use std::cmp::{Ordering, Reverse};
use std::collections::{hash_map::DefaultHasher, BinaryHeap};
use std::fs::{File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::{api::ApiClient, TraceArgs};

const PAGE_BYTES: usize = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const MERGE_FAN_IN: u64 = 8;

pub(super) async fn export_trace(client: &ApiClient, args: TraceArgs) -> Result<Value> {
    let parent = args
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".rvx-trace-")
        .tempfile_in(parent)
        .with_context(|| format!("create temporary output beside {}", args.output.display()))?;
    let mut spool = SortedTrace::new(args.temp_dir.as_deref().unwrap_or(parent))?;
    let mut before_id: Option<i64> = None;
    let mut snapshots = 0u64;
    loop {
        let page = client
            .post_bounded(
                "/api/snapshots/history",
                json!({
                    "run_id": args.run, "source_ids": args.sources, "before_id": before_id,
                    "from": args.from_ns, "to": args.to_ns, "limit": 100,
                }),
                PAGE_BYTES,
            )
            .await?;
        let rows = page
            .get("snapshots")
            .and_then(Value::as_array)
            .context("snapshot history returned invalid snapshots")?;
        for snapshot in rows {
            snapshots = snapshots
                .checked_add(1)
                .context("trace snapshot count overflow")?;
            if let Some(spans) = snapshot.pointer("/state/spans").and_then(Value::as_array) {
                for span in spans {
                    if let Some((timestamp, event)) = trace_event(snapshot, span) {
                        spool.push(timestamp, event)?;
                    }
                }
            }
        }
        let next = match page.get("next_before_id") {
            Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_i64()
                    .context("snapshot history returned invalid cursor")?,
            ),
            None => bail!("snapshot history response is missing its continuation cursor"),
        };
        match next {
            None => break,
            Some(next)
                if rows.is_empty()
                    || next <= 0
                    || before_id.is_some_and(|previous| next >= previous) =>
            {
                bail!("snapshot history cursor did not advance");
            }
            Some(next) => before_id = Some(next),
        }
    }
    let events = spool.count;
    spool.write_trace(temporary.as_file_mut())?;
    temporary
        .as_file()
        .sync_all()
        .context("sync trace output")?;
    // Sorting and serialization must succeed before replacing any existing destination.
    temporary
        .persist(&args.output)
        .map_err(|error| error.error)
        .with_context(|| format!("replace {}", args.output.display()))?;
    Ok(json!({"output":args.output, "snapshots_scanned":snapshots, "spans_exported":events}))
}

fn trace_event(snapshot: &Value, span: &Value) -> Option<(f64, Value)> {
    let name = span.get("name")?.as_str()?;
    let start = span.get("start_ns")?.as_i64()?;
    let duration = span.get("duration_ms")?.as_f64()?;
    let source = snapshot
        .get("source_id")
        .and_then(Value::as_str)
        .unwrap_or("source");
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    let mut arguments = serde_json::Map::new();
    arguments.insert("source_id".into(), source.into());
    if let Some(step) = snapshot
        .pointer("/state/tracker/step")
        .and_then(Value::as_i64)
    {
        arguments.insert("step".into(), step.into());
    }
    if let Some(attributes) = span.get("attributes").and_then(Value::as_object) {
        arguments.extend(attributes.clone());
    }
    if let Some(error) = span.get("error").and_then(Value::as_str) {
        arguments.insert("error".into(), error.into());
    }
    let timestamp = start as f64 / 1000.0;
    Some((
        timestamp,
        json!({
            "name":name, "cat":"rvx.tracker", "ph":"X",
            "ts":timestamp, "dur":duration*1000.0, "pid":hasher.finish(),
            "tid":0, "args":arguments,
        }),
    ))
}

#[derive(Debug)]
struct Record {
    timestamp: f64,
    ordinal: u64,
    payload: Vec<u8>,
}

