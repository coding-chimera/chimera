//! End-to-end acceptance: open/initialize a project graph, extract a real
//! TypeScript and Rust source file, write and read nodes/edges, run the
//! incremental delete/rename flow, and resolve a reference through the
//! ctx/resolver path — all through the crate's public Rust API.

use codewhale_codegraph::extract::{buffers, extract_file};
use codewhale_codegraph::resolve::{ctx_get_nodes_by_names, ctx_open, resolve_batch, resolve_open};
use codewhale_codegraph::store::{
    OP_DELETE_FILE, OP_STORE_FILE_RESULT, StoreBatch, StoreHandle, store_commit_batch,
    store_delete_file, store_open,
};

use rusqlite::Connection;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

struct Env {
    db: String,
    dir: std::path::PathBuf,
}

impl Env {
    fn new() -> Env {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codegraph-e2e-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("graph.db").to_string_lossy().to_string();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        codewhale_codegraph::store::apply_schema(&conn).expect("apply schema");
        drop(conn);
        Env { db, dir }
    }

    fn write(&self, rel: &str, content: &str) {
        let p = self.dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    fn count(&self, sql: &str) -> i64 {
        let conn = Connection::open(&self.db).unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Decode the extraction wire into (id, kind, name, startLine, endLine).
fn decode_nodes(out: &buffers::EmitOut) -> Vec<(String, String, String, u32, u32)> {
    let rd_u32 = |r: &[u8], at: usize| u32::from_le_bytes([r[at], r[at + 1], r[at + 2], r[at + 3]]);
    let rd_str = |r: &[u8], arena: &[u8], at: usize| -> String {
        let off = u32::from_le_bytes([r[at], r[at + 1], r[at + 2], r[at + 3]]) as usize;
        let len = u32::from_le_bytes([r[at + 4], r[at + 5], r[at + 6], r[at + 7]]) as usize;
        String::from_utf8(arena[off..off + len].to_vec()).unwrap()
    };
    let mut rows = Vec::new();
    for i in 0..out.nodes.len() / buffers::NODE_ROW_SIZE {
        let r = &out.nodes[i * buffers::NODE_ROW_SIZE..(i + 1) * buffers::NODE_ROW_SIZE];
        rows.push((
            rd_str(r, &out.arena, 36),
            buffers::NODE_KINDS[r[0] as usize].to_string(),
            rd_str(r, &out.arena, 20),
            rd_u32(r, 4),
            rd_u32(r, 8),
        ));
    }
    rows
}

/// Builder that lays extracted nodes/edges out in the STORE wire row format
/// (140B node / 48B edge) and wraps them in one OP_STORE_FILE_RESULT op.
/// The extraction wire row (96B) and the store row (140B) are different
/// layouts by contract, so the conversion is explicit here.
struct StoreEncode {
    arena: Vec<u8>,
    nodes: Vec<u8>,
    edges: Vec<u8>,
    refs: Vec<u8>,
    ops: Vec<u8>,
    files: Vec<u8>,
    node_count: u32,
    edge_count: u32,
    ref_count: u32,
    op_count: u32,
    file_count: u32,
}

impl StoreEncode {
    fn new() -> Self {
        StoreEncode {
            arena: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            refs: Vec::new(),
            ops: Vec::new(),
            files: Vec::new(),
            node_count: 0,
            edge_count: 0,
            ref_count: 0,
            op_count: 0,
            file_count: 0,
        }
    }

    fn put(&mut self, s: &str) -> (u32, u32) {
        let off = self.arena.len() as u32;
        self.arena.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    }

    /// Append a string slot (offset, len) into `buf`, interning into the arena.
    fn push_str_slot(buf: &mut Vec<u8>, r: (u32, u32)) {
        buf.extend_from_slice(&r.0.to_le_bytes());
        buf.extend_from_slice(&r.1.to_le_bytes());
    }

    /// Append the NONE slot (absent field).
    fn push_none(buf: &mut Vec<u8>) {
        buf.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
    }

    fn node(
        &mut self,
        id: &str,
        kind: &str,
        name: &str,
        file_path: &str,
        language: &str,
        line: u32,
    ) {
        let slots = [
            self.put(id),
            self.put(kind),
            self.put(name),
            self.put(name),
            self.put(file_path),
            self.put(language),
        ];
        let b = &mut self.nodes;
        for r in slots {
            Self::push_str_slot(b, r);
        }
        for v in [line, line, 0, 0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        Self::push_none(b); // docstring
        Self::push_none(b); // signature
        Self::push_none(b); // visibility
        b.push(1); // flags: is_exported
        b.extend_from_slice(&[0u8; 3]); // pad
        Self::push_none(b); // decorators_json
        Self::push_none(b); // type_parameters_json
        Self::push_none(b); // return_type
        Self::push_none(b); // params_json
        Self::push_none(b); // search_text — TS binds a string; None decodes to ''
        b.extend_from_slice(&7i64.to_le_bytes()); // updated_at
        self.node_count += 1;
    }

    fn edge(&mut self, source: &str, target: &str, kind: &str, line: u32) {
        let slots = [self.put(source), self.put(target), self.put(kind)];
        let b = &mut self.edges;
        for r in slots {
            Self::push_str_slot(b, r);
        }
        Self::push_none(b); // metadata
        b.extend_from_slice(&line.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes()); // col
        Self::push_none(b); // provenance
        self.edge_count += 1;
    }

    /// One OP_STORE_FILE_RESULT op + its file row.
    fn file_result(
        &mut self,
        path: &str,
        hash: &str,
        language: &str,
        node_span: (u32, u32),
        edge_span: (u32, u32),
    ) {
        let slots = [self.put(path), self.put(hash), self.put(language)];
        let f = &mut self.files;
        for r in slots {
            Self::push_str_slot(f, r);
        }
        Self::push_none(f); // errors_json
        f.extend_from_slice(&10i64.to_le_bytes()); // size
        f.extend_from_slice(&100.0f64.to_le_bytes()); // modified_at
        f.extend_from_slice(&1000i64.to_le_bytes()); // indexed_at
        f.extend_from_slice(&node_span.1.to_le_bytes()); // node_count (pre-filter)
        f.extend_from_slice(&0u32.to_le_bytes()); // pad

        let o = &mut self.ops;
        o.push(OP_STORE_FILE_RESULT);
        o.extend_from_slice(&[0u8; 3]);
        o.extend_from_slice(&0u32.to_le_bytes()); // file_index 0
        o.extend_from_slice(&node_span.0.to_le_bytes());
        o.extend_from_slice(&node_span.1.to_le_bytes());
        o.extend_from_slice(&edge_span.0.to_le_bytes());
        o.extend_from_slice(&edge_span.1.to_le_bytes());
        o.extend_from_slice(&0u32.to_le_bytes()); // refs start
        o.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // refs end NONE = empty
        Self::push_none(o); // arg
        o.extend_from_slice(&0u32.to_le_bytes()); // flags
        o.extend_from_slice(&0u32.to_le_bytes()); // pad
        self.op_count += 1;
        self.file_count += 1;
    }

    /// One standalone OP_DELETE_FILE op (arg = path).
    fn delete_file_op(&mut self, path: &str, flags: u32) {
        let arg = self.put(path);
        let o = &mut self.ops;
        o.push(OP_DELETE_FILE);
        o.extend_from_slice(&[0u8; 3]);
        o.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // file_index NONE
        for _ in 0..3 {
            o.extend_from_slice(&0u32.to_le_bytes()); // span start 0
            o.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // span end NONE = empty
        }
        Self::push_str_slot(o, arg); // arg
        o.extend_from_slice(&flags.to_le_bytes());
        o.extend_from_slice(&0u32.to_le_bytes()); // pad
        self.op_count += 1;
    }

    fn finish(self) -> StoreBatch {
        let mut meta = Vec::new();
        meta.push(1u8); // STORE_ABI_VERSION
        meta.extend_from_slice(&[0u8; 3]);
        for v in [
            self.op_count,
            self.file_count,
            self.node_count,
            self.edge_count,
            self.ref_count,
            self.arena.len() as u32,
        ] {
            meta.extend_from_slice(&v.to_le_bytes());
        }
        meta.extend_from_slice(&self.ops);
        meta.extend_from_slice(&self.files);
        StoreBatch {
            meta,
            nodes: self.nodes,
            edges: self.edges,
            refs: self.refs,
            arena: self.arena,
        }
    }
}

/// Extract → store roundtrip for one file: returns (nodes_inserted, edges_inserted).
fn commit_extraction(
    store: &StoreHandle,
    path: &str,
    hash: &str,
    language: &str,
    out: &buffers::EmitOut,
) -> (u32, u32) {
    let mut enc = StoreEncode::new();
    let decoded = decode_nodes(out);
    let mut ids = Vec::new();
    for (id, kind, name, line, _el) in &decoded {
        enc.node(id, kind, name, path, language, *line);
        ids.push(id.clone());
    }
    let node_end = enc.node_count;
    // contains edges: file node → each symbol node.
    if let Some(file_id) = ids.first().cloned() {
        for id in ids.iter().skip(1) {
            let id = id.clone();
            enc.edge(&file_id, &id, "contains", 0);
        }
    }
    let edge_end = enc.edge_count;
    enc.file_result(path, hash, language, (0, node_end), (0, edge_end));
    let (stats, _wal) = store_commit_batch(store, &enc.finish()).expect("commit extraction");
    assert!(
        stats.nodes_inserted >= 1,
        "nodes inserted: {:?}",
        stats.nodes_inserted
    );
    (stats.nodes_inserted, stats.edges_inserted)
}

#[test]
fn extract_and_store_roundtrip() {
    let env = Env::new();
    env.write(
        "src/calc.ts",
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    env.write("src/main.rs", "pub fn main() {\n    println!(\"hi\");\n}\n");

    let store = store_open(env.db.clone()).expect("store_open");

    // Real TS extraction through the walker.
    let ts_src = std::fs::read_to_string(env.dir.join("src/calc.ts")).unwrap();
    let ts_out = extract_file("src/calc.ts", &ts_src, "typescript").expect("ts extract");
    let ts_nodes = decode_nodes(&ts_out);
    assert!(
        ts_nodes
            .iter()
            .any(|(id, _, name, _, _)| name == "add" && id.starts_with("function:")),
        "TS add node: {ts_nodes:?}"
    );
    assert!(
        ts_nodes.iter().any(|(_, k, _, _, _)| k == "file"),
        "file node present"
    );

    // Real Rust extraction.
    let rs_src = std::fs::read_to_string(env.dir.join("src/main.rs")).unwrap();
    let rs_out = extract_file("src/main.rs", &rs_src, "rust").expect("rust extract");
    let rs_nodes = decode_nodes(&rs_out);
    assert!(
        rs_nodes
            .iter()
            .any(|(_, k, name, _, _)| k == "function" && name == "main"),
        "Rust main node: {rs_nodes:?}"
    );

    // Store both files' extractions.
    let (ts_nodes_in, ts_edges_in) =
        commit_extraction(&store, "src/calc.ts", "hash-ts-1", "typescript", &ts_out);
    assert_eq!(ts_nodes_in as usize, ts_nodes.len());
    assert!(ts_edges_in >= 1);
    commit_extraction(&store, "src/main.rs", "hash-rs-1", "rust", &rs_out);

    // Read back through the ctx face (wire: header 20B, then group rows).
    let ctx = ctx_open(&store, env.dir.to_string_lossy().to_string()).expect("ctx_open");
    let wire = ctx_get_nodes_by_names(&ctx, vec!["add".to_string(), "main".to_string()])
        .expect("ctx_get_nodes_by_names");
    let rd = |at: usize| u32::from_le_bytes([wire[at], wire[at + 1], wire[at + 2], wire[at + 3]]);
    let g0 = (rd(20), rd(24)); // group 0 span: "add"
    let g1 = (rd(28), rd(32)); // group 1 span: "main"
    let node_count = rd(8) as usize;
    assert_eq!(g0, (0, 1), "add group holds one node");
    assert_eq!(g1.1 - g1.0, 1, "main group holds one node");
    assert_eq!(node_count, 2, "add + main nodes decoded");
}

#[test]
fn incremental_delete_and_rename() {
    let env = Env::new();
    let store = store_open(env.db.clone()).expect("store_open");

    // v1: a.ts defines `hello`.
    let v1 = extract_file("a.ts", "export function hello() {}\n", "typescript").unwrap();
    commit_extraction(&store, "a.ts", "h1", "typescript", &v1);
    assert_eq!(
        env.count("SELECT COUNT(*) FROM nodes"),
        (v1.nodes.len() / buffers::NODE_ROW_SIZE) as i64
    );
    let v1_ids: Vec<String> = decode_nodes(&v1).into_iter().map(|(id, ..)| id).collect();

    // v2: same file re-indexed with the function RENAMED — old nodes must be
    // cascade-deleted and the new name present (incremental rename).
    let v2 = extract_file("a.ts", "export function hello2() {}\n", "typescript").unwrap();
    commit_extraction(&store, "a.ts", "h2", "typescript", &v2);
    let conn = Connection::open(&env.db).unwrap();
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM nodes WHERE file_path = 'a.ts'")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    drop(conn);
    assert!(
        names.contains(&"hello2".to_string()),
        "renamed node present: {names:?}"
    );
    assert!(
        !names.contains(&"hello".to_string()),
        "old name gone: {names:?}"
    );
    // The file node id (file:<path>) is content-independent — it survives.
    // Symbol ids embed the name+line, so every v1 SYMBOL id must be gone.
    for id in v1_ids.iter().filter(|id| !id.starts_with("file:")) {
        let conn = Connection::open(&env.db).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "old symbol id {id} cascade-deleted");
    }

    // Delete the file outright: nodes and the files row disappear.
    let mut enc = StoreEncode::new();
    enc.delete_file_op("a.ts", 0);
    let (stats, _wal) = store_commit_batch(&store, &enc.finish()).expect("delete commit");
    assert_eq!(stats.files_deleted, 1);
    assert_eq!(
        env.count("SELECT COUNT(*) FROM nodes"),
        0,
        "nodes gone after delete"
    );
    assert_eq!(
        env.count("SELECT COUNT(*) FROM files"),
        0,
        "file record gone"
    );

    // The plain store_delete_file face (no resurrect) errors loudly on a
    // missing file? No — deleteFile is idempotent SQL (0 rows); it must just
    // succeed. This pins the non-batch face too.
    store_delete_file(&store, "a.ts").expect("plain delete on empty is benign");
}

#[test]
fn resolver_resolves_exact_name_through_ctx() {
    let env = Env::new();
    env.write("a.ts", "export function greet() {}\n");
    let store = store_open(env.db.clone()).expect("store_open");
    let out = extract_file("a.ts", "export function greet() {}\n", "typescript").unwrap();
    commit_extraction(&store, "a.ts", "hg1", "typescript", &out);

    // Ctx read: getNodesByName through the wire face.
    let ctx = ctx_open(&store, env.dir.to_string_lossy().to_string()).expect("ctx_open");
    let wire = ctx_get_nodes_by_names(&ctx, vec!["greet".to_string()]).expect("nodes");
    let node_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]);
    assert_eq!(node_count, 1);

    // Resolver: one-ref batch through the resolve wire face.
    let resolver = resolve_open(&ctx).expect("resolve_open");
    let decoded = decode_nodes(&out);
    let from_id = decoded
        .iter()
        .find(|(_, k, _, _, _)| k == "file")
        .map(|(id, ..)| id.clone())
        .unwrap();
    let strs: [&str; 5] = [from_id.as_str(), "greet", "calls", "a.ts", "typescript"];
    let mut refs_row = Vec::new();
    let mut arena = Vec::new();
    let put = |arena: &mut Vec<u8>, s: &str| -> (u32, u32) {
        let off = arena.len() as u32;
        arena.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    };
    refs_row.extend_from_slice(&(-1i64).to_le_bytes()); // id absent
    for s in strs {
        let r = put(&mut arena, s);
        refs_row.extend_from_slice(&r.0.to_le_bytes());
        refs_row.extend_from_slice(&r.1.to_le_bytes());
    }
    refs_row.extend_from_slice(&2i64.to_le_bytes()); // line
    refs_row.extend_from_slice(&0i64.to_le_bytes()); // column
    let mut meta = Vec::new();
    meta.push(1u8); // RESOLVE_ABI_VERSION
    meta.extend_from_slice(&[0u8; 3]);
    meta.extend_from_slice(&1u32.to_le_bytes()); // ref_count
    meta.extend_from_slice(&0u32.to_le_bytes()); // flags
    meta.extend_from_slice(&arena.len().to_le_bytes()); // arena_len
    let external = {
        let mut e = Vec::new();
        e.push(1u8); // RESOLVE_ABI_VERSION
        e.extend_from_slice(&[0u8; 3]);
        for _ in 0..7 {
            e.extend_from_slice(&0u32.to_le_bytes()); // all counts zero
        }
        e
    };
    let out = resolve_batch(
        &ctx,
        &resolver,
        codewhale_codegraph::resolve::ResolveBatch {
            meta: &meta,
            refs: &refs_row,
            external: &external,
            arena: &arena,
        },
    )
    .expect("resolve_batch");
    let rd = |at: usize| {
        u32::from_le_bytes([
            out.header[at],
            out.header[at + 1],
            out.header[at + 2],
            out.header[at + 3],
        ])
    };
    let resolved = rd(8);
    let failed = rd(12);
    assert_eq!((resolved, failed), (1, 0), "greet resolves via exact-match");
    assert!(
        !out.edges.is_empty(),
        "resolve produced edges: {} bytes",
        out.edges.len()
    );
}

#[test]
fn store_open_requires_initialized_db() {
    let env = Env::new();
    let bare = env.dir.join("bare.db").to_string_lossy().to_string();
    let err = store_open(bare).err().expect("must fail on bare file");
    assert!(
        err.to_string().contains("missing the graph schema"),
        "{err}"
    );
}

#[test]
fn extract_defers_on_parse_error_and_rejects_unported_walker() {
    // Parse-error files defer (the routing signal), not panic.
    let out = extract_file("bad.ts", "export function {{{\n", "typescript");
    match out {
        Err(msg) => assert!(msg.starts_with("defer:"), "parse errors defer: {msg}"),
        Ok(_) => panic!("broken syntax must not extract"),
    }

    // Unported walkers error loudly, not silently.
    let out = extract_file("x.java", "class A {}\n", "java");
    assert!(
        out.is_err(),
        "java walker is not ported; must be an explicit error"
    );
}

#[test]
fn second_handle_reads_committed_graph() {
    let env = Env::new();
    let store = store_open(env.db.clone()).unwrap();
    let out = extract_file("a.ts", "export const x = 1;\n", "typescript").unwrap();
    commit_extraction(&store, "a.ts", "h1", "typescript", &out);

    // A second handle over the same DB reads the committed graph (WAL mode).
    let store2 = store_open(env.db.clone()).unwrap();
    let ctx2 = ctx_open(&store2, env.dir.to_string_lossy().to_string()).unwrap();
    let wire = ctx_get_nodes_by_names(&ctx2, vec!["x".to_string()]).unwrap();
    let node_count = u32::from_le_bytes([wire[8], wire[9], wire[10], wire[11]]);
    assert_eq!(node_count, 1);
}
