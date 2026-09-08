use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use reqwest::Client;
use rvx_engine::Engine;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[path = "http/tables.rs"]
mod table_tests;
#[path = "http/snapshot_views.rs"]
mod snapshot_view_tests;

struct Server {
    url: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(router: Router) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
                .unwrap();
        });
        Self {
            url,
            shutdown: Some(shutdown),
            task,
        }
    }

    async fn close(mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Fixture {
    directory: TempDir,
    engine: Arc<Engine>,
}

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let engine = Engine::open(directory.path().join("data")).unwrap();
        let ui = directory.path().join("ui");
        std::fs::create_dir_all(ui.join("assets")).unwrap();
        std::fs::write(ui.join("index.html"), "<!doctype html><title>RVX</title>").unwrap();
        std::fs::write(ui.join("assets/app.js"), "console.log('rvx');").unwrap();
        Self { directory, engine }
    }

    fn router(&self) -> Router {
        rvx_server::application(self.engine.clone(), self.directory.path().join("ui")).unwrap()
    }
}

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

#[tokio::test]
async fn authenticated_ui_and_api_allow_remote_same_origin_without_exposing_anonymous_data() {
    const TOKEN: &str = "fixture-token-0123456789abcdef0123456789abcdef";
    let fixture = Fixture::new();
    fixture.engine.create_project("private-project").unwrap();
    let router = rvx_server::application_with_access(
        fixture.engine.clone(),
        fixture.directory.path().join("ui"),
        rvx_server::AccessPolicy::authenticated(TOKEN, None).unwrap(),
    )
    .unwrap();
    let server = Server::start(router).await;
    let client = client();
    for path in [
        "/",
        "/rvx",
        "/assets/app.js",
        "/healthz",
        "/api/experiments/projects",
        "/api/status",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert!(response.headers()[header::WWW_AUTHENTICATE]
            .to_str()
            .unwrap()
            .starts_with("Bearer "));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.text().await.unwrap().contains("private-project"));
    }
    let incorrect = client
        .get(format!("{}/api/experiments/projects", server.url))
        .basic_auth("rvx", Some("wrong-password"))
        .send()
        .await
        .unwrap();
    assert_eq!(incorrect.status(), StatusCode::UNAUTHORIZED);

    for path in [
        "/rvx",
        "/assets/app.js",
        "/healthz",
        "/api/experiments/projects",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .header(header::HOST, "192.0.2.10:9110")
            .basic_auth("rvx", Some(TOKEN))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
    }
    let remote = client
        .post(format!("{}/api/snapshots/latest", server.url))
        .header(header::HOST, "192.0.2.10:9110")
        .header(header::ORIGIN, "http://192.0.2.10:9110")
        .header("sec-fetch-site", "same-origin")
        .bearer_auth(TOKEN)
        .json(&json!({"run_id":"no-observations-yet"}))
        .send()
        .await
        .unwrap();
    assert_eq!(remote.status(), StatusCode::OK);
    assert_eq!(
        remote.json::<Value>().await.unwrap()["snapshots"],
        json!([])
    );
    let cross_site = client
        .post(format!("{}/api/snapshots/latest", server.url))
        .header(header::HOST, "192.0.2.10:9110")
        .header(header::ORIGIN, "https://untrusted.example")
        .basic_auth("rvx", Some(TOKEN))
        .json(&json!({"run_id":"run"}))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);
    let cli = client
        .get(format!("{}/api/experiments/projects", server.url))
        .header(header::HOST, "192.0.2.10:9110")
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(cli.status(), StatusCode::OK);
    assert_eq!(
        cli.json::<Value>().await.unwrap()["projects"][0]["name"],
        "private-project"
    );
    server.close().await;
}

#[tokio::test]
async fn authenticated_https_proxy_requires_the_explicit_public_origin() {
    const TOKEN: &str = "fixture-token-0123456789abcdef0123456789abcdef";
    let fixture = Fixture::new();
    let router = rvx_server::application_with_access(
        fixture.engine.clone(),
        fixture.directory.path().join("ui"),
        rvx_server::AccessPolicy::authenticated(TOKEN, Some("https://rvx.example")).unwrap(),
    )
    .unwrap();
    let server = Server::start(router).await;
    let client = client();
    let accepted = client
        .post(format!("{}/api/snapshots/latest", server.url))
        .header(header::ORIGIN, "https://rvx.example")
        .bearer_auth(TOKEN)
        .json(&json!({"run_id":"run"}))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let rejected = client
        .post(format!("{}/api/snapshots/latest", server.url))
        .header(header::ORIGIN, "http://rvx.example")
        .bearer_auth(TOKEN)
        .header("x-forwarded-proto", "https")
        .json(&json!({"run_id":"run"}))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    server.close().await;
}

