//! Bounded, immutable full-state capture and the read-only snapshot Pull protocol.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};

use axum::{
    extract::{rejection::QueryRejection, Query, State},
    http::{header, HeaderValue, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use parking_lot::Mutex;
use rvx_core::{
    now_ns, validate_state_snapshot, SnapshotDescriptor, SnapshotHistoryResponse, StateSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub use rvx_core::{
    DEFAULT_SNAPSHOT_HISTORY_LIMIT as DEFAULT_PAGE_SNAPSHOTS, MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_DEPTH as MAX_DEPTH, MAX_SNAPSHOT_HISTORY_LIMIT as MAX_PAGE_SNAPSHOTS,
    MAX_SNAPSHOT_PAGE_BYTES as MAX_PAGE_BYTES,
};
pub const MAX_BATCH_SNAPSHOTS: usize = 256;
pub const MAX_BUFFER_SNAPSHOTS: usize = 1_000_000;
pub const MAX_BUFFER_BYTES: usize = 1024 * 1024 * 1024;

/// History count and conservative retained-memory budget, not process RSS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BufferLimits {
    pub max_snapshots: usize,
    pub max_bytes: usize,
}

impl Default for BufferLimits {
    fn default() -> Self {
        Self {
            max_snapshots: 1_024,
            max_bytes: 64 * 1024 * 1024,
        }
    }
}

/// One complete observation; identity, schema, and sequence are producer-owned.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SnapshotEvent {
    pub state: Value,
    #[serde(default)]
    pub observed_at_ns: Option<i64>,
    #[serde(default)]
    pub axes: BTreeMap<String, i64>,
}

/// Accepted interval and cumulative evictions after an atomic capture.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CaptureReceipt {
    pub first_sequence: u64,
    pub next_sequence: u64,
    pub accepted: usize,
    pub dropped_snapshots: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ProducerStats {
    pub buffered_snapshots: usize,
    pub buffered_bytes: usize,
    pub dropped_snapshots: u64,
    pub oldest_sequence: u64,
    pub next_sequence: u64,
    pub sealed: bool,
}

#[derive(Debug, Error)]
pub enum ProducerError {
    #[error("invalid snapshot producer input: {0}")]
    InvalidInput(String),
    #[error("snapshot producer is sealed; capture is no longer allowed")]
    Sealed,
    #[error("snapshot producer sequence space is exhausted")]
    SequenceExhausted,
    #[error("snapshot is unavailable until the first capture")]
    SnapshotUnavailable,
}

pub type Result<T> = std::result::Result<T, ProducerError>;

struct BufferedSnapshot {
    snapshot: Arc<StateSnapshot>,
    bytes: usize,
}

#[derive(Default)]
struct ProducerState {
    snapshots: VecDeque<BufferedSnapshot>,
    buffered_bytes: usize,
    dropped_snapshots: u64,
    next_sequence: u64,
    sealed: bool,
}

/// Thread-safe full-state history, independent of HTTP runtime ownership.
pub struct SnapshotProducer {
    descriptor: SnapshotDescriptor,
    limits: BufferLimits,
    state: Mutex<ProducerState>,
}

impl SnapshotProducer {
    /// Validate immutable identity and allocate a fresh bounded history.
    pub fn new(descriptor: SnapshotDescriptor, limits: BufferLimits) -> Result<Arc<Self>> {
        if !(1..=MAX_BUFFER_SNAPSHOTS).contains(&limits.max_snapshots)
            || !(1..=MAX_BUFFER_BYTES).contains(&limits.max_bytes)
        {
            return invalid(
                "buffer count/byte limits must be positive and within supported bounds",
            );
        }
        validate_descriptor(&descriptor)?;
        Ok(Arc::new(Self {
            descriptor: descriptor.clone(),
            limits,
            state: Mutex::default(),
        }))
    }

    /// Capture one complete replacement without retaining references to caller state.
    pub fn capture(&self, event: SnapshotEvent) -> Result<CaptureReceipt> {
        self.capture_batch(vec![event])
    }

    /// Validate the entire batch before assigning sequences or evicting any history.
    ///
    /// Every snapshot must fit individually; an accepted batch may evict its own
    /// earliest entries. Evictions are reported, never consumer acknowledgments.
    pub fn capture_batch(&self, events: Vec<SnapshotEvent>) -> Result<CaptureReceipt> {
        if self.state.lock().sealed {
            return Err(ProducerError::Sealed);
        }
        let batch_limit = MAX_BATCH_SNAPSHOTS.min(self.limits.max_snapshots);
        if events.is_empty() || events.len() > batch_limit {
            return invalid(format!("batch size must be between 1 and {batch_limit}"));
        }
        let mut prepared = Vec::with_capacity(events.len());
        let mut batch_bytes = 2;
        for event in events {
            if !event.state.is_object() {
                return invalid("state must be a JSON object");
            }
            let state_bytes = accounted_value(&event.state, 0)?;
            if event.axes.len() > 64 {
                return invalid("axes exceed 64 entries");
            }
            for name in event.axes.keys() {
                validate_text("axis name", name, 256, false)?;
            }
            let axes_bytes: usize = event.axes.keys().map(|name| 128 + name.len()).sum();
            // Cloning normalizes caller-reserved String/Vec capacities before retention.
            let snapshot = StateSnapshot {
                source_session_id: self.descriptor.source_session_id.clone(),
                sequence: 0,
                observed_at_ns: event.observed_at_ns.unwrap_or_else(now_ns),
                schema_version: self.descriptor.schema_version,
                axes: event.axes.clone(),
                state: event.state.clone(),
            };
            validate_state_snapshot(&snapshot).map_err(input_error)?;
            let encoded = serde_json::to_vec(&snapshot).map_err(input_error)?.len();
            if encoded > MAX_SNAPSHOT_BYTES {
                return invalid("snapshot exceeds 4 MiB");
            }
            batch_bytes += encoded + 1;
            if batch_bytes > MAX_PAGE_BYTES {
                return invalid("snapshot batch exceeds 16 MiB");
            }
            let bytes = 512 + snapshot.source_session_id.len() + axes_bytes + state_bytes;
            if bytes > self.limits.max_bytes {
                return invalid("a snapshot exceeds the accounted buffer byte budget");
            }
            prepared.push((snapshot, bytes, encoded));
        }
        let mut state = self.state.lock();
        if state.sealed {
            return Err(ProducerError::Sealed);
        }
        let accepted = prepared.len();
        let first_sequence = state.next_sequence;
        let next_sequence = first_sequence
            .checked_add(accepted as u64)
            .filter(|next| *next <= i64::MAX as u64)
            .ok_or(ProducerError::SequenceExhausted)?;
        for (index, (_, _, encoded)) in prepared.iter().enumerate() {
            let sequence = first_sequence + index as u64;
            let digits = sequence.checked_ilog10().unwrap_or(0) as usize + 1;
            if encoded + digits - 1 > MAX_SNAPSHOT_BYTES {
                return invalid("snapshot exceeds 4 MiB including its assigned sequence");
            }
        }
        for (index, (mut snapshot, bytes, _)) in prepared.into_iter().enumerate() {
            snapshot.sequence = first_sequence + index as u64;
            while state.snapshots.len() >= self.limits.max_snapshots
                || state.buffered_bytes + bytes > self.limits.max_bytes
            {
                if let Some(removed) = state.snapshots.pop_front() {
                    state.buffered_bytes -= removed.bytes;
                    state.dropped_snapshots += 1;
                }
            }
            state.buffered_bytes += bytes;
            state.snapshots.push_back(BufferedSnapshot {
                snapshot: Arc::new(snapshot),
                bytes,
            });
        }
        state.next_sequence = next_sequence;
        Ok(CaptureReceipt {
            first_sequence,
            next_sequence,
            accepted,
            dropped_snapshots: state.dropped_snapshots,
        })
    }

    /// Return immutable session metadata without inspecting or inferring state fields.
    pub fn descriptor(&self) -> SnapshotDescriptor {
        self.descriptor.clone()
    }

    /// Serialize immutable session metadata directly into protocol JSON bytes.
    pub fn descriptor_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(&self.descriptor).map_err(input_error)
    }

    /// Clone only shared ownership under the lock; readers cannot mutate history.
    pub fn latest(&self) -> Result<Arc<StateSnapshot>> {
        self.state
            .lock()
            .snapshots
            .back()
            .map(|entry| Arc::clone(&entry.snapshot))
            .ok_or(ProducerError::SnapshotUnavailable)
    }

    /// Serialize the shared latest snapshot after releasing the buffer mutex.
    pub fn latest_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self.latest()?.as_ref()).map_err(input_error)
    }

    /// Return the exact protocol DTO; deep copies happen after releasing the lock.
    pub fn history(&self, after: u64, limit: usize) -> Result<SnapshotHistoryResponse> {
        let selected = self.select_history(after, limit)?;
        Ok(SnapshotHistoryResponse {
            protocol_version: 1,
            source_session_id: self.descriptor.source_session_id.clone(),
            oldest_sequence: selected.oldest_sequence,
            next_sequence: selected.next_sequence,
            dropped_before: selected.dropped_before,
            snapshots: selected
                .snapshots
                .iter()
                .map(|snapshot| (**snapshot).clone())
                .collect(),
        })
    }

    /// Serialize a bounded protocol page without cloning retained JSON trees.
    pub fn history_bytes(&self, after: u64, limit: usize) -> Result<Vec<u8>> {
        let selected = self.select_history(after, limit)?;
        serde_json::to_vec(&HistoryWire {
            protocol_version: 1,
            source_session_id: &self.descriptor.source_session_id,
            oldest_sequence: selected.oldest_sequence,
            next_sequence: selected.next_sequence,
            dropped_before: selected.dropped_before,
            snapshots: selected.snapshots.iter().map(Arc::as_ref).collect(),
        })
        .map_err(input_error)
    }

    /// Select shared snapshots atomically, then enforce the wire byte budget unlocked.
    fn select_history(&self, after: u64, limit: usize) -> Result<HistorySelection> {
        if !(1..=MAX_PAGE_SNAPSHOTS).contains(&limit) {
            return invalid("limit must be between 1 and 256");
        }
        let mut selected = {
            let state = self.state.lock();
            if after > state.next_sequence {
                return invalid("after must not exceed next_sequence");
            }
            let oldest_sequence = oldest_sequence(&state);
            HistorySelection {
                oldest_sequence,
                next_sequence: after.max(oldest_sequence),
                dropped_before: (after < oldest_sequence).then_some(oldest_sequence),
                snapshots: state
                    .snapshots
                    .iter()
                    .skip(after.saturating_sub(oldest_sequence) as usize)
                    .take(limit)
                    .map(|entry| Arc::clone(&entry.snapshot))
                    .collect(),
            }
        };
        // Reserve an exact upper bound for the small envelope; snapshot serialization
        // and any eventual HTTP copies run outside the capture mutex.
        let mut bytes = 1_024 + self.descriptor.source_session_id.len() * 6;
        let mut count = 0;
        for snapshot in &selected.snapshots {
            let length = serde_json::to_vec(snapshot.as_ref())
                .map_err(input_error)?
                .len()
                + 1;
            if bytes + length > MAX_PAGE_BYTES {
                break;
            }
            bytes += length;
            count += 1;
        }
        selected.snapshots.truncate(count);
        if let Some(last) = selected.snapshots.last() {
            selected.next_sequence = last.sequence + 1;
        }
        Ok(selected)
    }

    /// Read local retention counters atomically, independently of HTTP delivery.
    pub fn stats(&self) -> ProducerStats {
        let state = self.state.lock();
        ProducerStats {
            buffered_snapshots: state.snapshots.len(),
            buffered_bytes: state.buffered_bytes,
            dropped_snapshots: state.dropped_snapshots,
            oldest_sequence: oldest_sequence(&state),
            next_sequence: state.next_sequence,
            sealed: state.sealed,
        }
    }

    /// Freeze captures while leaving descriptor, latest, and history readable.
    pub fn seal(&self) -> u64 {
        let mut state = self.state.lock();
        state.sealed = true;
        state.next_sequence
    }

    /// Seal and release retained history, preserving identity, sequence, and eviction counters.
    pub fn seal_and_release_history(&self) -> u64 {
        let (snapshots, next_sequence) = {
            let mut state = self.state.lock();
            state.sealed = true;
            state.buffered_bytes = 0;
            (std::mem::take(&mut state.snapshots), state.next_sequence)
        };
        // Release allocations outside the mutex; existing Arc readers remain valid.
        drop(snapshots);
        next_sequence
    }

    /// Build only read routes; binding and shutdown belong to the caller.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route(
                "/v1/snapshots/descriptor",
                get(get_descriptor).fallback(method_not_allowed),
            )
            .route(
                "/v1/snapshots/latest",
                get(get_latest).fallback(method_not_allowed),
            )
            .route(
                "/v1/snapshots/history",
                get(get_history).fallback(method_not_allowed),
            )
            .route("/healthz", get(get_health).fallback(method_not_allowed))
            .fallback(not_found)
            .layer(middleware::map_response(no_cache))
            .with_state(self)
    }
}

