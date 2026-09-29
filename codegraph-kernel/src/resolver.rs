//! resolver — R3c-1: the name-matcher strategy tree + resolveOne's single-ref
//! arbitration flow, ported from `packages/chimera/src/graph/resolution/`
//! (name-matcher.ts 3,214 lines + index.ts resolveOne face). INTERNAL module:
//! no napi exports in this baton — R3c-2 designs the `resolve_batch` wire face
//! and the TS routing. Reads go through resolver_ctx's `CtxConn` in-crate
//! (the 18-getter ResolutionContext face already lives there); strategy data
//! the FFI boundary rules keep TS-side (R3 proposal §4) arrives PRECOMPUTED
//! via `ExternalStrategies` (案 A): import/JVM-import/framework results per
//! ref key + framework-claimed names. No TS callbacks, no per-ref crossings.
//!
//! # Fidelity rules (R3c risk list #1 — ordering/arbitration are load-bearing)
//!
//! - Candidate order = CtxConn SQL order verbatim: getNodesByName
//!   `ORDER BY file_path, start_line` (CG-33), getNodesByFile `ORDER BY
//!   start_line`, by-qualified-name/by-lower-name/by-kind unordered (same
//!   SQLite scan order both arms).
//! - Arbitration replicates pickBestCandidate exactly: RESOLVER_RANK class
//!   order, then same-file, then same-language, then the lexicographically
//!   smaller target id (JS `<` on ids = UTF-16 code-unit order; node ids are
//!   ASCII so Rust's UTF-8 byte `<` agrees). On a rank tie TS calls
//!   getNodeById twice — replicated (both lookups run, same caches).
//! - JS regex semantics: patterns run in the crate's default Unicode mode
//!   (byte mode `(?-u)` cannot host the JS Unicode `\s` class). `\w` is made
//!   ASCII-exact like JS by expanding it to `[0-9A-Za-z_]`; `\s` expands to the
//!   full JS whitespace class (resolver_ctx `S`); `\b`/`\d` keep their Unicode
//!   meaning (`\b` divergence is a Known deviation below). Leftmost-first
//!   preference of the regex crate matches JS backtracking on these patterns.
//! - Lookarounds/backrefs are hand-expanded, each at its use site with a note:
//!   the declarator lookahead (matchMethodCall cpp), RECEIVER_ANNOTATION_FULL
//!   (match.index bookkeeping preserved via group-2 end), and the
//!   require-json backref (two-class capture + manual equality).
//! - String indices: ref `column` is a UTF-16 code-unit offset (extraction),
//!   so per-line slices use `js_slice_*` helpers; `blank_string_contents` /
//!   `strip_comments_for_regex` are offset-preserving byte scanners whose
//!   match indices stay self-consistent within the Rust arm.
//! - Stable sorts mirror Array.prototype.sort (Rust sort_by is stable);
//!   `reduce((a,b) => a.startLine <= b.startLine ? a : b)` folds keep the
//!   FIRST on ties (ported literally).
//! - Memo lifecycle: TS keys six memo WeakMaps on the ResolutionContext and
//!   drops them via clearNameMatcherMemos from clearCaches. Here memos live
//!   in `Resolver` and drop automatically when CtxConn's (store generation,
//!   epoch) invalidation key changes — the same pairing, deterministic.
//!   TS identity-token rebuilds (cached.nodes === nodes) are subsumed: within
//!   one generation the derived values are identical.
//!
//! # Known deviations (documented, test-visible)
//!
//! - `localeCompare` (matchTsThisFieldCall nearest-declaration tiebreak only):
//!   approximated by ASCII case-insensitive then byte compare — exact for the
//!   ASCII paths the tiebreak sees; ICU punctuation weighting not replicated.
//! - `String.toUpperCase/toLowerCase` first-char casing: Rust full-Unicode
//!   casing vs JS code-unit casing differs only for astral-plane first chars.
//! - `\b` word boundaries run in Unicode mode (JS `\b` is ASCII-only): they
//!   diverge only at a boundary adjacent to a non-ASCII word char (e.g. a
//!   Unicode identifier butted against an ASCII keyword). ASCII word chars —
//!   the overwhelmingly common code case — are identical. The regex crate has
//!   no lookaround, so an ASCII-exact `\b` is not expressible in Unicode mode.
//! - AMBIGUOUS_NAME_CEILING is read per Resolver::new (TS: once per module
//!   load) — same value unless the env mutates mid-process.
//! - hasAnyPossibleMatch/isBuiltInOrExternal always see a built knownNames
//!   index (lazily built); TS's null-index permissive arms correspond to
//!   pre-warmCaches states production never resolves in.
//!
//! # Wire formats (RESOLVE_ABI_VERSION = 1) — R3c-2
//!
//! All little-endian. Strings are `(offset u32, len u32)` pairs into ONE
//! shared UTF-8 arena; `offset == NONE (0xFFFF_FFFF)` means "field absent".
//! One `resolve_batch` call is ONE boundary crossing per ref batch (5000 in
//! production — resolveAndPersistBatched's batch granularity).
//!
//! ## Input ResolveBuffers { meta, refs, external, arena }
//!
//! meta (16 bytes): abi u8, [3] pad, ref_count u32, flags u32, arena_len u32.
//!   flags bit0 = sweep the batch's own files for file-level import
//!   edges (materializeFileLevelImportEdges' per-batch arm; the loop-tail
//!   residual sweep stays TS in v1).
//! ref row (64 bytes): id i64 (-1 = absent), from_node_id str, reference_name
//!   str, reference_kind str, file_path str, language str, line i64, column
//!   i64. filePath/language are DENORMALIZED TS-side before encoding (the
//!   getFilePathFromNodeId/getLanguageFromNodeId fallbacks run pre-wire).
//! external header (32 bytes): abi u8, [3] pad, import_count u32, jvm_count
//!   u32, fw_group_count u32, fw_cand_count u32, also_count u32, claimed_count
//!   u32, path_count u32. Then row tables IN THIS ORDER: import key rows
//!   (32B: file str, name str, kind str, target_node_id str), jvm key rows
//!   (same 32B), fw group rows (48B: file str, name str, kind str, line i64,
//!   col i64, cand_start u32, cand_end u32 — POSITION-keyed: framework
//!   resolvers parse the call site, so same-name refs at different lines
//!   resolve differently), fw candidate rows (40B: target str, resolved_by u8
//!   (1=import … 8=fuzzy), authoritative u8, [2] pad, edge_kind str,
//!   metadata str (JSON), also_start u32, also_end u32), also rows (16B:
//!   target str, metadata str), claimed-name rows (8B: str), import-path rows
//!   (24B: file str, source str, resolved str — NONE = unresolvable/external).
//!   The import/jvm tables are resolveViaImport/resolveJvmImport results
//!   PRECOMPUTED per ref key plus the synthetic store-holder keys
//!   (file, holderName, "references") — the R3c-1 report's named pit; the
//!   framework tables replay detection order and MUST stop at the first
//!   authoritative/import/qualified-name candidate (resolveOne's
//!   short-circuit keeps the framework.resolve call set identical). The
//!   import-path table is the resolveImportPath Plan-A seam: TS resolves each
//!   (file, specifier) once per batch through its own import-resolver arm
//!   (aliases/go-module/cpp-include-dirs stay TS); the file-level sweep
//!   consumes it.
//!
//! ## Output ResolveBuffersOut { header, edges, refs, files, stats, arena }
//!
//! header (40 bytes): abi u8, [3] pad, batch_edge_count u32, resolved_count
//!   u32, failed_count u32, sweep_count u32, stat_count u32, arena_len u32,
//!   total u32, resolved_total u32, unresolved_total u32.
//! edge row (80 bytes): source str, target str, kind str, line i64, column
//!   i64, target_metadata str (JSON passthrough | NONE), resolved_by str,
//!   ref_name str, ref_kind str (NONE unless a kind promotion rewrote kind),
//!   fn_ref u8, [7] pad. The first batch_edge_count rows are the createEdges
//!   output (dedupeSymbolImportEdges applied); later rows belong to the sweep
//!   ranges in the files table. The TS decoder REBUILDS each edge's metadata
//!   object in JS spread order ({...t.metadata, resolvedBy, refName, refKind?,
//!   fnRef?}) from the stamp fields — serde_json without preserve_order
//!   cannot keep insertion order, so assembly stays TS-side (byte-identical
//!   to the TS arm's JSON.stringify).
//! refs row (40 bytes): flag u8 (1 = resolved → delete, 2 = unresolved →
//!   mark failed), [7] pad, id i64 (-1 absent; only meaningful on resolved
//!   rows), from_node_id str, reference_name str, reference_kind str.
//! files row (24 bytes): source_node_id str, edge_start u32, edge_end u32
//!   (indexes into the edge table AFTER the batch edges; an EMPTY range is a
//!   delete-only sweep — TS materializeFileLevelImportEdges deletes before
//!   the mappings-empty check), pad u32.
//! stats row (16 bytes): byMethod key str, count u32, pad u32.
//!
//! # Not ported (stay TS arms)
//!
//! callback-synthesizer (batch-loop tail, called as a TS batch),
//! resolveViaImport/resolveJvmImport/resolveImportPath (precomputed per
//! batch — 案 A), frameworks (precomputed per ref key), the loop-tail
//! residual file-level sweep, and the WAL-backpressure/yield orchestration
//! (the TS batch loop keeps its cadence around the native call).
#![allow(clippy::too_many_arguments)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;

use crate::buffers::NONE;
use crate::resolver_ctx::{
    js_trim, put_opt_str, put_str, push_str_ref, push_u32, CtxConn, CtxHandle, CtxNode,
    ImportMapping, Lru, ReExport, S,
};

type Result<T> = napi::bindgen_prelude::Result<T>;

fn rerr(msg: String) -> napi::bindgen_prelude::Error {
    napi::bindgen_prelude::Error::from_reason(format!("resolver: {msg}"))
}

// ---------------------------------------------------------------------------
// Built-in name tables (resolution/js-builtins.ts — byte-identical sets)
// ---------------------------------------------------------------------------

fn set(items: &'static [&'static str]) -> HashSet<&'static str> {
    items.into_iter().copied().collect()
}

fn js_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "console", "window", "document", "global", "process",
            "Promise", "Array", "Object", "String", "Number", "Boolean",
            "Date", "Math", "JSON", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet",
            "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "fetch", "require", "module", "exports", "__dirname", "__filename",
        ])
    })
}

/// Method names that require receiver evidence before linking to project
/// code (js-builtins.ts JS_BUILTIN_METHODS, upstream #1987).
fn js_builtin_methods() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            // Array / typed arrays and collections.
            "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find",
            "findIndex", "findLast", "findLastIndex", "flat", "flatMap", "forEach",
            "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push",
            "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice",
            "toReversed", "toSorted", "toSpliced", "unshift", "values", "with", "subarray",
            "get", "set", "has", "add", "delete", "clear",
            // String.
            "charAt", "charCodeAt", "codePointAt", "endsWith", "localeCompare", "match",
            "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll",
            "search", "split", "startsWith", "substring", "substr", "toLowerCase",
            "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "trim", "trimStart",
            "trimEnd", "trimLeft", "trimRight", "toString", "toLocaleString", "valueOf",
            // Promise, Function, EventTarget / EventEmitter and iterators.
            "then", "catch", "finally", "call", "apply", "bind",
            "addEventListener", "removeEventListener", "dispatchEvent", "on", "once",
            "off", "emit", "addListener", "removeListener", "removeAllListeners",
            "prependListener", "prependOnceListener", "listeners", "rawListeners",
            "listenerCount", "eventNames", "setMaxListeners", "getMaxListeners",
            "next", "return", "throw", "drop", "take", "toArray",
        ])
    })
}

fn ts_primitive_types() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "string", "number", "boolean", "bigint", "symbol",
            "void", "undefined", "null", "never", "unknown", "any", "object",
        ])
    })
}

fn react_hooks() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "useState", "useEffect", "useContext", "useReducer", "useCallback",
            "useMemo", "useRef", "useLayoutEffect", "useImperativeHandle", "useDebugValue",
        ])
    })
}

fn python_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple",
            "open", "input", "type", "isinstance", "hasattr", "getattr", "setattr",
            "super", "self", "cls", "None", "True", "False",
        ])
    })
}

fn python_builtin_types() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "list", "dict", "set", "tuple", "str", "int", "float", "bool",
            "bytes", "bytearray", "frozenset", "object", "super",
        ])
    })
}

fn python_builtin_methods() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse", "copy",
            "update", "keys", "values", "items", "get",
            "add", "discard", "union", "intersection", "difference",
            "split", "join", "strip", "lstrip", "rstrip", "replace", "lower", "upper",
            "startswith", "endswith", "find", "index", "count", "encode", "decode",
            "format", "isdigit", "isalpha", "isalnum",
            "read", "write", "readline", "readlines", "close", "flush", "seek",
        ])
    })
}

fn go_stdlib_packages() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "fmt", "os", "io", "net", "http", "log", "math", "sort", "sync",
            "time", "path", "bytes", "strings", "strconv", "errors", "context",
            "json", "xml", "csv", "html", "template", "regexp", "reflect",
            "runtime", "testing", "flag", "bufio", "crypto", "encoding",
            "filepath", "hash", "mime", "rand", "signal", "sql", "syscall",
            "unicode", "unsafe", "atomic", "binary", "debug", "exec", "heap",
            "ring", "scanner", "tar", "zip", "gzip", "zlib", "tls", "url",
            "user", "pprof", "trace", "ast", "build", "parser", "printer",
            "token", "types", "cgo", "plugin", "race", "ioutil",
            // Kubernetes-common stdlib aliases
            "utilruntime", "utilwait", "utilnet",
        ])
    })
}

fn go_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "make", "new", "len", "cap", "append", "copy", "delete", "close",
            "panic", "recover", "print", "println", "complex", "real", "imag",
            "error", "nil", "true", "false", "iota",
            "int", "int8", "int16", "int32", "int64",
            "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
            "float32", "float64", "complex64", "complex128",
            "string", "bool", "byte", "rune", "any",
        ])
    })
}

/// PASCAL_UNIT_PREFIXES is an ARRAY in TS (`.some(startsWith)`) — order-free
/// membership, kept as a slice.
const PASCAL_UNIT_PREFIXES: &[&str] = &[
    "System.", "Winapi.", "Vcl.", "Fmx.", "Data.", "Datasnap.",
    "Soap.", "Xml.", "Web.", "REST.", "FireDAC.", "IBX.",
    "IdHTTP", "IdTCP", "IdSSL",
];

fn pascal_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "System", "SysUtils", "Classes", "Types", "Variants", "StrUtils",
            "Math", "DateUtils", "IOUtils", "Generics.Collections", "Generics.Defaults",
            "Rtti", "TypInfo", "SyncObjs", "RegularExpressions",
            "SysInit", "Windows", "Messages", "Graphics", "Controls", "Forms",
            "Dialogs", "StdCtrls", "ExtCtrls", "ComCtrls", "Menus", "ActnList",
            "WriteLn", "Write", "ReadLn", "Read", "Inc", "Dec", "Ord", "Chr",
            "Length", "SetLength", "High", "Low", "Assigned", "FreeAndNil",
            "Format", "IntToStr", "StrToInt", "FloatToStr", "StrToFloat",
            "Trim", "UpperCase", "LowerCase", "Pos", "Copy", "Delete", "Insert",
            "Now", "Date", "Time", "DateToStr", "StrToDate",
            "Raise", "Exit", "Break", "Continue", "Abort",
            "True", "False", "nil", "Self", "Result",
            "Create", "Destroy", "Free",
            "TObject", "TComponent", "TPersistent", "TInterfacedObject",
            "TList", "TStringList", "TStrings", "TStream", "TMemoryStream", "TFileStream",
            "Exception", "EAbort", "EConvertError", "EAccessViolation",
            "IInterface", "IUnknown",
        ])
    })
}

fn c_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "printf", "fprintf", "sprintf", "snprintf", "scanf", "fscanf", "sscanf",
            "malloc", "calloc", "realloc", "free",
            "memcpy", "memmove", "memset", "memcmp", "memchr",
            "strlen", "strcpy", "strncpy", "strcat", "strncat", "strcmp", "strncmp",
            "strstr", "strchr", "strrchr", "strtok", "strdup",
            "fopen", "fclose", "fread", "fwrite", "fgets", "fputs", "fputc", "fgetc",
            "feof", "ferror", "fflush", "fseek", "ftell", "rewind",
            "exit", "abort", "atexit", "atoi", "atol", "atof", "strtol", "strtoul", "strtod",
            "qsort", "bsearch",
            "abs", "labs", "rand", "srand",
            "sin", "cos", "tan", "sqrt", "pow", "log", "log10", "exp", "ceil", "floor", "fabs",
            "time", "clock", "difftime", "mktime", "localtime", "gmtime", "strftime", "asctime",
            "assert", "errno",
            "perror", "remove", "rename", "tmpfile", "tmpnam",
            "getenv", "system",
            "signal", "raise",
            "setjmp", "longjmp",
            "va_start", "va_end", "va_arg", "va_copy",
            "NULL", "EOF", "BUFSIZ", "FILENAME_MAX", "RAND_MAX", "EXIT_SUCCESS", "EXIT_FAILURE",
            "size_t", "ptrdiff_t", "wchar_t", "intptr_t", "uintptr_t",
            "int8_t", "int16_t", "int32_t", "int64_t",
            "uint8_t", "uint16_t", "uint32_t", "uint64_t",
            "FILE",
            // POSIX additions commonly seen
            "stat", "lstat", "fstat", "open", "close", "read", "write", "pipe",
            "fork", "exec", "waitpid", "getpid", "getppid", "kill", "sleep", "usleep",
            "pthread_create", "pthread_join", "pthread_mutex_lock", "pthread_mutex_unlock",
            "dlopen", "dlsym", "dlclose",
        ])
    })
}

fn cpp_built_ins() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "cout", "cin", "cerr", "clog", "endl", "flush", "ws",
            "std",
            "nullptr", "true", "false", "this", "sizeof", "alignof", "typeid",
            "static_cast", "dynamic_cast", "reinterpret_cast", "const_cast",
            "make_unique", "make_shared", "make_pair",
            "move", "forward", "swap",
        ])
    })
}

// ---------------------------------------------------------------------------
// Language families / sets (name-matcher.ts + index.ts)
// ---------------------------------------------------------------------------

/// name-matcher.ts:42 — ESM_FAMILY.
fn esm_family(lang: &str) -> bool {
    matches!(lang, "typescript" | "tsx" | "javascript" | "jsx" | "arkts")
}

/// name-matcher.ts:269 — JS_FAMILY (no arkts).
fn js_family(lang: &str) -> bool {
    matches!(lang, "typescript" | "tsx" | "javascript" | "jsx")
}

/// resolution/types.ts SUPERTYPE_TARGET_KINDS — node kinds an
/// extends/implements edge may legally target (#1536/#2029).
fn supertype_target_kinds() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "class", "struct", "interface", "trait", "protocol", "enum", "union",
            "type_alias", "component", "module", "namespace",
        ])
    })
}

/// resolution/types.ts isSupertypeTarget — Scala singleton objects are
/// values, unlike inheritable Ruby modules (#2029).
fn is_supertype_target(node: &CtxNode) -> bool {
    supertype_target_kinds().contains(node.kind.as_str())
        && !(node.language == "scala" && node.kind == "module")
}

/// resolution/types.ts isInheritanceRef.
fn is_inheritance_ref(r: &RefIn) -> bool {
    matches!(r.reference_kind.as_str(), "extends" | "implements")
}

/// name-matcher.ts:136 — PRIVATE_IS_FILE_LOCAL.
fn private_is_file_local(lang: &str) -> bool {
    matches!(lang, "kotlin" | "java" | "csharp" | "swift" | "scala" | "dart" | "php")
}

/// name-matcher.ts:1215 — NO_NESTED_FUNCTIONS.
fn no_nested_functions(lang: &str) -> bool {
    matches!(lang, "c" | "cpp")
}

/// name-matcher.ts:1279 — OBJECT_LITERAL_LANGUAGES.
fn object_literal_languages(lang: &str) -> bool {
    matches!(lang, "typescript" | "tsx" | "javascript" | "jsx" | "arkts")
}

/// name-matcher.ts:2045 — DECLARATION_EVIDENCE_LANGUAGES (Strategy 0.5 gate).
fn declaration_evidence_languages(lang: &str) -> bool {
    matches!(lang, "typescript" | "javascript" | "tsx" | "jsx")
}

/// name-matcher.ts:1088 — CONSTRUCTS_VIA_BARE_CALL.
fn constructs_via_bare_call(lang: &str) -> bool {
    matches!(lang, "kotlin" | "swift" | "scala" | "dart" | "pascal")
}

/// name-matcher.ts:1197-1207 — LANGUAGE_FAMILY.
fn language_family_of(lang: &str) -> Option<&'static str> {
    match lang {
        "java" | "kotlin" | "scala" => Some("jvm"),
        "swift" | "objc" => Some("apple"),
        "typescript" | "tsx" | "javascript" | "jsx" | "arkts" => Some("web"),
        "c" | "cpp" => Some("c"),
        "csharp" | "razor" => Some("dotnet"),
        _ => None,
    }
}

/// name-matcher.ts:1208 — sameLanguageFamily (exported).
pub(crate) fn same_language_family(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match language_family_of(a) {
        Some(fa) => Some(fa) == language_family_of(b),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Types — resolution/types.ts wire shapes (R3c-2 will encode these)
// ---------------------------------------------------------------------------

/// UnresolvedRef (resolution/types.ts:12-31). `column`/`line` are 1-based-ish
/// extraction coordinates; `column` is a UTF-16 code-unit offset.
#[derive(Clone, Debug)]
pub(crate) struct RefIn {
    pub id: Option<i64>,
    pub from_node_id: String,
    pub reference_name: String,
    /// EdgeKind | 'function_ref' (never validated here — TS ReferenceKind).
    pub reference_kind: String,
    pub line: i64,
    pub column: i64,
    pub file_path: String,
    pub language: String,
}

impl RefIn {
    /// `{ ...ref, referenceName }` / `{ ...ref, referenceName, referenceKind }`
    /// — the synthetic-ref spreads (matchDottedCallChain go fallback #1269,
    /// resolveStoreAction holder lookup). `id` rides along like the TS spread.
    fn with_name(&self, reference_name: &str, reference_kind: Option<&str>) -> RefIn {
        RefIn {
            id: self.id,
            from_node_id: self.from_node_id.clone(),
            reference_name: reference_name.to_string(),
            reference_kind: reference_kind.unwrap_or(&self.reference_kind).to_string(),
            line: self.line,
            column: self.column,
            file_path: self.file_path.clone(),
            language: self.language.clone(),
        }
    }
}

/// ResolvedRef['resolvedBy'] — the evidence classes. RESOLVER_RANK
/// (index.ts:73-86) is `rank()`; `as_str()` is the stats/metadata key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ResolvedBy {
    Import,
    QualifiedName,
    ExactMatch,
    FunctionRef,
    InstanceMethod,
    FilePath,
    Framework,
    Fuzzy,
}

impl ResolvedBy {
    /// index.ts:73-86 — import 6, qualified-name 5, exact-match 4,
    /// function-ref 4, instance-method 3, file-path 2, framework 1, fuzzy 0.
    fn rank(&self) -> i32 {
        match self {
            ResolvedBy::Import => 6,
            ResolvedBy::QualifiedName => 5,
            ResolvedBy::ExactMatch => 4,
            ResolvedBy::FunctionRef => 4,
            ResolvedBy::InstanceMethod => 3,
            ResolvedBy::FilePath => 2,
            ResolvedBy::Framework => 1,
            ResolvedBy::Fuzzy => 0,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ResolvedBy::Import => "import",
            ResolvedBy::QualifiedName => "qualified-name",
            ResolvedBy::ExactMatch => "exact-match",
            ResolvedBy::FunctionRef => "function-ref",
            ResolvedBy::InstanceMethod => "instance-method",
            ResolvedBy::FilePath => "file-path",
            ResolvedBy::Framework => "framework",
            ResolvedBy::Fuzzy => "fuzzy",
        }
    }
}

impl ResolvedBy {
    /// Wire code (RESOLVE_ABI 1) — the frozen numeric identity for external
    /// framework-candidate rows: 1=import, 2=qualified-name, 3=exact-match,
    /// 4=function-ref, 5=instance-method, 6=file-path, 7=framework, 8=fuzzy.
    fn code(&self) -> u8 {
        match self {
            ResolvedBy::Import => 1,
            ResolvedBy::QualifiedName => 2,
            ResolvedBy::ExactMatch => 3,
            ResolvedBy::FunctionRef => 4,
            ResolvedBy::InstanceMethod => 5,
            ResolvedBy::FilePath => 6,
            ResolvedBy::Framework => 7,
            ResolvedBy::Fuzzy => 8,
        }
    }

    fn from_code(c: u8) -> Option<ResolvedBy> {
        Some(match c {
            1 => ResolvedBy::Import,
            2 => ResolvedBy::QualifiedName,
            3 => ResolvedBy::ExactMatch,
            4 => ResolvedBy::FunctionRef,
            5 => ResolvedBy::InstanceMethod,
            6 => ResolvedBy::FilePath,
            7 => ResolvedBy::Framework,
            8 => ResolvedBy::Fuzzy,
            _ => return None,
        })
    }
}

/// ResolvedRef.alsoTargets entry (types.ts:69).
#[derive(Clone, Debug)]
pub(crate) struct AlsoTarget {
    pub target_node_id: String,
    /// Raw JSON text (framework-provided) — order-preserving passthrough;
    /// Rust NEVER parses it (serde_json without preserve_order would reorder
    /// keys and break stored-metadata byte parity with the TS arm).
    pub metadata: Option<String>,
}

/// ResolvedRef minus `original` (the batch loop re-attaches the ref, like
/// resolveAll's resolved[i].original). Carries the framework-only fields
/// (authoritative/edgeKind/metadata/alsoTargets) so pickBestCandidate and the
/// future createEdges port see the full shape.
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub target_node_id: String,
    pub resolved_by: ResolvedBy,
    pub authoritative: bool,
    pub edge_kind: Option<String>,
    /// Raw JSON text passthrough (see AlsoTarget).
    pub metadata: Option<String>,
    pub also_targets: Vec<AlsoTarget>,
}

impl Resolved {
    fn new(target_node_id: String, resolved_by: ResolvedBy) -> Resolved {
        Resolved {
            target_node_id,
            resolved_by,
            authoritative: false,
            edge_kind: None,
            metadata: None,
            also_targets: Vec::new(),
        }
    }
}

/// Precomputed strategy-data key: resolveOne's per-ref external lookups are
/// keyed by the ref identity the TS side can derive from the batch (file,
/// name, kind). R3c-2 freezes this as the wire contract.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct ImportKey {
    pub file_path: String,
    pub reference_name: String,
    pub reference_kind: String,
}

impl ImportKey {
    pub(crate) fn of(r: &RefIn) -> ImportKey {
        ImportKey {
            file_path: r.file_path.clone(),
            reference_name: r.reference_name.clone(),
            reference_kind: r.reference_kind.clone(),
        }
    }

    pub(crate) fn synthetic(file_path: &str, reference_name: &str, reference_kind: &str) -> ImportKey {
        ImportKey {
            file_path: file_path.to_string(),
            reference_name: reference_name.to_string(),
            reference_kind: reference_kind.to_string(),
        }
    }
}

/// Position-aware framework-table key: framework `resolve(ref)` parses the
/// call site (router.push argument literals, Spring annotations, sveltekit
/// goto URLs), so the precomputed table is keyed by the FULL ref position —
/// two same-name refs at different lines of one file resolve differently
/// (the vue-router/sveltekit regression adjudicated during R3c-2 bring-up).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct FwKey {
    pub file_path: String,
    pub reference_name: String,
    pub reference_kind: String,
    pub line: i64,
    pub col: i64,
}

impl FwKey {
    pub(crate) fn of(r: &RefIn) -> FwKey {
        FwKey {
            file_path: r.file_path.clone(),
            reference_name: r.reference_name.clone(),
            reference_kind: r.reference_kind.clone(),
            line: r.line,
            col: r.column,
        }
    }

    #[cfg(test)]
    pub(crate) fn at(
        file_path: &str,
        reference_name: &str,
        reference_kind: &str,
        line: i64,
        col: i64,
    ) -> FwKey {
        FwKey {
            file_path: file_path.to_string(),
            reference_name: reference_name.to_string(),
            reference_kind: reference_kind.to_string(),
            line,
            col,
        }
    }
}

/// A framework resolver's per-ref result, precomputed TS-side (framework
/// detection order preserved in the Vec — resolveOne consumes in order).
#[derive(Clone, Debug)]
pub(crate) struct FrameworkCandidate {
    pub target_node_id: String,
    pub resolved_by: ResolvedBy,
    pub authoritative: bool,
    pub edge_kind: Option<String>,
    /// Raw JSON text (never parsed by Rust — order-preserving passthrough).
    pub metadata: Option<String>,
    pub also_targets: Vec<AlsoTarget>,
}

impl FrameworkCandidate {
    fn to_resolved(&self) -> Resolved {
        Resolved {
            target_node_id: self.target_node_id.clone(),
            resolved_by: self.resolved_by,
            authoritative: self.authoritative,
            edge_kind: self.edge_kind.clone(),
            metadata: self.metadata.clone(),
            also_targets: self.also_targets.clone(),
        }
    }
}

/// 案 A (R3 proposal §4.2): the strategies the FFI boundary keeps TS-side,
/// precomputed per batch. Presence of an import_results entry means
/// resolveViaImport RETURNED a result (today always resolvedBy 'import');
/// absent = null. Synthetic keys (resolveStoreAction's holder lookup, keyed
/// (file, holderName, "references")) must be included by the TS precompute —
/// they are mechanical derivations of the batch's own ref names.
#[derive(Default)]
pub(crate) struct ExternalStrategies {
    pub import_results: HashMap<ImportKey, String>,
    pub jvm_import_results: HashMap<ImportKey, String>,
    pub framework_results: HashMap<FwKey, Vec<FrameworkCandidate>>,
    /// Union of every detected framework's claimsReference(name) answers.
    pub claimed_names: HashSet<String>,
}

// ---------------------------------------------------------------------------
// JS-semantics helpers
// ---------------------------------------------------------------------------

/// UTF-16 code-unit length (JS `str.length`).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Byte index of UTF-16 code-unit index `cu` (clamped) — JS `slice` offsets
/// against extraction columns, which are code-unit based.
fn js_char_index(s: &str, cu: usize) -> usize {
    let mut count = 0usize;
    for (bi, ch) in s.char_indices() {
        if count >= cu {
            return bi;
        }
        count += ch.len_utf16();
    }
    s.len()
}

/// `s.slice(cu)` (JS code-unit semantics, clamped).
fn js_slice_from(s: &str, cu: usize) -> &str {
    &s[js_char_index(s, cu)..]
}

/// `s.slice(0, cu)` (JS code-unit semantics, clamped).
fn js_slice_to(s: &str, cu: usize) -> &str {
    &s[..js_char_index(s, cu)]
}

/// JS `String.prototype.split(sep)` on a single char (empty string → [""]).
fn js_split(s: &str, sep: char) -> Vec<String> {
    s.split(sep).map(|x| x.to_string()).collect()
}

/// `charAt(0).toUpperCase() + slice(1)` — ASCII-exact; astral first chars use
/// Rust full-char casing (documented deviation).
fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => {
            let mut out: String = c.to_uppercase().collect();
            out.push_str(chars.as_str());
            out
        }
    }
}

/// ASCII approximation of `localeCompare` — case-insensitive code-point
/// order, ties by byte order. Exact for ASCII paths (the only inputs the
/// single tiebreak site sees); documented deviation.
fn locale_compare_ascii(a: &str, b: &str) -> std::cmp::Ordering {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    al.cmp(&bl).then_with(|| a.cmp(b))
}

