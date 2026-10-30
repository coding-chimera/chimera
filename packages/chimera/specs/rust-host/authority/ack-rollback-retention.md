# ACK / 回退 / 保留契约（WP-05）

状态：契约阶段。contract_rev：`cr-2026-10-30-r1`。基线 HEAD：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
本文件把 `RUST_FULL_MIGRATION_PLAN.md` §10（统一门禁）的写路径要求展开成可执行契约；引用 `recovery-matrix.md` / `h2-data-plane.md` 的既有语义时只做收窄，不另发明同义状态。

## 1. 术语与边界

| 术语 | 含义 | 不成立的误读 |
|---|---|---|
| ACK | 对“已 durable”事实的确认；确认前该事实不得对外宣称成功 | ACK 不是“已发送”，也不是“已写入内存” |
| durable checkpoint | 跨重启可读的进度标记：`session_turn_checkpoint.last_message_id/last_event_seq`、投影库 `projection_checkpoint.last_seq` | 日志行、内存游标、SSE 队列都不是 checkpoint |
| drain | 停止接受新写，完成在途写并落 checkpoint，再允许换权/退出 | drain ≠ 立即 kill；drain 超时才升级终止 |
| writer fencing | 用 generation/CAS 拒绝旧写者，保证同一表同一时刻只有一个写者 | SQLite 的 `SQLITE_BUSY` 不是业务 fencing |
| 换权 | 把某张表/某个数据面的权威写者从旧实现切到新实现（或反向） | 换权不是只改一个配置开关；写路径回退必须先 drain + checkpoint + fencing |
| retention floor | 保留窗口的起始游标；小于它的 replay 请求必须返回 `stream_reset`，不得伪造连续 | 裁剪不是“删旧行”这么简单；未 ACK 的事实不得被裁掉 |

**边界**：本契约覆盖主应用库（Drizzle）与项目图库（graph + Chimera overlay）两张 SQLite 文件；不覆盖 provider 流、PTY 字节流、plugin module cache 等可丢弃执行态。跨库没有分布式事务（`h2-data-plane.md` §4.3、`recovery-matrix.md` §5.4）。

## 2. 写路径 ACK 契约

### 2.1 分层：host-control ACK 与 worker session 确认是两段

H1 的事实是：session/message/part 仍由 Bun worker 写，host 只写 host-owned 控制表；因此不能假装“checkpoint + message/part + event 在一个事务里”。契约拆成两段（`recovery-matrix.md` §5.1）：

1. **host-control commit-before-ack**：host 自己的表先落库，再向客户端/worker 确认。
2. **worker session commit confirmation**：worker 提交 message/part 后发 `commit.confirm`，host 只读校验并推进 checkpoint/event；host 不写 session 行。

H2 把 session 写者切到 host 后，第 2 段退化为同一 SQLite 事务内的内部函数调用；在第 1 段仍然成立前，不得把两段合并宣称原子。

### 2.2 host-control commit-before-ack（当前必须遵守）

| 动作 | 必须先落库（host-owned） | 之后才能 |
|---|---|---|
| 接受 turn | `session_turn_checkpoint`（`accepted`） | 返回 turn id |
| 开始工具调用 | checkpoint 记录 `tool_call_id` + intent | worker 执行副作用 |
| 发出 permission/question | `pending_request` 行（`pending`，稳定 `request_id`） | 发布 `*.asked` |
| 回复 permission/question | 先写答案 + generation 校验 | 唤醒 worker |
| 发布 durable event | `host_event` 插入成功（含 `seq`/`aggregate_seq`/`dedupe_key`） | SSE 广播 / 返回 200 |
| 接受 job start | `request_idempotency` 行（`in_flight`） | 转发给 worker 启动 Fiber |
| 取消 | checkpoint 的 `cancel_requested_at` | 发 cancel 帧 |

证据：`recovery-matrix.md` §5.1.1；host 表结构 `src/storage/tables/host.sql.ts:57-166`；Rust 写入口 `chimera-host/src/store.rs:512-786`。

### 2.3 worker session commit confirmation（H1 补偿协议）

