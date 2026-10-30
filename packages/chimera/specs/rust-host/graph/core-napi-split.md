# Graph core / NAPI 拆层设计（WP-06）

> 状态：**draft for review**（设计契约；不实现生产 core）
> contract_rev：`cr-2026-10-30-r1`
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §3（已有 Rust 资产）/§8（WP-06）/§9（manifest 纪律）/§10（统一门禁）；`packages/chimera/specs/rust-host/{manifest.yaml,partition-table.md,a0-scope-decisions.md}`。
> 基线：commit `9600ee7f49ddcb065a33511f21f570d2b2d13a19`
> 关联：`inventory.md`（资产清点）、`parity-fixtures.md`（fixture 契约）、`known-pitfalls.md`（三个坑）

---

## 0. 结论摘要

1. 计划 §3 的 “52 napi 函数” 是 **产品面** 基线：HEAD 实测 54 个 `#[napi] pub fn`，减去两个 cfnptr 差分/调试钩子（`cfnptr_scan_files`、`cfnptr_strip_c`）正好 52。
2. 52 = extraction 3 + store 9 + ctx 21 + resolve 4 + sqlite_bridge 15。**graph 域自身是 37**（extraction/store/ctx/resolve），另外 15 个属于 storage 域的 SQLite bridge。
3. 拆层方向：**纯 Rust core rlib + NAPI 薄适配**。core 不出现 `napi` 类型；`codegraph-kernel` 继续作为 cdylib 给 TS 过渡调用；`chimera-host` 直接链接 core rlib。
4. 迁移顺序建议：`wire → store → ctx → resolve → extraction → query/traversal → pattern`。前四段有现成 NAPI 语义可对；后三段没有 NAPI 基线，先以 TS 为 oracle 新建 core 模块。
5. `sqlite_bridge` 15 个函数不归 graph core，**保留 NAPI**，由 storage 域（WP-05）决定其终态。

---

## 1. 52 基线核对

### 1.1 计划基线

`RUST_FULL_MIGRATION_PLAN.md:87` 记录：`codegraph-kernel`（30 文件 / 40,273 行 / **52 napi 函数**，extraction+store+resolution 默认 ON）。计划没有给出逐函数清单，也没有说明 52 的口径。

### 1.2 HEAD 实测

对 `codegraph-kernel/src/**/*.rs` 中 `#[napi]` 且下一项为 `pub fn` 的声明逐文件计数（2026-10-30）：

| 文件 | 函数数 | 行号（`#[napi]` 后的 `pub fn`） |
|---|---:|---|
| `src/lib.rs` | 5 | 111, 122, 198, 243, 248 |
| `src/store.rs` | 9 | 1381, 1396, 1479, 1485, 1491, 1497, 1502, 1520, 1536 |
| `src/resolver_ctx.rs` | 21 | 1410, 1457, 1466, 1476, 1487, 1497, 1648, 1655, 1662, 1668, 1675, 1682, 1691, 1697, 1703, 1711, 1718, 1725, 1733, 1742, 1748 |
| `src/resolver.rs` | 4 | 6852, 6920, 6934, 6966 |
| `src/sqlite_bridge.rs` | 15 | 553, 596, 603, 783, 797, 819, 848, 975, 990, 1006, 1011, 1016, 1022, 1030, 1046 |
| **合计** | **54** | — |

另有 4 个 `#[napi]` 句柄类（不是函数）：`StoreHandle`（`store.rs:1346`）、`CtxHandle`（`resolver_ctx.rs:1378`）、`ResolveHandle`（`resolver.rs:6851`）、`SqliteBridgeHandle`（`sqlite_bridge.rs:565`）。

### 1.3 口径对齐

| 口径 | 数量 | 说明 |
|---|---:|---|
| 全部 `#[napi] pub fn` | 54 | 含 2 个 cfnptr 钩子 |
| 减 cfnptr 钩子 | **52** | 与计划 §3 基线一致 |
| graph 域（extraction/store/ctx/resolve） | 39 | 含 2 个 cfnptr 钩子 |
| graph 域减 cfnptr | 37 | 产品面 graph 函数 |
| storage 域（sqlite_bridge） | 15 | 不归 graph core |

