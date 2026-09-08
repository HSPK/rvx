use std::sync::Arc;

use rvx_core::{
    ColumnPreference, PanelSpec, SaveBrowserPreferences, SaveWorkspaces, SourceRegistration,
    MAX_UI_REVISION, MAX_UI_RUN_COLORS,
};
use rvx_engine::{Engine, EngineError};
use serde_json::{json, Value};

struct Fixture {
    directory: tempfile::TempDir,
    engine: Arc<Engine>,
    experiment: String,
    foreign_experiment: String,
    source: String,
    foreign_source: String,
    browser: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let engine = Engine::open(directory.path()).unwrap();
        let project = engine.create_project("ui-fixture").unwrap();
        let experiment = engine
            .create_experiment(&project.id, "experiment")
            .unwrap()
            .id;
        let foreign_experiment = engine.create_experiment(&project.id, "foreign").unwrap().id;
        let register = |experiment: &str| {
            let run = engine.create_run(experiment, "run", "{}").unwrap();
            engine
                .register_source(&SourceRegistration {
                    run_id: run.id,
                    attempt_id: "attempt".into(),
                    role: "test".into(),
                    endpoint: "http://127.0.0.1:1".into(),
                    node_id: None,
                    rank: None,
                    scrape_interval_ms: 1000,
                    timeout_ms: 100,
                })
                .unwrap()
                .id
        };
        let source = register(&experiment);
        let foreign_source = register(&foreign_experiment);
        let browser = engine.ui_state(None).unwrap().browser_id;
        Self {
            directory,
            engine,
            experiment,
            foreign_experiment,
            source,
            foreign_source,
            browser,
        }
    }

    fn input(&self) -> Value {
        json!({"revision":0,"mutation_id":"mutation-1","sets":[{
            "id":"set-1","name":"Workspace","experimentId":self.experiment,
            "sections":[{"id":"section-1","name":"","collapsed":false}],
            "panels":[
                {"id":"chart","sectionId":"section-1","size":"normal","kind":"chart","path":"/loss","paths":["/loss","/accuracy"],
                 "presentation":{"title":"Results","style":"area","lineWidth":2.5,"points":true,"legend":"show","yMin":-2,"yMax":10}},
                {"id":"metrics","sectionId":"section-1","size":"wide","kind":"metric-table","paths":["/loss"],"title":"Metrics",
                 "sourceIds":[self.source],"columns":[{"id":"@run","width":170,"hidden":false},{"id":"average","width":70}],
                 "query":{"search":"run","sort":{"path":"average","direction":"desc"},"filters":[
                     {"path":"average","op":"contains","value":"1"},{"path":"average","op":"eq","value":"1"},
                     {"path":"average","op":"gt","value":"0"},{"path":"average","op":"lt","value":"10"}
                 ]}},
                {"id":"snapshot","sectionId":"section-1","size":"wide","kind":"snapshot-table","path":"","title":"",
                 "sourceIds":[],"columns":[{"id":"$key"},{"id":""},{"id":"/value","width":800,"hidden":true}],
                 "query":{"search":"","sort":{"path":"","direction":"asc"},"filters":[]}}
            ]
        }]})
    }

    fn save(&self, value: Value) -> Result<rvx_core::WorkspaceDocument, EngineError> {
        let input: SaveWorkspaces = serde_json::from_value(value)
            .map_err(|error| EngineError::InvalidInput(error.to_string()))?;
        self.engine.save_workspaces(&self.browser, &input)
    }

    fn prefs(
        &self,
        revision: u64,
        mutation: &str,
        theme: &str,
        width: u16,
        selected: Value,
    ) -> SaveBrowserPreferences {
        serde_json::from_value(json!({"revision":revision,"mutation_id":mutation,"theme":theme,"sidebar_width":width,"selected":selected,"run_colors":{}})).unwrap()
    }
}

#[test]
fn ui_durable_roundtrip_keeps_shared_workspaces_and_independent_browser_preferences() {
    let fixture = Fixture::new();
    let other = fixture.engine.ui_state(None).unwrap();
    assert!(other.initialized);
    assert_ne!(other.browser_id, fixture.browser);
    assert_eq!(other.state.workspaces.revision, 0);
    assert_eq!(other.state.browser.sidebar_width, 280);
    let mut value = fixture.input();
    let mut second_set = value["sets"][0].clone();
    second_set["id"] = json!("set-2");
    second_set["name"] = json!("Second");
    value["sets"].as_array_mut().unwrap().push(second_set);
    let saved = fixture.save(value).unwrap();
    let one = fixture.prefs(
        0,
        "prefs-1",
        "dark",
        520,
        json!({fixture.experiment.clone():"set-1"}),
    );
    let two = fixture.prefs(
        0,
        "prefs-2",
        "light",
        220,
        json!({fixture.experiment.clone():"set-2"}),
    );
    let first_prefs = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &one)
        .unwrap();
    let second_prefs = fixture
        .engine
        .save_browser_preferences(&other.browser_id, &two)
        .unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(first_prefs.revision, 1);
    assert_eq!(second_prefs.revision, 1);
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
    let first_id = fixture.browser.clone();
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let reopened = Engine::open(&path).unwrap();
    let first = reopened.ui_state(Some(&first_id)).unwrap();
    let second = reopened.ui_state(Some(&other.browser_id)).unwrap();
    assert!(!first.initialized && !second.initialized);
    assert_eq!(first.state.workspaces, saved);
    assert_eq!(second.state.workspaces, saved);
    assert_eq!(first.state.browser, first_prefs);
    assert_eq!(second.state.browser, second_prefs);
    assert_eq!(reopened.stats().unwrap().sources, 2);
    assert_eq!(reopened.stats().unwrap().snapshots, 0);
    let connection = rusqlite::Connection::open(path.join("metadata.db")).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert!(!path.join("ui.json").exists());
}

