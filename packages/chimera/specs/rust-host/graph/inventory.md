# Graph 资产清点（WP-06）

> 状态：**draft for review**（WP-06 交付；不实现生产 core）
> contract_rev：`cr-2026-10-30-r1`
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §8（WP-06）/§9（manifest 纪律）/§10（统一门禁）；`packages/chimera/specs/rust-host/{manifest.yaml,partition-table.md,a0-scope-decisions.md}`。
> 基线：commit `9600ee7f49ddcb065a33511f21f570d2b2d13a19`（工作树含本批新增文件）
> 取证方式：只读代码/规格检查 + 现有 TS 引擎的隔离执行（用于派生 fixture，不修改生产代码）
> 范围：extraction / store / resolution / query / traversal / pattern 六面；不覆盖 HTTP/UI、session runtime、provider。

---

## 0. 结论摘要

1. **kernel 已接管四面**：`codegraph-kernel`（NAPI cdylib）覆盖 extraction、store、resolution read-context（ctx）、resolution batch（resolve）；四个 bridge 默认 ON，均可通过 `CODEGRAPH_*` kill switch 回 TS。
2. **query / traversal / pattern 仍纯 TS**：没有对应 NAPI 导出；`GraphQueryManager`、`GraphTraverser`、ast-grep 端口全部在 Bun 进程内运行。
3. **规模基线**：kernel 报 23 种语言（`langs.rs:49-53`），TS 路由默认 22 种（`kernel/index.ts:164-233`；`r` 未路由）；图契约 24 个 node kind、13 个 edge kind（`types.ts:18-49`、`types.ts:56-69`）；检测语言 42 种（`types.ts:507-551`）。
4. **NAPI 面**：HEAD 实测 54 个 `#[napi] pub fn` + 4 个 `#[napi]` 句柄类；计划 §3 的 “52 napi 函数” 基线 = 54 减去两个 cfnptr 差分/调试钩子（详见 `core-napi-split.md` §1）。
5. **存储**：图库位于 `<project>/.chimera/codegraph.db`（legacy `.codegraph/` 兼容），schema 9 张表 + FTS5（`db/schema.sql:5-221`）；写路径由 `codegraph.lock`（跨进程）+ `writer.pid`（单 MCP writer）双层约束。
6. **三个已知坑**已单独成文：UTF-8/UTF-16 偏移、pattern/search/framework fallback、daemon writer 归属（`known-pitfalls.md`）。

---

## 1. 六面总表

| 面 | 关键源码入口（file:line） | 现状 | 已有 Rust 资产 | 迁移目标（建议，未拍板） |
|---|---|---|---|---|
| extraction | `extraction/index.ts:800,827,1001`；`extract-from-source.ts:41`；`tree-sitter.ts:632,734`；`extraction/kernel/index.ts:164,508` | 双arm：22 语言走 native kernel，其余/ defer 走 wasm；语义版本 10 | `codegraph-kernel/src/lib.rs:248`（`extract_file`）+ 各语言 walker | core `extract` rlib；NAPI 薄适配保留 |
| store | `db/index.ts:138,163,246`；`db/queries.ts:340`；`store/bridge.ts:346,491`；`store/encoder.ts:75` | TS QueryBuilder + native batch commit（默认 ON）；WAL valve；单写者 | `codegraph-kernel/src/store.rs:1381-1536` | core `store` rlib；NAPI 薄适配保留 |
| resolution | `resolution/index.ts:161,635,920,1203,1655`；`resolution/ctx-bridge.ts:57`；`resolution/resolve-bridge.ts:397` | TS 策略树 + native ctx/resolve 两段桥；25 个 framework resolver | `resolver_ctx.rs:1410-1748`、`resolver.rs:6852-6966` | core `ctx` + `resolve` rlib；framework 暂留 TS |
| query | `graph/queries.ts:27`；`db/queries.ts:1483`；`search/query-parser.ts:66`；`search/query-utils.ts:218,362,407` | 纯 TS：FTS5 → LIKE → fuzzy → exact-name 补强；TS 后置打分 | 无 | core `query`（建议）；或 host 侧 SQL + TS 保留 |
| traversal | `graph/traversal.ts:34,48,154,278,338,392,539,640`；`index.ts:3068-3181` | 纯 TS：BFS/DFS、callers/callees、impact、path；含深度重扩张语义 | 无 | core `traverse`（建议）；先以 TS 为 oracle |
| pattern | `pattern/index.ts:1-96`；`pattern/pattern.ts:237,371`；`pattern/match-tree.ts:181`；`pattern/replacer.ts:41` | 纯 TS ast-grep 端口，跑在 web-tree-sitter WASM 上；语言子集 | 无 | 保留 WASM/TS，或 core `pattern` + 原生 tree-sitter（待拍板） |

