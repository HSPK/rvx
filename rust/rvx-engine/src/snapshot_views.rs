use rvx_core::{
    SnapshotAggregateRequest, SnapshotAggregateResponse, SnapshotRecordsRequest,
    SnapshotRecordsResponse,
};

use crate::{snapshot_store::tables, Engine, Result, TableReadControl};

impl Engine {
    /// Aggregate every filtered record from complete selected snapshots, without mixing Source values.
    pub fn snapshot_aggregate(
        &self,
        request: &SnapshotAggregateRequest,
    ) -> Result<SnapshotAggregateResponse> {
        self.snapshot_aggregate_controlled(request, &TableReadControl::default())
    }

    /// Compute globally paged categories with cooperative request-local cancellation.
    pub fn snapshot_aggregate_controlled(
        &self,
        request: &SnapshotAggregateRequest,
        control: &TableReadControl,
    ) -> Result<SnapshotAggregateResponse> {
        control.check()?;
        tables::validate_selection(&request.run_ids, &request.source_ids)?;
        let sources = self
            .repository
            .table_sources(&request.run_ids, &request.source_ids)?;
        self.snapshots
            .snapshot_aggregate(request, &sources, control)
    }

    /// Return exact cells and stable scoped identities, interleaving Source-local identity order by default.
    pub fn snapshot_records(
        &self,
        request: &SnapshotRecordsRequest,
    ) -> Result<SnapshotRecordsResponse> {
        self.snapshot_records_controlled(request, &TableReadControl::default())
    }

    /// Page stable identities while retaining immutable snapshot IDs and original collection row keys.
    pub fn snapshot_records_controlled(
        &self,
        request: &SnapshotRecordsRequest,
        control: &TableReadControl,
    ) -> Result<SnapshotRecordsResponse> {
        control.check()?;
        tables::validate_selection(&request.run_ids, &request.source_ids)?;
        let sources = self
            .repository
            .table_sources(&request.run_ids, &request.source_ids)?;
        self.snapshots.snapshot_records(request, &sources, control)
    }
}
