use super::super::tests::Fixture;
use super::*;
use serde_json::json;

fn records(fixture: &Fixture, mut request: Value) -> Result<SnapshotRecordsResponse> {
    request["run_ids"] = json!(fixture
        .sources
        .iter()
        .map(|source| &source.run_id)
        .collect::<BTreeSet<_>>());
    fixture.store.snapshot_records(
        &serde_json::from_value(request).unwrap(),
        &fixture.sources,
        &TableReadControl::default(),
    )
}

fn aggregate(fixture: &Fixture, mut request: Value) -> Result<SnapshotAggregateResponse> {
    request["run_ids"] = json!(fixture
        .sources
        .iter()
        .map(|source| &source.run_id)
        .collect::<BTreeSet<_>>());
    fixture.store.snapshot_aggregate(
        &serde_json::from_value(request).unwrap(),
        &fixture.sources,
        &TableReadControl::default(),
    )
}

fn base_aggregate() -> Value {
    json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"rows","op":"count"},{"id":"sum","op":"sum","path":"/n"},{"id":"min","op":"min","path":"/n"},{"id":"max","op":"max","path":"/n"}]})
}

fn category<'a>(response: &'a SnapshotAggregateResponse, name: &str) -> &'a SnapshotAggregateGroup {
    response
        .groups
        .iter()
        .find(|group| group.cells[0].text == name && group.cells[0].kind == TableCellKind::String)
        .unwrap()
}

#[test]
fn records_keep_scoped_exact_identities_across_reordering_pagination_and_pins() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let original = json!([
        {"id":"task-a","state":false},{"id":"","state":null},
        {"id":18446744073709551615u64,"state":0},{"id":"0","state":""},{"id":"false","state":"unrecognized"}
    ]);
    fixture.ingest("a", vec![(1, None, json!({"rows":original}))]);
    let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/state"]});
    let first = records(&fixture, request.clone()).unwrap();
    assert_eq!((first.table.total, first.table.limit), (5, 1000));
    assert_eq!(first.identities.iter().collect::<HashSet<_>>().len(), 5);
    assert!(first
        .table
        .rows
        .iter()
        .any(|row| row.cells["/id"].text == "18446744073709551615"));
    assert!(first
        .table
        .rows
        .iter()
        .any(|row| row.cells["/state"].kind == TableCellKind::Null));
    assert!(first
        .table
        .rows
        .iter()
        .any(|row| row.cells["/state"].kind == TableCellKind::Number
            && row.cells["/state"].text == "0"));
    let mut pages = Vec::new();
    for offset in [0, 2, 4] {
        let mut request = request.clone();
        request["offset"] = json!(offset);
        request["limit"] = json!(2);
        pages.extend(records(&fixture, request).unwrap().identities);
    }
    assert_eq!(pages, first.identities);
    let pins = json!(first
        .table
        .snapshots
        .iter()
        .map(|source| &source.snapshot_id)
        .collect::<Vec<_>>());
    let mut reversed = original.as_array().unwrap().clone();
    reversed.reverse();
    fixture.ingest("a", vec![(2, None, json!({"rows":reversed}))]);
    let latest = records(&fixture, request.clone()).unwrap();
    assert_eq!(latest.identities, first.identities);
    assert_ne!(
        latest.table.rows[0].snapshot_id,
        first.table.rows[0].snapshot_id
    );
    assert!(latest
        .table
        .rows
        .iter()
        .zip(&first.table.rows)
        .any(|(a, b)| a.row_key != b.row_key));
    let mut pinned = request;
    pinned["snapshot_ids"] = pins;
    assert_eq!(
        serde_json::to_value(records(&fixture, pinned).unwrap()).unwrap(),
        serde_json::to_value(first).unwrap()
    );
}

#[test]
fn records_validate_all_filtered_identities_and_never_use_array_positions() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(
            1,
            None,
            json!({"rows":[{"id":"a","keep":true},{"id":"b","keep":true},{"id":"b","keep":false}]}),
        )],
    );
    let request = json!({"path":"/rows","identity_paths":["/id"],"limit":1});
    assert!(records(&fixture, request.clone())
        .unwrap_err()
        .to_string()
        .contains("duplicate"));
    let mut filtered = request.clone();
    filtered["filters"] = json!([{"path":"/keep","op":"eq","value":"true"}]);
    assert_eq!(records(&fixture, filtered).unwrap().table.total, 2);
    for id in [Value::Null, json!(false), json!(1.0), json!([]), json!({})] {
        fixture.ingest("a", vec![(2, None, json!({"rows":[{"id":id}]}))]);
        assert!(records(&fixture, request.clone()).is_err(), "{id}");
    }
    fixture.ingest("a", vec![(3, None, json!({"rows":[{}]}))]);
    assert!(records(&fixture, request).is_err());
    assert!(
        records(&fixture, json!({"path":"/rows","identity_paths":["$key"]}))
            .unwrap_err()
            .to_string()
            .contains("array positions")
    );
    fixture.ingest(
        "a",
        vec![(
            4,
            None,
            json!({"rows":{"":{"state":false},"other":{"state":0}}}),
        )],
    );
    let objects = records(&fixture, json!({"path":"/rows","identity_paths":["$key"]})).unwrap();
    assert_eq!(objects.table.total, 2);
    assert!(objects.table.rows.iter().any(|row| row.row_key.is_empty()));
    fixture.ingest(
        "a",
        vec![(
            5,
            None,
            json!({"rows":[{"id":"","shard":0},{"id":"","shard":1}]}),
        )],
    );
    assert_eq!(
        records(
            &fixture,
            json!({"path":"/rows","identity_paths":["/id","/shard"]})
        )
        .unwrap()
        .table
        .total,
        2
    );
    assert!(records(&fixture, json!({"path":"/rows","identity_paths":["/id"]})).is_err());
}

