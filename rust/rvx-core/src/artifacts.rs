use crate::{ProtocolError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_ARTIFACT_QUERY_RUNS: usize = 64;
pub const MAX_ARTIFACT_QUERY_SOURCES: usize = 256;
pub const MAX_ARTIFACT_PAGE_LIMIT: usize = 1_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactAction {
    Log,
    Use,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRecord {
    #[serde(default = "artifact_version")]
    pub record_version: u32,
    pub action: ArtifactAction,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub digest: String,
    pub size: u64,
    pub uri: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

impl ArtifactRecord {
    pub fn validate(&self) -> Result<()> {
        let text = |s: &str| !s.trim().is_empty() && s.len() <= 4096 && !s.contains('\0');
        if self.record_version != 1
            || !text(&self.name)
            || !text(&self.kind)
            || !text(&self.digest)
            || !text(&self.uri)
            || self.aliases.len() > 256
            || self.aliases.iter().any(|s| !text(s))
            || self
                .aliases
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.aliases.len()
            || !(self.metadata.is_object() || self.metadata.is_null())
        {
            return Err(ProtocolError::InvalidSnapshot(
                "invalid artifact version, identity, aliases or metadata".into(),
            ));
        }
        Ok(())
    }
}

fn artifact_version() -> u32 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ArtifactLineageRecord {
    pub snapshot_id: i64,
    pub artifact_index: u32,
    pub run_id: String,
    pub source_id: String,
    pub observed_at_ns: i64,
    pub step: Option<i64>,
    #[serde(flatten)]
    pub record: ArtifactRecord,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactCursor {
    pub snapshot_id: i64,
    pub artifact_index: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactLineageRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub action: Option<ArtifactAction>,
    #[serde(default)]
    pub before: Option<ArtifactCursor>,
    #[serde(default = "default_artifact_page_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ArtifactLineagePage {
    pub artifacts: Vec<ArtifactLineageRecord>,
    pub next_before: Option<ArtifactCursor>,
    pub coverage: ArtifactCoverage,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactResolveRequest {
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub name: String,
    #[serde(default = "latest_alias")]
    pub alias: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ArtifactResolveResponse {
    pub artifact: ArtifactLineageRecord,
    pub coverage: ArtifactCoverage,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ArtifactCoverage {
    pub complete: bool,
    pub excluded_records: u64,
}

fn default_artifact_page_limit() -> usize {
    100
}

fn latest_alias() -> String {
    "latest".into()
}
