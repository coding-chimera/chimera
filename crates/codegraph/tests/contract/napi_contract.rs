//! The four contract infos must equal the fixture recorded from the HEAD NAPI
//! binary (`packages/chimera/test/oracle/data-graph/contract/napi-contract.json`).

use codewhale_codegraph::contract::{
    BUILTINS_VERSION, CTX_VERSION, CtxContractInfo, KERNEL_VERSION, KernelContractInfo,
    RESOLVE_VERSION, ResolveContractInfo, STORE_VERSION, StoreContractInfo, ctx_contract_info,
    kernel_contract_info, resolve_contract_info, store_contract_info,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/napi-contract.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read contract fixture {path}: {error}"));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("invalid contract fixture {path}: {error}"))
}

fn kernel_value(info: &KernelContractInfo) -> Value {
    json!({
        "abiVersion": info.abi_version,
        "kernelVersion": info.kernel_version,
        "nodeKinds": info.node_kinds,
        "edgeKinds": info.edge_kinds,
        "languages": info.languages,
    })
}

fn store_value(info: &StoreContractInfo) -> Value {
    json!({
        "abiVersion": info.abi_version,
        "storeVersion": info.store_version,
        "nodeKinds": info.node_kinds,
        "edgeKinds": info.edge_kinds,
    })
}

fn ctx_value(info: &CtxContractInfo) -> Value {
    json!({
        "ctxAbi": info.ctx_abi,
        "ctxVersion": info.ctx_version,
        "nodeRowSize": info.node_row_size,
        "gettersPresent": info.getters_present,
        "gettersAbsent": info.getters_absent,
        "semantics": info.semantics,
    })
}

fn resolve_value(info: &ResolveContractInfo) -> Value {
    json!({
        "resolveAbi": info.resolve_abi,
        "resolveVersion": info.resolve_version,
        "strategies": info.strategies,
        "resolverRank": info.resolver_rank,
        "builtinsVersion": info.builtins_version,
        "ambiguousNameCeiling": info.ambiguous_name_ceiling,
        "refRowSize": info.ref_row_size,
        "edgeRowSize": info.edge_row_size,
    })
}

#[test]
fn fixture_metadata_is_the_track_contract() {
    let fixture = fixture();
    assert_eq!(fixture["fixture_version"], 1);
    assert_eq!(fixture["contract_rev"], "cr-2026-10-30-r1");
    assert_eq!(fixture["recorded_from"]["kernel_version"], KERNEL_VERSION);
}

#[test]
fn kernel_contract_info_matches_head() {
    let fixture = fixture();
    assert_eq!(kernel_value(&kernel_contract_info()), fixture["kernel"]);
}

#[test]
fn store_contract_info_matches_head() {
    let fixture = fixture();
    assert_eq!(store_value(&store_contract_info()), fixture["store"]);
}

#[test]
fn ctx_contract_info_matches_head() {
    let fixture = fixture();
    assert_eq!(ctx_value(&ctx_contract_info()), fixture["ctx"]);
}

#[test]
fn resolve_contract_info_matches_head() {
    let fixture = fixture();
    assert_eq!(resolve_value(&resolve_contract_info()), fixture["resolve"]);
    assert_eq!(
        BUILTINS_VERSION,
        fixture["resolve"]["builtinsVersion"].as_str().unwrap()
    );
}

#[test]
fn version_constants_match_the_fixture() {
    let fixture = fixture();
    assert_eq!(fixture["kernel"]["kernelVersion"], KERNEL_VERSION);
    assert_eq!(fixture["store"]["storeVersion"], STORE_VERSION);
    assert_eq!(fixture["ctx"]["ctxVersion"], CTX_VERSION);
    assert_eq!(fixture["resolve"]["resolveVersion"], RESOLVE_VERSION);
}
