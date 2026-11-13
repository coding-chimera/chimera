//! Resolve wire round trips and buffer validation.

use codewhale_codegraph::wire::abi;
use codewhale_codegraph::wire::buf::Arena;
use codewhale_codegraph::wire::resolve::{
    AlsoRow, EdgeRow, ExternalHeader, FwCandidateRow, FwGroupRow, InBuffers, KeyRow, Meta,
    OutBuffers, OutHeader, OutRefRow, PathRow, RefRow, StatRow, SweepRow,
};

#[test]
fn input_meta_and_ref_round_trip() {
    let meta = Meta {
        abi_version: abi::RESOLVE_ABI_VERSION,
        ref_count: 2,
        flags: abi::RESOLVE_FLAG_SWEEP_BATCH_FILES,
        arena_len: 9,
    };
    let bytes = meta.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_META_SIZE);
    assert_eq!(Meta::decode(&bytes).unwrap(), meta);

    let mut arena = Arena::new();
    let row = RefRow {
        id: 42,
        from_node_id: arena.put("function:a"),
        reference_name: arena.put("helper"),
        reference_kind: arena.put("function_ref"),
        file_path: arena.put("src/a.ts"),
        language: arena.put("typescript"),
        line: 12,
        column: 4,
    };
    let bytes = row.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_REF_ROW_SIZE);
    assert_eq!(RefRow::decode(&bytes).unwrap(), row);
}

#[test]
fn external_rows_round_trip() {
    let header = ExternalHeader {
        abi_version: abi::RESOLVE_ABI_VERSION,
        import_count: 1,
        jvm_count: 1,
        fw_group_count: 1,
        fw_cand_count: 1,
        also_count: 1,
        claimed_count: 1,
        path_count: 1,
    };
    assert_eq!(header.encode().len(), abi::RESOLVE_EXT_HEADER_SIZE);
    assert_eq!(ExternalHeader::decode(&header.encode()).unwrap(), header);

    let mut arena = Arena::new();
    let key = KeyRow {
        file: arena.put("src/a.ts"),
        name: arena.put("x"),
        kind: arena.put("import"),
        target_node_id: arena.put("function:x"),
    };
    let bytes = key.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_KEY_ROW_SIZE);
    assert_eq!(KeyRow::decode(&bytes).unwrap(), key);

    let group = FwGroupRow {
        file: arena.put("src/a.ts"),
        name: arena.put("useQuery"),
        kind: arena.put("calls"),
        line: 3,
        column: 7,
        cand_start: 0,
        cand_end: 1,
    };
    let bytes = group.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_FW_GROUP_ROW_SIZE);
    assert_eq!(FwGroupRow::decode(&bytes).unwrap(), group);

    let candidate = FwCandidateRow {
        target_node_id: arena.put("function:useQuery"),
        resolved_by: 3,
        authoritative: true,
        edge_kind: arena.put("calls"),
        metadata: arena.put("{\"framework\":\"react\"}"),
        also_start: 0,
        also_end: 1,
    };
    let bytes = candidate.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_FW_CAND_ROW_SIZE);
    assert_eq!(FwCandidateRow::decode(&bytes).unwrap(), candidate);

    let also = AlsoRow {
        target_node_id: arena.put("function:x"),
        metadata: abi::NONE_STR,
    };
    let bytes = also.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_ALSO_ROW_SIZE);
    assert_eq!(AlsoRow::decode(&bytes).unwrap(), also);

    let path = PathRow {
        file: arena.put("src/a.ts"),
        source: arena.put("./x"),
        resolved: abi::NONE_STR,
    };
    let bytes = path.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_PATH_ROW_SIZE);
    assert_eq!(PathRow::decode(&bytes).unwrap(), path);
}

#[test]
fn output_rows_round_trip() {
    let header = OutHeader {
        abi_version: abi::RESOLVE_ABI_VERSION,
        batch_edge_count: 1,
        resolved_count: 1,
        failed_count: 1,
        sweep_count: 1,
        stat_count: 1,
        arena_len: 9,
        total: 2,
        resolved_total: 1,
        unresolved_total: 1,
    };
    let bytes = header.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_OUT_HEADER_SIZE);
    assert_eq!(OutHeader::decode(&bytes).unwrap(), header);

    let mut arena = Arena::new();
    let edge = EdgeRow {
        source: arena.put("function:a"),
        target: arena.put("function:b"),
        kind: arena.put("calls"),
        line: 1,
        column: 2,
        target_metadata: arena.put("{\"k\":1}"),
        resolved_by: arena.put("import"),
        ref_name: arena.put("b"),
        ref_kind: abi::NONE_STR,
        fn_ref: true,
    };
    let bytes = edge.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_EDGE_ROW_SIZE);
    assert_eq!(EdgeRow::decode(&bytes).unwrap(), edge);

    let out_ref = OutRefRow {
        flag: abi::RESOLVE_OUT_REF_RESOLVED,
        id: 7,
        from_node_id: arena.put("function:a"),
        reference_name: arena.put("b"),
        reference_kind: arena.put("calls"),
    };
    let bytes = out_ref.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_OUT_REF_ROW_SIZE);
    assert_eq!(OutRefRow::decode(&bytes).unwrap(), out_ref);

    let sweep = SweepRow {
        source_node_id: arena.put("file:src/a.ts"),
        edge_start: 1,
        edge_end: 2,
    };
    let bytes = sweep.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_SWEEP_ROW_SIZE);
    assert_eq!(SweepRow::decode(&bytes).unwrap(), sweep);

    let stat = StatRow {
        by_method: arena.put("import"),
        count: 3,
    };
    let bytes = stat.encode();
    assert_eq!(bytes.len(), abi::RESOLVE_STAT_ROW_SIZE);
    assert_eq!(StatRow::decode(&bytes).unwrap(), stat);
}