---

## 2. 分面清点

### 2.1 extraction

**管线（当前 TS 进程内）**

1. 文件发现：`scanDirectory` / `scanDirectoryAsync`（`extraction/index.ts:800,827`）→ gitignore / 忽略规则（`:473` `buildDefaultIgnore`）。
2. 语言与 grammar 预加载：`preloadLanguagesForFiles`（`:500`）→ `loadGrammarsForLanguages`（`extraction/grammars.ts:571`）；kernel 已路由语言会从 wasm 预加载集合中剔除（`kernel/index.ts:328` `filterKernelRoutedLanguages`）。
3. 批量编排：`ExtractionOrchestrator`（`extraction/index.ts:1001`）驱动 `ParseWorkerPool`（`parse-pool.ts:200`）/ `parse-worker.ts:61-106`；纯 kernel 语言集合可在主线程直通（`kernel/index.ts:346` `isKernelOnlyLanguageSet`）。
4. 单文件提取：`extractFromSource`（`extract-from-source.ts:41`）先试 `tryKernelExtract`（`kernel/index.ts:508`），返回 null 再走 `TreeSitterExtractor.extract`（`tree-sitter.ts:734`）。
5. 路由表：`DEFAULT_ROUTED`（`kernel/index.ts:164-233`）当前 22 项；`isRouted`（`:286`）支持 `CODEGRAPH_KERNEL_LANGS` 覆盖；`kernelRoutes`（`:297`）= 路由表 ∧ `kernelSupports`。
6. 失败/defer：kernel 抛 `defer:`（解析错误/栈保护）时写入一槽 defer memo（`kernel/index.ts:476-499`）；调用方经 `deferred-grammar.ts:38-68` 懒加载该语言 wasm grammar 后重放 wasm 臂。
7. 解码与后处理：`kernel/decode.ts` 按 kernel 自己的 wire tables 解码（`kernel/index.ts:461-470`）；TS 后置 pass（`kernel/index.ts:260-284`，当前仅 interface member 排序）。
8. framework extract hook：`frameworkExtractLanguages`（`extraction/index.ts:521-540`）把 framework 的 `extract()` 语言并入 worker pool 决策。

**现状要点**

- kernel 支持 23 语言（`langs.rs:49-53`），默认路由 22（`r` 仍 wasm）；`objc` 的 wasm 仍来自 npm `tree-sitter-wasms`，kernel arm 已建立（`extraction/wasm/MANIFEST.md` 末尾说明）。
- 每文件安全阀：parse-error / 深嵌套栈保护 → `defer:` → wasm（`kernel/index.ts:158-162,484-491`）；C/C++ 的 defer 带 10–40% 政策带（`:301-310`）。
- 提取语义版本 `EXTRACTION_SEMANTICS_VERSION = 10`（`db/extraction-version.ts:119`）；kernel wire ABI `KERNEL_ABI_VERSION = 2`（`extraction/kernel/layout.ts:28`）。
- 节点身份：`generateNodeId` 为 `kind:sha256(filePath:kind:name:line)[0..32]`；同 id 不同 UTF-16 列时追加 `:<column>`（`tree-sitter-helpers.ts:34-49`、`codegraph-kernel/src/ids.rs:5-44`）。

**主要缺口**

- `defer:` 仍依赖 wasm 错误恢复（H2 §5 已登记 wasm 退役前置）。
- `r` 未路由；`objc` wasm 尚未 vendored 到本地目录。
- 提取结果到 store 的“raw buffers 直通”尚未接线（`kernel/index.ts:422-428` 注释：fork 的 `ExtractionResult` 还没有 `kernelBuffers` 字段）。

### 2.2 store

**入口与层次**

