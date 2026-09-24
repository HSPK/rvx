mod api;
mod tui;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use url::form_urlencoded;

use api::{ApiClient, DEFAULT_URL};

#[derive(Parser)]
#[command(
    name = "rvx",
    version,
    about = "Local-first full-state snapshot observability."
)]
struct Cli {
    #[arg(long, global = true, env = "RVX_URL")]
    url: Option<String>,
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    #[command(about = "Run the config-driven native daemon with the bundled Web UI")]
    Daemon(DaemonArgs),
    #[command(about = "Run the central native daemon with the bundled Web UI")]
    Serve(DaemonArgs),
    Status,
    #[command(subcommand)]
    Projects(ProjectCommand),
    #[command(subcommand)]
    Experiments(ExperimentCommand),
    #[command(subcommand)]
    Runs(RunCommand),
    #[command(subcommand)]
    Sources(SourceCommand),
    #[command(subcommand)]
    Snapshots(SnapshotCommand),
    Catalog(CatalogArgs),
    Query(QueryArgs),
    #[command(about = "Export tracker spans as a Chrome/Perfetto trace")]
    Trace(TraceArgs),
    #[command(about = "Show the latest running training Run in a terminal dashboard")]
    Tui(TuiArgs),
}

#[derive(Args)]
struct DaemonArgs {
    #[arg(long, required_unless_present = "data_dir")]
    config: Option<PathBuf>,
    #[arg(long, required_unless_present = "config")]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    listen: Option<String>,
    #[arg(long)]
    ui_dir: Option<PathBuf>,
    #[arg(long)]
    scrape_concurrency: Option<usize>,
}

#[derive(Subcommand)]
enum ProjectCommand {
    List,
    Create { name: String },
}

#[derive(Subcommand)]
enum ExperimentCommand {
    List {
        #[arg(long)]
        project: Option<String>,
    },
    Create {
        #[arg(long)]
        project: String,
        name: String,
    },
}

#[derive(Subcommand)]
enum RunCommand {
    List {
        #[arg(long)]
        experiment: Option<String>,
    },
    Create {
        #[arg(long)]
        experiment: String,
        #[arg(long, default_value = "{}")]
        config: String,
        name: String,
    },
    Update {
        #[arg(long)]
        run: String,
        #[arg(long, value_parser = ["running", "finished", "failed", "cancelled"])]
        status: String,
    },
}

#[derive(Subcommand)]
enum SourceCommand {
    List {
        #[arg(long)]
        run: Option<String>,
    },
    Register {
        #[arg(long)]
        run: String,
        #[arg(long, default_value = "attempt-1")]
        attempt: String,
        #[arg(long)]
        role: String,
        #[arg(long)]
        endpoint: String,
        #[arg(long)]
        node: Option<String>,
        #[arg(long)]
        rank: Option<i64>,
        #[arg(long, default_value_t = 1_000)]
        interval_ms: u64,
        #[arg(long, default_value_t = 5_000)]
        timeout_ms: u64,
    },
    Update {
        #[arg(long)]
        source: String,
        #[arg(long, value_parser = ["draining", "ended", "lost"])]
        state: String,
    },
}

#[derive(Subcommand)]
enum SnapshotCommand {
    Latest {
        #[arg(long)]
        run: String,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        after_source_id: Option<String>,
    },
    History {
        #[arg(long)]
        run: String,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        before_id: Option<i64>,
        #[arg(long = "from")]
        from_ns: Option<i64>,
        #[arg(long = "to")]
        to_ns: Option<i64>,
    },
    Diff {
        #[arg(long)]
        before_id: i64,
        #[arg(long)]
        after_id: i64,
    },
    Get {
        id: i64,
    },
}

#[derive(Args)]
struct CatalogArgs {
    #[arg(long = "run", required = true)]
    runs: Vec<String>,
}

#[derive(Args)]
struct QueryArgs {
    #[arg(long = "run", required = true)]
    runs: Vec<String>,
    #[arg(long = "field", required = true)]
    fields: Vec<String>,
    #[arg(long = "source")]
    sources: Vec<String>,
    #[arg(long, default_value = "wall_time")]
    axis: String,
    #[arg(long, default_value_t = 1_600)]
    max_points: usize,
    #[arg(long = "from")]
    from_ns: Option<i64>,
    #[arg(long = "to")]
    to_ns: Option<i64>,
}

#[derive(Args)]
struct TuiArgs {
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    run: Option<String>,
    #[arg(long)]
    once: bool,
}

#[derive(Args)]
struct TraceArgs {
    #[arg(long)]
    run: String,
    #[arg(long = "source")]
    sources: Vec<String>,
    #[arg(long = "from")]
    from_ns: Option<i64>,
    #[arg(long = "to")]
    to_ns: Option<i64>,
    #[arg(short, long, default_value = "trace.json")]
    output: PathBuf,
}

