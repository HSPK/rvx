mod delivery;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use rvx_core::{
    QueryRequest, RunStatus, SnapshotDiffRequest, SnapshotHistoryRequest, SnapshotLatestRequest,
    SnapshotQueryRequest, SourceRegistration, SourceState, SummaryRequest,
};
use rvx_engine::{Engine, EngineError};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use delivery::{Hostmon, HOSTMON_ROUTES};

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    hostmon: Hostmon,
}

#[derive(Debug)]
struct ApiError(EngineError);

impl From<EngineError> for ApiError {
    fn from(error: EngineError) -> Self {
        Self(error)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self(EngineError::Json(error))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.0 {
            EngineError::InvalidInput(_) | EngineError::Protocol(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({"error": self.0.to_string()}))).into_response()
    }
}

#[derive(Deserialize)]
struct ProjectInput {
    name: String,
}

#[derive(Deserialize)]
struct ExperimentInput {
    project_id: String,
    name: String,
}

#[derive(Deserialize)]
struct RunInput {
    experiment_id: String,
    name: String,
    #[serde(default)]
    config: Value,
}

#[derive(Deserialize)]
struct RunStatusInput {
    status: RunStatus,
}

#[derive(Deserialize)]
struct SourceInput {
    run_id: String,
    attempt_id: String,
    role: String,
    endpoint: String,
    node_id: Option<String>,
    rank: Option<i64>,
    #[serde(default = "default_scrape_interval")]
    scrape_interval_ms: u64,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}

#[derive(Deserialize)]
struct SourceStateInput {
    state: SourceState,
}

#[derive(Deserialize)]
struct ProjectFilter {
    project_id: Option<String>,
}

#[derive(Deserialize)]
struct ExperimentFilter {
    experiment_id: Option<String>,
}

#[derive(Deserialize)]
struct RunFilter {
    run_id: Option<String>,
}

pub fn application(
    engine: Arc<Engine>,
    ui_directory: PathBuf,
    hostmon_url: &str,
) -> anyhow::Result<Router> {
    let hostmon = Hostmon::new(hostmon_url)?;
    let index = ServeFile::new(ui_directory.join("index.html"));
    let mut router = Router::new()
        .route("/", get(|| async { Redirect::temporary("/rvx") }))
        // Legacy UI bookmarks are redirects, not additional SPA roots.
        .route("/ryx", get(delivery::legacy_ui_redirect))
        .route("/ryx/", get(delivery::legacy_ui_redirect))
        .route("/ryx/*path", get(delivery::legacy_ui_redirect))
        .route_service("/rvx", index.clone())
        .route_service("/rvx/", index.clone())
        .route_service("/rvx/*path", index)
        .nest_service("/assets", ServeDir::new(ui_directory.join("assets")))
        .route("/hostmon", get(delivery::hostmon_redirect))
        .route("/api/hostmon", get(delivery::hostmon_info))
        .route("/healthz", get(health))
        .route("/api/experiments/stats", get(stats))
        .route(
            "/api/experiments/projects",
            get(projects).post(create_project),
        )
        .route(
            "/api/experiments/experiments",
            get(experiments).post(create_experiment),
        )
        .route("/api/experiments/runs", get(runs).post(create_run))
        .route("/api/experiments/runs/:run_id", patch(update_run))
        .route(
            "/api/experiments/sources",
            get(sources).post(register_source),
        )
        .route("/api/experiments/sources/:source_id", patch(update_source))
        .route("/api/experiments/query", post(query_metrics))
        .route("/api/experiments/query-summaries", post(query_summaries))
        .route("/api/snapshots/latest", post(snapshot_latest))
        .route("/api/snapshots/history", post(snapshot_history))
        .route("/api/snapshots/query", post(snapshot_query))
        .route("/api/snapshots/diff", post(snapshot_diff));
    for route in HOSTMON_ROUTES {
        router = router.route(route, get(delivery::proxy_hostmon));
    }
    Ok(router
        .fallback(delivery::not_found)
        .layer(middleware::from_fn(delivery::protect_mutations))
        .layer(TraceLayer::new_for_http())
        .with_state(AppState { engine, hostmon }))
}

