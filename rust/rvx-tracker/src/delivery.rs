use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::{AlertEvent, AlertSink, Result, TrackerError};

#[derive(Clone, Debug, Default, Serialize)]
pub struct DeliveryStats {
    pub accepted: u64,
    pub completed: u64,
    pub dropped: u64,
    pub pending: u64,
    pub failed: u64,
    pub suppressed: u64,
}

enum Message {
    Event(AlertEvent, usize),
    Flush(Instant, mpsc::Sender<bool>),
}

struct Counters {
    accepted: AtomicU64,
    completed: AtomicU64,
    dropped: AtomicU64,
    stop: AtomicBool,
    bytes: std::sync::atomic::AtomicUsize,
}

/// User-provided sinks never execute on a producer's thread or under its state lock.
pub(crate) struct AlertQueue {
    sender: mpsc::SyncSender<Message>,
    counters: Arc<Counters>,
    worker: Mutex<Option<JoinHandle<()>>>,
    sink: Arc<dyn AlertSink>,
    max_bytes: usize,
}

impl AlertQueue {
    pub(crate) fn new(sink: Arc<dyn AlertSink>, capacity: usize, max_bytes: usize) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let counters = Arc::new(Counters {
            accepted: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            bytes: std::sync::atomic::AtomicUsize::new(0),
        });
        let state = counters.clone();
        let worker_sink = sink.clone();
        let worker = std::thread::Builder::new()
            .name("rvx-alert-sink".into())
            .spawn(move || {
                let sink = worker_sink;
                loop {
                    if state.stop.load(Ordering::Acquire) {
                        while let Ok(message) = receiver.try_recv() {
                            if let Message::Event(_, bytes) = message {
                                state.dropped.fetch_add(1, Ordering::Relaxed);
                                state.bytes.fetch_sub(bytes, Ordering::Release);
                            }
                        }
                        break;
                    }
                    match receiver.recv_timeout(Duration::from_millis(10)) {
                        Ok(Message::Event(event, bytes)) => {
                            sink.send(event);
                            state.completed.fetch_add(1, Ordering::Release);
                            state.bytes.fetch_sub(bytes, Ordering::Release);
                        }
                        Ok(Message::Flush(deadline, reply)) => {
                            let complete =
                                sink.flush(deadline.saturating_duration_since(Instant::now()));
                            let _ = reply.send(complete);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                sink.close();
            })
            .map_err(TrackerError::Io)?;
        Ok(Self {
            sender,
            counters,
            worker: Mutex::new(Some(worker)),
            sink,
            max_bytes,
        })
    }

    pub(crate) fn send(&self, event: AlertEvent) {
        // Count before enqueue so a fast consumer cannot make pending underflow.
        self.counters.accepted.fetch_add(1, Ordering::Release);
        let bytes = match serde_json::to_vec(&event) {
            Ok(bytes) => bytes.len(),
            Err(error) => {
                self.counters.dropped.fetch_add(1, Ordering::Release);
                eprintln!("RVX alert sink encoding failed: {error}");
                return;
            }
        };
        let reserved = self
            .counters
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|next| *next <= self.max_bytes)
            })
            .is_ok();
        if !reserved
            || self.counters.stop.load(Ordering::Acquire)
            || self.sender.try_send(Message::Event(event, bytes)).is_err()
        {
            if reserved {
                self.counters.bytes.fetch_sub(bytes, Ordering::Release);
            }
            self.counters.dropped.fetch_add(1, Ordering::Release);
            eprintln!("RVX alert sink queue is full or closed; event remains in Source history");
        }
    }

    pub(crate) fn stats(&self) -> DeliveryStats {
        let accepted = self.counters.accepted.load(Ordering::Acquire);
        let completed = self.counters.completed.load(Ordering::Acquire);
        let dropped = self.counters.dropped.load(Ordering::Acquire);
        DeliveryStats {
            accepted,
            completed,
            dropped,
            pending: accepted.saturating_sub(completed + dropped),
            ..DeliveryStats::default()
        }
    }

    pub(crate) fn sink_stats(&self) -> DeliveryStats {
        self.sink.stats()
    }

    pub(crate) fn close(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (reply, done) = mpsc::channel();
        let mut message = Message::Flush(deadline, reply);
        let submitted = loop {
            match self.sender.try_send(message) {
                Ok(()) => break true,
                Err(mpsc::TrySendError::Full(value)) if Instant::now() < deadline => {
                    message = value;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(_) => break false,
            }
        };
        let flushed = submitted
            && done
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(false);
        self.counters.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().take() {
            while !worker.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if worker.is_finished() {
                if worker.join().is_err() {
                    eprintln!("RVX alert sink worker panicked");
                    return false;
                }
            } else {
                // Rust cannot force-cancel an arbitrary foreign callback.
                eprintln!("RVX alert sink exceeded shutdown deadline; abandoning worker");
                return false;
            }
        }
        flushed
    }
}

impl Drop for AlertQueue {
    fn drop(&mut self) {
        self.counters.stop.store(true, Ordering::Release);
    }
}
