use serde::{Deserialize, Serialize};

/// Fixed-memory timings: bucket 0 is zero, 1..30 cover [2^(i-1), 2^i) us, and 31 overflows.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestionTiming {
    pub count: u64,
    pub total_us: u64,
    pub max_us: u64,
    pub buckets: [u64; 32],
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestionWriteTiming {
    pub lock_wait: IngestionTiming,
    pub execute: IngestionTiming,
    pub commit: IngestionTiming,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestionDiagnostics {
    pub groups: u64,
    pub pages: u64,
    pub empty_pages: u64,
    pub input_records: u64,
    pub committed_records: u64,
    pub failed_pages: u64,
    pub serialized_bytes: u64,
    pub max_group_pages: u64,
    pub max_group_records: u64,
    pub admission_wait: IngestionTiming,
    pub queue_wait: IngestionTiming,
    pub snapshots: IngestionWriteTiming,
    pub metadata: IngestionWriteTiming,
}