```text
host   ── turn.accepted(checkpoint=accepted) ──▶ worker
worker ── execute ──▶ 本地 SQLite 事务提交 message/part/session_message
worker ── commit.confirm(turn_id, turn_generation, worker_generation,
                         commit_token, last_message_id, part_watermark) ──▶ host
host   ── 事务：锁定 checkpoint；校验 generation；
          只读校验 message/part 行存在且属于该 turn；
          写 commit_state=confirmed + status=completed；
          插入 host_event(dedupe_key=turn:<turn_id>:completed) ──▶ ack
```

规则（`recovery-matrix.md` §5.1.2）：

1. **host 不写 session 行，只读校验。** 完成判定是 host 读到完整行，不是 worker 单方面声明。
2. **`commit_token` 是确认幂等键。** 同 token 重发返回同一 ack；不同 token 但同一 turn + generation 视为重复确认并记录诊断。
3. **确认前崩溃 = `committed_unconfirmed`。** checkpoint 非终态但 session 行完整 → 恢复为 `completed(recovered_confirmation)`；行不完整 → `interrupted`。
4. **不自动重放副作用。** 只允许“确认已存在的行”，不允许重新执行工具调用。
5. **原子性缺口显式记录。** host checkpoint 事务与 worker session 事务是两次提交；中间崩溃由确认/补偿收敛。
6. **H2 收口。** session 写者切到 host 后，`message/part` 与 checkpoint/event 同事务，`commit.confirm` 退化为内部调用。

当前 schema 已有 `commit_state`/`commit_token`/`last_message_id`（`src/storage/tables/host.sql.ts:67-75`），但 `part_watermark` 列尚未添加，`commit.confirm` 帧处理也未实现（`recovery-matrix.md` §5.1.2 状态注记）。

### 2.4 durable event append-before-ack

- `host_event.seq` 是全局 durable 游标，`aggregate_seq` 是单 aggregate 顺序，`transport_sequence` 是单连接传输序号；三者互不推算（`recovery-matrix.md` §5.3.2）。
- 取号 + 插入必须在同一事务内；禁止先广播后落库。
- 同 `dedupe_key` 或同 `(aggregate_id, aggregate_seq)` 重复写入是幂等冲突，返回已有行，不递增 seq。
- `seq` 缺口视为数据损坏：host 进入 `degraded`，不得宣称 replay 可用。
- `Last-Event-ID` 只映射 `host_event.seq`；小于 `retention_floor_seq` 时返回 `stream_reset` + 当前快照游标。
- 实现证据：`src/storage/tables/host.sql.ts:144-166`；`chimera-host/src/store.rs:744-786`。

### 2.5 幂等键

| 入口 | 幂等键 | 作用域 | 重复请求行为 |
|---|---|---|---|
| prompt / turn start | `(session_id, idempotency_key)`；无 key 时 `(session_id, turn_id)` | session | 返回第一次的 turn，不新建 |
| job start | `(instance_directory, job_id, generation)` 或 `(instance_directory, owner_session_id, idempotency_key)` | job（instance-scoped） | 返回既有 job 快照 |
| permission / question reply | `request_id` + `generation` | request | 同 generation 返回已存答案；旧 generation 409 |
| cancel | `(turn_id, cancel_request_id)` | turn | 幂等；重复 cancel 返回同一终态 |
| worker command | `(worker_generation, correlation_id)` | worker | worker 去重 |
| durable event append | `dedupe_key` 唯一 | aggregate/event | 忽略/返回已有行，不递增 seq |

规则：幂等键必须持久化；没有幂等键的写入口不得暴露为可重试 API；幂等记录必须有 TTL（过期重复 key 返回 `idempotency_expired`）。证据：`recovery-matrix.md` §5.2；`src/storage/tables/host.sql.ts:123-142`。

### 2.6 ACK 故障矩阵

