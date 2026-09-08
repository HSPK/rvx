use std::env;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::auth::{self, AuthState};

/// Keeps secrets out of debug output while sharing one authentication policy across requests.
#[derive(Clone)]
pub struct AccessPolicy {
    token: Option<Arc<str>>,
    password_hash: Option<[u8; 32]>,
    public_origin: Option<Url>,
}

impl AccessPolicy {
    /// Preserve the original unauthenticated loopback-only deployment.
    pub fn local_only() -> Self {
        Self {
            token: None,
            password_hash: None,
            public_origin: None,
        }
    }

    /// Validate an explicit shared password and optional HTTPS reverse-proxy origin.
    pub fn authenticated(token: &str, public_origin: Option<&str>) -> Result<Self> {
        if !(32..=256).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            bail!(
                "RVX_API_TOKEN must contain 32..256 printable ASCII characters without whitespace"
            );
        }
        let public_origin = public_origin.map(parse_origin).transpose()?;
        Ok(Self {
            token: Some(Arc::from(token)),
            password_hash: Some(Sha256::digest(token.as_bytes()).into()),
            public_origin,
        })
    }

    /// Fail closed for malformed environment values instead of silently disabling authentication.
    pub fn from_env() -> Result<Self> {
        let origin = optional_env("RVX_PUBLIC_ORIGIN")?;
        match optional_env("RVX_API_TOKEN")? {
            Some(token) => Self::authenticated(&token, origin.as_deref()),
            None if origin.is_some() => bail!("RVX_PUBLIC_ORIGIN requires RVX_API_TOKEN"),
            None => Ok(Self::local_only()),
        }
    }

    /// Require authentication before a listener can accept connections on non-loopback interfaces.
    pub fn validate_listener(&self, listen: SocketAddr) -> Result<()> {
        if !listen.ip().is_loopback() && self.token.is_none() {
            bail!("non-loopback listeners require RVX_API_TOKEN; configure a protected environment file");
        }
        Ok(())
    }

    pub(crate) fn authentication_required(&self) -> bool {
        self.token.is_some()
    }

    /// Compare fixed-size hashes so password equality does not branch on the secret's length.
    pub(crate) fn password_matches(&self, candidate: &[u8]) -> bool {
        self.password_hash.as_ref().is_some_and(|expected| {
            let provided: [u8; 32] = Sha256::digest(candidate).into();
            bool::from(provided.ct_eq(expected))
        })
    }

    pub(crate) fn session_key_digest(&self) -> Option<[u8; 32]> {
        self.keyed_digest(b"rvx:session-key:v1\0", b"")
    }

    pub(crate) fn session_digest(&self, nonce: &str) -> Option<[u8; 32]> {
        self.keyed_digest(b"rvx:session-cookie:v1\0", nonce.as_bytes())
    }

    fn keyed_digest(&self, domain: &[u8], message: &[u8]) -> Option<[u8; 32]> {
        let token = self.token.as_ref()?;
        let mut mac =
            Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts this key length");
        mac.update(domain);
        mac.update(message);
        Some(mac.finalize().into_bytes().into())
    }

    /// Accept one canonical server-generated session nonce, never a caller-selected registry key.
    pub(crate) fn cookie_digest(&self, headers: &HeaderMap) -> Option<[u8; 32]> {
        let mut nonce = None;
        for header in headers.get_all(header::COOKIE) {
            for cookie in header.to_str().ok()?.split(';') {
                let Some((name, value)) = cookie.trim().split_once('=') else {
                    continue;
                };
                if name == "rvx_session" {
                    if nonce.is_some()
                        || value.len() != 64
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    {
                        return None;
                    }
                    nonce = Some(value);
                }
            }
        }
        self.session_digest(nonce?)
    }

    pub(crate) fn secure_browser_cookie(&self) -> bool {
        self.public_origin
            .as_ref()
            .is_some_and(|origin| origin.scheme() == "https")
    }

    /// Accept a constant-time token comparison for browser Basic or CLI Bearer authentication.
    fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(_) = &self.token else {
            return true;
        };
        let Some(value) = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        if value.len() > 2048 {
            return false;
        }
        let Some((scheme, credential)) = value.split_once(' ') else {
            return false;
        };
        if scheme.eq_ignore_ascii_case("Bearer") {
            return self.password_matches(credential.trim().as_bytes());
        }
        if scheme.eq_ignore_ascii_case("Basic") {
            if headers
                .keys()
                .any(|name| name.as_str().starts_with("sec-fetch-"))
            {
                return false;
            }
            let Ok(decoded) = STANDARD.decode(credential.trim()) else {
                return false;
            };
            let Some(colon) = decoded.iter().position(|byte| *byte == b':') else {
                return false;
            };
            return decoded[..colon] == *b"rvx" && self.password_matches(&decoded[colon + 1..]);
        }
        false
    }

    /// Compare browser origins without trusting caller-supplied forwarded-header overrides.
    fn same_origin(&self, headers: &HeaderMap, base: &Url) -> bool {
        if let Some(site) = headers.get("sec-fetch-site") {
            if site != "same-origin" && site != "none" {
                return false;
            }
        }
        let expected = self.public_origin.as_ref().unwrap_or(base).origin();
        for name in [header::ORIGIN, header::REFERER] {
            if let Some(value) = headers.get(name) {
                let Ok(origin) = value.to_str().unwrap_or("").parse::<Url>() else {
                    return false;
                };
                if origin.origin() != expected {
                    return false;
                }
            }
        }
        true
    }

    fn required_origin(&self, headers: &HeaderMap, base: &Url) -> bool {
        headers.get_all(header::ORIGIN).iter().count() == 1
            && headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| parse_origin(value).is_ok())
            && self.same_origin(headers, base)
    }
}

