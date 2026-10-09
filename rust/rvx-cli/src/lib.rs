mod api;
mod commands;
mod daemon;
mod trace;
mod tui;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

use api::{ApiClient, DEFAULT_URL};
use commands::execute_api;
use daemon::exec_daemon;
use trace::export_trace;

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
    #[command(subcommand)]
    Artifacts(ArtifactCommand),
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

#[derive(Subcommand)]
enum ArtifactCommand {
    Lineage {
        #[arg(long = "run", required = true)]
        runs: Vec<String>,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        digest: Option<String>,
        #[arg(long, value_parser = ["log", "use"])]
        action: Option<String>,
        #[arg(long, requires = "before_artifact_index")]
        before_snapshot_id: Option<i64>,
        #[arg(long, requires = "before_snapshot_id")]
        before_artifact_index: Option<u32>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    Resolve {
        #[arg(long = "run", required = true)]
        runs: Vec<String>,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "latest")]
        alias: String,
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
    #[arg(
        long,
        help = "Existing scratch directory for external sorting (default: output directory)"
    )]
    temp_dir: Option<PathBuf>,
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
