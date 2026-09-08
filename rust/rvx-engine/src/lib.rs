mod chart_index;
mod auth_sessions;
mod repository;
mod snapshot_store;
mod snapshot_views;
mod ui_state;

pub use ui_state::{valid_browser_id, UiSession};
pub use auth_sessions::{AUTH_SESSION_SECONDS, MAX_AUTH_SESSIONS};

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rvx_core::{
    new_id, now_ns, validate_snapshot_descriptor, ChartCatalogRequest, ChartCatalogResponse,
    EngineStats, Experiment, Project, Run, RunStatus, SnapshotDescriptor, SnapshotDiffRequest,
    SnapshotDiffResponse, SnapshotHistoryPage, SnapshotHistoryRequest, SnapshotHistoryResponse,
    SnapshotLatestRequest, SnapshotLatestResponse, SnapshotQueryRequest, SnapshotQueryResponse,
    Source, SourceRegistration, SourceState, StoredSnapshot,
    TableCatalogRequest, TableCatalogResponse, TableRowsRequest, TableRowsResponse,
    TableSummaryRequest, TableSummaryResponse,
};
use thiserror::Error;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{interval, sleep_until, Instant, MissedTickBehavior};

use repository::Repository;
use snapshot_store::SnapshotStore;
pub use snapshot_store::tables::TableReadControl;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("authentication sessions are temporarily unavailable")]
    AuthSessionUnavailable,
    #[error("{error}")]
    UiConflict {
        error: String,
        current: serde_json::Value,
    },
    #[error("{0}")]
    UiBootstrap(String),
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
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("runtime error: {0}")]
    Runtime(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Default)]
struct Counters {
    scrape_failures: AtomicU64,
}

pub struct Engine {
    repository: Repository,
    snapshots: SnapshotStore,
    scrape_owners: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    client: reqwest::Client,
    counters: Counters,
}

impl Engine {
    pub fn open(directory: impl AsRef<Path>) -> Result<Arc<Self>> {
        let directory = directory.as_ref();
        std::fs::create_dir_all(directory)?;
        let repository = Repository::open(&directory.join("metadata.db"))?;
        let snapshots = SnapshotStore::open(&directory.join("snapshots.db"))?;
        let engine = Arc::new(Self {
            repository,
            snapshots,
            scrape_owners: parking_lot::Mutex::new(HashMap::new()),
            client: reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(60))
                .tcp_nodelay(true)
                .build()?,
            counters: Counters::default(),
        });
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

    /// Register an HTTP(S) role API.
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

