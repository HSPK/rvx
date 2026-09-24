use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use rvx_engine::Engine;
use tokio::sync::watch;

#[tokio::main]
async fn main() -> Result<()> {
    let Some(options) = Options::parse(std::env::args().skip(1))? else {
        return Ok(());
    };
    let access = rvx_server::AccessPolicy::from_env()?;
    access.validate_listener(options.listen)?;
    let engine = Engine::open(&options.data_directory).context("open experiment engine")?;
    rvx_server::apply_config(&options.configuration, &engine).context("apply RVX config")?;
    let connections = rvx_server::UiConnections::new();
    let application = rvx_server::application_with_access_and_connections(
        engine.clone(),
        options.ui_directory,
        access,
        connections.clone(),
    )?;
    let listener = tokio::net::TcpListener::bind(options.listen)
        .await
        .context("bind experiment server")?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let scraper = tokio::spawn(
        engine
            .clone()
            .run_scraper(options.scrape_concurrency, shutdown_rx),
    );
    println!("rvxd listening on http://{}", listener.local_addr()?);
    let coordinator_shutdown = shutdown_tx.clone();
    let connection_shutdown = connections.clone();
    let result = axum::serve(
        listener,
        application.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = coordinator_shutdown.send(true);
        connection_shutdown.shutdown().await;
    })
    .await;
    let _ = shutdown_tx.send(true);
    connections.shutdown().await;
    scraper.await.context("join scrape coordinator")?;
    result.context("serve Rvx HTTP")?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

struct Options {
    data_directory: PathBuf,
    ui_directory: PathBuf,
    listen: SocketAddr,
    scrape_concurrency: usize,
    configuration: rvx_server::config::RvxConfig,
}

impl Options {
    fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Option<Self>> {
        let mut config_path = None;
        let mut data_directory = None;
        let mut ui_directory = None;
        let mut listen = None;
        let mut scrape_concurrency = None;
        while let Some(argument) = arguments.next() {
            if argument == "--version" || argument == "-V" {
                println!("rvxd {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            if argument == "--help" || argument == "-h" {
                println!(
                    "Usage: rvxd [--config rvx.toml] [--data-dir PATH] \
                     [--listen 127.0.0.1:9110] [--ui-dir web/dist] \
                     [--scrape-concurrency 256]\n\
                     --data-dir may be supplied by [daemon] in the config.\n\
                     The data directory must have exactly one engine owner.\n\
                     Non-loopback listeners require RVX_API_TOKEN (32+ printable characters).\n\
                     Browser login: /login with RVX_API_TOKEN; CLI may use Bearer.\n\
                     Set RVX_PUBLIC_ORIGIN for an explicit HTTPS reverse-proxy origin."
                );
                return Ok(None);
            }

            let value = arguments
                .next()
                .with_context(|| format!("{argument} requires a value"))?;
            match argument.as_str() {
                "--config" => config_path = Some(PathBuf::from(value)),
                "--data-dir" => data_directory = Some(PathBuf::from(value)),
                "--ui-dir" => ui_directory = Some(PathBuf::from(value)),
                "--listen" => listen = Some(value.parse().context("parse --listen")?),
                "--scrape-concurrency" => {
                    scrape_concurrency = Some(value.parse().context("parse --scrape-concurrency")?)
                }
                _ => bail!("unknown option: {argument}"),
            }
        }
        let configuration = if let Some(path) = &config_path {
            rvx_server::config::load(path)?
        } else {
            rvx_server::config::RvxConfig::empty()
        };
        let base = config_path
            .as_deref()
            .and_then(|path| path.parent())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let config_path = |path: &PathBuf| {
            if path.is_absolute() {
                path.clone()
            } else {
                base.join(path)
            }
        };
        let data_directory = data_directory
            .or_else(|| configuration.daemon.data_dir.as_ref().map(config_path))
            .context("--data-dir is required unless daemon.data_dir is configured")?;
        let ui_directory = ui_directory
            .or_else(|| configuration.daemon.ui_dir.as_ref().map(config_path))
            .unwrap_or_else(default_ui_directory);
        let listen = match listen {
            Some(listen) => listen,
            None => configuration
                .daemon
                .listen
                .as_deref()
                .unwrap_or("127.0.0.1:9110")
                .parse()
                .context("parse daemon.listen")?,
        };
        let scrape_concurrency = scrape_concurrency
            .or(configuration.daemon.scrape_concurrency)
            .unwrap_or(256);
        if !(1..=1_000_000).contains(&scrape_concurrency) {
            bail!("--scrape-concurrency must be between 1 and 1000000");
        }

        fn default_ui_directory() -> PathBuf {
            let installed = std::env::current_exe()
                .ok()
                .and_then(|path| {
                    path.parent()
                        .and_then(|scripts| scripts.parent())
                        .map(PathBuf::from)
                })
                .map(|prefix| prefix.join("share/rvx/web"));
            if installed
                .as_ref()
                .is_some_and(|path| path.join("index.html").is_file())
            {
                installed.unwrap()
            } else {
                PathBuf::from("web/dist")
            }
        }
        Ok(Some(Self {
            data_directory,
            ui_directory,
            listen,
            scrape_concurrency,
            configuration,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Options>> {
        Options::parse(args.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn requires_explicit_storage_and_defaults_to_loopback() {
        assert!(parse(&[]).is_err());
        let options = parse(&["--data-dir", "fixture"]).unwrap().unwrap();
        assert_eq!(options.listen.to_string(), "127.0.0.1:9110");
        assert_eq!(options.ui_directory, PathBuf::from("web/dist"));
        assert!(parse(&["--help"]).unwrap().is_none());
        assert!(parse(&["--version"]).unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_limits_and_unknown_flags() {
        assert!(
            parse(&["--data-dir", "fixture", "--listen", "0.0.0.0:9110"])
                .unwrap()
                .is_some()
        );
        for args in [
            vec!["--data-dir", "fixture", "--hot-capacity", "0"],
            vec![
                "--data-dir",
                "fixture",
                "--hostmon-url",
                "http://127.0.0.1:9108",
            ],
            vec!["--data-dir", "fixture", "--scrape-concurrency", "0"],
            vec!["--data-dir", "fixture", "--unknown", "value"],
            vec!["--data-dir"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn config_supplies_daemon_defaults_and_cli_values_override_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rvx.toml");
        std::fs::write(
            &path,
            r#"
version = 1
[daemon]
data_dir = "data"
listen = "127.0.0.1:9120"
scrape_concurrency = 7
"#,
        )
        .unwrap();
        let options = Options::parse(
            [
                "--config".to_string(),
                path.display().to_string(),
                "--listen".to_string(),
                "127.0.0.1:9130".to_string(),
            ]
            .into_iter(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(options.data_directory, directory.path().join("data"));
        assert_eq!(options.listen.to_string(), "127.0.0.1:9130");
        assert_eq!(options.scrape_concurrency, 7);
    }
}
