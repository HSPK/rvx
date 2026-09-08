use super::*;
use rvx_core::SourceRegistration;

#[tokio::test]
async fn table_endpoints_preserve_auth_exact_statistics_cells_and_pinned_evidence() {
    const TOKEN: &str = "table-test-token-0123456789abcdef0123456789abcdef";
    let fixture = Fixture::new();
    let project = fixture.engine.create_project("tables").unwrap();
    let experiment = fixture
        .engine
        .create_experiment(&project.id, "records")
        .unwrap();
    let run = fixture
        .engine
        .create_run(&experiment.id, "run", "{}")
        .unwrap();
    let descriptor = json!({
        "protocol_version":1,"schema_version":1,"source_session_id":"tables-session",
        "project":"tables","experiment":"records","run_id":run.id,
        "attempt_id":"attempt","role":"worker","rank":0,"node_id":"node","pid":42,"labels":{}
    });
    let observations: Vec<Value> = (0..20)
        .map(|n| {
            json!({
                "source_session_id":"tables-session","sequence":n,"schema_version":1,
                "observed_at_ns":100+n*10,"axes":{"step":n},
                "state":{"n":n,"workers":[
                    {"rank":18446744073709551615u64,"name":"worker max"},
                    {"rank":9007199254740993u64,"name":"worker next"},
                    {"rank":9007199254740992u64,"name":"worker first"}
                ]}
            })
        })
        .collect();
    let history = Arc::new(std::sync::RwLock::new(json!({
        "protocol_version":1,"source_session_id":"tables-session","oldest_sequence":0,
        "next_sequence":20,"dropped_before":null,"snapshots":observations
    })));
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
                get({
                    let history = history.clone();
                    move || {
                        let page = history.read().unwrap().clone();
                        async move { Json(page) }
                    }
                }),
            ),
    )
    .await;
    let source = fixture
        .engine
        .register_source(&SourceRegistration {
            run_id: run.id.clone(),
            attempt_id: "attempt".into(),
            role: "worker".into(),
            endpoint: producer.url.clone(),
            node_id: None,
            rank: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 20);
    let server = Server::start(
        rvx_server::application_with_access(
            fixture.engine.clone(),
            fixture.directory.path().join("ui"),
            rvx_server::AccessPolicy::authenticated(TOKEN, None).unwrap(),
        )
        .unwrap(),
    )
    .await;
    let client = client();
    for route in ["summary", "catalog", "rows"] {
        let url = format!("{}/api/tables/{route}", server.url);
        assert_eq!(
            client
                .post(&url)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(TOKEN)
                .header(header::ORIGIN, "https://evil.example")
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let summary = client
        .post(format!("{}/api/tables/summary", server.url))
        .bearer_auth(TOKEN)
        .json(&json!({"run_ids":[run.id],"paths":["/n"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(summary.status(), StatusCode::OK);
    let summary: Value = summary.json().await.unwrap();
    assert_eq!(summary["axis"], "elapsed");
    assert_eq!(summary["rows"][0]["average"], 9.5);
    assert_eq!(summary["rows"][0]["p95"], 18.0);
    assert_eq!(summary["rows"][0]["count"], 20);
    assert_eq!(summary["rows"][0]["snapshot_id"], "20");
    assert_eq!(summary["rows"][0].as_object().unwrap().len(), 13);

    let catalog: Value = client
        .post(format!("{}/api/tables/catalog", server.url))
        .bearer_auth(TOKEN)
        .json(&json!({"run_ids":[run.id]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let workers = catalog["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["path"] == "/workers")
        .unwrap();
    assert_eq!(workers["sources"][0]["row_count"], 3);
    assert_eq!(workers["sources"][0]["source_id"], source.id);
    assert_eq!(workers["sources"][0]["snapshot_id"], "20");
    assert!(workers["columns"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["path"] == "/rank"));

    let request = json!({"run_ids":[run.id],"source_ids":[source.id],"path":"/workers",
        "sort":{"path":"/rank","direction":"asc"},"search":"worker","offset":0,"limit":1});
    let rows: Value = client
        .post(format!("{}/api/tables/rows", server.url))
        .bearer_auth(TOKEN)
        .json(&request)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rows["total"], 3);
    assert_eq!(rows["rows"][0]["row_key"], "2");
    assert_eq!(
        rows["rows"][0]["cells"]["/rank"],
        json!({"kind":"number","text":"9007199254740992","truncated":false})
    );
    assert_eq!(rows["rows"][0]["snapshot_id"], "20");
    let raw = client
        .get(format!("{}/api/snapshots/20", server.url))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(raw.contains("18446744073709551615"));

    {
        let mut history = history.write().unwrap();
        history["snapshots"].as_array_mut().unwrap().push(json!({
            "source_session_id":"tables-session","sequence":20,"schema_version":1,
            "observed_at_ns":300,"axes":{"step":20},"state":{"n":null,"workers":null}
        }));
        history["next_sequence"] = json!(21);
    }
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 1);
    let mut pinned = request.clone();
    pinned["snapshot_ids"] = json!(["20"]);
    pinned["offset"] = json!(1);
    let next: Value = client
        .post(format!("{}/api/tables/rows", server.url))
        .bearer_auth(TOKEN)
        .json(&pinned)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(next["total"], 3);
    assert_eq!(
        next["rows"][0]["cells"]["/rank"]["text"],
        "9007199254740993"
    );
    let current = client
        .post(format!("{}/api/tables/rows", server.url))
        .bearer_auth(TOKEN)
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::BAD_REQUEST);
    assert!(current.json::<Value>().await.unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("null"));
    let summary: Value = client
        .post(format!("{}/api/tables/summary", server.url))
        .bearer_auth(TOKEN)
        .json(&json!({"run_ids":[run.id],"paths":["/n"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(summary["rows"][0]["current"], Value::Null);
    assert_eq!(summary["rows"][0]["snapshot_id"], "21");
    assert_eq!(summary["rows"][0]["missing"], 1);
    assert_eq!(fixture.engine.stats().unwrap().snapshots, 21);
    producer.close().await;
    server.close().await;
}

#[tokio::test]
async fn table_http_invalid_shapes_bounds_and_ownership_are_json_400_errors() {
    let fixture = Fixture::new();
    let project = fixture.engine.create_project("tables").unwrap();
    let experiment = fixture
        .engine
        .create_experiment(&project.id, "invalid")
        .unwrap();
    let run = fixture
        .engine
        .create_run(&experiment.id, "run", "{}")
        .unwrap();
    let other = fixture
        .engine
        .create_run(&experiment.id, "other", "{}")
        .unwrap();
    let source = fixture
        .engine
        .register_source(&SourceRegistration {
            run_id: other.id,
            attempt_id: "attempt".into(),
            role: "worker".into(),
            endpoint: "http://127.0.0.1:1".into(),
            node_id: None,
            rank: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        })
        .unwrap();
    let server = Server::start(fixture.router()).await;
    let client = client();
    for (route, request) in [
        ("catalog", json!({"run_ids":[]})),
        ("catalog", json!({"run_ids":["unknown"]})),
        ("catalog", json!({"run_ids":[run.id,run.id]})),
        (
            "catalog",
            json!({"run_ids":[run.id],"source_ids":[source.id]}),
        ),
        ("catalog", json!({"run_ids":[run.id],"unexpected":true})),
        (
            "rows",
            json!({"run_ids":[run.id],"path":"","snapshot_ids":[]}),
        ),
        (
            "rows",
            json!({"run_ids":[run.id],"path":"","snapshot_ids":[1]}),
        ),
        ("rows", json!({"run_ids":[run.id],"path":"","limit":257})),
        ("rows", json!({"run_ids":[run.id],"path":"","limit":-1})),
        ("rows", json!({"run_ids":[run.id],"path":"","offset":1.5})),
        ("rows", json!({"run_ids":[run.id],"path":"/bad~2"})),
        (
            "rows",
            json!({"run_ids":[run.id],"path":"","sort":{"path":"$key","direction":"up"}}),
        ),
        (
            "rows",
            json!({"run_ids":[run.id],"path":"","filters":[{"path":"$key","op":"like","value":"x"}]}),
        ),
        (
            "rows",
            json!({"run_ids":[run.id],"path":"","filters":[{"path":"$key","op":"contains","value":"x","enabled":false}]}),
        ),
        (
            "summary",
            json!({"run_ids":[run.id],"paths":["/n"],"from":3,"to":2}),
        ),
        (
            "summary",
            json!({"run_ids":[run.id],"paths":["/n"],"from":1.5}),
        ),
        (
            "summary",
            json!({"run_ids":[run.id],"paths":["/n"],"axis":""}),
        ),
        ("summary", json!({"run_ids":[run.id],"paths":["/n","/n"]})),
    ] {
        let response = client
            .post(format!("{}/api/tables/{route}", server.url))
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{route}: {request}"
        );
        assert!(response.json::<Value>().await.unwrap()["error"].is_string());
    }
    let malformed = client
        .post(format!("{}/api/tables/rows", server.url))
        .header(header::CONTENT_TYPE, "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert!(malformed.json::<Value>().await.unwrap()["error"].is_string());
    let mut first_source = None;
    for index in 0..257 {
        let registered = fixture
            .engine
            .register_source(&SourceRegistration {
                run_id: run.id.clone(),
                attempt_id: "attempt".into(),
                role: "worker".into(),
                endpoint: format!("http://127.0.0.1:1/source-{index}"),
                node_id: None,
                rank: None,
                scrape_interval_ms: 1000,
                timeout_ms: 500,
            })
            .unwrap();
        first_source.get_or_insert(registered.id);
    }
    let oversized = client
        .post(format!("{}/api/tables/catalog", server.url))
        .json(&json!({"run_ids":[run.id]}))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::BAD_REQUEST);
    assert!(oversized.json::<Value>().await.unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("256 Sources"));
    let selected = client
        .post(format!("{}/api/tables/catalog", server.url))
        .json(&json!({"run_ids":[run.id],"source_ids":[first_source.unwrap()]}))
        .send()
        .await
        .unwrap();
    assert_eq!(selected.status(), StatusCode::OK);
    assert_eq!(selected.json::<Value>().await.unwrap()["tables"], json!([]));
    server.close().await;
}
