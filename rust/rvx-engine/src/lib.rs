mod cold_store;
mod hot_store;
mod repository;
mod snapshot_store;
mod wal;

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rvx_core::{
    new_id, now_ns, validate_snapshot_descriptor, EngineStats, Experiment, Project, QueryRequest,
    QueryResponse, Run, RunStatus, RunSummary, SnapshotDescriptor, SnapshotDiffRequest,
    SnapshotDiffResponse, SnapshotHistoryPage, SnapshotHistoryRequest, SnapshotHistoryResponse,
    SnapshotLatestRequest, SnapshotLatestResponse, SnapshotQueryRequest, SnapshotQueryResponse,
    Source, SourceRegistration, SourceState, SummaryRequest, SummaryResponse,
};
#[cfg(test)]
use rvx_core::{validate_points_response, MetricBatch, PointsResponse};
use thiserror::Error;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{interval, sleep_until, Instant, MissedTickBehavior};

use cold_store::ColdStore;
use hot_store::merge_responses;
use hot_store::HotStore;
use repository::Repository;
use snapshot_store::SnapshotStore;
use wal::MetricWal;

const MAX_SUMMARY_RUNS: usize = 1_000;
const MAX_SUMMARY_METRICS: usize = 128;
const SUMMARY_QUERY_THREADS: usize = 8;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("protocol error: {0}")]
    Protocol(#[from] rvx_core::ProtocolError),
    #[error("storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("Parquet error: {0}")]
    Parquet(#[from] parquet::errors::ParquetError),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("corrupt metric WAL: {0}")]
    CorruptWal(String),
    #[error("runtime error: {0}")]
    Runtime(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Default)]
struct Counters {
    ingested_points: AtomicU64,
    duplicate_points: AtomicU64,
    cursor_gaps: AtomicU64,
    scrape_failures: AtomicU64,
    compacted_values: AtomicU64,
}

pub struct Engine {
    repository: Repository,
    snapshots: SnapshotStore,
    scrape_owners: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    wal: MetricWal,
    cold: ColdStore,
    hot: HotStore,
    client: reqwest::Client,
    counters: Counters,
}

impl Engine {
    pub fn open(directory: impl AsRef<Path>, hot_capacity: usize) -> Result<Arc<Self>> {
        let directory = directory.as_ref();
        std::fs::create_dir_all(directory)?;
        let repository = Repository::open(&directory.join("metadata.db"))?;
        let snapshots = SnapshotStore::open(&directory.join("snapshots.db"))?;
        #[cfg(test)]
        let (wal, recovered) = MetricWal::open(&directory.join("metrics.wal"))?;
        #[cfg(not(test))]
        let (wal, recovered) = MetricWal::open_read_only(&directory.join("metrics.wal"))?;
        // Legacy WAL no longer compacts in production: retain every archived observation for reads.
        let hot_capacity = hot_capacity.max(recovered.iter().map(|b| b.points.len()).sum());
        let cold = ColdStore::open(directory.join("parquet"))?;
        let engine = Arc::new(Self {
            repository,
            snapshots,
            scrape_owners: parking_lot::Mutex::new(HashMap::new()),
            wal,
            cold,
            hot: HotStore::new(hot_capacity),
            client: reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(60))
                .tcp_nodelay(true)
                .build()?,
            counters: Counters::default(),
        });
        for batch in recovered {
            engine.hot.append(&batch);
            engine
                .counters
                .ingested_points
                .fetch_add(batch.points.len() as u64, Ordering::Relaxed);
        }
        Ok(engine)
    }

    pub fn create_project(&self, name: &str) -> Result<Project> {
        self.repository.create_project(name)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.repository.list_projects()
    }

    pub fn create_experiment(&self, project_id: &str, name: &str) -> Result<Experiment> {
        self.repository.create_experiment(project_id, name)
    }

    pub fn list_experiments(&self, project_id: Option<&str>) -> Result<Vec<Experiment>> {
        self.repository.list_experiments(project_id)
    }

    pub fn create_run(&self, experiment_id: &str, name: &str, config_json: &str) -> Result<Run> {
        self.repository.create_run(experiment_id, name, config_json)
    }

    pub fn list_runs(&self, experiment_id: Option<&str>) -> Result<Vec<Run>> {
        self.repository.list_runs(experiment_id)
    }

    pub fn update_run_status(&self, run_id: &str, status: &RunStatus) -> Result<Run> {
        rvx_core::validate_name("run_id", run_id)?;
        self.repository.update_run_status(run_id, status)
    }

    /// Register an HTTP(S) role API without altering previously stored archive sources.
    pub fn register_source(&self, registration: &SourceRegistration) -> Result<Source> {
        for (field, value) in [
            ("run_id", registration.run_id.as_str()),
            ("attempt_id", registration.attempt_id.as_str()),
            ("role", registration.role.as_str()),
            ("endpoint", registration.endpoint.as_str()),
        ] {
            rvx_core::validate_name(field, value)?;
        }
        let endpoint = reqwest::Url::parse(&registration.endpoint).map_err(|_| {
            EngineError::InvalidInput("source endpoint must be an absolute HTTP(S) URL".into())
        })?;
        if !matches!(endpoint.scheme(), "http" | "https") || !endpoint.has_host() {
            return Err(EngineError::InvalidInput(
                "source endpoint must be an absolute HTTP(S) URL".into(),
            ));
        }
        if endpoint.query().is_some() || endpoint.fragment().is_some() {
            return Err(EngineError::InvalidInput(
                "source endpoint must be a base URL without query or fragment".into(),
            ));
        }
        if registration.scrape_interval_ms < 50 {
            return Err(EngineError::InvalidInput(
                "scrape_interval_ms must be at least 50".into(),
            ));
        }
        if registration.timeout_ms == 0
            || registration.timeout_ms >= registration.scrape_interval_ms.saturating_mul(10)
        {
            return Err(EngineError::InvalidInput(
                "timeout_ms must be positive and bounded".into(),
            ));
        }
        let source = Source {
            id: new_id("source"),
            run_id: registration.run_id.clone(),
            attempt_id: registration.attempt_id.clone(),
            role: registration.role.clone(),
            endpoint: endpoint.as_str().trim_end_matches('/').to_string(),
            node_id: registration.node_id.clone(),
            rank: registration.rank,
            state: SourceState::Discovered,
            source_session_id: None,
            last_success_at_ns: None,
            last_error: None,
            scrape_interval_ms: registration.scrape_interval_ms,
            timeout_ms: registration.timeout_ms,
            descriptor: None,
        };
        self.repository.register_source(&source)
    }

    pub fn list_sources(&self, run_id: Option<&str>) -> Result<Vec<Source>> {
        self.repository.list_sources(run_id)
    }

    pub fn update_source_state(&self, source_id: &str, state: &SourceState) -> Result<Source> {
        rvx_core::validate_name("source_id", source_id)?;
        if !matches!(
            state,
            SourceState::Draining | SourceState::Ended | SourceState::Lost
        ) {
            return Err(EngineError::InvalidInput(
                "source control state must be draining, ended, or lost".into(),
            ));
        }
        self.repository.update_source_state(source_id, state)
    }

    #[cfg(test)]
    fn ingest(&self, mut batch: MetricBatch) -> Result<usize> {
        let response = PointsResponse {
            protocol_version: rvx_core::PROTOCOL_VERSION,
            source_session_id: batch.source_session_id.clone(),
            oldest_sequence: batch.oldest_sequence,
            next_sequence: batch.next_sequence,
            dropped_before: batch.dropped_before,
            points: batch.points.clone(),
        };
        validate_points_response(&response)?;
        let committed = self
            .repository
            .cursor(&batch.source_id, &batch.source_session_id)?
            .unwrap_or(batch.oldest_sequence);
        let gap = (batch.oldest_sequence > committed).then_some((committed, batch.oldest_sequence));
        if gap.is_some() {
            self.counters.cursor_gaps.fetch_add(1, Ordering::Relaxed);
        }
        let before = batch.points.len();
        batch.points.retain(|point| point.sequence >= committed);
        self.counters
            .duplicate_points
            .fetch_add((before - batch.points.len()) as u64, Ordering::Relaxed);
        for point in &mut batch.points {
            if point.ingest_time_ns == 0 {
                point.ingest_time_ns = now_ns();
            }
        }
        let accepted = batch.points.len();
        if accepted > 0 || batch.next_sequence > committed {
            self.wal.append(&batch)?;
            self.repository.commit_cursor(
                &batch.source_id,
                &batch.source_session_id,
                batch.next_sequence.max(committed),
                gap,
            )?;
            self.hot.append(&batch);
            self.counters
                .ingested_points
                .fetch_add(accepted as u64, Ordering::Relaxed);
        }
        Ok(accepted)
    }

    /// Read legacy numeric archives; new observations are ingested exclusively as snapshots.
    pub fn query(&self, request: &QueryRequest) -> Result<QueryResponse> {
        rvx_core::validate_name("run_id", &request.run_id)?;
        rvx_core::validate_name("axis", &request.axis)?;
        Ok(merge_responses(
            request,
            [self.cold.query(request)?, self.hot.query(request)],
        ))
    }

    pub fn query_summaries(&self, request: &SummaryRequest) -> Result<SummaryResponse> {
        if request.run_ids.len() > MAX_SUMMARY_RUNS {
            return Err(EngineError::InvalidInput(format!(
                "summary query exceeds {MAX_SUMMARY_RUNS} runs"
            )));
        }
        if request.metrics.is_empty() || request.metrics.len() > MAX_SUMMARY_METRICS {
            return Err(EngineError::InvalidInput(format!(
                "summary query requires 1 to {MAX_SUMMARY_METRICS} metrics"
            )));
        }
        for metric in &request.metrics {
            rvx_core::validate_name("metric", metric)?;
        }
        let next = AtomicUsize::new(0);
        let worker_count = request.run_ids.len().min(SUMMARY_QUERY_THREADS);
        let summaries = std::thread::scope(|scope| {
            let mut workers = Vec::with_capacity(worker_count);
            for _ in 0..worker_count {
                workers.push(scope.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(run_id) = request.run_ids.get(index) else {
                            break;
                        };
                        local.push((index, self.query_summary(run_id, request)));
                    }
                    local
                }));
            }
            let mut ordered = vec![None; request.run_ids.len()];
            for worker in workers {
                let values = worker
                    .join()
                    .map_err(|_| EngineError::Runtime("summary query worker panicked".into()))?;
                for (index, summary) in values {
                    ordered[index] = Some(summary?);
                }
            }
            ordered
                .into_iter()
                .map(|summary| {
                    summary.ok_or_else(|| {
                        EngineError::Runtime("summary query result is missing".into())
                    })
                })
                .collect::<Result<Vec<_>>>()
        })?;
        Ok(SummaryResponse { summaries })
    }

    fn query_summary(&self, run_id: &str, request: &SummaryRequest) -> Result<RunSummary> {
        let response = self.query(&QueryRequest {
            run_id: run_id.to_string(),
            source_ids: Vec::new(),
            metrics: request.metrics.clone(),
            axis: request.axis.clone(),
            from: request.from,
            to: request.to,
            max_points: 2,
        })?;
        let values = response
            .series
            .into_iter()
            .filter_map(|series| {
                series
                    .values
                    .last()
                    .copied()
                    .map(|value| (series.metric, value))
            })
            .collect();
        Ok(RunSummary {
            run_id: run_id.to_string(),
            values,
        })
    }

    #[cfg(test)]
    fn compact(&self) -> Result<usize> {
        let _ = self.wal.rotate()?;
        let mut compacted = 0;
        for segment in self.wal.sealed_paths()? {
            let batches = MetricWal::read_records(&segment)?;
            compacted += self.cold.write_segment(&segment, &batches)?;
            self.hot.remove_batches(&batches);
            std::fs::remove_file(segment)?;
        }
        self.counters
            .compacted_values
            .fetch_add(compacted as u64, Ordering::Relaxed);
        trim_native_heap();
        Ok(compacted)
    }

    pub fn stats(&self) -> Result<EngineStats> {
        let (projects, experiments, runs, sources, active_sources) = self.repository.counts()?;
        Ok(EngineStats {
            snapshots: self.snapshots.count()?,
            projects,
            experiments,
            runs,
            sources,
            active_sources,
            hot_points: self.hot.len() as u64,
            parquet_files: self.cold.file_count()?,
            wal_bytes: self.wal.size()?,
            ingested_points: self.counters.ingested_points.load(Ordering::Relaxed),
            duplicate_points: self.counters.duplicate_points.load(Ordering::Relaxed),
            compacted_values: self.counters.compacted_values.load(Ordering::Relaxed),
            cursor_gaps: self.counters.cursor_gaps.load(Ordering::Relaxed)
                + self.snapshots.gap_count()?,
            scrape_failures: self.counters.scrape_failures.load(Ordering::Relaxed),
        })
    }

    pub fn snapshot_latest(
        &self,
        request: &SnapshotLatestRequest,
    ) -> Result<SnapshotLatestResponse> {
        self.snapshots.latest(request)
    }

    pub fn snapshot_history(
        &self,
        request: &SnapshotHistoryRequest,
    ) -> Result<SnapshotHistoryPage> {
        self.snapshots.history(request)
    }

    pub fn snapshot_query(&self, request: &SnapshotQueryRequest) -> Result<SnapshotQueryResponse> {
        self.snapshots.query(request)
    }

    pub fn snapshot_diff(&self, request: &SnapshotDiffRequest) -> Result<SnapshotDiffResponse> {
        self.snapshots.diff(request)
    }

    /// Pull only the versioned snapshot protocol; legacy metric endpoints are never probed.
    pub async fn scrape_source(self: &Arc<Self>, source: &Source) -> Result<usize> {
        let engine = self.clone();
        let source_id = source.id.clone();
        let source =
            tokio::task::spawn_blocking(move || engine.repository.source_by_id(&source_id))
                .await
                .map_err(|e| EngineError::Runtime(e.to_string()))??;
        // Entries are created only for persisted registrations, never arbitrary caller IDs.
        let owner = {
            let mut owners = self.scrape_owners.lock();
            owners
                .entry(source.id.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let owner = owner.lock_owned().await;
        let engine = self.clone();
        let id = source.id.clone();
        let source = tokio::task::spawn_blocking(move || engine.repository.source_by_id(&id))
            .await
            .map_err(|e| EngineError::Runtime(e.to_string()))??;
        if matches!(
            source.state,
            SourceState::Draining | SourceState::Ended | SourceState::Lost
        ) {
            return Ok(0);
        }
        let descriptor: SnapshotDescriptor = self
            .pull_json(&source, "/v1/snapshots/descriptor", 256 * 1024)
            .await?;
        validate_snapshot_descriptor(&descriptor)?;
        if descriptor.run_id != source.run_id
            || descriptor.attempt_id != source.attempt_id
            || descriptor.role != source.role
        {
            return Err(EngineError::InvalidInput(
                "source descriptor identity does not match registration".into(),
            ));
        }
        let engine = self.clone();
        let id = source.id.clone();
        let session = descriptor.source_session_id.clone();
        let cursor = tokio::task::spawn_blocking(move || engine.snapshots.cursor(&id, &session))
            .await
            .map_err(|e| EngineError::Runtime(e.to_string()))??;
        let page: SnapshotHistoryResponse = self
            .pull_json(
                &source,
                &format!(
                    "/v1/snapshots/history?after={cursor}&limit={}",
                    rvx_core::DEFAULT_SNAPSHOT_HISTORY_LIMIT
                ),
                rvx_core::MAX_SNAPSHOT_PAGE_BYTES,
            )
            .await?;
        // The transaction validates descriptor/history session agreement before any cursor write.
        let engine = self.clone();
        tokio::task::spawn_blocking(move || {
            // Keep ownership through native commit even if the awaiting async task is cancelled.
            let _owner = owner;
            let accepted = engine.snapshots.ingest(&source, &descriptor, &page)?;
            engine
                .repository
                .update_source_success(&source.id, &descriptor, now_ns())?;
            Ok(accepted)
        })
        .await
        .map_err(|e| EngineError::Runtime(e.to_string()))?
    }

    async fn pull_json<T: serde::de::DeserializeOwned>(
        &self,
        source: &Source,
        path: &str,
        limit: usize,
    ) -> Result<T> {
        let mut response = self
            .client
            .get(format!("{}{path}", source.endpoint))
            .timeout(Duration::from_millis(source.timeout_ms))
            .send()
            .await?
            .error_for_status()?;
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(EngineError::InvalidInput(
                "snapshot response exceeds byte budget".into(),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > limit {
                return Err(EngineError::InvalidInput(
                    "snapshot response exceeds byte budget".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub async fn run_scraper(
        self: Arc<Self>,
        maximum_concurrency: usize,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let semaphore = Arc::new(Semaphore::new(maximum_concurrency.max(1)));
        let mut sources: HashMap<String, Source> = HashMap::new();
        let mut schedule: BinaryHeap<Reverse<(Instant, String)>> = BinaryHeap::new();
        let mut scheduled: HashSet<String> = HashSet::new();
        let mut tasks: JoinSet<(Source, bool)> = JoinSet::new();
        let mut discovery = interval(Duration::from_secs(1));
        discovery.set_missed_tick_behavior(MissedTickBehavior::Skip);
        self.refresh_schedule(&mut sources, &mut schedule, &mut scheduled);
        loop {
            while let Some(result) = tasks.try_join_next() {
                if let Ok((source, has_data)) = result {
                    let due = Instant::now() + Self::scrape_delay(&source, has_data);
                    scheduled.insert(source.id.clone());
                    schedule.push(Reverse((due, source.id)));
                }
            }
            let now = Instant::now();
            while schedule.peek().is_some_and(|entry| entry.0 .0 <= now) {
                let Reverse((_, source_id)) = schedule.pop().unwrap();
                scheduled.remove(&source_id);
                let Some(source) = sources.get(&source_id).cloned() else {
                    continue;
                };
                let Ok(permit) = semaphore.clone().try_acquire_owned() else {
                    scheduled.insert(source_id.clone());
                    schedule.push(Reverse((now + Duration::from_millis(1), source_id)));
                    break;
                };
                let engine = self.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let has_data = match engine.scrape_source(&source).await {
                        Ok(accepted) => accepted > 0,
                        Err(error) => {
                            engine
                                .counters
                                .scrape_failures
                                .fetch_add(1, Ordering::Relaxed);
                            if let Err(storage_error) = engine
                                .repository
                                .update_source_failure(&source.id, &error.to_string())
                            {
                                eprintln!(
                                    "Rvx could not persist scrape failure for {}: {}",
                                    source.id, storage_error
                                );
                            }
                            false
                        }
                    };
                    (source, has_data)
                });
            }
            let wake_at = schedule
                .peek()
                .map(|entry| entry.0 .0)
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(1));
            tokio::select! {
                _ = sleep_until(wake_at) => {}
                _ = discovery.tick() => {
                    self.refresh_schedule(
                        &mut sources,
                        &mut schedule,
                        &mut scheduled,
                    );
                }
                result = tasks.join_next(), if !tasks.is_empty() => {
                    if let Some(Ok((source, has_data))) = result {
                        let due = Instant::now() + Self::scrape_delay(&source, has_data);
                        scheduled.insert(source.id.clone());
                        schedule.push(Reverse((due, source.id)));
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }

    /// Drain retained pages promptly, yielding through the shared concurrency limit between pages.
    fn scrape_delay(source: &Source, has_data: bool) -> Duration {
        if has_data {
            Duration::from_millis(1)
        } else {
            Duration::from_millis(source.scrape_interval_ms)
        }
    }

    fn refresh_schedule(
        &self,
        sources: &mut HashMap<String, Source>,
        schedule: &mut BinaryHeap<Reverse<(Instant, String)>>,
        scheduled: &mut HashSet<String>,
    ) {
        let discovered = match self.list_sources(None) {
            Ok(sources) => sources,
            Err(error) => {
                eprintln!("Rvx scraper could not list sources: {error}");
                return;
            }
        };
        for source in discovered {
            if matches!(
                source.state,
                SourceState::Draining | SourceState::Ended | SourceState::Lost
            ) || !reqwest::Url::parse(&source.endpoint)
                .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
            {
                sources.remove(&source.id);
                continue;
            }
            if !sources.contains_key(&source.id) && !scheduled.contains(&source.id) {
                scheduled.insert(source.id.clone());
                schedule.push(Reverse((Instant::now(), source.id.clone())));
            }
            sources.insert(source.id.clone(), source);
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
fn trim_native_heap() {
    // Rvx is Linux-first; release free pages retained by glibc after compaction.
    unsafe {
        libc::malloc_trim(0);
    }
}

#[cfg(all(test, not(target_os = "linux")))]
fn trim_native_heap() {}

#[cfg(test)]
fn test_directory() -> std::io::Result<tempfile::TempDir> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root)?;
    tempfile::tempdir_in(root)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::test_directory as tempdir;
    use axum::extract::Query;
    use axum::routing::get;
    use axum::{Json, Router};
    use rvx_core::{
        MetricBatch, MetricPoint, QueryRequest, RunStatus, SnapshotDescriptor, SourceRegistration,
        PROTOCOL_VERSION,
    };
    use serde::Deserialize;

    use super::*;

    #[test]
    fn persists_deduplicates_and_recovers_points() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("project").unwrap();
        let experiment = engine.create_experiment(&project.id, "experiment").unwrap();
        let run = engine.create_run(&experiment.id, "run", "{}").unwrap();
        let batch = MetricBatch {
            run_id: run.id.clone(),
            source_id: "source".into(),
            source_session_id: "session".into(),
            oldest_sequence: 1,
            next_sequence: 3,
            dropped_before: None,
            points: (1..3)
                .map(|sequence| MetricPoint {
                    source_session_id: "session".into(),
                    sequence,
                    event_time_ns: sequence as i64,
                    ingest_time_ns: 0,
                    axes: BTreeMap::from([("optimizer_step".into(), sequence as i64)]),
                    values: BTreeMap::from([("train/loss".into(), sequence as f64)]),
                })
                .collect(),
        };
        assert_eq!(engine.ingest(batch.clone()).unwrap(), 2);
        assert_eq!(engine.ingest(batch).unwrap(), 0);
        let summaries = engine
            .query_summaries(&SummaryRequest {
                run_ids: vec![run.id.clone()],
                metrics: vec!["train/loss".into()],
                axis: "optimizer_step".into(),
                from: None,
                to: None,
            })
            .unwrap();
        assert_eq!(summaries.summaries[0].values["train/loss"], 2.0);
        let running = engine
            .update_run_status(&run.id, &RunStatus::Running)
            .unwrap();
        let finished = engine
            .update_run_status(&run.id, &RunStatus::Finished)
            .unwrap();
        assert_eq!(running.status, RunStatus::Running);
        assert_eq!(finished.status, RunStatus::Finished);
        assert!(engine
            .update_run_status(&run.id, &RunStatus::Running)
            .is_err());
        drop(engine);

        let recovered = Engine::open(directory.path(), 100).unwrap();
        let response = recovered
            .query(&QueryRequest {
                run_id: run.id.clone(),
                source_ids: Vec::new(),
                metrics: vec!["train/loss".into()],
                axis: "optimizer_step".into(),
                from: None,
                to: None,
                max_points: 100,
            })
            .unwrap();

        assert_eq!(response.series[0].values, vec![1.0, 2.0]);
        assert_eq!(recovered.stats().unwrap().hot_points, 2);
    }

    #[test]
    fn compacts_wal_to_parquet_and_queries_after_restart() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("project").unwrap();
        let experiment = engine.create_experiment(&project.id, "experiment").unwrap();
        let run = engine.create_run(&experiment.id, "run", "{}").unwrap();
        engine
            .ingest(MetricBatch {
                run_id: run.id.clone(),
                source_id: "source".into(),
                source_session_id: "session".into(),
                oldest_sequence: 1,
                next_sequence: 4,
                dropped_before: None,
                points: (1..4)
                    .map(|sequence| MetricPoint {
                        source_session_id: "session".into(),
                        sequence,
                        event_time_ns: sequence as i64,
                        ingest_time_ns: 0,
                        axes: BTreeMap::from([("optimizer_step".into(), sequence as i64)]),
                        values: BTreeMap::from([("train/loss".into(), sequence as f64)]),
                    })
                    .collect(),
            })
            .unwrap();

        assert_eq!(engine.compact().unwrap(), 3);
        assert_eq!(engine.stats().unwrap().parquet_files, 1);
        drop(engine);

        let recovered = Engine::open(directory.path(), 1).unwrap();
        let response = recovered
            .query(&QueryRequest {
                run_id: run.id.clone(),
                source_ids: Vec::new(),
                metrics: vec!["train/loss".into()],
                axis: "optimizer_step".into(),
                from: None,
                to: None,
                max_points: 100,
            })
            .unwrap();

        assert_eq!(response.series[0].values, vec![1.0, 2.0, 3.0]);
        assert_eq!(recovered.stats().unwrap().hot_points, 0);
    }

    #[test]
    fn retains_existing_archive_history_without_scheduling_it() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("hostmon").unwrap();
        let experiment = engine.create_experiment(&project.id, "host").unwrap();
        let run = engine.create_run(&experiment.id, "host", "{}").unwrap();
        let source = engine
            .repository
            .register_source(&Source {
                id: "legacy-source".into(),
                run_id: run.id.clone(),
                attempt_id: "legacy-import".into(),
                role: "hostmon".into(),
                endpoint: "archive://hostmon-history".into(),
                node_id: Some("node-a".into()),
                rank: None,
                state: SourceState::Ended,
                source_session_id: Some("hostmon-history-v1".into()),
                last_success_at_ns: None,
                last_error: None,
                scrape_interval_ms: 60_000,
                timeout_ms: 1_000,
                descriptor: None,
            })
            .unwrap();
        engine
            .ingest(MetricBatch {
                run_id: run.id.clone(),
                source_id: source.id.clone(),
                source_session_id: "hostmon-history-v1".into(),
                oldest_sequence: 0,
                next_sequence: 2,
                dropped_before: None,
                points: (0..2)
                    .map(|sequence| MetricPoint {
                        source_session_id: "hostmon-history-v1".into(),
                        sequence,
                        event_time_ns: (sequence as i64 + 1) * 1_000_000_000,
                        ingest_time_ns: 0,
                        axes: BTreeMap::from([("hostmon_sample".into(), sequence as i64)]),
                        values: BTreeMap::from([(
                            "cpu/percent".into(),
                            10.0 + sequence as f64 * 20.0,
                        )]),
                    })
                    .collect(),
            })
            .unwrap();
        drop(engine);

        let engine = Engine::open(directory.path(), 100).unwrap();
        assert_eq!(engine.stats().unwrap().hot_points, 2);
        assert_eq!(engine.compact().unwrap(), 2);
        drop(engine);

        let engine = Engine::open(directory.path(), 100).unwrap();
        let response = engine
            .query(&QueryRequest {
                run_id: run.id,
                source_ids: vec![source.id.clone()],
                metrics: vec!["cpu/percent".into()],
                axis: "wall_time".into(),
                from: None,
                to: None,
                max_points: 100,
            })
            .unwrap();

        assert_eq!(response.series[0].values, vec![10.0, 30.0]);
        assert_eq!(
            response.series[0].event_time_ns,
            vec![1_000_000_000, 2_000_000_000]
        );
        assert_eq!(engine.list_sources(None).unwrap(), vec![source.clone()]);
        assert_eq!(
            engine
                .repository
                .cursor(&source.id, "hostmon-history-v1")
                .unwrap(),
            Some(2)
        );
        let mut sources = HashMap::new();
        let mut schedule = BinaryHeap::new();
        let mut scheduled = HashSet::new();
        engine.refresh_schedule(&mut sources, &mut schedule, &mut scheduled);
        assert!(sources.is_empty());
        assert!(schedule.is_empty());
        assert!(scheduled.is_empty());
    }

    #[test]
    fn registers_only_http_pull_base_urls() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("project").unwrap();
        let experiment = engine.create_experiment(&project.id, "experiment").unwrap();
        let run = engine.create_run(&experiment.id, "run", "{}").unwrap();
        let mut registration = SourceRegistration {
            run_id: run.id,
            attempt_id: "attempt-1".into(),
            role: "learner".into(),
            endpoint: String::new(),
            node_id: None,
            rank: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
        };
        for endpoint in [
            "archive://hostmon-history",
            "file:///output/metrics.jsonl",
            "/output/metrics.jsonl",
            "ftp://learner/metrics",
            "http://",
            "http://learner/role?token=value",
            "https://learner/role#metrics",
        ] {
            registration.endpoint = endpoint.into();
            assert!(
                matches!(
                    engine.register_source(&registration),
                    Err(EngineError::InvalidInput(_))
                ),
                "{endpoint} must not be registered"
            );
        }
        assert!(engine.list_sources(None).unwrap().is_empty());
        for endpoint in ["http://127.0.0.1:9200", "https://learner.example/role/"] {
            registration.endpoint = endpoint.into();
            let source = engine.register_source(&registration).unwrap();
            assert_eq!(source.endpoint, endpoint.trim_end_matches('/'));
            assert_eq!(source.state, SourceState::Discovered);
        }
    }

    #[derive(Deserialize)]
    struct PointQuery {
        after: u64,
    }

    #[tokio::test]
    async fn pulls_descriptor_and_cursor_snapshots_from_a_role_endpoint() {
        async fn descriptor() -> Json<SnapshotDescriptor> {
            Json(SnapshotDescriptor {
                protocol_version: PROTOCOL_VERSION,
                source_session_id: "session-1".into(),
                project: "project".into(),
                experiment: "experiment".into(),
                run_id: "placeholder".into(),
                attempt_id: "attempt-1".into(),
                role: "learner".into(),
                rank: Some(0),
                node_id: Some("node-a".into()),
                pid: Some(42),
                labels: BTreeMap::new(),
                schema_version: 1,
            })
        }

        async fn points(Query(query): Query<PointQuery>) -> Json<SnapshotHistoryResponse> {
            let sequence = query.after;
            Json(SnapshotHistoryResponse {
                protocol_version: PROTOCOL_VERSION,
                source_session_id: "session-1".into(),
                oldest_sequence: 0,
                next_sequence: sequence + 1,
                dropped_before: None,
                snapshots: vec![rvx_core::StateSnapshot {
                    source_session_id: "session-1".into(),
                    sequence,
                    observed_at_ns: sequence as i64,
                    schema_version: 1,
                    axes: BTreeMap::from([("optimizer_step".into(), sequence as i64)]),
                    state: serde_json::json!({"progress": {"loss": 0.25}, "workers": [{"busy": true}]}),
                }],
            })
        }

        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("project").unwrap();
        let experiment = engine.create_experiment(&project.id, "experiment").unwrap();
        let run = engine.create_run(&experiment.id, "run", "{}").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let run_id = run.id.clone();
        let application = Router::new()
            .route(
                "/v1/snapshots/descriptor",
                get(move || {
                    let run_id = run_id.clone();
                    async move {
                        let mut response = descriptor().await;
                        response.run_id = run_id;
                        response
                    }
                }),
            )
            .route("/v1/snapshots/history", get(points));
        let server = tokio::spawn(async move {
            axum::serve(listener, application).await.unwrap();
        });
        let source = engine
            .register_source(&SourceRegistration {
                run_id: run.id.clone(),
                attempt_id: "attempt-1".into(),
                role: "learner".into(),
                endpoint: format!("http://{address}"),
                node_id: Some("node-a".into()),
                rank: Some(0),
                scrape_interval_ms: 100,
                timeout_ms: 500,
            })
            .unwrap();

        assert_eq!(engine.scrape_source(&source).await.unwrap(), 1);
        let response = engine
            .snapshot_query(&SnapshotQueryRequest {
                run_ids: vec![run.id.clone()],
                source_ids: Vec::new(),
                paths: vec!["/progress/loss".into()],
                axis: "optimizer_step".into(),
                from: None,
                to: None,
                max_points: 100,
            })
            .unwrap();

        assert_eq!(response.series[0].values, vec![Some(0.25)]);
        assert_eq!(engine.stats().unwrap().snapshots, 1);
        assert_eq!(engine.stats().unwrap().ingested_points, 0);
        let persisted_run = engine.list_runs(None).unwrap().remove(0);
        assert_eq!(persisted_run.status, RunStatus::Running);
        assert!(persisted_run.updated_at_ns > persisted_run.created_at_ns);
        let persisted_source = engine.list_sources(None).unwrap().remove(0);
        assert_eq!(persisted_source.state, SourceState::Active);
        assert_eq!(
            persisted_source
                .descriptor
                .and_then(|descriptor| descriptor["pid"].as_u64()),
            Some(42)
        );
        let draining = engine
            .update_source_state(&source.id, &SourceState::Draining)
            .unwrap();
        assert_eq!(engine.scrape_source(&source).await.unwrap(), 0);
        assert_eq!(
            engine.list_sources(None).unwrap()[0].state,
            SourceState::Draining
        );
        assert_eq!(engine.stats().unwrap().snapshots, 1);
        let ended = engine
            .update_source_state(&source.id, &SourceState::Ended)
            .unwrap();
        assert_eq!(draining.state, SourceState::Draining);
        assert_eq!(ended.state, SourceState::Ended);
        assert_eq!(engine.scrape_source(&source).await.unwrap(), 0);
        assert!(engine
            .update_source_state(&source.id, &SourceState::Draining)
            .is_err());
        let finished = engine
            .update_run_status(&run.id, &RunStatus::Finished)
            .unwrap();
        assert_eq!(finished.status, RunStatus::Finished);
        assert_eq!(
            engine.list_sources(None).unwrap()[0].state,
            SourceState::Ended
        );
        assert!(engine
            .update_run_status(&run.id, &RunStatus::Running)
            .is_err());
        assert_eq!(engine.scrape_source(&source).await.unwrap(), 0);
        assert_eq!(engine.stats().unwrap().snapshots, 1);
        server.abort();
    }

    #[tokio::test]
    async fn coordinator_and_manual_pull_share_source_ownership_across_session_restarts() {
        struct Restart {
            run_id: String,
            descriptors: AtomicUsize,
            histories: AtomicUsize,
            history_entered: tokio::sync::Notify,
            release_history: tokio::sync::Notify,
            second_descriptor: tokio::sync::Notify,
        }

        async fn descriptor(
            axum::extract::State(state): axum::extract::State<Arc<Restart>>,
        ) -> Json<serde_json::Value> {
            let request = state.descriptors.fetch_add(1, Ordering::SeqCst);
            if request > 0 {
                state.second_descriptor.notify_one();
            }
            Json(serde_json::json!({
                "protocol_version":1,"source_session_id":if request == 0 {"old-session"} else {"new-session"},
                "project":"p","experiment":"e","run_id":state.run_id,"attempt_id":"a","role":"learner"
            }))
        }

        async fn history(
            axum::extract::State(state): axum::extract::State<Arc<Restart>>,
        ) -> Json<serde_json::Value> {
            let request = state.histories.fetch_add(1, Ordering::SeqCst);
            if request == 0 {
                state.history_entered.notify_one();
                state.release_history.notified().await;
            }
            let session = if request == 0 {
                "old-session"
            } else {
                "new-session"
            };
            Json(serde_json::json!({
                "protocol_version":1,"source_session_id":session,"oldest_sequence":0,"next_sequence":1,
                "snapshots":[{"source_session_id":session,"sequence":0,"observed_at_ns":request as i64,
                    "state":{"session":session}}]
            }))
        }

        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("p").unwrap();
        let experiment = engine.create_experiment(&project.id, "e").unwrap();
        let run = engine.create_run(&experiment.id, "r", "{}").unwrap();
        let restart = Arc::new(Restart {
            run_id: run.id.clone(),
            descriptors: AtomicUsize::new(0),
            histories: AtomicUsize::new(0),
            history_entered: tokio::sync::Notify::new(),
            release_history: tokio::sync::Notify::new(),
            second_descriptor: tokio::sync::Notify::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let application = Router::new()
            .route("/v1/snapshots/descriptor", get(descriptor))
            .route("/v1/snapshots/history", get(history))
            .with_state(restart.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, application).await.unwrap();
        });
        let source = engine
            .register_source(&SourceRegistration {
                run_id: run.id.clone(),
                attempt_id: "a".into(),
                role: "learner".into(),
                endpoint,
                node_id: None,
                rank: None,
                scrape_interval_ms: 60_000,
                timeout_ms: 5_000,
            })
            .unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let coordinator = tokio::spawn(engine.clone().run_scraper(1, shutdown_rx));
        tokio::time::timeout(Duration::from_secs(5), restart.history_entered.notified())
            .await
            .unwrap();
        let manual_engine = engine.clone();
        let manual_source = source.clone();
        let manual = tokio::spawn(async move { manual_engine.scrape_source(&manual_source).await });
        assert!(tokio::time::timeout(Duration::from_millis(100),restart.second_descriptor.notified()).await.is_err(),
            "a manual scrape must not start another descriptor request while the coordinator owns this source");
        restart.release_history.notify_one();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), manual)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            1
        );
        shutdown_tx.send(true).unwrap();
        coordinator.await.unwrap();
        let latest = engine
            .snapshot_latest(&SnapshotLatestRequest {
                run_id: run.id,
                source_ids: vec![],
                limit: 100,
                after_source_id: None,
            })
            .unwrap();
        assert_eq!(
            latest.snapshots[0].snapshot.source_session_id,
            "new-session"
        );
        assert_eq!(
            engine.list_sources(None).unwrap()[0]
                .source_session_id
                .as_deref(),
            Some("new-session")
        );
        assert_eq!(engine.stats().unwrap().snapshots, 2);
        assert_eq!(engine.scrape_owners.lock().len(), 1);
        let mut unregistered = source;
        unregistered.id = "not-registered".into();
        assert!(engine.scrape_source(&unregistered).await.is_err());
        assert_eq!(engine.scrape_owners.lock().len(), 1);
        assert!((2..=3).contains(&restart.descriptors.load(Ordering::SeqCst)));
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn coordinator_drains_short_pages_without_waiting_between_backlog_pages() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("p").unwrap();
        let experiment = engine.create_experiment(&project.id, "e").unwrap();
        let run = engine.create_run(&experiment.id, "r", "{}").unwrap();
        let run_id = run.id.clone();
        let application = Router::new()
            .route(
                "/v1/snapshots/descriptor",
                get(move || {
                    let run_id = run_id.clone();
                    async move {
                        Json(serde_json::json!({
                            "protocol_version": 1, "source_session_id": "backlog",
                            "project": "p", "experiment": "e", "run_id": run_id,
                            "attempt_id": "a", "role": "learner"
                        }))
                    }
                }),
            )
            .route(
                "/v1/snapshots/history",
                get(|Query(query): Query<PointQuery>| async move {
                    let end = (query.after + 2).min(130);
                    Json(SnapshotHistoryResponse {
                        protocol_version: 1,
                        source_session_id: "backlog".into(),
                        oldest_sequence: 0,
                        next_sequence: end,
                        dropped_before: None,
                        snapshots: (query.after..end)
                            .map(|sequence| rvx_core::StateSnapshot {
                                source_session_id: "backlog".into(),
                                sequence,
                                observed_at_ns: sequence as i64,
                                schema_version: 1,
                                axes: BTreeMap::new(),
                                state: serde_json::json!({"value": sequence}),
                            })
                            .collect(),
                    })
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, application).await.unwrap();
        });
        engine
            .register_source(&SourceRegistration {
                run_id: run.id,
                attempt_id: "a".into(),
                role: "learner".into(),
                endpoint,
                node_id: None,
                rank: None,
                scrape_interval_ms: 60_000,
                timeout_ms: 1_000,
            })
            .unwrap();
        let (stop, shutdown) = watch::channel(false);
        let coordinator = tokio::spawn(engine.clone().run_scraper(1, shutdown));
        let drained = tokio::time::timeout(Duration::from_secs(5), async {
            while engine.stats().unwrap().snapshots < 130 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        stop.send(true).unwrap();
        coordinator.await.unwrap();
        server.abort();
        let _ = server.await;
        assert!(
            drained.is_ok(),
            "retained pages must not wait for the 60-second idle poll"
        );
        let stats = engine.stats().unwrap();
        assert_eq!(stats.snapshots, 130);
        assert_eq!(stats.cursor_gaps, 0);
        assert_eq!(stats.scrape_failures, 0);
    }

    #[tokio::test]
    async fn coordinator_shutdown_cancels_blocked_http_and_releases_source_ownership() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path(), 100).unwrap();
        let project = engine.create_project("p").unwrap();
        let experiment = engine.create_experiment(&project.id, "e").unwrap();
        let run = engine.create_run(&experiment.id, "r", "{}").unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let seen = entered.clone();
        let application = Router::new().route(
            "/v1/snapshots/descriptor",
            get(move || {
                let seen = seen.clone();
                async move {
                    seen.notify_one();
                    std::future::pending::<Json<serde_json::Value>>().await
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, application).await.unwrap();
        });
        let source = engine
            .register_source(&SourceRegistration {
                run_id: run.id,
                attempt_id: "a".into(),
                role: "learner".into(),
                endpoint,
                node_id: None,
                rank: None,
                scrape_interval_ms: 60_000,
                timeout_ms: 60_000,
            })
            .unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let coordinator = tokio::spawn(engine.clone().run_scraper(1, shutdown_rx));
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), coordinator)
            .await
            .unwrap()
            .unwrap();
        let owner = engine.scrape_owners.lock().get(&source.id).unwrap().clone();
        assert!(owner.try_lock().is_ok());
        assert_eq!(engine.stats().unwrap().snapshots, 0);
        server.abort();
        let _ = server.await;
    }
}
