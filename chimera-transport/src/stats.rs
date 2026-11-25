//! Process-wide counters for the private transport ABI.
//!
//! Only the fields that cannot be derived from the handle registry live here.
//! `activeHandles` and `bufferedBytes` are computed from the registry at read
//! time so they cannot drift; everything in this module is monotonic.

use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};

pub struct TransportStats {
    cancelled_handles: AtomicU64,
    post_send_errors: AtomicU64,
    idle_reclaimed_handles: AtomicU64,
    /// Pre-send connect-layer retries that switched h2 -> http1 for one
    /// destination. Signed only to match the ABI field type; never negative.
    protocol_fallbacks: AtomicI64,
    /// Pre-send connect-layer retries that bypassed a system/env proxy for one
    /// destination. Signed only to match the ABI field type; never negative.
    route_fallbacks: AtomicI64,
    worker_threads: AtomicUsize,
}

pub static STATS: TransportStats = TransportStats {
    cancelled_handles: AtomicU64::new(0),
    post_send_errors: AtomicU64::new(0),
    idle_reclaimed_handles: AtomicU64::new(0),
    protocol_fallbacks: AtomicI64::new(0),
    route_fallbacks: AtomicI64::new(0),
    worker_threads: AtomicUsize::new(0),
};

impl TransportStats {
    /// A `cancel(handle)` that actually transitioned the request to cancelled.
    /// Repeated `cancel` calls on the same handle do not count again.
    pub fn record_cancelled(&self) {
        self.cancelled_handles.fetch_add(1, Ordering::Relaxed);
    }

    /// Errors raised after the request was on the wire — i.e. while streaming
    /// the response body. Connect/send failures are not counted here.
    pub fn record_post_send_error(&self) {
        self.post_send_errors.fetch_add(1, Ordering::Relaxed);
    }
    /// An idle-reader watchdog reclaim that actually removed the handle from
    /// the registry. Handles torn down by cancel/release/EOF do not count.
    pub fn record_idle_reclaimed(&self) {
        self.idle_reclaimed_handles.fetch_add(1, Ordering::Relaxed);
    }

    /// A connect-layer protocol fallback (h2 -> http1) actually attempted.
    /// Counted when the retry is issued, not only when it succeeds.
    pub fn record_protocol_fallback(&self) {
        self.protocol_fallbacks.fetch_add(1, Ordering::Relaxed);
    }

    /// A connect-layer route fallback (system/env proxy -> direct) actually
    /// attempted. Counted when the retry is issued.
    pub fn record_route_fallback(&self) {
        self.route_fallbacks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_worker_threads(&self, workers: usize) {
        self.worker_threads.store(workers, Ordering::Relaxed);
    }

    pub fn cancelled_handles(&self) -> u64 {
        self.cancelled_handles.load(Ordering::Relaxed)
    }

    pub fn post_send_errors(&self) -> u64 {
        self.post_send_errors.load(Ordering::Relaxed)
    }
    pub fn idle_reclaimed(&self) -> u64 {
        self.idle_reclaimed_handles.load(Ordering::Relaxed)
    }

    pub fn protocol_fallbacks(&self) -> i64 {
        self.protocol_fallbacks.load(Ordering::Relaxed)
    }

    pub fn route_fallbacks(&self) -> i64 {
        self.route_fallbacks.load(Ordering::Relaxed)
    }

    pub fn worker_threads(&self) -> usize {
        self.worker_threads.load(Ordering::Relaxed)
    }
}