- schema：`db/schema.sql:5-221`；核心表 `nodes` / `edges` / `files` / `file_semantics` / `unresolved_refs` / `name_segment_vocab`，FTS5 虚表 `nodes_fts`（`:144`），`synthesis_inputs`、`project_metadata`、`schema_versions`。
- 连接：`DatabaseConnection`（`db/index.ts:138`），`initialize`（`:162`）创建 schema，`open`（`:246`）要求文件存在并跑迁移；`configureConnection`（`:109-130`）设置 `busy_timeout` / `foreign_keys` / `journal_mode=WAL` / `synchronous=NORMAL` / `journal_size_limit`；readOnly 只设 `query_only=ON`（`:114-116`）。
- 查询/写入门面：`QueryBuilder`（`db/queries.ts:340`）；节点写入 `insertNodes`（`:686`）、边 `insertEdges`（`:2185`）、ref `insertUnresolvedRefsBatch`（`:2619`）、文件 `upsertFile`（`:2344`）。
- native 批量：`StoreBridge`（`store/bridge.ts:346`）在 `StoreBridge.open`（`:380`）通过 contract gate 后接管 batch commit；`commit`（`:491`）把 `RecordedOp[]` 编码成 wire buffers；`StoreBuffersBuilder`（`store/encoder.ts:75`）；wire layout `STORE_ABI_VERSION = 1`、`STORE_NODE_ROW_SIZE = 140` 等（`store/layout.ts:21-31`）。
- 单写者：`FileLock`（`utils.ts:184`）以 `codegraph.lock` 序列化 `indexAll` / `sync` / `syncFiles`（`index.ts:1025,1502,1705,2036`）；`writer.pid` 约束长驻 MCP writer（`mcp/writer-lock.ts:75-190`）。
- WAL：`WalCheckpointValve`（`db/wal-valve.ts`）+ `storeSetWalAutocheckpoint` 镜像（`index.ts:1533-1541`）；readOnly 打开不修复目录、不跑 sync（`index.ts:1269,1306-1315`）。

**现状要点**

- native store 默认 ON；每个未覆盖写操作有 TS replay fallback（`store/bridge.ts:6-35` 的 op 形态说明）。
- store bridge 调用是同步的，v1 允许主线程调用；迁 worker 是记录在案的后续项（`store/loader.ts:25-30`）。
- `store_open` 拒绝未初始化 schema（`store.rs:1390-1396` 注释），schema/migrator 仍由 TS 唯一拥有。

### 2.3 resolution

**入口与层次**

- `ReferenceResolver`（`resolution/index.ts:161`）；`initialize`（`:285`）检测 framework；`resolveAll`（`:635`）串行策略树；`resolveOne`（`:920`）/`resolveOneCore`（`:937`）；`createEdges`（`:1203`）；`resolveAndPersist`（`:1395`）；`resolveAndPersistBatched`（`:1655`）优先走 native `resolve_batch`，失败按批回 TS；`refreshSynthesis`（`:1879`）。
- 策略表：31 项 `RESOLVE_TS_STRATEGY_TABLE`（`store/loader.ts:423-455`）；rank 表 `RESOLVE_EXPECTED_RANK`（`:459-468`，import 6 > qualified-name 5 > exact-match/function-ref 4 > instance-method 3 > file-path 2 > framework 1 > fuzzy 0）。
- native read context：`CtxBridge`（`resolution/ctx-bridge.ts:57`）包装 15 个 routed getter（`store/loader.ts:296-312`）；4 个 getter 明确保留 TS（`getProjectAliases` / `getGoModule` / `getCppIncludeDirs` / `resolveImport`，`:288-295`）。
- native batch：`ResolveBridge`（`resolution/resolve-bridge.ts:397`）；wire 编解码 `resolve-encode.ts` / `ctx-decode.ts`。
- framework：25 个 resolver 注册在 `frameworks/index.ts:34-75`；`detectFrameworks`（`:94`）、`getApplicableFrameworks`（`:108`）；resolver 接口 `detect` / `resolve` / 可选 `extract`（`resolution/types.ts:186-211`）。
- import 解析：`resolveImportPath`（`import-resolver.ts:42`）、`resolveViaImport`（`:985`）；同文件 `matchReference`（`name-matcher.ts`，3822 行）。

**现状要点**

