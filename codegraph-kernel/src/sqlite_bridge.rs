//! sqlite_bridge — main-storage SQLite driver bridge (napi).
//!
//! Replaces ONLY the lowest-level drizzle client (the bun:sqlite `Database`
//! handed to `drizzle({ client })` in `packages/chimera/src/storage/db.bun.ts`)
//! with a rusqlite connection driven through synchronous napi calls. The
//! drizzle query layer, the `#db` import map, and `db.ts`'s PRAGMA/migration/
//! transaction orchestration are untouched — this module must be
//! behaviorally indistinguishable from bun:sqlite's default surface for the
//! shapes drizzle-orm/bun-sqlite/session.js actually calls:
//!
//!   - `client.prepare(sql)` → `{ run, get, all, values }` (sync, variadic
//!     params; the TS bridge keeps the Statement wrapper, Rust keeps the
//!     prepare cache),
//!   - `client.exec(sql)` — multi-statement batches (migration SQL),
//!   - `client.transaction(cb)` → callable with `.deferred()/.immediate()/
//!     .exclusive()` (drizzle calls `[behavior]()`; the TS bridge owns that
//!     shape and drives `sqlite_bridge_transaction_*` with JOIN-the-outer
//!     nesting semantics — sqlite-adapter.ts / store.rs parity, NO savepoints),
//!   - `client.close()` — idempotent.
//!
//! # Value mapping (bun:sqlite DEFAULT behavior parity)
//!
//! Read path: NULL→null, INTEGER→Number, REAL→Number, TEXT→String (lossy
//! UTF-8), BLOB→Uint8Array. INTEGER-as-Number is bun's NON-STRICT default
//! (drizzle timestamp columns depend on it): bun converts every i64 through
//! double on read, lossy above 2^53−1 — the strict-mode BigInt arm is
//! deliberately NOT reproduced (verified against bun 1.4: `SELECT big`
//! returns a lossy Number by default), and chimera storage holds no i64
//! above 2^53. `.all()` returns column-name-keyed objects, `.get()` returns
//! object|null, `.run()` returns `{ changes, lastInsertRowid }` (changes =
//! `sqlite3_changes`, the same counter bun reports — a stale value after
//! non-modifying statements, exactly like bun).
//!
//! Write path: null/undefined→NULL, boolean→INTEGER 1/0, Number→INTEGER when
//! integral and i64-representable else REAL, String→TEXT, BigInt→INTEGER via
//! f64 conversion (bun converts BigInt binds through double — verified: a
//! 2^53+1 BigInt param stores INTEGER 9007199254740992),
//! Buffer/TypedArray→BLOB, plain object→named-parameter map (a SINGLE object
//! argument, bun's convention; the TS bridge pre-expands `@x`/`$x`/`:x`/`x`
//! key variants — sqlite-adapter.ts expandNamedParameters — and names the
//! statement does not declare are skipped). Positional `?` binding enforces
//! the exact parameter count (bun throws on a mismatch; so do we).
//!
//! # Prepare cache
//!
//! `prepare_cached` keyed by SQL text, LRU capacity 256 (the
//! db.bun.ts withPrepareCache limit), cache lives and dies with the
//! connection — `sqlite_bridge_close` drops it. rusqlite clears bindings on
//! statement check-in, and a statement already checked out is re-prepared
//! instead of shared, so cached reuse is transaction-safe (connection-scoped,
//! like bun's own db.query() cache).
//!
//! # Boundary discipline
//!
//! Synchronous short DB operations only (same posture as the bun:sqlite path
//! it replaces — db.ts's NotPromise constraint); NO long-running work inside
//! a bridge call. One handle = one connection; concurrent JS callers
//! serialize on the handle mutex (StoreHandle pattern, store.rs). Poisoned
//! mutex (panic mid-call) latches the handle dead rather than trusting
//! inconsistent txn depth.
//!
//! # Contract handshake
//!
//! `sqlite_bridge_contract_info()` (store.rs store_contract_info precedent):
//! the TS loader (src/storage/db-bridge.ts) verifies ABI equality plus the
//! capability table before routing anything; any mismatch — or the
//! CHIMERA_SQLITE_BRIDGE kill switch not set to 1 — silently keeps the
//! existing bun:sqlite path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{Connection, ToSql};

/// Bridge wire ABI — verified for EQUALITY by the TS loader (independent
/// numbering, the STORE_ABI_VERSION posture).
pub const SQLITE_BRIDGE_ABI_VERSION: u32 = 1;
/// Semantic version string reported alongside the ABI number.
pub const SQLITE_BRIDGE_VERSION: &str = "1.0.0";
/// LRU capacity of the rusqlite prepared-statement cache — the
/// db.bun.ts PREPARE_CACHE_LIMIT parity value (contract: LRU 256 by SQL text).
pub const BRIDGE_PREPARE_CACHE_LIMIT: usize = 256;
/// Capability table the TS loader requires as a subset of its own list.
pub const BRIDGE_CAPABILITIES: &[&str] = &[
    "open",
    "exec",
    "run",
    "get",
    "all",
    "values",
    "transaction",
    "pragma",
    "close",
    // Optional packed read wire (sqliteBridgeAllPacked/ValuesPacked). NOT in
    // the TS BRIDGE_REQUIRED_CAPABILITIES: an older binary without it is
    // still contract-valid and the TS side falls back to the object path.
    "packed-read",
];

// No MAX_SAFE_INTEGER split on the JS projection: bun's non-strict default
// reads EVERY integer through double (lossy above 2^53) and the bridge
// reproduces that exactly — see the module header # Value mapping.

// ---------------------------------------------------------------------------
// Core value types (napi-free — shared by the JS wrappers and cargo tests)
// ---------------------------------------------------------------------------

/// A bound parameter decoded from JS (bun:sqlite default binding semantics).
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
    /// Named-parameter object (bun: a SINGLE object argument binds by name).
    Named(Vec<(String, ParamValue)>),
}

fn param_err(msg: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, msg)))
}

impl ToSql for ParamValue {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            ParamValue::Null => ToSqlOutput::Borrowed(ValueRef::Null),
            // bun:sqlite binds booleans as INTEGER 1/0.
            ParamValue::Bool(b) => ToSqlOutput::Borrowed(ValueRef::Integer(i64::from(*b))),
            ParamValue::Int(i) => ToSqlOutput::Borrowed(ValueRef::Integer(*i)),
            ParamValue::Real(f) => ToSqlOutput::Borrowed(ValueRef::Real(*f)),
            ParamValue::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
            ParamValue::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
            ParamValue::Named(_) => return Err(param_err("named parameter object used as a scalar bind value")),
        })
    }
}

/// One result cell in bun:sqlite default read-type terms.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// A materialized result set: column names + typed rows. The napi wrappers
/// project this to JS (objects keyed by column name for all/get, plain
/// arrays for values).
#[derive(Debug, Default)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
}

fn err(e: rusqlite::Error) -> Error {
    Error::from_reason(format!("sqlite bridge: {e}"))
}

fn closed_err() -> Error {
    Error::from_reason("sqlite bridge handle is closed")
}

fn cell_of(v: rusqlite::Result<ValueRef<'_>>) -> rusqlite::Result<CellValue> {
    Ok(match v? {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => CellValue::Int(i),
        ValueRef::Real(f) => CellValue::Real(f),
        // SQLite TEXT is UTF-8 by contract; lossy keeps a corrupt value
        // readable instead of failing the query (bun is lenient too).
        ValueRef::Text(t) => CellValue::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => CellValue::Blob(b.to_vec()),
    })
}

