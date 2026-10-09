use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use serde_json::Value;

use crate::numeric_value;

use super::super::RuleAxis;
use super::super::Sample;
use super::syntax::{BinaryOp, Expr, UnaryOp, Window};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tri {
    False,
    True,
    Unknown,
}

impl Tri {
    fn not(self) -> Self {
        match self {
            Self::False => Self::True,
            Self::True => Self::False,
            Self::Unknown => Self::Unknown,
        }
    }

    fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        }
    }

    fn or(self, other: Self) -> Self {
        match (self, other) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Evaluated {
    Number(f64),
    Bool(Tri),
    Duration(i64),
    Series(Vec<Sample>),
    Unknown,
}

impl Evaluated {
    pub(crate) fn truth(&self) -> Tri {
        match self {
            Self::Bool(value) => *value,
            Self::Number(value) if value.is_finite() => {
                if *value == 0.0 {
                    Tri::False
                } else {
                    Tri::True
                }
            }
            _ => Tri::Unknown,
        }
    }

    fn number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            Self::Duration(value) => Some(*value as f64 / 1_000_000_000.0),
            _ => None,
        }
    }

    fn values(&self) -> Vec<f64> {
        match self {
            Self::Number(value) => vec![*value],
            Self::Series(values) => values.iter().map(|sample| sample.value).collect(),
            _ => Vec::new(),
        }
    }
}

pub(crate) struct EvalContext<'a> {
    pub(crate) step: i64,
    pub(crate) observed_at_ns: i64,
    pub(crate) started_at_ns: i64,
    pub(crate) last_observed_at_ns: Option<i64>,
    pub(crate) metrics: &'a BTreeMap<String, Value>,
    pub(crate) series: &'a HashMap<String, Arc<VecDeque<Sample>>>,
    pub(crate) pending: &'a BTreeMap<String, Sample>,
    pub(crate) partial_window: bool,
    pub(crate) axis: RuleAxis,
    pub(crate) tick: bool,
}

pub(crate) fn evaluate(expression: &Expr, context: &EvalContext<'_>) -> Evaluated {
    match expression {
        Expr::Number(value) => Evaluated::Number(*value),
        Expr::Duration(value) => Evaluated::Duration(*value),
        Expr::Metric(name, window) => metric_value(name, window.as_ref(), context),
        Expr::Call(name, arguments) => evaluate_call(name, arguments, context),
        Expr::Unary(operation, value) => {
            let value = evaluate(value, context);
            match operation {
                UnaryOp::Neg => value
                    .number()
                    .map(|value| Evaluated::Number(-value))
                    .unwrap_or(Evaluated::Unknown),
                UnaryOp::Pos => value
                    .number()
                    .map(Evaluated::Number)
                    .unwrap_or(Evaluated::Unknown),
                UnaryOp::Not => Evaluated::Bool(value.truth().not()),
            }
        }
        Expr::Binary(operation, left, right) => {
            let left = evaluate(left, context);
            let right = evaluate(right, context);
            evaluate_binary(*operation, left, right)
        }
    }
}

fn metric_value(name: &str, window: Option<&Window>, context: &EvalContext<'_>) -> Evaluated {
    let current = context
        .pending
        .get(name)
        .map(|sample| sample.value)
        .or_else(|| context.metrics.get(name).and_then(numeric_value));
    if window.is_none() {
        return current
            .or_else(|| {
                if context.tick {
                    context
                        .series
                        .get(name)
                        .and_then(|series| series.back())
                        .map(|sample| sample.value)
                } else {
                    None
                }
            })
            .map(Evaluated::Number)
            .unwrap_or(Evaluated::Unknown);
    }
    let stored = context.series.get(name);
    let pending = context.pending.get(name);
    let length = stored.map_or(0, |s| s.len()) + usize::from(pending.is_some());
    if matches!(window, Some(Window::Points(points)) if !context.partial_window && length < *points)
    {
        return Evaluated::Unknown;
    }
    let skip = match window {
        Some(Window::Points(points)) => length.saturating_sub(*points),
        _ => 0,
    };
    let mut values: Vec<_> = stored
        .into_iter()
        .flat_map(|series| series.iter())
        .chain(pending)
        .skip(skip)
        .cloned()
        .collect();
    let values = match window.unwrap() {
        Window::Points(_) => values,
        Window::Duration(duration) => {
            let start = context.observed_at_ns.saturating_sub(*duration);
            if !context.partial_window && !values.first().is_some_and(|s| s.observed_at_ns <= start)
            {
                return Evaluated::Unknown;
            }
            values.retain(|sample| sample.observed_at_ns >= start);
            values
        }
    };
    Evaluated::Series(values)
}