impl PartialEq for Record {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Record {}
impl PartialOrd for Record {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Record {
    fn cmp(&self, other: &Self) -> Ordering {
        self.timestamp
            .total_cmp(&other.timestamp)
            .then(self.ordinal.cmp(&other.ordinal))
    }
}

impl Record {
    fn write(&self, output: &mut impl Write) -> Result<()> {
        output.write_all(&self.timestamp.to_bits().to_le_bytes())?;
        output.write_all(&self.ordinal.to_le_bytes())?;
        output.write_all(&(self.payload.len() as u32).to_le_bytes())?;
        output.write_all(&self.payload)?;
        Ok(())
    }

    fn read(input: &mut impl Read) -> Result<Option<Self>> {
        let mut header = [0u8; 20];
        if input.read(&mut header[..1])? == 0 {
            return Ok(None);
        }
        input
            .read_exact(&mut header[1..])
            .context("truncated trace sort record")?;
        let timestamp = f64::from_bits(u64::from_le_bytes(header[..8].try_into()?));
        let ordinal = u64::from_le_bytes(header[8..16].try_into()?);
        let length = u32::from_le_bytes(header[16..].try_into()?) as usize;
        if !timestamp.is_finite() || length > PAGE_BYTES {
            bail!("invalid trace sort record");
        }
        let mut payload = vec![0; length];
        input
            .read_exact(&mut payload)
            .context("truncated trace sort payload")?;
        Ok(Some(Self {
            timestamp,
            ordinal,
            payload,
        }))
    }
}

struct SortedTrace {
    directory: TempDir,
    chunk: Vec<Record>,
    chunk_bytes: usize,
    runs: u64,
    count: u64,
}

impl SortedTrace {
    fn new(scratch: &Path) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix(".rvx-trace-sort-")
            .tempdir_in(scratch)
            .with_context(|| format!("create trace scratch directory in {}", scratch.display()))?;
        Ok(Self {
            directory,
            chunk: Vec::new(),
            chunk_bytes: 0,
            runs: 0,
            count: 0,
        })
    }

    fn push(&mut self, timestamp: f64, event: Value) -> Result<()> {
        let payload = serde_json::to_vec(&event)?;
        if payload.len() > PAGE_BYTES || !timestamp.is_finite() {
            bail!("trace event exceeds its byte limit or has an invalid timestamp");
        }
        let bytes = payload.len() + std::mem::size_of::<Record>();
        if self.chunk_bytes + bytes > CHUNK_BYTES && !self.chunk.is_empty() {
            self.flush_run()?;
        }
        let ordinal = self.count;
        self.count = self
            .count
            .checked_add(1)
            .context("trace event count overflow")?;
        self.chunk.push(Record {
            timestamp,
            ordinal,
            payload,
        });
        self.chunk_bytes += bytes;
        if self.chunk_bytes >= CHUNK_BYTES {
            self.flush_run()?;
        }
        Ok(())
    }

    fn path(&self, pass: u64, run: u64) -> PathBuf {
        self.directory.path().join(format!("{pass}-{run}.bin"))
    }

