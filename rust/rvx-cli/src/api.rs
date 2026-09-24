use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::{Method, StatusCode};
use serde_json::Value;

pub const DEFAULT_URL: &str = "http://127.0.0.1:9110";

pub struct ApiClient {
    base_url: String,
    client: reqwest::Client,
    token: Option<String>,
}

impl ApiClient {
    pub fn new(base_url: &str, timeout: Duration) -> Result<Self> {
        let parsed = reqwest::Url::parse(base_url)
            .with_context(|| format!("invalid RVX API URL {base_url:?}"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.has_host()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            bail!("RVX API URL must be an absolute credential-free HTTP(S) base URL");
        }
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder().timeout(timeout).build()?,
            token: std::env::var("RVX_API_TOKEN").ok(),
        })
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.request(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, payload: Value) -> Result<Value> {
        self.request(Method::POST, path, Some(payload)).await
    }

    pub async fn patch(&self, path: &str, payload: Value) -> Result<Value> {
        self.request(Method::PATCH, path, Some(payload)).await
    }

    async fn request(&self, method: Method, path: &str, payload: Option<Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url))
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(payload) = payload {
            request = request.json(&payload);
        }
        let response = request.send().await.context("send RVX API request")?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.text().await.context("read RVX API response")?;
        if !status.is_success() {
            bail!("{}", http_error(status, &body, content_type.as_deref()));
        }
        serde_json::from_str(&body).context("RVX API returned malformed JSON")
    }
}

fn http_error(status: StatusCode, body: &str, content_type: Option<&str>) -> String {
    if status == StatusCode::UNAUTHORIZED {
        return "sign in or set RVX_API_TOKEN to continue".into();
    }
    let mut detail = body.trim().to_string();
    let media_type = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if detail.len() > 16 * 1024 {
        detail = "the server returned oversized error details".into();
    } else if matches!(media_type, Some("application/json"))
        || media_type.is_some_and(|value| value.ends_with("+json"))
    {
        detail = serde_json::from_str::<Value>(&detail)
            .ok()
            .and_then(|value| match value {
                Value::String(value) => Some(value),
                Value::Object(object) => object
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            })
            .unwrap_or_else(|| "the server returned no readable error details".into());
    } else if detail.starts_with('<') {
        detail.clear();
    }
    if detail.len() > 400 {
        detail.truncate(400);
        detail.push_str("...");
    }
    format!(
        "RVX API returned HTTP {}{}",
        status.as_u16(),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )
}