#[test]
fn ui_cas_retry_noop_and_pruning_are_transactional_and_independent() {
    let fixture = Fixture::new();
    let input = fixture.input();
    let first = fixture.save(input.clone()).unwrap();
    assert_eq!(fixture.save(input.clone()).unwrap(), first);
    let mut reused = input.clone();
    reused["sets"][0]["name"] = json!("Conflicting reuse");
    assert!(matches!(
        fixture.save(reused),
        Err(EngineError::UiConflict { .. })
    ));
    let mut stale = input.clone();
    stale["mutation_id"] = json!("other-mutation");
    assert!(matches!(
        fixture.save(stale),
        Err(EngineError::UiConflict { .. })
    ));
    let mut noop = input.clone();
    noop["mutation_id"] = json!("no-op");
    noop["revision"] = json!(1);
    assert_eq!(fixture.save(noop.clone()).unwrap(), first);
    assert_eq!(fixture.save(noop).unwrap(), first);
    assert!(matches!(
        fixture.save(input),
        Err(EngineError::UiConflict { .. })
    ));

    let prefs = fixture.prefs(
        0,
        "prefs",
        "dark",
        300,
        json!({fixture.experiment.clone():"set-1"}),
    );
    let saved_prefs = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &prefs)
        .unwrap();
    assert_eq!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &prefs)
            .unwrap(),
        saved_prefs
    );
    let mut reused = prefs.clone();
    reused.sidebar_width = 301;
    assert!(matches!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &reused),
        Err(EngineError::UiConflict { .. })
    ));
    reused.mutation_id = "stale-prefs".into();
    assert!(matches!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &reused),
        Err(EngineError::UiConflict { .. })
    ));
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces
            .revision,
        1
    );

    let other = fixture.engine.ui_state(None).unwrap();
    let deleted = fixture
        .save(json!({"revision":1,"mutation_id":"delete","sets":[]}))
        .unwrap();
    assert_eq!(deleted.revision, 2);
    let after = fixture
        .engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state
        .browser;
    assert!(after.selected.is_empty());
    assert_eq!(after.revision, 2);
    assert_eq!(after.theme, saved_prefs.theme);
    assert_eq!(after.sidebar_width, saved_prefs.sidebar_width);
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&other.browser_id))
            .unwrap()
            .state
            .browser
            .revision,
        0
    );
    assert!(matches!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &prefs),
        Err(EngineError::UiConflict { .. })
    ));
}

#[test]
fn ui_rejects_invalid_shapes_bounds_raw_fields_and_foreign_relationships_without_mutation() {
    let fixture = Fixture::new();
    let base = fixture.input();
    let cases = [
        ("/sets/0/id", json!("")),
        ("/sets/0/id", json!("x".repeat(257))),
        ("/sets/0/name", json!(" not trimmed ")),
        ("/sets/0/name", json!("x".repeat(81))),
        ("/sets/0/experimentId", json!("missing")),
        ("/sets/0/sections", json!([])),
        ("/sets/0/sections/0/id", json!("")),
        ("/sets/0/sections/0/name", json!("x".repeat(101))),
        ("/sets/0/panels/0/id", json!("")),
        ("/sets/0/panels/0/sectionId", json!("missing")),
        ("/sets/0/panels/0/kind", json!("raw-data")),
        ("/sets/0/panels/0/size", json!("giant")),
        ("/sets/0/panels/0/path", json!("loss")),
        ("/sets/0/panels/0/paths", json!(["/accuracy"])),
        ("/sets/0/panels/0/paths", json!(["/loss", "/loss"])),
        ("/sets/0/panels/0/presentation/title", json!(" ")),
        ("/sets/0/panels/0/presentation/style", json!("bar")),
        ("/sets/0/panels/0/presentation/legend", json!("sometimes")),
        ("/sets/0/panels/0/presentation/points", json!("yes")),
        ("/sets/0/panels/0/presentation/lineWidth", json!(7)),
        ("/sets/0/panels/0/presentation/yMax", json!(-3)),
        ("/sets/0/panels/0/presentation/yMin", Value::Null),
        ("/sets/0/panels/0/presentation", Value::Null),
        ("/sets/0/panels/1/paths", json!([])),
        ("/sets/0/panels/1/sourceIds", json!(["missing"])),
        (
            "/sets/0/panels/1/sourceIds",
            json!([fixture.source, fixture.source]),
        ),
        ("/sets/0/panels/1/columns/0/width", json!(69)),
        ("/sets/0/panels/1/columns/0/width", json!(801)),
        ("/sets/0/panels/1/columns/0/hidden", Value::Null),
        ("/sets/0/panels/1/query/search", json!("x".repeat(4097))),
        ("/sets/0/panels/1/query/filters/0/op", json!("regex")),
        (
            "/sets/0/panels/1/query/filters/0/value",
            json!("x".repeat(4097)),
        ),
        ("/sets/0/panels/1/query/sort/direction", json!("down")),
        ("/sets/0/panels/2/path", json!("not-a-path")),
        ("/revision", json!(MAX_UI_REVISION + 1)),
        ("/mutation_id", json!("")),
    ];
    for (pointer, invalid) in cases {
        let mut input = base.clone();
        *input.pointer_mut(pointer).unwrap() = invalid;
        assert!(fixture.save(input).is_err(), "{pointer}");
    }
    for pointer in [
        "",
        "/sets/0",
        "/sets/0/sections/0",
        "/sets/0/panels/0",
        "/sets/0/panels/0/presentation",
        "/sets/0/panels/1",
        "/sets/0/panels/1/columns/0",
        "/sets/0/panels/1/query",
        "/sets/0/panels/1/query/sort",
        "/sets/0/panels/1/query/filters/0",
        "/sets/0/panels/2",
    ] {
        let mut input = base.clone();
        input
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("raw_state".into(), json!({"secret":"not UI config"}));
        assert!(
            fixture.save(input).is_err(),
            "{pointer} must deny unknown fields"
        );
    }
    for (pointer, count) in [
        ("/sets", 101),
        ("/sets/0/panels", 25),
        ("/sets/0/sections", 25),
        ("/sets/0/panels/0/paths", 65),
        ("/sets/0/panels/1/sourceIds", 257),
        ("/sets/0/panels/1/columns", 132),
        ("/sets/0/panels/1/query/filters", 33),
    ] {
        let mut input = base.clone();
        let original = input.pointer(pointer).unwrap()[0].clone();
        *input.pointer_mut(pointer).unwrap() = Value::Array(vec![original; count]);
        assert!(fixture.save(input).is_err(), "{pointer} count");
    }
    for pointer in [
        "/sets",
        "/sets/0/panels",
        "/sets/0/sections",
        "/sets/0/panels/1/columns",
    ] {
        let mut input = base.clone();
        let values = input.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
        values.push(values[0].clone());
        assert!(fixture.save(input).is_err(), "{pointer} duplicates");
    }
    let mut duplicate_name = base.clone();
    let mut other = duplicate_name["sets"][0].clone();
    other["id"] = json!("other");
    duplicate_name["sets"].as_array_mut().unwrap().push(other);
    assert!(fixture.save(duplicate_name).is_err());
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces
            .revision,
        0
    );
    assert!(fixture
        .engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state
        .workspaces
        .sets
        .is_empty());
}