#[test]
fn in_buffers_validate_and_expose_refs() {
    let mut arena = Arena::new();
    let row = RefRow {
        id: -1,
        from_node_id: arena.put("function:a"),
        reference_name: arena.put("b"),
        reference_kind: arena.put("calls"),
        file_path: arena.put("a.ts"),
        language: arena.put("typescript"),
        line: 1,
        column: 0,
    };
    let arena_bytes = arena.into_vec();
    let meta = Meta {
        abi_version: abi::RESOLVE_ABI_VERSION,
        ref_count: 1,
        flags: 0,
        arena_len: arena_bytes.len() as u32,
    };
    let external = ExternalHeader {
        abi_version: abi::RESOLVE_ABI_VERSION,
        import_count: 0,
        jvm_count: 0,
        fw_group_count: 0,
        fw_cand_count: 0,
        also_count: 0,
        claimed_count: 0,
        path_count: 0,
    }
    .encode();
    let refs = row.encode();
    let buffers = InBuffers {
        meta: &meta.encode(),
        refs: &refs,
        external: &external,
        arena: &arena_bytes,
    };
    assert_eq!(buffers.validate().unwrap().ref_count, 1);
    assert_eq!(buffers.ref_row(0).unwrap(), row);
    assert_eq!(
        buffers.external_header().unwrap().abi_version,
        abi::RESOLVE_ABI_VERSION
    );
    assert!(buffers.ref_row(1).is_err());
}

#[test]
fn out_buffers_validate_and_expose_plan_rows() {
    let mut arena = Arena::new();
    let edge = EdgeRow {
        source: arena.put("function:a"),
        target: arena.put("function:b"),
        kind: arena.put("calls"),
        line: 0,
        column: 0,
        target_metadata: abi::NONE_STR,
        resolved_by: arena.put("import"),
        ref_name: arena.put("b"),
        ref_kind: abi::NONE_STR,
        fn_ref: false,
    };
    let out_ref = OutRefRow {
        flag: abi::RESOLVE_OUT_REF_UNRESOLVED,
        id: -1,
        from_node_id: arena.put("function:a"),
        reference_name: arena.put("c"),
        reference_kind: arena.put("calls"),
    };
    let sweep = SweepRow {
        source_node_id: arena.put("file:a.ts"),
        edge_start: 1,
        edge_end: 1,
    };
    let stat = StatRow {
        by_method: arena.put("import"),
        count: 1,
    };
    let arena_bytes = arena.into_vec();
    let header = OutHeader {
        abi_version: abi::RESOLVE_ABI_VERSION,
        batch_edge_count: 1,
        resolved_count: 0,
        failed_count: 1,
        sweep_count: 1,
        stat_count: 1,
        arena_len: arena_bytes.len() as u32,
        total: 2,
        resolved_total: 1,
        unresolved_total: 1,
    };
    let edges = edge.encode();
    let refs = out_ref.encode();
    let files = sweep.encode();
    let stats = stat.encode();
    let buffers = OutBuffers {
        header: &header.encode(),
        edges: &edges,
        refs: &refs,
        files: &files,
        stats: &stats,
        arena: &arena_bytes,
    };
    assert_eq!(buffers.validate().unwrap().batch_edge_count, 1);
    assert_eq!(buffers.edge(0).unwrap(), edge);
    assert_eq!(buffers.ref_row(0).unwrap(), out_ref);
    assert_eq!(buffers.sweep(0).unwrap(), sweep);
    assert_eq!(buffers.stat(0).unwrap(), stat);
}

#[test]
fn validate_rejects_wrong_abi() {
    let mut meta = Meta {
        abi_version: 7,
        ref_count: 0,
        flags: 0,
        arena_len: 0,
    };
    let raw_meta = meta.encode();
    let buffers = InBuffers {
        meta: &raw_meta,
        refs: &[],
        external: &[],
        arena: &[],
    };
    assert!(
        buffers
            .validate()
            .unwrap_err()
            .message
            .contains("RESOLVE_ABI_VERSION")
    );
    meta.abi_version = abi::RESOLVE_ABI_VERSION;
    let raw_meta = meta.encode();
    let buffers = InBuffers {
        meta: &raw_meta,
        refs: &[],
        external: &[],
        arena: &[],
    };
    assert!(buffers.validate().is_ok());
}
