use std::io::Read;
use std::time::{Duration, Instant};

use rvx_core::{PersistedCursorRequest, PersistedCursorResponse};

pub(crate) fn wait(
    url: &str,
    request: PersistedCursorRequest,
    timeout_ms: u64,
) -> Result<PersistedCursorResponse, String> {
    if !(1..=300_000).contains(&timeout_ms) {
        return Err("durable timeout must be between 1 and 300000 ms".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.has_host()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("durable server URL must be a credential-free HTTP(S) base URL".into());
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("durable flush timed out before daemon persistence confirmation".into());
        }
        let mut call = client
            .post(format!("{}/api/snapshots/ack", url.trim_end_matches('/')))
            .timeout(remaining)
            .json(&request);
        if let Ok(token) = std::env::var("RVX_API_TOKEN") {
            call = call.bearer_auth(token);
        }
        let response = call
            .send()
            .map_err(|e| format!("durable confirmation request failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "durable confirmation returned HTTP {}",
                response.status()
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 65536 {
            return Err("oversized acknowledgment response".into());
        }
        let result: PersistedCursorResponse =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if result.run_id != request.run_id
            || result.source_id != request.source_id
            || result.source_session_id != request.source_session_id
        {
            return Err("acknowledgment identity mismatch".into());
        }
        if result.has_gaps {
            return Err(
                "source history has eviction gaps; full durability cannot be confirmed".into(),
            );
        }
        if result.complete && result.persisted_next_sequence >= request.next_sequence {
            return Ok(result);
        }
        std::thread::sleep(
            Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}
