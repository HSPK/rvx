use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::{Condvar, Mutex};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client,
};
use rvx_tracker::{AlertEvent, AlertLevel, AlertSink, DeliveryStats, TrackerError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Webhook,
    Slack,
    Lark,
    Dingtalk,
    Wecom,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ChannelConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ChannelKind,
    pub url: Option<String>,
    pub url_env: Option<String>,
    pub min_level: AlertLevel,
    pub levels: Vec<AlertLevel>,
    pub tags: Vec<String>,
    pub enabled: bool,
    pub headers: BTreeMap<String, String>,
}
impl Default for ChannelConfig {
    fn default() -> Self {
        Self {
            name: "default".into(),
            kind: ChannelKind::Webhook,
            url: None,
            url_env: None,
            min_level: AlertLevel::Warning,
            levels: Vec::new(),
            tags: Vec::new(),
            enabled: true,
            headers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DeliveryConfig {
    pub channels: Vec<ChannelConfig>,
    pub rate_limit_per_minute: u32,
    pub dedup_window_seconds: u64,
    pub max_retries: u32,
    pub queue_capacity: usize,
    pub timeout_seconds: u64,
    pub max_pending_bytes: usize,
    pub shutdown_timeout_ms: u64,
}
impl Default for DeliveryConfig {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            rate_limit_per_minute: 20,
            dedup_window_seconds: 300,
            max_retries: 3,
            queue_capacity: 1024,
            timeout_seconds: 10,
            max_pending_bytes: 8 * 1024 * 1024,
            shutdown_timeout_ms: 1000,
        }
    }
}

struct Shared {
    stats: Mutex<DeliveryStats>,
    changed: Condvar,
    closed: AtomicBool,
}
impl Shared {
    fn finish(&self, dropped: bool, failed: bool, suppressed: bool) {
        let mut stats = self.stats.lock();
        stats.pending = stats.pending.saturating_sub(1);
        if dropped {
            stats.dropped += 1;
        } else {
            stats.completed += 1;
        }
        stats.failed += u64::from(failed);
        stats.suppressed += u64::from(suppressed);
        self.changed.notify_all();
    }
}

struct Pending {
    event: AlertEvent,
    bytes: usize,
    channel_bytes: Arc<Mutex<usize>>,
    shared: Arc<Shared>,
    finished: bool,
}
impl Pending {
    fn finish(&mut self, failed: bool, suppressed: bool) {
        self.shared.finish(false, failed, suppressed);
        self.finished = true;
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        *self.channel_bytes.lock() -= self.bytes;
        if !self.finished {
            self.shared.finish(true, false, false);
        }
    }
}

struct Channel {
    config: ChannelConfig,
    sender: mpsc::Sender<Pending>,
    bytes: Arc<Mutex<usize>>,
}

pub struct Dispatcher {
    channels: Vec<Channel>,
    shared: Arc<Shared>,
    cancel: watch::Sender<bool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    config: DeliveryConfig,
}

impl Dispatcher {
    pub fn new(config: DeliveryConfig) -> Result<Option<Self>, TrackerError> {
        if config.channels.len() > 32
            || !(1..=100_000).contains(&config.queue_capacity)
            || !(1..=300).contains(&config.timeout_seconds)
            || config.max_retries > 10
            || config.max_pending_bytes == 0
            || config.max_pending_bytes > 64 * 1024 * 1024
            || config.dedup_window_seconds > 86_400
            || !(1..=60_000).contains(&config.shutdown_timeout_ms)
        {
            return Err(invalid("invalid HTTP alert resource limits"));
        }
        let mut names = HashSet::new();
        let mut resolved = Vec::new();
        for channel in &config.channels {
            if !channel.enabled {
                continue;
            }
            if channel.name.trim().is_empty() || !names.insert(channel.name.clone()) {
                return Err(invalid("alert channel names must be nonempty and unique"));
            }
            let url = match (&channel.url, &channel.url_env) {
                (Some(url), None) => url.clone(),
                (None, Some(key)) => std::env::var(key)
                    .map_err(|_| invalid("missing alert URL environment variable"))?,
                _ => return Err(invalid("channel requires exactly one of url or url_env")),
            };
            let url = reqwest::Url::parse(&url).map_err(|_| invalid("invalid alert URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.has_host()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid("alert URL requires credential-free HTTP(S)"));
            }
            let mut headers = HeaderMap::new();
            for (name, value) in &channel.headers {
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| invalid("invalid alert header name"))?,
                    HeaderValue::from_str(value)
                        .map_err(|_| invalid("invalid alert header value"))?,
                );
            }
            resolved.push((channel.clone(), url, headers));
        }
        if resolved.is_empty() {
            return Ok(None);
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| invalid(&e.to_string()))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let shared = Arc::new(Shared {
            stats: Mutex::new(DeliveryStats::default()),
            changed: Condvar::new(),
            closed: AtomicBool::new(false),
        });
        let (cancel, receiver) = watch::channel(false);
        let mut channels = Vec::new();
        let mut tasks = Vec::new();
        for (channel, url, headers) in resolved {
            let (sender, queue) = mpsc::channel(config.queue_capacity);
            let bytes = Arc::new(Mutex::new(0));
            channels.push(Channel {
                config: channel.clone(),
                sender,
                bytes,
            });
            tasks.push((channel, url, headers, queue));
        }
        let worker_config = config.clone();
        let thread = std::thread::Builder::new()
            .name("rvx-alert-http".into())
            .spawn(move || {
                runtime.block_on(async move {
                    let mut workers = tokio::task::JoinSet::new();
                    for (channel, url, headers, queue) in tasks {
                        workers.spawn(worker(
                            client.clone(),
                            channel,
                            url,
                            headers,
                            queue,
                            receiver.clone(),
                            worker_config.clone(),
                        ));
                    }
                    while let Some(result) = workers.join_next().await {
                        if let Err(error) = result {
                            eprintln!("RVX alert channel worker failed: {error}");
                        }
                    }
                });
            })?;
        Ok(Some(Self {
            channels,
            shared,
            cancel,
            thread: Mutex::new(Some(thread)),
            config,
        }))
    }
}