#[test]
fn ui_preserves_explicit_reporters_across_compared_experiments() {
    let fixture = Fixture::new();
    let mut input = fixture.input();
    input["sets"][0]["panels"][1]["sourceIds"] = json!([fixture.source, fixture.foreign_source]);
    let saved = fixture.save(input).unwrap();
    assert_eq!(saved.sets[0].panels[1].source_ids().len(), 2);
}

#[test]
fn ui_accepts_current_minimal_variants_and_rejects_programmatic_nonfinite_numbers() {
    let fixture = Fixture::new();
    let mut minimal = fixture.input();
    minimal["sets"][0]["panels"] = json!([
        {"kind":"chart","id":"c","sectionId":"section-1","path":"/loss","size":"wide"},
        {"kind":"metric-table","id":"m","sectionId":"section-1","paths":["/loss"],"size":"normal"},
        {"kind":"snapshot-table","id":"s","sectionId":"section-1","path":"/records","size":"normal"}
    ]);
    let saved = fixture.save(minimal).unwrap();
    assert_eq!(saved.sets[0].panels.len(), 3);
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut input: SaveWorkspaces = serde_json::from_value(fixture.input()).unwrap();
        input.revision = 1;
        input.mutation_id = "nonfinite".into();
        if let PanelSpec::Chart {
            presentation: Some(display),
            ..
        } = &mut input.sets[0].panels[0]
        {
            display.y_min = Some(value);
        }
        assert!(fixture
            .engine
            .save_workspaces(&fixture.browser, &input)
            .is_err());
        if let PanelSpec::Chart {
            presentation: Some(display),
            ..
        } = &mut input.sets[0].panels[0]
        {
            display.y_min = Some(-2.0);
            display.line_width = Some(value);
        }
        assert!(fixture
            .engine
            .save_workspaces(&fixture.browser, &input)
            .is_err());
        if let PanelSpec::Chart {
            presentation: Some(display),
            ..
        } = &mut input.sets[0].panels[0]
        {
            display.line_width = Some(2.5);
        }
        if let PanelSpec::MetricTable {
            columns: Some(columns),
            ..
        } = &mut input.sets[0].panels[1]
        {
            columns[0].width = Some(value);
        }
        assert!(fixture
            .engine
            .save_workspaces(&fixture.browser, &input)
            .is_err());
    }
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
}

#[test]
fn ui_commit_failure_rolls_back_shared_document_and_all_browser_pruning() {
    let fixture = Fixture::new();
    let original = fixture.save(fixture.input()).unwrap();
    let prefs = fixture.prefs(
        0,
        "prefs",
        "dark",
        360,
        json!({fixture.experiment.clone():"set-1"}),
    );
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &prefs)
        .unwrap();
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("metadata.db")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fixture_reject_workspace BEFORE UPDATE ON ui_workspaces
                BEGIN SELECT RAISE(ABORT, 'fixture durable write failure'); END;",
        )
        .unwrap();
    let deletion = json!({"revision":1,"mutation_id":"failed-delete","sets":[]});
    assert!(matches!(
        fixture.save(deletion.clone()),
        Err(EngineError::Sqlite(_))
    ));
    let unchanged = fixture
        .engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state;
    assert_eq!(unchanged.workspaces, original);
    assert_eq!(unchanged.browser, saved);
    connection
        .execute_batch("DROP TRIGGER fixture_reject_workspace;")
        .unwrap();
    assert_eq!(fixture.save(deletion).unwrap().revision, 2);
    assert!(fixture
        .engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state
        .browser
        .selected
        .is_empty());
}

#[test]
fn ui_latest_retry_survives_reopen_and_revision_limit_prevents_partial_pruning() {
    let fixture = Fixture::new();
    let input = fixture.input();
    let original = fixture.save(input.clone()).unwrap();
    let prefs = fixture.prefs(
        0,
        "prefs",
        "dark",
        360,
        json!({fixture.experiment.clone():"set-1"}),
    );
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &prefs)
        .unwrap();
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let engine = Engine::open(&path).unwrap();
    let request: SaveWorkspaces = serde_json::from_value(input).unwrap();
    assert_eq!(
        engine.save_workspaces(&fixture.browser, &request).unwrap(),
        original
    );
    assert_eq!(
        engine
            .save_browser_preferences(&fixture.browser, &prefs)
            .unwrap(),
        saved
    );
    let mut at_limit = saved.clone();
    at_limit.revision = MAX_UI_REVISION;
    let connection = rusqlite::Connection::open(path.join("metadata.db")).unwrap();
    connection
        .execute(
            "UPDATE ui_browsers SET document_json=?2 WHERE browser_id=?1",
            rusqlite::params![fixture.browser, serde_json::to_string(&at_limit).unwrap()],
        )
        .unwrap();
    let deletion: SaveWorkspaces =
        serde_json::from_value(json!({"revision":1,"mutation_id":"delete","sets":[]})).unwrap();
    assert!(matches!(
        engine.save_workspaces(&fixture.browser, &deletion),
        Err(EngineError::InvalidInput(_))
    ));
    let state = engine.ui_state(Some(&fixture.browser)).unwrap().state;
    assert_eq!(state.workspaces, original);
    assert_eq!(state.browser, at_limit);
}

