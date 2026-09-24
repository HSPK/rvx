use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use url::form_urlencoded;

use crate::api::{ApiClient, DEFAULT_URL};
use rvx_config::{DashboardConfig, DashboardPanel, RvxConfig};

pub(crate) struct DashboardState {
    pub(crate) project: Option<Map<String, Value>>,
    pub(crate) experiment: Option<Map<String, Value>>,
    pub(crate) run: Option<Map<String, Value>>,
    pub(crate) sources: Vec<Map<String, Value>>,
    pub(crate) snapshots: Vec<Map<String, Value>>,
    pub(crate) metrics: HashMap<usize, Value>,
    pub(crate) notice: Option<String>,
    pub(crate) refreshed_at: SystemTime,
}

impl Default for DashboardState {
    fn default() -> Self {
        Self {
            project: None,
            experiment: None,
            run: None,
            sources: Vec::new(),
            snapshots: Vec::new(),
            metrics: HashMap::new(),
            notice: None,
            refreshed_at: SystemTime::now(),
        }
    }
}

impl DashboardState {
    pub(crate) fn waiting(message: impl Into<String>) -> Self {
        Self {
            notice: Some(message.into()),
            refreshed_at: SystemTime::now(),
            ..Self::default()
        }
    }
}

pub(crate) struct DashboardClient<'a> {
    api: ApiClient,
    dashboard: &'a DashboardConfig,
    run_id: Option<String>,
}

impl<'a> DashboardClient<'a> {
    pub(crate) fn new(
        base_url: &str,
        dashboard: &'a DashboardConfig,
        run_id: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            api: ApiClient::new(base_url, Duration::from_secs(5))?,
            dashboard,
            run_id,
        })
    }

    pub(crate) async fn refresh(&self) -> Result<DashboardState> {
        let projects = response_objects(
            self.api.get("/api/experiments/projects").await?,
            "projects",
            "/api/experiments/projects",
        )?;
        let Some(project) = projects
            .into_iter()
            .find(|item| string(item, "name") == Some(self.dashboard.project.as_str()))
        else {
            return Ok(DashboardState::waiting(format!(
                "Waiting for project {:?}.",
                self.dashboard.project
            )));
        };
        let project_id = required_string(&project, "id", "Project")?;
        let experiment_path = query_path("/api/experiments/experiments", "project_id", project_id);
        let experiments = response_objects(
            self.api.get(&experiment_path).await?,
            "experiments",
            &experiment_path,
        )?;
        let Some(experiment) = experiments
            .into_iter()
            .find(|item| string(item, "name") == Some(self.dashboard.experiment.as_str()))
        else {
            return Ok(DashboardState {
                project: Some(project),
                notice: Some(format!(
                    "Waiting for experiment {:?}.",
                    self.dashboard.experiment
                )),
                refreshed_at: SystemTime::now(),
                ..DashboardState::default()
            });
        };
        let experiment_id = required_string(&experiment, "id", "Experiment")?;
        let run_path = query_path("/api/experiments/runs", "experiment_id", experiment_id);
        let runs = response_objects(self.api.get(&run_path).await?, "runs", &run_path)?;
        let selected = if let Some(run_id) = &self.run_id {
            runs.into_iter()
                .find(|item| string(item, "id") == Some(run_id.as_str()))
        } else {
            runs.into_iter()
                .filter(|item| string(item, "status") == Some("running"))
                .max_by_key(|item| {
                    (
                        integer(item, "updated_at_ns").unwrap_or_default(),
                        integer(item, "created_at_ns").unwrap_or_default(),
                        string(item, "id").unwrap_or_default().to_string(),
                    )
                })
        };
        let Some(run) = selected else {
            return Ok(DashboardState {
                project: Some(project),
                experiment: Some(experiment),
                notice: Some(if let Some(run_id) = &self.run_id {
                    format!("Run {run_id:?} is not available in this experiment.")
                } else {
                    "Waiting for the latest running Run.".into()
                }),
                refreshed_at: SystemTime::now(),
                ..DashboardState::default()
            });
        };
        let run_id = required_string(&run, "id", "Run")?;
        let source_path = query_path("/api/experiments/sources", "run_id", run_id);
        let sources = response_objects(self.api.get(&source_path).await?, "sources", &source_path)?;
        let snapshots = response_objects(
            self.api
                .post(
                    "/api/snapshots/latest",
                    json!({"run_id": run_id, "limit": 256}),
                )
                .await?,
            "snapshots",
            "/api/snapshots/latest",
        )?;
        let mut metrics = HashMap::new();
        for (index, panel) in self.dashboard.panels.iter().enumerate() {
            let DashboardPanel::Metrics {
                paths, axis, roles, ..
            } = panel
            else {
                continue;
            };
            let source_ids: Vec<_> = sources
                .iter()
                .filter(|source| roles.is_empty() || role_selected(source, roles))
                .filter_map(|source| string(source, "id").map(str::to_owned))
                .collect();
            if !roles.is_empty() && source_ids.is_empty() {
                metrics.insert(index, json!({"axis": axis, "series": []}));
                continue;
            }
            let mut payload = json!({
                "run_ids": [run_id],
                "paths": paths,
                "axis": axis,
                "max_points": self.dashboard.history_points,
            });
            if !source_ids.is_empty() {
                payload["source_ids"] = json!(source_ids);
            }
            let response = self.api.post("/api/snapshots/query", payload).await?;
            if !response
                .get("series")
                .is_some_and(|series| series.is_array())
            {
                bail!("/api/snapshots/query returned an invalid response");
            }
            metrics.insert(index, response);
        }
        Ok(DashboardState {
            project: Some(project),
            experiment: Some(experiment),
            run: Some(run),
            sources,
            snapshots,
            metrics,
            notice: None,
            refreshed_at: SystemTime::now(),
        })
    }
}