#[test]
fn record_pages_use_new_limits_and_stable_identity_ties_without_changing_tables() {
    let mut fixture = Fixture::new();
    fixture.source("b", "run-b");
    fixture.source("a", "run-a");
    for id in ["a", "b"] {
        fixture.ingest(id,vec![(1,None,json!({"rows":(0..600).rev().map(|index|json!({"id":index,"same":1})).collect::<Vec<_>>()}))]);
    }
    let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id"],"sort":{"path":"/same","direction":"desc"}});
    let page = records(&fixture, request.clone()).unwrap();
    assert_eq!(
        (
            page.table.total,
            page.table.rows.len(),
            page.identities.len()
        ),
        (1200, 1000, 1000)
    );
    let mut all = request.clone();
    all["limit"] = json!(2048);
    let all = records(&fixture, all).unwrap();
    let mut natural = request.clone();
    natural.as_object_mut().unwrap().remove("sort");
    natural["limit"] = json!(2048);
    let natural = records(&fixture, natural).unwrap();
    assert_ne!(natural.identities, all.identities);
    assert!(all.table.rows[..600].iter().all(|row| row.source_id == "a"));
    assert!(all.table.rows[600..].iter().all(|row| row.source_id == "b"));
    for (index, row) in natural.table.rows.iter().enumerate() {
        assert_eq!(row.source_id, if index % 2 == 0 { "a" } else { "b" });
        assert_eq!(row.cells["/id"].text, (index / 2).to_string());
    }
    let balanced = records(
        &fixture,
        json!({"path":"/rows","identity_paths":["/id"],"columns":["/id"]}),
    )
    .unwrap();
    assert_eq!(
        balanced
            .table
            .rows
            .iter()
            .filter(|row| row.source_id == "a")
            .count(),
        500
    );
    assert_eq!(
        balanced
            .table
            .rows
            .iter()
            .filter(|row| row.source_id == "b")
            .count(),
        500
    );
    let mut bad = request;
    bad["limit"] = json!(2049);
    assert!(records(&fixture, bad).is_err());
    assert!(fixture.rows(json!({"path":"/rows","limit":1000})).is_err());
    assert_eq!(
        records(
            &fixture,
            json!({"path":"/rows","identity_paths":["/id"],
        "columns":null,"sort":null,"search":null,"snapshot_ids":null,"limit":1})
        )
        .unwrap()
        .table
        .total,
        1200
    );
}

#[test]
fn records_sort_budget_counts_decoded_identity_text_without_raising_the_limit() {
    let mut fixture = Fixture::new();
    for source in 0..5 {
        let id = format!("source_{source:032}");
        fixture.source(&id, &format!("run_{:032}", source % 2));
        fixture.ingest(
            &id,
            vec![(
                1,
                None,
                json!({"rows":(0..10_000u64).map(|index|json!({
                    "id":format!("task-{index:05}"),"n":u64::MAX-index
                })).collect::<Vec<_>>()}),
            )],
        );
    }
    let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/n"],
        "sort":{"path":"/n","direction":"asc"}});
    let page = records(&fixture, request.clone()).unwrap();
    assert_eq!((page.table.total, page.table.rows.len()), (50_000, 1000));
    assert_eq!(
        page.table.rows[0].cells["/n"].text,
        (u64::MAX - 9999).to_string()
    );
    fixture.ingest(
        &format!("source_{:032}", 0),
        vec![(
            2,
            None,
            json!({"rows":(0..10_000u64).map(|index|json!({
                "id":format!("{}task-{index:05}", "x".repeat(128)), "n":u64::MAX-index
            })).collect::<Vec<_>>()}),
        )],
    );
    assert!(records(&fixture, request)
        .unwrap_err()
        .to_string()
        .contains("64 MiB of text work"));
}