fn oldest_sequence(state: &ProducerState) -> u64 {
    state
        .snapshots
        .front()
        .map_or(state.next_sequence, |entry| entry.snapshot.sequence)
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(ProducerError::InvalidInput(message.into()))
}

fn input_error(error: impl std::fmt::Display) -> ProducerError {
    ProducerError::InvalidInput(error.to_string())
}

fn validate_text(field: &str, text: &str, maximum: usize, allow_empty: bool) -> Result<()> {
    if text.len() > maximum || (!allow_empty && text.trim().is_empty()) {
        return invalid(format!(
            "{field} must {}contain at most {maximum} UTF-8 bytes",
            if allow_empty { "" } else { "be nonblank and " }
        ));
    }
    Ok(())
}

fn validate_descriptor(descriptor: &SnapshotDescriptor) -> Result<()> {
    if descriptor.protocol_version != 1 || descriptor.schema_version != 1 {
        return invalid("protocol_version and schema_version must be 1");
    }
    for (name, text) in [
        ("source_session_id", descriptor.source_session_id.as_str()),
        ("project", descriptor.project.as_str()),
        ("experiment", descriptor.experiment.as_str()),
        ("run_id", descriptor.run_id.as_str()),
        ("attempt_id", descriptor.attempt_id.as_str()),
        ("role", descriptor.role.as_str()),
    ] {
        validate_text(name, text, 256, false)?;
    }
    if let Some(node) = &descriptor.node_id {
        validate_text("node_id", node, 256, false)?;
    }
    if descriptor.labels.len() > 64 {
        return invalid("labels exceed 64 entries");
    }
    for (name, value) in &descriptor.labels {
        validate_text("label name", name, 256, false)?;
        validate_text("label value", value, 1_024, true)?;
    }
    Ok(())
}

