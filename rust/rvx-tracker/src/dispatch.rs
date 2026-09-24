use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{AlertEvent, AlertLevel, TrackerError};

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
}

impl Default for DeliveryConfig {
    fn default() -> Self {
        Self {
            channels: Vec::new(),
            rate_limit_per_minute: 20,
            dedup_window_seconds: 300,
            max_retries: 3,
            queue_capacity: 1_024,
            timeout_seconds: 10,
        }
    }
}

impl DeliveryConfig {
    pub fn validate(&self) -> Result<(), TrackerError> {
        if !(1..=1_000_000).contains(&self.queue_capacity)
            || self.timeout_seconds == 0
            || self.timeout_seconds > 300
        {
            return Err(TrackerError::InvalidInput(
                "invalid alert delivery queue or timeout limits".into(),
            ));
        }
        for channel in &self.channels {
            if !channel.enabled {
                continue;
            }
            if channel.name.trim().is_empty() || channel.name.len() > 256 {
                return Err(TrackerError::InvalidInput(
                    "alert channel names must contain 1..=256 bytes".into(),
                ));
            }
            let url = resolve_url(channel)?;
            let parsed = reqwest::Url::parse(&url).map_err(|_| {
                TrackerError::InvalidInput(format!(
                    "alert channel {:?} has an invalid URL",
                    channel.name
                ))
            })?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.has_host()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(TrackerError::InvalidInput(format!(
                    "alert channel {:?} requires a credential-free HTTP(S) URL",
                    channel.name
                )));
            }
        }
        Ok(())
    }
}

enum Command {
    Event(AlertEvent),
    Flush(mpsc::Sender<()>),
    Close,
}

pub trait AlertSink: Send + Sync {
    fn send(&self, event: AlertEvent);
    fn flush(&self, timeout: Duration) -> bool;
    fn close(&self);
}

