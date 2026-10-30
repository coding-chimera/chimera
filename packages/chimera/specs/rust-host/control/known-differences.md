# WP-10 · 新增能力与已知差异（单列）

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 本文是 WP-10 DoD “新增能力与已知差异单列”的唯一汇总；各域清单里的 `new_capabilities` / `known_differences` 是本节的分域展开。

## 1. 本包新增的能力

| 编号 | 能力 | 位置 | 性质 |
|---|---|---|---|
| C1 | 343 语义点的版本化“点/桶 → owner → fixture 状态”映射 | `test/oracle/control/semantic-points.json` | 新增契约产物；不是生产行为 |
| C2 | 12 个控制域的机读清单（含 `待补` 点与 owner 角色） | `test/oracle/control/domains/*.json` | 新增契约产物 |
| C3 | 29 组合成行为 fixture（14 behavior + 15 negative），由纯参考 judge 执行 | `test/oracle/control/fixtures/**/*.json`、`fixtures/judges.ts` | 新增 fixture；不导入生产代码 |
| C4 | `control-check.ts`：计数、owner、引用闭包、schema、域覆盖、29/29 judge 一次校验 | `test/oracle/control/control-check.ts` | 新增校验脚本 |
| C5 | 控制面契约文档：mutation 链、MCP 三 transport、job family、retention | `specs/rust-host/control/*.md` | 新增契约文档 |
| C6 | 343 的“223 逐点 + 120 模块级桶”诚实拆分 | `semantic-points.json` 的 `source.explanation` | 新增证据口径；不伪造 mechanical 行号 |
| C7 | 域级 fixture 与 W-E 点的 `control_domains` 交叉链接（`existing-domain` 状态） | `semantic-points.json`、`domains/*.json` | 新增可机检的覆盖关系 |

**不声称是新增能力**：本包没有改生产代码、没有新增 CLI/工具/表/迁移、没有改 manifest 或 lockfile。上述 C1-C7 都是契约/fixture/文档。

## 2. 已知差异与缺口

### D1 · 343 只有 223 个逐点 file:line

- 事实：归档 `tool-output/tool_1817c7215001Jj52Lh6h4U02cg` 的 `nonMechanical` 数组有 223 项；12 个模块 `semanticsCount` 合计 343；`byClass.mechanical = 120`。
- 影响：120 个 mechanical 点没有逐点 `where`，本包用 12 个 bucket 承载，`fixture.status = pending`。
- 不做的补救：不把 bucket 拆成 120 条重复行，不编造 `file:line`。
- 需要的后续：如果 G0 要求 mechanical 点也逐点可审计，必须重新跑 W-E census 或从原始 worker 输出恢复逐点清单；这是新工作，不是本包能补的。

### D2 · 控制域 fixture 是合成参考判定，不是生产 parity

- `fixtures/judges.ts` 不导入 `packages/chimera/src/**`；它按契约文档的规则计算期望值。
- 因此 fixture 能防止“契约被误读”，但不能证明“生产 TS 与 Rust host 字节一致”。
- 真正的 parity 需要 WP-02 transcript + WP-03 comparator 的双臂录制；本包只提供控制面输入/期望形状。

### D3 · 343 映射的 fixture 状态不是“已逐点测试”

- 67 个 W-E 点关联到域级 behavior fixture（`fixture.status = existing-domain`），但这是 **域级** 关联，不是点级 parity；`existing` 预留给真正的点级 parity（当前为 0）。
- 156 个 W-E 点 + 120 个 mechanical 桶是 `pending`；`control-check.ts` 会打印 `existing-domain 67, existing 0, pending 276`（计数口径不变）。
- 因此不能把本包表述为“343 项已逐点测试”；正确表述是“343 项已逐点/逐桶映射，67 项有域级 fixture，276 项待补”。

### D4 · MCP 三 transport 的未覆盖面

- 没有 WebSocket MCP transport；三 transport 指 `stdio / StreamableHTTP / SSE`。证据：`src/mcp/index.ts:5-7`、`:282-303`。
- fixture 不建立真实连接、不执行 OAuth、不启动子进程；auth 短路与 transport 顺序是合成 attempts。
- finalizer 的 SIGTERM 后代清理（`src/mcp/index.ts:558-584`）与 instructions permission 门控（`src/session/system.ts:247-265`）仍是 `待补`。
- 远程 transport 的重连/退避不在本契约范围；当前只在 `create` 时顺序回退一次。

### D5 · job family 的 256 上限与 quota 作用域

- family 遍历硬上限 256（`src/session/activity.ts:49-70`）；超边界 family 的 quiescence/取消/claim 释放没有压测 fixture。计划明确要求这类 oracle：`RUST_FULL_MIGRATION_PLAN.md:284`。
- `BackgroundJob` quota 是 instance-scoped（按目录），不是 process-global；一个进程打开 N 个目录有 N 个池。证据：`src/agent/background-job.ts:327-340`、`src/effect/instance-state.ts:36-65`。
- 池满错误文案要求模型“complete or cancel”，但模型可能看不到/不能取消外部 job；这是已知陷阱，本包只记录，不修 quota 作用域或文案。
- dispose finalizer（`src/agent/background-job.ts:730-786`）有生产测试 `test/agent/background-job-dispose.test.ts`，但本包未复制成控制域 fixture。

