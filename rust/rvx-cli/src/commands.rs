use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use url::form_urlencoded;

use super::{
    ArtifactCommand, CommandKind, ExperimentCommand, ProjectCommand, RunCommand, SnapshotCommand,
    SourceCommand,
};
use crate::api::ApiClient;

pub(super) async fn execute_api(client: &ApiClient, command: CommandKind) -> Result<Value> {
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
        CommandKind::Artifacts(command) => match command {
            ArtifactCommand::Lineage {
                runs,
                sources,
                name,
                digest,
                action,
                before_snapshot_id,
                before_artifact_index,
                limit,
            } => {
                let before = match (before_snapshot_id, before_artifact_index) {
                    (Some(snapshot_id), Some(artifact_index)) => {
                        Some(json!({"snapshot_id": snapshot_id, "artifact_index": artifact_index}))
                    }
                    (None, None) => None,
                    _ => bail!("artifact cursor requires both snapshot and artifact indexes"),
                };
                client
                    .post(
                        "/api/artifacts/lineage",
                        json!({
                            "run_ids": runs,
                            "source_ids": sources,
                            "name": name,
                            "digest": digest,
                            "action": action,
                            "before": before,
                            "limit": limit,
                        }),
                    )
                    .await
            }
            ArtifactCommand::Resolve {
                runs,
                sources,
                name,
                alias,
            } => {
                client
                    .post(
                        "/api/artifacts/resolve",
                        json!({
                            "run_ids": runs,
                            "source_ids": sources,
                            "name": name,
                            "alias": alias,
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
