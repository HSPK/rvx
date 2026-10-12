use std::time::{Duration, Instant};

use rvx_core::{IngestionTiming, IngestionWriteTiming};

#[derive(Default)]
pub(crate) struct WriteTiming {
    pub lock_wait: Duration,
    pub execute: Duration,
    pub commit: Duration,
}

pub(crate) fn measure<T>(duration: &mut Duration, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    *duration = started.elapsed();
    result
}

pub(crate) fn observe(timing: &mut IngestionTiming, duration: Duration) {
    let micros = duration.as_micros().min(u128::from(u64::MAX)) as u64;
    let bucket = (64 - micros.leading_zeros() as usize).min(timing.buckets.len() - 1);
    timing.count = timing.count.saturating_add(1);
    timing.total_us = timing.total_us.saturating_add(micros);
    timing.max_us = timing.max_us.max(micros);
    timing.buckets[bucket] = timing.buckets[bucket].saturating_add(1);
}

pub(crate) fn observe_write(summary: &mut IngestionWriteTiming, timing: &WriteTiming) {
    observe(&mut summary.lock_wait, timing.lock_wait);
    observe(&mut summary.execute, timing.execute);
    observe(&mut summary.commit, timing.commit);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timings_are_bounded_and_include_zero_and_overflow_buckets() {
        let mut timing = IngestionTiming::default();
        for micros in [0, 1, 2, 3, 4, u64::MAX] {
            observe(&mut timing, Duration::from_micros(micros));
        }
        assert_eq!(timing.count, 6);
        assert_eq!(timing.total_us, u64::MAX);
        assert_eq!(timing.max_us, u64::MAX);
        assert_eq!(timing.buckets[..4], [1, 1, 2, 1]);
        assert_eq!(timing.buckets[31], 1);
        assert_eq!(timing.buckets.iter().sum::<u64>(), timing.count);
    }
}