/// Protect UI, assets, health, proxy data, and APIs under the same access boundary.
pub(crate) async fn protect(
    State(state): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Response {
    let policy = &state.policy;
    let Some(base) = request_origin(request.headers()) else {
        return error(StatusCode::FORBIDDEN, "invalid request host", false);
    };
    if policy.token.is_none() && !loopback_host(&base) {
        return error(
            StatusCode::FORBIDDEN,
            "unauthenticated access is limited to loopback hosts",
            false,
        );
    }
    let auth_write = *request.method() == Method::POST
        && matches!(request.uri().path(), "/api/auth/login" | "/api/auth/logout");
    if auth_write && !policy.required_origin(request.headers(), &base) {
        return error(
            StatusCode::FORBIDDEN,
            "Authentication requests require the same-origin Origin header",
            false,
        );
    }
    if auth_write && request.uri().query().is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "Authentication requests must not use query parameters",
            false,
        );
    }
    if *request.method() == Method::POST && request.uri().path() == "/api/auth/login" {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        if let Some(retry) = state.attempt(peer) {
            let mut response = auth::throttled(retry);
            protect_headers(&mut response);
            return response;
        }
    }
    if !public_request(&request) && !policy.authorized(request.headers()) {
        match state.cookie_session(request.headers()).await {
            Ok(Some(session)) => {
                request.extensions_mut().insert(session);
            }
            Ok(None) => {
                if let Some(response) = login_redirect(&request) {
                    return response;
                }
                return error(
                    StatusCode::UNAUTHORIZED,
                    "RVX authentication required",
                    true,
                );
            }
            Err(_) => {
                let mut response = auth::unavailable();
                protect_headers(&mut response);
                return response;
            }
        }
    }
    if request.uri().path() == "/api/ui/connection" {
        if request.uri().query().is_some() {
            return error(
                StatusCode::BAD_REQUEST,
                "WebSocket connection URL must not contain query parameters",
                false,
            );
        }
        if !policy.required_origin(request.headers(), &base) {
            return error(
                StatusCode::FORBIDDEN,
                "WebSocket requires the same-origin Origin header",
                false,
            );
        }
    }
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !policy.same_origin(request.headers(), &base)
    {
        return error(
            StatusCode::FORBIDDEN,
            "requests must use the same origin",
            false,
        );
    }
    let mut response = next.run(request).await;
    protect_headers(&mut response);
    if policy.token.is_some() {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
    response
}

fn public_request(request: &Request) -> bool {
    let path = request.uri().path();
    (*request.method() == Method::GET && path == "/api/auth/session")
        || (*request.method() == Method::POST
            && matches!(path, "/api/auth/login" | "/api/auth/logout"))
        || (matches!(*request.method(), Method::GET | Method::HEAD)
            && (matches!(path, "/login" | "/login/") || path.starts_with("/login/assets/")))
}