async fn health() -> &'static str {
    "ok\n"
}

async fn stats(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    blocking(move || Ok(serde_json::to_value(state.engine.stats()?)?)).await
}

async fn projects(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"projects": state.engine.list_projects()?})))
}

async fn create_project(
    State(state): State<AppState>,
    Json(input): Json<ProjectInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(
            state.engine.create_project(&input.name)?,
        )?),
    ))
}

async fn experiments(
    State(state): State<AppState>,
    Query(filter): Query<ProjectFilter>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "experiments": state.engine.list_experiments(filter.project_id.as_deref())?
    })))
}

async fn create_experiment(
    State(state): State<AppState>,
    Json(input): Json<ExperimentInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(
            state
                .engine
                .create_experiment(&input.project_id, &input.name)?,
        )?),
    ))
}

async fn runs(
    State(state): State<AppState>,
    Query(filter): Query<ExperimentFilter>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "runs": state.engine.list_runs(filter.experiment_id.as_deref())?
    })))
}

async fn create_run(
    State(state): State<AppState>,
    Json(input): Json<RunInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(state.engine.create_run(
            &input.experiment_id,
            &input.name,
            &serde_json::to_string(&input.config)?,
        )?)?),
    ))
}

async fn update_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Json(input): Json<RunStatusInput>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(serde_json::to_value(
        state.engine.update_run_status(&run_id, &input.status)?,
    )?))
}

async fn sources(
    State(state): State<AppState>,
    Query(filter): Query<RunFilter>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "sources": state.engine.list_sources(filter.run_id.as_deref())?
    })))
}

async fn register_source(
    State(state): State<AppState>,
    Json(input): Json<SourceInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(state.engine.register_source(
            &SourceRegistration {
                run_id: input.run_id,
                attempt_id: input.attempt_id,
                role: input.role,
                endpoint: input.endpoint,
                node_id: input.node_id,
                rank: input.rank,
                scrape_interval_ms: input.scrape_interval_ms,
                timeout_ms: input.timeout_ms,
            },
        )?)?),
    ))
}

async fn update_source(
    State(state): State<AppState>,
    Path(source_id): Path<String>,
    Json(input): Json<SourceStateInput>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(serde_json::to_value(
        state.engine.update_source_state(&source_id, &input.state)?,
    )?))
}

async fn query_metrics(
    State(state): State<AppState>,
    Json(request): Json<QueryRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || Ok(serde_json::to_value(state.engine.query(&request)?)?)).await
}

async fn query_summaries(
    State(state): State<AppState>,
    Json(request): Json<SummaryRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || {
        Ok(serde_json::to_value(
            state.engine.query_summaries(&request)?,
        )?)
    })
    .await
}

async fn snapshot_latest(
    State(state): State<AppState>,
    Json(request): Json<SnapshotLatestRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || {
        Ok(serde_json::to_value(
            state.engine.snapshot_latest(&request)?,
        )?)
    })
    .await
}

async fn snapshot_history(
    State(state): State<AppState>,
    Json(request): Json<SnapshotHistoryRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || {
        Ok(serde_json::to_value(
            state.engine.snapshot_history(&request)?,
        )?)
    })
    .await
}

async fn snapshot_query(
    State(state): State<AppState>,
    Json(request): Json<SnapshotQueryRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || {
        Ok(serde_json::to_value(
            state.engine.snapshot_query(&request)?,
        )?)
    })
    .await
}

async fn snapshot_diff(
    State(state): State<AppState>,
    Json(request): Json<SnapshotDiffRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || Ok(serde_json::to_value(state.engine.snapshot_diff(&request)?)?)).await
}

async fn blocking(
    work: impl FnOnce() -> Result<Value, ApiError> + Send + 'static,
) -> Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| ApiError(EngineError::Runtime(error.to_string())))?
        .map(Json)
}

fn default_scrape_interval() -> u64 {
    1_000
}

fn default_timeout() -> u64 {
    5_000
}
