use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::OriginalUri;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use reqwest::Client;
use rvx_engine::Engine;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

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
        let engine = Engine::open(directory.path().join("data"), 100).unwrap();
        let ui = directory.path().join("ui");
        std::fs::create_dir_all(ui.join("assets")).unwrap();
        std::fs::write(ui.join("index.html"), "<!doctype html><title>RVX</title>").unwrap();
        std::fs::write(ui.join("assets/app.js"), "console.log('rvx');").unwrap();
        Self { directory, engine }
    }

    fn router(&self, hostmon_url: &str) -> Router {
        rvx_server::application(
            self.engine.clone(),
            self.directory.path().join("ui"),
            hostmon_url,
        )
        .unwrap()
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
    assert_eq!(stats.ingested_points, 0);
    assert_eq!(stats.wal_bytes, 0);
    let server = Server::start(fixture.router("http://127.0.0.1:1")).await;
    let client = client();
    let mut results = Vec::new();
    for (route, request) in [
        ("latest", json!({"run_id":run.id})),
        ("history", json!({"run_id":run.id,"limit":1})),
        (
            "query",
            json!({"run_ids":[run.id],"paths":["/loss","/removed"]}),
        ),
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
    assert!(results[3]["changes"]
        .as_array()
        .unwrap()
        .contains(&json!({"path":"/removed","kind":"removed","before":null})));
    for (route, request) in [
        ("history", json!({"run_id":run.id,"limit":257})),
        ("latest", json!({"run_id":run.id,"limit":0})),
        ("query", json!({"run_ids":[run.id],"paths":["/bad~2"]})),
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
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
    let server = Server::start(fixture.router("http://127.0.0.1:1")).await;
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
    for (route, payload, field) in [
        (
            "query",
            json!({"run_id": run["id"], "metrics": ["loss"], "max_points": 10}),
            "series",
        ),
        (
            "query-summaries",
            json!({"run_ids": [run["id"]], "metrics": ["loss"]}),
            "summaries",
        ),
    ] {
        let response = client
            .post(format!("{}/api/experiments/{route}", server.url))
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.json::<Value>().await.unwrap();
        assert!(body[field].is_array());
        if route == "query" {
            assert_eq!(body["axis"], "wall_time");
        }
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
async fn legacy_ui_bookmarks_redirect_on_origin_with_exact_queries() {
    let fixture = Fixture::new();
    let server = Server::start(fixture.router("http://127.0.0.1:1")).await;
    let client = client();
    for path in [
        "/ryx",
        "/ryx/",
        "/ryx?filter=running%20jobs&filter=x+y",
        "/ryx/projects/project%201/experiments/experiment-1?filter=a%2Fb",
        "/ryx/workspace?runs=run-1%2Crun-2&return=%2Fryx%2Fruns",
        "/ryx/workspace?runs=run-1&return=https%3A%2F%2Fevil.example",
        "/ryx//evil.example/runs?next=https://evil.example",
    ] {
        for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
            let response = client
                .request(method, format!("{}{path}", server.url))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT, "{path}");
            let location = response.headers()[header::LOCATION].to_str().unwrap();
            assert_eq!(location, format!("/rvx{}", &path[4..]));
            let target = reqwest::Url::parse(&server.url).unwrap().join(location).unwrap();
            assert_eq!(target.origin(), reqwest::Url::parse(&server.url).unwrap().origin());
        }
    }
    for path in [
        "/ryx-other",
        "/api/ryx",
        "/api/no-such-route",
        "/assets/missing.js",
    ] {
        let response = client.get(format!("{}{path}", server.url)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(!response.headers().contains_key(header::LOCATION));
        assert!(!response.text().await.unwrap().contains("<!doctype html>"));
    }
    server.close().await;
}

#[tokio::test]
async fn hostmon_proxy_is_read_only_exact_and_preserves_upstream_errors() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let upstream = Server::start(Router::new().fallback(get(
        move |OriginalUri(uri): OriginalUri| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(uri.to_string());
                if uri.path() == "/monitor/api/rules" {
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({"error": "fixture"})),
                    )
                        .into_response();
                }
                if uri.path() == "/monitor/api/collectors" {
                    return (StatusCode::FOUND, [(header::LOCATION, "/api/control")])
                        .into_response();
                }
                Json(json!({"path": uri.path(), "query": uri.query()})).into_response()
            }
        },
    )))
    .await;
    let fixture = Fixture::new();
    let hostmon_url = format!("{}/monitor", upstream.url);
    let server = Server::start(fixture.router(&hostmon_url)).await;
    let client = client();
    for path in [
        "/api/status",
        "/api/catalog",
        "/api/plugins/cluster_gpu_usage",
    ] {
        let result: Value = client
            .get(format!("{}{path}?limit=3&cursor=a%2Fb", server.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["path"], format!("/monitor{path}"));
        assert_eq!(result["query"], "limit=3&cursor=a%2Fb");
    }
    let unavailable = client
        .get(format!("{}/api/rules", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        unavailable.json::<Value>().await.unwrap()["error"],
        "fixture"
    );
    let redirect = client
        .get(format!("{}/api/collectors", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), StatusCode::FOUND);
    assert!(!redirect.headers().contains_key(header::LOCATION));
    let info: Value = client
        .get(format!("{}/api/hostmon", server.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["url"], hostmon_url);
    let legacy = client
        .get(format!("{}/hostmon", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(legacy.headers()[header::LOCATION], hostmon_url);
    let settings = client
        .get(format!("{}/hostmon?page=settings", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        settings.headers()[header::LOCATION],
        format!("{hostmon_url}?page=settings")
    );
    let layouts = client
        .get(format!("{}/hostmon?page=layouts", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        layouts.headers()[header::LOCATION],
        format!("{hostmon_url}?page=layouts")
    );
    let arbitrary = client
        .get(format!(
            "{}/hostmon?page=other&url=http://evil.example",
            server.url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(arbitrary.headers()[header::LOCATION], hostmon_url);
    let count = requests.lock().unwrap().len();
    for path in [
        "/api/status/extra",
        "/api/control",
        "/api/proxy?url=http://example.com",
    ] {
        assert_eq!(
            client
                .get(format!("{}{path}", server.url))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        client
            .post(format!("{}/api/status", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(requests.lock().unwrap().len(), count);
    upstream.close().await;
    let unavailable = client
        .get(format!("{}/api/status", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::BAD_GATEWAY);
    assert!(unavailable.json::<Value>().await.unwrap()["error"].is_string());
    server.close().await;
}

#[tokio::test]
async fn browser_mutations_require_same_origin_but_cli_needs_no_origin() {
    let fixture = Fixture::new();
    let server = Server::start(fixture.router("http://127.0.0.1:1")).await;
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

#[test]
fn invalid_hostmon_configuration_fails_before_serving() {
    let fixture = Fixture::new();
    for url in [
        "file:///unused",
        "http://user:password@127.0.0.1",
        "http://127.0.0.1?url=other",
        "http://127.0.0.1#fragment",
    ] {
        assert!(rvx_server::application(
            fixture.engine.clone(),
            fixture.directory.path().to_path_buf(),
            url
        )
        .is_err());
    }
}
