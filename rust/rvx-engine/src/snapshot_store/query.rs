//! Partition long chart histories without weakening exact-summary or per-scan budgets.

use super::*;
use tables::TableReadControl;

const MAX_QUERY_WINDOWS: usize = 64;

impl SnapshotStore {
    /// Bound chart work by request-local cancellation while retaining actual observation provenance.
    pub fn query(&self, request: &SnapshotQueryRequest) -> Result<SnapshotQueryResponse> {
        self.query_controlled(request, &TableReadControl::default())
    }

    /// Split only scan-budget failures; malformed, incomplete and oversized-output reads stay errors.
    pub(crate) fn query_controlled(
        &self,
        request: &SnapshotQueryRequest,
        control: &TableReadControl,
    ) -> Result<SnapshotQueryResponse> {
        match self.query_page(request, control) {
            Ok(response) => return Ok(response),
            Err(error) if scan_budget(&error) => {}
            Err(error) => return Err(error),
        }
        let (from, to, count) = self.query_bounds(request, control)?;
        let span = i128::from(to) - i128::from(from) + 1;
        let page_rows =
            (MAX_QUERY_SCAN_ROWS / 2).min(MAX_QUERY_OUTPUT_POINTS * 5 / request.paths.len());
        let pages = count.div_ceil(page_rows).max(2).min(MAX_QUERY_WINDOWS);
        let pages = (pages as i128).min(span) as usize;
        let mut windows: Vec<_> = (0..pages)
            .rev()
            .map(|index| {
                (
                    (i128::from(from) + span * index as i128 / pages as i128) as i64,
                    (i128::from(from) + span * (index + 1) as i128 / pages as i128 - 1) as i64,
                )
            })
            .collect();
        let mut series = BTreeMap::<(String, String, String), SnapshotQuerySeries>::new();
        let mut reads = 0;
        let mut points = 0;
        let mut bytes = 0;
        while let Some((start, end)) = windows.pop() {
            control.check()?;
            reads += 1;
            if reads > MAX_QUERY_WINDOWS {
                return invalid(
                    "chart history exceeds 64 bounded scans; narrow run/source/time filters",
                );
            }
            let width = i128::from(end) - i128::from(start) + 1;
            let page = SnapshotQueryRequest {
                from: Some(start),
                to: Some(end),
                max_points: ((request.max_points as i128 * width + span - 1) / span).max(2)
                    as usize,
                ..request.clone()
            };
            let response = match self.query_page(&page, control) {
                Ok(response) => response,
                Err(error) if scan_budget(&error) && start < end => {
                    let middle =
                        (i128::from(start) + (i128::from(end) - i128::from(start)) / 2) as i64;
                    windows.push((middle + 1, end));
                    windows.push((start, middle));
                    continue;
                }
                Err(error) => return Err(error),
            };
            bytes += serde_json::to_vec(&response)?.len();
            for part in response.series {
                points += part.values.len();
                if points > MAX_QUERY_OUTPUT_POINTS * 2 || bytes > MAX_QUERY_SCAN_BYTES {
                    return invalid("partitioned chart working set exceeds budget; narrow run/source/field filters");
                }
                let key = (
                    part.run_id.clone(),
                    part.source_id.clone(),
                    part.path.clone(),
                );
                if let Some(merged) = series.get_mut(&key) {
                    merged.snapshot_ids.extend(part.snapshot_ids);
                    merged.source_session_ids.extend(part.source_session_ids);
                    merged.sequences.extend(part.sequences);
                    merged.axes.extend(part.axes);
                    merged.observed_at_ns.extend(part.observed_at_ns);
                    merged.values.extend(part.values);
                } else {
                    series.insert(key, part);
                }
            }
        }
        let mut output_points = 0;
        let mut response = SnapshotQueryResponse {
            axis: request.axis.clone(),
            series: Vec::new(),
        };
        for (_, mut item) in series {
            control.check()?;
            let positions = sample_positions(
                item.values.len(),
                request.max_points.min(item.values.len()),
                |index| item.values[index].is_none(),
            );
            output_points += positions.len();
            if output_points > MAX_QUERY_OUTPUT_POINTS {
                return invalid("snapshot query output budget exceeded; narrow query");
            }
            item.snapshot_ids = positions
                .iter()
                .map(|&index| item.snapshot_ids[index])
                .collect();
            item.source_session_ids = positions
                .iter()
                .map(|&index| item.source_session_ids[index].clone())
                .collect();
            item.sequences = positions
                .iter()
                .map(|&index| item.sequences[index])
                .collect();
            item.axes = positions.iter().map(|&index| item.axes[index]).collect();
            item.observed_at_ns = positions
                .iter()
                .map(|&index| item.observed_at_ns[index])
                .collect();
            item.values = positions.iter().map(|&index| item.values[index]).collect();
            response.series.push(item);
        }
        if serde_json::to_vec(&response)?.len() > MAX_SNAPSHOT_PAGE_BYTES {
            return invalid("snapshot query response exceeds 16 MiB; narrow query");
        }
        Ok(response)
    }

    /// Discover the selected observation span without loading full snapshots or projected cells.
    fn query_bounds(
        &self,
        request: &SnapshotQueryRequest,
        control: &TableReadControl,
    ) -> Result<(i64, i64, usize)> {
        control.check()?;
        let reader = self.reader.lock();
        let mut filter = Filter::new();
        filter.ids("s.run_id", &request.run_ids);
        filter.ids("s.source_id", &request.source_ids);
        let axis = match request.axis.as_str() {
            "wall_time" => "s.observed_at_ns",
            "elapsed" => "s.observed_at_ns-r.first_observed_at_ns",
            _ => {
                filter.push("a.name=?", request.axis.clone().into());
                "a.value"
            }
        };
        if let Some(from) = request.from {
            filter.push(&format!("{axis}>=?"), from.into());
        }
        if let Some(to) = request.to {
            filter.push(&format!("{axis}<=?"), to.into());
        }
        let join_axis = if axis == "a.value" {
            "JOIN chart_axes a ON a.snapshot_id=s.id"
        } else {
            ""
        };
        let (from, to, count): (Option<i64>, Option<i64>, usize) = reader.query_row(
            &format!(
                "SELECT MIN({axis}),MAX({axis}),COUNT(*) FROM snapshots s
                 JOIN chart_runs r ON r.run_id=s.run_id
                 JOIN chart_observations c ON c.snapshot_id=s.id {join_axis} {}",
                filter.sql()
            ),
            params_from_iter(&filter.values),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        control.check()?;
        match (from, to) {
            (Some(from), Some(to)) => Ok((from, to, count)),
            _ => invalid(
                "chart history has no splittable observation range; narrow source/field filters",
            ),
        }
    }
}

/// Retry only the native work limits that a narrower observation window can resolve.
fn scan_budget(error: &EngineError) -> bool {
    matches!(error, EngineError::InvalidInput(message) if
        message.starts_with("snapshot query scan budget exceeded")
        || message.starts_with("snapshot query scan byte budget exceeded")
        || message.starts_with("snapshot projection budget exceeded"))
}
