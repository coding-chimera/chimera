//! resolver_ctx — R3b resolution read context (SQLite reads + fs reads behind napi).
//!
//! Mirrors the TS `ResolutionContext` read surface
//! (`packages/chimera/src/graph/resolution/index.ts` createContext :277-443 +
//! `packages/chimera/src/graph/db/queries.ts` getters) so the JS side no longer
//! needs the knownNames/knownFiles full-DB string projections or the 8 LRU
//! caches (~85MB/root of JS heap, r3-contract-inventory.md §E/§F). Batch
//! interfaces are the primary face — one boundary crossing per BATCH, never
//! per ref (R3 proposal §4.1: per-ref crossings are unacceptable at 129k refs).
//!
//! Boundary discipline (same as store.rs / lib.rs): calls are SYNCHRONOUS and
//! must be driven from a worker thread. One CtxHandle = one graph root; it
//! holds its OWN rusqlite read connection to the same db file (WAL: readers
//! never block the store's writer) plus the read-context caches.
//!
//! # Cache invalidation — generation counter
//!
//! TS semantics being replaced: `warmCaches()` rebuilds knownFiles/knownNames
//! before every resolveAll; `clearCaches()` drops everything on every
//! index/sync. Here the rebuild is LAZY and generation-keyed: the shared
//! StoreHandle bumps its commit generation on every committed write unit
//! (store.rs `gen`), and every ctx entry point first compares the store
//! generation (plus the local epoch bumped by `ctx_invalidate`) against the
//! generation the caches were built at — stale means drop all LRUs + both
//! name/file indexes and rebuild the indexes on demand. No rebuild happens
//! when nothing was written (the "avoid pointless warmCaches" win).
//!
//! WRITES THAT BYPASS THE STORE HANDLE are invisible to the generation
//! counter (TS QueryBuilder arm, runPostExtract's updateNode, another
//! process): the R3b-2 TS bridge MUST call `ctx_invalidate` at those seams
//! (the clearCaches call sites).
//!
//! # Wire formats (CTX_ABI_VERSION = 1)
//!
//! All little-endian. Strings are `(offset u32, len u32)` pairs into the UTF-8
//! arena; `offset == NONE (0xFFFF_FFFF)` means "field absent" (NULL). The node
//! row layout is BYTE-IDENTICAL to store.rs's 140-byte store node row (same
//! field order/slots) so the R3a-2 TS decoder is reusable; differences on the
//! read side: `search_text` is always NONE (rowToNode never maps it) and
//! `updated_at` carries the raw DB value.
//!
//! ## CtxNodesOut { header, groups, nodes, arena } — node-result batches
//!
//! header (20 bytes):
//!   0   u8   CTX_ABI_VERSION
//!   1   [3]  pad
//!   4   u32  group_count   (one group per requested key, REQUEST ORDER)
//!   8   u32  node_count
//!   12  u32  arena byte length
//!   16  u32  pad
//!
//! group row (8 bytes), `group_count` rows after the header:
//!   0   u32  node_start (row index into the node table)
//!   4   u32  node_end   (EXCLUSIVE; empty range = no rows for this key —
//!                        for ctx_get_node_by_id that is the `undefined` miss)
//!
//! node row (140 bytes): see store.rs "nodes buffer" for the field table.
//! is_exported/is_async/is_static/is_abstract fold into the flags byte with
//! `column === 1` semantics (TS rowToNode's strict `=== 1`).
//!
//! ## CtxStringsOut { header, groups, strs, arena } — string-list batches
//!
//! header (16 bytes):
//!   0   u8   CTX_ABI_VERSION
//!   1   [3]  pad
//!   4   u32  group_count
//!   8   u32  str_count
//!   12  u32  arena byte length
//!
//! group row (8 bytes): str_start, str_end (exclusive)
//! str row (8 bytes): (offset, len); offset == NONE → absent (readFile miss)
//!
//! Used by ctx_get_all_files / ctx_get_all_node_names (single group),
//! ctx_read_files / ctx_get_file_lines / ctx_list_directories (group per
//! requested path; an absent or EMPTY group carries the TS null/[] outcome).
//!
//! ## CtxImportMappingsOut { header, groups, mappings, arena }
//!
//! header (20 bytes): abi u8, [3] pad, group_count u32, mapping_count u32,
//! arena_len u32, pad u32. Group row (8): mapping_start, mapping_end.
//! mapping row (36 bytes):
//!   0   str  local_name
//!   8   str  exported_name
//!   16  str  source
//!   24  str  resolved_path (ALWAYS NONE — extractImportMappings never sets
//!                           it; resolveViaImport resolves later, TS-side)
//!   32  u8   flags — bit0 is_default, bit1 is_namespace
//!   33  [3]  pad
//!
//! ## CtxReExportsOut { header, groups, reexports, arena }
//!
//! Same 20-byte header (reexport_count at 8). reexport row (28 bytes):
//!   0   u8   kind — 1 = named, 2 = wildcard
//!   1   [3]  pad
//!   4   str  exported_name (wildcard → NONE)
//!   12  str  original_name (wildcard → NONE)
//!   20  str  source
//!
//! # Parity notes (TS source of truth)
//!
//! - getNodesByName: `ORDER BY file_path, start_line` — LOAD-BEARING (CG-33,
//!   queries.ts:1135-1143); same-name candidate arbitration binds to the
//!   first row. SQL is verbatim so the bundled SQLite sorts identically.
//! - getNodesByFile: `ORDER BY start_line`; by-qualified-name / lower-name /
//!   kind have NO ORDER BY (verbatim SQL — tie order is the same SQLite scan
//!   order the bun:sqlite/node:sqlite arms produce).
//! - getNodesByLowerName: `lower(name) = lower(?)` — SQLite's ASCII-only
//!   lower() on BOTH sides (queries.ts:1172-1180 hardening), not Rust-side
//!   Unicode folding.
//! - fileExists: knownFiles membership on the raw path AND the `\`→`/`
//!   normalized path (resolution/index.ts:309-310), then fs.existsSync
//!   fallback (follows symlinks, dirs count).
//! - readFile: LOSSY UTF-8 decode (Node readFileSync utf8 replaces invalid
//!   bytes with U+FFFD rather than throwing); failures cache None exactly
//!   like `fileCache.set(filePath, null)`.
//! - getFileLines: `content.split('\n')` — an empty file yields [""], an
//!   unreadable file yields [] and is NOT lines-cached (TS early-returns
//!   before the set).
//! - fs paths go through a port of Node's path.join + normalize (posix and
//!   win32 drive-letter forms): `.`/`..` collapse, duplicate separators
//!   collapse, separators normalize to `/` (accepted by win32 fs APIs).
//! - Import-mapping / re-export extraction ports the import-resolver.ts
//!   regex walkers with JS-equivalent character classes: `\w` →
//!   `[0-9A-Za-z_]` (JS \w is ASCII-only), `\s` → the full JS whitespace set
//!   (incl. \u{a0}, \u{feff}). The regex crate's leftmost-first preference
//!   semantics match JS backtracking group priority on these patterns (no
//!   lookaround/backrefs are used anywhere).
//! - LRU: capacity + recency semantics of resolution/lru-cache.ts (get
//!   refreshes, set-on-existing refreshes, evict-oldest only when the key is
//!   new and size >= max). Capacities: 6×limit (default 5000) + 2×content
//!   limit (max(64, limit/5) = 1000) — nodeCache/nameCache/lowerNameCache/
//!   qualifiedNameCache/importMappingCache/reExportCache at limit;
//!   fileCache/linesCache at content limit; plus the QueryBuilder by-id node
//!   cache (queries.ts:367 maxCacheSize = 1000) for getNodeById. Env
//!   CODEGRAPH_RESOLVER_CACHE_SIZE parsed with JS parseInt semantics.
//!
//! # Not ported (declared ABSENT in ctx_contract_info — R3b verification
//! requires the capability table to name these; the TS bridge keeps its arm)
//!
//! - getProjectAliases / getGoModule — config-file parses, stay TS.
//! - getCppIncludeDirs — compile_commands.json + shlex + heuristic walk,
//!   stays TS. SEMANTIC NOTE: the TS getter recomputes via
//!   loadCppIncludeDirs whose module-level cache lives until
//!   clearImportMappingCache — the ctx caches do NOT interact with it.
//! - resolveImport — per-ref crossing, forbidden by the FFI boundary rules;
//!   R3c precomputes per-file import tables instead.
#![allow(clippy::too_many_arguments)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use rusqlite::Connection;

use crate::buffers::NONE;
use crate::store::{StoreHandle, STORE_NODE_ROW_SIZE};

/// Ctx wire ABI — independent numbering from KERNEL_ABI_VERSION and
/// STORE_ABI_VERSION; the TS loader verifies equality before routing reads.
pub const CTX_ABI_VERSION: u8 = 1;
/// Semantic version string reported alongside the ABI number.
pub const CTX_VERSION: &str = "1.0.0";

pub const CTX_NODES_HEADER_SIZE: usize = 20;
pub const CTX_STRINGS_HEADER_SIZE: usize = 16;
pub const CTX_MAPPINGS_HEADER_SIZE: usize = 20;
pub const CTX_REEXPORTS_HEADER_SIZE: usize = 20;
pub const CTX_GROUP_ROW_SIZE: usize = 8;
pub const CTX_STR_ROW_SIZE: usize = 8;
pub const CTX_MAPPING_ROW_SIZE: usize = 36;
pub const CTX_REEXPORT_ROW_SIZE: usize = 28;

/// resolution/index.ts:51 DEFAULT_CACHE_LIMIT.
const DEFAULT_CACHE_LIMIT: usize = 5_000;
/// queries.ts:367 QueryBuilder nodeCache (getNodeById arm).
const BY_ID_CACHE_LIMIT: usize = 1_000;

fn ctx_err(msg: String) -> Error {
    Error::from_reason(format!("ctx: {msg}"))
}

fn err(e: rusqlite::Error) -> Error {
    Error::from_reason(format!("ctx sql: {e}"))
}

// ---------------------------------------------------------------------------
// LRU — resolution/lru-cache.ts semantics
// ---------------------------------------------------------------------------

/// Insertion-ordered LRU: `get` refreshes recency, `set` on an existing key
/// refreshes, eviction (oldest first) happens only when a NEW key lands in a
/// full cache — exactly lru-cache.ts:29-57.
struct Lru<K, V> {
    map: HashMap<K, (u64, V)>,
    order: BTreeMap<u64, K>,
    next_seq: u64,
    max: usize,
}

impl<K: Clone + Ord + Eq + std::hash::Hash, V> Lru<K, V> {
    fn new(max: usize) -> Self {
        Lru { map: HashMap::new(), order: BTreeMap::new(), next_seq: 0, max: max.max(1) }
    }

    /// The entry count (capacity tests).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        let old_seq = self.map.get(key)?.0;
        let seq = self.next_seq;
        self.next_seq += 1;
        self.map.get_mut(key)?.0 = seq;
        self.order.remove(&old_seq);
        self.order.insert(seq, key.clone());
        Some(&self.map.get(key)?.1)
    }

    fn has(&self, key: &K) -> bool {
        self.map.contains_key(key)
    }

    fn set(&mut self, key: K, value: V) {
        if let Some((old_seq, _)) = self.map.get(&key) {
            self.order.remove(old_seq);
        } else if self.map.len() >= self.max {
            // Evict the OLDEST (lowest seq = first in ascending order).
            if let Some((_, oldest)) = self.order.iter().next() {
                let oldest = oldest.clone();
                if let Some((old_seq, _)) = self.map.remove(&oldest) {
                    self.order.remove(&old_seq);
                }
            }
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.map.insert(key.clone(), (seq, value));
        self.order.insert(seq, key);
    }

    /// The LRU (first-evicted) key, for capacity tests.
    #[cfg(test)]
    fn oldest(&self) -> Option<&K> {
        self.order.values().next()
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

// ---------------------------------------------------------------------------
// Env — resolution/index.ts:52-58 resolveCacheLimit
// ---------------------------------------------------------------------------

/// JS `Number.parseInt(raw, 10)`: leading-whitespace tolerant, optional sign,
/// stops at the first non-digit, NaN → None. Overflow saturates (JS yields a
/// finite float; any huge positive limit behaves identically for us).
fn js_parse_int(raw: &str) -> Option<i64> {
    let t = raw.trim_start_matches(is_js_space);
    let (neg, digits) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let v = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if neg { -v } else { v })
}

/// The JS whitespace set (`\s` + LineTerminators + ZWNBSP) — used by the
/// parseInt port, the `.trim()` port and the regex class below.
fn is_js_space(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn resolve_cache_limit() -> usize {
    match std::env::var("CODEGRAPH_RESOLVER_CACHE_SIZE").ok().filter(|s| !s.is_empty()) {
        Some(raw) => match js_parse_int(&raw) {
            Some(v) if v > 0 => v as usize,
            _ => DEFAULT_CACHE_LIMIT,
        },
        None => DEFAULT_CACHE_LIMIT,
    }
}

// ---------------------------------------------------------------------------
// Path handling — Node path.join + normalize port
// ---------------------------------------------------------------------------

/// Node `path.join(root, rel)` + `path.normalize` semantics (posix; the
/// win32 drive-letter form is preserved). Separators normalize to `/` —
/// win32 fs APIs accept forward slashes, and the TS side only ever keys
/// caches with the caller-supplied relative path.
fn join_normalized(root: &str, rel: &str) -> String {
    normalize_path(&format!("{root}/{rel}"))
}

fn normalize_path(p: &str) -> String {
    let (prefix, rest) = drive_prefix(p);
    let rooted = rest.starts_with('/') || rest.starts_with('\\');
    let rest = rest.trim_start_matches(['/', '\\']);
    let mut segs: Vec<&str> = Vec::new();
    let mut ups = 0usize;
    for seg in rest.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                if segs.pop().is_none() {
                    ups += 1;
                }
            }
            s => segs.push(s),
        }
    }
    let mut out = String::from(prefix);
    if rooted {
        out.push('/');
    } else {
        for _ in 0..ups {
            out.push_str("../");
        }
    }
    out.push_str(&segs.join("/"));
    if out.is_empty() {
        return ".".to_string();
    }
    // Node keeps a trailing separator when the input ended in one.
    if (p.ends_with('/') || p.ends_with('\\')) && !out.ends_with('/') {
        out.push('/');
    }
    out
}

