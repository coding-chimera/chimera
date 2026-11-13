pub mod egraph;
pub mod error_map;

use crate::wire::abi;

/// `contract_info().kernel_version` at HEAD.
pub const KERNEL_VERSION: &str = "0.1.0";
/// `store_contract_info().store_version`.
pub const STORE_VERSION: &str = "1.0.0";
/// `ctx_contract_info().ctx_version`.
pub const CTX_VERSION: &str = "1.0.0";
/// `resolve_contract_info().resolve_version`.
pub const RESOLVE_VERSION: &str = "1.0.0";

/// `DEFAULT_CACHE_LIMIT` (resolution/index.ts:51); the adapter applies
/// `CODEGRAPH_RESOLVER_CACHE_SIZE` before calling [`ctx_contract_info_for`].
pub const DEFAULT_RESOLVER_CACHE_LIMIT: usize = 5_000;

/// `DEFAULT_AMBIGUOUS_NAME_CEILING` (name-matcher.ts:20-24); the adapter
/// applies `CODEGRAPH_AMBIGUOUS_NAME_CEILING` before calling
/// [`resolve_contract_info_for`].
pub const DEFAULT_AMBIGUOUS_NAME_CEILING: u32 = 500;

/// Content version of the builtin name tables (js-builtins.ts port) at HEAD.
/// DG-04 re-derives this hash from the actual tables and must keep equality;
/// any change is a contract bump and requires re-recording the fixture.
pub const BUILTINS_VERSION: &str = "builtin-tables-v1-502aeb9c686d3da0";

/// `CtxContractInfo.getters_present` — exact HEAD order.
pub const CTX_GETTERS_PRESENT: [&str; 16] = [
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
];

/// The 15 getters DG-04 must implement with field-level parity.
/// `getProjectRoot` is excluded: it is `retire_after_parity` and TS keeps its
/// constructor-side value until then.
pub const CTX_ROUTED_GETTERS: [&str; 15] = [
    "getNodesInFile",
    "getNodesByName",
    "getNodesByQualifiedName",
    "getNodesByKind",
    "fileExists",
    "readFile",
    "getAllFiles",
    "getAllNodeNames",
    "getNodesByLowerName",
    "getImportMappings",
    "getReExports",
    "listDirectories",
    "getFileLines",
    "getNodeById",
    "hasNames",
];

/// `CtxContractInfo.getters_absent` — these stay TS-only and must never
/// appear in the core routing table.
pub const CTX_GETTERS_ABSENT: [&str; 4] = [
    "getProjectAliases",
    "getGoModule",
    "getCppIncludeDirs",
    "resolveImport",
];

/// `ResolveContractInfo.strategies` — the 31-strategy manifest, exact HEAD
/// order (kernel ⊆ fork subset direction at the TS gate).
pub const RESOLVE_STRATEGIES: [&str; 31] = [
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

/// `ResolveContractInfo.resolverRank` — frozen evidence order as
/// `"resolvedBy:rank"` strings.
pub const RESOLVER_RANK: [&str; 8] = [
    "import:6",
    "qualified-name:5",
    "exact-match:4",
    "function-ref:4",
    "instance-method:3",
    "file-path:2",
    "framework:1",
    "fuzzy:0",
];

/// Extraction contract info (`contract_info` in codegraph-kernel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelContractInfo {
    pub abi_version: u32,
    pub kernel_version: String,
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
    pub languages: Vec<String>,
}

/// Store contract info (`store_contract_info`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreContractInfo {
    pub abi_version: u32,
    pub store_version: String,
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
}

/// Resolution read-context contract info (`ctx_contract_info`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CtxContractInfo {
    pub ctx_abi: u32,
    pub ctx_version: String,
    pub node_row_size: u32,
    pub getters_present: Vec<String>,
    pub getters_absent: Vec<String>,
    pub semantics: Vec<String>,
}

/// Resolution batch contract info (`resolve_contract_info`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveContractInfo {
    pub resolve_abi: u32,
    pub resolve_version: String,
    pub strategies: Vec<String>,
    pub resolver_rank: Vec<String>,
    pub builtins_version: String,
    pub ambiguous_name_ceiling: u32,
    pub ref_row_size: u32,
    pub edge_row_size: u32,
}

/// Grammar identity (`grammar_info`). DG-05 produces this from the grammar
/// registry; DG-01 only freezes the shape so the adapter can be written
/// against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrammarInfo {
    pub abi_version: u32,
    pub node_kind_count: u32,
    pub field_count: u32,
    pub node_kinds: Vec<String>,
    pub field_names: Vec<String>,
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