#[test]
fn ui_exact_capacity_is_preserved_without_evicting_existing_workspaces() {
    let fixture = Fixture::new();
    let mut input = fixture.input();
    let mut template = input["sets"][0].clone();
    template["panels"] = json!([]);
    input["sets"] = Value::Array(
        (0..100)
            .map(|index| {
                let mut set = template.clone();
                set["id"] = json!(format!("set-{index}"));
                set["name"] = json!(format!("Workspace {index}"));
                set
            })
            .collect(),
    );
    let saved = fixture.save(input.clone()).unwrap();
    assert_eq!(saved.sets.len(), 100);
    input["revision"] = json!(1);
    input["mutation_id"] = json!("over-capacity");
    template["id"] = json!("set-101");
    template["name"] = json!("No eviction");
    input["sets"].as_array_mut().unwrap().push(template);
    assert!(fixture.save(input).is_err());
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
}
#[test]
fn ui_column_decimals_preserve_auto_and_roundtrip_display_only_precision() {
    let automatic: ColumnPreference =
        serde_json::from_value(json!({"id":"average","hidden":false,"width":150})).unwrap();
    assert_eq!(automatic.decimals, None);
    assert!(serde_json::to_value(&automatic)
        .unwrap()
        .get("decimals")
        .is_none());
    for decimals in [0, 8, 20] {
        let input = json!({"id":"average","hidden":true,"width":150.0,"decimals":decimals});
        let column: ColumnPreference = serde_json::from_str(&input.to_string()).unwrap();
        assert_eq!(column.decimals, Some(decimals));
        assert_eq!(serde_json::to_value(column).unwrap(), input);
    }
    for decimals in [
        "-1", "21", "256", "1.5", "1e400", "NaN", "null", "\"2\"", "true",
    ] {
        let input = format!("{{\"id\":\"average\",\"decimals\":{decimals}}}");
        assert!(
            serde_json::from_str::<ColumnPreference>(&input).is_err(),
            "{decimals}"
        );
    }

    let fixture = Fixture::new();
    let mut input = fixture.input();
    input["sets"][0]["panels"][1]["columns"][1]["decimals"] = json!(0);
    input["sets"][0]["panels"][2]["columns"][2]["decimals"] = json!(20);
    let saved = fixture.save(input.clone()).unwrap();
    let encoded = serde_json::to_value(&saved).unwrap();
    assert_eq!(encoded["sets"][0]["panels"][1]["columns"][1]["decimals"], 0);
    assert_eq!(
        encoded["sets"][0]["panels"][2]["columns"][2]["decimals"],
        20
    );
    let mut bad: SaveWorkspaces = serde_json::from_value(input).unwrap();
    assert_eq!(saved.sets, bad.sets);
    bad.revision = 1;
    bad.mutation_id = "bad-decimals".into();
    if let PanelSpec::MetricTable {
        columns: Some(columns),
        ..
    } = &mut bad.sets[0].panels[1]
    {
        columns[1].decimals = Some(21);
    }
    assert!(fixture
        .engine
        .save_workspaces(&fixture.browser, &bad)
        .is_err());
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let reopened = Engine::open(path).unwrap();
    assert_eq!(
        reopened
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
}

#[test]
fn ui_run_colors_are_browser_owned_global_durable_and_survive_selection_pruning() {
    let fixture = Fixture::new();
    let workspace = fixture.save(fixture.input()).unwrap();
    let run = fixture.engine.list_runs(Some(&fixture.experiment)).unwrap()[0]
        .id
        .clone();
    let foreign = fixture
        .engine
        .list_runs(Some(&fixture.foreign_experiment))
        .unwrap()[0]
        .id
        .clone();
    let other = fixture.engine.ui_state(None).unwrap();
    let mut input = fixture.prefs(
        0,
        "colors",
        "dark",
        360,
        json!({fixture.experiment.clone():"set-1"}),
    );
    input.run_colors.insert(run.clone(), "#aBcD09".into());
    input.run_colors.insert(foreign, "#123456".into());
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &input)
        .unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.run_colors, input.run_colors);
    assert_eq!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &input)
            .unwrap(),
        saved
    );
    let mut second_input = fixture.prefs(0, "other-colors", "light", 280, json!({}));
    second_input
        .run_colors
        .insert(run.clone(), "#FFFFFF".into());
    let second_saved = fixture
        .engine
        .save_browser_preferences(&other.browser_id, &second_input)
        .unwrap();
    assert_eq!(second_saved.run_colors[&run], "#FFFFFF");
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        workspace
    );

    let mut stale = input.clone();
    stale.mutation_id = "stale-color".into();
    stale.run_colors.insert(run.clone(), "#000000".into());
    match fixture
        .engine
        .save_browser_preferences(&fixture.browser, &stale)
    {
        Err(EngineError::UiConflict { current, .. }) => {
            assert_eq!(current["run_colors"][&run], "#aBcD09")
        }
        other => panic!("expected stale browser revision, got {other:?}"),
    }
    stale.mutation_id = input.mutation_id.clone();
    assert!(matches!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &stale),
        Err(EngineError::UiConflict { .. })
    ));
    let mut noop = input.clone();
    noop.revision = saved.revision;
    noop.mutation_id = "same-colors".into();
    assert_eq!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &noop)
            .unwrap(),
        saved
    );

    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let engine = Engine::open(path).unwrap();
    assert_eq!(
        engine
            .save_browser_preferences(&fixture.browser, &noop)
            .unwrap(),
        saved
    );
    assert_eq!(
        engine
            .ui_state(Some(&other.browser_id))
            .unwrap()
            .state
            .browser,
        second_saved
    );
    let deletion: SaveWorkspaces =
        serde_json::from_value(json!({"revision":1,"mutation_id":"delete","sets":[]})).unwrap();
    assert_eq!(
        engine
            .save_workspaces(&fixture.browser, &deletion)
            .unwrap()
            .revision,
        2
    );
    let after = engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state
        .browser;
    assert_eq!(after.revision, 2);
    assert!(after.selected.is_empty());
    assert_eq!(after.run_colors, saved.run_colors);
    assert_eq!(after.theme, saved.theme);
    assert_eq!(after.sidebar_width, saved.sidebar_width);
    assert_eq!(
        engine
            .ui_state(Some(&other.browser_id))
            .unwrap()
            .state
            .browser,
        second_saved
    );
    let mut automatic = input;
    automatic.revision = after.revision;
    automatic.mutation_id = "reset-colors".into();
    automatic.selected.clear();
    automatic.run_colors.clear();
    assert!(engine
        .save_browser_preferences(&fixture.browser, &automatic)
        .unwrap()
        .run_colors
        .is_empty());
    assert_eq!(
        engine
            .ui_state(Some(&other.browser_id))
            .unwrap()
            .state
            .browser,
        second_saved
    );
}

