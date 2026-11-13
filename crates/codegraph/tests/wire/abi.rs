//! ABI constants must equal the HEAD NAPI values.

use codewhale_codegraph::wire::abi;

#[test]
fn abi_versions_match_head() {
    assert_eq!(abi::KERNEL_ABI_VERSION, 2);
    assert_eq!(abi::STORE_ABI_VERSION, 1);
    assert_eq!(abi::CTX_ABI_VERSION, 1);
    assert_eq!(abi::RESOLVE_ABI_VERSION, 1);
}

#[test]
fn extraction_row_sizes_match_head() {
    assert_eq!(abi::META_SIZE, 36);
    assert_eq!(abi::NODE_ROW_SIZE, 96);
    assert_eq!(abi::EDGE_ROW_SIZE, 44);
    assert_eq!(abi::REF_ROW_SIZE, 40);
}

#[test]
fn store_row_sizes_match_head() {
    assert_eq!(abi::STORE_META_HEADER_SIZE, 28);
    assert_eq!(abi::STORE_OP_ROW_SIZE, 48);
    assert_eq!(abi::STORE_FILE_ROW_SIZE, 64);
    assert_eq!(abi::STORE_NODE_ROW_SIZE, 140);
    assert_eq!(abi::STORE_EDGE_ROW_SIZE, 48);
    assert_eq!(abi::STORE_REF_ROW_SIZE, 56);
}

#[test]
fn ctx_row_sizes_match_head() {
    assert_eq!(abi::CTX_NODES_HEADER_SIZE, 20);
    assert_eq!(abi::CTX_STRINGS_HEADER_SIZE, 16);
    assert_eq!(abi::CTX_MAPPINGS_HEADER_SIZE, 20);
    assert_eq!(abi::CTX_REEXPORTS_HEADER_SIZE, 20);
    assert_eq!(abi::CTX_GROUP_ROW_SIZE, 8);
    assert_eq!(abi::CTX_STR_ROW_SIZE, 8);
    assert_eq!(abi::CTX_MAPPING_ROW_SIZE, 36);
    assert_eq!(abi::CTX_REEXPORT_ROW_SIZE, 28);
}

#[test]
fn resolve_row_sizes_match_head() {
    assert_eq!(abi::RESOLVE_META_SIZE, 16);
    assert_eq!(abi::RESOLVE_REF_ROW_SIZE, 64);
    assert_eq!(abi::RESOLVE_EXT_HEADER_SIZE, 32);
    assert_eq!(abi::RESOLVE_KEY_ROW_SIZE, 32);
    assert_eq!(abi::RESOLVE_FW_GROUP_ROW_SIZE, 48);
    assert_eq!(abi::RESOLVE_FW_CAND_ROW_SIZE, 40);
    assert_eq!(abi::RESOLVE_ALSO_ROW_SIZE, 16);
    assert_eq!(abi::RESOLVE_CLAIMED_ROW_SIZE, 8);
    assert_eq!(abi::RESOLVE_PATH_ROW_SIZE, 24);
    assert_eq!(abi::RESOLVE_OUT_HEADER_SIZE, 40);
    assert_eq!(abi::RESOLVE_EDGE_ROW_SIZE, 80);
    assert_eq!(abi::RESOLVE_OUT_REF_ROW_SIZE, 40);
    assert_eq!(abi::RESOLVE_SWEEP_ROW_SIZE, 24);
    assert_eq!(abi::RESOLVE_STAT_ROW_SIZE, 16);
}

#[test]
fn kind_tables_match_head() {
    assert_eq!(abi::NODE_KINDS.len(), 24);
    assert_eq!(abi::NODE_KINDS[0], "file");
    assert_eq!(abi::NODE_KINDS[23], "statement");
    assert_eq!(abi::EDGE_KINDS.len(), 13);
    assert_eq!(abi::EDGE_KINDS[0], "contains");
    assert_eq!(abi::EDGE_KINDS[12], "navigates");
    assert_eq!(abi::LANGUAGES.len(), 23);
    assert_eq!(abi::LANGUAGES[0], "typescript");
    assert_eq!(abi::LANGUAGES[22], "objc");
}

#[test]
fn kind_indices_round_trip_and_reject_unknown() {
    for (index, kind) in abi::NODE_KINDS.iter().enumerate() {
        assert_eq!(abi::node_kind_index(kind), Some(index as u8));
    }
    for (index, kind) in abi::EDGE_KINDS.iter().enumerate() {
        assert_eq!(abi::edge_kind_index(kind), Some(index as u8));
    }
    assert_eq!(abi::node_kind_index("not_a_kind"), None);
    assert_eq!(abi::edge_kind_index("not_a_kind"), None);
}

#[test]
fn sentinel_values_match_head() {
    assert_eq!(abi::NONE, 0xFFFF_FFFF);
    assert_eq!(abi::NONE_STR, (abi::NONE, 0));
    assert_eq!(abi::FUNCTION_REF_CODE, 200);
    assert_eq!(abi::REF_FLAG_FILE_PATH, 1);
    assert_eq!(abi::DELETE_FILE_FLAG_RESURRECT, 1);
    assert_eq!(abi::RESOLVE_FLAG_SWEEP_BATCH_FILES, 1);
}