**为什么把 cfnptr 两个钩子排除在 52 之外**：`cfnptr_scan_files` 是可选批量扫描（`kernel/loader.ts:88-92` 明确“OPTIONAL: absent on older binaries — callers feature-detect”），`cfnptr_strip_c` 是差分 oracle 调试钩子（`kernel/loader.ts:91-92`、`lib.rs:239-245`）；fork 当前没有 JS cFnPtr synthesizer 消费者（`kernel/loader.ts:64-67`）。它们不是 graph 产品路径的一部分。

> **注意**：如果按“graph 域”口径，52 无法由 37 或 39 得到；52 必然包含 sqlite_bridge 的 15 个函数。因此本文把 52 理解为“kernel 全部产品面 NAPI 函数（graph 37 + storage 15）”。

### 1.4 TS 侧清单出处

“packages/chimera/src/graph 内 NAPI 绑定”的权威清单是四个 TS 接口；它们的方法名就是 §3 映射表的行来源：

| TS 接口 | 文件:行 | 方法数 | 覆盖的 Rust 函数 |
|---|---|---:|---|
| `KernelModule` | `packages/chimera/src/graph/extraction/kernel/loader.ts:84-93` | 5 | `lib.rs` 5 个 |
| `StoreModule` | `packages/chimera/src/graph/store/loader.ts:77-91` | 9 | `store.rs` 9 个 |
| `CtxModule` | `packages/chimera/src/graph/store/loader.ts:263-285` | 21 | `resolver_ctx.rs` 21 个 |
| `ResolveModule` | `packages/chimera/src/graph/store/loader.ts:409-414` | 4 | `resolver.rs` 4 个 |
| `SqliteBridgeModule` | `packages/chimera/src/storage/db-bridge.ts:51-77` | 15 | `sqlite_bridge.rs` 15 个 |

合计 54 个方法；其中 52 个产品面（减去 `cfnptr_scan_files` / `cfnptr_strip_c`）。`SqliteBridgeModule` 在 `src/storage/` 而非 `src/graph/`，本文仍列出它，因为计划 §3 的 52 口径必须包含它。

---

## 2. 拆层原则

### 2.1 目标分层

```text
chimera-graph-core (rlib, 无 napi / 无 JS 类型)
├── wire       buffer 布局、ABI 常量、错误码
├── extract    walkers、contract/grammar info、cfnptr
├── store      SQLite store、commit batch、WAL
├── ctx        read context
├── resolve    策略树 + persist plan
├── query      查询/搜索（新建）
├── traverse   遍历（新建）
└── pattern    结构模式（新建，待拍板）

codegraph-kernel (cdylib)  = 薄 NAPI 适配层
chimera-host (Rust)        = 直接链接 chimera-graph-core
```

依赖方向：`codegraph-kernel → chimera-graph-core`、`chimera-host → chimera-graph-core`；core 不反向依赖任何宿主，也不依赖 `napi` / `napi-derive` / `web-tree-sitter`。

### 2.2 硬约束

| # | 约束 | 理由 |
|---:|---|---|
| C1 | core 不出现 `napi::*`、`Buffer`、`Env`、`JsObject` 等类型 | 让 host 可直接链接；NAPI 只做字节/句柄转换 |
| C2 | core 的错误类型是 `CoreError { code, message, retryable }`；adapter 映射到 `napi::Error` | 保持现有 TS 错误分类（`isStoreWireError` 等）可识别 |
| C3 | core 的 buffer 入参用 `&[u8]`，出参用 `Vec<u8>`；NAPI 层负责 `Buffer` 拷贝 | 现有 wire layout 不变，ABI 常量留在 core |
| C4 | 句柄生命周期（open/close/poison）在 core 内实现；NAPI 句柄只是 `Arc` 包装 | 保留 `store_close` / `ctx_close` / `resolve_close` 的确定性释放语义 |
| C5 | core 函数保持同步；线程模型由宿主决定 | 现有 NAPI 调用同步，store 的 worker 化是记录在案的后续项（`store/loader.ts:25-30`） |
| C6 | core 的缓存必须有界（LRU/条目/字节上限） | 计划 §12 风险：host 自身无界增长 |
| C7 | ABI/contract info 函数保留在 core，并由 adapter 透出 | 现有 loader 的 contract gate 依赖 `*_contract_info` |
| C8 | core 不读取 `process.env` 的 kill switch；kill switch 由宿主/adapter 检查 | 保持 `CODEGRAPH_*` 语义在 TS/宿主层可翻转 |