fn drive_prefix(p: &str) -> (&str, &str) {
    if p.len() >= 2 {
        let b = p.as_bytes();
        if b[0].is_ascii_alphabetic() && b[1] == b':' && p.len() > 2 && (b[2] == b'/' || b[2] == b'\\') {
            return (&p[..2], &p[2..]);
        }
    }
    ("", p)
}

// ---------------------------------------------------------------------------
// Import-mapping / re-export regex ports (import-resolver.ts)
// ---------------------------------------------------------------------------

/// JS `\s` as a regex class (Unicode set, matching String.prototype space).
const S: &str = "[\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
/// JS `\w` as a regex class (ASCII-only, unlike Rust's Unicode default).
const W: &str = "[0-9A-Za-z_]";

struct Pats {
    js_import: Regex,
    alias_as: Regex,
    js_require: Regex,
    destr_alias: Regex,
    py_from: Regex,
    py_import: Regex,
    go_single: Regex,
    go_block: Regex,
    go_line: Regex,
    java_block_comment: Regex,
    java_line_comment: Regex,
    java_import: Regex,
    php_use: Regex,
    cpp_include: Regex,
    cpp_ext: Regex,
    re_wildcard: Regex,
    re_named: Regex,
    re_alias: Regex,
    re_word: Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| {
        let r = |s: String| Regex::new(&s).expect("resolver_ctx pattern");
        Pats {
            js_import: r(["import", S, "+(?:(", W, "+)", S, "*,?", S, "*)?(?:\\{([^}]+)\\})?", S, "*(?:(\\*)", S, "+as", S, "+(", W, "+))?", S, "*from", S, "*['\"]([^'\"]+)['\"]"].concat()),
            alias_as: r(["(", W, "+)", S, "+as", S, "+(", W, "+)"].concat()),
            js_require: r(["(?:const|let|var)", S, "+(?:(", W, "+)|\\{([^}]+)\\})", S, "*=", S, "*require\\(['\"]([^'\"]+)['\"]\\)"].concat()),
            destr_alias: r(["(", W, "+)", S, "*:", S, "*(", W, "+)"].concat()),
            py_from: r(["from", S, "+([0-9A-Za-z_.]+)", S, "+import", S, "+([^#\\n]+)"].concat()),
            py_import: r(["(?m)^import", S, "+([0-9A-Za-z_.]+)(?:", S, "+as", S, "+(", W, "+))?"].concat()),
            go_single: r(["import", S, "+(?:(", W, "+)", S, "+)?[\"']([^\"']+)[\"']"].concat()),
            go_block: r(["import", S, "*\\(", S, "*([^)]+)", S, "*\\)"].concat()),
            go_line: r(["(?:(", W, "+)", S, "+)?[\"']([^\"']+)[\"']"].concat()),
            java_block_comment: r("(?s)/\\*.*?\\*/".to_string()),
            java_line_comment: r("//[^\\n]*".to_string()),
            java_import: r(["(?m)^", S, "*import", S, "+(static", S, "+)?([0-9A-Za-z_.]+(?:\\.\\*)?)", S, "*;"].concat()),
            php_use: r(["use", S, "+([0-9A-Za-z_\\\\]+)(?:", S, "+as", S, "+(", W, "+))?;"].concat()),
            cpp_include: r(["(?m)^", S, "*#", S, "*include", S, "+[<\"]([^>\"]+)[>\"]"].concat()),
            cpp_ext: r("\\.(h|hpp|hxx|hh|inl|ipp|cxx|cc|cpp)$".to_string()),
            re_wildcard: r(["export", S, "*\\*(?:", S, "+as", S, "+", W, "+)?", S, "*from", S, "*['\"]([^'\"]+)['\"]"].concat()),
            re_named: r(["export", S, "*\\{([^}]+)\\}", S, "*from", S, "*['\"]([^'\"]+)['\"]"].concat()),
            re_alias: r(["^(", W, "+)", S, "+as", S, "+(", W, "+)$"].concat()),
            re_word: r(["^", W, "+$"].concat()),
        }
    })
}

/// ImportMapping (resolution/types.ts:229-242). resolved_path is never set by
/// extractImportMappings — resolution fills it later, TS-side.
#[derive(Clone, PartialEq, Debug)]
struct ImportMapping {
    local_name: String,
    exported_name: String,
    source: String,
    is_default: bool,
    is_namespace: bool,
}

/// ReExport (resolution/types.ts:249-263).
#[derive(Clone, PartialEq, Debug)]
enum ReExport {
    Named { exported_name: String, original_name: String, source: String },
    Wildcard { source: String },
}

fn cap<'m>(c: &'m regex::Captures, i: usize) -> &'m str {
    c.get(i).map(|m| m.as_str()).unwrap_or("")
}

/// extractImportMappings (import-resolver.ts:490-512) — language dispatch.
fn extract_import_mappings(content: &str, language: &str) -> Vec<ImportMapping> {
    let mut out = Vec::new();
    match language {
        "typescript" | "javascript" | "tsx" | "jsx" => extract_js_imports(content, &mut out),
        "python" => extract_python_imports(content, &mut out),
        "go" => extract_go_imports(content, &mut out),
        "java" | "kotlin" => extract_java_imports(content, &mut out),
        "php" => extract_php_imports(content, &mut out),
        "c" | "cpp" => extract_cpp_imports(content, &mut out),
        _ => {}
    }
    out
}

fn extract_js_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    for c in p.js_import.captures_iter(content) {
        let source = cap(&c, 5);
        // Default import (group 1 = `(\w)+` is non-empty whenever present).
        if let Some(d) = c.get(1) {
            out.push(ImportMapping { local_name: d.as_str().to_string(), exported_name: "default".to_string(), source: source.to_string(), is_default: true, is_namespace: false });
        }
        if let Some(named) = c.get(2) {
            for name in named.as_str().split(',').map(js_trim) {
                if let Some(a) = p.alias_as.captures(name) {
                    out.push(ImportMapping { local_name: cap(&a, 2).to_string(), exported_name: cap(&a, 1).to_string(), source: source.to_string(), is_default: false, is_namespace: false });
                } else if !name.is_empty() {
                    out.push(ImportMapping { local_name: name.to_string(), exported_name: name.to_string(), source: source.to_string(), is_default: false, is_namespace: false });
                }
            }
        }
        // Namespace import: `* as alias`.
        if c.get(3).is_some() {
            if let Some(ns) = c.get(4) {
                out.push(ImportMapping { local_name: ns.as_str().to_string(), exported_name: "*".to_string(), source: source.to_string(), is_default: false, is_namespace: true });
            }
        }
    }
    for c in p.js_require.captures_iter(content) {
        let source = cap(&c, 3);
        if let Some(d) = c.get(1) {
            out.push(ImportMapping { local_name: d.as_str().to_string(), exported_name: "default".to_string(), source: source.to_string(), is_default: true, is_namespace: false });
        }
        if let Some(de) = c.get(2) {
            for name in de.as_str().split(',').map(js_trim) {
                if let Some(a) = p.destr_alias.captures(name) {
                    out.push(ImportMapping { local_name: cap(&a, 2).to_string(), exported_name: cap(&a, 1).to_string(), source: source.to_string(), is_default: false, is_namespace: false });
                } else if !name.is_empty() {
                    out.push(ImportMapping { local_name: name.to_string(), exported_name: name.to_string(), source: source.to_string(), is_default: false, is_namespace: false });
                }
            }
        }
    }
}

fn extract_python_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    for c in p.py_from.captures_iter(content) {
        let source = cap(&c, 1);
        for name in cap(&c, 2).split(',').map(js_trim) {
            if let Some(a) = p.alias_as.captures(name) {
                out.push(ImportMapping { local_name: cap(&a, 2).to_string(), exported_name: cap(&a, 1).to_string(), source: source.to_string(), is_default: false, is_namespace: false });
            } else if !name.is_empty() && name != "*" {
                out.push(ImportMapping { local_name: name.to_string(), exported_name: name.to_string(), source: source.to_string(), is_default: false, is_namespace: false });
            }
        }
    }
    for c in p.py_import.captures_iter(content) {
        let source = cap(&c, 1);
        let alias = c.get(2).map(|m| m.as_str()).filter(|s| !s.is_empty());
        let local = match alias {
            Some(a) => a.to_string(),
            None => source.rsplit('.').next().unwrap_or("").to_string(),
        };
        out.push(ImportMapping { local_name: local, exported_name: "*".to_string(), source: source.to_string(), is_default: false, is_namespace: true });
    }
}

fn extract_go_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    let push = |out: &mut Vec<ImportMapping>, alias: Option<&str>, source: &str| {
        let pkg = source.rsplit('/').next().unwrap_or("");
        let local = match alias.filter(|s| !s.is_empty()) {
            Some(a) => a.to_string(),
            None => pkg.to_string(),
        };
        out.push(ImportMapping { local_name: local, exported_name: "*".to_string(), source: source.to_string(), is_default: false, is_namespace: true });
    };
    for c in p.go_single.captures_iter(content) {
        push(out, c.get(1).map(|m| m.as_str()), cap(&c, 2));
    }
    for c in p.go_block.captures_iter(content) {
        let block = cap(&c, 1).to_string();
        for lc in p.go_line.captures_iter(&block) {
            push(out, lc.get(1).map(|m| m.as_str()), cap(&lc, 2));
        }
    }
}

fn extract_java_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    // Strip block comments FIRST, then line comments (import-resolver.ts:733-735).
    let no_block = p.java_block_comment.replace_all(content, "");
    let stripped = p.java_line_comment.replace_all(no_block.as_ref(), "");
    for c in p.java_import.captures_iter(stripped.as_ref()) {
        let fqn = cap(&c, 2);
        if fqn.ends_with(".*") {
            continue;
        }
        let local = fqn.rsplit('.').next().unwrap_or("");
        if local.is_empty() {
            continue;
        }
        out.push(ImportMapping { local_name: local.to_string(), exported_name: local.to_string(), source: fqn.to_string(), is_default: false, is_namespace: false });
    }
}

fn extract_php_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    for c in p.php_use.captures_iter(content) {
        let full = cap(&c, 1);
        let class = full.rsplit('\\').next().unwrap_or("");
        let alias = c.get(2).map(|m| m.as_str()).filter(|s| !s.is_empty());
        let local = match alias {
            Some(a) => a.to_string(),
            None => class.to_string(),
        };
        out.push(ImportMapping { local_name: local, exported_name: class.to_string(), source: full.to_string(), is_default: false, is_namespace: false });
    }
}

fn extract_cpp_imports(content: &str, out: &mut Vec<ImportMapping>) {
    let p = pats();
    for c in p.cpp_include.captures_iter(content) {
        let module_path = cap(&c, 1);
        let base = module_path.rsplit('/').next().unwrap_or("");
        let stripped = p.cpp_ext.replace(base, "");
        let local = if stripped.is_empty() { module_path } else { stripped.as_ref() };
        out.push(ImportMapping { local_name: local.to_string(), exported_name: "*".to_string(), source: module_path.to_string(), is_default: false, is_namespace: true });
    }
}

