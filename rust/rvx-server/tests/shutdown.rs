#![cfg(unix)]

use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rvx_core::SourceRegistration;
use rvx_engine::Engine;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[tokio::test]
async fn signals_stop_and_restart_daemon_with_stalled_snapshot_pull() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root).unwrap();
    let directory = tempfile::tempdir_in(root).unwrap();
    let data = directory.path().join("data");
    let ui = directory.path().join("ui");
    std::fs::create_dir_all(&ui).unwrap();
    std::fs::write(ui.join("index.html"), "<title>fixture</title>").unwrap();

    let producer = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let producer_url = format!("http://{}", producer.local_addr().unwrap());
    let entered = Arc::new(tokio::sync::Notify::new());
    let seen = entered.clone();
    let (stop_producer, producer_stopped) = tokio::sync::oneshot::channel();
    let producer_task = tokio::spawn(async move {
        let mut sockets = Vec::new();
        for _ in 0..2 {
            let (socket, _) = producer.accept().await.unwrap();
            sockets.push(socket);
            seen.notify_one();
        }
        let _ = producer_stopped.await;
        drop(sockets);
    });

    let engine = Engine::open(&data).unwrap();
    let project = engine.create_project("shutdown").unwrap();
    let experiment = engine.create_experiment(&project.id, "signals").unwrap();
    let run = engine.create_run(&experiment.id, "stalled", "{}").unwrap();
    engine
        .register_source(&SourceRegistration {
            run_id: run.id,
            attempt_id: "a".into(),
            role: "learner".into(),
            endpoint: producer_url,
            node_id: None,
            rank: None,
            scrape_interval_ms: 60_000,
            timeout_ms: 60_000,
        })
        .unwrap();
    drop(engine);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    const TOKEN: &str = "shutdown-auth-fixture-0123456789abcdef0123456789";
    let mut cookie = String::new();
    for signal in ["-TERM", "-INT"] {
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);
        let mut process = Process(
            Command::new(env!("CARGO_BIN_EXE_rvxd"))
                .env("RVX_API_TOKEN", TOKEN)
                .env_remove("RVX_PUBLIC_ORIGIN")
                .arg("--data-dir")
                .arg(&data)
                .arg("--ui-dir")
                .arg(&ui)
                .arg("--listen")
                .arg(address.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(response) = client
                    .get(format!("http://{address}/healthz"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                {
                    assert_eq!(response.text().await.unwrap(), "ok\n");
                    break;
                }
                assert!(
                    process.0.try_wait().unwrap().is_none(),
                    "rvxd exited before readiness"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        if !cookie.is_empty() {
            let restored: serde_json::Value = client
                .get(format!("http://{address}/api/auth/session"))
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                restored["authenticated"], true,
                "session must survive a real daemon restart"
            );
        }
        let login = client
            .post(format!("http://{address}/api/auth/login"))
            .header("origin", format!("http://{address}"))
            .header("cookie", &cookie)
            .json(&serde_json::json!({"password":TOKEN}))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), reqwest::StatusCode::OK);
        cookie = login.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let mut request = format!("ws://{address}/api/ui/connection")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("origin", format!("http://{address}").parse().unwrap());
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"ping","id":"before-signal"}"#.into(),
            ))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(pong.to_text().unwrap().contains("before-signal"));
        assert!(Command::new("kill")
            .arg(signal)
            .arg(process.0.id().to_string())
            .status()
            .unwrap()
            .success());
        let status = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(status) = process.0.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("daemon must stop without waiting for the 60-second producer timeout");
        assert!(status.success(), "daemon exited unsuccessfully: {status}");
        let close = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match close {
            Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1001),
            other => panic!("expected shutdown close, got {other:?}"),
        }
        assert!(!data.join("metrics.wal").exists());
    }
    let _ = stop_producer.send(());
    producer_task.await.unwrap();
}
