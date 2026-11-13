//! Resolution: the read context (ctx) and the strategy-tree resolver.

mod resolver;
mod resolver_ctx;

pub use resolver::{
    BatchInput, BatchOutput, EdgeRow, ExternalStrategies, FrameworkCandidate, FwKey, ImportKey,
    RESOLVE_ABI_VERSION, RESOLVE_ALSO_ROW_SIZE, RESOLVE_CLAIMED_ROW_SIZE, RESOLVE_EDGE_ROW_SIZE,
    RESOLVE_EXT_HEADER_SIZE, RESOLVE_FLAG_SWEEP_BATCH_FILES, RESOLVE_FW_CAND_ROW_SIZE,
    RESOLVE_FW_GROUP_ROW_SIZE, RESOLVE_KEY_ROW_SIZE, RESOLVE_META_SIZE, RESOLVE_OUT_HEADER_SIZE,
    RESOLVE_OUT_REF_ROW_SIZE, RESOLVE_REF_ROW_SIZE, RESOLVE_STAT_ROW_SIZE, RESOLVE_STRATEGY_TABLE,
    RESOLVE_SWEEP_ROW_SIZE, RESOLVE_VERSION, RefIn, ResolveBatch, ResolveBatchOut, ResolveHandle,
    Resolver, SweepRow, resolve_batch, resolve_batch_core, resolve_close, resolve_contract_info,
    resolve_open,
};

pub use resolver_ctx::{
    CTX_ABI_VERSION, CTX_GROUP_ROW_SIZE, CTX_MAPPING_ROW_SIZE, CTX_NODES_HEADER_SIZE,
    CTX_REEXPORT_ROW_SIZE, CTX_REEXPORTS_HEADER_SIZE, CTX_STR_ROW_SIZE, CTX_STRINGS_HEADER_SIZE,
    CTX_VERSION, CtxHandle, ctx_close, ctx_contract_info, ctx_file_exists, ctx_get_all_files,
    ctx_get_all_node_names, ctx_get_file_lines, ctx_get_import_mappings, ctx_get_node_by_id,
    ctx_get_nodes_by_kind, ctx_get_nodes_by_lower_names, ctx_get_nodes_by_names,
    ctx_get_nodes_by_qualified_names, ctx_get_nodes_in_files, ctx_get_project_root,
    ctx_get_re_exports, ctx_has_names, ctx_invalidate, ctx_list_directories, ctx_open,
    ctx_read_files, ctx_warm,
};
