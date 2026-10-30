# Graph 迁移三个已知坑（WP-06）

> 状态：**draft for review**（逐项成文；不实现生产 core）
> contract_rev：`cr-2026-10-30-r1`
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §8（WP-06 三个已知坑）/§10（统一门禁）；`packages/chimera/specs/rust-host/{manifest.yaml,partition-table.md,a0-scope-decisions.md}`。
> 基线：commit `9600ee7f49ddcb065a33511f21f570d2b2d13a19`
> 关联：`inventory.md`、`core-napi-split.md`、`parity-fixtures.md`

本文把计划 §8 WP-06 点名的三个坑逐项展开：**UTF-8/UTF-16 偏移**、**pattern/search/framework fallback**、**daemon writer 归属**。每项给出证据、规则、迁移影响与验收向量。

---

## 1. UTF-8 / UTF-16 偏移

### 1.1 现状：三套坐标系并存

| 坐标系 | 使用位置 | 证据 |
|---|---|---|
| **UTF-16 code unit** | 图节点 `startColumn` / `endColumn`；pattern range；`ast_edit` splice；LSP 风格位置 | `extraction/tree-sitter-helpers.ts:43`（“Columns are zero-based UTF-16 code units in both wasm and the kernel”）；`codegraph-kernel/src/ids.rs:5,35`；`pattern/index.ts:29-37`；`pattern/pattern.ts:12-16`；`pattern/replacer.ts:25`；`pattern/indent.ts:9-10` |
| **UTF-8 byte** | kernel/store wire arena 的 `(offset,len)`；Rust 内部 `&str` 切片；`readFile` 的字节读取 | `extraction/kernel/layout.ts:6`（“strings are (offset, len) pairs into the UTF-8 arena”）；`store/layout.ts:7`；`store/encoder.ts:64-111`；`resolver_ctx.rs:117`（`readFile` lossy UTF-8） |
| **行号** | 图节点 `startLine` / `endLine`（1-based）；ref `line`（1-based） | `types.ts:301-304`；`extraction/kernel/layout.ts:50-56` |

### 1.2 关键事实

1. **kernel 的列不是 tree-sitter 的字节列**。`util::col16` 把 `byte_pos` 转成 UTF-16 列（`codegraph-kernel/src/textutil.rs:98-110`）；`NodeIdAllocator` 注释明确“Zero-based UTF-16 column (util::col16), never tree-sitter's byte column”（`ids.rs:35`）。
2. **wire 的字符串是 UTF-8 字节**。kernel 输出 arena 是 UTF-8；TS 解码按 `(offset,len)` 读字节（`extraction/kernel/layout.ts:6`、`store/encoder.ts:64-111`）。**不能**把 wire offset 直接当 JS `slice` 下标。
3. **pattern 端口是 UTF-16**。web-tree-sitter 的 `startIndex`/`endIndex` 是 UTF-16 code unit；端口所有 `PatternRange`/`PatternEdit` 都是 UTF-16，直接 `source.slice`（`pattern/index.ts:29-37`、`pattern/pattern.ts:12-16`、`pattern/replacer.ts:25`）。ast-grep 原版 Rust 用字节偏移，这是**有意的适配差异**。
4. **`ast_edit` 在边界做转换**。`nodeSpliceRange` 把图节点的 1-based line / 0-based UTF-16 column 转成当前文本的 splice range（`src/tool/ast_edit.ts:621-631`）；多行节点吸附到整行。
5. **`readFile` 是 lossy UTF-8**。Rust `resolver_ctx.rs` 的 `readFile` 用 `String::from_utf8_lossy`，无效字节变 U+FFFD，与 Node `readFileSync(..., 'utf8')` 对齐（`resolver_ctx.rs:117,932,1369,1446`）。这会改变字符串长度，进而影响列号/范围。

### 1.3 规则（迁移必须遵守）

