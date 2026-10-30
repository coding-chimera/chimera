# Graph parity fixture 契约（WP-06）

> 状态：**draft for review**（静态 fixture；不要求执行引擎）
> contract_rev：`cr-2026-10-30-r1`
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §8（WP-06 DoD）/§10（统一门禁）；`packages/chimera/specs/rust-host/{manifest.yaml,partition-table.md,a0-scope-decisions.md}`。
> 基线：commit `9600ee7f49ddcb065a33511f21f570d2b2d13a19`
> 落位：`packages/chimera/test/oracle/graph/**`（fixture 与校验脚本）、`packages/chimera/specs/rust-host/graph/**`（契约文档）

---

## 0. 目的与边界

本包定义 graph 六面的 **静态 parity fixture**：每组 fixture 给出“输入 + 期望输出/期望判定”，用于未来 TS/Rust 双臂对账。它**不是**执行引擎，也不依赖 Rust core：

- 本包只写 fixture、schema、索引与一个形状/覆盖校验脚本；
- 真正的录制、比较、统计门归 WP-02/WP-03；
- fixture 里的“期望”来自当前 TS 实现的代码语义，或对当前 TS 引擎的隔离执行（`provenance.executed` 标明）；
- 不包含真实后端 URL、内网域名、IP、凭据或用户 home 绝对路径。

---

## 1. 目录布局

```text
packages/chimera/test/oracle/graph/
├── README.md                  # 使用说明（本文件的精简版）
├── schema.json                # fixture JSON Schema（自描述）
├── index.json                 # fixture 索引 + 覆盖矩阵（机检入口）
├── validate-fixtures.ts       # 形状/覆盖/禁用内容校验（不执行引擎）
├── extraction/
│   ├── golden/ts-basic.json
│   └── negative/kernel-defer-parse-error.json
├── store/
│   ├── golden/commit-batch.json
│   └── negative/dangling-edge-drop.json
├── resolution/
│   ├── golden/import-over-same-name.json
│   └── negative/unknown-name.json
├── query/
│   ├── golden/fts-prefix.json
│   └── negative/no-match-fallbacks.json
├── traversal/
│   ├── golden/callers-depth2.json
│   └── negative/unknown-start.json
└── pattern/
    ├── golden/metavar-rewrite.json
    ├── golden/utf16-astral.json
    └── negative/parse-failed.json
```

命名约定：`<face>/<kind>/<slug>.json`；fixture `id` 等于去掉 `.json` 的仓库相对路径（相对 `test/oracle/graph/`），例如 `extraction/golden/ts-basic`。

---

## 2. 格式规范

### 2.1 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `fixture_version` | 是 | 固定 `1`；格式破坏性变更时递增 |
| `contract_rev` | 是 | 固定 `cr-2026-10-30-r1`；共享契约变更时随 manifest 递增 |
| `id` | 是 | `<face>/<kind>/<slug>`，与文件路径一致 |
| `face` | 是 | `extraction` / `store` / `resolution` / `query` / `traversal` / `pattern` |
| `kind` | 是 | `golden` / `negative` |
| `title` | 是 | 一行摘要 |
| `description` | 否 | 该 fixture 钉住的行为与边界 |
| `input` | 是 | 面相关输入对象（见 §2.2） |
| `expect` | 是 | 期望输出/判定；至少含 `status` |
| `provenance` | 是 | `{ evidence: string[], derivation: string, executed: boolean }` |

`expect.status` 取值：

- `ok`：正常输出；
- `defer`：kernel 主动 defer 到 wasm（extraction）；
- `error`：期望结构化错误；
- `empty`：期望空结果（负例常用）。

### 2.2 各面 input 约定

| 面 | input 关键字段 | 说明 |
|---|---|---|
| extraction | `file_path`、`language`、`source`；可选 `kernel`（routing/kill switch） | 单文件提取；不依赖真实项目 |
| store | `ops`（逻辑 `RecordedOp[]`）、可选 `fuse`、`db_state` | 逻辑 op 而非预编码字节；harness 用 `StoreBuffersBuilder` 编码 |
| resolution | `project.files`、`nodes`、`refs`、`frameworks` | 小型虚拟项目；文件内容用字符串给出 |
| query | `nodes`、`query`、`options` | 直接给节点行；FTS 由 harness 建库 |
| traversal | `nodes`、`edges`、`operation`、`args` | 直接给图；operation 如 `getCallers` |
| pattern | `language`、`source`、`pattern`、可选 `template` | 需 `ensureGrammarLoaded` 的 wasm 语法 |