- native ctx/resolve 默认 ON；任一 native 失败按调用回 TS（`ctx-bridge.ts:52-124`、`resolve-bridge.ts:83-129`）。
- `resolve_batch` 是“一次边界完成 resolveOne + createEdges + file-level import sweep”的 persist plan（`resolver.rs` 模块注释与 `resolve_batch` 签名）。
- framework 结果 rank 1，低于 import/qualified/exact；`gateFrameworkLanguage` 对 calls 放行、对跨代码族引用做边界校验（`resolution/index.ts:971-1005`）。

### 2.4 query

**入口与层次**

- `GraphQueryManager`（`graph/queries.ts:27`）：`getContext`（`:45`）、`getDependencyFilePaths`（`:143`）、`getFileDependencies`（`:155`）、`getDependentFilePaths`（`:159`）、`getExportedSymbols`（`:181`）、`findByQualifiedName`（`:192`）、`getModuleStructure`（`:234`）、`findCircularDependencies`（`:256`）、`getNodeMetrics`（`:302`）、`findDeadCode`（`:335`）、`getFilteredSubgraph`（`:368`）。
- `CodeGraph` 门面：`searchNodes`（`index.ts:2813`）、`searchNodesDetailed`（`:2826`）、`getExploreMissDiagnostics`（`:2818`）、`getTopRouteFile`（`:2838`）、`getRoutingManifest`（`:2848`）。
- 搜索实现：`QueryBuilder.searchNodesDetailed`（`db/queries.ts:1483`）；FTS5 前缀（`:1732`）→ LIKE 子串（`:1900`）→ fuzzy 编辑距离（`:1666`）→ exact-name 补强（`:1548-1600`）；查询解析 `parseQuery`（`search/query-parser.ts:66`）；打分 `scorePathRelevance`（`search/query-utils.ts:218`）、`nameMatchBonus`（`:362`）、`kindBonus`（`:407`）。

**现状要点**

- 纯 TS；没有 query NAPI。FTS5 依赖 SQLite 编译选项；LIKE/fuzzy 是 TS 侧回退链。
- `searchNodes` 的 `LIMIT`/offset、per-term FTS count、candidate pool 语义是 oracle 的一部分（`db/queries.ts:240-260` 注释）。
- `findByQualifiedName` 当前对 kind 列表做全表扫描 + JS regex（`graph/queries.ts:192-225`），是已知低效点。

### 2.5 traversal

**入口与层次**

- `GraphTraverser`（`graph/traversal.ts:34`）：`traverseBFS`（`:48`）、`traverseDFS`（`:154`）、`getCallers`（`:278`）、`getCallees`（`:338`）、`getCallGraph`（`:392`）、`getTypeHierarchy`（`:431`）、`findUsages`（`:513`）、`getImpactRadius`（`:539`）、`findPath`（`:640`）、`getAncestors`（`:710`）、`getChildren`（`:748`）。
- `CodeGraph` 门面：`traverse`（`index.ts:3068`）、`getCallGraph`（`:3082`）、`getTypeHierarchy`（`:3095`）、`findUsages`（`:3108`）、`getCallers`（`:3119`）、`getCallees`（`:3130`）、`getImpactRadius`（`:3143`）、`findPath`（`:3155`）、`getAncestors`（`:3169`）、`getChildren`（`:3179`）。

**现状要点**

- 纯 TS；没有 traversal NAPI。
- 语义细节（迁移必须逐项保留）：BFS 邻接边按 `contains`→`calls`→其他 排序（`traversal.ts:96-99`）；enqueue-once 防并行边丢失（`:59-72`）；`limit` 按 add 检查防超限（`:118-126`）；`getCallers`/`getCallees` 使用“最浅展开深度”重扩张（`:287-329`、`:347-383`）；callers/callees 边集合包含 `calls/references/imports/instantiates/navigates`（`:312`、`:367`）。

### 2.6 pattern

**入口与层次**