### D6 · retention 的未拍板项

- `host_event` 无裁剪任务；窗口与 owner 待 D-R1。证据：`specs/rust-host/authority/ack-rollback-retention.md:254,270`。
- `request_idempotency` 的 `expires_at` 由调用方写，无清理任务；待 D14。证据：同上 `:255`。
- `session_turn_checkpoint` / `pending_request` / `host_worker` 终态行保留窗口待 D-R2。证据：`specs/rust-host/authority/ack-rollback-retention.md:276`。
- `model_telemetry_*` 是否在“遥测持久化移除”范围内待 D-R3。证据：`specs/rust-host/authority/table-authority-matrix.md:70-75`。
- session prune 没有自动定时任务；默认 dry-run。若 Rust host 引入定时 prune，必须先补跨进程活跃会话可见性。

### D7 · mutation 链的未覆盖面

- claim 队列公平性（wake-priority、yield、dead-host 清理）只有代码级证据，未做跨进程行为 fixture。证据：`src/chimera/edit-intent.ts:53-143`。
- 图未初始化时 predesign 门降级、claim 仍执行，只有代码级证据；fixture `CP-MUT-007` 仍是 `待补`。证据：`src/chimera/provenance.ts:1391-1400`。
- `chimera_audit_recent` 的 closeout unlock 与自动 audit 的交互未做跨进程 fixture。
- obligation 的 `stale` 重放生命周期（`replayable` / `missing_target`）只有代码级证据。

### D8 · compaction 的未覆盖面

- 远程压缩资格/失败回退（`src/session/compaction.ts:569-651`）没有控制域 fixture；WP-08 provider profile 覆盖 provider 侧，本包只记录回退契约。
- `time_compacting` 的 ensuring 清理（`src/session/compaction.ts:735-780`）需要真实 DB + 中断注入；WP-03 fault matrix 可复用。
- `PRUNE_PROTECTED_TOOLS` 源码当前为 `["skill"]`（`src/session/compaction.ts:42`）；fixture 用 `skill` 作代表，不覆盖未来新增的受保护工具。

### D9 · prompt assembly 的未覆盖面

- `system_context` epoch 复用/delta/压缩跨越（`src/session/system-context.ts`、`src/session/context-epoch.ts`）默认关闭，未做控制域 fixture。
- provider/overlay/ultra 分段 memo 上限 64（`src/session/system.ts:113-139`）是性能/内存边界，未做 fixture。
- fixture 只断言 key 顺序与门控，不比较真实 txt 内容字节。

### D10 · tool_search 的未覆盖面

- `tool_reveal` 持久化、session 级联删除、LRU 256（`src/session/tool-search.ts:373-420`）未做控制域 fixture。
- OpenAI-native `tool_search` 的 wire 形状由 WP-08 `provider` fixture 覆盖；本包只记录 gate 条件（`src/session/tool-search.ts:249-290`）。
- alias 归一化（`tool-search` → `tool_search`）只有代码级证据，未做行为 fixture。

### D11 · goal / skills / instructions / workbrief / config 的待补点

| 域 | 待补点 | 证据 |
|---|---|---|
| goal | token 预算按会话子树累计、DB 恢复、continuation 计数跨重启 | `src/session/goal.ts:293-348` |
| skills | permission 过滤、builtin 不可覆盖、URL pull 失败策略 | `src/skill/index.ts:100-203`、`src/session/system.ts:230-242` |
| instructions | per-message 去重、向上发现、远程 fetch 失败降级 | `src/session/instruction.ts:168-220` |
| workbrief | `Event.Updated` 发布、DB 行生命周期 | `src/session/work-brief.ts:132-145` |
| config | `resolve()` provenance 四元组、环境开关、bootstrap 失败隔离 | `src/config/config.ts:407-450,912-921`、`src/project/bootstrap.ts:53-64` |

## 3. 需要 parent 拍板的事项

| 编号 | 事项 | 为什么需要拍板 |
|---|---|---|
| P1 | mechanical 120 点是否必须逐点 file:line | 需要重跑 W-E census；本包不伪造 |
| P2 | 343 映射的 `existing-domain` 是否接受“域级 fixture”而非点级 parity | 影响 G0 对 WP-10 出口的判定口径 |
| P3 | `BackgroundJob` quota 作用域是否改为 process-global 或 session-scoped | 涉及可见性不对称与错误文案；不能只改 quota |
| P4 | `host_event` 裁剪窗口/owner（D-R1） | WP-05 建议 S1；本包不擅自定值 |
| P5 | `model_telemetry_*` 是否移除（D-R3） | 影响 retention 域 `CP-RET-006` |
| P6 | claim 队列公平性是否需要跨进程 oracle | 当前只有代码级证据 |

## 4. 复现与验证

```bash
cd packages/chimera
bun test/oracle/control/control-check.ts
bun test --timeout 30000 test/oracle/control/control.test.ts
```

期望：`PASS semantic points: 223 enumerated + 12 buckets = 343`、`PASS judges: 29/29`、`1 pass / 0 fail`。