/// Encode one local workspace URL as data; arbitrary next parameters never become server redirects.
fn login_redirect(request: &Request) -> Option<Response> {
    let path = request.uri().path();
    let navigation = request
        .headers()
        .get("sec-fetch-dest")
        .is_some_and(|value| value == "document")
        || request
            .headers()
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|part| {
                    let mut parameters = part.split(';').map(str::trim);
                    parameters
                        .next()
                        .is_some_and(|mime| mime.eq_ignore_ascii_case("text/html"))
                        && parameters.all(|parameter| match parameter.split_once('=') {
                            Some((name, value)) if name.trim().eq_ignore_ascii_case("q") => value
                                .trim()
                                .parse::<f32>()
                                .is_ok_and(|quality| quality > 0.0 && quality <= 1.0),
                            _ => true,
                        })
                })
            });
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        || !navigation
        || !(matches!(path, "/" | "/rvx") || path.starts_with("/rvx/"))
    {
        return None;
    }
    let original = request.uri().path_and_query()?.as_str();
    let mut location = Url::parse("http://localhost/login").expect("fixed URL");
    location.query_pairs_mut().append_pair("next", original);
    let mut response =
        axum::response::Redirect::to(&format!("/login?{}", location.query()?)).into_response();
    protect_headers(&mut response);
    Some(response)
}

/// Require a syntactically valid Host authority, not credentials or URL path components.
fn request_origin(headers: &HeaderMap) -> Option<Url> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let url = Url::parse(&format!("http://{host}")).ok()?;
    (url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

/// Avoid weakening the original DNS-rebinding boundary when no password is configured.
fn loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

/// Accept only a complete origin, leaving proxy routing and certificate ownership external.
fn parse_origin(value: &str) -> Result<Url> {
    let origin =
        Url::parse(value).context("RVX_PUBLIC_ORIGIN must be an absolute HTTP(S) origin")?;
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.has_host()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        bail!("RVX_PUBLIC_ORIGIN must contain only HTTP(S) scheme, host, and optional port");
    }
    Ok(origin)
}

/// Distinguish absent configuration from invalid Unicode without printing secret values.
fn optional_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => bail!("{name} must be valid Unicode"),
    }
}

/// Signal API authentication without triggering a browser's native Basic password dialog.
fn error(status: StatusCode, message: &str, challenge: bool) -> Response {
    let mut response = (status, Json(json!({"error": message}))).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if challenge {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer realm=\"RVX\""),
        );
    }
    protect_headers(&mut response);
    response
}

/// Prevent framing and cross-origin referrer disclosure on the authenticated console.
fn protect_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'; base-uri 'self'"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "fixture-token-0123456789abcdef0123456789abcdef";

    #[test]
    fn public_listeners_require_an_explicit_strong_token() {
        let local = AccessPolicy::local_only();
        assert!(local
            .validate_listener("127.0.0.1:9110".parse().unwrap())
            .is_ok());
        assert!(local
            .validate_listener("0.0.0.0:9110".parse().unwrap())
            .is_err());
        let authenticated = AccessPolicy::authenticated(TOKEN, None).unwrap();
        assert!(authenticated
            .validate_listener("0.0.0.0:9110".parse().unwrap())
            .is_ok());
        for invalid in ["", "short", "password contains spaces and is long enough"] {
            assert!(AccessPolicy::authenticated(invalid, None).is_err());
        }
    }

    #[test]
    fn browser_and_cli_credentials_are_checked_without_echoing_tokens() {
        let policy = AccessPolicy::authenticated(TOKEN, None).unwrap();
        let mut headers = HeaderMap::new();
        assert!(!policy.authorized(&headers));
        for accepted in [
            format!("Bearer {TOKEN}"),
            format!("Basic {}", STANDARD.encode(format!("rvx:{TOKEN}"))),
        ] {
            headers.insert(header::AUTHORIZATION, accepted.parse().unwrap());
            assert!(policy.authorized(&headers));
        }
        for rejected in [
            "Bearer wrong".to_owned(),
            "Basic invalid".to_owned(),
            format!("Basic {}", STANDARD.encode(format!("other:{TOKEN}"))),
        ] {
            headers.insert(header::AUTHORIZATION, rejected.parse().unwrap());
            assert!(!policy.authorized(&headers));
        }
    }

    #[test]
    fn proxy_origin_is_explicit_and_cross_origin_requests_remain_rejected() {
        let policy = AccessPolicy::authenticated(TOKEN, Some("https://rvx.example")).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:9110".parse().unwrap());
        headers.insert(header::ORIGIN, "https://rvx.example".parse().unwrap());
        let base = request_origin(&headers).unwrap();
        assert!(policy.same_origin(&headers, &base));
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(!policy.same_origin(&headers, &base));
        for invalid in [
            "https://rvx.example/path",
            "https://user:pass@rvx.example",
            "https://rvx.example?token=x",
        ] {
            assert!(AccessPolicy::authenticated(TOKEN, Some(invalid)).is_err());
        }
    }
}