#[test]
fn records_field_sort_orders_full_filtered_dataset_exactly_across_default_page_boundaries() {
    let mut fixture = Fixture::new();
    let mut original = BTreeMap::new();
    let base = 9_007_199_254_740_992u64;
    let per_source = 1301;
    let total = 2 * per_source;
    for (source, run, parity) in [("b", "run-b", 1), ("a", "run-a", 0)] {
        fixture.source(source, run);
        let mut rows: Vec<_> = (0..per_source)
            .rev()
            .map(|id| {
                let ordinal = 2 * ((id * 17) % per_source) + parity;
                json!({"id":id,"n":base + ordinal as u64,"keep":true})
            })
            .collect();
        rows.push(json!({"id":"excluded","n":if parity == 0 { 0 } else { u64::MAX },"keep":false}));
        fixture.ingest(source, vec![(1, None, json!({"rows":rows}))]);
        original.insert(source, rows);
    }
    for direction in ["asc", "desc"] {
        let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/n"],
            "filters":[{"path":"/keep","op":"eq","value":"true"}],
            "sort":{"path":"/n","direction":direction}});
        let mut identities = Vec::new();
        for offset in [0, 1000, 2000] {
            let mut request = request.clone();
            request["offset"] = json!(offset);
            let page = records(&fixture, request).unwrap();
            assert_eq!((page.table.total, page.table.limit), (total, 1000));
            assert_eq!(page.table.offset, offset);
            assert_eq!(page.table.rows.len(), (total - offset).min(1000));
            assert_eq!(page.table.snapshots.len(), 2);
            for snapshot in &page.table.snapshots {
                assert_eq!(snapshot.row_count, per_source + 1);
                assert_eq!(snapshot.observed_at_ns, 1);
                assert_eq!(snapshot.role, "worker");
            }
            for (index, (row, identity)) in page.table.rows.iter().zip(&page.identities).enumerate()
            {
                let ordinal = if direction == "asc" {
                    offset + index
                } else {
                    total - 1 - offset - index
                };
                assert_eq!(row.cells["/n"].text, (base + ordinal as u64).to_string());
                let source = if ordinal % 2 == 0 { "a" } else { "b" };
                assert_eq!(row.source_id, source);
                assert_eq!(row.run_id, format!("run-{source}"));
                let snapshot = page
                    .table
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot.source_id == row.source_id)
                    .unwrap();
                assert_eq!(row.snapshot_id, snapshot.snapshot_id);
                assert_eq!(row.run_id, snapshot.run_id);
                let observed = &original[source][row.row_key.parse::<usize>().unwrap()];
                assert_eq!(row.cells["/id"].text, observed["id"].to_string());
                assert_eq!(row.cells["/n"].text, observed["n"].to_string());
                assert_eq!(
                    serde_json::from_str::<Value>(identity).unwrap(),
                    json!([
                        row.run_id,
                        row.source_id,
                        [["number", row.cells["/id"].text]]
                    ])
                );
            }
            identities.extend(page.identities);
        }
        assert_eq!(identities.len(), total);
        assert_eq!(identities.iter().collect::<HashSet<_>>().len(), total);
        for offset in [999, 1999] {
            let mut crossing = request.clone();
            crossing["offset"] = json!(offset);
            crossing["limit"] = json!(3);
            assert_eq!(
                records(&fixture, crossing).unwrap().identities,
                identities[offset..offset + 3]
            );
        }
    }
}

#[test]
fn records_field_sort_keeps_missing_null_and_zero_distinct_in_both_directions() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(
            1,
            None,
            json!({"rows":[{"id":9,"n":null},{"id":7,"n":0},{"id":2},
                {"id":6,"n":false},{"id":1,"n":null},{"id":0},{"id":5,"n":""}]}),
        )],
    );
    for (direction, expected) in [
        ("asc", [0, 2, 1, 9, 6, 7, 5]),
        ("desc", [5, 7, 6, 1, 9, 0, 2]),
    ] {
        let mut ids = Vec::new();
        for offset in [0, 2, 4, 6] {
            let page = records(
                &fixture,
                json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/n"],
                    "sort":{"path":"/n","direction":direction},"offset":offset,"limit":2}),
            )
            .unwrap();
            assert_eq!(page.table.total, expected.len());
            for row in page.table.rows {
                let id = row.cells["/id"].text.parse::<usize>().unwrap();
                assert_eq!(
                    row.cells["/n"].kind,
                    match id {
                        0 | 2 => TableCellKind::Missing,
                        1 | 9 => TableCellKind::Null,
                        6 => TableCellKind::Boolean,
                        7 => TableCellKind::Number,
                        5 => TableCellKind::String,
                        _ => unreachable!(),
                    }
                );
                ids.push(id);
            }
        }
        assert_eq!(ids, expected);
    }
}

