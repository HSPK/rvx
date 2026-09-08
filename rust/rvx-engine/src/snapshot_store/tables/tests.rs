use super::*;
use serde_json::json;

#[test]
#[ignore = "manual release-mode table sorting performance exercise"]
fn table_sort_performance_exercise() {
    let mut fixture = Fixture::new();
    for source in 0..4 {
        let id = format!("s{source}");
        fixture.source(&id, "run");
        let rows: Vec<_> = (0..12_500)
            .map(|index| {
                let ordinal = source * 12_500 + index;
                let shuffled = (ordinal * 17_719) % 50_000;
                json!({"nested":{"value":9_007_199_254_740_000u64 + shuffled},"group":"keep"})
            })
            .collect();
        fixture.ingest(&id, vec![(1, None, json!({"rows":rows}))]);
    }
    let snapshots = fixture
        .store
        .table_snapshots(&fixture.sources, None, true, &TableReadControl::default())
        .unwrap();
    let records: Vec<_> = snapshots
        .iter()
        .flat_map(|snapshot| {
            collection(snapshot.snapshot.state.pointer("/rows").unwrap())
                .enumerate()
                .map(move |(position, (key, value))| Record {
                    snapshot,
                    key,
                    position,
                    value,
                })
        })
        .collect();
    for (direction, offset) in [("asc", 0), ("desc", 20_000)] {
        let payload = json!({"run_ids":["run"],"path":"/rows","columns":["/nested/value"],"sort":{"path":"/nested/value","direction":direction},"offset":offset,"limit":128});
        let request: TableRowsRequest = serde_json::from_value(payload.clone()).unwrap();
        let warm = fixture.rows(payload.clone()).unwrap();
        assert_eq!((warm.total, warm.rows.len()), (50_000, 128));
        for (index, row) in warm.rows.iter().enumerate() {
            let ordinal = if direction == "asc" {
                offset + index
            } else {
                49_999 - offset - index
            };
            assert_eq!(
                row.cells["/nested/value"].text,
                (9_007_199_254_740_000u64 + ordinal as u64).to_string(),
            );
        }
        let expected = serde_json::to_value(warm).unwrap();
        let mut ordering = Vec::new();
        let mut complete = Vec::new();
        for _ in 0..7 {
            let begin = Instant::now();
            let page = SnapshotStore::table_page_order(
                &records,
                &request,
                &mut WorkBudget::default(),
                &TableReadControl::default(),
            )
            .unwrap();
            ordering.push(begin.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(page.len(), 128);
            std::hint::black_box(page);
            let begin = Instant::now();
            let response = fixture.rows(payload.clone()).unwrap();
            complete.push(begin.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(serde_json::to_value(response).unwrap(), expected);
        }
        ordering.sort_by(f64::total_cmp);
        complete.sort_by(f64::total_cmp);
        println!("table_sort rows=50000 direction={direction} offset={offset} limit=128 ordering_median_ms={:.3} ordering_range_ms={:.3}..{:.3} complete_median_ms={:.3} complete_range_ms={:.3}..{:.3}",
            ordering[3],ordering[0],ordering[6],complete[3],complete[0],complete[6]);
    }
}

#[test]
fn decimal_numeric_keys_match_scaled_integer_oracle() {
    let mut cases = Vec::new();
    for coefficient in (-997i64..1000).step_by(197) {
        for exponent in -5i32..=5 {
            let sign = if coefficient < 0 { "-" } else { "" };
            let magnitude = coefficient.unsigned_abs();
            let token = format!(
                "{sign}{}.{:02}e{exponent}",
                magnitude / 100,
                magnitude % 100
            );
            let number: Number = serde_json::from_str(&token).unwrap();
            let exact = i128::from(coefficient) * 10i128.pow((exponent + 5) as u32);
            cases.push((number, exact));
        }
    }
    for (a, exact_a) in &cases {
        for (b, exact_b) in &cases {
            assert_eq!(compare_numbers(a, b), exact_a.cmp(exact_b), "{a} vs {b}");
        }
    }
}

#[test]
fn numeric_order_keeps_decimal_tokens_exact_without_rounding_or_underflow() {
    let ordered = [
        "-1e100",
        "-18446744073709551616.0",
        "-9223372036854775808",
        "-9007199254740993",
        "-1.0000000000000000000001",
        "-1",
        "-0.1000000000000000000001",
        "-0.1",
        "-1e-99999999999999999999999999",
        "0",
        "1e-99999999999999999999999999",
        "1e-1000000000000000000000",
        "1e-999",
        "0.1",
        "0.1000000000000000000001",
        "1",
        "1.0000000000000000000001",
        "9007199254740992",
        "9007199254740992.5",
        "9007199254740993",
        "9223372036854775807",
        "18446744073709551615",
        "18446744073709551615.1",
        "18446744073709551616.0",
        "1e100",
    ];
    let numbers: Vec<Number> = ordered
        .iter()
        .map(|token| serde_json::from_str(token).unwrap())
        .collect();
    for (a, first) in numbers.iter().enumerate() {
        for (b, second) in numbers.iter().enumerate() {
            assert_eq!(
                compare_numbers(first, second),
                a.cmp(&b),
                "{} vs {}",
                ordered[a],
                ordered[b]
            );
        }
    }
    for (a, b) in [
        ("1", "1.0"),
        ("1", "0.01e2"),
        ("1", "1000e-3"),
        ("0", "-0.0000e9999999999999999999999"),
        ("1e-9223372036854775809", "10e-9223372036854775810"),
        ("10e9223372036854775807", "1e9223372036854775808"),
        (
            "1e-99999999999999999999999999",
            "10e-100000000000000000000000000",
        ),
    ] {
        let a: Number = serde_json::from_str(a).unwrap();
        let b: Number = serde_json::from_str(b).unwrap();
        assert_eq!(compare_numbers(&a, &b), Ordering::Equal, "{a} vs {b}");
    }

    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let rows: Vec<_> = numbers
        .iter()
        .rev()
        .map(|number| json!({"n":number}))
        .collect();
    fixture.ingest("a", vec![(1, None, json!({"rows":rows}))]);
    let page = fixture.rows(json!({"path":"/rows","columns":["/n"],"sort":{"path":"/n","direction":"asc"},"limit":256})).unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.cells["/n"].text.clone())
            .collect::<Vec<_>>(),
        numbers.iter().map(Number::to_string).collect::<Vec<_>>()
    );
    let exact = fixture.rows(json!({"path":"/rows","columns":["/n"],"filters":[{"path":"/n","op":"eq","value":"0.1000000000000000000001"}]})).unwrap();
    assert_eq!(exact.total, 1);
    let range = fixture.rows(json!({"path":"/rows","columns":["/n"],"filters":[{"path":"/n","op":"gt","value":"9007199254740992.5"}],"sort":{"path":"/n","direction":"asc"},"offset":1,"limit":2})).unwrap();
    assert_eq!(range.total, 6);
    assert_eq!(range.rows[0].cells["/n"].text, "9223372036854775807");
    assert_eq!(range.rows[1].cells["/n"].text, "18446744073709551615");
}