### 2.3 错误与句柄映射

| 现有 NAPI 形态 | core 形态 | adapter 形态 |
|---|---|---|
| `Result<T, napi::Error>` | `Result<T, CoreError>` | `napi::Error::from_reason(format!("{}: {}", code, message))` |
| `#[napi] pub struct StoreHandle` | `store::Handle`（`Arc<Mutex<StoreConn>>` + poisoned flag） | `#[napi] pub struct StoreHandle { inner: core::store::Handle }` |
| `Buffer` 入参 | `&[u8]` | `Buffer::as_ref()` |
| `Buffer` 出参 | `Vec<u8>` | `Buffer::from(vec)` |
| `Option<T>` | `Option<T>` | 原样 |
| 句柄关闭后报错 | core 返回 `CoreError { code: "closed" }` | adapter 保留现有 message 前缀（TS 侧按 message 判定） |

---

## 3. 函数逐个映射

> 约定：`thin_adapter` = core 实现 + NAPI 薄适配（过渡期保留）；`keep_napi` = 不迁 core，继续 NAPI；`retire_after_parity` = core 有入口但 TS 不再路由，parity 后可删 NAPI；`optional_keep_napi` = 可选/差分钩子，保留 NAPI。

### 3.1 extraction（5，其中 2 个在 52 基线之外）

TS 绑定：`KernelModule`（`packages/chimera/src/graph/extraction/kernel/loader.ts:84-93`）。

| # | Rust fn（file:line） | future core entry | NAPI disposition | 备注 |
|---:|---|---|---|---|
| 1 | `contract_info`（`lib.rs:111`） | `core::extract::contract_info` | `thin_adapter` | 返回 ABI/版本/kind/language 表；contract gate 依赖 |
| 2 | `grammar_info`（`lib.rs:122`） | `core::extract::grammar_info` | `thin_adapter` | grammar-source-parity 钩子 |
| 3 | `cfnptr_scan_files`（`lib.rs:198`） | `core::extract::cfnptr::scan_files` | `optional_keep_napi` | 不在 52 基线；JS 无消费者 |
| 4 | `cfnptr_strip_c`（`lib.rs:243`） | `core::extract::cfnptr::strip_c` | `optional_keep_napi` | 不在 52 基线；差分 oracle |
| 5 | `extract_file`（`lib.rs:248`） | `core::extract::extract_file` | `thin_adapter` | 主提取入口；defer 语义由 core 抛 `defer:` |

### 3.2 store（9）

TS 绑定：`StoreModule`（`packages/chimera/src/graph/store/loader.ts:77-91`）。

| # | Rust fn（file:line） | future core entry | NAPI disposition | 备注 |
|---:|---|---|---|---|
| 6 | `store_contract_info`（`store.rs:1381`） | `core::store::contract_info` | `thin_adapter` | ABI 1；kind 表 subset gate |
| 7 | `store_open`（`store.rs:1396`） | `core::store::open` | `thin_adapter` | 拒绝未初始化 schema；不建表 |
| 8 | `store_insert_nodes`（`store.rs:1479`） | `core::store::insert_nodes` | `thin_adapter` | 单事务；返回插入数 |
| 9 | `store_insert_edges`（`store.rs:1485`） | `core::store::insert_edges` | `thin_adapter` | dangling 过滤 |
| 10 | `store_insert_refs`（`store.rs:1491`） | `core::store::insert_refs` | `thin_adapter` | 独立 ref 批量；FK 失败语义保留 |
| 11 | `store_delete_file`（`store.rs:1497`） | `core::store::delete_file` | `thin_adapter` | 普通级联删除（非 resurrect） |
| 12 | `store_commit_batch`（`store.rs:1502`） | `core::store::commit_batch` | `thin_adapter` | 一次边界、单事务；返回 `StoreWriteStats` |
| 13 | `store_close`（`store.rs:1520`） | `core::store::close` | `thin_adapter` | 确定性释放；幂等错误语义 |
| 14 | `store_set_wal_autocheckpoint`（`store.rs:1536`） | `core::store::set_wal_autocheckpoint` | `thin_adapter` | WAL deferral 镜像 |