#[test]
fn records_equal_sort_keys_keep_identity_order_when_sources_and_record_arrays_reverse() {
    let mut fixture = Fixture::new();
    let original = json!([
        {"id":9007199254740993u64,"same":1},{"id":10,"same":1},
        {"id":9007199254740992u64,"same":1},{"id":2,"same":1}
    ]);
    for (source, run) in [("z", "run-b"), ("b", "run-a"), ("a", "run-a")] {
        fixture.source(source, run);
        fixture.ingest(source, vec![(1, None, json!({"rows":original}))]);
    }
    let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id"]});
    let natural = records(&fixture, request.clone()).unwrap();
    let mut sorted = request.clone();
    sorted["sort"] = json!({"path":"/same","direction":"asc"});
    let first = records(&fixture, sorted.clone()).unwrap();
    assert_ne!(first.identities, natural.identities);
    let expected_ids = ["2", "10", "9007199254740992", "9007199254740993"];
    for (index, row) in first.table.rows.iter().enumerate() {
        assert_eq!(row.source_id, ["a", "b", "z"][index / 4]);
        assert_eq!(row.cells["/id"].text, expected_ids[index % 4]);
    }
    for (index, row) in natural.table.rows.iter().enumerate() {
        assert_eq!(row.source_id, ["a", "b", "z"][index % 3]);
        assert_eq!(row.cells["/id"].text, expected_ids[index / 3]);
    }
    fixture.sources.reverse();
    assert_eq!(
        serde_json::to_value(records(&fixture, sorted.clone()).unwrap()).unwrap(),
        serde_json::to_value(&first).unwrap()
    );
    let mut reversed = original.as_array().unwrap().clone();
    reversed.reverse();
    for source in ["a", "b", "z"] {
        fixture.ingest(source, vec![(2, None, json!({"rows":reversed}))]);
    }
    for direction in ["asc", "desc"] {
        sorted["sort"]["direction"] = json!(direction);
        let latest = records(&fixture, sorted.clone()).unwrap();
        assert_eq!(latest.identities, first.identities);
        for (latest, first) in latest.table.rows.iter().zip(&first.table.rows) {
            assert_eq!(latest.run_id, first.run_id);
            assert_eq!(latest.source_id, first.source_id);
            assert_eq!(latest.cells["/id"].text, first.cells["/id"].text);
            assert_ne!(latest.snapshot_id, first.snapshot_id);
            assert_ne!(latest.row_key, first.row_key);
        }
        let mut pages = Vec::new();
        for offset in [0, 5, 10] {
            let mut paged = sorted.clone();
            paged["offset"] = json!(offset);
            paged["limit"] = json!(5);
            pages.extend(records(&fixture, paged).unwrap().identities);
        }
        assert_eq!(pages, first.identities);
    }
    let latest_natural = records(&fixture, request).unwrap();
    assert_eq!(latest_natural.identities, natural.identities);
}

#[test]
fn source_interleaving_matches_complete_round_robin_for_uneven_empty_and_deep_pages() {
    for counts in [
        vec![],
        vec![0],
        vec![3],
        vec![0, 1, 3, 7],
        vec![1, 128, 0, 2],
        vec![64, 64, 64],
    ] {
        let mut identities = Vec::new();
        let mut sources = Vec::new();
        for (scope, count) in counts.iter().enumerate() {
            let mut source = Vec::new();
            for value in (0..*count).rev() {
                source.push(identities.len());
                identities.push(Identity {
                    scope,
                    parts: vec![IdentityPart::Number(value as i128)],
                    full: format!("{scope}:{value}"),
                });
            }
            source.sort_by(|a, b| identities[*a].parts.cmp(&identities[*b].parts));
            sources.push(source);
        }
        let mut expected = Vec::new();
        for rank in 0..counts.iter().copied().max().unwrap_or_default() {
            for source in &sources {
                if let Some(index) = source.get(rank) {
                    expected.push(*index);
                }
            }
        }
        for offset in 0..=identities.len() + 1 {
            for limit in [1, 2, 7, 64, 2048] {
                let page = interleaved_identity_page(
                    &identities,
                    counts.len(),
                    offset,
                    limit,
                    &TableReadControl::default(),
                )
                .unwrap();
                assert_eq!(
                    page,
                    expected
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .copied()
                        .collect::<Vec<_>>(),
                    "counts={counts:?} offset={offset} limit={limit}"
                );
            }
        }
    }
}

#[test]
fn aggregation_keeps_sources_exact_integer_sums_and_numeric_accounting() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run-a");
    fixture.source("b", "run-a");
    fixture.source("c", "run-b");
    fixture.ingest("a",vec![(1,None,json!({"rows":[
        {"category":"x","n":18446744073709551615u64},{"category":"x","n":18446744073709551615u64},
        {"category":"x","n":null},{"category":"x"},{"category":"x","n":"12"},{"category":"x","n":false}
    ]}))]);
    fixture.ingest(
        "b",
        vec![(
            1,
            None,
            json!({"rows":[{"category":"x","n":1},{"category":"y","n":100}]}),
        )],
    );
    fixture.ingest(
        "c",
        vec![(
            1,
            None,
            json!({"rows":[{"category":"y","n":2},{"category":"z"}]}),
        )],
    );
    let response = aggregate(&fixture, base_aggregate()).unwrap();
    assert_eq!((response.total_groups, response.matched_rows), (3, 10));
    let x = category(&response, "x");
    assert_eq!(x.series.len(), 2);
    let value = &x
        .series
        .iter()
        .find(|series| series.source_id == "a")
        .unwrap()
        .measures["sum"];
    assert_eq!(value.value.text, "36893488147419103230");
    assert_eq!(
        (
            value.count,
            value.missing,
            value.non_numeric,
            value.approximate
        ),
        (2, 2, 2, false)
    );
    let a = &x
        .series
        .iter()
        .find(|series| series.source_id == "a")
        .unwrap();
    assert_eq!(a.measures["rows"].value.text, "6");
    assert_eq!(a.measures["min"].value.text, "18446744073709551615");
    assert_eq!(a.measures["max"].value.text, "18446744073709551615");
    assert_eq!(
        category(&response, "z").series[0].measures["sum"]
            .value
            .kind,
        TableCellKind::Missing
    );
    let mut request = base_aggregate();
    request["order"] = json!({"measure":"sum","direction":"desc"});
    request["limit"] = json!(1);
    let first = aggregate(&fixture, request.clone()).unwrap();
    assert_eq!(first.groups[0].cells[0].text, "x");
    assert_eq!(first.groups[0].series.len(), 2);
    request["offset"] = json!(1);
    assert_eq!(
        aggregate(&fixture, request.clone()).unwrap().groups[0].cells[0].text,
        "y"
    );
    request["order"]["direction"] = json!("asc");
    request["offset"] = json!(0);
    assert_eq!(
        aggregate(&fixture, request).unwrap().groups[0].cells[0].text,
        "y"
    );
}