#[test]
fn bounded_page_selection_matches_full_order_for_every_cell_kind_ties_and_sources() {
    let mut fixture = Fixture::new();
    let values = [
        None,
        Some(Value::Null),
        Some(json!(false)),
        Some(json!(true)),
        Some(json!(-9223372036854775808i64)),
        Some(json!(18446744073709551615u64)),
        Some(json!("")),
        Some(json!("alpha")),
        Some(json!([])),
        Some(json!([1, 2])),
        Some(json!({})),
        Some(json!({"a":1})),
        Some(serde_json::from_str("0.10000000000000000001").unwrap()),
    ];
    for source in ["z", "a", "m"] {
        fixture.source(source, "run");
        let rows: Vec<_> = (0..73)
            .map(|index| {
                let mut row = json!({"nested":{"a/b":{}}});
                if let Some(value) = &values[(index * 7) % values.len()] {
                    row["n"] = value.clone();
                    row["nested"]["a/b"]["~val"] = value.clone();
                }
                row
            })
            .collect();
        fixture.ingest(source, vec![(1, None, json!({"rows":rows}))]);
    }
    let snapshots = fixture
        .store
        .table_snapshots(&fixture.sources, None, true, &TableReadControl::default())
        .unwrap();
    let records: Vec<_> = snapshots
        .iter()
        .flat_map(|snapshot| {
            collection(snapshot.snapshot.state.pointer("/rows").unwrap())
                .enumerate()
                .map(move |(position, (key, value))| Record {
                    snapshot,
                    key,
                    position,
                    value,
                })
        })
        .collect();
    for path in ["/n", "$key", "/nested/a~1b/~0val"] {
        for direction in ["asc", "desc"] {
            let mut all: Vec<_> = (0..records.len()).collect();
            all.sort_by(|a, b| {
                let (a, b) = (&records[*a], &records[*b]);
                let order = SortKey::new(a.cell(path)).compare(&SortKey::new(b.cell(path)));
                let order = if direction == "desc" {
                    order.reverse()
                } else {
                    order
                };
                order.then_with(|| {
                    (&a.snapshot.run_id, &a.snapshot.source_id, a.position).cmp(&(
                        &b.snapshot.run_id,
                        &b.snapshot.source_id,
                        b.position,
                    ))
                })
            });
            for (offset, limit) in [(0, 1), (0, 256), (37, 5), (218, 20), (500, 1)] {
                let request: TableRowsRequest =
                    serde_json::from_value(json!({"run_ids":["run"],"path":"/rows",
                    "sort":{"path":path,"direction":direction},"offset":offset,"limit":limit}))
                    .unwrap();
                let page = SnapshotStore::table_page_order(
                    &records,
                    &request,
                    &mut WorkBudget::default(),
                    &TableReadControl::default(),
                )
                .unwrap();
                assert_eq!(
                    page,
                    all.iter()
                        .skip(offset)
                        .take(limit)
                        .copied()
                        .collect::<Vec<_>>(),
                    "{path} {direction} {offset} {limit}"
                );
            }
        }
    }
    let natural = fixture
        .rows(json!({"path":"/rows","columns":["/n"],"offset":72,"limit":3}))
        .unwrap();
    assert_eq!(
        natural
            .rows
            .iter()
            .map(|row| (row.source_id.as_str(), row.row_key.as_str()))
            .collect::<Vec<_>>(),
        [("a", "72"), ("m", "0"), ("m", "1")]
    );
    let request: TableRowsRequest = serde_json::from_value(
        json!({"run_ids":["run"],"path":"/rows","sort":{"path":"/n","direction":"asc"}}),
    )
    .unwrap();
    let mut exhausted = WorkBudget {
        nodes: 0,
        text_bytes: MAX_TEXT_WORK,
    };
    assert!(SnapshotStore::table_page_order(
        &records,
        &request,
        &mut exhausted,
        &TableReadControl::default()
    )
    .unwrap_err()
    .to_string()
    .contains("64 MiB"));
    let cancelled = TableReadControl::default();
    cancelled.cancel();
    assert!(SnapshotStore::table_page_order(
        &records,
        &request,
        &mut WorkBudget::default(),
        &cancelled
    )
    .unwrap_err()
    .to_string()
    .contains("cancelled"));
}

