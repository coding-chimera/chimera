//! Store wire round trips and buffer validation.

use codewhale_codegraph::wire::abi;
use codewhale_codegraph::wire::buf::Arena;
use codewhale_codegraph::wire::store::{
    Buffers, EdgeRow, FileRow, MetaHeader, NodeRow, OpRow, RefRow, collapse_range,
};

#[test]
fn meta_header_round_trips() {
    let header = MetaHeader {
        abi_version: abi::STORE_ABI_VERSION,
        op_count: 2,
        file_count: 1,
        node_count: 3,
        edge_count: 4,
        ref_count: 5,
        arena_len: 6,
    };
    let bytes = header.encode();
    assert_eq!(bytes.len(), abi::STORE_META_HEADER_SIZE);
    assert_eq!(MetaHeader::decode(&bytes).unwrap(), header);
}

#[test]
fn op_row_round_trips_with_and_without_file() {
    let op = OpRow {
        code: abi::OP_STORE_FILE_RESULT,
        file_index: Some(2),
        node_start: 0,
        node_end: 5,
        edge_start: 5,
        edge_end: abi::NONE,
        ref_start: 7,
        ref_end: 9,
        arg: (0, 3),
        flags: abi::DELETE_FILE_FLAG_RESURRECT,
    };
    let bytes = op.encode();
    assert_eq!(bytes.len(), abi::STORE_OP_ROW_SIZE);
    let decoded = OpRow::decode(&bytes).unwrap();
    assert_eq!(decoded, op);
    assert_eq!(decoded.node_range(), 0..5);
    assert_eq!(decoded.edge_range(), 5..5);
    assert_eq!(decoded.ref_range(), 7..9);

    let mut no_file = op;
    no_file.file_index = None;
    assert_eq!(OpRow::decode(&no_file.encode()).unwrap(), no_file);
}

#[test]
fn collapse_range_treats_none_as_empty() {
    assert_eq!(collapse_range(4, 9), 4..9);
    assert_eq!(collapse_range(4, abi::NONE), 4..4);
    assert_eq!(collapse_range(4, 2), 4..4);
}

#[test]
fn file_row_round_trips() {
    let mut arena = Arena::new();
    let row = FileRow {
        path: arena.put("src/a.ts"),
        content_hash: arena.put("hash"),
        language: arena.put("typescript"),
        errors_json: arena.put("[{\"message\":\"x\"}]"),
        size: 1234,
        modified_at: 1_700_000_000_123.5,
        indexed_at: 1_700_000_000_999,
        node_count: 7,
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::STORE_FILE_ROW_SIZE);
    let decoded = FileRow::decode(&bytes).unwrap();
    assert_eq!(decoded, row);
    assert_eq!(decoded.modified_at.to_bits(), row.modified_at.to_bits());
}

#[test]
fn node_row_round_trips() {
    let mut arena = Arena::new();
    let row = NodeRow {
        id: arena.put("function:abc"),
        kind: arena.put("function"),
        name: arena.put("run"),
        qualified_name: arena.put("A.run"),
        file_path: arena.put("src/a.ts"),
        language: arena.put("typescript"),
        start_line: 1,
        end_line: 3,
        start_column: 0,
        end_column: 10,
        docstring: arena.put("docs"),
        signature: arena.put("run(): void"),
        visibility: arena.put("public"),
        flags: abi::STORE_NODE_FLAG_EXPORTED | abi::STORE_NODE_FLAG_ASYNC,
        decorators_json: arena.put("[]"),
        type_parameters_json: arena.put("[]"),
        return_type: arena.put("void"),
        params_json: arena.put("[]"),
        search_text: arena.put("run A.run"),
        updated_at: 1_700_000_000_000,
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::STORE_NODE_ROW_SIZE);
    assert_eq!(NodeRow::decode(&bytes).unwrap(), row);
}

#[test]
fn edge_and_ref_rows_round_trip() {
    let mut arena = Arena::new();
    let edge = EdgeRow {
        source: arena.put("function:a"),
        target: arena.put("function:b"),
        kind: arena.put("calls"),
        metadata_json: arena.put("{\"resolvedBy\":\"import\"}"),
        line: Some(12),
        col: Some(4),
        provenance: arena.put("tree-sitter"),
    };
    let bytes = edge.encode();
    assert_eq!(bytes.len(), abi::STORE_EDGE_ROW_SIZE);
    assert_eq!(EdgeRow::decode(&bytes).unwrap(), edge);

    let reference = RefRow {
        from_node_id: arena.put("function:a"),
        reference_name: arena.put("helper"),
        reference_kind: arena.put("function_ref"),
        line: None,
        col: None,
        candidates_json: arena.put("[\"helper\"]"),
        file_path: arena.put("src/a.ts"),
        language: arena.put("typescript"),
    };
    let bytes = reference.encode();
    assert_eq!(bytes.len(), abi::STORE_REF_ROW_SIZE);
    assert_eq!(RefRow::decode(&bytes).unwrap(), reference);
}

