# WP-02 · W0 recorder / replay harness（transcript v1）

> 状态：**building 交付物**（WP-02，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:256`（WP-02 DoD）、`packages/chimera/specs/rust-host/manifest.yaml:64-83`（WP-02 manifest 条目）、`packages/chimera/specs/rust-host/partition-table.md:29`（`T/transcript/**` 独占分区）、`packages/chimera/specs/rust-host/a0-scope-decisions.md:35`（WP-02 范围）。
> 本目录只做 **契约、合成 fixture、录制/重放 harness、判定与文档**；不写生产迁移代码、不导入生产 `src/` 深内部件、不编译 Rust、不构建可执行体（`a0-scope-decisions.md:50-51`）。

## 1. 结论先行

- 同一合成输入在两个隔离目录、两个独立 SQLite DB 实例上各录制一次，生成的 `transcript.jsonl` **逐字节一致**；harness 同时写出两份可重放 transcript 并做 golden 对账。
- 判定分两层：**确定性层**（同输入同输出，字节比较）与**因果层**（tool result 在 call 之后、SSE 每流单调连续、DB read 在 write 之后、prompt 分段按装配序）。
- 两层各有 **golden + 负例**；负例覆盖篡改、丢失、重复、乱序、越序与 footer 完整性破坏，必须被指定错误码拒绝。
- 真实 session 录制不在本包：本包先冻结格式与 mock 级 fixture；后续 recorder 只需产出同样的 JSONL 即可接入同一套判定。

## 2. 范围与非目标

### 2.1 本包覆盖

| 录制类 | 本包记录内容 | 本包不记录 |
|---|---|---|
| tool result | `tool.call` 与 `tool.result` 的配对、`call_id`、`status`、`output` | 真实工具执行、权限、取消 |
| DB | 每个 arm 独立 SQLite 文件的 insert/read/snapshot 行投影 | 生产 schema、迁移、WAL、跨库投影 |
| SSE | 每流 `event_seq`、事件名、data | 真实 HTTP/SSE 传输、重连、背压 |
| prompt 分段 | `segment_index`、`key`、`content`、内容摘要、join 摘要/字节长度 | 真实 system prompt 装配、provider 模板 |

### 2.2 明确非目标

- **不导入生产 `src/` 深内部件做语义复制**：fixture 与 recorder 全部是合成输入（`synthetic_*` 工具、`synthetic://` 路径、固定 SQLite 行）。
- **不实现真实 session 录制**：真实 session 录制是后续包；本包只定义格式、隔离双臂、golden/负例与判定代码。
- **不做比较器/fault matrix/统计门**：那是 WP-03（`RUST_FULL_MIGRATION_PLAN.md:257`）；本包的负例只验证“故意破坏必须被判定不通过”。
- **不把格式接入 manifest/CI 共享契约**：manifest 回填命令见 §8，是否升级为跨语言共享契约需 parent 拍板（见 §10）。

## 3. 目录结构

```text
packages/chimera/test/oracle/transcript/
├── README.md                     # 本文件
├── format.ts                     # transcript v1：canonical JSONL、header/event/footer、parse/encode
├── scenario.ts                   # 合成场景类型
├── record.ts                     # 四类录制器；每 arm 一个目录 + 一个 SQLite 实例
├── verify.ts                     # 确定性层/因果层判定 + replay
├── harness.ts                    # 双臂编排、golden 对账、负例注入、suite 聚合
├── run.ts                        # bun run 入口（默认输出到临时目录；--out / --write-golden）
├── transcript.test.ts            # bun test 入口
├── fixtures/
│   ├── scenarios.ts              # 2 组合成输入：determinism / causality
│   └── negative-cases.ts         # 10 组故意破坏 fixture + 精确期望错误码
└── golden/
    ├── determinism.jsonl         # 确定性层 golden（15 events）
    └── causality.jsonl           # 因果层 golden（18 events）
```

## 4. transcript 格式 v1

### 4.1 行结构

```text
line 1              header   {"record":"header", ...}
line 2..N+1         event    {"kind":"<event-kind>","seq":1..N, ...}
line N+2            footer   {"record":"footer","event_count":N,"body_sha256":"<hex>"}
```

- 一行一个 JSON 对象，UTF-8，文件以换行结尾；空行不允许。
- `seq` 必须等于事件在文件中的物理序号（1 起连续）；物理顺序就是因果顺序。
- footer 的 `body_sha256` 覆盖 `header + 所有 event` 的精确字节（含末尾换行），不覆盖 footer 自身。
- 解析顺序：结构 → format/version/contract_rev → body digest → event_count → 每行 JSON/kind/seq。故意丢行但保留旧 footer 会在 `TRANSCRIPT_BODY_DIGEST` 被拒绝。

### 4.2 canonical JSON 规则

- 对象键递归排序；数组保持原序。
- 只允许 `null` / boolean / string / safe integer / array / object；`undefined`（含对象属性值，不会被静默丢弃）与非整数一律拒绝（`canonicalJson` 抛错）。
- 不写入时间戳、随机 id、绝对路径、host 名、凭据；transcript 不记录 arm 路径，DB 事件只记录 `table` 投影（arm 身份由 arm 目录隐式确定），合成资源写成 `synthetic://...`。

### 4.3 事件类型

| `kind` | 关键字段 | 用途 |
|---|---|---|
| `prompt.segment` | `segment_index`、`key`、`content`、`sha256` | prompt 分段及其内容摘要 |
| `prompt.join` | `segment_count`、`digest`、`byte_length` | 分段按 `\n\n` join 后的摘要/字节长度 |
| `tool.call` | `call_id`、`tool`、`input` | 工具调用 |
| `tool.result` | `call_id`、`status`、`output` | 工具结果（必须晚于对应 call） |
| `db.write` | `table`、`op`、`row` | SQLite insert 投影 |
| `db.read` | `table`、`query`、`rows` | 读结果投影（非空结果须晚于同表 write） |
| `db.snapshot` | `table`、`rows` | 结束快照；replay 用 write 重建后对账 |
| `sse.event` | `stream_id`、`event_seq`、`event`、`data` | SSE 帧（每流 `event_seq` 从 1 连续） |

## 5. 双臂与隔离

`harness.ts` 对每个 scenario 执行：

1. 在 `<root>/arm-a` 与 `<root>/arm-b` 各创建一个目录；
2. 每个 arm 创建自己的 `state.db`（两个不同的 SQLite 实例）；
3. 用同一 scenario 录制，得到两份 transcript；
4. 分别写入 `arm-a/transcript.jsonl`、`arm-b/transcript.jsonl`；
5. 比较 **内存 vs 文件、arm-a vs arm-b、file-a vs file-b** 三组字节；
6. 断言两个 arm 目录不同、DB 文件路径不同且都存在、transcript 不含 host 路径或 `file://`；
7. 对 golden 做字节对账，并分别执行因果层与 replay。

`db.read` / `db.snapshot` 的 replay 只从 `db.write` 重建行集合，再与录制结果比较；因此“记录可重放”不是只比较文件哈希，而是能重建 DB 投影。`parse -> encode` 必须逐字节还原源文件，否则报 `REPLAY_ENCODING_UNSTABLE`。

### 5.1 双臂语义与已知限制（当前实现）

- **当前双臂 = 同一 recorder 的两次独立调用**：`arm-a` 与 `arm-b` 运行同一份 TS 录制代码、消费同一份合成 scenario，仅目录与 SQLite 实例隔离。两臂字节一致证明的是**该 recorder 在隔离环境下的确定性**（无隐藏共享状态、无时间/路径/随机源泄漏），**不是跨实现 parity**，也不能外推为“真实 session 录制与 Rust recorder 等价”。
- **真实 session 录制**（真实工具执行、真实 provider/SSE、真实 SQLite schema）与**跨实现双臂**（同输入下 TS recorder 与 Rust recorder 的产物对比）都属后续包，不在本包范围（见 §2.2、§9）。
- **已知限制（待 G0 拍板是否为 approved_delta）**：本包不提供任何跨实现等价证据；若后续把“双臂一致”当作 Rust 迁移的 parity 门槛，需由 G0 明确该缺口是否登记为 `approved_delta`，以及由哪个包补齐跨实现双臂。

## 6. 双层判定与覆盖矩阵

### 6.1 判定层

| 层 | 判定 | 通过条件 | 负例期望 |
|---|---|---|---|
| 确定性层 | `checkDeterminism(expected, actual)` | 字节完全相等 | `DETERMINISM_DIFF` |
| 因果层 | `checkCausality(transcript)` | 事件引用顺序/单调性成立 | `CAUSAL_*` 稳定错误码 |
| 重放层 | `verifyReplay(transcript)` | prompt 分段摘要、join 摘要、DB read/snapshot、重编码字节一致 | `REPLAY_*` 稳定错误码 |
| 完整性层 | `parseTranscript(text)` | header/footer/digest/count/seq 合法 | `TRANSCRIPT_*` 稳定错误码 |

### 6.2 覆盖矩阵（四类 × 两层）

| 录制类 | 确定性 golden | 确定性负例 | 因果 golden | 因果负例 |
|---|---|---|---|---|
| tool result | `golden/determinism.jsonl`（call/result 各 1） | 篡改 result payload → `DETERMINISM_DIFF` | `golden/causality.jsonl`（2 组 call/result） | result 移到 call 之前 → `CAUSAL_RESULT_BEFORE_CALL` |
| DB | 3 行 insert + read + snapshot | 篡改 db row → `DETERMINISM_DIFF` | 3 行 insert + read + snapshot | read 移到首个 write 之前 → `CAUSAL_DB_READ_BEFORE_WRITE` |
| SSE | 单流 4 帧 | 丢帧 → `DETERMINISM_DIFF` | 双流交错 5 帧 | 丢帧 → `CAUSAL_SSE_SEQ_GAP`；重复 → `CAUSAL_SSE_SEQ_DUPLICATE` |
| prompt 分段 | 3 段 + join 摘要 | 丢一段 → `DETERMINISM_DIFF` | 3 段 + join 摘要 | 交换两段 → `CAUSAL_PROMPT_SEGMENT_ORDER` |

### 6.3 负例清单（10 组）

| 负例 id | 层 | 破坏方式 | 期望错误码 |
|---|---|---|---|
| `determinism-tampered-tool-output` | determinism | 改 tool result 输出 | `DETERMINISM_DIFF` |
| `determinism-tampered-db-row` | determinism | 改 SQLite write 行 | `DETERMINISM_DIFF` |
| `determinism-dropped-prompt-segment` | determinism | 丢一个 prompt 分段 | `DETERMINISM_DIFF` |
| `determinism-dropped-sse-frame` | determinism | 丢一帧 SSE | `DETERMINISM_DIFF` |
| `causality-tool-result-before-call` | causality | result 移到 call 前 | `CAUSAL_RESULT_BEFORE_CALL` |
| `causality-sse-seq-gap` | causality | 丢一帧造成序号缺口 | `CAUSAL_SSE_SEQ_GAP` |
| `causality-sse-seq-duplicate` | causality | 重复一帧 | `CAUSAL_SSE_SEQ_DUPLICATE` |
| `causality-db-read-before-write` | causality | read 移到 write 前 | `CAUSAL_DB_READ_BEFORE_WRITE` |
| `causality-prompt-segment-reorder` | causality | 交换两个 prompt 分段 | `CAUSAL_PROMPT_SEGMENT_ORDER` |
| `integrity-stale-footer` | integrity | 删行但保留旧 footer | `TRANSCRIPT_BODY_DIGEST` |

负例的乱序/丢失类会重新编码并重算 footer，确保它们进入因果层而不是被完整性层提前拦截；`integrity-stale-footer` 故意保留旧 footer，专门验证完整性层。

## 7. 运行方式

以下命令均从 `packages/chimera` 执行（`package.json:29-31` 的 `typecheck` / `test` 脚本）：

```bash
# 1) harness 主入口：双臂 + golden + 因果 + replay + 10 组负例
bun run test/oracle/transcript/run.ts

# 2) 保留产物到指定目录（否则打印 OS 临时目录）
bun run test/oracle/transcript/run.ts --out <out-dir>

# 3) 重新生成 golden（只在 fixture 有意变更时执行）
bun run test/oracle/transcript/run.ts --write-golden

# 4) bun test 入口
bun test --timeout 30000 test/oracle/transcript/transcript.test.ts

# 5) 包级类型检查
bun typecheck
```

产物布局（`--out` 或默认临时目录）：

```text
<out>/<scenario-id>/arm-a/transcript.jsonl
<out>/<scenario-id>/arm-b/transcript.jsonl
<out>/summary.json
```

## 8. oracle_commands 建议（供 manifest 回填，未拍板）

建议把 WP-02 的 `oracle_commands` 回填为：

```yaml
oracle_commands:
  - "cd packages/chimera && bun run test/oracle/transcript/run.ts"
  - "cd packages/chimera && bun test --timeout 30000 test/oracle/transcript/transcript.test.ts"
```

说明：第一条是包内 focused 主判定（24 项检查）；第二条验证 bun test 集成与逐项负例断言。`bun typecheck` 属于包级门禁，不建议塞进 WP-02 的 focused oracle 列表（`RUST_FULL_MIGRATION_PLAN.md:297` 已把全量 typecheck 列为统一门禁）。

## 9. 与后续包的边界

- **WP-03**：在本包的 `DETERMINISM_DIFF` / `CAUSAL_*` 错误码之上做 fault matrix、比较器与统计门；本包不实现 8 类故障的完整矩阵与噪声带。
- **后续真实 session recorder**：按本格式输出即可复用 `parseTranscript` / `checkCausality` / `verifyReplay`；真实录制必须自行完成隐私脱敏（本包只冻结“不得写入 host 路径/凭据/时间戳”的格式约束）。
- **Rust host**：格式是语言无关的 JSONL；Rust 侧只需按 §4 规则编码，不需要依赖本 TS 实现。

## 10. 建议与待拍板（分开标注）

### 10.1 建议（未拍板）

- 建议把 transcript v1 作为 W0 录制基线，WP-03/WP-08/WP-09/WP-10 的 fixture 复用同一 header/event/footer 结构，减少比较器分叉。
- 建议后续真实 recorder 在写入前统一做路径/凭据归一化，并保持 `seq` 物理序 = 因果序。
- 建议 golden 只在 fixture 有意变更时用 `--write-golden` 重生成；CI 只读不写。

### 10.2 待拍板

- transcript v1 是否升级为跨语言共享契约（若升级，按 `partition-table.md:133` 递增 `contract_rev`）。
- 真实 session 录制的隐私边界（哪些 prompt/tool 字段必须脱敏、是否允许落盘）由哪个包定义。
- golden 刷新是否纳入 CI 的显式 `approved_delta` 流程，而不是仅靠人工 review。

## 11. 证据索引

| 证据 | 位置 |
|---|---|
| WP-02 范围与 DoD | `RUST_FULL_MIGRATION_PLAN.md:256` |
| 包纪律：独立 build/test、独立临时 DB | `RUST_FULL_MIGRATION_PLAN.md:268` |
| oracle 零 diff；不得排序掉因果错误或过滤丢失事件 | `RUST_FULL_MIGRATION_PLAN.md:296` |
| 统一门禁：全量测试 + `bun typecheck` | `RUST_FULL_MIGRATION_PLAN.md:297` |
| WP-02/WP-03 提供记录与比较框架 | `RUST_FULL_MIGRATION_PLAN.md:320` |
| WP-02 manifest（owner/deps/owned_files/DoD） | `packages/chimera/specs/rust-host/manifest.yaml:64-83` |
| WP-02 分区 `T/transcript/**` | `packages/chimera/specs/rust-host/partition-table.md:29` |
| WP-02 范围（W0 recorder/harness） | `packages/chimera/specs/rust-host/a0-scope-decisions.md:35` |
| 非目标：不写生产迁移代码 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:50-51` |
| W0 四层 fixture 出口 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:64` |
| 包脚本 `typecheck` / `test` | `packages/chimera/package.json:29-31` |

## 12. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/transcript/run.ts` | PASS（24/24 checks） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/transcript/transcript.test.ts` | 18 pass / 0 fail（含 `canonicalJson` 拒绝 `undefined` 属性值的负例） |
| `cd packages/chimera && bun typecheck` | 通过（tsgo 无输出） |
| 对 `--out` 产物执行 `cmp arm-a/transcript.jsonl arm-b/transcript.jsonl` | 两个 scenario 均逐字节一致 |

以上命令均在 `packages/chimera` 内运行；产物默认写入 OS 临时目录，不在仓库内留下未跟踪文件。