# WP-03 · W0 故障矩阵（fault matrix v1）

> 状态：**verified 交付物（review 修正后）**（WP-03，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:257`（WP-03 DoD）、`packages/chimera/specs/rust-host/manifest.yaml:88-107`（WP-03 manifest 条目）、`packages/chimera/specs/rust-host/partition-table.md:30,53`（`T/faults/**` 独占分区）、`packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64`（WP-03 范围与 W0 四层出口）。
> 本目录只做契约、合成 fixture、注入器与文档；不写生产迁移代码、不导入生产 `src/` 深内部件、不编译 Rust、不构建/执行新鲜可执行体（`a0-scope-decisions.md:50-51`）。

## 1. 结论先行

- `matrix.json` 是机器可读的 8 类故障表；每类**恰好一个** JSON fixture，fixture 声明基 golden、注入操作、envelope 终态与期望判定。
- 8 类覆盖 DoD 原文：丢失 / 乱序 / 重复 / 中断 / 部分写 / 超时 / 取消 / 重放；每类有稳定错误码 `FAULT_LOSS` … `FAULT_REPLAY`。
- 注入只改 transcript 或 envelope，不改 WP-02 文件；丢失/乱序/重复 fixture 会重新编码并重算 footer，确保进入比较器而不是被完整性层提前拦截。
- 判定由 `../compare/` 比较器执行；meta-test 证明“每类注入必 fail、未注入 golden 必 pass”（见 `../compare/README.md` §6）。
- 超时/取消 fixture 同时携带 transcript 级证据（超时=无结果的 in-flight `tool.call`，取消=cancel 标记后仍有事件），envelope 级只作附加信号。

## 2. 范围与非目标

### 2.1 本包覆盖

| 故障类 | 注入位置 | 期望判定 | 判定层 |
|---|---|---|---|
| 丢失 `loss` | `db.write` 事件缺失 | `FAULT_LOSS` | golden 事件身份多重集 |
| 乱序 `reorder` | 两个 `db.write` 交换 | `FAULT_REORDER` | golden 事件身份顺序 |
| 重复 `duplicate` | 重复一个 `db.write` | `FAULT_DUPLICATE` | golden 事件身份计数 |
| 中断 `interruption` | 截断事件前缀 + `envelope=interrupted` | `FAULT_INTERRUPTION` | envelope 终态 |
| 部分写 `partial_write` | 结束 snapshot 缺少已写行 | `FAULT_PARTIAL_WRITE` | write-vs-snapshot 不变式 |
| 超时 `timeout` | 删除 `tool.result`（in-flight 截断）+ `envelope=timed_out` | `FAULT_TIMEOUT` | envelope 终态；transcript 级证据附加 |
| 取消 `cancel` | 插入 cancel 标记后保留后续事件 + `envelope=cancelled` | `FAULT_CANCEL` | envelope 终态 + transcript cancel 标记 |
| 重放 `replay` | 改写 `tool.result` 输出且保持自洽 | `FAULT_REPLAY` | 重放状态与基线不同 |

### 2.2 明确非目标

- **不做真实故障注入**：不杀进程、不制造真实 SQLite 半写、不中断真实 SSE/HTTP；fixture 是合成 transcript + 合成 envelope。
- **不替代 WP-02 的字节级判定**：WP-02 的 `DETERMINISM_DIFF` / `CAUSAL_*` / `REPLAY_*` 仍是底层；本包在其上做“故障分类”。
- **不定义 Rust 侧故障注入 API**：fixture JSON 可被后续 Rust runner 直接读取，但跨语言共享契约需 parent 拍板（见 §9.2）。
- **不改 WP-02**：`format.ts`、`verify.ts`、`harness.ts`、`golden/*.jsonl` 只读引用；WP-02 README 已把 fault matrix/比较器/统计门划给 WP-03（`test/oracle/transcript/README.md:186`）。

## 3. 目录结构

```text
packages/chimera/test/oracle/faults/
├── README.md                  # 本文件
├── matrix.json                # 8 类故障的机器可读矩阵
├── matrix.ts                  # 矩阵/fixture 解析与校验
├── inject.ts                  # 确定性注入器（重新编码 transcript）
└── fixtures/
    ├── loss-dropped-db-write.json
    ├── reorder-swapped-db-writes.json
    ├── duplicate-db-write.json
    ├── interruption-truncated-run.json
    ├── partial-write-missing-snapshot-row.json
    ├── timeout-run.json
    ├── cancel-run.json
    └── replay-tool-output-drift.json
```

## 4. 机器可读矩阵

`matrix.json` 顶层字段：

| 字段 | 含义 |
|---|---|
| `format` | 固定 `chimera.oracle.fault-matrix` |
| `version` | 固定 `1` |
| `contract_rev` | 固定 `cr-2026-10-30-r1` |
| `classes` | 8 行故障类；每行含 `id`、`fault_class`、`label_zh`、`fixture`、`base_golden`、`injection`、`expected_code`、`detection` |

校验入口是 `matrix.ts` 的 `loadFaultMatrix()` / `loadFaultFixture()`：未知类、未知 envelope 状态、非法注入操作都会直接抛错，不静默降级。

## 5. Fixture schema

```json
{
  "id": "loss-dropped-db-write",
  "fault_class": "loss",
  "label_zh": "丢失",
  "base_golden": "determinism.jsonl",
  "description": "删除第 2 条 db.write；footer 重算后结构合法，但相对基线丢失一个事件身份。",
  "envelope_status": "complete",
  "injections": [
    { "op": "drop-event", "kind": "db.write", "ordinal": 2 }
  ],
  "expected": { "status": "fail", "code": "FAULT_LOSS" }
}
```

| 字段 | 约束 |
|---|---|
| `id` | 必须与矩阵行 `id` 一致 |
| `fault_class` | 必须是 8 类之一 |
| `base_golden` | 必须是 WP-02 `transcript/golden/` 下的文件 |
| `envelope_status` | `complete` / `interrupted` / `timed_out` / `cancelled` |
| `injections` | 有序注入操作数组；空数组表示只改 envelope |
| `expected.status` | 固定 `fail`（故障 fixture 不允许期望通过） |
| `expected.code` | 必须与矩阵行 `expected_code` 一致 |

### 5.1 注入操作

| `op` | 参数 | 语义 |
|---|---|---|
| `drop-event` | `kind`、`ordinal` | 删除第 `ordinal` 个（1 起）指定 `kind` 事件 |
| `swap-events` | `kind`、`ordinals: [a,b]` | 交换同 `kind` 的第 a、b 个事件 |
| `duplicate-event` | `kind`、`ordinal` | 在第 `ordinal` 个事件后复制一份 |
| `truncate-events` | `keep` | 只保留前 `keep` 个事件（模拟中断前缀） |
| `remove-snapshot-row` | `table`、`id` | 从该表 `db.snapshot` 删除指定行 |
| `set-tool-output` | `call_id`、`output` | 改写指定 `tool.result` 的输出对象 |
| `insert-cancel-event` | `at`、`reason` | 在第 `at` 个（1 起）事件前插入 `sse.event` 控制标记（`stream_id=control`、`event=cancel`），后续事件保留 |

所有 `ordinal` 都是 1 起；找不到目标事件时注入器抛错，不生成“看似合法但未注入”的 fixture。注入后统一走 `encodeTranscript()` 重算 `seq` 与 footer，因此结构完整性层不会替比较器“提前判负”。

## 6. 判定语义（与比较器的分工）

本目录只负责“造故障”；判定顺序在 `../compare/compare.ts`：

1. envelope 终态（中断/超时/取消）；
2. transcript 完整性；
2b. transcript cancel 标记（cancel 标记后仍有后续事件）；
3. header parity；
4. golden 事件身份对齐（丢失/重复/乱序）；
5. write-vs-snapshot 不变式（部分写）；
6. WP-02 因果层；
7. 重放状态与基线比较。

这个顺序是契约的一部分：例如“丢失一个 `db.write`”同时也会破坏重放，但比较器必须在第 4 步报 `FAULT_LOSS`，而不是在第 7 步报 `FAULT_REPLAY`。meta-test 用精确错误码锁定该行为。

transcript cancel 检查放在 header/身份对齐之前，避免 cancel 标记被身份层误报为 `FAULT_DUPLICATE`。

## 7. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 1) 比较器 CLI：矩阵形状 + 正控制 + 8 类注入
bun run test/oracle/compare/run.ts

# 2) 机器可读报告
bun run test/oracle/compare/run.ts --json

# 3) bun test meta-test
bun test --timeout 30000 test/oracle/compare/compare.test.ts
```

## 8. 与 WP-02 的边界

- WP-02 的 10 组负例是**字节/结构层**负例（篡改、丢行、footer 过期等），期望 `DETERMINISM_DIFF`、`CAUSAL_*`、`TRANSCRIPT_*`（`test/oracle/transcript/fixtures/negative-cases.ts:33-114`）。
- WP-03 的 8 组 fixture 是**故障分类层**负例，期望 `FAULT_*`；它们复用 WP-02 的 `parseTranscript` / `checkCausality` / `verifyReplay` 与 golden（`test/oracle/transcript/format.ts:236-281`、`verify.ts:198-318`）。
- WP-02 的 golden 是唯一基线来源；WP-03 不复制 golden，也不在运行时改写 WP-02 目录。

## 9. 建议与待拍板（分开标注）

### 9.1 建议（未拍板）

- 把 `matrix.json` + `fixtures/` 作为 W0 故障分类的共享基线；WP-08/WP-09/WP-10 复用同一 `envelope` 语义，避免每个包各造一套故障码。
- 新增故障类时先加矩阵行 + fixture + 精确期望码，再加比较器分支；禁止只加代码不加 fixture。
- Rust 侧只复用 fixture JSON 与错误码，不复制 TS 注入器实现；注入器语义由本文件 §5.1 冻结。

### 9.2 待拍板

- `envelope` 是否升级为跨语言共享契约；若升级，按 `partition-table.md:133` 由 parent 签定并递增 `contract_rev`。
- 中断/超时/取消在真实 recorder 中是否需要记录更多字段（例如 durable checkpoint id、cancel reason、deadline 值）；当前 envelope 只有 `scenario` + `status`。
- 当前每类恰好 1 个 fixture（DoD 下限）。是否要求每类 ≥2 个不同注入位置，需 parent 决定。

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| WP-03 DoD（8 类 + meta-test + 统计门） | `RUST_FULL_MIGRATION_PLAN.md:257` |
| 包纪律：独立 build/test、独立临时 DB | `RUST_FULL_MIGRATION_PLAN.md:268` |
| oracle 零 diff；不得排序掉因果错误或过滤丢失事件 | `RUST_FULL_MIGRATION_PLAN.md:296` |
| 压测阈值按同环境重复基线签定 | `RUST_FULL_MIGRATION_PLAN.md:300` |
| WP-02/WP-03 提供记录与比较框架 | `RUST_FULL_MIGRATION_PLAN.md:320` |
| WP-03 manifest（owner/deps/owned_files/DoD） | `packages/chimera/specs/rust-host/manifest.yaml:88-107` |
| WP-03 分区 `T/faults/**` | `packages/chimera/specs/rust-host/partition-table.md:30,53` |
| 共享契约变更递增 `contract_rev` | `packages/chimera/specs/rust-host/partition-table.md:133` |
| WP-03 范围与 W0 四层出口 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:36,64` |
| 不写生产迁移代码 / 不编译新可执行体 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:50-51` |
| WP-02 把 fault matrix/比较器/统计门划给 WP-03 | `packages/chimera/test/oracle/transcript/README.md:186` |
| WP-02 负例清单（字节/结构层） | `packages/chimera/test/oracle/transcript/fixtures/negative-cases.ts:33-114` |
| WP-02 transcript 解析与编码 | `packages/chimera/test/oracle/transcript/format.ts:166-178,236-281` |
| WP-02 因果/重放判定 | `packages/chimera/test/oracle/transcript/verify.ts:198-318` |

## 11. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/compare/run.ts` | PASS（12/12 checks） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/compare/compare.test.ts` | 18 pass / 0 fail（63 expect calls） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/baselines/baselines.test.ts` | 17 pass / 0 fail（32 expect calls） |
| `cd packages/chimera && bun run test/oracle/baselines/measure.ts --runs 5 --check` | `BASELINE_OK` |

以上命令均在 `packages/chimera` 内运行；不写仓库内临时产物（WP-02 harness 的临时目录在 OS 临时目录并在每次运行后清理）。