| 故障 | 必须保证 | 处理 |
|---|---|---|
| ACK 丢失 | 客户端可安全重试 | 同幂等键重试返回第一次结果；不产生第二个 turn/job/approval |
| ACK 重复 | 不重复插入事件/不推进 seq | `dedupe_key` / `commit_token` 幂等 |
| ACK 乱序 | durable 顺序不靠到达顺序 | `host_event.seq`/`aggregate_seq` 在事务内取号；乱序帧只影响传输 |
| 部分写 | 投影库不得出现半行 | 每批投影 + checkpoint 同事务；崩溃回滚到上一 checkpoint |
| 崩溃在 checkpoint 前 | 重启可重放 | 从最后 durable checkpoint 重放；幂等 `INSERT OR IGNORE` |
| 崩溃在投影后、ACK 前 | 不得重复副作用 | ACK 游标只在投影 checkpoint 追上权威高水位后前进 |
| cancel vs complete 竞态 | 终态只落一个 | commit 先到 → `completed`；cancel intent 先到 → `cancelled`（`recovery-matrix.md` §5.5 #4） |
| 旧 generation 写入 | 不得改变终态 | 事务内比较 generation；不匹配返回 `stale_generation` |
| `SQLITE_BUSY` | 不静默丢写 | `busy_timeout=5000` + 有界重试；最终 `storage_busy`（`h2-data-plane.md` §4.3） |
| drain 超时 | 不无限等待 | 升级 `SIGTERM` → `SIGKILL`；终态仍按 cancel intent 收敛 |

## 3. Durable checkpoint 契约

### 3.1 必须持久化的字段

| 载体 | 字段 | 语义 |
|---|---|---|
| `session_turn_checkpoint` | `turn_id`/`turn_seq`/`generation`/`status`/`commit_state`/`commit_token`/`last_message_id`/`last_event_seq`/`cancel_requested_at`/`resume_policy`/`side_effect_state` | turn intent、提交状态、恢复策略、副作用状态 |
| `pending_request` | `request_id`/`request_key`/`generation`/`status`/`expires_at` | 请求生命周期；重新发布只递增 generation |
| `host_event` | `seq`/`aggregate_seq`/`dedupe_key` | durable 事件游标与幂等 |
| 投影库（本包演练模型） | `projection_checkpoint.last_seq` + `projection_row` | 跨库投影进度与已投影事实 |

证据：`src/storage/tables/host.sql.ts:57-121,144-166`；`recovery-matrix.md` §4.3/§4.6。

### 3.2 恢复状态

- turn：`accepted → running → waiting_* → cancelling → cancelled/completed/failed/interrupted`；`interrupted` 不等于 `failed`（`recovery-matrix.md` §4.3）。
- job：保留 `running/completed/error/cancelled` 四状态，另加 `recovery_state = none|interrupted|recoverable|recovered|abandoned`；不重命名现有状态（`recovery-matrix.md` §4.4）。
- `resume_policy = none` 的 turn/job 一律 `interrupted`；`retry_safe` 且身份匹配才可 `recoverable`；绝不静默重跑有副作用的工具调用。
- `side_effect_state = unknown` 时要求人工/上层策略确认，不得自动重试（`recovery-matrix.md` §6.1 “重试”）。

### 3.3 终态优先级

1. 已提交终态不可覆盖（`completed`/`cancelled`/`failed`/`interrupted`）。
2. cancel intent 优先于 crash：已记录 `cancel_requested_at` 的 turn，即使 worker 随后崩溃，终态是 `cancelled`。
3. crash sweep 只处理未提交终态，且只处理与死亡 worker generation 匹配的行。
4. 完成优先于 cancel 的竞态：`commit.confirm` 先提交则 `completed`；cancel intent 先提交则 `cancelled`。
5. `failed` 只来自当前 generation 的显式失败确认；崩溃推断只能是 `interrupted`。
6. missing-event 竞态：worker 已提交 session 行但 host 写 `host_event` 前崩溃时，按 `commit_token`/`dedupe_key` 补写一次事件；已存在则复用，不重复分配 seq。

证据：`recovery-matrix.md` §5.5。

## 4. Writer fencing 与换权

### 4.1 generation 层级（互不替代）

| 层级 | 分配者 | 存储 | 作用域 | 递增时机 | 不匹配行为 |
|---|---|---|---|---|---|
| `host_generation` | host | `host_state.host_generation` | 整个数据库 | 每次 host 启动；只增不减 | 回退 fail closed，不启动 worker |
| `worker_generation` | host | `host_worker.generation` | workspace | 每次 spawn/resume worker | 旧 worker 帧丢弃并记 `stale_generation` |
| `turn_generation` / pending `generation` | host | `session_turn_checkpoint.generation` / `pending_request.generation` | turn / request | turn 被新执行接管；request 重新发布 | 旧 turn/request 写入不得改变终态 |
| `background_job.generation` | Bun（H1）/ host（H2） | `background_job.generation` | 单个 job_id | 同一 job 开始新一次 run | 旧 run 的完成/失败通知不得覆盖新 run |