/// stripJsComments (import-resolver.ts:839-876) — string-literal-preserving
/// line/block comment stripper; char-scan port (UTF-16 vs char iteration is
/// observationally identical at the string level).
fn strip_js_comments(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::with_capacity(content.len());
    let mut i = 0usize;
    let mut str_ch: Option<char> = None;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(s) = str_ch {
            out.push(ch);
            if ch == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == s {
                str_ch = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            str_ch = Some(ch);
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// extractReExports (import-resolver.ts:893-946).
fn extract_re_exports(content: &str, language: &str) -> Vec<ReExport> {
    if !matches!(language, "typescript" | "javascript" | "tsx" | "jsx") {
        return Vec::new();
    }
    let p = pats();
    let cleaned = strip_js_comments(content);
    let mut out = Vec::new();
    for c in p.re_wildcard.captures_iter(&cleaned) {
        out.push(ReExport::Wildcard { source: cap(&c, 1).to_string() });
    }
    for c in p.re_named.captures_iter(&cleaned) {
        let inner = cap(&c, 1);
        let source = cap(&c, 2);
        for raw in inner.split(',') {
            let item = js_trim(raw);
            if item.is_empty() {
                continue;
            }
            if let Some(a) = p.re_alias.captures(item) {
                out.push(ReExport::Named { exported_name: cap(&a, 2).to_string(), original_name: cap(&a, 1).to_string(), source: source.to_string() });
            } else if p.re_word.is_match(item) {
                out.push(ReExport::Named { exported_name: item.to_string(), original_name: item.to_string(), source: source.to_string() });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Node rows + SQL (verbatim queries.ts statements)
// ---------------------------------------------------------------------------

/// One decoded `nodes` row (owned). rowToNode's source shape — the wire
/// encoder maps Option None → NULL/absent; TS decoding does `?? undefined`.
#[derive(Clone, PartialEq, Debug)]
struct CtxNode {
    id: String,
    kind: String,
    name: String,
    qualified_name: String,
    file_path: String,
    language: String,
    start_line: i64,
    end_line: i64,
    start_column: i64,
    end_column: i64,
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<String>,
    is_exported: i64,
    is_async: i64,
    is_static: i64,
    is_abstract: i64,
    decorators: Option<String>,
    type_parameters: Option<String>,
    return_type: Option<String>,
    params_json: Option<String>,
    updated_at: i64,
}

/// Explicit column list in wire-row order (search_text excluded — rowToNode
/// never maps it; the wire slot stays NONE). concat! takes literals only, so
/// the column list lives in this macro.
macro_rules! select_nodes {
    ($tail:literal) => {
        concat!(
            "SELECT id, kind, name, qualified_name, file_path, language, ",
            "start_line, end_line, start_column, end_column, docstring, signature, visibility, ",
            "is_exported, is_async, is_static, is_abstract, decorators, type_parameters, ",
            "return_type, params_json, updated_at FROM nodes ",
            $tail
        )
    };
}

/// getNodesByName — queries.ts:1135-1143. ORDER BY IS LOAD-BEARING (CG-33).
const SQL_BY_NAME: &str = select_nodes!("WHERE name = ?1 ORDER BY file_path, start_line");
/// getNodesByFile — queries.ts:940-948.
const SQL_BY_FILE: &str = select_nodes!("WHERE file_path = ?1 ORDER BY start_line");
/// getNodesByQualifiedNameExact — queries.ts:1148-1156 (NO ORDER BY).
const SQL_BY_QUALIFIED_NAME: &str = select_nodes!("WHERE qualified_name = ?1");
/// getNodesByLowerName — queries.ts:1172-1180 (SQLite ASCII lower() both sides).
const SQL_BY_LOWER_NAME: &str = select_nodes!("WHERE lower(name) = lower(?1)");
/// iterateNodesByKind — queries.ts:2126-2130 (NO ORDER BY).
const SQL_BY_KIND: &str = select_nodes!("WHERE kind = ?1");
/// getNodeById — queries.ts:790-811.
const SQL_BY_ID: &str = select_nodes!("WHERE id = ?1");
/// getAllFilePaths — queries.ts:2373-2377.
const SQL_ALL_FILE_PATHS: &str = "SELECT path FROM files ORDER BY path";
/// getAllNodeNames — queries.ts:2384-2388.
const SQL_ALL_NODE_NAMES: &str = "SELECT DISTINCT name FROM nodes";

fn row_to_ctx_node(r: &rusqlite::Row) -> rusqlite::Result<CtxNode> {
    Ok(CtxNode {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        qualified_name: r.get(3)?,
        file_path: r.get(4)?,
        language: r.get(5)?,
        start_line: r.get(6)?,
        end_line: r.get(7)?,
        start_column: r.get(8)?,
        end_column: r.get(9)?,
        docstring: r.get(10)?,
        signature: r.get(11)?,
        visibility: r.get(12)?,
        is_exported: r.get(13)?,
        is_async: r.get(14)?,
        is_static: r.get(15)?,
        is_abstract: r.get(16)?,
        decorators: r.get(17)?,
        type_parameters: r.get(18)?,
        return_type: r.get(19)?,
        params_json: r.get(20)?,
        updated_at: r.get(21)?,
    })
}

fn query_nodes(conn: &Connection, sql: &str, key: &str) -> Result<Vec<CtxNode>> {
    let mut stmt = conn.prepare_cached(sql).map_err(err)?;
    let rows = stmt.query_map(rusqlite::params![key], row_to_ctx_node).map_err(err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(err)?);
    }
    Ok(out)
}

fn query_strings(conn: &Connection, sql: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(sql).map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(err)?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// CtxConn — connection + caches
// ---------------------------------------------------------------------------

struct CtxConn {
    /// `None` after ctx_close; every entry point rejects via `conn()`.
    conn: Option<Connection>,
    project_root: String,
    /// Shared with the StoreHandle this ctx was opened from (store.rs gen).
    store_gen: Arc<AtomicU64>,
    /// Store generation the caches were built at.
    seen_gen: u64,
    /// Local invalidation epoch — bumped by ctx_invalidate (the clearCaches
    /// seam for writes that bypass the store handle).
    epoch: u64,
    /// Epoch the caches were built at.
    seen_epoch: u64,
    known_names: Option<HashSet<String>>,
    known_files: Option<HashSet<String>>,
    name_cache: Lru<String, Vec<CtxNode>>,
    lower_name_cache: Lru<String, Vec<CtxNode>>,
    qualified_name_cache: Lru<String, Vec<CtxNode>>,
    node_cache: Lru<String, Vec<CtxNode>>,
    by_id_cache: Lru<String, CtxNode>,
    file_cache: Lru<String, Option<String>>,
    lines_cache: Lru<String, Vec<String>>,
    import_mapping_cache: Lru<String, Vec<ImportMapping>>,
    re_export_cache: Lru<String, Vec<ReExport>>,
}

fn closed_err() -> Error {
    Error::from_reason("ctx handle is closed")
}

impl CtxConn {
    fn conn(&self) -> Result<&Connection> {
        self.conn.as_ref().ok_or_else(closed_err)
    }

    fn open(store: &StoreHandle, project_root: String) -> Result<Self> {
        // A closed store rejects ctx_open (StoreHandle.closed_err parity).
        let (db_path, store_gen) = store.with_conn(|c| {
            c.conn()?;
            Ok((c.db_path().to_string(), c.generation()))
        })?;
        let conn = Connection::open(&db_path).map_err(err)?;
        // store.rs configureConnection parity (correctness core). journal_mode
        // is persistent (already WAL); busy_timeout matters for reader-vs-
        // checkpoint contention.
        conn.pragma_update(None, "busy_timeout", 5000).map_err(err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(err)?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(err)?;
        let limit = resolve_cache_limit();
        // resolution/index.ts:184 — contentLimit = max(64, floor(limit / 5)).
        let content_limit = (limit / 5).max(64);
        Ok(CtxConn {
            conn: Some(conn),
            project_root,
            store_gen,
            seen_gen: 0,
            epoch: 0,
            seen_epoch: 0,
            known_names: None,
            known_files: None,
            name_cache: Lru::new(limit),
            lower_name_cache: Lru::new(limit),
            qualified_name_cache: Lru::new(limit),
            node_cache: Lru::new(limit),
            by_id_cache: Lru::new(BY_ID_CACHE_LIMIT),
            file_cache: Lru::new(content_limit),
            lines_cache: Lru::new(content_limit),
            import_mapping_cache: Lru::new(limit),
            re_export_cache: Lru::new(limit),
        })
    }

    /// Generation check at every entry point: a committed store write (gen
    /// bump) or an explicit ctx_invalidate (epoch bump) drops every cache and
    /// both indexes; the indexes rebuild lazily on first use — the warmCaches
    /// rebuild-before-every-resolveAll cost disappears when nothing changed.
    fn refresh(&mut self) -> Result<()> {
        // A closed handle rejects EVERY entry point (ctx_close contract) —
        // even the fs-backed arms a stale cache could otherwise serve.
        self.conn()?;
        let g = self.store_gen.load(Ordering::Relaxed);
        if g == self.seen_gen && self.epoch == self.seen_epoch {
            return Ok(());
        }
        self.seen_gen = g;
        self.seen_epoch = self.epoch;
        self.known_names = None;
        self.known_files = None;
        self.name_cache.clear();
        self.lower_name_cache.clear();
        self.qualified_name_cache.clear();
        self.node_cache.clear();
        self.by_id_cache.clear();
        self.file_cache.clear();
        self.lines_cache.clear();
        self.import_mapping_cache.clear();
        self.re_export_cache.clear();
        Ok(())
    }

    /// warmCaches (resolution/index.ts:240-250) — knownFiles + knownNames.
    fn warm(&mut self) -> Result<()> {
        self.refresh()?;
        if self.known_files.is_none() {
            self.known_files = Some(query_strings(self.conn()?, SQL_ALL_FILE_PATHS)?.into_iter().collect());
        }
        if self.known_names.is_none() {
            self.known_names = Some(query_strings(self.conn()?, SQL_ALL_NODE_NAMES)?.into_iter().collect());
        }
        Ok(())
    }

    /// fileExists (resolution/index.ts:306-322).
    fn file_exists(&mut self, file_path: &str) -> Result<bool> {
        self.refresh()?;
        if self.known_files.is_none() {
            self.known_files = Some(query_strings(self.conn()?, SQL_ALL_FILE_PATHS)?.into_iter().collect());
        }
        if let Some(files) = &self.known_files {
            // :309 — BOTH the raw path and the `\`→`/` normalized path.
            let normalized = file_path.replace('\\', "/");
            if files.contains(file_path) || files.contains(&normalized) {
                return Ok(true);
            }
        }
        Ok(std::fs::metadata(join_normalized(&self.project_root, file_path)).is_ok())
    }

    /// readFile (resolution/index.ts:324-339) — failures cache None.
    fn read_file(&mut self, file_path: &str) -> Result<Option<String>> {
        self.refresh()?;
        if self.file_cache.has(&file_path.to_string()) {
            let key = file_path.to_string();
            return Ok(self.file_cache.get(&key).cloned().flatten());
        }
        let full = join_normalized(&self.project_root, file_path);
        let content = match std::fs::read(&full) {
            Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            Err(_) => None,
        };
        self.file_cache.set(file_path.to_string(), content.clone());
        Ok(content)
    }

    /// getFileLines (resolution/index.ts:420-433). Null content → [] WITHOUT
    /// a linesCache entry (TS early-returns before the set).
    fn file_lines(&mut self, file_path: &str) -> Result<Vec<String>> {
        self.refresh()?;
        let key = file_path.to_string();
        if let Some(lines) = self.lines_cache.get(&key) {
            return Ok(lines.clone());
        }
        let Some(content) = self.read_file(file_path)? else { return Ok(Vec::new()) };
        let lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
        self.lines_cache.set(key, lines.clone());
        Ok(lines)
    }

    /// listDirectories (resolution/index.ts:347-363).
    fn list_directories(&mut self, relative_path: &str) -> Vec<String> {
        let target = if relative_path == "." || relative_path.is_empty() {
            self.project_root.clone()
        } else {
            join_normalized(&self.project_root, relative_path)
        };
        let Ok(entries) = std::fs::read_dir(&target) else { return Vec::new() };
        let mut out: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        // JS readdirSync order is platform-dependent (APFS/ext4 ≈ lexical);
        // sort for a deterministic wire (TS consumers membership-test).
        out.sort();
        out
    }

    /// getImportMappings (resolution/index.ts:373-387) — key is filePath ONLY
    /// (TS quirk: the language argument never enters the cache key).
    fn import_mappings(&mut self, file_path: &str, language: &str) -> Result<Vec<ImportMapping>> {
        self.refresh()?;
        let key = file_path.to_string();
        if let Some(hit) = self.import_mapping_cache.get(&key) {
            return Ok(hit.clone());
        }
        let Some(content) = self.read_file(file_path)? else {
            self.import_mapping_cache.set(key, Vec::new());
            return Ok(Vec::new());
        };
        let mappings = extract_import_mappings(&content, language);
        self.import_mapping_cache.set(key, mappings.clone());
        Ok(mappings)
    }

    /// getReExports (resolution/index.ts:403-414).
    fn re_exports(&mut self, file_path: &str, language: &str) -> Result<Vec<ReExport>> {
        self.refresh()?;
        let key = file_path.to_string();
        if let Some(hit) = self.re_export_cache.get(&key) {
            return Ok(hit.clone());
        }
        let Some(content) = self.read_file(file_path)? else {
            self.re_export_cache.set(key, Vec::new());
            return Ok(Vec::new());
        };
        let re = extract_re_exports(&content, language);
        self.re_export_cache.set(key, re.clone());
        Ok(re)
    }

    fn get_node_by_id(&mut self, id: &str) -> Result<Option<CtxNode>> {
        self.refresh()?;
        if let Some(hit) = self.by_id_cache.get(&id.to_string()) {
            return Ok(Some(hit.clone()));
        }
        // Misses are NOT cached (QueryBuilder.getNodeById only caches hits).
        // Scoped so the CachedStatement's borrow of the connection ends
        // before the cache write.
        let node = {
            let conn = self.conn()?;
            let mut stmt = conn.prepare_cached(SQL_BY_ID).map_err(err)?;
            let mut rows = stmt.query(rusqlite::params![id]).map_err(err)?.mapped(row_to_ctx_node);
            rows.next().transpose().map_err(err)?
        };
        if let Some(n) = &node {
            self.by_id_cache.set(id.to_string(), n.clone());
        }
        Ok(node)
    }

    /// The knownNames index (getAllNodeNames projection), built on demand.
    fn known_names(&mut self) -> Result<&HashSet<String>> {
        self.refresh()?;
        if self.known_names.is_none() {
            self.known_names = Some(query_strings(self.conn()?, SQL_ALL_NODE_NAMES)?.into_iter().collect());
        }
        Ok(self.known_names.as_ref().expect("just built"))
    }
}

// ---------------------------------------------------------------------------
// Wire encoders
// ---------------------------------------------------------------------------

fn push_u32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn put_str(arena: &mut Vec<u8>, s: &str) -> (u32, u32) {
    let off = arena.len() as u32;
    arena.extend_from_slice(s.as_bytes());
    (off, s.len() as u32)
}

fn put_opt_str(arena: &mut Vec<u8>, s: Option<&str>) -> (u32, u32) {
    match s {
        Some(s) => put_str(arena, s),
        None => (NONE, 0),
    }
}

fn push_str_ref(b: &mut Vec<u8>, r: (u32, u32)) {
    push_u32(b, r.0);
    push_u32(b, r.1);
}

fn encode_node(nodes: &mut Vec<u8>, arena: &mut Vec<u8>, n: &CtxNode) {
    push_str_ref(nodes, put_str(arena, &n.id));
    push_str_ref(nodes, put_str(arena, &n.kind));
    push_str_ref(nodes, put_str(arena, &n.name));
    push_str_ref(nodes, put_opt_str(arena, Some(&n.qualified_name)));
    push_str_ref(nodes, put_str(arena, &n.file_path));
    push_str_ref(nodes, put_str(arena, &n.language));
    for v in [n.start_line, n.end_line, n.start_column, n.end_column] {
        // Schema columns are NOT NULL and every write path stores u32; a
        // negative legacy value clamps to 0 rather than wrapping (documented
        // in the ctx contract notes — no writer produces negatives).
        push_u32(nodes, v.max(0) as u32);
    }
    push_str_ref(nodes, put_opt_str(arena, n.docstring.as_deref()));
    push_str_ref(nodes, put_opt_str(arena, n.signature.as_deref()));
    push_str_ref(nodes, put_opt_str(arena, n.visibility.as_deref()));
    // rowToNode: `row.is_exported === 1` — strict equality, folded to bits.
    let flags = (n.is_exported == 1) as u8
        | ((n.is_async == 1) as u8) << 1
        | ((n.is_static == 1) as u8) << 2
        | ((n.is_abstract == 1) as u8) << 3;
    nodes.push(flags);
    nodes.extend_from_slice(&[0u8; 3]);
    push_str_ref(nodes, put_opt_str(arena, n.decorators.as_deref()));
    push_str_ref(nodes, put_opt_str(arena, n.type_parameters.as_deref()));
    push_str_ref(nodes, put_opt_str(arena, n.return_type.as_deref()));
    push_str_ref(nodes, put_opt_str(arena, n.params_json.as_deref()));
    push_str_ref(nodes, (NONE, 0)); // search_text — never read by rowToNode
    nodes.extend_from_slice(&n.updated_at.to_le_bytes());
    debug_assert_eq!(nodes.len() % STORE_NODE_ROW_SIZE, 0);
}

/// CtxNodesOut wire — see the module docs.
fn encode_nodes(groups: Vec<Vec<CtxNode>>) -> Vec<u8> {
    let mut arena = Vec::new();
    let mut nodes = Vec::new();
    let mut group_rows = Vec::new();
    let mut start = 0u32;
    for g in &groups {
        for n in g {
            encode_node(&mut nodes, &mut arena, n);
        }
        push_u32(&mut group_rows, start);
        start += g.len() as u32;
        push_u32(&mut group_rows, start);
    }
    let mut out = Vec::with_capacity(CTX_NODES_HEADER_SIZE + group_rows.len() + nodes.len() + arena.len());
    out.push(CTX_ABI_VERSION);
    out.extend_from_slice(&[0u8; 3]);
    push_u32(&mut out, groups.len() as u32);
    push_u32(&mut out, (nodes.len() / STORE_NODE_ROW_SIZE) as u32);
    push_u32(&mut out, arena.len() as u32);
    push_u32(&mut out, 0);
    out.extend_from_slice(&group_rows);
    out.extend_from_slice(&nodes);
    out.extend_from_slice(&arena);
    out
}

/// CtxStringsOut wire. `rows[i] == None` encodes the absent (NULL) str row.
fn encode_strings(groups: Vec<Vec<Option<String>>>) -> Vec<u8> {
    let mut arena = Vec::new();
    let mut strs = Vec::new();
    let mut group_rows = Vec::new();
    let mut start = 0u32;
    for g in &groups {
        for s in g {
            push_str_ref(&mut strs, put_opt_str(&mut arena, s.as_deref()));
        }
        push_u32(&mut group_rows, start);
        start += g.len() as u32;
        push_u32(&mut group_rows, start);
    }
    let mut out = Vec::with_capacity(CTX_STRINGS_HEADER_SIZE + group_rows.len() + strs.len() + arena.len());
    out.push(CTX_ABI_VERSION);
    out.extend_from_slice(&[0u8; 3]);
    push_u32(&mut out, groups.len() as u32);
    push_u32(&mut out, (strs.len() / CTX_STR_ROW_SIZE) as u32);
    push_u32(&mut out, arena.len() as u32);
    out.extend_from_slice(&group_rows);
    out.extend_from_slice(&strs);
    out.extend_from_slice(&arena);
    out
}

fn encode_mappings(groups: Vec<Vec<ImportMapping>>) -> Vec<u8> {
    let mut arena = Vec::new();
    let mut rows = Vec::new();
    let mut group_rows = Vec::new();
    let mut start = 0u32;
    for g in &groups {
        for m in g {
            push_str_ref(&mut rows, put_str(&mut arena, &m.local_name));
            push_str_ref(&mut rows, put_str(&mut arena, &m.exported_name));
            push_str_ref(&mut rows, put_str(&mut arena, &m.source));
            push_str_ref(&mut rows, (NONE, 0)); // resolved_path — never set here
            let flags = m.is_default as u8 | (m.is_namespace as u8) << 1;
            rows.push(flags);
            rows.extend_from_slice(&[0u8; 3]);
        }
        push_u32(&mut group_rows, start);
        start += g.len() as u32;
        push_u32(&mut group_rows, start);
    }
    let mut out = Vec::with_capacity(CTX_MAPPINGS_HEADER_SIZE + group_rows.len() + rows.len() + arena.len());
    out.push(CTX_ABI_VERSION);
    out.extend_from_slice(&[0u8; 3]);
    push_u32(&mut out, groups.len() as u32);
    push_u32(&mut out, (rows.len() / CTX_MAPPING_ROW_SIZE) as u32);
    push_u32(&mut out, arena.len() as u32);
    push_u32(&mut out, 0);
    out.extend_from_slice(&group_rows);
    out.extend_from_slice(&rows);
    out.extend_from_slice(&arena);
    out
}

fn encode_reexports(groups: Vec<Vec<ReExport>>) -> Vec<u8> {
    let mut arena = Vec::new();
    let mut rows = Vec::new();
    let mut group_rows = Vec::new();
    let mut start = 0u32;
    for g in &groups {
        for re in g {
            match re {
                ReExport::Named { exported_name, original_name, source } => {
                    rows.push(1u8);
                    rows.extend_from_slice(&[0u8; 3]);
                    push_str_ref(&mut rows, put_str(&mut arena, exported_name));
                    push_str_ref(&mut rows, put_str(&mut arena, original_name));
                    push_str_ref(&mut rows, put_str(&mut arena, source));
                }
                ReExport::Wildcard { source } => {
                    rows.push(2u8);
                    rows.extend_from_slice(&[0u8; 3]);
                    push_str_ref(&mut rows, (NONE, 0));
                    push_str_ref(&mut rows, (NONE, 0));
                    push_str_ref(&mut rows, put_str(&mut arena, source));
                }
            }
        }
        push_u32(&mut group_rows, start);
        start += g.len() as u32;
        push_u32(&mut group_rows, start);
    }
    let mut out = Vec::with_capacity(CTX_REEXPORTS_HEADER_SIZE + group_rows.len() + rows.len() + arena.len());
    out.push(CTX_ABI_VERSION);
    out.extend_from_slice(&[0u8; 3]);
    push_u32(&mut out, groups.len() as u32);
    push_u32(&mut out, (rows.len() / CTX_REEXPORT_ROW_SIZE) as u32);
    push_u32(&mut out, arena.len() as u32);
    push_u32(&mut out, 0);
    out.extend_from_slice(&group_rows);
    out.extend_from_slice(&rows);
    out.extend_from_slice(&arena);
    out
}

// ---------------------------------------------------------------------------
// napi surface
// ---------------------------------------------------------------------------

/// Node-result batch (CtxNodesOut wire — module docs).
#[napi(object)]
pub struct CtxNodesOut {
    pub header: Buffer,
    pub groups: Buffer,
    pub nodes: Buffer,
    pub arena: Buffer,
}

/// String-list batch (CtxStringsOut wire — module docs).
#[napi(object)]
pub struct CtxStringsOut {
    pub header: Buffer,
    pub groups: Buffer,
    pub strs: Buffer,
    pub arena: Buffer,
}

/// Import-mapping batch (CtxImportMappingsOut wire — module docs).
#[napi(object)]
pub struct CtxImportMappingsOut {
    pub header: Buffer,
    pub groups: Buffer,
    pub mappings: Buffer,
    pub arena: Buffer,
}

/// Re-export batch (CtxReExportsOut wire — module docs).
#[napi(object)]
pub struct CtxReExportsOut {
    pub header: Buffer,
    pub groups: Buffer,
    pub reexports: Buffer,
    pub arena: Buffer,
}

/// Wire contract + getter capability table (R3b acceptance: the TS loader
/// verifies ctx_abi equality AND that every getter it routes through the
/// native arm is listed as present; absent getters keep the TS arm — the
/// kill-switch/silent-degrade discipline of loader.ts).
#[napi(object)]
pub struct CtxContractInfo {
    /// CTX_ABI_VERSION — independent numbering from the extraction/store ABIs.
    pub ctx_abi: u32,
    pub ctx_version: String,
    /// Node-row layout identity: rows are byte-identical to the store wire's
    /// 140-byte node row (search_text slot always NONE) — the TS decoder for
    /// STORE_NODE_ROW_SIZE decodes these unchanged.
    pub node_row_size: u32,
    /// Present getters ( ResolutionContext names, r3-contract-inventory §A):
    /// getNodesInFile, getNodesByName, getNodesByQualifiedName, getNodesByKind,
    /// fileExists, readFile, getProjectRoot, getAllFiles, getNodesByLowerName,
    /// getImportMappings, getReExports, listDirectories, getFileLines,
    /// getNodeById, getAllNodeNames, hasNames (knownNames membership batch).
    pub getters_present: Vec<String>,
    /// Absent getters — the TS bridge MUST keep its arm for these:
    /// getProjectAliases, getGoModule (config parses stay TS),
    /// getCppIncludeDirs (compile_commands/shlex/heuristic walk stays TS),
    /// resolveImport (per-ref crossing — forbidden by the FFI boundary
    /// rules; R3c precomputes per-file import tables instead).
    pub getters_absent: Vec<String>,
    /// Semantic-difference declarations the TS verifier should surface:
    /// - "lru:<limit>/<contentLimit>" — live cache capacities (env
    ///   CODEGRAPH_RESOLVER_CACHE_SIZE applied with JS parseInt semantics).
    /// - "byIdCache:1000" — QueryBuilder.getNodeById LRU mirror.
    /// - "generation:store-commits" — caches invalidate on store-handle
    ///   commits + ctx_invalidate ONLY; TS-arm writes (updateNode etc.) need
    ///   an explicit ctx_invalidate at the clearCaches seams.
    /// - "knownFiles:file-table" — fileExists membership mirrors the files
    ///   table exactly (TS warmCaches parity); unindexed files fall to the
    ///   fs.existsSync port.
    /// - "listDirectories:sorted" — JS readdir order is platform-dependent;
    ///   the native arm returns lexical order.
    /// - "readFile:lossy-utf8" — invalid bytes become U+FFFD (Node parity).
    pub semantics: Vec<String>,
}

/// One open resolution read context (one graph root). Symbiotic with its
/// StoreHandle: separate rusqlite read connection to the same WAL database +
/// the shared commit-generation counter. Lifecycle mirrors StoreHandle —
/// deterministic `ctx_close`, JS GC finalizer only as the crash fallback;
/// calls are synchronous and MUST run on a worker thread (R3 §2).
#[napi]
pub struct CtxHandle {
    inner: Mutex<CtxConn>,
    poisoned: AtomicBool,
}

impl CtxHandle {
    fn with<T>(&self, f: impl FnOnce(&mut CtxConn) -> Result<T>) -> Result<T> {
        if self.poisoned.load(Ordering::Relaxed) {
            return Err(Error::from_reason("ctx handle is poisoned by an earlier panic; reopen it"));
        }
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                self.poisoned.store(true, Ordering::Relaxed);
                return Err(Error::from_reason("ctx handle mutex poisoned"));
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
pub fn ctx_contract_info() -> CtxContractInfo {
    CtxContractInfo {
        ctx_abi: CTX_ABI_VERSION as u32,
        ctx_version: CTX_VERSION.to_string(),
        node_row_size: STORE_NODE_ROW_SIZE as u32,
        getters_present: [
            "getNodesInFile",
            "getNodesByName",
            "getNodesByQualifiedName",
            "getNodesByKind",
            "fileExists",
            "readFile",
            "getProjectRoot",
            "getAllFiles",
            "getAllNodeNames",
            "getNodesByLowerName",
            "getImportMappings",
            "getReExports",
            "listDirectories",
            "getFileLines",
            "getNodeById",
            "hasNames",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        getters_absent: ["getProjectAliases", "getGoModule", "getCppIncludeDirs", "resolveImport"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        semantics: [
            format!("lru:{}/{}", resolve_cache_limit(), (resolve_cache_limit() / 5).max(64)),
            "byIdCache:1000".to_string(),
            "generation:store-commits".to_string(),
            "knownFiles:file-table".to_string(),
            "listDirectories:sorted".to_string(),
            "readFile:lossy-utf8".to_string(),
        ]
        .to_vec(),
    }
}

/// Open the read context for `store`'s database. Borrows the store's db path
/// and commit-generation counter, then opens its OWN read connection (WAL —
/// readers never block the store writer). Fails when the store handle is
/// closed.
#[napi]
pub fn ctx_open(store: &StoreHandle, project_root: String) -> Result<CtxHandle> {
    let conn = CtxConn::open(store, project_root)?;
    Ok(CtxHandle { inner: Mutex::new(conn), poisoned: AtomicBool::new(false) })
}

/// warmCaches parity: rebuild knownFiles/knownNames NOW (before a resolveAll
/// run) instead of lazily on first membership query. No-op when the
/// generation is unchanged and the indexes are already built.
#[napi]
pub fn ctx_warm(handle: &CtxHandle) -> Result<()> {
    handle.with(|c| c.warm())
}

/// clearCaches parity for writes the generation counter cannot see (TS
/// QueryBuilder arm, runPostExtract updateNode, external processes): bumps
/// the local epoch so the next entry point drops every cache and rebuilds
/// the indexes. ALSO use this after `store` writes performed on a DIFFERENT
/// StoreHandle over the same db file.
#[napi]
pub fn ctx_invalidate(handle: &CtxHandle) -> Result<()> {
    handle.with(|c| {
        c.epoch = c.epoch.wrapping_add(1);
        Ok(())
    })
}

/// Deterministic release (R1 no-unpaired-resources): drops the read
/// connection and every cache IN PLACE. Later calls fail with "ctx handle is
/// closed"; a double close is an error the TS side treats as benign.
#[napi]
pub fn ctx_close(handle: &CtxHandle) -> Result<()> {
    handle.with(|c| {
        let conn = c.conn.take().ok_or_else(closed_err)?;
        drop(conn);
        Ok(())
    })
}

/// getProjectRoot (resolution/index.ts:341).
#[napi]
pub fn ctx_get_project_root(handle: &CtxHandle) -> Result<String> {
    handle.with(|c| Ok(c.project_root.clone()))
}

/// Which cached node getter a batch runs (one LRU + one SQL statement each).
#[derive(Clone, Copy)]
enum NodeQuery {
    ByName,
    ByQualifiedName,
    ByLowerName,
    InFile,
}

impl NodeQuery {
    fn sql(&self) -> &'static str {
        match self {
            NodeQuery::ByName => SQL_BY_NAME,
            NodeQuery::ByQualifiedName => SQL_BY_QUALIFIED_NAME,
            NodeQuery::ByLowerName => SQL_BY_LOWER_NAME,
            NodeQuery::InFile => SQL_BY_FILE,
        }
    }
}

/// Shared batch core — ONE encoded group per key, REQUEST ORDER, each group
/// in its SQL's row order (getNodesByName: ORDER BY file_path, start_line —
/// CG-33 load-bearing).
fn nodes_batch_core(c: &mut CtxConn, keys: &[String], q: NodeQuery) -> Result<Vec<u8>> {
    c.refresh()?;
    let mut groups = Vec::with_capacity(keys.len());
    for key in keys {
        let hit = match q {
            NodeQuery::ByName => c.name_cache.get(key).cloned(),
            NodeQuery::ByQualifiedName => c.qualified_name_cache.get(key).cloned(),
            NodeQuery::ByLowerName => c.lower_name_cache.get(key).cloned(),
            NodeQuery::InFile => c.node_cache.get(key).cloned(),
        };
        if let Some(rows) = hit {
            groups.push(rows);
            continue;
        }
        let rows = query_nodes(c.conn()?, q.sql(), key)?;
        match q {
            NodeQuery::ByName => c.name_cache.set(key.clone(), rows.clone()),
            NodeQuery::ByQualifiedName => c.qualified_name_cache.set(key.clone(), rows.clone()),
            NodeQuery::ByLowerName => c.lower_name_cache.set(key.clone(), rows.clone()),
            NodeQuery::InFile => c.node_cache.set(key.clone(), rows.clone()),
        }
        groups.push(rows);
    }
    Ok(encode_nodes(groups))
}

fn nodes_by_kind_core(c: &mut CtxConn, kind: &str) -> Result<Vec<u8>> {
    c.refresh()?;
    let rows = query_nodes(c.conn()?, SQL_BY_KIND, kind)?;
    Ok(encode_nodes(vec![rows]))
}

fn node_by_id_core(c: &mut CtxConn, id: &str) -> Result<Vec<u8>> {
    let node = c.get_node_by_id(id)?;
    Ok(encode_nodes(vec![node.into_iter().collect()]))
}

fn has_names_core(c: &mut CtxConn, names: &[String]) -> Result<Vec<bool>> {
    let known = c.known_names()?;
    Ok(names.iter().map(|n| known.contains(n.as_str())).collect())
}

fn all_files_core(c: &mut CtxConn) -> Result<Vec<u8>> {
    c.refresh()?;
    let rows = query_strings(c.conn()?, SQL_ALL_FILE_PATHS)?;
    Ok(encode_strings(vec![rows.into_iter().map(Some).collect()]))
}

fn all_node_names_core(c: &mut CtxConn) -> Result<Vec<u8>> {
    c.refresh()?;
    let rows = query_strings(c.conn()?, SQL_ALL_NODE_NAMES)?;
    Ok(encode_strings(vec![rows.into_iter().map(Some).collect()]))
}

fn read_files_core(c: &mut CtxConn, paths: &[String]) -> Result<Vec<u8>> {
    c.refresh()?;
    let mut groups = Vec::with_capacity(paths.len());
    for p in paths {
        groups.push(vec![c.read_file(p)?]);
    }
    Ok(encode_strings(groups))
}

fn file_lines_core(c: &mut CtxConn, paths: &[String]) -> Result<Vec<u8>> {
    c.refresh()?;
    let mut groups = Vec::with_capacity(paths.len());
    for p in paths {
        groups.push(c.file_lines(p)?.into_iter().map(Some).collect());
    }
    Ok(encode_strings(groups))
}

fn file_exists_core(c: &mut CtxConn, paths: &[String]) -> Result<Vec<bool>> {
    c.refresh()?;
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(c.file_exists(p)?);
    }
    Ok(out)
}

fn list_directories_core(c: &mut CtxConn, rels: &[String]) -> Result<Vec<u8>> {
    c.refresh()?;
    let groups: Vec<Vec<Option<String>>> = rels.iter().map(|p| c.list_directories(p).into_iter().map(Some).collect()).collect();
    Ok(encode_strings(groups))
}

fn pair_lang(languages: &[String], i: usize) -> &str {
    languages.get(i).or_else(|| languages.last()).map(|s| s.as_str()).unwrap_or("unknown")
}

fn import_mappings_core(c: &mut CtxConn, paths: &[String], languages: &[String]) -> Result<Vec<u8>> {
    if languages.is_empty() {
        return Err(ctx_err("import mappings: languages must not be empty".into()));
    }
    c.refresh()?;
    let mut groups = Vec::with_capacity(paths.len());
    for (i, p) in paths.iter().enumerate() {
        groups.push(c.import_mappings(p, pair_lang(languages, i))?);
    }
    Ok(encode_mappings(groups))
}

fn re_exports_core(c: &mut CtxConn, paths: &[String], languages: &[String]) -> Result<Vec<u8>> {
    if languages.is_empty() {
        return Err(ctx_err("re-exports: languages must not be empty".into()));
    }
    c.refresh()?;
    let mut groups = Vec::with_capacity(paths.len());
    for (i, p) in paths.iter().enumerate() {
        groups.push(c.re_exports(p, pair_lang(languages, i))?);
    }
    Ok(encode_reexports(groups))
}

// napi wrappers — THIN: every wrapper is handle.with(core) + wire split, so
// cargo tests exercise the identical cores without touching napi Buffer
// types (store.rs test-harness discipline: Buffer Drop paths reference
// libnode symbols a test executable cannot resolve).

/// Batch getNodesByName — ONE group per requested name, REQUEST ORDER, each
/// group `ORDER BY file_path, start_line` (CG-33 load-bearing). Backed by the
/// nameCache LRU.
#[napi]
pub fn ctx_get_nodes_by_names(handle: &CtxHandle, names: Vec<String>) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(nodes_batch_core(c, &names, NodeQuery::ByName)?))
}

/// Batch getNodesByQualifiedName (qualifiedNameCache LRU; NO ORDER BY —
/// queries.ts parity).
#[napi]
pub fn ctx_get_nodes_by_qualified_names(handle: &CtxHandle, qualified_names: Vec<String>) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(nodes_batch_core(c, &qualified_names, NodeQuery::ByQualifiedName)?))
}

/// Batch getNodesByLowerName (lowerNameCache LRU; SQLite ASCII lower() on
/// both sides — queries.ts:1172-1180).
#[napi]
pub fn ctx_get_nodes_by_lower_names(handle: &CtxHandle, names: Vec<String>) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(nodes_batch_core(c, &names, NodeQuery::ByLowerName)?))
}

/// Batch getNodesInFile (nodeCache LRU; `ORDER BY start_line`).
#[napi]
pub fn ctx_get_nodes_in_files(handle: &CtxHandle, file_paths: Vec<String>) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(nodes_batch_core(c, &file_paths, NodeQuery::InFile)?))
}

/// Single getNodesByKind — deliberately UNCACHED (TS parity :302-304: a full
/// kind scan can be huge; a cache entry would pin it). Single group.
#[napi]
pub fn ctx_get_nodes_by_kind(handle: &CtxHandle, kind: String) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(nodes_by_kind_core(c, &kind)?))
}