#[test]
fn aggregate_ranking_uses_source_maximum_not_cross_source_sums_and_pins_whole_categories() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "run");
    for (source, a, b) in [("a", 90, 60), ("b", 1, 60)] {
        let rows: Vec<_> = (0..a)
            .map(|_| json!({"category":"A"}))
            .chain((0..b).map(|_| json!({"category":"B"})))
            .collect();
        fixture.ingest(source, vec![(1, None, json!({"rows":rows}))]);
    }
    let request = json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"count","op":"count"}],"order":{"measure":"count","direction":"desc"},"limit":1});
    let first = aggregate(&fixture, request.clone()).unwrap();
    assert_eq!((first.total_groups, first.matched_rows), (2, 211));
    assert_eq!(first.groups[0].cells[0].text, "A");
    assert_eq!(
        first.groups[0]
            .series
            .iter()
            .map(|series| series.measures["count"].value.text.as_str())
            .collect::<Vec<_>>(),
        ["90", "1"]
    );
    let mut pinned = request.clone();
    pinned["snapshot_ids"] = json!(first
        .snapshots
        .iter()
        .map(|source| &source.snapshot_id)
        .collect::<Vec<_>>());
    fixture.ingest("a", vec![(2, None, json!({"rows":[{"category":"C"}]}))]);
    assert_eq!(
        serde_json::to_value(aggregate(&fixture, pinned).unwrap()).unwrap(),
        serde_json::to_value(first).unwrap()
    );
    assert_eq!(
        aggregate(&fixture, request).unwrap().groups[0].cells[0].text,
        "B"
    );
}

#[test]
fn grouping_keys_preserve_missing_null_empty_zero_and_full_values() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let long = format!("{}a", "x".repeat(1100));
    let longer = format!("{}b", "x".repeat(1100));
    fixture.ingest("a",vec![(1,None,json!({"rows":[
        {},{"category":null},{"category":false},{"category":0},{"category":""},{"category":"unknown"},
        {"category":long},{"category":longer},{"category":1},{"category":1.0},{"category":"1"}
    ]}))]);
    let response = aggregate(
        &fixture,
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"count","op":"count"}]}),
    )
    .unwrap();
    assert_eq!((response.total_groups, response.matched_rows), (10, 11));
    assert!(response
        .groups
        .iter()
        .any(|group| group.cells[0].kind == TableCellKind::Missing));
    assert!(response
        .groups
        .iter()
        .any(|group| group.cells[0].kind == TableCellKind::Null));
    assert!(response.groups.iter().any(
        |group| group.cells[0].kind == TableCellKind::String && group.cells[0].text.is_empty()
    ));
    let truncated: Vec<_> = response
        .groups
        .iter()
        .filter(|group| group.cells[0].truncated)
        .collect();
    assert_eq!(truncated.len(), 2);
    assert_eq!(truncated[0].cells[0].text, truncated[1].cells[0].text);
    assert_ne!(truncated[0].key, truncated[1].key);
    assert!(response
        .groups
        .iter()
        .any(|group| group.cells[0].kind == TableCellKind::Number
            && group.series[0].measures["count"].value.text == "2"));
    fixture.ingest(
        "a",
        vec![(
            2,
            None,
            json!({"rows":[{"category":[],"keep":false},{"category":"ok","keep":true}]}),
        )],
    );
    let mut request =
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"count","op":"count"}]});
    assert!(aggregate(&fixture, request.clone()).is_err());
    request["filters"] = json!([{"path":"/keep","op":"eq","value":"true"}]);
    assert_eq!(aggregate(&fixture, request).unwrap().matched_rows, 1);
}

