use axum::extract::{rejection::JsonRejection, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use rvx_core::{SaveBrowserPreferences, SaveWorkspaces, Theme};
use rvx_engine::EngineError;
use serde::Serialize;
use serde_json::json;

use crate::{ApiError, AppState};

/// Accept one well-formed preference cookie without treating it as authorization.
fn browser_cookie(headers: &HeaderMap) -> Option<&str> {
    let mut result = None;
    for header in headers.get_all(header::COOKIE) {
        for cookie in header.to_str().ok()?.split(';') {
            let Some((name, value)) = cookie.trim().split_once('=') else {
                continue;
            };
            if name == "rvx_browser" {
                if result.is_some() || !rvx_engine::valid_browser_id(value) {
                    return None;
                }
                result = Some(value);
            }
        }
    }
    result
}

/// Keep browser-specific bootstrap documents and mutation results out of caches.
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Preserve typed API errors while disabling caching on every persistence response.
fn response<T: Serialize>(result: Result<T, EngineError>) -> Response {
    no_store(match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError(error).into_response(),
    })
}

/// Report malformed or oversized UI documents before dispatching a database mutation.
fn parse<T>(input: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    input.map(|Json(value)| value).map_err(|error| {
        let status = if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_REQUEST
        };
        no_store((status, Json(json!({"error": error.body_text()}))).into_response())
    })
}

/// Deliver the saved theme in the HTML itself so neither CSS nor API startup can paint a light frame.
pub(crate) async fn index(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let browser_id = browser_cookie(&headers).map(str::to_owned);
    let result = tokio::task::spawn_blocking(move || -> Result<String, EngineError> {
        let theme = state.engine.ui_theme(browser_id.as_deref())?;
        // Read through the deployment symlink on each navigation, not a stale startup-time template.
        let html = std::fs::read_to_string(state.ui_index)?;
        Ok(if theme == Theme::Dark {
            html.replacen("data-theme=\"light\"", "data-theme=\"dark\"", 1)
                .replacen("content=\"#f6f7f9\"", "content=\"#171b23\"", 1)
        } else {
            html
        })
    })
    .await;
    match result {
        Ok(Ok(html)) => no_store(Html(html).into_response()),
        Ok(Err(error)) => response::<()>(Err(error)),
        Err(error) => response::<()>(Err(EngineError::Runtime(error.to_string()))),
    }
}

/// Bootstrap a durable browser identity and read its settings with shared workspace state.
pub(crate) async fn state(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let browser_id = browser_cookie(&headers).map(str::to_owned);
    let result =
        tokio::task::spawn_blocking(move || state.engine.ui_state(browser_id.as_deref())).await;
    match result {
        Ok(Ok(session)) => {
            let mut response = no_store(Json(session.state).into_response());
            if session.initialized {
                let secure = if state.secure_browser_cookie {
                    "; Secure"
                } else {
                    ""
                };
                let cookie = format!(
                    "rvx_browser={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000{secure}",
                    session.browser_id
                );
                response.headers_mut().insert(
                    header::SET_COOKIE,
                    cookie.parse().expect("server-generated cookie"),
                );
            }
            response
        }
        Ok(Err(error)) => response::<()>(Err(error)),
        Err(error) => response::<()>(Err(EngineError::Runtime(error.to_string()))),
    }
}

/// Commit a shared layout revision without blocking the async HTTP executor.
pub(crate) async fn workspaces(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<SaveWorkspaces>, JsonRejection>,
) -> Response {
    let input = match parse(input) {
        Ok(input) => input,
        Err(error) => return error,
    };
    let id = browser_cookie(&headers).unwrap_or_default().to_owned();
    let result =
        tokio::task::spawn_blocking(move || state.engine.save_workspaces(&id, &input)).await;
    response(result.unwrap_or_else(|error| Err(EngineError::Runtime(error.to_string()))))
}

/// Commit settings only for the existing browser identified by its opaque cookie.
pub(crate) async fn browser(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<SaveBrowserPreferences>, JsonRejection>,
) -> Response {
    let input = match parse(input) {
        Ok(input) => input,
        Err(error) => return error,
    };
    let id = browser_cookie(&headers).unwrap_or_default().to_owned();
    let result =
        tokio::task::spawn_blocking(move || state.engine.save_browser_preferences(&id, &input))
            .await;
    response(result.unwrap_or_else(|error| Err(EngineError::Runtime(error.to_string()))))
}
