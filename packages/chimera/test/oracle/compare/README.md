# WP-03 · W0 比较器（compare v1）

> 状态：**verified 交付物（review 修正后）**（WP-03，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:257`（WP-03 DoD：比较器在故意注入下必须报错）、`packages/chimera/specs/rust-host/manifest.yaml:88-107`（WP-03 manifest 条目）、`packages/chimera/specs/rust-host/partition-table.md:30,53`（`T/compare/**` 独占分区）、`packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64`（WP-03 范围与 W0 四层出口）。
> 本目录只做比较器、meta-test、CLI 与文档；不写生产迁移代码、不编译 Rust、不构建/执行新鲜可执行体（`a0-scope-decisions.md:50-51`）。

## 1. 结论先行

- 比较器输入是 `RunArtifact = { envelope, transcript }`：`transcript` 是 WP-02 transcript v1 的精确字节，`envelope` 只记录 `scenario` 与运行终态（`complete` / `interrupted` / `timed_out` / `cancelled`）。
- 比较器做**语义比较**，不做字节比较：字节相等是 WP-02 确定性层的职责（`test/oracle/transcript/verify.ts:69-80`）；本层必须回答“为什么不同”，并把差异归入 8 类故障之一。
- 判定顺序固定：envelope → 完整性（含 transcript cancel 标记）→ header → golden 事件身份对齐 → write-vs-snapshot → 因果层 → 重放状态。顺序本身是契约，防止一个故障类掩盖另一个。
- meta-test 实测：8/8 注入 fixture 均以精确期望码被拒绝；2/2 未注入 golden 均通过；`bun test` 18 pass / 0 fail（63 expect calls）。

## 2. 输入契约

```ts
export type RunStatus = "complete" | "interrupted" | "timed_out" | "cancelled"

export type RunArtifact = {
  envelope: { scenario: string; status: RunStatus }
  transcript: string
}
```

- baseline 的 `envelope.status` 必须是 `complete`；否则比较器直接报 `COMPARE_BASELINE_NOT_COMPLETE`。
- candidate 的 `envelope.scenario` 必须与 baseline 一致；candidate 的 header `scenario` 也必须与 envelope 一致。
- `transcript` 必须是合法的 WP-02 transcript v1：header + `seq=1..N` 事件 + footer digest（`test/oracle/transcript/format.ts:236-281`）。
- `envelope` 不是 WP-02 的产物；WP-02 recorder 只产出 transcript。envelope 是 WP-03 为故障分类引入的最小运行结果契约，真实 recorder 后续只需补这两个字段即可接入。

## 3. 判定顺序与错误码

| 顺序 | 检查 | 触发条件 | 稳定错误码 |
|---|---|---|---|
| 1 | envelope 终态 | baseline 非 `complete` | `COMPARE_BASELINE_NOT_COMPLETE` |
| 1 | envelope 终态 | scenario 不一致 | `COMPARE_SCENARIO_MISMATCH` |
| 1 | envelope 终态 | `interrupted` / `timed_out` / `cancelled` | `FAULT_INTERRUPTION` / `FAULT_TIMEOUT` / `FAULT_CANCEL` |
| 2 | transcript 完整性 | candidate 无法解析 | `FAULT_INTEGRITY` |
| 2b | transcript cancel 标记 | `sse.event`（`stream_id=control`、`event=cancel`）后仍有后续事件 | `FAULT_CANCEL` |
| 3 | header parity | `format` / `version` / `contract_rev` / `scenario` / `layer` 不同 | `COMPARE_HEADER_MISMATCH` |
| 4 | golden 事件身份对齐 | candidate 多出身份 | `FAULT_DUPLICATE` |
| 4 | golden 事件身份对齐 | candidate 缺少身份 | `FAULT_LOSS` |
| 4 | golden 事件身份对齐 | 身份多重集相同但物理顺序不同 | `FAULT_REORDER` |
| 5 | write-vs-snapshot | `db.write` 行集合与结束 `db.snapshot` 不一致 | `FAULT_PARTIAL_WRITE` |
| 6 | 因果层 | WP-02 `checkCausality()` 拒绝 | `FAULT_CAUSALITY` |
| 7 | 重放层 | WP-02 `verifyReplay()` 拒绝 | `FAULT_REPLAY` |
| 7 | 重放层 | 重放状态与 baseline 重放状态不同 | `FAULT_REPLAY` |
| — | 全部通过 | 7 项检查全 pass | `PASS` |

`FAULT_INTEGRITY` / `FAULT_CAUSALITY` 是次级拒绝码，不属于 8 类故障矩阵的 verdict；矩阵只使用 8 个 `FAULT_*` 类码。meta-test 额外验证 `FAULT_INTEGRITY` 与 `COMPARE_BASELINE_NOT_COMPLETE` 两个次级路径不会吞掉故障类判定；`FAULT_CAUSALITY` 由 WP-02 因果层负例覆盖。

## 4. 事件身份

对齐阶段只比较“身份”，不比较 payload；payload 漂移属于重放类。

| 事件 `kind` | 身份 |
|---|---|
| `prompt.segment` | `prompt.segment:<segment_index>` |
| `prompt.join` | `prompt.join` |
| `tool.call` | `tool.call:<call_id>` |
| `tool.result` | `tool.result:<call_id>` |
| `db.write` | `db.write:<table>:<row.id>` |
| `db.read` | `db.read:<table>:<query>` |
| `db.snapshot` | `db.snapshot:<table>` |
| `sse.event` | `sse.event:<stream_id>:<event_seq>` |

设计理由：

- 丢失/重复/乱序必须先由身份层分类；如果先跑重放，丢失一个 `db.write` 会被报成 `REPLAY_DB_READ_MISMATCH`，故障类信息就丢了。
- `db.snapshot` 身份只到 table，因此“snapshot 少一行”不会被误判为丢失/重复，而会落到第 5 步的部分写检查。
- `tool.result` 身份只到 `call_id`，因此改写输出不会触发丢失/重复，而会落到第 7 步的重放状态比较。

## 5. 为什么不是字节比较

- WP-02 的 `checkDeterminism()` 已经覆盖“同输入同输出”的字节层（`test/oracle/transcript/verify.ts:69-80`）；再在 WP-03 做一次字节比较只会得到 `DETERMINISM_DIFF`，无法区分 8 类故障。
- 故障分类需要“同一组事件的不同组织方式”可区分：交换两条 `db.write` 在字节层只是一个 diff，在语义层是 `FAULT_REORDER`；重复一条是 `FAULT_DUPLICATE`；少一条是 `FAULT_LOSS`。
- 部分写必须独立于重放：snapshot 少一行时，WP-02 `verifyReplay()` 会报 `REPLAY_DB_SNAPSHOT_MISMATCH`；本比较器在第 5 步先报 `FAULT_PARTIAL_WRITE`，保留“部分写”这一故障类。
- 重放状态比较使用 `canonicalJson()`（`test/oracle/transcript/format.ts:144-160`）做稳定序列化，避免对象键顺序造成伪 diff；比较的是 prompt/tool/db/sse 的重放状态，不是原始字节。

## 6. Meta-test（DoD 硬要求）

命令与实测：

```bash
cd packages/chimera
bun test --timeout 30000 test/oracle/compare/compare.test.ts
# 18 pass / 0 fail, 63 expect() calls

bun run test/oracle/compare/run.ts
# RESULT: PASS (12/12 checks)
```

meta-test 覆盖：

1. **矩阵形状**：8 类恰好各一次；每类期望码唯一；每个 fixture 的 id/class/base_golden/expected_code 与矩阵行一致。
2. **注入必 fail**：对每个 fixture 先 `parseTranscript()` 证明注入后结构合法，再断言比较器抛出的 `CompareRejection.code` **精确等于** `expected_code`。
3. **未注入必 pass**：对 `determinism.jsonl` 与 `causality.jsonl` 各跑一次 baseline vs baseline，断言 `status === "pass"` 且 7 项检查全 pass。
4. **次级拒绝**：畸形 transcript → `FAULT_INTEGRITY`；非 complete baseline → `COMPARE_BASELINE_NOT_COMPLETE`。
5. **完整报告**：`runFaultMatrix()` 的 matrix checks + controls + 8 类 results 全部 pass。
6. **transcript 级终态证据**：timeout fixture 留下无结果的 in-flight `tool.call`；cancel fixture 在 cancel 标记后仍有事件，且去掉 envelope 后仍以 `FAULT_CANCEL` 拒绝。

`compare/run.ts` 是同一套逻辑的 CLI 入口；`--json` 输出机器可读报告，退出码 0/1 可直接接入 oracle_commands。

## 7. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 比较器 CLI（人读）
bun run test/oracle/compare/run.ts

# 比较器 CLI（机器读）
bun run test/oracle/compare/run.ts --json

# meta-test
bun test --timeout 30000 test/oracle/compare/compare.test.ts
```

## 8. 边界与已知限制

- **合成输入**：当前 baseline 是 WP-02 的合成 golden；不覆盖真实 session、真实 provider、真实 SQLite schema、真实 SSE 传输。
- **envelope 不是 WP-02 产物**：WP-02 recorder 目前不写 envelope；本比较器把 envelope 作为独立的最小运行结果契约。真实 recorder 接入前，envelope 由 harness/上层 runner 填充。
- **只读复用 WP-02**：`format.ts`、`verify.ts`、`golden/*.jsonl` 只读；本目录不修改 WP-02 的任何文件。
- **重放状态包含 tool output**：因为 WP-02 `replay()` 的 `ReplayState.tools` 含 `output`（`test/oracle/transcript/verify.ts:209-304`），改写 tool 输出会被判 `FAULT_REPLAY`。这是当前契约，不是实现偶然。
- **单故障假设**：每个 fixture 只注入一个故障类；比较器按固定顺序报第一个命中的类。多故障叠加不在本包范围。
- **cancel 标记是合成控制事件**：transcript v1 没有专用 cancel kind，fixture 用 `sse.event`（`stream_id=control`、`event=cancel`）表达取消信号；真实 recorder 接入时需保持同一约定或由 parent 升级契约。

## 9. 建议与待拍板（分开标注）

### 9.1 建议（未拍板）

- 保持判定顺序稳定；新增故障类时追加到矩阵末尾，并在 `compare.ts` 的固定位置插入检查，不要重排既有检查。
- 真实 recorder 接入时只补 `envelope`，不要改 transcript v1；这样 WP-03 比较器与 WP-02 判定可以原样复用。
- Rust 侧按本文件 §3/§4 的语义移植，复用 `faults/matrix.json` 与 `faults/fixtures/*.json`，不要复制 TS 实现。
- 每个新错误码必须同时有 fixture + meta-test 断言；禁止只加分支不加证据。

### 9.2 待拍板

- `envelope` 是否升级为跨语言共享契约；若升级，按 `partition-table.md:133` 递增 `contract_rev`。
- `FAULT_INTEGRITY` / `FAULT_CAUSALITY` 是否要提升为矩阵中的正式故障类（当前是次级拒绝码）。
- 重放状态比较是否应只比较“durable state”（例如排除 tool output），还是保持当前全状态比较；这会影响“重放”故障类的边界。
- `db.read` 身份是否应包含 `query` 文本（当前包含）；若未来 query 文本不稳定，可能需要退化为 `table` + 序号。

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| WP-03 DoD：比较器在故意注入下必须报错 | `RUST_FULL_MIGRATION_PLAN.md:257` |
| oracle 零 diff；不得排序掉因果错误或过滤丢失事件 | `RUST_FULL_MIGRATION_PLAN.md:296` |
| 统一门禁：全量测试 + `bun typecheck` | `RUST_FULL_MIGRATION_PLAN.md:297` |
| WP-02/WP-03 提供记录与比较框架 | `RUST_FULL_MIGRATION_PLAN.md:320` |
| WP-03 manifest（owner/deps/owned_files/DoD） | `packages/chimera/specs/rust-host/manifest.yaml:88-107` |
| WP-03 分区 `T/compare/**` | `packages/chimera/specs/rust-host/partition-table.md:30,53` |
| 共享契约变更递增 `contract_rev` | `packages/chimera/specs/rust-host/partition-table.md:133` |
| WP-03 范围与 W0 四层出口 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64` |
| 不写生产迁移代码 / 不编译新可执行体 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:50-51` |
| WP-02 确定性层 | `packages/chimera/test/oracle/transcript/verify.ts:69-80` |
| WP-02 因果层 | `packages/chimera/test/oracle/transcript/verify.ts:82-203` |
| WP-02 重放层 | `packages/chimera/test/oracle/transcript/verify.ts:209-318` |
| WP-02 canonical JSON | `packages/chimera/test/oracle/transcript/format.ts:144-160` |
| WP-02 transcript 解析/编码 | `packages/chimera/test/oracle/transcript/format.ts:166-178,236-281` |
| WP-02 把 fault matrix/比较器/统计门划给 WP-03 | `packages/chimera/test/oracle/transcript/README.md:186` |

## 11. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/compare/run.ts` | PASS（12/12 checks） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/compare/compare.test.ts` | 18 pass / 0 fail（63 expect calls） |
| `cd packages/chimera && bun run test/oracle/compare/run.ts --json` | 退出码 0；报告含 2 个 matrix check、2 个 control、8 个 fault result |

以上命令均在 `packages/chimera` 内运行；产物只写入内存/标准输出，不落仓库临时文件。