impl AlertSink for Dispatcher {
    fn send(&self, event: AlertEvent) {
        let size = match serde_json::to_vec(&event) {
            Ok(bytes) => bytes.len(),
            Err(error) => {
                eprintln!("RVX alert serialization failed: {error}");
                return;
            }
        };
        for channel in &self.channels {
            if !accepts(&channel.config, &event) {
                continue;
            }
            let mut stats = self.shared.stats.lock();
            stats.accepted += 1;
            let mut bytes = channel.bytes.lock();
            if self.shared.closed.load(Ordering::Acquire)
                || size > self.config.max_pending_bytes.saturating_sub(*bytes)
            {
                stats.dropped += 1;
                eprintln!(
                    "RVX alert channel {} closed or over byte budget",
                    channel.config.name
                );
                continue;
            }
            stats.pending += 1;
            *bytes += size;
            drop(bytes);
            drop(stats);
            let pending = Pending {
                event: event.clone(),
                bytes: size,
                channel_bytes: channel.bytes.clone(),
                shared: self.shared.clone(),
                finished: false,
            };
            if channel.sender.try_send(pending).is_err() {
                eprintln!(
                    "RVX alert channel {} queue full or closed",
                    channel.config.name
                );
            }
        }
    }
    fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut stats = self.shared.stats.lock();
        while stats.pending > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            self.shared.changed.wait_for(&mut stats, remaining);
        }
        stats.failed == 0 && stats.dropped == 0
    }
    fn close(&self) {
        self.shared.closed.store(true, Ordering::Release);
        let _ = self.cancel.send(true);
        let deadline = Instant::now() + Duration::from_millis(self.config.shutdown_timeout_ms);
        if let Some(thread) = self.thread.lock().take() {
            while !thread.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if thread.is_finished() {
                if thread.join().is_err() {
                    eprintln!("RVX HTTP dispatcher panicked");
                }
            } else {
                eprintln!("RVX HTTP dispatcher exceeded cancellation deadline");
            }
        }
    }
    fn stats(&self) -> DeliveryStats {
        self.shared.stats.lock().clone()
    }
}
impl Drop for Dispatcher {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        let _ = self.cancel.send(true);
    }
}

