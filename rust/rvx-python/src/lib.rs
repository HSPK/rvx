#![allow(non_local_definitions)]

mod source;

use std::sync::Arc;

use parking_lot::Mutex;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use rvx_core::{
    ChartCatalogRequest, RunStatus, SnapshotDiffRequest, SnapshotHistoryRequest,
    SnapshotLatestRequest, SnapshotQueryRequest, SourceRegistration, SourceState,
};
use rvx_engine::Engine;
use tokio::runtime::{Builder, Runtime};
use tokio::sync::watch;

struct RuntimeState {
    runtime: Option<Runtime>,
    shutdown: Option<watch::Sender<bool>>,
    coordinator: Option<tokio::task::JoinHandle<()>>,
}

#[pyclass(module = "rvx._native")]
struct RvxEngine {
    engine: Arc<Engine>,
    lifecycle: Mutex<RuntimeState>,
    scrape_concurrency: usize,
}

#[pymethods]
impl RvxEngine {
    #[new]
    #[pyo3(signature = (
        data_directory,
        scrape_concurrency=256,
        auto_start=true
    ))]
    fn new(data_directory: String, scrape_concurrency: usize, auto_start: bool) -> PyResult<Self> {
        let runtime = Builder::new_multi_thread()
            .enable_all()
            .thread_name("rvx-engine")
            .build()
            .map_err(runtime_error)?;
        if scrape_concurrency == 0 {
            return Err(runtime_error("scrape_concurrency must be positive"));
        }
        let engine = Engine::open(data_directory).map_err(runtime_error)?;
        let instance = Self {
            engine,
            lifecycle: Mutex::new(RuntimeState {
                runtime: Some(runtime),
                shutdown: None,
                coordinator: None,
            }),
            scrape_concurrency,
        };
        if auto_start {
            instance.start()?;
        }
        Ok(instance)
    }

    fn start(&self) -> PyResult<()> {
        let mut lifecycle = self.lifecycle.lock();
        if lifecycle.shutdown.is_some() {
            return Ok(());
        }
        let runtime = lifecycle
            .runtime
            .as_ref()
            .ok_or_else(|| PyRuntimeError::new_err("Rvx engine is closed"))?;
        let (shutdown, receiver) = watch::channel(false);
        let coordinator = runtime.spawn(
            self.engine
                .clone()
                .run_scraper(self.scrape_concurrency, receiver),
        );
        lifecycle.shutdown = Some(shutdown);
        lifecycle.coordinator = Some(coordinator);
        Ok(())
    }

    fn create_project(&self, py: Python<'_>, name: String) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.create_project(&name)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn list_projects(&self, py: Python<'_>) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.list_projects()?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn create_experiment(
        &self,
        py: Python<'_>,
        project_id: String,
        name: String,
    ) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.create_experiment(&project_id, &name)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    #[pyo3(signature = (project_id=None))]
    fn list_experiments(&self, py: Python<'_>, project_id: Option<String>) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.list_experiments(project_id.as_deref())?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    #[pyo3(signature = (experiment_id, name, config_json="{}".to_string()))]
    fn create_run(
        &self,
        py: Python<'_>,
        experiment_id: String,
        name: String,
        config_json: String,
    ) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(
                &self
                    .engine
                    .create_run(&experiment_id, &name, &config_json)?,
            )
            .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    #[pyo3(signature = (experiment_id=None))]
    fn list_runs(&self, py: Python<'_>, experiment_id: Option<String>) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.list_runs(experiment_id.as_deref())?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn update_run_status(
        &self,
        py: Python<'_>,
        run_id: String,
        status: String,
    ) -> PyResult<String> {
        py.allow_threads(|| {
            let status: RunStatus = serde_json::from_value(serde_json::Value::String(status))?;
            serde_json::to_string(&self.engine.update_run_status(&run_id, &status)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    #[pyo3(signature = (
        run_id,
        attempt_id,
        role,
        endpoint,
        node_id=None,
        rank=None,
        scrape_interval_ms=1_000,
        timeout_ms=5_000
    ))]
    #[allow(clippy::too_many_arguments)]
    fn register_source(
        &self,
        py: Python<'_>,
        run_id: String,
        attempt_id: String,
        role: String,
        endpoint: String,
        node_id: Option<String>,
        rank: Option<i64>,
        scrape_interval_ms: u64,
        timeout_ms: u64,
    ) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.register_source(&SourceRegistration {
                run_id,
                attempt_id,
                role,
                endpoint,
                node_id,
                rank,
                scrape_interval_ms,
                timeout_ms,
            })?)
            .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    #[pyo3(signature = (run_id=None))]
    fn list_sources(&self, py: Python<'_>, run_id: Option<String>) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.list_sources(run_id.as_deref())?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn update_source_state(
        &self,
        py: Python<'_>,
        source_id: String,
        state: String,
    ) -> PyResult<String> {
        py.allow_threads(|| {
            let state: SourceState = serde_json::from_value(serde_json::Value::String(state))?;
            serde_json::to_string(&self.engine.update_source_state(&source_id, &state)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Read latest full states using the shared bounded request/response contract.
    fn snapshot_latest(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        py.allow_threads(|| {
            let request: SnapshotLatestRequest = serde_json::from_str(&payload)?;
            serde_json::to_string(&self.engine.snapshot_latest(&request)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Read immutable stored history using newest-first storage IDs.
    fn snapshot_history(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        py.allow_threads(|| {
            let request: SnapshotHistoryRequest = serde_json::from_str(&payload)?;
            serde_json::to_string(&self.engine.snapshot_history(&request)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Project numeric JSON-pointer fields on read without a metric ingestion channel.
    fn snapshot_query(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        py.allow_threads(|| {
            let request: SnapshotQueryRequest = serde_json::from_str(&payload)?;
            serde_json::to_string(&self.engine.snapshot_query(&request)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Compare full states while preserving missing versus explicitly null fields.
    fn snapshot_diff(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        py.allow_threads(|| {
            let request: SnapshotDiffRequest = serde_json::from_str(&payload)?;
            serde_json::to_string(&self.engine.snapshot_diff(&request)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Return bounded field discovery and latest Source summaries as JSON without holding Python's GIL.
    fn chart_catalog(&self, py: Python<'_>, payload: String) -> PyResult<String> {
        py.allow_threads(|| {
            let request: ChartCatalogRequest = serde_json::from_str(&payload)?;
            serde_json::to_string(&self.engine.chart_catalog(&request)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    /// Return the original observation as JSON so a projected chart point can be inspected without losing state.
    fn snapshot_get(&self, py: Python<'_>, id: i64) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.snapshot_get(id)?)
                .map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn stats_json(&self, py: Python<'_>) -> PyResult<String> {
        py.allow_threads(|| {
            serde_json::to_string(&self.engine.stats()?).map_err(rvx_engine::EngineError::from)
        })
        .map_err(runtime_error)
    }

    fn close(&self, py: Python<'_>) {
        let (shutdown, runtime, coordinator) = {
            let mut lifecycle = self.lifecycle.lock();
            (
                lifecycle.shutdown.take(),
                lifecycle.runtime.take(),
                lifecycle.coordinator.take(),
            )
        };
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(true);
        }
        if let Some(runtime) = runtime {
            py.allow_threads(|| {
                if let Some(coordinator) = coordinator {
                    let _ = runtime.block_on(coordinator);
                }
                runtime.shutdown_timeout(std::time::Duration::from_secs(2));
            });
        }
    }
}

fn runtime_error(error: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(error.to_string())
}

#[pymodule]
fn _native(_py: Python<'_>, module: &PyModule) -> PyResult<()> {
    module.add_class::<RvxEngine>()?;
    module.add_class::<source::RvxSource>()?;
    Ok(())
}
