use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use rvx_core::{default_snapshot_schema_version, new_id, SnapshotDescriptor, PROTOCOL_VERSION};
use rvx_snapshots::{BufferLimits, ProducerError, SnapshotEvent, SnapshotProducer, MAX_PAGE_BYTES};
use serde::Deserialize;
use tokio::runtime::{Builder, Runtime};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const MAX_IDENTITY_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    project: String,
    experiment: String,
    run_id: String,
    attempt_id: String,
    role: String,
    rank: Option<i64>,
    node_id: Option<String>,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default = "default_snapshot_schema_version")]
    schema_version: u32,
}

struct Serving {
    runtime: Runtime,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
    address: SocketAddr,
    requested_listen: SocketAddr,
}

#[derive(Default)]
struct Lifecycle {
    closed: bool,
}

/// Own a bounded producer and an optional standalone HTTP runtime.
#[pyclass(module = "rvx._native")]
pub struct RvxSource {
    producer: Arc<SnapshotProducer>,
    lifecycle: Mutex<Lifecycle>,
    serving: Mutex<Option<Serving>>,
    session_id: String,
    owner_pid: u32,
}

#[pymethods]
impl RvxSource {
    /// Allocate a fresh role session and bounded buffer without binding a listener.
    #[new]
    #[pyo3(signature = (
        identity_json,
        capacity=1_024,
        max_buffer_bytes=67_108_864
    ))]
    fn new(
        py: Python<'_>,
        identity_json: String,
        capacity: usize,
        max_buffer_bytes: usize,
    ) -> PyResult<Self> {
        if identity_json.len() > MAX_IDENTITY_BYTES {
            return Err(PyValueError::new_err("snapshot identity exceeds 1 MiB"));
        }
        let identity: Identity = serde_json::from_str(&identity_json).map_err(input_error)?;
        let session_id = new_id("session");
        let owner_pid = std::process::id();
        let descriptor = SnapshotDescriptor {
            protocol_version: PROTOCOL_VERSION,
            source_session_id: session_id.clone(),
            project: identity.project,
            experiment: identity.experiment,
            run_id: identity.run_id,
            attempt_id: identity.attempt_id,
            role: identity.role,
            rank: identity.rank,
            node_id: identity.node_id,
            pid: Some(owner_pid),
            labels: identity.labels,
            schema_version: identity.schema_version,
        };
        let producer = py
            .allow_threads(|| {
                SnapshotProducer::new(
                    descriptor,
                    BufferLimits {
                        max_snapshots: capacity,
                        max_bytes: max_buffer_bytes,
                    },
                )
            })
            .map_err(input_error)?;
        Ok(Self {
            producer,
            lifecycle: Mutex::new(Lifecycle::default()),
            serving: Mutex::new(None),
            session_id,
            owner_pid,
        })
    }

    /// Bind the requested address and start exactly one native HTTP worker.
    #[pyo3(signature = (listen="127.0.0.1:0"))]
    fn serve(&self, py: Python<'_>, listen: &str) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| {
            let listen: SocketAddr = listen.parse().map_err(input_error)?;
            let mut owned = self.serving.lock();
            let lifecycle = self.lifecycle.lock();
            ensure_open(&lifecycle)?;
            if let Some(serving) = owned.as_ref() {
                if serving.requested_listen != listen {
                    return Err(PyRuntimeError::new_err(
                        "source is already serving a different listen address; call stop_serving first",
                    ));
                }
                ensure_serving(serving)?;
                return Ok(format!("http://{}", serving.address));
            }
            let serving = Serving::start(Arc::clone(&self.producer), listen).map_err(operation_error)?;
            let address = serving.address;
            *owned = Some(serving);
            Ok(format!("http://{address}"))
        })
    }

    /// Return the bound endpoint only while the native server is running.
    #[getter]
    fn endpoint(&self, py: Python<'_>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| {
            let owned = self.serving.lock();
            ensure_open(&self.lifecycle.lock())?;
            let serving = owned
                .as_ref()
                .ok_or_else(|| PyRuntimeError::new_err("source is not serving standalone HTTP"))?;
            ensure_serving(serving)?;
            Ok(format!("http://{}", serving.address))
        })
    }

    /// Expose the immutable generated identity for this process's producer session.
    #[getter]
    fn source_session_id(&self) -> PyResult<String> {
        self.check_process()?;
        Ok(self.session_id.clone())
    }

    /// Validate and capture complete states locally, releasing the GIL for native work.
    fn capture_batch_json(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        self.check_process()?;
        if payload.len() > MAX_PAGE_BYTES {
            return Err(PyValueError::new_err("snapshot batch exceeds 16 MiB"));
        }
        py.allow_threads(|| {
            let events: Vec<SnapshotEvent> = serde_json::from_str(&payload).map_err(input_error)?;
            let lifecycle = self.lifecycle.lock();
            ensure_open(&lifecycle)?;
            let receipt = self.producer.capture_batch(events).map_err(capture_error)?;
            drop(lifecycle);
            serde_json::to_string(&receipt).map_err(operation_error)
        })
    }

    /// Freeze capture but keep HTTP reads available for the last Pull requests.
    fn seal(&self, py: Python<'_>) -> PyResult<u64> {
        self.check_process()?;
        py.allow_threads(|| {
            let lifecycle = self.lifecycle.lock();
            ensure_open(&lifecycle)?;
            Ok(self.producer.seal())
        })
    }

    /// Report retention and eviction counters without fetching data over HTTP.
    fn stats_json(&self, py: Python<'_>) -> PyResult<String> {
        self.check_process()?;
        py.allow_threads(|| serde_json::to_string(&self.producer.stats()).map_err(operation_error))
    }

    /// Return descriptor wire bytes without constructing a Python object tree.
    fn descriptor_bytes<'py>(&self, py: Python<'py>) -> PyResult<&'py PyBytes> {
        self.read_bytes(py, SnapshotProducer::descriptor_bytes)
    }

    /// Return latest wire bytes, or fail until the first capture is available.
    fn latest_bytes<'py>(&self, py: Python<'py>) -> PyResult<&'py PyBytes> {
        self.read_bytes(py, SnapshotProducer::latest_bytes)
    }

    /// Return a bounded history page serialized from shared immutable snapshots.
    #[pyo3(signature = (after=0, limit=64))]
    fn history_bytes<'py>(
        &self,
        py: Python<'py>,
        #[pyo3(from_py_with = "history_cursor")] after: u64,
        #[pyo3(from_py_with = "history_limit")] limit: usize,
    ) -> PyResult<&'py PyBytes> {
        self.read_bytes(py, |producer| producer.history_bytes(after, limit))
    }

    /// Stop only the owned HTTP listener, preserving capture and the producer session.
    fn stop_serving(&self, py: Python<'_>) -> PyResult<()> {
        self.check_process()?;
        py.allow_threads(|| self.stop_serving_native().map_err(operation_error))
    }

    /// Stop captures, shut down HTTP, and await or cancel the owned task.
    fn close(&self, py: Python<'_>) -> PyResult<()> {
        self.check_process()?;
        py.allow_threads(|| self.close_native().map_err(operation_error))
    }
}