/// Account retained JSON allocations; shared validation also bounds nodes and numbers.
fn accounted_value(value: &Value, depth: usize) -> Result<usize> {
    if depth > MAX_DEPTH {
        return invalid("JSON nesting exceeds 64 levels");
    }
    match value {
        Value::Array(values) => values.iter().try_fold(64, |bytes, child| {
            Ok(bytes + accounted_value(child, depth + 1)?)
        }),
        Value::Object(values) => values.iter().try_fold(64, |bytes, (key, child)| {
            Ok(bytes + 128 + key.len() + accounted_value(child, depth + 1)?)
        }),
        Value::String(text) => Ok(64 + text.len()),
        Value::Number(number) => Ok(64 + number.to_string().len()),
        _ => Ok(64),
    }
}

struct HistorySelection {
    oldest_sequence: u64,
    next_sequence: u64,
    dropped_before: Option<u64>,
    snapshots: Vec<Arc<StateSnapshot>>,
}

#[derive(Serialize)]
struct HistoryWire<'a> {
    protocol_version: u32,
    source_session_id: &'a str,
    oldest_sequence: u64,
    next_sequence: u64,
    dropped_before: Option<u64>,
    snapshots: Vec<&'a StateSnapshot>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

fn default_page_limit() -> usize {
    DEFAULT_PAGE_SNAPSHOTS
}