#[test]
fn min_measures_keep_exact_smallest_nonzero_magnitudes_for_logarithmic_shading() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let query = json!({"path":"/rows","group_by":["/category"],"measures":[
        {"id":"count","op":"count"},{"id":"min","op":"min","path":"/n"},{"id":"max","op":"max","path":"/n"}
    ]});
    for (revision, rows, expected) in [
        (
            1,
            json!([{"category":"x","n":0},{"category":"x","n":-2},{"category":"x","n":4},{"category":"x","n":1344}]),
            "2",
        ),
        (
            2,
            json!([{"category":"x","n":-9223372036854775808i64},{"category":"x","n":9223372036854775807i64},{"category":"x","n":"0.1"}]),
            "9223372036854775807",
        ),
        (
            3,
            json!([{"category":"x","n":-0.25},{"category":"x","n":0.5},{"category":"x","n":Value::Null}]),
            "0.25",
        ),
    ] {
        fixture.ingest("a", vec![(revision, None, json!({"rows":rows}))]);
        let result = aggregate(&fixture, query.clone()).unwrap();
        let measures = &result.groups[0].series[0].measures;
        assert_eq!(
            measures["min"].minimum_magnitude.as_ref().unwrap().text,
            expected
        );
        assert!(measures["max"].minimum_magnitude.is_none());
        assert!(measures["count"].minimum_magnitude.is_none());
    }
    let tiny: Value = serde_json::from_str("-1e-1000000").unwrap();
    fixture.ingest(
        "a",
        vec![(
            4,
            None,
            json!({"rows":[{"category":"x","n":tiny},{"category":"x","n":0}]}),
        )],
    );
    assert_eq!(
        aggregate(&fixture, query.clone()).unwrap().groups[0].series[0].measures["min"]
            .minimum_magnitude
            .as_ref()
            .unwrap()
            .text,
        "1e-1000000"
    );
    fixture.ingest("a", vec![(5, None, json!({"rows":[{"category":"x","n":0},{"category":"x","n":null},{"category":"x","n":"1"}]}))]);
    assert_eq!(
        aggregate(&fixture, query).unwrap().groups[0].series[0].measures["min"]
            .minimum_magnitude
            .as_ref()
            .unwrap()
            .kind,
        TableCellKind::Missing
    );
}

#[test]
fn numeric_aggregation_is_exact_or_explicitly_approximate_and_never_silently_overflows() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let tiny: Value = serde_json::from_str("0.1000000000000000000001").unwrap();
    fixture.ingest("a",vec![(1,None,json!({"rows":[{"category":"x","n":0.1},{"category":"x","n":tiny},{"category":"x","n":"3"},{"category":"x","n":null}]}))]);
    let response = aggregate(&fixture, base_aggregate()).unwrap();
    let values = &response.groups[0].series[0].measures;
    assert_eq!(values["min"].value.text, "0.1");
    assert_eq!(values["max"].value.text, "0.1000000000000000000001");
    assert!(!values["max"].approximate);
    assert!(values["sum"].approximate);
    assert_eq!(
        (
            values["sum"].count,
            values["sum"].missing,
            values["sum"].non_numeric
        ),
        (2, 1, 1)
    );
    fixture.ingest(
        "a",
        vec![(
            2,
            None,
            json!({"rows":[{"category":"x","n":1e308},{"category":"x","n":1e308}]}),
        )],
    );
    assert!(aggregate(&fixture, base_aggregate())
        .unwrap_err()
        .to_string()
        .contains("overflow"));
    fixture.ingest("a",vec![(3,None,json!({"rows":[{"category":"x","n":1e308},{"category":"x","n":1e308},{"category":"x","n":-1e308}]}))]);
    let response = aggregate(&fixture, base_aggregate()).unwrap();
    assert_eq!(
        response.groups[0].series[0].measures["sum"]
            .value
            .text
            .parse::<f64>()
            .unwrap(),
        1e308
    );
    fixture.ingest("a",vec![(4,None,json!({"rows":[{"category":"x","n":1e308},{"category":"x","n":1},{"category":"x","n":-1e308}]}))]);
    let response = aggregate(&fixture, base_aggregate()).unwrap();
    let value = &response.groups[0].series[0].measures["sum"];
    assert!(value.approximate);
    assert!((value.value.text.parse::<f64>().unwrap() - 1.0).abs() < 1e-12);
}

#[test]
fn missing_view_fields_remain_honest_without_weakening_filters_or_native_tables() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(1, None, json!({"rows":[{"id":"a"},{"id":"b"}]}))],
    );
    let request = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/state","/label","/group","/value"]});
    let page = records(&fixture, request.clone()).unwrap();
    assert_eq!(page.table.total, 2);
    for row in &page.table.rows {
        for path in ["/state", "/label", "/group", "/value"] {
            assert_eq!(row.cells[path].kind, TableCellKind::Missing);
            assert_eq!(row.cells[path].text, "");
        }
    }
    assert!(fixture
        .rows(json!({"path":"/rows","columns":["/id","/state"]}))
        .unwrap_err()
        .to_string()
        .contains("unknown table column"));
    let mut sorted = request.clone();
    sorted["sort"] = json!({"path":"/state","direction":"asc"});
    assert!(records(&fixture, sorted.clone())
        .unwrap_err()
        .to_string()
        .contains("unknown table column"));
    let mut filtered = request.clone();
    filtered["filters"] = json!([{"path":"/state","op":"eq","value":"running"}]);
    assert!(records(&fixture, filtered.clone())
        .unwrap_err()
        .to_string()
        .contains("unknown table column"));
    let mut aggregate_request = base_aggregate();
    let grouped = aggregate(&fixture, aggregate_request.clone()).unwrap();
    assert_eq!((grouped.total_groups, grouped.matched_rows), (1, 2));
    assert_eq!(grouped.groups[0].cells[0].kind, TableCellKind::Missing);
    let sum = &grouped.groups[0].series[0].measures["sum"];
    assert_eq!((sum.count, sum.missing, sum.non_numeric), (0, 2, 0));
    assert_eq!(sum.value.kind, TableCellKind::Missing);
    aggregate_request["filters"] = json!([{"path":"/state","op":"eq","value":"running"}]);
    assert!(aggregate(&fixture, aggregate_request.clone())
        .unwrap_err()
        .to_string()
        .contains("unknown table column"));

    fixture.ingest("a", vec![(2, None, json!({"rows":[]}))]);
    for request in [request.clone(), sorted, filtered] {
        let empty = records(&fixture, request).unwrap();
        assert_eq!(
            (empty.table.total, empty.table.snapshots[0].row_count),
            (0, 0)
        );
        assert!(empty.identities.is_empty());
    }
    let empty = aggregate(&fixture, aggregate_request).unwrap();
    assert_eq!(
        (
            empty.matched_rows,
            empty.total_groups,
            empty.snapshots[0].row_count
        ),
        (0, 0, 0)
    );
    fixture.ingest("a", vec![(3, None, json!({"rows":[{}]}))]);
    assert!(records(&fixture, request)
        .unwrap_err()
        .to_string()
        .contains("identity"));
}