pub fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(Cli::parse()))
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        CommandKind::Daemon(args) | CommandKind::Serve(args) => exec_daemon(args),
        CommandKind::Tui(args) => tui::run(args.config, cli.url, args.run, args.once).await,
        CommandKind::Trace(args) => {
            let client = ApiClient::new(
                cli.url.as_deref().unwrap_or(DEFAULT_URL),
                Duration::from_secs(30),
            )?;
            let value = export_trace(&client, args).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        command => {
            let client = ApiClient::new(
                cli.url.as_deref().unwrap_or(DEFAULT_URL),
                Duration::from_secs(30),
            )?;
            let value = execute_api(&client, command).await?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
    }
}

async fn execute_api(client: &ApiClient, command: CommandKind) -> Result<Value> {
    match command {
        CommandKind::Status => client.get("/api/experiments/stats").await,
        CommandKind::Projects(command) => match command {
            ProjectCommand::List => client.get("/api/experiments/projects").await,
            ProjectCommand::Create { name } => {
                client
                    .post("/api/experiments/projects", json!({"name": name}))
                    .await
            }
        },
        CommandKind::Experiments(command) => match command {
            ExperimentCommand::List { project } => {
                client
                    .get(&query_path(
                        "/api/experiments/experiments",
                        project.map(|value| ("project_id", value)),
                    ))
                    .await
            }
            ExperimentCommand::Create { project, name } => {
                client
                    .post(
                        "/api/experiments/experiments",
                        json!({"project_id": project, "name": name}),
                    )
                    .await
            }
        },
        CommandKind::Runs(command) => match command {
            RunCommand::List { experiment } => {
                client
                    .get(&query_path(
                        "/api/experiments/runs",
                        experiment.map(|value| ("experiment_id", value)),
                    ))
                    .await
            }
            RunCommand::Create {
                experiment,
                config,
                name,
            } => {
                let config: Value =
                    serde_json::from_str(&config).context("invalid run config JSON")?;
                if !config.is_object() {
                    bail!("run config must be a JSON object");
                }
                client
                    .post(
                        "/api/experiments/runs",
                        json!({"experiment_id": experiment, "name": name, "config": config}),
                    )
                    .await
            }
            RunCommand::Update { run, status } => {
                client
                    .patch(
                        &format!("/api/experiments/runs/{}", component(&run)),
                        json!({"status": status}),
                    )
                    .await
            }
        },
        CommandKind::Sources(command) => match command {
            SourceCommand::List { run } => {
                client
                    .get(&query_path(
                        "/api/experiments/sources",
                        run.map(|value| ("run_id", value)),
                    ))
                    .await
            }
            SourceCommand::Register {
                run,
                attempt,
                role,
                endpoint,
                node,
                rank,
                interval_ms,
                timeout_ms,
            } => {
                client
                    .post(
                        "/api/experiments/sources",
                        json!({
                            "run_id": run,
                            "attempt_id": attempt,
                            "role": role,
                            "endpoint": endpoint,
                            "node_id": node,
                            "rank": rank,
                            "scrape_interval_ms": interval_ms,
                            "timeout_ms": timeout_ms,
                        }),
                    )
                    .await
            }
            SourceCommand::Update { source, state } => {
                client
                    .patch(
                        &format!("/api/experiments/sources/{}", component(&source)),
                        json!({"state": state}),
                    )
                    .await
            }
        },
        CommandKind::Snapshots(command) => match command {
            SnapshotCommand::Get { id } => client.get(&format!("/api/snapshots/{id}")).await,
            SnapshotCommand::Diff {
                before_id,
                after_id,
            } => {
                client
                    .post(
                        "/api/snapshots/diff",
                        json!({"before_id": before_id, "after_id": after_id}),
                    )
                    .await
            }
            SnapshotCommand::Latest {
                run,
                sources,
                limit,
                after_source_id,
            } => {
                client
                    .post(
                        "/api/snapshots/latest",
                        json!({
                            "run_id": run,
                            "source_ids": sources,
                            "limit": limit,
                            "after_source_id": after_source_id,
                        }),
                    )
                    .await
            }
            SnapshotCommand::History {
                run,
                sources,
                limit,
                before_id,
                from_ns,
                to_ns,
            } => {
                client
                    .post(
                        "/api/snapshots/history",
                        json!({
                            "run_id": run,
                            "source_ids": sources,
                            "limit": limit,
                            "before_id": before_id,
                            "from": from_ns,
                            "to": to_ns,
                        }),
                    )
                    .await
            }
        },
        CommandKind::Catalog(args) => {
            client
                .post("/api/charts/catalog", json!({"run_ids": args.runs}))
                .await
        }
        CommandKind::Query(args) => {
            client
                .post(
                    "/api/snapshots/query",
                    json!({
                        "run_ids": args.runs,
                        "paths": args.fields,
                        "source_ids": args.sources,
                        "axis": args.axis,
                        "max_points": args.max_points,
                        "from": args.from_ns,
                        "to": args.to_ns,
                    }),
                )
                .await
        }
        CommandKind::Daemon(_)
        | CommandKind::Serve(_)
        | CommandKind::Tui(_)
        | CommandKind::Trace(_) => {
            unreachable!("non-API command dispatched as API")
        }
    }
}

