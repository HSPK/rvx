mod expression;
mod model;
#[cfg(test)]
mod tests;

pub use model::{AlertEvent, AlertLevel, AlertMode, AlertRule};

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde_json::Value;

use crate::{numeric_value, TrackerError};
use expression::{evaluate, touches_time, EvalContext, Expr, Parser, Tri};

const DEFAULT_WINDOW: usize = 1_024;
const MAX_WINDOW: usize = 100_000;

#[derive(Clone, Debug)]
struct Sample {
    observed_at_ns: i64,
    value: f64,
}

#[derive(Clone, Debug, Default)]
struct RuleState {
    consecutive: u64,
    fires: u64,
    firing: bool,
    last_fire_ns: Option<i64>,
}

#[derive(Clone, Debug)]
struct CompiledRule {
    rule: AlertRule,
    expression: Expr,
    state: RuleState,
}

#[derive(Clone, Debug)]
pub struct AlertEngine {
    rules: Vec<CompiledRule>,
    series: HashMap<String, VecDeque<Sample>>,
    capacity: usize,
    started_at_ns: i64,
    last_observed_at_ns: Option<i64>,
}

pub(crate) struct ManualAlert {
    pub(crate) title: String,
    pub(crate) text: String,
    pub(crate) level: AlertLevel,
    pub(crate) step: i64,
    pub(crate) observed_at_ns: i64,
    pub(crate) tags: Vec<String>,
    pub(crate) channels: Vec<String>,
}

pub(crate) struct AlertUpdate {
    samples: Vec<(String, Sample)>,
    states: Vec<RuleState>,
    events: Vec<AlertEvent>,
    last_observed_at_ns: Option<i64>,
}

impl AlertUpdate {
    pub(crate) fn events(&self) -> &[AlertEvent] {
        &self.events
    }
}

impl AlertEngine {
    pub fn new(
        rules: Vec<AlertRule>,
        started_at_ns: i64,
        capacity: usize,
    ) -> Result<Self, TrackerError> {
        let capacity = capacity.clamp(DEFAULT_WINDOW, MAX_WINDOW);
        let mut compiled = Vec::with_capacity(rules.len());
        for rule in rules {
            if rule.name.trim().is_empty() || rule.for_steps == 0 {
                return Err(TrackerError::InvalidInput(
                    "alert rule name must be nonempty and for_steps must be positive".into(),
                ));
            }
            let expression = Parser::parse(&rule.condition)?;
            compiled.push(CompiledRule {
                rule,
                expression,
                state: RuleState::default(),
            });
        }
        Ok(Self {
            rules: compiled,
            series: HashMap::new(),
            capacity,
            started_at_ns,
            last_observed_at_ns: None,
        })
    }

    #[cfg(test)]
    pub fn on_step(
        &mut self,
        step: i64,
        observed_at_ns: i64,
        metrics: &BTreeMap<String, Value>,
    ) -> Vec<AlertEvent> {
        let update = self.prepare_step(step, observed_at_ns, metrics);
        let events = update.events.clone();
        self.apply(update);
        events
    }

    pub fn manual(&self, alert: ManualAlert) -> AlertEvent {
        AlertEvent {
            rule: alert.title,
            level: alert.level,
            message: alert.text,
            step: alert.step,
            observed_at_ns: alert.observed_at_ns,
            recovered: false,
            tags: alert.tags,
            channels: alert.channels,
        }
    }

    pub fn add_rule(&mut self, rule: AlertRule) -> Result<(), TrackerError> {
        if self.rules.iter().any(|value| value.rule.name == rule.name) {
            return Err(TrackerError::InvalidInput(format!(
                "duplicate alert rule name {:?}",
                rule.name
            )));
        }
        if rule.name.trim().is_empty() || rule.for_steps == 0 {
            return Err(TrackerError::InvalidInput(
                "alert rule name must be nonempty and for_steps must be positive".into(),
            ));
        }
        let expression = Parser::parse(&rule.condition)?;
        self.rules.push(CompiledRule {
            rule,
            expression,
            state: RuleState::default(),
        });
        Ok(())
    }

    pub fn remove_rule(&mut self, name: &str) -> bool {
        let before = self.rules.len();
        self.rules.retain(|rule| rule.rule.name != name);
        before != self.rules.len()
    }

    pub fn rules(&self) -> Vec<AlertRule> {
        self.rules.iter().map(|rule| rule.rule.clone()).collect()
    }

    pub fn has_time_rules(&self) -> bool {
        self.rules.iter().any(|rule| touches_time(&rule.expression))
    }

    pub(crate) fn prepare_step(
        &self,
        step: i64,
        observed_at_ns: i64,
        metrics: &BTreeMap<String, Value>,
    ) -> AlertUpdate {
        let samples: Vec<_> = metrics
            .iter()
            .filter_map(|(name, value)| {
                numeric_value(value).map(|value| {
                    (
                        name.clone(),
                        Sample {
                            observed_at_ns,
                            value,
                        },
                    )
                })
            })
            .collect();
        self.prepare(step, observed_at_ns, metrics, samples, Some(observed_at_ns))
    }

    pub(crate) fn prepare_tick(&self, step: i64, observed_at_ns: i64) -> AlertUpdate {
        self.prepare(
            step,
            observed_at_ns,
            &BTreeMap::new(),
            Vec::new(),
            self.last_observed_at_ns,
        )
    }

