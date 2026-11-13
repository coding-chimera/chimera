//! Extraction wire round trips.

use codewhale_codegraph::wire::abi;
use codewhale_codegraph::wire::buf::Arena;
use codewhale_codegraph::wire::extract::{Buffers, EdgeRow, Meta, NodeRow, RawBufs, RefRow};

fn sample_meta(node_count: u32, edge_count: u32, ref_count: u32, arena_len: u32) -> Meta {
    Meta {
        abi_version: abi::KERNEL_ABI_VERSION,
        node_count,
        edge_count,
        ref_count,
        arena_len,
        errors_json: abi::NONE_STR,
        duration_ms: 1.25,
    }
}

#[test]
fn meta_round_trips() {
    let meta = sample_meta(1, 2, 3, 42);
    let bytes = meta.encode();
    assert_eq!(bytes.len(), abi::META_SIZE);
    let decoded = Meta::decode(&bytes).unwrap();
    assert_eq!(decoded, meta);
    assert_eq!(decoded.duration_ms.to_bits(), meta.duration_ms.to_bits());
    assert_eq!(decoded.encode(), bytes);
}

#[test]
fn node_row_round_trips() {
    let mut arena = Arena::new();
    let row = NodeRow {
        kind: 7,
        visibility: 1,
        flags: 0b0101,
        start_line: 10,
        end_line: 12,
        start_column: 4,
        end_column: 9,
        name: arena.put("run"),
        qualified_name: arena.put("A.run"),
        id: arena.put("function:abc"),
        docstring: arena.put("docs"),
        signature: arena.put("run(): void"),
        decorators: arena.put("deprecated\0memo"),
        type_parameters: arena.put("T"),
        return_type: arena.put("void"),
        extra_json: arena.put("{\"x\":1}"),
        metrics: 0,
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::NODE_ROW_SIZE);
    assert_eq!(NodeRow::decode(&bytes).unwrap(), row);
    assert_eq!(NodeRow::decode(&bytes).unwrap().encode(), bytes);
}

#[test]
fn edge_row_round_trips() {
    let mut arena = Arena::new();
    let row = EdgeRow {
        source: 0,
        target: 1,
        kind: 1,
        provenance: 2,
        line: 4,
        column: 7,
        metadata_json: arena.put("{\"resolvedBy\":\"import\"}"),
        source_id: arena.put("function:a"),
        target_id: arena.put("function:b"),
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::EDGE_ROW_SIZE);
    assert_eq!(EdgeRow::decode(&bytes).unwrap(), row);
}

#[test]
fn ref_row_round_trips() {
    let mut arena = Arena::new();
    let row = RefRow {
        from_node: abi::NONE,
        kind: abi::FUNCTION_REF_CODE,
        flags: abi::REF_FLAG_FILE_PATH,
        line: 3,
        column: 1,
        reference_name: arena.put("helper"),
        candidates: arena.put("a\0b"),
        from_node_id: arena.put("function:caller"),
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::REF_ROW_SIZE);
    assert_eq!(RefRow::decode(&bytes).unwrap(), row);
}

#[test]
fn raw_buffers_decode_rows_and_validate_counts() {
    let mut arena = Arena::new();
    let node = NodeRow {
        kind: 0,
        visibility: 0,
        flags: 0,
        start_line: 1,
        end_line: 1,
        start_column: 0,
        end_column: 0,
        name: arena.put("x"),
        qualified_name: arena.put("x"),
        id: arena.put("file:x"),
        docstring: abi::NONE_STR,
        signature: abi::NONE_STR,
        decorators: abi::NONE_STR,
        type_parameters: abi::NONE_STR,
        return_type: abi::NONE_STR,
        extra_json: abi::NONE_STR,
        metrics: 0,
    };
    let edge = EdgeRow {
        source: 0,
        target: 0,
        kind: 0,
        provenance: 0,
        line: abi::NONE,
        column: abi::NONE,
        metadata_json: abi::NONE_STR,
        source_id: abi::NONE_STR,
        target_id: abi::NONE_STR,
    };
    let reference = RefRow {
        from_node: 0,
        kind: 1,
        flags: 0,
        line: 1,
        column: 0,
        reference_name: arena.put("y"),
        candidates: abi::NONE_STR,
        from_node_id: abi::NONE_STR,
    };
    let arena_bytes = arena.into_vec();
    let meta = sample_meta(1, 1, 1, arena_bytes.len() as u32);
    let buffers = Buffers {
        meta: meta.encode(),
        nodes: node.encode(),
        edges: edge.encode(),
        refs: reference.encode(),
        arena: arena_bytes,
    };
    let raw = buffers.as_raw();
    let decoded = raw.validate().unwrap();
    assert_eq!(decoded.node_count, 1);
    assert_eq!(raw.node(0).unwrap(), node);
    assert_eq!(raw.edge(0).unwrap(), edge);
    assert_eq!(raw.reference(0).unwrap(), reference);
}

#[test]
fn validate_rejects_wrong_abi_and_truncated_tables() {
    let mut meta = sample_meta(1, 0, 0, 0);
    meta.abi_version = 1;
    let raw = RawBufs {
        meta: &meta.encode(),
        nodes: &[0u8; abi::NODE_ROW_SIZE],
        edges: &[],
        refs: &[],
        arena: &[],
    };
    let error = raw.validate().unwrap_err();
    assert!(error.message.contains("extract wire: abi"));

    let meta = sample_meta(2, 0, 0, 0);
    let raw = RawBufs {
        meta: &meta.encode(),
        nodes: &[0u8; abi::NODE_ROW_SIZE],
        edges: &[],
        refs: &[],
        arena: &[],
    };
    let error = raw.validate().unwrap_err();
    assert!(error.message.contains("nodes buffer"));
}
