//! Wire ABI constants shared by the extraction, store, ctx, and resolve
//! surfaces.
//!
//! Every value here is a byte-level contract with the TypeScript
//! encoders/decoders (`src/extraction/kernel/layout.ts`,
//! `src/graph/store/layout.ts`, `src/graph/resolution/resolve-encode.ts`,
//! `src/graph/resolution/ctx-decode.ts`). Changing a layout requires bumping
//! the owning ABI version and re-recording
//! `test/oracle/data-graph/contract/napi-contract.json`.
//!
//! Four ABIs are numbered independently. They are NOT comparable: a kernel
//! ABI of 2 says nothing about the store/ctx/resolve ABI of 1.

// ---------------------------------------------------------------------------
// ABI versions
// ---------------------------------------------------------------------------

/// Extraction buffer ABI (`KERNEL_ABI_VERSION` in codegraph-kernel).
pub const KERNEL_ABI_VERSION: u8 = 2;
/// Store wire ABI (`STORE_ABI_VERSION`).
pub const STORE_ABI_VERSION: u8 = 1;
/// Resolution read-context ABI (`CTX_ABI_VERSION`).
pub const CTX_ABI_VERSION: u8 = 1;
/// Resolution batch ABI (`RESOLVE_ABI_VERSION`).
pub const RESOLVE_ABI_VERSION: u8 = 1;

// ---------------------------------------------------------------------------
// Arena string references
// ---------------------------------------------------------------------------

/// `NONE` marks an absent field in a `(offset, len)` string slot.
pub const NONE: u32 = 0xFFFF_FFFF;
/// `(offset, len)` pair into the shared UTF-8 arena.
pub type StrRef = (u32, u32);
/// The canonical absent string reference.
pub const NONE_STR: StrRef = (NONE, 0);

/// Reference-kind code for the internal-only `function_ref` row (#756).
pub const FUNCTION_REF_CODE: u8 = 200;
/// Ref-row flag bit 0: the ref carries the extracting file's path.
pub const REF_FLAG_FILE_PATH: u8 = 1;

// ---------------------------------------------------------------------------
// Extraction wire (KERNEL_ABI_VERSION = 2)
// ---------------------------------------------------------------------------

pub const META_SIZE: usize = 36;
pub const NODE_ROW_SIZE: usize = 96;
pub const EDGE_ROW_SIZE: usize = 44;
pub const REF_ROW_SIZE: usize = 40;

// ---------------------------------------------------------------------------
// Store wire (STORE_ABI_VERSION = 1)
// ---------------------------------------------------------------------------

pub const STORE_META_HEADER_SIZE: usize = 28;
pub const STORE_OP_ROW_SIZE: usize = 48;
pub const STORE_FILE_ROW_SIZE: usize = 64;
pub const STORE_NODE_ROW_SIZE: usize = 140;
pub const STORE_EDGE_ROW_SIZE: usize = 48;
pub const STORE_REF_ROW_SIZE: usize = 56;

/// `storeExtractionResultTxn` for one file, in one transaction.
pub const OP_STORE_FILE_RESULT: u8 = 1;
/// Cascade delete of one file (`arg` = file path).
pub const OP_DELETE_FILE: u8 = 2;
/// Standalone node-range insert.
pub const OP_INSERT_NODES: u8 = 3;
/// Standalone edge-range insert.
pub const OP_INSERT_EDGES: u8 = 4;
/// Standalone unresolved-ref-range insert.
pub const OP_INSERT_REFS: u8 = 5;
/// Upsert one file record (`file_index` selects it).
pub const OP_UPSERT_FILE: u8 = 6;
/// Delete unresolved refs by row id (`arg` = NUL-joined decimal ids).
pub const OP_DELETE_UNRESOLVED_BY_IDS: u8 = 7;
/// Delete specific resolved refs (`arg` = NUL-joined triples).
pub const OP_DELETE_SPECIFIC_RESOLVED_REFS: u8 = 8;
/// Mark refs failed (`arg` = NUL-joined triples).
pub const OP_MARK_REFS_FAILED: u8 = 9;

/// `OP_DELETE_FILE` flag bit 0: resurrect incoming cross-file edges as
/// pending refs before the cascade.
pub const DELETE_FILE_FLAG_RESURRECT: u32 = 1;

/// Store node flags byte: exported / async / static / abstract, one bit each.
pub const STORE_NODE_FLAG_EXPORTED: u8 = 1;
pub const STORE_NODE_FLAG_ASYNC: u8 = 2;
pub const STORE_NODE_FLAG_STATIC: u8 = 4;
pub const STORE_NODE_FLAG_ABSTRACT: u8 = 8;