规则：任何 worker→host 写帧必须携带 `(worker_id, worker_generation, correlation_id)`；涉及 turn/request/job 还要携带各自 generation；任何 host→worker 命令帧携带 `expected_generation`；旧 generation 的完成/失败通知只用于诊断。证据：`recovery-matrix.md` §5.3.1；`src/session/turn-lease.ts:104-110`（lease 30min / renew 10min）。

### 4.2 表级单写者

- 任一表任一时刻只有一个写入方；由表所有权注册表 + 启动断言保证，不依赖 SQLite（`h2-data-plane.md` §4.3）。
- 同一事务内不跨库；需要跨库一致性时用 outbox/补偿，不允许分布式事务假象（`recovery-matrix.md` §5.4）。
- 长事务禁止包住 provider 流或工具执行；只包住“取号 + 插入 + 状态迁移”。

### 4.3 换权前置（写路径）

每张表/每个数据面翻转前必须同时满足（`h2-data-plane.md` §4.4-§4.5）：

1. **shadow 对账窗口内零差异**：10k 次写或 24h（先到者）内字段缺失/值不同/行缺失/重复行均为 0；任何非零都阻止 flip。
2. **读路径已在 host 上运行至少一个发布周期**；读结果 parity 通过。
3. **故障注入矩阵通过**：丢失/乱序/重复/中断/部分写/超时/取消/重放 8 类（WP-03 fault matrix）。
4. **回退演练通过**：关闭该表开关后 Bun 能读到完整数据并继续写。
5. **durable checkpoint 已确认**：换权前最后一次写已落 checkpoint；未确认的 `committed_unconfirmed` 必须先按 §2.3 收敛。
6. **writer fencing 已生效**：新 generation 已分配，旧 generation 写入被拒绝。

### 4.4 换权顺序（H2 §4.4）

| 序 | 表 | 切换前必须完成 | 回退 |
|---:|---|---|---|
| 0 | `host_worker`/`host_state`/`session_turn_checkpoint`/`pending_request`/`host_event`/`request_idempotency` | H1 已由 host 写 | 关闭 host 写，旧路径忽略这些表 |
| 1 | `session_turn_lease` | 增加 `turn_id`/`worker_generation`/`renewed_at`；host 接管 acquire/release CAS | Bun 重新接管 lease |
| 2 | `background_job` | 增加 `owner_worker_id`/`worker_generation`/`recovery_state`/`cancel_requested_at`/`request_id`；host 接管 open-time reconcile | Bun write-through 恢复 |
| 3 | `workspace` | workspace control-plane parity 通过 | Bun control-plane 恢复 |
| 4 | `session` | session metadata 读写 parity；checkpoint 与 session 同事务 | Bun 恢复写 |
| 5 | `session_message` | v2 投影 parity | Bun 恢复写 |
| 6 | `message` | 消息提交与 checkpoint/event 同事务 | Bun 恢复写 |
| 7 | `part` | `part_watermark` 生效；part reconcile 由 host 承担 | Bun `part-reconcile` 恢复 |
| 8 | `permission.data` | approved ruleset 读写 parity | Bun 恢复写 |

不切换：`event`/`event_sequence`（实验 flag，继续由 Bun/实验路径维护；host 用 `host_event`）；`chimera_process_registry` 属项目库，按 `h2-data-plane.md` §3.7 单独切换。

### 4.5 迟到写者

- H1 无法在 SQLite 层阻止旧 worker 继续 append session 行；迟到行按 `turn_id` 隔离为历史，不得被当成当前 turn 的提交（`recovery-matrix.md` §5.1.3）。
- host 只接受与当前 `turn_generation` + `worker_generation` 匹配的 `commit.confirm`；旧 generation 返回 `stale_generation`。
- 旧 generation 的 event 不分配新 seq，不进入 replay log。
- 监控 `stale_generation_rejected_total` 必须可观测；持续非零说明 supervisor 或 fencing 有 bug。

