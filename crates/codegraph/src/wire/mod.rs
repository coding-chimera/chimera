//! Wire codec layer — the single byte-level contract between the graph core
//! and its adapters.
//!
//! The module is split by surface:
//!
//! - [`abi`] — ABI versions, row sizes, kind tables, op codes, flags;
//! - [`error`] — [`CoreError`] / [`CoreErrorCode`];
//! - [`buf`] — arena, writer, bounds-checked reader, row helpers;
//! - [`extract`] — extraction buffers (meta / node / edge / ref);
//! - [`store`] — store batch buffers (meta header, op/file/node/edge/ref rows);
//! - [`ctx`] — resolution read-context output buffers;
//! - [`resolve`] — resolution batch input/output buffers.
//!
//! Layouts mirror the HEAD TypeScript encoders byte for byte. No module here
//! may depend on an adapter or host crate; everything is `&[u8]`/`Vec<u8>` and
//! [`CoreError`].

pub mod abi;
pub mod buf;
pub mod ctx;
pub mod error;
pub mod extract;
pub mod resolve;
pub mod store;

pub use buf::{Arena, Reader, Writer};
pub use error::{CoreError, CoreErrorCode, Result};
