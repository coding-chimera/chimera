//! store — R3a graph-store write path (SQLite ingest behind napi).
//!
//! Mirrors the TS `QueryBuilder` write surface (`packages/chimera/src/graph/db/
//! queries.ts`) plus the `storeExtractionResultTxn` orchestration
//! (`packages/chimera/src/graph/extraction/index.ts`), including the
//! cross-file-edge snapshot → re-attach / resurrect flow whose loss is the
//! historical #899/#1240 edge-dropping bug. Rust never owns schema truth:
//! `store_open` requires an already-initialized database (schema.sql +
//! migrations applied TS-side) and fails fast otherwise.
//!
//! Boundary discipline (same as the extraction kernel, lib.rs): calls are
//! SYNCHRONOUS and must be driven from a worker thread — do NOT call these
//! from the JS main thread, and do NOT rebuild pools on the Rust side. One
//! handle = one graph root = one SQLite connection; concurrent JS callers
//! serialize on the handle's internal mutex.
//!
//! # Wire format (STORE_ABI_VERSION = 1)
//!
//! `StoreBuffers` is five flat little-endian Buffers — meta, nodes, edges,
//! refs, arena — the store-side sibling of the extraction `ExtractBuffers`
//! (buffers.rs / `src/extraction/kernel/layout.ts`). Every fixed-width row
//! lives in its table buffer; every string is an `(offset u32, len u32)` pair
//! into the UTF-8 arena; `offset == NONE (0xFFFF_FFFF)` means "field absent".
//! THIS LAYOUT IS THE TS-ENCODER CONTRACT (R3a-2 implements the encoder
//! against it). Any change bumps `STORE_ABI_VERSION`; `store_contract_info()`
//! is the handshake the TS loader verifies before routing (ABI equality +
//! node/edge kind-table subset, loader.ts pattern).
//!
//! ## meta buffer
//!
//! header (28 bytes):
//!   0   u8   STORE_ABI_VERSION (= 1; decoder rejects mismatches)
//!   1   [3]  pad
//!   4   u32  op_count      (op rows follow the header)
//!   8   u32  file_count    (file rows follow the op rows)
//!   12  u32  node_count
//!   16  u32  edge_count
//!   20  u32  ref_count
//!   24  u32  arena byte length
//!
//! op row (48 bytes), `op_count` rows directly after the header:
//!   0   u8   op code (see OP_* below; unknown codes are a hard error)
//!   1   [3]  pad
//!   4   u32  file_index (index into the file table, NONE = op has no file)
//!   8   u32  node_start (row index into the node table)
//!   12  u32  node_end   (EXCLUSIVE; NONE = same as start, i.e. empty range)
//!   16  u32  edge_start
//!   20  u32  edge_end   (exclusive, NONE = empty)
//!   24  u32  ref_start
//!   28  u32  ref_end    (exclusive, NONE = empty)
//!   32  str  arg (op-specific NUL-joined payload, see OP_* docs)
//!   40  u32  flags (op-specific bitfield, see OP_* docs)
//!   44  u32  pad
//!
//! file row (64 bytes), `file_count` rows after the op table:
//!   0   str  path          (required)
//!   8   str  content_hash  (required)
//!   16  str  language      (required)
//!   24  str  errors_json   (JSON array text or absent → NULL; the encoder
//!                           decides, mirroring TS `errors ? JSON : null`)
//!   32  i64  size
//!   40  f64  modified_at   (ms; may be fractional exactly like stats.mtimeMs)
//!   48  i64  indexed_at    (ms epoch; encoder supplies Date.now())
//!   56  u32  node_count    (encoder supplies — NOTE: the TS orchestration
//!                           records result.nodes.length, the PRE-validity-
//!                           filter count, so the encoder must too)
//!   60  u32  pad
//!
//! ## nodes buffer — store node row (140 bytes)
//!
//! One row per `insertNode` call (queries.ts:406, INSERT OR REPLACE, 23
//! columns). Derived values are COMPUTED BY THE TS ENCODER and passed in —
//! Rust never duplicates `buildSearchText` / `serializeParamsJson` /
//! `JSON.stringify(decorators)` logic (single source of truth stays TS):
//!
//!   0   str  id                 (required, non-empty)
//!   8   str  kind               (required, non-empty)
//!   16  str  name               (required, non-empty)
//!   24  str  qualified_name     (absent → falls back to name, TS `?? name`)
//!   32  str  file_path          (required, non-empty)
//!   40  str  language           (required, non-empty)
//!   48  u32  start_line
//!   52  u32  end_line
//!   56  u32  start_column
//!   60  u32  end_column
//!   64  str  docstring           (absent → NULL)
//!   72  str  signature           (absent → NULL)
//!   80  str  visibility          (absent → NULL)
//!   88  u8   flags — bit0 is_exported, bit1 is_async, bit2 is_static,
//!                   bit3 is_abstract (each stored as 0/1 integer)
//!   89  [3]  pad
//!   92  str  decorators_json     (JSON array text pre-serialized by the
//!   100 str  type_parameters_json encoder, or absent → NULL)
//!   108 str  return_type         (absent → NULL)
//!   116 str  params_json         (compact [{"n":..,"t":..}] text pre-
//!                                 serialized by the encoder, absent → NULL)
//!   124 str  search_text         (pre-computed buildSearchText output;
//!                                 absent → '' — TS always binds a string)
//!   132 i64  updated_at          (ms epoch; encoder supplies the TS
//!                                 `node.updatedAt ?? Date.now()` value)
//!
//! A row missing any required field is SKIPPED (counted in
//! `nodes_skipped_invalid`), mirroring TS insertNode's validation guard and
//! the extraction path's validNodes pre-filter (issue #42).
//!
//! ## edges buffer — store edge row (48 bytes)
//!
//! One row per `insertEdge` (queries.ts:1611, INSERT OR IGNORE, identity
//! dedup via idx_edges_identity):
//!   0   str  source         (node id, required)
//!   8   str  target         (node id, required)
//!   16  str  kind           (required)
//!   24  str  metadata_json  (JSON object text or absent → NULL; passed
//!                            through BYTE-IDENTICAL — the encoder must send
//!                            the same compact JSON.stringify text TS would)
//!   32  u32  line           (NONE → NULL)
//!   36  u32  col            (NONE → NULL)
//!   40  str  provenance     (absent → NULL)
//!
//! Batch inserts apply the TS `insertEdges` dangling-endpoint filter: both
//! endpoints must exist in `nodes` (getExistingNodeIds semantics, chunked at
//! SQLITE_PARAM_CHUNK_SIZE = 500) or the edge is dropped (counted in
//! `edges_dropped_dangling`).
//!
//! ## refs buffer — store unresolved-ref row (56 bytes)
//!
//! One row per `insertUnresolvedRef` (queries.ts, plain INSERT; `status`
//! defaults to 'pending' in the schema):
//!   0   str  from_node_id     (required)
//!   8   str  reference_name   (required)
//!   16  str  reference_kind   (required)
//!   24  u32  line             (NONE → 0)
//!   28  u32  col              (NONE → 0)
//!   32  str  candidates_json  (JSON array text or absent → NULL)
//!   40  str  file_path        (absent → '' standalone; inside
//!                             OP_STORE_FILE_RESULT absent → the op's file
//!                             path, mirroring TS `ref.filePath ?? filePath`)
//!   48  str  language         (absent → 'unknown' standalone; inside
//!                             OP_STORE_FILE_RESULT absent → the file
//!                             record's language, mirroring `?? language`)
//!
//! ## arena buffer
//!
//! UTF-8 bytes, no alignment, no dedup requirement; str refs index into it.
//! Out-of-bounds or non-UTF-8 refs are hard wire errors.
//!
//! # Op codes (meta op table)
//!
//! - `OP_STORE_FILE_RESULT (1)` — the full `storeExtractionResultTxn` for one
//!   file, in ONE transaction with the exact TS ordering:
//!   ① content-hash skip check (unchanged file → no writes, `files_skipped_
//!   unchanged`); ② snapshot incoming cross-file edges (JOIN query excluding
//!   kind='contains' and same-file sources) BEFORE the delete; ③ deleteFile
//!   cascade (nodes of the file + files row; edges/unresolved_refs/file_
//!   semantics cascade via FK ON DELETE CASCADE); ④ insert the node range
//!   (validity-filtered) and build the (kind,name)→id re-attach map (last
//!   duplicate wins, TS Map.set order); ⑤ for each snapshot edge: re-attach
//!   to the new target id when (targetKind,targetName) survived, else
//!   resurrect it as its ORIGINAL unresolved ref from the metadata
//!   refName/refKind stamp (no stamp → silent drop, "silent beats wrong");
//!   re-attached edges go through the dangling filter, resurrected refs are
//!   inserted after them — both batches in TS order; ⑥ insert the edge range
//!   filtered to endpoints present in THIS batch's inserted node ids (then
//!   the usual DB existence check); ⑦ insert the ref range filtered to
//!   fromNodeId in this batch's inserted ids, with filePath/language context
//!   fill; ⑧ upsertFile LAST (contentHash skip-guard correctness under the
//!   BUSY-retry replay, commitExtractionResult contract). `file_index`
//!   selects the file record; node/edge/ref ranges carry the extraction
//!   payload.
//! - `OP_DELETE_FILE (2)` — `arg` = file path. flags bit0
//!   (`DELETE_FILE_FLAG_RESURRECT`) first resurrects ALL incoming cross-file
//!   edges as pending refs (removeFileResurrectingRefs, #1240 removal case),
//!   then cascades — same transaction.
//! - `OP_INSERT_NODES (3)` / `OP_INSERT_EDGES (4)` / `OP_INSERT_REFS (5)` —
//!   the row range through the matching QueryBuilder batch method semantics
//!   (one transaction per op when standalone; JOINs the batch transaction
//!   inside commit_batch).
//! - `OP_UPSERT_FILE (6)` — `file_index` record via upsertFile (INSERT … ON
//!   CONFLICT(path) DO UPDATE; the `generated` column is intentionally NOT
//!   in the update set, matching TS).
//! - `OP_DELETE_UNRESOLVED_BY_IDS (7)` — `arg` = NUL-joined decimal row ids;
//!   dedup + chunked `DELETE … WHERE id IN (…)`, returns change counts.
//! - `OP_DELETE_SPECIFIC_RESOLVED_REFS (8)` — `arg` = NUL-joined triples
//!   (fromNodeId, referenceName, referenceKind), flat (length % 3 == 0);
//!   per-triple DELETE, change counts summed.
//! - `OP_MARK_REFS_FAILED (9)` — same triple encoding; UPDATE status='failed'
//!   with name_tail = reference_name after its last '.' or ':' (#1240 retry
//!   surface).
//!
//! Standalone `store_insert_*` calls ignore the op/file tables and take
//! their rows from the header counts (whole-table ranges).
//!
//! # Transaction semantics
//!
//! Mirrors the sqlite-adapter: `transaction()` tracks a depth counter and
//! nested calls JOIN the outer transaction (plain BEGIN/COMMIT, NO
//! savepoints); a failure anywhere rolls the whole unit back. commit_batch =
//! exactly one BEGIN/COMMIT pair for all its ops.
#![allow(clippy::too_many_arguments)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{Connection, OptionalExtension};

use crate::buffers::{EDGE_KINDS, NODE_KINDS, NONE};

/// Store wire ABI — independent of KERNEL_ABI_VERSION (new handshake per the
/// R3a contract; TS loader verifies equality, not ordering).
pub const STORE_ABI_VERSION: u8 = 1;
/// Semantic version string reported alongside the ABI number.
pub const STORE_VERSION: &str = "1.0.0";

/// Mirror of SQLITE_PARAM_CHUNK_SIZE (queries.ts:52) — IN-list chunking under
/// the lowest common SQLite parameter limit across bun:sqlite / node:sqlite.
pub const SQLITE_PARAM_CHUNK_SIZE: usize = 500;

pub const STORE_META_HEADER_SIZE: usize = 28;
pub const STORE_OP_ROW_SIZE: usize = 48;
pub const STORE_FILE_ROW_SIZE: usize = 64;
pub const STORE_NODE_ROW_SIZE: usize = 140;
pub const STORE_EDGE_ROW_SIZE: usize = 48;
pub const STORE_REF_ROW_SIZE: usize = 56;

pub const OP_STORE_FILE_RESULT: u8 = 1;
pub const OP_DELETE_FILE: u8 = 2;
pub const OP_INSERT_NODES: u8 = 3;
pub const OP_INSERT_EDGES: u8 = 4;
pub const OP_INSERT_REFS: u8 = 5;
pub const OP_UPSERT_FILE: u8 = 6;
pub const OP_DELETE_UNRESOLVED_BY_IDS: u8 = 7;
pub const OP_DELETE_SPECIFIC_RESOLVED_REFS: u8 = 8;
pub const OP_MARK_REFS_FAILED: u8 = 9;