pub(super) struct Fixture {
    _directory: tempfile::TempDir,
    pub(super) store: SnapshotStore,
    pub(super) sources: Vec<Source>,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let directory = crate::test_directory().unwrap();
        let store = SnapshotStore::open(&directory.path().join("snapshots.db")).unwrap();
        Self {
            _directory: directory,
            store,
            sources: Vec::new(),
        }
    }

    pub(super) fn source(&mut self, id: &str, run: &str) {
        self.sources.push(Source {
            id: id.into(),
            run_id: run.into(),
            attempt_id: "attempt".into(),
            role: "worker".into(),
            endpoint: "http://127.0.0.1:1".into(),
            node_id: None,
            rank: None,
            state: SourceState::Active,
            source_session_id: None,
            last_success_at_ns: None,
            last_error: None,
            scrape_interval_ms: 1000,
            timeout_ms: 500,
            descriptor: None,
        });
    }

    pub(super) fn ingest(&self, id: &str, observations: Vec<(i64, Option<i64>, Value)>) {
        let source = self.sources.iter().find(|s| s.id == id).unwrap();
        let descriptor = SnapshotDescriptor {
            protocol_version: 1,
            source_session_id: "session".into(),
            project: "p".into(),
            experiment: "e".into(),
            run_id: source.run_id.clone(),
            attempt_id: "attempt".into(),
            role: "worker".into(),
            rank: None,
            node_id: None,
            pid: None,
            labels: BTreeMap::new(),
            schema_version: 1,
        };
        let start = self.store.cursor(id, "session").unwrap();
        let snapshots: Vec<_> = observations
            .into_iter()
            .enumerate()
            .map(|(i, (time, step, state))| StateSnapshot {
                source_session_id: "session".into(),
                sequence: start + i as u64,
                observed_at_ns: time,
                schema_version: 1,
                axes: step
                    .map(|s| BTreeMap::from([("step".into(), s)]))
                    .unwrap_or_default(),
                state,
            })
            .collect();
        for batch in snapshots.chunks(256) {
            self.store
                .ingest(
                    source,
                    &descriptor,
                    &SnapshotHistoryResponse {
                        protocol_version: 1,
                        source_session_id: "session".into(),
                        oldest_sequence: 0,
                        next_sequence: batch.last().unwrap().sequence + 1,
                        dropped_before: None,
                        snapshots: batch.to_vec(),
                    },
                )
                .unwrap();
        }
    }

    pub(super) fn rows(&self, payload: Value) -> Result<TableRowsResponse> {
        let mut payload = payload;
        payload["run_ids"] = json!(["run"]);
        self.store.table_rows(
            &serde_json::from_value(payload).unwrap(),
            &self.sources,
            &TableReadControl::default(),
        )
    }

    fn summary(&self, payload: Value) -> Result<TableSummaryResponse> {
        self.store.table_summary(
            &serde_json::from_value(payload).unwrap(),
            &self.sources,
            &TableReadControl::default(),
        )
    }

    pub(super) fn catalog(&self) -> TableCatalogResponse {
        self.store
            .table_catalog(&self.sources, &TableReadControl::default())
            .unwrap()
    }
}