### 2.3 规范化（canonicalization）

fixture 的期望输出是**规范化后**的形状；harness 必须先规范化再比较：

1. **ID 符号化**：extraction/store/resolution fixture 用 `n_*` / `fn_*` 等符号 id；比较时把真实哈希 id 替换为按 `(kind,name,startLine,startColumn)` 稳定排序后的序号。fixture 的 `expect.canonicalization` 字段声明所用规则。
2. **稳定排序**：nodes 按 `(kind,name,startLine,startColumn)`；edges 按 `(source,target,kind,line,column)`；refs 按 `(from,referenceName,referenceKind,line,column)`。
3. **省略 undefined**：TS 对象的 `undefined` 字段在 JSON 中省略；比较时“缺失”与 `null` 不等价，除非 fixture 明确写 `null`。
4. **浮点**：query 的 BM25 分数不写死；fixture 只钉顺序、名称与 `score_order: "desc"`；若必须钉分数，用 `score_tolerance`。
5. **范围**：所有 range 是 UTF-16 code-unit 索引（见 `known-pitfalls.md` §1）；fixture 不写 UTF-8 字节偏移，除非字段名明确为 `*_utf8`。
6. **volatile 字段**：`walPages`、`durationMs`、`updatedAt` 等运行相关字段不钉具体值；fixture 用 `volatile_fields` 声明类型约束。

### 2.4 比较模式

| `expect.match` | 语义 |
|---|---|
| `exact_after_canonicalization` | 规范化后完全相等（默认） |
| `subset` | 期望条目必须全部存在；允许额外条目，但 `must_not` 不得出现 |
| `stats_only` | 只比较 `expect.stats` 与 `row_counts` |
| `error` | 比较 `expect.error.code` / `message_contains`；`must_not` 不得发生 |

---

## 3. 六面覆盖矩阵

| 面 | golden | negative | 钉住的行为 |
|---|---|---|---|
| extraction | `ts-basic` | `kernel-defer-parse-error` | 节点/边/ref 形状；`defer:` → wasm 回退 |
| store | `commit-batch` | `dangling-edge-drop` | 批量提交计数；dangling 边静默丢弃 |
| resolution | `import-over-same-name` | `unknown-name` | import 优先于同名 exact-match；未知名不产生边 |
| query | `fts-prefix` | `no-match-fallbacks` | FTS 前缀顺序；FTS→LIKE→fuzzy 全 miss 返回空 |
| traversal | `callers-depth2` | `unknown-start` | 深度 2 callers 集合/顺序；未知起点返回空 |
| pattern | `metavar-rewrite`、`utf16-astral` | `parse-failed` | 元变量捕获/替换；UTF-16 range；parse-failed 编译错误 |

`index.json` 的 `coverage` 段是机检入口；`validate-fixtures.ts` 会验证“每面至少 1 golden + 1 negative”。

---

## 4. 判定语义

### 4.1 golden

- 期望 `status: "ok"`（或 `defer` 的明确分支）；
- 输出经 §2.3 规范化后与 `expect` 逐字段相等；
- 对 `subset` 模式，`expect.must_not` 中的条目不得出现；
- 任何额外错误、panic、未捕获异常都判失败。

### 4.2 negative

- 期望 `status: "error"` / `"empty"` / `"defer"` / `"ok"`；
- 若为 `error`，比较 `error.code`（稳定）与 `message_contains`（宽松）；
- 若为 `empty`，比较空集合/空数组，并验证 `must_not` 未发生；
- 若为 `ok`，表示操作成功但契约要求“丢弃/拒绝某行”（例如 store 的悬空边）；此时负例断言由 `must_not` 与预期计数（如 `edgesDroppedDangling`）共同表达；
- 负例不得以“吞掉错误、返回空成功”通过——`must_not` 明确列出该反模式。

### 4.3 与 W0 的关系

