use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rvx_core::{
    IngestionDiagnostics, SnapshotDescriptor, SnapshotHistoryResponse, Source,
    MAX_SNAPSHOT_PAGE_BYTES,
};
use tokio::sync::{mpsc, oneshot, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

use crate::diagnostics::{observe, observe_write, WriteTiming};
use crate::{repository::Repository, snapshot_store::SnapshotStore, EngineError, Result};

const MAX_BATCH_PAGES: usize = 64;
const MAX_BATCH_RECORDS: usize = 1024;
const MAX_BATCH_BYTES: usize = MAX_SNAPSHOT_PAGE_BYTES + 256 * 1024;
const QUEUED_BYTES: usize = 2 * MAX_BATCH_BYTES;
const GROUP_DELAY: Duration = Duration::from_millis(2);

struct Pending {
    source: Source,
    descriptor: SnapshotDescriptor,
    page: SnapshotHistoryResponse,
    bytes: usize,
    queued_at: Instant,
    reply: oneshot::Sender<Result<usize>>,
    _owner: OwnedMutexGuard<()>,
    _budget: OwnedSemaphorePermit,
}

/// Group durable writes across Sources without acknowledging or releasing ownership before commit.
pub(crate) struct Ingestor {
    sender: Option<mpsc::Sender<Pending>>,
    budget: Arc<Semaphore>,
    worker: Option<JoinHandle<()>>,
    diagnostics: Arc<parking_lot::Mutex<IngestionDiagnostics>>,
}

impl Ingestor {
    pub fn new(snapshots: Arc<SnapshotStore>, repository: Arc<Repository>) -> Result<Self> {
        let (sender, receiver) = mpsc::channel(MAX_BATCH_PAGES);
        let diagnostics = Arc::new(parking_lot::Mutex::new(IngestionDiagnostics::default()));
        let worker_diagnostics = diagnostics.clone();
        let worker = thread::Builder::new()
            .name("rvx-ingest".into())
            .spawn(move || Self::run(receiver, snapshots, repository, worker_diagnostics))?;
        Ok(Self {
            sender: Some(sender),
            budget: Arc::new(Semaphore::new(QUEUED_BYTES)),
            worker: Some(worker),
            diagnostics,
        })
    }

    pub fn diagnostics(&self) -> IngestionDiagnostics {
        self.diagnostics.lock().clone()
    }

    pub async fn commit(
        &self,
        source: Source,
        descriptor: SnapshotDescriptor,
        page: SnapshotHistoryResponse,
        owner: OwnedMutexGuard<()>,
    ) -> Result<usize> {
        let bytes = serde_json::to_vec(&page)?.len() + serde_json::to_vec(&descriptor)?.len();
        if bytes > MAX_BATCH_BYTES {
            return Err(EngineError::InvalidInput(
                "snapshot page and descriptor exceed ingestion queue budget".into(),
            ));
        }
        let admission = Instant::now();
        let budget = self
            .budget
            .clone()
            .acquire_many_owned(bytes as u32)
            .await
            .map_err(|error| EngineError::Runtime(error.to_string()))?;
        let (reply, receive) = oneshot::channel();
        self.sender
            .as_ref()
            .expect("live ingestion sender")
            .send(Pending {
                source,
                descriptor,
                page,
                bytes,
                queued_at: Instant::now(),
                reply,
                _owner: owner,
                _budget: budget,
            })
            .await
            .map_err(|_| EngineError::Runtime("ingestion worker stopped".into()))?;
        observe(
            &mut self.diagnostics.lock().admission_wait,
            admission.elapsed(),
        );
        receive
            .await
            .map_err(|_| EngineError::Runtime("ingestion worker dropped acknowledgment".into()))?
    }

    fn run(
        mut receiver: mpsc::Receiver<Pending>,
        snapshots: Arc<SnapshotStore>,
        repository: Arc<Repository>,
        diagnostics: Arc<parking_lot::Mutex<IngestionDiagnostics>>,
    ) {
        let mut deferred = None;
        while let Some(first) = deferred.take().or_else(|| receiver.blocking_recv()) {
            let mut bytes = first.bytes;
            let mut records = first.page.snapshots.len();
            let mut batch = vec![first];
            thread::sleep(GROUP_DELAY);
            while batch.len() < MAX_BATCH_PAGES {
                let Ok(next) = receiver.try_recv() else { break };
                if bytes + next.bytes > MAX_BATCH_BYTES
                    || records + next.page.snapshots.len() > MAX_BATCH_RECORDS
                {
                    deferred = Some(next);
                    break;
                }
                bytes += next.bytes;
                records += next.page.snapshots.len();
                batch.push(next);
            }
            Self::write(batch, &snapshots, &repository, &diagnostics);
        }
    }

    fn write(
        batch: Vec<Pending>,
        snapshots: &SnapshotStore,
        repository: &Repository,
        diagnostics: &parking_lot::Mutex<IngestionDiagnostics>,
    ) {
        {
            let mut stats = diagnostics.lock();
            stats.groups += 1;
            stats.pages += batch.len() as u64;
            stats.empty_pages +=
                batch.iter().filter(|p| p.page.snapshots.is_empty()).count() as u64;
            let records = batch
                .iter()
                .map(|p| p.page.snapshots.len() as u64)
                .sum::<u64>();
            stats.input_records += records;
            stats.serialized_bytes += batch.iter().map(|p| p.bytes as u64).sum::<u64>();
            stats.max_group_pages = stats.max_group_pages.max(batch.len() as u64);
            stats.max_group_records = stats.max_group_records.max(records);
            for pending in &batch {
                observe(&mut stats.queue_wait, pending.queued_at.elapsed());
            }
        }
        let pages: Vec<_> = batch
            .iter()
            .map(|pending| (&pending.source, &pending.descriptor, &pending.page))
            .collect();
        let mut snapshot_timing = WriteTiming::default();
        let results = snapshots.ingest_batch_timed(&pages, &mut snapshot_timing);
        observe_write(&mut diagnostics.lock().snapshots, &snapshot_timing);
        let results = match results {
            Ok(results) => results,
            Err(error) => {
                diagnostics.lock().failed_pages += batch.len() as u64;
                Self::fail(batch, &error);
                return;
            }
        };
        {
            let mut stats = diagnostics.lock();
            stats.committed_records += results
                .iter()
                .filter_map(|r| r.as_ref().ok())
                .sum::<usize>() as u64;
            stats.failed_pages += results.iter().filter(|r| r.is_err()).count() as u64;
        }
        let successful: Vec<_> = batch
            .iter()
            .zip(&results)
            .filter(|(_, result)| result.is_ok())
            .map(|(pending, _)| (pending.source.id.as_str(), &pending.descriptor))
            .collect();
        let mut metadata_timing = WriteTiming::default();
        let metadata = repository.update_source_success_batch(&successful, &mut metadata_timing);
        observe_write(&mut diagnostics.lock().metadata, &metadata_timing);
        if let Err(error) = metadata {
            diagnostics.lock().failed_pages += successful.len() as u64;
            Self::fail(batch, &error);
            return;
        }
        for (pending, result) in batch.into_iter().zip(results) {
            // A disconnected client does not roll back already committed observations.
            if let Err(Err(error)) = pending.reply.send(result) {
                eprintln!(
                    "RVX cancelled scrape for {} failed: {error}",
                    pending.source.id
                );
            }
        }
    }

    fn fail(batch: Vec<Pending>, error: &EngineError) {
        eprintln!("RVX grouped ingestion failed: {error}");
        for pending in batch {
            let _ = pending.reply.send(Err(EngineError::Runtime(format!(
                "grouped ingestion failed: {error}"
            ))));
        }
    }
}

impl Drop for Ingestor {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("RVX ingestion worker panicked during shutdown");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rvx_core::{PersistedCursorRequest, StateSnapshot};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn fixture() -> (tempfile::TempDir, Arc<SnapshotStore>, Arc<Repository>) {
        let directory = crate::test_directory().unwrap();
        let snapshots =
            Arc::new(SnapshotStore::open(&directory.path().join("snapshots.db")).unwrap());
        let repository = Arc::new(Repository::open(&directory.path().join("metadata.db")).unwrap());
        (directory, snapshots, repository)
    }

    fn registration(
        repository: &Repository,
        index: usize,
    ) -> (Source, SnapshotDescriptor, SnapshotHistoryResponse) {
        let project = repository.create_project(&format!("p-{index}")).unwrap();
        let experiment = repository.create_experiment(&project.id, "e").unwrap();
        let run = repository.create_run(&experiment.id, "r", "{}").unwrap();
        let source = Source {
            id: format!("source-{index}"),
            run_id: run.id.clone(),
            attempt_id: "a".into(),
            role: "worker".into(),
            endpoint: format!("http://127.0.0.1:1/{index}"),
            node_id: None,
            rank: None,
            state: rvx_core::SourceState::Discovered,
            source_session_id: None,
            last_success_at_ns: None,
            last_error: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
            descriptor: None,
        };
        let source = repository.register_source(&source).unwrap();
        let descriptor = SnapshotDescriptor {
            protocol_version: 1,
            source_session_id: format!("session-{index}"),
            project: project.name,
            experiment: experiment.name,
            run_id: run.id,
            attempt_id: "a".into(),
            role: "worker".into(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        };
        let page = SnapshotHistoryResponse {
            protocol_version: 1,
            source_session_id: descriptor.source_session_id.clone(),
            oldest_sequence: 0,
            next_sequence: 1,
            dropped_before: None,
            snapshots: vec![StateSnapshot {
                source_session_id: descriptor.source_session_id.clone(),
                sequence: 0,
                observed_at_ns: 1,
                schema_version: 1,
                axes: BTreeMap::new(),
                state: json!({"value": index}),
            }],
        };
        (source, descriptor, page)
    }

    #[tokio::test]
    async fn acknowledgments_follow_commits_and_preserve_page_errors() {
        let (_directory, snapshots, repository) = fixture();
        let ingestor = Ingestor::new(snapshots.clone(), repository.clone()).unwrap();
        let (source, descriptor, page) = registration(&repository, 0);
        let owner = Arc::new(tokio::sync::Mutex::new(()));
        assert_eq!(
            ingestor
                .commit(
                    source.clone(),
                    descriptor.clone(),
                    page.clone(),
                    owner.clone().lock_owned().await
                )
                .await
                .unwrap(),
            1
        );
        let ack = snapshots
            .persisted_cursor(&PersistedCursorRequest {
                run_id: source.run_id.clone(),
                source_id: source.id.clone(),
                source_session_id: descriptor.source_session_id.clone(),
                next_sequence: 1,
            })
            .unwrap();
        assert!(ack.complete && !ack.has_gaps);
        let state = repository.source_by_id(&source.id).unwrap().source;
        assert_eq!(state.state, rvx_core::SourceState::Active);
        assert!(state.last_success_at_ns.is_some());
        let mut conflict = page.clone();
        conflict.snapshots[0].state = json!({"value": "conflict"});
        assert!(matches!(
            ingestor
                .commit(
                    source.clone(),
                    descriptor.clone(),
                    conflict,
                    owner.clone().lock_owned().await
                )
                .await,
            Err(EngineError::InvalidInput(_))
        ));
        assert_eq!(snapshots.count().unwrap(), 1);
        assert_eq!(
            ingestor
                .commit(
                    source.clone(),
                    descriptor.clone(),
                    page,
                    owner.clone().lock_owned().await
                )
                .await
                .unwrap(),
            0
        );
        let newer = repository.source_by_id(&source.id).unwrap().source;
        assert!(newer.last_success_at_ns > state.last_success_at_ns);
        let stats = ingestor.diagnostics();
        assert_eq!(stats.groups, 3);
        assert_eq!(stats.pages, 3);
        assert_eq!(stats.input_records, 3);
        assert_eq!(stats.committed_records, 1);
        assert_eq!(stats.failed_pages, 1);
        assert_eq!(stats.queue_wait.count, 3);
        assert_eq!(stats.snapshots.commit.count, 3);
    }

    #[tokio::test]
    async fn shutdown_drains_accepted_pages_after_receiver_cancellation() {
        let (_directory, snapshots, repository) = fixture();
        let ingestor = Ingestor::new(snapshots.clone(), repository.clone()).unwrap();
        let mut owners = Vec::new();
        for index in 0..16 {
            let (source, descriptor, page) = registration(&repository, index);
            let owner = Arc::new(tokio::sync::Mutex::new(()));
            let guard = owner.clone().lock_owned().await;
            owners.push(owner);
            let (reply, receive) = oneshot::channel();
            drop(receive);
            let budget = ingestor.budget.clone().acquire_many_owned(1).await.unwrap();
            ingestor
                .sender
                .as_ref()
                .unwrap()
                .send(Pending {
                    source,
                    descriptor,
                    page,
                    bytes: 1,
                    queued_at: Instant::now(),
                    reply,
                    _owner: guard,
                    _budget: budget,
                })
                .await
                .unwrap();
        }
        drop(ingestor);
        assert_eq!(snapshots.count().unwrap(), 16);
        assert!(owners.iter().all(|owner| owner.try_lock().is_ok()));
        assert_eq!(repository.list_sources(None).unwrap().len(), 16);
    }

    #[tokio::test]
    async fn byte_backpressure_is_cancellable_without_losing_source_ownership() {
        let (_directory, snapshots, repository) = fixture();
        let ingestor = Ingestor::new(snapshots.clone(), repository.clone()).unwrap();
        let (source, descriptor, page) = registration(&repository, 0);
        let owner = Arc::new(tokio::sync::Mutex::new(()));
        let held = ingestor
            .budget
            .clone()
            .acquire_many_owned(QUEUED_BYTES as u32)
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(20),
            ingestor.commit(
                source.clone(),
                descriptor.clone(),
                page.clone(),
                owner.clone().lock_owned().await,
            ),
        )
        .await;
        assert!(result.is_err());
        assert!(owner.try_lock().is_ok());
        assert_eq!(snapshots.count().unwrap(), 0);
        drop(held);
        assert_eq!(
            ingestor
                .commit(source, descriptor, page, owner.lock_owned().await)
                .await
                .unwrap(),
            1
        );
        let all = tokio::time::timeout(
            Duration::from_secs(1),
            ingestor
                .budget
                .clone()
                .acquire_many_owned(QUEUED_BYTES as u32),
        )
        .await
        .unwrap()
        .unwrap();
        drop(all);
    }

    #[tokio::test]
    async fn metadata_failure_never_reports_a_success_and_retries_remain_idempotent() {
        let (directory, snapshots, repository) = fixture();
        let (source, descriptor, page) = registration(&repository, 0);
        // This isolated fixture has no running daemon or writer yet.
        let fault = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER fail_success BEFORE UPDATE ON sources
                        BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;",
            )
            .unwrap();
        drop(fault);
        let ingestor = Ingestor::new(snapshots.clone(), repository.clone()).unwrap();
        let owner = Arc::new(tokio::sync::Mutex::new(()));
        let result = ingestor
            .commit(
                source.clone(),
                descriptor.clone(),
                page.clone(),
                owner.clone().lock_owned().await,
            )
            .await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("injected metadata failure"));
        assert_eq!(snapshots.count().unwrap(), 1);
        assert_eq!(snapshots.cursor("source-0", "session-0").unwrap(), 1);
        drop(ingestor);
        let fault = rusqlite::Connection::open(directory.path().join("metadata.db")).unwrap();
        fault.execute_batch("DROP TRIGGER fail_success").unwrap();
        drop(fault);
        let ingestor = Ingestor::new(snapshots.clone(), repository.clone()).unwrap();
        assert_eq!(
            ingestor
                .commit(source.clone(), descriptor, page, owner.lock_owned().await)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            repository.source_by_id(&source.id).unwrap().source.state,
            rvx_core::SourceState::Active
        );
        assert_eq!(snapshots.count().unwrap(), 1);
    }
}
