use std::time::Duration;

use crate::{AlertEvent, DeliveryStats};

pub trait AlertSink: Send + Sync {
    fn send(&self, event: AlertEvent);
    fn flush(&self, timeout: Duration) -> bool;
    fn close(&self);
    fn stats(&self) -> DeliveryStats {
        DeliveryStats::default()
    }
}