#[test]
fn ui_invalid_run_colors_and_failed_commit_leave_data_revision_and_retry_unchanged() {
    let fixture = Fixture::new();
    let run = fixture.engine.list_runs(Some(&fixture.experiment)).unwrap()[0]
        .id
        .clone();
    let mut input = fixture.prefs(0, "colors", "light", 280, json!({}));
    input.run_colors.insert(run.clone(), "#aBcD09".into());
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &input)
        .unwrap();
    for color in [
        "red",
        "url(https://example.test/color)",
        "#abc",
        "#12345678",
        "#GG1234",
        "123456",
        "#123456 ",
        " #123456",
        "#é1234",
    ] {
        let mut bad = input.clone();
        bad.revision = 1;
        bad.mutation_id = "invalid-color".into();
        bad.run_colors.insert(run.clone(), color.into());
        assert!(bad.validate().is_err(), "{color}");
        assert!(
            fixture
                .engine
                .save_browser_preferences(&fixture.browser, &bad)
                .is_err(),
            "{color}"
        );
    }
    for id in [
        "",
        "run_missing",
        fixture.experiment.as_str(),
        fixture.source.as_str(),
    ] {
        let mut bad = input.clone();
        bad.revision = 1;
        bad.mutation_id = "invalid-run".into();
        bad.run_colors.insert(id.into(), "#123456".into());
        assert!(
            fixture
                .engine
                .save_browser_preferences(&fixture.browser, &bad)
                .is_err(),
            "{id}"
        );
    }
    let mut changed = input.clone();
    changed.revision = 1;
    changed.mutation_id = "failed-color-commit".into();
    changed.run_colors.insert(run, "#FFFFFF".into());
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("metadata.db")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fixture_reject_browser BEFORE UPDATE ON ui_browsers
         BEGIN SELECT RAISE(ABORT, 'fixture color write failure'); END;",
        )
        .unwrap();
    assert!(matches!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &changed),
        Err(EngineError::Sqlite(_))
    ));
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .browser,
        saved
    );
    assert_eq!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &input)
            .unwrap(),
        saved
    );
    connection
        .execute_batch("DROP TRIGGER fixture_reject_browser;")
        .unwrap();
    assert_eq!(
        fixture
            .engine
            .save_browser_preferences(&fixture.browser, &changed)
            .unwrap()
            .revision,
        2
    );
}

#[test]
fn ui_run_color_capacity_is_explicit_and_never_evicts_overrides() {
    let fixture = Fixture::new();
    let mut input = fixture.prefs(0, "color-capacity", "light", 280, json!({}));
    for index in 0..MAX_UI_RUN_COLORS {
        let run = fixture
            .engine
            .create_run(&fixture.experiment, &format!("color-{index}"), "{}")
            .unwrap();
        input.run_colors.insert(run.id, format!("#{index:06x}"));
    }
    let encoded = serde_json::to_string(&input).unwrap();
    assert!(serde_json::from_str::<SaveBrowserPreferences>(&encoded).is_ok());
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &input)
        .unwrap();
    assert_eq!(saved.run_colors.len(), MAX_UI_RUN_COLORS);
    input.revision = 1;
    input.mutation_id = "over-capacity".into();
    let extra = fixture
        .engine
        .create_run(&fixture.experiment, "one-too-many", "{}")
        .unwrap();
    input.run_colors.insert(extra.id, "#000000".into());
    assert!(input.validate().is_err());
    assert!(serde_json::from_str::<SaveBrowserPreferences>(
        &serde_json::to_string(&input).unwrap()
    )
    .is_err());
    assert!(fixture
        .engine
        .save_browser_preferences(&fixture.browser, &input)
        .is_err());
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .browser,
        saved
    );
    for map in [
        r##"{"run":"#123456","run":"#abcdef"}"##,
        "null",
        "[]",
        r##"{"run":12}"##,
    ] {
        let payload = format!(
            r#"{{"revision":0,"mutation_id":"shape","theme":"light","sidebar_width":280,"selected":{{}},"run_colors":{map}}}"#
        );
        assert!(
            serde_json::from_str::<SaveBrowserPreferences>(&payload).is_err(),
            "{map}"
        );
    }
}

#[test]
fn ui_old_browser_records_gain_empty_colors_without_resetting_saved_settings() {
    let fixture = Fixture::new();
    let shared = fixture.save(fixture.input()).unwrap();
    let prefs = fixture.prefs(
        0,
        "legacy-prefs",
        "dark",
        417,
        json!({fixture.experiment.clone():"set-1"}),
    );
    let saved = fixture
        .engine
        .save_browser_preferences(&fixture.browser, &prefs)
        .unwrap();
    let run = fixture.engine.list_runs(Some(&fixture.experiment)).unwrap()[0]
        .id
        .clone();
    let mut legacy_document = serde_json::to_value(&saved).unwrap();
    legacy_document
        .as_object_mut()
        .unwrap()
        .remove("run_colors");
    let mut legacy_request = serde_json::to_value(&prefs).unwrap();
    legacy_request.as_object_mut().unwrap().remove("run_colors");
    assert!(serde_json::from_value::<SaveBrowserPreferences>(legacy_request.clone()).is_err());
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("metadata.db")).unwrap();
    connection
        .execute(
            "UPDATE ui_browsers SET document_json=?2, mutation_json=?3 WHERE browser_id=?1",
            rusqlite::params![
                fixture.browser,
                legacy_document.to_string(),
                legacy_request.to_string()
            ],
        )
        .unwrap();
    drop(connection);
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let engine = Engine::open(&path).unwrap();
    let loaded = engine.ui_state(Some(&fixture.browser)).unwrap();
    assert!(!loaded.initialized);
    assert_eq!(loaded.state.workspaces, shared);
    assert_eq!(loaded.state.browser, saved);
    assert_eq!(
        serde_json::to_value(&loaded.state.browser).unwrap()["run_colors"],
        json!({})
    );
    let mut changed = prefs;
    changed.revision = saved.revision;
    changed.mutation_id = "new-colors".into();
    changed.run_colors.insert(run, "#Fa8b00".into());
    let updated = engine
        .save_browser_preferences(&fixture.browser, &changed)
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.theme, saved.theme);
    assert_eq!(updated.sidebar_width, saved.sidebar_width);
    assert_eq!(updated.selected, saved.selected);
    drop(engine);
    let reopened = Engine::open(path).unwrap();
    assert_eq!(
        reopened
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .browser,
        updated
    );
}