/// OP_DELETE_FILE flags bit0: resurrect incoming cross-file edges as pending
/// refs before the cascade (removeFileResurrectingRefs, #1240 removal case).
pub const DELETE_FILE_FLAG_RESURRECT: u32 = 1;

// ---------------------------------------------------------------------------
// Wire decoding
// ---------------------------------------------------------------------------

fn wire_err(msg: String) -> Error {
    Error::from_reason(format!("store wire: {msg}"))
}

fn rd_u8(b: &[u8], at: usize) -> Result<u8> {
    b.get(at).copied().ok_or_else(|| wire_err(format!("u8 at {at} out of bounds (len {})", b.len())))
}

fn rd_u32(b: &[u8], at: usize) -> Result<u32> {
    let s = b.get(at..at + 4).ok_or_else(|| wire_err(format!("u32 at {at} out of bounds (len {})", b.len())))?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn rd_i64(b: &[u8], at: usize) -> Result<i64> {
    let s = b
        .get(at..at + 8)
        .ok_or_else(|| wire_err(format!("i64 at {at} out of bounds (len {})", b.len())))?;
    Ok(i64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

fn rd_f64(b: &[u8], at: usize) -> Result<f64> {
    let s = b
        .get(at..at + 8)
        .ok_or_else(|| wire_err(format!("f64 at {at} out of bounds (len {})", b.len())))?
        .try_into()
        .map_err(|_| wire_err("f64 slice".into()))?;
    Ok(f64::from_le_bytes(s))
}

/// (offset, len) arena string; NONE offset → None.
fn rd_str<'a>(row: &[u8], at: usize, arena: &'a [u8]) -> Result<Option<&'a str>> {
    let off = rd_u32(row, at)?;
    if off == NONE {
        return Ok(None);
    }
    let len = rd_u32(row, at + 4)? as usize;
    let s = arena
        .get(off as usize..off as usize + len)
        .ok_or_else(|| wire_err(format!("arena ref {off}+{len} out of bounds (arena {})", arena.len())))?;
    std::str::from_utf8(s).map(Some).map_err(|_| wire_err(format!("arena ref {off}+{len} is not UTF-8")))
}

/// NONE-valued range end collapses to start (empty range).
fn range(start: u32, end: u32) -> std::ops::Range<u32> {
    let end = if end == NONE { start } else { end };
    start..end.max(start)
}

#[derive(Default)]
struct NodeView<'a> {
    id: Option<&'a str>,
    kind: Option<&'a str>,
    name: Option<&'a str>,
    qualified_name: Option<&'a str>,
    file_path: Option<&'a str>,
    language: Option<&'a str>,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    docstring: Option<&'a str>,
    signature: Option<&'a str>,
    visibility: Option<&'a str>,
    flags: u8,
    decorators_json: Option<&'a str>,
    type_parameters_json: Option<&'a str>,
    return_type: Option<&'a str>,
    params_json: Option<&'a str>,
    search_text: Option<&'a str>,
    updated_at: i64,
}

impl NodeView<'_> {
    /// TS validNodes filter / insertNode guard: id && kind && name && filePath
    /// && language (empty strings are falsy → invalid).
    fn valid(&self) -> bool {
        [self.id, self.kind, self.name, self.file_path, self.language]
            .iter()
            .all(|f| f.is_some_and(|s| !s.is_empty()))
    }
}

#[derive(Default)]
struct EdgeView<'a> {
    source: Option<&'a str>,
    target: Option<&'a str>,
    kind: Option<&'a str>,
    metadata_json: Option<&'a str>,
    line: Option<u32>,
    col: Option<u32>,
    provenance: Option<&'a str>,
}

#[derive(Default)]
struct RefView<'a> {
    from_node_id: Option<&'a str>,
    reference_name: Option<&'a str>,
    reference_kind: Option<&'a str>,
    line: Option<u32>,
    col: Option<u32>,
    candidates_json: Option<&'a str>,
    file_path: Option<&'a str>,
    language: Option<&'a str>,
}

struct FileView<'a> {
    path: Option<&'a str>,
    content_hash: Option<&'a str>,
    language: Option<&'a str>,
    errors_json: Option<&'a str>,
    size: i64,
    modified_at: f64,
    indexed_at: i64,
    node_count: u32,
}

struct OpView<'a> {
    code: u8,
    file_index: Option<u32>,
    nodes: std::ops::Range<u32>,
    edges: std::ops::Range<u32>,
    refs: std::ops::Range<u32>,
    arg: Option<&'a str>,
    flags: u32,
}

/// Decoded StoreBuffers — borrowed views, zero copies until SQL binding.
struct Wire<'a> {
    nodes: &'a [u8],
    edges: &'a [u8],
    refs: &'a [u8],
    arena: &'a [u8],
    meta: &'a [u8],
    op_count: u32,
    file_count: u32,
    node_count: u32,
    edge_count: u32,
    ref_count: u32,
}

impl<'a> Wire<'a> {
    fn decode(meta: &'a [u8], nodes: &'a [u8], edges: &'a [u8], refs: &'a [u8], arena: &'a [u8]) -> Result<Self> {
        if meta.len() < STORE_META_HEADER_SIZE {
            return Err(wire_err(format!("meta {} bytes < header {STORE_META_HEADER_SIZE}", meta.len())));
        }
        let abi = rd_u8(meta, 0)?;
        if abi != STORE_ABI_VERSION {
            return Err(wire_err(format!("abi {abi} != STORE_ABI_VERSION {STORE_ABI_VERSION}")));
        }
        let w = Wire {
            meta,
            nodes,
            edges,
            refs,
            arena,
            op_count: rd_u32(meta, 4)?,
            file_count: rd_u32(meta, 8)?,
            node_count: rd_u32(meta, 12)?,
            edge_count: rd_u32(meta, 16)?,
            ref_count: rd_u32(meta, 20)?,
        };
        let arena_len = rd_u32(meta, 24)? as usize;
        if arena_len > arena.len() {
            return Err(wire_err(format!("meta arena_len {arena_len} > arena buffer {}", arena.len())));
        }
        if nodes.len() < w.node_count as usize * STORE_NODE_ROW_SIZE {
            return Err(wire_err("nodes buffer shorter than node_count rows".into()));
        }
        if edges.len() < w.edge_count as usize * STORE_EDGE_ROW_SIZE {
            return Err(wire_err("edges buffer shorter than edge_count rows".into()));
        }
        if refs.len() < w.ref_count as usize * STORE_REF_ROW_SIZE {
            return Err(wire_err("refs buffer shorter than ref_count rows".into()));
        }
        let ops_end = STORE_META_HEADER_SIZE + w.op_count as usize * STORE_OP_ROW_SIZE;
        let files_end = ops_end + w.file_count as usize * STORE_FILE_ROW_SIZE;
        if meta.len() < files_end {
            return Err(wire_err(format!("meta {} bytes < op/file tables end {files_end}", meta.len())));
        }
        Ok(w)
    }

    fn op(&self, i: u32) -> Result<OpView<'a>> {
        if i >= self.op_count {
            return Err(wire_err(format!("op index {i} >= op_count {}", self.op_count)));
        }
        let at = STORE_META_HEADER_SIZE + i as usize * STORE_OP_ROW_SIZE;
        let row = &self.meta[at..at + STORE_OP_ROW_SIZE];
        let file_index = rd_u32(row, 4)?;
        Ok(OpView {
            code: rd_u8(row, 0)?,
            file_index: if file_index == NONE { None } else { Some(file_index) },
            nodes: range(rd_u32(row, 8)?, rd_u32(row, 12)?),
            edges: range(rd_u32(row, 16)?, rd_u32(row, 20)?),
            refs: range(rd_u32(row, 24)?, rd_u32(row, 28)?),
            arg: rd_str(row, 32, self.arena)?,
            flags: rd_u32(row, 40)?,
        })
    }

    fn file(&self, i: u32) -> Result<FileView<'a>> {
        if i >= self.file_count {
            return Err(wire_err(format!("file index {i} >= file_count {}", self.file_count)));
        }
        let at = STORE_META_HEADER_SIZE + self.op_count as usize * STORE_OP_ROW_SIZE + i as usize * STORE_FILE_ROW_SIZE;
        let row = &self.meta[at..at + STORE_FILE_ROW_SIZE];
        Ok(FileView {
            path: rd_str(row, 0, self.arena)?,
            content_hash: rd_str(row, 8, self.arena)?,
            language: rd_str(row, 16, self.arena)?,
            errors_json: rd_str(row, 24, self.arena)?,
            size: rd_i64(row, 32)?,
            modified_at: rd_f64(row, 40)?,
            indexed_at: rd_i64(row, 48)?,
            node_count: rd_u32(row, 56)?,
        })
    }

    fn node(&self, i: u32) -> Result<NodeView<'a>> {
        if i >= self.node_count {
            return Err(wire_err(format!("node index {i} >= node_count {}", self.node_count)));
        }
        let at = i as usize * STORE_NODE_ROW_SIZE;
        let row = &self.nodes[at..at + STORE_NODE_ROW_SIZE];
        let a = self.arena;
        Ok(NodeView {
            id: rd_str(row, 0, a)?,
            kind: rd_str(row, 8, a)?,
            name: rd_str(row, 16, a)?,
            qualified_name: rd_str(row, 24, a)?,
            file_path: rd_str(row, 32, a)?,
            language: rd_str(row, 40, a)?,
            start_line: rd_u32(row, 48)?,
            end_line: rd_u32(row, 52)?,
            start_column: rd_u32(row, 56)?,
            end_column: rd_u32(row, 60)?,
            docstring: rd_str(row, 64, a)?,
            signature: rd_str(row, 72, a)?,
            visibility: rd_str(row, 80, a)?,
            flags: rd_u8(row, 88)?,
            decorators_json: rd_str(row, 92, a)?,
            type_parameters_json: rd_str(row, 100, a)?,
            return_type: rd_str(row, 108, a)?,
            params_json: rd_str(row, 116, a)?,
            search_text: rd_str(row, 124, a)?,
            updated_at: rd_i64(row, 132)?,
        })
    }

    fn edge(&self, i: u32) -> Result<EdgeView<'a>> {
        if i >= self.edge_count {
            return Err(wire_err(format!("edge index {i} >= edge_count {}", self.edge_count)));
        }
        let at = i as usize * STORE_EDGE_ROW_SIZE;
        let row = &self.edges[at..at + STORE_EDGE_ROW_SIZE];
        let a = self.arena;
        let line = rd_u32(row, 32)?;
        let col = rd_u32(row, 36)?;
        Ok(EdgeView {
            source: rd_str(row, 0, a)?,
            target: rd_str(row, 8, a)?,
            kind: rd_str(row, 16, a)?,
            metadata_json: rd_str(row, 24, a)?,
            line: if line == NONE { None } else { Some(line) },
            col: if col == NONE { None } else { Some(col) },
            provenance: rd_str(row, 40, a)?,
        })
    }

    fn r#ref(&self, i: u32) -> Result<RefView<'a>> {
        if i >= self.ref_count {
            return Err(wire_err(format!("ref index {i} >= ref_count {}", self.ref_count)));
        }
        let at = i as usize * STORE_REF_ROW_SIZE;
        let row = &self.refs[at..at + STORE_REF_ROW_SIZE];
        let a = self.arena;
        let line = rd_u32(row, 24)?;
        let col = rd_u32(row, 28)?;
        Ok(RefView {
            from_node_id: rd_str(row, 0, a)?,
            reference_name: rd_str(row, 8, a)?,
            reference_kind: rd_str(row, 16, a)?,
            line: if line == NONE { None } else { Some(line) },
            col: if col == NONE { None } else { Some(col) },
            candidates_json: rd_str(row, 32, a)?,
            file_path: rd_str(row, 40, a)?,
            language: rd_str(row, 48, a)?,
        })
    }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Copy)]
struct Stats {
    nodes_inserted: u32,
    nodes_skipped_invalid: u32,
    edges_inserted: u32,
    edges_dropped_dangling: u32,
    edges_dropped_not_in_batch: u32,
    edges_reattached: u32,
    refs_inserted: u32,
    refs_dropped_not_in_batch: u32,
    refs_resurrected: u32,
    refs_deleted: u32,
    refs_marked_failed: u32,
    files_deleted: u32,
    files_upserted: u32,
    files_skipped_unchanged: u32,
}

// ---------------------------------------------------------------------------
// SQL core — statement-for-statement mirrors of QueryBuilder methods.
// prepare_cached is the rusqlite analogue of the TS `stmts` lazy cache.
// ---------------------------------------------------------------------------

const INSERT_NODE_SQL: &str = "INSERT OR REPLACE INTO nodes (
  id, kind, name, qualified_name, file_path, language,
  start_line, end_line, start_column, end_column,
  docstring, signature, visibility,
  is_exported, is_async, is_static, is_abstract,
  decorators, type_parameters, return_type, params_json, search_text, updated_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
  ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
)";