## 5. 回退契约

### 5.1 kill switch 粒度

优先级 **route > plane > mode**（`h2-data-plane.md` §4.6）：

| 开关 | 取值 | 作用 |
|---|---|---|
| `CHIMERA_HOST_MODE` | `legacy` / `proxy` / `rust` | 进程级 |
| `CHIMERA_HOST_PLANE_<PLANE>` | `legacy` / `shadow` / `enforce` / `off` | 单数据面：GRAPH/WATCH/STORAGE/STATIC/SSE/WORKSPACE/PROCESS |
| `CHIMERA_HOST_ROUTE_<OPERATION>` | `legacy` / `proxy` / `rust` | 单 OpenAPI operation |

- 未识别开关值启动时 `unknown_kill_switch` 拒绝该面，不猜默认。
- route/plane 级开关必须能热重载；进程级 `CHIMERA_HOST_MODE` 允许要求重启。
- 单面失败写 `PlaneHealth { plane, state: ready|degraded|unavailable, reason }`；一个面 `unavailable` 不阻止 host `ready`，也不阻止其他面。

### 5.2 写路径回退序列（不可省）

1. **停止新写**：关闭对应 plane/route 写入口，拒绝新 turn/job/命令。
2. **drain**：完成在途请求；drain deadline 到达仍不退出则升级终止；终态按 cancel intent 收敛。
3. **确认 durable checkpoint**：checkpoint 的 `commit_state`/`last_message_id`/`last_event_seq` 已落库；`committed_unconfirmed` 按 §2.3 收敛。
4. **writer fencing/换权**：递增 generation，拒绝旧写者；旧实现只读或关闭。
5. **验证旧版完整读写兼容**：旧二进制能读到新表/新列/新行，能继续写；WAL 未 checkpoint 也要能恢复。
6. **切换开关**：关闭 plane/route，恢复 Bun 直连；不提供 down migration。
7. **观察一个发布周期**：旧实现至少保留一个发布周期，之后才允许删除兼容代码/表。

证据：计划 §10:298；`h2-data-plane.md` §4.2、§4.7。

### 5.3 旧版兼容一个发布周期

- 旧实现至少保留一个发布周期；期间新表/新列只允许 additive，不得让旧路径依赖新表作为唯一来源。
- 回退后旧路径不得依赖新表；若某表已 writer flip，回退前必须确认旧路径能读到完整数据。
- `host_generation` 一旦前进，旧二进制不得写回更小值；回退后的新 host 启动继续递增。
- 旧 worker 的迟到 session 行按 `turn_id` 隔离，不隐藏、不改变当前终态（`h2-data-plane.md` D11）。

### 5.4 回退演练清单

必须覆盖（`h2-data-plane.md` §4.7）：

- [ ] 已有新表/新列，旧路径仍可读写。
- [ ] WAL 未 checkpoint（`-wal` 非空）时旧路径能恢复。
- [ ] 旧 worker 仍持有 lease（`session_turn_lease` 未过期）。
- [ ] SSE 客户端带 `Last-Event-ID` 重连，窗口内可 replay、窗口外 `stream_reset`。
- [ ] `commit_state=committed_unconfirmed` 的 checkpoint 能按 §2.3 收敛。
- [ ] 旧 generation 写入被拒绝，且 `stale_generation_rejected_total` 可观测。
- [ ] 跨库投影库落后于权威库时，重放幂等且无 phantom。

## 6. 保留契约

### 6.1 已拍板

- **session 与图审计证据保留期均 30 天**（计划 §13:362）。
- 遥测 DB 持久化移除；调度速度信号改进程内存态（计划 §13:363）。注意：`model_telemetry_*` 仍在写，范围待 D-R3 拍板。

### 6.2 当前实现事实

