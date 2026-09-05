use std::fs;
use std::time::Duration;

use rvx_core::SourceRegistration;
use rvx_engine::Engine;
use tokio::sync::watch;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let targets = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(10_000);
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root)?;
    let directory = tempfile::tempdir_in(root)?;
    let engine = Engine::open(directory.path(), 10_000)?;
    let project = engine.create_project("benchmark")?;
    let experiment = engine.create_experiment(&project.id, "scheduler")?;
    let run = engine.create_run(&experiment.id, "targets", "{}")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let endpoint = tokio::spawn(async move {
        while let Ok((connection, _)) = listener.accept().await {
            drop(connection);
        }
    });
    for index in 0..targets {
        engine.register_source(&SourceRegistration {
            run_id: run.id.clone(),
            attempt_id: "attempt-1".into(),
            role: "actor".into(),
            endpoint: format!("http://{address}/source-{index}"),
            node_id: Some(format!("node-{}", index % 128)),
            rank: Some(index as i64),
            scrape_interval_ms: 60_000,
            timeout_ms: 100,
        })?;
    }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let coordinator = tokio::spawn(engine.clone().run_scraper(128, shutdown_rx));
    tokio::time::sleep(Duration::from_secs(5)).await;
    let stats = engine.stats()?;
    let rss_mib = process_rss_mib()?;
    let _ = shutdown_tx.send(true);
    coordinator.await?;
    endpoint.abort();
    println!(
        "targets={} active_sources={} failures={} rss_mib={rss_mib:.2}",
        stats.sources, stats.active_sources, stats.scrape_failures
    );
    Ok(())
}

fn process_rss_mib() -> Result<f64, Box<dyn std::error::Error>> {
    let status = fs::read_to_string("/proc/self/status")?;
    let rss_kib = status
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")
                .and_then(|value| value.split_whitespace().next())
                .and_then(|value| value.parse::<f64>().ok())
        })
        .ok_or("VmRSS is unavailable")?;
    Ok(rss_kib / 1024.0)
}