#[test]
fn summary_uses_every_value_not_decimated_chart_points_and_never_carries_forward() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "run");
    fixture.source("no-snapshot", "run");
    fixture.ingest(
        "a",
        (0..1000)
            .map(|n| (n * 10, Some(n), json!({"n":n})))
            .collect(),
    );
    fixture.ingest("a", vec![(10_000, Some(1000), json!({"n":null}))]);
    fixture.ingest("b", vec![(20, Some(2), json!({"unrelated":8}))]);
    let result = fixture
        .summary(json!({"run_ids":["run"],"paths":["/n"]}))
        .unwrap();
    let row = &result.rows[0];
    assert_eq!((row.observations, row.count, row.missing), (1001, 1000, 1));
    assert_eq!(
        (row.minimum, row.average, row.p95, row.maximum),
        (Some(0.0), Some(499.5), Some(949.0), Some(999.0))
    );
    assert_eq!(row.current, None);
    assert_eq!(row.snapshot_id.as_deref(), Some("1001"));
    assert_eq!(row.observed_at_ns, Some(10_000));
    assert_eq!(
        (
            result.rows[1].observations,
            result.rows[1].count,
            result.rows[1].missing
        ),
        (1, 0, 1)
    );
    assert_eq!(result.rows[1].current, None);
    assert_eq!(result.rows[2].observations, 0);
    assert_eq!(result.rows[2].snapshot_id, None);
    let query = fixture
        .store
        .query(
            &serde_json::from_value(json!({
                "run_ids":["run"],"paths":["/n"],"max_points":2
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(query.series[0].values.len(), 2);
    assert_ne!(
        query.series[0]
            .values
            .iter()
            .flatten()
            .copied()
            .fold(0.0_f64, f64::max),
        999.0
    );
}

#[test]
fn summary_axis_ranges_match_query_baselines_and_actual_latest_time() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "other");
    fixture.ingest(
        "a",
        vec![
            (100, Some(30), json!({"n":3})),
            (120, None, json!({"n":100})),
            (130, Some(10), json!({"n":1})),
            (140, Some(20), json!({"n":2})),
        ],
    );
    fixture.ingest(
        "b",
        vec![
            (500, Some(10), json!({"n":8})),
            (540, Some(20), json!({"n":9})),
        ],
    );
    let elapsed = fixture
        .summary(json!({"run_ids":["run","other"],"paths":["/n"],"from":30,"to":40}))
        .unwrap();
    assert_eq!(
        (elapsed.rows[0].count, elapsed.rows[0].average),
        (2, Some(1.5))
    );
    assert_eq!(
        (elapsed.rows[1].count, elapsed.rows[1].current),
        (1, Some(9.0))
    );
    let wall = fixture.summary(json!({"run_ids":["run","other"],"paths":["/n"],"axis":"wall_time","from":120,"to":130})).unwrap();
    assert_eq!((wall.rows[0].count, wall.rows[0].average), (2, Some(50.5)));
    assert_eq!(wall.rows[1].count, 0);
    let logical = fixture
        .summary(json!({"run_ids":["run","other"],"paths":["/n"],"axis":"step","from":10,"to":30}))
        .unwrap();
    assert_eq!(
        (
            logical.rows[0].count,
            logical.rows[0].average,
            logical.rows[0].current
        ),
        (3, Some(2.0), Some(2.0))
    );
    assert_eq!(logical.rows[0].observed_at_ns, Some(140));
    assert!(fixture
        .summary(json!({"run_ids":["run"],"paths":["/n"],"from":40,"to":30}))
        .is_err());
    assert!(fixture
        .summary(json!({"run_ids":["run"],"paths":["/n"],"from":i64::MAX}))
        .is_err());
}

#[test]
fn mean_is_finite_for_extreme_finite_values() {
    assert_eq!(mean(&[f64::MAX, f64::MAX]), Some(f64::MAX));
    assert_eq!(mean(&[-f64::MAX, f64::MAX]), Some(0.0));
    assert_eq!(mean(&[0.0]), Some(0.0));
    assert_eq!(mean(&[]), None);
}

#[test]
fn summary_rejects_unindexed_or_incomplete_values_instead_of_inventing_nulls() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let wide: serde_json::Map<_, _> = (0..257).map(|n| (format!("v{n}"), json!(n))).collect();
    fixture.ingest(
        "a",
        vec![
            (0, None, json!({"wide":wide})),
            (1, None, json!({"wide":{"v0":12}})),
        ],
    );
    let error = fixture
        .summary(json!({"run_ids":["run"],"paths":["/wide/v0"]}))
        .unwrap_err();
    assert!(error.to_string().contains("coverage"), "{error}");
    assert!(fixture
        .summary(json!({"run_ids":["run"],"paths":["/wide/v0"],"from":1}))
        .is_ok());
    assert!(fixture
        .summary(json!({"run_ids":["run"],"paths":["/unknown"]}))
        .is_err());
}