### 3.3 ctx（21）

TS 绑定：`CtxModule`（`packages/chimera/src/graph/store/loader.ts:263-285`）。

| # | Rust fn（file:line） | future core entry | NAPI disposition | 备注 |
|---:|---|---|---|---|
| 15 | `ctx_contract_info`（`resolver_ctx.rs:1410`） | `core::ctx::contract_info` | `thin_adapter` | ctx ABI 1；routed getter 能力表 |
| 16 | `ctx_open`（`resolver_ctx.rs:1457`） | `core::ctx::open` | `thin_adapter` | 借用 store handle 的 db path + commit generation |
| 17 | `ctx_warm`（`resolver_ctx.rs:1466`） | `core::ctx::warm` | `thin_adapter` | 预热缓存 |
| 18 | `ctx_invalidate`（`resolver_ctx.rs:1476`） | `core::ctx::invalidate` | `thin_adapter` | TS 写路径通知 |
| 19 | `ctx_close`（`resolver_ctx.rs:1487`） | `core::ctx::close` | `thin_adapter` | 确定性释放 |
| 20 | `ctx_get_project_root`（`resolver_ctx.rs:1497`） | `core::ctx::project_root` | `retire_after_parity` | `CTX_ROUTED_GETTERS` 不含它；TS 用构造串 |
| 21 | `ctx_get_nodes_by_names`（`resolver_ctx.rs:1648`） | `core::ctx::nodes_by_names` | `thin_adapter` | 路由 getter |
| 22 | `ctx_get_nodes_by_qualified_names`（`resolver_ctx.rs:1655`） | `core::ctx::nodes_by_qualified_names` | `thin_adapter` | 路由 getter |
| 23 | `ctx_get_nodes_by_lower_names`（`resolver_ctx.rs:1662`） | `core::ctx::nodes_by_lower_names` | `thin_adapter` | 路由 getter |
| 24 | `ctx_get_nodes_in_files`（`resolver_ctx.rs:1668`） | `core::ctx::nodes_in_files` | `thin_adapter` | 路由 getter |
| 25 | `ctx_get_nodes_by_kind`（`resolver_ctx.rs:1675`） | `core::ctx::nodes_by_kind` | `thin_adapter` | 路由 getter |
| 26 | `ctx_get_node_by_id`（`resolver_ctx.rs:1682`） | `core::ctx::node_by_id` | `thin_adapter` | 路由 getter |
| 27 | `ctx_has_names`（`resolver_ctx.rs:1691`） | `core::ctx::has_names` | `thin_adapter` | 路由 getter |
| 28 | `ctx_get_all_files`（`resolver_ctx.rs:1697`） | `core::ctx::all_files` | `thin_adapter` | 路由 getter |
| 29 | `ctx_get_all_node_names`（`resolver_ctx.rs:1703`） | `core::ctx::all_node_names` | `thin_adapter` | 路由 getter |
| 30 | `ctx_read_files`（`resolver_ctx.rs:1711`） | `core::ctx::read_files` | `thin_adapter` | 路由 getter；lossy UTF-8 语义 |
| 31 | `ctx_get_file_lines`（`resolver_ctx.rs:1718`） | `core::ctx::file_lines` | `thin_adapter` | 路由 getter |
| 32 | `ctx_file_exists`（`resolver_ctx.rs:1725`） | `core::ctx::file_exists` | `thin_adapter` | 路由 getter |
| 33 | `ctx_list_directories`（`resolver_ctx.rs:1733`） | `core::ctx::list_directories` | `thin_adapter` | 路由 getter |
| 34 | `ctx_get_import_mappings`（`resolver_ctx.rs:1742`） | `core::ctx::import_mappings` | `thin_adapter` | 路由 getter |
| 35 | `ctx_get_re_exports`（`resolver_ctx.rs:1748`） | `core::ctx::re_exports` | `thin_adapter` | 路由 getter |

