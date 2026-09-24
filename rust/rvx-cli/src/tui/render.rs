use std::collections::HashMap;

use chrono::{DateTime, Local, Utc};
use serde_json::{json, Map, Value};

use rvx_config::{DashboardConfig, DashboardPanel};

use super::client::{integer, role_selected, string, DashboardState};
#[cfg(test)]
use crate::api::DEFAULT_URL;

const SPARK_CHARS: &[u8] = b"._-:=+*#%@";

pub(crate) fn render(
    dashboard: &DashboardConfig,
    state: &DashboardState,
    base_url: &str,
    width: usize,
    error: Option<&str>,
) -> Vec<String> {
    let width = width.max(20);
    let mut lines = vec![
        fit(
            &format!(
                "RVX TUI | {} / {} | {base_url}",
                dashboard.project, dashboard.experiment
            ),
            width,
        ),
        fit(
            &state.run.as_ref().map_or_else(
                || "Run: waiting".into(),
                |run| {
                    format!(
                        "Run: {} [{}] {}",
                        string(run, "name").unwrap_or("-"),
                        string(run, "status").unwrap_or("-"),
                        string(run, "id").unwrap_or("-")
                    )
                },
            ),
            width,
        ),
    ];
    if let Some(error) = error {
        lines.push(fit(&format!("ERROR: {error}"), width));
    }
    if let Some(notice) = &state.notice {
        lines.push(fit(notice, width));
    }
    if state.run.is_some() {
        let source_by_id: HashMap<_, _> = state
            .sources
            .iter()
            .filter_map(|source| string(source, "id").map(|id| (id, source)))
            .collect();
        for (index, panel) in dashboard.panels.iter().enumerate() {
            let (title, content) = match panel {
                DashboardPanel::Metrics {
                    title, paths, axis, ..
                } => (
                    title.clone().unwrap_or_else(|| format!("Metrics ({axis})")),
                    metric_lines(
                        paths,
                        state.metrics.get(&index).unwrap_or(&json!({"series": []})),
                        &source_by_id,
                        width.saturating_sub(4),
                    ),
                ),
                DashboardPanel::SnapshotFields {
                    title,
                    paths,
                    roles,
                } => (
                    title.clone().unwrap_or_else(|| "Current snapshot".into()),
                    snapshot_lines(
                        paths,
                        roles,
                        &state.snapshots,
                        &source_by_id,
                        width.saturating_sub(4),
                    ),
                ),
                DashboardPanel::RunMetadata {
                    title,
                    config_paths,
                } => (
                    title.clone().unwrap_or_else(|| "Run metadata".into()),
                    metadata_lines(config_paths, state, width.saturating_sub(4)),
                ),
            };
            lines.extend(box_lines(&title, &content, width));
        }
    }
    let refreshed: DateTime<Local> = state.refreshed_at.into();
    lines.push(fit(
        &format!("Updated {}", refreshed.format("%H:%M:%S")),
        width,
    ));
    lines
}

fn metric_lines(
    paths: &[String],
    response: &Value,
    sources: &HashMap<&str, &Map<String, Value>>,
    width: usize,
) -> Vec<String> {
    let series = response
        .get("series")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut result = Vec::new();
    for path in paths {
        let matching: Vec<_> = series
            .iter()
            .filter(|item| item.get("path").and_then(Value::as_str) == Some(path))
            .collect();
        if matching.is_empty() {
            result.push(format!("{path}: waiting for numeric observations"));
            continue;
        }
        for item in matching {
            let source = item
                .get("source_id")
                .and_then(Value::as_str)
                .and_then(|id| sources.get(id).copied());
            let label = source_label(source);
            let values = item
                .get("values")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let current = values.last().unwrap_or(&Value::Null);
            let prefix = format!("{path} [{label}]");
            let value = number(current);
            let spark_width = width
                .saturating_sub(prefix.chars().count() + value.chars().count() + 4)
                .clamp(8, 40);
            result.push(format!(
                "{prefix} {value:>10} {}",
                sparkline(values, spark_width)
            ));
        }
    }
    if result.is_empty() {
        result.push("Waiting for metric observations.".into());
    }
    result
}