    pub(crate) fn apply(&mut self, update: AlertUpdate) {
        for (name, sample) in update.samples {
            let series = self.series.entry(name).or_default();
            series.push_back(sample);
            while series.len() > self.capacity {
                series.pop_front();
            }
        }
        for (compiled, state) in self.rules.iter_mut().zip(update.states) {
            compiled.state = state;
        }
        self.last_observed_at_ns = update.last_observed_at_ns;
    }

    fn prepare(
        &self,
        step: i64,
        observed_at_ns: i64,
        metrics: &BTreeMap<String, Value>,
        samples: Vec<(String, Sample)>,
        last_observed_at_ns: Option<i64>,
    ) -> AlertUpdate {
        let pending: BTreeMap<_, _> = samples.iter().cloned().collect();
        let context = EvalContext {
            step,
            observed_at_ns,
            started_at_ns: self.started_at_ns,
            last_observed_at_ns,
            metrics,
            series: &self.series,
            pending: &pending,
        };
        let mut events = Vec::new();
        let mut states = Vec::with_capacity(self.rules.len());
        for compiled in &self.rules {
            let mut state = compiled.state.clone();
            let truth = evaluate(&compiled.expression, &context).truth();
            match truth {
                Tri::Unknown => {}
                Tri::False => {
                    state.consecutive = 0;
                    if state.firing {
                        state.firing = false;
                        if compiled.rule.notify_recovery {
                            events.push(AlertEvent {
                                rule: compiled.rule.name.clone(),
                                level: AlertLevel::Info,
                                message: format!("{} recovered", compiled.rule.name),
                                step,
                                observed_at_ns,
                                recovered: true,
                                tags: compiled.rule.tags.clone(),
                                channels: compiled.rule.channels.clone(),
                            });
                        }
                    }
                }
                Tri::True => {
                    state.consecutive = state.consecutive.saturating_add(1);
                    if state.consecutive >= compiled.rule.for_steps {
                        let edge_blocked = compiled.rule.mode == AlertMode::Edge && state.firing;
                        let cooldown_ns =
                            (compiled.rule.cooldown_seconds as i64).saturating_mul(1_000_000_000);
                        let cooling = state
                            .last_fire_ns
                            .is_some_and(|last| observed_at_ns.saturating_sub(last) < cooldown_ns);
                        let exhausted = compiled
                            .rule
                            .max_fires
                            .is_some_and(|limit| state.fires >= limit);
                        state.firing = true;
                        if !edge_blocked && !cooling && !exhausted {
                            state.fires = state.fires.saturating_add(1);
                            state.last_fire_ns = Some(observed_at_ns);
                            events.push(AlertEvent {
                                rule: compiled.rule.name.clone(),
                                level: compiled.rule.level.clone(),
                                message: render_message(
                                    &compiled.rule,
                                    step,
                                    metrics,
                                    &compiled.expression,
                                    &context,
                                ),
                                step,
                                observed_at_ns,
                                recovered: false,
                                tags: compiled.rule.tags.clone(),
                                channels: compiled.rule.channels.clone(),
                            });
                        }
                    }
                }
            }
            states.push(state);
        }
        AlertUpdate {
            samples,
            states,
            events,
            last_observed_at_ns,
        }
    }
}

fn render_message(
    rule: &AlertRule,
    step: i64,
    metrics: &BTreeMap<String, Value>,
    expression: &Expr,
    context: &EvalContext<'_>,
) -> String {
    let template = if rule.message.is_empty() {
        rule.condition.clone()
    } else {
        rule.message.clone()
    };
    let mut output = String::with_capacity(template.len());
    let mut rest = template.as_str();
    while let Some(start) = rest.find('{') {
        output.push_str(&rest[..start]);
        let Some(end) = rest[start + 1..].find('}') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let end = start + 1 + end;
        let placeholder = &rest[start + 1..end];
        let (key, format) = placeholder
            .split_once(':')
            .map_or((placeholder, None), |(key, format)| (key, Some(format)));
        let value = match key {
            "step" => Some(step.to_string()),
            "time" => Some((context.observed_at_ns as f64 / 1_000_000_000.0).to_string()),
            "expr" => Some(format!("{:?}", evaluate(expression, context))),
            key => metrics.get(key).map(|value| format_metric(value, format)),
        };
        if let Some(value) = value {
            output.push_str(&value);
        } else {
            output.push_str(&rest[start..=end]);
        }
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    output
}

fn display_metric(value: &Value) -> String {
    numeric_value(value)
        .map(|value| value.to_string())
        .unwrap_or_else(|| value.to_string())
}

fn format_metric(value: &Value, format: Option<&str>) -> String {
    let Some(number) = numeric_value(value) else {
        return display_metric(value);
    };
    let Some(format) = format else {
        return number.to_string();
    };
    let Some(precision) = format
        .strip_prefix('.')
        .and_then(|value| value.get(..value.len().saturating_sub(1)))
        .and_then(|value| value.parse::<usize>().ok())
    else {
        return number.to_string();
    };
    match format.chars().last() {
        Some('f') => format!("{number:.precision$}"),
        Some('e') => format!("{number:.precision$e}"),
        _ => number.to_string(),
    }
}