| # | 规则 |
|---:|---|
| U1 | **图节点范围对外一律是 1-based line + 0-based UTF-16 column，end 为 exclusive**。core 不得把 Rust 字节列直接写进 `startColumn` / `endColumn`。 |
| U2 | **wire 字符串一律 UTF-8 `(offset,len)`**；只有 adapter/TS 解码层做字节→字符串转换。core 内部可以继续用字节偏移，但出 wire 前必须按 `line_starts` + `col16` 生成列。 |
| U3 | **pattern range 一律 UTF-16 code unit**；若 core 新增 pattern，必须在边界把字节偏移转成 UTF-16（astral 字符 1 字符 = 2 code units，UTF-8 4 字节）。 |
| U4 | **不要用 `str::len()` 当列号**；`str::len()` 是 UTF-8 字节数。用 `utf16_len` / `col16`（`textutil.rs:94-110`）。 |
| U5 | **lossy 解码必须双臂一致**：Node `readFileSync(...,'utf8')` 与 Rust `from_utf8_lossy` 的替换行为要逐字节对；无效字节会改变长度。 |
| U6 | **BOM/CRLF 不特殊处理**：BOM 本身是一个 UTF-16 code unit，会让后续 token 的列号偏移；是否剥离 BOM 必须双臂一致。CRLF 的 `\r` 和 `\n` 各占 1 个 UTF-16 code unit；行号由 tree-sitter 行边界给出，不要自行 `split('\n')` 重算。 |
| U7 | **LSP/编辑器边界保持 UTF-16**；若 host 暴露 LSP 风格位置，不要转成 UTF-8 字节。 |
| U8 | **fixture 必须显式标注坐标系**：字段名 `startColumn` 默认 UTF-16；若出现 `*_utf8` 字段，必须写明是字节偏移。 |

### 1.4 验收向量

| 向量 | 输入 | 期望 |
|---|---|---|
| V1 astral | 源 `const x = foo("😀", 2);`，pattern `foo($$$ARGS)` | match range `[10,22]`（UTF-16），UTF-8 字节范围是 `[10,24]`；见 `test/oracle/graph/pattern/golden/utf16-astral.json` |
| V2 BMP 多字节 | 源含 `é`（UTF-8 2 字节，UTF-16 1 unit） | 列号按 1 unit 计，不按 2 字节计 |
| V3 组合字符 | `e` + combining acute（2 code units） | 列号按 2 units；不要按 grapheme cluster 归一化 |
| V4 lossy | 含无效 UTF-8 字节的文件 | `readFile` 返回 U+FFFD；长度与 Node 一致 |
| V5 CRLF | `a\r\nb` | 第一行结束列包含 `\r`；第二行 line=2 |

> **建议（未拍板）**：在 core 的 `wire` 模块提供唯一转换函数 `byte_pos_to_utf16_col(src, line_starts, row, byte_pos)`，禁止各模块自行实现；在 fixture harness 中把“UTF-8 字节范围”作为反例断言（若实现返回字节范围，必须失败）。

---

## 2. pattern / search / framework fallback

### 2.1 pattern：WASM-only，错误显式，不静默回退

**现状**

- pattern 端口只跑 web-tree-sitter WASM：`ensureGrammarLoaded`（`pattern/pattern.ts:209`）→ `getParser` / `loadGrammarsForLanguages`（`extraction/grammars.ts:571`）；它**不**走 kernel 的 native 树。
- 语言子集：typescript/tsx/javascript/python 有 conformant 测试；其他语言要求存在 Chimera WASM grammar 且在 expando 表内（`pattern/index.ts:49-51`）。
- 编译错误是结构化的：`parse-failed` / `no-content` / `multiple-node` / `root-multi-metavar` / `grammar-not-loaded`（`pattern/pattern.ts:79-87`）；parse-error pattern 在编译期拒绝（`pattern/pattern.ts:279-288` 的 `containsErrorKind` 检查，helper `:185-189`）。
- 明确未移植：relational operators、KindMatcher/contextual patterns/potential_kinds、`transform:` 元变量管线、ast-grep streaming fixer（`pattern/index.ts:43-48`）。

**坑**

1. 把 pattern 的“编译失败”当成“无匹配”会静默吞掉用户错误；`ast_edit` 的 `runPatternMode` 必须把 `CompileResult.ok === false` 作为显式失败返回（`src/tool/ast_edit.ts:1363`）。
2. 若未来 core 用原生 tree-sitter 重写 pattern，ast-grep 的 **byte offset** 语义与当前 **UTF-16** 语义不同；不能直接照搬 `PatternRange`。
3. 语言子集之外的 pattern 请求当前返回 `grammar-not-loaded`，不是“尽力而为”；迁移后必须保留这一显式拒绝。

**规则**

- P1：pattern 编译错误必须原样上报 `kind` + `message`，不得降级为空匹配。
- P2：pattern range 一律 UTF-16；替换用 `source.slice` 语义（`applyReplacements`，`pattern/replacer.ts:41-79`）。
- P3：pattern 的 WASM grammar 与 kernel grammar 必须继续按 `MANIFEST.md` 同 revision 对齐；否则 pattern 与 extraction 的树形状会分叉。
- P4：若 core 化 pattern，先做 conformance（ast-grep 端口测试）再谈性能；不要以“Rust 更快”作为正确性证据。