/// Single getNodeById — QueryBuilder nodeCache parity (LRU 1000, misses not
/// cached). One group of 0..1 nodes: an EMPTY group is the `undefined` miss.
#[napi]
pub fn ctx_get_node_by_id(handle: &CtxHandle, id: String) -> Result<CtxNodesOut> {
    handle.with(|c| split_nodes(node_by_id_core(c, &id)?))
}

/// Batch knownNames membership — the hasAnyPossibleMatch / isBuiltInOrExternal
/// pre-filter stays TS (R3c moves it in); this replaces the JS full-DB string
/// Set. Builds the index on demand, generation-invalidated. One bool per
/// input name, INPUT ORDER.
#[napi]
pub fn ctx_has_names(handle: &CtxHandle, names: Vec<String>) -> Result<Vec<bool>> {
    handle.with(|c| has_names_core(c, &names))
}

/// getAllFilePaths (single group, `ORDER BY path`).
#[napi]
pub fn ctx_get_all_files(handle: &CtxHandle) -> Result<CtxStringsOut> {
    handle.with(|c| split_strings(all_files_core(c)?))
}

/// getAllNodeNames (`SELECT DISTINCT name FROM nodes`, single group).
#[napi]
pub fn ctx_get_all_node_names(handle: &CtxHandle) -> Result<CtxStringsOut> {
    handle.with(|c| split_strings(all_node_names_core(c)?))
}

