# 控制面契约 · retention（30 天规则与 WP-05 矩阵衔接）

> 状态：契约阶段。`contract_rev = cr-2026-10-30-r1`。
> 机读清单：`packages/chimera/test/oracle/control/domains/retention.json`；行为 fixture：`packages/chimera/test/oracle/control/fixtures/retention/`。
> 权威来源：WP-05 `specs/rust-host/authority/ack-rollback-retention.md:236-280` 与 `specs/rust-host/authority/table-authority-matrix.md:20-58`。本文只补充控制面行为断言，不重写表级矩阵。

## 0. 结论先行

- **已拍板**：session 与图审计证据保留期均 **30 天**（`RUST_FULL_MIGRATION_PLAN.md:362`）。
- **session prune** 是显式 CLI（`chimera session prune --older-than 30d --yes`），默认 dry-run；没有自动定时任务。证据：`src/cli/cmd/session.ts:92-113`、`src/session/session.ts:847-940`。
- **图审计证据压缩** `compactCommittedChangeEvidence` 默认 `retentionDays = 30`；只处理 **已提交** 的 change event，重写 fact payload、删除旧 semantic snapshot/object。证据：`src/chimera/store.ts:290-294`、`:2700-2830`。
- **pending obligation 永不自动删除**；被 active obligation 引用的 change fact/event 也不得被压缩。证据：`src/chimera/store.ts:2704-2788`、`specs/rust-host/authority/ack-rollback-retention.md:262`。
- **短 TTL 与 30 天保留分开**：process registry 24h、turn lease 30min、edit-intent claim 2h、wake-priority 10min。证据见 §3。

## 1. 两类保留

| 类别 | 对象 | 窗口 | 触发方式 | 证据 |
|---|---|---|---|---|
| 会话数据 | `session` / `message` / `part` / `todo` / `work_brief` / `goal` / `tool_reveal` 等 | 30 天 | 显式 `chimera session prune`；默认 dry-run | `src/cli/cmd/session.ts:92-113`、`src/session/session.ts:847-940` |
| 图审计证据 | `chimera_change_event` / `chimera_change_fact` / `chimera_audit_run` / `chimera_oracle_result` / `chimera_semantic_snapshot*` | 30 天（仅已提交） | `compactCommittedChangeEvidence`；默认 dry-run，可选 vacuum | `src/chimera/store.ts:290-294,2700-2830` |
| 持久跟进 | `chimera_audit_obligation` | **不自动删除** | 必须 resolve/ignore | `src/chimera/store.ts:2971-3004` |
| 后台 job | `background_job` | 每 instance 500 行，按 `updated_at` 最旧优先 | live registry 持久化投影 | `src/agent/background-job.ts:171-172,244-261` |
| 短租约 | `session_turn_lease` | 30min TTL，renew 10min | 过期接管 | `src/session/turn-lease.ts:104,110` |
| 进程注册 | `chimera_process_registry` | 24h TTL；5 分钟清扫 | `sweepExpiredStoreRows` | `src/chimera/store.ts:2152,2244-2256` |
| 编辑意图 | `chimera_edit_intent_claim` | 默认 2h TTL | 显式 release / TTL | `src/chimera/store.ts:190,1789-1800` |
| 唤醒窗口 | `chimera_edit_intent_waiter` | 10min wake-priority | release 后 | `src/chimera/edit-intent.ts:53-62` |

## 2. 行为断言

### R1 · session prune 的选择规则

- 只选 `time_updated < cutoff` 的 session；cutoff = now - 30 天（或 CLI 传入窗口）。证据：`src/session/session.ts:847-940`。
- **保护非 idle 会话及其祖先**：`active` 集合来自 `SessionStatus.list()`（非 idle）与 running background job 的 owner；沿 `parent_id` 上溯加入 `protectedIDs`。
- **向下级联**：被选中的旧 root 会把较新的后代一起删除；dry-run 统计与 `remove()` 实际级联一致。
- 证据：`src/session/session.ts:873-940`。

### R2 · session prune 的默认安全

- CLI 默认 dry-run；只有 `--yes` 才真正删除。证据：`src/cli/cmd/session.ts:97-113`。
- 没有自动定时任务；不会因为 30 天到期自动删会话。
- 跨进程活跃 session 不可见（prune 使用本进程 `SessionStatus` 与 background job），保持与 session store 相同的单写者假设。证据：`src/session/session.ts:862-872`。

### R3 · 证据压缩的候选门控

`compactionCandidates` 只接受同时满足以下条件的事件：

1. 已提交（`gitFilesCommitted` 为 true）；
2. `finished_at <= cutoff`（默认 30 天）；
3. `actor_session_id !== options.activeSessionID`；
4. 关联 oracle 为 `pass` 且 `trusted`；
5. change fact/event 未被 active obligation 文本引用。

证据：`src/chimera/store.ts:2700-2788`、`:2794-2830`。

### R4 · active obligation 保护

- `activeObligationText` 读取 `chimera_audit_obligation` 中 `status NOT IN ('resolved','ignored')` 的 evidence/payload。
- 如果任一 change fact 的 `id` 或 `eventID` 出现在该文本中，整个 event 不进入候选。
- 证据：`src/chimera/store.ts:2695-2703`、`:2740-2788`。
- 推论：pending obligation 的事实只能通过 resolve/ignore 释放，不能被 30 天压缩“顺手”删除。