fn evaluate_binary(operation: BinaryOp, left: Evaluated, right: Evaluated) -> Evaluated {
    match operation {
        BinaryOp::And => Evaluated::Bool(left.truth().and(right.truth())),
        BinaryOp::Or => Evaluated::Bool(left.truth().or(right.truth())),
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
            let (Some(left), Some(right)) = (left.number(), right.number()) else {
                return Evaluated::Unknown;
            };
            let value = match operation {
                BinaryOp::Add => left + right,
                BinaryOp::Sub => left - right,
                BinaryOp::Mul => left * right,
                BinaryOp::Div if right != 0.0 => left / right,
                BinaryOp::Mod if right != 0.0 => left % right,
                _ => return Evaluated::Unknown,
            };
            if value.is_finite() {
                Evaluated::Number(value)
            } else {
                Evaluated::Unknown
            }
        }
        _ => {
            let (Some(left), Some(right)) = (left.number(), right.number()) else {
                return Evaluated::Bool(Tri::Unknown);
            };
            if !left.is_finite() || !right.is_finite() {
                return Evaluated::Bool(Tri::Unknown);
            }
            let result = match operation {
                BinaryOp::Eq => left == right,
                BinaryOp::Ne => left != right,
                BinaryOp::Lt => left < right,
                BinaryOp::Le => left <= right,
                BinaryOp::Gt => left > right,
                BinaryOp::Ge => left >= right,
                _ => unreachable!(),
            };
            Evaluated::Bool(if result { Tri::True } else { Tri::False })
        }
    }
}

fn evaluate_call(name: &str, arguments: &[Expr], context: &EvalContext<'_>) -> Evaluated {
    let name = name.to_ascii_lowercase();
    if name == "step" {
        return Evaluated::Number(context.step as f64);
    }
    if name == "elapsed" {
        return Evaluated::Number(
            context.observed_at_ns.saturating_sub(context.started_at_ns) as f64 / 1_000_000_000.0,
        );
    }
    if name == "no_data" {
        let duration = arguments
            .first()
            .map(|value| evaluate(value, context))
            .and_then(|value| match value {
                Evaluated::Duration(value) => Some(value),
                Evaluated::Number(value) if value.is_finite() => {
                    Some((value * 1_000_000_000.0) as i64)
                }
                _ => None,
            });
        let result = duration.is_some_and(|duration| {
            context
                .last_observed_at_ns
                .unwrap_or(context.started_at_ns)
                .saturating_add(duration)
                <= context.observed_at_ns
        });
        return Evaluated::Bool(if result { Tri::True } else { Tri::False });
    }
    let first = match (name.as_str(), arguments.first()) {
        ("diff", Some(Expr::Metric(metric, None))) => {
            metric_value(metric, Some(&Window::Points(2)), context)
        }
        (_, Some(value)) => evaluate(value, context),
        _ => Evaluated::Unknown,
    };
    if name == "isnan" {
        return Evaluated::Bool(match first.number() {
            Some(value) if value.is_nan() => Tri::True,
            Some(_) => Tri::False,
            None => Tri::Unknown,
        });
    }
    if name == "isinf" {
        return Evaluated::Bool(match first.number() {
            Some(value) if value.is_infinite() => Tri::True,
            Some(_) => Tri::False,
            None => Tri::Unknown,
        });
    }
    if name == "has" {
        let present = match arguments.first() {
            Some(Expr::Metric(metric, _)) => {
                context.pending.contains_key(metric)
                    || context.metrics.contains_key(metric)
                    || context.tick && context.series.contains_key(metric)
            }
            _ => !matches!(first, Evaluated::Unknown),
        };
        return Evaluated::Bool(if present { Tri::True } else { Tri::False });
    }
    if name == "age" {
        let Some(Expr::Metric(metric, _)) = arguments.first() else {
            return Evaluated::Unknown;
        };
        return context
            .pending
            .get(metric)
            .or_else(|| context.series.get(metric).and_then(|series| series.back()))
            .map(|sample| {
                Evaluated::Number(
                    context.observed_at_ns.saturating_sub(sample.observed_at_ns) as f64
                        / 1_000_000_000.0,
                )
            })
            .unwrap_or(Evaluated::Unknown);
    }
    let values = first.values();
    if matches!(first, Evaluated::Unknown) {
        return Evaluated::Unknown;
    }
    if name != "count" && values.iter().any(|value| !value.is_finite()) {
        return Evaluated::Unknown;
    }
    let finite: Vec<_> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    match name.as_str() {
        "count" => Evaluated::Number(values.len() as f64),
        "sum" if !finite.is_empty() => Evaluated::Number(finite.iter().sum()),
        "mean" if !finite.is_empty() => {
            Evaluated::Number(finite.iter().sum::<f64>() / finite.len() as f64)
        }
        "median" if !finite.is_empty() => {
            let mut values = finite.clone();
            values.sort_by(f64::total_cmp);
            let middle = values.len() / 2;
            Evaluated::Number(if values.len() % 2 == 0 {
                (values[middle - 1] + values[middle]) / 2.0
            } else {
                values[middle]
            })
        }
        "min" if !finite.is_empty() => {
            Evaluated::Number(finite.iter().copied().fold(f64::INFINITY, f64::min))
        }
        "max" if !finite.is_empty() => {
            Evaluated::Number(finite.iter().copied().fold(f64::NEG_INFINITY, f64::max))
        }
        "first" if !values.is_empty() => Evaluated::Number(values[0]),
        "last" if !values.is_empty() => Evaluated::Number(*values.last().unwrap()),
        "diff" if values.len() >= 2 => {
            Evaluated::Number(values.last().unwrap() - values.first().unwrap())
        }
        "pct_change" if values.len() >= 2 && values[0] != 0.0 => {
            Evaluated::Number((values.last().unwrap() - values[0]) / values[0])
        }
        "rate" | "slope" if values.len() >= 2 => trend(&first, context.axis, name == "rate"),
        "var" | "std" if finite.len() >= 2 => {
            let mean = finite.iter().sum::<f64>() / finite.len() as f64;
            let variance = finite
                .iter()
                .map(|value| (value - mean).powi(2))
                .sum::<f64>()
                / finite.len() as f64;
            Evaluated::Number(if name == "std" {
                variance.sqrt()
            } else {
                variance
            })
        }
        "zscore" if finite.len() >= 2 => {
            let mean = finite.iter().sum::<f64>() / finite.len() as f64;
            let variance = finite
                .iter()
                .map(|value| (value - mean).powi(2))
                .sum::<f64>()
                / finite.len() as f64;
            let std = variance.sqrt();
            if std == 0.0 {
                Evaluated::Unknown
            } else {
                Evaluated::Number((finite.last().unwrap() - mean) / std)
            }
        }
        "ema" if !finite.is_empty() => {
            let alpha = arguments
                .get(1)
                .map(|value| evaluate(value, context))
                .and_then(|value| value.number())
                .unwrap_or(0.2);
            if !(0.0..=1.0).contains(&alpha) {
                return Evaluated::Unknown;
            }
            let mut ema = finite[0];
            for value in &finite[1..] {
                ema = alpha * value + (1.0 - alpha) * ema;
            }
            Evaluated::Number(ema)
        }
        "increasing" if finite.len() >= 2 => {
            Evaluated::Bool(if finite.windows(2).all(|pair| pair[1] > pair[0]) {
                Tri::True
            } else {
                Tri::False
            })
        }
        "decreasing" if finite.len() >= 2 => {
            Evaluated::Bool(if finite.windows(2).all(|pair| pair[1] < pair[0]) {
                Tri::True
            } else {
                Tri::False
            })
        }
        "stalled" if finite.len() >= 2 => {
            let epsilon = arguments
                .get(1)
                .map(|value| evaluate(value, context))
                .and_then(|value| value.number())
                .unwrap_or(0.0);
            let low = finite.iter().copied().fold(f64::INFINITY, f64::min);
            let high = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            Evaluated::Bool(if high - low <= epsilon {
                Tri::True
            } else {
                Tri::False
            })
        }
        _ => Evaluated::Unknown,
    }
}

