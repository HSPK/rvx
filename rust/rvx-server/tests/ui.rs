use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use rvx_engine::Engine;
use rvx_server::{AccessPolicy, UiConnections};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "ui-test-credential-0123456789abcdef0123456789";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Fixture {
    directory: tempfile::TempDir,
    engine: Arc<Engine>,
    experiment: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let engine = Engine::open(directory.path().join("data")).unwrap();
        let project = engine.create_project("ui-test").unwrap();
        let experiment = engine
            .create_experiment(&project.id, "workspace")
            .unwrap()
            .id;
        let ui = directory.path().join("ui");
        std::fs::create_dir_all(&ui).unwrap();
        std::fs::write(ui.join("index.html"), "<title>fixture</title>").unwrap();
        Self {
            directory,
            engine,
            experiment,
        }
    }

    fn workspace(&self, revision: u64, mutation: &str) -> Value {
        json!({"revision":revision,"mutation_id":mutation,"sets":[{
            "id":"workspace","name":"Workspace","experimentId":self.experiment,
            "panels":[{"kind":"chart","id":"chart","sectionId":"section","size":"normal","path":"/loss",
                "presentation":{"lineWidth":1.5,"yMin":-1.25,"yMax":2.0}}],
            "sections":[{"id":"section","name":"","collapsed":false}]
        }]})
    }
}

