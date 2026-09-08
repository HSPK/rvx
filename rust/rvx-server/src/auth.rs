use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{rejection::JsonRejection, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rvx_engine::{Engine, EngineError, AUTH_SESSION_SECONDS};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{AccessPolicy, AppState};

const ATTEMPT_WINDOW: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u32 = 10;
const MAX_PEERS: usize = 4096;

#[derive(Clone)]
pub(crate) struct AuthState {
    pub(crate) policy: AccessPolicy,
    engine: Arc<Engine>,
    key_digest: Option<[u8; 32]>,
    throttle: Arc<Mutex<LoginThrottle>>,
}

impl AuthState {
    /// Bind authentication to the same metadata owner and durably apply password rotation.
    pub(crate) fn new(policy: AccessPolicy, engine: Arc<Engine>) -> anyhow::Result<Self> {
        let key_digest = policy.session_key_digest();
        if let Some(key) = &key_digest {
            engine.configure_auth_sessions(key)?;
        }
        Ok(Self {
            policy,
            engine,
            key_digest,
            throttle: Arc::new(Mutex::new(LoginThrottle::default())),
        })
    }

    /// Bound attempts by the actual transport peer, or one shared bucket for embedded router tests.
    pub(crate) fn attempt(&self, peer: Option<IpAddr>) -> Option<u64> {
        self.throttle.lock().unwrap().attempt(peer, Instant::now())
    }

    /// Cookie sessions never inherit Authorization headers and never expose their nonce in state.
    pub(crate) async fn cookie_session(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<CookieSession>, EngineError> {
        let Some((digest, key_digest)) = self.policy.cookie_digest(headers).zip(self.key_digest)
        else {
            return Ok(None);
        };
        let session = CookieSession {
            engine: self.engine.clone(),
            key_digest,
            digest,
        };
        if session.active().await? {
            Ok(Some(session))
        } else {
            Ok(None)
        }
    }
}

#[derive(Clone)]
pub(crate) struct CookieSession {
    engine: Arc<Engine>,
    key_digest: [u8; 32],
    digest: [u8; 32],
}

impl CookieSession {
    /// Recheck expiry and durable revocation before an upgraded cookie client receives another pong.
    pub(crate) async fn active(&self) -> Result<bool, EngineError> {
        let engine = self.engine.clone();
        let (key, digest) = (self.key_digest, self.digest);
        tokio::task::spawn_blocking(move || engine.auth_session_active(&key, &digest))
            .await
            .map_err(|error| EngineError::Runtime(error.to_string()))?
    }
}

struct AttemptWindow {
    began: Instant,
    attempts: u32,
}

#[derive(Default)]
struct LoginThrottle {
    peers: HashMap<Option<IpAddr>, AttemptWindow>,
    cleanup_at: Option<Instant>,
}

impl LoginThrottle {
    fn attempt(&mut self, peer: Option<IpAddr>, now: Instant) -> Option<u64> {
        if self.cleanup_at.map_or(true, |deadline| now >= deadline) {
            self.peers
                .retain(|_, window| now.duration_since(window.began) < ATTEMPT_WINDOW);
            self.cleanup_at = Some(now + ATTEMPT_WINDOW);
        }
        if !self.peers.contains_key(&peer) && self.peers.len() >= MAX_PEERS {
            return Some(ATTEMPT_WINDOW.as_secs());
        }
        let window = self.peers.entry(peer).or_insert(AttemptWindow {
            began: now,
            attempts: 0,
        });
        let elapsed = now.duration_since(window.began);
        if elapsed >= ATTEMPT_WINDOW {
            window.began = now;
            window.attempts = 0;
        }
        if window.attempts >= MAX_ATTEMPTS {
            return Some(
                (ATTEMPT_WINDOW - now.duration_since(window.began))
                    .as_secs()
                    .saturating_add(1)
                    .min(60),
            );
        }
        window.attempts += 1;
        None
    }
}

#[derive(Serialize)]
pub(crate) struct SessionStatus {
    authenticated: bool,
    authentication_required: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoginInput {
    password: String,
}

pub(crate) async fn session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let required = state.auth.policy.authentication_required();
    let authenticated = if required {
        match state.auth.cookie_session(&headers).await {
            Ok(session) => session.is_some(),
            Err(_) => return unavailable(),
        }
    } else {
        true
    };
    Json(SessionStatus {
        authenticated,
        authentication_required: required,
    })
    .into_response()
}

pub(crate) async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<LoginInput>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return invalid_input();
    };
    let auth = state.auth;
    if !auth.policy.authentication_required() {
        return Json(SessionStatus {
            authenticated: true,
            authentication_required: false,
        })
        .into_response();
    }
    if !auth.policy.password_matches(input.password.as_bytes()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Invalid password."})),
        )
            .into_response();
    }
    let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let digest = auth
        .policy
        .session_digest(&nonce)
        .expect("authenticated policy");
    let key = auth.key_digest.expect("authenticated policy");
    let previous = auth.policy.cookie_digest(&headers);
    let engine = auth.engine;
    let result = tokio::task::spawn_blocking(move || {
        engine.create_auth_session(&key, &digest, previous.as_ref())
    })
    .await;
    if !matches!(result, Ok(Ok(()))) {
        return unavailable();
    }
    let mut response = Json(SessionStatus {
        authenticated: true,
        authentication_required: true,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(
            &nonce,
            AUTH_SESSION_SECONDS,
            auth.policy.secure_browser_cookie(),
        )
        .parse()
        .expect("server-generated cookie"),
    );
    response
}

pub(crate) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let auth = state.auth;
    if let Some(digest) = auth.policy.cookie_digest(&headers) {
        let engine = auth.engine;
        let result = tokio::task::spawn_blocking(move || engine.revoke_auth_session(&digest)).await;
        if !matches!(result, Ok(Ok(()))) {
            return unavailable();
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie("", 0, auth.policy.secure_browser_cookie())
            .parse()
            .expect("fixed cookie attributes"),
    );
    response
}

fn session_cookie(nonce: &str, max_age: i64, secure: bool) -> String {
    format!(
        "rvx_session={nonce}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn invalid_input() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":"Invalid login request."})),
    )
        .into_response()
}

pub(crate) fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Authentication is temporarily unavailable."})),
    )
        .into_response()
}

pub(crate) fn throttled(retry: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"error":"Too many login attempts. Try again later."})),
    )
        .into_response();
    response.headers_mut().insert(
        header::RETRY_AFTER,
        retry.to_string().parse().expect("numeric retry delay"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_throttle_bounds_peers_and_resets_without_trusting_forwarded_addresses() {
        let mut throttle = LoginThrottle::default();
        let now = Instant::now();
        for _ in 0..MAX_ATTEMPTS {
            assert_eq!(throttle.attempt(None, now), None);
        }
        assert_eq!(throttle.attempt(None, now), Some(60));
        assert_eq!(throttle.attempt(None, now + ATTEMPT_WINDOW), None);
        for index in 0..MAX_PEERS {
            throttle.attempt(
                Some(IpAddr::V6(std::net::Ipv6Addr::from(index as u128))),
                now + ATTEMPT_WINDOW,
            );
        }
        assert_eq!(throttle.peers.len(), MAX_PEERS);
        assert_eq!(
            throttle.attempt(Some("192.0.2.1".parse().unwrap()), now + ATTEMPT_WINDOW),
            Some(60)
        );
        assert_eq!(
            throttle.attempt(Some("192.0.2.1".parse().unwrap()), now + ATTEMPT_WINDOW * 2),
            None
        );
        assert_eq!(throttle.peers.len(), 1);
    }
}