### 2.2 search：FTS → LIKE → fuzzy → exact-name 补强

**现状**

`QueryBuilder.searchNodesDetailed`（`db/queries.ts:1483`）的固定顺序：

1. `parseQuery` 拆 `kind:` / `lang:` / `path:` / `name:` 过滤（`search/query-parser.ts:66`）。
2. FTS5 前缀查询（`searchNodesFTS`，`db/queries.ts:1732`）；多 token 逐 token 查询后合并（`:255-...`）。
3. 若无结果且 `text.length >= 2`，LIKE 子串（`searchNodesLike`，`:1900`）。
4. 若无结果且 `text.length >= 3`，fuzzy 编辑距离（`searchNodesFuzzy`，`:1666`；`boundedEditDistance`，`search/query-parser.ts:157`）。
5. 结果非空时，补 exact-name 候选（`db/queries.ts:1548-1600`），再做多信号打分（`scorePathRelevance` / `nameMatchBonus` / `kindBonus`，`search/query-utils.ts:218,362,407`）。

**坑**

1. FTS5 查询失败被 `catch` 成空结果（`db/queries.ts:1853` “FTS query failed, return empty”），随后 LIKE/fuzzy 仍会跑；这意味着“FTS 不可用”不会显式报错，只会变慢/变差。迁移时不能把这条静默路径变成“直接报错”，否则行为不兼容；但应加诊断计数（建议）。
2. LIKE 分支要求 `text.length >= 2`、fuzzy 要求 `>= 3`；阈值是行为契约，不是实现细节。
3. 打分是 TS 后置层；Rust core 若只做 SQL 候选集，必须把打分函数一并移植，否则排序会变。
4. `lower(name)` 的 SQL 索引只折叠 ASCII；JS `.toLowerCase()` 折叠 Unicode。`db/queries.ts:1548-1576` 注释明确这一点。跨语言实现不能用 Rust `to_lowercase()` 直接替代 SQL `lower()`。
5. 图未初始化/只读时，搜索不应自动初始化图数据；只读打开必须返回结构化状态（`index.ts:1269,1306-1315`；项目规则见 `packages/chimera/AGENTS.md` 的 graph data root 段）。

**规则**

- S1：保留 FTS→LIKE→fuzzy→exact-name 的顺序与阈值；不得合并或重排。
- S2：FTS 失败保持“空结果 + 继续 fallback”，但增加可观测计数（建议，未拍板）。
- S3：Unicode 大小写折叠必须与 SQL `lower()` / JS `toLowerCase()` 的现有分工一致；不要用 Rust 默认 Unicode 折叠替换 ASCII-only SQL。
- S4：query fixture 只钉顺序/名称/term count，不钉 BM25 浮点（见 `parity-fixtures.md` §2.3）。

### 2.3 framework：25 个 TS resolver，检测失败是静默的

**现状**

- 25 个 resolver 注册在 `frameworks/index.ts:34-75`；`detectFrameworks`（`:94-101`）对每个 resolver 调 `detect`，**任何异常都被 catch 成 `false`**；`getApplicableFrameworks`（`:108-114`）按语言过滤。
- resolver 接口：`detect` / `resolve` / 可选 `extract`（`resolution/types.ts:186-211`）；`extract` 在 extraction 阶段合并 framework 自己的节点/边（`extraction/index.ts:521-540`）。
- framework 结果在 rank 表里是 1（`store/loader.ts:459-468`），低于 import/qualified/exact/function-ref/instance-method/file-path，高于 fuzzy。
- framework 仓库即使所有语言都路由 kernel，也会保留 parse worker pool，因为 `extract()` 合并和 kernel `defer:` wasm 回退不能在主线程跑（`kernel/index.ts:332-352`、`extraction/index.ts:521-540`）。

**坑**

1. `detectFrameworks` 的 `catch → false` 会把 resolver 的 bug 伪装成“项目没用这个框架”；迁移时不能把这个静默行为带进 core，否则 framework 解析会无声降级。
2. framework 的 `extract()` 是 extraction 管线的一部分，不是 resolution 的附属；core 化 extraction 时若丢掉 `extract()`，会丢 route/component/navigates 等节点/边。
3. framework 结果依赖 `resolution` 的 rank/gate；core 化 resolve 时必须保留 `resolvedBy: 'framework'` 与 `gateFrameworkLanguage` 的跨语言边界。
4. `defer:` 回退依赖 wasm grammar 懒加载（`deferred-grammar.ts:38-68`）；framework 仓库的 worker pool 不能被“kernel-only 主线程直通”优化掉。