/// Byte index of the first top-level ';' outside quotes/comments, or None.
/// Only consulted AFTER SQLite itself refused the SQL as multi-statement —
/// reproducing bun:sqlite's "compile the first statement, silently drop the
/// tail" behavior (verified bun 1.4: `prepare("INSERT (2); INSERT (3)").run()`
/// inserts only 2; the drizzle migrator's `ALTER ...; UPDATE ...` batch
/// applies only the ALTER under bun too — the drop is the production
/// behavior we must be byte-identical with). A mis-split on an exotic
/// token can only produce another prepare error, never silent misbehavior:
/// the truncation path is entered solely when rusqlite already refused to
/// compile the full text.
fn first_statement_end(sql: &str) -> Option<usize> {
    let b = sql.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b';' => return Some(i),
            // Quote styles: '' "" `` escapes double; [...] is a bare span.
            b'\'' | b'"' | b'`' => {
                let q = b[i];
                i += 1;
                while i < b.len() {
                    if b[i] == q {
                        if b.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'[' => {
                i += 1;
                while i < b.len() && b[i] != b']' {
                    i += 1;
                }
                i += 1;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    None
}

/// bun:sqlite prepare semantics: compile the FIRST statement, drop the tail.
/// rusqlite refuses multi-statement text (an explicit MultipleStatement
/// error, or a failed tail probe — its prepare() pre-compiles the tail to
/// detect it), so on a prepare error truncate at the first top-level ';'
/// and retry. Genuine single-statement errors pass through untouched.
fn prepare_first<'c>(conn: &'c Connection, sql: &str) -> rusqlite::Result<rusqlite::CachedStatement<'c>> {
    match conn.prepare_cached(sql) {
        Ok(stmt) => Ok(stmt),
        Err(e) => match first_statement_end(sql) {
            Some(end) if end + 1 < sql.len() => conn.prepare_cached(&sql[..end]),
            _ => Err(e),
        },
    }
}

// ---------------------------------------------------------------------------
// Connection core
// ---------------------------------------------------------------------------

pub(crate) struct BridgeConn {
    /// `None` after `sqlite_bridge_close` — deterministic release (the R1
    /// no-unpaired-resources posture, store_close precedent); the JS GC
    /// finalizer (Drop → SQLite close) is only the crash fallback.
    conn: Option<Connection>,
    /// Transaction depth: nested units JOIN the outer one (plain
    /// BEGIN/COMMIT, NO savepoints — sqlite-adapter.ts / store.rs parity).
    txn_depth: u32,
}

impl BridgeConn {
    fn conn(&self) -> Result<&Connection> {
        self.conn.as_ref().ok_or_else(closed_err)
    }

    /// Open (create if missing, exactly like `new Database(path, { create:
    /// true })`; `:memory:` works) with the 256-entry prepare cache. NO
    /// pragmas here — db.ts owns the full PRAGMA sequence and drives it
    /// through run()/exec() like it does on the bun path.
    pub(crate) fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path).map_err(err)?;
        conn.set_prepared_statement_cache_capacity(BRIDGE_PREPARE_CACHE_LIMIT);
        Ok(BridgeConn { conn: Some(conn), txn_depth: 0 })
    }

    pub(crate) fn exec(&self, sql: &str) -> Result<()> {
        self.conn()?.execute_batch(sql).map_err(err)
    }

    /// Bind decoded params onto a prepared statement (raw-bind discipline:
    /// ALL parameters bound via raw_bind_parameter + raw_query/raw_execute).
    fn bind_all(stmt: &mut rusqlite::CachedStatement<'_>, params: &[ParamValue]) -> rusqlite::Result<()> {
        // bun convention: one plain-object argument = named-parameter map.
        if let [ParamValue::Named(entries)] = params {
            for (name, value) in entries {
                // Names the statement does not declare are skipped: the TS
                // expansion sends every prefix variant (@x/$x/:x/x) and only
                // the spelled one exists (sqlite-adapter.ts parity).
                if let Some(idx) = stmt.parameter_index(name)? {
                    stmt.raw_bind_parameter(idx, value)?;
                }
            }
            return Ok(());
        }
        if params.iter().any(|p| matches!(p, ParamValue::Named(_))) {
            return Err(param_err("named parameter object mixed with positional parameters"));
        }
        let expected = stmt.parameter_count();
        if params.len() != expected {
            // bun:sqlite throws on a positional count mismatch.
            return Err(rusqlite::Error::InvalidParameterCount(params.len(), expected));
        }
        for (i, p) in params.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, p)?;
        }
        Ok(())
    }

    /// Materializing result-set core — the pragma()/cargo-test path. The
    /// napi read wrappers (get/all/values) stream through query_first/
    /// query_map instead: they build JS values while stepping, so the full
    /// result set never exists on the Rust side.
    pub(crate) fn query(&self, sql: &str, params: &[ParamValue]) -> Result<QueryResult> {
        let conn = self.conn()?;
        let mut stmt = prepare_first(conn, sql).map_err(err)?;
        Self::bind_all(&mut stmt, params).map_err(err)?;
        let columns = stmt.column_names().into_iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let count = columns.len();
        let mut rows = Vec::new();
        let mut query = stmt.raw_query();
        while let Some(row) = query.next().map_err(err)? {
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell_of(row.get_ref(i)).map_err(err)?);
            }
            rows.push(cells);
        }
        Ok(QueryResult { columns, rows })
    }

    /// Streaming variant of query(): steps rows and hands each one to
    /// `visit` together with the column names (row-object keying),
    /// collecting only what `visit` returns — no Vec<Vec<CellValue>>
    /// materialization. `visit` runs while the statement is stepping; it
    /// must not touch the connection.
    pub(crate) fn query_map<T>(
        &self,
        sql: &str,
        params: &[ParamValue],
        mut visit: impl FnMut(&[String], &rusqlite::Row<'_>) -> Result<T>,
    ) -> Result<Vec<T>> {
        let conn = self.conn()?;
        let mut stmt = prepare_first(conn, sql).map_err(err)?;
        Self::bind_all(&mut stmt, params).map_err(err)?;
        let columns = stmt.column_names().into_iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut out = Vec::new();
        let mut query = stmt.raw_query();
        while let Some(row) = query.next().map_err(err)? {
            out.push(visit(&columns, row)?);
        }
        Ok(out)
    }

    /// Streaming query() that stops after the FIRST row (bun's get()/db.query
    /// shape) — later rows are never stepped.
    pub(crate) fn query_first<T>(
        &self,
        sql: &str,
        params: &[ParamValue],
        mut visit: impl FnMut(&[String], &rusqlite::Row<'_>) -> Result<T>,
    ) -> Result<Option<T>> {
        let conn = self.conn()?;
        let mut stmt = prepare_first(conn, sql).map_err(err)?;
        Self::bind_all(&mut stmt, params).map_err(err)?;
        let columns = stmt.column_names().into_iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut query = stmt.raw_query();
        match query.next().map_err(err)? {
            Some(row) => visit(&columns, row).map(Some),
            None => Ok(None),
        }
    }

    /// run() core: `{ changes, lastInsertRowid }` in bun terms. Executed via
    /// raw_query + drain (NOT raw_execute) so row-returning statements —
    /// `PRAGMA journal_mode = WAL`, `PRAGMA wal_checkpoint(PASSIVE)` — work
    /// through run() exactly like bun:sqlite's Statement.run. changes =
    /// sqlite3_changes (stale after non-modifying statements — bun parity).
    pub(crate) fn execute(&self, sql: &str, params: &[ParamValue]) -> Result<(u64, i64)> {
        let conn = self.conn()?;
        let mut stmt = prepare_first(conn, sql).map_err(err)?;
        Self::bind_all(&mut stmt, params).map_err(err)?;
        {
            let mut query = stmt.raw_query();
            while query.next().map_err(err)?.is_some() {}
        }
        Ok((conn.changes(), conn.last_insert_rowid()))
    }

    pub(crate) fn txn_begin(&mut self, behavior: &str) -> Result<()> {
        let sql = match behavior {
            "deferred" => "BEGIN DEFERRED",
            "immediate" => "BEGIN IMMEDIATE",
            "exclusive" => "BEGIN EXCLUSIVE",
            other => return Err(Error::from_reason(format!("sqlite bridge: unknown transaction behavior '{other}'"))),
        };
        if self.txn_depth > 0 {
            // JOIN the outer unit — no savepoint, no nested BEGIN.
            self.txn_depth += 1;
            return Ok(());
        }
        self.conn()?.execute_batch(sql).map_err(err)?;
        self.txn_depth = 1;
        Ok(())
    }

    pub(crate) fn txn_commit(&mut self) -> Result<()> {
        if self.txn_depth == 0 {
            return Err(Error::from_reason("sqlite bridge: commit outside a transaction"));
        }
        if self.txn_depth > 1 {
            self.txn_depth -= 1;
            return Ok(());
        }
        self.txn_depth = 0;
        self.conn()?.execute_batch("COMMIT").map_err(err)
    }

    pub(crate) fn txn_rollback(&mut self) -> Result<()> {
        if self.txn_depth == 0 {
            return Err(Error::from_reason("sqlite bridge: rollback outside a transaction"));
        }
        self.txn_depth = 0;
        self.conn()?.execute_batch("ROLLBACK").map_err(err)
    }

    pub(crate) fn in_transaction(&self) -> Result<bool> {
        self.conn()?;
        // The bridge owns every BEGIN on this connection, so its own depth
        // counter is the authoritative in-transaction state (a savepoint
        // opened through run() does not count — bun's getter agrees).
        Ok(self.txn_depth > 0)
    }

    /// Pragma read/write split (sqlite-adapter.ts pragma() parity): a string
    /// containing '=' is a WRITE pragma (executed, no result); anything else
    /// is a READ pragma returning the row set. The `{ simple: true }` first-
    /// column projection lives in the TS bridge.
    pub(crate) fn pragma(&self, text: &str) -> Result<Option<QueryResult>> {
        if text.contains('=') {
            self.conn()?.execute_batch(&format!("PRAGMA {text}")).map_err(err)?;
            return Ok(None);
        }
        self.query(&format!("PRAGMA {text}"), &[]).map(Some)
    }

    /// Idempotent close (contract: close 幂等) — second and later calls are
    /// no-ops. Dropping the Connection releases the prepare cache and rolls
    /// back any open transaction (SQLite close semantics — bun parity).
    pub(crate) fn close(&mut self) -> Result<()> {
        self.conn.take();
        self.txn_depth = 0;
        Ok(())
    }

    /// Packed read core (capability "packed-read"): streams rows straight
    /// into the flat wire buffer — the query_map stepping discipline (no
    /// Vec<Vec<CellValue>> materialization) with ONE napi value crossing
    /// per query instead of one per cell. `with_column_names` selects the
    /// all() shape (name table present, flags bit0 set) vs the values()
    /// shape (positional grid only). Layout: see the packed wire section
    /// below (MUST MATCH db-bridge-decode.ts byte for byte).
    pub(crate) fn query_packed(&self, sql: &str, params: &[ParamValue], with_column_names: bool) -> Result<Vec<u8>> {
        let conn = self.conn()?;
        let mut stmt = prepare_first(conn, sql).map_err(err)?;
        Self::bind_all(&mut stmt, params).map_err(err)?;
        let column_count = stmt.column_count();
        if column_count > u16::MAX as usize {
            return Err(Error::from_reason("sqlite bridge: packed read result has more than 65535 columns"));
        }
        let mut arena: Vec<u8> = Vec::new();
        // Column names lead the arena; the name table stores (off, len) pairs.
        let mut names: Vec<(u32, u32)> = Vec::new();
        if with_column_names {
            for name in stmt.column_names() {
                names.push((arena.len() as u32, name.len() as u32));
                arena.extend_from_slice(name.as_bytes());
            }
        }
        let mut grid: Vec<u8> = Vec::new();
        let mut row_count: u64 = 0;
        {
            let mut query = stmt.raw_query();
            while let Some(row) = query.next().map_err(err)? {
                row_count += 1;
                for i in 0..column_count {
                    write_packed_cell(&mut grid, &mut arena, row.get_ref(i)).map_err(err)?;
                }
            }
        }
        // u32 wire guards — a result set beyond 4GB per segment is refused
        // rather than silently truncated (the object path would have died in
        // JS long before, but the packed encoder must not wrap).
        if row_count > u32::MAX as u64 || grid.len() > u32::MAX as usize || arena.len() > u32::MAX as usize {
            return Err(Error::from_reason("sqlite bridge: packed read result set too large for the u32 wire"));
        }
        let names_len = if with_column_names { names.len() * PACKED_NAME_ENTRY_SIZE } else { 0 };
        let grid_offset = PACKED_HEADER_SIZE + names_len;
        let arena_offset = grid_offset + grid.len();
        let total = arena_offset + arena.len();
        if total > u32::MAX as usize {
            return Err(Error::from_reason("sqlite bridge: packed read result set too large for the u32 wire"));
        }
        let mut out = Vec::with_capacity(total);
        out.push(PACKED_LAYOUT_VERSION);
        out.push(if with_column_names { PACKED_FLAG_COLUMN_NAMES } else { 0 });
        out.extend_from_slice(&(column_count as u16).to_le_bytes());
        out.extend_from_slice(&(row_count as u32).to_le_bytes());
        out.extend_from_slice(&(grid_offset as u32).to_le_bytes());
        out.extend_from_slice(&(grid.len() as u32).to_le_bytes());
        out.extend_from_slice(&(if with_column_names { PACKED_HEADER_SIZE as u32 } else { PACKED_NONE }).to_le_bytes());
        out.extend_from_slice(&(names_len as u32).to_le_bytes());
        out.extend_from_slice(&(arena_offset as u32).to_le_bytes());
        out.extend_from_slice(&(arena.len() as u32).to_le_bytes());
        debug_assert_eq!(out.len(), PACKED_HEADER_SIZE);
        for (off, len) in &names {
            out.extend_from_slice(&off.to_le_bytes());
            out.extend_from_slice(&len.to_le_bytes());
        }
        out.extend_from_slice(&grid);
        out.extend_from_slice(&arena);
        debug_assert_eq!(out.len(), total);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// napi surface
// ---------------------------------------------------------------------------

/// Wire-contract description — the TS loader verifies this before routing
/// anything through the bridge (store_contract_info precedent).
#[napi(object)]
pub struct SqliteBridgeContractInfo {
    pub abi_version: u32,
    pub bridge_version: String,
    pub capabilities: Vec<String>,
}

#[napi]
pub fn sqlite_bridge_contract_info() -> SqliteBridgeContractInfo {
    SqliteBridgeContractInfo {
        abi_version: SQLITE_BRIDGE_ABI_VERSION,
        bridge_version: SQLITE_BRIDGE_VERSION.to_string(),
        capabilities: BRIDGE_CAPABILITIES.iter().map(|s| s.to_string()).collect(),
    }
}

/// One open bridge connection. Handle-based (StoreHandle pattern): the
/// Connection is `!Sync` behind a Mutex; a panic mid-call latches the handle
/// poisoned so no later call trusts inconsistent txn depth.
#[napi]
pub struct SqliteBridgeHandle {
    inner: Mutex<BridgeConn>,
    poisoned: AtomicBool,
}

impl SqliteBridgeHandle {
    fn with_conn<T>(&self, f: impl FnOnce(&mut BridgeConn) -> Result<T>) -> Result<T> {
        if self.poisoned.load(Ordering::Relaxed) {
            return Err(Error::from_reason("sqlite bridge handle is poisoned by an earlier panic; reopen it"));
        }
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                self.poisoned.store(true, Ordering::Relaxed);
                return Err(Error::from_reason("sqlite bridge handle mutex poisoned"));
            }
        };
        struct PoisonOnDrop<'a>(&'a AtomicBool);
        impl Drop for PoisonOnDrop<'_> {
            fn drop(&mut self) {
                if std::thread::panicking() {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
        }
        let _latch = PoisonOnDrop(&self.poisoned);
        f(&mut guard)
    }
}

#[napi]
pub fn sqlite_bridge_open(path: String) -> Result<SqliteBridgeHandle> {
    let conn = BridgeConn::open(&path)?;
    Ok(SqliteBridgeHandle { inner: Mutex::new(conn), poisoned: AtomicBool::new(false) })
}

/// Multi-statement batch (migration SQL path, db.ts applyMigrations).
#[napi]
pub fn sqlite_bridge_exec(handle: &SqliteBridgeHandle, sql: String) -> Result<()> {
    handle.with_conn(|c| c.exec(&sql))
}

// --- JS value projection ---------------------------------------------------

/// One decoded parameter, or None when the value is an unsupported type
/// (caller turns None into a bridge error naming the offending slot).
fn decode_param<'env>(env: &Env, u: &Unknown<'env>) -> Result<Option<ParamValue>> {
    Ok(match u.get_type()? {
        ValueType::Null | ValueType::Undefined => Some(ParamValue::Null),
        ValueType::Boolean => Some(ParamValue::Bool(unsafe { u.cast::<bool>() }?)),
        ValueType::Number => {
            let d = unsafe { u.cast::<f64>() }?;
            // bun/better-sqlite3: integral Numbers bind as INTEGER.
            if d.fract() == 0.0 && d >= i64::MIN as f64 && d <= i64::MAX as f64 {
                Some(ParamValue::Int(d as i64))
            } else {
                Some(ParamValue::Real(d))
            }
        }
        ValueType::String => Some(ParamValue::Text(unsafe { u.cast::<String>() }?)),
        ValueType::BigInt => {
            // bun converts BigInt binds through double: a lossless-i64 read
            // plus the f64 round reproduces its stored value bit-for-bit
            // (9007199254740993n stores INTEGER 9007199254740992).
            let (v, lossless) = unsafe { u.cast::<BigInt>() }?.get_i64();
            if !lossless {
                return Err(Error::from_reason("sqlite bridge: BigInt parameter out of i64 range"));
            }
            Some(ParamValue::Int((v as f64) as i64))
        }
        ValueType::Object => {
            // Buffer / TypedArray → BLOB (bun binds both as blobs);
            // from_napi_value validates the underlying napi type, so a
            // failed cast IS the type check (no pending JS exception).
            if let Ok(buf) = unsafe { u.cast::<Buffer>() } {
                Some(ParamValue::Blob(buf.to_vec()))
            } else if let Ok(ta) = unsafe { u.cast::<Uint8Array>() } {
                Some(ParamValue::Blob(ta.to_vec()))
            } else {
                // Plain object → named-parameter map. One level deep:
                // nested structures are a binding error, not silent NULL.
                let mut entries = Vec::new();
                let obj = unsafe { u.cast::<Object>() }?;
                let names_raw = obj.get_property_names()?;
                let names = unsafe { Array::from_napi_value(env.raw(), names_raw.value().value) }?;
                for i in 0..names.len() {
                    let name: String = names.get(i)?.ok_or_else(|| Error::from_reason("sqlite bridge: bad parameter name"))?;
                    let value = obj.get_named_property::<Unknown>(&name)?;
                    match decode_param(env, &value)? {
                        Some(v) if !matches!(v, ParamValue::Named(_)) => entries.push((name, v)),
                        _ => {
                            return Err(Error::from_reason(format!(
                                "sqlite bridge: unsupported nested value for named parameter '{name}'"
                            )))
                        }
                    }
                }
                Some(ParamValue::Named(entries))
            }
        }
        other => {
            return Err(Error::from_reason(format!(
                "sqlite bridge: unsupported parameter type {other:?} (bun:sqlite binds null/boolean/number/string/bigint/buffer only)"
            )))
        }
    })
}