/// Batch readFile — Rust reads the fs directly (project_root + Node
/// path.join/normalize port). One group per path; a group holding ONE ABSENT
/// str row is the `null` outcome (failures are fileCache-cached like TS).
#[napi]
pub fn ctx_read_files(handle: &CtxHandle, file_paths: Vec<String>) -> Result<CtxStringsOut> {
    handle.with(|c| split_strings(read_files_core(c, &file_paths)?))
}

/// Batch getFileLines — one group per path, `content.split('\n')` parity.
/// An EMPTY group is the unreadable-file `[]` (not lines-cached, TS parity).
#[napi]
pub fn ctx_get_file_lines(handle: &CtxHandle, file_paths: Vec<String>) -> Result<CtxStringsOut> {
    handle.with(|c| split_strings(file_lines_core(c, &file_paths)?))
}

/// Batch fileExists — knownFiles membership (raw + `\`→`/` normalized) then
/// the fs.existsSync port. One bool per path, INPUT ORDER.
#[napi]
pub fn ctx_file_exists(handle: &CtxHandle, file_paths: Vec<String>) -> Result<Vec<bool>> {
    handle.with(|c| file_exists_core(c, &file_paths))
}

/// Batch listDirectories — one group per relative path ('.'/'' = project
/// root). Errors → EMPTY group (TS [] parity). Order: lexical (declared in
/// the contract semantics; JS readdir order is platform-dependent).
#[napi]
pub fn ctx_list_directories(handle: &CtxHandle, relative_paths: Vec<String>) -> Result<CtxStringsOut> {
    handle.with(|c| split_strings(list_directories_core(c, &relative_paths)?))
}

/// Batch getImportMappings — one group per (path, language) PAIR (paths[i]
/// with languages[i]; languages shorter than paths reuses its LAST element).
/// Cache key is the PATH ONLY (TS quirk). The extraction itself is the
/// import-resolver.ts regex-walker port.
#[napi]
pub fn ctx_get_import_mappings(handle: &CtxHandle, paths: Vec<String>, languages: Vec<String>) -> Result<CtxImportMappingsOut> {
    handle.with(|c| split_mappings(import_mappings_core(c, &paths, &languages)?))
}

/// Batch getReExports — same pair semantics as ctx_get_import_mappings.
#[napi]
pub fn ctx_get_re_exports(handle: &CtxHandle, paths: Vec<String>, languages: Vec<String>) -> Result<CtxReExportsOut> {
    handle.with(|c| split_reexports(re_exports_core(c, &paths, &languages)?))
}

// ---------------------------------------------------------------------------
// Wire splitting into the napi buffer objects
// ---------------------------------------------------------------------------

fn split_nodes(wire: Vec<u8>) -> Result<CtxNodesOut> {
    if wire.len() < CTX_NODES_HEADER_SIZE {
        return Err(ctx_err("nodes wire shorter than header".into()));
    }
    let group_count = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]) as usize;
    let node_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]) as usize;
    let arena_len = u32::from_le_bytes([wire[12], wire[13], wire[14], wire[15]]) as usize;
    let groups_end = CTX_NODES_HEADER_SIZE + group_count * CTX_GROUP_ROW_SIZE;
    let nodes_end = groups_end + node_count * STORE_NODE_ROW_SIZE;
    if wire.len() < nodes_end + arena_len {
        return Err(ctx_err("nodes wire truncated".into()));
    }
    Ok(CtxNodesOut {
        header: wire[..CTX_NODES_HEADER_SIZE].to_vec().into(),
        groups: wire[CTX_NODES_HEADER_SIZE..groups_end].to_vec().into(),
        nodes: wire[groups_end..nodes_end].to_vec().into(),
        arena: wire[nodes_end..nodes_end + arena_len].to_vec().into(),
    })
}

fn split_strings(wire: Vec<u8>) -> Result<CtxStringsOut> {
    if wire.len() < CTX_STRINGS_HEADER_SIZE {
        return Err(ctx_err("strings wire shorter than header".into()));
    }
    let group_count = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]) as usize;
    let str_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]) as usize;
    let arena_len = u32::from_le_bytes([wire[12], wire[13], wire[14], wire[15]]) as usize;
    let groups_end = CTX_STRINGS_HEADER_SIZE + group_count * CTX_GROUP_ROW_SIZE;
    let strs_end = groups_end + str_count * CTX_STR_ROW_SIZE;
    if wire.len() < strs_end + arena_len {
        return Err(ctx_err("strings wire truncated".into()));
    }
    Ok(CtxStringsOut {
        header: wire[..CTX_STRINGS_HEADER_SIZE].to_vec().into(),
        groups: wire[CTX_STRINGS_HEADER_SIZE..groups_end].to_vec().into(),
        strs: wire[groups_end..strs_end].to_vec().into(),
        arena: wire[strs_end..strs_end + arena_len].to_vec().into(),
    })
}