#[test]
fn ui_filter_enabled_is_optional_durable_configuration_not_native_filter_wire() {
    for enabled in [None, Some(false), Some(true)] {
        let mut value = json!({"path":"/value","op":"gt","value":"1"});
        if let Some(enabled) = enabled {
            value["enabled"] = json!(enabled);
        }
        let filter: rvx_core::UiTableFilter = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(filter.enabled, enabled);
        assert_eq!(serde_json::to_value(filter).unwrap(), value);
        if enabled.is_some() {
            let request = json!({"run_ids":["run"],"path":"/rows","filters":[value]});
            assert!(serde_json::from_value::<rvx_core::TableRowsRequest>(request).is_err());
        }
    }
    for enabled in [Value::Null, json!(0), json!("false"), json!([])] {
        assert!(serde_json::from_value::<rvx_core::UiTableFilter>(
            json!({"path":"/value","op":"gt","value":"1","enabled":enabled}),
        )
        .is_err());
    }
    let fixture = Fixture::new();
    let mut value = fixture.input();
    value["sets"][0]["panels"][1]["query"]["filters"][0]["enabled"] = json!(false);
    value["sets"][0]["panels"][1]["query"]["filters"][1]["enabled"] = json!(true);
    let saved = fixture.save(value.clone()).unwrap();
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let engine = Engine::open(path).unwrap();
    assert_eq!(
        engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
    let mut stale: SaveWorkspaces = serde_json::from_value(value.clone()).unwrap();
    stale.mutation_id = "stale-filter-toggle".into();
    assert!(matches!(
        engine.save_workspaces(&fixture.browser, &stale),
        Err(EngineError::UiConflict { .. })
    ));
    value["revision"] = json!(1);
    value["mutation_id"] = json!("enable-filter");
    value["sets"][0]["panels"][1]["query"]["filters"][0]["enabled"] = json!(true);
    let enabled = engine
        .save_workspaces(&fixture.browser, &serde_json::from_value(value).unwrap())
        .unwrap();
    assert_eq!(enabled.revision, 2);
    let encoded = serde_json::to_value(enabled).unwrap();
    let filters = &encoded["sets"][0]["panels"][1]["query"]["filters"];
    assert_eq!(filters.as_array().unwrap().len(), 4);
    assert_eq!(filters[0]["enabled"], true);
    assert_eq!(filters[0]["value"], "1");
    assert!(filters[2].get("enabled").is_none());
}

#[test]
fn ui_snapshot_views_roundtrip_on_the_canonical_panel_without_losing_common_fields() {
    let fixture = Fixture::new();
    let mut input = fixture.input();
    let common = input["sets"][0]["panels"][2].clone();
    let variants = [
        json!({"type":"bar","categoryPath":"$key","valuePaths":[],"aggregation":"count","orientation":"horizontal","layout":"grouped","order":"value-desc","limit":50,"decimals":0,"unit":""}),
        json!({"type":"bar","categoryPath":"/name","valuePaths":["/n","/other"],"aggregation":"sum","orientation":"vertical","layout":"stacked","order":"value-asc","limit":1,"decimals":20,"unit":"items"}),
        json!({"type":"status-grid","idPaths":["$key"],"statusPath":"/state","labelPath":"/name","groupPath":"/stage","valuePath":"/progress","density":"compact","colors":{"":"#ABCdef","unknown":"#112233","0":"#000000"}}),
        json!({"type":"status-grid","idPaths":["/id"],"statusPath":"/state","density":"comfortable","sort":{"path":"/progress","direction":"asc"},"shadePath":"/progress","shadeScale":"log","columns":1,"cellSize":12,"gap":2}),
        json!({"type":"status-grid","idPaths":["/id"],"statusPath":"/state","density":"compact","sort":{"path":"/progress","direction":"desc"},"columns":64,"cellSize":40,"gap":12}),
    ];
    let mut revision = 0;
    for view in variants {
        input["revision"] = json!(revision);
        input["mutation_id"] = json!(format!("view-{revision}"));
        input["sets"][0]["panels"][2]["view"] = view.clone();
        let saved = fixture.save(input.clone()).unwrap();
        revision += 1;
        assert_eq!(saved.revision, revision);
        assert_eq!(fixture.save(input.clone()).unwrap(), saved);
        let mut encoded = serde_json::to_value(&saved).unwrap()["sets"][0]["panels"][2].clone();
        assert_eq!(encoded["kind"], "snapshot-table");
        assert_eq!(encoded["view"], view);
        encoded.as_object_mut().unwrap().remove("view");
        let expected: rvx_core::PanelSpec = serde_json::from_value(common.clone()).unwrap();
        assert_eq!(encoded, serde_json::to_value(expected).unwrap());
    }
    let path = fixture.directory.path().to_owned();
    let saved = fixture
        .engine
        .ui_state(Some(&fixture.browser))
        .unwrap()
        .state
        .workspaces;
    drop(fixture.engine);
    let engine = Engine::open(path).unwrap();
    assert_eq!(
        engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces,
        saved
    );
    input["revision"] = json!(0);
    input["mutation_id"] = json!("stale-view");
    assert!(matches!(
        engine.save_workspaces(
            &fixture.browser,
            &serde_json::from_value(input.clone()).unwrap()
        ),
        Err(EngineError::UiConflict { .. })
    ));
    input["revision"] = json!(revision);
    input["mutation_id"] = json!("back-to-table");
    input["sets"][0]["panels"][2]
        .as_object_mut()
        .unwrap()
        .remove("view");
    let table = engine
        .save_workspaces(&fixture.browser, &serde_json::from_value(input).unwrap())
        .unwrap();
    let encoded = serde_json::to_value(table).unwrap();
    assert!(encoded["sets"][0]["panels"][2].get("view").is_none());
    assert_eq!(encoded["sets"][0]["panels"][2]["id"], common["id"]);
}

#[test]
fn ui_snapshot_views_status_grid_optional_layout_and_sort_selectors_roundtrip_without_defaults() {
    for density in ["compact", "comfortable"] {
        let legacy =
            json!({"type":"status-grid","idPaths":["/id"],"statusPath":"/state","density":density});
        let view: rvx_core::SnapshotView = serde_json::from_value(legacy.clone()).unwrap();
        view.validate().unwrap();
        assert_eq!(serde_json::to_value(view).unwrap(), legacy);
        for path in ["", "$key", "$value", "/", "/0", "/a~1b/~0state"] {
            let mut shaded = legacy.clone();
            shaded["shadePath"] = json!(path);
            let view: rvx_core::SnapshotView = serde_json::from_value(shaded.clone()).unwrap();
            view.validate().unwrap();
            assert_eq!(serde_json::to_value(view).unwrap(), shaded);
            for direction in ["asc", "desc"] {
                let mut configured = legacy.clone();
                configured["sort"] = json!({"path":path,"direction":direction});
                let view: rvx_core::SnapshotView =
                    serde_json::from_value(configured.clone()).unwrap();
                view.validate().unwrap();
                assert_eq!(serde_json::to_value(view).unwrap(), configured);
            }
            for scale in ["linear", "log"] {
                let mut configured = legacy.clone();
                configured["shadeScale"] = json!(scale);
                let view: rvx_core::SnapshotView =
                    serde_json::from_value(configured.clone()).unwrap();
                view.validate().unwrap();
                assert_eq!(serde_json::to_value(view).unwrap(), configured);
            }
        }
        for (field, values) in [
            ("columns", [1, 64]),
            ("cellSize", [12, 40]),
            ("gap", [2, 12]),
        ] {
            for value in values {
                let mut configured = legacy.clone();
                configured[field] = json!(value);
                let view: rvx_core::SnapshotView =
                    serde_json::from_value(configured.clone()).unwrap();
                view.validate().unwrap();
                assert_eq!(serde_json::to_value(view).unwrap(), configured);
            }
        }
    }
}

#[test]
fn ui_snapshot_views_status_grid_rejects_invalid_layout_and_sort_atomically() {
    let fixture = Fixture::new();
    let status =
        json!({"type":"status-grid","idPaths":["/id"],"statusPath":"/state","density":"compact"});
    let mut input = fixture.input();
    input["sets"][0]["panels"][2]["view"] = status.clone();
    let saved = fixture.save(input.clone()).unwrap();
    input["revision"] = json!(1);
    input["mutation_id"] = json!("invalid-grid");
    let mut invalid = Vec::new();
    for (field, values) in [
        ("columns", [0, 65]),
        ("cellSize", [11, 41]),
        ("gap", [1, 13]),
    ] {
        for value in values.map(|value| json!(value)).into_iter().chain([
            json!(-1),
            json!(256),
            json!(12.5),
            Value::Null,
            json!("12"),
            json!(true),
            json!([]),
            json!({}),
        ]) {
            let mut view = status.clone();
            view[field] = value;
            invalid.push(view);
        }
    }
    for sort in [
        Value::Null,
        json!(true),
        json!(12),
        json!("asc"),
        json!([]),
        json!({}),
        json!({"path":"/id"}),
        json!({"direction":"asc"}),
        json!({"path":"/id","direction":"ascending"}),
        json!({"path":"/id","direction":null}),
        json!({"path":"/id","direction":1}),
        json!({"path":"/id","direction":"asc","unknown":true}),
        json!({"path":null,"direction":"asc"}),
        json!({"path":12,"direction":"asc"}),
    ] {
        let mut view = status.clone();
        view["sort"] = sort;
        invalid.push(view);
    }
    for path in ["id", "$unknown", "/a~2", "/a~", "/a\u{0000}", "\u{0000}"] {
        let mut view = status.clone();
        view["sort"] = json!({"path":path,"direction":"asc"});
        invalid.push(view);
        let mut view = status.clone();
        view["shadePath"] = json!(path);
        invalid.push(view);
    }
    for value in [Value::Null, json!(12), json!(true), json!([]), json!({})] {
        let mut view = status.clone();
        view["shadePath"] = value;
        invalid.push(view);
    }
    for value in [
        Value::Null,
        json!("sqrt"),
        json!(12),
        json!(true),
        json!([]),
        json!({}),
    ] {
        let mut view = status.clone();
        view["shadeScale"] = value;
        invalid.push(view);
    }
    let mut missing_density = status.clone();
    missing_density.as_object_mut().unwrap().remove("density");
    invalid.push(missing_density);
    let mut null_density = status.clone();
    null_density["density"] = Value::Null;
    invalid.push(null_density);
    let mut unknown = status;
    unknown["manualOrder"] = json!(["a", "b"]);
    invalid.push(unknown);
    for view in invalid {
        input["sets"][0]["panels"][2]["view"] = view.clone();
        assert!(fixture.save(input.clone()).is_err(), "{view}");
    }
    let path = fixture.directory.path().to_owned();
    drop(fixture.engine);
    let reopened = Engine::open(path).unwrap();
    let loaded = reopened.ui_state(Some(&fixture.browser)).unwrap();
    assert_eq!(loaded.state.workspaces, saved);
    let encoded = serde_json::to_value(loaded.state.workspaces).unwrap();
    let legacy = &encoded["sets"][0]["panels"][2]["view"];
    for field in [
        "sort",
        "columns",
        "cellSize",
        "gap",
        "shadePath",
        "shadeScale",
    ] {
        assert!(legacy.get(field).is_none(), "{field}");
    }
}

#[test]
fn ui_snapshot_views_reject_invalid_fields_types_limits_and_foreign_panel_kinds_atomically() {
    let fixture = Fixture::new();
    let bar = json!({"type":"bar","categoryPath":"/category","valuePaths":["/n"],"aggregation":"sum","orientation":"horizontal","layout":"grouped","order":"label","limit":10,"decimals":2,"unit":"items"});
    let status = json!({"type":"status-grid","idPaths":["/id"],"statusPath":"/state","labelPath":"/name","density":"comfortable","colors":{"ready":"#123456"}});
    for (base, pointer, value) in [
        (&bar, "/type", json!("table")),
        (&bar, "/type", json!("heatmap")),
        (&bar, "/categoryPath", json!("category")),
        (&bar, "/categoryPath", json!("/a~2")),
        (&bar, "/categoryPath", json!("/a\u{0000}")),
        (&bar, "/valuePaths", json!([])),
        (&bar, "/valuePaths", json!(["/n", "/n"])),
        (
            &bar,
            "/valuePaths",
            json!((0..9).map(|index| format!("/n{index}")).collect::<Vec<_>>()),
        ),
        (&bar, "/aggregation", json!("average")),
        (&bar, "/aggregation", json!("count")),
        (&bar, "/orientation", json!("diagonal")),
        (&bar, "/layout", json!("overlap")),
        (&bar, "/order", json!("timestamp")),
        (&bar, "/limit", json!(0)),
        (&bar, "/limit", json!(51)),
        (&bar, "/limit", json!(1.5)),
        (&bar, "/decimals", json!(21)),
        (&bar, "/decimals", json!(-1)),
        (&bar, "/decimals", Value::Null),
        (&bar, "/unit", json!("u".repeat(41))),
        (&status, "/idPaths", json!([])),
        (&status, "/idPaths", json!(["/id", "/id"])),
        (&status, "/idPaths", json!(["/a", "/b", "/c", "/d", "/e"])),
        (&status, "/statusPath", Value::Null),
        (&status, "/labelPath", Value::Null),
        (&status, "/density", json!("dense")),
        (&status, "/colors", Value::Null),
        (&status, "/colors", json!({"x".repeat(257):"#123456"})),
        (&status, "/colors", json!({"ready":"red"})),
        (&status, "/colors", json!({"bad\u{0000}state":"#123456"})),
        (&status, "/colors", json!({"ready":"#123"})),
        (
            &status,
            "/colors",
            json!({"ready":"url(https://example.test)"}),
        ),
    ] {
        let mut view = base.clone();
        *view.pointer_mut(pointer).unwrap() = value;
        let mut input = fixture.input();
        input["sets"][0]["panels"][2]["view"] = view;
        assert!(fixture.save(input).is_err(), "{pointer}");
    }
    let mut excessive = status.clone();
    excessive["colors"] = json!((0..129)
        .map(|index| (index.to_string(), "#112233"))
        .collect::<std::collections::BTreeMap<_, _>>());
    for view in [Value::Null, excessive] {
        let mut input = fixture.input();
        input["sets"][0]["panels"][2]["view"] = view;
        assert!(fixture.save(input).is_err());
    }
    for index in [0, 1] {
        let mut input = fixture.input();
        input["sets"][0]["panels"][index]["view"] = bar.clone();
        assert!(fixture.save(input).is_err());
    }
    let mut unknown = bar;
    unknown["raw_state"] = json!([1, 2, 3]);
    let mut input = fixture.input();
    input["sets"][0]["panels"][2]["view"] = unknown;
    assert!(fixture.save(input).is_err());
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces
            .revision,
        0
    );
}

