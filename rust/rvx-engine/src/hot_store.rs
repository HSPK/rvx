use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;

use parking_lot::RwLock;
use rvx_core::{MetricBatch, QueryRequest, QueryResponse, QuerySeries};
use smallvec::SmallVec;

struct StoredPoint {
    run_id: u32,
    source_id: u32,
    source_session_id: u32,
    sequence: u64,
    event_time_ns: i64,
    axes: SmallVec<[(u32, i64); 4]>,
    values: SmallVec<[(u32, f64); 8]>,
}

struct HotState {
    points: VecDeque<StoredPoint>,
    string_ids: HashMap<String, u32>,
    strings: Vec<Arc<str>>,
}

impl HotState {
    fn intern(&mut self, value: &str) -> u32 {
        if let Some(id) = self.string_ids.get(value) {
            return *id;
        }
        let id = self.strings.len() as u32;
        let interned: Arc<str> = Arc::from(value);
        self.string_ids.insert(value.to_string(), id);
        self.strings.push(interned);
        id
    }

    fn resolve(&self, id: u32) -> &str {
        &self.strings[id as usize]
    }
}

pub struct HotStore {
    capacity: usize,
    state: RwLock<HotState>,
}

impl HotStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: RwLock::new(HotState {
                points: VecDeque::with_capacity(capacity.min(4_096)),
                string_ids: HashMap::new(),
                strings: Vec::new(),
            }),
        }
    }

    pub fn append(&self, batch: &MetricBatch) {
        let mut state = self.state.write();
        let run_id = state.intern(&batch.run_id);
        let source_id = state.intern(&batch.source_id);
        for point in &batch.points {
            let source_session_id = state.intern(&point.source_session_id);
            let mut axes = SmallVec::with_capacity(point.axes.len());
            for (name, value) in &point.axes {
                axes.push((state.intern(name), *value));
            }
            let mut values = SmallVec::with_capacity(point.values.len());
            for (name, value) in &point.values {
                values.push((state.intern(name), *value));
            }
            state.points.push_back(StoredPoint {
                run_id,
                source_id,
                source_session_id,
                sequence: point.sequence,
                event_time_ns: point.event_time_ns,
                axes,
                values,
            });
            while state.points.len() > self.capacity {
                state.points.pop_front();
            }
        }
    }

    pub fn len(&self) -> usize {
        self.state.read().points.len()
    }

    #[cfg(test)]
    pub fn remove_batches(&self, batches: &[MetricBatch]) {
        let mut state = self.state.write();
        let mut identities = HashSet::new();
        for batch in batches {
            let Some(source_id) = state.string_ids.get(&batch.source_id).copied() else {
                continue;
            };
            for point in &batch.points {
                let Some(session_id) = state.string_ids.get(&point.source_session_id).copied()
                else {
                    continue;
                };
                identities.insert((source_id, session_id, point.sequence));
            }
        }
        state.points.retain(|stored| {
            !identities.contains(&(stored.source_id, stored.source_session_id, stored.sequence))
        });
        state.points.shrink_to_fit();
    }

    pub fn query(&self, request: &QueryRequest) -> QueryResponse {
        let state = self.state.read();
        let Some(run_id) = state.string_ids.get(&request.run_id).copied() else {
            return empty_response(request);
        };
        let source_filter = request
            .source_ids
            .iter()
            .filter_map(|name| state.string_ids.get(name).copied())
            .collect::<HashSet<_>>();
        let metric_filter = request
            .metrics
            .iter()
            .filter_map(|name| state.string_ids.get(name).copied())
            .collect::<HashSet<_>>();
        let axis_id = state.string_ids.get(&request.axis).copied();
        if request.axis != "wall_time" && axis_id.is_none() {
            return empty_response(request);
        }
        let capacity = request.max_points.clamp(2, 100_000) * 2;
        let mut seen: BTreeMap<(u32, u32), u64> = BTreeMap::new();
        let mut series: BTreeMap<(u32, u32), QuerySeries> = BTreeMap::new();
        for stored in &state.points {
            if stored.run_id != run_id {
                continue;
            }
            if !source_filter.is_empty() && !source_filter.contains(&stored.source_id) {
                continue;
            }
            let axis = if request.axis == "wall_time" {
                stored.event_time_ns
            } else {
                let Some(value) = stored
                    .axes
                    .iter()
                    .find_map(|(name, value)| (*name == axis_id.unwrap()).then_some(*value))
                else {
                    continue;
                };
                value
            };
            if request.from.is_some_and(|from| axis < from)
                || request.to.is_some_and(|to| axis > to)
            {
                continue;
            }
            for (metric, value) in &stored.values {
                if !metric_filter.is_empty() && !metric_filter.contains(metric) {
                    continue;
                }
                let key = (stored.source_id, *metric);
                let observed = seen.entry(key).or_default();
                *observed += 1;
                let entry = series.entry(key).or_insert_with(|| QuerySeries {
                    metric: state.resolve(*metric).to_string(),
                    source_id: state.resolve(stored.source_id).to_string(),
                    source_session_ids: Vec::new(),
                    sequences: Vec::new(),
                    axes: Vec::new(),
                    event_time_ns: Vec::new(),
                    values: Vec::new(),
                });
                push_bounded(
                    entry,
                    QuerySample {
                        session_id: state.resolve(stored.source_session_id),
                        sequence: stored.sequence,
                        axis,
                        event_time_ns: stored.event_time_ns,
                        value: *value,
                    },
                    *observed,
                    capacity,
                );
            }
        }
        QueryResponse {
            run_id: request.run_id.clone(),
            axis: request.axis.clone(),
            series: series.into_values().collect(),
        }
    }
}