- 模块入口与移植决策：`pattern/index.ts:1-96`（ast-grep @ `6f59168`，MIT；纯函数、无 Effect、无 top-level await）。
- 编译/匹配：`ensureGrammarLoaded`（`pattern/pattern.ts:209`）、`parseSource`（`:226`）、`compilePattern`（`:237`）、`findMatches`（`:371`）、`findMatchesInTree`（`:382`）、`findFirstMatch`（`:401`）。
- 匹配树：`matchNodeImpl`（`pattern/match-tree.ts:181`）、`matchEndNonRecursive`（`:367`）、strictness（`pattern/strictness.ts`）。
- 元变量：`extractMetaVar`（`pattern/meta-var.ts:40`）、`MetaVarEnv`（`:136`）、`preprocessPattern`（`:115`）。
- 替换：`editForMatch`（`pattern/replacer.ts:33`）、`applyReplacements`（`:41`）、`renderTemplateReplacement`（`:179`）、`renderStructuralReplacement`（`:219`）。
- 工具接线：`ast_edit` 的 `runPatternMode`（`src/tool/ast_edit.ts:1326`）→ `compilePattern`（`:1363`）→ `findMatchesInTree`（`:1369`）。

**现状要点**

- 纯 TS，跑在 **web-tree-sitter WASM** 上；`ensureGrammarLoaded` 走 `extraction/grammars.ts` 的 wasm 加载器（`pattern.ts:209-235`），与 kernel 的 native 提取是两条独立解析路径。
- 语言子集：typescript/tsx/javascript/python 有 conformant 测试；其他语言要求存在 Chimera WASM grammar 且在 expando 表内（`pattern/index.ts:49-51`）。
- 明确未移植：relational operators、KindMatcher/contextual patterns/potential_kinds、`transform:` 元变量管线、ast-grep streaming fixer（`pattern/index.ts:43-48`）；parse-error pattern 在编译期拒绝（`pattern/pattern.ts:279-288` 的 `containsErrorKind` 检查，helper `:185-189`）。
- 所有 range 是 **UTF-16 code-unit 索引**（`pattern/index.ts:29-37`、`pattern/pattern.ts:12-16`、`replacer.ts:25`）。

---

## 3. 资产规模与版本（2026-10-30 实测）

| 项 | 值 | 证据 |
|---|---|---|
| kernel 支持语言 | 23 | `codegraph-kernel/src/langs.rs:49-53` |
| TS 默认路由语言 | 22（`r` 未路由） | `extraction/kernel/index.ts:164-233` |
| node kind | 24 | `src/graph/types.ts:18-49` |
| edge kind | 13 | `src/graph/types.ts:56-69` |
| 检测语言 | 42 | `src/graph/types.ts:507-551` |
| extraction ABI | `KERNEL_ABI_VERSION = 2` | `extraction/kernel/layout.ts:28` |
| store ABI | `STORE_ABI_VERSION = 1` | `store/layout.ts:21` |
| ctx ABI | `CTX_ABI_VERSION = 1` | `store/loader.ts:223` |
| resolve ABI | `RESOLVE_ABI_VERSION = 1` | `store/loader.ts:393` |
| 提取语义版本 | 10 | `db/extraction-version.ts:119` |
| NAPI 函数（`#[napi] pub fn`） | 54（52 产品面 + 2 cfnptr 钩子） | `codegraph-kernel/src/{lib,store,resolver,resolver_ctx,sqlite_bridge}.rs` |
| NAPI 句柄类 | 4 | `StoreHandle` / `CtxHandle` / `ResolveHandle` / `SqliteBridgeHandle` |
| graph schema 表 | 9 + FTS5 | `db/schema.sql:5-221` |
| framework resolver | 25 | `resolution/frameworks/index.ts:34-75` |
| resolve 策略 | 31 | `store/loader.ts:423-455` |

---

## 4. 迁移面归属（建议，未拍板）

| 面 | 建议终态 | 理由 | 风险 |
|---|---|---|---|
| extraction | `chimera-graph-core` rlib 的 `extract` 模块；NAPI 只做薄适配 | kernel walker 已是纯 Rust，cdylib 不应被 host 直接吸收 | grammar 版本/ABI 必须与 wasm 对齐；defer 语义要保留 |
| store | core `store` 模块；host 直接持有写连接 | 单写者 + WAL 需要 host 级所有权 | TS fallback 周期内双写风险；必须 fencing |
| resolution | core `ctx` + `resolve` 模块 | 已有完整 NAPI 面，拆层成本最低 | framework 策略仍 TS；rank 必须逐项一致 |
| query | core `query`（或 host SQL） | 目前纯 TS，移植收益中等 | FTS5/LIKE/fuzzy 打分是行为契约，不能“近似” |
| traversal | core `traverse` | 纯图算法，易 parity | 深度重扩张/边优先级/limit 语义必须逐项保留 |
| pattern | **建议先保留 WASM/TS**；是否 core 化待拍板 | ast-grep 语义复杂、语言子集小、WASM 是现有 oracle | 若 core 化需原生 tree-sitter + 字节→UTF-16 转换 |