#[test]
fn summary_scan_budget_is_explicit_and_narrow_ranges_succeed() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest("a", vec![(0, None, json!({"n":1}))]);
    fixture.store.connection.lock().execute_batch(&format!(
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
         INSERT INTO snapshots(run_id,source_id,source_session_id,sequence,observed_at_ns,ingested_at_ns,snapshot_json)
         SELECT 'run','a','session',n,n,0,'{{}}' FROM seq;
         INSERT INTO chart_observations SELECT id,0,'[]' FROM snapshots WHERE id>1;
         INSERT INTO chart_values SELECT id,'/n',1 FROM snapshots WHERE id>1;"
    )).unwrap();
    let error = fixture
        .summary(json!({"run_ids":["run"],"paths":["/n"]}))
        .unwrap_err();
    assert!(error.to_string().contains("budget"), "{error}");
    let narrow = fixture
        .summary(json!({"run_ids":["run"],"paths":["/n"],"from":99_990}))
        .unwrap();
    assert_eq!(narrow.rows[0].count, 11);
}

#[test]
fn catalog_handles_real_host_state_arrays_keyed_records_scalars_and_escaped_paths() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "run");
    fixture.ingest("a", vec![(0,None,json!({
        "host":"node-a", "metrics":{"cpu/percent":12.0},
        "fields":{"tasks":{"one":{"pid":1,"name":"init"},"two":{"pid":2,"name":"worker"}}},
        "collectors":{"plugin":{"up":true,"document":{"workers":[{"rank":0,"state":"busy"}]}}},
        "alerts":[{"title":"hot","level":"warning","message":"CPU"}],
        "a/b~c":[{"x/y~z":1}], "values":[1,null,"ok"], "map":{"x":2,"y":true}
    }))]);
    fixture.ingest(
        "b",
        vec![(1, None, json!({"alerts":[{"title":"ok","extra":true}]}))],
    );
    let catalog = fixture.catalog();
    assert!(!catalog.truncated);
    for path in [
        "",
        "/metrics",
        "/fields/tasks",
        "/alerts",
        "/a~1b~0c",
        "/values",
        "/map",
    ] {
        assert!(catalog.tables.iter().any(|t| t.path == path), "{path}");
    }
    assert!(!catalog
        .tables
        .iter()
        .any(|t| t.path.starts_with("/fields/tasks/")));
    let alerts = catalog.tables.iter().find(|t| t.path == "/alerts").unwrap();
    assert_eq!(alerts.sources.len(), 2);
    assert!(alerts.columns.iter().any(|c| c.path == "/extra"));
    let rows = fixture
        .store
        .table_rows(
            &serde_json::from_value(json!({
                "run_ids":["run"], "source_ids":["a"], "path":"/a~1b~0c"
            }))
            .unwrap(),
            &fixture.sources[..1],
            &TableReadControl::default(),
        )
        .unwrap();
    assert_eq!(rows.rows[0].cells["/x~1y~0z"].text, "1");
}

#[test]
fn ten_thousand_records_are_one_collection_not_ten_thousand_catalog_entries() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let workers: serde_json::Map<_, _> = (0..10_000)
        .map(|i| (format!("worker-{i}"), json!({"rank":i,"status":"busy"})))
        .collect();
    fixture.ingest("a", vec![(0, None, json!({"workers":workers}))]);
    let catalog = fixture.catalog();
    assert_eq!(catalog.tables.len(), 2);
    assert_eq!(
        catalog
            .tables
            .iter()
            .find(|t| t.path == "/workers")
            .unwrap()
            .sources[0]
            .row_count,
        10_000
    );
    let rows = fixture.rows(json!({"path":"/workers","limit":5,"offset":9995,"sort":{"path":"/rank","direction":"asc"}})).unwrap();
    assert_eq!(rows.total, 10_000);
    assert_eq!(rows.rows[0].cells["/rank"].text, "9995");
}