const INSERT_EDGE_SQL: &str =
    "INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

const INSERT_REF_SQL: &str = "INSERT INTO unresolved_refs
  (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";

const UPSERT_FILE_SQL: &str = "INSERT INTO files
  (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(path) DO UPDATE SET
    content_hash = ?2, language = ?3, size = ?4,
    modified_at = ?5, indexed_at = ?6, node_count = ?7, errors = ?8";

/// getCrossFileIncomingEdgesWithTarget (queries.ts:2383) — verbatim SQL.
const CROSS_FILE_INCOMING_SQL: &str = "SELECT e.source, e.kind, e.metadata, e.line, e.col, e.provenance,
    tgt.name AS target_name, tgt.kind AS target_kind,
    src.file_path AS source_file_path, src.language AS source_language
  FROM edges e
  JOIN nodes tgt ON tgt.id = e.target
  JOIN nodes src ON src.id = e.source
  WHERE tgt.file_path = ?1
    AND e.kind != 'contains'
    AND src.file_path != ?1";

/// metadata NULL vs malformed-JSON parity: TS rowToEdge runs safeJsonParse —
/// invalid text degrades to undefined (re-bind → NULL). Valid compact JSON is
/// passed through byte-identical (no parse/re-stringify round trip, which
/// could reorder keys differently from JS insertion order).
fn metadata_sql(md: Option<&str>) -> Option<String> {
    md.filter(|s| serde_json::from_str::<serde_json::Value>(s).is_ok()).map(|s| s.to_string())
}

fn sql_insert_node(conn: &Connection, n: &NodeView) -> rusqlite::Result<()> {
    conn.prepare_cached(INSERT_NODE_SQL)?.execute(rusqlite::params![
        n.id,
        n.kind,
        n.name,
        n.qualified_name.or(n.name),
        n.file_path,
        n.language,
        n.start_line,
        n.end_line,
        n.start_column,
        n.end_column,
        n.docstring,
        n.signature,
        n.visibility,
        (n.flags & 1) as i64,
        ((n.flags >> 1) & 1) as i64,
        ((n.flags >> 2) & 1) as i64,
        ((n.flags >> 3) & 1) as i64,
        n.decorators_json,
        n.type_parameters_json,
        n.return_type,
        n.params_json,
        n.search_text.unwrap_or(""),
        n.updated_at,
    ])?;
    Ok(())
}

/// getExistingNodeIds (queries.ts) — dedup + chunked IN-list.
fn sql_existing_node_ids<'a, I: IntoIterator<Item = &'a str>>(conn: &Connection, ids: I) -> rusqlite::Result<HashSet<String>> {
    let unique: Vec<&str> = {
        let mut seen = HashSet::new();
        ids.into_iter().filter(|id| seen.insert(*id)).collect()
    };
    let mut out = HashSet::new();
    for chunk in unique.chunks(SQLITE_PARAM_CHUNK_SIZE) {
        let sql = format!("SELECT id FROM nodes WHERE id IN ({})", vec!["?"; chunk.len()].join(","));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| r.get::<_, String>(0))?;
        for row in rows {
            out.insert(row?);
        }
    }
    Ok(out)
}

/// insertEdges — dangling-endpoint filter, then INSERT OR IGNORE per row.
fn sql_insert_edge_rows<'a>(conn: &Connection, rows: impl Iterator<Item = EdgeBind<'a>>, stats: &mut Stats, reattached: bool) -> rusqlite::Result<()> {
    let binds: Vec<EdgeBind<'a>> = rows.collect();
    if binds.is_empty() {
        return Ok(());
    }
    let existing = sql_existing_node_ids(conn, binds.iter().flat_map(|b| [b.source, b.target.as_str()]))?;
    for b in &binds {
        if !existing.contains(b.source) || !existing.contains(b.target.as_str()) {
            stats.edges_dropped_dangling += 1;
            continue;
        }
        let changes = conn.prepare_cached(INSERT_EDGE_SQL)?.execute(rusqlite::params![
            b.source,
            b.target.as_str(),
            b.kind,
            b.metadata.as_deref(),
            b.line,
            b.col,
            b.provenance,
        ])?;
        if reattached {
            stats.edges_reattached += changes as u32;
        } else {
            stats.edges_inserted += changes as u32;
        }
    }
    Ok(())
}

/// One bound edge insert. `target` is owned because the re-attach path
/// rewrites it to the freshly mapped node id; everything else borrows the
/// wire arena (or the snapshot row) zero-copy.
struct EdgeBind<'a> {
    source: &'a str,
    target: String,
    kind: &'a str,
    metadata: Option<String>,
    line: Option<i64>,
    col: Option<i64>,
    provenance: Option<&'a str>
}

struct RefBind {
    from_node_id: String,
    reference_name: String,
    reference_kind: String,
    line: i64,
    col: i64,
    candidates_json: Option<String>,
    file_path: String,
    language: String,
}

fn sql_insert_ref_binds(conn: &Connection, binds: &[RefBind], stats: &mut Stats) -> rusqlite::Result<()> {
    for b in binds {
        let changes = conn.prepare_cached(INSERT_REF_SQL)?.execute(rusqlite::params![
            b.from_node_id,
            b.reference_name,
            b.reference_kind,
            b.line,
            b.col,
            b.candidates_json.as_deref(),
            b.file_path,
            b.language,
        ])?;
        stats.refs_inserted += changes as u32;
    }
    Ok(())
}

/// deleteFile (queries.ts) — nodes of the file, then the files row; edges /
/// unresolved_refs / file_semantics cascade via FK ON DELETE CASCADE.
fn sql_delete_file(conn: &Connection, path: &str, stats: &mut Stats) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM nodes WHERE file_path = ?1")?.execute(rusqlite::params![path])?;
    conn.prepare_cached("DELETE FROM files WHERE path = ?1")?.execute(rusqlite::params![path])?;
    stats.files_deleted += 1;
    Ok(())
}

fn sql_upsert_file(conn: &Connection, f: &FileView, stats: &mut Stats) -> rusqlite::Result<()> {
    conn.prepare_cached(UPSERT_FILE_SQL)?.execute(rusqlite::params![
        f.path,
        f.content_hash,
        f.language,
        f.size,
        f.modified_at,
        f.indexed_at,
        f.node_count,
        f.errors_json,
    ])?;
    stats.files_upserted += 1;
    Ok(())
}

/// One snapshot row from CROSS_FILE_INCOMING_SQL.
struct CrossEdge {
    source: String,
    kind: String,
    metadata: Option<String>,
    line: Option<i64>,
    col: Option<i64>,
    provenance: Option<String>,
    target_name: String,
    target_kind: String,
    source_file_path: String,
    source_language: String,
}

fn sql_snapshot_cross_file_incoming(conn: &Connection, path: &str) -> rusqlite::Result<Vec<CrossEdge>> {
    let mut stmt = conn.prepare_cached(CROSS_FILE_INCOMING_SQL)?;
    let rows = stmt.query_map(rusqlite::params![path], |r| {
        Ok(CrossEdge {
            source: r.get(0)?,
            kind: r.get(1)?,
            metadata: r.get(2)?,
            line: r.get(3)?,
            col: r.get(4)?,
            provenance: r.get(5)?,
            target_name: r.get(6)?,
            target_kind: r.get(7)?,
            source_file_path: r.get(8)?,
            source_language: r.get(9)?,
        })
    })?;
    rows.collect()
}

/// resurrectRefFromDroppedEdge (extraction/index.ts:889) — rebuild the
/// ORIGINAL unresolved ref from the metadata refName/refKind stamp; None
/// (silent drop) without a usable stamp.
fn resurrect_ref(e: &CrossEdge) -> Option<RefBind> {
    let md = e.metadata.as_deref()?;
    let v: serde_json::Value = serde_json::from_str(md).ok()?;
    let ref_name = v.get("refName").and_then(|x| x.as_str())?;
    if ref_name.is_empty() {
        return None;
    }
    // TS: typeof refKind === 'string' ? refKind : e.kind — empty string
    // passes the typeof check, so only a non-string falls back to e.kind.
    let ref_kind = v.get("refKind").and_then(|x| x.as_str()).unwrap_or(e.kind.as_str());
    Some(RefBind {
        from_node_id: e.source.clone(),
        reference_name: ref_name.to_string(),
        reference_kind: ref_kind.to_string(),
        line: e.line.unwrap_or(0),
        col: e.col.unwrap_or(0),
        candidates_json: None,
        file_path: e.source_file_path.clone(),
        language: e.source_language.clone(),
    })
}

/// referenceNameTail (queries.ts:138) — segment after the last '.' or ':'.
fn reference_name_tail(name: &str) -> &str {
    match name.rfind(['.', ':']) {
        Some(idx) => &name[idx + 1..],
        None => name,
    }
}

// ---------------------------------------------------------------------------
// Op execution
// ---------------------------------------------------------------------------

/// Owned re-attach/resurrect plan so borrows of `incoming` and the kind/name
/// map coexist without lifetime entanglement.
struct ReattachPlan<'a> {
    reinserted: Vec<EdgeBind<'a>>,
    resurrected: Vec<RefBind>,
}

fn plan_reattach<'i>(incoming: &'i [CrossEdge], by_kind_name: &HashMap<String, String>) -> ReattachPlan<'i> {
    let mut plan = ReattachPlan { reinserted: Vec::new(), resurrected: Vec::new() };
    for e in incoming {
        let key = format!("{}\0{}", e.target_kind, e.target_name);
        match by_kind_name.get(&key) {
            Some(new_id) => plan.reinserted.push(EdgeBind {
                source: e.source.as_str(),
                target: new_id.clone(),
                kind: e.kind.as_str(),
                metadata: metadata_sql(e.metadata.as_deref()),
                line: e.line,
                col: e.col,
                provenance: e.provenance.as_deref(),
            }),
            None => {
                if let Some(r) = resurrect_ref(e) {
                    plan.resurrected.push(r);
                }
            }
        }
    }
    plan
}

/// OP_STORE_FILE_RESULT — storeExtractionResultTxn, step for step.
fn op_store_file_result<'a>(conn: &Connection, wire: &Wire<'a>, op: &OpView<'a>, stats: &mut Stats) -> Result<()> {
    let file = match op.file_index {
        Some(i) => wire.file(i)?,
        None => return Err(wire_err("OP_STORE_FILE_RESULT without file_index".into())),
    };
    let path = file.path.ok_or_else(|| wire_err("file row without path".into()))?;
    let content_hash = file.content_hash.ok_or_else(|| wire_err("file row without content_hash".into()))?;

    // ① skip guard — the file record is written LAST (⑧), so a failed commit
    // can never make its own retry skip the work.
    let existing: Option<String> = conn
        .prepare_cached("SELECT content_hash FROM files WHERE path = ?1")
        .map_err(err)?
        .query_row(rusqlite::params![path], |r| r.get(0))
        .optional()
        .map_err(err)?;
    if existing.as_deref() == Some(content_hash) {
        stats.files_skipped_unchanged += 1;
        return Ok(());
    }

    // ② snapshot BEFORE the delete (#899).
    let incoming = match &existing {
        Some(_) => sql_snapshot_cross_file_incoming(conn, path).map_err(err)?,
        None => Vec::new(),
    };

    // ③ deleteFile cascade.
    if existing.is_some() {
        sql_delete_file(conn, path, stats).map_err(err)?;
    }

    // ④ nodes — validity filter, insert, (kind,name)→id map (last wins).
    let mut by_kind_name: HashMap<String, String> = HashMap::new();
    let mut inserted_ids: HashSet<&str> = HashSet::new();
    for i in op.nodes.clone() {
        let n = wire.node(i)?;
        if !n.valid() {
            stats.nodes_skipped_invalid += 1;
            continue;
        }
        sql_insert_node(conn, &n).map_err(err)?;
        stats.nodes_inserted += 1;
        inserted_ids.insert(n.id.unwrap());
        by_kind_name.insert(format!("{}\0{}", n.kind.unwrap(), n.name.unwrap()), n.id.unwrap().to_string());
    }

    // ⑤ re-attach / resurrect, TS batch order: edges first, then refs.
    if !incoming.is_empty() {
        let plan = plan_reattach(&incoming, &by_kind_name);
        stats.refs_resurrected += plan.resurrected.len() as u32;
        sql_insert_edge_rows(conn, plan.reinserted.into_iter(), stats, true).map_err(err)?;
        sql_insert_ref_binds(conn, &plan.resurrected, stats).map_err(err)?;
    }

    let mut batch_binds: Vec<EdgeBind> = Vec::new();
    for i in op.edges.clone() {
        let e = wire.edge(i)?;
        let (Some(source), Some(target), Some(kind)) = (e.source, e.target, e.kind) else {
            return Err(wire_err("edge row without source/target/kind".into()));
        };
        if !inserted_ids.contains(source) || !inserted_ids.contains(target) {
            stats.edges_dropped_not_in_batch += 1;
            continue;
        }
        batch_binds.push(EdgeBind {
            source,
            target: target.to_string(),
            kind,
            metadata: metadata_sql(e.metadata_json),
            line: e.line.map(|v| v as i64),
            col: e.col.map(|v| v as i64),
            provenance: e.provenance,
        });
    }
    sql_insert_edge_rows(conn, batch_binds.into_iter(), stats, false).map_err(err)?;

    // ⑦ refs — fromNodeId must be in this batch; filePath/language context
    // fill mirrors `ref.filePath ?? filePath` / `ref.language ?? language`.
    let file_language = file.language.unwrap_or("unknown");
    let mut ref_binds = Vec::new();
    for i in op.refs.clone() {
        let r = wire.r#ref(i)?;
        let (Some(from), Some(name), Some(kind)) = (r.from_node_id, r.reference_name, r.reference_kind) else {
            return Err(wire_err("ref row without from_node_id/reference_name/reference_kind".into()));
        };
        if !inserted_ids.contains(from) {
            stats.refs_dropped_not_in_batch += 1;
            continue;
        }
        ref_binds.push(RefBind {
            from_node_id: from.to_string(),
            reference_name: name.to_string(),
            reference_kind: kind.to_string(),
            line: r.line.unwrap_or(0) as i64,
            col: r.col.unwrap_or(0) as i64,
            candidates_json: r.candidates_json.map(|s| s.to_string()),
            file_path: r.file_path.unwrap_or(path).to_string(),
            language: r.language.unwrap_or(file_language).to_string(),
        });
    }
    sql_insert_ref_binds(conn, &ref_binds, stats).map_err(err)?;

    // ⑧ file record LAST.
    sql_upsert_file(conn, &file, stats).map_err(err)?;
    Ok(())
}