#[tokio::test]
async fn snapshot_pull_and_read_apis_preserve_structured_state_without_metric_writes() {
    use rvx_core::SourceRegistration;

    let fixture = Fixture::new();
    let project = fixture.engine.create_project("snapshots").unwrap();
    let experiment = fixture
        .engine
        .create_experiment(&project.id, "experiment")
        .unwrap();
    let run = fixture
        .engine
        .create_run(&experiment.id, "run", "{}")
        .unwrap();
    let descriptor = json!({
        "protocol_version":1,"schema_version":1,"source_session_id":"fixture-session",
        "project":"snapshots","experiment":"experiment","run_id":run.id,
        "attempt_id":"attempt","role":"learner","rank":0,"node_id":"node","pid":42,"labels":{}
    });
    let history = json!({
        "protocol_version":1,"source_session_id":"fixture-session","oldest_sequence":0,"next_sequence":2,"dropped_before":null,
        "snapshots":[
            {"source_session_id":"fixture-session","sequence":0,"schema_version":1,"observed_at_ns":10,
             "axes":{},"state":{"workers":[{"busy":true}],"removed":null,"loss":2}},
            {"source_session_id":"fixture-session","sequence":1,"schema_version":1,"observed_at_ns":20,
             "axes":{},"state":{"workers":[],"loss":false}}
        ]
    });
    let producer = Server::start(
        Router::new()
            .route(
                "/v1/snapshots/descriptor",
                get(move || {
                    let descriptor = descriptor.clone();
                    async move { Json(descriptor) }
                }),
            )
            .route(
                "/v1/snapshots/history",
                get(move || {
                    let history = history.clone();
                    async move { Json(history) }
                }),
            ),
    )
    .await;
    let source = fixture
        .engine
        .register_source(&SourceRegistration {
            run_id: run.id.clone(),
            attempt_id: "attempt".into(),
            role: "learner".into(),
            endpoint: producer.url.clone(),
            node_id: None,
            rank: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 2);
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 0);
    assert!(!fixture.directory.path().join("data/metrics.wal").exists());
    let stats = fixture.engine.stats().unwrap();
    assert_eq!(stats.snapshots, 2);
    assert_eq!(
        serde_json::to_value(stats)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        8
    );
    let server = Server::start(fixture.router()).await;
    let client = client();
    let mut results = Vec::new();
    for (route, request) in [
        ("latest", json!({"run_id":run.id})),
        ("history", json!({"run_id":run.id,"limit":1})),
        ("query", json!({"run_ids":[run.id],"paths":["/loss"]})),
        ("diff", json!({"before_id":1,"after_id":2})),
    ] {
        let url = format!("{}/api/snapshots/{route}", server.url);
        let rejected = client
            .post(&url)
            .header("origin", "https://evil.example")
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        let response = client.post(&url).json(&request).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        results.push(response.json::<Value>().await.unwrap());
    }
    assert_eq!(
        results[0]["snapshots"][0]["state"],
        json!({"workers":[],"loss":false})
    );
    assert_eq!(results[0]["snapshots"][0]["sequence"], 1);
    assert_eq!(results[1]["next_before_id"], 2);
    assert_eq!(results[2]["axis"], "wall_time");
    assert_eq!(results[2]["series"][0]["values"], json!([2.0, null]));
    assert_eq!(results[2]["series"][0]["snapshot_ids"], json!([1, 2]));
    let raw: Value = client
        .get(format!("{}/api/snapshots/1", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(raw["sequence"], 0);
    assert_eq!(raw["state"]["loss"], 2.0);
    let catalog: Value = client
        .post(format!("{}/api/charts/catalog", server.url))
        .json(&json!({"run_ids":[run.id]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["defaults"], json!(["/loss"]));
    assert_eq!(
        catalog["metrics"][0]["sources"][0]["latest_value"],
        Value::Null
    );
    let elapsed: Value = client
        .post(format!("{}/api/snapshots/query", server.url))
        .json(&json!({"run_ids":[run.id],"paths":["/loss"],"axis":"elapsed"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(elapsed["series"][0]["axes"], json!([0, 10]));
    assert!(results[3]["changes"]
        .as_array()
        .unwrap()
        .contains(&json!({"path":"/removed","kind":"removed","before":null})));
    for (route, request) in [
        ("history", json!({"run_id":run.id,"limit":257})),
        ("latest", json!({"run_id":run.id,"limit":0})),
        ("query", json!({"run_ids":[run.id],"paths":["/bad~2"]})),
        ("query", json!({"run_ids":[run.id],"paths":["/removed"]})),
        ("diff", json!({"before_id":1,"after_id":999})),
    ] {
        let response = client
            .post(format!("{}/api/snapshots/{route}", server.url))
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    for route in ["push", "ingest", "capture"] {
        let response = client
            .post(format!("{}/api/snapshots/{route}", server.url))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
    producer.close().await;
    server.close().await;
}

async fn create(client: &Client, server: &Server, kind: &str, payload: Value) -> Value {
    let response = client
        .post(format!("{}/api/experiments/{kind}", server.url))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response.json().await.unwrap()
}

#[tokio::test]
async fn static_routes_and_native_management_are_independent() {
    let fixture = Fixture::new();
    let server = Server::start(fixture.router()).await;
    let client = client();
    for path in [
        "/rvx",
        "/rvx/",
        "/rvx/projects/demo",
        "/rvx/workspace/run-1",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        assert!(response
            .text()
            .await
            .unwrap()
            .contains("<title>RVX</title>"));
    }
    let root = client.get(&server.url).send().await.unwrap();
    assert_eq!(root.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(root.headers()[header::LOCATION], "/rvx");
    let script = client
        .get(format!("{}/assets/app.js", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(script.status(), StatusCode::OK);
    assert_eq!(script.text().await.unwrap(), "console.log('rvx');");

    let project = create(&client, &server, "projects", json!({"name": "demo"})).await;
    let experiment = create(
        &client,
        &server,
        "experiments",
        json!({"project_id": project["id"], "name": "experiment"}),
    )
    .await;
    let run = create(
        &client,
        &server,
        "runs",
        json!({"experiment_id": experiment["id"], "name": "run", "config": {"seed": 1}}),
    )
    .await;
    let source = create(
        &client,
        &server,
        "sources",
        json!({
            "run_id": run["id"], "attempt_id": "attempt-1", "role": "learner",
            "endpoint": "http://127.0.0.1:1/learner"
        }),
    )
    .await;
    for (kind, field, id) in [
        ("experiments", "project_id", project["id"].as_str().unwrap()),
        ("runs", "experiment_id", experiment["id"].as_str().unwrap()),
        ("sources", "run_id", run["id"].as_str().unwrap()),
    ] {
        let response: Value = client
            .get(format!("{}/api/experiments/{kind}", server.url))
            .query(&[(field, id)])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response[kind].as_array().unwrap().len(), 1);
    }
    for (kind, id, field, value) in [
        ("sources", &source["id"], "state", "draining"),
        ("runs", &run["id"], "status", "finished"),
    ] {
        let response = client
            .patch(format!(
                "{}/api/experiments/{kind}/{}",
                server.url,
                id.as_str().unwrap()
            ))
            .json(&json!({field: value}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()[field], value);
    }
    for route in ["query", "query-summaries"] {
        let response = client
            .post(format!("{}/api/experiments/{route}", server.url))
            .json(&json!({"run_ids": [run["id"]]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    for path in [
        "/api/no-such-route",
        "/api/experiments/import",
        "/api/experiments/ingest",
        "/api/experiments/compact",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"],
            "not found"
        );
    }
    let missing = client
        .get(format!("{}/assets/missing.js", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert!(!missing.text().await.unwrap().contains("<!doctype html>"));
    let malformed = client
        .post(format!("{}/api/experiments/projects", server.url))
        .header(header::CONTENT_TYPE, "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    let invalid_source = client
        .post(format!("{}/api/experiments/sources", server.url))
        .json(&json!({
            "run_id": run["id"], "attempt_id": "a", "role": "learner",
            "endpoint": "file:///metrics.jsonl"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_source.status(), StatusCode::BAD_REQUEST);
    server.close().await;
}

#[tokio::test]
async fn removed_routes_do_not_redirect_or_proxy() {
    let fixture = Fixture::new();
    let server = Server::start(fixture.router()).await;
    let client = client();
    for path in [
        "/ryx",
        "/ryx/",
        "/ryx/workspace",
        "/hostmon",
        "/api/hostmon",
        "/api/status",
        "/api/catalog",
        "/api/collectors",
        "/api/rules",
        "/api/plugins/cluster_gpu_usage",
        "/api/experiments/query",
        "/api/experiments/query-summaries",
        "/ryx-other",
        "/api/ryx",
        "/api/no-such-route",
        "/assets/missing.js",
    ] {
        let response = client
            .get(format!("{}{path}", server.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(!response.headers().contains_key(header::LOCATION));
        assert!(!response.text().await.unwrap().contains("<!doctype html>"));
    }
    server.close().await;
}

#[tokio::test]
async fn browser_mutations_require_same_origin_but_cli_needs_no_origin() {
    let fixture = Fixture::new();
    let server = Server::start(fixture.router()).await;
    let client = client();
    let url = format!("{}/api/experiments/projects", server.url);
    for (name, value) in [
        ("origin", "http://evil.example"),
        ("origin", "null"),
        ("referer", "http://evil.example/path"),
        ("sec-fetch-site", "cross-site"),
        ("host", "evil.example"),
    ] {
        let response = client
            .post(&url)
            .header(name, value)
            .json(&json!({"name": "blocked"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{name}: {value}");
    }
    assert!(fixture.engine.list_projects().unwrap().is_empty());
    let accepted = client
        .post(&url)
        .header(header::ORIGIN, &server.url)
        .header("sec-fetch-site", "same-origin")
        .json(&json!({"name": "browser"}))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::CREATED);
    create(&client, &server, "projects", json!({"name": "cli"})).await;
    server.close().await;
}
