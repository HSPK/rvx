use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use rvx_engine::Engine;
use rvx_server::{AccessPolicy, UiConnections};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "login-fixture-0123456789abcdef0123456789abcdef";
const ROTATED: &str = "rotated-fixture-0123456789abcdef0123456789abcdef";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Fixture {
    directory: tempfile::TempDir,
    engine: Arc<Engine>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let engine = Engine::open(directory.path().join("data")).unwrap();
        let ui = directory.path().join("ui");
        std::fs::create_dir_all(ui.join("login/assets")).unwrap();
        std::fs::create_dir_all(ui.join("assets")).unwrap();
        std::fs::write(ui.join("index.html"), "private-workspace").unwrap();
        std::fs::write(ui.join("assets/app.js"), "private-application").unwrap();
        std::fs::write(ui.join("login/index.html"), "public-login").unwrap();
        std::fs::write(ui.join("login/assets/login.js"), "public-login-asset").unwrap();
        Self { directory, engine }
    }

    fn database(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.directory.path().join("data/metadata.db")).unwrap()
    }
}

struct Server {
    url: String,
    connections: UiConnections,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start(fixture: &Fixture, policy: AccessPolicy, connect_info: bool) -> Self {
        let connections = UiConnections::new();
        let router = rvx_server::application_with_access_and_connections(
            fixture.engine.clone(),
            fixture.directory.path().join("ui"),
            policy,
            connections.clone(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let shutdown = async {
                let _ = stopped.await;
            };
            if connect_info {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(shutdown)
                .await
                .unwrap();
            } else {
                axum::serve(listener, router)
                    .with_graceful_shutdown(shutdown)
                    .await
                    .unwrap();
            }
        });
        Self {
            url,
            connections,
            stop: Some(stop),
            task,
        }
    }

    async fn authenticated(fixture: &Fixture) -> Self {
        Self::start(
            fixture,
            AccessPolicy::authenticated(TOKEN, None).unwrap(),
            true,
        )
        .await
    }

    async fn close(mut self) {
        self.connections.shutdown().await;
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }

    async fn login(
        &self,
        client: &reqwest::Client,
        password: &str,
        cookie: &str,
    ) -> reqwest::Response {
        client
            .post(format!("{}/api/auth/login", self.url))
            .header("origin", &self.url)
            .header("cookie", cookie)
            .json(&json!({"password": password}))
            .send()
            .await
            .unwrap()
    }

    async fn status(&self, client: &reqwest::Client, cookie: &str) -> Value {
        let response = client
            .get(format!("{}/api/auth/session", self.url))
            .header("cookie", cookie)
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store"));
        response.json().await.unwrap()
    }

    async fn logout(&self, client: &reqwest::Client, cookie: &str) -> reqwest::Response {
        client
            .post(format!("{}/api/auth/logout", self.url))
            .header("origin", &self.url)
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
    }

    async fn socket(&self, cookie: &str, bearer: bool) -> Socket {
        let mut request = format!("{}/api/ui/connection", self.url.replace("http://", "ws://"))
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", self.url.parse().unwrap());
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        request
            .headers_mut()
            .insert("sec-fetch-site", "same-origin".parse().unwrap());
        let authorization = if bearer {
            format!("Bearer {TOKEN}")
        } else {
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("rvx:{TOKEN}"))
            )
        };
        request
            .headers_mut()
            .insert("authorization", authorization.parse().unwrap());
        connect_async(request).await.unwrap().0
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

fn cookie(response: &reqwest::Response) -> String {
    let values: Vec<_> = response.headers().get_all("set-cookie").iter().collect();
    assert_eq!(values.len(), 1);
    let value = values[0].to_str().unwrap();
    assert!(
        value.contains("HttpOnly") && value.contains("SameSite=Strict") && value.contains("Path=/")
    );
    value.split(';').next().unwrap().to_owned()
}

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn assert_closed(message: Message, code: u16) {
    match message {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), code),
        other => panic!("expected close {code}, received {other:?}"),
    }
}