struct QuerySample<'a> {
    session_id: &'a str,
    sequence: u64,
    axis: i64,
    event_time_ns: i64,
    value: f64,
}

fn push_bounded(series: &mut QuerySeries, sample: QuerySample<'_>, seen: u64, capacity: usize) {
    if series.values.len() < capacity {
        append_sample(series, &sample);
        return;
    }
    if capacity > 2 {
        let available = capacity - 2;
        let candidate = sample_hash(&sample) % seen.max(1);
        if candidate < available as u64 {
            replace_sample(series, candidate as usize + 1, &sample);
        }
    }
    replace_sample(series, capacity - 1, &sample);
}

fn append_sample(series: &mut QuerySeries, sample: &QuerySample<'_>) {
    series
        .source_session_ids
        .push(sample.session_id.to_string());
    series.sequences.push(sample.sequence);
    series.axes.push(sample.axis);
    series.event_time_ns.push(sample.event_time_ns);
    series.values.push(sample.value);
}

fn replace_sample(series: &mut QuerySeries, index: usize, sample: &QuerySample<'_>) {
    series.source_session_ids[index] = sample.session_id.to_string();
    series.sequences[index] = sample.sequence;
    series.axes[index] = sample.axis;
    series.event_time_ns[index] = sample.event_time_ns;
    series.values[index] = sample.value;
}

fn sample_hash(sample: &QuerySample<'_>) -> u64 {
    let mut value = sample.sequence
        ^ (sample.event_time_ns as u64).rotate_left(17)
        ^ u64::from(crc32fast::hash(sample.session_id.as_bytes()));
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn empty_response(request: &QueryRequest) -> QueryResponse {
    QueryResponse {
        run_id: request.run_id.clone(),
        axis: request.axis.clone(),
        series: Vec::new(),
    }
}

pub fn merge_responses(
    request: &QueryRequest,
    responses: impl IntoIterator<Item = QueryResponse>,
) -> QueryResponse {
    let mut grouped: BTreeMap<(String, String), QuerySeries> = BTreeMap::new();
    let mut identities = HashSet::new();
    for response in responses {
        for series in response.series {
            let entry = grouped
                .entry((series.source_id.clone(), series.metric.clone()))
                .or_insert_with(|| QuerySeries {
                    metric: series.metric.clone(),
                    source_id: series.source_id.clone(),
                    source_session_ids: Vec::new(),
                    sequences: Vec::new(),
                    axes: Vec::new(),
                    event_time_ns: Vec::new(),
                    values: Vec::new(),
                });
            for index in 0..series.values.len() {
                let identity = (
                    series.source_id.clone(),
                    series.source_session_ids[index].clone(),
                    series.sequences[index],
                    series.metric.clone(),
                );
                if !identities.insert(identity) {
                    continue;
                }
                entry
                    .source_session_ids
                    .push(series.source_session_ids[index].clone());
                entry.sequences.push(series.sequences[index]);
                entry.axes.push(series.axes[index]);
                entry.event_time_ns.push(series.event_time_ns[index]);
                entry.values.push(series.values[index]);
            }
        }
    }
    for series in grouped.values_mut() {
        let mut indices = (0..series.values.len()).collect::<Vec<_>>();
        indices.sort_unstable_by_key(|index| {
            (
                series.axes[*index],
                series.event_time_ns[*index],
                series.sequences[*index],
            )
        });
        series.source_session_ids = indices
            .iter()
            .map(|index| series.source_session_ids[*index].clone())
            .collect();
        series.sequences = indices
            .iter()
            .map(|index| series.sequences[*index])
            .collect();
        series.axes = indices.iter().map(|index| series.axes[*index]).collect();
        series.event_time_ns = indices
            .iter()
            .map(|index| series.event_time_ns[*index])
            .collect();
        series.values = indices.iter().map(|index| series.values[*index]).collect();
        downsample(series, request.max_points.clamp(2, 100_000));
    }
    QueryResponse {
        run_id: request.run_id.clone(),
        axis: request.axis.clone(),
        series: grouped.into_values().collect(),
    }
}

fn downsample(series: &mut QuerySeries, maximum: usize) {
    let length = series.values.len();
    if length <= maximum {
        return;
    }
    let indices = (0..maximum)
        .map(|index| {
            if index == maximum - 1 {
                length - 1
            } else {
                index * (length - 1) / (maximum - 1)
            }
        })
        .collect::<Vec<_>>();
    series.axes = indices.iter().map(|index| series.axes[*index]).collect();
    series.source_session_ids = indices
        .iter()
        .map(|index| series.source_session_ids[*index].clone())
        .collect();
    series.sequences = indices
        .iter()
        .map(|index| series.sequences[*index])
        .collect();
    series.event_time_ns = indices
        .iter()
        .map(|index| series.event_time_ns[*index])
        .collect();
    series.values = indices.iter().map(|index| series.values[*index]).collect();
}