fn err(e: rusqlite::Error) -> Error {
    Error::from_reason(format!("store sql: {e}"))
}

fn op_delete_file(conn: &Connection, op: &OpView, stats: &mut Stats) -> Result<()> {
    let path = op.arg.ok_or_else(|| wire_err("OP_DELETE_FILE without path arg".into()))?;
    if op.flags & DELETE_FILE_FLAG_RESURRECT != 0 {
        // removeFileResurrectingRefs: resurrect ALL incoming cross-file edges
        // (no re-attach — the file is going away), then cascade. One txn.
        let incoming = sql_snapshot_cross_file_incoming(conn, path).map_err(err)?;
        let binds: Vec<RefBind> = incoming.iter().filter_map(resurrect_ref).collect();
        stats.refs_resurrected += binds.len() as u32;
        sql_insert_ref_binds(conn, &binds, stats).map_err(err)?;
    }
    sql_delete_file(conn, path, stats).map_err(err)?;
    Ok(())
}

fn op_insert_nodes<'a>(conn: &Connection, wire: &Wire<'a>, op_nodes: std::ops::Range<u32>, stats: &mut Stats) -> Result<()> {
    for i in op_nodes {
        let n = wire.node(i)?;
        if !n.valid() {
            stats.nodes_skipped_invalid += 1;
            continue;
        }
        sql_insert_node(conn, &n).map_err(err)?;
        stats.nodes_inserted += 1;
    }
    Ok(())
}

fn op_insert_edges<'a>(conn: &Connection, wire: &Wire<'a>, op_edges: std::ops::Range<u32>, stats: &mut Stats) -> Result<()> {
    let mut binds = Vec::new();
    for i in op_edges {
        let e = wire.edge(i)?;
        let (Some(source), Some(target), Some(kind)) = (e.source, e.target, e.kind) else {
            return Err(wire_err("edge row without source/target/kind".into()));
        };
        binds.push(EdgeBind {
            source,
            target: target.to_string(),
            kind,
            metadata: metadata_sql(e.metadata_json),
            line: e.line.map(|v| v as i64),
            col: e.col.map(|v| v as i64),
            provenance: e.provenance,
        });
    }
    sql_insert_edge_rows(conn, binds.into_iter(), stats, false).map_err(err)
}

fn op_insert_refs<'a>(conn: &Connection, wire: &Wire<'a>, op_refs: std::ops::Range<u32>, stats: &mut Stats) -> Result<()> {
    let mut binds = Vec::new();
    for i in op_refs {
        let r = wire.r#ref(i)?;
        let (Some(from), Some(name), Some(kind)) = (r.from_node_id, r.reference_name, r.reference_kind) else {
            return Err(wire_err("ref row without from_node_id/reference_name/reference_kind".into()));
        };
        binds.push(RefBind {
            from_node_id: from.to_string(),
            reference_name: name.to_string(),
            reference_kind: kind.to_string(),
            line: r.line.unwrap_or(0) as i64,
            col: r.col.unwrap_or(0) as i64,
            candidates_json: r.candidates_json.map(|s| s.to_string()),
            file_path: r.file_path.unwrap_or("").to_string(),
            language: r.language.unwrap_or("unknown").to_string(),
        });
    }
    sql_insert_ref_binds(conn, &binds, stats).map_err(err)
}

/// `arg` = NUL-joined decimal row ids → deleteUnresolvedReferencesByIds.
fn op_delete_unresolved_by_ids(conn: &Connection, arg: Option<&str>, stats: &mut Stats) -> Result<()> {
    let Some(arg) = arg else { return Ok(()) };
    let unique: Vec<i64> = {
        let mut seen = HashSet::new();
        arg.split('\0')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<i64>().ok())
            .filter(|id| seen.insert(*id))
            .collect()
    };
    for chunk in unique.chunks(SQLITE_PARAM_CHUNK_SIZE) {
        let sql = format!("DELETE FROM unresolved_refs WHERE id IN ({})", vec!["?"; chunk.len()].join(","));
        let changes = conn.prepare(&sql).map_err(err)?.execute(rusqlite::params_from_iter(chunk.iter())).map_err(err)?;
        stats.refs_deleted += changes as u32;
    }
    Ok(())
}

/// `arg` = flat NUL-joined (fromNodeId, referenceName, referenceKind) triples.
fn parse_triples(arg: Option<&str>) -> Result<Vec<[String; 3]>> {
    let Some(arg) = arg else { return Ok(Vec::new()) };
    let parts: Vec<&str> = arg.split('\0').collect();
    if parts.len() % 3 != 0 {
        return Err(wire_err(format!("triple arg length {} not a multiple of 3", parts.len())));
    }
    Ok(parts.chunks(3).map(|c| [c[0].to_string(), c[1].to_string(), c[2].to_string()]).collect())
}

fn op_delete_specific_resolved_refs(conn: &Connection, arg: Option<&str>, stats: &mut Stats) -> Result<()> {
    for t in parse_triples(arg)? {
        let changes = conn
            .prepare_cached(
                "DELETE FROM unresolved_refs WHERE from_node_id = ?1 AND reference_name = ?2 AND reference_kind = ?3",
            )
            .map_err(err)?
            .execute(rusqlite::params![t[0], t[1], t[2]])
            .map_err(err)?;
        stats.refs_deleted += changes as u32;
    }
    Ok(())
}

fn op_mark_refs_failed(conn: &Connection, arg: Option<&str>, stats: &mut Stats) -> Result<()> {
    for t in parse_triples(arg)? {
        let changes = conn
            .prepare_cached(
                "UPDATE unresolved_refs SET status = 'failed', name_tail = ?1
                 WHERE from_node_id = ?2 AND reference_name = ?3 AND reference_kind = ?4",
            )
            .map_err(err)?
            .execute(rusqlite::params![reference_name_tail(&t[1]), t[0], t[1], t[2]])
            .map_err(err)?;
        stats.refs_marked_failed += changes as u32;
    }
    Ok(())
}