// ---------------------------------------------------------------------------
// Ctx wire (CTX_ABI_VERSION = 1)
// ---------------------------------------------------------------------------

pub const CTX_NODES_HEADER_SIZE: usize = 20;
pub const CTX_STRINGS_HEADER_SIZE: usize = 16;
pub const CTX_MAPPINGS_HEADER_SIZE: usize = 20;
pub const CTX_REEXPORTS_HEADER_SIZE: usize = 20;
pub const CTX_GROUP_ROW_SIZE: usize = 8;
pub const CTX_STR_ROW_SIZE: usize = 8;
pub const CTX_MAPPING_ROW_SIZE: usize = 36;
pub const CTX_REEXPORT_ROW_SIZE: usize = 28;

/// Re-export row kind: named re-export.
pub const CTX_REEXPORT_NAMED: u8 = 1;
/// Re-export row kind: `export * from` wildcard.
pub const CTX_REEXPORT_WILDCARD: u8 = 2;

// ---------------------------------------------------------------------------
// Resolve wire (RESOLVE_ABI_VERSION = 1)
// ---------------------------------------------------------------------------

pub const RESOLVE_META_SIZE: usize = 16;
pub const RESOLVE_REF_ROW_SIZE: usize = 64;
pub const RESOLVE_EXT_HEADER_SIZE: usize = 32;
pub const RESOLVE_KEY_ROW_SIZE: usize = 32;
pub const RESOLVE_FW_GROUP_ROW_SIZE: usize = 48;
pub const RESOLVE_FW_CAND_ROW_SIZE: usize = 40;
pub const RESOLVE_ALSO_ROW_SIZE: usize = 16;
pub const RESOLVE_CLAIMED_ROW_SIZE: usize = 8;
pub const RESOLVE_PATH_ROW_SIZE: usize = 24;
pub const RESOLVE_OUT_HEADER_SIZE: usize = 40;
pub const RESOLVE_EDGE_ROW_SIZE: usize = 80;
pub const RESOLVE_OUT_REF_ROW_SIZE: usize = 40;
pub const RESOLVE_SWEEP_ROW_SIZE: usize = 24;
pub const RESOLVE_STAT_ROW_SIZE: usize = 16;

/// Resolve meta flags bit 0: sweep the batch's own files for file-level
/// import edges.
pub const RESOLVE_FLAG_SWEEP_BATCH_FILES: u32 = 1;

/// Resolve output ref-row flag: resolved (delete after persist).
pub const RESOLVE_OUT_REF_RESOLVED: u8 = 1;
/// Resolve output ref-row flag: unresolved (mark failed after persist).
pub const RESOLVE_OUT_REF_UNRESOLVED: u8 = 2;

// ---------------------------------------------------------------------------
// Kind tables — order is the wire contract
// ---------------------------------------------------------------------------

/// Node kinds. The first 23 entries mirror the upstream table; `statement` is
/// the fork-exclusive tail append. Append, never reorder.
pub const NODE_KINDS: [&str; 24] = [
    "file",
    "module",
    "class",
    "struct",
    "interface",
    "trait",
    "protocol",
    "function",
    "method",
    "property",
    "field",
    "variable",
    "constant",
    "enum",
    "enum_member",
    "type_alias",
    "namespace",
    "parameter",
    "import",
    "export",
    "route",
    "component",
    "union",
    "statement",
];

/// Edge kinds. `navigates` is a reserved tail append with no extraction-layer
/// emitter on either side.
pub const EDGE_KINDS: [&str; 13] = [
    "contains",
    "calls",
    "imports",
    "exports",
    "extends",
    "implements",
    "references",
    "type_of",
    "returns",
    "instantiates",
    "overrides",
    "decorates",
    "navigates",
];

/// Languages the HEAD kernel reports in `contract_info().languages`. Routing
/// policy stays TS-side; this table only pins the contract value.
pub const LANGUAGES: [&str; 23] = [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "java",
    "python",
    "go",
    "c",
    "cpp",
    "rust",
    "csharp",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "r",
    "lua",
    "luau",
    "scala",
    "dart",
    "pascal",
    "nix",
    "objc",
];

/// Index of `kind` in [`NODE_KINDS`], or `None` when the fork does not know
/// the kind.
pub fn node_kind_index(kind: &str) -> Option<u8> {
    NODE_KINDS
        .iter()
        .position(|candidate| *candidate == kind)
        .map(|index| index as u8)
}

/// Index of `kind` in [`EDGE_KINDS`], or `None` when the fork does not know
/// the kind.
pub fn edge_kind_index(kind: &str) -> Option<u8> {
    EDGE_KINDS
        .iter()
        .position(|candidate| *candidate == kind)
        .map(|index| index as u8)
}
