use anyhow::{Context, Result};
use rvx_config::{toml_json, RvxConfig};
use rvx_core::SourceRegistration;
use rvx_engine::Engine;

pub fn apply_config(config: &RvxConfig, engine: &Engine) -> Result<()> {
    for run in &config.runs {
        let run_config = serde_json::to_string(&toml_json(&run.config, "runs.config")?)?;
        engine
            .ensure_configured_run(
                &run.id,
                &run.project,
                &run.experiment,
                &run.name,
                &run_config,
            )
            .with_context(|| format!("configure Run {:?}", run.id))?;
        for source in &run.sources {
            engine
                .register_source(&SourceRegistration {
                    run_id: run.id.clone(),
                    attempt_id: source.attempt_id.clone(),
                    role: source.role.clone(),
                    endpoint: source.endpoint.clone(),
                    node_id: source.node_id.clone(),
                    rank: source.rank,
                    scrape_interval_ms: source.scrape_interval_ms,
                    timeout_ms: source.timeout_ms,
                })
                .with_context(|| {
                    format!(
                        "configure Source {:?} for Run {:?}",
                        source.endpoint, run.id
                    )
                })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_configured_hierarchy_and_sources_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let config: RvxConfig = toml::from_str(
            r#"
version = 1
[[runs]]
id = "trial-1"
project = "async-rl"
experiment = "grpo"
name = "trial-1"
config = { batch_size = 32 }
[[runs.sources]]
endpoint = "http://127.0.0.1:9200"
role = "learner"
"#,
        )
        .unwrap();
        apply_config(&config, &engine).unwrap();
        apply_config(&config, &engine).unwrap();
        assert_eq!(engine.list_projects().unwrap().len(), 1);
        assert_eq!(engine.list_experiments(None).unwrap().len(), 1);
        let runs = engine.list_runs(None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, "trial-1");
        assert_eq!(runs[0].config_json, r#"{"batch_size":32}"#);
        let sources = engine.list_sources(Some("trial-1")).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].role, "learner");
    }
}