### 3.4 resolve（4）

TS 绑定：`ResolveModule`（`packages/chimera/src/graph/store/loader.ts:409-414`）。

| # | Rust fn（file:line） | future core entry | NAPI disposition | 备注 |
|---:|---|---|---|---|
| 36 | `resolve_contract_info`（`resolver.rs:6852`） | `core::resolve::contract_info` | `thin_adapter` | ABI 1；31 策略 + rank 表 |
| 37 | `resolve_open`（`resolver.rs:6920`） | `core::resolve::open` | `thin_adapter` | 借用 ctx handle |
| 38 | `resolve_close`（`resolver.rs:6934`） | `core::resolve::close` | `thin_adapter` | 先于 ctx_close（配对纪律） |
| 39 | `resolve_batch`（`resolver.rs:6966`） | `core::resolve::batch` | `thin_adapter` | 一次边界返回 persist plan |

### 3.5 sqlite_bridge（15，storage 域）

TS 绑定：`SqliteBridgeModule`（`packages/chimera/src/storage/db-bridge.ts:51-77`）。

| # | Rust fn（file:line） | future core entry | NAPI disposition | 备注 |
|---:|---|---|---|---|
| 40 | `sqlite_bridge_contract_info`（`sqlite_bridge.rs:553`） | —（storage 域） | `keep_napi` | 不归 graph core |
| 41 | `sqlite_bridge_open`（`sqlite_bridge.rs:596`） | — | `keep_napi` | 由 WP-05 决定终态 |
| 42 | `sqlite_bridge_exec`（`sqlite_bridge.rs:603`） | — | `keep_napi` | 同上 |
| 43 | `sqlite_bridge_run`（`sqlite_bridge.rs:783`） | — | `keep_napi` | 同上 |
| 44 | `sqlite_bridge_get`（`sqlite_bridge.rs:797`） | — | `keep_napi` | 同上 |
| 45 | `sqlite_bridge_all`（`sqlite_bridge.rs:819`） | — | `keep_napi` | 同上 |
| 46 | `sqlite_bridge_values`（`sqlite_bridge.rs:848`） | — | `keep_napi` | 同上 |
| 47 | `sqlite_bridge_all_packed`（`sqlite_bridge.rs:975`） | — | `keep_napi` | 可选 packed 读 |
| 48 | `sqlite_bridge_values_packed`（`sqlite_bridge.rs:990`） | — | `keep_napi` | 可选 packed 读 |
| 49 | `sqlite_bridge_transaction_begin`（`sqlite_bridge.rs:1006`） | — | `keep_napi` | 同上 |
| 50 | `sqlite_bridge_transaction_commit`（`sqlite_bridge.rs:1011`） | — | `keep_napi` | 同上 |
| 51 | `sqlite_bridge_transaction_rollback`（`sqlite_bridge.rs:1016`） | — | `keep_napi` | 同上 |
| 52 | `sqlite_bridge_in_transaction`（`sqlite_bridge.rs:1022`） | — | `keep_napi` | 同上 |
| 53 | `sqlite_bridge_pragma`（`sqlite_bridge.rs:1030`） | — | `keep_napi` | 同上 |
| 54 | `sqlite_bridge_close`（`sqlite_bridge.rs:1046`） | — | `keep_napi` | 同上 |

### 3.6 句柄类（不计入 54）

