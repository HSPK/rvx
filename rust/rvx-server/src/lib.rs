mod access;
mod auth;
mod connection;
mod delivery;
mod ui;

pub use access::AccessPolicy;
pub use connection::UiConnections;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use rvx_core::{
    ChartCatalogRequest, RunStatus, SnapshotDiffRequest, SnapshotHistoryRequest,
    SnapshotLatestRequest, SnapshotQueryRequest, SourceRegistration, SourceState,
    TableCatalogRequest, TableRowsRequest, TableSummaryRequest,
};
use rvx_engine::{Engine, EngineError, TableReadControl};
use rvx_core::{SnapshotAggregateRequest, SnapshotRecordsRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    auth: auth::AuthState,
    connections: UiConnections,
    secure_browser_cookie: bool,
    ui_index: PathBuf,
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
        if let EngineError::UiConflict { error, current } = self.0 {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": error, "current": current})),
            )
                .into_response();
        }
        let status = match self.0 {
            EngineError::InvalidInput(_)
            | EngineError::Protocol(_)
            | EngineError::UiBootstrap(_) => StatusCode::BAD_REQUEST,
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

pub fn application(engine: Arc<Engine>, ui_directory: PathBuf) -> anyhow::Result<Router> {
    application_with_access(engine, ui_directory, AccessPolicy::local_only())
}

/// Build the same UI/API router with an explicit authentication and origin policy.
pub fn application_with_access(
    engine: Arc<Engine>,
    ui_directory: PathBuf,
    access: AccessPolicy,
) -> anyhow::Result<Router> {
    application_with_access_and_connections(engine, ui_directory, access, UiConnections::new())
}

/// Build the standard router with an explicit WebSocket task owner for coordinated native shutdown.
pub fn application_with_access_and_connections(
    engine: Arc<Engine>,
    ui_directory: PathBuf,
    access: AccessPolicy,
    connections: UiConnections,
) -> anyhow::Result<Router> {
    let secure_browser_cookie = access.secure_browser_cookie();
    let auth = auth::AuthState::new(access, engine.clone())?;
    let ui_index = ui_directory.join("index.html");
    let login = ServeFile::new(ui_directory.join("login/index.html"));
    let router = Router::new()
        .route_service("/login", login.clone())
        .route_service("/login/", login)
        .nest_service(
            "/login/assets",
            ServeDir::new(ui_directory.join("login/assets")),
        )
        .route("/api/auth/session", get(auth::session))
        .route(
            "/api/auth/login",
            post(auth::login).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/ui/state", get(ui::state))
        .route(
            "/api/ui/workspaces",
            put(ui::workspaces).layer(DefaultBodyLimit::max(rvx_core::MAX_UI_REQUEST_BYTES)),
        )
        .route(
            "/api/ui/browser",
            put(ui::browser).layer(DefaultBodyLimit::max(rvx_core::MAX_UI_REQUEST_BYTES)),
        )
        .route("/api/ui/connection", get(connection::upgrade))
        .route("/", get(|| async { Redirect::temporary("/rvx") }))
        .route("/rvx", get(ui::index))
        .route("/rvx/", get(ui::index))
        .route("/rvx/*path", get(ui::index))
        .nest_service("/assets", ServeDir::new(ui_directory.join("assets")))
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
        .route("/api/charts/catalog", post(chart_catalog))
        .route("/api/tables/summary", post(table_summary))
        .route("/api/tables/catalog", post(table_catalog))
        .route("/api/tables/rows", post(table_rows))
        .route("/api/snapshots/:id", get(snapshot_get))
        .route("/api/snapshots/latest", post(snapshot_latest))
        .route("/api/snapshots/history", post(snapshot_history))
        .route("/api/snapshots/query", post(snapshot_query))
        .route("/api/snapshots/diff", post(snapshot_diff))
        .route("/api/snapshots/aggregate", post(snapshot_aggregate))
        .route("/api/snapshots/records", post(snapshot_records));
    Ok(router
        .fallback(delivery::not_found)
        .layer(middleware::from_fn_with_state(auth.clone(), access::protect))
        // Route templates omit credentials that callers might place in URLs, headers, or bodies.
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::extract::Request| {
                let route = request
                    .extensions()
                    .get::<axum::extract::MatchedPath>()
                    .map(|path| path.as_str())
                    .unwrap_or("<unmatched>");
                tracing::debug_span!("request", method = %request.method(), route)
            }),
        )
        .with_state(AppState {
            engine,
            auth,
            connections,
            secure_browser_cookie,
            ui_index,
        }))
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

/// Serve index-derived discovery on a blocking worker rather than the async HTTP executor.
async fn chart_catalog(
    State(state): State<AppState>,
    Json(request): Json<ChartCatalogRequest>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || Ok(serde_json::to_value(state.engine.chart_catalog(&request)?)?)).await
}

/// Resolve storage IDs to flattened raw observations while retaining chart-point provenance.
async fn snapshot_get(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    blocking(move || Ok(serde_json::to_value(state.engine.snapshot_get(id)?)?)).await
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

/// Preserve the shared access middleware and cancel only the abandoned table request.
async fn table_summary(
    State(state): State<AppState>,
    request: Result<Json<TableSummaryRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = request.map_err(table_json_error)?;
    table_blocking(move |control| {
        Ok(serde_json::to_value(
            state.engine.table_summary_controlled(&request, &control)?,
        )?)
    })
    .await
}

async fn table_catalog(
    State(state): State<AppState>,
    request: Result<Json<TableCatalogRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = request.map_err(table_json_error)?;
    table_blocking(move |control| {
        Ok(serde_json::to_value(
            state.engine.table_catalog_controlled(&request, &control)?,
        )?)
    })
    .await
}

async fn table_rows(
    State(state): State<AppState>,
    request: Result<Json<TableRowsRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = request.map_err(table_json_error)?;
    table_blocking(move |control| {
        Ok(serde_json::to_value(
            state.engine.table_rows_controlled(&request, &control)?,
        )?)
    })
    .await
}

async fn snapshot_aggregate(
    State(state): State<AppState>,
    request: Result<Json<SnapshotAggregateRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = request.map_err(table_json_error)?;
    table_blocking(move |control| Ok(serde_json::to_value(
        state.engine.snapshot_aggregate_controlled(&request, &control)?,
    )?)).await
}

async fn snapshot_records(
    State(state): State<AppState>,
    request: Result<Json<SnapshotRecordsRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(request) = request.map_err(table_json_error)?;
    table_blocking(move |control| Ok(serde_json::to_value(
        state.engine.snapshot_records_controlled(&request, &control)?,
    )?)).await
}

struct CancelTableOnDrop(TableReadControl);

fn table_json_error(error: axum::extract::rejection::JsonRejection) -> ApiError {
    ApiError(EngineError::InvalidInput(error.body_text()))
}

impl Drop for CancelTableOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn table_blocking(
    work: impl FnOnce(TableReadControl) -> Result<Value, ApiError> + Send + 'static,
) -> Result<Json<Value>, ApiError> {
    let guard = CancelTableOnDrop(TableReadControl::default());
    let control = guard.0.clone();
    blocking(move || work(control)).await
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