struct Server {
    url: String,
    connections: UiConnections,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[tokio::test]
async fn ui_html_uses_cookie_theme_before_scripts_without_mutating_preferences() {
    let fixture = Fixture::new();
    let path = fixture.directory.path().join("ui/index.html");
    let template = "<html data-theme=\"light\"><head><meta name=\"theme-color\" content=\"#f6f7f9\"></head><body>first</body></html>";
    std::fs::write(&path, template).unwrap();
    let server = Server::new(&fixture, None).await;
    let client = client();
    let (dark_cookie, original) = bootstrap(&client, &server).await;
    let (light_cookie, _) = bootstrap(&client, &server).await;
    let mut preferences = original["browser"].clone();
    preferences["mutation_id"] = json!("set-dark");
    preferences["theme"] = json!("dark");
    let saved: Value = put(&client, &server, "browser", &dark_cookie, &preferences)
        .await
        .json()
        .await
        .unwrap();
    for (cookie, theme, color) in [
        (dark_cookie.as_str(), "dark", "#171b23"),
        (light_cookie.as_str(), "light", "#f6f7f9"),
        (
            "rvx_browser=browser_00000000000000000000000000000000",
            "light",
            "#f6f7f9",
        ),
        ("", "light", "#f6f7f9"),
    ] {
        let response = client
            .get(format!("{}/rvx", server.url))
            .bearer_auth(TOKEN)
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("set-cookie"));
        assert!(response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store"));
        let html = response.text().await.unwrap();
        assert!(html.contains(&format!("data-theme=\"{theme}\"")));
        assert!(html.contains(&format!("content=\"{color}\"")));
    }
    let state: Value = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &dark_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["browser"], saved);
    let database =
        rusqlite::Connection::open(fixture.directory.path().join("data/metadata.db")).unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM ui_browsers", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    std::fs::write(&path, template.replace("first", "new-release")).unwrap();
    let html = client
        .get(format!("{}/rvx", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &dark_cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("new-release") && html.contains("data-theme=\"dark\""));
    server.close().await;
}

impl Server {
    async fn new(fixture: &Fixture, public_origin: Option<&str>) -> Self {
        let connections = UiConnections::new();
        let router = rvx_server::application_with_access_and_connections(
            fixture.engine.clone(),
            fixture.directory.path().join("ui"),
            AccessPolicy::authenticated(TOKEN, public_origin).unwrap(),
            connections.clone(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            url,
            connections,
            stop: Some(stop),
            task,
        }
    }

    async fn close(mut self) {
        self.connections.shutdown().await;
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }

    fn ws_request(
        &self,
        origin: Option<&str>,
        authenticated: bool,
        suffix: &str,
    ) -> axum::http::Request<()> {
        let mut request = format!(
            "{}/api/ui/connection{suffix}",
            self.url.replace("http://", "ws://")
        )
        .into_client_request()
        .unwrap();
        if authenticated {
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        }
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        request
    }

    async fn socket(&self) -> Socket {
        connect_async(self.ws_request(Some(&self.url), true, ""))
            .await
            .unwrap()
            .0
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
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

async fn bootstrap(client: &reqwest::Client, server: &Server) -> (String, Value) {
    let response = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("no-store"));
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && cookie.contains("Path=/")
            && cookie.contains("Max-Age=31536000")
    );
    (
        cookie.split(';').next().unwrap().to_owned(),
        response.json().await.unwrap(),
    )
}

async fn put(
    client: &reqwest::Client,
    server: &Server,
    endpoint: &str,
    cookie: &str,
    body: &Value,
) -> reqwest::Response {
    client
        .put(format!("{}/api/ui/{endpoint}", server.url))
        .bearer_auth(TOKEN)
        .header("origin", &server.url)
        .header("cookie", cookie)
        .json(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn ui_http_two_browsers_cas_retry_delete_and_validation() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let client = client();
    let (one, defaults) = bootstrap(&client, &server).await;
    let (two, second_defaults) = bootstrap(&client, &server).await;
    assert_ne!(one, two);
    assert_eq!(defaults, second_defaults);
    assert_eq!(
        defaults,
        json!({"workspaces":{"revision":0,"sets":[]},"browser":{"revision":0,"theme":"light","sidebar_width":280,"selected":{},"run_colors":{}}})
    );
    let saved: Value = put(
        &client,
        &server,
        "workspaces",
        &one,
        &fixture.workspace(0, "save"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        put(
            &client,
            &server,
            "workspaces",
            &one,
            &fixture.workspace(0, "save")
        )
        .await
        .json::<Value>()
        .await
        .unwrap(),
        saved
    );
    let stale = put(
        &client,
        &server,
        "workspaces",
        &two,
        &fixture.workspace(0, "other-save"),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let stale: Value = stale.json().await.unwrap();
    assert_eq!(stale["current"], saved);
    assert!(stale["error"].is_string());
    let mut invalid = fixture.workspace(1, "invalid");
    invalid["sets"][0]["panels"][0]["state"] = json!({"hidden":"data"});
    let invalid = put(&client, &server, "workspaces", &one, &invalid).await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert!(invalid.json::<Value>().await.unwrap()["error"].is_string());
    let prefs = json!({"revision":0,"mutation_id":"prefs","theme":"dark","sidebar_width":350,"selected":{fixture.experiment.clone():"workspace"},"run_colors":{}});
    let updated = put(&client, &server, "browser", &one, &prefs).await;
    assert_eq!(updated.status(), StatusCode::OK);
    assert_eq!(updated.json::<Value>().await.unwrap()["revision"], 1);
    for (cookie, theme, width, revision) in [(&one, "dark", 350, 1), (&two, "light", 280, 0)] {
        let response = client
            .get(format!("{}/api/ui/state", server.url))
            .bearer_auth(TOKEN)
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        assert!(response.headers().get("set-cookie").is_none());
        let state: Value = response.json().await.unwrap();
        assert_eq!(state["workspaces"], saved);
        assert_eq!(state["browser"]["theme"], theme);
        assert_eq!(state["browser"]["sidebar_width"], width);
        assert_eq!(state["browser"]["revision"], revision);
    }
    let deleted = put(
        &client,
        &server,
        "workspaces",
        &two,
        &json!({"revision":1,"mutation_id":"delete","sets":[]}),
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    let after: Value = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &one)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["browser"]["selected"], json!({}));
    assert_eq!(after["browser"]["revision"], 2);
    assert_eq!(after["browser"]["theme"], "dark");
    assert_eq!(after["workspaces"]["revision"], 2);
    server.close().await;
}

#[tokio::test]
async fn ui_http_auth_origin_cookie_bootstrap_and_body_limit_fail_closed() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let client = client();
    let (cookie, _) = bootstrap(&client, &server).await;
    for endpoint in ["state", "connection"] {
        let response = client
            .get(format!("{}/api/ui/{endpoint}", server.url))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for endpoint in ["workspaces", "browser"] {
        let response = client
            .put(format!("{}/api/ui/{endpoint}", server.url))
            .header("cookie", &cookie)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    for bad in [
        "",
        "rvx_browser=arbitrary",
        "rvx_browser=browser_00000000000000000000000000000000",
    ] {
        let response = put(
            &client,
            &server,
            "workspaces",
            bad,
            &fixture.workspace(0, "bootstrap-needed"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("GET /api/ui/state"));
    }
    let duplicate = format!("{cookie}; {cookie}");
    let response = put(
        &client,
        &server,
        "workspaces",
        &duplicate,
        &fixture.workspace(0, "duplicate-cookie"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = client
        .put(format!("{}/api/ui/workspaces", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &cookie)
        .header("origin", "https://foreign.example")
        .json(&fixture.workspace(0, "foreign"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = client
        .put(format!("{}/api/ui/workspaces", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &cookie)
        .header("content-type", "application/json")
        .body(" ".repeat(rvx_core::MAX_UI_REQUEST_BYTES + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(response.json::<Value>().await.unwrap()["error"].is_string());
    for body in [
        r#"{"revision":0,"mutation_id":"bad","sets":[],"raw":true}"#,
        r#"{"revision":0,"mutation_id":"bad","sets":[],"sets":[]}"#,
        r#"{"revision":0,"mutation_id":"bad","sets":[{"id":"a","name":"a","experimentId":"a","sections":[],"panels":[{"kind":"chart","id":"a","sectionId":"a","size":"normal","path":"/a","presentation":{"yMin":1e400}}]}]}"#,
    ] {
        let response = client
            .put(format!("{}/api/ui/workspaces", server.url))
            .bearer_auth(TOKEN)
            .header("cookie", &cookie)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    for body in [
        r#"{"revision":0,"mutation_id":"bad","theme":"light","sidebar_width":280,"selected":{"a":"b","a":"c"},"run_colors":{}}"#,
        r#"{"revision":0,"mutation_id":"bad","theme":"system","sidebar_width":280,"selected":{},"run_colors":{}}"#,
        r#"{"revision":0,"mutation_id":"bad","theme":"light","sidebar_width":280.5,"selected":{},"run_colors":{}}"#,
        r#"{"revision":0,"mutation_id":"bad","theme":"light","sidebar_width":280,"selected":null,"run_colors":{}}"#,
    ] {
        let response = client
            .put(format!("{}/api/ui/browser", server.url))
            .bearer_auth(TOKEN)
            .header("cookie", &cookie)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let state = fixture
        .engine
        .ui_state(Some(cookie.strip_prefix("rvx_browser=").unwrap()))
        .unwrap()
        .state;
    assert_eq!(state.workspaces.revision, 0);
    assert!(state.workspaces.sets.is_empty());
    server.close().await;
}

#[tokio::test]
async fn ui_http_run_colors_require_full_schema_and_preserve_browser_cas() {
    let fixture = Fixture::new();
    let run = fixture
        .engine
        .create_run(&fixture.experiment, "colored", "{}")
        .unwrap()
        .id;
    let project = fixture.engine.list_projects().unwrap()[0].id.clone();
    let other_experiment = fixture
        .engine
        .create_experiment(&project, "comparison")
        .unwrap();
    let other_run = fixture
        .engine
        .create_run(&other_experiment.id, "also-colored", "{}")
        .unwrap()
        .id;
    let server = Server::new(&fixture, None).await;
    let client = client();
    let (one, _) = bootstrap(&client, &server).await;
    let (two, _) = bootstrap(&client, &server).await;
    let mut prefs = json!({"revision":0,"mutation_id":"colors","theme":"light","sidebar_width":280,"selected":{}});
    let missing = put(&client, &server, "browser", &one, &prefs).await;
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    let error = missing.json::<Value>().await.unwrap();
    assert!(error["error"].as_str().unwrap().contains("run_colors"));
    prefs["run_colors"] = json!({run.clone():"#aBcD09",other_run:"#FE1023"});
    let response = put(&client, &server, "browser", &one, &prefs).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value = response.json().await.unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["run_colors"], prefs["run_colors"]);
    assert_eq!(
        put(&client, &server, "browser", &one, &prefs)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        saved
    );
    let mut stale = prefs.clone();
    stale["mutation_id"] = json!("stale-colors");
    stale["run_colors"][&run] = json!("#FFFFFF");
    let response = put(&client, &server, "browser", &one, &stale).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.json::<Value>().await.unwrap()["current"], saved);
    for overrides in [
        json!({run.clone():"red"}),
        json!({run.clone():"url(https://example.test/color)"}),
        json!({run.clone():"#abc"}),
        json!({"run_missing":"#123456"}),
        Value::Null,
        json!([]),
    ] {
        let mut invalid = prefs.clone();
        invalid["revision"] = json!(1);
        invalid["mutation_id"] = json!("bad-colors");
        invalid["run_colors"] = overrides;
        let response = put(&client, &server, "browser", &one, &invalid).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("run_colors"));
    }
    let duplicate = format!(
        r##"{{"revision":1,"mutation_id":"duplicate","theme":"light","sidebar_width":280,"selected":{{}},"run_colors":{{"{run}":"#123456","{run}":"#abcdef"}}}}"##
    );
    let response = client
        .put(format!("{}/api/ui/browser", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &one)
        .header("content-type", "application/json")
        .body(duplicate)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    for (cookie, colors, revision) in [(&one, saved["run_colors"].clone(), 1), (&two, json!({}), 0)]
    {
        let state: Value = client
            .get(format!("{}/api/ui/state", server.url))
            .bearer_auth(TOKEN)
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state["browser"]["run_colors"], colors);
        assert_eq!(state["browser"]["revision"], revision);
        assert_eq!(state["workspaces"]["revision"], 0);
    }
    server.close().await;
}

#[tokio::test]
async fn ui_http_column_decimals_roundtrip_and_reject_invalid_numbers_without_mutation() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let client = client();
    let (cookie, _) = bootstrap(&client, &server).await;
    let mut request = fixture.workspace(0, "precision");
    request["sets"][0]["panels"] = json!([
        {"kind":"metric-table","id":"metric","sectionId":"section","size":"normal","paths":["/loss"],
            "columns":[{"id":"current","width":130.5,"hidden":false,"decimals":0},{"id":"average","width":170.0}],
            "query":{"sort":{"path":"current","direction":"desc"},"filters":[
                {"path":"current","op":"gt","value":"1","enabled":false},
                {"path":"average","op":"lt","value":"10"}
            ]}},
        {"kind":"snapshot-table","id":"snapshot","sectionId":"section","size":"wide","path":"/records",
            "columns":[{"id":"/value","decimals":20,"hidden":true}],
            "query":{"sort":{"path":"/value","direction":"asc"}}}
    ]);
    let response = put(&client, &server, "workspaces", &cookie, &request).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value = response.json().await.unwrap();
    assert_eq!(saved["sets"], request["sets"]);
    assert!(saved["sets"][0]["panels"][0]["columns"][1]
        .get("decimals")
        .is_none());
    for decimals in [json!(-1), json!(21), json!(1.5), Value::Null, json!("Auto")] {
        let mut invalid = request.clone();
        invalid["revision"] = json!(1);
        invalid["mutation_id"] = json!("bad-precision");
        invalid["sets"][0]["panels"][0]["columns"][0]["decimals"] = decimals;
        let response = put(&client, &server, "workspaces", &cookie, &invalid).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("decimals"));
    }
    for enabled in [Value::Null, json!(0), json!("false")] {
        let mut invalid = request.clone();
        invalid["revision"] = json!(1);
        invalid["mutation_id"] = json!("bad-filter-enabled");
        invalid["sets"][0]["panels"][0]["query"]["filters"][0]["enabled"] = enabled;
        let response = put(&client, &server, "workspaces", &cookie, &invalid).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("enabled"));
    }
    let mut nonfinite = request;
    nonfinite["revision"] = json!(1);
    nonfinite["mutation_id"] = json!("nonfinite-precision");
    nonfinite["sets"][0]["panels"][0]["columns"][0]["decimals"] = json!("NONFINITE");
    let response = client
        .put(format!("{}/api/ui/workspaces", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &cookie)
        .header("content-type", "application/json")
        .body(nonfinite.to_string().replace("\"NONFINITE\"", "1e400"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let state: Value = client
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["workspaces"], saved);
    server.close().await;
}

async fn status(request: axum::http::Request<()>) -> StatusCode {
    match connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status(),
        other => panic!("expected rejected handshake, got {other:?}"),
    }
}

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn assert_close(message: Message, expected: u16) {
    match message {
        Message::Close(Some(frame)) => {
            assert_eq!(u16::from(frame.code), expected, "{}", frame.reason)
        }
        other => panic!("expected close {expected}, got {other:?}"),
    }
}

#[tokio::test]
async fn ui_websocket_real_upgrade_requires_auth_and_exact_origin_without_url_credentials() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    assert_eq!(
        status(server.ws_request(Some(&server.url), false, "")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(server.ws_request(Some(&server.url), false, &format!("?token={TOKEN}"))).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(server.ws_request(Some(&server.url), true, "?token=ignored")).await,
        StatusCode::BAD_REQUEST
    );
    for origin in [
        None,
        Some("null"),
        Some("https://foreign.example"),
        Some("http://rvx:password@127.0.0.1"),
        Some("https://foreign.example/path"),
    ] {
        assert_eq!(
            status(server.ws_request(origin, true, "")).await,
            StatusCode::FORBIDDEN
        );
    }
    let mut crossed = server.ws_request(Some(&server.url), true, "");
    crossed
        .headers_mut()
        .insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert_eq!(status(crossed).await, StatusCode::FORBIDDEN);
    let mut request = server.ws_request(Some(&server.url), true, "");
    request.headers_mut().insert(
        "authorization",
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("rvx:{TOKEN}"))
        )
        .parse()
        .unwrap(),
    );
    let (mut socket, upgraded) = connect_async(request).await.unwrap();
    assert_eq!(upgraded.status(), StatusCode::SWITCHING_PROTOCOLS);
    socket
        .send(Message::Text(
            r#"{"type":"ping","id":"actual-roundtrip"}"#.into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(next(&mut socket).await.to_text().unwrap()).unwrap(),
        json!({"type":"pong","id":"actual-roundtrip"})
    );
    socket.send(Message::Ping(vec![1, 2, 3])).await.unwrap();
    assert_eq!(next(&mut socket).await, Message::Pong(vec![1, 2, 3]));
    let id = format!("{}\t", "a".repeat(63));
    socket
        .send(Message::Text(json!({"type":"ping","id":id}).to_string()))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(next(&mut socket).await.to_text().unwrap()).unwrap(),
        json!({"type":"pong","id":id})
    );
    server.close().await;
    assert_close(next(&mut socket).await, 1001);
}

#[tokio::test]
async fn ui_https_public_origin_sets_secure_cookie_and_is_required_for_websocket() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, Some("https://rvx.example")).await;
    let response = client()
        .get(format!("{}/api/ui/state", server.url))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert!(response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("; Secure"));
    assert_eq!(
        status(server.ws_request(Some(&server.url), true, "")).await,
        StatusCode::FORBIDDEN
    );
    let mut socket = connect_async(server.ws_request(Some("https://rvx.example"), true, ""))
        .await
        .unwrap()
        .0;
    socket
        .send(Message::Text(r#"{"type":"ping","id":"proxy"}"#.into()))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(next(&mut socket).await.to_text().unwrap()).unwrap()["id"],
        "proxy"
    );
    server.close().await;
    assert_close(next(&mut socket).await, 1001);
}

#[tokio::test]
async fn ui_websocket_rejects_invalid_oversized_and_high_rate_messages() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let messages = [
        Message::Binary(vec![1]),
        Message::Text("not JSON".into()),
        Message::Text(r#"{"type":"pong","id":"no-ack-loop"}"#.into()),
        Message::Text(r#"{"type":"ping","id":"ok","data":"not-reflected"}"#.into()),
        Message::Text(json!({"type":"ping","id":""}).to_string()),
        Message::Text(json!({"type":"ping","id":"x".repeat(65)}).to_string()),
        Message::Text(json!({"type":"ping","id":"é"}).to_string()),
        Message::Text(json!({"type":"ping","id":123}).to_string()),
    ];
    for message in messages {
        let mut socket = server.socket().await;
        socket.send(message).await.unwrap();
        assert_close(next(&mut socket).await, 1008);
    }
    let mut socket = server.socket().await;
    socket.send(Message::Text("x".repeat(1025))).await.unwrap();
    assert_close(next(&mut socket).await, 1009);
    let mut socket = server.socket().await;
    for id in 0..10 {
        socket
            .send(Message::Text(
                json!({"type":"ping","id":id.to_string()}).to_string(),
            ))
            .await
            .unwrap();
        assert!(matches!(next(&mut socket).await, Message::Text(_)));
    }
    socket
        .send(Message::Text(
            r#"{"type":"ping","id":"rate-limited"}"#.into(),
        ))
        .await
        .unwrap();
    assert_close(next(&mut socket).await, 1008);
    server.close().await;
}

#[tokio::test]
async fn ui_websocket_idle_timeout_closes_without_application_ack_loops() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let mut socket = server.socket().await;
    let message = tokio::time::timeout(Duration::from_secs(35), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_close(message, 1008);
    server.close().await;
}

#[tokio::test]
async fn ui_websocket_global_capacity_and_shutdown_are_bounded() {
    let fixture = Fixture::new();
    let server = Server::new(&fixture, None).await;
    let mut sockets = Vec::new();
    for _ in 0..128 {
        sockets.push(server.socket().await);
    }
    assert_eq!(
        status(server.ws_request(Some(&server.url), true, "")).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    tokio::time::timeout(Duration::from_secs(3), server.connections.shutdown())
        .await
        .unwrap();
    for socket in &mut sockets {
        assert_close(next(socket).await, 1001);
    }
    assert_eq!(
        status(server.ws_request(Some(&server.url), true, "")).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    server.close().await;
}