#[tokio::test]
async fn auth_public_login_is_isolated_and_redirects_encode_only_local_workspace_urls() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    for path in [
        "/login",
        "/login/",
        "/login?next=https://evil.example",
        "/login/assets/login.js",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(response.headers().get("location").is_none());
        assert!(response.headers().get("www-authenticate").is_none());
        assert!(!response.text().await.unwrap().contains("private-"));
    }
    assert_eq!(
        client
            .head(format!("{}/login", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for path in [
        "/assets/app.js",
        "/api/experiments/projects",
        "/healthz",
        "/login/other",
        "/rvx",
        "/",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert!(!response
            .headers()
            .get("www-authenticate")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("Basic"));
    }
    for path in ["/login", "/login/assets/login.js"] {
        assert_eq!(
            client
                .post(format!("{}{path}", server.url))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    for path in [
        "/login/assets/%2e%2e%2f%2e%2e%2fassets/app.js",
        "/login/assets/%252e%252e/assets/app.js",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::OK);
        assert!(!response.text().await.unwrap().contains("private-"));
    }
    for path in [
        "/",
        "/rvx?runs=a,b&next=https://evil.example",
        "/rvx/nested?value=%0D%0AX-Injected%3Ayes",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .header("accept", "text/html")
            .header("sec-fetch-dest", "document")
            .basic_auth("rvx", Some(TOKEN))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert!(response.headers().get("x-injected").is_none());
        assert!(response.headers().get("www-authenticate").is_none());
        let location = response.headers()["location"].to_str().unwrap();
        assert!(location.starts_with("/login?next="));
        let resolved = reqwest::Url::parse(&server.url)
            .unwrap()
            .join(location)
            .unwrap();
        assert_eq!(
            resolved
                .query_pairs()
                .find(|(name, _)| name == "next")
                .unwrap()
                .1,
            path
        );
    }
    let status = server.status(&client, "").await;
    assert_eq!(
        status,
        json!({"authenticated":false,"authentication_required":true})
    );
    let no_html = client
        .get(format!("{}/rvx", server.url))
        .header("accept", "application/json,text/html;q=0")
        .send()
        .await
        .unwrap();
    assert_eq!(no_html.status(), StatusCode::UNAUTHORIZED);
    let ambient = client
        .get(format!("{}/healthz", server.url))
        .basic_auth("rvx", Some(TOKEN))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(ambient.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        client
            .get(format!("{}/healthz", server.url))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .get(format!("{}/healthz", server.url))
            .basic_auth("rvx", Some(TOKEN))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    server.close().await;
}

#[tokio::test]
async fn auth_failed_session_commit_never_issues_a_cookie_or_echoes_the_password() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    fixture
        .database()
        .execute_batch(
            "CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions
         BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;",
        )
        .unwrap();
    let response = server.login(&client, TOKEN, "").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().get("set-cookie").is_none());
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error":"Authentication is temporarily unavailable."})
    );
    assert_eq!(server.status(&client, "").await["authenticated"], false);
    fixture
        .database()
        .execute_batch("DROP TRIGGER reject_session;")
        .unwrap();
    assert_eq!(
        server.login(&client, TOKEN, "").await.status(),
        StatusCode::OK
    );
    server.close().await;
}

#[tokio::test]
async fn auth_login_requires_origin_and_keeps_password_errors_generic() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    for origin in [
        None,
        Some("null"),
        Some("https://foreign.example"),
        Some("http://127.0.0.1/path"),
    ] {
        let mut request = client
            .post(format!("{}/api/auth/login", server.url))
            .json(&json!({"password":TOKEN}));
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let wrong = server.login(&client, "wrong-password", "").await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert!(wrong.headers().get("set-cookie").is_none());
    assert!(wrong.headers().get("www-authenticate").is_none());
    assert_eq!(
        wrong.json::<Value>().await.unwrap(),
        json!({"error":"Invalid password."})
    );
    for body in [
        "{}",
        "null",
        "{",
        r#"{"password":null}"#,
        r#"{"password":"do-not-echo","extra":true}"#,
        r#"{"password":1}"#,
    ] {
        let response = client
            .post(format!("{}/api/auth/login", server.url))
            .header("origin", &server.url)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":"Invalid login request."})
        );
    }
    let oversized = client
        .post(format!("{}/api/auth/login", server.url))
        .header("origin", &server.url)
        .header("content-type", "application/json")
        .body(" ".repeat(4097))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        oversized.json::<Value>().await.unwrap(),
        json!({"error":"Invalid login request."})
    );
    let empty = server.login(&client, "", "").await;
    assert_eq!(empty.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        empty.json::<Value>().await.unwrap(),
        json!({"error":"Invalid password."})
    );
    let response = server.login(&client, TOKEN, "").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"authenticated":true,"authentication_required":true})
    );
    server.close().await;
}