**规则**

- F1：framework `detect` 异常必须可观测（至少计数/日志）；不得继续静默 `false`。
- F2：framework `extract()` 的节点/边合并顺序与现有 `runPostExtract` 语义一致（`resolution/index.ts:298-325`）。
- F3：framework 结果 rank 1 与 language gate 不变；迁移后用 `resolution/golden` + framework fixture 对账。
- F4：framework 仓库保留 worker pool 的判定（`isKernelOnlyLanguageSet` 的 framework 参数）不得简化掉。

### 2.4 三者关系图

```text
extraction
  ├─ kernel (native) ──defer:──▶ wasm extractor (lazy grammar)
  └─ framework extract() ──▶ extra nodes/edges
resolution
  ├─ framework resolve() (rank 1)
  ├─ import / qualified / exact / ...
  └─ fuzzy (rank 0)
search (query)
  └─ FTS5 → LIKE → fuzzy → exact-name supplement
pattern (codemod)
  └─ WASM tree-sitter only; compile errors explicit
```

> **建议（未拍板）**：为 framework detect 失败增加一个 `framework.detect_error` 诊断事件（不改变解析结果），并在 parity 报告中单列；这样迁移时能区分“真没检测到”和“resolver 抛错”。

---

## 3. daemon writer 归属

### 3.1 三层锁/身份

| 机制 | 文件/位置 | 作用域 | 语义 |
|---|---|---|---|
| `codegraph.lock` | `src/graph/utils.ts:184-...`（`FileLock`）；路径 `index.ts:1025` | 跨进程、单次写操作 | `indexAll` / `sync` / `syncFiles` 获取；stale 2min + heartbeat；`chimera graph unlock` 可清理（`cli/chimera.ts:1525`） |
| `writer.pid` | `src/graph/mcp/writer-lock.ts:75-190` | 跨进程、长驻 MCP writer | 每个项目最多一个 live writer（daemon / direct / fallback）；link-into-place 原子创建；同 PID 可重入；死 PID 清理一次 |
| `daemon.pid` | `src/graph/mcp/daemon-paths.ts`；`daemon.ts:30-36` 注释 | 跨进程、daemon 仲裁 | 竞争 daemon 的 `O_EXCL` 锁；与 `writer.pid` 故意分离（direct holder 不应看起来像 daemon） |

### 3.2 当前所有权流程

1. **daemon 模式**：`Daemon.start` 先 `tryAcquireWriterLock(projectRoot, 'daemon')`（`mcp/daemon.ts:127-146`），失败则清理 lockfile 并抛错；成功后 `engine.ensureInitialized` 后台打开 CodeGraph。
2. **direct 模式**：`startDirect` 先 `tryAcquireWriterLock(writerRoot, 'direct')`（`mcp/index.ts:366-390`），失败直接 `process.exit(1)`；这是 #1740 的“第二个 direct writer 拒绝”策略。
3. **engine watcher**：`startWatching` 再 `tryAcquireWriterLock(lockRoot, 'fallback')`（`mcp/engine.ts:228-246`）；同 PID 重入，所以 daemon/direct 已持有时直接通过；proxy 的 in-process fallback 在这里首次获取。
4. **写操作**：`CodeGraph.indexAll` / `sync` / `syncFiles` 每次 `fileLock.acquire()`（`index.ts:1502,1705,2036`），失败返回结构化错误（`index.ts:1503-1506`）。
5. **读路径**：readOnly 打开不跑 sync、不修复目录、DB `query_only=ON`（`index.ts:1269,1306-1315`；`db/index.ts:114-116`）；多个读者可并存（WAL）。

### 3.3 坑