#[test]
fn ui_browser_bootstrap_selection_validation_and_concurrent_cas_prevent_lost_updates() {
    let fixture = Fixture::new();
    for id in ["", "garbage", "browser_00000000000000000000000000000000"] {
        let input: SaveWorkspaces = serde_json::from_value(fixture.input()).unwrap();
        assert!(matches!(
            fixture.engine.save_workspaces(id, &input),
            Err(EngineError::UiBootstrap(_))
        ));
        let prefs = fixture.prefs(0, "prefs", "light", 280, json!({}));
        assert!(matches!(
            fixture.engine.save_browser_preferences(id, &prefs),
            Err(EngineError::UiBootstrap(_))
        ));
        let bootstrap = fixture.engine.ui_state(Some(id)).unwrap();
        assert!(bootstrap.initialized);
        assert_ne!(bootstrap.browser_id, id);
    }
    fixture.save(fixture.input()).unwrap();
    for selected in [
        json!({fixture.foreign_experiment.clone():"set-1"}),
        json!({fixture.experiment.clone():"missing"}),
        json!({"missing":"set-1"}),
    ] {
        let prefs = fixture.prefs(0, "bad-selection", "light", 280, selected);
        assert!(fixture
            .engine
            .save_browser_preferences(&fixture.browser, &prefs)
            .is_err());
    }
    for width in [219, 521] {
        let prefs = fixture.prefs(0, "bad-width", "light", width, json!({}));
        assert!(fixture
            .engine
            .save_browser_preferences(&fixture.browser, &prefs)
            .is_err());
    }
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .browser
            .revision,
        0
    );
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut tasks = Vec::new();
    for name in ["first", "second"] {
        let engine = fixture.engine.clone();
        let browser = fixture.browser.clone();
        let barrier = barrier.clone();
        let mut input: SaveWorkspaces = serde_json::from_value(fixture.input()).unwrap();
        input.revision = 1;
        input.mutation_id = name.into();
        input.sets[0].name = name.into();
        tasks.push(std::thread::spawn(move || {
            barrier.wait();
            engine.save_workspaces(&browser, &input)
        }));
    }
    barrier.wait();
    let results: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(EngineError::UiConflict { .. })))
            .count(),
        1
    );
    assert_eq!(
        fixture
            .engine
            .ui_state(Some(&fixture.browser))
            .unwrap()
            .state
            .workspaces
            .revision,
        2
    );
}