| 类（file:line） | core 对应 | 处理 |
|---|---|---|
| `StoreHandle`（`store.rs:1346`） | `core::store::Handle` | adapter 包一层；close/poison 语义在 core |
| `CtxHandle`（`resolver_ctx.rs:1378`） | `core::ctx::Handle` | 同上 |
| `ResolveHandle`（`resolver.rs:6851`） | `core::resolve::Handle` | 同上 |
| `SqliteBridgeHandle`（`sqlite_bridge.rs:565`） | —（storage 域） | 保留 NAPI |

---

## 4. core 模块边界与接口草案

### 4.1 `wire`

- 常量：`KERNEL_ABI_VERSION = 2`、`STORE_ABI_VERSION = 1`、`CTX_ABI_VERSION = 1`、`RESOLVE_ABI_VERSION = 1`；行宽 `NODE_ROW_SIZE` / `EDGE_ROW_SIZE` / `REF_ROW_SIZE` / `STORE_*_ROW_SIZE`。
- 类型：`WireError`、`RawBufs<'a>`、`StoreBuffersIn/Out`、`ResolveBuffersIn/Out`、`Ctx*Out`。
- 约束：与 TS 侧 `layout.ts` / `store/layout.ts` / `resolve-encode.ts` 逐字节一致；改布局必须同时 bump ABI。

### 4.2 `extract`

```rust
pub fn contract_info() -> ContractInfo;
pub fn grammar_info(language: &str) -> Option<GrammarInfo>;
pub fn extract_file(file_path: &str, content: &str, language: &str) -> Result<ExtractBuffers, CoreError>;
pub fn cfnptr_scan_files(files: &[CfnptrFileIn]) -> Vec<CfnptrFacts>; // optional
pub fn cfnptr_strip_c(text: &str) -> String;                           // differential
```

- `defer:` 仍是 core 的 `CoreError { code: "defer" }`；adapter 保留 message 前缀，TS 的 `message.includes('defer:')` 判定不变。
- walker 调度与 `stack::run_guarded` 原样迁入；grammar 版本 pin 不变。

### 4.3 `store`

```rust
pub struct Handle { /* Mutex<StoreConn>, poisoned */ }
pub fn open(db_path: &str) -> Result<Handle, CoreError>;
pub fn insert_nodes(h: &Handle, batch: &[u8; 5]) -> Result<u32, CoreError>;
pub fn commit_batch(h: &Handle, ops: &[u8; 5]) -> Result<StoreWriteStats, CoreError>;
pub fn close(h: Handle) -> Result<(), CoreError>;
```

- `StoreWriteStats` 字段名与顺序保持现有 camelCase 投影（adapter 负责）。
- 事务边界、`BEGIN IMMEDIATE`、WAL watermark、FK 语义不变。

### 4.4 `ctx`

```rust
pub struct Handle { /* store handle borrow + caches */ }
pub fn open(store: &store::Handle, project_root: &str) -> Result<Handle, CoreError>;
pub fn nodes_by_names(h: &Handle, names: &[String]) -> Result<NodesOut, CoreError>;
// ... 其余 routed getter
```

- `CTX_ROUTED_GETTERS` 的 15 项是 core 必须实现的最小面；4 个 absent getter 继续 TS。
- `read_files` 的 lossy UTF-8 语义必须与 Node `readFileSync(..., 'utf8')` 对齐（`resolver_ctx.rs:117`）。

### 4.5 `resolve`

```rust
pub struct Handle { /* Resolver + ctx borrow */ }
pub fn open(ctx: &ctx::Handle) -> Result<Handle, CoreError>;
pub fn batch(h: &Handle, input: &[u8; 4]) -> Result<ResolveOut, CoreError>;
```

- 31 策略 manifest 与 `RESOLVER_RANK` 由 `contract_info` 报告，TS loader 继续做双向 subset/equality gate。
- `resolve_batch` 的输出是 persist plan（edges/refs/files/stats/arena），core 不直接写库。

### 4.6 `query` / `traverse` / `pattern`（新建，建议）