#[test]
fn collector_style_wrappers_expose_documents_without_expanding_task_or_gpu_records() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let tasks: Vec<_> = (0..10_000)
        .map(|rank| json!({"rank":rank,"task/name":"worker","state":null}))
        .collect();
    fixture.ingest(
        "a",
        vec![(
            0,
            None,
            json!({
                "host":"node-a","metrics":{"cpu/percent":12},"fields":{},"alerts":[],
                "collectors":{
                    "task/watch":{
                        "up":true,"stale":false,
                        "document":{
                            "tasks":tasks,
                            "queues":{
                                "queue/a":{"depth":2,"limit":10},
                                "queue~b":{"depth":0,"limit":10}
                            }
                        }
                    },
                    "gpu":{
                        "up":true,"stale":false,
                        "document":{"devices":{"gpu0":{"memory":4},"gpu1":{"memory":8}}}
                    }
                },
                "arbitrary_namespace":{
                    "member":{"healthy":true,"payload":{"items":[{"id":1}]}}
                }
            }),
        )],
    );
    let catalog = fixture.catalog();
    assert!(!catalog.truncated);
    for (path, count) in [
        ("/collectors/task~1watch/document/tasks", 10_000),
        ("/collectors/task~1watch/document/queues", 2),
        ("/collectors/gpu/document/devices", 2),
        ("/arbitrary_namespace/member/payload/items", 1),
    ] {
        let table = catalog.tables.iter().find(|t| t.path == path).unwrap();
        assert_eq!(table.sources[0].row_count, count);
        assert!(!catalog
            .tables
            .iter()
            .any(|t| t.path.starts_with(&format!("{path}/"))));
    }
    let tasks = catalog
        .tables
        .iter()
        .find(|t| t.path == "/collectors/task~1watch/document/tasks")
        .unwrap();
    assert!(tasks.columns.iter().any(|c| c.path == "/task~1name"));
    let queues = fixture
        .rows(json!({"path":"/collectors/task~1watch/document/queues"}))
        .unwrap();
    assert_eq!(queues.rows[0].row_key, "queue/a");
    assert_eq!(queues.rows[1].row_key, "queue~b");
}

#[test]
fn large_keyed_records_with_nested_values_do_not_become_wrapper_namespaces() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let workers: serde_json::Map<_, _> = (0..10_000)
        .map(|i| {
            (
                format!("worker-{i}"),
                json!({"rank":i,"details":{"queue":{"pending":i}}}),
            )
        })
        .collect();
    fixture.ingest("a", vec![(0, None, json!({"workers":workers}))]);
    let catalog = fixture.catalog();
    assert_eq!(catalog.tables.len(), 2);
    assert!(catalog.tables.iter().any(|t| t.path == "/workers"));
}

#[test]
fn array_rows_preserve_original_order_before_paging_and_for_sort_ties() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(
            1,
            None,
            json!({"rows": (0..15).map(|n| json!({"n": n, "same": 1})).collect::<Vec<_>>()}),
        )],
    );
    for payload in [
        json!({"path": "/rows", "offset": 2, "limit": 3}),
        json!({"path": "/rows", "offset": 2, "limit": 3, "sort": {"path": "/same", "direction": "asc"}}),
    ] {
        let page = fixture.rows(payload).unwrap();
        assert_eq!(
            page.rows
                .iter()
                .map(|row| row.row_key.as_str())
                .collect::<Vec<_>>(),
            ["2", "3", "4"],
        );
    }
}

#[test]
fn exact_integer_cells_sort_and_filter_before_pagination() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(
            0,
            None,
            json!({"rows":[
                {"n":18446744073709551615u64,"tag":"Keep"},
                {"n":9007199254740993u64,"tag":"KEEP"},
                {"n":9007199254740992u64,"tag":"Keep"},
                {"n":-9223372036854775808i64,"tag":"skip"},
                {"n":2,"tag":"Keep"}
            ]}),
        )],
    );
    let result = fixture.rows(json!({"path":"/rows","search":"keep","sort":{"path":"/n","direction":"asc"},"offset":1,"limit":2})).unwrap();
    assert_eq!(result.total, 4);
    assert_eq!(result.rows[0].cells["/n"].text, "9007199254740992");
    assert_eq!(result.rows[1].cells["/n"].text, "9007199254740993");
    assert_eq!(result.rows[1].cells["/n"].kind, TableCellKind::Number);
    let greater = fixture
        .rows(
            json!({"path":"/rows","filters":[{"path":"/n","op":"gt","value":"9007199254740992"}]}),
        )
        .unwrap();
    assert_eq!(greater.total, 2);
    let equal = fixture.rows(json!({"path":"/rows","filters":[{"path":"/n","op":"eq","value":"18446744073709551615"}]})).unwrap();
    assert_eq!(equal.total, 1);
    assert_eq!(equal.rows[0].row_key, "0");
    for (integer, float, order) in [
        (9007199254740993u64, 9007199254740992.0, Ordering::Greater),
        (
            18446744073709551615u64,
            18446744073709551616.0,
            Ordering::Less,
        ),
        (1u64, 1.5, Ordering::Less),
    ] {
        assert_eq!(
            compare_numbers(&Number::from(integer), &Number::from_f64(float).unwrap()),
            order
        );
    }
}