async fn get_descriptor(State(producer): State<Arc<SnapshotProducer>>) -> Response {
    raw_response(producer.descriptor_bytes())
}

async fn get_latest(State(producer): State<Arc<SnapshotProducer>>) -> Response {
    raw_response(producer.latest_bytes())
}

async fn get_history(
    State(producer): State<Arc<SnapshotProducer>>,
    query: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Response {
    match query {
        Ok(Query(query)) => raw_response(producer.history_bytes(query.after, query.limit)),
        Err(_) => json_error(
            StatusCode::BAD_REQUEST,
            "invalid history query; expected nonnegative after and limit between 1 and 256",
        ),
    }
}

async fn get_health(State(producer): State<Arc<SnapshotProducer>>) -> Json<Value> {
    Json(serde_json::json!({"status": "ok", "sealed": producer.stats().sealed}))
}

/// Serve the same Rust-serialized protocol bytes used by borrowed web adapters.
fn raw_response(bytes: Result<Vec<u8>>) -> Response {
    match bytes {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Err(error) => producer_error(error),
    }
}

fn producer_error(error: ProducerError) -> Response {
    let status = match error {
        ProducerError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        ProducerError::SnapshotUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        ProducerError::Sealed => StatusCode::CONFLICT,
        ProducerError::SequenceExhausted => StatusCode::INSUFFICIENT_STORAGE,
    };
    json_error(status, &error.to_string())
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"error": message}))).into_response()
}

async fn method_not_allowed() -> Response {
    let mut response = json_error(
        StatusCode::METHOD_NOT_ALLOWED,
        "only GET and HEAD are supported",
    );
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
    response
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "route not found")
}

async fn no_cache(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

#[cfg(test)]
mod tests;