#[test]
fn empty_collections_are_not_confused_with_missing_paths_or_unrecorded_sources() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    assert!(aggregate(&fixture, base_aggregate())
        .unwrap_err()
        .to_string()
        .contains("no completed snapshot"));
    fixture.ingest("a", vec![(1, None, json!({"rows":[]}))]);
    let empty = aggregate(&fixture, base_aggregate()).unwrap();
    assert_eq!(
        (
            empty.total_groups,
            empty.matched_rows,
            empty.snapshots[0].row_count
        ),
        (0, 0, 0)
    );
    let page = records(
        &fixture,
        json!({"path":"/rows","identity_paths":["/id"],"columns":["/id"]}),
    )
    .unwrap();
    assert_eq!(page.table.total, 0);
    assert!(page.identities.is_empty());
    assert!(records(&fixture, json!({"path":"/rows","identity_paths":["$key"]})).is_err());
    fixture.ingest("a", vec![(2, None, json!({}))]);
    assert!(aggregate(&fixture, base_aggregate())
        .unwrap_err()
        .to_string()
        .contains("missing"));
    fixture.ingest("a", vec![(3, None, json!({"rows":null}))]);
    assert!(aggregate(&fixture, base_aggregate())
        .unwrap_err()
        .to_string()
        .contains("null"));
}

#[test]
fn catalog_kinds_are_observed_not_guessed_from_field_names() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.source("b", "run");
    fixture.ingest("a",vec![(1,None,json!({"rows":[{"duration":"slow","state":false,"n":0},{"duration":7,"state":null},{}]}))]);
    fixture.ingest(
        "b",
        vec![(
            1,
            None,
            json!({"rows":{"task":{"duration":null,"state":"alien"}}}),
        )],
    );
    let catalog = fixture.catalog();
    let rows = catalog
        .tables
        .iter()
        .find(|table| table.path == "/rows")
        .unwrap();
    assert_eq!(
        rows.collection_kinds.as_ref().unwrap(),
        &[TableCollectionKind::Array, TableCollectionKind::Object]
    );
    let duration = rows
        .columns
        .iter()
        .find(|column| column.path == "/duration")
        .unwrap()
        .kinds
        .as_ref()
        .unwrap();
    for kind in [
        TableCellKind::String,
        TableCellKind::Number,
        TableCellKind::Null,
        TableCellKind::Missing,
    ] {
        assert!(duration.contains(&kind));
    }
    let state = rows
        .columns
        .iter()
        .find(|column| column.path == "/state")
        .unwrap()
        .kinds
        .as_ref()
        .unwrap();
    assert!(state.contains(&TableCellKind::Boolean));
    assert!(!state.contains(&TableCellKind::Number));
}

#[test]
fn partial_catalog_hints_do_not_reject_valid_projected_fields_or_two_dimension_groups() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    let mut row: serde_json::Map<String, Value> = (0..150)
        .map(|index| (format!("padding_{index:03}"), json!("text")))
        .collect();
    row.insert("z_identity".into(), json!("task"));
    row.insert("zz_state".into(), json!("running"));
    row.insert("zz_shard".into(), json!(0));
    row.insert("zz_amount".into(), json!(2));
    fixture.ingest("a", vec![(1, None, json!({"rows":[row]}))]);
    let catalog = fixture.catalog();
    assert!(catalog.truncated);
    let table = catalog
        .tables
        .iter()
        .find(|table| table.path == "/rows")
        .unwrap();
    assert!(!table
        .columns
        .iter()
        .any(|column| column.path == "/z_identity"));
    let projected=records(&fixture,json!({"path":"/rows","identity_paths":["/z_identity"],"columns":["/z_identity","/zz_state"]})).unwrap();
    assert_eq!(projected.table.rows[0].cells["/zz_state"].text, "running");
    let projected = aggregate(
        &fixture,
        json!({"path":"/rows","group_by":["/zz_state","/zz_shard"],
        "search":"RUNNING","measures":[{"id":"sum","op":"sum","path":"/zz_amount"}]}),
    )
    .unwrap();
    assert_eq!(
        (
            projected.total_groups,
            projected.matched_rows,
            projected.groups[0].cells.len()
        ),
        (1, 1, 2)
    );
    assert_eq!(
        projected.groups[0].series[0].measures["sum"].value.text,
        "2"
    );
}

