use super::*;

fn metrics(values: &[(&str, f64)]) -> BTreeMap<String, Value> {
    values
        .iter()
        .map(|(name, value)| ((*name).into(), Value::from(*value)))
        .collect()
}

#[test]
fn parses_windows_and_fires_after_persistence() {
    let mut engine = AlertEngine::new(
        vec![AlertRule {
            name: "spike".into(),
            condition: "loss > mean(loss[3]) * 1.5".into(),
            level: AlertLevel::Error,
            message: "loss spike at {step}".into(),
            mode: AlertMode::Edge,
            for_steps: 2,
            for_duration_ms: 0,
            partial_window: true,
            axis: RuleAxis::WallTime,
            cooldown_seconds: 0,
            max_fires: None,
            notify_recovery: true,
            tags: vec![],
            channels: vec![],
        }],
        0,
        1024,
    )
    .unwrap();
    assert!(engine.on_step(0, 1, &metrics(&[("loss", 1.0)])).is_empty());
    assert!(engine.on_step(1, 2, &metrics(&[("loss", 5.0)])).is_empty());
    let events = engine.on_step(2, 3, &metrics(&[("loss", 9.0)]));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].rule, "spike");
    let recovery = engine.on_step(3, 4, &metrics(&[("loss", 1.0)]));
    assert!(recovery.iter().any(|event| event.recovered));
}

#[test]
fn nonfinite_predicates_and_three_valued_logic_are_explicit() {
    let expression = Parser::parse("isnan(loss) or missing > 1").unwrap();
    let metrics = BTreeMap::from([("loss".into(), serde_json::json!({"$rvx.nonfinite":"nan"}))]);
    let context = EvalContext {
        step: 1,
        observed_at_ns: 1,
        started_at_ns: 0,
        last_observed_at_ns: Some(1),
        metrics: &metrics,
        series: &HashMap::new(),
        pending: &BTreeMap::new(),
        partial_window: false,
        axis: RuleAxis::WallTime,
        tick: false,
    };
    assert_eq!(evaluate(&expression, &context).truth(), Tri::True);
}

#[test]
fn chained_comparisons_preserve_mathematical_semantics() {
    let expression = Parser::parse("0 < loss < 2").unwrap();
    let metrics = metrics(&[("loss", 1.0)]);
    let context = EvalContext {
        step: 1,
        observed_at_ns: 1,
        started_at_ns: 0,
        last_observed_at_ns: Some(1),
        metrics: &metrics,
        series: &HashMap::new(),
        pending: &BTreeMap::new(),
        partial_window: false,
        axis: RuleAxis::WallTime,
        tick: false,
    };
    assert_eq!(evaluate(&expression, &context).truth(), Tri::True);
}

#[test]
fn message_templates_support_numeric_precision() {
    let rule = AlertRule {
        name: "loss".into(),
        condition: "loss > 0".into(),
        level: AlertLevel::Warning,
        message: "loss={loss:.2f} step={step}".into(),
        mode: AlertMode::Edge,
        for_steps: 1,
        for_duration_ms: 0,
        partial_window: false,
        axis: RuleAxis::WallTime,
        cooldown_seconds: 0,
        max_fires: None,
        notify_recovery: false,
        tags: vec![],
        channels: vec![],
    };
    let expression = Parser::parse(&rule.condition).unwrap();
    let metrics = metrics(&[("loss", 1.234)]);
    let context = EvalContext {
        step: 4,
        observed_at_ns: 1,
        started_at_ns: 0,
        last_observed_at_ns: Some(1),
        metrics: &metrics,
        series: &HashMap::new(),
        pending: &BTreeMap::new(),
        partial_window: false,
        axis: RuleAxis::WallTime,
        tick: false,
    };
    assert_eq!(
        render_message(&rule, 4, &metrics, &expression, &context),
        "loss=1.23 step=4"
    );
}