- 本包 fixture 是**面级契约**，不是 W0 四层（确定性/因果/fault/统计）的替代；
- WP-02 的 recorder 负责把实际输出写成同形状记录；WP-03 的比较器消费本包 fixture；
- 本包不执行 fixture；`provenance.executed` 只表示“派生时是否跑过当前 TS 引擎”，不是持续验证结果。

---

## 5. Fixture 清单

| # | id | 面/类型 | 钉住的行为 | 派生方式 |
|---:|---|---|---|---|
| 1 | `extraction/golden/ts-basic` | extraction/golden | TS 文件/导入/函数/statement 节点与 ref | 执行当前 TS extractor |
| 2 | `extraction/negative/kernel-defer-parse-error` | extraction/negative | kernel parse-error → `defer:` → wasm | 执行 kernel + 检查 defer memo |
| 3 | `store/golden/commit-batch` | store/golden | 3 nodes/2 edges/2 refs/1 file 的批量计数 | 执行 native store bridge |
| 4 | `store/negative/dangling-edge-drop` | store/negative | 悬空边被丢弃、不写库 | 执行 native store bridge |
| 5 | `resolution/golden/import-over-same-name` | resolution/golden | 同名两候选时 import 选中被导入文件 | 执行 TS ReferenceResolver |
| 6 | `resolution/negative/unknown-name` | resolution/negative | 未知引用名保持 unresolved | 代码语义 + TS resolver |
| 7 | `query/golden/fts-prefix` | query/golden | `parse` 前缀命中顺序 | 执行 QueryBuilder（内存库） |
| 8 | `query/negative/no-match-fallbacks` | query/negative | FTS/LIKE/fuzzy 全 miss → 空 | 执行 QueryBuilder（内存库） |
| 9 | `traversal/golden/callers-depth2` | traversal/golden | a→t, b→a, b→t, c→b 的 2 跳 callers | 执行 GraphTraverser（假查询） |
| 10 | `traversal/negative/unknown-start` | traversal/negative | 未知起点返回空 | 代码语义 |
| 11 | `pattern/golden/metavar-rewrite` | pattern/golden | `foo($$$ARGS)` → `bar($$$ARGS)` | 执行 pattern 端口 |
| 12 | `pattern/golden/utf16-astral` | pattern/golden | astral 字符下 UTF-16 range | 执行 pattern 端口 |
| 13 | `pattern/negative/parse-failed` | pattern/negative | 非法 pattern → `parse-failed` | 执行 pattern 端口 |

---

## 6. 机检

```bash
# 从 packages/chimera 运行
bun run test/oracle/graph/validate-fixtures.ts
```

校验内容：

1. `index.json` 与磁盘文件一一对应；
2. 每个 fixture 的 `fixture_version` / `contract_rev` / `id` / `face` / `kind` / `title` / `input` / `expect` / `provenance` 必填；
3. `id` 与文件路径一致；
4. 六面各有 ≥1 golden + ≥1 negative；
5. 禁止内容扫描：真实后端 URL、用户 home 绝对路径（macOS/Linux 常见前缀）、IPv4 字面量、常见凭据前缀。

---

## 7. 建议（未拍板）

- **S1**：WP-02/WP-03 的比较器直接消费 `index.json`，不要复制 fixture 清单。
- **S2**：后续新增 fixture 一律走 `<face>/<kind>/<slug>.json` + `index.json` 登记，保持 id=路径。
- **S3**：query 的分数若必须钉住，使用 `score_tolerance`（建议 1e-6）并注明 SQLite 版本。
- **S4**：extraction fixture 的 `statement` 节点依赖 `EXTRACTION_SEMANTICS_VERSION = 10`；语义版本变更时更新 fixture 并在 `provenance` 记录。

## 8. 待拍板

- **D-A**：fixture 的最终消费方是 WP-02 recorder 还是 WP-03 comparator；两者接口未定。
- **D-B**：是否要求 Rust 侧也提供同名 fixture 的“自动生成”模式，还是只做消费方。
- **D-C**：query 分数是否纳入硬门；若纳入，需固定 SQLite/FTS5 版本。
- **D-D**：pattern fixture 是否在 wasm 退役后改为原生 tree-sitter 派生。