### R5 · 删除顺序与幂等

- `deleteEvents` 先删 `chimera_semantic_snapshot_ref`，再删 `chimera_semantic_snapshot`，再删 `chimera_change_fact`，最后删未被引用的 `chimera_semantic_object`。
- 重复执行同一窗口不应产生第二次删除（候选集合已为空）。
- 证据：`src/chimera/store.ts:2764-2788`。

### R6 · 压缩不改已应用迁移

- 证据压缩只做行级 delete/update，不新增/重排 migration；WP-05 矩阵中的 `migrator` 列保持权威。
- 证据：`specs/rust-host/authority/table-authority-matrix.md:20-58`、`src/chimera/store.ts:2794-2830`。

### R7 · 短 TTL 的独立性

| 对象 | TTL | 是否受 30 天规则影响 | 证据 |
|---|---|---|---|
| `session_turn_lease` | 30min | 否 | `src/session/turn-lease.ts:104` |
| `chimera_process_registry` | 24h | 否 | `src/chimera/store.ts:2152` |
| `chimera_edit_intent_claim` | 2h | 否 | `src/chimera/store.ts:190` |
| waiter wake-priority | 10min | 否 | `src/chimera/edit-intent.ts:62` |
| `request_idempotency` | 调用方写 `expires_at`；无清理任务 | 否（待 D14） | `specs/rust-host/authority/ack-rollback-retention.md:255` |
| `host_event` | 无裁剪任务 | 否（待 D9/D-R1） | `specs/rust-host/authority/ack-rollback-retention.md:254` |

### R8 · 跨库保留分开

- 主库 30 天策略不自动作用于项目图库；项目图库按审计证据压缩与 graph 派生数据重建策略分别处理。
- 证据：`specs/rust-host/authority/ack-rollback-retention.md:266`。
- 项目图库的 `chimera_*` overlay 表与 graph 核心表同库但版本线不同；不要用主库 Drizzle 迁移管理。证据：`specs/rust-host/authority/table-authority-matrix.md:60-120`。

## 3. 与 WP-05 矩阵的逐行衔接

WP-05 矩阵是权威；本契约只把与 30 天/短 TTL 相关的行列出来，便于 G0 交叉检查：

| 表 | WP-05 保留列 | 本契约断言 |
|---|---|---|
| `session` | 已拍板 30 天；显式 `chimera session prune`；无自动任务 | R1/R2 |
| `message` / `part` | 随 session 级联删除；compaction 只清 tool output，不删行 | R1 |
| `work_brief` / `goal` / `tool_reveal` | 随 session 级联删除 | R1 |
| `session_turn_lease` | TTL 30min + pid probe；过期接管 | R7 |
| `background_job` | 每 instance 500 行，按 updated_at 最旧优先 | §1 |
| `chimera_change_event` / `chimera_change_fact` | 30 天证据压缩 | R3/R5 |
| `chimera_audit_run` | 30 天证据压缩 | R3 |
| `chimera_audit_obligation` | **不随 30 天压缩删除 pending**；必须 resolve/ignore | R4 |
| `chimera_oracle_result` | 30 天证据压缩 | R3 |
| `chimera_semantic_snapshot*` / `chimera_semantic_object` | 30 天压缩删除；content-addressed 可重算 | R3/R5 |
| `chimera_process_registry` | 24h TTL；5 分钟清扫 | R7 |
| `chimera_edit_intent_claim` / `_waiter` | 2h TTL + 10min wake window | R7 |
| `host_event` | 无裁剪任务；D9 待拍板 | R7 |
| `model_telemetry_*` | 终态事件 compact → tombstone；D-R3 待拍板 | §4 待补 |
| `memory_*` | 软删除 + resetScope 硬删除；无时间 TTL | §4 待补 |

证据：`specs/rust-host/authority/table-authority-matrix.md`、`specs/rust-host/authority/ack-rollback-retention.md:245-276`。

## 4. 负例与不变量

| 编号 | 不变量 | fixture |
|---|---|---|
| N1 | 活跃会话及其祖先不得被 prune；旧 root 的后代要级联 | `retention/session-prune` |
| N2 | 活跃子会话保护其祖先，祖先即使过 cutoff 也不得删除 | `retention/active-parent-protects-child` |
| N3 | 只有 30 天前、已提交、pass+trusted、非 active session 的事件可压缩 | `retention/evidence-compaction` |
| N4 | active obligation 引用的事实不得删除 | `retention/evidence-compaction` |
| N5 | pending obligation 本身不得被 30 天压缩删除 | `CP-RET-003` + `CP-MUT-006` |
| N6 | 短 TTL 不得被 30 天规则覆盖 | `CP-RET-004`（待补） |

## 5. 已知限制

- fixture 不执行真实 SQLite 删除/VACUUM；只验证候选选择规则。
- process registry / turn lease / claim TTL 与 WP-05 矩阵逐行对齐仍是待补点。
- `host_event` 裁剪窗口、`request_idempotency` 清理、`model_telemetry_*` 是否移除（D-R3）均待 parent 拍板，本契约不擅自定值。
- session prune 没有自动定时任务；如果 Rust host 要引入定时 prune，必须先补“跨进程活跃会话可见性”与 dry-run 提醒，见 `specs/rust-host/authority/ack-rollback-retention.md:272` 的建议 S3。