pub(crate) fn base_url(configuration: &RvxConfig, cli_url: Option<String>) -> Result<String> {
    if let Some(url) = cli_url {
        return Ok(url.trim_end_matches('/').to_string());
    }
    let dashboard = configuration
        .dashboard
        .as_ref()
        .context("config does not contain a [dashboard] section")?;
    if let Some(url) = &dashboard.url {
        return Ok(url.trim_end_matches('/').to_string());
    }
    if let Some(listen) = &configuration.daemon.listen {
        let url = reqwest::Url::parse(&format!("http://{listen}"))
            .context("derive dashboard URL from daemon.listen")?;
        let host = match url.host_str().unwrap_or("127.0.0.1") {
            "0.0.0.0" | "::" => "127.0.0.1",
            host => host,
        };
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        return Ok(format!("http://{host}:{}", url.port().unwrap_or(9110)));
    }
    Ok(DEFAULT_URL.into())
}

fn response_objects(value: Value, key: &str, path: &str) -> Result<Vec<Map<String, Value>>> {
    let values = value
        .get(key)
        .and_then(Value::as_array)
        .with_context(|| format!("{path} returned an invalid response"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_object()
                .cloned()
                .with_context(|| format!("{path} returned invalid {key}"))
        })
        .collect()
}

fn query_path(path: &str, name: &str, value: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair(name, value)
        .finish();
    format!("{path}?{query}")
}

fn required_string<'a>(value: &'a Map<String, Value>, key: &str, kind: &str) -> Result<&'a str> {
    string(value, key).with_context(|| format!("{kind} response is missing {key}"))
}

pub(crate) fn string<'a>(value: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub(crate) fn integer(value: &Map<String, Value>, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

pub(crate) fn role_selected(source: &Map<String, Value>, roles: &[String]) -> bool {
    string(source, "role").is_some_and(|role| roles.iter().any(|value| value == role))
}