    fn flush_run(&mut self) -> Result<()> {
        if self.chunk.is_empty() {
            return Ok(());
        }
        self.chunk.sort_unstable();
        let path = self.path(0, self.runs);
        let mut output =
            BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path)?);
        for record in &self.chunk {
            record.write(&mut output)?;
        }
        output.flush().context("flush sorted trace chunk")?;
        self.chunk.clear();
        self.chunk_bytes = 0;
        self.runs += 1;
        Ok(())
    }

    fn write_trace(&mut self, output: &mut File) -> Result<()> {
        self.flush_run()?;
        let mut pass = 0;
        let mut runs = self.runs;
        while runs > 1 {
            let mut next = 0;
            let mut start = 0;
            while start < runs {
                let end = (start + MERGE_FAN_IN).min(runs);
                self.merge(pass, start, end, next)?;
                // Delete only the exact input runs after their merged file was flushed.
                for run in start..end {
                    std::fs::remove_file(self.path(pass, run))?;
                }
                start = end;
                next += 1;
            }
            pass += 1;
            runs = next;
        }
        let mut writer = BufWriter::new(output);
        writer.write_all(b"{\"traceEvents\":[")?;
        let mut first = true;
        if runs > 0 {
            let mut input = BufReader::new(File::open(self.path(pass, 0))?);
            while let Some(record) = Record::read(&mut input)? {
                if !first {
                    writer.write_all(b",")?;
                }
                writer.write_all(&record.payload)?;
                first = false;
            }
        }
        writer.write_all(b"],\"displayTimeUnit\":\"ms\"}")?;
        writer.flush().context("flush trace JSON")?;
        Ok(())
    }

    fn merge(&self, pass: u64, start: u64, end: u64, next: u64) -> Result<()> {
        let mut readers = Vec::new();
        let mut heap = BinaryHeap::new();
        for run in start..end {
            let mut reader = BufReader::new(File::open(self.path(pass, run))?);
            if let Some(record) = Record::read(&mut reader)? {
                heap.push(Reverse((record, readers.len())));
            }
            readers.push(reader);
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path(pass + 1, next))?;
        let mut output = BufWriter::new(file);
        while let Some(Reverse((record, index))) = heap.pop() {
            record.write(&mut output)?;
            if let Some(next) = Record::read(&mut readers[index])? {
                heap.push(Reverse((next, index)));
            }
        }
        output.flush().context("flush merged trace run")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn multi_pass_external_sort_is_stable_and_preserves_event_payloads() {
        let scratch = tempfile::tempdir().unwrap();
        let mut sorter = SortedTrace::new(scratch.path()).unwrap();
        let mut expected = Vec::new();
        for group in 0..(MERGE_FAN_IN * 2 + 1) {
            for position in (0..20).rev() {
                let event =
                    json!({"ts":position as f64, "group":group, "exact":u64::MAX, "label":"训练"});
                expected.push(event.clone());
                sorter.push(position as f64, event).unwrap();
            }
            sorter.flush_run().unwrap();
        }
        expected.sort_by(|a, b| a["ts"].as_f64().partial_cmp(&b["ts"].as_f64()).unwrap());
        let mut output = NamedTempFile::new_in(scratch.path()).unwrap();
        sorter.write_trace(output.as_file_mut()).unwrap();
        let result: Value = serde_json::from_reader(File::open(output.path()).unwrap()).unwrap();
        assert_eq!(result["traceEvents"], json!(expected));
        assert_eq!(result["displayTimeUnit"], "ms");
        let directory = sorter.directory.path().to_owned();
        drop(sorter);
        assert!(!directory.exists());
    }

    #[test]
    fn large_records_flush_immediately_and_chunks_remain_bounded() {
        let scratch = tempfile::tempdir().unwrap();
        let mut sorter = SortedTrace::new(scratch.path()).unwrap();
        for index in 0..3 {
            sorter
                .push(
                    index as f64,
                    json!({"ts":index,"value":"x".repeat(CHUNK_BYTES)}),
                )
                .unwrap();
            assert_eq!(sorter.chunk_bytes, 0);
            assert!(sorter.chunk.is_empty());
        }
        let mut output = NamedTempFile::new_in(scratch.path()).unwrap();
        sorter.write_trace(output.as_file_mut()).unwrap();
        assert!(output.as_file().metadata().unwrap().len() > (3 * CHUNK_BYTES) as u64);
    }

    #[test]
    fn empty_trace_has_the_existing_output_shape() {
        let scratch = tempfile::tempdir().unwrap();
        let mut sorter = SortedTrace::new(scratch.path()).unwrap();
        let mut output = NamedTempFile::new_in(scratch.path()).unwrap();
        sorter.write_trace(output.as_file_mut()).unwrap();
        let result: Value = serde_json::from_reader(File::open(output.path()).unwrap()).unwrap();
        assert_eq!(result, json!({"traceEvents":[],"displayTimeUnit":"ms"}));
    }

    #[test]
    fn malformed_sort_records_fail_explicitly() {
        assert!(Record::read(&mut &b"short"[..]).is_err());
        let mut header = [0u8; 20];
        header[16..].copy_from_slice(&((PAGE_BYTES + 1) as u32).to_le_bytes());
        assert!(Record::read(&mut &header[..]).is_err());
    }
}
