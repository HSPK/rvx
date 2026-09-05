use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::extract::{OriginalUri, Query, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use reqwest::{Client, Url};
use serde_json::json;

use crate::AppState;

pub const HOSTMON_ROUTES: [&str; 5] = [
    "/api/status",
    "/api/catalog",
    "/api/collectors",
    "/api/rules",
    "/api/plugins/cluster_gpu_usage",
];

/// Legacy bookmarks retain their path and exact query, always on this origin.
pub async fn legacy_ui_redirect(OriginalUri(uri): OriginalUri) -> Redirect {
    let path = uri.path().strip_prefix("/ryx").unwrap_or("");
    let query = uri.query().map(|query| format!("?{query}")).unwrap_or_default();
    Redirect::permanent(&format!("/rvx{path}{query}"))
}

#[derive(Clone)]
pub struct Hostmon {
    pub url: Url,
    client: Client,
}

impl Hostmon {
    pub fn new(base_url: &str) -> Result<Self> {
        let url = Url::parse(base_url).context("parse --hostmon-url")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!(
                "--hostmon-url must be an HTTP(S) base URL without credentials, query or fragment"
            );
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Self { url, client })
    }
}

pub async fn hostmon_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({"url": state.hostmon.url.as_str().trim_end_matches('/')}))
}

pub async fn hostmon_redirect(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Redirect {
    let mut url = state.hostmon.url.clone();
    if let Some(page) = query
        .get("page")
        .filter(|page| matches!(page.as_str(), "settings" | "layouts"))
    {
        url.set_query(Some(&format!("page={page}")));
    }
    Redirect::temporary(url.as_str())
}

pub async fn proxy_hostmon(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    if !HOSTMON_ROUTES.contains(&uri.path()) {
        return not_found().await;
    }
    let mut url = state.hostmon.url.clone();
    url.set_path(&format!(
        "{}{}",
        state.hostmon.url.path().trim_end_matches('/'),
        uri.path()
    ));
    url.set_query(uri.query());
    let result = async {
        let mut upstream = state.hostmon.client.get(url).send().await?;
        let status = upstream.status();
        let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
        let mut body = Vec::new();
        while let Some(chunk) = upstream.chunk().await? {
            if body.len() + chunk.len() > 16 * 1024 * 1024 {
                anyhow::bail!("hostmon response exceeds 16 MiB");
            }
            body.extend_from_slice(&chunk);
        }
        let mut response = (status, body).into_response();
        if let Some(content_type) = content_type {
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, content_type);
        }
        Ok::<_, anyhow::Error>(response)
    }
    .await;
    match result {
        Ok(response) => response,
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "hostmon read API is unavailable"})),
        )
            .into_response(),
    }
}

pub async fn protect_mutations(request: Request, next: Next) -> Response {
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) || same_origin(request.headers())
    {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "mutations require a same-origin loopback request"})),
    )
        .into_response()
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(base) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|host| Url::parse(&format!("http://{host}")).ok())
    else {
        return false;
    };
    let local = base.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !local {
        return false;
    }
    if let Some(site) = headers.get("sec-fetch-site") {
        if site != "same-origin" && site != "none" {
            return false;
        }
    }
    for name in [header::ORIGIN, header::REFERER] {
        if let Some(value) = headers.get(name) {
            let Ok(origin) = value.to_str().unwrap_or("").parse::<Url>() else {
                return false;
            };
            if origin.origin() != base.origin() {
                return false;
            }
        }
    }
    true
}

pub async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response()
}
