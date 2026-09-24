use serde::{Deserialize, Serialize};

use crate::TrackerError;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlertLevel {
    Info,
    #[default]
    Warning,
    Error,
    Critical,
}

impl AlertLevel {
    pub fn rank(&self) -> u8 {
        match self {
            Self::Info => 0,
            Self::Warning => 1,
            Self::Error => 2,
            Self::Critical => 3,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlertMode {
    #[default]
    Edge,
    Level,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AlertRule {
    pub name: String,
    pub condition: String,
    #[serde(default)]
    pub level: AlertLevel,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub mode: AlertMode,
    #[serde(default = "one")]
    pub for_steps: u64,
    #[serde(default)]
    pub cooldown_seconds: u64,
    #[serde(default)]
    pub max_fires: Option<u64>,
    #[serde(default)]
    pub notify_recovery: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

impl AlertRule {
    pub fn parse(value: &str, index: usize) -> Result<Self, TrackerError> {
        let (condition, action) = value
            .split_once("=>")
            .map(|(condition, action)| (condition.trim(), action.trim()))
            .unwrap_or((value.trim(), ""));
        if condition.is_empty() {
            return Err(TrackerError::InvalidInput(
                "alert condition must not be empty".into(),
            ));
        }
        let (level, message) = parse_action(action);
        Ok(Self {
            name: format!("rule-{}", index + 1),
            condition: condition.to_string(),
            level,
            message,
            mode: AlertMode::Edge,
            for_steps: 1,
            cooldown_seconds: 0,
            max_fires: None,
            notify_recovery: false,
            tags: Vec::new(),
            channels: Vec::new(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct AlertEvent {
    pub rule: String,
    pub level: AlertLevel,
    pub message: String,
    pub step: i64,
    pub observed_at_ns: i64,
    pub recovered: bool,
    pub tags: Vec<String>,
    pub channels: Vec<String>,
}

fn one() -> u64 {
    1
}

fn parse_action(value: &str) -> (AlertLevel, String) {
    let (head, message) = value
        .split_once(':')
        .map(|(head, message)| (head.trim(), message.trim()))
        .unwrap_or((value.trim(), ""));
    let level = match head.to_ascii_lowercase().as_str() {
        "info" => AlertLevel::Info,
        "warn" | "warning" => AlertLevel::Warning,
        "error" => AlertLevel::Error,
        "critical" => AlertLevel::Critical,
        _ => AlertLevel::Warning,
    };
    let message = if message.is_empty() && !head.is_empty() && !is_level(head) {
        head.to_string()
    } else {
        message.to_string()
    };
    (level, message)
}

fn is_level(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "info" | "warn" | "warning" | "error" | "critical"
    )
}