1. **`writer.pid` 是 advisory**：只靠 signal-0 判活；PID 复用可能误判；没有内核 flock。迁移到 host 时若换一套锁，会与 TS daemon 形成双 writer。
2. **`codegraph.lock` 只覆盖单次写操作**，不覆盖长驻 watcher 的生命周期；watcher 每批 sync 仍会拿它。
3. **daemon 的 engine 与 direct 的 engine 是同一套 MCPEngine**；daemon 关闭/空闲超时会 `engine.stop()`（`daemon.ts:196-220`），但 writer.pid 释放时机必须与 engine 关闭配对（`engine.ts` 的 `stop` 释放 `writerLockRoot`）。
4. **host 接管 graph 写路径**时，若 host 直接打开 DB 写而不拿 `writer.pid`/`codegraph.lock`，TS daemon 可能仍在写；这是 D4 的核心风险。
5. **read-only 与 writer 的边界**：只读查询不需要 writer.pid，但 host 的读连接不能持有写事务；WAL 允许并发读，但 checkpoint owner 必须唯一（计划 H2 §4.3）。

### 3.4 迁移规则（建议，未拍板）

| # | 规则 |
|---:|---|
| W1 | **单一 writer**：任一项目任一时刻只有一个进程持有 graph 写权；host 接管前必须明确是“daemon 变薄代理”还是“host 直接持锁”。 |
| W2 | **锁命名空间不分裂**：host 继续使用 `.chimera/writer.pid` + `codegraph.lock`（或迁移时原子改名并保留兼容读），不得新建第二套锁。 |
| W3 | **写路径先 drain 再换权**：host 接管前停止 TS watcher、等待在飞 sync 完成、确认 `codegraph.lock` 空闲；换权后 TS 只读。 |
| W4 | **回退不双写**：kill switch 回 TS 时，host 必须先释放 writer 身份；不允许“host 写 + TS 写”并存。 |
| W5 | **只读面不取 writer 锁**：host 的 query/search/traversal 读连接走 WAL 读池，不拿 writer.pid；checkpoint owner 仍唯一。 |
| W6 | **stale 恢复语义保留**：死 PID 清理、2min stale、`chimera graph unlock` 的行为要与现有 TS 一致；host 不能把 stale 锁当成“无锁”直接写。 |
| W7 | **daemon.pid 与 writer.pid 分离**：host 若接管 daemon，仍要保留两个身份的区别；direct 模式不应被误认为 daemon。 |

### 3.5 验收向量

| 向量 | 场景 | 期望 |
|---|---|---|
| W-1 | 两个 direct `serve --mcp` 同项目 | 第二个退出（exit 1），错误含 `writer.pid` 持有者 PID |
| W-2 | daemon 已运行，direct 启动 | direct 被拒绝；proxy 可连 daemon |
| W-3 | daemon 崩溃留下 stale `writer.pid` | 下一个 writer 能清理并获取；不误杀活 PID |
| W-4 | `indexAll` 与 watcher sync 并发 | `codegraph.lock` 串行化；失败方返回结构化“locked”错误，不静默丢写 |
| W-5 | host 接管写 + TS 只读 | TS 读连接 `query_only=ON`；host 是唯一 writer；kill switch 回退不双写 |
| W-6 | 多读者 + 单 writer | WAL 读不阻塞；checkpoint owner 唯一；`journal_size_limit` 生效 |

> **建议（未拍板）**：D4 的默认选项建议“daemon 变薄代理，host 持 writer 身份”；理由是现有 `writer.pid` / `codegraph.lock` 语义已经覆盖 direct/daemon/fallback 三种模式，直接改 Rust 会扩大首条闭环的锁迁移面。

---

## 4. 汇总门禁

| 坑 | 迁移前必须有的证据 | 本包提供的资产 |
|---|---|---|
| UTF-8/UTF-16 | astral/BMP/lossy/CRLF 向量；wire 字节 vs 列号分离 | `pattern/golden/utf16-astral.json`；本文 §1.4 |
| pattern/search/framework fallback | pattern 错误分类；search 顺序/阈值；framework detect 可观测性 | `pattern/*`、`query/*` fixture；本文 §2 |
| daemon writer | 单 writer 向量；锁命名空间；drain/回退 | 本文 §3.5；`writer-lock.ts` 证据 |

## 5. 待拍板

- **P-A**：是否在 core `wire` 提供唯一 `byte_pos_to_utf16_col` 转换函数（建议是）。
- **P-B**：search 的 FTS 失败是否要加诊断计数（会改变日志/遥测，不改变结果）。
- **P-C**：framework `detect` 异常是否升级为可见诊断（建议是）。
- **P-D**：D4 的默认选项（daemon 薄代理 vs host 直接持锁）。
- **P-E**：host 是否复用现有 `.chimera/writer.pid` 与 `codegraph.lock` 文件名（建议复用，迁移期原子改名并保留兼容）。