| 数据 | 当前保留/裁剪 | 证据 |
|---|---|---|
| session/message/part 等 | 显式 `chimera session prune --older-than <window> --yes`；默认 dry-run；无自动定时任务 | `src/cli/cmd/session.ts:92-113`；`src/session/session.ts:847-940` |
| 图审计证据 | `compactCommittedChangeEvidence` 默认 `retentionDays = 30`；只压缩已提交事件，重写 fact payload、删除旧 semantic snapshot/object | `src/chimera/store.ts:290-294,2705-2707,2794-2914` |
| `background_job` | 每 instance 最多 500 行，按 `updated_at` 最旧优先 prune | `src/agent/background-job.ts:171-172,244-261` |
| `session_turn_lease` | TTL 30min，renew 10min | `src/session/turn-lease.ts:104,110` |
| `chimera_process_registry` | TTL 24h；`sweepExpiredStoreRows` 每 5 分钟持久化清理，`readActiveProcesses` 纯读取 | `src/chimera/store.ts:2152,2244-2256,2331-2354`；`src/chimera/edit-intent.ts:39,45-50` |
| `chimera_edit_intent_claim` | 默认 TTL 2h；lazy 过期 | `src/chimera/store.ts:190,1789-1800` |
| `model_telemetry_*` | 终态事件 `compact()` → tombstone；tombstone 可按 `tombstoneBefore` 裁剪 | `src/agent/model-telemetry.ts:1522-1610` |
| `memory_*` | 软删除 `time_deleted`；`resetScope` 硬删除；无时间 TTL | `src/memory/store.ts:1264-1330` |
| `host_event` | **无裁剪任务** | `h2-data-plane.md` D9；`src/storage/tables/host.sql.ts:144-166` |
| `request_idempotency` | `expires_at` 由调用方写；无清理任务 | `src/storage/tables/host.sql.ts:123-142`；`h2-data-plane.md` D14 |
| `session_turn_checkpoint` / `pending_request` / `host_worker` 终态行 | 无裁剪任务 | `src/storage/tables/host.sql.ts:16-121` |

### 6.3 裁剪规则（硬约束）

1. **未 ACK 的事实不得裁剪**：`host_event`、`request_idempotency`、投影库未确认行必须在 ACK/checkpoint 之后才允许进入裁剪候选。
2. **pending obligation 不得被 30 天证据压缩静默删除**：`chimera_audit_obligation` 必须保留到 resolve/ignore；压缩只能处理已提交的 change evidence。
3. **保留窗口必须记录 floor**：`host_event` 裁剪后写 `retention_floor_seq`；小于 floor 的 `Last-Event-ID` 返回 `stream_reset`，不伪造连续。
4. **裁剪是幂等的**：重复执行同一窗口不产生第二次删除；删除前按主键分批，避免长事务。
5. **软删除优先于硬删除**：memory、session 等可恢复数据先软删除；硬删除只在 `resetScope`/显式 prune `--yes` 时执行。
6. **跨库保留分开**：主库 30 天策略不自动作用于项目图库；项目图库按审计证据压缩与 graph 派生数据重建策略分别处理。

### 6.4 建议与待拍板

- **建议 S1**：`host_event` 保留 = 时间 30 天 + 行数 1,000,000 + 字节 256 MiB（先到者），并持久化 `retention_floor_seq`。
- **建议 S2**：`request_idempotency` TTL 24h + 清理任务；过期重复 key 返回 `idempotency_expired`。
- **建议 S3**：session 30 天保留增加“默认 dry-run 提醒”，不自动删除活跃/有子会话的会话。
- **建议 S4**：`permission` 运行时写回或明确 legacy（见矩阵 §2.1）。
- **建议 S5**：`chimera_process_registry` 保持 24h TTL，不并入 30 天审计证据保留。
- **待拍板 D-R1**：`host_event` 裁剪窗口数值与 owner（host 内置任务 vs TS 命令）。
- **待拍板 D-R2**：`session_turn_checkpoint`/`pending_request`/`host_worker` 终态行保留窗口。
- **待拍板 D-R3**：`model_telemetry_*` 是否在“遥测持久化移除”范围内。
- **待拍板 D-R4**：`account`/`account_state` 是否迁入 host（安全边界）。
- **待拍板 D-R5**：项目图库与主库是否要求同一快照点备份。

## 7. 跨库投影恢复契约（演练对应）

本包演练的模型是“权威库 A（主库/上游）+ 投影库 B（项目图库/下游）”，对应真实拓扑中**没有跨文件事务**的两库。

### 7.1 契约