fn decode_params(env: &Env, params: &[Unknown]) -> Result<Vec<ParamValue>> {
    params
        .iter()
        .enumerate()
        .map(|(i, u)| {
            decode_param(env, u)?.ok_or_else(|| {
                Error::from_reason(format!("sqlite bridge: unsupported parameter at position {i}"))
            })
        })
        .collect()
}

type Cell = Either4<Null, f64, String, Uint8Array>;

/// bun:sqlite non-strict-default read mapping: INTEGER → Number (through
/// f64, lossy above 2^53 — exactly like bun), REAL → Number, TEXT → String,
/// BLOB → Uint8Array, NULL → null.
fn cell_js(c: CellValue) -> Cell {
    match c {
        CellValue::Null => Cell::A(Null),
        CellValue::Int(i) => Cell::B(i as f64),
        CellValue::Real(f) => Cell::B(f),
        // By-value: the owned String/Vec moves into the JS projection (no
        // clone). Kept for the materialized paths (run_result_object, the
        // pragma row_object); the hot get/all/values path uses cell_js_ref.
        CellValue::Text(s) => Cell::C(s),
        CellValue::Blob(b) => Cell::D(Uint8Array::from(b)),
    }
}

/// Streaming read mapping: one rusqlite cell straight into its JS `Cell`
/// form — the exact bun:sqlite default mapping of cell_js/cell_of, but the
/// cell is never materialized as CellValue first (TEXT/BLOB pay ONE copy
/// into their owned JS form instead of copy-then-clone).
fn cell_js_ref(v: rusqlite::Result<ValueRef<'_>>) -> Result<Cell> {
    Ok(match v.map_err(err)? {
        ValueRef::Null => Cell::A(Null),
        ValueRef::Integer(i) => Cell::B(i as f64),
        ValueRef::Real(f) => Cell::B(f),
        // SQLite TEXT is UTF-8 by contract; lossy keeps a corrupt value
        // readable instead of failing the query (cell_of parity).
        ValueRef::Text(t) => Cell::C(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Cell::D(Uint8Array::from(b.to_vec())),
    })
}

/// cell_js_ref projected to an untyped JS handle for set_property with an
/// interned key (the row-object path).
fn cell_unknown<'env>(env: &Env, v: rusqlite::Result<ValueRef<'_>>) -> Result<Unknown<'env>> {
    // SAFETY: env.raw() is the live napi env of this synchronous call; every
    // produced napi_value is valid for the enclosing handle scope and is
    // wrapped into an Unknown of the same env immediately.
    let raw = match v.map_err(err)? {
        // TEXT fast path: napi copies the borrowed SQLite bytes straight into
        // the JS string (ONE copy). The Cell::C route would first materialize
        // an intermediate Rust String — a full extra copy per text cell on
        // the payload-dominated storage reads. Lossy re-encoding only for
        // invalid UTF-8 (cell_of parity).
        ValueRef::Text(t) => match String::from_utf8_lossy(t) {
            std::borrow::Cow::Borrowed(s) => env.create_string(s)?.raw(),
            std::borrow::Cow::Owned(s) => env.create_string_from_std(s)?.raw(),
        },
        other => unsafe { Cell::to_napi_value(env.raw(), cell_js_ref(Ok(other))?) }?,
    };
    // SAFETY: `raw` was just produced by this same valid env.
    unsafe { Unknown::from_napi_value(env.raw(), raw) }
}

