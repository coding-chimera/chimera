# 控制面契约 · mutation 链（predesign → claim → audit → oracle → obligation）

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 本文只读引用生产实现，不写迁移代码。机读清单：`packages/chimera/test/oracle/control/domains/mutation-chain.json`；行为 fixture：`packages/chimera/test/oracle/control/fixtures/mutation-chain/`。

## 0. 结论先行

mutation 链不是“一次写文件”，而是五个可独立失败的 gate：

```text
predesign（预设计证据）
  → edit-intent claim（跨 session 文件占用）
  → mutation（实际写入）
  → audit（自动传播审计记录）
  → oracle（验证证据）
  → obligation（持久跟进项）
```

- **predesign gate**：只在图已初始化、文件高风险、且当前 agent 确实能调用 `chimera_predesign` 时要求新鲜 predesign；否则降级放行。
- **claim gate**：对所有声明文件生效，与风险分类、图初始化、predesign 可用性都无关；冲突时 `blockedBy = "edit-intent-claim"`。
- **audit 是系统侧自动记录**：`trackToolMutation` 在 mutation 成功后写 `AuditRunRecord(source = "track-tool-mutation")`；closeout 不再要求模型手动调用 `chimera_audit_recent`。
- **oracle 只提供证据，不自动改文件**：linked failing/unknown oracle 进入 closeout 信号，模型必须处理或显式驳回。
- **obligation 是持久状态机**：`pending / claimed / resolved / ignored / stale`；active obligation 阻断 closeout，retention 不得静默删除。

## 1. 状态机

| 状态 | 进入条件 | 允许的下一步 | 证据 |
|---|---|---|---|
| `predesign-required` | 图初始化 ∧ 高风险文件 ∧ predesign 工具可用 ∧ 无新鲜记录 | `predesign-recorded` 或 `blocked(predesign)` | `src/chimera/provenance.ts:1353-1420` |
| `claim-blocked` | 声明文件与外部 family 的 claim 冲突 | `claim-released` 后重新尝试 | `src/chimera/provenance.ts:1366-1390` |
| `mutation-success` | 工具 effect 成功 | `audit-recorded` | `src/chimera/provenance.ts:1153-1256` |
| `mutation-failure` | 工具 effect 失败 | `provenance-recorded`（status=failure）+ `audit-recorded`（status=failure，changeFacts=0）；不写 change facts | `src/chimera/provenance.ts:1195-1256` |
| `audit-recorded` | mutation 成功自动写 audit run | `oracle-linked` / `closeout` | `src/chimera/provenance.ts:1238-1256` |
| `oracle-linked` | oracle 与 change fact 按文件/时间链接 | `closeout` 或 `closeout-blocked` | `src/chimera/provenance.ts:569-594` |
| `obligation-pending` | audit 发现传播候选 | `claimed` / `resolved` / `ignored` | `src/tool/chimera.ts:2132-2276` |
| `obligation-stale` | 目标节点从当前图消失 | 保持 stale，等待重新审计 | `src/tool/chimera.ts:2223-2260` |

## 2. 行为断言

### A1 · predesign gate 的适用条件

- 图未初始化时，predesign gate **降级关闭**；mutation provenance 也不活跃。证据：`src/chimera/provenance.ts:1391-1400`。
- 图已初始化但 `chimera_predesign` 对当前 agent 不可见/被 deny 时，不要求 predesign，避免“要求一个无法调用的工具”造成死锁。证据：`src/chimera/provenance.ts:1280-1351`。
- 高风险文件（按 `predesignRisk` 分类）且工具可用且无同 session、同文件的新鲜 predesign 时，返回 `blockedBy = "predesign"`，并附带 replay stash。证据：`src/chimera/provenance.ts:1353-1420`。
- 低风险文件即使没有 predesign 也放行；在至少一个文件高风险时，`destructive`/`rename`/`multiFile` 会把 `required` 提升为 true。证据：`src/chimera/provenance.ts:1358-1365`。

