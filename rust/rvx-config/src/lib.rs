use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{Map, Value};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RUNS: usize = 256;
const MAX_SOURCES: usize = 256;
const MAX_PANELS: usize = 24;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RvxConfig {
    version: u32,
    #[serde(default)]
    pub daemon: DaemonConfig,
    #[serde(default)]
    pub runs: Vec<RunConfig>,
    pub dashboard: Option<DashboardConfig>,
}

impl RvxConfig {
    pub fn empty() -> Self {
        Self {
            version: 1,
            daemon: DaemonConfig::default(),
            runs: Vec::new(),
            dashboard: None,
        }
    }

    fn validate(&self) -> Result<()> {
        if self.version != 1 {
            bail!("config version must be 1");
        }
        if self.runs.len() > MAX_RUNS {
            bail!("config contains more than {MAX_RUNS} runs");
        }
        self.daemon.validate()?;
        let mut run_ids = HashSet::new();
        for run in &self.runs {
            run.validate()?;
            if !run_ids.insert(&run.id) {
                bail!("duplicate configured Run id {:?}", run.id);
            }
        }
        if let Some(dashboard) = &self.dashboard {
            dashboard.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DaemonConfig {
    pub data_dir: Option<PathBuf>,
    pub listen: Option<String>,
    pub ui_dir: Option<PathBuf>,
    pub scrape_concurrency: Option<usize>,
}

impl DaemonConfig {
    fn validate(&self) -> Result<()> {
        for (field, path) in [
            ("daemon.data_dir", self.data_dir.as_ref()),
            ("daemon.ui_dir", self.ui_dir.as_ref()),
        ] {
            if path.is_some_and(|path| path.as_os_str().is_empty()) {
                bail!("{field} must not be empty");
            }
        }
        if self
            .scrape_concurrency
            .is_some_and(|value| !(1..=1_000_000).contains(&value))
        {
            bail!("daemon.scrape_concurrency must be between 1 and 1000000");
        }
        if let Some(listen) = &self.listen {
            listen
                .parse::<std::net::SocketAddr>()
                .with_context(|| "parse daemon.listen")?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunConfig {
    pub id: String,
    pub project: String,
    pub experiment: String,
    pub name: String,
    #[serde(default = "empty_table")]
    pub config: toml::Value,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
}

impl RunConfig {
    fn validate(&self) -> Result<()> {
        for (field, value) in [
            ("runs.id", self.id.as_str()),
            ("runs.project", self.project.as_str()),
            ("runs.experiment", self.experiment.as_str()),
            ("runs.name", self.name.as_str()),
        ] {
            identifier(field, value)?;
        }
        if !self.config.is_table() {
            bail!("runs.config must be a TOML table");
        }
        toml_json(&self.config, "runs.config")?;
        if self.sources.len() > MAX_SOURCES {
            bail!("Run {:?} contains more than {MAX_SOURCES} sources", self.id);
        }
        let mut endpoints = HashSet::new();
        for source in &self.sources {
            source.validate()?;
            if !endpoints.insert(source.endpoint.trim_end_matches('/')) {
                bail!(
                    "Run {:?} contains duplicate Source endpoint {:?}",
                    self.id,
                    source.endpoint
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceConfig {
    pub endpoint: String,
    pub role: String,
    #[serde(default = "default_attempt")]
    pub attempt_id: String,
    pub node_id: Option<String>,
    pub rank: Option<i64>,
    #[serde(default = "default_scrape_interval")]
    pub scrape_interval_ms: u64,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

impl SourceConfig {
    fn validate(&self) -> Result<()> {
        identifier("runs.sources.role", &self.role)?;
        identifier("runs.sources.attempt_id", &self.attempt_id)?;
        if let Some(node) = &self.node_id {
            identifier("runs.sources.node_id", node)?;
        }
        let endpoint = reqwest::Url::parse(&self.endpoint)
            .with_context(|| "runs.sources.endpoint must be an absolute HTTP(S) URL")?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.has_host()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            bail!("runs.sources.endpoint must be an absolute HTTP(S) base URL");
        }
        if self.scrape_interval_ms < 50 {
            bail!("runs.sources.scrape_interval_ms must be at least 50");
        }
        if self.timeout_ms == 0 || self.timeout_ms >= self.scrape_interval_ms.saturating_mul(10) {
            bail!("runs.sources.timeout_ms must be positive and bounded");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardConfig {
    pub project: String,
    pub experiment: String,
    pub url: Option<String>,
    #[serde(default = "default_refresh")]
    pub refresh_ms: u64,
    #[serde(default = "default_history_points")]
    pub history_points: usize,
    pub panels: Vec<DashboardPanel>,
}

impl DashboardConfig {
    fn validate(&self) -> Result<()> {
        identifier("dashboard.project", &self.project)?;
        identifier("dashboard.experiment", &self.experiment)?;
        if let Some(url) = &self.url {
            let url = reqwest::Url::parse(url)
                .with_context(|| "dashboard.url must be an absolute HTTP(S) URL")?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.has_host()
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                bail!("dashboard.url must be an absolute HTTP(S) base URL");
            }
        }
        if !(250..=60_000).contains(&self.refresh_ms) {
            bail!("dashboard.refresh_ms must be between 250 and 60000");
        }
        if !(2..=10_000).contains(&self.history_points) {
            bail!("dashboard.history_points must be between 2 and 10000");
        }
        if self.panels.is_empty() || self.panels.len() > MAX_PANELS {
            bail!("dashboard.panels must contain 1..={MAX_PANELS} panels");
        }
        for panel in &self.panels {
            panel.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DashboardPanel {
    Metrics {
        title: Option<String>,
        paths: Vec<String>,
        #[serde(default = "default_axis")]
        axis: String,
        #[serde(default)]
        roles: Vec<String>,
    },
    SnapshotFields {
        title: Option<String>,
        paths: Vec<String>,
        #[serde(default)]
        roles: Vec<String>,
    },
    RunMetadata {
        title: Option<String>,
        #[serde(default)]
        config_paths: Vec<String>,
    },
}

impl DashboardPanel {
    fn validate(&self) -> Result<()> {
        let (title, paths, roles) = match self {
            Self::Metrics {
                title,
                paths,
                axis,
                roles,
            } => {
                identifier("dashboard.panels.axis", axis)?;
                (title, paths, roles.as_slice())
            }
            Self::SnapshotFields {
                title,
                paths,
                roles,
            } => (title, paths, roles.as_slice()),
            Self::RunMetadata {
                title,
                config_paths,
            } => (title, config_paths, &[][..]),
        };
        if title
            .as_ref()
            .is_some_and(|title| title.len() > 120 || title.contains('\0'))
        {
            bail!("dashboard panel title must not exceed 120 bytes or contain NUL");
        }
        if paths.len() > 64
            || matches!(self, Self::Metrics { .. } | Self::SnapshotFields { .. })
                && paths.is_empty()
        {
            bail!("dashboard panel paths must contain 1..=64 entries");
        }
        let mut unique = HashSet::new();
        for path in paths {
            json_pointer(path)?;
            if !unique.insert(path) {
                bail!("dashboard panel contains duplicate path {path:?}");
            }
        }
        let mut unique_roles = HashSet::new();
        for role in roles {
            identifier("dashboard.panels.roles", role)?;
            if !unique_roles.insert(role) {
                bail!("dashboard panel contains duplicate role {role:?}");
            }
        }
        Ok(())
    }
}

pub fn load(path: &Path) -> Result<RvxConfig> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("read config metadata {}", path.display()))?;
    if metadata.len() > MAX_CONFIG_BYTES {
        bail!("config exceeds 2 MiB");
    }
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read config {}", path.display()))?;
    let config: RvxConfig =
        toml::from_str(&text).with_context(|| format!("parse config {}", path.display()))?;
    config.validate()?;
    Ok(config)
}

fn identifier(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 4096 || value.contains('\0') {
        bail!("{field} must contain 1..=4096 non-NUL bytes");
    }
    Ok(())
}

fn json_pointer(value: &str) -> Result<()> {
    if value.len() > 4096 || value.contains('\0') || !value.starts_with('/') {
        bail!("dashboard paths must be RFC 6901 pointers starting with '/'");
    }
    for segment in value.split('/').skip(1) {
        let bytes = segment.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'~' {
                if index + 1 >= bytes.len() || !matches!(bytes[index + 1], b'0' | b'1') {
                    bail!("invalid RFC 6901 pointer {value:?}");
                }
                index += 2;
            } else {
                index += 1;
            }
        }
    }
    Ok(())
}

fn empty_table() -> toml::Value {
    toml::Value::Table(toml::map::Map::new())
}

pub fn toml_json(value: &toml::Value, field: &str) -> Result<Value> {
    Ok(match value {
        toml::Value::String(value) => Value::String(value.clone()),
        toml::Value::Integer(value) => Value::Number((*value).into()),
        toml::Value::Float(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .with_context(|| format!("{field} contains a non-finite number"))?,
        toml::Value::Boolean(value) => Value::Bool(*value),
        toml::Value::Datetime(_) => {
            bail!("{field} contains a TOML datetime, which is not a JSON value")
        }
        toml::Value::Array(values) => Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| toml_json(value, &format!("{field}[{index}]")))
                .collect::<Result<Vec<_>>>()?,
        ),
        toml::Value::Table(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), toml_json(value, &format!("{field}.{key}"))?)))
                .collect::<Result<Map<_, _>>>()?,
        ),
    })
}

fn default_attempt() -> String {
    "attempt-1".into()
}

fn default_scrape_interval() -> u64 {
    1_000
}

fn default_timeout() -> u64 {
    5_000
}

fn default_refresh() -> u64 {
    1_000
}

fn default_history_points() -> usize {
    120
}

fn default_axis() -> String {
    "elapsed".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_shared_daemon_and_dashboard_document() {
        let config: RvxConfig = toml::from_str(
            r#"
version = 1

[daemon]
data_dir = ".rvx"
listen = "127.0.0.1:9110"

[[runs]]
id = "trial-1"
project = "async-rl"
experiment = "grpo"
name = "trial-1"
config = { batch_size = 32 }

[[runs.sources]]
endpoint = "http://127.0.0.1:9200"
role = "learner"

[dashboard]
project = "async-rl"
experiment = "grpo"

[[dashboard.panels]]
type = "metrics"
paths = ["/progress/loss"]
axis = "optimizer_step"

[[dashboard.panels]]
type = "snapshot-fields"
paths = ["/phase", "/progress/step"]

[[dashboard.panels]]
type = "run-metadata"
config_paths = ["/batch_size"]
"#,
        )
        .unwrap();
        config.validate().unwrap();
    }

    #[test]
    fn rejects_unknown_panels_and_invalid_source_limits() {
        for document in [
            r#"version=1
               [dashboard]
               project="p"
               experiment="e"
               [[dashboard.panels]]
               type="unknown""#,
            r#"version=1
               [[runs]]
               id="run"
               project="p"
               experiment="e"
               name="run"
               [[runs.sources]]
               endpoint="http://localhost:1"
               role="worker"
               scrape_interval_ms=50
               timeout_ms=500"#,
        ] {
            assert!(toml::from_str::<RvxConfig>(document)
                .map_err(anyhow::Error::from)
                .and_then(|config| config.validate())
                .is_err());
        }
    }
}