/// JS `Number(raw)` — conservative port covering the env-value shapes:
/// empty/whitespace → 0, decimal with optional fraction/exponent, hex/octal/
/// binary literals, Infinity; anything else → NaN.
fn js_number(raw: &str) -> f64 {
    let t = js_trim(raw);
    if t.is_empty() {
        return 0.0;
    }
    let bytes = t.as_bytes();
    let mut i = 0usize;
    let neg = match bytes[0] {
        b'+' => {
            i += 1;
            false
        }
        b'-' => {
            i += 1;
            true
        }
        _ => false,
    };
    let body = &t[i..];
    let signed = |v: f64| if neg { -v } else { v };
    if body == "Infinity" {
        return signed(f64::INFINITY);
    }
    let lower = body.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return signed(u64::from_str_radix(hex, 16).unwrap_or(u64::MAX) as f64);
        }
        return f64::NAN;
    }
    if let Some(o) = lower.strip_prefix("0o") {
        if !o.is_empty() && o.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return signed(u64::from_str_radix(o, 8).unwrap_or(u64::MAX) as f64);
        }
        return f64::NAN;
    }
    if let Some(b) = lower.strip_prefix("0b") {
        if !b.is_empty() && b.bytes().all(|x| x == b'0' || x == b'1') {
            return signed(u64::from_str_radix(b, 2).unwrap_or(u64::MAX) as f64);
        }
        return f64::NAN;
    }
    // decimal: digits [. digits] [eE [+-] digits]
    let chars: Vec<char> = body.chars().collect();
    let mut j = 0usize;
    let mut mant = String::new();
    while j < chars.len() && chars[j].is_ascii_digit() {
        mant.push(chars[j]);
        j += 1;
    }
    if j < chars.len() && chars[j] == '.' {
        mant.push('.');
        j += 1;
        while j < chars.len() && chars[j].is_ascii_digit() {
            mant.push(chars[j]);
            j += 1;
        }
    }
    if mant.is_empty() || mant == "." {
        return f64::NAN;
    }
    let mut v: f64 = match mant.parse() {
        Ok(v) => v,
        Err(_) => return f64::NAN,
    };
    if j < chars.len() && (chars[j] == 'e' || chars[j] == 'E') {
        j += 1;
        let eneg = if j < chars.len() && (chars[j] == '-' || chars[j] == '+') {
            let n = chars[j] == '-';
            j += 1;
            n
        } else {
            false
        };
        let mut exp = String::new();
        while j < chars.len() && chars[j].is_ascii_digit() {
            exp.push(chars[j]);
            j += 1;
        }
        if exp.is_empty() || j != chars.len() {
            return f64::NAN;
        }
        let e: i64 = exp.parse::<i64>().unwrap_or(i64::MAX);
        let e = if eneg { -e } else { e };
        let e = e.clamp(-400, 400);
        v *= 10f64.powi(e as i32);
    } else if j != chars.len() {
        return f64::NAN;
    }
    signed(v)
}

/// JS `Number.isInteger(v)`.
fn js_is_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0
}

/// name-matcher.ts:20-24 resolveAmbiguousNameCeiling (env
/// CODEGRAPH_AMBIGUOUS_NAME_CEILING, Number() semantics, default 500).
const DEFAULT_AMBIGUOUS_NAME_CEILING: i64 = 500;

fn resolve_ambiguous_name_ceiling() -> i64 {
    match std::env::var("CODEGRAPH_AMBIGUOUS_NAME_CEILING").ok() {
        Some(raw) => {
            let v = js_number(&raw);
            if js_is_integer(v) && v > 0.0 {
                v as i64
            } else {
                DEFAULT_AMBIGUOUS_NAME_CEILING
            }
        }
        None => DEFAULT_AMBIGUOUS_NAME_CEILING,
    }
}

/// queries.ts:149-155 parseParamsJson — `[{"n":name,"t":type}]`, malformed
/// entries dropped, empty result → undefined.
fn params_of(n: &CtxNode) -> Option<Vec<(String, String)>> {
    let json = n.params_json.as_deref()?;
    let entries: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
    let params: Vec<(String, String)> = entries
        .iter()
        .filter_map(|e| {
            let name = e.get("n")?.as_str()?.to_string();
            let ty = e.get("t")?.as_str()?.to_string();
            Some((name, ty))
        })
        .collect();
    if params.is_empty() {
        None
    } else {
        Some(params)
    }
}

/// `scope.every((pos, i) => callScope[i] === pos)` — the block-identity check
/// (matchDestructuredStoreCall / matchSelectedStoreCall / importShadowedAt).
fn scope_prefix_eq(scope: &[usize], call_scope: &[usize]) -> bool {
    scope.iter().enumerate().all(|(i, p)| call_scope.get(i) == Some(p))
}

/// GET_STATE_FILES semantics (name-matcher.ts:1738-1756): insertion-ordered
/// map, `get` does NOT refresh recency, FIFO eviction of the oldest inserted
/// key at cap — NOT the recency LRU.
struct FifoMap<K, V> {
    map: HashMap<K, V>,
    order: VecDeque<K>,
    cap: usize,
}

impl<K: Clone + Eq + std::hash::Hash, V> FifoMap<K, V> {
    fn new(cap: usize) -> Self {
        FifoMap { map: HashMap::new(), order: VecDeque::new(), cap }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.map.get(key)
    }

    fn set(&mut self, key: K, value: V) {
        if self.map.insert(key.clone(), value).is_none() {
            if self.map.len() > self.cap {
                if let Some(oldest) = self.order.pop_front() {
                    self.map.remove(&oldest);
                }
            }
            self.order.push_back(key);
        }
    }
}

// ---------------------------------------------------------------------------
// strip-comments.ts port — offset-preserving scanners (blank, not remove)
// ---------------------------------------------------------------------------

fn blank_range(buf: &mut Vec<u8>, start: usize, end: usize) {
    for i in start..end.min(buf.len()) {
        if buf[i] != b'\n' {
            buf[i] = b' ';
        }
    }
}