pub(crate) fn touches_time(expression: &Expr) -> bool {
    match expression {
        Expr::Call(name, arguments) => {
            matches!(name.as_str(), "no_data" | "age" | "elapsed")
                || arguments.iter().any(touches_time)
        }
        Expr::Unary(_, value) => touches_time(value),
        Expr::Binary(_, left, right) => touches_time(left) || touches_time(right),
        _ => false,
    }
}

fn trend(series: &Evaluated, axis: RuleAxis, rate: bool) -> Evaluated {
    let Evaluated::Series(samples) = series else {
        return Evaluated::Unknown;
    };
    let coordinate = |sample: &Sample| match axis {
        RuleAxis::WallTime => sample.observed_at_ns,
        RuleAxis::Step => sample.step,
    };
    if samples.len() < 2
        || samples
            .windows(2)
            .any(|pair| coordinate(&pair[1]) <= coordinate(&pair[0]))
    {
        return Evaluated::Unknown;
    }
    let origin = coordinate(&samples[0]);
    let scale = if matches!(axis, RuleAxis::WallTime) {
        1e9
    } else {
        1.0
    };
    let xs: Vec<_> = samples
        .iter()
        .map(|s| (coordinate(s) as i128 - origin as i128) as f64 / scale)
        .collect();
    let result = if rate {
        (samples[samples.len() - 1].value - samples[0].value) / xs[xs.len() - 1]
    } else {
        let mean_x = xs.iter().sum::<f64>() / xs.len() as f64;
        let mean_y = samples.iter().map(|s| s.value).sum::<f64>() / xs.len() as f64;
        xs.iter()
            .zip(samples)
            .map(|(x, s)| (x - mean_x) * (s.value - mean_y))
            .sum::<f64>()
            / xs.iter().map(|x| (x - mean_x).powi(2)).sum::<f64>()
    };
    if result.is_finite() {
        Evaluated::Number(result)
    } else {
        Evaluated::Unknown
    }
}