#[test]
fn pinning_freezes_schema_sort_and_page_and_rejects_incomplete_or_foreign_sets() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "run");
    fixture.ingest("a", vec![(0, None, json!({"rows":[{"n":2},{"n":1}]}))]);
    fixture.ingest("b", vec![(0, None, json!({"rows":[{"n":3}]}))]);
    let first = fixture
        .rows(json!({"path":"/rows","sort":{"path":"/n","direction":"asc"},"limit":1}))
        .unwrap();
    let pins: Vec<_> = first
        .snapshots
        .iter()
        .map(|s| s.snapshot_id.clone())
        .collect();
    fixture.ingest("a", vec![(1, None, json!({"rows":[{"changed":"new"}]}))]);
    let second = fixture.rows(json!({"path":"/rows","snapshot_ids":pins,"sort":{"path":"/n","direction":"asc"},"offset":1,"limit":2})).unwrap();
    assert_eq!(second.total, 3);
    assert_eq!(second.rows[0].cells["/n"].text, "2");
    assert_eq!(second.rows[1].cells["/n"].text, "3");
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":[]}))
        .is_err());
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":["1"]}))
        .is_err());
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":["1","1"]}))
        .is_err());
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":["1","3"]}))
        .is_err());
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":["01"]}))
        .is_err());
    assert!(fixture
        .rows(json!({"path":"/rows","snapshot_ids":["9999"]}))
        .is_err());
    let foreign = fixture
        .store
        .table_rows(
            &serde_json::from_value(json!({
                "run_ids":["run"],"source_ids":["a"],"snapshot_ids":["2"],"path":"/rows"
            }))
            .unwrap(),
            &fixture.sources[..1],
            &TableReadControl::default(),
        )
        .unwrap_err();
    assert!(foreign.to_string().contains("does not belong"));
}

#[test]
fn missing_null_empty_and_noncollections_are_honest_and_cells_are_previews() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest("a", vec![(0,None,json!({
        "null":null,"scalar":12,"empty":[],
        "rows":[{"nullable":null,"long":"é".repeat(3000),"array":[1,2,3],"object":{"nested":true}},{}],
        "values":[null,4,true],"map":{"a":7,"b":9}
    }))]);
    for path in ["/null", "/scalar", "/missing"] {
        let error = fixture.rows(json!({"path":path})).unwrap_err();
        assert!(error.to_string().contains("refresh the catalog"));
    }
    let empty = fixture.rows(json!({"path":"/empty"})).unwrap();
    assert_eq!((empty.total, empty.snapshots[0].row_count), (0, 0));
    let rows = fixture.rows(json!({"path":"/rows"})).unwrap();
    assert_eq!(rows.rows[0].cells["/nullable"].kind, TableCellKind::Null);
    assert_eq!(rows.rows[1].cells["/nullable"].kind, TableCellKind::Missing);
    for path in ["/long", "/array", "/object"] {
        assert!(rows.rows[0].cells[path].truncated);
        assert!(rows.rows[0].cells[path].text.len() <= MAX_CELL_BYTES);
    }
    assert_eq!(
        fixture.rows(json!({"path":"/values"})).unwrap().rows[1].cells["$value"].text,
        "4"
    );
    assert_eq!(
        fixture.rows(json!({"path":"/map"})).unwrap().rows[1].cells["$key"].text,
        "b"
    );
    let search = fixture
        .rows(json!({"path":"/rows","search":"nested"}))
        .unwrap();
    assert_eq!(search.total, 1);
}

#[test]
fn catalogs_truncate_but_selected_rows_and_schema_budgets_error() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let many: serde_json::Map<_, _> = (0..300)
        .map(|i| (format!("table{i}"), json!([{"n":i}])))
        .collect();
    fixture.ingest("a", vec![(0, None, Value::Object(many))]);
    let catalog = fixture.catalog();
    assert!(catalog.truncated);
    assert_eq!(catalog.tables.len(), MAX_TABLES);
    let wide: serde_json::Map<_, _> = (0..200).map(|i| (format!("c{i}"), json!(i))).collect();
    fixture.ingest("a", vec![(1, None, json!({"rows":[wide]}))]);
    assert!(fixture.catalog().truncated);
    assert!(fixture
        .rows(json!({"path":"/rows"}))
        .unwrap_err()
        .to_string()
        .contains("128"));
    let selected = fixture
        .rows(json!({"path":"/rows","columns":["/c199"]}))
        .unwrap();
    assert_eq!(selected.rows[0].cells["/c199"].text, "199");
}