/// blankStringContents (strip-comments.ts:44-83). Byte scanner; the regex-literal
/// lookbehind runs against the (possibly already blanked) buffer — same as TS,
/// which tests `text` (the original) — blanked quote chars cannot form string
/// starts, and the 32-char window contents are equivalent for the punctuation
/// class the test looks for.
fn blank_string_contents(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    let p = rpats();
    while i < n {
        let c = bytes[i];
        // A quote inside a JS regex is data, not the beginning of a string.
        if c == b'/' {
            let start = i.saturating_sub(32);
            let window = std::str::from_utf8(&bytes[start..i]).unwrap_or("");
            if p.regex_preceder.is_match(window) {
                let mut end = i + 1;
                let mut in_class = false;
                while end < n && bytes[end] != b'\n' {
                    if bytes[end] == b'\\' {
                        end += 1;
                        if end < n {
                            end += 1;
                        }
                        continue;
                    }
                    if bytes[end] == b'[' {
                        in_class = true;
                    }
                    if bytes[end] == b']' {
                        in_class = false;
                    }
                    if bytes[end] == b'/' && !in_class {
                        break;
                    }
                    end += 1;
                }
                if end < n && bytes[end] == b'/' {
                    i = end + 1;
                    continue;
                }
            }
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                    continue;
                }
                if quote != b'`' && bytes[i] == b'\n' {
                    break;
                }
                if bytes[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// stripCommentsForRegex (strip-comments.ts:85-106) — language dispatch.
fn strip_comments_for_regex(content: &str, lang: &str) -> String {
    match lang {
        "python" => strip_python(content),
        "ruby" => strip_ruby(content),
        "rust" => strip_rust_comments(content),
        "php" => strip_php(content),
        "go" => strip_go(content),
        "javascript" | "typescript" => strip_c_style(content, true),
        "java" | "csharp" | "swift" => strip_c_style(content, false),
        _ => content.to_string(),
    }
}

fn strip_python(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        // Triple-quoted string: """...""" or '''...'''
        if (c == b'"' || c == b'\'') && i + 2 < n && bytes[i + 1] == c && bytes[i + 2] == c {
            let quote = c;
            let start = i;
            i += 3;
            while i < n {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == quote && i + 2 < n && bytes[i + 1] == quote && bytes[i + 2] == quote {
                    i += 3;
                    break;
                }
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        // Single-line string
        if c == b'"' || c == b'\'' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        // Line comment
        if c == b'#' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_ruby(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    let mut at_line_start = true;
    while i < n {
        let c = bytes[i];
        // =begin / =end block comments at line start
        if at_line_start && c == b'=' && src[i..].starts_with("=begin") {
            let start = i;
            i += "=begin".len();
            while i < n {
                if bytes[i] == b'\n' {
                    let mut j = i + 1;
                    while j < n && (bytes[j] == b' ' || bytes[j] == b'\t') {
                        j += 1;
                    }
                    if src[j..].starts_with("=end") {
                        i = j + "=end".len();
                        while i < n && bytes[i] != b'\n' {
                            i += 1;
                        }
                        break;
                    }
                }
                i += 1;
            }
            blank_range(&mut out, start, i);
            at_line_start = i > 0 && bytes[i - 1] == b'\n';
            continue;
        }
        if c == b'"' || c == b'\'' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            at_line_start = false;
            continue;
        }
        if c == b'#' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            at_line_start = false;
            continue;
        }
        if c == b'\n' {
            at_line_start = true;
            i += 1;
            continue;
        }
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        at_line_start = false;
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_c_style(src: &str, allow_single_quote_strings: bool) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        // Block comment
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            let start = i;
            i += 2;
            while i < n && !(bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i < n {
                i += 2;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        // Line comment
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        // String literals
        if c == b'"' || (allow_single_quote_strings && c == b'\'') || c == b'`' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if quote != b'`' && bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_php(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            let start = i;
            i += 2;
            while i < n && !(bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i < n {
                i += 2;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        // # line comment (PHP supports both)
        if c == b'#' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        if c == b'"' || c == b'\'' || c == b'`' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_go(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            let start = i;
            i += 2;
            while i < n && !(bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i < n {
                i += 2;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        // Raw string with backticks (no escapes, can span lines)
        if c == b'`' {
            i += 1;
            while i < n && bytes[i] != b'`' {
                i += 1;
            }
            if i < n {
                i += 1;
            }
            continue;
        }
        if c == b'"' || c == b'\'' {
            let quote = c;
            i += 1;
            while i < n && bytes[i] != quote {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == quote {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        // Nested block comment
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            let start = i;
            i += 2;
            let mut depth = 1i32;
            while i < n && depth > 0 {
                if bytes[i] == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            blank_range(&mut out, start, i);
            continue;
        }
        if c == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            blank_range(&mut out, start, i);
            continue;
        }
        if c == b'"' {
            i += 1;
            while i < n && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            if i < n && bytes[i] == b'"' {
                i += 1;
            }
            continue;
        }
        // Char literal — keep simple: skip 'x' or '\x'
        if c == b'\'' {
            i += 1;
            while i < n && bytes[i] != b'\'' {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            if i < n && bytes[i] == b'\'' {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Static regex table — every fixed pattern of name-matcher.ts / index.ts.
// (?-u) gives ASCII \w/\b/\d exactly like JS; `\s` expands to the JS class S.
// ---------------------------------------------------------------------------

struct RPats {
    has_import_statement: Regex,
    has_esm_export: Regex,
    has_cjs_export: Regex,
    c_source_ext: Regex,
    rust_impl_header: Regex,
    rust_for: Regex,
    rust_line_comment: Regex,
    rust_top_item: Regex,
    bare_call_preceder: Regex,
    bare_call_keyword: Regex,
    local_import_init: Regex,
    barrel_index_file: Regex,
    type_only_default_import: Regex,
    dynamic_import_specifier: Regex,
    json_require_sig: Regex,
    rust_field_unwrap_ref: Regex,
    rust_field_unwrap_ptr: Regex,
    rust_field_unwrap_dyn: Regex,
    rust_field_strip: Regex,
    ident_full: Regex,
    upper_single: Regex,
    line_comment_strip: Regex,
    block_comment_strip: Regex,
    leading_upper: Regex,
    chain_shape: Regex,
    word_dollar_seq: Regex,
    store_accessor_shape: Regex,
    fn_ref_this_window: Regex,
    fn_ref_chain: Regex,
    selector_names: Regex,
    decl_store_binding: Regex,
    camel_a: Regex,
    camel_b: Regex,
    camel_split: Regex,
    regex_preceder: Regex,
    cpp_non_nested_generic: Regex,
    cpp_declarator_head: Regex,
    cpp_make_smart: Regex,
    cpp_new_init: Regex,
    cpp_call_init: Regex,
    cpp_ws: Regex,
    recv_new_decl: Regex,
    recv_factory_decl: Regex,
    recv_dotted_factory_decl: Regex,
    recv_annotation_decl: Regex,
    recv_annotation_full_decl: Regex,
    factory_awaited_init: Regex,
    annotation_awaited_init: Regex,
    simple_type_name: Regex,
    promise_wrapping: Regex,
    readonly_qualified: Regex,
}

fn rpats() -> &'static RPats {
    static P: OnceLock<RPats> = OnceLock::new();
    P.get_or_init(|| {
        let r = |s: String| Regex::new(&s).expect("resolver pattern");
        RPats {
            // /^[ \t]*import[\s{*'"]/m
            has_import_statement: r(format!("(?m)^[ \\t]*import[{S_INNER}{{}}*'\\\"]")),
            // /^[ \t]*export[\s{*]|^[ \t]*declare\s+global\b/m
            has_esm_export: r(format!("(?m)^[ \\t]*export[{S_INNER}{{*]|^[ \\t]*declare{S}+global\\b")),
            // /\bmodule\.exports\b|\bexports\s*[.[]/
            has_cjs_export: r(format!("\\bmodule\\.exports\\b|\\bexports{S}*[.\\[]")),
            // /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i
            c_source_ext: r("(?i)\\.(c|cc|cpp|cxx|c\\+\\+|m|mm)$".into()),
            // /^\s*(pub(\([^)]*\))?\s+)?(unsafe\s+)?impl\b/
            rust_impl_header: r(format!("^{S}*(pub(?:\\([^)]*\\))?{S}+)?(unsafe{S}+)?impl\\b")),
            // /\sfor\s/
            rust_for: r(format!("{S}for{S}")),
            // /\/\/.*$/ (single-line inputs)
            rust_line_comment: r("//.*$".into()),
            // /^(pub(\([^)]*\))?\s+)?(fn|struct|enum|mod|trait|const|static|type)\b/
            rust_top_item: r(format!("^(pub(?:\\([^)]*\\))?{S}+)?(fn|struct|enum|mod|trait|const|static|type)\\b")),
            // /[.\w$\]\)]\s*$/
            bare_call_preceder: r(format!("[.[0-9A-Za-z_]$\\])]{S}*$")),
            // /\b(?:return|await|yield|typeof|void|new|else|case|throw|in|of|instanceof|go|defer)\s*$/
            bare_call_keyword: r(format!("\\b(?:return|await|yield|typeof|void|new|else|case|throw|in|of|instanceof|go|defer){S}*$")),
            // /^\s*(?:await\s+)?(?:require|import)\s*\(/
            local_import_init: r(format!("^{S}*(?:await{S}+)?(?:require|import){S}*\\(")),
            // /^index\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)?$/
            barrel_index_file: r("^index\\.[A-Za-z0-9]+(\\.[A-Za-z0-9]+)?$".into()),
            // /\bimport\s+type\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g
            type_only_default_import: r(format!("\\bimport{S}+type{S}+([A-Za-z_$][\\w$]*){S}*(?:,{S}*\\{{[^}}]*\\}})?{S}*from{S}*['\\\"]([^'\\\"]+)['\\\"]")),
            // /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
            dynamic_import_specifier: r(format!("\\bimport{S}*\\({S}*['\\\"]([^'\\\"]+)['\\\"]{S}*\\)")),
            // /^=\s*require\s*\(\s*(['"])[^'"]+\.json\1\s*\)\s*;?\s*$/ — the \1
            // backref becomes two captures + a manual equality check.
            json_require_sig: r(format!("^={S}*require{S}*\\({S}*(['\\\"])[^'\\\"]+\\.json(['\\\"]){S}*\\){S}*;?{S}*$")),
            // /^&\s*(?:'\w+\s+)?(?:mut\s+)?/
            rust_field_unwrap_ref: r(format!("^&{S}*(?:'{S}*[0-9A-Za-z_]+{S}+)?(?:mut{S}+)?")),
            // NOTE the lifetime form is `'\w+\s+` — quote then word chars:
            // kept identical to TS (`/^&\s*(?:'\w+\s+)?(?:mut\s+)?/`).
            // /^(?:Box|Rc|Arc)\s*<\s*/
            rust_field_unwrap_ptr: r(format!("^(?:Box|Rc|Arc){S}*<{S}*")),
            // /^(?:dyn|impl)\s+/
            rust_field_unwrap_dyn: r(format!("^(?:dyn|impl){S}+")),
            // /[<>+].*$/
            rust_field_strip: r("[<>+].*$".into()),
            // /^[A-Za-z_]\w*$/
            ident_full: r("^[A-Za-z_][0-9A-Za-z_]*$".into()),
            // /^[A-Z]$/
            upper_single: r("^[A-Z]$".into()),
            // /\/\/.*$/
            line_comment_strip: r("//.*$".into()),
            // /\/\*.*?\*\//g
            block_comment_strip: r("/\\*.*?\\*/".into()),
            // /^[A-Z]/
            leading_upper: r("^[A-Z]".into()),
            // /^(.+)\(\)\.(\w+)$/ — CHAIN_SHAPE / the three chain matchers.
            chain_shape: r("^(.+)\\(\\)\\.([0-9A-Za-z_]+)$".into()),
            // /^[\w$]+$/
            word_dollar_seq: r("^[0-9A-Za-z_$]+$".into()),
            // /^([\w$.]+)\(\)\.(\w+)$/ — matchStoreAccessorChain.
            store_accessor_shape: r("^([0-9A-Za-z_$.]+)\\(\\)\\.([0-9A-Za-z_]+)$".into()),
            // /^(?:this|window)\./ — isUnresolvedJsMemberCall guard.
            fn_ref_this_window: r("^(?:this|window)\\.".into()),
            // /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/
            fn_ref_chain: r("^[A-Za-z_$][0-9A-Za-z_$]*(?:\\.[A-Za-z_$][0-9A-Za-z_$]*){2,}$".into()),
            // /\bconst\s+([\w$]+)\s*=\s*[\w$]+\s*\(\s*(?:\(\s*[\w$]+\s*\)|[\w$]+)\s*=>/g
            selector_names: r(format!("\\bconst{S}+([0-9A-Za-z_$]+){S}*={S}*[0-9A-Za-z_$]+{S}*\\({S}*(?:\\({S}*[0-9A-Za-z_$]+{S}*\\)|[0-9A-Za-z_$]+){S}*=>")),
            // /\bconst\s*\{([^{}]*)\}\s*=\s*([\w$]+)\.getState\s*\(\s*\)/g
            decl_store_binding: r(format!("\\bconst{S}*\\{{([^{{}}]*)\\}}{S}*={S}*([0-9A-Za-z_$]+)\\.getState{S}*\\({S}*\\)")),
            // splitCamelCase: /([a-z])([A-Z])/g, /([A-Z]+)([A-Z][a-z])/g, /[\s._:\/\\]+/
            camel_a: r("([a-z])([A-Z])".into()),
            camel_b: r("([A-Z]+)([A-Z][a-z])".into()),
            camel_split: r(format!("[{S_INNER}._:/\\\\]+")),
            // blankStringContents regex-literal lookbehind:
            // /(?:^|[=(:,)!&|?;{}\[\]+*%~^<>-]|\b(?:return|throw|case|yield|await|else|do|typeof|void|delete|new|in|of|instanceof))\s*$/
            regex_preceder: r(format!("(?:^|[=(:,)!&|?;{{}}\\[\\]+*%~^<>-]|\\b(?:return|throw|case|yield|await|else|do|typeof|void|delete|new|in|of|instanceof)){S}*$")),
            // /<[^<>]*>/g — chainReceiverTypeName non-nested generic strip.
            cpp_non_nested_generic: r("<[^<>]*>".into()),
            // buildDeclaratorRegex HEAD: ([A-Za-z_][\w:]*(?:\s*<[^;=(){}]+>)?(?:\s*[*&]+)?)
            cpp_declarator_head: r(format!("([A-Za-z_][0-9A-Za-z_:]*(?:{S}*<[^;=(){{}}]+>)?(?:{S}*[*&]+)?)")),
            // /(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/
            cpp_make_smart: r(format!("(?:^|::)(?:make_unique|make_shared){S}*<{S}*([A-Za-z_][0-9A-Za-z_]*)")),
            // /^new\s+([A-Za-z_][\w:]*)/
            cpp_new_init: r(format!("^new{S}+([A-Za-z_][0-9A-Za-z_:]*)")),
            // /^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/
            cpp_call_init: r(format!("^([A-Za-z_][0-9A-Za-z_:]*(?:{S}*<[^>;]*>)?){S}*\\(")),
            // /\s+/g
            cpp_ws: r(format!("{S}+")),
            // /\b(\w+)\s*=\s*new\s+([A-Za-z_$][\w$]*)/g
            recv_new_decl: r(format!("\\b([0-9A-Za-z_]+){S}*={S}*new{S}+([A-Za-z_$][0-9A-Za-z_$]*)")),
            // /\b(\w+)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g
            recv_factory_decl: r(format!("\\b([0-9A-Za-z_]+){S}*={S}*(?:await{S}+)?([A-Za-z_$][0-9A-Za-z_$]*){S}*\\(")),
            // /\b(\w+)\s*=\s*(?:await\s+)?((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)\s*\(/g
            recv_dotted_factory_decl: r(format!("\\b([0-9A-Za-z_]+){S}*={S}*(?:await{S}+)?((?:[A-Za-z_$][0-9A-Za-z_$]*\\.)+[A-Za-z_$][0-9A-Za-z_$]*){S}*\\(")),
            // /\b(\w+)\s*:\s*([A-Za-z_$][\w$.]*)\s*[=;]/g
            recv_annotation_decl: r(format!("\\b([0-9A-Za-z_]+){S}*:{S}*([A-Za-z_$][0-9A-Za-z_$.]*){S}*[=;]")),
            // /\b(?:const|let|var)\s+(\w+)\s*:\s*([^=;,\n)]+?)(?=\s*[=;,\n)])/g —
            // the lookahead is consumed as group 3; JS match.index bookkeeping
            // uses group-2 end (ANNOTATION_AWAITED_INIT tests the text BEFORE
            // the terminator, so the terminator must not be swallowed there).
            recv_annotation_full_decl: r(format!("\\b(?:const|let|var){S}+([0-9A-Za-z_]+){S}*:{S}*([^=;,\\n)]+?)({S}*[=;,\\n)])")),
            // /=\s*await\s/
            factory_awaited_init: r(format!("={S}*await{S}")),
            // /^\s*=\s*await\s/
            annotation_awaited_init: r(format!("^{S}*={S}*await{S}")),
            // /^[\w$.]+$/
            simple_type_name: r("^[0-9A-Za-z_$.]+$".into()),
            // /^Promise\s*<([^<>]+)>$/
            promise_wrapping: r(format!("^Promise{S}*<([^<>]+)>$")),
            // /^readonly\s+([\w$.]+)$/
            readonly_qualified: r(format!("^readonly{S}+([0-9A-Za-z_$.]+)$")),
            // import-resolver.ts:844 block-comment strip for re-export scans.
        }
    })
}

/// The S class WITHOUT brackets, for composing inside other classes.
const S_INNER: &str = "\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// Dynamic per-name/per-field patterns get the same ASCII treatment.
fn dyn_re(pattern: &str) -> Regex {
    Regex::new(&format!("{pattern}")).expect("resolver dynamic pattern")
}

// ---------------------------------------------------------------------------
// Memos — the six name-matcher WeakMap memos + the two file-property caches
// ---------------------------------------------------------------------------

// Constructed via Memos::new (Lru/FifoMap have no Default).
struct Memos {
    /// SEALED_MODULES (name-matcher.ts:71).
    sealed_modules: HashMap<String, bool>,
    /// C_STATIC_MEMO (:139) — node id → static.
    c_static: HashMap<String, bool>,
    /// RUST_TRAIT_IMPL_MEMO (:173) — node id → trait-impl method.
    rust_trait_impl: HashMap<String, bool>,
    /// LOCAL_BINDING_MEMO (:296) — `file\0name` → locally bound.
    local_binding: HashMap<String, bool>,
    /// IMPORT_SUPPLEMENT_CACHES (:493) — LRU 256.
    import_supplements: Lru<String, Vec<ImportMapping>>,
    /// RECEIVER_DECL_CACHES (:2199) — LRU 256; the TS identity-token rebuild
    /// is subsumed by the generation-keyed memo drop (see module docs).
    receiver_decls: Lru<String, HashMap<String, Vec<ReceiverDeclaration>>>,
    /// TYPED_FN_CACHES (:2598) — LRU 256.
    typed_fns: Lru<String, Vec<CtxNode>>,
    /// GET_STATE_FILES (:1738) — FIFO cap 8192, get does not refresh.
    get_state_files: FifoMap<String, bool>,
    /// SELECTOR_NAMES (:1791) — unbounded per-context map.
    selector_names: HashMap<String, HashSet<String>>,
}

impl Memos {
    fn new() -> Memos {
        Memos {
            sealed_modules: HashMap::new(),
            c_static: HashMap::new(),
            rust_trait_impl: HashMap::new(),
            local_binding: HashMap::new(),
            import_supplements: Lru::new(IMPORT_SUPPLEMENT_FILE_LIMIT),
            receiver_decls: Lru::new(RECEIVER_DECL_FILE_LIMIT),
            typed_fns: Lru::new(TYPED_FN_FILE_LIMIT),
            get_state_files: FifoMap::new(GET_STATE_FILES_CAP),
            selector_names: HashMap::new(),
        }
    }
}

const IMPORT_SUPPLEMENT_FILE_LIMIT: usize = 256;
const RECEIVER_DECL_FILE_LIMIT: usize = 256;
const TYPED_FN_FILE_LIMIT: usize = 256;
const GET_STATE_FILES_CAP: usize = 8192;

// ---------------------------------------------------------------------------
// Receiver-declaration evidence (Strategy 0.5)
// ---------------------------------------------------------------------------

/// ReceiverEvidenceKind (name-matcher.ts:2055) + RECEIVER_EVIDENCE_PRIORITY
/// (:2179-2183): new 2, annotation 1, factory 0.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReceiverEvidenceKind {
    New,
    Annotation,
    Factory,
}

impl ReceiverEvidenceKind {
    fn priority(&self) -> i32 {
        match self {
            ReceiverEvidenceKind::New => 2,
            ReceiverEvidenceKind::Annotation => 1,
            ReceiverEvidenceKind::Factory => 0,
        }
    }
}

#[derive(Clone, Debug)]
struct ReceiverDeclaration {
    kind: ReceiverEvidenceKind,
    /// 'new' → class name, 'annotation' → type name, 'factory' → callee name.
    name: String,
    line: i64,
    await_initialized: bool,
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/// The per-resolution-session strategy state (TS: the module-level WeakMap
/// memos keyed on the ResolutionContext + the resolver's ceiling). One
/// Resolver per resolve session; memos auto-drop on ctx invalidation.
pub(crate) struct Resolver {
    memos: Memos,
    ambiguous_ceiling: i64,
    seen_gen: u64,
    seen_epoch: u64,
}

impl Resolver {
    pub(crate) fn new(ctx: &CtxConn) -> Resolver {
        let (g, e) = ctx.invalidation_key();
        Resolver {
            memos: Memos::new(),
            ambiguous_ceiling: resolve_ambiguous_name_ceiling(),
            seen_gen: g,
            seen_epoch: e,
        }
    }

    /// clearNameMatcherMemos (name-matcher.ts:355-365) — plus the ceiling
    /// stays (TS module const). Called automatically when the ctx
    /// invalidation key moves; R3c-2 may also call it at explicit seams.
    pub(crate) fn clear_memos(&mut self) {
        self.memos = Memos::new();
    }

    fn sync_memos(&mut self, ctx: &CtxConn) {
        let (g, e) = ctx.invalidation_key();
        if (g, e) != (self.seen_gen, self.seen_epoch) {
            self.seen_gen = g;
            self.seen_epoch = e;
            self.clear_memos();
        }
    }

    // -----------------------------------------------------------------------
    // K-v2 P5-1 / D8 cross-file pseudo-edge defenses (name-matcher.ts:28-346)
    // -----------------------------------------------------------------------

    /// isSealedModule (name-matcher.ts:87-105).
    fn is_sealed_module(&mut self, ctx: &mut CtxConn, file_path: &str) -> Result<bool> {
        if let Some(hit) = self.memos.sealed_modules.get(file_path) {
            return Ok(*hit);
        }
        let source = ctx.read_file(file_path)?;
        let code = match &source {
            Some(s) => blank_string_contents(&strip_comments_for_regex(s, "typescript")),
            None => String::new(),
        };
        let p = rpats();
        let mut sealed = false;
        if let Some(src) = &source {
            if p.has_import_statement.is_match(&code) {
                let exported = ctx.nodes_in_file(file_path)?.iter().any(|n| n.is_exported == 1);
                sealed = !exported && !p.has_esm_export.is_match(&code) && !p.has_cjs_export.is_match(src);
            }
        }
        self.memos.sealed_modules.insert(file_path.to_string(), sealed);
        Ok(sealed)
    }

    /// isCrossFileReachable (name-matcher.ts:115-129).
    fn is_cross_file_reachable(&mut self, ctx: &mut CtxConn, c: &CtxNode, r: &RefIn) -> Result<bool> {
        if r.language != "markdown" && c.language == "markdown" {
            return Ok(false);
        }
        if r.reference_kind == "calls"
            && esm_family(&c.language)
            && (c.kind == "constant" || c.kind == "variable")
        {
            // /^=\s*require\s*\(\s*(['"])[^'"]+\.json\1\s*\)\s*;?\s*$/ — the
            // \1 backref ported as capture-equality.
            if let Some(sig) = &c.signature {
                if let Some(m) = rpats().json_require_sig.captures(sig) {
                    if m.get(1).map(|x| x.as_str()) == m.get(2).map(|x| x.as_str()) {
                        return Ok(false);
                    }
                }
            }
        }
        if c.file_path == r.file_path {
            return Ok(true);
        }
        if !esm_family(&c.language) {
            return Ok(true);
        }
        Ok(!self.is_sealed_module(ctx, &c.file_path)?)
    }

    /// isStaticCFunction (name-matcher.ts:157-170).
    fn is_static_c_function(&mut self, ctx: &mut CtxConn, c: &CtxNode) -> Result<bool> {
        if let Some(hit) = self.memos.c_static.get(&c.id) {
            return Ok(*hit);
        }
        let lines = self.effective_file_lines(ctx, &c.file_path)?;
        // JS `lines[startLine-2] ?? ''` and `lines[startLine-1] ?? ''` — a
        // negative or out-of-range index yields '' (JS array semantics).
        let js_line = |i: i64| -> String {
            if i < 0 {
                return String::new();
            }
            lines.get(i as usize).cloned().unwrap_or_default()
        };
        let head = format!("{}\n{}", js_line(c.start_line - 2), js_line(c.start_line - 1));
        let is_static = dyn_re(&format!("(^|[{S_INNER};}}])static{S}")).is_match(&head);
        self.memos.c_static.insert(c.id.clone(), is_static);
        Ok(is_static)
    }

    /// isRustTraitImplMethod (name-matcher.ts:181-203).
    fn is_rust_trait_impl_method(&mut self, ctx: &mut CtxConn, c: &CtxNode) -> Result<bool> {
        if c.kind != "method" {
            return Ok(false);
        }
        if let Some(hit) = self.memos.rust_trait_impl.get(&c.id) {
            return Ok(*hit);
        }
        let lines = self.effective_file_lines(ctx, &c.file_path)?;
        let p = rpats();
        let mut is_trait = false;
        let mut i = c.start_line - 2;
        while i >= 0 {
            let line = lines.get(i as usize).map(|s| s.as_str()).unwrap_or("");
            if p.rust_impl_header.is_match(line) {
                let no_comment = p.rust_line_comment.replace(line, "");
                is_trait = p.rust_for.is_match(&no_comment);
                break;
            }
            // A top-level item above the method means it was not inside an impl.
            if p.rust_top_item.is_match(line) {
                break;
            }
            i -= 1;
        }
        self.memos.rust_trait_impl.insert(c.id.clone(), is_trait);
        Ok(is_trait)
    }

    /// rustModuleDir (name-matcher.ts:211-216) — path.posix semantics.
    fn rust_module_dir(file_path: &str) -> String {
        let slash = file_path.rfind('/');
        let base = match slash {
            Some(i) => &file_path[i + 1..],
            None => file_path,
        };
        let dir = match slash {
            Some(0) => "/",
            Some(i) => &file_path[..i],
            None => ".",
        };
        if base == "mod.rs" || base == "lib.rs" || base == "main.rs" {
            return dir.to_string();
        }
        let stem = base.strip_suffix(".rs").unwrap_or(base);
        if dir == "." {
            return stem.to_string();
        }
        format!("{dir}/{stem}")
    }

    /// isVisibleAcrossFiles (name-matcher.ts:243-267) — exported to
    /// resolveOne's post-pipeline guard.
    pub(crate) fn is_visible_across_files(&mut self, ctx: &mut CtxConn, c: &CtxNode, r: &RefIn) -> Result<bool> {
        if c.file_path == r.file_path {
            return Ok(true);
        }
        let lang = c.language.as_str();
        if lang == "c" || lang == "cpp" {
            return Ok(c.kind != "function"
                || !rpats().c_source_ext.is_match(&c.file_path)
                || !self.is_static_c_function(ctx, c)?);
        }
        if lang == "go" {
            // By the name's first letter, not the extractor's flag.
            if c.name.starts_with(|ch: char| ch.is_ascii_uppercase()) {
                return Ok(true);
            }
            return Ok(posix_dirname(&c.file_path) == posix_dirname(&r.file_path));
        }
        if lang == "rust" {
            if c.visibility.as_deref() != Some("private") {
                return Ok(true);
            }
            if self.is_rust_trait_impl_method(ctx, c)? {
                return Ok(true);
            }
            let owner = Self::rust_module_dir(&c.file_path);
            return Ok(r.file_path.starts_with(&format!("{owner}/")));
        }
        if private_is_file_local(lang) {
            return Ok(c.visibility.as_deref() != Some("private"));
        }
        // JS/TS/ArkTS sealed modules + markdown/JSON call-target guards (#1719).
        self.is_cross_file_reachable(ctx, c, r)
    }

    /// isBareJsCall (name-matcher.ts:282-284).
    fn is_bare_js_call(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<bool> {
        Ok(js_family(&r.language) && self.is_receiver_less_call(ctx, r)?)
    }

    /// isBareGoCall (name-matcher.ts:286-298) — a Go method is only reachable
    /// through a value or a method expression, so a receiver-less `calls` ref
    /// (func parameter, local func value, package-level function) is never a
    /// method, in its own package or an unimported one (#1857).
    fn is_bare_go_call(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<bool> {
        Ok(r.language == "go" && self.is_receiver_less_call(ctx, r)?)
    }

    /// isReceiverLessCall (name-matcher.ts:300-310). `column` is a UTF-16
    /// code-unit offset — the line slices use the js_slice helpers.
    fn is_receiver_less_call(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<bool> {
        if r.reference_kind != "calls" {
            return Ok(false);
        }
        if r.reference_name.contains('.') {
            return Ok(false);
        }
        let line_opt = self.column_source_line(ctx, r)?;
        let Some(line) = line_opt else { return Ok(false) };
        let col = r.column.max(0) as usize;
        let at = js_slice_from(&line, col);
        let name_esc = regex::escape(&r.reference_name);
        if !dyn_re(&format!("^{name_esc}{S}*[(<]")).is_match(&at) {
            return Ok(false);
        }
        // Nothing but whitespace, an operator or an opener may precede a bare call.
        let before = js_slice_to(&line, col);
        Ok(!rpats().bare_call_preceder.is_match(before) || rpats().bare_call_keyword.is_match(before))
    }

    /// The call-site line for column-relative reads: getFileLines?.[line-1]
    /// ?? readFile-split[line-1] — both arms are content.split('\n') based,
    /// so one lookup serves both (the ?? fires only when getFileLines yields
    /// [], i.e. an unreadable file, where the split arm also misses).
    fn column_source_line(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<String>> {
        let idx = (r.line - 1).max(0) as usize;
        Ok(ctx.file_lines(&r.file_path)?.get(idx).cloned())
    }

    /// isLocallyBoundJsName (name-matcher.ts:311-346).
    fn is_locally_bound_js_name(&mut self, ctx: &mut CtxConn, name: &str, file_path: &str) -> Result<bool> {
        let key = format!("{file_path}\0{name}");
        if let Some(hit) = self.memos.local_binding.get(&key) {
            return Ok(*hit);
        }
        let source = ctx.read_file(file_path)?.unwrap_or_default();
        let n = regex::escape(name);
        // `const { name } = require('./m')` / `= await import('./m')` binds an
        // IMPORT, not a shadow.
        let decl_re = dyn_re(&format!(
            "\\b(?:const|let|var){S}+(?:{n}\\b|[{{\\[][^;=]*?\\b{n}\\b[^;=]*?[}}\\]]){S}*(?:={S}*([^;\\n]*))?"
        ));
        let mut bound = false;
        for m in decl_re.captures_iter(&source) {
            let init = m.get(1).map(|x| x.as_str()).unwrap_or("");
            if !rpats().local_import_init.is_match(init) {
                bound = true;
                break;
            }
        }
        if !bound {
            bound = dyn_re(&format!("\\b(?:function|class){S}+{n}\\b")).is_match(&source)
                || dyn_re(&format!(
                    "\\({S}*(?:(?:\\.\\.\\.)?[0-9A-Za-z_$]+(?:{S}*\\??{S}*:{S}*[^,()]+)?(?:{S}*={S}*[^,()]+)?{S}*,{S}*)*{n}\\b(?:{S}*\\??{S}*:[^,()]*)?(?:{S}*=[^,()]*)?(?:{S}*,{S}*[^()]*)?\\){S}*(?::[^=;{{]*)?(?:=>|\\{{)"
                )).is_match(&source)
                || dyn_re(&format!("(?:^|[^0-9A-Za-z_$.]){n}{S}*=>")).is_match(&source);
        }
        self.memos.local_binding.insert(key, bound);
        Ok(bound)
    }

    // -----------------------------------------------------------------------
    // Import-aware veto (name-matcher.ts:367-532)
    // -----------------------------------------------------------------------

    /// fileTailNoExt (:392-396).
    fn file_tail_no_ext(file_path: &str) -> &str {
        let tail = match file_path.rfind('/') {
            Some(i) => &file_path[i + 1..],
            None => file_path,
        };
        match tail.rfind('.') {
            Some(dot) if dot > 0 => &tail[..dot],
            _ => tail,
        }
    }

    /// normalizeRelativeSegments (:410-422) — None when the walk escapes root.
    fn normalize_relative_segments(segments: &[&str]) -> Option<Vec<String>> {
        let mut out: Vec<String> = Vec::new();
        for seg in segments {
            if seg.is_empty() || *seg == "." {
                continue;
            }
            if *seg == ".." {
                if out.is_empty() {
                    return None;
                }
                out.pop();
                continue;
            }
            out.push(seg.to_string());
        }
        Some(out)
    }

    /// barrelImportReachesFile (:432-445).
    fn barrel_import_reaches_file(r: &RefIn, candidate_file_path: &str, source: &str) -> bool {
        if !source.starts_with("./") && !source.starts_with("../") {
            return false;
        }
        let candidate_segments = js_split(candidate_file_path, '/');
        let candidate_tail = candidate_segments.last().map(|s| s.as_str()).unwrap_or("");
        if !rpats().barrel_index_file.is_match(candidate_tail) {
            return false;
        }
        let file_segs = js_split(&r.file_path, '/');
        let mut segs: Vec<&str> = file_segs.iter().map(|s| s.as_str()).collect();
        segs.pop(); // slice(0, -1)
        segs.extend(source.split('/'));
        let Some(resolved) = Self::normalize_relative_segments(&segs) else { return false };
        let candidate_dir = &candidate_segments[..candidate_segments.len() - 1];
        if candidate_dir.len() != resolved.len() {
            return false;
        }
        resolved.iter().enumerate().all(|(i, s)| candidate_dir[i] == *s)
    }

    /// relativeSourceNamesFile (:2457-2470) — strict path identity.
    fn relative_source_names_file(candidate_file_path: &str, r: &RefIn, source: &str) -> bool {
        if !source.starts_with("./") && !source.starts_with("../") {
            return false;
        }
        let file_segs = js_split(&r.file_path, '/');
        let mut segs: Vec<&str> = file_segs.iter().map(|s| s.as_str()).collect();
        segs.pop();
        segs.extend(source.split('/'));
        let Some(resolved) = Self::normalize_relative_segments(&segs) else { return false };
        let candidate_segments = js_split(candidate_file_path, '/');
        let file_tail = Self::file_tail_no_ext(candidate_segments.last().map(|s| s.as_str()).unwrap_or(""));
        if resolved.last().map(|s| s.as_str()) != Some(file_tail) {
            return false;
        }
        let candidate_dir = &candidate_segments[..candidate_segments.len() - 1];
        if candidate_dir.len() + 1 != resolved.len() {
            return false;
        }
        candidate_dir.iter().enumerate().all(|(i, s)| resolved[i] == **s)
    }

    /// refImportMappings (:447-459) — base mappings + ALLOW-only supplements.
    fn ref_import_mappings(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Vec<ImportMapping>> {
        let base = ctx.import_mappings(&r.file_path, &r.language)?;
        if base.is_empty() {
            return Ok(base);
        }
        let extras = self.import_supplements_for_file(ctx, &r.file_path)?;
        if extras.is_empty() {
            return Ok(base);
        }
        let seen: HashSet<(String, String)> =
            base.iter().map(|m| (m.local_name.clone(), m.source.clone())).collect();
        let mut out = base;
        for m in extras {
            if !seen.contains(&(m.local_name.clone(), m.source.clone())) {
                out.push(m);
            }
        }
        Ok(out)
    }

    /// crossFileCandidateAllowed (:461-479).
    fn cross_file_candidate_allowed(r: &RefIn, c: &CtxNode, imports: &[ImportMapping]) -> bool {
        if c.file_path == r.file_path {
            return true;
        }
        if imports.is_empty() {
            return true;
        }
        let candidate_tail = Self::file_tail_no_ext(&c.file_path);
        for imp in imports {
            if imp.local_name == r.reference_name || r.reference_name.starts_with(&format!("{}.", imp.local_name)) {
                return true;
            }
            // resolvedPath is never set by extractImportMappings (TS-side
            // resolution fills it) — the arm stays for wire-table parity.
            let resolved_matches = false;
            if resolved_matches {
                return true;
            }
            if Self::file_tail_no_ext(&imp.source) == candidate_tail {
                return true;
            }
            if Self::barrel_import_reaches_file(r, &c.file_path, &imp.source) {
                return true;
            }
        }
        false
    }

    /// importSupplementsForFile (:496-532) — type-only default imports and
    /// dynamic specifiers as ALLOW-only ImportMapping supplements.
    fn import_supplements_for_file(&mut self, ctx: &mut CtxConn, file_path: &str) -> Result<Vec<ImportMapping>> {
        if let Some(hit) = self.memos.import_supplements.get(&file_path.to_string()) {
            return Ok(hit.clone());
        }
        let source = ctx.read_file(file_path)?;
        let mut supplements: Vec<ImportMapping> = Vec::new();
        if let Some(src) = &source {
            let p = rpats();
            for m in p.type_only_default_import.captures_iter(src) {
                supplements.push(ImportMapping {
                    local_name: m[1].to_string(),
                    exported_name: "default".to_string(),
                    source: m[2].to_string(),
                    is_default: true,
                    is_namespace: false,
                });
            }
            let mut seen_specifiers: HashSet<String> = HashSet::new();
            for m in p.dynamic_import_specifier.captures_iter(src) {
                let spec = m[1].to_string();
                if !seen_specifiers.insert(spec.clone()) {
                    continue;
                }
                supplements.push(ImportMapping {
                    local_name: String::new(),
                    exported_name: String::new(),
                    source: spec,
                    is_default: false,
                    is_namespace: false,
                });
            }
        }
        self.memos.import_supplements.set(file_path.to_string(), supplements.clone());
        Ok(supplements)
    }

    // -----------------------------------------------------------------------
    // Strategies — name-matcher.ts
    // -----------------------------------------------------------------------

    /// matchByFilePath (:538-584).
    pub(crate) fn match_by_file_path(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        if !r.reference_name.contains('/') {
            return Ok(None);
        }
        let file_name = r.reference_name.rsplit('/').next().unwrap_or("");
        if file_name.is_empty() {
            return Ok(None);
        }
        let candidates = ctx.nodes_by_name(file_name)?;
        let file_nodes: Vec<&CtxNode> = candidates.iter().filter(|n| n.kind == "file").collect();
        if file_nodes.is_empty() {
            return Ok(None);
        }
        // Prefer exact path match on qualified_name
        if let Some(hit) = file_nodes.iter().find(|n| {
            n.qualified_name == r.reference_name || n.file_path == r.reference_name
        }) {
            return Ok(Some(Resolved::new(hit.id.clone(), ResolvedBy::FilePath)));
        }
        // Suffix match
        if let Some(hit) = file_nodes.iter().find(|n| {
            n.qualified_name.ends_with(&r.reference_name) || n.file_path.ends_with(&r.reference_name)
        }) {
            return Ok(Some(Resolved::new(hit.id.clone(), ResolvedBy::FilePath)));
        }
        if file_nodes.len() == 1 {
            return Ok(Some(Resolved::new(file_nodes[0].id.clone(), ResolvedBy::FilePath)));
        }
        Ok(None)
    }

    /// matchByExactName (:589-663).
    pub(crate) fn match_by_exact_name(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let bare_js = self.is_bare_js_call(ctx, r)?;
        let bare_go = self.is_bare_go_call(ctx, r)?;
        if bare_js {
            if let Some(hit) = self.match_js_store_binding_call(ctx, r, ext)? {
                return Ok(Some(hit));
            }
        }
        let all = ctx.nodes_by_name(&r.reference_name)?;
        let mut candidates: Vec<CtxNode> = Vec::new();
        for n in all {
            if n.kind == "import" {
                continue;
            }
            // Restrict the pool BEFORE ranking for inheritance refs
            // (#1536/#2029) — mirrors name-matcher.ts's isSupertypeTarget
            // filter: a same-named non-type (Scala companion object, Rust
            // enum variant) must never win an extends/implements ref.
            if is_inheritance_ref(r) && !is_supertype_target(&n) {
                continue;
            }
            if r.reference_kind == "imports"
                && n.file_path != r.file_path
                && esm_family(&n.language)
                && self.is_sealed_module(ctx, &n.file_path)?
            {
                continue;
            }
            // A receiver-less JS/TS or Go call cannot reach a method (#1714, #1857).
            if (bare_js || bare_go) && n.kind == "method" {
                continue;
            }
            if bare_js
                && n.file_path != r.file_path
                && self.is_locally_bound_js_name(ctx, &r.reference_name, &r.file_path)?
            {
                continue;
            }
            candidates.push(n);
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        let imports = self.ref_import_mappings(ctx, r)?;
        let reachable: Vec<CtxNode> = candidates
            .into_iter()
            .filter(|n| Self::cross_file_candidate_allowed(r, n, &imports))
            .collect();
        if reachable.is_empty() {
            return Ok(None);
        }
        if reachable.len() == 1 {
            if !self.is_cross_file_reachable(ctx, &reachable[0], r)? {
                return Ok(None);
            }
            return Ok(Some(Resolved::new(reachable[0].id.clone(), ResolvedBy::ExactMatch)));
        }
        // O(K²) stall protection — mirrors AMBIGUOUS_NAME_CEILING.
        if reachable.len() as i64 > self.ambiguous_ceiling {
            return Ok(None);
        }
        let best = find_best_match(r, &reachable);
        if let Some(b) = best {
            if self.is_cross_file_reachable(ctx, &b, r)? {
                return Ok(Some(Resolved::new(b.id.clone(), ResolvedBy::ExactMatch)));
            }
        }
        Ok(None)
    }

    /// matchByQualifiedName (:668-704).
    pub(crate) fn match_by_qualified_name(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        if !r.reference_name.contains("::") && !r.reference_name.contains('.') {
            return Ok(None);
        }
        let candidates = ctx.nodes_by_qualified_name(&r.reference_name)?;
        if candidates.len() == 1 {
            return Ok(Some(Resolved::new(candidates[0].id.clone(), ResolvedBy::QualifiedName)));
        }
        // Partial qualified name match — split(/[:.]/), last segment.
        let parts: Vec<&str> = r.reference_name.split([':', '.']).collect();
        let last_name = parts.last().copied().unwrap_or("");
        if !last_name.is_empty() {
            let partial = ctx.nodes_by_name(last_name)?;
            for c in &partial {
                if c.qualified_name.ends_with(&r.reference_name) {
                    return Ok(Some(Resolved::new(c.id.clone(), ResolvedBy::QualifiedName)));
                }
            }
        }
        Ok(None)
    }

    /// resolveMethodOnType (:706-761).
    fn resolve_method_on_type(
        &mut self,
        ctx: &mut CtxConn,
        type_name: &str,
        method_name: &str,
        r: &RefIn,
        resolved_by: ResolvedBy,
        preferred_fqn: Option<&str>,
    ) -> Result<Option<Resolved>> {
        let method_candidates = ctx.nodes_by_name(method_name)?;
        let want = format!("{type_name}::{method_name}");
        let want_suffix = format!("::{want}");
        let mut matches: Vec<&CtxNode> = Vec::new();
        for m in &method_candidates {
            if m.kind != "method" {
                continue;
            }
            if m.language != r.language {
                continue;
            }
            if m.qualified_name == want || m.qualified_name.ends_with(&want_suffix) {
                matches.push(m);
            }
        }
        if matches.is_empty() {
            return Ok(None);
        }
        if matches.len() > 1 {
            if let Some(fqn) = preferred_fqn {
                // #314 — the imported FQN's file-path suffix picks the right
                // same-qualifiedName declaration.
                let ext = if r.language == "kotlin" { ".kt" } else { ".java" };
                let fqn_path = format!("{}{ext}", fqn.replace('.', "/"));
                if let Some(chosen) = matches.iter().find(|m| {
                    let fp = m.file_path.replace('\\', "/");
                    fp.ends_with(&fqn_path) || fp.ends_with(&format!("/{fqn_path}"))
                }) {
                    return Ok(Some(Resolved::new(chosen.id.clone(), resolved_by)));
                }
            }
        }
        Ok(Some(Resolved::new(matches[0].id.clone(), resolved_by)))
    }

    // -- C++ receiver/chain inference (:763-1050) ---------------------------

    /// normalizeCppTypeName (:772-786).
    fn normalize_cpp_type_name(type_name: &str) -> Option<String> {
        let mut normalized = dyn_re("\\b(const|volatile|mutable|typename|class|struct)\\b")
            .replace_all(type_name, " ")
            .into_owned();
        normalized = dyn_re("[&*]+").replace_all(&normalized, " ").into_owned();
        normalized = rpats().cpp_non_nested_generic.replace_all(&normalized, " ").into_owned();
        normalized = rpats().cpp_ws.replace_all(&normalized, " ").into_owned();
        let normalized = js_trim(&normalized).to_string();
        if normalized.is_empty() {
            return None;
        }
        let parts: Vec<&str> = normalized.split("::").filter(|s| !s.is_empty()).collect();
        let last = parts.last().copied()?;
        if last.is_empty() {
            return None;
        }
        if cpp_non_type_tokens().contains(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// inferCppReceiverType (:799-859).
    fn infer_cpp_receiver_type(
        &mut self,
        ctx: &mut CtxConn,
        receiver_name: &str,
        r: &RefIn,
        depth: usize,
    ) -> Result<Option<String>> {
        let lines = ctx.file_lines(&r.file_path)?;
        if lines.is_empty() {
            return Ok(None);
        }
        let call_line_index = ((r.line - 1).max(0) as usize).min(lines.len() - 1);
        let escaped = regex::escape(receiver_name);
        let receiver_pattern = dyn_re(&format!("\\b{escaped}\\b"));
        // buildDeclaratorRegex — the TS lookahead `(?=[;=,)\[{(]|$)` becomes a
        // consumed terminator: it cannot shift the leftmost match (a
        // terminator char never starts `\b(?:[A-Za-z_]...)`) and group 1 is
        // untouched.
        let declarator = dyn_re(&format!(
            "([A-Za-z_][0-9A-Za-z_:]*(?:{S}*<[^;=(){{}}]+>)?(?:{S}*[*&]+)?){S}*\\b{escaped}\\b{S}*(?:[;=,)\\[{{(]|$)"
        ));
        for i in (0..=call_line_index).rev() {
            let line = &lines[i];
            if !receiver_pattern.is_match(line) {
                continue;
            }
            if let Some(m) = declarator.captures(line) {
                let normalized = Self::normalize_cpp_type_name(m.get(1).map(|x| x.as_str()).unwrap_or(""));
                match normalized.as_deref() {
                    Some("auto") => {
                        // `auto x = Foo::instance();` — recover from the initializer (#645).
                        if let Some(t) = self.infer_cpp_auto_initializer_type(ctx, line, receiver_name, r, depth)? {
                            return Ok(Some(t));
                        }
                        // No usable initializer on this line — keep scanning earlier ones.
                    }
                    Some(_) => return Ok(normalized),
                    None => {}
                }
            }
        }
        // Header siblings (.h/.hpp/.hxx), deduped, excluding the source file.
        let mut header_candidates: Vec<String> = Vec::new();
        for ext in [".h", ".hpp", ".hxx"] {
            let candidate = dyn_re("\\.(?:c|cc|cpp|cxx)$")
                .replace(&r.file_path, ext)
                .into_owned();
            if !header_candidates.contains(&candidate) && candidate != r.file_path {
                header_candidates.push(candidate);
            }
        }
        for header_path in &header_candidates {
            if !ctx.file_exists(header_path)? {
                continue;
            }
            let header_lines = ctx.file_lines(header_path)?;
            for line in &header_lines {
                if !receiver_pattern.is_match(line) {
                    continue;
                }
                let Some(m) = declarator.captures(line) else { continue };
                let normalized = Self::normalize_cpp_type_name(m.get(1).map(|x| x.as_str()).unwrap_or(""));
                if let Some(nm) = normalized {
                    if nm != "auto" {
                        return Ok(Some(nm));
                    }
                }
            }
        }
        Ok(None)
    }

    /// cppLastSegment (:878-881).
    fn cpp_last_segment(name: &str) -> String {
        name.split("::")
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(name)
            .to_string()
    }

    /// chainReceiverTypeName (:900-911).
    fn chain_receiver_type_name(raw: Option<&str>) -> Option<String> {
        let raw = raw?;
        let mut t = js_trim(raw).to_string();
        if t.is_empty() {
            return None;
        }
        if t == "Self" || t == "self" || t == "static" {
            return Some("self".to_string());
        }
        // rust lifetimes: /'\w+\s*/g
        t = dyn_re(&format!("'[0-9A-Za-z_]+{S}*")).replace_all(&t, "").into_owned();
        // /^(?:const\s+)?(?:mut\s+)?[*&\s]+/
        t = dyn_re(&format!("^(?:const{S}+)?(?:mut{S}+)?[*&{S_INNER}]+"))
            .replace(&t, "")
            .into_owned();
        // /<[^<>]*>/g then /\?+\s*$/
        t = rpats().cpp_non_nested_generic.replace_all(&t, "").into_owned();
        t = dyn_re(&format!("\\?+{S}*$")).replace(&t, "").into_owned();
        let t = js_trim(&t);
        // split(/::|\./) — segments on "::" or ".", keep the last non-empty.
        let parts: Vec<&str> = split_colon_or_dot(t);
        let last = parts.iter().filter(|s| !s.is_empty()).last().copied()?;
        if last.is_empty() || !rpats().ident_full.is_match(last) {
            return None;
        }
        Some(last.to_string())
    }

    /// lookupCalleeReturnType (:921-954).
    fn lookup_callee_return_type(&mut self, ctx: &mut CtxConn, callee: &str, r: &RefIn) -> Result<Option<String>> {
        let mut method = callee;
        let mut cls: Option<String> = None;
        if callee.contains("::") {
            let parts: Vec<&str> = callee.split("::").filter(|s| !s.is_empty()).collect();
            method = parts.last().copied().unwrap_or(callee);
            cls = Some(parts[..parts.len() - 1].join("::"));
        }
        let all = ctx.nodes_by_name(method)?;
        let candidates: Vec<&CtxNode> = all
            .iter()
            .filter(|n| {
                (n.kind == "method" || n.kind == "function")
                    && n.language == r.language
                    && n.return_type.is_some()
            })
            .collect();
        if let Some(cls) = cls {
            let want = format!("{cls}::{method}");
            let m = candidates.iter().find(|n| {
                n.qualified_name == want
                    || n.qualified_name.ends_with(&format!("::{want}"))
                    || want.ends_with(&format!("::{}", n.qualified_name))
            });
            return Ok(Self::chain_receiver_type_name(m.and_then(|n| n.return_type.as_deref())));
        }
        let f = candidates.iter().find(|n| n.kind == "function");
        Ok(Self::chain_receiver_type_name(f.and_then(|n| n.return_type.as_deref())))
    }

    /// cppClassExists (:957-962).
    fn cpp_class_exists(&mut self, ctx: &mut CtxConn, name: &str, r: &RefIn) -> Result<bool> {
        let last = Self::cpp_last_segment(name);
        Ok(ctx
            .nodes_by_name(&last)?
            .iter()
            .any(|n| (n.kind == "class" || n.kind == "struct" || n.kind == "union") && n.language == r.language))
    }

    /// resolveCppCallResultType (:975-1005).
    fn resolve_cpp_call_result_type(
        &mut self,
        ctx: &mut CtxConn,
        inner: &str,
        r: &RefIn,
        depth: usize,
    ) -> Result<Option<String>> {
        if depth > 3 {
            return Ok(None); // guard against pathological mutual recursion
        }
        let expr = js_trim(inner);
        if let Some(m) = rpats().cpp_make_smart.captures(expr) {
            return Ok(Some(m[1].to_string()));
        }
        // Single-level member call `recv.method`.
        if let Some(dot_idx) = expr.rfind('.') {
            if dot_idx > 0 {
                let recv = &expr[..dot_idx];
                let method = &expr[dot_idx + 1..];
                if recv.contains('.') || recv.contains('(') || recv.contains("::") {
                    return Ok(None); // single level only
                }
                let Some(recv_type) = self.infer_cpp_receiver_type(ctx, recv, r, depth + 1)? else {
                    return Ok(None);
                };
                return self.lookup_callee_return_type(ctx, &format!("{recv_type}::{method}"), r);
            }
        }
        if let Some(ret) = self.lookup_callee_return_type(ctx, expr, r)? {
            return Ok(Some(ret));
        }
        // Direct construction — the callee itself names a class/struct.
        if self.cpp_class_exists(ctx, expr, r)? {
            return Ok(Some(Self::cpp_last_segment(expr)));
        }
        Ok(None)
    }

    /// inferCppAutoInitializerType (:1012-1032).
    fn infer_cpp_auto_initializer_type(
        &mut self,
        ctx: &mut CtxConn,
        line: &str,
        receiver_name: &str,
        r: &RefIn,
        depth: usize,
    ) -> Result<Option<String>> {
        let escaped = regex::escape(receiver_name);
        let re = dyn_re(&format!("\\b{escaped}\\b{S}*={S}*([^;]+)"));
        let Some(m) = re.captures(line) else { return Ok(None) };
        let init = js_trim(&m[1]);
        if init.is_empty() {
            return Ok(None);
        }
        if let Some(neu) = rpats().cpp_new_init.captures(init) {
            return Ok(Some(Self::cpp_last_segment(&neu[1])));
        }
        // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
        if let Some(call) = rpats().cpp_call_init.captures(init) {
            let head = rpats().cpp_ws.replace_all(&call[1], "").into_owned();
            return self.resolve_cpp_call_result_type(ctx, &head, r, depth + 1);
        }
        Ok(None)
    }

    /// matchCppCallChain (:1041-1050).
    pub(crate) fn match_cpp_call_chain(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        let Some(m) = rpats().chain_shape.captures(&r.reference_name) else {
            return Ok(None);
        };
        let inner = &m[1];
        let method = &m[2];
        if inner.is_empty() || method.is_empty() {
            return Ok(None);
        }
        let Some(cls) = self.resolve_cpp_call_result_type(ctx, inner, r, 0)? else {
            return Ok(None);
        };
        self.resolve_method_on_type(ctx, &cls, method, r, ResolvedBy::InstanceMethod, None)
    }

    /// matchScopedCallChain (:1061-1076).
    pub(crate) fn match_scoped_call_chain(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        let Some(m) = rpats().chain_shape.captures(&r.reference_name) else {
            return Ok(None);
        };
        let inner = m[1].to_string();
        let method = m[2].to_string();
        if inner.is_empty() || method.is_empty() {
            return Ok(None);
        }
        if !inner.contains("::") {
            return Ok(None); // only static-factory (`Cls::method`) chains
        }
        let factory_class = &inner[..inner.rfind("::").unwrap()];
        let Some(ret) = self.lookup_callee_return_type(ctx, &inner, r)? else {
            return Ok(None);
        };
        // `self` (the extractor's marker for self/static/$this) → the factory's class.
        let resolved_class = if ret == "self" { factory_class } else { &ret };
        self.resolve_method_on_type(ctx, resolved_class, &method, r, ResolvedBy::InstanceMethod, None)
    }

    /// importedFqnOf (:1183-1190).
    fn imported_fqn_of(&mut self, ctx: &mut CtxConn, type_name: &str, r: &RefIn) -> Result<Option<String>> {
        let imports = ctx.import_mappings(&r.file_path, &r.language)?;
        Ok(imports
            .iter()
            .find(|i| i.local_name == type_name)
            .map(|i| i.source.clone()))
    }

    /// matchDottedCallChain (:1099-1176).
    pub(crate) fn match_dotted_call_chain(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let Some(m) = rpats().chain_shape.captures(&r.reference_name) else {
            return Ok(None);
        };
        let inner = m[1].to_string(); // `Foo.getInstance`
        let method = m[2].to_string(); // `bar`
        if inner.is_empty() || method.is_empty() {
            return Ok(None);
        }
        let last_dot = inner.rfind('.').map(|i| i as i64).unwrap_or(-1);
        if last_dot <= 0 {
            // Go: bare package-level factory FUNCTION `New().method()`.
            if r.language == "go" {
                if let Some(ret) = self.lookup_callee_return_type(ctx, &inner, r)? {
                    let fqn = self.imported_fqn_of(ctx, &ret, r)?;
                    return self.resolve_method_on_type(
                        ctx,
                        &ret,
                        &method,
                        r,
                        ResolvedBy::InstanceMethod,
                        fqn.as_deref(),
                    );
                }
                // `inner` isn't a function with a captured return type — fall
                // back to bare-name resolution of the method. CRITICAL (#1269):
                // resolve via a SYNTHETIC bare-name ref but return the match
                // tied to the ORIGINAL ref, or the batched resolver's tuple
                // delete never drains and the loop re-inserts forever.
                let bare = r.with_name(&method, None);
                let bare_match = match self.match_by_exact_name(ctx, &bare, ext)? {
                    Some(hit) => Some(hit),
                    None => self.match_fuzzy(ctx, &bare)?,
                };
                return Ok(bare_match);
            }
            // Constructor receiver `Foo(args).method()` (encoded `Foo().method`).
            if !constructs_via_bare_call(&r.language) || !rpats().leading_upper.is_match(&inner) {
                return Ok(None);
            }
            let fqn = self.imported_fqn_of(ctx, &inner, r)?;
            return self.resolve_method_on_type(
                ctx,
                &inner,
                &method,
                r,
                ResolvedBy::InstanceMethod,
                fqn.as_deref(),
            );
        }
        // Factory/fluent receiver `Receiver.factory(args).method()`.
        let head = &inner[..last_dot as usize];
        let factory_class = head.rsplit('.').next().unwrap_or(""); // simple class name
        let factory_method = &inner[last_dot as usize + 1..];
        if factory_class.is_empty() || factory_method.is_empty() {
            return Ok(None);
        }
        let ret = self.lookup_callee_return_type(ctx, &format!("{factory_class}::{factory_method}"), r)?;
        match ret {
            None => {
                // Objective-C class-message factory ([X alloc]/[X new]/…) →
                // instancetype convention, validated by resolveMethodOnType.
                if r.language == "objc" && rpats().leading_upper.is_match(factory_class) {
                    let fqn = self.imported_fqn_of(ctx, factory_class, r)?;
                    return self.resolve_method_on_type(
                        ctx,
                        factory_class,
                        &method,
                        r,
                        ResolvedBy::InstanceMethod,
                        fqn.as_deref(),
                    );
                }
                // Pascal/Delphi: `TFoo`/`IFoo`-prefixed chain — an uncaptured
                // factory return type is a constructor; the receiver's type is
                // the class itself.
                if r.language == "pascal" && factory_class.starts_with(['T', 'I']) {
                    let fqn = self.imported_fqn_of(ctx, factory_class, r)?;
                    return self.resolve_method_on_type(
                        ctx,
                        factory_class,
                        &method,
                        r,
                        ResolvedBy::InstanceMethod,
                        fqn.as_deref(),
                    );
                }
                Ok(None)
            }
            Some(ret) => {
                let fqn = self.imported_fqn_of(ctx, &ret, r)?;
                self.resolve_method_on_type(ctx, &ret, &method, r, ResolvedBy::InstanceMethod, fqn.as_deref())
            }
        }
    }

    // -- lexical reachability / call-site preference (:1214-1273) -----------

    /// isLexicallyReachable (:1228-1255).
    fn is_lexically_reachable(&mut self, ctx: &mut CtxConn, c: &CtxNode, r: &RefIn) -> Result<bool> {
        if c.kind != "function" {
            return Ok(true);
        }
        // C/C++ have no nested named functions — nesting is an extraction artifact.
        if no_nested_functions(&c.language) {
            return Ok(true);
        }
        let qn = c.qualified_name.as_str();
        if qn.is_empty() || !qn.contains("::") {
            return Ok(true);
        }
        let parent_qn = &qn[..qn.rfind("::").unwrap()];
        let parents = ctx.nodes_by_qualified_name(parent_qn)?;
        let containers: Vec<&CtxNode> = parents
            .iter()
            .filter(|p| {
                p.file_path == c.file_path
                    && (p.kind == "function" || p.kind == "method")
                    && p.start_line <= c.start_line
                    && p.end_line >= c.end_line
            })
            .collect();
        if containers.is_empty() {
            return Ok(true);
        }
        Ok(r.file_path == c.file_path
            && containers.iter().any(|p| r.line >= p.start_line && r.line <= p.end_line))
    }

    /// preferCallSiteFile (:1264-1273) — same-file candidates first, the rest
    /// in original order; no-op when <2 candidates or none share the file.
    fn prefer_call_site_file(nodes: Vec<CtxNode>, call_site_file: &str) -> Vec<CtxNode> {
        if nodes.len() < 2 {
            return nodes;
        }
        let mut same: Vec<CtxNode> = Vec::new();
        let mut other: Vec<CtxNode> = Vec::new();
        for n in nodes {
            if n.file_path == call_site_file {
                same.push(n);
            } else {
                other.push(n);
            }
        }
        if same.is_empty() {
            other.extend(same);
            return other;
        }
        same.extend(other);
        same
    }

    // -- object literals / rust / ts-this (:1275-1612) ----------------------

    /// rangeWithin (:1282-1289). endLine is NOT NULL in the schema, so the
    /// TS `?? startLine` defense is dead code — end_line is used directly.
    fn range_within(inner: &CtxNode, outer: &CtxNode) -> bool {
        if inner.start_line < outer.start_line || inner.end_line > outer.end_line {
            return false;
        }
        if inner.start_line == outer.start_line && inner.start_column < outer.start_column {
            return false;
        }
        if inner.end_line == outer.end_line && inner.end_column > outer.end_column {
            return false;
        }
        true
    }

    fn same_range(a: &CtxNode, b: &CtxNode) -> bool {
        a.start_line == b.start_line
            && a.start_column == b.start_column
            && a.end_line == b.end_line
            && a.end_column == b.end_column
    }

    /// resolveObjectLiteralMember (:1311-1355) — #1573 containment lookup.
    fn resolve_object_literal_member(
        &mut self,
        ctx: &mut CtxConn,
        container: &CtxNode,
        member: &str,
        r: &RefIn,
        resolved_by: ResolvedBy,
    ) -> Result<Option<Resolved>> {
        if container.kind != "constant" && container.kind != "variable" {
            return Ok(None);
        }
        if !object_literal_languages(&container.language) {
            return Ok(None);
        }
        if !same_language_family(&container.language, &r.language) {
            return Ok(None);
        }
        let in_file = ctx.nodes_in_file(&container.file_path)?;
        let callable = |n: &CtxNode| n.kind == "function" || n.kind == "method";
        let value_member = |n: &CtxNode| {
            callable(n) || n.kind == "property" || n.kind == "variable" || n.kind == "constant"
        };
        let accepts_call = r.reference_kind == "calls";
        let inside: Vec<&CtxNode> = in_file
            .iter()
            .filter(|n| n.id != container.id && Self::range_within(n, container))
            .collect();
        // Own-property evidence (#1932) — mirrors name-matcher.ts's
        // objectLiteralProperty gate: a member that is one of the literal's own
        // top-level properties confines containment to that property, and a
        // property whose value is a bare identifier names an outer binding
        // (resolve_object_literal_binding follows it instead).
        let lines = ctx.file_lines(&container.file_path)?;
        let property = Self::object_literal_property(&lines, container, member);
        match &property {
            Some(None) => return Ok(None),
            Some(Some((Some(_), _, _))) => return Ok(None),
            _ => {}
        }
        let mut candidates: Vec<&CtxNode> = inside
            .iter()
            .copied()
            .filter(|n| {
                n.name == member
                    && if accepts_call {
                        callable(n)
                    } else {
                        value_member(n)
                    }
                    && match &property {
                        Some(Some((_, p_start, p_end))) => {
                            // offset(node): UTF-16 columns + line lengths, as in TS.
                            let mut off = n.start_column - container.start_column;
                            let mut line = container.start_line;
                            while line < n.start_line {
                                let idx = (line - 1).max(0) as usize;
                                if idx < lines.len() {
                                    off += js_len(&lines[idx]) as i64 + 1;
                                }
                                line += 1;
                            }
                            off >= *p_start as i64 && off < *p_end as i64
                        }
                        _ => true,
                    }
            })
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        // Drop a candidate nested inside ANOTHER callable's body within the
        // literal. Strict containment: an identically-ranged sibling is not a body.
        let bodies: Vec<&CtxNode> = inside.iter().copied().filter(|n| callable(n)).collect();
        candidates.retain(|c| {
            !bodies
                .iter()
                .any(|b| b.id != c.id && !Self::same_range(b, c) && Self::range_within(c, b))
        });
        if candidates.is_empty() {
            return Ok(None);
        }
        // A callable first, then the earliest in source order (stable).
        candidates.sort_by(|a, b| {
            let ca = if callable(a) { 0 } else { 1 };
            let cb = if callable(b) { 0 } else { 1 };
            ca.cmp(&cb)
                .then(a.start_line.cmp(&b.start_line))
                .then(a.start_column.cmp(&b.start_column))
        });
        Ok(Some(Resolved::new(candidates[0].id.clone(), resolved_by)))
    }

    /// objectLiteralProperty (name-matcher.ts, #1932) — own-property evidence.
    /// Tri-state: None = source/extent unavailable (TS undefined), Some(None) =
    /// member absent (TS null), Some(Some((binding, start, end))) = the last own
    /// property of that name; start/end are UTF-16 offsets into the
    /// comment-stripped, string-blanked extent (offset-preserving rewrites).
    fn object_literal_property(
        lines: &[String],
        container: &CtxNode,
        member: &str,
    ) -> Option<Option<(Option<String>, usize, usize)>> {
        if lines.is_empty() {
            return None;
        }
        let start_idx = container.start_line.saturating_sub(1).max(0) as usize;
        let end_idx = (container.end_line.max(0) as usize).min(lines.len());
        if start_idx >= end_idx {
            return None;
        }
        let mut extent_lines: Vec<String> = lines[start_idx..end_idx].to_vec();
        let last = extent_lines.len() - 1;
        extent_lines[last] =
            js_slice_to(&extent_lines[last], container.end_column.max(0) as usize).to_string();
        extent_lines[0] =
            js_slice_from(&extent_lines[0], container.start_column.max(0) as usize).to_string();
        let extent = strip_comments_for_regex(&extent_lines.join("\n"), "typescript");
        let code = blank_string_contents(&extent);
        // Start at THIS declarator, including its columns, never a sibling on the same line.
        let open_re = dyn_re(&format!("^[^=]*={S}*(?:(?:Object\\.(?:freeze|seal){S}*)?\\({S}*)*\\{{"));
        let open_m = open_re.find(&code)?;
        let open_len = js_len(open_m.as_str());

        let code16: Vec<u16> = code.encode_utf16().collect();
        let extent16: Vec<u16> = extent.encode_utf16().collect();
        let mut members: Vec<(usize, usize)> = Vec::new();
        let mut depth = 0i32;
        let mut start = open_len;
        let mut i = open_len;
        while i < code16.len() {
            let ch = code16[i];
            if ch == '{' as u16 || ch == '(' as u16 || ch == '[' as u16 {
                depth += 1;
            } else if ch == ')' as u16 || ch == ']' as u16 {
                depth -= 1;
            } else if ch == '}' as u16 {
                if depth == 0 {
                    members.push((start, i));
                    break;
                }
                depth -= 1;
            } else if ch == ',' as u16 && depth == 0 {
                members.push((start, i));
                start = i + 1;
            }
            i += 1;
        }

        let key_re = dyn_re(&format!(
            "^(?:(?:async|get|set){S}+)?\\*?{S}*(?:([A-Za-z_$][0-9A-Za-z_$]*)|['\\\"]([^'\\\"\\\\]*)['\\\"])"
        ));
        let value_re = dyn_re(&format!("^:{S}*([A-Za-z_$][0-9A-Za-z_$]*)$"));
        let spread_re = dyn_re("^(?:\\.\\.\\.|\\[)");
        let mut selected: Option<(usize, usize, Option<String>)> = None;
        for (ms, me) in members {
            let text = js_trim(&String::from_utf16_lossy(&extent16[ms..me])).to_string();
            if spread_re.is_match(&text) {
                selected = None;
                continue;
            }
            let Some(key_m) = key_re.captures(&text) else { continue };
            let key_name = key_m
                .get(1)
                .or_else(|| key_m.get(2))
                .map(|x| x.as_str())
                .unwrap_or("");
            if key_name != member {
                continue;
            }
            let text16: Vec<u16> = text.encode_utf16().collect();
            let key_len = js_len(key_m.get(0).map(|x| x.as_str()).unwrap_or(""));
            let value = js_trim(&String::from_utf16_lossy(&text16[key_len.min(text16.len())..])).to_string();
            // The TS key regex's `(?=\s*(?:[:(<,=]|$))` lookahead, spelled out:
            // after the key (whitespace trimmed) comes a value delimiter or EOT.
            if !(value.is_empty()
                || value.starts_with(':')
                || value.starts_with('(')
                || value.starts_with('<')
                || value.starts_with(',')
                || value.starts_with('='))
            {
                continue;
            }
            let binding = if value.is_empty() {
                Some(member.to_string())
            } else {
                value_re
                    .captures(&value)
                    .and_then(|c| c.get(1))
                    .map(|x| x.as_str().to_string())
            };
            selected = Some((ms, me, binding));
        }
        let (ms, me, binding) = selected?;
        Some(Some((binding, ms, me)))
    }

    /// resolveObjectLiteralBinding (name-matcher.ts, #1932) — follow the bare
    /// identifier an own member names: a lexically-visible symbol of the
    /// container's file, else one of its imports (Plan A precomputed key
    /// (container.file, binding, ref kind) — primed by resolve-bridge.ts).
    fn resolve_object_literal_binding(
        &mut self,
        ctx: &mut CtxConn,
        container: &CtxNode,
        member: &str,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let lines = ctx.file_lines(&container.file_path)?;
        let binding = match Self::object_literal_property(&lines, container, member) {
            Some(Some((Some(b), _, _))) => b,
            _ => return Ok(None),
        };
        let in_file = ctx.nodes_in_file(&container.file_path)?;
        // A parameter of a callable enclosing the literal shadows the name.
        for n in &in_file {
            if (n.kind == "function" || n.kind == "method") && Self::range_within(container, n) {
                if let Some(sig) = &n.signature {
                    if Self::has_parameter_binding(&format!("{sig} {{"), &regex::escape(&binding)) {
                        return Ok(None);
                    }
                }
            }
        }
        if lines.is_empty() {
            return Ok(None);
        }
        let code = blank_string_contents(&strip_comments_for_regex(&lines.join("\n"), "typescript"));
        let code16: Vec<u16> = code.encode_utf16().collect();
        let mut offsets: Vec<usize> = vec![0];
        for (idx, ch) in code16.iter().enumerate() {
            if *ch == '\n' as u16 {
                offsets.push(idx + 1);
            }
        }
        let scope_at = |node: &CtxNode| -> Vec<usize> {
            let line_idx = (node.start_line - 1).max(0) as usize;
            let end = offsets.get(line_idx).copied().unwrap_or(code16.len())
                + node.start_column.max(0) as usize;
            let mut scope: Vec<usize> = Vec::new();
            for i in 0..end.min(code16.len()) {
                if code16[i] == '{' as u16 {
                    scope.push(i);
                } else if code16[i] == '}' as u16 {
                    scope.pop();
                }
            }
            scope
        };
        let scope = scope_at(container);
        let accepts_call = r.reference_kind == "calls";
        let accepts = |n: &CtxNode| -> bool {
            n.kind == "function"
                || n.kind == "method"
                || n.kind == "class"
                || (!accepts_call
                    && (n.kind == "constant" || n.kind == "variable" || n.kind == "component"))
        };
        let mut locals: Vec<(&CtxNode, Vec<usize>)> = in_file
            .iter()
            .filter(|n| {
                n.name == binding
                    && n.id != container.id
                    && matches!(
                        n.kind.as_str(),
                        "function" | "class" | "constant" | "variable" | "component"
                    )
            })
            .map(|n| (n, scope_at(n)))
            .filter(|(_, s)| {
                s.iter()
                    .enumerate()
                    .all(|(i, pos)| scope.get(i).copied() == Some(*pos))
            })
            .collect();
        // Deepest lexical scope first (stable), as the TS comparator.
        locals.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        // Select the lexical binding BEFORE checking callability: a nearer value
        // shadows an outer function even if that value cannot be called.
        if let Some((local, _)) = locals.first() {
            return Ok(if accepts(local) {
                Some(Resolved::new(local.id.clone(), ResolvedBy::InstanceMethod))
            } else {
                None
            });
        }
        let key = ImportKey::synthetic(&container.file_path, &binding, &r.reference_kind);
        if let Some(target_id) = ext.import_results.get(&key) {
            if let Some(target) = ctx.get_node_by_id(target_id)? {
                if accepts(&target) {
                    return Ok(Some(Resolved::new(target.id.clone(), ResolvedBy::InstanceMethod)));
                }
            }
        }
        Ok(None)
    }

    /// rustFieldTypeName (:1379-1396) — exported (pure) for tests.
    pub(crate) fn rust_field_type_name(raw: &str) -> Option<String> {
        let p = rpats();
        let mut t = js_trim(raw).to_string();
        loop {
            let before = t.clone();
            t = p.rust_field_unwrap_ref.replace(&t, "").into_owned();
            t = p.rust_field_unwrap_ptr.replace(&t, "").into_owned();
            t = p.rust_field_unwrap_dyn.replace(&t, "").into_owned();
            if t == before {
                break;
            }
        }
        // Drop generic args, closing `>`s and trait-object bounds; last segment.
        let t = js_trim(&p.rust_field_strip.replace(&t, "")).to_string();
        let seg = t.split("::").filter(|s| !s.is_empty()).last()?.to_string();
        if seg.is_empty() || !p.ident_full.is_match(&seg) {
            return None;
        }
        if rust_non_project_field_types().contains(seg.as_str()) {
            return None;
        }
        if p.upper_single.is_match(&seg) {
            return None; // bare single-letter generic parameter
        }
        Some(seg)
    }

    /// matchRustSelfFieldCall (:1411-1457) — #1585, EXCLUSIVE.
    fn match_rust_self_field_call(
        &mut self,
        ctx: &mut CtxConn,
        field: &str,
        method_name: &str,
        r: &RefIn,
    ) -> Result<Option<Resolved>> {
        // The extractor only ever emits a single field hop.
        if field.is_empty() || field.contains('.') {
            return Ok(None);
        }
        let Some(caller) = ctx.get_node_by_id(&r.from_node_id)? else {
            return Ok(None);
        };
        let sep = caller.qualified_name.rfind("::").map(|i| i as i64).unwrap_or(-1);
        if sep <= 0 {
            return Ok(None); // a free fn has no `self`
        }
        let owner = caller.qualified_name[..sep as usize]
            .split("::")
            .filter(|s| !s.is_empty())
            .last()
            .map(|s| s.to_string());
        let Some(owner) = owner else { return Ok(None) };
        let owners: Vec<CtxNode> = Self::prefer_call_site_file(ctx.nodes_by_name(&owner)?, &r.file_path)
            .into_iter()
            .filter(|n| {
                (n.kind == "struct" || n.kind == "union" || n.kind == "class") && n.language == "rust"
            })
            .collect();
        let field_esc = regex::escape(field);
        // `pub inner: Inner,` / `inner: Box<dyn Source>,` — the type text runs
        // to the field separator; a comma inside generic args truncates the
        // capture, which rustFieldTypeName then refuses (non-deref container).
        let field_re = dyn_re(&format!("\\b{field_esc}{S}*:{S}*([^,{{}}]+)"));
        for s in &owners {
            let Some(source) = ctx.read_file(&s.file_path)? else { continue };
            // Only the struct's own declaration lines, comment-stripped per line.
            let lines: Vec<&str> = source.split('\n').collect();
            let start = ((s.start_line - 1).max(0)) as usize;
            let end = (s.end_line.max(0) as usize).min(lines.len());
            for raw_line in &lines[start.min(end)..end] {
                let line = rpats()
                    .block_comment_strip
                    .replace_all(&rpats().line_comment_strip.replace(raw_line, ""), "")
                    .into_owned();
                let Some(m) = field_re.captures(&line) else { continue };
                let Some(captured) = m.get(1) else { continue };
                if captured.as_str().is_empty() {
                    continue;
                }
                let field_type = Self::rust_field_type_name(captured.as_str());
                // The field is declared here; whether or not its type names a
                // project symbol, this owner is the answer.
                let Some(ft) = field_type else { return Ok(None) };
                return self.resolve_method_on_type(
                    ctx,
                    &ft,
                    method_name,
                    r,
                    ResolvedBy::InstanceMethod,
                    None,
                );
            }
        }
        Ok(None)
    }

    /// matchRustSelfCall (:1468-1505) — #1861, EXCLUSIVE.
    fn match_rust_self_call(
        &mut self,
        ctx: &mut CtxConn,
        method_name: &str,
        r: &RefIn,
    ) -> Result<Option<Resolved>> {
        let Some(caller) = ctx.get_node_by_id(&r.from_node_id)? else {
            return Ok(None);
        };
        if caller.qualified_name.is_empty() {
            return Ok(None);
        }
        let sep = caller.qualified_name.rfind("::").map(|i| i as i64).unwrap_or(-1);
        if sep <= 0 {
            return Ok(None); // a free fn has no `self`
        }
        let owner = &caller.qualified_name[..sep as usize];
        let want = format!("{owner}::{method_name}");
        let mut owned: Vec<CtxNode> = ctx
            .nodes_by_qualified_name(&want)?
            .into_iter()
            .filter(|n| n.kind == "method" && n.language == "rust" && n.qualified_name == want)
            .collect();
        // Two modules can each declare `Target`; require a single owner
        // declaration in the caller's file and a method in that file.
        let owners: Vec<CtxNode> = ctx
            .nodes_by_qualified_name(owner)?
            .into_iter()
            .filter(|n| {
                n.language == "rust"
                    && matches!(
                        n.kind.as_str(),
                        "struct" | "enum" | "union" | "trait" | "class"
                    )
            })
            .collect();
        if owners.len() > 1 {
            if owners.iter().filter(|n| n.file_path == caller.file_path).count() != 1 {
                return Ok(None);
            }
            owned.retain(|n| n.file_path == caller.file_path);
        }
        if owned.len() != 1 {
            return Ok(None);
        }
        Ok(Some(Resolved::new(owned[0].id.clone(), ResolvedBy::QualifiedName)))
    }

    /// matchTsThisFieldCall (:1520-1612) — #1496, EXCLUSIVE.
    fn match_ts_this_field_call(
        &mut self,
        ctx: &mut CtxConn,
        field: &str,
        method_name: &str,
        r: &RefIn,
    ) -> Result<Option<Resolved>> {
        if field.is_empty() || field.contains('.') {
            return Ok(None);
        }
        let Some(caller) = ctx.get_node_by_id(&r.from_node_id)? else {
            return Ok(None);
        };
        let sep = caller.qualified_name.rfind("::").map(|i| i as i64).unwrap_or(-1);
        if sep <= 0 {
            return Ok(None); // not inside a class
        }
        let owner = caller.qualified_name[..sep as usize]
            .split("::")
            .filter(|s| !s.is_empty())
            .last()
            .map(|s| s.to_string());
        let Some(owner) = owner else { return Ok(None) };
        let owners: Vec<CtxNode> = Self::prefer_call_site_file(ctx.nodes_by_name(&owner)?, &r.file_path)
            .into_iter()
            .filter(|n| {
                (n.kind == "class" || n.kind == "component") && same_language_family(&n.language, &r.language)
            })
            .collect();
        let field_esc = regex::escape(field);
        // Tried in order: typeof-value, declared type, `= new` initializer.
        // The leading `(?:^|[^\w$#])` is the regex-crate spelling of the wasm
        // arm's `(?<![\w$#])` lookbehind (#1987): a word boundary cannot open a
        // private name, and a public `items` must not match `#items`.
        let patterns: Vec<(Regex, bool)> = vec![
            (
                dyn_re(&format!(
                    "(?:^|[^\\w$#]){field_esc}\\b{S}*[?!]?{S}*:{S}*(?:readonly{S}+)?typeof{S}+([A-Za-z_$][0-9A-Za-z_.$]*)"
                )),
                true,
            ),
            (
                dyn_re(&format!(
                    "(?:^|[^\\w$#]){field_esc}\\b{S}*[?!]?{S}*:{S}*(?:readonly{S}+)?([A-Za-z_$][0-9A-Za-z_.$]*)"
                )),
                false,
            ),
            (
                dyn_re(&format!("(?:^|[^\\w$#]){field_esc}\\b{S}*={S}*new{S}+([A-Za-z_$][0-9A-Za-z_.$]*)")),
                false,
            ),
        ];
        for cls in &owners {
            let Some(source) = ctx.read_file(&cls.file_path)? else { continue };
            let lines: Vec<&str> = source.split('\n').collect();
            let start = ((cls.start_line - 1).max(0)) as usize;
            let end = (cls.end_line.max(0) as usize).min(lines.len());
            for raw_line in &lines[start.min(end)..end] {
                let line = rpats()
                    .block_comment_strip
                    .replace_all(&rpats().line_comment_strip.replace(raw_line, ""), "")
                    .into_owned();
                for (re, value_type) in &patterns {
                    let Some(m) = re.captures(&line) else { continue };
                    let Some(cap) = m.get(1) else { continue };
                    if cap.as_str().is_empty() {
                        continue;
                    }
                    if *value_type {
                        // `storage: typeof DraftHubStorage` — the value's
                        // members are found by containment (#1573).
                        let holder_name = cap.as_str().rsplit('.').next().unwrap_or("");
                        let holders: Vec<CtxNode> =
                            Self::prefer_call_site_file(ctx.nodes_by_name(holder_name)?, &r.file_path)
                                .into_iter()
                                .filter(|n| {
                                    (n.kind == "constant" || n.kind == "variable")
                                        && same_language_family(&n.language, &r.language)
                                })
                                .collect();
                        for holder in &holders {
                            if let Some(hit) = self.resolve_object_literal_member(
                                ctx,
                                holder,
                                method_name,
                                r,
                                ResolvedBy::InstanceMethod,
                            )? {
                                return Ok(Some(hit));
                            }
                        }
                        return Ok(None);
                    }
                    // `ns.Mailer` → `Mailer`; a primitive/builtin names no project type.
                    let type_name = cap.as_str().rsplit('.').next().unwrap_or("");
                    if !rpats().leading_upper.is_match(type_name) {
                        return Ok(None);
                    }
                    // Two apps in one repo may each declare a `UserService` —
                    // keep the directory-proximity tiebreak the replaced
                    // bare-name path used, never index order.
                    let want = format!("{type_name}::{method_name}");
                    let want_suffix = format!("::{want}");
                    let declared: Vec<CtxNode> = ctx
                        .nodes_by_name(method_name)?
                        .into_iter()
                        .filter(|n| {
                            n.kind == "method"
                                && same_language_family(&n.language, &r.language)
                                && (n.qualified_name == want || n.qualified_name.ends_with(&want_suffix))
                        })
                        .collect();
                    if declared.len() > 1 {
                        let call_dirs: Vec<String> = {
                            let mut d = js_split(&r.file_path, '/');
                            d.pop();
                            d
                        };
                        let shared = |fp: &str| -> usize {
                            let mut dirs = js_split(fp, '/');
                            dirs.pop();
                            let mut i = 0usize;
                            while i < dirs.len() && i < call_dirs.len() && dirs[i] == call_dirs[i] {
                                i += 1;
                            }
                            i
                        };
                        let mut declared = declared;
                        declared.sort_by(|a, b| {
                            shared(&b.file_path)
                                .cmp(&shared(&a.file_path))
                                .then_with(|| locale_compare_ascii(&a.file_path, &b.file_path))
                        });
                        return Ok(Some(Resolved::new(
                            declared[0].id.clone(),
                            ResolvedBy::InstanceMethod,
                        )));
                    }
                    return self.resolve_method_on_type(
                        ctx,
                        type_name,
                        method_name,
                        r,
                        ResolvedBy::InstanceMethod,
                        None,
                    );
                }
            }
        }
        Ok(None)
    }

    // -- store-accessor chain (#1683) (:1614-1845) --------------------------

    /// enclosingScopeStartLine (:1615-1626).
    fn enclosing_scope_start_line(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<i64> {
        let mut start = 1i64;
        for n in ctx.nodes_in_file(&r.file_path)? {
            if n.kind != "function" && n.kind != "method" {
                continue;
            }
            if n.language != r.language {
                continue;
            }
            if n.start_line <= r.line && n.end_line >= r.line && n.start_line >= start {
                start = n.start_line;
            }
        }
        Ok(start)
    }

    /// hasParameterBinding (:1631-1645). `escaped_name` is the regex-escaped
    /// name (TS passes the escaped form into the pattern builders).
    fn has_parameter_binding(code: &str, escaped_name: &str) -> bool {
        let name = dyn_re(&format!("\\b{escaped_name}\\b"));
        if dyn_re(&format!("\\b{escaped_name}{S}*=>")).is_match(code) {
            return true;
        }
        let bytes = code.as_bytes();
        let after_control = dyn_re(&format!("\\b(?:if|while|for|switch|with){S}*$"));
        let arrow_or_brace = dyn_re(&format!("^{S}*(?::[^=;{{]*)?(?:=>|\\{{)"));
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] != b'(' || after_control.is_match(&code[..i]) {
                i += 1;
                continue;
            }
            let mut depth = 1i32;
            let mut j = i + 1;
            while j < bytes.len() && depth != 0 {
                if bytes[j] == b'(' {
                    depth += 1;
                } else if bytes[j] == b')' {
                    depth -= 1;
                }
                j += 1;
            }
            if depth == 0 {
                // code.slice(i + 1, j - 1) — the balanced parameter list.
                let inner = &code[(i + 1).min(code.len())..(j - 1).min(code.len())];
                if name.is_match(inner) && arrow_or_brace.is_match(&code[j.min(code.len())..]) {
                    return true;
                }
            }
            i += 1;
        }
        false
    }

    /// importShadowedAt (:1649-1669).
    fn import_shadowed_at(&mut self, ctx: &mut CtxConn, name: &str, r: &RefIn) -> Result<bool> {
        let escaped = regex::escape(name);
        for n in ctx.nodes_in_file(&r.file_path)? {
            if (n.kind == "function" || n.kind == "method")
                && n.start_line <= r.line
                && n.end_line >= r.line
            {
                if let Some(sig) = &n.signature {
                    if Self::has_parameter_binding(&format!("{sig} {{"), &escaped) {
                        return Ok(true);
                    }
                }
            }
        }
        let lines = ctx.file_lines(&r.file_path)?;
        let line_idx = (r.line - 1).max(0) as usize;
        let before = build_before_text(&lines, line_idx, r.column.max(0) as usize);
        let code = blank_string_contents(&strip_comments_for_regex(&before, "typescript"));
        let scope = stack_at(&code, code.len());
        let declarations =
            dyn_re(&format!("\\b(?:const|let|var|function|class){S}+(?:{escaped}\\b|\\{{[^}}]*\\b{escaped}\\b)"));
        let any = declarations.captures_iter(&code).any(|m| {
            let at = m.get(0).map(|x| x.start()).unwrap_or(0);
            scope_prefix_eq(&stack_at(&code, at), &scope)
        });
        Ok(any)
    }

    /// matchStoreAccessorChain (:1682-1696).
    fn match_store_accessor_chain(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let Some(m) = rpats().store_accessor_shape.captures(&r.reference_name) else {
            return Ok(None);
        };
        let inner = m[1].to_string();
        let method = m[2].to_string();
        if inner.is_empty() || method.is_empty() {
            return Ok(None);
        }
        if !(inner == "get" || inner == "getState" || inner.ends_with(".getState")) {
            return Ok(None);
        }
        if js_family(&r.language) {
            return self.resolve_store_action(ctx, &inner, &method, r, ext, false);
        }
        let callables: Vec<CtxNode> = ctx
            .nodes_by_name(&method)?
            .into_iter()
            .filter(|n| {
                (n.kind == "function" || n.kind == "method")
                    && same_language_family(&n.language, &r.language)
                    && n.id != r.from_node_id
            })
            .collect();
        if callables.len() != 1 {
            return Ok(None);
        }
        Ok(Some(Resolved::new(callables[0].id.clone(), ResolvedBy::ExactMatch)))
    }

    /// resolveStoreAction (:1701-1733).
    fn resolve_store_action(
        &mut self,
        ctx: &mut CtxConn,
        inner: &str,
        member: &str,
        r: &RefIn,
        ext: &ExternalStrategies,
        selector: bool,
    ) -> Result<Option<Resolved>> {
        let holders: Vec<CtxNode>;
        if inner == "get" || inner == "getState" {
            let Some(caller) = ctx.get_node_by_id(&r.from_node_id)? else {
                return Ok(None);
            };
            let factory_re = dyn_re(&format!(
                "\\({S}*[0-9A-Za-z_$]+{S}*,{S}*{}(?:{S}*,{S}*[0-9A-Za-z_$]+{S}*)?\\){S}*=>",
                regex::escape(inner)
            ));
            let mut hs = Vec::new();
            for n in ctx.nodes_in_file(&r.file_path)? {
                if (n.kind != "constant" && n.kind != "variable") || !Self::range_within(&caller, &n) {
                    continue;
                }
                let n_src = ctx.read_file(&n.file_path)?;
                let lines: Vec<&str> = match &n_src {
                    Some(src) => src.split('\n').collect(),
                    None => Vec::new(),
                };
                // slice(n.startLine - 1, caller.startLine) joined by '\n'
                let start = ((n.start_line - 1).max(0)) as usize;
                let end = (caller.start_line.max(0) as usize).min(lines.len());
                let source = lines[start.min(end)..end].join("\n");
                // The accessor must actually be a parameter of the enclosing factory.
                if factory_re.is_match(&source) {
                    hs.push(n);
                }
            }
            holders = hs;
        } else {
            let name = &inner[..inner.len() - ".getState".len()];
            if !rpats().word_dollar_seq.is_match(name) {
                return Ok(None);
            }
            // context.resolveImport — Plan A precomputed table, synthetic ref
            // `{ ...ref, referenceName: name, referenceKind: 'references' }`.
            let key = ImportKey::synthetic(&r.file_path, name, "references");
            let imported_target = ext.import_results.get(&key).cloned();
            let node = match &imported_target {
                Some(t) => ctx.get_node_by_id(t)?,
                None => None,
            };
            // TS: `if (node && importShadowedAt(...)) return null` — a dangling
            // import result falls through to the same-file holders arm.
            if node.is_some() && self.import_shadowed_at(ctx, name, r)? {
                return Ok(None);
            }
            holders = match node {
                Some(n) => vec![n],
                None => {
                    let mut hs = Vec::new();
                    for n in ctx.nodes_by_name(name)? {
                        if n.file_path == r.file_path && self.is_lexically_reachable(ctx, &n, r)? {
                            hs.push(n);
                        }
                    }
                    hs
                }
            };
        }
        if holders.len() != 1 {
            return Ok(None);
        }
        let holder = &holders[0];
        if selector {
            // Only a Zustand hook promises to return the selector's result.
            let holder_src = ctx.read_file(&holder.file_path)?;
            let lines: Vec<&str> = match &holder_src {
                Some(src) => src.split('\n').collect(),
                None => Vec::new(),
            };
            let start = ((holder.start_line - 1).max(0)) as usize;
            let end = (holder.end_line.max(0) as usize).min(lines.len());
            let text = lines[start.min(end)..end].join("\n");
            let escaped = regex::escape(&holder.name);
            let factory = dyn_re(&format!("\\b(?:const|let){S}+{escaped}{S}*={S}*([0-9A-Za-z_$]+){S}*[<(]"))
                .captures(&text)
                .and_then(|m| m.get(1).map(|x| x.as_str().to_string()));
            let mut ok = false;
            if let Some(factory) = &factory {
                for m in ctx.import_mappings(&holder.file_path, &holder.language)? {
                    if m.local_name == *factory
                        && m.source == "zustand"
                        && (m.exported_name == "create" || m.is_default)
                    {
                        ok = true;
                        break;
                    }
                }
            }
            if !ok {
                return Ok(None);
            }
        }
        self.resolve_object_literal_member(ctx, holder, member, r, ResolvedBy::InstanceMethod)
    }

    /// matchDestructuredStoreCall (:1743-1789).
    fn match_destructured_store_call(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let eligible = match self.memos.get_state_files.get(&r.file_path) {
            Some(v) => *v,
            None => {
                let source = ctx.read_file(&r.file_path)?;
                let v = source.as_deref().map(|s| s.contains(".getState")).unwrap_or(false);
                self.memos.get_state_files.set(r.file_path.clone(), v);
                v
            }
        };
        if !eligible {
            return Ok(None);
        }
        let Some(source) = ctx.read_file(&r.file_path)? else {
            return Ok(None);
        };
        let lines: Vec<&str> = source.split('\n').collect();
        let start = (self.enclosing_scope_start_line(ctx, r)? - 1).max(0) as usize;
        let line_idx = (r.line - 1).max(0) as usize;
        // lines.slice(start, ref.line - 1).concat(lines[ref.line-1].slice(0, ref.column))
        let mid_end = line_idx.min(lines.len());
        let mut parts: Vec<String> = lines[start.min(mid_end)..mid_end].iter().map(|s| s.to_string()).collect();
        parts.push(js_slice_to(lines.get(line_idx).copied().unwrap_or(""), r.column.max(0) as usize).to_string());
        let before = parts.join("\n");
        let code = blank_string_contents(&strip_comments_for_regex(&before, "typescript"));
        let name = regex::escape(&r.reference_name);
        let binding = rpats().decl_store_binding.clone();
        let call_scope = stack_at(&code, code.len());
        let shadow_guard =
            dyn_re(&format!("\\b(?:const|let|var|function|class){S}+(?:{name}\\b|\\{{[^}}]*\\b{name}\\b)"));
        // [...code.matchAll(binding)].reverse()
        let matches: Vec<(usize, usize, String, String)> = binding
            .captures_iter(&code)
            .map(|m| {
                let whole = m.get(0).unwrap();
                (
                    whole.start(),
                    whole.end(),
                    m.get(1).map(|x| x.as_str().to_string()).unwrap_or_default(),
                    m.get(2).map(|x| x.as_str().to_string()).unwrap_or_default(),
                )
            })
            .collect();
        for (idx, end, g1, g2) in matches.iter().rev() {
            // Plain named bindings only.
            if !g1.split(',').any(|part| js_trim(part) == r.reference_name) {
                continue;
            }
            let scope = stack_at(&code, *idx);
            if !scope_prefix_eq(&scope, &call_scope) {
                continue;
            }
            let rest = &code[*end..];
            // Keep the guard when another declaration shadows the captured const.
            if shadow_guard.is_match(rest) {
                return Ok(None);
            }
            return self.resolve_store_action(
                ctx,
                &format!("{g2}.getState"),
                &r.reference_name,
                r,
                ext,
                false,
            );
        }
        Ok(None)
    }

    /// matchSelectedStoreCall (:1796-1830).
    fn match_selected_store_call(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        let Some(source) = ctx.read_file(&r.file_path)? else {
            return Ok(None);
        };
        if !source.contains("=>") {
            return Ok(None);
        }
        let names = match self.memos.selector_names.get(&r.file_path) {
            Some(v) => v.clone(),
            None => {
                let v: HashSet<String> = rpats()
                    .selector_names
                    .captures_iter(&source)
                    .map(|m| m[1].to_string())
                    .collect();
                self.memos.selector_names.insert(r.file_path.clone(), v.clone());
                v
            }
        };
        if !names.contains(&r.reference_name) {
            return Ok(None);
        }
        let name = regex::escape(&r.reference_name);
        let lines: Vec<&str> = source.split('\n').collect();
        let line_idx = (r.line - 1).max(0) as usize;
        let before = build_before_text(&lines, line_idx, r.column.max(0) as usize);
        let code = blank_string_contents(&strip_comments_for_regex(&before, "typescript"));
        let binding = dyn_re(&format!(
            "\\bconst{S}+{name}{S}*={S}*([0-9A-Za-z_$]+){S}*\\({S}*(?:\\({S}*([0-9A-Za-z_$]+){S}*\\)|([0-9A-Za-z_$]+)){S}*=>{S}*([0-9A-Za-z_$]+)\\.([0-9A-Za-z_$]+){S}*\\)"
        ));
        let call_scope = stack_at(&code, code.len());
        let shadow_guard =
            dyn_re(&format!("\\b(?:const|let|var|function|class){S}+(?:{name}\\b|\\{{[^}}]*\\b{name}\\b)"));
        let matches: Vec<(usize, usize, [String; 5])> = binding
            .captures_iter(&code)
            .map(|m| {
                let whole = m.get(0).unwrap();
                (
                    whole.start(),
                    whole.end(),
                    [
                        m.get(1).map(|x| x.as_str().to_string()).unwrap_or_default(),
                        m.get(2).map(|x| x.as_str().to_string()).unwrap_or_default(),
                        m.get(3).map(|x| x.as_str().to_string()).unwrap_or_default(),
                        m.get(4).map(|x| x.as_str().to_string()).unwrap_or_default(),
                        m.get(5).map(|x| x.as_str().to_string()).unwrap_or_default(),
                    ],
                )
            })
            .collect();
        for (idx, end, g) in matches.iter().rev() {
            // (m[2] ?? m[3]) !== m[4] — an absent group 2 means it did not
            // participate (`[\w$]+` never matches empty), so m[3] is the param.
            let param = if g[1].is_empty() { &g[2] } else { &g[1] };
            if *param != g[3] {
                continue;
            }
            let scope = stack_at(&code, *idx);
            if !scope_prefix_eq(&scope, &call_scope) {
                continue;
            }
            let rest = &code[*end..];
            if shadow_guard.is_match(rest) || Self::has_parameter_binding(rest, &name) {
                return Ok(None);
            }
            return self.resolve_store_action(
                ctx,
                &format!("{}.getState", g[0]),
                &g[4],
                r,
                ext,
                true,
            );
        }
        Ok(None)
    }

    /// matchJsStoreBindingCall (:1834-1837) — exported (resolver prefilter
    /// allows bound action names without same-named definitions).
    pub(crate) fn match_js_store_binding_call(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        if !self.is_bare_js_call(ctx, r)? {
            return Ok(None);
        }
        match self.match_destructured_store_call(ctx, r, ext)? {
            Some(hit) => Ok(Some(hit)),
            None => self.match_selected_store_call(ctx, r, ext),
        }
    }

    // -- function refs (#756) (:1841-1979) ----------------------------------

    /// isUnresolvedJsMemberCall (:1841-1845) — exported.
    pub(crate) fn is_unresolved_js_member_call(r: &RefIn) -> bool {
        r.reference_kind == "calls"
            && js_family(&r.language)
            && !rpats().fn_ref_this_window.is_match(&r.reference_name)
            && rpats().fn_ref_chain.is_match(&r.reference_name)
    }

    /// matchFunctionRef (:1856-1979).
    pub(crate) fn match_function_ref(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        // `this.<member>` refs resolve ONLY via resolveThisMemberFnRef.
        if r.reference_name.starts_with("this.") {
            return Ok(None);
        }
        // In JS/TS/Python a bare identifier can never be a method value; PHP
        // string callables name global FUNCTIONS. Others keep method targets.
        let bare_fn_only = matches!(
            r.language.as_str(),
            "typescript" | "tsx" | "javascript" | "jsx" | "arkts" | "cpp" | "python" | "php"
        );
        let bare_class_ok = r.language == "python";
        // Qualified member-pointer (`&Widget::on_click` → "Widget::on_click").
        if r.reference_name.contains("::") {
            let member_name = &r.reference_name[r.reference_name.rfind("::").unwrap() + 2..];
            let scoped: Vec<CtxNode> = ctx
                .nodes_by_name(member_name)?
                .into_iter()
                .filter(|n| {
                    (n.kind == "function" || n.kind == "method")
                        && same_language_family(&n.language, &r.language)
                        && n.id != r.from_node_id
                        && (n.qualified_name == r.reference_name
                            || n.qualified_name.ends_with(&format!("::{}", r.reference_name)))
                })
                .collect();
            if scoped.is_empty() {
                return Ok(None);
            }
            let same_file_scoped: Vec<&CtxNode> =
                scoped.iter().filter(|n| n.file_path == r.file_path).collect();
            if same_file_scoped.is_empty() && scoped.len() > 1 {
                return Ok(None);
            }
            let pool: Vec<&CtxNode> = if same_file_scoped.is_empty() {
                scoped.iter().collect()
            } else {
                same_file_scoped
            };
            // reduce((a, b) => a.startLine <= b.startLine ? a : b) — first wins ties.
            let mut target = pool[0];
            for n in pool.iter().skip(1) {
                if n.start_line < target.start_line {
                    target = *n;
                }
            }
            return Ok(Some(Resolved::new(target.id.clone(), ResolvedBy::FunctionRef)));
        }
        let mut candidates: Vec<CtxNode> = ctx
            .nodes_by_name(&r.reference_name)?
            .into_iter()
            .filter(|n| {
                (n.kind == "function" || (!bare_fn_only && n.kind == "method") || (bare_class_ok && n.kind == "class"))
                    && same_language_family(&n.language, &r.language)
                    && n.id != r.from_node_id // a function registering itself is not an edge
            })
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        // Swift implicit-self: a bare identifier can name a METHOD only of the
        // ENCLOSING type.
        if r.language == "swift" && candidates.iter().any(|n| n.kind == "method") {
            let from_node = ctx.get_node_by_id(&r.from_node_id)?;
            let class_prefix = from_node.as_ref().and_then(|f| {
                let sep = f.qualified_name.rfind("::")?;
                if sep == 0 {
                    return None;
                }
                Some(f.qualified_name[..sep].to_string())
            });
            candidates.retain(|n| {
                if n.kind != "method" {
                    return true;
                }
                let Some(prefix) = &class_prefix else { return false };
                let Some(m_sep) = n.qualified_name.rfind("::") else { return false };
                if m_sep <= 0 {
                    return false;
                }
                let method_prefix = &n.qualified_name[..m_sep];
                // Exact-scope matches plus suffix relationships either way.
                method_prefix == prefix.as_str()
                    || method_prefix.ends_with(&format!("::{prefix}"))
                    || prefix.ends_with(&format!("::{method_prefix}"))
            });
            if candidates.is_empty() {
                return Ok(None);
            }
        }
        // Same-file definition wins.
        let same_file: Vec<&CtxNode> = candidates.iter().filter(|n| n.file_path == r.file_path).collect();
        if !same_file.is_empty() {
            // Swift: several same-named METHODS in one file is an overload
            // family — refuse rather than guess.
            if r.language == "swift" && same_file.len() > 1 && same_file.iter().all(|n| n.kind == "method") {
                return Ok(None);
            }
            // Same-name overloads are one conceptual symbol; first by position.
            let mut target = same_file[0];
            for n in same_file.iter().skip(1) {
                if n.start_line < target.start_line {
                    target = *n;
                }
            }
            return Ok(Some(Resolved::new(target.id.clone(), ResolvedBy::FunctionRef)));
        }
        // Cross-file: only an unambiguous match resolves.
        if candidates.len() == 1 {
            return Ok(Some(Resolved::new(candidates[0].id.clone(), ResolvedBy::FunctionRef)));
        }
        Ok(None)
    }

    // -- Java/Kotlin field receiver (#314) (:1981-2039) ---------------------

    /// inferJavaFieldReceiverType (:1992-2039).
    fn infer_java_field_receiver_type(
        &mut self,
        ctx: &mut CtxConn,
        receiver_name: &str,
        r: &RefIn,
    ) -> Result<Option<String>> {
        let in_file = ctx.nodes_in_file(&r.file_path)?;
        if in_file.is_empty() {
            return Ok(None);
        }
        // The class enclosing the call line (tightest match by latest start).
        let mut enclosing: Option<&CtxNode> = None;
        for n in &in_file {
            if n.kind != "class" && n.kind != "interface" {
                continue;
            }
            if n.language != r.language {
                continue;
            }
            if n.start_line <= r.line && n.end_line >= r.line {
                match enclosing {
                    None => enclosing = Some(n),
                    Some(e) if n.start_line >= e.start_line => enclosing = Some(n),
                    Some(_) => {}
                }
            }
        }
        let Some(enclosing) = enclosing else { return Ok(None) };
        let field = in_file.iter().find(|n| {
            n.kind == "field"
                && n.name == receiver_name
                && n.language == r.language
                && n.start_line >= enclosing.start_line
                && n.end_line <= enclosing.end_line
        });
        let Some(field) = field else { return Ok(None) };
        let Some(signature) = &field.signature else { return Ok(None) };
        // Signature shape: "<TypeName> <fieldName>" (extractField).
        let Some(name_pos) = signature.rfind(&field.name) else { return Ok(None) };
        let type_raw = js_trim(&signature[..name_pos]);
        if type_raw.is_empty() {
            return Ok(None);
        }
        let type_no_generics = js_trim(&dyn_re("<[^>]*>").replace_all(type_raw, "")).to_string();
        let type_no_array = js_trim(&dyn_re("\\.\\.\\.$")
            .replace(&dyn_re(&format!("\\[{S}*\\]")).replace_all(&type_no_generics, ""), ""))
            .to_string();
        let parts: Vec<&str> = type_no_array.split(['.', ' ', '\t', '\n']).filter(|s| !s.is_empty()).collect();
        let Some(last_part) = parts.last().copied() else { return Ok(None) };
        if !rpats().leading_upper.is_match(last_part) {
            return Ok(None); // primitives / lowercase → skip
        }
        Ok(Some(last_part.to_string()))
    }

    // -- Strategy 0.5 / 0.5b receiver-declaration evidence (:2041-2677) -----

    /// unwrapReceiverType (:2133-2163) — tri-state via Option; None = not
    /// bindable evidence (fall through, never veto).
    fn unwrap_receiver_type(type_text: &str, await_initialized: bool) -> Option<String> {
        let trimmed = js_trim(type_text);
        // Nullable-union peel: split on '|', drop null/undefined, exactly one
        // survivor re-enters every rule (one hop deep — it can no longer
        // contain '|').
        if trimmed.contains('|') {
            let survivors: Vec<&str> = trimmed
                .split('|')
                .map(js_trim)
                .filter(|m| *m != "null" && *m != "undefined")
                .collect();
            if survivors.len() != 1 {
                return None;
            }
            return Self::unwrap_receiver_type(survivors[0], await_initialized);
        }
        let p = rpats();
        if let Some(m) = p.promise_wrapping.captures(trimmed) {
            if !await_initialized {
                return None;
            }
            let inner = js_trim(&m[1]);
            return if p.simple_type_name.is_match(inner) {
                Some(inner.to_string())
            } else {
                None
            };
        }
        if let Some(m) = p.readonly_qualified.captures(trimmed) {
            return Some(m[1].to_string());
        }
        if p.simple_type_name.is_match(trimmed) {
            return Some(trimmed.to_string());
        }
        None
    }

    /// receiverDeclarationsForFile (:2202-2322).
    fn receiver_declarations_for_file(
        &mut self,
        ctx: &mut CtxConn,
        file_path: &str,
    ) -> Result<HashMap<String, Vec<ReceiverDeclaration>>> {
        if let Some(hit) = self.memos.receiver_decls.get(&file_path.to_string()) {
            return Ok(hit.clone());
        }
        let nodes = ctx.nodes_in_file(file_path)?;
        let mut decls: HashMap<String, Vec<ReceiverDeclaration>> = HashMap::new();
        {
            let add = |decls: &mut HashMap<String, Vec<ReceiverDeclaration>>,
                       receiver: &str,
                       decl: ReceiverDeclaration| {
                decls.entry(receiver.to_string()).or_default().push(decl);
            };
            let p = rpats();
            for node in &nodes {
                if node.kind != "statement" && node.kind != "variable" && node.kind != "constant" {
                    continue;
                }
                let Some(signature) = &node.signature else { continue };
                // variable/constant signatures are initializer-only — prefix
                // the node name to feed both shapes through the same regexes.
                let text = if node.kind == "statement" {
                    signature.clone()
                } else {
                    format!("{} {signature}", node.name)
                };
                for m in p.recv_new_decl.captures_iter(&text) {
                    add(&mut decls, &m[1], ReceiverDeclaration {
                        kind: ReceiverEvidenceKind::New,
                        name: m[2].to_string(),
                        line: node.start_line,
                        await_initialized: false,
                    });
                }
                for m in p.recv_factory_decl.captures_iter(&text) {
                    if &m[2] == "new" {
                        continue; // direct construction handled above
                    }
                    add(&mut decls, &m[1], ReceiverDeclaration {
                        kind: ReceiverEvidenceKind::Factory,
                        name: m[2].to_string(),
                        line: node.start_line,
                        await_initialized: p.factory_awaited_init.is_match(m.get(0).unwrap().as_str()),
                    });
                }
                for m in p.recv_dotted_factory_decl.captures_iter(&text) {
                    add(&mut decls, &m[1], ReceiverDeclaration {
                        kind: ReceiverEvidenceKind::Factory,
                        name: m[2].to_string(),
                        line: node.start_line,
                        await_initialized: p.factory_awaited_init.is_match(m.get(0).unwrap().as_str()),
                    });
                }
                for m in p.recv_annotation_decl.captures_iter(&text) {
                    add(&mut decls, &m[1], ReceiverDeclaration {
                        kind: ReceiverEvidenceKind::Annotation,
                        name: m[2].to_string(),
                        line: node.start_line,
                        await_initialized: false,
                    });
                }
                for m in p.recv_annotation_full_decl.captures_iter(&text) {
                    // ANNOTATION_AWAITED_INIT tests match.input AFTER the JS
                    // match end — which excludes the lookahead; group-2 end is
                    // that position here (group 3 consumed the terminator).
                    let after = m.get(2).map(|g| g.end()).unwrap_or(0);
                    add(&mut decls, &m[1], ReceiverDeclaration {
                        kind: ReceiverEvidenceKind::Annotation,
                        name: m[2].to_string(),
                        line: node.start_line,
                        await_initialized: p.annotation_awaited_init.is_match(&text[after..]),
                    });
                }
            }
            // Source-row backstop for the kernel route (no statement nodes):
            // annotation evidence from raw source lines + `= new`/factory rows
            // (comment lines skipped; string literals an accepted risk, same
            // tier as TS).
            if let Some(source) = ctx.read_file(file_path)? {
                let lines: Vec<&str> = source.split(['\n']).collect();
                // TS splits on /\r?\n/ — strip a trailing \r per line.
                for (i, raw) in lines.iter().enumerate() {
                    let line = raw.strip_suffix('\r').unwrap_or(raw);
                    for m in p.recv_annotation_decl.captures_iter(line) {
                        add(&mut decls, &m[1], ReceiverDeclaration {
                            kind: ReceiverEvidenceKind::Annotation,
                            name: m[2].to_string(),
                            line: i as i64 + 1,
                            await_initialized: false,
                        });
                    }
                    for m in p.recv_annotation_full_decl.captures_iter(line) {
                        let after = m.get(2).map(|g| g.end()).unwrap_or(0);
                        add(&mut decls, &m[1], ReceiverDeclaration {
                            kind: ReceiverEvidenceKind::Annotation,
                            name: m[2].to_string(),
                            line: i as i64 + 1,
                            await_initialized: p.annotation_awaited_init.is_match(&line[after..]),
                        });
                    }
                    let trimmed = js_trim(line);
                    if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
                        continue;
                    }
                    for m in p.recv_new_decl.captures_iter(line) {
                        add(&mut decls, &m[1], ReceiverDeclaration {
                            kind: ReceiverEvidenceKind::New,
                            name: m[2].to_string(),
                            line: i as i64 + 1,
                            await_initialized: false,
                        });
                    }
                    for m in p.recv_factory_decl.captures_iter(line) {
                        if &m[2] == "new" {
                            continue;
                        }
                        add(&mut decls, &m[1], ReceiverDeclaration {
                            kind: ReceiverEvidenceKind::Factory,
                            name: m[2].to_string(),
                            line: i as i64 + 1,
                            await_initialized: p.factory_awaited_init.is_match(m.get(0).unwrap().as_str()),
                        });
                    }
                    for m in p.recv_dotted_factory_decl.captures_iter(line) {
                        add(&mut decls, &m[1], ReceiverDeclaration {
                            kind: ReceiverEvidenceKind::Factory,
                            name: m[2].to_string(),
                            line: i as i64 + 1,
                            await_initialized: p.factory_awaited_init.is_match(m.get(0).unwrap().as_str()),
                        });
                    }
                }
            }
        }
        self.memos.receiver_decls.set(file_path.to_string(), decls.clone());
        Ok(decls)
    }

    /// selectReceiverDeclaration (:2328-2346) — highest priority at or before
    /// the call line; ties within a kind go to the nearest line (>= keeps the
    /// later declaration — reassignment retypes the receiver).
    fn select_receiver_declaration(
        declarations: Option<&Vec<ReceiverDeclaration>>,
        call_line: i64,
    ) -> Option<&ReceiverDeclaration> {
        let decls = declarations?;
        let mut best: Option<&ReceiverDeclaration> = None;
        for candidate in decls.iter() {
            if candidate.line > call_line {
                continue;
            }
            match best {
                None => best = Some(candidate),
                Some(b) => {
                    let cr = candidate.kind.priority();
                    let br = b.kind.priority();
                    if cr > br || (cr == br && candidate.line >= b.line) {
                        best = Some(candidate);
                    }
                }
            }
        }
        best
    }

    /// declaredReceiverTypeName (:2357-2388).
    fn declared_receiver_type_name(
        &mut self,
        ctx: &mut CtxConn,
        declared: &ReceiverDeclaration,
        r: &RefIn,
        imports: &[ImportMapping],
    ) -> Result<Option<String>> {
        if declared.kind != ReceiverEvidenceKind::Factory {
            return Ok(Self::unwrap_receiver_type(&declared.name, declared.await_initialized));
        }
        if declared.name.contains('.') {
            return self.dotted_factory_type_name(ctx, declared, r, imports);
        }
        let factories: Vec<CtxNode> = ctx
            .nodes_by_name(&declared.name)?
            .into_iter()
            .filter(|n| (n.kind == "function" || n.kind == "method") && n.language == r.language)
            .collect();
        let ordered = order_same_file_first(&factories, r, imports);
        for candidate in &ordered {
            let Some(rt) = &candidate.return_type else { continue };
            if let Some(type_name) = Self::unwrap_receiver_type(rt, declared.await_initialized) {
                return Ok(Some(type_name));
            }
        }
        Ok(None)
    }

    /// dottedFactoryTypeName (:2398-2433).
    fn dotted_factory_type_name(
        &mut self,
        ctx: &mut CtxConn,
        declared: &ReceiverDeclaration,
        r: &RefIn,
        imports: &[ImportMapping],
    ) -> Result<Option<String>> {
        let segments: Vec<&str> = declared.name.split('.').collect();
        if segments.len() < 2 {
            return Ok(None);
        }
        let callee = segments[segments.len() - 1];
        let prefix = segments[segments.len() - 2];
        if segments.len() > 2 {
            return Ok(None); // `a.b.c()` — too deep to trust
        }
        let via_this = prefix == "this";
        let methods: Vec<CtxNode> = ctx
            .nodes_by_name(callee)?
            .into_iter()
            .filter(|n| n.kind == "method" && n.language == r.language)
            .filter(|n| {
                if via_this {
                    return n.file_path == r.file_path;
                }
                // qualifiedName.split(/::|\./) — second-to-last == prefix.
                let parts = split_colon_or_dot(&n.qualified_name);
                parts.len() >= 2
                    && parts[parts.len() - 2] == prefix
                    && parts[parts.len() - 1] == callee
            })
            .collect();
        let ordered = order_same_file_first(&methods, r, imports);
        for candidate in &ordered {
            let Some(rt) = &candidate.return_type else { continue };
            if let Some(type_name) = Self::unwrap_receiver_type(rt, declared.await_initialized) {
                return Ok(Some(type_name));
            }
        }
        Ok(None)
    }

    /// isReceiverContainerCandidate (:2439-2448) — TS type aliases included
    /// (extractTsTypeAliasMembers emits `X::m` method nodes).
    fn is_receiver_container_candidate(node: &CtxNode, language: &str) -> bool {
        matches!(
            node.kind.as_str(),
            "class" | "struct" | "union" | "interface" | "type_alias"
        ) && node.language == language
    }

    /// importPinsFile (:2479-2493).
    fn import_pins_file(candidate_file_path: &str, r: &RefIn, imports: &[ImportMapping]) -> bool {
        for imp in imports {
            // resolvedPath is never set on the extract side (see
            // cross_file_candidate_allowed) — arm kept for wire-table parity.
            if imp.source.is_empty() {
                continue;
            }
            if Self::relative_source_names_file(candidate_file_path, r, &imp.source) {
                return true;
            }
            if Self::barrel_import_reaches_file(r, candidate_file_path, &imp.source) {
                return true;
            }
        }
        false
    }

    /// pickContainerCandidate (:2506-2517) — conservative layering: unique
    /// same-file, then unique import-pinned, then the first allowed.
    fn pick_container_candidate<'a>(
        candidates: &'a [CtxNode],
        r: &RefIn,
        imports: &[ImportMapping],
    ) -> Option<&'a CtxNode> {
        let allowed: Vec<&CtxNode> = candidates
            .iter()
            .filter(|n| Self::cross_file_candidate_allowed(r, n, imports))
            .collect();
        let same_file: Vec<&&CtxNode> = allowed.iter().filter(|n| n.file_path == r.file_path).collect();
        if same_file.len() == 1 {
            return Some(*same_file[0]);
        }
        let pinned: Vec<&&CtxNode> = allowed
            .iter()
            .filter(|n| Self::import_pins_file(&n.file_path, r, imports))
            .collect();
        if pinned.len() == 1 {
            return Some(*pinned[0]);
        }
        allowed.first().copied()
    }

    /// builtinReceiverVeto (:2525-2527).
    fn builtin_receiver_veto(type_name: &str, r: &RefIn) -> bool {
        esm_family(&r.language)
            && (js_built_ins().contains(type_name) || ts_primitive_types().contains(type_name))
    }

    /// matchMethodCallByDeclaration (:2542-2586) — tri-state: Ok(None) with
    /// the `TriState` wrapper distinguishes fall-through from veto.
    fn match_method_call_by_declaration(
        &mut self,
        ctx: &mut CtxConn,
        receiver_name: &str,
        method_name: &str,
        r: &RefIn,
    ) -> Result<TriState> {
        let declared = {
            let decls = self.receiver_declarations_for_file(ctx, &r.file_path)?;
            decls
                .get(receiver_name)
                .and_then(|v| Self::select_receiver_declaration(Some(v), r.line).cloned())
        };
        let Some(declared) = declared else { return Ok(TriState::FallThrough) };
        let imports = self.ref_import_mappings(ctx, r)?;
        let Some(type_name) = self.declared_receiver_type_name(ctx, &declared, r, &imports)? else {
            return Ok(TriState::FallThrough);
        };
        let class_candidates: Vec<CtxNode> = ctx
            .nodes_by_name(&type_name)?
            .into_iter()
            .filter(|n| Self::is_receiver_container_candidate(n, &r.language))
            .collect();
        let decl_class = Self::pick_container_candidate(&class_candidates, r, &imports);
        let Some(decl_class) = decl_class else {
            return Ok(if Self::builtin_receiver_veto(&type_name, r) {
                TriState::Veto
            } else {
                TriState::FallThrough
            });
        };
        let decl_class_name = decl_class.name.clone();
        let decl_class_file = decl_class.file_path.clone();
        let method_node = ctx.nodes_in_file(&decl_class_file)?.into_iter().find(|n| {
            n.kind == "method" && n.name == method_name && n.qualified_name.contains(&decl_class_name)
        });
        // Declaration evidence is authoritative.
        let Some(method_node) = method_node else { return Ok(TriState::Veto) };
        if !Self::cross_file_candidate_allowed(r, &method_node, &imports) {
            return Ok(TriState::Veto);
        }
        Ok(TriState::Resolved(Resolved::new(
            method_node.id.clone(),
            ResolvedBy::InstanceMethod,
        )))
    }

    /// typedFunctionsForFile (:2601-2616).
    fn typed_functions_for_file(&mut self, ctx: &mut CtxConn, file_path: &str) -> Result<Vec<CtxNode>> {
        if let Some(hit) = self.memos.typed_fns.get(&file_path.to_string()) {
            return Ok(hit.clone());
        }
        let functions: Vec<CtxNode> = ctx
            .nodes_in_file(file_path)?
            .into_iter()
            .filter(|n| {
                (n.kind == "function" || n.kind == "method")
                    && params_of(n).map(|p| !p.is_empty()).unwrap_or(false)
            })
            .collect();
        self.memos.typed_fns.set(file_path.to_string(), functions.clone());
        Ok(functions)
    }

    /// matchMethodCallByParamType (:2627-2677) — Strategy 0.5b.
    fn match_method_call_by_param_type(
        &mut self,
        ctx: &mut CtxConn,
        receiver_name: &str,
        method_name: &str,
        r: &RefIn,
    ) -> Result<TriState> {
        // Every typed function/method containing the call line, innermost first.
        let mut covering: Vec<CtxNode> = self
            .typed_functions_for_file(ctx, &r.file_path)?
            .into_iter()
            .filter(|n| n.start_line <= r.line && n.end_line >= r.line)
            .collect();
        covering.sort_by(|a, b| b.start_line.cmp(&a.start_line));
        let mut param: Option<(String, String)> = None;
        for f in &covering {
            if let Some(params) = params_of(f) {
                if let Some(p) = params.into_iter().find(|(name, _)| name == receiver_name) {
                    param = Some(p);
                    break;
                }
            }
        }
        let Some((_, param_type)) = param else { return Ok(TriState::FallThrough) };
        // Parameters hold exactly what callers pass — never await-initialized.
        let Some(declared_type) = Self::unwrap_receiver_type(&param_type, false) else {
            return Ok(TriState::FallThrough);
        };
        // `db.Queue` names the class `Queue`.
        let type_name = declared_type.rsplit('.').next().unwrap_or(&declared_type).to_string();
        let imports = self.ref_import_mappings(ctx, r)?;
        let class_candidates: Vec<CtxNode> = ctx
            .nodes_by_name(&type_name)?
            .into_iter()
            .filter(|n| Self::is_receiver_container_candidate(n, &r.language))
            .collect();
        let Some(param_class) = Self::pick_container_candidate(&class_candidates, r, &imports) else {
            return Ok(if Self::builtin_receiver_veto(&type_name, r) {
                TriState::Veto
            } else {
                TriState::FallThrough
            });
        };
        let param_class_name = param_class.name.clone();
        let param_class_file = param_class.file_path.clone();
        let method_node = ctx.nodes_in_file(&param_class_file)?.into_iter().find(|n| {
            n.kind == "method" && n.name == method_name && n.qualified_name.contains(&param_class_name)
        });
        let Some(method_node) = method_node else { return Ok(TriState::Veto) };
        if !Self::cross_file_candidate_allowed(r, &method_node, &imports) {
            return Ok(TriState::Veto);
        }
        Ok(TriState::Resolved(Resolved::new(
            method_node.id.clone(),
            ResolvedBy::InstanceMethod,
        )))
    }

    // -- matchMethodCall (:2682-2945) ---------------------------------------

    pub(crate) fn match_method_call(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        // "obj.method" / "Class::method"; the receiver allows dots; the method
        // part allows trailing `:` keywords (Objective-C selectors); C++
        // explicit operator call `a.operator+` (#1247).
        let dot_re = dyn_re("^([0-9A-Za-z_.]+)\\.([0-9A-Za-z_]+:?(?:[0-9A-Za-z_]+:)*)$");
        let op_re = dyn_re(&format!("^([0-9A-Za-z_.]+)\\.(operator[^0-9A-Za-z_{S_INNER}.]+)$"));
        let colon_re = dyn_re("^([0-9A-Za-z_]+)::([0-9A-Za-z_]+)$");
        let dot_match = dot_re.captures(&r.reference_name).or_else(|| {
            if r.language == "cpp" {
                op_re.captures(&r.reference_name)
            } else {
                None
            }
        });
        let colon_match = colon_re.captures(&r.reference_name);
        let dot_match_used = dot_match.is_some();
        // A TS/JS call through an ES private field of the enclosing class —
        // `this.#items.add()`, emitted as `this.#items.add` (#1987) — resolves
        // exactly like `this.<field>` (#1496). `#` is outside dot_re's receiver
        // class, so the shape is matched here.
        if matches!(r.language.as_str(), "typescript" | "javascript" | "tsx" | "jsx") {
            let pf_re = dyn_re("^this\\.(#[0-9A-Za-z_$]+)\\.([0-9A-Za-z_]+)$");
            if let Some(pf) = pf_re.captures(&r.reference_name) {
                return self.match_ts_this_field_call(
                    ctx,
                    pf.get(1).map(|x| x.as_str()).unwrap_or(""),
                    pf.get(2).map(|x| x.as_str()).unwrap_or(""),
                    r,
                );
            }
        }
        let Some(m) = dot_match.or(colon_match) else {
            return Ok(None);
        };
        let object_or_class = m.get(1).map(|x| x.as_str()).unwrap_or("");
        let method_name = m.get(2).map(|x| x.as_str()).unwrap_or("");

        if r.language == "cpp" && dot_match_used {
            if let Some(inferred) = self.infer_cpp_receiver_type(ctx, object_or_class, r, 0)? {
                if let Some(hit) = self.resolve_method_on_type(
                    ctx,
                    &inferred,
                    method_name,
                    r,
                    ResolvedBy::InstanceMethod,
                    None,
                )? {
                    return Ok(Some(hit));
                }
            }
        }

        // Go 2-hop field chain `base.field.Method` (#1276) — EXCLUSIVE decline
        // (scope-narrowed #1108 port: unresolved rather than a guessed edge).
        if r.language == "go" && dot_match_used && object_or_class.contains('.') {
            return Ok(None);
        }

        // Rust `self.inner.run()` (#1585) — EXCLUSIVE.
        if r.language == "rust" && dot_match_used && object_or_class.starts_with("self.") {
            return self.match_rust_self_field_call(ctx, &object_or_class["self.".len()..], method_name, r);
        }

        // Rust `self.reset()` (#1861) — EXCLUSIVE.
        if r.language == "rust" && dot_match_used && object_or_class == "self" {
            return self.match_rust_self_call(ctx, method_name, r);
        }

        // TS/JS `this.mailer.send()` (#1496) — EXCLUSIVE.
        if js_family(&r.language) && dot_match_used && object_or_class.starts_with("this.") {
            return self.match_ts_this_field_call(ctx, &object_or_class["this.".len()..], method_name, r);
        }

        // Java/Kotlin field-receiver inference (#314).
        if (r.language == "java" || r.language == "kotlin") && dot_match_used {
            if let Some(inferred) = self.infer_java_field_receiver_type(ctx, object_or_class, r)? {
                let imports = ctx.import_mappings(&r.file_path, &r.language)?;
                let imported_fqn = imports
                    .iter()
                    .find(|i| i.local_name == inferred)
                    .map(|i| i.source.clone());
                if let Some(hit) = self.resolve_method_on_type(
                    ctx,
                    &inferred,
                    method_name,
                    r,
                    ResolvedBy::InstanceMethod,
                    imported_fqn.as_deref(),
                )? {
                    return Ok(Some(hit));
                }
            }
        }

        // Strategy 0.5: declaration-evidence receiver type.
        if dot_match_used && declaration_evidence_languages(&r.language) {
            match self.match_method_call_by_declaration(ctx, object_or_class, method_name, r)? {
                TriState::Resolved(res) => return Ok(Some(res)),
                TriState::Veto => return Ok(None),
                TriState::FallThrough => {}
            }
            // No `= new` evidence — a typed parameter is the next-strongest.
            match self.match_method_call_by_param_type(ctx, object_or_class, method_name, r)? {
                TriState::Resolved(res) => return Ok(Some(res)),
                TriState::Veto => return Ok(None),
                TriState::FallThrough => {}
            }
        }

        // Object-literal namespace receiver (#1573) — same file only.
        if dot_match_used && !object_or_class.contains('.') && object_literal_languages(&r.language) {
            let holders: Vec<CtxNode> =
                Self::prefer_call_site_file(ctx.nodes_by_name(object_or_class)?, &r.file_path)
                    .into_iter()
                    .filter(|n| {
                        (n.kind == "constant" || n.kind == "variable") && n.file_path == r.file_path
                    })
                    .collect();
            for holder in &holders {
                if let Some(hit) = self.resolve_object_literal_member(
                    ctx,
                    holder,
                    method_name,
                    r,
                    ResolvedBy::InstanceMethod,
                )? {
                    return Ok(Some(hit));
                }
                // #1932: a member that aliases an OUTER function — containment
                // found nothing, so follow the binding the member names.
                if let Some(hit) =
                    self.resolve_object_literal_binding(ctx, holder, method_name, r, ext)?
                {
                    return Ok(Some(hit));
                }
            }
        }

        // Strategy 1: Direct class name match.
        let class_candidates = ctx.nodes_by_name(object_or_class)?;
        for class_node in &class_candidates {
            if matches!(
                class_node.kind.as_str(),
                "class" | "struct" | "union" | "interface"
            )
                || (class_node.language == "scala" && class_node.kind == "module")
            {
                if class_node.language != r.language {
                    continue;
                }
                let nodes_in_file = ctx.nodes_in_file(&class_node.file_path)?;
                let method_node = nodes_in_file.iter().find(|n| {
                    n.kind == "method" && n.name == method_name && n.qualified_name.contains(&class_node.name)
                });
                if let Some(mn) = method_node {
                    return Ok(Some(Resolved::new(mn.id.clone(), ResolvedBy::QualifiedName)));
                }
            }
        }

        // Built-in method names need a validated receiver (#1987). Typed,
        // imported, object-literal and direct class receivers have had their
        // chance above; capitalization, word overlap or a unique method name
        // are not evidence that `list.map()` / `cache.get()` calls a project
        // class. Mirrors name-matcher.ts's JS_BUILTIN_METHODS veto.
        if r.reference_kind == "calls"
            && js_family(&r.language)
            && object_or_class != "this"
            && object_or_class != "super"
            && js_builtin_methods().contains(method_name)
        {
            return Ok(None);
        }

        // Strategy 2: capitalized receiver ("permissionEngine" → "PermissionEngine").
        let capitalized = capitalize_first(object_or_class);
        if capitalized != object_or_class {
            let fuzzy_class_candidates = ctx.nodes_by_name(&capitalized)?;
            for class_node in &fuzzy_class_candidates {
                if matches!(
                    class_node.kind.as_str(),
                    "class" | "struct" | "union" | "interface"
                )
                    || (class_node.language == "scala" && class_node.kind == "module")
                {
                    if class_node.language != r.language {
                        continue;
                    }
                    let nodes_in_file = ctx.nodes_in_file(&class_node.file_path)?;
                    let method_node = nodes_in_file.iter().find(|n| {
                        n.kind == "method" && n.name == method_name && n.qualified_name.contains(&class_node.name)
                    });
                    if let Some(mn) = method_node {
                        return Ok(Some(Resolved::new(mn.id.clone(), ResolvedBy::InstanceMethod)));
                    }
                }
            }
        }

        // Strategy 3: methods by name, receiver/class word-overlap scoring.
        if !method_name.is_empty() {
            let method_candidates = ctx.nodes_by_name(method_name)?;
            // Same-name ceiling: refuse to guess beyond any real codebase.
            if method_candidates.len() as i64 > self.ambiguous_ceiling {
                return Ok(None);
            }
            let methods: Vec<&CtxNode> = method_candidates
                .iter()
                .filter(|n| n.kind == "method" && n.name == method_name)
                .collect();
            let same_language: Vec<&CtxNode> = methods.iter().copied().filter(|m| m.language == r.language).collect();
            let target_methods: Vec<&CtxNode> = if !same_language.is_empty() { same_language } else { methods };
            // Single same-language method — import-reachability veto applies
            // ONLY to this branch.
            if target_methods.len() == 1 && target_methods[0].language == r.language {
                let imports = self.ref_import_mappings(ctx, r)?;
                if !Self::cross_file_candidate_allowed(r, target_methods[0], &imports) {
                    return Ok(None);
                }
                return Ok(Some(Resolved::new(
                    target_methods[0].id.clone(),
                    ResolvedBy::InstanceMethod,
                )));
            }
            // Multiple: score by receiver-name word overlap with the class name.
            if target_methods.len() > 1 {
                let receiver_words = split_camel_case(object_or_class);
                let mut best_match: Option<&CtxNode> = None;
                let mut best_score = 0i32;
                for method in &target_methods {
                    let class_words = split_camel_case(&method.qualified_name);
                    let mut score = receiver_words
                        .iter()
                        .filter(|w| {
                            class_words.iter().any(|cw| cw.to_lowercase() == w.to_lowercase())
                        })
                        .count() as i32;
                    if method.language == r.language {
                        score += 1;
                    }
                    if score > best_score {
                        best_score = score;
                        best_match = Some(*method);
                    }
                }
                if let Some(bm) = best_match {
                    if best_score >= 2 {
                        return Ok(Some(Resolved::new(bm.id.clone(), ResolvedBy::InstanceMethod)));
                    }
                }
            }
        }
        Ok(None)
    }

    // -- fuzzy + orchestrator (:2947-3215) -----------------------------------

    /// matchFuzzy (:3070-3116).
    pub(crate) fn match_fuzzy(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        let lower_name = r.reference_name.to_lowercase();
        let candidates = ctx.nodes_by_lower_name(&lower_name)?;
        let callable_candidates: Vec<&CtxNode> = candidates
            .iter()
            .filter(|n| matches!(n.kind.as_str(), "function" | "method" | "class"))
            .collect();
        // Same import-aware veto as exact matching.
        let fuzzy_imports = self.ref_import_mappings(ctx, r)?;
        let reachable: Vec<&CtxNode> = callable_candidates
            .iter()
            .copied()
            .filter(|n| Self::cross_file_candidate_allowed(r, n, &fuzzy_imports))
            .collect();
        let same_language: Vec<&CtxNode> = reachable.iter().copied().filter(|n| n.language == r.language).collect();
        let final_candidates: Vec<&CtxNode> = if !same_language.is_empty() { same_language } else { reachable };
        // Post-rank survivor validation — rejection never filters the set that
        // produced it (never manufacture a guess out of an ambiguity).
        if final_candidates.len() == 1 {
            let survivor = final_candidates[0];
            let bare_js = self.is_bare_js_call(ctx, r)?;
            if self.is_visible_across_files(ctx, survivor, r)?
                && self.is_cross_file_reachable(ctx, survivor, r)?
                && !(bare_js
                    && (survivor.kind == "method"
                        || (survivor.file_path != r.file_path
                            && self.is_locally_bound_js_name(ctx, &r.reference_name, &r.file_path)?)))
                && !(survivor.kind == "method" && self.is_bare_go_call(ctx, r)?)
            {
                return Ok(Some(Resolved::new(survivor.id.clone(), ResolvedBy::Fuzzy)));
            }
        }
        Ok(None)
    }

    /// matchReference (:3122-3215) — fixed try order, first hit wins.
    pub(crate) fn match_reference(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        self.sync_memos(ctx);
        // Function-as-value refs resolve ONLY through the dedicated matcher.
        if r.reference_kind == "function_ref" {
            return self.match_function_ref(ctx, r);
        }
        // A retained untyped qualified chain (`a.b.c`, 3+ segments): nothing
        // below may guess for it.
        if Self::is_unresolved_js_member_call(r) {
            return Ok(None);
        }
        // 0. File path match
        if let Some(res) = self.match_by_file_path(ctx, r)? {
            return Ok(Some(res));
        }
        // 1. Qualified name match
        if let Some(res) = self.match_by_qualified_name(ctx, r)? {
            return Ok(Some(res));
        }
        // 1b. C++ chained call whose receiver is another call (#645)
        if r.language == "cpp" || r.language == "c" {
            if let Some(res) = self.match_cpp_call_chain(ctx, r)? {
                return Ok(Some(res));
            }
        }
        // 1c. `::`-scoped factory chain — PHP (#608) / Rust
        if r.language == "php" || r.language == "rust" {
            if let Some(res) = self.match_scoped_call_chain(ctx, r)? {
                return Ok(Some(res));
            }
        }
        // 1d. Dotted chained static-factory / fluent call
        if matches!(
            r.language.as_str(),
            "java" | "kotlin" | "csharp" | "swift" | "go" | "scala" | "dart" | "objc" | "pascal"
        ) {
            if let Some(res) = self.match_dotted_call_chain(ctx, r, ext)? {
                return Ok(Some(res));
            }
        }
        // A call-receiver chain `<inner>().<method>` for TS/JS/Python (#1683):
        // the store-accessor fallback is the ONE kept resolution; its answer
        // (including null) is FINAL.
        if r.reference_name.contains("().")
            && matches!(
                r.language.as_str(),
                "typescript" | "javascript" | "tsx" | "jsx" | "python"
            )
        {
            return self.match_store_accessor_chain(ctx, r, ext);
        }
        // 2. Method call pattern
        if let Some(res) = self.match_method_call(ctx, r, ext)? {
            return Ok(Some(res));
        }
        // 3. Exact name match
        if let Some(res) = self.match_by_exact_name(ctx, r, ext)? {
            return Ok(Some(res));
        }
        // 4. Fuzzy match
        if let Some(res) = self.match_fuzzy(ctx, r)? {
            return Ok(Some(res));
        }
        Ok(None)
    }

    // -----------------------------------------------------------------------
    // resolveOne face — resolution/index.ts
    // -----------------------------------------------------------------------

    /// hasAnyPossibleMatch (index.ts:683-722).
    pub(crate) fn has_any_possible_match(&mut self, ctx: &mut CtxConn, name: &str) -> Result<bool> {
        let known = ctx.known_names()?;
        // Direct name match
        if known.contains(name) {
            return Ok(true);
        }
        // Qualified names "obj.method" / "Class::method" — check the parts.
        if let Some(dot_idx) = name.find('.') {
            if dot_idx > 0 {
                let receiver = &name[..dot_idx];
                let member = &name[dot_idx + 1..];
                if known.contains(receiver) || known.contains(member) {
                    return Ok(true);
                }
                // Capitalized receiver (instance-method resolution).
                let capitalized = capitalize_first(receiver);
                if known.contains(capitalized.as_str()) {
                    return Ok(true);
                }
                // JVM FQN: `com.example.foo.Bar` — the last segment.
                if let Some(last_dot) = name.rfind('.') {
                    if last_dot > dot_idx {
                        let tail = &name[last_dot + 1..];
                        if !tail.is_empty() && known.contains(tail) {
                            return Ok(true);
                        }
                    }
                }
            }
        }
        if let Some(colon_idx) = name.find("::") {
            if colon_idx > 0 {
                let receiver = &name[..colon_idx];
                let member = &name[colon_idx + 2..];
                if known.contains(receiver) || known.contains(member) {
                    return Ok(true);
                }
            }
        }
        // Path-like references — check the filename.
        if let Some(slash_idx) = name.rfind('/') {
            if slash_idx > 0 {
                let file_name = &name[slash_idx + 1..];
                if known.contains(file_name) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// matchesAnyImport (index.ts:729-741).
    fn matches_any_import(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<bool> {
        let imports = ctx.import_mappings(&r.file_path, &r.language)?;
        Ok(imports.iter().any(|imp| {
            imp.local_name == r.reference_name
                || r.reference_name.starts_with(&format!("{}.", imp.local_name))
        }))
    }

    /// isBuiltInOrExternal (index.ts:1378-1477).
    pub(crate) fn is_built_in_or_external(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<bool> {
        let name = r.reference_name.as_str();
        let is_js_ts = matches!(
            r.language.as_str(),
            "typescript" | "javascript" | "tsx" | "jsx"
        );
        // JavaScript/TypeScript built-ins
        if is_js_ts && js_built_ins().contains(name) {
            return Ok(true);
        }
        // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
        if is_js_ts && (name.starts_with("console.") || name.starts_with("Math.") || name.starts_with("JSON.")) {
            return Ok(true);
        }
        // React hooks from React itself
        if is_js_ts && react_hooks().contains(name) {
            return Ok(true);
        }
        if r.language == "python" {
            // Python built-ins (bare calls only)
            if python_built_ins().contains(name) {
                return Ok(true);
            }
            if let Some(dot_idx) = name.find('.') {
                if dot_idx > 0 {
                    let receiver = &name[..dot_idx];
                    let method = &name[dot_idx + 1..];
                    if python_builtin_types().contains(receiver) {
                        return Ok(true);
                    }
                    // Built-in methods on non-class receivers — allowed when
                    // the capitalized receiver names a known codebase class.
                    if python_builtin_methods().contains(method) {
                        let capitalized = capitalize_first(receiver);
                        if !ctx.known_names()?.contains(capitalized.as_str()) {
                            return Ok(true);
                        }
                    }
                }
            }
            // A bare name colliding with a builtin method is only a builtin
            // when NOTHING in the codebase declares it.
            if python_builtin_methods().contains(name) && !ctx.known_names()?.contains(name) {
                return Ok(true);
            }
        }
        // Go standard library packages / builtins
        if r.language == "go" {
            if let Some(dot_idx) = name.find('.') {
                if dot_idx > 0 {
                    let pkg = &name[..dot_idx];
                    if go_stdlib_packages().contains(pkg) {
                        return Ok(true);
                    }
                }
            }
            if go_built_ins().contains(name) {
                return Ok(true);
            }
        }
        // Pascal/Delphi built-ins and standard library units
        if r.language == "pascal" {
            if PASCAL_UNIT_PREFIXES.iter().any(|p| name.starts_with(p)) {
                return Ok(true);
            }
            if pascal_built_ins().contains(name) {
                return Ok(true);
            }
        }
        // C/C++ standard library symbols — filtered ONLY when no user node
        // shares the name (projects routinely shadow stdlib names).
        if r.language == "c" || r.language == "cpp" {
            // `std::` is never a user-defined qualified name in tree-sitter output.
            if name.starts_with("std::") {
                return Ok(true);
            }
            if c_built_ins().contains(name) || cpp_built_ins().contains(name) {
                return Ok(!self.has_any_possible_match(ctx, name)?);
            }
        }
        Ok(false)
    }

    /// resolveThisMemberFnRef (index.ts:908-938) — #756/#808.
    fn resolve_this_member_fn_ref(&mut self, ctx: &mut CtxConn, r: &RefIn) -> Result<Option<Resolved>> {
        let member = &r.reference_name["this.".len()..];
        if member.is_empty() {
            return Ok(None);
        }
        let Some(from_node) = ctx.get_node_by_id(&r.from_node_id)? else {
            return Ok(None);
        };
        // A hook declared at class-body level attributes to the CLASS node
        // itself — its qualified name IS the scope.
        let class_prefix = if class_scope_kinds().contains(from_node.kind.as_str()) {
            from_node.qualified_name.clone()
        } else {
            let sep = from_node.qualified_name.rfind("::").map(|i| i as i64).unwrap_or(-1);
            if sep <= 0 {
                return Ok(None); // not inside a class scope
            }
            from_node.qualified_name[..sep as usize].to_string()
        };
        let candidates: Vec<CtxNode> = ctx
            .nodes_by_qualified_name(&format!("{class_prefix}::{member}"))?
            .into_iter()
            .filter(|n| {
                (n.kind == "function" || n.kind == "method")
                    && n.file_path == r.file_path
                    && n.id != r.from_node_id
            })
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        // reduce((a, b) => a.startLine <= b.startLine ? a : b) — first wins ties.
        let mut target = &candidates[0];
        for n in candidates.iter().skip(1) {
            if n.start_line < target.start_line {
                target = n;
            }
        }
        Ok(Some(Resolved::new(target.id.clone(), ResolvedBy::FunctionRef)))
    }

    /// resolveOne (index.ts:749-870) — single-ref full-strategy arbitration.
    /// The import/JVM-import/framework arms read the PRECOMPUTED tables
    /// (Plan A); everything else runs in-crate against CtxConn.
    pub(crate) fn resolve_one(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        ext: &ExternalStrategies,
    ) -> Result<Option<Resolved>> {
        self.sync_memos(ctx);
        // Skip built-in/external references
        if self.is_built_in_or_external(ctx, r)? {
            return Ok(None);
        }
        // Fast pre-filter with the import + framework-claim escapes.
        if !self.has_any_possible_match(ctx, &r.reference_name)?
            && !self.matches_any_import(ctx, r)?
            && !ext.claimed_names.contains(&r.reference_name)
        {
            return Ok(None);
        }
        // Function-as-value refs (#756): dedicated, strictly-gated path.
        if r.reference_kind == "function_ref" {
            if r.reference_name.starts_with("this.") {
                return self.resolve_this_member_fn_ref(ctx, r);
            }
            let key = ImportKey::of(r);
            if let Some(target) = ext.import_results.get(&key) {
                if let Some(t) = ctx.get_node_by_id(target)? {
                    if t.kind == "function"
                        || t.kind == "method"
                        // Python (#1478): an imported class used as a value.
                        || (r.language == "python" && t.kind == "class")
                    {
                        return Ok(Some(Resolved::new(target.clone(), ResolvedBy::Import)));
                    }
                }
            }
            return self.match_function_ref(ctx, r);
        }
        // JVM FQN imports skip framework/name-matcher (resolveJvmImport gate
        // lives in the TS precompute; presence = a result).
        if let Some(target) = ext.jvm_import_results.get(&ImportKey::of(r)) {
            return Ok(Some(Resolved::new(target.clone(), ResolvedBy::Import)));
        }
        let mut candidates: Vec<Resolved> = Vec::new();
        // Strategy 1: framework-specific resolution (detection order).
        if let Some(fws) = ext.framework_results.get(&FwKey::of(r)) {
            for fw in fws {
                // Authoritative evidence resolves immediately.
                if fw.authoritative
                    || fw.resolved_by == ResolvedBy::Import
                    || fw.resolved_by == ResolvedBy::QualifiedName
                {
                    return Ok(Some(fw.to_resolved()));
                }
                candidates.push(fw.to_resolved());
            }
        }
        // A retained untyped qualified chain supplies evidence only.
        if Self::is_unresolved_js_member_call(r) {
            return Ok(None);
        }
        // TS/JS/Python call-receiver chains name the ROOT's import, not the
        // method's — the name-matcher owns the chain shape for these languages.
        if r.reference_kind == "calls"
            && rpats().chain_shape.is_match(&r.reference_name)
            && matches!(
                r.language.as_str(),
                "typescript" | "javascript" | "tsx" | "jsx" | "python"
            )
        {
            return self.match_reference(ctx, r, ext);
        }
        // Strategy 2: import-based resolution — always the strongest available
        // (every precomputed result carries resolvedBy 'import').
        if let Some(target) = ext.import_results.get(&ImportKey::of(r)) {
            return Ok(Some(Resolved::new(target.clone(), ResolvedBy::Import)));
        }
        // Strategy 3: name matching + the post-pipeline visibility guard
        // (K-v2 P5-1/D8) — the rejection is FINAL, never a promoted runner-up.
        let mut name_result = self.match_reference(ctx, r, ext)?;
        if let Some(nr) = &name_result {
            if let Some(target) = ctx.get_node_by_id(&nr.target_node_id)? {
                if !self.is_visible_across_files(ctx, &target, r)? {
                    name_result = None;
                }
            }
        }
        if let Some(nr) = name_result {
            candidates.push(nr);
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        // Strongest evidence class wins; ties fall to same-file, then
        // same-language, then a deterministic id order.
        let picked = self.pick_best_candidate(ctx, r, candidates)?;
        // Inheritance refs may only land on real type definitions
        // (#1536/#2029) — FINAL rejection, never a promoted runner-up.
        // Mirrors resolution/index.ts resolveOneCore's post-validation.
        if let Some(p) = &picked {
            if is_inheritance_ref(r) {
                if let Some(target) = ctx.get_node_by_id(&p.target_node_id)? {
                    if !is_supertype_target(&target) {
                        return Ok(None);
                    }
                }
            }
        }
        Ok(picked)
    }

    /// pickBestCandidate (index.ts:878-892).
    fn pick_best_candidate(
        &mut self,
        ctx: &mut CtxConn,
        r: &RefIn,
        candidates: Vec<Resolved>,
    ) -> Result<Option<Resolved>> {
        let mut iter = candidates.into_iter();
        let Some(first) = iter.next() else { return Ok(None) };
        let mut best = first;
        for curr in iter {
            let rank_diff = curr.resolved_by.rank() - best.resolved_by.rank();
            if rank_diff != 0 {
                if rank_diff > 0 {
                    best = curr;
                }
                continue;
            }
            // On a rank tie TS calls getNodeById TWICE (both lookups run).
            let best_node = ctx.get_node_by_id(&best.target_node_id)?;
            let curr_node = ctx.get_node_by_id(&curr.target_node_id)?;
            let best_same_file = best_node.as_ref().map(|n| n.file_path == r.file_path).unwrap_or(false);
            let curr_same_file = curr_node.as_ref().map(|n| n.file_path == r.file_path).unwrap_or(false);
            if curr_same_file != best_same_file {
                if curr_same_file {
                    best = curr;
                }
                continue;
            }
            if let (Some(cn), Some(bn)) = (&curr_node, &best_node) {
                if cn.language != bn.language {
                    best = if cn.language == r.language { curr } else { best };
                    continue;
                }
            }
            // Lexicographically smaller target id (deterministic across
            // reindexes; ASCII ids make JS `<` and Rust `<` agree).
            if curr.target_node_id < best.target_node_id {
                best = curr;
            }
        }
        Ok(Some(best))
    }

    // -----------------------------------------------------------------------
    // Shared line-read helpers
    // -----------------------------------------------------------------------

    /// `context.getFileLines?.(p) ?? context.readFile?.(p)?.split('\n') ?? []`
    /// — both arms are content.split('\n')-based (the ?? fires only on the
    /// unreadable-file [] where the split arm also yields nothing).
    fn effective_file_lines(&mut self, ctx: &mut CtxConn, file_path: &str) -> Result<Vec<String>> {
        Ok(ctx.file_lines(file_path)?)
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// splitCamelCase (name-matcher.ts:2950-2955).
fn split_camel_case(s: &str) -> Vec<String> {
    let p = rpats();
    let t1 = p.camel_a.replace_all(s, "${1} ${2}");
    let t2 = p.camel_b.replace_all(&t1, "${1} ${2}");
    p.camel_split
        .split(&t2)
        .map(|x| x.to_string())
        .filter(|w| js_len(w) > 1)
        .collect()
}

/// computePathProximity (name-matcher.ts:2962-2977) — 15 points per shared
/// directory segment, capped at 80.
fn compute_path_proximity(file_path1: &str, file_path2: &str) -> i32 {
    let mut dir1 = js_split(file_path1, '/');
    dir1.pop();
    let mut dir2 = js_split(file_path2, '/');
    dir2.pop();
    let mut shared = 0i32;
    for i in 0..dir1.len().min(dir2.len()) {
        if dir1[i] == dir2[i] {
            shared += 1;
        } else {
            break;
        }
    }
    (shared * 15).min(80)
}

/// findBestMatch (name-matcher.ts:2982-3065) — scoring is f64 (the line-
/// distance term is fractional); strict `>` keeps the FIRST best.
fn find_best_match(r: &RefIn, candidates: &[CtxNode]) -> Option<CtxNode> {
    let mut best_score = -1f64;
    let mut best_node: Option<CtxNode> = None;
    for candidate in candidates {
        let mut score = 0f64;
        // Same file bonus
        if candidate.file_path == r.file_path {
            score += 100.0;
        }
        // Directory proximity bonus
        score += compute_path_proximity(&r.file_path, &candidate.file_path) as f64;
        // Language matching
        if candidate.language == r.language {
            score += 50.0;
        } else {
            score -= 80.0;
        }
        match r.reference_kind.as_str() {
            // For call references, prefer functions/methods
            "calls" => {
                if candidate.kind == "function" || candidate.kind == "method" {
                    score += 25.0;
                }
            }
            // For instantiation references, prefer class-like targets
            "instantiates" => {
                if matches!(
                    candidate.kind.as_str(),
                    "class" | "struct" | "union" | "interface"
                ) {
                    score += 25.0;
                }
            }
            // For decorator references, prefer functions (classes smaller)
            "decorates" => {
                if candidate.kind == "function" || candidate.kind == "method" {
                    score += 25.0;
                } else if candidate.kind == "class" || candidate.kind == "interface" {
                    score += 15.0;
                }
            }
            _ => {}
        }
        // Exported bonus
        if candidate.is_exported == 1 {
            score += 10.0;
        }
        // Closer line number (within same file) — `candidate.startLine` truthy
        if candidate.file_path == r.file_path && candidate.start_line != 0 {
            let distance = (candidate.start_line - r.line).abs();
            score += (20.0 - distance as f64 / 10.0).max(0.0);
        }
        if score > best_score {
            best_score = score;
            best_node = Some(candidate.clone());
        }
    }
    best_node
}

/// The `[sameFile…, other…]` ordering used by declaredReceiverTypeName /
/// dottedFactoryTypeName (reachable filter, then same-file first).
fn order_same_file_first<'a>(nodes: &'a [CtxNode], r: &RefIn, imports: &[ImportMapping]) -> Vec<&'a CtxNode> {
    let reachable: Vec<&CtxNode> = nodes
        .iter()
        .filter(|n| Resolver::cross_file_candidate_allowed(r, n, imports))
        .collect();
    let mut ordered: Vec<&CtxNode> = reachable.iter().copied().filter(|n| n.file_path == r.file_path).collect();
    ordered.extend(reachable.iter().copied().filter(|n| n.file_path != r.file_path));
    ordered
}

/// `lines.slice(0, line_idx).concat(lines[line_idx]?.slice(0, column)).join('\n')`
fn build_before_text<S: AsRef<str>>(lines: &[S], line_idx: usize, column: usize) -> String {
    let mut parts: Vec<String> = lines[..line_idx.min(lines.len())].iter().map(|s| s.as_ref().to_string()).collect();
    parts.push(js_slice_to(lines.get(line_idx).map(|s| s.as_ref()).unwrap_or(""), column).to_string());
    parts.join("\n")
}

/// The `{`/`}` position stack at `end` (matchDestructuredStoreCall /
/// matchSelectedStoreCall / importShadowedAt block-identity checks).
fn stack_at(code: &str, end: usize) -> Vec<usize> {
    let mut stack: Vec<usize> = Vec::new();
    for (i, b) in code.bytes().enumerate().take(end) {
        if b == b'{' {
            stack.push(i);
        } else if b == b'}' {
            stack.pop();
        }
    }
    stack
}

/// JS `split(/::|\./)` — segments on "::" or "." (empty segments kept, the
/// callers filter(Boolean)).
fn split_colon_or_dot(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'.' {
            out.push(&s[start..i]);
            i += 1;
            start = i;
        } else if bytes[i] == b':' && i + 1 < bytes.len() && bytes[i + 1] == b':' {
            out.push(&s[start..i]);
            i += 2;
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&s[start..]);
    out
}

/// path.posix.dirname.
fn posix_dirname(p: &str) -> &str {
    match p.rfind('/') {
        None => ".",
        Some(0) => "/",
        Some(i) => &p[..i],
    }
}

/// Tri-state result of the Strategy 0.5/0.5b declaration-evidence matchers:
/// `undefined` (fall through), `null` (veto), or the bound method.
enum TriState {
    Resolved(Resolved),
    Veto,
    FallThrough,
}

/// CPP_NON_TYPE_TOKENS (name-matcher.ts:765-770).
fn cpp_non_type_tokens() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "return", "if", "else", "for", "while", "do", "switch", "case", "default",
            "break", "continue", "goto", "throw", "new", "delete", "co_await", "co_yield",
            "co_return", "static_cast", "const_cast", "dynamic_cast", "reinterpret_cast",
            "sizeof", "alignof", "typeid", "and", "or", "not", "xor",
        ])
    })
}

/// RUST_NON_PROJECT_FIELD_TYPES (name-matcher.ts:1359-1365).
fn rust_non_project_field_types() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&[
            "bool", "char", "str", "String",
            "i8", "i16", "i32", "i64", "i128", "isize",
            "u8", "u16", "u32", "u64", "u128", "usize",
            "f32", "f64",
            "Self", "self",
        ])
    })
}

/// CLASS_SCOPE_KINDS (index.ts:97-99).
fn class_scope_kinds() -> &'static HashSet<&'static str> {
    static T: OnceLock<HashSet<&'static str>> = OnceLock::new();
    T.get_or_init(|| {
        set(&["class", "struct", "interface", "trait", "protocol", "enum", "module"])
    })
}

// ---------------------------------------------------------------------------
// R3c-2 — createEdges + dedupe + file-level import sweep (resolution/index.ts)
// ---------------------------------------------------------------------------

/// One createEdges output edge (index.ts:943-1016). The edge's final
/// `metadata` OBJECT is assembled by the TS decoder from the stamp fields in
/// exact JS spread order ({...t.metadata, resolvedBy, refName, refKind?,
/// fnRef?}) — Rust never builds the object, so stored JSON key order matches
/// the TS arm byte-for-byte.
pub(crate) struct EdgeRow {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub line: i64,
    pub column: i64,
    /// Strategy/framework-provided t.metadata as raw JSON text (never
    /// parsed here — order-preserving passthrough).
    pub target_metadata: Option<String>,
    pub resolved_by: String,
    pub ref_name: String,
    /// Set only when a kind promotion rewrote the edge kind.
    pub ref_kind: Option<String>,
    pub fn_ref: bool,
}

/// createEdges for ONE resolved ref (index.ts:943-1016), minus the final
/// dedupe (applied over the whole batch output).
fn create_edges(ctx: &mut CtxConn, r: &RefIn, res: &Resolved) -> Result<Vec<EdgeRow>> {
    let mut kind = match &res.edge_kind {
        Some(k) => k.clone(),
        None => {
            if r.reference_kind == "function_ref" {
                "references".to_string()
            } else {
                r.reference_kind.clone()
            }
        }
    };
    // Promote "extends" to "implements" when a class/struct targets an interface.
    if kind == "extends" {
        if let Some(target) = ctx.get_node_by_id(&res.target_node_id)? {
            if target.kind == "interface" || target.kind == "protocol" {
                if let Some(source) = ctx.get_node_by_id(&r.from_node_id)? {
                    if source.kind != "interface" && source.kind != "protocol" {
                        kind = "implements".to_string();
                    }
                }
            }
        }
    }
    // Promote "calls" to "instantiates" when the resolved target is a
    // class/struct/union (Python/Ruby express instantiation as `Foo()`).
    if kind == "calls" {
        if let Some(target) = ctx.get_node_by_id(&res.target_node_id)? {
            if target.kind == "class" || target.kind == "struct" || target.kind == "union" {
                kind = "instantiates".to_string();
            }
        }
    }
    // One reference can name several targets — each becomes its own edge.
    let mut targets: Vec<(&str, Option<&str>)> = vec![(res.target_node_id.as_str(), res.metadata.as_deref())];
    for a in &res.also_targets {
        targets.push((a.target_node_id.as_str(), a.metadata.as_deref()));
    }
    let ref_kind = if r.reference_kind != kind { Some(r.reference_kind.clone()) } else { None };
    Ok(targets
        .into_iter()
        .map(|(target, target_metadata)| EdgeRow {
            source: r.from_node_id.clone(),
            target: target.to_string(),
            kind: kind.clone(),
            line: r.line,
            column: r.column,
            target_metadata: target_metadata.map(|s| s.to_string()),
            resolved_by: res.resolved_by.as_str().to_string(),
            ref_name: r.reference_name.clone(),
            ref_kind: ref_kind.clone(),
            fn_ref: r.reference_kind == "function_ref",
        })
        .collect())
}

/// dedupeSymbolImportEdges (index.ts:126-145) — an `imports` edge is a
/// file→symbol dependency FACT; multiplicity carries no graph information.
/// Deterministic keep-rule: lowest (line, column) wins.
fn dedupe_symbol_import_edges(edges: Vec<EdgeRow>) -> Vec<EdgeRow> {
    let mut kept_index: HashMap<(String, String), usize> = HashMap::new();
    let mut out: Vec<EdgeRow> = Vec::new();
    let rank = |e: &EdgeRow| e.line * 0x1000000 + e.column;
    for edge in edges {
        if edge.kind != "imports" {
            out.push(edge);
            continue;
        }
        let key = (edge.source.clone(), edge.target.clone());
        match kept_index.get(&key) {
            None => {
                kept_index.insert(key, out.len());
                out.push(edge);
            }
            Some(&at) => {
                if rank(&edge) < rank(&out[at]) {
                    out[at] = edge;
                }
            }
        }
    }
    out
}

/// One file-level import sweep row (materializeFileLevelImportEdges output).
/// The TS side runs deleteFileLevelImportEdgesBySource(source_node_id) then
/// bulk-inserts `edges` — EVERY row means delete-then-insert (the TS delete
/// runs before the mappings-empty check, so a zero-edge row is meaningful).
pub(crate) struct SweepRow {
    pub source_node_id: String,
    pub edges: Vec<EdgeRow>,
}

fn re_source(re: &ReExport) -> &str {
    match re {
        ReExport::Named { source, .. } => source,
        ReExport::Wildcard { source } => source,
    }
}

/// materializeFileLevelImportEdges (index.ts:1036-1090) for the given files.
/// resolveImportPath decisions arrive as the TS-precomputed (file,
/// specifier) → resolved-path table (Plan A seam: aliases/go-module/
/// cpp-include-dirs stay TS). The delete stays TS-side — the store wire's op
/// vocabulary is frozen (STORE_ABI untouched).
fn file_level_import_sweep(
    ctx: &mut CtxConn,
    files: &[String],
    paths: &HashMap<(String, String), Option<String>>,
) -> Result<Vec<SweepRow>> {
    let mut out: Vec<SweepRow> = Vec::new();
    let mut seen_sources: HashSet<String> = HashSet::new();
    for file_path in files {
        // getFileByPath — record existence + language (no record → skip).
        let Some(language) = ctx.file_record_language(file_path)? else { continue };
        let source_node_id = {
            let nodes = ctx.nodes_in_file(file_path)?;
            match nodes.iter().find(|n| n.kind == "file") {
                Some(n) => n.id.clone(),
                None => continue,
            }
        };
        // delete-then-insert idempotence: ONE sweep row per source node.
        if !seen_sources.insert(source_node_id.clone()) {
            continue;
        }
        let mut row = SweepRow { source_node_id: source_node_id.clone(), edges: Vec::new() };
        let mappings = ctx.import_mappings(file_path, &language)?;
        let re_exports = ctx.re_exports(file_path, &language)?;
        if !mappings.is_empty() || !re_exports.is_empty() {
            // Import and re-export sources share ONE dedupe set.
            let mut seen: HashSet<String> = HashSet::new();
            let mut sources: Vec<String> = Vec::new();
            for m in &mappings {
                if seen.insert(m.source.clone()) {
                    sources.push(m.source.clone());
                }
            }
            for re in &re_exports {
                let s = re_source(re).to_string();
                if seen.insert(s.clone()) {
                    sources.push(s);
                }
            }
            for source in &sources {
                // resolveImportPath: precomputed; absent key or NONE → null.
                let resolved = paths
                    .get(&(file_path.clone(), source.clone()))
                    .cloned()
                    .unwrap_or(None);
                let Some(resolved) = resolved else { continue };
                if resolved == *file_path {
                    continue;
                }
                let target_node_id = {
                    let nodes = ctx.nodes_in_file(&resolved)?;
                    match nodes.iter().find(|n| n.kind == "file") {
                        Some(n) => n.id.clone(),
                        None => continue,
                    }
                };
                row.edges.push(EdgeRow {
                    source: source_node_id.clone(),
                    target: target_node_id,
                    kind: "imports".to_string(),
                    line: 0,
                    column: 0,
                    target_metadata: None,
                    resolved_by: "import".to_string(),
                    // Deliberately NO refName stamp — synthesized file-level
                    // edges must never resurrect (index.ts:1026-1028).
                    ref_name: String::new(),
                    ref_kind: None,
                    fn_ref: false,
                });
            }
        }
        out.push(row);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Batch main loop — resolveBatchYielding's per-batch body (index.ts:631-676)
// ---------------------------------------------------------------------------

pub(crate) struct BatchInput {
    pub refs: Vec<RefIn>,
    pub ext: ExternalStrategies,
    /// (file, import specifier) → resolveImportPath result (None = null).
    pub import_paths: HashMap<(String, String), Option<String>>,
    pub flags: u32,
}

pub(crate) struct BatchOutput {
    /// createEdges output (dedupeSymbolImportEdges applied).
    pub edges: Vec<EdgeRow>,
    pub sweeps: Vec<SweepRow>,
    /// (row id | -1, from_node_id, reference_name, reference_kind) — resolved
    /// rows drive deleteUnresolvedReferences, failed rows markReferencesFailed.
    pub resolved: Vec<(i64, String, String, String)>,
    pub failed: Vec<(i64, String, String, String)>,
    pub total: u32,
    pub resolved_count: u32,
    pub unresolved_count: u32,
    /// byMethod — first-appearance key order (JS Record insertion parity).
    pub by_method: Vec<(String, u32)>,
}

/// The full per-batch pipeline: per-ref resolveOne → createEdges → dedupe →
/// (optional) file-level import sweep. Persistence stays TS-side through the
/// existing QueryBuilder/StoreBridge arms (R3a op vocabulary unchanged).
pub(crate) fn resolve_batch_core(ctx: &mut CtxConn, res: &mut Resolver, input: BatchInput) -> Result<BatchOutput> {
    let total = input.refs.len();
    let mut raw_edges: Vec<EdgeRow> = Vec::new();
    let mut resolved: Vec<(i64, String, String, String)> = Vec::new();
    let mut failed: Vec<(i64, String, String, String)> = Vec::new();
    let mut by_method: Vec<(String, u32)> = Vec::new();
    // [...new Set(batch.map(ref => ref.filePath))] — first-appearance order.
    let mut batch_files: Vec<String> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    for r in &input.refs {
        if seen_files.insert(r.file_path.clone()) {
            batch_files.push(r.file_path.clone());
        }
        match res.resolve_one(ctx, r, &input.ext)? {
            Some(hit) => {
                let key = hit.resolved_by.as_str();
                match by_method.iter_mut().find(|(k, _)| k == key) {
                    Some(entry) => entry.1 += 1,
                    None => by_method.push((key.to_string(), 1)),
                }
                raw_edges.extend(create_edges(ctx, r, &hit)?);
                resolved.push((r.id.unwrap_or(-1), r.from_node_id.clone(), r.reference_name.clone(), r.reference_kind.clone()));
            }
            None => {
                failed.push((-1, r.from_node_id.clone(), r.reference_name.clone(), r.reference_kind.clone()));
            }
        }
    }
    let edges = dedupe_symbol_import_edges(raw_edges);
    let sweeps = if input.flags & RESOLVE_FLAG_SWEEP_BATCH_FILES != 0 {
        file_level_import_sweep(ctx, &batch_files, &input.import_paths)?
    } else {
        Vec::new()
    };
    let resolved_count = resolved.len() as u32;
    let unresolved_count = failed.len() as u32;
    Ok(BatchOutput {
        edges,
        sweeps,
        resolved,
        failed,
        total: total as u32,
        resolved_count,
        unresolved_count,
        by_method,
    })
}

// ---------------------------------------------------------------------------
// RESOLVE wire (RESOLVE_ABI_VERSION = 1) — layouts in the module docs
// ---------------------------------------------------------------------------

/// RESOLVE wire ABI — independent numbering from KERNEL/STORE/CTX ABIs; the
/// TS loader verifies equality before routing any batch.
pub const RESOLVE_ABI_VERSION: u8 = 1;
/// Semantic version reported alongside the ABI number.
pub const RESOLVE_VERSION: &str = "1.0.0";

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

/// flags bit0: sweep the batch's own files for file-level import edges.
pub const RESOLVE_FLAG_SWEEP_BATCH_FILES: u32 = 1;

/// Strategy manifest for the contract gate — the TS loader checks every name
/// against the fork's strategy table (kernel ⊆ fork subset direction, the
/// loader.ts:150-167 kind-table discipline).
pub const RESOLVE_STRATEGY_TABLE: &[&str] = &[
    "file-path",
    "qualified-name",
    "cpp-call-chain",
    "scoped-call-chain",
    "dotted-call-chain",
    "store-accessor-chain",
    "method-call",
    "method-call-by-declaration",
    "method-call-by-param-type",
    "object-literal-member",
    "rust-self-call",
    "rust-self-field-call",
    "ts-this-field-call",
    "java-field-receiver",
    "exact-match",
    "fuzzy",
    "function-ref",
    "js-store-binding",
    "this-member-fn-ref",
    "import-precomputed",
    "jvm-import-precomputed",
    "framework-precomputed",
    "visible-across-files",
    "cross-file-reachable",
    "import-veto",
    "builtin-external-prefilter",
    "known-names-prefilter",
    "create-edges",
    "dedupe-symbol-import-edges",
    "materialize-file-level-import-edges",
    "pick-best-candidate",
];

/// Content version of the builtin name tables (js-builtins.ts port) — a
/// stable hash over the union of every table's entries.
fn builtins_version() -> String {
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| {
        use std::collections::BTreeSet;
        use std::hash::{Hash, Hasher};
        let mut names: BTreeSet<&str> = BTreeSet::new();
        for t in [
            js_built_ins(),
            js_builtin_methods(),
            ts_primitive_types(),
            react_hooks(),
            python_built_ins(),
            python_builtin_types(),
            python_builtin_methods(),
            go_stdlib_packages(),
            go_built_ins(),
            pascal_built_ins(),
            c_built_ins(),
            cpp_built_ins(),
        ] {
            names.extend(t.iter().copied());
        }
        names.extend(PASCAL_UNIT_PREFIXES.iter().copied());
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for n in &names {
            n.hash(&mut h);
        }
        format!("builtin-tables-v1-{:016x}", h.finish())
    })
    .clone()
}

fn rd_u8(b: &[u8], at: usize) -> Result<u8> {
    b.get(at).copied().ok_or_else(|| rerr("resolve wire: truncated u8".into()))
}

fn rd_u32(b: &[u8], at: usize) -> Result<u32> {
    let s = b.get(at..at + 4).ok_or_else(|| rerr("resolve wire: truncated u32".into()))?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn rd_i64(b: &[u8], at: usize) -> Result<i64> {
    let s = b.get(at..at + 8).ok_or_else(|| rerr("resolve wire: truncated i64".into()))?;
    Ok(i64::from_le_bytes(s.try_into().unwrap()))
}

/// String slot → arena slice. A NONE offset reads as "" (required slots are
/// never NONE from the encoder); use rd_opt_str for optional slots.
fn rd_str<'a>(arena: &'a [u8], b: &[u8], at: usize) -> Result<&'a str> {
    let off = rd_u32(b, at)?;
    let len = rd_u32(b, at + 4)?;
    if off == NONE {
        return Ok("");
    }
    let end = (off as usize)
        .checked_add(len as usize)
        .ok_or_else(|| rerr("resolve wire: str overflow".into()))?;
    let bytes = arena
        .get(off as usize..end)
        .ok_or_else(|| rerr("resolve wire: str outside arena".into()))?;
    std::str::from_utf8(bytes).map_err(|e| rerr(format!("resolve wire: invalid utf8 ({e})")))
}

fn rd_opt_str<'a>(arena: &'a [u8], b: &[u8], at: usize) -> Result<Option<&'a str>> {
    if rd_u32(b, at)? == NONE {
        return Ok(None);
    }
    Some(rd_str(arena, b, at)).transpose()
}

fn decode_external(b: &[u8], arena: &[u8]) -> Result<(ExternalStrategies, HashMap<(String, String), Option<String>>)> {
    if b.len() < RESOLVE_EXT_HEADER_SIZE {
        return Err(rerr("resolve wire: external header truncated".into()));
    }
    if b[0] != RESOLVE_ABI_VERSION {
        return Err(rerr(format!("resolve wire: external abi {} != {}", b[0], RESOLVE_ABI_VERSION)));
    }
    let import_count = rd_u32(b, 4)? as usize;
    let jvm_count = rd_u32(b, 8)? as usize;
    let fwg_count = rd_u32(b, 12)? as usize;
    let fwc_count = rd_u32(b, 16)? as usize;
    let also_count = rd_u32(b, 20)? as usize;
    let claimed_count = rd_u32(b, 24)? as usize;
    let path_count = rd_u32(b, 28)? as usize;
    let need = RESOLVE_EXT_HEADER_SIZE
        + (import_count + jvm_count + fwg_count) * RESOLVE_KEY_ROW_SIZE
        + fwc_count * RESOLVE_FW_CAND_ROW_SIZE
        + also_count * RESOLVE_ALSO_ROW_SIZE
        + claimed_count * RESOLVE_CLAIMED_ROW_SIZE
        + path_count * RESOLVE_PATH_ROW_SIZE;
    if b.len() < need {
        return Err(rerr("resolve wire: external tables truncated".into()));
    }
    let mut ext = ExternalStrategies::default();
    let mut at = RESOLVE_EXT_HEADER_SIZE;
    for _ in 0..import_count {
        let key = ImportKey {
            file_path: rd_str(arena, b, at)?.to_string(),
            reference_name: rd_str(arena, b, at + 8)?.to_string(),
            reference_kind: rd_str(arena, b, at + 16)?.to_string(),
        };
        let target = rd_str(arena, b, at + 24)?.to_string();
        ext.import_results.insert(key, target);
        at += RESOLVE_KEY_ROW_SIZE;
    }
    for _ in 0..jvm_count {
        let key = ImportKey {
            file_path: rd_str(arena, b, at)?.to_string(),
            reference_name: rd_str(arena, b, at + 8)?.to_string(),
            reference_kind: rd_str(arena, b, at + 16)?.to_string(),
        };
        let target = rd_str(arena, b, at + 24)?.to_string();
        ext.jvm_import_results.insert(key, target);
        at += RESOLVE_KEY_ROW_SIZE;
    }
    let fw_table_start = at + fwg_count * RESOLVE_FW_GROUP_ROW_SIZE;
    let also_table_start = fw_table_start + fwc_count * RESOLVE_FW_CAND_ROW_SIZE;
    let mut groups: Vec<(FwKey, usize, usize)> = Vec::with_capacity(fwg_count);
    for g in 0..fwg_count {
        let g_at = at + g * RESOLVE_FW_GROUP_ROW_SIZE;
        let key = FwKey {
            file_path: rd_str(arena, b, g_at)?.to_string(),
            reference_name: rd_str(arena, b, g_at + 8)?.to_string(),
            reference_kind: rd_str(arena, b, g_at + 16)?.to_string(),
            line: rd_i64(b, g_at + 24)?,
            col: rd_i64(b, g_at + 32)?,
        };
        let cand_start = rd_u32(b, g_at + 40)? as usize;
        let cand_end = rd_u32(b, g_at + 44)? as usize;
        if cand_start > cand_end || cand_end > fwc_count {
            return Err(rerr("resolve wire: fw candidate range out of bounds".into()));
        }
        groups.push((key, cand_start, cand_end));
    }
    for (key, cand_start, cand_end) in groups {
        let mut cands: Vec<FrameworkCandidate> = Vec::with_capacity(cand_end - cand_start);
        for ci in cand_start..cand_end {
            let c_at = fw_table_start + ci * RESOLVE_FW_CAND_ROW_SIZE;
            let resolved_by = ResolvedBy::from_code(rd_u8(b, c_at + 8)?)
                .ok_or_else(|| rerr("resolve wire: bad resolvedBy code".into()))?;
            let authoritative = rd_u8(b, c_at + 9)? != 0;
            let edge_kind = rd_opt_str(arena, b, c_at + 12)?.map(|s| s.to_string());
            let metadata = rd_opt_str(arena, b, c_at + 20)?.map(|s| s.to_string());
            let also_start = rd_u32(b, c_at + 28)? as usize;
            let also_end = rd_u32(b, c_at + 32)? as usize;
            if also_start > also_end || also_end > also_count {
                return Err(rerr("resolve wire: also-target range out of bounds".into()));
            }
            let mut also_targets: Vec<AlsoTarget> = Vec::with_capacity(also_end - also_start);
            for ai in also_start..also_end {
                let a_at = also_table_start + ai * RESOLVE_ALSO_ROW_SIZE;
                also_targets.push(AlsoTarget {
                    target_node_id: rd_str(arena, b, a_at)?.to_string(),
                    metadata: rd_opt_str(arena, b, a_at + 8)?.map(|s| s.to_string()),
                });
            }
            cands.push(FrameworkCandidate {
                target_node_id: rd_str(arena, b, c_at)?.to_string(),
                resolved_by,
                authoritative,
                edge_kind,
                metadata,
                also_targets,
            });
        }
        ext.framework_results.insert(key, cands);
    }
    at = also_table_start + also_count * RESOLVE_ALSO_ROW_SIZE;
    for _ in 0..claimed_count {
        ext.claimed_names.insert(rd_str(arena, b, at)?.to_string());
        at += RESOLVE_CLAIMED_ROW_SIZE;
    }
    let mut import_paths: HashMap<(String, String), Option<String>> = HashMap::with_capacity(path_count);
    for _ in 0..path_count {
        let file = rd_str(arena, b, at)?.to_string();
        let source = rd_str(arena, b, at + 8)?.to_string();
        let resolved = rd_opt_str(arena, b, at + 16)?.map(|s| s.to_string());
        import_paths.insert((file, source), resolved);
        at += RESOLVE_PATH_ROW_SIZE;
    }
    Ok((ext, import_paths))
}

fn decode_batch_input(meta: &[u8], refs: &[u8], external: &[u8], arena: &[u8]) -> Result<BatchInput> {
    if meta.len() < RESOLVE_META_SIZE {
        return Err(rerr("resolve wire: meta truncated".into()));
    }
    if meta[0] != RESOLVE_ABI_VERSION {
        return Err(rerr(format!("resolve wire: abi {} != {}", meta[0], RESOLVE_ABI_VERSION)));
    }
    let ref_count = rd_u32(meta, 4)? as usize;
    let flags = rd_u32(meta, 8)?;
    let arena_len = rd_u32(meta, 12)? as usize;
    if arena.len() < arena_len {
        return Err(rerr("resolve wire: arena truncated".into()));
    }
    if refs.len() < ref_count * RESOLVE_REF_ROW_SIZE {
        return Err(rerr("resolve wire: refs truncated".into()));
    }
    let mut rs: Vec<RefIn> = Vec::with_capacity(ref_count);
    for i in 0..ref_count {
        let at = i * RESOLVE_REF_ROW_SIZE;
        let id_raw = rd_i64(refs, at)?;
        rs.push(RefIn {
            id: if id_raw < 0 { None } else { Some(id_raw) },
            from_node_id: rd_str(arena, refs, at + 8)?.to_string(),
            reference_name: rd_str(arena, refs, at + 16)?.to_string(),
            reference_kind: rd_str(arena, refs, at + 24)?.to_string(),
            file_path: rd_str(arena, refs, at + 32)?.to_string(),
            language: rd_str(arena, refs, at + 40)?.to_string(),
            line: rd_i64(refs, at + 48)?,
            column: rd_i64(refs, at + 56)?,
        });
    }
    let (ext, import_paths) = decode_external(external, arena)?;
    Ok(BatchInput { refs: rs, ext, import_paths, flags })
}

/// The encoded batch output as PLAIN byte vectors — the napi wrapper below
/// is the ONLY place that touches napi Buffer types (store.rs/resolver_ctx.rs
/// test-harness discipline: Buffer Drop paths reference libnode symbols a
/// test executable cannot resolve, so cargo tests exercise this struct).
pub(crate) struct EncodedBatch {
    pub header: Vec<u8>,
    pub edges: Vec<u8>,
    pub refs: Vec<u8>,
    pub files: Vec<u8>,
    pub stats: Vec<u8>,
    pub arena: Vec<u8>,
}

fn encode_batch_output(out: &BatchOutput) -> Result<EncodedBatch> {
    let mut arena: Vec<u8> = Vec::new();
    let mut edges: Vec<u8> = Vec::new();
    let mut refs_out: Vec<u8> = Vec::new();
    let mut files_out: Vec<u8> = Vec::new();
    let mut stats_out: Vec<u8> = Vec::new();
    let batch_edge_count = out.edges.len() as u32;
    for e in &out.edges {
        encode_edge_row(&mut edges, &mut arena, e);
    }
    // Sweep rows' edges append AFTER the batch edges in the shared table —
    // a running cursor gives each row its [start, end) range.
    let mut edge_cursor = out.edges.len();
    for s in &out.sweeps {
        let start = edge_cursor as u32;
        for e in &s.edges {
            encode_edge_row(&mut edges, &mut arena, e);
        }
        edge_cursor += s.edges.len();
        push_str_ref(&mut files_out, put_str(&mut arena, &s.source_node_id));
        push_u32(&mut files_out, start);
        push_u32(&mut files_out, edge_cursor as u32);
        push_u32(&mut files_out, 0);
        push_u32(&mut files_out, 0);
    }
    for (flag, row) in std::iter::chain(out.resolved.iter().map(|r| (1u8, r)), out.failed.iter().map(|r| (2u8, r))) {
        refs_out.push(flag);
        refs_out.extend_from_slice(&[0u8; 7]);
        refs_out.extend_from_slice(&row.0.to_le_bytes());
        push_str_ref(&mut refs_out, put_str(&mut arena, &row.1));
        push_str_ref(&mut refs_out, put_str(&mut arena, &row.2));
        push_str_ref(&mut refs_out, put_str(&mut arena, &row.3));
    }
    for (key, count) in &out.by_method {
        push_str_ref(&mut stats_out, put_str(&mut arena, key));
        push_u32(&mut stats_out, *count);
        push_u32(&mut stats_out, 0);
    }
    let mut header: Vec<u8> = Vec::with_capacity(RESOLVE_OUT_HEADER_SIZE);
    header.push(RESOLVE_ABI_VERSION);
    header.extend_from_slice(&[0u8; 3]);
    push_u32(&mut header, batch_edge_count);
    push_u32(&mut header, out.resolved.len() as u32);
    push_u32(&mut header, out.failed.len() as u32);
    push_u32(&mut header, out.sweeps.len() as u32);
    push_u32(&mut header, out.by_method.len() as u32);
    push_u32(&mut header, arena.len() as u32);
    push_u32(&mut header, out.total);
    push_u32(&mut header, out.resolved_count);
    push_u32(&mut header, out.unresolved_count);
    Ok(EncodedBatch {
        header,
        edges,
        refs: refs_out,
        files: files_out,
        stats: stats_out,
        arena,
    })
}

fn encode_edge_row(edges: &mut Vec<u8>, arena: &mut Vec<u8>, e: &EdgeRow) {
    push_str_ref(edges, put_str(arena, &e.source));
    push_str_ref(edges, put_str(arena, &e.target));
    push_str_ref(edges, put_str(arena, &e.kind));
    edges.extend_from_slice(&e.line.to_le_bytes());
    edges.extend_from_slice(&e.column.to_le_bytes());
    push_str_ref(edges, put_opt_str(arena, e.target_metadata.as_deref()));
    push_str_ref(edges, put_str(arena, &e.resolved_by));
    push_str_ref(edges, put_str(arena, &e.ref_name));
    push_str_ref(edges, put_opt_str(arena, e.ref_kind.as_deref()));
    edges.push(e.fn_ref as u8);
    edges.extend_from_slice(&[0u8; 7]);
}


// ---------------------------------------------------------------------------
// napi surface — THIN wrappers over the cores (cargo tests exercise the
// identical cores without touching napi Buffer types)
// ---------------------------------------------------------------------------

/// Wire contract + strategy manifest for the TS contract gate.
#[napi(object)]
pub struct ResolveContractInfo {
    /// RESOLVE_ABI_VERSION — independent numbering from the other ABIs.
    pub resolve_abi: u32,
    pub resolve_version: String,
    /// Strategy manifest — the TS loader verifies it against the fork's
    /// strategy table (kernel ⊆ fork subset direction).
    pub strategies: Vec<String>,
    /// RESOLVER_RANK as "resolvedBy:rank" strings (frozen evidence order).
    pub resolver_rank: Vec<String>,
    /// Builtin name-table content version (js-builtins.ts port).
    pub builtins_version: String,
    /// Effective fuzzy ceiling (CODEGRAPH_AMBIGUOUS_NAME_CEILING applied).
    pub ambiguous_name_ceiling: u32,
    /// Row sizes the TS decoder sanity-checks.
    pub ref_row_size: u32,
    pub edge_row_size: u32,
}

#[napi]
pub fn resolve_contract_info() -> ResolveContractInfo {
    let rank = [
        ResolvedBy::Import,
        ResolvedBy::QualifiedName,
        ResolvedBy::ExactMatch,
        ResolvedBy::FunctionRef,
        ResolvedBy::InstanceMethod,
        ResolvedBy::FilePath,
        ResolvedBy::Framework,
        ResolvedBy::Fuzzy,
    ];
    ResolveContractInfo {
        resolve_abi: RESOLVE_ABI_VERSION as u32,
        resolve_version: RESOLVE_VERSION.to_string(),
        strategies: RESOLVE_STRATEGY_TABLE.iter().map(|s| s.to_string()).collect(),
        resolver_rank: rank.iter().map(|r| format!("{}:{}", r.as_str(), r.rank())).collect(),
        builtins_version: builtins_version(),
        ambiguous_name_ceiling: resolve_ambiguous_name_ceiling().max(0) as u32,
        ref_row_size: RESOLVE_REF_ROW_SIZE as u32,
        edge_row_size: RESOLVE_EDGE_ROW_SIZE as u32,
    }
}

/// One open resolution batch session (one per graph root, symbiotic with
/// that root's CtxHandle — resolve_batch borrows the ctx's CtxConn per
/// call). Holds the Resolver strategy memos; deterministic resolve_close,
/// GC finalizer only as the crash fallback. Lock order is ALWAYS
/// ResolveHandle → CtxHandle (no path locks the reverse).
#[napi]
pub struct ResolveHandle {
    inner: Mutex<Resolver>,
    poisoned: AtomicBool,
    /// Set by resolve_close — every entry point rejects afterwards (the
    /// ctx_close/store_close contract).
    closed: AtomicBool,
}

impl ResolveHandle {
    fn with<T>(&self, f: impl FnOnce(&mut Resolver) -> Result<T>) -> Result<T> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(Error::from_reason("resolve handle is closed"));
        }
        if self.poisoned.load(Ordering::Relaxed) {
            return Err(Error::from_reason("resolve handle is poisoned by an earlier panic; reopen it"));
        }
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                self.poisoned.store(true, Ordering::Relaxed);
                return Err(Error::from_reason("resolve handle mutex poisoned"));
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

/// Open a batch session against a live ctx handle (Resolver::new snapshots
/// the ctx invalidation key; memos auto-drop when it moves).
#[napi]
pub fn resolve_open(ctx: &CtxHandle) -> Result<ResolveHandle> {
    ctx.with(|c| {
        Ok(ResolveHandle {
            inner: Mutex::new(Resolver::new(c)),
            poisoned: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        })
    })
}

/// Deterministic release — the TS ResolveBridge closes this BEFORE
/// CtxBridge.close() (the R1 pairing discipline). Idempotent; the handle
/// rejects every call afterwards.
#[napi]
pub fn resolve_close(handle: &ResolveHandle) -> Result<()> {
    handle.closed.store(true, Ordering::Relaxed);
    Ok(())
}

/// Batch input: refs wire + external strategy wire + shared arena.
#[napi(object)]
pub struct ResolveBuffers {
    pub meta: Buffer,
    pub refs: Buffer,
    pub external: Buffer,
    pub arena: Buffer,
}

/// Batch output: persist plan (see the module-doc wire layout).
#[napi(object)]
pub struct ResolveBuffersOut {
    pub header: Buffer,
    pub edges: Buffer,
    pub refs: Buffer,
    pub files: Buffer,
    pub stats: Buffer,
    pub arena: Buffer,
}

/// ONE boundary crossing per ref batch: the full resolveOne + createEdges +
/// file-level import sweep, returning the persist PLAN. Persistence itself
/// runs through the existing TS QueryBuilder/StoreBridge arms (R3a op
/// vocabulary unchanged). Thread discipline v1: synchronous on the caller's
/// thread (the recorded R3 §2 amendment — same posture as the store/ctx
/// bridges); worker-thread migration is the shared follow-up.
#[napi]
pub fn resolve_batch(
    ctx: &CtxHandle,
    handle: &ResolveHandle,
    batch: ResolveBuffers,
) -> Result<ResolveBuffersOut> {
    let input = decode_batch_input(&batch.meta, &batch.refs, &batch.external, &batch.arena)?;
    let out = handle.with(|res| ctx.with(|c| resolve_batch_core(c, res, input)))?;
    let enc = encode_batch_output(&out)?;
    Ok(ResolveBuffersOut {
        header: enc.header.into(),
        edges: enc.edges.into(),
        refs: enc.refs.into(),
        files: enc.files.into(),
        stats: enc.stats.into(),
        arena: enc.arena.into(),
    })
}
// ===========================================================================
// Golden-fixture tests (R3c-1). In-crate: drive the strategy tree against a
// real schema'd SQLite db + fs source files through CtxConn, mirroring the
// resolver_ctx.rs test-harness discipline. Each family of name-matcher.ts is
// exercised with the ordering/arbitration/visibility boundaries that are
// load-bearing (R3c risk list #1).
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use rusqlite::Connection;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SCHEMA_SQL: &str = include_str!("../../packages/chimera/src/graph/db/schema.sql");
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Env {
        path: String,
        dir: std::path::PathBuf,
    }

    impl Env {
        fn new() -> Env {
            let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("cgk-res-{}-{}", std::process::id(), n));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("graph.db").to_string_lossy().to_string();
            let conn = Connection::open(&path).expect("open temp db");
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            conn.execute_batch(SCHEMA_SQL).expect("apply schema.sql");
            Env { path, dir }
        }

        fn conn(&self) -> Connection {
            let c = Connection::open(&self.path).unwrap();
            c.pragma_update(None, "foreign_keys", "ON").unwrap();
            c
        }

        fn write_file(&self, rel: &str, content: &str) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Node seed builder (full nodes-table column control).
    #[derive(Clone)]
    struct Nd {
        id: String,
        kind: String,
        name: String,
        qn: String,
        file: String,
        lang: String,
        sl: i64,
        el: i64,
        sc: i64,
        ec: i64,
        vis: Option<String>,
        exported: i64,
        ret: Option<String>,
        params: Option<String>,
        sig: Option<String>,
    }

    impl Nd {
        fn new(id: &str, kind: &str, name: &str, qn: &str, file: &str, lang: &str, sl: i64, el: i64) -> Nd {
            Nd {
                id: id.into(), kind: kind.into(), name: name.into(), qn: qn.into(),
                file: file.into(), lang: lang.into(), sl, el, sc: 0, ec: 0,
                vis: None, exported: 0, ret: None, params: None, sig: None,
            }
        }
        fn vis(mut self, v: &str) -> Self { self.vis = Some(v.into()); self }
        fn exported(mut self) -> Self { self.exported = 1; self }
        fn ret(mut self, r: &str) -> Self { self.ret = Some(r.into()); self }
        fn params(mut self, p: &str) -> Self { self.params = Some(p.into()); self }
        fn sig(mut self, s: &str) -> Self { self.sig = Some(s.into()); self }
        fn cols(mut self, sc: i64, ec: i64) -> Self { self.sc = sc; self.ec = ec; self }
    }

    fn seed(conn: &Connection, n: &Nd) {
        conn.execute(
            "INSERT OR REPLACE INTO nodes (id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, start_column, end_column, docstring, signature, visibility, \
             is_exported, is_async, is_static, is_abstract, decorators, type_parameters, \
             return_type, params_json, search_text, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11,?12,?13,0,0,0,NULL,NULL,?14,?15,'',7)",
            rusqlite::params![
                n.id, n.kind, n.name, n.qn, n.file, n.lang, n.sl, n.el, n.sc, n.ec,
                n.sig, n.vis, n.exported, n.ret, n.params
            ],
        )
        .unwrap();
    }

    struct Ctx {
        _sh: store::StoreHandle,
        c: CtxConn,
    }

    fn open_ctx(env: &Env) -> Ctx {
        let sh = store::store_open(env.path.clone()).expect("store_open");
        let c = CtxConn::open(&sh, env.dir.to_string_lossy().to_string()).expect("ctx_open");
        Ctx { _sh: sh, c }
    }

    fn mkref(name: &str, kind: &str, lang: &str, file: &str, line: i64, col: i64, from: &str) -> RefIn {
        RefIn {
            id: None,
            from_node_id: from.into(),
            reference_name: name.into(),
            reference_kind: kind.into(),
            line,
            column: col,
            file_path: file.into(),
            language: lang.into(),
        }
    }

    fn ext() -> ExternalStrategies {
        ExternalStrategies::default()
    }

    // -- exact / qualified / file-path --------------------------------------

    #[test]
    fn exact_single_candidate() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("fn1", "function", "myFunc", "myFunc", "a.ts", "typescript", 1, 5));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("myFunc", "references", "typescript", "a.ts", 3, 0, "caller");
        let out = res.match_by_exact_name(&mut ctx.c, &r, &ext()).unwrap();
        assert_eq!(out.unwrap().target_node_id, "fn1");
    }

    #[test]
    fn exact_import_veto_cross_file() {
        let env = Env::new();
        env.write_file("a.ts", "import { other } from './other';\nother();\n");
        env.write_file("unrelated.ts", "export function myFunc() {}\n");
        {
            let c = env.conn();
            seed(&c, &Nd::new("fn1", "function", "myFunc", "myFunc", "unrelated.ts", "typescript", 1, 1).exported());
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("myFunc", "references", "typescript", "a.ts", 2, 0, "caller");
        assert!(res.match_by_exact_name(&mut ctx.c, &r, &ext()).unwrap().is_none());
    }

    #[test]
    fn qualified_unique() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("m1", "method", "bar", "Foo::bar", "a.ts", "typescript", 2, 4));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("Foo::bar", "calls", "typescript", "a.ts", 9, 0, "caller");
        let out = res.match_by_qualified_name(&mut ctx.c, &r).unwrap();
        assert_eq!(out.unwrap().target_node_id, "m1");
    }

    #[test]
    fn file_path_suffix_match() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("f1", "file", "foo.liquid", "src/snippets/foo.liquid", "src/snippets/foo.liquid", "liquid", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("snippets/foo.liquid", "references", "liquid", "x.liquid", 1, 0, "caller");
        let out = res.match_by_file_path(&mut ctx.c, &r).unwrap();
        assert_eq!(out.unwrap().target_node_id, "f1");
    }

    // -- fuzzy --------------------------------------------------------------

    #[test]
    fn fuzzy_case_insensitive_unique() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("fn1", "function", "MyHelper", "MyHelper", "a.ts", "typescript", 1, 2));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("myhelper", "references", "typescript", "a.ts", 5, 0, "caller");
        let out = res.match_fuzzy(&mut ctx.c, &r).unwrap();
        let got = out.unwrap();
        assert_eq!(got.target_node_id, "fn1");
        assert_eq!(got.resolved_by, ResolvedBy::Fuzzy);
    }

    // -- method-call --------------------------------------------------------

    #[test]
    fn method_call_class_dot_qualified() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("cls", "class", "Foo", "Foo", "a.ts", "typescript", 1, 20));
            seed(&c, &Nd::new("m1", "method", "bar", "Foo::bar", "a.ts", "typescript", 5, 8));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("Foo.bar", "calls", "typescript", "a.ts", 30, 0, "caller");
        let out = res.match_method_call(&mut ctx.c, &r, &ext()).unwrap();
        let got = out.unwrap();
        assert_eq!(got.target_node_id, "m1");
        assert_eq!(got.resolved_by, ResolvedBy::QualifiedName);
    }

    #[test]
    fn method_call_capitalized_receiver() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("cls", "class", "Engine", "Engine", "a.ts", "typescript", 1, 20));
            seed(&c, &Nd::new("m1", "method", "run", "Engine::run", "a.ts", "typescript", 5, 8));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("engine.run", "calls", "typescript", "a.ts", 30, 0, "caller");
        let out = res.match_method_call(&mut ctx.c, &r, &ext()).unwrap();
        let got = out.unwrap();
        assert_eq!(got.target_node_id, "m1");
        assert_eq!(got.resolved_by, ResolvedBy::InstanceMethod);
    }

    #[test]
    fn object_literal_member_containment() {
        let env = Env::new();
        env.write_file("a.ts", "export const api = {\n  call() { return 1; },\n};\n");
        {
            let c = env.conn();
            seed(&c, &Nd::new("api", "constant", "api", "api", "a.ts", "typescript", 1, 3).exported());
            seed(&c, &Nd::new("call", "function", "call", "call", "a.ts", "typescript", 2, 2).cols(2, 20));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("api.call", "calls", "typescript", "a.ts", 9, 0, "caller");
        let out = res.match_method_call(&mut ctx.c, &r, &ext()).unwrap();
        assert_eq!(out.unwrap().target_node_id, "call");
    }

    #[test]
    fn go_two_hop_chain_declines() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("m1", "method", "Exec", "Conn::Exec", "a.go", "go", 5, 8));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("target.conn.Exec", "calls", "go", "a.go", 30, 0, "caller");
        assert!(res.match_method_call(&mut ctx.c, &r, &ext()).unwrap().is_none());
    }

    // -- rust self ----------------------------------------------------------

    #[test]
    fn rust_self_call_owner_method() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("run", "method", "run", "Target::run", "a.rs", "rust", 10, 20));
            seed(&c, &Nd::new("owner", "struct", "Target", "Target", "a.rs", "rust", 1, 5));
            seed(&c, &Nd::new("reset", "method", "reset", "Target::reset", "a.rs", "rust", 30, 35));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("self.reset", "calls", "rust", "a.rs", 15, 4, "run");
        let out = res.match_method_call(&mut ctx.c, &r, &ext()).unwrap();
        let got = out.unwrap();
        assert_eq!(got.target_node_id, "reset");
        assert_eq!(got.resolved_by, ResolvedBy::QualifiedName);
    }

    // -- function refs (#756) ----------------------------------------------

    #[test]
    fn fn_ref_same_file_wins() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("h1", "function", "handler", "handler", "a.ts", "typescript", 3, 6));
            seed(&c, &Nd::new("h2", "function", "handler", "handler", "b.ts", "typescript", 1, 2));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("handler", "function_ref", "typescript", "a.ts", 9, 0, "caller");
        let out = res.match_function_ref(&mut ctx.c, &r).unwrap();
        let got = out.unwrap();
        assert_eq!(got.target_node_id, "h1");
        assert_eq!(got.resolved_by, ResolvedBy::FunctionRef);
    }

    #[test]
    fn fn_ref_ambiguous_cross_file_declines() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("h1", "function", "handler", "handler", "a.ts", "typescript", 3, 6));
            seed(&c, &Nd::new("h2", "function", "handler", "handler", "b.ts", "typescript", 1, 2));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("handler", "function_ref", "typescript", "c.ts", 9, 0, "caller");
        assert!(res.match_function_ref(&mut ctx.c, &r).unwrap().is_none());
    }

    // -- cpp chain ----------------------------------------------------------

    #[test]
    fn cpp_call_chain_via_return_type() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("inst", "method", "instance", "Foo::instance", "a.cpp", "cpp", 5, 8).ret("Foo"));
            seed(&c, &Nd::new("bar", "method", "bar", "Foo::bar", "a.cpp", "cpp", 10, 14));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("Foo::instance().bar", "calls", "cpp", "a.cpp", 30, 0, "caller");
        let out = res.match_cpp_call_chain(&mut ctx.c, &r).unwrap();
        assert_eq!(out.unwrap().target_node_id, "bar");
    }

    // -- dotted chain (go synthetic-ref fallback, #1269) --------------------

    #[test]
    fn dotted_chain_go_bare_factory_preserves_original() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("run", "function", "run", "run", "a.go", "go", 3, 6).exported());
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("engine().run", "calls", "go", "a.go", 30, 0, "caller");
        let out = res.match_dotted_call_chain(&mut ctx.c, &r, &ext()).unwrap();
        assert_eq!(out.unwrap().target_node_id, "run");
    }

    // -- visibility boundaries ---------------------------------------------

    #[test]
    fn visibility_c_static_source_file_local() {
        let env = Env::new();
        env.write_file("impl.c", "static void helper(void) {}\nvoid use() { helper(); }\n");
        {
            let c = env.conn();
            seed(&c, &Nd::new("h", "function", "helper", "helper", "impl.c", "c", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let cand = ctx.c.get_node_by_id("h").unwrap().unwrap();
        let same = mkref("helper", "calls", "c", "impl.c", 2, 0, "u");
        assert!(res.is_visible_across_files(&mut ctx.c, &cand, &same).unwrap());
        let cross = mkref("helper", "calls", "c", "other.c", 2, 0, "u");
        assert!(!res.is_visible_across_files(&mut ctx.c, &cand, &cross).unwrap());
    }

    #[test]
    fn visibility_go_unexported_other_dir() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("h", "function", "helper", "helper", "pkg/a.go", "go", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let cand = ctx.c.get_node_by_id("h").unwrap().unwrap();
        let cross = mkref("helper", "calls", "go", "other/b.go", 2, 0, "u");
        assert!(!res.is_visible_across_files(&mut ctx.c, &cand, &cross).unwrap());
        let samedir = mkref("helper", "calls", "go", "pkg/b.go", 2, 0, "u");
        assert!(res.is_visible_across_files(&mut ctx.c, &cand, &samedir).unwrap());
    }

    #[test]
    fn visibility_rust_private_module_subtree() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("h", "function", "helper", "helper", "src/net.rs", "rust", 1, 1).vis("private"));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let cand = ctx.c.get_node_by_id("h").unwrap().unwrap();
        let sibling = mkref("helper", "calls", "rust", "src/other.rs", 2, 0, "u");
        assert!(!res.is_visible_across_files(&mut ctx.c, &cand, &sibling).unwrap());
        let child = mkref("helper", "calls", "rust", "src/net/inner.rs", 2, 0, "u");
        assert!(res.is_visible_across_files(&mut ctx.c, &cand, &child).unwrap());
    }

    #[test]
    fn visibility_sealed_js_module() {
        let env = Env::new();
        env.write_file("sealed.ts", "import x from './x';\nconst vite = 1;\n");
        {
            let c = env.conn();
            seed(&c, &Nd::new("v", "constant", "vite", "vite", "sealed.ts", "typescript", 2, 2));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let cand = ctx.c.get_node_by_id("v").unwrap().unwrap();
        let cross = mkref("vite", "references", "typescript", "other.ts", 1, 0, "u");
        assert!(!res.is_visible_across_files(&mut ctx.c, &cand, &cross).unwrap());
    }

    // -- arbitration --------------------------------------------------------

    #[test]
    fn pick_best_candidate_rank_then_same_file() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("z", "function", "f", "f", "other.ts", "typescript", 1, 1));
            seed(&c, &Nd::new("a", "function", "f", "f", "here.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("f", "references", "typescript", "here.ts", 5, 0, "caller");
        let cands = vec![
            Resolved::new("z".into(), ResolvedBy::ExactMatch),
            Resolved::new("a".into(), ResolvedBy::ExactMatch),
        ];
        let out = res.pick_best_candidate(&mut ctx.c, &r, cands).unwrap().unwrap();
        assert_eq!(out.target_node_id, "a");
    }

    #[test]
    fn pick_best_candidate_higher_rank_wins() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("imp", "function", "f", "f", "x.ts", "typescript", 1, 1));
            seed(&c, &Nd::new("fz", "function", "f", "f", "x.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("f", "references", "typescript", "x.ts", 5, 0, "caller");
        let cands = vec![
            Resolved::new("fz".into(), ResolvedBy::Fuzzy),
            Resolved::new("imp".into(), ResolvedBy::Import),
        ];
        let out = res.pick_best_candidate(&mut ctx.c, &r, cands).unwrap().unwrap();
        assert_eq!(out.target_node_id, "imp");
    }

    #[test]
    fn resolve_one_framework_authoritative_short_circuits() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("fw", "route", "route", "route", "x.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let r = mkref("route", "references", "typescript", "x.ts", 5, 0, "caller");
        let mut e = ext();
        let key = FwKey::of(&r);
        e.framework_results.insert(
            key,
            vec![FrameworkCandidate {
                target_node_id: "fw".into(),
                resolved_by: ResolvedBy::Framework,
                authoritative: true,
                edge_kind: None,
                metadata: None,
                also_targets: Vec::new(),
            }],
        );
        let out = res.resolve_one(&mut ctx.c, &r, &e).unwrap();
        assert_eq!(out.unwrap().target_node_id, "fw");
    }

    // -- prefilter / builtins ----------------------------------------------

    #[test]
    fn has_any_possible_match_parts() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("b", "method", "Bar", "Foo::Bar", "x.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        assert!(res.has_any_possible_match(&mut ctx.c, "Bar").unwrap());
        assert!(res.has_any_possible_match(&mut ctx.c, "obj.Bar").unwrap());
        assert!(!res.has_any_possible_match(&mut ctx.c, "Nope").unwrap());
    }

    #[test]
    fn built_in_or_external_families() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("x", "function", "whatever", "whatever", "x.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let js = mkref("console.log", "calls", "typescript", "x.ts", 1, 0, "c");
        assert!(res.is_built_in_or_external(&mut ctx.c, &js).unwrap());
        let go = mkref("fmt.Println", "calls", "go", "x.go", 1, 0, "c");
        assert!(res.is_built_in_or_external(&mut ctx.c, &go).unwrap());
        let cpp = mkref("std::vector", "references", "cpp", "x.cpp", 1, 0, "c");
        assert!(res.is_built_in_or_external(&mut ctx.c, &cpp).unwrap());
        let proj = mkref("whatever", "calls", "typescript", "x.ts", 1, 0, "c");
        assert!(!res.is_built_in_or_external(&mut ctx.c, &proj).unwrap());
    }

    // -- pure helpers -------------------------------------------------------

    #[test]
    fn rust_field_type_name_reductions() {
        assert_eq!(Resolver::rust_field_type_name("Box<dyn Source>").as_deref(), Some("Source"));
        assert_eq!(Resolver::rust_field_type_name("&'a mut Foo").as_deref(), Some("Foo"));
        assert_eq!(Resolver::rust_field_type_name("Vec<Inner>").as_deref(), Some("Vec"));
        assert_eq!(Resolver::rust_field_type_name("String"), None);
        assert_eq!(Resolver::rust_field_type_name("self"), None);
        assert_eq!(Resolver::rust_field_type_name("T"), None);
    }

    #[test]
    fn split_camel_case_words() {
        assert_eq!(split_camel_case("permissionEngine"), vec!["permission", "Engine"]);
        assert_eq!(split_camel_case("HTTPServer"), vec!["HTTP", "Server"]);
    }

    #[test]
    fn same_language_family_map() {
        assert!(same_language_family("java", "kotlin"));
        assert!(same_language_family("typescript", "arkts"));
        assert!(!same_language_family("go", "rust"));
        assert!(same_language_family("rust", "rust"));
    }

    #[test]
    fn js_store_destructured_getstate_binding() {
        let env = Env::new();
        // store.ts: an object literal used as a namespace (constant + member).
        env.write_file("store.ts", "export const useStore = {\n  doThing() { return 1; },\n};\n");
        // comp.ts: destructure an action off useStore.getState() and call it bare.
        env.write_file("comp.ts", "const { doThing } = useStore.getState();\ndoThing();\n");
        {
            let c = env.conn();
            seed(&c, &Nd::new("useStore", "constant", "useStore", "useStore", "store.ts", "typescript", 1, 3).exported());
            seed(&c, &Nd::new("doThing", "function", "doThing", "doThing", "store.ts", "typescript", 2, 2).cols(2, 24));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        // A bare `doThing()` at line 2, column 0 of comp.ts.
        let r = mkref("doThing", "calls", "typescript", "comp.ts", 2, 0, "caller");
        // Plan A: resolveViaImport for the synthetic holder ref is precomputed.
        let mut e = ext();
        e.import_results.insert(
            ImportKey::synthetic("comp.ts", "useStore", "references"),
            "useStore".into(),
        );
        let out = res.match_js_store_binding_call(&mut ctx.c, &r, &e).unwrap();
        assert_eq!(out.unwrap().target_node_id, "doThing");
    }

    // -- R3c-2: createEdges / dedupe / batch core / sweep / wire ------------

    fn mkedge(source: &str, target: &str, kind: &str, line: i64, col: i64) -> EdgeRow {
        EdgeRow {
            source: source.into(),
            target: target.into(),
            kind: kind.into(),
            line,
            column: col,
            target_metadata: None,
            resolved_by: "import".into(),
            ref_name: String::new(),
            ref_kind: None,
            fn_ref: false,
        }
    }

    #[test]
    fn dedupe_imports_lowest_linecol_wins() {
        let edges = vec![
            mkedge("f", "t", "imports", 5, 2),
            mkedge("f", "t", "imports", 3, 9),
            mkedge("f", "t", "calls", 9, 9),
            mkedge("f", "t", "imports", 4, 0),
        ];
        let out = dedupe_symbol_import_edges(edges);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, "imports");
        // lowest (line, column) kept IN PLACE; non-imports pass through.
        assert_eq!((out[0].line, out[0].column), (3, 9));
        assert_eq!(out[1].kind, "calls");
    }

    #[test]
    fn create_edges_promotions_and_stamps() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("iface", "interface", "I", "I", "a.ts", "typescript", 1, 2));
            seed(&c, &Nd::new("cls", "class", "C", "C", "a.ts", "typescript", 3, 4));
            seed(&c, &Nd::new("src", "class", "S", "S", "a.ts", "typescript", 5, 6));
        }
        let mut ctx = open_ctx(&env);
        // extends → implements (class source targeting an interface) + alsoTargets fanout.
        let r = mkref("I", "extends", "typescript", "a.ts", 9, 0, "src");
        let res = Resolved {
            target_node_id: "iface".into(),
            resolved_by: ResolvedBy::ExactMatch,
            authoritative: false,
            edge_kind: None,
            metadata: Some("{\"href\":\"/x\"}".into()),
            also_targets: vec![AlsoTarget { target_node_id: "cls".into(), metadata: None }],
        };
        let edges = create_edges(&mut ctx.c, &r, &res).unwrap();
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, "implements");
        assert_eq!(edges[0].ref_kind.as_deref(), Some("extends"));
        assert_eq!(edges[0].target_metadata.as_deref(), Some("{\"href\":\"/x\"}"));
        assert_eq!(edges[0].ref_name, "I");
        assert!(!edges[0].fn_ref);
        assert_eq!(edges[1].target, "cls");
        assert_eq!(edges[1].target_metadata, None);
        // calls → instantiates (target is a class).
        let r2 = mkref("C", "calls", "typescript", "a.ts", 9, 0, "src");
        let e2 = create_edges(&mut ctx.c, &r2, &Resolved::new("cls".into(), ResolvedBy::ExactMatch)).unwrap();
        assert_eq!(e2[0].kind, "instantiates");
        assert_eq!(e2[0].ref_kind.as_deref(), Some("calls"));
        // function_ref → references + the fnRef stamp.
        let r3 = mkref("f", "function_ref", "typescript", "a.ts", 9, 0, "src");
        let e3 = create_edges(&mut ctx.c, &r3, &Resolved::new("iface".into(), ResolvedBy::FunctionRef)).unwrap();
        assert_eq!(e3[0].kind, "references");
        assert!(e3[0].fn_ref);
        assert_eq!(e3[0].ref_kind.as_deref(), Some("function_ref"));
    }

    #[test]
    fn batch_core_resolve_stats_and_rows() {
        let env = Env::new();
        {
            let c = env.conn();
            seed(&c, &Nd::new("fn1", "function", "myFunc", "myFunc", "a.ts", "typescript", 1, 5));
        }
        let mut ctx = open_ctx(&env);
        let mut res = Resolver::new(&ctx.c);
        let mut r1 = mkref("myFunc", "references", "typescript", "a.ts", 3, 0, "caller");
        r1.id = Some(42);
        let r2 = mkref("__nope__", "references", "typescript", "a.ts", 4, 0, "caller");
        let input = BatchInput {
            refs: vec![r1, r2],
            ext: ExternalStrategies::default(),
            import_paths: HashMap::new(),
            flags: 0,
        };
        let out = resolve_batch_core(&mut ctx.c, &mut res, input).unwrap();
        assert_eq!(out.total, 2);
        assert_eq!(out.resolved_count, 1);
        assert_eq!(out.unresolved_count, 1);
        assert_eq!(out.resolved[0].0, 42); // row id rides for the delete
        assert_eq!(out.resolved[0].2, "myFunc");
        assert_eq!(out.failed[0].0, -1);
        assert_eq!(out.failed[0].2, "__nope__");
        assert_eq!(out.edges.len(), 1);
        assert_eq!(out.edges[0].target, "fn1");
        assert_eq!(out.edges[0].kind, "references");
        assert_eq!(out.by_method, vec![("exact-match".to_string(), 1)]);
    }

    #[test]
    fn file_sweep_rows_and_edges() {
        let env = Env::new();
        env.write_file("a.ts", "import { x } from './b';\n");
        env.write_file("b.ts", "export const x = 1;\n");
        env.write_file("lonely.ts", "export const y = 1;\n");
        {
            let c = env.conn();
            for p in ["a.ts", "b.ts", "lonely.ts", "ghost.ts"] {
                c.execute(
                    "INSERT OR REPLACE INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, generated) VALUES (?1,'h','typescript',1,1,1,0,0)",
                    rusqlite::params![p],
                )
                .unwrap();
            }
            seed(&c, &Nd::new("fa", "file", "a.ts", "a.ts", "a.ts", "typescript", 1, 1));
            seed(&c, &Nd::new("fb", "file", "b.ts", "b.ts", "b.ts", "typescript", 1, 1));
            seed(&c, &Nd::new("fl", "file", "lonely.ts", "lonely.ts", "lonely.ts", "typescript", 1, 1));
        }
        let mut ctx = open_ctx(&env);
        let mut paths: HashMap<(String, String), Option<String>> = HashMap::new();
        paths.insert(("a.ts".into(), "./b".into()), Some("b.ts".into()));
        let files = vec!["a.ts".to_string(), "lonely.ts".to_string(), "ghost.ts".to_string()];
        let out = file_level_import_sweep(&mut ctx.c, &files, &paths).unwrap();
        // ghost.ts has a files record but NO file node → skipped entirely.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source_node_id, "fa");
        assert_eq!(out[0].edges.len(), 1);
        assert_eq!(out[0].edges[0].target, "fb");
        assert_eq!(out[0].edges[0].kind, "imports");
        assert_eq!(out[0].edges[0].line, 0);
        // no refName stamp — synthesized file-level edges never resurrect.
        assert_eq!(out[0].edges[0].ref_name, "");
        assert_eq!(out[0].edges[0].ref_kind, None);
        // lonely.ts: record + node but no imports → delete-only row.
        assert_eq!(out[1].source_node_id, "fl");
        assert!(out[1].edges.is_empty());
    }

    #[test]
    fn wire_roundtrip_input_and_output() {
        // -- encode the input exactly the way resolve-encode.ts does --
        let mut arena: Vec<u8> = Vec::new();
        let mut refs: Vec<u8> = Vec::new();
        refs.extend_from_slice(&42i64.to_le_bytes());
        for s in ["caller", "myFunc", "calls", "a.ts", "typescript"] {
            push_str_ref(&mut refs, put_str(&mut arena, s));
        }
        refs.extend_from_slice(&3i64.to_le_bytes());
        refs.extend_from_slice(&0i64.to_le_bytes());
        let mut extb: Vec<u8> = Vec::new();
        extb.push(RESOLVE_ABI_VERSION);
        extb.extend_from_slice(&[0u8; 3]);
        push_u32(&mut extb, 1); // import
        push_u32(&mut extb, 0); // jvm
        push_u32(&mut extb, 1); // fw groups
        push_u32(&mut extb, 1); // fw cands
        push_u32(&mut extb, 0); // also
        push_u32(&mut extb, 1); // claimed
        push_u32(&mut extb, 1); // paths
        for s in ["a.ts", "other", "calls", "t1"] {
            push_str_ref(&mut extb, put_str(&mut arena, s));
        }
        for s in ["a.ts", "route", "references"] {
            push_str_ref(&mut extb, put_str(&mut arena, s));
        }
        extb.extend_from_slice(&3i64.to_le_bytes());
        extb.extend_from_slice(&0i64.to_le_bytes());
        push_u32(&mut extb, 0);
        push_u32(&mut extb, 1);
        push_str_ref(&mut extb, put_str(&mut arena, "fw1"));
        extb.push(7); // framework
        extb.push(1); // authoritative
        extb.extend_from_slice(&[0u8; 2]);
        push_str_ref(&mut extb, (NONE, 0)); // edge_kind absent
        push_str_ref(&mut extb, put_str(&mut arena, "{\"href\":\"/x\"}"));
        push_u32(&mut extb, 0);
        push_u32(&mut extb, 0);
        push_u32(&mut extb, 0); // cand-row trailing pad (40B row)
        push_str_ref(&mut extb, put_str(&mut arena, "claimedName"));
        for s in ["a.ts", "./b", "b.ts"] {
            push_str_ref(&mut extb, put_str(&mut arena, s));
        }
        let mut meta: Vec<u8> = Vec::new();
        meta.push(RESOLVE_ABI_VERSION);
        meta.extend_from_slice(&[0u8; 3]);
        push_u32(&mut meta, 1);
        push_u32(&mut meta, RESOLVE_FLAG_SWEEP_BATCH_FILES);
        push_u32(&mut meta, arena.len() as u32);

        let input = decode_batch_input(&meta, &refs, &extb, &arena).unwrap();
        assert_eq!(input.refs.len(), 1);
        assert_eq!(input.refs[0].id, Some(42));
        assert_eq!(input.refs[0].reference_name, "myFunc");
        assert_eq!(input.refs[0].reference_kind, "calls");
        assert_eq!(input.refs[0].line, 3);
        assert_eq!(input.refs[0].column, 0);
        assert_eq!(
            input.ext.import_results.get(&ImportKey::synthetic("a.ts", "other", "calls")).map(|s| s.as_str()),
            Some("t1")
        );
        assert!(input.ext.claimed_names.contains("claimedName"));
        let fw = input
            .ext
            .framework_results
            .get(&FwKey::at("a.ts", "route", "references", 3, 0))
            .unwrap();
        assert_eq!(fw.len(), 1);
        assert_eq!(fw[0].target_node_id, "fw1");
        assert_eq!(fw[0].resolved_by, ResolvedBy::Framework);
        assert!(fw[0].authoritative);
        assert_eq!(fw[0].edge_kind, None);
        assert_eq!(fw[0].metadata.as_deref(), Some("{\"href\":\"/x\"}"));
        assert_eq!(
            input.import_paths.get(&("a.ts".to_string(), "./b".to_string())),
            Some(&Some("b.ts".to_string()))
        );
        assert_eq!(input.flags, RESOLVE_FLAG_SWEEP_BATCH_FILES);

        // -- output encoding roundtrip (header + row geometry) --
        let out = BatchOutput {
            edges: vec![mkedge("s1", "t1", "calls", 2, 3)],
            sweeps: vec![
                SweepRow { source_node_id: "f1".into(), edges: vec![mkedge("f1", "f2", "imports", 0, 0)] },
                SweepRow { source_node_id: "f3".into(), edges: vec![] },
            ],
            resolved: vec![(7, "s1".into(), "n".into(), "calls".into())],
            failed: vec![(-1, "s2".into(), "m".into(), "references".into())],
            total: 2,
            resolved_count: 1,
            unresolved_count: 1,
            by_method: vec![("exact-match".into(), 1)],
        };
        let enc = encode_batch_output(&out).unwrap();
        let rd32 = |b: &[u8], at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
        assert_eq!(enc.header[0], RESOLVE_ABI_VERSION);
        assert_eq!(rd32(&enc.header, 4), 1); // batch edges
        assert_eq!(rd32(&enc.header, 8), 1); // resolved rows
        assert_eq!(rd32(&enc.header, 12), 1); // failed rows
        assert_eq!(rd32(&enc.header, 16), 2); // sweeps
        assert_eq!(rd32(&enc.header, 20), 1); // stats
        assert_eq!(enc.edges.len(), 2 * RESOLVE_EDGE_ROW_SIZE);
        assert_eq!(enc.refs.len(), 2 * RESOLVE_OUT_REF_ROW_SIZE);
        assert_eq!(enc.files.len(), 2 * RESOLVE_SWEEP_ROW_SIZE);
        assert_eq!(enc.stats.len(), RESOLVE_STAT_ROW_SIZE);
        // sweep ranges index past the batch edges.
        assert_eq!(rd32(&enc.files, 8), 1);
        assert_eq!(rd32(&enc.files, 12), 2);
        assert_eq!(rd32(&enc.files, 24 + 8), 2);
        assert_eq!(rd32(&enc.files, 24 + 12), 2);
        // resolved flag 1 / failed flag 2 lead their rows.
        assert_eq!(enc.refs[0], 1);
        assert_eq!(enc.refs[RESOLVE_OUT_REF_ROW_SIZE], 2);
    }

    #[test]
    fn contract_info_shape() {
        let info = resolve_contract_info();
        assert_eq!(info.resolve_abi, 1);
        assert!(info.strategies.iter().any(|s| s == "pick-best-candidate"));
        assert!(info.resolver_rank.contains(&"import:6".to_string()));
        assert!(info.resolver_rank.contains(&"fuzzy:0".to_string()));
        assert!(info.builtins_version.starts_with("builtin-tables-v1-"));
        assert_eq!(info.ref_row_size, RESOLVE_REF_ROW_SIZE as u32);
        assert_eq!(info.edge_row_size, RESOLVE_EDGE_ROW_SIZE as u32);
    }
}