/// Per-query interned column keys: ONE JS string per column name, reused as
/// the property key of every row. set_named_property would instead pay a
/// CString allocation plus an engine-side name→key conversion per cell per
/// row; set_property with these keys skips both.
fn column_keys<'env>(env: &Env, columns: &[String]) -> Result<Vec<Unknown<'env>>> {
    columns
        .iter()
        // SAFETY: the key's napi_value comes from create_string on this same
        // valid env and is wrapped immediately.
        .map(|name| unsafe { Unknown::from_napi_value(env.raw(), env.create_string(name)?.raw()) })
        .collect()
}

/// Streaming row-object builder (all()/get()): keys[i] is the interned JS
/// string of columns[i]; cells are projected one at a time straight off the
/// stepped row and ALL of them land in ONE napi_define_properties call
/// (the per-cell napi_set_property round trips collapse into one boundary
/// crossing per row). `props` is a caller-owned scratch buffer reused across
/// rows — zero per-row allocation on the Rust side. Property::default()'s
/// attributes are Writable|Enumerable|Configurable — the plain-object
/// semantics bun:sqlite rows have ([[Define]] on a fresh object is
/// indistinguishable from [[Set]] here).
fn row_object_from_row<'env>(
    env: &Env,
    keys: &[Unknown<'env>],
    columns: &[String],
    row: &rusqlite::Row<'_>,
    props: &mut Vec<Property>,
) -> Result<Object<'env>> {
    let mut obj = Object::new(env)?;
    props.clear();
    for i in 0..columns.len() {
        props.push(Property::new().with_name(env, keys[i])?.with_value(&cell_unknown(env, row.get_ref(i))?));
    }
    obj.define_properties(props)?;
    Ok(obj)
}

fn row_object<'env>(env: &Env, columns: &[String], cells: Vec<CellValue>) -> Result<Object<'env>> {
    let mut obj = Object::new(env)?;
    for (i, cell) in cells.into_iter().enumerate() {
        obj.set_named_property(columns.get(i).map(String::as_str).unwrap_or(""), cell_js(cell))?;
    }
    Ok(obj)
}

fn run_result_object<'env>(env: &Env, changes: u64, last_insert_rowid: i64) -> Result<Object<'env>> {
    let mut obj = Object::new(env)?;
    // bun reports both counters as plain Numbers.
    let changes_js: Cell = Cell::B(changes as f64);
    obj.set_named_property("changes", changes_js)?;
    obj.set_named_property("lastInsertRowid", cell_js(CellValue::Int(last_insert_rowid)))?;
    Ok(obj)
}

/// `{ changes, lastInsertRowid }` — bun:sqlite Statement.run shape.
#[napi]
pub fn sqlite_bridge_run<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Object<'env>> {
    let decoded = decode_params(&env, &params)?;
    let (changes, last_insert_rowid) = handle.with_conn(|c| c.execute(&sql, &decoded))?;
    run_result_object(&env, changes, last_insert_rowid)
}

/// Row object or null — bun:sqlite Statement.get shape (drizzle's session
/// maps null to undefined itself).
#[napi]
pub fn sqlite_bridge_get<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Either<Object<'env>, Null>> {
    let decoded = decode_params(&env, &params)?;
    // Streaming first-row projection: later rows are never stepped and no
    // Rust-side result set is materialized (query() fetched them all before).
    let first = handle.with_conn(|c| {
        c.query_first(&sql, &decoded, |columns, row| {
            row_object_from_row(&env, &column_keys(&env, columns)?, columns, row, &mut Vec::new())
        })
    })?;
    match first {
        Some(obj) => Ok(Either::A(obj)),
        None => Ok(Either::B(Null)),
    }
}

/// Array of column-name-keyed row objects — bun:sqlite Statement.all shape.
#[napi]
pub fn sqlite_bridge_all<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Vec<Object<'env>>> {
    let decoded = decode_params(&env, &params)?;
    // Column keys are interned once per query and reused across every row;
    // the property scratch buffer is reused the same way.
    let mut keys: Vec<Unknown<'env>> = Vec::new();
    let mut props: Vec<Property> = Vec::new();
    let mut armed = false;
    handle.with_conn(|c| {
        c.query_map(&sql, &decoded, |columns, row| {
            if !armed {
                keys = column_keys(&env, columns)?;
                props.reserve(columns.len());
                armed = true;
            }
            row_object_from_row(&env, &keys, columns, row, &mut props)
        })
    })
}