fn snapshot_lines(
    paths: &[String],
    roles: &[String],
    snapshots: &[Map<String, Value>],
    sources: &HashMap<&str, &Map<String, Value>>,
    width: usize,
) -> Vec<String> {
    let mut result = Vec::new();
    for snapshot in snapshots {
        let source = string(snapshot, "source_id").and_then(|id| sources.get(id).copied());
        if !roles.is_empty() && !source.is_some_and(|source| role_selected(source, roles)) {
            continue;
        }
        result.push(format!(
            "{} | sequence {} | {}",
            source_label(source),
            integer(snapshot, "sequence")
                .map(|value| value.to_string())
                .unwrap_or_else(|| "-".into()),
            timestamp(snapshot.get("observed_at_ns"))
        ));
        let state = snapshot.get("state").unwrap_or(&Value::Null);
        for path in paths {
            result.push(format!(
                "  {path} = {}",
                display_value(
                    state.pointer(path),
                    width.saturating_sub(path.chars().count() + 5)
                )
            ));
        }
    }
    if result.is_empty() {
        result.push("Waiting for current snapshots.".into());
    }
    result
}

fn metadata_lines(config_paths: &[String], state: &DashboardState, width: usize) -> Vec<String> {
    let run = state.run.as_ref().expect("metadata requires selected Run");
    let mut result = vec![
        format!(
            "project      {}",
            state
                .project
                .as_ref()
                .and_then(|value| string(value, "name"))
                .unwrap_or("-")
        ),
        format!(
            "experiment   {}",
            state
                .experiment
                .as_ref()
                .and_then(|value| string(value, "name"))
                .unwrap_or("-")
        ),
        format!(
            "run          {} ({})",
            string(run, "name").unwrap_or("-"),
            string(run, "id").unwrap_or("-")
        ),
        format!("status       {}", string(run, "status").unwrap_or("-")),
        format!("created      {}", timestamp(run.get("created_at_ns"))),
        format!("updated      {}", timestamp(run.get("updated_at_ns"))),
        format!("sources      {}", state.sources.len()),
    ];
    let config = string(run, "config_json")
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or(Value::Null);
    if !config_paths.is_empty() {
        for path in config_paths {
            result.push(format!(
                "config {path} = {}",
                display_value(
                    config.pointer(path),
                    width.saturating_sub(path.chars().count() + 10)
                )
            ));
        }
    } else if let Some(object) = config.as_object() {
        for (key, value) in object.iter().take(12) {
            result.push(format!(
                "config /{} = {}",
                escape_pointer(key),
                display_value(Some(value), width.saturating_sub(key.chars().count() + 12))
            ));
        }
        if object.len() > 12 {
            result.push(format!(
                "config       ... {} more top-level fields",
                object.len() - 12
            ));
        }
    }
    result
}

fn source_label(source: Option<&Map<String, Value>>) -> String {
    let Some(source) = source else {
        return "source".into();
    };
    let mut label = string(source, "role")
        .or_else(|| string(source, "id"))
        .unwrap_or("source")
        .to_string();
    if let Some(rank) = integer(source, "rank") {
        label.push_str(&format!(":r{rank}"));
    } else if let Some(node) = string(source, "node_id") {
        label.push(':');
        label.push_str(node);
    }
    label
}

fn box_lines(title: &str, content: &[String], width: usize) -> Vec<String> {
    let width = width.max(20);
    let label = format!(" {} ", fit(title, width.saturating_sub(4)));
    let mut result = vec![format!(
        "+{label}{}+",
        "-".repeat(width.saturating_sub(label.chars().count() + 2))
    )];
    for line in content {
        let line = fit(&format!(" {line}"), width - 2);
        result.push(format!("|{line:<padding$}|", padding = width - 2));
    }
    result.push(format!("+{}+", "-".repeat(width - 2)));
    result
}