#[test]
fn windows_need_full_coverage_and_invalid_rules_fail_at_construction() {
    for condition in [
        "meen(loss[2]) > 0",
        "mean() > 0",
        "rate(loss) > 0",
        "loss[100001] > 0",
    ] {
        assert!(AlertEngine::new(vec![AlertRule::parse(condition, 0).unwrap()], 0, 1024).is_err());
    }
    let mut engine = AlertEngine::new(
        vec![AlertRule::parse("mean(loss[3]) > 0", 0).unwrap()],
        0,
        3,
    )
    .unwrap();
    assert!(engine.on_step(0, 1, &metrics(&[("loss", 1.0)])).is_empty());
    assert!(engine.on_step(1, 2, &metrics(&[("loss", 2.0)])).is_empty());
    assert_eq!(engine.on_step(2, 3, &metrics(&[("loss", 3.0)])).len(), 1);
}

#[test]
fn timer_ticks_do_not_count_as_training_steps_and_duration_has_its_own_clock() {
    let mut rule = AlertRule::parse("loss > 1", 0).unwrap();
    rule.for_steps = 2;
    let mut engine = AlertEngine::new(vec![rule], 0, 10).unwrap();
    assert!(engine.on_step(0, 1, &metrics(&[("loss", 2.0)])).is_empty());
    for time in 2..5 {
        let update = engine.prepare_tick(0, time);
        assert!(update.events().is_empty());
        engine.apply(update);
    }
    assert!(engine.on_step(0, 5, &metrics(&[("loss", 2.0)])).is_empty());
    assert_eq!(engine.on_step(1, 6, &metrics(&[("loss", 2.0)])).len(), 1);
    let mut rule = AlertRule::parse("no_data(1s)", 0).unwrap();
    rule.for_duration_ms = 1000;
    let mut engine = AlertEngine::new(vec![rule], 0, 10).unwrap();
    let early = engine.prepare_tick(0, 1_000_000_000);
    assert!(early.events().is_empty());
    engine.apply(early);
    assert_eq!(engine.prepare_tick(0, 2_000_000_000).events().len(), 1);
}

#[test]
fn replay_and_online_share_time_based_rate_and_nonfinite_semantics() {
    let rule = AlertRule::parse("rate(loss[2]) > 1", 0).unwrap();
    let input = vec![
        ReplayInput::Step {
            step: 0,
            observed_at_ns: 1_000_000_000,
            metrics: metrics(&[("loss", 0.0)]),
        },
        ReplayInput::Step {
            step: 10,
            observed_at_ns: 5_000_000_000,
            metrics: metrics(&[("loss", 8.0)]),
        },
    ];
    let events = replay(vec![rule.clone()], 0, 10, input).unwrap();
    assert_eq!(events.len(), 1);
    let mut engine = AlertEngine::new(vec![rule], 0, 10).unwrap();
    engine.on_step(0, 1_000_000_000, &metrics(&[("loss", 0.0)]));
    assert_eq!(
        engine.on_step(10, 5_000_000_000, &metrics(&[("loss", 8.0)])),
        events
    );
    let mut rule = AlertRule::parse("rate(loss[2]) > 1", 0).unwrap();
    rule.axis = RuleAxis::Step;
    let mut engine = AlertEngine::new(vec![rule], 0, 10).unwrap();
    engine.on_step(0, 1, &metrics(&[("loss", 0.0)]));
    assert!(engine.on_step(10, 2, &metrics(&[("loss", 8.0)])).is_empty());
    assert!(Parser::parse("not loss > 0").is_ok());
}

#[test]
fn duration_comparisons_and_not_use_the_declared_time_and_boolean_semantics() {
    let rule = AlertRule::parse("age(loss) >= 1s and not loss < 1", 0).unwrap();
    let events = replay(
        vec![rule],
        0,
        10,
        vec![
            ReplayInput::Step {
                step: 0,
                observed_at_ns: 0,
                metrics: metrics(&[("loss", 2.0)]),
            },
            ReplayInput::Tick {
                step: 0,
                observed_at_ns: 500_000_000,
            },
            ReplayInput::Tick {
                step: 0,
                observed_at_ns: 1_000_000_000,
            },
        ],
    )
    .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].observed_at_ns, 1_000_000_000);
}