pub struct Dispatcher {
    sender: SyncSender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Dispatcher {
    pub fn new(config: DeliveryConfig) -> Result<Option<Self>, TrackerError> {
        config.validate()?;
        if config.channels.is_empty() {
            return Ok(None);
        }
        let (sender, receiver) = mpsc::sync_channel(config.queue_capacity);
        let thread = std::thread::Builder::new()
            .name("rvx-alert-dispatch".into())
            .spawn(move || worker(config, receiver))
            .map_err(TrackerError::Io)?;
        Ok(Some(Self {
            sender,
            thread: Mutex::new(Some(thread)),
        }))
    }

    fn enqueue(&self, event: AlertEvent) {
        if self.sender.try_send(Command::Event(event)).is_err() {
            eprintln!("RVX alert delivery queue is full or closed; dropping alert");
        }
    }

    fn flush_queue(&self, timeout: Duration) -> bool {
        let (sender, receiver) = mpsc::channel();
        if self.sender.send(Command::Flush(sender)).is_err() {
            return false;
        }
        receiver.recv_timeout(timeout).is_ok()
    }

    fn close_worker(&self) {
        let _ = self.sender.send(Command::Close);
        if let Some(thread) = self.thread.lock().take() {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl AlertSink for Dispatcher {
    fn send(&self, event: AlertEvent) {
        self.enqueue(event);
    }

    fn flush(&self, timeout: Duration) -> bool {
        self.flush_queue(timeout)
    }

    fn close(&self) {
        self.close_worker();
    }
}

impl Drop for Dispatcher {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::Close);
        if let Some(thread) = self.thread.get_mut().take() {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

struct ChannelRuntime {
    config: ChannelConfig,
    url: String,
    tokens: f64,
    last_refill: Instant,
    dedup: HashMap<String, (Instant, u64)>,
}

fn worker(config: DeliveryConfig, receiver: Receiver<Command>) {
    let client = match Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("RVX alert dispatcher could not build HTTP client: {error}");
            return;
        }
    };
    let mut channels: Vec<_> = config
        .channels
        .clone()
        .into_iter()
        .filter(|channel| channel.enabled)
        .filter_map(|channel| match resolve_url(&channel) {
            Ok(url) => Some(ChannelRuntime {
                config: channel,
                url,
                tokens: config.rate_limit_per_minute as f64,
                last_refill: Instant::now(),
                dedup: HashMap::new(),
            }),
            Err(error) => {
                eprintln!("RVX alert channel disabled: {error}");
                None
            }
        })
        .collect();
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Event(event) => {
                for channel in &mut channels {
                    if accepts(&channel.config, &event) && admit(channel, &event, &config) {
                        deliver(&client, channel, &event, config.max_retries);
                    }
                }
            }
            Command::Flush(done) => {
                let _ = done.send(());
            }
            Command::Close => return,
        }
    }
}

fn resolve_url(channel: &ChannelConfig) -> Result<String, TrackerError> {
    if let Some(url) = &channel.url {
        return Ok(url.clone());
    }
    if let Some(variable) = &channel.url_env {
        return std::env::var(variable).map_err(|_| {
            TrackerError::InvalidInput(format!(
                "alert channel {:?} requires environment variable {variable}",
                channel.name
            ))
        });
    }
    Err(TrackerError::InvalidInput(format!(
        "alert channel {:?} requires url or url_env",
        channel.name
    )))
}

fn accepts(channel: &ChannelConfig, event: &AlertEvent) -> bool {
    if !event.channels.is_empty() && !event.channels.iter().any(|name| name == &channel.name) {
        return false;
    }
    if !channel.levels.is_empty() && !channel.levels.contains(&event.level) {
        return false;
    }
    if channel.levels.is_empty() && event.level.rank() < channel.min_level.rank() {
        return false;
    }
    channel.tags.is_empty()
        || event
            .tags
            .iter()
            .any(|tag| channel.tags.iter().any(|value| value == tag))
}

fn admit(channel: &mut ChannelRuntime, event: &AlertEvent, config: &DeliveryConfig) -> bool {
    let now = Instant::now();
    let rate = config.rate_limit_per_minute;
    if rate > 0 {
        let elapsed = now.duration_since(channel.last_refill).as_secs_f64();
        channel.tokens = (channel.tokens + elapsed * rate as f64 / 60.0).min(rate as f64);
        channel.last_refill = now;
        if channel.tokens < 1.0 {
            return false;
        }
        channel.tokens -= 1.0;
    }
    let window = Duration::from_secs(config.dedup_window_seconds);
    channel
        .dedup
        .retain(|_, (seen, _)| now.duration_since(*seen) <= window);
    let key = format!("{:?}\0{}\0{}", event.level, event.rule, event.message);
    if let Some((seen, suppressed)) = channel.dedup.get_mut(&key) {
        if now.duration_since(*seen) <= window {
            *suppressed = suppressed.saturating_add(1);
            return false;
        }
    }
    channel.dedup.insert(key, (now, 0));
    true
}

fn deliver(client: &Client, channel: &ChannelRuntime, event: &AlertEvent, retries: u32) {
    let payload = payload(&channel.config.kind, event);
    for attempt in 0..=retries {
        let mut request = client.post(&channel.url).json(&payload);
        for (name, value) in &channel.config.headers {
            request = request.header(name, value);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => return,
            Ok(response) => {
                if attempt == retries {
                    eprintln!(
                        "RVX alert channel {:?} returned HTTP {}",
                        channel.config.name,
                        response.status()
                    );
                    return;
                }
            }
            Err(error) => {
                if attempt == retries {
                    eprintln!(
                        "RVX alert channel {:?} failed: {error}",
                        channel.config.name
                    );
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(
            100u64.saturating_mul(1u64 << attempt.min(6)),
        ));
    }
}

fn payload(kind: &ChannelKind, event: &AlertEvent) -> Value {
    let text = format!(
        "[{:?}] {}: {} (step {})",
        event.level, event.rule, event.message, event.step
    );
    match kind {
        ChannelKind::Webhook => serde_json::to_value(event).unwrap_or(Value::Null),
        ChannelKind::Slack => json!({"text": text}),
        ChannelKind::Lark => json!({"msg_type":"text","content":{"text":text}}),
        ChannelKind::Dingtalk => json!({"msgtype":"text","text":{"content":text}}),
        ChannelKind::Wecom => json!({"msgtype":"text","text":{"content":text}}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_filters_level_and_tags() {
        let channel = ChannelConfig {
            min_level: AlertLevel::Error,
            tags: vec!["gpu".into()],
            ..ChannelConfig::default()
        };
        let mut event = AlertEvent {
            rule: "x".into(),
            level: AlertLevel::Warning,
            message: "x".into(),
            step: 1,
            observed_at_ns: 1,
            recovered: false,
            tags: vec!["gpu".into()],
            channels: vec![],
        };
        assert!(!accepts(&channel, &event));
        event.level = AlertLevel::Error;
        assert!(accepts(&channel, &event));
        event.tags.clear();
        assert!(!accepts(&channel, &event));
    }
}
