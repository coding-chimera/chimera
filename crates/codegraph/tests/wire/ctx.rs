//! Ctx wire round trips and output views.

use codewhale_codegraph::wire::abi;
use codewhale_codegraph::wire::buf::Arena;
use codewhale_codegraph::wire::ctx::{
    GroupRow, MappingRow, MappingsHeader, MappingsOut, NodesHeader, NodesOut, ReExportRow,
    ReExportsHeader, ReExportsOut, StringsHeader, StringsOut,
};
use codewhale_codegraph::wire::store::NodeRow;

fn sample_node(arena: &mut Arena) -> NodeRow {
    NodeRow {
        id: arena.put("function:abc"),
        kind: arena.put("function"),
        name: arena.put("run"),
        qualified_name: arena.put("A.run"),
        file_path: arena.put("src/a.ts"),
        language: arena.put("typescript"),
        start_line: 2,
        end_line: 4,
        start_column: 0,
        end_column: 5,
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
    }
}

#[test]
fn headers_round_trip() {
    let nodes = NodesHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        node_count: 2,
        arena_len: 3,
    };
    assert_eq!(nodes.encode().len(), abi::CTX_NODES_HEADER_SIZE);
    assert_eq!(NodesHeader::decode(&nodes.encode()).unwrap(), nodes);

    let strings = StringsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 2,
        str_count: 3,
        arena_len: 4,
    };
    assert_eq!(strings.encode().len(), abi::CTX_STRINGS_HEADER_SIZE);
    assert_eq!(StringsHeader::decode(&strings.encode()).unwrap(), strings);

    let mappings = MappingsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        mapping_count: 2,
        arena_len: 3,
    };
    assert_eq!(mappings.encode().len(), abi::CTX_MAPPINGS_HEADER_SIZE);
    assert_eq!(
        MappingsHeader::decode(&mappings.encode()).unwrap(),
        mappings
    );

    let reexports = ReExportsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        reexport_count: 2,
        arena_len: 3,
    };
    assert_eq!(reexports.encode().len(), abi::CTX_REEXPORTS_HEADER_SIZE);
    assert_eq!(
        ReExportsHeader::decode(&reexports.encode()).unwrap(),
        reexports
    );
}

#[test]
fn rows_round_trip() {
    let group = GroupRow { start: 1, end: 3 };
    assert_eq!(GroupRow::decode(&group.encode()).unwrap(), group);

    let mut arena = Arena::new();
    let mapping = MappingRow {
        local_name: arena.put("local"),
        exported_name: arena.put("exported"),
        source: arena.put("./mod"),
        resolved_path: abi::NONE_STR,
        flags: 0b11,
    };
    let bytes = mapping.encode();
    assert_eq!(bytes.len(), abi::CTX_MAPPING_ROW_SIZE);
    assert_eq!(MappingRow::decode(&bytes).unwrap(), mapping);

    let reexport = ReExportRow {
        kind: abi::CTX_REEXPORT_WILDCARD,
        exported_name: abi::NONE_STR,
        original_name: abi::NONE_STR,
        source: arena.put("./mod"),
    };
    let bytes = reexport.encode();
    assert_eq!(bytes.len(), abi::CTX_REEXPORT_ROW_SIZE);
    assert_eq!(ReExportRow::decode(&bytes).unwrap(), reexport);
}

#[test]
fn nodes_out_parses_groups_and_nodes() {
    let mut arena = Arena::new();
    let node = sample_node(&mut arena);
    let arena_bytes = arena.into_vec();
    let header = NodesHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        node_count: 1,
        arena_len: arena_bytes.len() as u32,
    };
    let groups = GroupRow { start: 0, end: 1 }.encode();
    let nodes = node.encode();
    let out = NodesOut::parse(&header.encode(), &groups, &nodes, &arena_bytes).unwrap();
    assert_eq!(out.group(0).unwrap(), GroupRow { start: 0, end: 1 });
    assert_eq!(out.node(0).unwrap(), node);
    assert_eq!(out.group_nodes(0).unwrap(), vec![node]);
    assert!(out.node(1).is_err());
}

#[test]
fn strings_out_parses_optional_values() {
    let mut arena = Arena::new();
    let first = arena.put("a.ts");
    let second = abi::NONE_STR;
    let arena_bytes = arena.into_vec();
    let header = StringsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        str_count: 2,
        arena_len: arena_bytes.len() as u32,
    };
    let groups = GroupRow { start: 0, end: 2 }.encode();
    let mut strs = Vec::new();
    strs.extend_from_slice(&first.0.to_le_bytes());
    strs.extend_from_slice(&first.1.to_le_bytes());
    strs.extend_from_slice(&second.0.to_le_bytes());
    strs.extend_from_slice(&second.1.to_le_bytes());
    let out = StringsOut::parse(&header.encode(), &groups, &strs, &arena_bytes).unwrap();
    assert_eq!(out.str_ref(0).unwrap(), first);
    assert_eq!(out.str_ref(1).unwrap(), second);
    let values = out
        .group_strings(0, &Arena::from_bytes(&arena_bytes))
        .unwrap();
    assert_eq!(values, vec![Some("a.ts".to_string()), None]);
}

#[test]
fn mappings_and_reexports_out_parse() {
    let mut arena = Arena::new();
    let mapping = MappingRow {
        local_name: arena.put("x"),
        exported_name: arena.put("y"),
        source: arena.put("./m"),
        resolved_path: abi::NONE_STR,
        flags: 0,
    };
    let reexport = ReExportRow {
        kind: abi::CTX_REEXPORT_NAMED,
        exported_name: arena.put("y"),
        original_name: arena.put("x"),
        source: arena.put("./m"),
    };
    let arena_bytes = arena.into_vec();

    let mappings_header = MappingsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        mapping_count: 1,
        arena_len: arena_bytes.len() as u32,
    };
    let groups = GroupRow { start: 0, end: 1 }.encode();
    let mappings = mapping.encode();
    let out =
        MappingsOut::parse(&mappings_header.encode(), &groups, &mappings, &arena_bytes).unwrap();
    assert_eq!(out.mapping(0).unwrap(), mapping);

    let reexports_header = ReExportsHeader {
        abi_version: abi::CTX_ABI_VERSION,
        group_count: 1,
        reexport_count: 1,
        arena_len: arena_bytes.len() as u32,
    };
    let reexports = reexport.encode();
    let out = ReExportsOut::parse(
        &reexports_header.encode(),
        &groups,
        &reexports,
        &arena_bytes,
    )
    .unwrap();
    assert_eq!(out.reexport(0).unwrap(), reexport);
}