fn split_mappings(wire: Vec<u8>) -> Result<CtxImportMappingsOut> {
    if wire.len() < CTX_MAPPINGS_HEADER_SIZE {
        return Err(ctx_err("mappings wire shorter than header".into()));
    }
    let group_count = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]) as usize;
    let mapping_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]) as usize;
    let arena_len = u32::from_le_bytes([wire[12], wire[13], wire[14], wire[15]]) as usize;
    let groups_end = CTX_MAPPINGS_HEADER_SIZE + group_count * CTX_GROUP_ROW_SIZE;
    let rows_end = groups_end + mapping_count * CTX_MAPPING_ROW_SIZE;
    if wire.len() < rows_end + arena_len {
        return Err(ctx_err("mappings wire truncated".into()));
    }
    Ok(CtxImportMappingsOut {
        header: wire[..CTX_MAPPINGS_HEADER_SIZE].to_vec().into(),
        groups: wire[CTX_MAPPINGS_HEADER_SIZE..groups_end].to_vec().into(),
        mappings: wire[groups_end..rows_end].to_vec().into(),
        arena: wire[rows_end..rows_end + arena_len].to_vec().into(),
    })
}

fn split_reexports(wire: Vec<u8>) -> Result<CtxReExportsOut> {
    if wire.len() < CTX_REEXPORTS_HEADER_SIZE {
        return Err(ctx_err("reexports wire shorter than header".into()));
    }
    let group_count = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]) as usize;
    let reexport_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]) as usize;
    let arena_len = u32::from_le_bytes([wire[12], wire[13], wire[14], wire[15]]) as usize;
    let groups_end = CTX_REEXPORTS_HEADER_SIZE + group_count * CTX_GROUP_ROW_SIZE;
    let rows_end = groups_end + reexport_count * CTX_REEXPORT_ROW_SIZE;
    if wire.len() < rows_end + arena_len {
        return Err(ctx_err("reexports wire truncated".into()));
    }
    Ok(CtxReExportsOut {
        header: wire[..CTX_REEXPORTS_HEADER_SIZE].to_vec().into(),
        groups: wire[CTX_REEXPORTS_HEADER_SIZE..groups_end].to_vec().into(),
        reexports: wire[groups_end..rows_end].to_vec().into(),
        arena: wire[rows_end..rows_end + arena_len].to_vec().into(),
    })
}

