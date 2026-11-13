//! `codewhale-codegraph` — the Rust CodeGraph core extracted from
//! `codegraph-kernel` and `chimera-graph-core` (W4A first batch).
//!
//! No NAPI/TS boundary lives in this crate: every public surface is plain
//! Rust (`&str`/`&[u8]`/`Vec<u8>`), errors are `Result<T, String>` on the
//! kernel faces and the store/ctx faces keep their handle semantics. The
//! JS adapters are a later slice's concern.
//!
//! Module map (one directory per surface, mirroring the kernel):
//!
//! - [`wire`] — ABI constants, row layouts, and codec for the four wire
//!   contracts (extract/store/ctx/resolve);
//! - [`contract`] — the four contract infos pinned against the recorded
//!   HEAD fixture, the shared error map, and the E-GRAPH port trait;
//! - [`store`] — SQLite write path (batch ops, resurrect/re-attach flow);
//!   owns the graph schema.sql;
//! - [`resolve`] — resolution read context (ctx) and the strategy-tree
//!   resolver;
//! - [`extract`] — the tree-sitter extraction kernel (tsjs/rust/python/
//!   c/cpp walkers, buffers, ids, stack guard, grammar registry).

pub mod contract;
pub mod extract;
pub mod resolve;
pub mod store;
pub mod wire;