    pub fn stats(&self) -> Result<EngineStats> {
        let (projects, experiments, runs, sources, active_sources) = self.repository.counts()?;
        Ok(EngineStats {
            snapshots: self.snapshots.count()?,
            projects,
            experiments,
            runs,
            sources,
            active_sources,
            cursor_gaps: self.snapshots.gap_count()?,
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

    /// Resolve chart-point provenance to the original stored observation, including its full state.
    pub fn snapshot_get(&self, id: i64) -> Result<StoredSnapshot> {
        self.snapshots.get(id)
    }

    /// Join Source identities with indexed field availability and defaults without reading state histories.
    pub fn chart_catalog(&self, request: &ChartCatalogRequest) -> Result<ChartCatalogResponse> {
        if request.run_ids.is_empty() || request.run_ids.len() > rvx_core::MAX_SNAPSHOT_QUERY_RUNS {
            return Err(EngineError::InvalidInput(
                "catalog requires 1..64 run_ids".into(),
            ));
        }
        let sources = request
            .run_ids
            .iter()
            .map(|run| self.list_sources(Some(run)))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        self.snapshots.catalog(request, &sources)
    }

    /// Compute exact-range statistics over the complete covered numeric index, separated by Source.
    pub fn table_summary(&self, request: &TableSummaryRequest) -> Result<TableSummaryResponse> {
        self.table_summary_controlled(request, &TableReadControl::default())
    }

    /// Perform an exact summary with request-local cooperative cancellation.
    pub fn table_summary_controlled(
        &self,
        request: &TableSummaryRequest,
        control: &TableReadControl,
    ) -> Result<TableSummaryResponse> {
        control.check()?;
        snapshot_store::tables::validate_selection(&request.run_ids, &request.source_ids)?;
        let sources = self
            .repository
            .table_sources(&request.run_ids, &request.source_ids)?;
        self.snapshots.table_summary(request, &sources, control)
    }

    /// Discover structured collections from current complete snapshots without returning raw state.
    pub fn table_catalog(&self, request: &TableCatalogRequest) -> Result<TableCatalogResponse> {
        self.table_catalog_controlled(request, &TableReadControl::default())
    }

    /// Discover table metadata with request-local cancellation and explicit truncation.
    pub fn table_catalog_controlled(
        &self,
        request: &TableCatalogRequest,
        control: &TableReadControl,
    ) -> Result<TableCatalogResponse> {
        control.check()?;
        snapshot_store::tables::validate_selection(&request.run_ids, &request.source_ids)?;
        let sources = self
            .repository
            .table_sources(&request.run_ids, &request.source_ids)?;
        self.snapshots.table_catalog(&sources, control)
    }

    /// Sort and filter complete selected collections before pagination, preserving exact cell numbers.
    pub fn table_rows(&self, request: &TableRowsRequest) -> Result<TableRowsResponse> {
        self.table_rows_controlled(request, &TableReadControl::default())
    }

    /// Read pinned or current structured rows with request-local cooperative cancellation.
    pub fn table_rows_controlled(
        &self,
        request: &TableRowsRequest,
        control: &TableReadControl,
    ) -> Result<TableRowsResponse> {
        control.check()?;
        snapshot_store::tables::validate_selection(&request.run_ids, &request.source_ids)?;
        let sources = self
            .repository
            .table_sources(&request.run_ids, &request.source_ids)?;
        self.snapshots.table_rows(request, &sources, control)
    }

    pub fn snapshot_diff(&self, request: &SnapshotDiffRequest) -> Result<SnapshotDiffResponse> {
        self.snapshots.diff(request)
    }

    /// Pull the versioned snapshot protocol.
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

#[cfg(test)]
fn test_directory() -> std::io::Result<tempfile::TempDir> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
    std::fs::create_dir_all(&root)?;
    tempfile::tempdir_in(root)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicUsize;

    use crate::test_directory as tempdir;
    use axum::extract::Query;
    use axum::routing::get;
    use axum::{Json, Router};
    use rvx_core::{RunStatus, SnapshotDescriptor, SourceRegistration, PROTOCOL_VERSION};
    use serde::Deserialize;

    use super::*;

    #[test]
    fn persists_run_lifecycle_without_reopening_finished_runs() {
        let directory = tempdir().unwrap();
        let untouched = directory.path().join("metrics.wal");
        std::fs::write(&untouched, b"existing unrelated data").unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = engine.create_project("project").unwrap();
        let experiment = engine.create_experiment(&project.id, "experiment").unwrap();
        let run = engine.create_run(&experiment.id, "run", "{}").unwrap();
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

        let recovered = Engine::open(directory.path()).unwrap();
        assert_eq!(
            recovered.list_runs(None).unwrap()[0].status,
            RunStatus::Finished
        );
        assert_eq!(
            std::fs::read(untouched).unwrap(),
            b"existing unrelated data"
        );
    }

    #[test]
    fn registers_only_http_pull_base_urls() {
        let directory = tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
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
        let engine = Engine::open(directory.path()).unwrap();
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
        assert_eq!(engine.stats().unwrap().snapshots, 1);
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
        let engine = Engine::open(directory.path()).unwrap();
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
        let engine = Engine::open(directory.path()).unwrap();
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
        let engine = Engine::open(directory.path()).unwrap();
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