### A2 · edit-intent claim gate 的独立性

- claim 检查在 predesign 判定之前执行；冲突直接返回 `blockedBy = "edit-intent-claim"`，不进入 predesign 分支。证据：`src/chimera/provenance.ts:1366-1390`。
- claim 对所有声明文件生效，**与风险分类、图初始化、predesign 可用性无关**。证据：`src/chimera/provenance.ts:1366-1374`。
- 同一 session family（parent/child 链）互不阻塞；不同 family 的 earliest claim 优先，后到者排队为 waiter。证据：`src/chimera/edit-intent.ts:252-372`。
- claim 默认 TTL 2 小时；显式 release 优先于 TTL。证据：`src/chimera/store.ts:190`、`src/chimera/edit-intent.ts:112-143`。
- release 会唤醒 waiter；woken waiter 有 10 分钟 wake-priority 窗口。证据：`src/chimera/edit-intent.ts:53-62`、`:372-410`。

### A3 · mutation 成功后自动 audit

- `trackToolMutation` 在 effect 成功时：
  1. 写 `ToolMutationRecord` 到 provenance artifact；
  2. 写 change facts；
  3. 写 `AuditRunRecord`，`source = "track-tool-mutation"`、`provenanceID = record.id`、`changedFiles`、`snapshotRevision`、`seedNodes: []`、`obligations: []`。
  证据：`src/chimera/provenance.ts:1195-1256`。
- mutation 失败时写 provenance（`status = "failure"`），不写 change facts；仍写 `AuditRunRecord`（payload.status=failure、changeFacts=0），因此 closeout 不会把失败 mutation 误判为缺少 audit。证据：`src/chimera/provenance.ts:1228-1256`。
- 自动 audit 记录的存在意味着 closeout 不需要模型再调用 `chimera_audit_recent`；只有自动记录缺失（图降级）时 closeout 才要求手动审计。证据：`src/chimera/prompt-context.ts:249-286`。

### A4 · oracle 证据链接与 closeout

- oracle 记录包含 `linkedChanges`；链接按文件与 mutation 完成时间匹配（`oracleFinishedAt >= mutationFinishedAt`）。证据：`src/chimera/provenance.ts:569-594`。
- 只有 `status = "pass"` 且 `trusted = true` 的 oracle 能作为可信验证；failing/unknown 进入 closeout 信号。证据：`src/chimera/prompt-context.ts:345-362`。
- linked failing/unknown oracle 会在 runtime context 的 `Linked Verification Evidence` 段内联一行摘要（命令、exit、最后一行输出、`oracle:<id>`），不要求模型先展开全文。证据：`src/chimera/prompt-context.ts:334-362`、`:531-541`。
- closeout 判定：`failing/unknown oracle` → `warn`/`block`（apocalypse 模式）；`pass` 不产生阻断。证据：`src/chimera/prompt-context.ts:242-286`。

### A5 · obligation 生命周期

- audit 候选按 `fingerprint = sha256(source, target, evidence, reason)` 去重；同 fingerprint 再次同步只更新字段，不重复插入。证据：`src/tool/chimera.ts:2132-2216`。
- 新 obligation 初始 `status = "pending"`；`sync` 只创建/更新，不自动 resolve。证据：`src/tool/chimera.ts:2146-2216`。
- `claim` 把 pending/stale 置 claimed；`resolve` 置 resolved 并记录可选 note；`ignore` 置 ignored 并要求 reason。证据：`src/tool/chimera.ts:3485-3625`。
- `refreshStaleObligations` 在目标节点从当前图消失时置 `stale`，并记录 `replayLifecycle.status = "missing_target"`；节点仍存在但 revision 不同则 `replayable`。证据：`src/tool/chimera.ts:2223-2260`。
- active obligation（非 resolved/ignored）阻断 closeout；`resolve`/`ignore` 是唯一清除方式。证据：`src/chimera/prompt-context.ts:242-286`、`src/tool/chimera.ts:2267-2276`。

