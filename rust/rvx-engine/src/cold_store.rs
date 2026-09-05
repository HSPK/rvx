use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::BTreeSet;
use std::fs::File;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use arrow::array::ArrayRef;
use arrow::array::{Array, Float64Array, Int64Array, StringArray, UInt64Array};
#[cfg(test)]
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
#[cfg(test)]
use parquet::arrow::ArrowWriter;
use parquet::arrow::ProjectionMask;
#[cfg(test)]
use parquet::basic::{Compression, ZstdLevel};
#[cfg(test)]
use parquet::file::properties::WriterProperties;
#[cfg(test)]
use rvx_core::MetricBatch;
use rvx_core::{QueryRequest, QueryResponse, QuerySeries};

use crate::{EngineError, Result};

struct ProjectionLayout {
    axis: Option<usize>,
    metric: usize,
    value: usize,
}

pub struct ColdStore {
    root: PathBuf,
    #[cfg(test)]
    schema: Arc<Schema>,
}

impl ColdStore {
    pub fn open(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            #[cfg(test)]
            schema: Arc::new(Schema::new(vec![
                Field::new("source_id", DataType::Utf8, false),
                Field::new("source_session_id", DataType::Utf8, false),
                Field::new("sequence", DataType::UInt64, false),
                Field::new("event_time_ns", DataType::Int64, false),
                Field::new("ingest_time_ns", DataType::Int64, false),
                Field::new("optimizer_step", DataType::Int64, true),
                Field::new("env_step", DataType::Int64, true),
                Field::new("tokens", DataType::Int64, true),
                Field::new("policy_version", DataType::Int64, true),
                Field::new("episode", DataType::Int64, true),
                Field::new("axes_json", DataType::Utf8, false),
                Field::new("metric", DataType::Utf8, false),
                Field::new("value", DataType::Float64, false),
            ])),
        })
    }

    #[cfg(test)]
    pub fn write_segment(&self, segment: &Path, batches: &[MetricBatch]) -> Result<usize> {
        let mut grouped: BTreeMap<&str, Vec<&MetricBatch>> = BTreeMap::new();
        for batch in batches {
            grouped.entry(&batch.run_id).or_default().push(batch);
        }
        let mut written = 0;
        for (run_id, run_batches) in grouped {
            let stem = segment
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("segment");
            let metrics = run_batches
                .iter()
                .flat_map(|batch| batch.points.iter())
                .flat_map(|point| point.values.keys())
                .collect::<BTreeSet<_>>();
            for metric in metrics {
                let directory = self
                    .root
                    .join(run_component(run_id))
                    .join(metric_component(metric));
                std::fs::create_dir_all(&directory)?;
                let target = directory.join(format!("{stem}.parquet"));
                if target.exists() {
                    continue;
                }
                let batch = self.record_batch(&run_batches, metric)?;
                if batch.num_rows() == 0 {
                    continue;
                }
                let temporary = tempfile::NamedTempFile::new_in(&directory)?;
                let properties = WriterProperties::builder()
                    .set_compression(Compression::ZSTD(ZstdLevel::default()))
                    .build();
                let mut writer = ArrowWriter::try_new(
                    temporary.reopen()?,
                    self.schema.clone(),
                    Some(properties),
                )?;
                writer.write(&batch)?;
                writer.close()?;
                temporary.as_file().sync_all()?;
                temporary
                    .persist(&target)
                    .map_err(|error| EngineError::Io(error.error))?;
                written += batch.num_rows();
            }
        }
        Ok(written)
    }

    pub fn query(&self, request: &QueryRequest) -> Result<QueryResponse> {
        let directory = self.root.join(run_component(&request.run_id));
        if !directory.exists() {
            return Ok(QueryResponse {
                run_id: request.run_id.clone(),
                axis: request.axis.clone(),
                series: Vec::new(),
            });
        }
        let source_filter = !request.source_ids.is_empty();
        let metric_filter = !request.metrics.is_empty();
        let mut series: BTreeMap<(String, String), QuerySeries> = BTreeMap::new();
        let mut seen: BTreeMap<(String, String), u64> = BTreeMap::new();
        let capacity = request.max_points.clamp(2, 100_000) * 2;
        for path in query_paths(&directory, &request.metrics)? {
            let builder = ParquetRecordBatchReaderBuilder::try_new(File::open(path)?)?;
            let (projection, layout) = query_projection(&request.axis);
            let mask =
                ProjectionMask::columns(builder.parquet_schema(), projection.iter().copied());
            let reader = builder
                .with_projection(mask)
                .with_batch_size(16_384)
                .build()?;
            for batch in reader {
                let batch = batch?;
                let source_ids = strings(&batch, 0)?;
                let session_ids = strings(&batch, 1)?;
                let sequences = unsigned(&batch, 2)?;
                let event_times = signed(&batch, 3)?;
                let metrics = strings(&batch, layout.metric)?;
                let values = floats(&batch, layout.value)?;
                for row in 0..batch.num_rows() {
                    let source_id = source_ids.value(row);
                    let metric = metrics.value(row);
                    if source_filter && !request.source_ids.iter().any(|value| value == source_id) {
                        continue;
                    }
                    if metric_filter && !request.metrics.iter().any(|value| value == metric) {
                        continue;
                    }
                    let axis = axis_value(&batch, row, &request.axis, &layout)?;
                    let Some(axis) = axis else {
                        continue;
                    };
                    if request.from.is_some_and(|from| axis < from)
                        || request.to.is_some_and(|to| axis > to)
                    {
                        continue;
                    }
                    let session_id = session_ids.value(row);
                    let sequence = sequences.value(row);
                    let key = (source_id.to_string(), metric.to_string());
                    let observed = seen.entry(key.clone()).or_default();
                    *observed += 1;
                    let entry = series.entry(key).or_insert_with(|| QuerySeries {
                        metric: metric.to_string(),
                        source_id: source_id.to_string(),
                        source_session_ids: Vec::new(),
                        sequences: Vec::new(),
                        axes: Vec::new(),
                        event_time_ns: Vec::new(),
                        values: Vec::new(),
                    });
                    push_bounded(
                        entry,
                        SampleRef {
                            session_id,
                            sequence,
                            axis,
                            event_time_ns: event_times.value(row),
                            value: values.value(row),
                        },
                        *observed,
                        capacity,
                    );
                }
            }
        }
        Ok(QueryResponse {
            run_id: request.run_id.clone(),
            axis: request.axis.clone(),
            series: series.into_values().collect(),
        })
    }

    pub fn file_count(&self) -> Result<u64> {
        let mut count = 0;
        for entry in std::fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.is_dir() {
                for metric in std::fs::read_dir(path)? {
                    let metric_path = metric?.path();
                    if metric_path.is_dir() {
                        count += parquet_paths(&metric_path)?.len() as u64;
                    }
                }
            }
        }
        Ok(count)
    }

    #[cfg(test)]
    fn record_batch(&self, batches: &[&MetricBatch], selected_metric: &str) -> Result<RecordBatch> {
        let rows = batches
            .iter()
            .map(|batch| {
                batch
                    .points
                    .iter()
                    .filter(|point| point.values.contains_key(selected_metric))
                    .count()
            })
            .sum();
        let mut source_ids = Vec::with_capacity(rows);
        let mut session_ids = Vec::with_capacity(rows);
        let mut sequences = Vec::with_capacity(rows);
        let mut event_times = Vec::with_capacity(rows);
        let mut ingest_times = Vec::with_capacity(rows);
        let mut optimizer_steps = Vec::with_capacity(rows);
        let mut env_steps = Vec::with_capacity(rows);
        let mut tokens = Vec::with_capacity(rows);
        let mut policy_versions = Vec::with_capacity(rows);
        let mut episodes = Vec::with_capacity(rows);
        let mut axes_json = Vec::with_capacity(rows);
        let mut metrics = Vec::with_capacity(rows);
        let mut values = Vec::with_capacity(rows);
        for batch in batches {
            for point in &batch.points {
                let Some(value) = point.values.get(selected_metric) else {
                    continue;
                };
                let encoded_axes = serde_json::to_string(&point.axes)?;
                source_ids.push(batch.source_id.as_str());
                session_ids.push(point.source_session_id.as_str());
                sequences.push(point.sequence);
                event_times.push(point.event_time_ns);
                ingest_times.push(point.ingest_time_ns);
                optimizer_steps.push(point.axes.get("optimizer_step").copied());
                env_steps.push(point.axes.get("env_step").copied());
                tokens.push(point.axes.get("tokens").copied());
                policy_versions.push(point.axes.get("policy_version").copied());
                episodes.push(point.axes.get("episode").copied());
                axes_json.push(encoded_axes);
                metrics.push(selected_metric);
                values.push(*value);
            }
        }
        let columns: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(source_ids)),
            Arc::new(StringArray::from(session_ids)),
            Arc::new(UInt64Array::from(sequences)),
            Arc::new(Int64Array::from(event_times)),
            Arc::new(Int64Array::from(ingest_times)),
            Arc::new(Int64Array::from(optimizer_steps)),
            Arc::new(Int64Array::from(env_steps)),
            Arc::new(Int64Array::from(tokens)),
            Arc::new(Int64Array::from(policy_versions)),
            Arc::new(Int64Array::from(episodes)),
            Arc::new(StringArray::from(axes_json)),
            Arc::new(StringArray::from(metrics)),
            Arc::new(Float64Array::from(values)),
        ];
        Ok(RecordBatch::try_new(self.schema.clone(), columns)?)
    }
}