fn sample_buffers(arena: &[u8]) -> Vec<u8> {
    let header = MetaHeader {
        abi_version: abi::STORE_ABI_VERSION,
        op_count: 1,
        file_count: 1,
        node_count: 1,
        edge_count: 1,
        ref_count: 1,
        arena_len: arena.len() as u32,
    };
    let op = OpRow {
        code: abi::OP_STORE_FILE_RESULT,
        file_index: Some(0),
        node_start: 0,
        node_end: 1,
        edge_start: 0,
        edge_end: 1,
        ref_start: 0,
        ref_end: 1,
        arg: abi::NONE_STR,
        flags: 0,
    };
    let file = FileRow {
        path: (0, 1),
        content_hash: (1, 1),
        language: (2, 1),
        errors_json: abi::NONE_STR,
        size: 0,
        modified_at: 0.0,
        indexed_at: 0,
        node_count: 1,
    };
    let mut meta = header.encode();
    meta.extend(op.encode());
    meta.extend(file.encode());
    meta
}

#[test]
fn buffers_validate_and_expose_rows() {
    let mut arena = Arena::new();
    let node = NodeRow {
        id: arena.put("file:a"),
        kind: arena.put("file"),
        name: arena.put("a"),
        qualified_name: arena.put("a"),
        file_path: arena.put("a"),
        language: arena.put("typescript"),
        start_line: 1,
        end_line: 1,
        start_column: 0,
        end_column: 0,
        docstring: abi::NONE_STR,
        signature: abi::NONE_STR,
        visibility: abi::NONE_STR,
        flags: 0,
        decorators_json: abi::NONE_STR,
        type_parameters_json: abi::NONE_STR,
        return_type: abi::NONE_STR,
        params_json: abi::NONE_STR,
        search_text: abi::NONE_STR,
        updated_at: 0,
    };
    let edge = EdgeRow {
        source: (0, 1),
        target: (0, 1),
        kind: (0, 1),
        metadata_json: abi::NONE_STR,
        line: None,
        col: None,
        provenance: abi::NONE_STR,
    };
    let reference = RefRow {
        from_node_id: (0, 1),
        reference_name: (0, 1),
        reference_kind: (0, 1),
        line: None,
        col: None,
        candidates_json: abi::NONE_STR,
        file_path: abi::NONE_STR,
        language: abi::NONE_STR,
    };
    let arena_bytes = arena.into_vec();
    let meta = sample_buffers(&arena_bytes);
    let buffers = Buffers {
        meta: &meta,
        nodes: &node.encode(),
        edges: &edge.encode(),
        refs: &reference.encode(),
        arena: &arena_bytes,
    };
    let header = buffers.validate().unwrap();
    assert_eq!(header.op_count, 1);
    assert_eq!(buffers.op(0).unwrap().code, abi::OP_STORE_FILE_RESULT);
    assert_eq!(buffers.file(0).unwrap().path, (0, 1));
    assert_eq!(buffers.node(0).unwrap(), node);
    assert_eq!(buffers.edge(0).unwrap(), edge);
    assert_eq!(buffers.reference(0).unwrap(), reference);
    assert_eq!(buffers.ops().unwrap().len(), 1);
    assert_eq!(buffers.files().unwrap().len(), 1);
}

#[test]
fn validate_rejects_wrong_abi_and_short_arena() {
    let mut arena = Arena::new();
    let name = arena.put("x");
    let node = NodeRow {
        id: name,
        kind: name,
        name,
        qualified_name: name,
        file_path: name,
        language: name,
        start_line: 0,
        end_line: 0,
        start_column: 0,
        end_column: 0,
        docstring: abi::NONE_STR,
        signature: abi::NONE_STR,
        visibility: abi::NONE_STR,
        flags: 0,
        decorators_json: abi::NONE_STR,
        type_parameters_json: abi::NONE_STR,
        return_type: abi::NONE_STR,
        params_json: abi::NONE_STR,
        search_text: abi::NONE_STR,
        updated_at: 0,
    };
    let arena_bytes = arena.into_vec();
    let mut header = MetaHeader {
        abi_version: 9,
        op_count: 0,
        file_count: 0,
        node_count: 1,
        edge_count: 0,
        ref_count: 0,
        arena_len: arena_bytes.len() as u32,
    };
    let nodes = node.encode();
    let buffers = Buffers {
        meta: &header.encode(),
        nodes: &nodes,
        edges: &[],
        refs: &[],
        arena: &arena_bytes,
    };
    assert!(
        buffers
            .validate()
            .unwrap_err()
            .message
            .contains("STORE_ABI_VERSION")
    );

    header.abi_version = abi::STORE_ABI_VERSION;
    header.arena_len = arena_bytes.len() as u32 + 1;
    let buffers = Buffers {
        meta: &header.encode(),
        nodes: &nodes,
        edges: &[],
        refs: &[],
        arena: &arena_bytes,
    };
    assert!(
        buffers
            .validate()
            .unwrap_err()
            .message
            .contains("arena_len")
    );
}