impl RvxSource {
    /// Reject inherited runtimes instead of using locks and threads copied by fork.
    fn check_process(&self) -> PyResult<()> {
        if std::process::id() != self.owner_pid {
            return Err(PyRuntimeError::new_err(
                "construct Source inside each worker process; do not reuse it after fork",
            ));
        }
        Ok(())
    }

    /// Check lifetime and clone ownership before serializing with all locks released.
    fn read_bytes<'py>(
        &self,
        py: Python<'py>,
        serialize: impl FnOnce(&SnapshotProducer) -> rvx_snapshots::Result<Vec<u8>> + Send,
    ) -> PyResult<&'py PyBytes> {
        self.check_process()?;
        let bytes = py.allow_threads(|| {
            let producer = {
                let lifecycle = self.lifecycle.lock();
                ensure_open(&lifecycle)?;
                Arc::clone(&self.producer)
            };
            serialize(&producer).map_err(capture_error)
        })?;
        Ok(PyBytes::new(py, &bytes))
    }

    /// Seal and release retained history before waiting for owned HTTP shutdown.
    fn close_native(&self) -> Result<(), String> {
        {
            let mut lifecycle = self.lifecycle.lock();
            lifecycle.closed = true;
            self.producer.seal_and_release_history();
        }
        self.stop_serving_native()
    }

    /// Serialize listener ownership without blocking producer capture or raw reads.
    fn stop_serving_native(&self) -> Result<(), String> {
        let mut owned = self.serving.lock();
        let serving = owned.take();
        serving.map_or(Ok(()), Serving::stop)
    }
}

