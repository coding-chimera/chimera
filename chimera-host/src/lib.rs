//! `chimera-host` — Rust host IPC v0 framing primitives.
//!
//! This crate is intentionally lib-only: it implements the byte-level frame
//! codec described in `packages/chimera/specs/rust-host/ipc-v0.md` (§3) plus
//! CRC32C, bounded `MORE` fragment reassembly, and the connection layer that
//! streams frames and enforces `transport_sequence` continuity. It has no
//! external dependencies and produces no binaries.
//!
//! ```
//! use chimera_host::frame::{
//!     decode_header, FrameKind, Header, FLAG_DURABLE, PROTOCOL_VERSION_V0,
//! };
//!
//! let header = Header {
//!     protocol_version: PROTOCOL_VERSION_V0,
//!     frame_kind: FrameKind::Request,
//!     flags: FLAG_DURABLE,
//!     payload_length: 0,
//!     connection_id: 1,
//!     worker_generation: 7,
//!     sequence: 1,
//!     correlation_id: [0; 16],
//!     payload_crc32c: 0,
//! };
//! let bytes = header.encode(b"{}");
//! let decoded = decode_header(&bytes).unwrap();
//! assert_eq!(decoded.payload_length, 2);
//! ```

#![forbid(unsafe_code)]

pub mod connection;
pub mod crc32c;
pub mod frame;
pub mod handshake;
pub mod host;
pub mod host_driver;
pub mod runtime;
pub mod store;
pub mod supervisor;

pub use crc32c::crc32c;
pub use frame::*;
