use super::*;
use rvx_core::SourceRegistration;

#[tokio::test]
async fn snapshot_view_endpoints_keep_auth_exact_cells_pins_and_canonical_workspace_state() {
    const TOKEN: &str = "snapshot-view-fixture-0123456789abcdef0123456789";
    let fixture = Fixture::new();
    let project = fixture.engine.create_project("views").unwrap();
    let experiment = fixture
        .engine
        .create_experiment(&project.id, "collections")
        .unwrap();
    let run = fixture
        .engine
        .create_run(&experiment.id, "tasks", "{}")
        .unwrap();
    let descriptor = json!({"protocol_version":1,"schema_version":1,"source_session_id":"view-session",
        "project":"views","experiment":"collections","run_id":run.id,"attempt_id":"attempt","role":"worker","rank":null,"node_id":null,"pid":42,"labels":{}});
    let history = Arc::new(std::sync::RwLock::new(
        json!({"protocol_version":1,"source_session_id":"view-session",
        "oldest_sequence":0,"next_sequence":1,"dropped_before":null,"snapshots":[{
            "source_session_id":"view-session","sequence":0,"schema_version":1,"observed_at_ns":100,"axes":{},
            "state":{"tasks":[{"id":18446744073709551615u64,"state":"running","n":18446744073709551615u64},
                {"id":"other","state":"running","n":18446744073709551615u64},{"id":"","state":null,"n":0}]}
        }]}),
    ));
    let producer = Server::start(
        Router::new()
            .route(
                "/v1/snapshots/descriptor",
                get(move || {
                    let value = descriptor.clone();
                    async move { Json(value) }
                }),
            )
            .route(
                "/v1/snapshots/history",
                get({
                    let history = history.clone();
                    move || {
                        let value = history.read().unwrap().clone();
                        async move { Json(value) }
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
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 1);
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
    for endpoint in ["aggregate", "records"] {
        let url = format!("{}/api/snapshots/{endpoint}", server.url);
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
                .header("origin", "https://foreign.example")
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let invalid = client
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({"run_ids":[run.id],"path":"/tasks","raw_state":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert!(invalid.json::<Value>().await.unwrap()["error"].is_string());
    }
    let login = client
        .post(format!("{}/api/auth/login", server.url))
        .header("origin", &server.url)
        .json(&json!({"password":TOKEN}))
        .send()
        .await
        .unwrap();
    let session = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let aggregate_request = json!({"run_ids":[run.id],"path":"/tasks","group_by":["/state"],"measures":[{"id":"sum","op":"sum","path":"/n"}],
        "order":{"measure":"sum","direction":"desc"},"limit":1});
    let response = client
        .post(format!("{}/api/snapshots/aggregate", server.url))
        .header("cookie", &session)
        .json(&aggregate_request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let aggregate: Value = response.json().await.unwrap();
    assert_eq!(
        (
            aggregate["total_groups"].as_u64(),
            aggregate["matched_rows"].as_u64()
        ),
        (Some(2), Some(3))
    );
    assert_eq!(
        aggregate["groups"][0]["series"][0]["measures"]["sum"]["value"]["text"],
        "36893488147419103230"
    );
    assert_eq!(aggregate["groups"][0]["series"][0]["source_id"], source.id);
    let records_request = json!({"run_ids":[run.id],"path":"/tasks","identity_paths":["/id"],"columns":["/id","/state"],"limit":2048});
    let response = client
        .post(format!("{}/api/snapshots/records", server.url))
        .header("cookie", &session)
        .json(&records_request)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let records: Value = response.json().await.unwrap();
    assert_eq!(records["identities"].as_array().unwrap().len(), 3);
    assert!(records["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["cells"]["/id"]["text"] == "18446744073709551615"));
    let bootstrap = client
        .get(format!("{}/api/ui/state", server.url))
        .header("cookie", &session)
        .send()
        .await
        .unwrap();
    let preferences = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let cookies = format!("{session}; {preferences}");
    let workspace = json!({"revision":0,"mutation_id":"collection-view","sets":[{"id":"saved-view","name":"Tasks","experimentId":experiment.id,
        "sections":[{"id":"s","name":"","collapsed":false}],"panels":[{"id":"panel","kind":"snapshot-table","sectionId":"s","size":"wide","path":"/tasks",
            "columns":[{"id":"/n","width":130.0,"decimals":20}],"query":{"filters":[{"path":"/state","op":"eq","value":"running","enabled":false}]},
            "view":{"type":"bar","categoryPath":"/state","valuePaths":[],"aggregation":"count","orientation":"horizontal","layout":"grouped","order":"value-desc","limit":50}}]}]});
    let response = client
        .put(format!("{}/api/ui/workspaces", server.url))
        .header("origin", &server.url)
        .header("cookie", &cookies)
        .json(&workspace)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved: Value = response.json().await.unwrap();
    assert_eq!(saved["sets"], workspace["sets"]);
    let mut invalid = workspace.clone();
    invalid["revision"] = json!(1);
    invalid["mutation_id"] = json!("invalid-view");
    invalid["sets"][0]["panels"][0]["view"]["limit"] = json!(51);
    assert_eq!(
        client
            .put(format!("{}/api/ui/workspaces", server.url))
            .header("cookie", &cookies)
            .json(&invalid)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let current: Value = client
        .get(format!("{}/api/ui/state", server.url))
        .header("cookie", &cookies)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(current["workspaces"], saved);
    for (sequence, tasks, total) in [(1, json!([{"id":"survivor"}]), 1), (2, json!([]), 0)] {
        {
            let mut history = history.write().unwrap();
            history["snapshots"].as_array_mut().unwrap().push(json!({
                "source_session_id":"view-session","sequence":sequence,"schema_version":1,
                "observed_at_ns":100+sequence*100,"axes":{},"state":{"tasks":tasks}
            }));
            history["next_sequence"] = json!(sequence + 1);
        }
        assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 1);
        let response = client
            .post(format!("{}/api/snapshots/records", server.url))
            .header("cookie", &session)
            .json(&records_request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let missing: Value = response.json().await.unwrap();
        assert_eq!(missing["total"], total);
        assert_eq!(missing["snapshots"][0]["row_count"], total);
        if total > 0 {
            assert_eq!(missing["rows"][0]["cells"]["/state"]["kind"], "missing");
        }
        let response = client
            .post(format!("{}/api/snapshots/aggregate", server.url))
            .header("cookie", &session)
            .json(&aggregate_request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let missing: Value = response.json().await.unwrap();
        assert_eq!(missing["matched_rows"], total);
        if total > 0 {
            assert_eq!(missing["groups"][0]["cells"][0]["kind"], "missing");
            assert_eq!(
                missing["groups"][0]["series"][0]["measures"]["sum"]["missing"],
                total
            );
            assert_eq!(
                missing["groups"][0]["series"][0]["measures"]["sum"]["value"]["kind"],
                "missing"
            );
        } else {
            assert_eq!(missing["total_groups"], 0);
        }
    }
    {
        let mut history = history.write().unwrap();
        history["snapshots"].as_array_mut().unwrap().push(json!({"source_session_id":"view-session","sequence":3,"schema_version":1,"observed_at_ns":400,"axes":{},"state":{"tasks":null}}));
        history["next_sequence"] = json!(4);
    }
    assert_eq!(fixture.engine.scrape_source(&source).await.unwrap(), 1);
    for (endpoint, mut request, previous) in [
        ("aggregate", aggregate_request, aggregate),
        ("records", records_request, records),
    ] {
        let url = format!("{}/api/snapshots/{endpoint}", server.url);
        let current = client
            .post(&url)
            .header("cookie", &session)
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(current.status(), StatusCode::BAD_REQUEST);
        assert!(current.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("null"));
        request["snapshot_ids"] = json!(["1"]);
        assert_eq!(
            client
                .post(&url)
                .header("cookie", &session)
                .json(&request)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap(),
            previous
        );
    }
    assert_eq!(fixture.engine.stats().unwrap().snapshots, 4);
    server.close().await;
    producer.close().await;
}
