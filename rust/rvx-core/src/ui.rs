//! Configuration-only UI documents; observed experiment data never belongs in these records.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_UI_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_UI_REVISION: u64 = 9_007_199_254_740_991;
pub const MAX_WORKSPACE_SETS: usize = 100;
pub const MAX_UI_ID_BYTES: usize = 256;
pub const MAX_UI_RUN_COLORS: usize = 1000;
pub const MAX_COLUMN_DECIMALS: u8 = 20;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceDocument {
    pub revision: u64,
    pub sets: Vec<WorkspaceSet>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BrowserPreferences {
    pub revision: u64,
    pub theme: Theme,
    pub sidebar_width: u16,
    #[serde(deserialize_with = "selections")]
    pub selected: BTreeMap<String, String>,
    #[serde(default, deserialize_with = "run_colors")]
    pub run_colors: BTreeMap<String, String>,
}

impl Default for BrowserPreferences {
    /// Start new browsers with a neutral theme, compact rail, and no workspace selection.
    fn default() -> Self {
        Self {
            revision: 0,
            theme: Theme::Light,
            sidebar_width: 280,
            selected: BTreeMap::new(),
            run_colors: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiState {
    pub workspaces: WorkspaceDocument,
    pub browser: BrowserPreferences,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SaveWorkspaces {
    pub revision: u64,
    pub mutation_id: String,
    pub sets: Vec<WorkspaceSet>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SaveBrowserPreferences {
    pub revision: u64,
    pub mutation_id: String,
    pub theme: Theme,
    pub sidebar_width: u16,
    #[serde(deserialize_with = "selections")]
    pub selected: BTreeMap<String, String>,
    #[serde(deserialize_with = "run_colors")]
    pub run_colors: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSet {
    pub id: String,
    pub name: String,
    pub experiment_id: String,
    pub panels: Vec<PanelSpec>,
    pub sections: Vec<SectionSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SectionSpec {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PanelSpec {
    #[serde(rename_all = "camelCase")]
    Chart {
        id: String,
        section_id: String,
        size: PanelSize,
        path: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        paths: Option<Vec<String>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        presentation: Option<ChartPresentation>,
    },
    #[serde(rename_all = "camelCase")]
    MetricTable {
        id: String,
        section_id: String,
        size: PanelSize,
        paths: Vec<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        title: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        source_ids: Option<Vec<String>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        columns: Option<Vec<ColumnPreference>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        query: Option<TableQueryPreference>,
    },
    #[serde(rename_all = "camelCase")]
    SnapshotTable {
        id: String,
        section_id: String,
        size: PanelSize,
        path: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        title: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        source_ids: Option<Vec<String>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        columns: Option<Vec<ColumnPreference>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        query: Option<TableQueryPreference>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        view: Option<crate::SnapshotView>,
    },
}

// Decode fields directly rather than serde's internally-tagged numeric buffer: the rest of
// the protocol enables arbitrary_precision to retain large snapshot integers losslessly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PanelFields {
    kind: String,
    id: String,
    section_id: String,
    size: PanelSize,
    #[serde(default, deserialize_with = "present")]
    path: Option<String>,
    #[serde(default, deserialize_with = "present")]
    paths: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    presentation: Option<ChartPresentation>,
    #[serde(default, deserialize_with = "present")]
    title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    source_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    columns: Option<Vec<ColumnPreference>>,
    #[serde(default, deserialize_with = "present")]
    query: Option<TableQueryPreference>,
    #[serde(default, deserialize_with = "present")]
    view: Option<crate::SnapshotView>,
}

impl<'de> Deserialize<'de> for PanelSpec {
    /// Preserve exact numeric decoding while rejecting fields belonging to another panel kind.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let fields = PanelFields::deserialize(deserializer)?;
        match fields.kind.as_str() {
            "chart" => {
                if fields.title.is_some()
                    || fields.source_ids.is_some()
                    || fields.columns.is_some()
                    || fields.query.is_some()
                    || fields.view.is_some()
                {
                    return Err(D::Error::custom(
                        "table-only fields are not valid chart configuration",
                    ));
                }
                Ok(Self::Chart {
                    id: fields.id,
                    section_id: fields.section_id,
                    size: fields.size,
                    path: fields.path.ok_or_else(|| D::Error::missing_field("path"))?,
                    paths: fields.paths,
                    presentation: fields.presentation,
                })
            }
            "metric-table" => {
                if fields.path.is_some() || fields.presentation.is_some() || fields.view.is_some() {
                    return Err(D::Error::custom(
                        "path/presentation are not valid metric-table configuration",
                    ));
                }
                Ok(Self::MetricTable {
                    id: fields.id,
                    section_id: fields.section_id,
                    size: fields.size,
                    paths: fields
                        .paths
                        .ok_or_else(|| D::Error::missing_field("paths"))?,
                    title: fields.title,
                    source_ids: fields.source_ids,
                    columns: fields.columns,
                    query: fields.query,
                })
            }
            "snapshot-table" => {
                if fields.paths.is_some() || fields.presentation.is_some() {
                    return Err(D::Error::custom(
                        "paths/presentation are not valid snapshot-table configuration",
                    ));
                }
                Ok(Self::SnapshotTable {
                    id: fields.id,
                    section_id: fields.section_id,
                    size: fields.size,
                    path: fields.path.ok_or_else(|| D::Error::missing_field("path"))?,
                    title: fields.title,
                    source_ids: fields.source_ids,
                    columns: fields.columns,
                    query: fields.query,
                    view: fields.view,
                })
            }
            _ => Err(D::Error::unknown_variant(
                &fields.kind,
                &["chart", "metric-table", "snapshot-table"],
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartPresentation {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub style: Option<ChartStyle>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub points: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub legend: Option<ChartLegend>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub y_min: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub y_max: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ColumnPreference {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub hidden: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "column_decimals",
        skip_serializing_if = "Option::is_none"
    )]
    pub decimals: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TableQueryPreference {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub search: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub filters: Option<Vec<UiTableFilter>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sort: Option<TableSortPreference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiTableFilter {
    pub path: String,
    pub op: UiFilterOp,
    pub value: String,
    /// Omission means enabled; this presentation flag never belongs to native table requests.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TableSortPreference {
    pub path: String,
    pub direction: UiSortDirection,
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident),* }) => {
        #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
        #[serde(rename_all = "lowercase")]
        pub enum $name { $($variant),* }
    };
}
string_enum!(Theme { Light, Dark });
string_enum!(PanelSize { Normal, Wide });
string_enum!(ChartStyle { Line, Area });
string_enum!(ChartLegend { Auto, Show, Hide });
string_enum!(UiFilterOp {
    Contains,
    Eq,
    Gt,
    Lt
});
string_enum!(UiSortDirection { Asc, Desc });

/// Allow absent optional fields but reject explicit nulls that have no configuration meaning.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// Keep Auto absent while rejecting non-integer or out-of-range display precision.
fn column_decimals<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u8>, D::Error> {
    let decimals = u8::deserialize(deserializer)?;
    if decimals > MAX_COLUMN_DECIMALS {
        return Err(serde::de::Error::custom(
            "decimals must be an integer from 0 through 20",
        ));
    }
    Ok(Some(decimals))
}

/// Reject duplicate or excessive overrides rather than discarding any browser's chosen colors.
fn run_colors<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct RunColors;
    impl<'de> serde::de::Visitor<'de> for RunColors {
        type Value = BTreeMap<String, String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most 1000 distinct Run-to-color overrides")
        }

        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            use serde::de::Error;
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.len() >= MAX_UI_RUN_COLORS || result.insert(key, value).is_some() {
                    return Err(M::Error::custom(
                        "duplicate or excessive run_colors overrides",
                    ));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(RunColors)
}

/// Reject duplicate selection keys before a map could silently overwrite their values.
fn selections<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Selections;
    impl<'de> serde::de::Visitor<'de> for Selections {
        type Value = BTreeMap<String, String>;

        /// Describe the bounded selection map in deserialization errors.
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most 100 distinct experiment-to-workspace selections")
        }

        /// Build selections while enforcing unique experiment keys and the shared capacity limit.
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            use serde::de::Error;
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.len() >= MAX_WORKSPACE_SETS || result.insert(key, value).is_some() {
                    return Err(M::Error::custom(
                        "duplicate or excessive workspace selections",
                    ));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Selections)
}

/// Convert a configuration invariant into a specific validation error.
fn check(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.to_owned())
}

/// Bound UTF-8 storage and displayed character counts without accepting embedded nulls.
fn text(value: &str, max_chars: usize) -> bool {
    value.len() <= 4096 && value.chars().count() <= max_chars && !value.contains('\0')
}

/// Validate bounded opaque layout/mutation identifiers, without interpreting them as paths.
pub fn valid_ui_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_UI_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

/// Recognize bounded absolute snapshot paths, optionally including the document root.
fn path(value: &str, root: bool) -> bool {
    text(value, 4096) && ((root && value.is_empty()) || value.starts_with('/'))
}

/// Require a nonempty, bounded metric selection without duplicate paths.
fn paths(values: &[String]) -> bool {
    !values.is_empty()
        && values.len() <= 64
        && values.iter().all(|value| path(value, false))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}

impl SaveWorkspaces {
    /// Validate the complete current-format configuration before any repository mutation.
    pub fn validate(&self) -> Result<(), String> {
        check(
            self.revision <= MAX_UI_REVISION,
            "revision exceeds JavaScript safe integer",
        )?;
        check(
            valid_ui_id(&self.mutation_id),
            "mutation_id must contain 1..256 bounded bytes",
        )?;
        check(
            self.sets.len() <= MAX_WORKSPACE_SETS,
            "at most 100 workspace sets are allowed",
        )?;
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        for set in &self.sets {
            check(
                valid_ui_id(&set.id) && valid_ui_id(&set.experiment_id),
                "invalid workspace or experiment ID",
            )?;
            check(ids.insert(&set.id), "duplicate workspace ID")?;
            check(
                !set.name.is_empty() && set.name.trim() == set.name && text(&set.name, 80),
                "workspace name must be trimmed, nonempty, and at most 80 characters",
            )?;
            check(
                names.insert((&set.experiment_id, &set.name)),
                "duplicate workspace name in experiment",
            )?;
            check(
                (1..=24).contains(&set.sections.len()) && set.panels.len() <= 24,
                "workspace requires 1..24 sections and at most 24 panels",
            )?;
            let mut sections = HashSet::new();
            for section in &set.sections {
                check(
                    valid_ui_id(&section.id) && sections.insert(section.id.as_str()),
                    "invalid or duplicate section ID",
                )?;
                check(
                    text(&section.name, 100),
                    "section name exceeds 100 characters",
                )?;
            }
            let mut panels = HashSet::new();
            for panel in &set.panels {
                let (id, section_id) = panel.identity();
                check(
                    valid_ui_id(id) && panels.insert(id),
                    "invalid or duplicate panel ID",
                )?;
                check(
                    sections.contains(section_id),
                    "panel references an unknown section",
                )?;
                panel.validate()?;
            }
        }
        Ok(())
    }
}

impl SaveBrowserPreferences {
    /// Validate browser-owned fields; selection relationships are checked atomically by the repository.
    pub fn validate(&self) -> Result<(), String> {
        check(
            self.revision <= MAX_UI_REVISION,
            "revision exceeds JavaScript safe integer",
        )?;
        check(valid_ui_id(&self.mutation_id), "invalid mutation_id")?;
        check(
            (220..=520).contains(&self.sidebar_width),
            "sidebar_width must be an integer from 220 through 520",
        )?;
        check(
            self.selected.len() <= MAX_WORKSPACE_SETS,
            "at most 100 workspace selections are allowed",
        )?;
        check(
            self.selected
                .iter()
                .all(|(experiment, set)| valid_ui_id(experiment) && valid_ui_id(set)),
            "invalid selection identifier",
        )?;
        check(
            self.run_colors.len() <= MAX_UI_RUN_COLORS,
            "at most 1000 run_colors overrides are allowed; no overrides were evicted",
        )?;
        check(
            self.run_colors.iter().all(|(run, color)| {
                valid_ui_id(run)
                    && color.len() == 7
                    && color.starts_with('#')
                    && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            }),
            "run_colors must map bounded Run IDs to six-digit #RRGGBB colors",
        )
    }
}

impl PanelSpec {
    /// Return stable panel and section identities independently of panel kind.
    pub fn identity(&self) -> (&str, &str) {
        match self {
            Self::Chart { id, section_id, .. }
            | Self::MetricTable { id, section_id, .. }
            | Self::SnapshotTable { id, section_id, .. } => (id, section_id),
        }
    }

    /// Return configured Source filters; these remain separate from stored observations.
    pub fn source_ids(&self) -> &[String] {
        match self {
            Self::Chart { .. } => &[],
            Self::MetricTable { source_ids, .. } | Self::SnapshotTable { source_ids, .. } => {
                source_ids.as_deref().unwrap_or_default()
            }
        }
    }

    /// Validate kind-specific presentation and query fields before persistence.
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Chart {
                path: metric,
                paths: metrics,
                presentation,
                ..
            } => {
                check(path(metric, false), "invalid chart path")?;
                if let Some(metrics) = metrics {
                    check(
                        paths(metrics) && metrics.contains(metric),
                        "chart paths must be 1..64 unique metric paths including path",
                    )?;
                }
                if let Some(display) = presentation {
                    if let Some(title) = &display.title {
                        check(
                            !title.trim().is_empty() && text(title, 120),
                            "invalid chart title",
                        )?;
                    }
                    if let Some(width) = display.line_width {
                        check(
                            width.is_finite() && (0.5..=6.0).contains(&width),
                            "lineWidth must be finite and from 0.5 through 6",
                        )?;
                    }
                    check(
                        display.y_min.map_or(true, f64::is_finite)
                            && display.y_max.map_or(true, f64::is_finite),
                        "chart bounds must be finite",
                    )?;
                    if let (Some(min), Some(max)) = (display.y_min, display.y_max) {
                        check(min < max, "yMin must be less than yMax")?;
                    }
                }
            }
            Self::MetricTable {
                paths: metrics,
                title,
                source_ids,
                columns,
                query,
                ..
            } => {
                check(
                    paths(metrics),
                    "table paths must be 1..64 unique metric paths",
                )?;
                validate_table(title, source_ids, columns, query)?;
            }
            Self::SnapshotTable {
                path: collection,
                title,
                source_ids,
                columns,
                query,
                view,
                ..
            } => {
                check(path(collection, true), "invalid snapshot-table path")?;
                validate_table(title, source_ids, columns, query)?;
                if let Some(view) = view {
                    view.validate()?;
                }
            }
        }
        Ok(())
    }
}

/// Keep table presentation and query documents within the same limits as their UI controls.
fn validate_table(
    title: &Option<String>,
    sources: &Option<Vec<String>>,
    columns: &Option<Vec<ColumnPreference>>,
    query: &Option<TableQueryPreference>,
) -> Result<(), String> {
    if let Some(title) = title {
        check(text(title, 120), "table title exceeds 120 characters")?;
    }
    if let Some(sources) = sources {
        check(
            sources.len() <= 256
                && sources.iter().all(|id| valid_ui_id(id))
                && sources.iter().collect::<HashSet<_>>().len() == sources.len(),
            "invalid, duplicate, or excessive Source IDs",
        )?;
    }
    if let Some(columns) = columns {
        check(
            columns.len() <= 131,
            "at most 131 table columns are allowed",
        )?;
        let mut ids = HashSet::new();
        for column in columns {
            check(
                text(&column.id, 4096) && ids.insert(&column.id),
                "invalid or duplicate column ID",
            )?;
            if let Some(width) = column.width {
                check(
                    width.is_finite() && (70.0..=800.0).contains(&width),
                    "column width must be finite and from 70 through 800",
                )?;
            }
            if let Some(decimals) = column.decimals {
                check(
                    decimals <= MAX_COLUMN_DECIMALS,
                    "decimals must be an integer from 0 through 20",
                )?;
            }
        }
    }
    if let Some(query) = query {
        check(
            query
                .search
                .as_ref()
                .map_or(true, |value| text(value, 4096)),
            "table search exceeds 4096 bytes",
        )?;
        if let Some(sort) = &query.sort {
            check(text(&sort.path, 4096), "sort path exceeds 4096 bytes")?;
        }
        if let Some(filters) = &query.filters {
            check(
                filters.len() <= 32
                    && filters
                        .iter()
                        .all(|filter| text(&filter.path, 4096) && text(&filter.value, 4096)),
                "at most 32 filters with 4096-byte strings are allowed",
            )?;
        }
    }
    Ok(())
}