---

## 5. 缺口清单（按迁移阻塞度）

1. **query/traversal/pattern 无 Rust core**：三面都是纯 TS，没有 NAPI 基线可复用。
2. **store bridge 主线程同步**：v1 允许主线程调用；迁 host 前必须决定 worker 线程模型（`store/loader.ts:25-30`）。
3. **ctx 四个 getter 永久 TS**：`getProjectAliases` / `getGoModule` / `getCppIncludeDirs` / `resolveImport`（`store/loader.ts:288-295`）；core 化时要显式保留 TS 臂或补 Rust 实现。
4. **framework 25 个 resolver 纯 TS**：detect/resolve/extract 都依赖 TS 上下文；core 迁移不能把它们当作“已覆盖”。
5. **pattern 只有 WASM 路径**：kernel 的 native 树不能直接喂给 web-tree-sitter 端口；需要单独设计。
6. **daemon writer 归属未定（D4）**：graph MCP daemon 目前是 TS 进程，持有 engine + watcher；host 接管 graph 写路径前必须先决定薄代理 vs 直接 Rust（见 `known-pitfalls.md` §3）。
7. **统一 parity harness 未建**：本包只给静态 fixture；执行/比较归 WP-02/WP-03。

---

## 6. 取证命令（只读，可复验）

```bash
# 面入口/行号
rg -n "export class|export function|async [a-zA-Z]+\(" packages/chimera/src/graph/{index.ts,extraction,store,resolution,graph,pattern}

# kernel 语言/路由
rg -n "LANGUAGES|DEFAULT_ROUTED|DEFER_ELIGIBLE_LANGUAGES" codegraph-kernel/src/langs.rs packages/chimera/src/graph/extraction/kernel/index.ts

# NAPI 面
rg -n "#\[napi\]" codegraph-kernel/src
rg -n "export interface (Kernel|Store|Ctx|Resolve)Module" packages/chimera/src/graph/{extraction/kernel,store}/loader.ts

# schema / 版本
rg -n "CREATE TABLE|CREATE VIRTUAL TABLE" packages/chimera/src/graph/db/schema.sql
rg -n "ABI_VERSION|SEMANTICS_VERSION" packages/chimera/src/graph/{store,extraction/kernel,db}/**/*.ts
```

本包未运行 `cargo build/test`，未修改 `codegraph-kernel/**`、`chimera-host/**`、`packages/chimera/src/**`。

---

## 7. 建议（未拍板）

- **S1**：core 拆层按 `extract → store → ctx → resolve → query → traverse → pattern` 顺序推进；前四面复用现有 NAPI 语义，后三面先以 TS 为 oracle 新建 core 模块。
- **S2**：`query` 的 FTS/LIKE/fuzzy 打分链建议整体保留在 SQLite/TS 侧，core 只接管“结构化查询计划 + 稳定排序”，避免在 Rust 里重写 BM25 打分。
- **S3**：`pattern` 在 wasm 退役前保持 WASM/TS；若必须 core 化，先做“原生 tree-sitter + UTF-16 投影”PoC，不直接照搬 ast-grep 的 byte 语义。
- **S4**：framework resolver 继续留在 TS 兼容边，直到 WP-09/控制面给出 JS 兼容拓扑。

## 8. 待拍板

- **D-A**：core crate 的正式名字与 workspace 归属（`chimera-graph-core` 仅为占位）。
- **D-B**：query/traversal/pattern 是进 core rlib，还是留在 host/TS；三面没有 NAPI 基线，选择影响迁移成本。
- **D-C**：pattern 是否保留 web-tree-sitter WASM 作为长期 oracle，还是接受原生 tree-sitter 的语义差异。
- **D-D**：store bridge 的线程模型（主线程 vs 专用 worker）与 host 接管后的写连接所有权。
- **D-E**：D4（graph MCP daemon 归属）与本文 §5.6 的 writer 切换时点绑定；未拍板前不得双写。