struct SampleRef<'a> {
    session_id: &'a str,
    sequence: u64,
    axis: i64,
    event_time_ns: i64,
    value: f64,
}

fn push_bounded(series: &mut QuerySeries, sample: SampleRef<'_>, seen: u64, capacity: usize) {
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

fn append_sample(series: &mut QuerySeries, sample: &SampleRef<'_>) {
    series
        .source_session_ids
        .push(sample.session_id.to_string());
    series.sequences.push(sample.sequence);
    series.axes.push(sample.axis);
    series.event_time_ns.push(sample.event_time_ns);
    series.values.push(sample.value);
}

fn replace_sample(series: &mut QuerySeries, index: usize, sample: &SampleRef<'_>) {
    series.source_session_ids[index] = sample.session_id.to_string();
    series.sequences[index] = sample.sequence;
    series.axes[index] = sample.axis;
    series.event_time_ns[index] = sample.event_time_ns;
    series.values[index] = sample.value;
}

fn sample_hash(sample: &SampleRef<'_>) -> u64 {
    let mut value = sample.sequence
        ^ (sample.event_time_ns as u64).rotate_left(17)
        ^ u64::from(crc32fast::hash(sample.session_id.as_bytes()));
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn axis_value(
    batch: &RecordBatch,
    row: usize,
    axis: &str,
    layout: &ProjectionLayout,
) -> Result<Option<i64>> {
    if axis == "wall_time" {
        return Ok(Some(signed(batch, 3)?.value(row)));
    }
    let index = layout
        .axis
        .ok_or_else(|| EngineError::InvalidInput("query axis is missing".into()))?;
    if known_axis(axis).is_some() {
        let values = signed(batch, index)?;
        return Ok((!values.is_null(row)).then(|| values.value(row)));
    }
    let axes: BTreeMap<String, i64> = serde_json::from_str(strings(batch, index)?.value(row))?;
    Ok(axes.get(axis).copied())
}

fn query_projection(axis: &str) -> (Vec<&str>, ProjectionLayout) {
    let mut columns = vec![
        "source_id",
        "source_session_id",
        "sequence",
        "event_time_ns",
    ];
    let axis_index = if axis == "wall_time" {
        None
    } else {
        columns.push(known_axis(axis).unwrap_or("axes_json"));
        Some(4)
    };
    let metric = columns.len();
    columns.push("metric");
    let value = columns.len();
    columns.push("value");
    (
        columns,
        ProjectionLayout {
            axis: axis_index,
            metric,
            value,
        },
    )
}

fn known_axis(axis: &str) -> Option<&'static str> {
    match axis {
        "optimizer_step" => Some("optimizer_step"),
        "env_step" => Some("env_step"),
        "tokens" => Some("tokens"),
        "policy_version" => Some("policy_version"),
        "episode" => Some("episode"),
        _ => None,
    }
}

fn strings(batch: &RecordBatch, index: usize) -> Result<&StringArray> {
    batch
        .column(index)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| EngineError::InvalidInput("invalid Parquet string column".into()))
}