#[allow(clippy::too_many_arguments)]
async fn worker(
    client: Client,
    channel: ChannelConfig,
    url: reqwest::Url,
    headers: HeaderMap,
    mut queue: mpsc::Receiver<Pending>,
    mut cancel: watch::Receiver<bool>,
    config: DeliveryConfig,
) {
    let mut dedup = HashMap::<String, Instant>::new();
    let mut tokens = config.rate_limit_per_minute as f64;
    let mut last_refill = Instant::now();
    loop {
        if *cancel.borrow() {
            break;
        }
        let mut pending = tokio::select! {
            biased;
            _ = cancel.changed() => break,
            message = queue.recv() => match message { Some(message) => message, None => break },
        };
        let now = Instant::now();
        dedup.retain(|_, at| now.duration_since(*at).as_secs() < config.dedup_window_seconds);
        let key = format!(
            "{:?}\0{}\0{}",
            pending.event.level, pending.event.rule, pending.event.message
        );
        if dedup.contains_key(&key) {
            pending.finish(false, true);
            continue;
        }
        if config.rate_limit_per_minute > 0 {
            let rate = config.rate_limit_per_minute as f64;
            tokens =
                (tokens + now.duration_since(last_refill).as_secs_f64() * rate / 60.0).min(rate);
            last_refill = now;
            if tokens < 1.0 {
                let wait = Duration::from_secs_f64((1.0 - tokens) * 60.0 / rate);
                tokio::select! { biased; _=cancel.changed()=>break, _=tokio::time::sleep(wait)=>{} }
                tokens = 0.0;
                last_refill = Instant::now();
            } else {
                tokens -= 1.0;
            }
        }
        let payload = payload(&channel.kind, &pending.event);
        let sent = tokio::select! {
            biased;
            _=cancel.changed()=>break,
            result=deliver(&client,&url,&headers,payload,&config)=>result,
        };
        if sent {
            if config.dedup_window_seconds > 0 {
                if dedup.len() >= config.queue_capacity {
                    dedup.clear();
                }
                dedup.insert(key, Instant::now());
            }
        } else {
            eprintln!("RVX alert delivery failed for channel {}", channel.name);
        }
        pending.finish(!sent, false);
    }
    queue.close();
    while let Some(pending) = queue.recv().await {
        drop(pending);
    }
}

async fn deliver(
    client: &Client,
    url: &reqwest::Url,
    headers: &HeaderMap,
    payload: Value,
    config: &DeliveryConfig,
) -> bool {
    for attempt in 0..=config.max_retries {
        let mut delay = Duration::from_millis(100 * (1u64 << attempt.min(6)));
        match client
            .post(url.clone())
            .headers(headers.clone())
            .json(&payload)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return true,
            Ok(response) => {
                let status = response.status();
                if status.is_client_error() && status.as_u16() != 429 && status.as_u16() != 408 {
                    return false;
                }
                if let Some(header) = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                {
                    delay = header
                        .parse::<u64>()
                        .map(Duration::from_secs)
                        .ok()
                        .or_else(|| {
                            httpdate::parse_http_date(header)
                                .ok()
                                .map(|d| d.duration_since(SystemTime::now()).unwrap_or_default())
                        })
                        .unwrap_or(delay);
                }
            }
            Err(_) => {}
        }
        if attempt == config.max_retries {
            return false;
        }
        tokio::time::sleep(delay.min(Duration::from_secs(300))).await;
    }
    false
}

fn accepts(channel: &ChannelConfig, event: &AlertEvent) -> bool {
    (event.channels.is_empty() || event.channels.contains(&channel.name))
        && (if channel.levels.is_empty() {
            event.level.rank() >= channel.min_level.rank()
        } else {
            channel.levels.contains(&event.level)
        })
        && (channel.tags.is_empty() || event.tags.iter().any(|tag| channel.tags.contains(tag)))
}
fn payload(kind: &ChannelKind, event: &AlertEvent) -> Value {
    let text = format!(
        "[{:?}] {}: {} (step {})",
        event.level, event.rule, event.message, event.step
    );
    match kind {
        ChannelKind::Webhook => json!(event),
        ChannelKind::Slack => json!({"text":text}),
        ChannelKind::Lark => json!({"msg_type":"text","content":{"text":text}}),
        ChannelKind::Dingtalk | ChannelKind::Wecom => {
            json!({"msgtype":"text","text":{"content":text}})
        }
    }
}
fn invalid(message: &str) -> TrackerError {
    TrackerError::InvalidInput(message.into())
}