// ---------------------------------------------------------------------------
// Tests — temp-dir SQLite (real schema.sql) + temp project root for the fs
// arms. Every entry point goes through the SAME napi-free core fns the JS
// wrappers delegate to; napi Buffer types are never constructed (store.rs
// test-harness discipline).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{self, wire_build::Builder};
    use std::cell::RefCell;

    const SCHEMA_SQL: &str = include_str!("../../packages/chimera/src/graph/db/schema.sql");

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempEnv {
        path: String,
        dir: std::path::PathBuf,
    }

    impl TempEnv {
        fn new() -> TempEnv {
            let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("cgk-ctx-{}-{}", std::process::id(), n));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("graph.db").to_string_lossy().to_string();
            let conn = Connection::open(&path).expect("open temp db");
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(SCHEMA_SQL).expect("apply schema.sql");
            drop(conn);
            TempEnv { path, dir }
        }

        fn conn(&self) -> Connection {
            let conn = Connection::open(&self.path).unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            conn
        }

        fn write_file(&self, rel: &str, content: &str) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
    }

    impl Drop for TempEnv {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Test-side stand-in for CtxHandle: RefCell instead of Mutex, plus the
    /// live StoreHandle used to drive REAL commits (generation bumps).
    struct TCtx {
        sh: store::StoreHandle,
        c: RefCell<CtxConn>,
    }

    impl TCtx {
        fn open(env: &TempEnv) -> TCtx {
            let sh = store::store_open(env.path.clone()).expect("store_open");
            let c = CtxConn::open(&sh, env.dir.to_string_lossy().to_string()).expect("ctx_open");
            TCtx { sh, c: RefCell::new(c) }
        }

        /// A real store commit — bumps the shared generation counter.
        fn commit(&self, o: store::wire_build::RawOwned) {
            self.sh.with_conn(|sc| store::commit_batch_core(sc, o.borrows()).map(|_| ())).unwrap();
        }

        fn gen(&self) -> u64 {
            self.sh.with_conn(|sc| Ok(sc.generation().load(Ordering::Relaxed))).unwrap()
        }

        fn c(&self) -> std::cell::RefMut<'_, CtxConn> {
            self.c.borrow_mut()
        }
    }

    /// Minimal node seed via an EXTERNAL connection (no generation bump —
    /// callers pair it with an epoch bump or seed before opening the ctx).
    fn seed_node(c: &Connection, id: &str, kind: &str, name: &str, qn: &str, file: &str, start: i64) {
        c.execute(
            "INSERT OR REPLACE INTO nodes (id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, start_column, end_column, is_exported, is_async, is_static, \
             is_abstract, search_text, updated_at) \
             VALUES (?1,?2,?3,?4,?5,'typescript',?6,?6,0,0,0,0,0,0,'',7)",
            rusqlite::params![id, kind, name, qn, file, start],
        )
        .unwrap();
    }

    /// Full-column node seed for the rowToNode-parity golden.
    fn seed_node_full(c: &Connection) {
        c.execute(
            "INSERT OR REPLACE INTO nodes (id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, start_column, end_column, docstring, signature, visibility, \
             is_exported, is_async, is_static, is_abstract, decorators, type_parameters, \
             return_type, params_json, search_text, updated_at) \
             VALUES ('function:full','method','full','mod.Full','a.ts','typescript',3,9,1,2,'doc', \
             'sig()','public',1,0,1,0,'[\"deco\"]','[\"T\"]','void','[{\"n\":\"p\",\"t\":\"string\"}]','full',42)",
            [],
        )
        .unwrap();
    }

    // -- wire decoders (test-side mirrors of the module-doc layouts) --------

    fn rd_u32(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    fn groups_of(wire: &[u8], header: usize) -> Vec<(usize, usize)> {
        assert_eq!(wire[0], CTX_ABI_VERSION, "wire abi byte");
        let gc = rd_u32(wire, 4) as usize;
        (0..gc)
            .map(|i| {
                (
                    rd_u32(wire, header + i * CTX_GROUP_ROW_SIZE) as usize,
                    rd_u32(wire, header + i * CTX_GROUP_ROW_SIZE + 4) as usize,
                )
            })
            .collect()
    }

    fn arena_str(arena: &[u8], row: &[u8], at: usize) -> Option<String> {
        let off = rd_u32(row, at);
        if off == NONE {
            return None;
        }
        let len = rd_u32(row, at + 4) as usize;
        Some(String::from_utf8(arena[off as usize..off as usize + len].to_vec()).unwrap())
    }

    #[derive(Debug)]
    struct DNode {
        id: String,
        kind: String,
        name: String,
        qn: Option<String>,
        file: String,
        lang: String,
        start: u32,
        end: u32,
        sc: u32,
        ec: u32,
        docstring: Option<String>,
        signature: Option<String>,
        visibility: Option<String>,
        flags: u8,
        decorators: Option<String>,
        type_parameters: Option<String>,
        return_type: Option<String>,
        params_json: Option<String>,
        search_text: Option<String>,
        updated_at: i64,
    }

    fn decode_nodes(wire: &[u8]) -> Vec<DNode> {
        let gc = rd_u32(wire, 4) as usize;
        let nc = rd_u32(wire, 8) as usize;
        let al = rd_u32(wire, 12) as usize;
        let nstart = CTX_NODES_HEADER_SIZE + gc * CTX_GROUP_ROW_SIZE;
        let astart = nstart + nc * STORE_NODE_ROW_SIZE;
        assert!(wire.len() >= astart + al, "nodes wire truncated");
        let arena = &wire[astart..astart + al];
        (0..nc)
            .map(|i| {
                let r = &wire[nstart + i * STORE_NODE_ROW_SIZE..nstart + (i + 1) * STORE_NODE_ROW_SIZE];
                DNode {
                    id: arena_str(arena, r, 0).unwrap(),
                    kind: arena_str(arena, r, 8).unwrap(),
                    name: arena_str(arena, r, 16).unwrap(),
                    qn: arena_str(arena, r, 24),
                    file: arena_str(arena, r, 32).unwrap(),
                    lang: arena_str(arena, r, 40).unwrap(),
                    start: rd_u32(r, 48),
                    end: rd_u32(r, 52),
                    sc: rd_u32(r, 56),
                    ec: rd_u32(r, 60),
                    docstring: arena_str(arena, r, 64),
                    signature: arena_str(arena, r, 72),
                    visibility: arena_str(arena, r, 80),
                    flags: r[88],
                    decorators: arena_str(arena, r, 92),
                    type_parameters: arena_str(arena, r, 100),
                    return_type: arena_str(arena, r, 108),
                    params_json: arena_str(arena, r, 116),
                    search_text: arena_str(arena, r, 124),
                    updated_at: i64::from_le_bytes(r[132..140].try_into().unwrap()),
                }
            })
            .collect()
    }

    fn decode_str_groups(wire: &[u8]) -> Vec<Vec<Option<String>>> {
        let gc = rd_u32(wire, 4) as usize;
        let sc = rd_u32(wire, 8) as usize;
        let al = rd_u32(wire, 12) as usize;
        let sstart = CTX_STRINGS_HEADER_SIZE + gc * CTX_GROUP_ROW_SIZE;
        let astart = sstart + sc * CTX_STR_ROW_SIZE;
        let arena = &wire[astart..astart + al];
        (0..gc)
            .map(|g| {
                let s0 = rd_u32(wire, CTX_STRINGS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE) as usize;
                let s1 = rd_u32(wire, CTX_STRINGS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE + 4) as usize;
                (s0..s1)
                    .map(|i| {
                        let row = &wire[sstart + i * CTX_STR_ROW_SIZE..sstart + (i + 1) * CTX_STR_ROW_SIZE];
                        arena_str(arena, row, 0)
                    })
                    .collect()
            })
            .collect()
    }

    #[derive(Debug, PartialEq)]
    struct DMapping {
        local: String,
        exported: String,
        source: String,
        resolved: Option<String>,
        is_default: bool,
        is_namespace: bool,
    }

    fn decode_mapping_groups(wire: &[u8]) -> Vec<Vec<DMapping>> {
        let gc = rd_u32(wire, 4) as usize;
        let mc = rd_u32(wire, 8) as usize;
        let al = rd_u32(wire, 12) as usize;
        let mstart = CTX_MAPPINGS_HEADER_SIZE + gc * CTX_GROUP_ROW_SIZE;
        let astart = mstart + mc * CTX_MAPPING_ROW_SIZE;
        let arena = &wire[astart..astart + al];
        (0..gc)
            .map(|g| {
                let m0 = rd_u32(wire, CTX_MAPPINGS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE) as usize;
                let m1 = rd_u32(wire, CTX_MAPPINGS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE + 4) as usize;
                (m0..m1)
                    .map(|i| {
                        let r = &wire[mstart + i * CTX_MAPPING_ROW_SIZE..mstart + (i + 1) * CTX_MAPPING_ROW_SIZE];
                        DMapping {
                            local: arena_str(arena, r, 0).unwrap(),
                            exported: arena_str(arena, r, 8).unwrap(),
                            source: arena_str(arena, r, 16).unwrap(),
                            resolved: arena_str(arena, r, 24),
                            is_default: r[32] & 1 != 0,
                            is_namespace: r[32] & 2 != 0,
                        }
                    })
                    .collect()
            })
            .collect()
    }

    #[derive(Debug, PartialEq)]
    enum DReExport {
        Named { exported: String, original: String, source: String },
        Wildcard { source: String },
    }

    fn decode_reexport_groups(wire: &[u8]) -> Vec<Vec<DReExport>> {
        let gc = rd_u32(wire, 4) as usize;
        let rc = rd_u32(wire, 8) as usize;
        let al = rd_u32(wire, 12) as usize;
        let rstart = CTX_REEXPORTS_HEADER_SIZE + gc * CTX_GROUP_ROW_SIZE;
        let astart = rstart + rc * CTX_REEXPORT_ROW_SIZE;
        let arena = &wire[astart..astart + al];
        (0..gc)
            .map(|g| {
                let r0 = rd_u32(wire, CTX_REEXPORTS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE) as usize;
                let r1 = rd_u32(wire, CTX_REEXPORTS_HEADER_SIZE + g * CTX_GROUP_ROW_SIZE + 4) as usize;
                (r0..r1)
                    .map(|i| {
                        let row = &wire[rstart + i * CTX_REEXPORT_ROW_SIZE..rstart + (i + 1) * CTX_REEXPORT_ROW_SIZE];
                        match row[0] {
                            1 => DReExport::Named {
                                exported: arena_str(arena, row, 4).unwrap(),
                                original: arena_str(arena, row, 12).unwrap(),
                                source: arena_str(arena, row, 20).unwrap(),
                            },
                            2 => DReExport::Wildcard { source: arena_str(arena, row, 20).unwrap() },
                            k => panic!("unknown reexport kind {k}"),
                        }
                    })
                    .collect()
            })
            .collect()
    }

    // -- unit: LRU ------------------------------------------------------------

    #[test]
    fn lru_matches_ts_lru_cache_semantics() {
        let mut l: Lru<&str, i32> = Lru::new(2);
        l.set("a", 1);
        l.set("b", 2);
        // get refreshes recency → "b" becomes the LRU victim.
        assert_eq!(l.get(&"a"), Some(&1));
        l.set("c", 3);
        assert!(!l.has(&"b"), "oldest (b) evicted, not the refreshed a");
        assert!(l.has(&"a") && l.has(&"c"));
        // set on an EXISTING key refreshes + replaces and never evicts.
        l.set("a", 9);
        assert_eq!(l.len(), 2);
        l.set("d", 4); // evicts c (a was refreshed by the set above)
        assert!(!l.has(&"c"));
        assert_eq!(l.oldest(), Some(&"a"));
        assert_eq!(l.get(&"a"), Some(&9));
        // has() does NOT refresh.
        let mut l2: Lru<&str, i32> = Lru::new(2);
        l2.set("x", 1);
        l2.set("y", 2);
        assert!(l2.has(&"x"));
        l2.set("z", 3);
        assert!(!l2.has(&"x"), "has() must not refresh recency");
    }

    // -- unit: env parseInt parity ---------------------------------------------

    #[test]
    fn js_parse_int_parity() {
        assert_eq!(js_parse_int("123"), Some(123));
        assert_eq!(js_parse_int("  42"), Some(42));
        assert_eq!(js_parse_int("+7"), Some(7));
        assert_eq!(js_parse_int("-5"), Some(-5));
        assert_eq!(js_parse_int("100abc"), Some(100));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_parse_int("0x10"), Some(0), "radix 10: stops at x");
        assert_eq!(js_parse_int("99999999999999999999999"), Some(i64::MAX), "overflow saturates");
    }

    // -- unit: Node path.join/normalize port ------------------------------------

    #[test]
    fn normalize_path_parity() {
        assert_eq!(join_normalized("/root", "src/a.ts"), "/root/src/a.ts");
        assert_eq!(join_normalized("/root/", "src/a.ts"), "/root/src/a.ts");
        assert_eq!(join_normalized("/root", "./src/../a.ts"), "/root/a.ts");
        assert_eq!(join_normalized("/root", "src//a.ts"), "/root/src/a.ts");
        assert_eq!(join_normalized("/root", "../up.ts"), "/up.ts");
        // win32 form: drive preserved, backslashes normalized to '/'
        assert_eq!(join_normalized("C:\\proj", "src\\a.ts"), "C:/proj/src/a.ts");
        assert_eq!(join_normalized("C:/proj", "../x"), "C:/x");
        // relative root keeps leading .. segments (Node normalize semantics)
        assert_eq!(normalize_path("a/../../b"), "../b");
        assert_eq!(normalize_path("./a/./b/"), "a/b/");
        assert_eq!(normalize_path(""), ".");
        assert_eq!(normalize_path("/"), "/");
    }

    // -- contract info ---------------------------------------------------------

    #[test]
    fn contract_info_reports_abi_and_capability_table() {
        let info = ctx_contract_info();
        assert_eq!(info.ctx_abi, 1);
        assert_eq!(info.ctx_version, CTX_VERSION);
        assert_eq!(info.node_row_size, STORE_NODE_ROW_SIZE as u32);
        for g in [
            "getNodesInFile", "getNodesByName", "getNodesByQualifiedName", "getNodesByKind",
            "fileExists", "readFile", "getProjectRoot", "getAllFiles", "getAllNodeNames",
            "getNodesByLowerName", "getImportMappings", "getReExports", "listDirectories",
            "getFileLines", "getNodeById", "hasNames",
        ] {
            assert!(info.getters_present.iter().any(|x| x == g), "missing present getter {g}");
        }
        assert_eq!(info.getters_absent, vec!["getProjectAliases", "getGoModule", "getCppIncludeDirs", "resolveImport"]);
        // env unset in the test process → default capacities 5000/1000.
        assert!(info.semantics.iter().any(|s| s == "lru:5000/1000"), "{:?}", info.semantics);
        assert!(info.semantics.iter().any(|s| s == "generation:store-commits"));
        assert!(info.semantics.iter().any(|s| s == "readFile:lossy-utf8"));
    }

    #[test]
    fn wire_row_and_header_sizes() {
        assert_eq!(CTX_NODES_HEADER_SIZE, 20);
        assert_eq!(CTX_STRINGS_HEADER_SIZE, 16);
        assert_eq!(CTX_MAPPINGS_HEADER_SIZE, 20);
        assert_eq!(CTX_REEXPORTS_HEADER_SIZE, 20);
        assert_eq!(CTX_GROUP_ROW_SIZE, 8);
        assert_eq!(CTX_STR_ROW_SIZE, 8);
        assert_eq!(CTX_MAPPING_ROW_SIZE, 36);
        assert_eq!(CTX_REEXPORT_ROW_SIZE, 28);
        // Empty batches still carry a well-formed header.
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        let wire = nodes_batch_core(&mut t.c(), &[], NodeQuery::ByName).unwrap();
        assert_eq!(wire.len(), CTX_NODES_HEADER_SIZE);
        assert!(groups_of(&wire, CTX_NODES_HEADER_SIZE).is_empty());
        let wire = all_files_core(&mut t.c()).unwrap();
        assert_eq!(wire.len(), CTX_STRINGS_HEADER_SIZE + CTX_GROUP_ROW_SIZE);
        assert_eq!(groups_of(&wire, CTX_STRINGS_HEADER_SIZE), vec![(0, 0)]);
    }

    // -- getNodesByName ordering (THE load-bearing sort, CG-33) ------------------

    #[test]
    fn by_name_order_is_file_path_then_start_line() {
        let env = TempEnv::new();
        let conn = env.conn();
        // Deliberate insert order ≠ sort order: rowid order must NOT win.
        seed_node(&conn, "function:c9", "function", "dup", "c.dup", "c.ts", 9);
        seed_node(&conn, "function:a5", "function", "dup", "a.dup5", "a.ts", 5);
        seed_node(&conn, "function:a1", "function", "dup", "a.dup1", "a.ts", 1);
        seed_node(&conn, "function:b3", "function", "dup", "b.dup", "b.ts", 3);
        seed_node(&conn, "function:x1", "function", "only", "x.only", "a.ts", 1);
        drop(conn);

        let t = TCtx::open(&env);
        let keys = ["dup", "only", "missing"].iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let wire = nodes_batch_core(&mut t.c(), &keys, NodeQuery::ByName).unwrap();
        assert_eq!(groups_of(&wire, CTX_NODES_HEADER_SIZE), vec![(0, 4), (4, 5), (5, 5)]);
        let decoded = decode_nodes(&wire);
        let ids: Vec<&str> = decoded.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["function:a1", "function:a5", "function:b3", "function:c9", "function:x1"]);
        // Second call is served from the nameCache with IDENTICAL bytes.
        let wire2 = nodes_batch_core(&mut t.c(), &keys, NodeQuery::ByName).unwrap();
        assert_eq!(wire, wire2);
        assert_eq!(t.c().name_cache.len(), 3);
    }

    // -- the other cached node getters ------------------------------------------

    #[test]
    fn by_file_qn_lower_kind_getters_parity() {
        let env = TempEnv::new();
        let conn = env.conn();
        seed_node(&conn, "function:l7", "function", "seven", "m.seven", "a.ts", 7);
        seed_node(&conn, "function:l3", "function", "three", "m.three", "a.ts", 3);
        seed_node(&conn, "function:l5", "function", "five", "m.five", "a.ts", 5);
        seed_node(&conn, "class:c1", "class", "MixedCase", "m.MixedCase", "b.ts", 1);
        drop(conn);

        let t = TCtx::open(&env);
        // getNodesInFile: ORDER BY start_line.
        let wire = nodes_batch_core(&mut t.c(), &["a.ts".to_string()], NodeQuery::InFile).unwrap();
        let decoded = decode_nodes(&wire);
        let ids: Vec<&str> = decoded.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["function:l3", "function:l5", "function:l7"]);

        // getNodesByQualifiedName: exact match, no ORDER BY.
        let wire = nodes_batch_core(&mut t.c(), &["m.five".to_string(), "m.none".to_string()], NodeQuery::ByQualifiedName).unwrap();
        assert_eq!(groups_of(&wire, CTX_NODES_HEADER_SIZE), vec![(0, 1), (1, 1)]);
        assert_eq!(decode_nodes(&wire)[0].id, "function:l5");

        // getNodesByLowerName: SQLite lower() folds ASCII on BOTH sides, so a
        // mixed-case query works (queries.ts hardening).
        let wire = nodes_batch_core(&mut t.c(), &["mixedcase".to_string(), "MIXEDCASE".to_string()], NodeQuery::ByLowerName).unwrap();
        let nodes = decode_nodes(&wire);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().all(|n| n.id == "class:c1"));

        // getNodesByKind: full scan, uncached (TS parity :302-304).
        let wire = nodes_by_kind_core(&mut t.c(), "function").unwrap();
        let mut ids: Vec<String> = decode_nodes(&wire).iter().map(|n| n.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, ["function:l3", "function:l5", "function:l7"]);
        assert_eq!(t.c().name_cache.len(), 0, "kind scans must not touch the name LRU");

        // Cache capacities mirror the TS constructor (limit 5000 / content
        // limit max(64, 5000/5) = 1000 / QueryBuilder by-id cache 1000).
        assert_eq!(t.c().name_cache.max, DEFAULT_CACHE_LIMIT);
        assert_eq!(t.c().node_cache.max, DEFAULT_CACHE_LIMIT);
        assert_eq!(t.c().file_cache.max, 1000);
        assert_eq!(t.c().lines_cache.max, 1000);
        assert_eq!(t.c().by_id_cache.max, BY_ID_CACHE_LIMIT);
    }

    // -- getNodeById full-row golden (rowToNode parity) --------------------------

    #[test]
    fn node_by_id_golden_row_and_miss_and_cache() {
        let env = TempEnv::new();
        let conn = env.conn();
        seed_node_full(&conn);
        drop(conn);
        let t = TCtx::open(&env);

        let wire = node_by_id_core(&mut t.c(), "function:full").unwrap();
        assert_eq!(groups_of(&wire, CTX_NODES_HEADER_SIZE), vec![(0, 1)]);
        let n = &decode_nodes(&wire)[0];
        assert_eq!(n.id, "function:full");
        assert_eq!(n.kind, "method");
        assert_eq!(n.name, "full");
        assert_eq!(n.qn.as_deref(), Some("mod.Full"));
        assert_eq!(n.file, "a.ts");
        assert_eq!(n.lang, "typescript");
        assert_eq!((n.start, n.end, n.sc, n.ec), (3, 9, 1, 2));
        assert_eq!(n.docstring.as_deref(), Some("doc"));
        assert_eq!(n.signature.as_deref(), Some("sig()"));
        assert_eq!(n.visibility.as_deref(), Some("public"));
        // flags: bit0 is_exported(1) | bit2 is_static(1); is_async/is_abstract 0.
        assert_eq!(n.flags, 0b0101);
        assert_eq!(n.decorators.as_deref(), Some("[\"deco\"]"));
        assert_eq!(n.type_parameters.as_deref(), Some("[\"T\"]"));
        assert_eq!(n.return_type.as_deref(), Some("void"));
        assert_eq!(n.params_json.as_deref(), Some("[{\"n\":\"p\",\"t\":\"string\"}]"));
        assert_eq!(n.search_text, None, "read rows never carry search_text");
        assert_eq!(n.updated_at, 42);

        // Hit is cached (QueryBuilder nodeCache parity); miss is NOT.
        assert_eq!(t.c().by_id_cache.len(), 1);
        let miss = node_by_id_core(&mut t.c(), "function:ghost").unwrap();
        assert_eq!(groups_of(&miss, CTX_NODES_HEADER_SIZE), vec![(0, 0)], "miss = empty group");
        assert_eq!(t.c().by_id_cache.len(), 1);
    }

    // -- knownNames/knownFiles membership + fs fallback ---------------------------

    #[test]
    fn has_names_and_file_exists_membership_plus_fs_fallback() {
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        // Seed through a REAL store commit so the generation bumps.
        let mut b = Builder::default();
        let f = b.file("src/a.ts", "h1", "typescript", 10, 1.0, 1, 1, None);
        b.node("function:n1", "function", "alpha", "src/a.ts", "typescript", 1, Some("m.alpha"), None, 5, 0);
        b.op(store::OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        t.commit(b.finish());
        assert_eq!(t.gen(), 1);

        let r = has_names_core(&mut t.c(), &["alpha".into(), "beta".into(), "m.alpha".into()]).unwrap();
        assert_eq!(r, vec![true, false, false], "qualified names are NOT node names");

        // fileExists: files-table membership (raw AND backslash-normalized),
        // then the fs.existsSync fallback for not-yet-indexed files.
        env.write_file("src/b.ts", "export const x = 1;");
        let r = file_exists_core(&mut t.c(), &["src/a.ts".into(), "src\\a.ts".into(), "src/b.ts".into(), "nope.ts".into()]).unwrap();
        assert_eq!(r, vec![true, true, true, false]);

        // getAllFiles / getAllNodeNames single-group wires.
        let wire = all_files_core(&mut t.c()).unwrap();
        assert_eq!(decode_str_groups(&wire), vec![vec![Some("src/a.ts".to_string())]]);
        let wire = all_node_names_core(&mut t.c()).unwrap();
        assert_eq!(decode_str_groups(&wire), vec![vec![Some("alpha".to_string())]]);
    }

    // -- generation + epoch invalidation -----------------------------------------

    #[test]
    fn generation_bump_invalidates_caches_and_indexes() {
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        let mut b = Builder::default();
        let f = b.file("a.ts", "h1", "typescript", 10, 1.0, 1, 1, None);
        b.node("function:n1", "function", "alpha", "a.ts", "typescript", 1, None, None, 5, 0);
        b.op(store::OP_STORE_FILE_RESULT, Some(f), Some((0, 1)), None, None, None, 0);
        t.commit(b.finish());

        // Warm caches at generation 1.
        assert_eq!(has_names_core(&mut t.c(), &["alpha".into(), "beta".into()]).unwrap(), vec![true, false]);
        nodes_batch_core(&mut t.c(), &["alpha".into()], NodeQuery::ByName).unwrap();
        assert_eq!(t.c().name_cache.len(), 1);

        // A second store commit adds "beta" and bumps the generation.
        let mut b2 = Builder::default();
        let f2 = b2.file("b.ts", "h2", "typescript", 10, 2.0, 2, 1, None);
        b2.node("function:n2", "function", "beta", "b.ts", "typescript", 1, None, None, 5, 0);
        b2.op(store::OP_STORE_FILE_RESULT, Some(f2), Some((0, 1)), None, None, None, 0);
        t.commit(b2.finish());
        assert_eq!(t.gen(), 2);

        // The stale nameCache was dropped by the generation check and the
        // knownNames index rebuilt: "beta" is now visible everywhere.
        assert_eq!(has_names_core(&mut t.c(), &["alpha".into(), "beta".into()]).unwrap(), vec![true, true]);
        let wire = nodes_batch_core(&mut t.c(), &["beta".into()], NodeQuery::ByName).unwrap();
        assert_eq!(groups_of(&wire, CTX_NODES_HEADER_SIZE), vec![(0, 1)]);
        assert_eq!(t.c().name_cache.len(), 1, "cache was cleared then refilled with beta only");

        // Explicit epoch invalidation (the ctx_invalidate seam for writes the
        // generation counter cannot see): seed via external SQL, then bump.
        let conn = env.conn();
        seed_node(&conn, "function:n3", "function", "gamma", "g", "c.ts", 1);
        drop(conn);
        assert_eq!(has_names_core(&mut t.c(), &["gamma".into()]).unwrap(), vec![false], "stale until invalidated");
        t.c().epoch += 1;
        assert_eq!(has_names_core(&mut t.c(), &["gamma".into()]).unwrap(), vec![true]);

        // ROLLED-BACK store batches must NOT bump the generation (no rebuild).
        let g = t.gen();
        let mut bad = Builder::default();
        bad.node("function:rb", "function", "rb", "rb.ts", "typescript", 1, None, None, 1, 0);
        bad.op(store::OP_INSERT_NODES, None, Some((0, 1)), None, None, None, 0);
        bad.op(200, None, None, None, None, None, 0); // unknown op → rollback
        let bufs = bad.finish();
        let failed = t.sh.with_conn(|sc| Ok(store::commit_batch_core(sc, bufs.borrows()).is_err())).unwrap();
        assert!(failed);
        assert_eq!(t.gen(), g, "rollback keeps the generation");
    }

    #[test]
    fn warm_is_noop_when_generation_unchanged() {
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        let conn = env.conn();
        seed_node(&conn, "function:n1", "function", "alpha", "m.alpha", "a.ts", 1);
        drop(conn);
        t.c().warm().unwrap();
        nodes_batch_core(&mut t.c(), &["alpha".into()], NodeQuery::ByName).unwrap();
        assert_eq!(t.c().name_cache.len(), 1);
        // warmCaches parity call with no intervening writes: caches survive.
        t.c().warm().unwrap();
        assert!(t.c().known_names.as_ref().unwrap().contains("alpha"));
        assert!(t.c().known_files.is_some());
        assert_eq!(t.c().name_cache.len(), 1, "unchanged generation must not clear caches");
    }

    // -- fs arms: readFile / getFileLines / listDirectories ------------------------

    #[test]
    fn read_files_lines_and_list_directories_parity() {
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        env.write_file("src/a.ts", "line1\nline2\n");
        env.write_file("empty.ts", "");
        std::fs::create_dir_all(env.dir.join("src/sub")).unwrap();

        // readFile: present / absent (null) / empty string; misses are cached.
        let wire = read_files_core(&mut t.c(), &["src/a.ts".into(), "missing.ts".into(), "empty.ts".into()]).unwrap();
        let g = decode_str_groups(&wire);
        assert_eq!(g[0], vec![Some("line1\nline2\n".to_string())]);
        assert_eq!(g[1], vec![None]);
        assert_eq!(g[2], vec![Some(String::new())]);
        assert_eq!(t.c().file_cache.len(), 3, "failures cache None like TS fileCache.set(path, null)");

        // getFileLines: split('\\n') — trailing newline yields a final empty
        // line; empty file yields [""]; missing file yields [] (empty group).
        let wire = file_lines_core(&mut t.c(), &["src/a.ts".into(), "empty.ts".into(), "missing.ts".into()]).unwrap();
        let g = decode_str_groups(&wire);
        assert_eq!(g[0], vec![Some("line1".into()), Some("line2".into()), Some(String::new())]);
        assert_eq!(g[1], vec![Some(String::new())]);
        assert!(g[2].is_empty());
        assert_eq!(t.c().lines_cache.len(), 2, "unreadable files are NOT lines-cached (TS early return)");

        // listDirectories: '.' = project root, lexical order, missing → [].
        let wire = list_directories_core(&mut t.c(), &[".".into(), "src".into(), "gone".into()]).unwrap();
        let g = decode_str_groups(&wire);
        assert_eq!(g[0], vec![Some("src".to_string())]);
        assert_eq!(g[1], vec![Some("sub".to_string())]);
        assert!(g[2].is_empty());
    }

    // -- import mappings / re-exports ports ---------------------------------------

    #[test]
    fn import_mappings_language_matrix() {
        let js = extract_import_mappings(
            "import def, { a, b as c } from './m1';\nimport * as ns from './m2';\nconst rq = require('./m3');\nconst { x, y: z } = require('./m4');\n",
            "typescript",
        );
        assert_eq!(
            js,
            vec![
                ImportMapping { local_name: "def".into(), exported_name: "default".into(), source: "./m1".into(), is_default: true, is_namespace: false },
                ImportMapping { local_name: "a".into(), exported_name: "a".into(), source: "./m1".into(), is_default: false, is_namespace: false },
                ImportMapping { local_name: "c".into(), exported_name: "b".into(), source: "./m1".into(), is_default: false, is_namespace: false },
                ImportMapping { local_name: "ns".into(), exported_name: "*".into(), source: "./m2".into(), is_default: false, is_namespace: true },
                ImportMapping { local_name: "rq".into(), exported_name: "default".into(), source: "./m3".into(), is_default: true, is_namespace: false },
                ImportMapping { local_name: "x".into(), exported_name: "x".into(), source: "./m4".into(), is_default: false, is_namespace: false },
                ImportMapping { local_name: "z".into(), exported_name: "y".into(), source: "./m4".into(), is_default: false, is_namespace: false },
            ]
        );

        let py = extract_import_mappings("from pkg.mod import Foo, Bar as B, *\nimport os.path\nimport numpy as np\n", "python");
        assert_eq!(
            py,
            vec![
                ImportMapping { local_name: "Foo".into(), exported_name: "Foo".into(), source: "pkg.mod".into(), is_default: false, is_namespace: false },
                ImportMapping { local_name: "B".into(), exported_name: "Bar".into(), source: "pkg.mod".into(), is_default: false, is_namespace: false },
                ImportMapping { local_name: "path".into(), exported_name: "*".into(), source: "os.path".into(), is_default: false, is_namespace: true },
                ImportMapping { local_name: "np".into(), exported_name: "*".into(), source: "numpy".into(), is_default: false, is_namespace: true },
            ],
            "star in from-import is skipped (name !== '*')"
        );

        let go = extract_import_mappings("import \"fmt\"\nimport alias \"os/special\"\nimport (\n\t\"strings\"\n\ts \"strconv\"\n)\n", "go");
        let go_pairs: Vec<(&str, &str)> = go.iter().map(|m| (m.local_name.as_str(), m.source.as_str())).collect();
        assert_eq!(go_pairs, [("fmt", "fmt"), ("alias", "os/special"), ("strings", "strings"), ("s", "strconv")]);
        assert!(go.iter().all(|m| m.is_namespace && m.exported_name == "*"));

        let java = extract_import_mappings(
            "/* import fake.Block; */\n// import fake.Line;\nimport com.example.dao.FooConverter;\nimport static com.example.Util.helper;\nimport com.example.*;\n",
            "java",
        );
        let java_pairs: Vec<(&str, &str)> = java.iter().map(|m| (m.local_name.as_str(), m.source.as_str())).collect();
        assert_eq!(java_pairs, [("FooConverter", "com.example.dao.FooConverter"), ("helper", "com.example.Util.helper")], "comments stripped, wildcard skipped");

        let php = extract_import_mappings("use App\\Models\\User;\nuse App\\Svc as S;\n", "php");
        let php_pairs: Vec<(&str, &str, &str)> = php.iter().map(|m| (m.local_name.as_str(), m.exported_name.as_str(), m.source.as_str())).collect();
        assert_eq!(php_pairs, [("User", "User", "App\\Models\\User"), ("S", "Svc", "App\\Svc")]);

        let cpp = extract_import_mappings("#include <vector>\n#  include \"myheader.hpp\"\n#include \"plain.h\"\n", "cpp");
        let cpp_pairs: Vec<(&str, &str)> = cpp.iter().map(|m| (m.local_name.as_str(), m.source.as_str())).collect();
        assert_eq!(cpp_pairs, [("vector", "vector"), ("myheader", "myheader.hpp"), ("plain", "plain.h")]);
        assert!(cpp.iter().all(|m| m.is_namespace && m.exported_name == "*"));

        // Unknown language → empty (TS dispatch has no else arm).
        assert!(extract_import_mappings("import x from 'y'", "ruby").is_empty());
    }

    #[test]
    fn re_exports_wildcard_named_and_comment_stripping() {
        let content = "export * from './a';\nexport * as ns from './b';\nexport { foo, bar as baz,  , not-word } from './c';\n// export { ghost } from './d';\n/* export { ghost2 } from './e'; */\nexport { keep } from './f'; // trailing\n";
        let out = extract_re_exports(content, "typescript");
        assert_eq!(
            out,
            vec![
                ReExport::Wildcard { source: "./a".into() },
                ReExport::Wildcard { source: "./b".into() },
                ReExport::Named { exported_name: "foo".into(), original_name: "foo".into(), source: "./c".into() },
                ReExport::Named { exported_name: "baz".into(), original_name: "bar".into(), source: "./c".into() },
                ReExport::Named { exported_name: "keep".into(), original_name: "keep".into(), source: "./f".into() },
            ],
            "commented exports produce no phantom entries; 'not-word' fails the word test"
        );
        // Non-JS languages → [].
        assert!(extract_re_exports(content, "python").is_empty());
        // Strings survive comment stripping.
        assert!(extract_re_exports("const s = '// not a comment';\nexport { v } from './g';", "javascript").len() >= 1);
    }

    #[test]
    fn mappings_and_reexports_through_ctx_with_cache_and_wire() {
        let env = TempEnv::new();
        let t = TCtx::open(&env);
        env.write_file("src/mod.ts", "import { a as b } from './dep';\nexport * from './barrel';\nexport { q } from './barrel';\n");

        let wire = import_mappings_core(&mut t.c(), &["src/mod.ts".into(), "missing.ts".into()], &["typescript".into()]).unwrap();
        let g = decode_mapping_groups(&wire);
        assert_eq!(
            g[0],
            vec![DMapping { local: "b".into(), exported: "a".into(), source: "./dep".into(), resolved: None, is_default: false, is_namespace: false }]
        );
        assert!(g[1].is_empty(), "missing file caches [] exactly like the TS arm");
        assert_eq!(t.c().import_mapping_cache.len(), 2);

        let wire = re_exports_core(&mut t.c(), &["src/mod.ts".into()], &["typescript".into()]).unwrap();
        let g = decode_reexport_groups(&wire);
        assert_eq!(
            g[0],
            vec![
                DReExport::Wildcard { source: "./barrel".into() },
                DReExport::Named { exported: "q".into(), original: "q".into(), source: "./barrel".into() },
            ]
        );

        // languages shorter than paths reuses the LAST element (pair rule).
        env.write_file("m.py", "import os\n");
        let wire = import_mappings_core(&mut t.c(), &["src/mod.ts".into(), "m.py".into()], &["typescript".into(), "python".into()]).unwrap();
        let g = decode_mapping_groups(&wire);
        assert_eq!(g[1][0].local, "os");
        // Empty languages is a hard error.
        assert!(import_mappings_core(&mut t.c(), &["src/mod.ts".into()], &[]).is_err());
    }

    // -- handle lifecycle ----------------------------------------------------------

    #[test]
    fn ctx_close_rejects_later_calls_and_double_close() {
        let env = TempEnv::new();
        let sh = store::store_open(env.path.clone()).unwrap();
        let h = ctx_open(&sh, env.dir.to_string_lossy().to_string()).unwrap();
        // Plain Vec<bool> surfaces are safe to call in tests (no napi Buffer).
        assert_eq!(ctx_file_exists(&h, vec!["nope.ts".into()]).unwrap(), vec![false]);
        assert_eq!(ctx_get_project_root(&h).unwrap(), env.dir.to_string_lossy().to_string());
        ctx_close(&h).unwrap();
        let e = ctx_file_exists(&h, vec!["nope.ts".into()]);
        match e {
            Err(err) => assert!(err.to_string().contains("closed"), "{err}"),
            Ok(_) => panic!("closed handle must reject calls"),
        }
        assert!(ctx_close(&h).is_err(), "double close is an error the TS side treats as benign");
        store::store_close(&sh).unwrap();
    }

    #[test]
    fn ctx_open_rejects_closed_store() {
        let env = TempEnv::new();
        let sh = store::store_open(env.path.clone()).unwrap();
        store::store_close(&sh).unwrap();
        let e = ctx_open(&sh, env.dir.to_string_lossy().to_string());
        match e {
            Err(err) => assert!(err.to_string().contains("closed"), "{err}"),
            Ok(_) => panic!("ctx_open on a closed store must fail"),
        }
    }
}