impl Serving {
    /// Bind one listener and retain exclusive ownership of its native HTTP runtime.
    fn start(producer: Arc<SnapshotProducer>, listen: SocketAddr) -> std::io::Result<Self> {
        let runtime = Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("rvx-snapshots")
            .enable_all()
            .build()?;
        let listener = runtime.block_on(tokio::net::TcpListener::bind(listen))?;
        let address = listener.local_addr()?;
        let application = producer.router();
        let (shutdown, receiver) = oneshot::channel();
        let task = runtime.spawn(async move {
            axum::serve(listener, application)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
        });
        Ok(Self {
            runtime,
            shutdown,
            task,
            address,
            requested_listen: listen,
        })
    }

    /// Await graceful shutdown, then cancel a stuck owned task and release its runtime.
    fn stop(self) -> Result<(), String> {
        let Serving {
            runtime,
            shutdown,
            mut task,
            ..
        } = self;
        let _ = shutdown.send(());
        let result = runtime.block_on(async {
            match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
                Ok(joined) => joined
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string()),
                Err(_) => {
                    task.abort();
                    match task.await {
                        Err(error) if error.is_cancelled() => {}
                        Err(error) => return Err(error.to_string()),
                        Ok(Err(error)) => return Err(error.to_string()),
                        Ok(Ok(())) => {}
                    }
                    Err("snapshot HTTP shutdown exceeded 2 seconds; task was cancelled".into())
                }
            }
        });
        runtime.shutdown_timeout(Duration::from_secs(2));
        result
    }
}

impl Drop for RvxSource {
    /// Release abandoned instances without leaking their listener or native thread.
    fn drop(&mut self) {
        if std::process::id() != self.owner_pid {
            // A forked child cannot join the parent's vanished runtime threads.
            if let Some(serving) = self.serving.get_mut().take() {
                std::mem::forget(serving);
            }
            return;
        }
        if let Err(error) = self.close_native() {
            eprintln!("Rvx source shutdown failed: {error}");
        }
    }
}

/// Fail explicitly on operations against a terminally closed source.
fn ensure_open(lifecycle: &Lifecycle) -> PyResult<()> {
    if lifecycle.closed {
        return Err(PyRuntimeError::new_err("source is closed"));
    }
    Ok(())
}

/// Surface premature HTTP termination only to standalone HTTP operations.
fn ensure_serving(serving: &Serving) -> PyResult<()> {
    if serving.task.is_finished() {
        return Err(PyRuntimeError::new_err(
            "snapshot HTTP server stopped unexpectedly",
        ));
    }
    Ok(())
}

/// Normalize invalid native history cursors to Python value errors.
fn history_cursor(value: &PyAny) -> PyResult<u64> {
    value.extract().map_err(input_error)
}

/// Normalize invalid native history limits to Python value errors.
fn history_limit(value: &PyAny) -> PyResult<usize> {
    value.extract().map_err(input_error)
}

/// Preserve validation failures as Python input errors.
fn input_error(error: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(error.to_string())
}

/// Distinguish invalid observations from a sealed or exhausted producer lifecycle.
fn capture_error(error: ProducerError) -> PyErr {
    match error {
        ProducerError::InvalidInput(_) => input_error(error),
        _ => operation_error(error),
    }
}