async fn export_trace(client: &ApiClient, args: TraceArgs) -> Result<Value> {
    let mut before_id = None;
    let mut events = Vec::new();
    let mut snapshots = 0usize;
    loop {
        let page = client
            .post(
                "/api/snapshots/history",
                json!({
                    "run_id": args.run,
                    "source_ids": args.sources,
                    "before_id": before_id,
                    "from": args.from_ns,
                    "to": args.to_ns,
                    "limit": 100,
                }),
            )
            .await?;
        let rows = page
            .get("snapshots")
            .and_then(Value::as_array)
            .context("snapshot history returned invalid snapshots")?;
        for snapshot in rows {
            snapshots += 1;
            let source = snapshot
                .get("source_id")
                .and_then(Value::as_str)
                .unwrap_or("source");
            let step = snapshot
                .pointer("/state/tracker/step")
                .and_then(Value::as_i64);
            let Some(spans) = snapshot.pointer("/state/spans").and_then(Value::as_array) else {
                continue;
            };
            for span in spans {
                let Some(name) = span.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let Some(start_ns) = span.get("start_ns").and_then(Value::as_i64) else {
                    continue;
                };
                let Some(duration_ms) = span.get("duration_ms").and_then(Value::as_f64) else {
                    continue;
                };
                let mut hasher = DefaultHasher::new();
                source.hash(&mut hasher);
                let mut trace_args = serde_json::Map::new();
                trace_args.insert("source_id".into(), Value::String(source.into()));
                if let Some(step) = step {
                    trace_args.insert("step".into(), Value::from(step));
                }
                if let Some(attributes) = span.get("attributes").and_then(Value::as_object) {
                    trace_args.extend(attributes.clone());
                }
                if let Some(error) = span.get("error").and_then(Value::as_str) {
                    trace_args.insert("error".into(), Value::String(error.into()));
                }
                events.push(json!({
                    "name": name,
                    "cat": "rvx.tracker",
                    "ph": "X",
                    "ts": start_ns as f64 / 1_000.0,
                    "dur": duration_ms * 1_000.0,
                    "pid": hasher.finish(),
                    "tid": 0,
                    "args": trace_args,
                }));
            }
        }
        let next = page.get("next_before_id").and_then(Value::as_i64);
        if next.is_none() || next == before_id {
            break;
        }
        before_id = next;
    }
    events.sort_by(|left, right| {
        left.get("ts")
            .and_then(Value::as_f64)
            .partial_cmp(&right.get("ts").and_then(Value::as_f64))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let trace = json!({"traceEvents": events, "displayTimeUnit": "ms"});
    let temporary = args
        .output
        .with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, serde_json::to_vec(&trace)?)
        .with_context(|| format!("write {}", temporary.display()))?;
    std::fs::rename(&temporary, &args.output)
        .with_context(|| format!("replace {}", args.output.display()))?;
    Ok(json!({
        "output": args.output,
        "snapshots_scanned": snapshots,
        "spans_exported": trace["traceEvents"].as_array().map_or(0, Vec::len),
    }))
}

fn exec_daemon(args: DaemonArgs) -> Result<()> {
    let current = std::env::current_exe().context("locate rvx executable")?;
    #[cfg(windows)]
    let daemon = current.with_file_name("rvxd.exe");
    #[cfg(not(windows))]
    let daemon = current.with_file_name("rvxd");
    if !daemon.is_file() {
        bail!(
            "native rvxd executable is missing beside rvx: {}",
            daemon.display()
        );
    }
    let mut command = Command::new(&daemon);
    if let Some(value) = args.config {
        command.arg("--config").arg(value);
    }
    if let Some(value) = args.data_dir {
        command.arg("--data-dir").arg(value);
    }
    if let Some(value) = args.listen {
        command.arg("--listen").arg(value);
    }
    if let Some(value) = args.ui_dir {
        command.arg("--ui-dir").arg(value);
    }
    if let Some(value) = args.scrape_concurrency {
        command.arg("--scrape-concurrency").arg(value.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(error).with_context(|| format!("launch {}", daemon.display()))
    }
    #[cfg(not(unix))]
    {
        let status = command.status()?;
        if status.success() {
            Ok(())
        } else {
            bail!("rvxd exited with {status}")
        }
    }
}

fn query_path(path: &str, parameter: Option<(&str, String)>) -> String {
    match parameter {
        Some((name, value)) => {
            let query = form_urlencoded::Serializer::new(String::new())
                .append_pair(name, &value)
                .finish();
            format!("{path}?{query}")
        }
        None => path.to_string(),
    }
}

fn component(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