#[test]
fn records_enforce_response_budget_before_returning_partial_pages() {
    let mut fixture = Fixture::new();
    let row: serde_json::Map<String, Value> = (0..127)
        .map(|index| (format!("c{index}"), json!("x".repeat(1025))))
        .collect();
    for index in 0..16 {
        let id = format!("s{index}");
        fixture.source(&id, "run");
        let rows: serde_json::Map<String, Value> = (0..16)
            .map(|index| (index.to_string(), json!(row.clone())))
            .collect();
        fixture.ingest(&id, vec![(1, None, json!({"rows":rows}))]);
    }
    let error = records(
        &fixture,
        json!({"path":"/rows","identity_paths":["$key"],"limit":256}),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("response exceeds 16 MiB"),
        "{error}"
    );
    let narrow = records(
        &fixture,
        json!({"path":"/rows","identity_paths":["$key"],"columns":["/c0"],"limit":256}),
    )
    .unwrap();
    assert_eq!(
        (
            narrow.table.total,
            narrow.table.rows.len(),
            narrow.identities.len()
        ),
        (256, 256, 256)
    );
}

#[test]
fn view_queries_reject_invalid_configuration_and_honor_cancellation_and_group_budgets() {
    let mut fixture = Fixture::new();
    fixture.source("a", "run");
    fixture.ingest(
        "a",
        vec![(1, None, json!({"rows":[{"id":"x","category":"x"}]}))],
    );
    for invalid in [
        json!({"path":"/rows","group_by":[],"measures":[{"id":"c","op":"count"}]}),
        json!({"path":"/rows","group_by":["/a","/a"],"measures":[{"id":"c","op":"count"}]}),
        json!({"path":"/rows","group_by":["/a~2"],"measures":[{"id":"c","op":"count"}]}),
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"c","op":"sum"}]}),
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"c","op":"count"},{"id":"c","op":"count"}]}),
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"c","op":"count"}],"order":{"measure":"missing","direction":"asc"}}),
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"c","op":"count"}],"limit":257}),
    ] {
        assert!(aggregate(&fixture, invalid.clone()).is_err(), "{invalid}");
    }
    let control = TableReadControl::default();
    control.cancel();
    let mut request = base_aggregate();
    request["run_ids"] = json!(["run"]);
    assert!(fixture
        .store
        .snapshot_aggregate(
            &serde_json::from_value(request).unwrap(),
            &fixture.sources,
            &control
        )
        .unwrap_err()
        .to_string()
        .contains("cancelled"));
    for source in 0..5 {
        let id = format!("extra-{source}");
        fixture.source(&id, "run");
        let rows: Vec<_> = (0..10_001)
            .map(|row| json!({"category":format!("{source}-{row}")}))
            .collect();
        fixture.ingest(&id, vec![(1, None, json!({"rows":rows}))]);
    }
    let error = aggregate(
        &fixture,
        json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"c","op":"count"}]}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("50000 groups"), "{error}");
}

#[test]
#[ignore = "manual release-mode full-dataset projection timing"]
fn snapshot_views_performance_exercise() {
    let mut fixture = Fixture::new();
    for source in 0..4 {
        let id = format!("s{source}");
        fixture.source(&id, "run");
        let rows: Vec<_>=(0..12_500).map(|row|json!({"id":row,"category":format!("category-{}",row%1000),"n":row as u64+9_007_199_254_740_000})).collect();
        fixture.ingest(&id, vec![(1, None, json!({"rows":rows}))]);
    }
    let query = json!({"path":"/rows","group_by":["/category"],"measures":[{"id":"sum","op":"sum","path":"/n"},{"id":"count","op":"count"}],"order":{"measure":"sum","direction":"desc"},"limit":50});
    let records_query = json!({"path":"/rows","identity_paths":["/id"],"columns":["/id","/category","/n"],"limit":1000});
    for mode in ["aggregate", "records"] {
        let mut times = Vec::new();
        for iteration in 0..6 {
            let begin = Instant::now();
            if mode == "aggregate" {
                let output = aggregate(&fixture, query.clone()).unwrap();
                assert_eq!(
                    (
                        output.matched_rows,
                        output.total_groups,
                        output.groups.len()
                    ),
                    (50_000, 1000, 50)
                );
            } else {
                let output = records(&fixture, records_query.clone()).unwrap();
                assert_eq!(
                    (output.table.total, output.table.rows.len()),
                    (50_000, 1000)
                );
                for source in ["s0", "s1", "s2", "s3"] {
                    assert_eq!(
                        output
                            .table
                            .rows
                            .iter()
                            .filter(|row| row.source_id == source)
                            .count(),
                        250
                    );
                }
            }
            if iteration > 0 {
                times.push(begin.elapsed().as_secs_f64() * 1000.0);
            }
        }
        times.sort_by(f64::total_cmp);
        println!(
            "snapshot_view mode={mode} rows=50000 sources=4 median_ms={:.3} range_ms={:.3}..{:.3}",
            times[2], times[0], times[4]
        );
    }
}