pub(crate) fn fit(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.to_string();
    }
    if width <= 3 {
        return value.chars().take(width).collect();
    }
    format!("{}...", value.chars().take(width - 3).collect::<String>())
}

fn sparkline(values: &[Value], width: usize) -> String {
    let sampled = &values[values.len().saturating_sub(width)..];
    let numbers: Vec<_> = sampled
        .iter()
        .filter_map(Value::as_f64)
        .filter(|value| value.is_finite())
        .collect();
    if numbers.is_empty() {
        return " ".repeat(width.min(sampled.len().max(width)));
    }
    let low = numbers.iter().copied().fold(f64::INFINITY, f64::min);
    let high = numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let span = high - low;
    let mut result = String::new();
    for value in sampled {
        let Some(value) = value.as_f64().filter(|value| value.is_finite()) else {
            result.push(' ');
            continue;
        };
        if span == 0.0 {
            result.push('-');
        } else {
            let index = (((value - low) / span) * (SPARK_CHARS.len() - 1) as f64).round() as usize;
            result.push(SPARK_CHARS[index] as char);
        }
    }
    format!("{result:>width$}")
}

fn number(value: &Value) -> String {
    let Some(number) = value.as_f64().filter(|value| value.is_finite()) else {
        return "-".into();
    };
    if number != 0.0 && (number.abs() < 0.001 || number.abs() >= 10_000_000.0) {
        format!("{number:.3e}")
    } else {
        format!("{number:.6}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn display_value(value: Option<&Value>, width: usize) -> String {
    match value {
        Some(value) => fit(
            &serde_json::to_string(value).unwrap_or_else(|_| "<invalid>".into()),
            width.max(8),
        ),
        None => "<missing>".into(),
    }
}

fn timestamp(value: Option<&Value>) -> String {
    let Some(ns) = value.and_then(Value::as_i64) else {
        return "-".into();
    };
    let seconds = ns.div_euclid(1_000_000_000);
    let nanos = ns.rem_euclid(1_000_000_000) as u32;
    DateTime::<Utc>::from_timestamp(seconds, nanos)
        .map(DateTime::<Local>::from)
        .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "-".into())
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;

    #[test]
    fn renders_metric_snapshot_and_metadata_panels() {
        let dashboard: DashboardConfig = toml::from_str(
            r#"
project = "p"
experiment = "e"
[[panels]]
type = "metrics"
paths = ["/loss"]
axis = "step"
[[panels]]
type = "snapshot-fields"
paths = ["/phase"]
[[panels]]
type = "run-metadata"
config_paths = ["/batch"]
"#,
        )
        .unwrap();
        let state = DashboardState {
            project: Some(json!({"name":"p"}).as_object().unwrap().clone()),
            experiment: Some(json!({"name":"e"}).as_object().unwrap().clone()),
            run: Some(
                json!({"id":"run","name":"trial","status":"running","config_json":"{\"batch\":32}"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
            sources: vec![json!({"id":"source","role":"learner"})
                .as_object()
                .unwrap()
                .clone()],
            snapshots: vec![
                json!({"source_id":"source","sequence":1,"state":{"phase":"train"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ],
            metrics: HashMap::from([(
                0,
                json!({"series":[{"source_id":"source","path":"/loss","values":[1.0,0.5]}]}),
            )]),
            refreshed_at: SystemTime::now(),
            ..DashboardState::default()
        };
        let text = render(&dashboard, &state, DEFAULT_URL, 100, None).join("\n");
        assert!(text.contains("/loss [learner]"));
        assert!(text.contains("/phase = \"train\""));
        assert!(text.contains("config /batch = 32"));
    }
}