1. **权威先提交**：A 的事实行先提交；B 只能投影已提交的 A 行。
2. **投影 + checkpoint 同事务**：B 的每批 `projection_row` 插入与 `projection_checkpoint.last_seq` 更新必须在同一 B 事务内。
3. **ACK 游标滞后于投影**：A 的 `ack_cursor.acked_seq` 只能在 B 的 `last_seq >= A 的权威高水位` 后前进；投影后 ACK 前崩溃 → 重启重放幂等。
4. **重放幂等**：从 B 的 `last_seq + 1` 开始，按 `INSERT OR IGNORE` 写 B；第二次重放必须写 0 行。
5. **phantom 检测**：B 中存在 A 没有的行（或 payload 不一致）→ 对账失败，不推进 ACK；不得静默接受。
6. **writer fencing**：A 的 lease 以 generation CAS 获取；旧 generation 的写入被 trigger/CAS 拒绝；崩溃后新 generation 接管。
7. **保留不得先于投影**：A 的裁剪必须等 B checkpoint 追上；否则先扩窗口/暂停裁剪。

### 7.2 演练覆盖

`packages/chimera/test/oracle/storage/cross-db-projection-drill.ts` 覆盖：

| 场景 | 崩溃点 | 期望 |
|---|---|---|
| `authority-only` | A 提交 12 行后、B 未写 | 重启从 0 重放 12 行 |
| `mid-projection` | B 第 1 批（1..5）提交后 | 从 checkpoint 5 重放 6..12 |
| `projection-before-checkpoint` | B 第 2 批行已提交、checkpoint 仍为 5 | 重放 6..12，`INSERT OR IGNORE` 不重复 |
| `after-ack` | B 完成 + ACK 后 | 重启无操作，二次对账 0 行 |
| `phantom-negative` | 无崩溃，人工注入 B 的 seq 999 | 对账报 phantom 并失败；清理后恢复通过 |

每次崩溃后还验证：旧 generation 不能重新获取 lease；新 generation 获取成功；旧 generation 插入被 trigger 拒绝。记录见 `cross-db-projection-drill.result.json`。

## 8. 验收与 oracle_commands

从 `packages/chimera` 运行：

```bash
# 1. 矩阵覆盖 + 8 列校验
bun test/oracle/storage/matrix-check.ts

# 2. 跨库投影恢复演练（SIGKILL + 重启对账）
bun test/oracle/storage/cross-db-projection-drill.ts

# 3. 既有 host schema 迁移回归（只读引用，确认 host 六表/additive）
bun test --timeout 30000 test/storage/host-schema.test.ts
```

验收判据：

- `matrix-check.ts` 输出 `PASS`，主库 37 + 账本 1、项目图库 26，合计 64 行，无缺失/多余/重复，每行 9 个单元。
- `cross-db-projection-drill.ts` 输出 `5/5 scenarios passed`，`cross-db-projection-drill.result.json` 的 `summary.failed = 0`。
- `host-schema.test.ts` 通过，证明已应用 host 迁移仍可幂等应用（本包未改迁移）。
- `git status --porcelain packages/chimera/migration` 无输出（本包不产生新迁移）。

## 9. 证据索引

- `RUST_FULL_MIGRATION_PLAN.md` §8:259（WP-05 DoD）、§10:298（写路径 drain/checkpoint/fencing/一个发布周期）、§13:362（30 天保留）。
- `packages/chimera/specs/rust-host/recovery-matrix.md` §4.1/§4.3/§4.4/§5.1/§5.2/§5.3/§5.4/§5.5/§6.1。
- `packages/chimera/specs/rust-host/h2-data-plane.md` §4.1-§4.7（DB 所有权、WAL、flip 顺序、shadow、kill switch、回退）。
- `packages/chimera/src/storage/tables/host.sql.ts:16-166`（host 六表与 checkpoint/幂等/事件字段）。
- `chimera-host/src/store.rs:348-368,512-786`（host 不迁移、ACK 写入口）。
- `src/session/turn-lease.ts:104,110`（lease TTL）。
- `src/agent/background-job.ts:171-172,244-261`（job durable cap）。
- `src/chimera/store.ts:290-294,2152,2705-2707,2794-2914`（审计保留、进程 TTL、证据压缩）。
- `src/cli/cmd/session.ts:92-113`（显式 session prune）。