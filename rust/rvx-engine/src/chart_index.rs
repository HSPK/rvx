use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use rvx_core::*;
use serde_json::Value;

use crate::{EngineError, Result};

pub(crate) const MAX_SOURCE_FIELDS: usize = 4096;
const MAX_OBJECT_FIELDS: usize = 256;
const MAX_DISCOVERY_NODES: usize = 8192;
const MAX_CATALOG_REPORTERS: usize = 16_384;
const INDEX_VERSION: i64 = 1;

/// Only derived tables are rebuilt; raw snapshots, IDs, heads and cursors never change.
pub(crate) fn initialize(connection: &mut Connection) -> Result<()> {
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
         ('chart_index_meta','chart_fields','chart_values','chart_axes','chart_observations','chart_runs','chart_source_axes')",
        [], |r| r.get(0),
    )?;
    let version = if tables == 7 {
        connection
            .query_row("SELECT version FROM chart_index_meta", [], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
    } else {
        None
    };
    if version != Some(INDEX_VERSION) {
        let tx = connection.transaction()?;
        tx.execute_batch(
            "DROP TABLE IF EXISTS chart_index_meta;
             DROP TABLE IF EXISTS chart_fields;
             DROP TABLE IF EXISTS chart_values;
             DROP TABLE IF EXISTS chart_axes;
             DROP TABLE IF EXISTS chart_observations;
             DROP TABLE IF EXISTS chart_runs;
             DROP TABLE IF EXISTS chart_source_axes;
             CREATE TABLE chart_index_meta(version INTEGER NOT NULL, last_id INTEGER NOT NULL);
             CREATE TABLE chart_fields(
                run_id TEXT NOT NULL, source_id TEXT NOT NULL, path TEXT NOT NULL,
                first_snapshot_id INTEGER NOT NULL,
                PRIMARY KEY(run_id,source_id,path));
             CREATE INDEX chart_field_reporters ON chart_fields(run_id,path,source_id);
             CREATE TABLE chart_values(
                snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), path TEXT NOT NULL,
                value REAL NOT NULL, PRIMARY KEY(snapshot_id,path));
             CREATE TABLE chart_axes(
                snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), name TEXT NOT NULL,
                value INTEGER NOT NULL, PRIMARY KEY(snapshot_id,name));
             CREATE TABLE chart_observations(
                snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id),
                truncated INTEGER NOT NULL, exclusions_json TEXT NOT NULL);
             CREATE TABLE chart_runs(
                run_id TEXT PRIMARY KEY, snapshot_count INTEGER NOT NULL,
                first_observed_at_ns INTEGER NOT NULL, last_observed_at_ns INTEGER NOT NULL,
                truncated INTEGER NOT NULL);
             CREATE TABLE chart_source_axes(
                run_id TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL,
                PRIMARY KEY(run_id,source_id,name));
             INSERT INTO chart_index_meta VALUES (1,0);",
        )?;
        tx.commit()?;
    }
    loop {
        let last_id: i64 =
            connection.query_row("SELECT last_id FROM chart_index_meta", [], |r| r.get(0))?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare(
            "SELECT id,run_id,source_id,snapshot_json FROM snapshots WHERE id>? ORDER BY id LIMIT 64",
        )?;
        let mut rows = statement.query([last_id])?;
        let mut count = 0;
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let raw: String = row.get(3)?;
            if count > 0 && bytes + raw.len() > MAX_SNAPSHOT_PAGE_BYTES {
                break;
            }
            let snapshot: StateSnapshot = serde_json::from_str(&raw)?;
            insert(
                &tx,
                row.get(0)?,
                &row.get::<_, String>(1)?,
                &row.get::<_, String>(2)?,
                &snapshot,
            )?;
            count += 1;
            bytes += raw.len();
            if bytes >= MAX_SNAPSHOT_PAGE_BYTES {
                break;
            }
        }
        drop(rows);
        drop(statement);
        tx.commit()?;
        if count == 0 {
            break;
        }
    }
    Ok(())
}