#[test]
fn cancellation_is_request_local_and_does_not_poison_the_owner() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest("a", vec![(0, None, json!({"n":1,"rows":[{"n":1}]}))]);
    let control = TableReadControl::default();
    control.cancel();
    assert!(fixture
        .store
        .table_catalog(&fixture.sources, &control)
        .unwrap_err()
        .to_string()
        .contains("cancelled"));
    let mut expired = TableReadControl::default();
    expired.deadline = Instant::now() - Duration::from_secs(1);
    assert!(fixture
        .store
        .table_catalog(&fixture.sources, &expired)
        .unwrap_err()
        .to_string()
        .contains("30 seconds"));
    fixture.ingest("a", vec![(1, None, json!({"n":2,"rows":[{"n":2}]}))]);
    assert_eq!(
        fixture.rows(json!({"path":"/rows"})).unwrap().rows[0].cells["/n"].text,
        "2"
    );
    assert_eq!(
        fixture
            .summary(json!({"run_ids":["run"],"paths":["/n"]}))
            .unwrap()
            .rows[0]
            .count,
        2
    );
    let mut budget = WorkBudget {
        nodes: MAX_TABLE_NODES,
        text_bytes: 0,
    };
    assert!(budget.visit(&TableReadControl::default()).is_err());
    assert!(budget.text(MAX_TEXT_WORK + 1).is_err());
}

#[test]
fn cancelled_reader_waits_for_the_same_store_lock_without_interrupting_its_owner() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest("a", vec![(0, None, json!({"rows":[1]}))]);
    let control = TableReadControl::default();
    let held = fixture.store.connection.lock();
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| fixture.store.table_catalog(&fixture.sources, &control));
        control.cancel();
        assert_eq!(
            held.query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(held);
        assert!(reader
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
    });
    assert_eq!(fixture.rows(json!({"path":"/rows"})).unwrap().total, 1);
}

#[test]
fn complete_snapshot_and_response_budgets_never_return_partial_totals() {
    let mut fixture = Fixture::new();
    let row: serde_json::Map<_, _> = (0..127)
        .map(|i| (format!("c{i}"), json!("x".repeat(1025))))
        .collect();
    for i in 0..16 {
        let id = format!("s{i}");
        fixture.source(&id, "run");
        fixture.ingest(&id, vec![(0, None, json!({"rows":vec![row.clone();16]}))]);
    }
    let error = fixture
        .rows(json!({"path":"/rows","limit":256}))
        .unwrap_err();
    assert!(
        error.to_string().contains("response exceeds 16 MiB"),
        "{error}"
    );
    let narrower = fixture
        .rows(json!({"path":"/rows","limit":256,"columns":["/c0"]}))
        .unwrap();
    assert_eq!(
        (
            narrower.total,
            narrower.rows.len(),
            narrower.snapshots.len()
        ),
        (256, 256, 16)
    );
    for i in 0..16 {
        fixture.ingest(
            &format!("s{i}"),
            vec![(1, None, json!({"rows":vec![Value::Null;70_000]}))],
        );
    }
    let error = fixture.rows(json!({"path":"/rows","limit":1})).unwrap_err();
    assert!(
        error.to_string().contains("1000000 visited nodes"),
        "{error}"
    );
}

#[test]
fn snapshot_byte_budget_and_absent_sources_are_errors_not_source_dropping() {
    let mut fixture = Fixture::new();
    fixture.source("empty", "run");
    assert!(fixture
        .rows(json!({"path":""}))
        .unwrap_err()
        .to_string()
        .contains("no completed snapshot"));
    fixture.sources.clear();
    let state = json!({"rows":[1],"large":"x".repeat(MAX_SNAPSHOT_BYTES-4096)});
    for i in 0..17 {
        let id = format!("s{i}");
        fixture.source(&id, "run");
        fixture.ingest(&id, vec![(0, None, state.clone())]);
    }
    let error = fixture.rows(json!({"path":"/rows","limit":1})).unwrap_err();
    assert!(error.to_string().contains("scan exceeds 64 MiB"), "{error}");
}

#[test]
fn invalid_requests_are_rejected_not_treated_as_partial_work() {
    assert!(validate_selection(&[], &[]).is_err());
    assert!(validate_selection(&["run".into(), "run".into()], &[]).is_err());
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest("a", vec![(0, None, json!({"rows":[{"n":1}]}))]);
    for payload in [
        json!({"path":"rows"}),
        json!({"path":"/a~2b"}),
        json!({"path":"/rows","limit":0}),
        json!({"path":"/rows","limit":257}),
        json!({"path":"/rows","columns":[]}),
        json!({"path":"/rows","columns":["/n","/n"]}),
        json!({"path":"/rows","columns":["/unknown"]}),
        json!({"path":"/rows","sort":{"path":"/unknown","direction":"asc"}}),
        json!({"path":"/rows","filters":[{"path":"/n","op":"gt","value":"NaN"}]}),
        json!({"path":"/rows","filters":[{"path":"/n","op":"gt","value":"1e999"}]}),
        json!({"path":"/rows","filters":[{"path":"/n","op":"lt","value":"-1e999"}]}),
        json!({"path":"/rows","filters":[{"path":"/n","op":"eq","value":"1e999"}]}),
        json!({"path":"/rows","search":"x".repeat(4097)}),
    ] {
        assert!(fixture.rows(payload.clone()).is_err(), "{payload}");
    }
}