- `query`：`search(query, options) -> SearchResult[]`；FTS5/LIKE/fuzzy 的候选集与打分可留在 SQLite/TS，core 只负责稳定排序/过滤/路径评分。
- `traverse`：`bfs/dfs/callers/callees/impact/path`；输入是图快照/邻接查询接口，输出是 `Subgraph`。
- `pattern`：若 core 化，接口为 `compile(pattern, language)` / `find_matches(tree, source)`；range 一律 UTF-16 code unit，内部字节偏移在边界转换。

---

## 5. NAPI 保留/退役矩阵

| 面 | 过渡期 NAPI | 退役条件 | 退役后 TS 路径 |
|---|---|---|---|
| extraction | 5（含 2 optional） | core 与 wasm 双臂 parity 通过 + host 直连 core | wasm fallback 保留到 wasm 退役 |
| store | 9 | WP-05 写者切换完成 + TS 只读兼容 | TS QueryBuilder 只读 |
| ctx | 21（1 个可先退役） | resolve 全部走 core + TS 不再需要 read-context | TS `ResolutionContext` 直读 SQLite |
| resolve | 4 | 同上 | TS 策略树保留为 oracle/fallback |
| sqlite_bridge | 15 | storage 域另行决定 | 不归本包 |
| query/traversal/pattern | 0（当前无 NAPI） | 若新增 core，可加 optional NAPI 供 parity harness | TS 保留为 oracle |

**kill switch 保留**：`CODEGRAPH_KERNEL`、`CODEGRAPH_STORE`、`CODEGRAPH_CTX`、`CODEGRAPH_RESOLVE` 的现有语义不变；core 不读 env，由 adapter/宿主检查。

---

## 6. 迁移顺序与门禁（建议）

| 阶段 | 内容 | 门禁 |
|---|---|---|
| R0 | `wire` + contract info 抽到 core；NAPI adapter 仍返回原字节 | 所有 `*_contract_info` 字段与 HEAD 逐字段相等 |
| R1 | `store` 抽 core；NAPI 薄适配 | store golden/negative fixture 零 diff；TS fallback 可一键切回 |
| R2 | `ctx` 抽 core | 15 routed getter 逐项 parity；4 absent getter 仍走 TS |
| R3 | `resolve` 抽 core | 31 策略 + rank 表相等；resolve golden 零 diff；TS 策略树保留 |
| R4 | `extraction` 抽 core | kernel/wasm 双臂零 diff；`defer:` 语义不变；grammar pin 不变 |
| R5 | `query` / `traversal` 新建 core | 以 TS 为 oracle 的 fixture 零 diff；排序/limit/深度语义逐项 |
| R6 | `pattern`（若拍板） | ast-grep 端口 conformance + UTF-16 fixture 零 diff |

**每阶段共同门禁**：`bun typecheck` + 既有 graph 测试不新增失败 + 本包 fixture 对账 + kill switch 回退演练 + 单写者不破坏（`codegraph.lock` / `writer.pid`）。

---

## 7. 建议（未拍板）

- **S1**：先做 R0–R3（有 NAPI 基线、风险最低），再评估 R4；query/traversal/pattern 不与 store/resolve 同批。
- **S2**：`sqlite_bridge` 明确划归 storage 域，graph core 不引用它；避免 graph 包承担 storage 写者切换责任。
- **S3**：core 的错误码表先固化为 `CoreErrorCode` 枚举（`closed` / `poisoned` / `wire` / `sql` / `defer` / `unsupported` / `not_found`），adapter 只做字符串映射。
- **S4**：NAPI 退役至少保留一个发布周期（计划 §10 的写回退纪律同样适用于读面）。

## 8. 待拍板

- **D-A**：core crate 名称/路径/workspace 归属。
- **D-B**：`query`/`traversal`/`pattern` 是否进 core；若不进，host 侧是否允许直接 SQL。
- **D-C**：`pattern` 是否接受原生 tree-sitter 的语义差异，还是长期保留 WASM/TS。
- **D-D**：store 线程模型（主线程 vs 专用 worker）与 host 写连接所有权。
- **D-E**：`sqlite_bridge` 的终态归属（storage 域 vs 独立 crate）。
- **D-F**：NAPI 退役节奏是否与 WP-05 写者切换共用同一个发布窗口。