### A6 · retention 与 mutation 链的交互

- 证据压缩只处理 **已提交**（`gitFilesCommitted`）且 30 天前的 change event。证据：`src/chimera/store.ts:2794-2830`。
- 被 active obligation 引用的 change fact/event 不得删除；`compactionCandidates` 用 `activeObligationText` 做子串保护。证据：`src/chimera/store.ts:2704-2788`。
- 活跃 session 的证据不压缩；`options.activeSessionID` 排除该 session 的 event 与 oracle。证据：`src/chimera/store.ts:2718-2760`。
- pending obligation 本身永不进入 30 天压缩；必须显式 resolve/ignore。证据：`specs/rust-host/authority/table-authority-matrix.md` 的 `chimera_audit_obligation` 行。

### A7 · 降级图行为

| 条件 | predesign gate | claim gate | auto audit | closeout 信号 |
|---|---|---|---|---|
| 图未初始化 | 关闭 | **仍执行** | 不写（无图） | “latest audit evidence: none recorded” 只在有 mutation 时提示手动审计 |
| 图初始化、predesign 工具不可用 | 关闭 | 仍执行 | 写 | 正常 |
| 图初始化、predesign 可用、低风险 | 放行 | 仍执行 | 写 | 正常 |
| 图初始化、predesign 可用、高风险、无新鲜 predesign | 阻断 | 先检查 | 不写 | 不进入 closeout |

证据：`src/chimera/provenance.ts:1353-1420`、`src/chimera/prompt-context.ts:249-286`。

## 3. 负例与不变量

| 编号 | 不变量 | fixture |
|---|---|---|
| N1 | 高风险 mutation 无新鲜 predesign 必须 `blockedBy = predesign` | `mutation-chain/predesign-gate` |
| N2 | 外部 claim 冲突必须 `blockedBy = edit-intent-claim`，与风险无关 | `mutation-chain/claim-conflict` |
| N3 | pending obligation 未 resolve/ignore 时 closeout 不得通过 | `mutation-chain/closeout-obligation` |
| N4 | linked oracle fail 时 closeout 必须要求处理证据 | `mutation-chain/oracle-fail-closeout` |
| N5 | mutation 成功但 audit 缺失时 closeout 必须提示手动审计 | `mutation-chain/audit-missing` |
| N6 | 证据压缩不得删除 active obligation 引用的事实 | `retention/evidence-compaction` |

## 4. 与 WP-05 / WP-09 的衔接

- **WP-05**：`chimera_change_event`、`chimera_change_fact`、`chimera_audit_run`、`chimera_audit_obligation`、`chimera_oracle_result` 的 owner/保留/换权列见 `specs/rust-host/authority/table-authority-matrix.md`。本契约只补充行为断言，不重写表级权威。
- **WP-09**：hook 轨迹的 `tool.execute.before/after` 与 `config` hook 可能改变 mutation 输入；mutation 链以最终工具 effect 为准，不以 hook 中间态为准。证据：`specs/rust-host/plugin/hook-matrix.md`、`src/chimera/provenance.ts:1153-1256`。
- **WP-02**：mutation 链的录制应复用 transcript 的 `tool.call`/`tool.result`/`db.write` 事件形状；本包不新增第二套 transcript 格式。证据：`packages/chimera/test/oracle/transcript/format.ts:1-140`。

## 5. 已知限制

- fixture 不执行真实图分类、LSP 诊断、跨进程 claim 唤醒；只验证 gate 判定与 closeout 理由。
- `chimera_audit_recent` 的 closeout unlock 与自动 audit 的交互只在 prompt-context 代码级证据中记录，未做跨进程行为 fixture。
- claim 队列公平性（wake-priority、yield、dead-host 清理）仍是待补点；WP-10 只冻结“冲突即阻断”的主路径。