fn exec_op(conn: &Connection, wire: &Wire, op: &OpView, stats: &mut Stats) -> Result<()> {
    match op.code {
        OP_STORE_FILE_RESULT => op_store_file_result(conn, wire, op, stats),
        OP_DELETE_FILE => op_delete_file(conn, op, stats),
        OP_INSERT_NODES => op_insert_nodes(conn, wire, op.nodes.clone(), stats),
        OP_INSERT_EDGES => op_insert_edges(conn, wire, op.edges.clone(), stats),
        OP_INSERT_REFS => op_insert_refs(conn, wire, op.refs.clone(), stats),
        OP_UPSERT_FILE => {
            let file = match op.file_index {
                Some(i) => wire.file(i)?,
                None => return Err(wire_err("OP_UPSERT_FILE without file_index".into())),
            };
            sql_upsert_file(conn, &file, stats).map_err(err)
        }
        OP_DELETE_UNRESOLVED_BY_IDS => op_delete_unresolved_by_ids(conn, op.arg, stats),
        OP_DELETE_SPECIFIC_RESOLVED_REFS => op_delete_specific_resolved_refs(conn, op.arg, stats),
        OP_MARK_REFS_FAILED => op_mark_refs_failed(conn, op.arg, stats),
        other => Err(wire_err(format!("unknown op code {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Connection wrapper
// ---------------------------------------------------------------------------


struct StoreConn {
    conn: Connection,
    db_path: String,
    /// Adapter-parity transaction depth: nested units JOIN the outer one
    /// (plain BEGIN/COMMIT, no savepoints — sqlite-adapter.ts semantics).
    txn_depth: u32,
}

impl StoreConn {
    fn open(db_path: &str) -> Result<Self> {
        let conn = Connection::open(db_path).map_err(err)?;
        // Core of db/index.ts configureConnection — the correctness-relevant
        // pragmas. cache_size/mmap/temp_store tuning stays TS-owned (they are
        // performance knobs with no semantic effect on stored rows).
        conn.pragma_update(None, "busy_timeout", 5000).map_err(err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(err)?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(err)?;
        // Fail fast on an uninitialized DB: the store never creates schema
        // (TS owns schema.sql + migrations), and writing into a bare file
        // would surface as confusing per-statement "no such table" errors.
        let tables: i64 = conn
            .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('nodes','edges','files','unresolved_refs')")
            .and_then(|mut s| s.query_row([], |r| r.get(0)))
            .map_err(err)?;
        if tables < 4 {
            return Err(Error::from_reason(format!(
                "store_open: {db_path} is missing the graph schema (found {tables}/4 core tables) — initialize it TS-side first"
            )));
        }
        Ok(StoreConn { conn, db_path: db_path.to_string(), txn_depth: 0 })
    }

    /// One atomic unit; nested calls JOIN (depth counter, TS adapter parity).
    /// NOTE: no SAVEPOINT — a failure inside a JOINed inner unit poisons the
    /// whole outer transaction exactly like the bun:sqlite/node:sqlite
    /// adapters (the outer COMMIT then fails), which is the contract the
    /// commit_batch rollback test pins.
    fn transaction<T>(&mut self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        if self.txn_depth > 0 {
            self.txn_depth += 1;
            let out = f(&self.conn);
            self.txn_depth -= 1;
            return out;
        }
        self.conn.execute_batch("BEGIN").map_err(err)?;
        self.txn_depth = 1;
        let out = f(&self.conn);
        self.txn_depth = 0;
        match out {
            Ok(v) => {
                self.conn.execute_batch("COMMIT").map_err(err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// WAL watermark in pages (risk #3: the TS orchestration layer keeps the
    /// backpressure DECISION; the Rust side only reports the level at batch
    /// boundaries). Approximation: -wal file size / page_size.
    fn wal_pages(&self) -> u32 {
        let page_size: i64 = self
            .conn
            .prepare_cached("PRAGMA page_size")
            .and_then(|mut s| s.query_row([], |r| r.get(0)))
            .unwrap_or(4096);
        if page_size <= 0 {
            return 0;
        }
        let wal = format!("{}-wal", self.db_path);
        match std::fs::metadata(&wal) {
            Ok(m) => (m.len() / page_size as u64) as u32,
            Err(_) => 0,
        }
    }
}

// ---------------------------------------------------------------------------
// napi surface
// ---------------------------------------------------------------------------

/// The five flat store tables — wire sibling of ExtractBuffers. See the
/// module docs for the byte layout; `StoreBuffers` consumers (R3a-2 TS
/// encoder) MUST match STORE_ABI_VERSION.
#[napi(object)]
pub struct StoreBuffers {
    pub meta: Buffer,
    pub nodes: Buffer,
    pub edges: Buffer,
    pub refs: Buffer,
    pub arena: Buffer,
}

/// Wire-contract description — the TS loader verifies ABI equality and that
/// its node/edge kind tables are supersets of these (loader.ts:150-167
/// pattern) before routing any write to the native store; a mismatch degrades
/// to the TS QueryBuilder silently (kill-switch discipline, R3a-2).
#[napi(object)]
pub struct StoreContractInfo {
    /// STORE_ABI_VERSION — independent numbering from the extraction ABI.
    pub abi_version: u32,
    pub store_version: String,
    /// The ONE kind-table truth: buffers::NODE_KINDS (shared with the
    /// extraction wire contract — never fork a second copy).
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
}

/// Result of one store call. `wal_pages` is the WAL watermark at the end of
/// the batch so the TS layer keeps backpressure authority (R3 proposal §5
/// risk 3); everything else mirrors the per-statement counters.
#[napi(object)]
pub struct StoreWriteStats {
    pub nodes_inserted: u32,
    pub nodes_skipped_invalid: u32,
    pub edges_inserted: u32,
    pub edges_dropped_dangling: u32,
    pub edges_dropped_not_in_batch: u32,
    pub edges_reattached: u32,
    pub refs_inserted: u32,
    pub refs_dropped_not_in_batch: u32,
    pub refs_resurrected: u32,
    pub refs_deleted: u32,
    pub refs_marked_failed: u32,
    pub files_deleted: u32,
    pub files_upserted: u32,
    pub files_skipped_unchanged: u32,
    pub wal_pages: u32,
    pub duration_ms: f64,
}

fn stats_out(s: Stats, wal_pages: u32, started: Instant) -> StoreWriteStats {
    StoreWriteStats {
        nodes_inserted: s.nodes_inserted,
        nodes_skipped_invalid: s.nodes_skipped_invalid,
        edges_inserted: s.edges_inserted,
        edges_dropped_dangling: s.edges_dropped_dangling,
        edges_dropped_not_in_batch: s.edges_dropped_not_in_batch,
        edges_reattached: s.edges_reattached,
        refs_inserted: s.refs_inserted,
        refs_dropped_not_in_batch: s.refs_dropped_not_in_batch,
        refs_resurrected: s.refs_resurrected,
        refs_deleted: s.refs_deleted,
        refs_marked_failed: s.refs_marked_failed,
        files_deleted: s.files_deleted,
        files_upserted: s.files_upserted,
        files_skipped_unchanged: s.files_skipped_unchanged,
        wal_pages,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    }
}

/// One open graph-store connection (one graph root). Handle-based, NOT
/// global: a process may hold up to one handle per root (×32 roots).
///
/// Lifecycle: created by `store_open`, closed by JS GC finalizer (Drop →
/// SQLite close, which also releases the handle's prepared-statement cache —
/// the rusqlite analogue of QueryBuilder.dispose()). There is deliberately no
/// explicit close export in ABI v1; R3a-2 may add `store_close` if the TS
/// side needs deterministic release (CodeGraph.close parity).
///
/// Thread safety: the Connection is `!Sync`, so it lives behind a Mutex —
/// concurrent JS calls into the SAME handle serialize (correct but no
/// throughput win); parallelism comes from one handle per worker graph root,
/// never from sharing one handle across workers. Calls are synchronous and
/// MUST run on a worker thread (R3 §2 hard constraint — main-thread sync
/// calls would just re-block the event loop). A poisoned mutex (previous call
/// panicked mid-write; its transaction was rolled back by Drop) returns an
/// error instead of poisoning further callers.
#[napi]
pub struct StoreHandle {
    inner: Mutex<StoreConn>,
    poisoned: AtomicBool,
}

impl StoreHandle {
    fn with_conn<T>(&self, f: impl FnOnce(&mut StoreConn) -> Result<T>) -> Result<T> {
        if self.poisoned.load(Ordering::Relaxed) {
            return Err(Error::from_reason("store handle is poisoned by an earlier panic; reopen it"));
        }
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                self.poisoned.store(true, Ordering::Relaxed);
                return Err(Error::from_reason("store handle mutex poisoned"));
            }
        };
        // A panic inside f would leave txn_depth/BEGIN state inconsistent —
        // latch the handle dead so no later call trusts it (the DB itself is
        // safe: rusqlite rolls back the open transaction on Drop).
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
pub fn store_contract_info() -> StoreContractInfo {
    StoreContractInfo {
        abi_version: STORE_ABI_VERSION as u32,
        store_version: STORE_VERSION.to_string(),
        node_kinds: NODE_KINDS.iter().map(|s| s.to_string()).collect(),
        edge_kinds: EDGE_KINDS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Open (never CREATE schema) the graph store at `db_path`. Requires the
/// four core tables to exist — TS applies schema.sql + migrations first
/// (db/index.ts open path). Pragmas mirror configureConnection's
/// correctness core: busy_timeout=5000, foreign_keys=ON, journal_mode=WAL,
/// synchronous=NORMAL.
#[napi]
pub fn store_open(db_path: String) -> Result<StoreHandle> {
    let conn = StoreConn::open(&db_path)?;
    Ok(StoreHandle { inner: Mutex::new(conn), poisoned: AtomicBool::new(false) })
}

/// Borrowed view of the five flat buffers — the napi-free core entry shared
/// by the JS wrappers and cargo tests. The test harness must never construct
/// napi `Buffer`/JS value types: their Drop and conversion paths reference
/// libnode symbols a test executable cannot resolve (cdylib legs defer them
/// at load time; executables cannot).
#[derive(Clone, Copy)]
pub struct RawBufs<'a> {
    pub meta: &'a [u8],
    pub nodes: &'a [u8],
    pub edges: &'a [u8],
    pub refs: &'a [u8],
    pub arena: &'a [u8],
}

/// insertNodes (whole node table) as one transaction unit. Returns the rows
/// INSERT OR REPLACE'd (invalid rows are skipped and NOT counted —
/// QueryBuilder.insertNode validation parity).
fn insert_nodes_core(c: &mut StoreConn, b: RawBufs) -> Result<u32> {
    let wire = Wire::decode(b.meta, b.nodes, b.edges, b.refs, b.arena)?;
    let mut stats = Stats::default();
    let range = 0..wire.node_count;
    c.transaction(|conn| op_insert_nodes(conn, &wire, range, &mut stats))?;
    Ok(stats.nodes_inserted)
}

/// insertEdges (whole edge table, dangling-endpoint filtered) as one
/// transaction unit. Returns rows actually inserted (INSERT OR IGNORE
/// changes — identity-deduped rows are not counted).
fn insert_edges_core(c: &mut StoreConn, b: RawBufs) -> Result<u32> {
    let wire = Wire::decode(b.meta, b.nodes, b.edges, b.refs, b.arena)?;
    let mut stats = Stats::default();
    let range = 0..wire.edge_count;
    c.transaction(|conn| op_insert_edges(conn, &wire, range, &mut stats))?;
    Ok(stats.edges_inserted)
}

/// insertUnresolvedRefsBatch (whole ref table) as one transaction unit.
/// Returns rows inserted (status defaults to 'pending').
fn insert_refs_core(c: &mut StoreConn, b: RawBufs) -> Result<u32> {
    let wire = Wire::decode(b.meta, b.nodes, b.edges, b.refs, b.arena)?;
    let mut stats = Stats::default();
    let range = 0..wire.ref_count;
    c.transaction(|conn| op_insert_refs(conn, &wire, range, &mut stats))?;
    Ok(stats.refs_inserted)
}

/// QueryBuilder.deleteFile parity: cascade this file's nodes (FK drops its
/// edges/refs) and its files row, one transaction. NOTE: this is the PLAIN
/// delete — the resurrect-first removal path (removeFileResurrectingRefs,
/// #1240) is OP_DELETE_FILE with DELETE_FILE_FLAG_RESURRECT inside
/// commit_batch; TS callers must pick the matching semantics.
fn delete_file_core(c: &mut StoreConn, path: &str) -> Result<()> {
    c.transaction(|conn| {
        let mut stats = Stats::default();
        sql_delete_file(conn, path, &mut stats).map_err(err)
    })
}

/// The one-crossing batch commit core: ALL ops run in a SINGLE transaction
/// (nested units JOIN, adapter parity) — this is what collapses the per-file
/// commit boundary (10k+ commits per reindex) into per-batch commits.
/// Includes the full OP_STORE_FILE_RESULT resurrect orchestration. Any op
/// failure rolls the WHOLE batch back. Returns the counters plus the WAL
/// watermark so the TS layer keeps backpressure authority (R3 §5 risk 3).
fn commit_batch_core(c: &mut StoreConn, b: RawBufs) -> Result<(Stats, u32)> {
    let wire = Wire::decode(b.meta, b.nodes, b.edges, b.refs, b.arena)?;
    let views: Vec<OpView> = (0..wire.op_count).map(|i| wire.op(i)).collect::<Result<_>>()?;
    let mut stats = Stats::default();
    c.transaction(|conn| {
        for v in &views {
            exec_op(conn, &wire, v, &mut stats)?;
        }
        Ok(())
    })?;
    Ok((stats, c.wal_pages()))
}

#[napi]
pub fn store_insert_nodes(handle: &StoreHandle, batch: StoreBuffers) -> Result<u32> {
    let b = RawBufs { meta: batch.meta.as_ref(), nodes: batch.nodes.as_ref(), edges: batch.edges.as_ref(), refs: batch.refs.as_ref(), arena: batch.arena.as_ref() };
    handle.with_conn(|c| insert_nodes_core(c, b))
}

#[napi]
pub fn store_insert_edges(handle: &StoreHandle, batch: StoreBuffers) -> Result<u32> {
    let b = RawBufs { meta: batch.meta.as_ref(), nodes: batch.nodes.as_ref(), edges: batch.edges.as_ref(), refs: batch.refs.as_ref(), arena: batch.arena.as_ref() };
    handle.with_conn(|c| insert_edges_core(c, b))
}

#[napi]
pub fn store_insert_refs(handle: &StoreHandle, batch: StoreBuffers) -> Result<u32> {
    let b = RawBufs { meta: batch.meta.as_ref(), nodes: batch.nodes.as_ref(), edges: batch.edges.as_ref(), refs: batch.refs.as_ref(), arena: batch.arena.as_ref() };
    handle.with_conn(|c| insert_refs_core(c, b))
}

#[napi]
pub fn store_delete_file(handle: &StoreHandle, path: String) -> Result<()> {
    handle.with_conn(|c| delete_file_core(c, &path))
}

#[napi]
pub fn store_commit_batch(handle: &StoreHandle, ops: StoreBuffers) -> Result<StoreWriteStats> {
    let started = Instant::now();
    let b = RawBufs { meta: ops.meta.as_ref(), nodes: ops.nodes.as_ref(), edges: ops.edges.as_ref(), refs: ops.refs.as_ref(), arena: ops.arena.as_ref() };
    handle.with_conn(|c| {
        let (stats, wal_pages) = commit_batch_core(c, b)?;
        Ok(stats_out(stats, wal_pages, started))
    })
}

// ---------------------------------------------------------------------------
// Test wire builder — also the executable reference for the R3a-2 TS encoder
// (byte order/field order MUST be read against the module docs above).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod wire_build {
    use super::*;

    pub struct Builder {
        pub arena: Vec<u8>,
        pub nodes: Vec<u8>,
        pub edges: Vec<u8>,
        pub refs: Vec<u8>,
        pub ops: Vec<u8>,
        pub files: Vec<u8>,
        pub node_count: u32,
        pub edge_count: u32,
        pub ref_count: u32,
        pub op_count: u32,
        pub file_count: u32,
    }

    impl Default for Builder {
        fn default() -> Self {
            Builder { arena: Vec::new(), nodes: Vec::new(), edges: Vec::new(), refs: Vec::new(), ops: Vec::new(), files: Vec::new(), node_count: 0, edge_count: 0, ref_count: 0, op_count: 0, file_count: 0 }
        }
    }

    impl Builder {
        fn put(arena: &mut Vec<u8>, s: &str) -> (u32, u32) {
            let off = arena.len() as u32;
            arena.extend_from_slice(s.as_bytes());
            (off, s.len() as u32)
        }
        fn put_opt(arena: &mut Vec<u8>, s: Option<&str>) -> (u32, u32) {
            match s {
                Some(s) => Self::put(arena, s),
                None => (NONE, 0),
            }
        }
        fn push_str(buf: &mut Vec<u8>, r: (u32, u32)) {
            buf.extend_from_slice(&r.0.to_le_bytes());
            buf.extend_from_slice(&r.1.to_le_bytes());
        }
        fn push_u32(buf: &mut Vec<u8>, v: u32) {
            buf.extend_from_slice(&v.to_le_bytes());
        }

        #[allow(clippy::type_complexity)]
        pub fn node(
            &mut self,
            id: &str,
            kind: &str,
            name: &str,
            file_path: &str,
            language: &str,
            start_line: u32,
            qualified_name: Option<&str>,
            search_text: Option<&str>,
            updated_at: i64,
            flags: u8,
        ) -> u32 {
            Self::push_str(&mut self.nodes, Self::put(&mut self.arena, id));
            Self::push_str(&mut self.nodes, Self::put(&mut self.arena, kind));
            Self::push_str(&mut self.nodes, Self::put(&mut self.arena, name));
            Self::push_str(&mut self.nodes, Self::put_opt(&mut self.arena, qualified_name));
            Self::push_str(&mut self.nodes, Self::put(&mut self.arena, file_path));
            Self::push_str(&mut self.nodes, Self::put(&mut self.arena, language));
            for v in [start_line, start_line, 0, 0] {
                Self::push_u32(&mut self.nodes, v);
            }
            Self::push_str(&mut self.nodes, (NONE, 0)); // docstring
            Self::push_str(&mut self.nodes, (NONE, 0)); // signature
            Self::push_str(&mut self.nodes, (NONE, 0)); // visibility
            self.nodes.push(flags);
            self.nodes.extend_from_slice(&[0u8; 3]);
            Self::push_str(&mut self.nodes, (NONE, 0)); // decorators_json
            Self::push_str(&mut self.nodes, (NONE, 0)); // type_parameters_json
            Self::push_str(&mut self.nodes, (NONE, 0)); // return_type
            Self::push_str(&mut self.nodes, (NONE, 0)); // params_json
            Self::push_str(&mut self.nodes, Self::put_opt(&mut self.arena, search_text));
            self.nodes.extend_from_slice(&updated_at.to_le_bytes());
            debug_assert_eq!(self.nodes.len() % STORE_NODE_ROW_SIZE, 0);
            self.node_count += 1;
            self.node_count - 1
        }

        pub fn edge(&mut self, source: &str, target: &str, kind: &str, metadata_json: Option<&str>, line: Option<u32>, col: Option<u32>, provenance: Option<&str>) -> u32 {
            Self::push_str(&mut self.edges, Self::put(&mut self.arena, source));
            Self::push_str(&mut self.edges, Self::put(&mut self.arena, target));
            Self::push_str(&mut self.edges, Self::put(&mut self.arena, kind));
            Self::push_str(&mut self.edges, Self::put_opt(&mut self.arena, metadata_json));
            Self::push_u32(&mut self.edges, line.unwrap_or(NONE));
            Self::push_u32(&mut self.edges, col.unwrap_or(NONE));
            Self::push_str(&mut self.edges, Self::put_opt(&mut self.arena, provenance));
            self.edge_count += 1;
            self.edge_count - 1
        }

        pub fn r#ref(&mut self, from_node_id: &str, reference_name: &str, reference_kind: &str, line: Option<u32>, col: Option<u32>, candidates_json: Option<&str>, file_path: Option<&str>, language: Option<&str>) -> u32 {
            Self::push_str(&mut self.refs, Self::put(&mut self.arena, from_node_id));
            Self::push_str(&mut self.refs, Self::put(&mut self.arena, reference_name));
            Self::push_str(&mut self.refs, Self::put(&mut self.arena, reference_kind));
            Self::push_u32(&mut self.refs, line.unwrap_or(NONE));
            Self::push_u32(&mut self.refs, col.unwrap_or(NONE));
            Self::push_str(&mut self.refs, Self::put_opt(&mut self.arena, candidates_json));
            Self::push_str(&mut self.refs, Self::put_opt(&mut self.arena, file_path));
            Self::push_str(&mut self.refs, Self::put_opt(&mut self.arena, language));
            self.ref_count += 1;
            self.ref_count - 1
        }

        pub fn file(&mut self, path: &str, content_hash: &str, language: &str, size: i64, modified_at: f64, indexed_at: i64, node_count: u32, errors_json: Option<&str>) -> u32 {
            Self::push_str(&mut self.files, Self::put(&mut self.arena, path));
            Self::push_str(&mut self.files, Self::put(&mut self.arena, content_hash));
            Self::push_str(&mut self.files, Self::put(&mut self.arena, language));
            Self::push_str(&mut self.files, Self::put_opt(&mut self.arena, errors_json));
            self.files.extend_from_slice(&size.to_le_bytes());
            self.files.extend_from_slice(&modified_at.to_le_bytes());
            self.files.extend_from_slice(&indexed_at.to_le_bytes());
            Self::push_u32(&mut self.files, node_count);
            Self::push_u32(&mut self.files, 0);
            self.file_count += 1;
            self.file_count - 1
        }

        pub fn op(&mut self, code: u8, file_index: Option<u32>, nodes: Option<(u32, u32)>, edges: Option<(u32, u32)>, refs: Option<(u32, u32)>, arg: Option<&str>, flags: u32) -> u32 {
            self.ops.push(code);
            self.ops.extend_from_slice(&[0u8; 3]);
            Self::push_u32(&mut self.ops, file_index.unwrap_or(NONE));
            Self::push_u32(&mut self.ops, nodes.map(|r| r.0).unwrap_or(0));
            Self::push_u32(&mut self.ops, nodes.map(|r| r.1).unwrap_or(NONE));
            Self::push_u32(&mut self.ops, edges.map(|r| r.0).unwrap_or(0));
            Self::push_u32(&mut self.ops, edges.map(|r| r.1).unwrap_or(NONE));
            Self::push_u32(&mut self.ops, refs.map(|r| r.0).unwrap_or(0));
            Self::push_u32(&mut self.ops, refs.map(|r| r.1).unwrap_or(NONE));
            Self::push_str(&mut self.ops, Self::put_opt(&mut self.arena, arg));
            Self::push_u32(&mut self.ops, flags);
            Self::push_u32(&mut self.ops, 0);
            self.op_count += 1;
            self.op_count - 1
        }

        pub fn finish(&self) -> RawOwned {
            let mut meta = Vec::new();
            meta.push(STORE_ABI_VERSION);
            meta.extend_from_slice(&[0u8; 3]);
            for v in [self.op_count, self.file_count, self.node_count, self.edge_count, self.ref_count, self.arena.len() as u32] {
                meta.extend_from_slice(&v.to_le_bytes());
            }
            meta.extend_from_slice(&self.ops);
            meta.extend_from_slice(&self.files);
            RawOwned { meta, nodes: self.nodes.clone(), edges: self.edges.clone(), refs: self.refs.clone(), arena: self.arena.clone() }
        }
    }

    /// Owned five-table bundle for tests — the napi-free mirror of
    /// StoreBuffers (Buffer's Drop path references libnode symbols).
    pub struct RawOwned {
        pub meta: Vec<u8>,
        pub nodes: Vec<u8>,
        pub edges: Vec<u8>,
        pub refs: Vec<u8>,
        pub arena: Vec<u8>,
    }

    impl RawOwned {
        pub fn borrows(&self) -> RawBufs<'_> {
            RawBufs { meta: &self.meta, nodes: &self.nodes, edges: &self.edges, refs: &self.refs, arena: &self.arena }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — temp-file SQLite, zero external deps, golden assertions against
// the REAL schema (include_str! of packages/chimera's schema.sql — single
// source of truth; the crate is vendored at the repo root so the relative
// path holds for every in-repo build, same assumption build-kernel.sh makes).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::wire_build::{Builder, RawOwned};
    use super::*;
    use rusqlite::types::Value;
    use std::cell::RefCell;
    use std::sync::atomic::AtomicU64;

    const SCHEMA_SQL: &str = include_str!("../../packages/chimera/src/graph/db/schema.sql");

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempDb {
        path: String,
    }

    impl TempDb {
        fn new() -> TempDb {
            let path = std::env::temp_dir()
                .join(format!("cgk-store-{}-{}.db", std::process::id(), TMP_SEQ.fetch_add(1, Ordering::Relaxed)))
                .to_string_lossy()
                .to_string();
            let _ = std::fs::remove_file(&path);
            let conn = Connection::open(&path).expect("open temp db");
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(SCHEMA_SQL).expect("apply schema.sql");
            drop(conn);
            TempDb { path }
        }

        fn conn(&self) -> Connection {
            let conn = Connection::open(&self.path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            conn
        }

        fn count(&self, sql: &str) -> i64 {
            self.conn().prepare(sql).unwrap().query_row([], |r| r.get(0)).unwrap()
        }

        fn rows(&self, sql: &str) -> Vec<Vec<Value>> {
            let conn = self.conn();
            let mut stmt = conn.prepare(sql).unwrap();
            let cols = stmt.column_count();
            let rows = stmt
                .query_map([], |r| (0..cols).map(|c| r.get::<_, Value>(c)).collect::<rusqlite::Result<Vec<_>>>())
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            rows
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}-wal", self.path));
            let _ = std::fs::remove_file(format!("{}-shm", self.path));
        }
    }

    /// Test-side stand-in for StoreHandle: RefCell instead of Mutex (tests
    /// are single-threaded) and calls route through the SAME napi-free core
    /// fns the JS wrappers delegate to.
    struct TStore(RefCell<StoreConn>);

    fn handle(db: &TempDb) -> TStore {
        TStore(RefCell::new(StoreConn::open(&db.path).expect("store_open")))
    }

    /// Same call shapes as the napi wrappers; commit returns the inner
    /// Stats (every field the tests assert is identical to StoreWriteStats).
    fn store_commit_batch(h: &TStore, o: RawOwned) -> Result<Stats> {
        h.store_commit_batch_(o)
    }

    fn store_delete_file(h: &TStore, path: String) -> Result<()> {
        delete_file_core(&mut *h.0.borrow_mut(), &path)
    }

    /// Golden row dump of the four tables (deterministic order).
    fn golden(db: &TempDb) -> Vec<Vec<Value>> {
        let mut out = db.rows("SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, return_type, params_json, search_text, updated_at FROM nodes ORDER BY id");
        out.extend(db.rows("SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY source, target, kind, IFNULL(line,-1), IFNULL(col,-1)"));
        out.extend(db.rows("SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail FROM unresolved_refs ORDER BY id"));
        out.extend(db.rows("SELECT path, content_hash, language, size, modified_at, indexed_at, node_count, errors FROM files ORDER BY path"));
        out
    }

    /// unwrap_err without requiring Debug on the Ok type (napi structs).
    fn err_of<T>(r: Result<T>) -> Error {
        match r {
            Err(e) => e,
            Ok(_) => panic!("expected error"),
        }
    }

    fn seed_file_a(db: &TempDb) {
        // a.ts with one function node, indexed.
        let mut b = Builder::default();
        let f = b.file("a.ts", "hash-a1", "typescript", 10, 100.0, 1000, 1, None);
        b.node("function:a:1", "function", "hello", "a.ts", "typescript", 1, Some("mod.hello"), Some("hello"), 5, 0);
        b.op(OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        handle(db).store_commit_batch_(b.finish()).unwrap();
    }

    impl TStore {
        fn store_commit_batch_(&self, o: RawOwned) -> Result<Stats> {
            commit_batch_core(&mut *self.0.borrow_mut(), o.borrows()).map(|(s, _wal)| s)
        }
        fn store_insert_nodes_(&self, o: RawOwned) -> Result<u32> {
            insert_nodes_core(&mut *self.0.borrow_mut(), o.borrows())
        }
        fn store_insert_edges_(&self, o: RawOwned) -> Result<u32> {
            insert_edges_core(&mut *self.0.borrow_mut(), o.borrows())
        }
        fn store_insert_refs_(&self, o: RawOwned) -> Result<u32> {
            insert_refs_core(&mut *self.0.borrow_mut(), o.borrows())
        }
    }

    #[test]
    fn contract_info_reports_abi_and_shared_kind_tables() {
        let info = store_contract_info();
        assert_eq!(info.abi_version, 1);
        assert_eq!(info.store_version, STORE_VERSION);
        // Single source of truth: exactly the extraction wire tables.
        assert_eq!(info.node_kinds, NODE_KINDS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(info.edge_kinds, EDGE_KINDS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn open_requires_initialized_schema() {
        let dir = std::env::temp_dir().join(format!("cgk-store-bare-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let e = err_of(store_open(dir.to_string_lossy().to_string()));
        assert!(e.to_string().contains("missing the graph schema"), "{e}");
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn insert_node_replace_semantics_and_defaults() {
        let db = TempDb::new();
        let h = handle(&db);
        let mut b = Builder::default();
        b.node("function:f1", "function", "f1", "x.ts", "typescript", 10, None, Some("f1"), 111, 1);
        assert_eq!(h.store_insert_nodes_(b.finish()).unwrap(), 1);

        // INSERT OR REPLACE: same id, new line — exactly one row, new values.
        let mut b2 = Builder::default();
        b2.node("function:f1", "function", "f1", "x.ts", "typescript", 20, Some("q.f1"), Some("f1"), 222, 0);
        assert_eq!(h.store_insert_nodes_(b2.finish()).unwrap(), 1);
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 1);

        let rows = db.rows("SELECT qualified_name, start_line, end_line, is_exported, search_text, updated_at FROM nodes WHERE id = 'function:f1'");
        assert_eq!(rows.len(), 1);
        // qualified_name: first insert absent → fell back to name; replace supplied q.f1.
        assert_eq!(rows[0][0], Value::Text("q.f1".into()));
        assert_eq!(rows[0][1], Value::Integer(20));
        // end_line was not supplied separately by the builder — mirrors start_line.
        assert_eq!(rows[0][2], Value::Integer(20));
        assert_eq!(rows[0][3], Value::Integer(0)); // flag bit0 cleared on replace
        assert_eq!(rows[0][4], Value::Text("f1".into()));
        assert_eq!(rows[0][5], Value::Integer(222));

        // Invalid row (empty name) is skipped, not an error — insertNode guard.
        let mut b3 = Builder::default();
        b3.node("function:bad", "function", "", "x.ts", "typescript", 1, None, None, 1, 0);
        assert_eq!(h.store_insert_nodes_(b3.finish()).unwrap(), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 1);

        // FTS trigger behavior through the native write path: SQLite fires
        // DELETE triggers on an INSERT OR REPLACE conflict ONLY when
        // recursive_triggers=ON (default OFF — same on the bun:sqlite /
        // node:sqlite arms), so the replaced row's stale FTS entry survives
        // exactly like it does under the TS QueryBuilder. 2 rows = TS parity,
        // not a leak to fix here.
        let fts = db.count("SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH 'f1'");
        assert_eq!(fts, 2);
    }

    #[test]
    fn edge_dangling_endpoint_filter_and_ignore_dedup() {
        let db = TempDb::new();
        let h = handle(&db);
        let mut b = Builder::default();
        b.node("function:a", "function", "a", "x.ts", "typescript", 1, None, None, 1, 0);
        b.node("function:b", "function", "b", "x.ts", "typescript", 2, None, None, 1, 0);
        h.store_insert_nodes_(b.finish()).unwrap();

        let mut e = Builder::default();
        e.edge("function:a", "function:b", "calls", Some("{\"refName\":\"b\"}"), Some(3), Some(4), Some("tree-sitter"));
        e.edge("function:a", "function:missing", "calls", None, Some(5), None, None); // dangling target
        e.edge("function:missing", "function:b", "calls", None, None, None, None); // dangling source
        e.edge("function:a", "function:b", "calls", Some("{\"refName\":\"b\"}"), Some(3), Some(4), None); // identity dup of row 0
        let stats = h.store_insert_edges_(e.finish()).unwrap();
        assert_eq!(stats, 1, "only the first row inserts; dangles drop, dup IGNOREs");
        assert_eq!(db.count("SELECT COUNT(*) FROM edges"), 1);
        let rows = db.rows("SELECT source, target, kind, metadata, line, col, provenance FROM edges");
        assert_eq!(rows[0][3], Value::Text("{\"refName\":\"b\"}".into())); // byte-identical passthrough
        assert_eq!(rows[0][4], Value::Integer(3));
        assert_eq!(rows[0][6], Value::Text("tree-sitter".into()));
    }

    #[test]
    fn delete_file_cascades_nodes_edges_refs() {
        let db = TempDb::new();
        let h = handle(&db);
        let mut b = Builder::default();
        b.node("file:y.ts", "file", "y.ts", "y.ts", "typescript", 0, None, None, 1, 0);
        b.node("function:y1", "function", "y1", "y.ts", "typescript", 1, None, None, 1, 0);
        b.node("function:z1", "function", "z1", "z.ts", "typescript", 1, None, None, 1, 0);
        b.edge("function:z1", "function:y1", "calls", None, Some(9), None, None);
        b.r#ref("function:y1", "ext", "calls", Some(2), Some(0), None, Some("y.ts"), Some("typescript"));
        b.file("y.ts", "hy", "typescript", 5, 1.0, 2, 2, None);
        h.store_insert_nodes_(b.finish()).unwrap();
        h.store_insert_edges_(b.finish()).unwrap();
        h.store_insert_refs_(b.finish()).unwrap();
        let mut fb = Builder::default();
        let fi = fb.file("y.ts", "hy", "typescript", 5, 1.0, 2, 2, None);
        fb.op(OP_UPSERT_FILE, Some(fi), None, None, None, None, 0);
        store_commit_batch(&h, fb.finish()).unwrap();
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 3);

        store_delete_file(&h, "y.ts".to_string()).unwrap();
        // y.ts's nodes gone; FK cascade took the cross-file edge AND the ref;
        // z.ts's node survives.
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 1);
        assert_eq!(db.count("SELECT COUNT(*) FROM edges"), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM files"), 0);
    }

    #[test]
    fn resurrect_flow_reattach_and_resurrect_across_line_shift() {
        let db = TempDb::new();
        let h = handle(&db);
        seed_file_a(&db); // a.ts: function:a:1 "hello" @ line 1

        // caller.ts resolves a call into a.ts's node — resolution-era edge
        // with the refName/refKind stamp.
        let mut b = Builder::default();
        b.node("function:caller", "function", "caller", "caller.ts", "typescript", 1, None, None, 1, 0);
        h.store_insert_nodes_(b.finish()).unwrap();
        let mut eb = Builder::default();
        eb.edge("function:caller", "function:a:1", "calls", Some("{\"refName\":\"mod.hello\",\"refKind\":\"calls\"}"), Some(7), Some(2), Some("resolver"));
        h.store_insert_edges_(eb.finish()).unwrap();
        assert_eq!(db.count("SELECT COUNT(*) FROM edges"), 1);

        // Re-index a.ts: line shift changes every node id, and "hello" is
        // RENAMED to "hello2" — so the (kind,name) re-attach map MISSES and
        // the snapshot edge must resurrect as its original pending ref.
        let mut b2 = Builder::default();
        let f = b2.file("a.ts", "hash-a2", "typescript", 12, 200.0, 2000, 2, None);
        b2.node("function:a:5", "function", "hello2", "a.ts", "typescript", 5, None, Some("hello2"), 5, 0);
        b2.op(OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        let stats = store_commit_batch(&h, b2.finish()).unwrap();
        assert_eq!(stats.files_deleted, 1);
        assert_eq!(stats.files_upserted, 1);
        assert_eq!(stats.refs_resurrected + stats.edges_reattached, 1);

        // The old edge is gone (deleteFile cascade); the resurrected ref is
        // pending with the ORIGINAL stamp values (#899/#1240 core assertion).
        assert_eq!(db.count("SELECT COUNT(*) FROM edges WHERE target = 'function:a:1'"), 0);
        let refs = db.rows("SELECT from_node_id, reference_name, reference_kind, line, col, file_path, language, status FROM unresolved_refs");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0][0], Value::Text("function:caller".into()));
        assert_eq!(refs[0][1], Value::Text("mod.hello".into()));
        assert_eq!(refs[0][2], Value::Text("calls".into()));
        assert_eq!(refs[0][3], Value::Integer(7));
        assert_eq!(refs[0][4], Value::Integer(2));
        assert_eq!(refs[0][5], Value::Text("caller.ts".into()));
        assert_eq!(refs[0][6], Value::Text("typescript".into()));
        assert_eq!(refs[0][7], Value::Text("pending".into()));

        // Now re-index AGAIN with the name restored at a new line: the
        // snapshot path is empty this time (the edge was resurrected, not
        // re-stored) — instead assert the RE-ATTACH leg: seed a fresh
        // stamped edge, keep the name, shift the line, expect re-attach to
        // the new id with metadata preserved byte-identical.
        let mut eb2 = Builder::default();
        eb2.edge("function:caller", "function:a:5", "calls", Some("{\"refName\":\"hello2\",\"refKind\":\"references\"}"), Some(8), Some(0), Some("resolver"));
        h.store_insert_edges_(eb2.finish()).unwrap();
        let mut b3 = Builder::default();
        let f3 = b3.file("a.ts", "hash-a3", "typescript", 14, 300.0, 3000, 1, None);
        b3.node("function:a:9", "function", "hello2", "a.ts", "typescript", 9, None, Some("hello2"), 5, 0);
        b3.op(OP_STORE_FILE_RESULT, Some(f3), Some((0, 1)), None, None, None, 0);
        let stats3 = store_commit_batch(&h, b3.finish()).unwrap();
        assert_eq!(stats3.edges_reattached, 1);
        assert_eq!(stats3.refs_resurrected, 0);
        let edges = db.rows("SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY target");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0][0], Value::Text("function:caller".into()));
        assert_eq!(edges[0][1], Value::Text("function:a:9".into())); // re-attached to the NEW id
        assert_eq!(edges[0][3], Value::Text("{\"refName\":\"hello2\",\"refKind\":\"references\"}".into()));
        assert_eq!(edges[0][4], Value::Integer(8));
        assert_eq!(edges[0][6], Value::Text("resolver".into()));
    }

    #[test]
    fn resurrect_drops_unstamped_edges_silently() {
        let db = TempDb::new();
        let h = handle(&db);
        seed_file_a(&db);
        let mut b = Builder::default();
        b.node("function:caller", "function", "caller", "caller.ts", "typescript", 1, None, None, 1, 0);
        h.store_insert_nodes_(b.finish()).unwrap();
        // No refName stamp ("silent beats wrong") and a contains edge that the
        // snapshot query excludes anyway.
        let mut eb = Builder::default();
        eb.edge("function:caller", "function:a:1", "references", Some("{\"score\":1}"), None, None, None);
        eb.edge("function:caller", "function:a:1", "contains", Some("{\"refName\":\"x\"}"), None, None, None);
        h.store_insert_edges_(eb.finish()).unwrap();

        let mut b2 = Builder::default();
        let f = b2.file("a.ts", "hash-a2", "typescript", 12, 200.0, 2000, 1, None);
        b2.node("function:a:5", "function", "renamed", "a.ts", "typescript", 5, None, None, 5, 0);
        b2.op(OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        store_commit_batch(&h, b2.finish()).unwrap();
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM edges"), 0);
    }

    #[test]
    fn delete_file_with_resurrect_flag() {
        let db = TempDb::new();
        let h = handle(&db);
        seed_file_a(&db);
        let mut b = Builder::default();
        b.node("function:caller", "function", "caller", "caller.ts", "typescript", 1, None, None, 1, 0);
        h.store_insert_nodes_(b.finish()).unwrap();
        let mut eb = Builder::default();
        eb.edge("function:caller", "function:a:1", "calls", Some("{\"refName\":\"hello\"}"), Some(4), Some(1), None);
        h.store_insert_edges_(eb.finish()).unwrap();

        let mut rb = Builder::default();
        rb.op(OP_DELETE_FILE, None, None, None, None, Some("a.ts"), DELETE_FILE_FLAG_RESURRECT);
        let stats = store_commit_batch(&h, rb.finish()).unwrap();
        assert_eq!(stats.refs_resurrected, 1);
        assert_eq!(stats.files_deleted, 1);
        assert_eq!(db.count("SELECT COUNT(*) FROM files"), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes WHERE file_path = 'a.ts'"), 0);
        let refs = db.rows("SELECT from_node_id, reference_name, status FROM unresolved_refs");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0][1], Value::Text("hello".into()));
        assert_eq!(refs[0][2], Value::Text("pending".into()));
    }

    #[test]
    fn store_file_result_skip_guard_and_batch_filtering() {
        let db = TempDb::new();
        let h = handle(&db);
        seed_file_a(&db);

        // Same content hash → whole op skipped, zero writes.
        let mut b = Builder::default();
        let f = b.file("a.ts", "hash-a1", "typescript", 10, 100.0, 1000, 1, None);
        b.node("function:a:1", "function", "hello", "a.ts", "typescript", 1, None, None, 99, 0);
        b.op(OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        let stats = store_commit_batch(&h, b.finish()).unwrap();
        assert_eq!(stats.files_skipped_unchanged, 1);
        assert_eq!(stats.nodes_inserted, 0);
        assert_eq!(db.rows("SELECT updated_at FROM nodes")[0][0], Value::Integer(5));

        // Batch-scoped filtering: an edge to a node OUTSIDE this batch and a
        // ref from a node outside it are dropped (TS insertedIds filter).
        let mut b2 = Builder::default();
        let f2 = b2.file("a.ts", "hash-a3", "typescript", 20, 300.0, 3000, 3, None);
        b2.node("function:a:2", "function", "two", "a.ts", "typescript", 2, None, None, 5, 0);
        b2.node("function:a:3", "function", "three", "a.ts", "typescript", 3, None, None, 5, 0);
        b2.edge("function:a:2", "function:a:3", "calls", None, Some(2), None, None); // in-batch → inserts
        b2.edge("function:a:2", "function:elsewhere", "calls", None, Some(3), None, None); // out-of-batch → dropped
        b2.r#ref("function:a:2", "ext", "calls", Some(2), Some(1), None, None, None); // context fill below
        b2.r#ref("function:ghost", "ext2", "calls", Some(9), None, None, None, None); // out-of-batch → dropped
        b2.op(OP_STORE_FILE_RESULT, Some(f2), Some((0, 2)), Some((0, 2)), Some((0, 2)), None, 0);
        let stats2 = store_commit_batch(&h, b2.finish()).unwrap();
        assert_eq!(stats2.nodes_inserted, 2);
        assert_eq!(stats2.edges_inserted, 1);
        assert_eq!(stats2.edges_dropped_not_in_batch, 1);
        assert_eq!(stats2.refs_inserted, 1);
        assert_eq!(stats2.refs_dropped_not_in_batch, 1);
        assert_eq!(stats2.files_upserted, 1);
        // node_count recorded PRE-validity-filter (result.nodes.length) = 3.
        let files = db.rows("SELECT node_count FROM files WHERE path = 'a.ts'");
        assert_eq!(files[0][0], Value::Integer(3));
        // ref context fill: filePath/language default from the op's file.
        let refs = db.rows("SELECT file_path, language, status FROM unresolved_refs");
        assert_eq!(refs[0][0], Value::Text("a.ts".into()));
        assert_eq!(refs[0][1], Value::Text("typescript".into()));
        assert_eq!(refs[0][2], Value::Text("pending".into()));
    }


    #[test]
    fn refs_lifecycle_ops_delete_and_mark_failed() {
        let db = TempDb::new();
        let h = handle(&db);
        let mut b = Builder::default();
        b.node("function:n1", "function", "n1", "n.ts", "typescript", 1, None, None, 1, 0);
        h.store_insert_nodes_(b.finish()).unwrap();
        let mut rb = Builder::default();
        rb.r#ref("function:n1", "util.greet", "calls", Some(2), Some(0), None, Some("n.ts"), Some("typescript"));
        rb.r#ref("function:n1", "other", "references", Some(3), Some(0), None, Some("n.ts"), Some("typescript"));
        h.store_insert_refs_(rb.finish()).unwrap();
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 2);

        let ids = db.rows("SELECT id FROM unresolved_refs ORDER BY id");
        let id0 = match &ids[0][0] {
            Value::Integer(i) => i.to_string(),
            _ => panic!("id"),
        };
        // delete-by-ids (NUL-joined decimal, dedup)
        let mut ob = Builder::default();
        ob.op(OP_DELETE_UNRESOLVED_BY_IDS, None, None, None, None, Some(&format!("{id0}\0{id0}")), 0);
        let stats = store_commit_batch(&h, ob.finish()).unwrap();
        assert_eq!(stats.refs_deleted, 1);
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 1);

        // mark failed: name_tail = segment after last '.'/':'
        let mut mb = Builder::default();
        mb.op(OP_MARK_REFS_FAILED, None, None, None, None, Some("function:n1\0other\0references"), 0);
        let stats = store_commit_batch(&h, mb.finish()).unwrap();
        assert_eq!(stats.refs_marked_failed, 1);
        let rows = db.rows("SELECT reference_name, status, name_tail FROM unresolved_refs");
        assert_eq!(rows[0][1], Value::Text("failed".into()));
        assert_eq!(rows[0][2], Value::Text("other".into()));

        // delete-specific-resolved triples
        let mut db2 = Builder::default();
        db2.op(OP_DELETE_SPECIFIC_RESOLVED_REFS, None, None, None, None, Some("function:n1\0other\0references"), 0);
        let stats = store_commit_batch(&h, db2.finish()).unwrap();
        assert_eq!(stats.refs_deleted, 1);
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 0);
    }

    #[test]
    fn reference_name_tail_parity() {
        assert_eq!(reference_name_tail("util.greet"), "greet");
        assert_eq!(reference_name_tail("A::b"), "b");
        assert_eq!(reference_name_tail("a.b:c"), "c");
        assert_eq!(reference_name_tail("plain"), "plain");
        assert_eq!(reference_name_tail("trailing."), "");
    }

    #[test]
    fn transaction_nesting_joins_outer_unit() {
        let db = TempDb::new();
        let mut c = StoreConn::open(&db.path).unwrap();
        let mut b = Builder::default();
        b.node("function:t1", "function", "t1", "t.ts", "typescript", 1, None, None, 1, 0);
        let buf = b.finish();

        // Simulate an already-active outer transaction exactly the way the
        // adapter does (BEGIN + depth=1), then run a nested unit: it must
        // JOIN — a nested BEGIN would fail with "cannot start a transaction
        // within a transaction", so reaching the row count proves JOIN.
        c.conn.execute_batch("BEGIN").unwrap();
        c.txn_depth = 1;
        let n = c
            .transaction(|conn| {
                let wire = Wire::decode(buf.meta.as_ref(), buf.nodes.as_ref(), buf.edges.as_ref(), buf.refs.as_ref(), buf.arena.as_ref()).unwrap();
                let mut s = Stats::default();
                op_insert_nodes(conn, &wire, 0..wire.node_count, &mut s)?;
                conn.prepare_cached("SELECT COUNT(*) FROM nodes").unwrap().query_row([], |r| r.get::<_, i64>(0)).map_err(err)
            })
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(c.txn_depth, 1, "nested unit restores the outer depth");
        c.txn_depth = 0;
        c.conn.execute_batch("COMMIT").unwrap();
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 1);

        // A standalone unit opens and commits its own transaction.
        let mut b2 = Builder::default();
        b2.node("function:t2", "function", "t2", "t.ts", "typescript", 2, None, None, 1, 0);
        let buf2 = b2.finish();
        c.transaction(|conn| {
            let wire = Wire::decode(buf2.meta.as_ref(), buf2.nodes.as_ref(), buf2.edges.as_ref(), buf2.refs.as_ref(), buf2.arena.as_ref()).unwrap();
            let mut s = Stats::default();
            op_insert_nodes(conn, &wire, 0..wire.node_count, &mut s)
        })
        .unwrap();
        assert_eq!(c.txn_depth, 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 2);
    }

    #[test]
    fn commit_batch_is_all_or_nothing() {
        let db = TempDb::new();
        let h = handle(&db);
        // Op 1 inserts a node; op 2 is garbage (unknown op code) → the whole
        // batch must roll back, node included.
        let mut b = Builder::default();
        b.node("function:rb", "function", "rb", "rb.ts", "typescript", 1, None, None, 1, 0);
        b.op(OP_INSERT_NODES, None, Some((0, 1)), None, None, None, 0);
        b.op(200, None, None, None, None, None, 0);
        let e = err_of(store_commit_batch(&h, b.finish()));
        assert!(e.to_string().contains("unknown op code"), "{e}");
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 0);
        assert_eq!(db.count("SELECT COUNT(*) FROM files"), 0);

        // Same batch with a SQL-level failure (FK violation: ref from a
        // non-existent node) also rolls back the earlier node insert.
        let mut b2 = Builder::default();
        b2.node("function:rb2", "function", "rb2", "rb.ts", "typescript", 1, None, None, 1, 0);
        b2.r#ref("function:does-not-exist", "x", "calls", Some(1), Some(0), None, None, None);
        b2.op(OP_INSERT_NODES, None, Some((0, 1)), None, None, None, 0);
        b2.op(OP_INSERT_REFS, None, None, None, Some((0, 1)), None, 0);
        assert!(store_commit_batch(&h, b2.finish()).is_err());
        assert_eq!(db.count("SELECT COUNT(*) FROM nodes"), 0);
    }

    #[test]
    fn golden_four_table_dump_matches_ts_semantics() {
        let db = TempDb::new();
        let h = handle(&db);

        // Batch 1: seed a.ts (file node + function) via STORE_FILE_RESULT.
        let mut b = Builder::default();
        let f = b.file("a.ts", "h1", "typescript", 42, 1000.5, 1700000000000, 2, None);
        b.node("file:a.ts", "file", "a.ts", "a.ts", "typescript", 0, None, Some("ts"), 1700000000000, 1);
        b.node("function:a:1", "function", "greet", "a.ts", "typescript", 1, Some("a.greet"), Some("greet"), 1700000000000, 1);
        b.r#ref("function:a:1", "console.log", "calls", Some(2), Some(4), Some("[\"log\"]"), None, None);
        b.op(OP_STORE_FILE_RESULT, Some(f), Some((0, 2)), None, Some((0, 1)), None, 0);
        store_commit_batch(&h, b.finish()).unwrap();

        // Batch 2: caller.ts + a stamped resolution edge into a.ts.
        let mut b2 = Builder::default();
        b2.node("function:c:1", "function", "main", "caller.ts", "typescript", 1, None, Some("main"), 7, 0);
        h.store_insert_nodes_(b2.finish()).unwrap();
        let mut eb = Builder::default();
        eb.edge("function:c:1", "function:a:1", "calls", Some("{\"refName\":\"greet\",\"refKind\":\"calls\"}"), Some(3), Some(0), Some("resolver"));
        h.store_insert_edges_(eb.finish()).unwrap();

        // Golden — nodes.
        let nodes = db.rows("SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, return_type, params_json, search_text, updated_at FROM nodes ORDER BY id");
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0][0], Value::Text("file:a.ts".into()));
        assert_eq!(nodes[0][3], Value::Text("a.ts".into())); // qualified falls back to name
        assert_eq!(nodes[0][13], Value::Integer(1)); // is_exported from flag bit0
        assert_eq!(nodes[0][10], Value::Null); // docstring
        assert_eq!(nodes[0][11], Value::Null); // signature
        assert_eq!(nodes[0][12], Value::Null); // visibility
        assert_eq!(nodes[1][3], Value::Text("a.greet".into()));
        assert_eq!(nodes[1][21], Value::Text("greet".into()));

        // Golden — edges (metadata byte-identical passthrough).
        let edges = db.rows("SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY id");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0][3], Value::Text("{\"refName\":\"greet\",\"refKind\":\"calls\"}".into()));
        assert_eq!(edges[0][6], Value::Text("resolver".into()));

        // Golden — unresolved_refs (context fill: filePath/language from the
        // op's file record; candidates JSON passthrough; status default).
        let refs = db.rows("SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail FROM unresolved_refs ORDER BY id");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0][5], Value::Text("[\"log\"]".into()));
        assert_eq!(refs[0][6], Value::Text("a.ts".into()));
        assert_eq!(refs[0][7], Value::Text("typescript".into()));
        assert_eq!(refs[0][8], Value::Text("pending".into()));
        assert_eq!(refs[0][9], Value::Text("".into()));

        // Golden — files (upsertFile wrote LAST; mtime stays fractional).
        let files = db.rows("SELECT path, content_hash, language, size, modified_at, indexed_at, node_count, errors FROM files ORDER BY path");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0][0], Value::Text("a.ts".into()));
        assert_eq!(files[0][3], Value::Integer(42));
        assert_eq!(files[0][4], Value::Real(1000.5));
        assert_eq!(files[0][6], Value::Integer(2));
        assert_eq!(files[0][7], Value::Null);

        // Re-index a.ts (hash change, line shift, name kept): the snapshot
        // edge re-attaches to the new id — full four-table terminal state.
        let mut b3 = Builder::default();
        let f3 = b3.file("a.ts", "h2", "typescript", 44, 2000.0, 1700000009999, 2, None);
        b3.node("file:a.ts", "file", "a.ts", "a.ts", "typescript", 0, None, Some("ts"), 1700000009999, 1);
        b3.node("function:a:4", "function", "greet", "a.ts", "typescript", 4, Some("a.greet"), Some("greet"), 1700000009999, 1);
        b3.op(OP_STORE_FILE_RESULT, Some(f3), Some((0, 2)), None, None, None, 0);
        let stats = store_commit_batch(&h, b3.finish()).unwrap();
        assert_eq!(stats.edges_reattached, 1);
        assert_eq!(stats.refs_resurrected, 0);
        let after = golden(&db);
        // Terminal golden: caller's ref from batch 1 was cascade-deleted with
        // a.ts's old nodes? No — its from_node lives in caller.ts; only the
        // EDGE into a.ts cascaded, and it is back (re-attached to a:4).
        let edges2 = db.rows("SELECT source, target FROM edges ORDER BY id");
        assert_eq!(edges2.len(), 1);
        assert_eq!(edges2[0][1], Value::Text("function:a:4".into()));
        // The batch-1 unresolved ref (from a.ts's OLD function id) cascaded
        // away with deleteFile — FK from_node_id ON DELETE CASCADE.
        assert_eq!(db.count("SELECT COUNT(*) FROM unresolved_refs"), 0);
        assert!(!after.is_empty());
    }

    #[test]
    fn wire_rejects_abi_mismatch_and_truncation() {
        let b = Builder::default();
        let buf = b.finish();
        let mut meta = buf.meta.clone();
        meta[0] = 99;
        let e = err_of(Wire::decode(&meta, &buf.nodes, &buf.edges, &buf.refs, &buf.arena));
        assert!(e.to_string().contains("abi"), "{e}");
        let e2 = err_of(Wire::decode(&buf.meta[..10], &[], &[], &[], &[]));
        assert!(e2.to_string().contains("header"), "{e2}");
    }
}
