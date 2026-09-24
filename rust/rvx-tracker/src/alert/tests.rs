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
    };
    assert_eq!(
        render_message(&rule, 4, &metrics, &expression, &context),
        "loss=1.23 step=4"
    );
}