#[tokio::test]
async fn auth_login_throttles_real_peers_and_has_a_bounded_embedded_fallback() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    for _ in 0..10 {
        assert_eq!(
            server.login(&client, "wrong", "").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let limited = client
        .post(format!("{}/api/auth/login", server.url))
        .header("origin", &server.url)
        .header("x-forwarded-for", "192.0.2.45")
        .header("forwarded", "for=192.0.2.46")
        .json(&json!({"password":TOKEN}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!((1..=60).contains(
        &limited.headers()["retry-after"]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
    ));
    let other = reqwest::Client::builder()
        .no_proxy()
        .local_address("127.0.0.2".parse::<IpAddr>().unwrap())
        .build()
        .unwrap();
    assert_eq!(
        server.login(&other, TOKEN, "").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        server.logout(&client, "").await.status(),
        StatusCode::NO_CONTENT
    );
    server.close().await;
    let fallback = Server::start(
        &fixture,
        AccessPolicy::authenticated(TOKEN, None).unwrap(),
        false,
    )
    .await;
    for _ in 0..10 {
        assert_eq!(
            fallback.login(&client, "wrong", "").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        fallback.login(&client, TOKEN, "").await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    fallback.close().await;
}

#[tokio::test]
async fn auth_sessions_are_keyed_opaque_and_logout_preserves_browser_preferences() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    let bootstrap = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    let preferences = cookie(&bootstrap);
    let stored=client.put(format!("{}/api/ui/browser",server.url)).bearer_auth(TOKEN).header("cookie",&preferences)
        .json(&json!({"revision":0,"mutation_id":"theme","theme":"dark","sidebar_width":410,"selected":{},"run_colors":{}}))
        .send().await.unwrap().json::<Value>().await.unwrap();
    let login = server.login(&client, TOKEN, &preferences).await;
    assert_eq!(login.status(), StatusCode::OK);
    assert!(login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=604800"));
    let session = cookie(&login);
    let nonce = session.strip_prefix("rvx_session=").unwrap();
    assert_eq!(nonce.len(), 64);
    assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!session.contains(TOKEN));
    let mut mac = Hmac::<Sha256>::new_from_slice(TOKEN.as_bytes()).unwrap();
    mac.update(b"rvx:session-cookie:v1\0");
    mac.update(nonce.as_bytes());
    let expected: Vec<u8> = mac.finalize().into_bytes().to_vec();
    let (digest, expiration): (Vec<u8>, i64) = fixture
        .database()
        .query_row("SELECT digest,expires_at FROM auth_sessions", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(digest, expected);
    assert!((604795..=604800).contains(&(expiration - rvx_core::now_ns() / 1_000_000_000)));
    let combined = format!("{preferences}; {session}");
    let state = client
        .get(format!("{}/api/ui/state", server.url))
        .header("cookie", &combined)
        .send()
        .await
        .unwrap();
    assert!(state.headers().get("set-cookie").is_none());
    assert_eq!(state.json::<Value>().await.unwrap()["browser"], stored);
    assert_eq!(
        server.status(&client, &session).await["authenticated"],
        true
    );
    let blocked = client
        .post(format!("{}/api/auth/logout", server.url))
        .header("cookie", &combined)
        .send()
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        server.status(&client, &session).await["authenticated"],
        true
    );
    let logout = server.logout(&client, &combined).await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert_eq!(cookie(&logout), "rvx_session=");
    assert!(logout.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        server.status(&client, &session).await["authenticated"],
        false
    );
    assert_eq!(
        server.logout(&client, &combined).await.status(),
        StatusCode::NO_CONTENT
    );
    for unknown in [
        "rvx_session=bad",
        "rvx_session=0000000000000000000000000000000000000000000000000000000000000000",
    ] {
        assert_eq!(
            server.status(&client, unknown).await["authenticated"],
            false
        );
        assert_eq!(
            server.logout(&client, unknown).await.status(),
            StatusCode::NO_CONTENT
        );
    }
    let preserved = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &preferences)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(preserved["browser"], stored);
    server.close().await;
}

#[tokio::test]
async fn auth_login_rotates_sessions_and_expiry_and_password_rotation_invalidate_cookies() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    let first = cookie(&server.login(&client, TOKEN, "").await);
    let second = cookie(&server.login(&client, TOKEN, &first).await);
    assert_ne!(first, second);
    assert_eq!(server.status(&client, &first).await["authenticated"], false);
    assert_eq!(server.status(&client, &second).await["authenticated"], true);
    assert_eq!(
        server.status(&client, &format!("{second}; {second}")).await["authenticated"],
        false
    );
    fixture
        .database()
        .execute("UPDATE auth_sessions SET expires_at=0", [])
        .unwrap();
    assert_eq!(
        server.status(&client, &second).await["authenticated"],
        false
    );
    assert_eq!(
        server.logout(&client, &second).await.status(),
        StatusCode::NO_CONTENT
    );
    let old = cookie(&server.login(&client, TOKEN, "").await);
    server.close().await;
    let rotated = Server::start(
        &fixture,
        AccessPolicy::authenticated(ROTATED, None).unwrap(),
        true,
    )
    .await;
    assert_eq!(rotated.status(&client, &old).await["authenticated"], false);
    assert_eq!(
        rotated.login(&client, TOKEN, "").await.status(),
        StatusCode::UNAUTHORIZED
    );
    let new = cookie(&rotated.login(&client, ROTATED, "").await);
    assert_eq!(rotated.status(&client, &new).await["authenticated"], true);
    rotated.close().await;
    let restored = Server::authenticated(&fixture).await;
    assert_eq!(restored.status(&client, &old).await["authenticated"], false);
    assert_eq!(restored.status(&client, &new).await["authenticated"], false);
    restored.close().await;
}

#[tokio::test]
async fn auth_https_origin_sets_secure_cookie_and_local_only_needs_no_session() {
    let fixture = Fixture::new();
    let server = Server::start(
        &fixture,
        AccessPolicy::authenticated(TOKEN, Some("https://rvx.example")).unwrap(),
        true,
    )
    .await;
    let client = client();
    assert_eq!(
        server.login(&client, TOKEN, "").await.status(),
        StatusCode::FORBIDDEN
    );
    let response = client
        .post(format!("{}/api/auth/login", server.url))
        .header("origin", "https://rvx.example")
        .json(&json!({"password":TOKEN}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("; Secure"));
    server.close().await;
    let local = Server::start(&fixture, AccessPolicy::local_only(), true).await;
    assert_eq!(
        local.status(&client, "").await,
        json!({"authenticated":true,"authentication_required":false})
    );
    assert_eq!(
        local.logout(&client, "").await.status(),
        StatusCode::NO_CONTENT
    );
    let denied = client
        .get(format!("{}/api/auth/session", local.url))
        .header("host", "foreign.example")
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    local.close().await;
}

#[tokio::test]
async fn auth_cookie_websockets_recheck_logout_expiry_and_shutdown_even_with_cached_basic() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let client = client();
    let login = cookie(&server.login(&client, TOKEN, "").await);
    for (origin, session, status) in [
        (
            "https://foreign.example",
            login.as_str(),
            StatusCode::FORBIDDEN,
        ),
        (server.url.as_str(), "", StatusCode::UNAUTHORIZED),
    ] {
        let mut request = format!(
            "{}/api/ui/connection",
            server.url.replace("http://", "ws://")
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        request
            .headers_mut()
            .insert("cookie", session.parse().unwrap());
        match connect_async(request).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), status)
            }
            other => panic!("expected rejected cookie handshake, got {other:?}"),
        }
    }
    let mut socket = server.socket(&login, false).await;
    socket
        .send(Message::Text(
            r#"{"type":"ping","id":"before-logout"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(next(&mut socket).await.to_text().unwrap()).unwrap()["type"],
        "pong"
    );
    assert_eq!(
        server.logout(&client, &login).await.status(),
        StatusCode::NO_CONTENT
    );
    socket
        .send(Message::Text(
            r#"{"type":"ping","id":"after-logout"}"#.into(),
        ))
        .await
        .unwrap();
    assert_closed(next(&mut socket).await, 1008);
    let login = cookie(&server.login(&client, TOKEN, "").await);
    let mut socket = server.socket(&login, false).await;
    fixture
        .database()
        .execute("UPDATE auth_sessions SET expires_at=0", [])
        .unwrap();
    socket
        .send(Message::Text(r#"{"type":"ping","id":"expired"}"#.into()))
        .await
        .unwrap();
    assert_closed(next(&mut socket).await, 1008);
    let login = cookie(&server.login(&client, TOKEN, "").await);
    let mut socket = server.socket(&login, false).await;
    server.close().await;
    assert_closed(next(&mut socket).await, 1001);
}

#[tokio::test]
async fn auth_bearer_websockets_never_query_cookie_session_storage() {
    let fixture = Fixture::new();
    let server = Server::authenticated(&fixture).await;
    let mut socket = server.socket("", true).await;
    fixture
        .database()
        .execute("DROP TABLE auth_sessions", [])
        .unwrap();
    socket
        .send(Message::Text(r#"{"type":"ping","id":"bearer"}"#.into()))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(next(&mut socket).await.to_text().unwrap()).unwrap(),
        json!({"type":"pong","id":"bearer"})
    );
    server.close().await;
    assert_closed(next(&mut socket).await, 1001);
}