/// Array of positional row arrays — bun:sqlite Statement.values shape
/// (drizzle's field-mapped reads go through this).
#[napi]
pub fn sqlite_bridge_values<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Vec<Vec<Cell>>> {
    let _ = env;
    let decoded = decode_params(&env, &params)?;
    handle.with_conn(|c| {
        c.query_map(&sql, &decoded, |_columns, row| {
            let count = row.as_ref().column_count();
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell_js_ref(row.get_ref(i))?);
            }
            Ok(cells)
        })
    })
}

// ---------------------------------------------------------------------------
// Packed read wire (capability "packed-read") — ONE flat buffer per query
// ---------------------------------------------------------------------------

// Packed wire layout v1 — a single Uint8Array returned per query (header ‖
// name table ‖ grid ‖ arena; every multi-byte field little-endian, the
// buffers.rs ExtractBuffers conventions). The napi read wrappers for this
// shape (sqlite_bridge_all_packed / sqlite_bridge_values_packed) cross the
// boundary exactly ONCE per query — the per-cell napi value creation of the
// object path collapses into TS-side DataView/TextDecoder decoding.
//
// THIS SECTION AND `packages/chimera/src/storage/db-bridge-decode.ts` MUST
// MATCH BYTE FOR BYTE. Any layout change bumps PACKED_LAYOUT_VERSION — the
// TS decoder hard-fails on a version it doesn't know (kernel/decode.ts
// posture). The optional-export + capability probing keeps old binaries on
// the object path, so the packed wire itself needs no ABI bump.
//
// header (32 bytes):
//   0   u8   layout_version (= PACKED_LAYOUT_VERSION)
//   1   u8   flags — bit0: has_column_names (packed-all; packed-values is 0)
//   2   u16  column_count
//   4   u32  row_count
//   8   u32  grid_offset   (= 32 + names_len)
//   12  u32  grid_len      (= row_count * column_count * 12)
//   16  u32  names_offset  (NONE = 0xFFFF_FFFF when !has_column_names)
//   20  u32  names_len     (= column_count * 8 when present, else 0)
//   24  u32  arena_offset  (= grid_offset + grid_len)
//   28  u32  arena_len     (buffer ends exactly at arena_offset + arena_len)
//
// name table (has_column_names only; 8 bytes per column, column order):
//   0   u32  arena offset of the column-name bytes
//   4   u32  byte length
//
// cell (12 bytes, row-major, row_count × column_count):
//   0   u8   tag: 0=NULL, 1=F64, 2=TEXT, 3=BLOB — per-cell because SQLite
//            column types are DYNAMIC (a column may mix types across rows)
//   1   [3]  pad (zero)
//   4   8B   payload: F64 → f64 LE bits (INTEGER via `i as f64` — bun's
//            non-strict lossy double read; REAL as-is); TEXT/BLOB →
//            u32 arena offset + u32 byte length; NULL → zero
//
// arena: raw bytes, no dedup, no alignment (store.rs convention). Column
// names lead (packed-all), then cell payload bytes in grid order. TEXT is
// stored as SQLite's ORIGINAL bytes INCLUDING invalid UTF-8 sequences — no
// Rust-side lossy re-encode. The TS decoder's TextDecoder (WHATWG maximal-
// subpart replacements) is byte-exactly aligned with the object path's
// String::from_utf8_lossy (same Unicode recommended practice), so both read
// shapes produce identical JS strings for corrupt values.

/// Packed wire layout version — the TS decoder hard-fails on any other value.
pub const PACKED_LAYOUT_VERSION: u8 = 1;
pub const PACKED_HEADER_SIZE: usize = 32;
pub const PACKED_CELL_SIZE: usize = 12;
pub const PACKED_NAME_ENTRY_SIZE: usize = 8;
/// flags bit0: the buffer carries the column-name table (packed-all shape).
pub const PACKED_FLAG_COLUMN_NAMES: u8 = 1;
pub const PACKED_TAG_NULL: u8 = 0;
pub const PACKED_TAG_F64: u8 = 1;
pub const PACKED_TAG_TEXT: u8 = 2;
pub const PACKED_TAG_BLOB: u8 = 3;
/// "Segment absent" sentinel (buffers.rs NONE convention).
pub const PACKED_NONE: u32 = 0xFFFF_FFFF;

/// Append one rusqlite cell to the packed grid/arena pair. Streaming: called
/// while the statement steps, so a cell is NEVER materialized as CellValue —
/// TEXT/BLOB payload bytes are copied exactly once (SQLite buffer → arena).
fn write_packed_cell(
    grid: &mut Vec<u8>,
    arena: &mut Vec<u8>,
    v: rusqlite::Result<ValueRef<'_>>,
) -> rusqlite::Result<()> {
    let at = grid.len();
    grid.resize(at + PACKED_CELL_SIZE, 0);
    let cell = &mut grid[at..at + PACKED_CELL_SIZE];
    match v? {
        ValueRef::Null => cell[0] = PACKED_TAG_NULL,
        // bun non-strict default: EVERY integer reads through f64 (lossy
        // above 2^53) — the payload is exactly the number the object path
        // hands JS (cell_js parity), just without the napi crossing.
        ValueRef::Integer(i) => {
            cell[0] = PACKED_TAG_F64;
            cell[4..12].copy_from_slice(&(i as f64).to_le_bytes());
        }
        ValueRef::Real(f) => {
            cell[0] = PACKED_TAG_F64;
            cell[4..12].copy_from_slice(&f.to_le_bytes());
        }
        ValueRef::Text(t) => {
            cell[0] = PACKED_TAG_TEXT;
            let off = arena.len() as u32;
            arena.extend_from_slice(t);
            cell[4..8].copy_from_slice(&off.to_le_bytes());
            cell[8..12].copy_from_slice(&(t.len() as u32).to_le_bytes());
        }
        ValueRef::Blob(b) => {
            cell[0] = PACKED_TAG_BLOB;
            let off = arena.len() as u32;
            arena.extend_from_slice(b);
            cell[4..8].copy_from_slice(&off.to_le_bytes());
            cell[8..12].copy_from_slice(&(b.len() as u32).to_le_bytes());
        }
    }
    Ok(())
}

/// Flat-buffer all() — the bun:sqlite Statement.all shape decoded TS-side
/// from the packed wire (one Uint8Array crossing; db-bridge-decode.ts).
#[napi]
pub fn sqlite_bridge_all_packed<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Uint8Array> {
    let _ = env;
    let decoded = decode_params(&env, &params)?;
    let out = handle.with_conn(|c| c.query_packed(&sql, &decoded, true))?;
    Ok(Uint8Array::from(out))
}

/// Flat-buffer values() — positional row arrays decoded TS-side (the drizzle
/// field-mapped read path; no column names on the wire).
#[napi]
pub fn sqlite_bridge_values_packed<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    sql: String,
    params: Vec<Unknown<'env>>,
) -> Result<Uint8Array> {
    let _ = env;
    let decoded = decode_params(&env, &params)?;
    let out = handle.with_conn(|c| c.query_packed(&sql, &decoded, false))?;
    Ok(Uint8Array::from(out))
}

// --- transactions / pragma / lifecycle --------------------------------------

/// BEGIN deferred|immediate|exclusive; nested calls JOIN the outer unit.
#[napi]
pub fn sqlite_bridge_transaction_begin(handle: &SqliteBridgeHandle, behavior: String) -> Result<()> {
    handle.with_conn(|c| c.txn_begin(&behavior))
}

#[napi]
pub fn sqlite_bridge_transaction_commit(handle: &SqliteBridgeHandle) -> Result<()> {
    handle.with_conn(|c| c.txn_commit())
}

#[napi]
pub fn sqlite_bridge_transaction_rollback(handle: &SqliteBridgeHandle) -> Result<()> {
    handle.with_conn(|c| c.txn_rollback())
}

/// sqlite3_get_autocommit inverse — bun:sqlite's `inTransaction` getter.
#[napi]
pub fn sqlite_bridge_in_transaction(handle: &SqliteBridgeHandle) -> Result<bool> {
    handle.with_conn(|c| c.in_transaction())
}

/// Pragma read/write split. WRITE ("k = v" form) → Undefined; READ → row
/// object, or Null when the pragma yields no rows. `{ simple: true }`
/// first-column projection is applied TS-side (sqlite-adapter parity).
#[napi]
pub fn sqlite_bridge_pragma<'env>(
    env: Env,
    handle: &SqliteBridgeHandle,
    pragma: String,
) -> Result<Either3<Object<'env>, Null, Undefined>> {
    let out = handle.with_conn(|c| c.pragma(&pragma))?;
    let Some(out) = out else { return Ok(Either3::C(())) };
    match out.rows.into_iter().next() {
        Some(cells) => Ok(Either3::A(row_object(&env, &out.columns, cells)?)),
        None => Ok(Either3::B(Null)),
    }
}

/// Idempotent deterministic close: drops the Connection (and its prepare
/// cache) in place; later calls on the handle fail with "handle is closed".
#[napi]
pub fn sqlite_bridge_close(handle: &SqliteBridgeHandle) -> Result<()> {
    handle.with_conn(|c| c.close())
}

