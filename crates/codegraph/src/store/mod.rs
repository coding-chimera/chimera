//! Graph store write path — SQLite ingest behind plain Rust handles.
//!
//! The wire layout, op vocabulary, transaction semantics, and the
//! resurrect/re-attach flow live in [`store`] (the ported `store.rs`); the
//! schema SQL is vendored here as `schema.sql` so the crate never reaches
//! into the TS repository.

pub(crate) mod store;

pub use store::{
    DELETE_FILE_FLAG_RESURRECT, OP_DELETE_FILE, OP_DELETE_SPECIFIC_RESOLVED_REFS, OP_INSERT_EDGES,
    OP_INSERT_NODES, OP_INSERT_REFS, OP_MARK_REFS_FAILED, OP_STORE_FILE_RESULT, OP_UPSERT_FILE,
    SQLITE_PARAM_CHUNK_SIZE, STORE_ABI_VERSION, STORE_EDGE_ROW_SIZE, STORE_FILE_ROW_SIZE,
    STORE_META_HEADER_SIZE, STORE_NODE_ROW_SIZE, STORE_OP_ROW_SIZE, STORE_REF_ROW_SIZE,
    STORE_VERSION, StoreBatch, StoreHandle, store_close, store_commit_batch, store_contract_info,
    store_delete_file, store_insert_edges, store_insert_nodes, store_insert_refs, store_open,
    store_set_wal_autocheckpoint,
};

pub use store::{Error, Result};

/// Apply the vendored graph schema (schema.sql) to a fresh SQLite database.
/// The store handle itself never creates schema — callers initialize first
/// (the TS `db/index.ts` open path parity), and `store_open` fails fast on
/// an uninitialized database.
pub fn apply_schema(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(include_str!("schema.sql"))
}
