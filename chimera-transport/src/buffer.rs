//! Bounded per-stream byte queue.
//!
//! One queue per in-flight response. The writer (the Tokio task draining
//! `bytes_stream`) only ever holds up to `capacity` bytes here; when the queue
//! is full the writer stops polling the network stream, which is what turns a
//! slow reader into TCP backpressure instead of unbounded memory growth.
//!
//! A single `Bytes` chunk can be larger than the whole capacity (a 1 MiB chunk
//! against a 256 KiB buffer), so `push` accepts a prefix and reports how many
//! bytes it took; the caller re-slices and retries. `take` copies at most
//! `max` bytes into one contiguous `Vec<u8>` for the JS boundary, splitting
//! across queued chunks when needed.

use std::collections::VecDeque;

use bytes::Bytes;

/// Per-stream buffer ceiling. 300 concurrent streams at this size is ~75 MiB,
/// which is the budget this ABI is designed around.
pub const DEFAULT_BUFFER_CAPACITY: usize = 256 * 1024;

/// Default `readBody` drain size: one 64 KiB batch per call.
pub const DEFAULT_READ_MAX: usize = 64 * 1024;

/// Upper bound for a caller-supplied `readBody` size. Anything larger is
/// clamped rather than allowed to allocate an arbitrary buffer in one call.
pub const MAX_READ_MAX: usize = 8 * 1024 * 1024;

pub struct ByteQueue {
    capacity: usize,
    chunks: VecDeque<Bytes>,
    len: usize,
}

impl ByteQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            chunks: VecDeque::new(),
            len: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn free(&self) -> usize {
        self.capacity.saturating_sub(self.len)
    }

    pub fn is_full(&self) -> bool {
        self.free() == 0
    }

    /// Accept as much of `data` as fits; returns the number of bytes accepted
    /// (0 when the queue is full). No byte copy: only the `Bytes` handle is
    /// cloned, and the accepted prefix shares the same allocation.
    pub fn push(&mut self, data: &Bytes) -> usize {
        let free = self.free();
        if free == 0 || data.is_empty() {
            return 0;
        }
        let accepted = free.min(data.len());
        if accepted == data.len() {
            self.chunks.push_back(data.clone());
        } else {
            self.chunks.push_back(data.slice(0..accepted));
        }
        self.len += accepted;
        accepted
    }

    /// Copy up to `max` bytes out, oldest first. Returns `None` when empty.
    pub fn take(&mut self, max: usize) -> Option<Vec<u8>> {
        if self.len == 0 || max == 0 {
            return None;
        }
        let want = max.min(self.len);
        let mut out = Vec::with_capacity(want);
        while out.len() < want {
            let front_len = match self.chunks.front() {
                Some(front) => front.len(),
                None => break,
            };
            if front_len == 0 {
                self.chunks.pop_front();
                continue;
            }
            let remaining = want - out.len();
            if front_len <= remaining {
                let chunk = self
                    .chunks
                    .pop_front()
                    .expect("front chunk exists after the length check above");
                out.extend_from_slice(&chunk);
            } else {
                let chunk = self
                    .chunks
                    .front_mut()
                    .expect("front chunk exists after the length check above");
                out.extend_from_slice(&chunk[..remaining]);
                *chunk = chunk.slice(remaining..);
            }
        }
        self.len -= out.len();
        Some(out)
    }

    /// Drop everything and report how many bytes were discarded.
    pub fn clear(&mut self) -> usize {
        let dropped = self.len;
        self.chunks.clear();
        self.len = 0;
        dropped
    }
}

impl Default for ByteQueue {
    fn default() -> Self {
        Self::new(DEFAULT_BUFFER_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_is_capped_by_capacity_and_reports_the_prefix() {
        let mut queue = ByteQueue::new(8);
        let accepted = queue.push(&Bytes::from_static(b"0123456789"));
        assert_eq!(accepted, 8);
        assert_eq!(queue.len(), 8);
        assert!(queue.is_full());
        assert_eq!(queue.push(&Bytes::from_static(b"x")), 0);
    }

    #[test]
    fn oversized_chunk_is_split_across_drains_without_losing_bytes() {
        let mut queue = ByteQueue::new(4);
        let payload = Bytes::from_static(b"abcdefghij");
        let mut accepted_total = 0;
        let mut collected = Vec::new();

        // Writer loop shape: push what fits, drain, repeat.
        loop {
            let accepted = queue.push(&payload.slice(accepted_total..));
            accepted_total += accepted;
            if accepted == 0 {
                break;
            }
            let drained = queue.take(3).expect("queue has bytes");
            assert!(drained.len() <= 3);
            collected.extend_from_slice(&drained);
        }
        while let Some(rest) = queue.take(3) {
            collected.extend_from_slice(&rest);
        }

        assert_eq!(accepted_total, payload.len());
        assert_eq!(collected, payload.to_vec());
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn take_merges_chunks_up_to_max() {
        let mut queue = ByteQueue::new(1024);
        queue.push(&Bytes::from_static(b"aaaa"));
        queue.push(&Bytes::from_static(b"bb"));
        queue.push(&Bytes::from_static(b"cccccc"));

        assert_eq!(queue.take(5), Some(b"aaaab".to_vec()));
        assert_eq!(queue.take(64), Some(b"bcccccc".to_vec()));
        assert_eq!(queue.take(64), None);
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn take_splits_a_single_chunk_and_keeps_the_remainder() {
        let mut queue = ByteQueue::new(1024);
        queue.push(&Bytes::from_static(b"0123456789"));

        assert_eq!(queue.take(4), Some(b"0123".to_vec()));
        assert_eq!(queue.len(), 6);
        assert_eq!(queue.take(64), Some(b"456789".to_vec()));
        assert!(queue.is_empty());
    }

    #[test]
    fn clear_reports_dropped_bytes() {
        let mut queue = ByteQueue::new(1024);
        queue.push(&Bytes::from_static(b"hello"));
        assert_eq!(queue.clear(), 5);
        assert!(queue.is_empty());
        assert_eq!(queue.clear(), 0);
    }

    #[test]
    fn default_capacity_matches_the_documented_budget() {
        let mut queue = ByteQueue::default();
        let payload = Bytes::from(vec![0u8; DEFAULT_BUFFER_CAPACITY]);
        assert_eq!(queue.push(&payload), DEFAULT_BUFFER_CAPACITY);
        assert!(queue.is_full());
        assert_eq!(queue.push(&Bytes::from_static(b"x")), 0);
        // 300 concurrent streams at the default ceiling.
        let budget = DEFAULT_BUFFER_CAPACITY * 300;
        assert_eq!(budget, 76_800 * 1024);
        assert_eq!(DEFAULT_READ_MAX, 64 * 1024);
        assert!(MAX_READ_MAX >= DEFAULT_READ_MAX);
    }
}