// ---------------------------------------------------------------------------
// Tests — exercise the napi-free BridgeConn core directly (store.rs posture:
// the harness must never construct napi/JS value types).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> BridgeConn {
        BridgeConn::open(":memory:").expect("open :memory:")
    }

    fn temp_path(tag: &str) -> String {
        use std::sync::atomic::AtomicU64;
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir()
            .join(format!("cgk-bridge-{tag}-{}-{}.db", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)))
            .to_string_lossy()
            .to_string()
    }

    fn rows(out: &QueryResult) -> &Vec<Vec<CellValue>> {
        &out.rows
    }

    fn err_msg<T>(r: Result<T>) -> String {
        match r {
            Err(e) => e.to_string(),
            Ok(_) => panic!("expected error"),
        }
    }

    #[test]
    fn contract_info_reports_abi_and_capabilities() {
        let info = sqlite_bridge_contract_info();
        assert_eq!(info.abi_version, SQLITE_BRIDGE_ABI_VERSION);
        assert_eq!(info.bridge_version, SQLITE_BRIDGE_VERSION);
        assert_eq!(info.capabilities, BRIDGE_CAPABILITIES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn open_supports_memory_and_file_paths() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER)").unwrap();
        assert_eq!(rows(&c.query("SELECT COUNT(*) FROM t", &[]).unwrap()).len(), 1);

        let path = temp_path("open");
        let f = BridgeConn::open(&path).unwrap();
        f.exec("CREATE TABLE t (a INTEGER)").unwrap();
        f.execute("INSERT INTO t VALUES (?)", &[ParamValue::Int(7)]).unwrap();
        drop(f);
        // Reopen persists (a real file, not :memory:).
        let f2 = BridgeConn::open(&path).unwrap();
        let out = f2.query("SELECT a FROM t", &[]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Int(7));
        drop(f2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn value_type_mapping_matches_bun_defaults() {
        let c = mem();
        c.exec("CREATE TABLE v (n NULL_COL, i INTEGER, r REAL, t TEXT, b BLOB)").unwrap();
        c.execute(
            "INSERT INTO v (i, r, t, b) VALUES (?, ?, ?, ?)",
            &[ParamValue::Int(42), ParamValue::Real(1.5), ParamValue::Text("hi".into()), ParamValue::Blob(vec![0, 255, 7])],
        )
        .unwrap();
        let out = c.query("SELECT n, i, r, t, b FROM v", &[]).unwrap();
        assert_eq!(out.columns, vec!["n", "i", "r", "t", "b"]);
        assert_eq!(
            rows(&out)[0],
            vec![
                CellValue::Null,
                CellValue::Int(42),
                CellValue::Real(1.5),
                CellValue::Text("hi".into()),
                CellValue::Blob(vec![0, 255, 7])
            ]
        );

        // INTEGER stays INTEGER storage class even when bound from an
        // integral Real decode path; REAL stays REAL.
        c.execute("UPDATE v SET i = ? WHERE 1", &[ParamValue::Int(43)]).unwrap();
        assert_eq!(rows(&c.query("SELECT i, typeof(i) FROM v", &[]).unwrap())[0][1], CellValue::Text("integer".into()));
        assert_eq!(rows(&c.query("SELECT r, typeof(r) FROM v", &[]).unwrap())[0][1], CellValue::Text("real".into()));

        // Bool binds as INTEGER 1/0 (bun parity).
        c.execute("UPDATE v SET i = ? WHERE 1", &[ParamValue::Bool(true)]).unwrap();
        assert_eq!(rows(&c.query("SELECT i FROM v", &[]).unwrap())[0][0], CellValue::Int(1));
    }

    #[test]
    fn run_reports_changes_and_last_insert_rowid() {
        let c = mem();
        c.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)").unwrap();
        let (changes, rowid) = c.execute("INSERT INTO t (a) VALUES (?)", &[ParamValue::Text("x".into())]).unwrap();
        assert_eq!((changes, rowid), (1, 1));
        let (changes, rowid) = c.execute("INSERT INTO t (a) VALUES (?)", &[ParamValue::Text("y".into())]).unwrap();
        assert_eq!((changes, rowid), (1, 2));
        let (changes, _) = c.execute("UPDATE t SET a = 'z' WHERE id = ?", &[ParamValue::Int(1)]).unwrap();
        assert_eq!(changes, 1);
        // Row-returning statements work through execute() (run-drain path —
        // the PRAGMA journal_mode = WAL shape db.ts drives through run()).
        // changes mirrors sqlite3_changes: a non-modifying statement keeps
        // the previous UPDATE's count — the same stale counter bun:sqlite's
        // .run() reports (it reads sqlite3_changes too).
        let (changes, _) = c.execute("PRAGMA journal_mode", &[]).unwrap();
        assert_eq!(changes, 1);
    }

    #[test]
    fn positional_parameter_count_mismatch_errors() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER, b TEXT)").unwrap();
        let e = err_msg(c.execute("INSERT INTO t VALUES (?)", &[ParamValue::Int(1), ParamValue::Int(2)]));
        assert!(e.contains("sqlite bridge"), "{e}");
        let e = err_msg(c.query("SELECT * FROM t WHERE a = ?", &[]));
        assert!(e.contains("sqlite bridge"), "{e}");
    }

    #[test]
    fn named_parameters_bind_by_declared_name() {
        let c = mem();
        c.exec("CREATE TABLE t (id INTEGER, name TEXT)").unwrap();
        // The TS expansion sends every prefix variant; only the declared
        // ":name"/"@id" spellings bind, the rest are skipped.
        let named = ParamValue::Named(vec![
            ("id".into(), ParamValue::Int(1)),
            ("@id".into(), ParamValue::Int(1)),
            (":name".into(), ParamValue::Text("n".into())),
            ("name".into(), ParamValue::Text("n".into())),
            ("$name".into(), ParamValue::Text("n".into())),
        ]);
        c.execute("INSERT INTO t (id, name) VALUES (@id, :name)", std::slice::from_ref(&named)).unwrap();
        assert_eq!(rows(&c.query("SELECT id, name FROM t", &[]).unwrap())[0], vec![CellValue::Int(1), CellValue::Text("n".into())]);
        // A named map mixed with positional args is an error (bun parity).
        let e = err_msg(c.execute("INSERT INTO t VALUES (@id, :name)", &[named, ParamValue::Int(2)]));
        assert!(e.contains("named parameter object mixed"), "{e}");
    }

    #[test]
    fn exec_runs_multi_statement_batches() {
        let c = mem();
        // The applyMigrations shape: one exec over a multi-statement batch.
        c.exec("CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);\nINSERT INTO a VALUES (1);\nINSERT INTO b SELECT x FROM a;").unwrap();
        assert_eq!(rows(&c.query("SELECT y FROM b", &[]).unwrap())[0][0], CellValue::Int(1));
    }

    #[test]
    fn transaction_three_behaviors_commit_and_rollback() {
        for behavior in ["deferred", "immediate", "exclusive"] {
            let c = mem();
            c.exec("CREATE TABLE t (a INTEGER)").unwrap();
            let mut c = c;
            c.txn_begin(behavior).unwrap();
            assert!(c.in_transaction().unwrap());
            c.execute("INSERT INTO t VALUES (1)", &[]).unwrap();
            c.txn_commit().unwrap();
            assert!(!c.in_transaction().unwrap());
            assert_eq!(rows(&c.query("SELECT COUNT(*) FROM t", &[]).unwrap())[0][0], CellValue::Int(1));

            c.txn_begin(behavior).unwrap();
            c.execute("INSERT INTO t VALUES (2)", &[]).unwrap();
            c.txn_rollback().unwrap();
            assert_eq!(rows(&c.query("SELECT COUNT(*) FROM t", &[]).unwrap())[0][0], CellValue::Int(1));
        }
        // Unknown behavior is refused.
        let mut c = mem();
        assert!(err_msg(c.txn_begin("serializable")).contains("unknown transaction behavior"));
    }

    #[test]
    fn nested_transactions_join_outer_unit() {
        let mut c = mem();
        c.exec("CREATE TABLE t (a INTEGER)").unwrap();
        c.txn_begin("deferred").unwrap();
        c.execute("INSERT INTO t VALUES (1)", &[]).unwrap();
        // Nested BEGIN would be a SQLite error if it did not JOIN.
        c.txn_begin("immediate").unwrap();
        c.execute("INSERT INTO t VALUES (2)", &[]).unwrap();
        c.txn_commit().unwrap(); // inner commit is a depth no-op
        assert!(c.in_transaction().unwrap());
        c.execute("INSERT INTO t VALUES (3)", &[]).unwrap();
        c.txn_commit().unwrap(); // outer commit lands all three
        assert_eq!(rows(&c.query("SELECT COUNT(*) FROM t", &[]).unwrap())[0][0], CellValue::Int(3));

        // An inner failure rolled back at the OUTER level drops everything.
        c.txn_begin("deferred").unwrap();
        c.execute("INSERT INTO t VALUES (4)", &[]).unwrap();
        c.txn_begin("deferred").unwrap();
        c.execute("INSERT INTO t VALUES (5)", &[]).unwrap();
        c.txn_rollback().unwrap(); // outer-level rollback ends the whole unit
        assert!(!c.in_transaction().unwrap());
        assert_eq!(rows(&c.query("SELECT COUNT(*) FROM t", &[]).unwrap())[0][0], CellValue::Int(3));

        // commit/rollback outside a transaction is an error.
        assert!(err_msg(c.txn_commit()).contains("outside a transaction"));
        assert!(err_msg(c.txn_rollback()).contains("outside a transaction"));
    }

    #[test]
    fn pragma_read_write_split() {
        let path = temp_path("pragma");
        let c = BridgeConn::open(&path).unwrap();
        // WRITE arm: "key = value" executes and yields no result set.
        assert!(c.pragma("journal_mode = WAL").unwrap().is_none());
        // READ arm: row set with the pragma column.
        let out = c.pragma("journal_mode").unwrap().unwrap();
        assert_eq!(out.columns, vec!["journal_mode"]);
        assert_eq!(rows(&out)[0][0], CellValue::Text("wal".into()));
        let out = c.pragma("synchronous").unwrap().unwrap();
        assert_eq!(out.columns, vec!["synchronous"]);
        // busy_timeout is settable and readable through the same split.
        assert!(c.pragma("busy_timeout = 5000").unwrap().is_none());
        assert_eq!(rows(&c.pragma("busy_timeout").unwrap().unwrap())[0][0], CellValue::Int(5000));
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
    }

    #[test]
    fn close_is_idempotent_and_rejects_later_calls() {
        let mut c = mem();
        c.exec("CREATE TABLE t (a INTEGER)").unwrap();
        c.close().unwrap();
        c.close().unwrap(); // second close: no-op, no error
        assert!(err_msg(c.query("SELECT 1", &[])).contains("closed"));
        assert!(err_msg(c.execute("SELECT 1", &[])).contains("closed"));
        assert!(err_msg(c.exec("SELECT 1")).contains("closed"));
        assert!(err_msg(c.txn_begin("deferred")).contains("closed"));
        assert!(err_msg(c.in_transaction()).contains("closed"));
    }

    #[test]
    fn prepare_cache_is_lru_bounded_at_256() {
        let c = mem();
        // Distinct SQL texts beyond the limit: the cache must not grow
        // unboundedly. rusqlite's cache capacity was set at open; verify it
        // survives heavy churn and statements still execute correctly
        // (evicted entries re-prepare transparently).
        for i in 0..600 {
            c.query(&format!("SELECT {i} + ?"), &[ParamValue::Int(1)]).unwrap();
        }
        // An early (long-evicted) shape still works — re-prepare path.
        let out = c.query("SELECT 0 + ?", &[ParamValue::Int(1)]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Int(1));
        // Same-text reuse hits the cache (no error, correct value).
        let out = c.query("SELECT 599 + ?", &[ParamValue::Int(1)]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Int(600));
    }

    #[test]
    fn large_text_and_blob_round_trip() {
        let c = mem();
        c.exec("CREATE TABLE t (s TEXT, b BLOB)").unwrap();
        let big_text = "漢字🚀".repeat(200_000); // ~2.8MB, multi-byte + emoji
        let big_blob: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
        c.execute(
            "INSERT INTO t VALUES (?, ?)",
            &[ParamValue::Text(big_text.clone()), ParamValue::Blob(big_blob.clone())],
        )
        .unwrap();
        let out = c.query("SELECT s, b FROM t", &[]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Text(big_text));
        assert_eq!(rows(&out)[0][1], CellValue::Blob(big_blob));
    }

    #[test]
    fn core_keeps_exact_i64_while_js_projection_is_bun_lossy_double() {
        let c = mem();
        let big = i64::MAX;
        c.exec("CREATE TABLE t (i INTEGER)").unwrap();
        c.execute("INSERT INTO t VALUES (?)", &[ParamValue::Int(big)]).unwrap();
        // The core keeps the exact i64; the napi projection converts through
        // f64 like bun's non-strict default (cell_js) — asserted in TS.
        assert_eq!(rows(&c.query("SELECT i FROM t", &[]).unwrap())[0][0], CellValue::Int(big));
        // And the JS-side value would be the lossy double:
        assert_eq!(big as f64, 9223372036854775808.0f64);
    }

    #[test]
    fn multi_statement_prepare_runs_first_statement_only_like_bun() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER)").unwrap();
        // bun:sqlite compiles only the first statement and silently drops
        // the tail: run() applies just the first INSERT.
        let (changes, _) = c.execute("INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);", &[]).unwrap();
        assert_eq!(changes, 1);
        assert_eq!(rows(&c.query("SELECT a FROM t", &[]).unwrap()), &vec![vec![CellValue::Int(2)]]);
        // Reads behave the same — first statement's rows only.
        let out = c.query("SELECT a FROM t; SELECT 99;", &[]).unwrap();
        assert_eq!(rows(&out), &vec![vec![CellValue::Int(2)]]);
        // The drizzle migrator's ALTER;UPDATE batch shape (the tail drop is
        // the exact production bun-arm behavior being reproduced).
        c.exec("CREATE TABLE p (icon_url TEXT)").unwrap();
        c.execute("ALTER TABLE p ADD icon_override TEXT; UPDATE p SET icon_override = icon_url WHERE icon_url IS NOT NULL;", &[])
            .unwrap();
        assert!(c.query("SELECT icon_override FROM p", &[]).is_ok());
    }

    #[test]
    fn semicolons_in_strings_and_comments_do_not_split_statements() {
        let c = mem();
        c.exec("CREATE TABLE t (s TEXT)").unwrap();
        c.execute("INSERT INTO t VALUES ('a;b')", &[]).unwrap();
        // A genuine single-statement error must surface, not vanish into the
        // truncation path (the ';' is inside a string literal).
        assert!(c.execute("INSERT INTO t VALUES ('c;d'); -- trailing;comment", &[]).is_ok());
        let out = c.query("SELECT s FROM t ORDER BY rowid", &[]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Text("a;b".into()));
        assert_eq!(rows(&out)[1][0], CellValue::Text("c;d".into()));
        // Comment containing a semicolon BEFORE the statement separator.
        let out = c.query("SELECT 1 -- a;b", &[]).unwrap();
        assert_eq!(rows(&out)[0][0], CellValue::Int(1));
    }

    #[test]
    fn first_statement_end_scanner() {
        assert_eq!(first_statement_end("SELECT 1"), None);
        assert_eq!(first_statement_end("SELECT 1;"), Some(8));
        assert_eq!(first_statement_end("SELECT 'a;b'; SELECT 2"), Some(12));
        assert_eq!(first_statement_end("SELECT \"a;b\" ; x"), Some(13));
        assert_eq!(first_statement_end("SELECT `a;b`; x"), Some(12));
        assert_eq!(first_statement_end("SELECT [a;b]; x"), Some(12));
        assert_eq!(first_statement_end("SELECT 1 -- a;b\n; SELECT 2"), Some(16));
        assert_eq!(first_statement_end("SELECT 1 /* a;b */; SELECT 2"), Some(18));
        assert_eq!(first_statement_end("SELECT 'it''s;ok'; x"), Some(17));
    }

    // --- packed read wire -------------------------------------------------

    fn le32(b: &[u8]) -> u32 {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    }

    fn le64f(b: &[u8]) -> f64 {
        f64::from_le_bytes(b.try_into().unwrap())
    }

    #[test]
    fn packed_layout_bytes_match_the_wire_contract() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER, b TEXT)").unwrap();
        c.execute("INSERT INTO t VALUES (?, ?)", &[ParamValue::Int(7), ParamValue::Text("hi".into())]).unwrap();
        let buf = c.query_packed("SELECT a, b FROM t", &[], true).unwrap();

        // header (32B): version, flags bit0, column_count u16, row_count u32
        assert_eq!(buf[0], PACKED_LAYOUT_VERSION);
        assert_eq!(buf[1], PACKED_FLAG_COLUMN_NAMES);
        assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 2);
        assert_eq!(le32(&buf[4..8]), 1);
        let names_len = 2 * PACKED_NAME_ENTRY_SIZE; // "a" + "b"
        let grid_offset = PACKED_HEADER_SIZE + names_len;
        let grid_len = 1 * 2 * PACKED_CELL_SIZE;
        let arena_offset = grid_offset + grid_len;
        assert_eq!(le32(&buf[8..12]), grid_offset as u32);
        assert_eq!(le32(&buf[12..16]), grid_len as u32);
        assert_eq!(le32(&buf[16..20]), PACKED_HEADER_SIZE as u32); // names_offset
        assert_eq!(le32(&buf[20..24]), names_len as u32);
        assert_eq!(le32(&buf[24..28]), arena_offset as u32);
        assert_eq!(buf.len(), arena_offset + le32(&buf[28..32]) as usize);

        // name table: (off,len) pairs pointing into the arena lead
        let n0 = (le32(&buf[32..36]), le32(&buf[36..40]));
        let n1 = (le32(&buf[40..44]), le32(&buf[44..48]));
        let arena = &buf[arena_offset..];
        assert_eq!(&arena[n0.0 as usize..(n0.0 + n0.1) as usize], b"a");
        assert_eq!(&arena[n1.0 as usize..(n1.0 + n1.1) as usize], b"b");

        // grid: cell0 = F64(7) — INTEGER reads through f64 like the object path
        let cell0 = &buf[grid_offset..grid_offset + PACKED_CELL_SIZE];
        assert_eq!(cell0[0], PACKED_TAG_F64);
        assert_eq!(&cell0[1..4], &[0, 0, 0]);
        assert_eq!(le64f(&cell0[4..12]), 7.0);
        // cell1 = TEXT "hi" behind the column names in the arena
        let cell1 = &buf[grid_offset + PACKED_CELL_SIZE..grid_offset + 2 * PACKED_CELL_SIZE];
        assert_eq!(cell1[0], PACKED_TAG_TEXT);
        let off = le32(&cell1[4..8]);
        let len = le32(&cell1[8..12]);
        assert_eq!(&arena[off as usize..(off + len) as usize], b"hi");
    }

    #[test]
    fn packed_values_shape_omits_column_names() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER)").unwrap();
        c.execute("INSERT INTO t VALUES (1)", &[]).unwrap();
        let buf = c.query_packed("SELECT a FROM t", &[], false).unwrap();
        assert_eq!(buf[1], 0); // flags bit0 clear
        assert_eq!(le32(&buf[16..20]), PACKED_NONE); // names_offset absent
        assert_eq!(le32(&buf[20..24]), 0); // names_len
        assert_eq!(le32(&buf[8..12]), PACKED_HEADER_SIZE as u32); // grid right after the header
        assert_eq!(buf.len(), PACKED_HEADER_SIZE + PACKED_CELL_SIZE + le32(&buf[28..32]) as usize);
    }

    #[test]
    fn packed_empty_result_set_keeps_columns_drops_rows() {
        let c = mem();
        c.exec("CREATE TABLE t (a INTEGER, b TEXT)").unwrap();
        let buf = c.query_packed("SELECT a, b FROM t", &[], true).unwrap();
        assert_eq!(u16::from_le_bytes([buf[2], buf[3]]), 2); // column_count survives 0 rows
        assert_eq!(le32(&buf[4..8]), 0); // row_count
        assert_eq!(le32(&buf[12..16]), 0); // grid_len
        let names_len = le32(&buf[20..24]) as usize;
        assert_eq!(names_len, 2 * PACKED_NAME_ENTRY_SIZE);
        let arena_len = le32(&buf[28..32]) as usize;
        let arena_offset = le32(&buf[24..28]) as usize;
        assert_eq!(arena_offset, PACKED_HEADER_SIZE + names_len); // empty grid
        assert_eq!(arena_len, 2); // "ab" — column names are the whole arena
        assert_eq!(&buf[arena_offset..], b"ab");
    }

    #[test]
    fn packed_all_cell_types_round_trip() {
        let c = mem();
        c.exec("CREATE TABLE v (n, i, r, t, b)").unwrap();
        c.execute(
            "INSERT INTO v VALUES (?, ?, ?, ?, ?)",
            &[ParamValue::Null, ParamValue::Int(42), ParamValue::Real(1.5), ParamValue::Text("漢字🚀".into()), ParamValue::Blob(vec![0, 255, 7])],
        )
        .unwrap();
        let buf = c.query_packed("SELECT n, i, r, t, b FROM v", &[], false).unwrap();
        let grid = &buf[PACKED_HEADER_SIZE..PACKED_HEADER_SIZE + 5 * PACKED_CELL_SIZE];
        let arena_off = le32(&buf[24..28]) as usize;
        let arena = &buf[arena_off..];
        let cell = |k: usize| &grid[k * PACKED_CELL_SIZE..(k + 1) * PACKED_CELL_SIZE];
        let payload = |k: usize| (le32(&cell(k)[4..8]), le32(&cell(k)[8..12]));

        assert_eq!(cell(0)[0], PACKED_TAG_NULL);
        assert_eq!(&cell(0)[1..12], &[0; 11]);
        assert_eq!(cell(1)[0], PACKED_TAG_F64);
        assert_eq!(le64f(&cell(1)[4..12]), 42.0);
        assert_eq!(cell(2)[0], PACKED_TAG_F64);
        assert_eq!(le64f(&cell(2)[4..12]), 1.5);
        assert_eq!(cell(3)[0], PACKED_TAG_TEXT);
        let (o, l) = payload(3);
        assert_eq!(&arena[o as usize..(o + l) as usize], "漢字🚀".as_bytes());
        assert_eq!(cell(4)[0], PACKED_TAG_BLOB);
        let (o, l) = payload(4);
        assert_eq!(&arena[o as usize..(o + l) as usize], &[0, 255, 7]);
    }

    #[test]
    fn packed_text_keeps_invalid_utf8_raw_for_ts_lossy_decode() {
        let c = mem();
        c.exec("CREATE TABLE t (b BLOB)").unwrap();
        // A blob with invalid UTF-8, CAST to TEXT: SQLite hands the raw bytes
        // back as TEXT — the packed wire must carry them UNTOUCHED (no
        // Rust-side from_utf8_lossy) so the TS TextDecoder performs the same
        // WHATWG maximal-subpart replacement the object path's lossy String
        // produces (byte-parity asserted in the TS three-arm test).
        c.execute("INSERT INTO t VALUES (?)", &[ParamValue::Blob(vec![b'a', 0xFF, 0x80, b'z'])]).unwrap();
        let buf = c.query_packed("SELECT CAST(b AS TEXT) FROM t", &[], false).unwrap();
        assert_eq!(buf[PACKED_HEADER_SIZE], PACKED_TAG_TEXT);
        let off = le32(&buf[PACKED_HEADER_SIZE + 4..PACKED_HEADER_SIZE + 8]) as usize;
        let len = le32(&buf[PACKED_HEADER_SIZE + 8..PACKED_HEADER_SIZE + 12]) as usize;
        let arena_off = le32(&buf[24..28]) as usize;
        assert_eq!(&buf[arena_off + off..arena_off + off + len], &[b'a', 0xFF, 0x80, b'z']);
    }

    #[test]
    fn packed_large_text_and_blob_offsets_stay_exact() {
        let c = mem();
        c.exec("CREATE TABLE t (s TEXT, b BLOB)").unwrap();
        let big_text = "漢字🚀".repeat(100_000); // ~1.4MB multi-byte
        let big_blob: Vec<u8> = (0..500_000u32).map(|i| (i % 251) as u8).collect();
        c.execute(
            "INSERT INTO t VALUES (?, ?)",
            &[ParamValue::Text(big_text.clone()), ParamValue::Blob(big_blob.clone())],
        )
        .unwrap();
        let buf = c.query_packed("SELECT s, b FROM t", &[], false).unwrap();
        let arena_off = le32(&buf[24..28]) as usize;
        let grid = &buf[PACKED_HEADER_SIZE..];
        let (t_off, t_len) = (le32(&grid[4..8]) as usize, le32(&grid[8..12]) as usize);
        let c1 = &grid[PACKED_CELL_SIZE..2 * PACKED_CELL_SIZE];
        let (b_off, b_len) = (le32(&c1[4..8]) as usize, le32(&c1[8..12]) as usize);
        assert_eq!(&buf[arena_off + t_off..arena_off + t_off + t_len], big_text.as_bytes());
        assert_eq!(&buf[arena_off + b_off..arena_off + b_off + b_len], big_blob.as_slice());
    }

    #[test]
    fn packed_integer_projection_is_bun_lossy_double() {
        let c = mem();
        c.exec("CREATE TABLE t (i INTEGER)").unwrap();
        c.execute("INSERT INTO t VALUES (?)", &[ParamValue::Int(9007199254740993)]).unwrap(); // 2^53+1
        let buf = c.query_packed("SELECT i FROM t", &[], false).unwrap();
        assert_eq!(buf[PACKED_HEADER_SIZE], PACKED_TAG_F64);
        // The same lossy f64 the object path hands JS (2^53+1 → 2^53).
        assert_eq!(le64f(&buf[PACKED_HEADER_SIZE + 4..PACKED_HEADER_SIZE + 12]), 9007199254740992.0f64);
    }
}