fn signed(batch: &RecordBatch, index: usize) -> Result<&Int64Array> {
    batch
        .column(index)
        .as_any()
        .downcast_ref::<Int64Array>()
        .ok_or_else(|| EngineError::InvalidInput("invalid Parquet integer column".into()))
}

fn unsigned(batch: &RecordBatch, index: usize) -> Result<&UInt64Array> {
    batch
        .column(index)
        .as_any()
        .downcast_ref::<UInt64Array>()
        .ok_or_else(|| EngineError::InvalidInput("invalid Parquet sequence column".into()))
}

fn floats(batch: &RecordBatch, index: usize) -> Result<&Float64Array> {
    batch
        .column(index)
        .as_any()
        .downcast_ref::<Float64Array>()
        .ok_or_else(|| EngineError::InvalidInput("invalid Parquet value column".into()))
}

fn parquet_paths(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = std::fs::read_dir(directory)?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| path.extension().is_some_and(|value| value == "parquet"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn query_paths(directory: &Path, metrics: &[String]) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if metrics.is_empty() {
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            if path.is_dir() {
                paths.extend(parquet_paths(&path)?);
            }
        }
    } else {
        for metric in metrics {
            let path = directory.join(metric_component(metric));
            if path.is_dir() {
                paths.extend(parquet_paths(&path)?);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

fn run_component(run_id: &str) -> String {
    safe_component("run", run_id)
}

fn metric_component(metric: &str) -> String {
    safe_component("metric", metric)
}

fn safe_component(fallback: &str, value: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect::<String>();
    format!(
        "{}-{:08x}",
        if normalized.is_empty() {
            fallback
        } else {
            &normalized
        },
        crc32fast::hash(value.as_bytes())
    )
}