/// HEAD extraction contract info.
pub fn kernel_contract_info() -> KernelContractInfo {
    kernel_contract_info_for(KERNEL_VERSION)
}

/// Extraction contract info with an explicit kernel version (the adapter
/// passes `env!("CARGO_PKG_VERSION")` of the kernel crate).
pub fn kernel_contract_info_for(kernel_version: &str) -> KernelContractInfo {
    KernelContractInfo {
        abi_version: abi::KERNEL_ABI_VERSION as u32,
        kernel_version: kernel_version.to_string(),
        node_kinds: strings(&abi::NODE_KINDS),
        edge_kinds: strings(&abi::EDGE_KINDS),
        languages: strings(&abi::LANGUAGES),
    }
}

/// HEAD store contract info.
pub fn store_contract_info() -> StoreContractInfo {
    StoreContractInfo {
        abi_version: abi::STORE_ABI_VERSION as u32,
        store_version: STORE_VERSION.to_string(),
        node_kinds: strings(&abi::NODE_KINDS),
        edge_kinds: strings(&abi::EDGE_KINDS),
    }
}

/// HEAD ctx contract info (default cache limit).
pub fn ctx_contract_info() -> CtxContractInfo {
    ctx_contract_info_for(DEFAULT_RESOLVER_CACHE_LIMIT)
}

/// Ctx contract info with the adapter-resolved cache limit.
pub fn ctx_contract_info_for(cache_limit: usize) -> CtxContractInfo {
    CtxContractInfo {
        ctx_abi: abi::CTX_ABI_VERSION as u32,
        ctx_version: CTX_VERSION.to_string(),
        node_row_size: abi::STORE_NODE_ROW_SIZE as u32,
        getters_present: strings(&CTX_GETTERS_PRESENT),
        getters_absent: strings(&CTX_GETTERS_ABSENT),
        semantics: ctx_semantics(cache_limit),
    }
}

/// Semantic-difference declarations the TS verifier surfaces. `cache_limit`
/// is the adapter-resolved `CODEGRAPH_RESOLVER_CACHE_SIZE` value.
pub fn ctx_semantics(cache_limit: usize) -> Vec<String> {
    vec![
        format!("lru:{cache_limit}/{}", (cache_limit / 5).max(64)),
        "byIdCache:1000".to_string(),
        "generation:store-commits".to_string(),
        "knownFiles:file-table".to_string(),
        "listDirectories:sorted".to_string(),
        "readFile:lossy-utf8".to_string(),
    ]
}

/// HEAD resolve contract info (default ceiling + pinned builtin version).
pub fn resolve_contract_info() -> ResolveContractInfo {
    resolve_contract_info_for(BUILTINS_VERSION, DEFAULT_AMBIGUOUS_NAME_CEILING)
}

/// Resolve contract info with adapter-resolved ceiling and DG-04-derived
/// builtin table version.
pub fn resolve_contract_info_for(
    builtins_version: &str,
    ambiguous_name_ceiling: u32,
) -> ResolveContractInfo {
    ResolveContractInfo {
        resolve_abi: abi::RESOLVE_ABI_VERSION as u32,
        resolve_version: RESOLVE_VERSION.to_string(),
        strategies: strings(&RESOLVE_STRATEGIES),
        resolver_rank: strings(&RESOLVER_RANK),
        builtins_version: builtins_version.to_string(),
        ambiguous_name_ceiling,
        ref_row_size: abi::RESOLVE_REF_ROW_SIZE as u32,
        edge_row_size: abi::RESOLVE_EDGE_ROW_SIZE as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routed_getters_are_present_minus_project_root() {
        let mut present = CTX_GETTERS_PRESENT.to_vec();
        present.retain(|getter| *getter != "getProjectRoot");
        assert_eq!(present, CTX_ROUTED_GETTERS.to_vec());
        assert_eq!(CTX_ROUTED_GETTERS.len(), 15);
    }

    #[test]
    fn absent_getters_never_appear_in_the_routing_table() {
        for getter in CTX_GETTERS_ABSENT {
            assert!(!CTX_GETTERS_PRESENT.contains(&getter));
            assert!(!CTX_ROUTED_GETTERS.contains(&getter));
        }
    }

    #[test]
    fn ctx_semantics_follows_the_cache_limit() {
        assert_eq!(ctx_semantics(5_000)[0], "lru:5000/1000");
        assert_eq!(ctx_semantics(100)[0], "lru:100/64");
    }
}
