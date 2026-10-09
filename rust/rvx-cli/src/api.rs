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
        self.request(Method::GET, path, None, None).await
    }

    pub async fn post(&self, path: &str, payload: Value) -> Result<Value> {
        self.request(Method::POST, path, Some(payload), None).await
    }

    pub async fn patch(&self, path: &str, payload: Value) -> Result<Value> {
        self.request(Method::PATCH, path, Some(payload), None).await
    }

    pub async fn post_bounded(
        &self,
        path: &str,
        payload: Value,
        max_bytes: usize,
    ) -> Result<Value> {
        self.request(Method::POST, path, Some(payload), Some(max_bytes))
            .await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        payload: Option<Value>,
        max_bytes: Option<usize>,
    ) -> Result<Value> {
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
        let mut response = request.send().await.context("send RVX API request")?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = if let Some(limit) = max_bytes {
            if response
                .content_length()
                .is_some_and(|length| length > limit as u64)
            {
                bail!("RVX API response exceeds {limit} bytes");
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.context("read RVX API response")? {
                if chunk.len() > limit.saturating_sub(bytes.len()) {
                    bail!("RVX API response exceeds {limit} bytes");
                }
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8(bytes).context("RVX API returned non-UTF-8 JSON")?
        } else {
            response.text().await.context("read RVX API response")?
        };
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
        let boundary = detail
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= 400)
            .last()
            .unwrap_or(0);
        detail.truncate(boundary);
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