/// Derive sparse values and discovery coverage inside the caller's raw-snapshot transaction.
pub(crate) fn insert(
    tx: &Transaction<'_>,
    id: i64,
    run: &str,
    source: &str,
    snapshot: &StateSnapshot,
) -> Result<()> {
    let mut known = tx
        .prepare_cached("SELECT path FROM chart_fields WHERE run_id=? AND source_id=?")?
        .query_map(params![run, source], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    let mut discovered = BTreeMap::new();
    let mut exclusions = BTreeSet::new();
    let mut truncated = false;
    let mut nodes = 0;
    discover(
        "",
        &snapshot.state,
        &mut discovered,
        &mut nodes,
        &mut truncated,
        &mut exclusions,
    );
    let mut field_insert = tx.prepare_cached(
        "INSERT INTO chart_fields(run_id,source_id,path,first_snapshot_id) VALUES (?,?,?,?)",
    )?;
    for path in discovered.keys() {
        if known.contains(path) {
            continue;
        }
        if known.len() == MAX_SOURCE_FIELDS {
            truncated = true;
            exclusions.insert(path.clone());
            continue;
        }
        field_insert.execute(params![run, source, path, id])?;
        known.insert(path.clone());
    }
    // Existing paths are always checked, including inside objects that have grown
    // beyond the discovery budget. Their latest value can never carry forward.
    let mut value_insert =
        tx.prepare_cached("INSERT INTO chart_values(snapshot_id,path,value) VALUES (?,?,?)")?;
    for path in known {
        if let Some(value) = snapshot
            .state
            .pointer(&path)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            value_insert.execute(params![id, path, value])?;
        }
    }
    let mut axis_insert =
        tx.prepare_cached("INSERT INTO chart_axes(snapshot_id,name,value) VALUES (?,?,?)")?;
    let mut known_axes = tx
        .prepare_cached("SELECT name FROM chart_source_axes WHERE run_id=? AND source_id=?")?
        .query_map(params![run, source], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    for (name, value) in &snapshot.axes {
        if name != "wall_time" && name != "elapsed" {
            axis_insert.execute(params![id, name, value])?;
            if !known_axes.contains(name) {
                if known_axes.len() < 256 {
                    tx.execute(
                        "INSERT INTO chart_source_axes VALUES (?,?,?)",
                        params![run, source, name],
                    )?;
                    known_axes.insert(name.clone());
                } else {
                    truncated = true;
                }
            }
        }
    }
    let mut encoded_exclusions = serde_json::to_string(&exclusions)?;
    if encoded_exclusions.len() > 16 * 1024 {
        encoded_exclusions = "[\"\"]".into();
        truncated = true;
    }
    tx.execute(
        "INSERT INTO chart_observations(snapshot_id,truncated,exclusions_json) VALUES (?,?,?)",
        params![id, truncated, encoded_exclusions],
    )?;
    tx.execute(
        "INSERT INTO chart_runs VALUES (?,1,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET snapshot_count=snapshot_count+1,
         first_observed_at_ns=MIN(first_observed_at_ns,excluded.first_observed_at_ns),
         last_observed_at_ns=MAX(last_observed_at_ns,excluded.last_observed_at_ns),
         truncated=MAX(truncated,excluded.truncated)",
        params![
            run,
            snapshot.observed_at_ns,
            snapshot.observed_at_ns,
            truncated
        ],
    )?;
    tx.execute("UPDATE chart_index_meta SET last_id=?", [id])?;
    Ok(())
}

/// Record numeric object fields and skipped subtrees so incomplete indexing cannot masquerade as absence.
fn discover(
    path: &str,
    value: &Value,
    fields: &mut BTreeMap<String, f64>,
    nodes: &mut usize,
    truncated: &mut bool,
    exclusions: &mut BTreeSet<String>,
) {
    *nodes += 1;
    if *nodes > MAX_DISCOVERY_NODES || path.len() > 4096 {
        *truncated = true;
        exclusions.insert(
            path.rsplit_once('/')
                .map_or("", |(parent, _)| parent)
                .into(),
        );
        return;
    }
    match value {
        Value::Object(object) if object.len() <= MAX_OBJECT_FIELDS => {
            for (key, value) in object {
                if *nodes >= MAX_DISCOVERY_NODES {
                    *truncated = true;
                    exclusions.insert(path.into());
                    break;
                }
                let key = key.replace('~', "~0").replace('/', "~1");
                discover(
                    &format!("{path}/{key}"),
                    value,
                    fields,
                    nodes,
                    truncated,
                    exclusions,
                );
            }
        }
        Value::Object(_) => {
            *truncated = true;
            exclusions.insert(path.into());
        }
        Value::Array(_) => {
            exclusions.insert(path.into());
        }
        Value::Number(number) => {
            if fields.len() >= MAX_SOURCE_FIELDS {
                *truncated = true;
                exclusions.insert(path.into());
            } else if let Some(value) = number.as_f64().filter(|v| v.is_finite()) {
                fields.insert(path.into(), value);
            }
        }
        // Arrays remain full-state evidence, not automatically expanded chart dimensions.
        _ => (),
    }
}

/// Combine historical field availability with latest Source values without decoding state histories.
pub(crate) fn catalog(
    connection: &Connection,
    request: &ChartCatalogRequest,
    sources: &[Source],
) -> Result<ChartCatalogResponse> {
    let mut response = ChartCatalogResponse {
        runs: Vec::new(),
        metrics: Vec::new(),
        defaults: Vec::new(),
        axes: vec!["wall_time".into(), "elapsed".into()],
        truncated: false,
    };
    let mut metrics = BTreeMap::<String, ChartMetric>::new();
    let source_map: BTreeMap<_, _> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut logical_axes = BTreeSet::new();
    let mut reporters = 0;
    let mut bytes = 0;
    for run in request.run_ids.iter().collect::<BTreeSet<_>>() {
        let info = connection.query_row(
            "SELECT snapshot_count,first_observed_at_ns,last_observed_at_ns FROM chart_runs WHERE run_id=?",
            [run], |r| Ok(ChartRunInfo { run_id:run.clone(), snapshot_count:r.get(0)?,
                first_observed_at_ns:r.get(1)?, last_observed_at_ns:r.get(2)? }),
        ).optional()?.unwrap_or(ChartRunInfo { run_id:run.clone(),snapshot_count:0,
            first_observed_at_ns:None,last_observed_at_ns:None });
        response.runs.push(info);
        let truncated: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM chart_runs WHERE run_id=? AND truncated=1)",
            [run],
            |r| r.get(0),
        )?;
        response.truncated |= truncated;
        let mut axes = connection.prepare(
            "SELECT DISTINCT name FROM chart_source_axes WHERE run_id=? ORDER BY name LIMIT 257",
        )?;
        for name in axes.query_map([run], |r| r.get::<_, String>(0))? {
            logical_axes.insert(name?);
        }
        if logical_axes.len() > 256 {
            response.truncated = true;
        }
        let mut statement = connection.prepare(
            "SELECT f.path,f.source_id,v.value,s.observed_at_ns
             FROM chart_fields f JOIN snapshot_heads h ON h.run_id=f.run_id AND h.source_id=f.source_id
             JOIN snapshots s ON s.id=h.snapshot_id
             LEFT JOIN chart_values v ON v.snapshot_id=s.id AND v.path=f.path
             WHERE f.run_id=? ORDER BY f.path,f.source_id LIMIT 16385",
        )?;
        let mut rows = statement.query([run])?;
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let source_id: String = row.get(1)?;
            let source = source_map.get(source_id.as_str()).ok_or_else(|| {
                EngineError::InvalidInput(format!("snapshot source metadata missing: {source_id}"))
            })?;
            let rank = source.rank.or_else(|| {
                source
                    .descriptor
                    .as_ref()
                    .and_then(|d| d.get("rank"))
                    .and_then(Value::as_i64)
            });
            let node_id = source.node_id.clone().or_else(|| {
                source
                    .descriptor
                    .as_ref()
                    .and_then(|d| d.get("node_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            let label = source
                .descriptor
                .as_ref()
                .and_then(|d| d.pointer("/labels/name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    let mut label = humanize(&source.role);
                    if let Some(rank) = rank {
                        label.push_str(&format!(" · rank {rank}"));
                    }
                    if let Some(node) = &node_id {
                        label.push_str(&format!(" · {node}"));
                    }
                    label
                });
            let reporter = ChartMetricSource {
                run_id: run.clone(),
                source_id,
                label,
                role: source.role.clone(),
                rank,
                node_id,
                primary: source
                    .descriptor
                    .as_ref()
                    .and_then(|d| d.get("labels"))
                    .and_then(|d| d.get("rvx.primary"))
                    .and_then(Value::as_str)
                    == Some("true"),
                latest_value: row.get(2)?,
                observed_at_ns: row.get(3)?,
            };
            reporters += 1;
            bytes += serde_json::to_vec(&reporter)?.len() + path.len() + 256;
            if reporters > MAX_CATALOG_REPORTERS || bytes > MAX_SNAPSHOT_PAGE_BYTES - 16384 {
                response.truncated = true;
                break;
            }
            let metric = metrics.entry(path.clone()).or_insert_with(|| {
                let (name, group, unit) = presentation(&path);
                ChartMetric {
                    path,
                    name,
                    group,
                    unit,
                    run_ids: Vec::new(),
                    sources: Vec::new(),
                }
            });
            if !metric.run_ids.contains(run) {
                metric.run_ids.push(run.clone());
            }
            metric.sources.push(reporter);
        }
    }
    for metric in metrics.values_mut() {
        for run in &metric.run_ids {
            let mut statement = connection
                .prepare_cached("SELECT source_id FROM chart_fields WHERE run_id=? AND path=?")?;
            let mut rows = statement.query(params![run, metric.path])?;
            let mut count = 0;
            let mut marked = 0;
            while let Some(row) = rows.next()? {
                count += 1;
                let id: String = row.get(0)?;
                if source_map
                    .get(id.as_str())
                    .and_then(|s| s.descriptor.as_ref())
                    .and_then(|d| d.get("labels"))
                    .and_then(|d| d.get("rvx.primary"))
                    .and_then(Value::as_str)
                    == Some("true")
                {
                    marked += 1;
                }
            }
            for source in metric.sources.iter_mut().filter(|s| &s.run_id == run) {
                source.primary = count == 1 || (source.primary && marked == 1);
            }
        }
    }
    response.metrics = metrics.into_values().collect();
    response.defaults = default_paths(&response.metrics);
    response.axes.extend(logical_axes.into_iter().take(256));
    if serde_json::to_vec(&response)?.len() > MAX_SNAPSHOT_PAGE_BYTES {
        return Err(EngineError::InvalidInput(
            "chart catalog exceeds 16 MiB; select fewer runs".into(),
        ));
    }
    Ok(response)
}

/// Exclude metadata and collector bookkeeping from defaults even when their paths contain metric terms.
fn meaningful(path: &str) -> bool {
    let normalized = path.replace("~1", "/").to_ascii_lowercase();
    !normalized.split(['/', '_', '-']).any(|part| {
        matches!(
            part,
            "id" | "ids"
                | "timestamp"
                | "timestamps"
                | "schema"
                | "pid"
                | "rank"
                | "collector"
                | "collectors"
                | "monitor"
                | "monitoring"
                | "internal"
                | "bookkeeping"
                | "observed"
                | "ingested"
        )
    })
}

/// Decode pointer escapes before interpreting slash-delimited publisher metric names.
fn metric_parts(path: &str) -> Vec<String> {
    path.replace("~1", "/")
        .replace("~0", "~")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Keep the resource or queue identity in labels while discarding internal container prefixes.
fn context_start(parts: &[String]) -> Option<usize> {
    parts.iter().position(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "cpu"
                | "gpu"
                | "cluster_gpu"
                | "memory"
                | "ram"
                | "vram"
                | "disk"
                | "network"
                | "pressure"
                | "queue"
                | "queues"
        )
    })
}

/// Associate device and queue fields with recorded aggregate counterparts without synthesizing reductions.
fn scoped_signal(path: &str) -> Option<(bool, String, String)> {
    let parts = metric_parts(path);
    let start = context_start(&parts)?;
    Some((
        parts.len() > start + 2,
        parts[start].to_ascii_lowercase(),
        parts.last()?.to_ascii_lowercase(),
    ))
}

/// Choose six diverse signals at most, hiding scoped duplicates only where every Run has an aggregate.
fn default_paths(metrics: &[ChartMetric]) -> Vec<String> {
    let mut candidates: Vec<_> = metrics
        .iter()
        .filter_map(|metric| default_priority(metric).map(|priority| (priority, metric)))
        .collect();
    let mut aggregates = BTreeMap::<_, BTreeSet<_>>::new();
    for (_, metric) in &candidates {
        if let Some((false, resource, signal)) = scoped_signal(&metric.path) {
            aggregates
                .entry((resource, signal))
                .or_default()
                .extend(metric.run_ids.iter());
        }
    }
    candidates.retain(|(_, metric)| {
        scoped_signal(&metric.path).map_or(true, |(scoped, resource, signal)| {
            !scoped
                || !aggregates
                    .get(&(resource, signal))
                    .is_some_and(|runs| metric.run_ids.iter().all(|run| runs.contains(run)))
        })
    });
    candidates
        .sort_by_key(|(priority, metric)| (metric.group.clone(), *priority, metric.path.clone()));
    let mut defaults = Vec::new();
    // Keep the first viewport diverse, then fill it with explicitly useful signals.
    for group in [
        ChartGroup::Training,
        ChartGroup::Throughput,
        ChartGroup::Pipeline,
        ChartGroup::Resources,
    ] {
        if let Some((_, metric)) = candidates.iter().find(|(_, metric)| metric.group == group) {
            defaults.push(metric.path.clone());
        }
    }
    for (_, metric) in candidates {
        if defaults.len() == 6 {
            break;
        }
        if !defaults.contains(&metric.path) {
            defaults.push(metric.path.clone());
        }
    }
    defaults
}

/// Rank explicitly useful signals and aggregate scopes; inventory and unknown resource fields stay opt-in.
fn default_priority(metric: &ChartMetric) -> Option<(u8, u8)> {
    if !meaningful(&metric.path) {
        return None;
    }
    let parts = metric_parts(&metric.path);
    let leaf = parts.last()?.to_ascii_lowercase();
    let words: Vec<_> = leaf.split(['_', '-']).collect();
    let has = |terms: &[&str]| words.iter().any(|word| terms.contains(word));
    let scope = scoped_signal(&metric.path);
    let resource = scope.as_ref().map(|(_, resource, _)| resource.as_str());
    let priority = match metric.group {
        ChartGroup::Training => {
            if has(&["loss"]) {
                0
            } else if has(&["reward"]) {
                1
            } else if has(&["accuracy", "objective"]) {
                2
            } else if has(&["kl", "entropy"]) {
                3
            } else {
                return None;
            }
        }
        ChartGroup::Throughput => {
            if leaf.ends_with("_per_second") || has(&["throughput", "fps"]) {
                0
            } else if matches!(resource, Some("network"))
                && matches!(leaf.as_str(), "rx_mbps" | "tx_mbps")
            {
                5
            } else if matches!(leaf.as_str(), "tokens" | "samples" | "steps") {
                10
            } else {
                return None;
            }
        }
        ChartGroup::Pipeline => {
            if has(&["depth", "backlog", "ready"]) {
                0
            } else if has(&["latency"]) {
                1
            } else if has(&["pending", "inflight"]) {
                2
            } else {
                return None;
            }
        }
        ChartGroup::Resources => match leaf.as_str() {
            "percent"
            | "utilization"
            | "utilization_percent"
            | "usage_percent"
            | "used_percent" => match resource {
                Some("cpu") => 0,
                Some("gpu") => 1,
                Some("memory" | "ram" | "vram") => 2,
                Some("disk") => 4,
                _ => 5,
            },
            "memory_percent" => 3,
            "load1" if resource == Some("cpu") => 6,
            "load5" | "load15" if resource == Some("cpu") => 7,
            "used_bytes" | "memory_used_bytes" => 8,
            "running_gpus" => 9,
            "power_watts" => 10,
            "temperature_c" => 11,
            "avg10" | "avg60" | "avg300" if resource == Some("pressure") => 12,
            "available_bytes" | "free_bytes" => 20,
            _ => return None,
        },
        ChartGroup::Other => return None,
    };
    Some((
        u8::from(scope.is_some_and(|(scoped, _, _)| scoped)),
        priority,
    ))
}

/// Apply explicit path conventions to names, groups, and units, never inferring semantics from values.
fn presentation(path: &str) -> (String, ChartGroup, Option<String>) {
    let decoded = path.replace("~1", "/").replace("~0", "~");
    let key = decoded.trim_start_matches('/').to_ascii_lowercase();
    let leaf = key.rsplit('/').next().unwrap_or(&key);
    let tokens: Vec<_> = key.split(['/', '_', '-']).collect();
    let has = |words: &[&str]| tokens.iter().any(|part| words.contains(part));
    let group = if has(&["loss", "reward", "kl", "accuracy", "objective", "entropy"]) {
        ChartGroup::Training
    } else if has(&["throughput", "tokens", "samples", "fps"])
        || leaf.ends_with("_per_second")
        || (has(&["network"]) && matches!(leaf, "rx_mbps" | "tx_mbps"))
    {
        ChartGroup::Throughput
    } else if has(&[
        "queue", "backlog", "latency", "inflight", "pipeline", "pending",
    ]) {
        ChartGroup::Pipeline
    } else if has(&[
        "cpu",
        "gpu",
        "memory",
        "ram",
        "vram",
        "disk",
        "network",
        "pressure",
        "utilization",
    ]) {
        ChartGroup::Resources
    } else {
        ChartGroup::Other
    };
    let unit = if leaf == "percent" || leaf.ends_with("_percent") || leaf.ends_with("_pct") {
        Some("%")
    } else if leaf == "bytes" || leaf.ends_with("_bytes") {
        Some("bytes")
    } else if leaf.ends_with("_ms") {
        Some("ms")
    } else if leaf.ends_with("_ns") {
        Some("ns")
    } else if leaf.ends_with("_seconds") {
        Some("s")
    } else if leaf == "tokens_per_second" {
        Some("tokens/s")
    } else if leaf == "samples_per_second" {
        Some("samples/s")
    } else if leaf.ends_with("_mbps") {
        Some("Mbps")
    } else if leaf.ends_with("_watts") {
        Some("W")
    } else if leaf.ends_with("_c") && has(&["temperature"]) {
        Some("°C")
    } else {
        None
    }
    .map(str::to_owned);
    let parts = metric_parts(path);
    let display = if let Some(start) = context_start(&parts) {
        parts[start..].join(" ")
    } else if matches!(
        leaf,
        "percent" | "bytes" | "utilization" | "used" | "total" | "ready" | "depth"
    ) || leaf.ends_with("_bytes")
        || leaf.ends_with("_percent")
    {
        key.rsplit('/')
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        leaf.into()
    };
    (humanize(&display), group, unit)
}

/// Render readable labels without losing device identifiers, queue names, or technical acronyms.
fn humanize(value: &str) -> String {
    value
        .split(['_', '-', ' '])
        .filter(|s| !s.is_empty())
        .map(|word| match word.to_ascii_lowercase().as_str() {
            "cpu" | "gpu" | "kl" | "ram" | "vram" | "rx" | "tx" => word.to_ascii_uppercase(),
            "cpus" => "CPUs".into(),
            "gpus" => "GPUs".into(),
            "mbps" => "Mbps".into(),
            "load1" => "Load 1".into(),
            "load5" => "Load 5".into(),
            "load15" => "Load 15".into(),
            _ => {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(paths: &[&str]) -> Vec<ChartMetric> {
        paths
            .iter()
            .map(|path| {
                let (name, group, unit) = presentation(path);
                ChartMetric {
                    path: (*path).into(),
                    name,
                    group,
                    unit,
                    run_ids: vec![],
                    sources: vec![],
                }
            })
            .collect()
    }

    #[test]
    fn aggregate_resource_utilization_precedes_other_signals_and_device_duplicates() {
        let metrics = metrics(&[
            "/metrics/cpu~1cores",
            "/metrics/cpu~1load1",
            "/metrics/cpu~1percent",
            "/metrics/gpu~10~1percent",
            "/metrics/gpu~11~1percent",
            "/metrics/gpu~10~1power_watts",
            "/metrics/gpu~1percent",
            "/metrics/gpu~1memory_percent",
            "/metrics/disk~1percent",
            "/metrics/memory~1percent",
            "/metrics/memory~1used_bytes",
        ]);
        assert_eq!(
            default_paths(&metrics),
            vec![
                "/metrics/cpu~1percent",
                "/metrics/gpu~1percent",
                "/metrics/memory~1percent",
                "/metrics/gpu~1memory_percent",
                "/metrics/disk~1percent",
                "/metrics/cpu~1load1",
            ]
        );
    }

    #[test]
    fn inventory_and_unknown_resource_fields_remain_opt_in() {
        let metrics = metrics(&[
            "/metrics/cpu~1cores",
            "/metrics/gpu~1count",
            "/metrics/network~1interface_count",
            "/metrics/memory~1total_bytes",
            "/metrics/gpu~10~1memory_total_bytes",
            "/metrics/cluster_gpu~1queue~1training~1allocated_gpus",
            "/metrics/cluster_gpu~1queue~1training~1capacity_cpus",
            "/metrics/gpu~1arbitrary",
            "/pipeline/schema_version",
            "/metrics/monitor~1pending",
            "/metrics/monitor~1cpu~1percent",
        ]);
        assert!(default_paths(&metrics).is_empty());
        assert!(metrics.iter().all(|metric| !metric.name.is_empty()));
    }

    #[test]
    fn per_device_utilization_is_available_when_no_aggregate_was_recorded() {
        let device_metrics = metrics(&["/metrics/gpu~10~1percent", "/metrics/gpu~11~1percent"]);
        assert_eq!(
            default_paths(&device_metrics),
            vec!["/metrics/gpu~10~1percent", "/metrics/gpu~11~1percent",]
        );
        assert_eq!(device_metrics[0].name, "GPU 0 Percent");
        let aggregate_metrics = metrics(&[
            "/metrics/gpu~10~1percent",
            "/metrics/gpu~11~1percent",
            "/metrics/gpu~1percent",
        ]);
        assert_eq!(
            default_paths(&aggregate_metrics),
            vec!["/metrics/gpu~1percent"]
        );
        let mut compared = aggregate_metrics;
        compared[0].run_ids = vec!["run-a".into()];
        compared[1].run_ids = vec!["run-b".into()];
        compared[2].run_ids = vec!["run-b".into()];
        assert_eq!(
            default_paths(&compared),
            vec!["/metrics/gpu~1percent", "/metrics/gpu~10~1percent",]
        );
    }
}