/// Preserve lifecycle and transport failures as Python runtime errors.
fn operation_error(error: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source() -> RvxSource {
        let session_id = new_id("session");
        let owner_pid = std::process::id();
        let producer = SnapshotProducer::new(
            SnapshotDescriptor {
                protocol_version: PROTOCOL_VERSION,
                source_session_id: session_id.clone(),
                project: "project".into(),
                experiment: "experiment".into(),
                run_id: "run".into(),
                attempt_id: "attempt".into(),
                role: "worker".into(),
                rank: None,
                node_id: None,
                pid: Some(owner_pid),
                labels: BTreeMap::new(),
                schema_version: 1,
            },
            BufferLimits::default(),
        )
        .unwrap();
        RvxSource {
            producer,
            lifecycle: Mutex::default(),
            serving: Mutex::new(None),
            session_id,
            owner_pid,
        }
    }

    fn capture(source: &RvxSource) {
        source
            .producer
            .capture(SnapshotEvent {
                state: json!({"ready": true}),
                observed_at_ns: Some(42),
                axes: BTreeMap::new(),
            })
            .unwrap();
    }

    #[test]
    fn stop_preserves_capture_and_history_across_rebinding() {
        let source = source();
        let initial =
            Serving::start(source.producer.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
        let address = initial.address;
        *source.serving.lock() = Some(initial);
        capture(&source);
        let descriptor = source.producer.descriptor_bytes().unwrap();
        let latest = source.producer.latest_bytes().unwrap();
        source.stop_serving_native().unwrap();
        source.stop_serving_native().unwrap();
        assert!(!source.lifecycle.lock().closed);
        assert!(!source.producer.stats().sealed);
        assert_eq!(source.producer.stats().buffered_snapshots, 1);
        assert!(source.producer.stats().buffered_bytes > 0);
        assert_eq!(source.producer.latest_bytes().unwrap(), latest);
        capture(&source);
        let rebound = Serving::start(source.producer.clone(), address).unwrap();
        assert_eq!(rebound.address, address);
        *source.serving.lock() = Some(rebound);
        assert_eq!(source.producer.descriptor_bytes().unwrap(), descriptor);
        assert_eq!(source.producer.stats().next_sequence, 2);
        source.close_native().unwrap();
        let _released = std::net::TcpListener::bind(address).unwrap();
    }

    #[test]
    fn close_is_terminal_idempotent_and_releases_retained_history() {
        let source = source();
        capture(&source);
        let retained = source.producer.latest().unwrap();
        let descriptor = source.producer.descriptor_bytes().unwrap();
        source.close_native().unwrap();
        source.close_native().unwrap();
        source.stop_serving_native().unwrap();
        assert!(source.lifecycle.lock().closed);
        let stats = source.producer.stats();
        assert!(stats.sealed);
        assert_eq!(stats.next_sequence, 1);
        assert_eq!(stats.oldest_sequence, 1);
        assert_eq!(stats.buffered_snapshots, 0);
        assert_eq!(stats.buffered_bytes, 0);
        assert_eq!(source.producer.descriptor_bytes().unwrap(), descriptor);
        assert_eq!(retained.state, json!({"ready": true}));
        assert_eq!(Arc::strong_count(&retained), 1);
        assert!(matches!(
            source.producer.capture_batch(vec![]),
            Err(ProducerError::Sealed)
        ));
    }

    #[test]
    fn failed_http_shutdown_does_not_seal_the_source() {
        let source = source();
        let serving =
            Serving::start(source.producer.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
        serving.task.abort();
        *source.serving.lock() = Some(serving);
        assert!(source.stop_serving_native().is_err());
        assert!(!source.lifecycle.lock().closed);
        assert!(!source.producer.stats().sealed);
        capture(&source);
        assert!(source.producer.latest_bytes().is_ok());
        assert!(source.producer.history_bytes(0, 64).is_ok());
        let rebound =
            Serving::start(source.producer.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
        *source.serving.lock() = Some(rebound);
        source.close_native().unwrap();
    }

    #[test]
    fn failed_bind_and_drop_release_only_owned_resources() {
        let source = source();
        let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(Serving::start(source.producer.clone(), foreign.local_addr().unwrap()).is_err());
        capture(&source);
        let serving =
            Serving::start(source.producer.clone(), "127.0.0.1:0".parse().unwrap()).unwrap();
        let address = serving.address;
        *source.serving.lock() = Some(serving);
        drop(source);
        let _released = std::net::TcpListener::bind(address).unwrap();
        assert!(std::net::TcpStream::connect(foreign.local_addr().unwrap()).is_ok());
    }
}
