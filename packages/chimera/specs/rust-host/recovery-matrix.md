# Rust Host H1：Durable State / Ownership / Recovery Matrix

状态：**H1 设计草案（proposed H1 boundary），未实现**

制定：2026-10-21

服务对象：`RUST_HOST_MIGRATION_PLAN.md` H1（Rust supervisor + front door）
适用范围：`packages/chimera` 的 session / turn / background job / permission / question / PTY / process registry / event-SSE 状态。

> 本文只描述目标语义、表候选、迁移顺序和验收目标。它不修改运行时代码，不产生 migration，不声称任何表、状态或恢复行为已经存在。文中所有“现状”均以当前 checkout 的源码为证据；“建议/候选/待定”均需 H1 评审后才能进入实现。
>
> **H1 写者边界（本文的核心约束）**：H1 期间 session/message/part/session_message 的实际写者仍是 Bun worker；H1 host 只写 host-owned control tables（`host_worker`、`host_state`、`session_turn_checkpoint`、`pending_request`、`request_idempotency`、`host_event`，以及 IPC 侧 `host_command_replay`）。H1 **不**声称能在同一 SQLite 事务内原子提交 checkpoint + message/part + event；该原子性要到 H2 把 session 写者也切到 host 后才成立。本文因此把 commit-before-ack 拆成 **host-control commit-before-ack** 与 **worker session commit confirmation/补偿协议** 两段（§5.1）。
>
> **Process registry 边界**：H1 host 对 `chimera_process_registry` 只读/代理，不做 adoption、不做写回；`orphaned` 状态不是 H1 必做项。H2 才处理 host ownership、CAS、signal-0 sweep 竞态（§3、§6、§8.9）。

---

## 1. 结论摘要

H1 的核心不是“把 HTTP 搬到 Rust”，而是先建立一条可验证的所有权边界：

1. **H1 有两个写者层级，不是一个提交点。** Bun worker 继续写 session/message/part/session_message 与 background_job 的 write-through 投影；host 只写 host-owned control tables。H1 的“先落库再确认”只对 host 控制的表成立；session 数据的提交由 worker 完成后再向 host 确认。
2. **Worker 只持有可丢弃的执行态。** Fiber、Deferred、Effect Scope、provider 流、plugin module cache、PTY 字节缓冲都属于可丢弃状态；worker 崩溃后不得成为恢复依据。
3. **Generation 是 fencing token，且有四个独立层级。** `host_generation`、workspace `worker_generation`、turn/pending-request generation、`background_job.generation` 作用域不同，必须逐层校验，禁止互相替代（§5.3）。
4. **Sequence 有三层，不能互相推算。** `host_event.seq` 是全局 durable 游标；`aggregate_seq` 是单 aggregate 的 durable 顺序；`transport_sequence` 是单连接传输序号，不落 durable 表。SSE 的 `Last-Event-ID` 只映射 `host_event.seq`。
5. **幂等键覆盖所有可重试入口。** prompt、job start、permission/question reply、PTY ticket、worker command 都必须有稳定的 idempotency key；重复请求返回第一次的结果，不产生第二个 turn/job/approval。
6. **单表单写者。** H1 过渡期 host 与 Bun worker 共用同一数据库，但按表划分写权限；任何表在任一时刻只能有一个写入方，禁止双写同一张表。H1 不得出现“host 也写 session/message/part”的实现。
7. **恢复默认保守。** 没有明确 `resume_policy` 的 turn/job 一律标记 interrupted，不自动重放有副作用的工具调用；自动续跑只允许显式声明为 `retry_safe` 且身份匹配的场景。
8. **终态优先于崩溃推断。** 已提交的 `completed`/`cancelled` 不得被 crash sweep 覆盖；cancel intent 优先于 `interrupted`；crash sweep 只处理未提交终态（§5.5）。
9. **Process registry 在 H1 只读/代理。** 现有 `readActiveProcesses` 会顺手把过期/死 pid 行改成 `expired`，因此它是“带清理副作用的读取”，不是纯只读；H1 host 不得把它当作无副作用探针，也不得执行 adoption。

---

## 2. 现状证据基线

### 2.1 存储拓扑

当前存在两个独立的 SQLite 事实源，H1 不能把它们当成一个库：

| 存储 | 路径/打开方式 | 迁移机制 | 当前承载 |
|---|---|---|---|
| 主应用库 | `Global.Path.data/chimera.db`（channel 变体见 `getChannelPath()`） | Drizzle Kit 目录 `packages/chimera/migration/<timestamp>_<slug>/migration.sql`，共 29 个目录；`Database.applyMigrations` 对已知 lineage repair 做第二遍 | session/message/part、permission ruleset、background_job、event、turn lease、goal/work_brief/tool_reveal 等 |
| 项目级 Chimera store | `getDatabasePath(projectRoot)`（项目内数据根） | `src/chimera/store.ts` 内联 `PRAGMA user_version` 迁移，当前版本 8 | edit-intent waiter、`chimera_process_registry`（bash/browser 子进程） |

主库打开参数（`src/storage/db.ts`）：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`cache_size=-16000`、`foreign_keys=ON`、`journal_size_limit=64MB`，并有 5 分钟一次的 `wal_checkpoint(PASSIVE)`。这意味着：

- 多进程同时打开同一主库在 SQLite 层面可行，但**应用层写冲突只会以 `SQLITE_BUSY`/重试暴露**，不会自动串行化业务语义；
- H1 必须用表级写所有权 + 单写事务避免“两个进程都认为自己能写”；
- WAL 不是事件日志，不能替代 durable event table。

### 2.2 现有表与字段（事实）

| 表 | 关键字段 | 现状语义 |
|---|---|---|
| `session` | `id` PK、`project_id`、`workspace_id`、`parent_id`、`directory`、`title`、`permission` JSON、`model` JSON、`time_compacting`、`time_archived` | session metadata 持久化 |
| `message` | `id` PK、`session_id` FK cascade、`data` JSON（含 role/time） | 已提交消息 |
| `part` | `id` PK、`message_id` FK cascade、`session_id`、`data` JSON | 已提交 part；tool part 的 `state.status` 有 `pending/running/completed/error` |
| `session_message` | `id` PK、`session_id`、`type`、`data` JSON | v2 消息投影 |
| `session_turn_lease` | `session_id` PK、`owner_boot_id`、`owner_pid`、`acquired_at`、`expires_at` | 跨进程 turn 互斥；无 worker generation、无 turn id |
| `background_job` | PK(`instance_directory`,`id`)、`generation`、`status`、`data` JSON、`updated_at` | 内存 registry 的 write-through 投影；`status` 文本为 `running/completed/error/cancelled`。registry 以 **instance_directory** 为 scope；`Info.ownerSessionId` 是类型化的可见性/取消归属字段 |
| `permission` | `project_id` PK、`data` JSON | 只持久化 approved ruleset，不持久化 pending request |
| `event_sequence` | `aggregate_id` PK、`seq`、`owner_id` | 每 aggregate 的连续序号 |
| `event` | `id` PK、`aggregate_id` FK cascade、`seq`、`type`、`data` JSON | 仅在 `OPENCODE_EXPERIMENTAL_WORKSPACES` 打开时写入 |
| `chimera_process_registry` | `id` PK、`session_id`、`host_boot_id`、`pid`、`pgid`、`command`、`cwd`、`status`、`exit_code`、`started_at`、`exited_at`、`expires_at` | 项目库中的 bash/browser 子进程登记；状态 `running/exited/killed/expired/released` |

### 2.3 现有内存态（事实）

| 内存结构 | 位置 | 内容 | 进程重启后 |
|---|---|---|---|
| `runners: Map<SessionID, Runner>` | `src/session/run-state.ts` | 本进程 turn 执行器、busy 标志、中断回调 | 全部丢失；DB 中只留 lease 与已提交消息 |
| `SessionStatus` `Map<SessionID, idle\|busy\|retry>` | `src/session/status.ts` | 状态事件源 | 丢失；读取默认 `idle` |
| `pending: Map<PermissionID, {info, deferred}>` | `src/permission/index.ts` | 等待中的 permission promise | 丢失；finalizer 统一 `RejectedError` |
| `pending: Map<QuestionID, {info, deferred}>` | `src/question/index.ts` | 等待中的 question promise | 丢失；finalizer 统一 `RejectedError` |
| `jobs: SynchronizedRef<Map<string, Active>>` | `src/agent/background-job.ts` | Fiber/Deferred/delivery 状态 | 丢失；durable 行在 open 时把 `running` 改写为 `error` |
| `sessions: Map<PtyID, Active>` | `src/pty/index.ts` | PTY 进程、2MB 环形缓冲、subscriber | 丢失；子进程可能仍存活 |
| PTY ticket `Cache<string, Scope>` | `src/pty/ticket.ts` | 60s TTL、容量 10000、单次消费 | 丢失；客户端需重新取 ticket |
| `GlobalEventStream` 队列 | `src/server/global-event-stream.ts` | 每连接 1024 槽、drop-oldest、40ms delta 合并 | 丢失；无 durable replay |

### 2.4 现有常量（事实）

- turn lease：`LEASE_TTL_MS = 30min`，`RENEW_INTERVAL_MS = 10min`；`acquire` 用单语句 upsert + CAS，`release` 按 `owner_boot_id` 守卫。
- background job：live settled 上限 200（`DEFAULT_SETTLED_LIVE_MAX`），durable 每 instance 上限 500（`DURABLE_ROWS_MAX`），prune 按 `updated_at` 最旧优先。
- SSE：队列 1024、delta 合并 40ms、heartbeat 10s、start watchdog 60s、默认最大连接 64（`OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS` 可覆盖）。
- PTY ticket：TTL 60s、容量 10000。
- process registry：TTL 24h；lazy TTL + signal-0 liveness sweep；`markProcessExited`/`markProcessKilled` 用 guarded UPDATE 保证 exactly-once。
- host boot id 格式：`boot_<process-start-ms>_<pid>`，turn-lease 与 edit-intent/process registry 共用同一约定。

### 2.5 现状中容易被误读的两点（事实）

- **job 的 scope 与可见性不是一回事。** 配额/持久化按 `instance_directory`（`InstanceState` 以 directory 为 key），而可见性与 cancel 权利按类型化 `Info.ownerSessionId`：prompt 的 background tasks 段只列 `ownerSessionId === input.sessionID` 的 job，`task_cancel` 也按 owner 拒绝跨 session 取消。一个 session 可能被自己看不见、也取消不了的 job 挤占配额，这是已知未解陷阱，H1 不得把“registry 可见”当成“session 可见”。
- **`readActiveProcesses` 会写库。** `src/chimera/store.ts:2313-2346` 在读取前调用 `expireStaleProcesses`，并对 `isPIDAlive(pid) === false` 的 running 行执行 `UPDATE ... SET status='expired'`。因此它是“带清理副作用的读取”；H1 的只读/代理声明必须带这个限定，不能把它当纯探针。

---

## 3. 状态所有权矩阵

“H1 写者”是 H1 的硬边界；“H2 目标 owner”是迁移终点。H1 期间 session 执行仍留在 Bun worker，因此表级写权限必须显式划分。

| # | 状态 | 当前权威 | 现有 durable 表/字段 | H1 写者 | H2 目标 owner | Worker 可持有 | 恢复依据 |
|---|---|---|---|---|---|---|---|
| S1 | session metadata / messages / parts | Bun 进程 | `session` / `message` / `part` / `session_message` | **Bun worker** | host | 当前 prompt、未提交 part、provider 流 | 已提交行 + `session_turn_checkpoint` |
| S2 | session status（idle/busy/retry） | Bun 内存 | 无 | host 只派生视图，不落表 | host | 本进程 Runner 状态 | checkpoint + worker heartbeat |
| S3 | turn intent / checkpoint | 无 | **不存在** | **host** | host | 执行计划、当前工具、上下文窗口 | H1 新增 `session_turn_checkpoint` |
| S4 | turn lease | Bun 进程（Runner map 为进程内权威） | `session_turn_lease` | **Bun worker**（host 只读） | host | 只持有 lease token | lease 行 + boot id；H1 仅作 advisory evidence |
| S5 | background job registry | Bun 内存 registry | `background_job` | **Bun worker**（write-through 投影） | host | Fiber、Deferred、delivery | durable 行；H1 的 open-time reconcile 仍由 Bun 执行 |
| S6 | permission pending | Bun 内存 | **无**（只持久化 approved ruleset） | **host** | host | 等待中的 Deferred | H1 新增 `pending_request` |
| S7 | permission approved ruleset | Bun 读 DB | `permission.data` | **Bun worker** | host | 内存缓存 | DB 行 |
| S8 | question pending | Bun 内存 | **无** | **host** | host | 等待中的 Deferred | H1 新增 `pending_request` |
| S9 | durable event / SSE cursor | Bun 进程 | `event`/`event_sequence`（仅实验 flag） | **host** | host | 发送缓冲、delta 合并 | H1 新增 `host_event` + `Last-Event-ID` |
| S10 | PTY ticket | Bun 内存 | **无** | host（H1 front door 终止 WS；仅内存） | host | 无 | host ticket 存储；host 重启即失效可接受 |
| S11 | PTY session runtime | Bun 内存 | 无（仅有 process registry 行） | **Bun worker**（host 不接管） | host/process supervisor（H2+） | 进程句柄、2MB buffer、subscriber | `chimera_process_registry`；H1 不新增 `orphaned` |
| S12 | bash/browser 子进程 registry | Bun 写项目库 | `chimera_process_registry` | **Bun worker**（host 只读/代理，不写回、不 adopt） | host（H2 处理 ownership/CAS/sweep 竞态） | 子进程句柄 | 项目库行 + pid/pgid + host_boot_id |
| S13 | worker registry / heartbeat / drain | 无 | **不存在** | **host** | host | 自身 health | H1 新增 `host_worker` |
| S14 | graph DB / watcher | Bun 进程 | 项目 graph DB | H2 host/core | H2 host/core | 请求级结果 | graph 自身；H1 不纳入恢复矩阵 |

**所有权原则**

- S1 在 H1 仍是 Bun 写，因为 session 执行器未迁移；host 不得同时写 `session/message/part`，否则违反单写者。**H2 才切换 session/message/part 写者。**
- S3/S6/S8/S9/S13 由 host 写；Bun worker 通过 IPC 上报，不直接写这些表。
- S4/S5/S7/S11/S12 在 H1 仍由 Bun 写；host 只读或只做诊断代理。新增列可以走 expand（由 Bun 写），但 host 不得在 H1 写这些表的行。
- S10 的 ticket 只在 host 内存；不落库，H1 不引入跨 host 共享。
- S12 的库在项目目录，和主库不同文件；host 不得假设跨库事务。**H1 不做 adoption/write-back**：host 只读取/代理，且必须把 `readActiveProcesses` 的 `expired` 清理副作用当作已知行为。H2 才处理 host ownership、CAS、signal-0 sweep 竞态。
- S1 的 H1 后果必须明说：由于 Bun 仍写 session 行，**旧 worker 的迟到 session 写入无法被 host 在 SQLite 层阻止**。H1 的 fencing 落在 checkpoint/event/UI 选择上；迟到行按 `turn_id` 隔离为历史，不得被当成当前 turn 的提交（§5.1.3）。

---

## 4. 状态枚举

以下枚举是 H1 契约候选。实现时必须一次性写入 schema/常量/文档，禁止不同层各自发明同义值。

### 4.1 Host 生命周期

```text
starting → ready → draining → stopping → stopped
                 ↘ crashed
```

- `ready` 才允许接受 HTTP 和 spawn worker。
- `draining` 不再接受新 turn/job，只完成在途请求和事件落库。
- `crashed` 由下一次启动时根据 `host_worker`/checkpoint 推断，不是运行态。

### 4.2 Worker 生命周期

```text
spawned → handshaking → ready → busy → draining → exited
                    ↘ crashed / killed / unresponsive
```

- `unresponsive`：heartbeat 超过阈值，host 已决定回收但尚未确认退出。
- `exited` 必须带 `exit_reason`：`normal|drain_timeout|crash|oom|killed|protocol_error`。
- 一个 `(workspace_id, generation)` 只能有一个非终态 worker。

### 4.3 Turn 状态

```text
accepted → running → waiting_permission | waiting_question | waiting_tool
         → cancelling → cancelled
         → completed
         → failed
         → interrupted
```

- `interrupted` 是崩溃/重启/lease 丢失后的终态，不等于 `failed`；客户端可据此展示“可重试”。
- `waiting_*` 必须能从 `pending_request` 重建；重建失败则 turn 直接 `interrupted`。
- `cancelled` 只由 host 的 cancel 决定，worker 自报 cancel 不能直接落终态。
- H1 另有一个**不正交于 status 的提交维度** `commit_state = uncommitted | committed_unconfirmed | confirmed`，用于描述 worker 侧 session 行是否已提交、host 是否已确认（§5.1.2）。它不进入客户端可见状态机。

### 4.4 Job 状态

现有 `Status = "running" | "completed" | "error" | "cancelled"` 保持兼容，不重命名。H1 增加独立恢复维度，避免破坏 SDK/UI：

```text
recovery_state = none | interrupted | recoverable | recovered | abandoned
```

- `interrupted`：执行体已消失，未完成。
- `recoverable`：有 checkpoint 且 `resume_policy != none`，但尚未决定是否重跑。
- `recovered`：已由新 generation 接续完成。
- `abandoned`：超过重试预算或人工放弃。
- H1 中 `recovery_state` 列由 Bun 的 write-through 路径写入（若实现），host 只读；H2 才由 host 写。H1 不得让 host 与 Bun 同时写该列。

### 4.5 Delivery 状态

沿用现有 `delivery = "pending" | "delivered"`。H1 只增加 generation 绑定：`markDelivered(id, generation)` 的旧 generation 调用必须是 no-op。

### 4.6 Pending request 状态

```text
pending → answered | rejected | expired | orphaned
```

- `orphaned`：原 turn 已中断，请求不再可回答；客户端列表仍可见但只读。
- `expired`：超过 TTL 或 host 重启后无法恢复。
- `request_id` 在请求生命周期内**稳定不变**；重新发布只递增 `generation`（republish attempt generation），不换 `request_id`。
- 同一 `(session_id, turn_id, kind, tool_call_id)` 只能有一个非终态请求；`tool_call_id` 可空，因此唯一性用 `request_key` 的部分唯一索引实现，而不是裸 `UNIQUE`（§8.4）。

### 4.7 PTY / 进程状态

PTY session（内存态）沿用 `running|exited`。

Process registry 现有 `running|exited|killed|expired|released`。

- `orphaned` **不是 H1 必做项**。H1 host 不接管进程、不做 adoption，因此不需要新增该状态。
- H2 引入 `orphaned`：worker 已死但子进程可能仍存活，host 尚未认领或终止。H2 必须同时定义 adoption 的 CAS 与 signal-0 sweep 竞态处理（pid 复用）。
- H1 不得把 `readActiveProcesses` 的返回当成纯只读快照：它可能已经把死 pid 行改成 `expired`。

### 4.8 Event 类别

```text
durable     — 必须落 host_event，带全局 seq，可 replay
transient   — delta/心跳，允许丢，带 gap 标记；不落表、不分配 durable seq
control     — connected/heartbeat/gap/stream_reset，不落表、不分配 durable seq
```

- `host_event` **只存 durable**。`control`/`transient` 不进入该表，也不消耗 `seq`。
- `Last-Event-ID` 只对 durable 生效；transient/control 没有可重放游标。
- 三类事件的 IPC 映射以 `ipc-v0.md` §8.4 为准；本文只定义 durable 落库与 seq 规则。

---

## 5. 不变量与规则

### 5.1 提交顺序

H1 的 commit-before-ack 分两段，不能合并成“一个事务里同时写 checkpoint + message/part + event”。

#### 5.1.1 Host-control commit-before-ack（H1 成立）

| 动作 | 必须先落库（host-owned） | 之后才能 |
|---|---|---|
| 接受 turn | `session_turn_checkpoint`（`accepted`） | 向客户端返回 turn id |
| 开始工具调用 | checkpoint 中记录 `tool_call_id` + intent | worker 执行副作用 |
| 发出 permission/question | `pending_request` 行（`pending`，稳定 `request_id`） | 发布 `*.asked` |
| 回复 permission/question | 先写答案 + generation 校验 | 唤醒 worker |
| 发布 durable event | `host_event` 插入成功（含 seq/aggregate_seq/dedupe_key） | SSE 广播 / 返回 200 |
| 接受 job start | `request_idempotency` 行（`in_flight`） | 转发给 worker 启动 Fiber |
| 取消 | checkpoint 的 `cancel_requested_at`（host-owned）；job 侧的同类字段 H1 由 Bun 写 | 发 cancel 帧 |

#### 5.1.2 Worker session commit confirmation（H1 的补偿协议）

message/part 由 Bun worker 写，host 不能在同一事务里替它提交。协议如下：

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

规则：

1. **host 不写 session 行，只读校验。** “提交完成”的判定是 host 在收到 `commit.confirm` 后读取 `message/part` 验证，而不是由 worker 单方面声明。
2. **`commit_token` 是确认幂等键。** 同一 `commit_token` 的重发返回同一 ack；不同 `commit_token` 但同一 `turn_id` 且 generation 匹配，按“重复确认”处理并记录诊断。
3. **确认前崩溃 = `committed_unconfirmed`。** 若 checkpoint 仍是非终态、`commit_state != confirmed`，但 session 行已完整存在，host 在恢复时可以把 checkpoint 推进到 `completed`，并标记 `completion_source=recovered_confirmation`；若行不完整，则 `interrupted`。
4. **不自动重放副作用。** 未确认提交只允许“确认已存在的行”，不允许重新执行工具调用。
5. **H1 的原子性缺口要显式记录。** host 的 checkpoint 事务与 worker 的 session 事务是两次提交；中间崩溃由上面的确认/补偿协议收敛，而不是假装它们原子。
6. **H2 收口。** H2 把 session 写者切到 host 后，`message/part` 提交与 checkpoint/event 可以在同一 SQLite 事务内完成，`commit.confirm` 协议退化为内部函数调用。

#### 5.1.3 迟到 worker 的 session 写入（H1 残余风险）

H1 无法在 SQLite 层阻止旧 worker 继续 append session 行。处理规则：

- 迟到行按 `turn_id` 隔离：它们保留为历史数据，但不得被当作当前 turn 的提交，也不得触发当前 turn 的 `completed`。
- host 只接受与当前 `turn_generation` + `worker_generation` 匹配的 `commit.confirm`；旧 generation 的确认返回 `stale_generation`，不改变终态。
- 迟到行是否需要在 UI 中隐藏，列为 H1 待决项（§14），不得默认假设“旧 worker 写不进去”。

### 5.2 幂等键

| 入口 | 幂等键 | 作用域 | 重复请求行为 |
|---|---|---|---|
| prompt / turn start | `(session_id, idempotency_key)`；无 key 时用 `(session_id, turn_id)` | session | 返回第一次的 turn；不新建 |
| job start | `(instance_directory, job_id, generation)` 或 `(instance_directory, owner_session_id, idempotency_key)` | job（instance-scoped） | 返回既有 job 快照 |
| permission reply | `request_id` + `generation` | request | 同 generation 返回已存答案；旧 generation 409 |
| question reply | `request_id` + `generation` | request | 同上 |
| cancel | `(turn_id, cancel_request_id)` | turn | 幂等；重复 cancel 返回同一终态 |
| worker command | `(worker_generation, correlation_id)` | worker | worker 去重；host 重发不产生第二次副作用 |
| PTY ticket consume | `ticket` 单次 | pty | 第二次 consume 返回 false |
| durable event append | `dedupe_key` 唯一（`(aggregate_id, aggregate_seq)` 另作顺序约束） | aggregate/event | 重复插入忽略/返回已有行，不递增 seq |

**规则**

- `idempotency_key` 必须由客户端或 host 生成后**持久化**，不能只存在内存。
- 没有幂等键的写入口，H1 不允许暴露为可重试 API；只能由 host 内部一次性调用。
- 幂等记录必须有 TTL/保留策略；过期后重复 key 视为新请求，但必须在响应中体现 `idempotency_expired`。
- job 的幂等 scope 必须带 `instance_directory`，因为 registry 与 durable 行都以 instance 为 scope；`owner_session_id` 是可见性/取消归属，不是配额 scope。

### 5.3 Generation 与 Sequence

#### 5.3.1 四个 generation 层级（互不替代）

| 层级 | 分配者 | 存储 | 作用域 | 递增时机 | 不匹配行为 |
|---|---|---|---|---|---|
| `host_generation` | host | `host_state.host_generation` | 整个数据库 | 每次 host 启动；只增不减 | 检测到回退则 fail closed，不启动 worker |
| `worker_generation` | host | `host_worker.generation` | workspace | 每次 spawn/resume worker | 旧 worker 帧丢弃并记 `stale_generation` |
| `turn_generation` / pending request `generation` | host | `session_turn_checkpoint.generation` / `pending_request.generation` | turn / request | turn 被新执行接管；request 重新发布 | 旧 turn/request 写入不得改变终态 |
| `background_job.generation` | Bun（H1）/ host（H2） | `background_job.generation` | 单个 `job_id` | 同一 job 开始新一次 run | 旧 run 的完成/失败通知不得覆盖新 run |

规则：

1. 四个层级**没有映射关系**。`host_generation` 不是 worker 代次，`worker_generation` 不是 turn 代次，`background_job.generation` 也不是 connection 代次。
2. 任何 worker→host 的写帧必须携带 `(worker_id, worker_generation, correlation_id)`；涉及 turn/request/job 的还要携带各自的 generation。两层（worker + 业务对象）都要校验。
3. 任何 host→worker 的命令帧携带 `expected_generation`；worker 发现自身 generation 更低时不得执行，直接回 `stale_worker`。
4. `host_generation` 只增不减；恢复时不得回退到更小的值，即使数据库被旧备份覆盖也要在启动时检测并拒绝服务（fail closed）。
5. `turn_id`、`job_id`、`request_id` 一经分配永不复用；重试创建新 id，旧 id 保留终态。
6. 旧 generation 的完成/失败通知只能用于诊断，不能改变 turn/job 终态；终态迁移必须由 host 基于当前 generation 执行。

#### 5.3.2 三层 sequence（互不推算）

| 序号 | 分配者 | 存储 | 作用域 | 单调性 | 用途 |
|---|---|---|---|---|---|
| `host_event.seq`（全局 durable） | host | `host_event.seq` | 数据库 | 严格 +1 | SSE `Last-Event-ID` 游标 |
| `aggregate_seq` | host | `host_event.aggregate_seq` | 单 aggregate | 每 aggregate +1 | 同一 session/job 的 durable 顺序；不等于全局 seq |
| `transport_sequence` | 发送方 | 不落 durable 表（IPC 连接内） | 单连接、单发送方向 | 重连即重置，从 1 开始 | 传输排序、去重、分片重组、连接内 gap 检测 |

规则：

1. `host_event.seq` 与 `aggregate_seq` 必须在同一事务内“取号 + 插入”；禁止先广播后落库。
2. `transport_sequence` 永不写入 `host_event`，也不参与 `Last-Event-ID`；worker 重连的 command 重放使用 `command_sequence`（IPC 侧，见 §8.8）。
3. `Last-Event-ID` 只映射 `host_event.seq`，不映射 `aggregate_seq`，不映射 `transport_sequence`，也不映射 `command_sequence`。
4. 同一 `dedupe_key` 重复写入是幂等冲突，不是新事件；返回已有行。同一 `(aggregate_id, aggregate_seq)` 重复写入同理。
5. durable event 出现 `seq` 缺口视为数据损坏，host 必须进入 `degraded` 并拒绝宣称 replay 可用；`transport_sequence` 的缺口只允许出现在 transient 流。
6. `Last-Event-ID` 指向的 seq 小于保留窗口起点（`retention_floor_seq`）时，host 返回 `stream_reset` + 当前快照游标，而不是假装连续。

### 5.4 单写者与事务边界

| 表 | H1 写者 | 读者 | H2 目标 | 备注 |
|---|---|---|---|---|
| `session/message/part/session_message` | **Bun worker** | host 只读 | host | H2 才翻转 |
| `permission.data` | **Bun worker** | host 只读 | host | H2 再翻转 |
| `background_job` | **Bun worker** | host 只读 | host | 现有 write-through 继续；host 不写行 |
| `session_turn_lease` | **Bun worker** | host 只读 | host | H1 host 只作 advisory evidence |
| `session_turn_checkpoint` | **host** | Bun worker 只读 | host | 新表 |
| `pending_request` | **host** | Bun worker 只读 | host | 新表 |
| `host_worker` | **host** | 只读诊断 | host | 新表 |
| `host_state` | **host** | 只读诊断 | host | 新表 |
| `request_idempotency` | **host** | 只读诊断 | host | 新表 |
| `host_event` | **host** | SSE/replay | host | 新表 |
| `host_command_replay` | **host（IPC 层）** | worker 重连 | host | IPC-owned，非业务事实源 |
| `chimera_process_registry` | **Bun worker**（项目库） | host 只读/代理 | host（H2） | 跨库；H1 不 adopt、不写回 |

- host 在 spawn worker 前完成 migration；worker handshake 必须报告 `schema_version`，不匹配则拒绝启动。
- 同一事务内不跨库；需要跨库一致性时用 outbox/补偿，不允许分布式事务假象。
- 长事务禁止包住 provider 流或工具执行；只包住“取号 + 插入 + 状态迁移”。
- H1 的 host 事务只覆盖 host-owned 表；不得把 worker 的 session 写操作拉进 host 事务。

### 5.5 终态优先级与 crash sweep

终态迁移必须在一个 host 事务内完成，并按以下优先级裁决：

1. **已提交终态不可覆盖。** `completed` / `cancelled` / `failed` / `interrupted` 一旦落库，crash sweep、重复确认、迟到帧都不得改写。
2. **cancel intent 优先于 crash。** 若 checkpoint/job 已记录 `cancel_requested_at`，即使 worker 随后崩溃，终态是 `cancelled`，不是 `interrupted`。
3. **worker crash 只处理未提交终态。** sweep 的 WHERE 条件必须包含 `status NOT IN (terminal set)`，并且只处理与死亡 worker generation 匹配的行。
4. **完成优先于 cancel 的竞态。** 若 `commit.confirm` 先于 cancel intent 提交，终态为 `completed`，后续 cancel 返回当前终态；若 cancel intent 先提交，则终态为 `cancelled`，即使 worker 随后报告完成。
5. **`failed` 只来自当前 generation 的显式失败确认。** 崩溃推断只能是 `interrupted`。
6. **missing-event 竞态。** worker 已提交 session 行但 host 在写 `host_event` 前崩溃时，恢复流程必须基于 `commit_token`/`dedupe_key` 补写一次事件；若事件已存在则直接复用，不重复分配 seq。

### 5.6 Process registry 的 H1 读取语义

- H1 host 只能以“代理读取”方式访问项目库：可以调用 Bun 的 registry API 或只读查询，但不得执行 adoption、不得更新 `host_boot_id`、不得把 `orphaned` 写回。
- `readActiveProcesses` 会执行 `expireStaleProcesses` 与死 pid 翻转，因此：
  - 它是一次**带清理副作用的读取**；
  - 调用方不得把它当纯探针或幂等读；
  - 并发 host/worker 同时调用时，`expired` 的写入由现有 guarded UPDATE 收敛，但 H1 不新增跨进程 CAS。
- H1 的诊断输出必须标注该副作用；H2 才引入 host ownership、adoption CAS 与 signal-0 sweep 竞态处理。

---

## 6. 恢复行为矩阵

图例：`H` = host 重启；`W` = worker crash；`G` = 旧 generation 写入；`C` = 取消；`R` = 重试；`S` = SSE 重连/gap。

> H1 的恢复范围是 **host-owned control tables**。session/message/part 的 reconcile 仍由 Bun 的 `part-reconcile` 与 registry open-time 逻辑执行；host 只读取结果并写 checkpoint。

| 状态 | H：host 重启 | W：worker crash | G：旧 generation | C：取消 | R：重试 | S：SSE gap/重连 |
|---|---|---|---|---|---|---|
| S1 session/messages/parts | 已提交行保留；Bun 的 part-reconcile 继续处理 running/pending tool part；host 读结果后把 checkpoint 标 `interrupted` 或按 commit confirmation 标 `completed` | 已提交行保留；当前流丢失；checkpoint 标 `interrupted`；不回滚已提交消息；未确认提交按 §5.1.2 收敛 | host 拒绝旧 generation 的 `commit.confirm`；迟到 session 行按 `turn_id` 隔离，不改变终态 | 保留已提交部分；running/pending part 由 Bun 转 error；checkpoint `cancelled` | 新 `turn_id`；幂等键命中则返回原 turn | 客户端按 session/message 重新拉取快照；delta 不重放 |
| S2 session status | 不恢复内存 Map；由 checkpoint/heartbeat 重新派生；无活 worker 时为 idle | 该 session 立即 idle 或 `interrupted`（取决于 turn 状态） | 忽略旧 worker 的 status 上报 | 置 idle 前先落 turn 终态 | 重新派生 | status 事件是 transient；以快照为准 |
| S3 turn checkpoint | 读取非终态 checkpoint；`resume_policy=none` → `interrupted`；`retry_safe` 且身份匹配 → `recoverable`；有 commit 证据则 `completed` | 标记 `interrupted`，保留 `last_message_id` / `last_event_seq`；有完整 session 行则 `completed(recovered_confirmation)` | 旧 generation 不得推进 checkpoint | 写 `cancelled` + `cancel_reason`；cancel intent 优先 | 新 turn 从 checkpoint 的 intent 重建，但工具副作用不自动重放 | 通过 `last_event_seq` 判断是否需要 snapshot |
| S4 turn lease | 新 boot id；旧行由 pid probe/TTL 回收；checkpoint 标 interrupted | Bun 仍持有 lease，自行释放/过期；host 不接管 | lease 行仍由 Bun 守卫；host 只读 | host 发 cancel，Bun 超时后终止 | 重新 acquire；CAS 保证不双持有 | 无关；busy 状态由 lease + heartbeat 派生 |
| S5 background job | 现有 Bun open-time reconcile：`running` → `status=error`；`recovery_state` 由 Bun 写（若实现） | 当前 Fiber 丢失；durable 行保留；Bun 标 interrupted；不自动重启有副作用任务 | 旧 worker 的 completion 被丢弃；generation 不匹配不落终态 | host 只发 cancel 请求；Bun 执行 `cancelled` exactly-once；H1 host 不写 job 行 | 新 generation；`job_id` 可复用但 generation+1；旧结果不得覆盖新 run | job 事件走 durable log；状态查询以 DB 为准 |
| S6 permission pending | 未决请求 → `orphaned`（turn 已断）或按 recoverable turn 重新发布同 `request_id` + `generation+1`；`approved` ruleset 保留 | Deferred 丢失；durable 行保留；请求转 `orphaned`/可重发 | 旧 generation 的 reply 拒绝（409 `stale_generation`） | 同 session/turn 的 pending 全部 `rejected`；保留现有“reject 级联”语义 | 同 request_id + generation 的重复 reply 幂等返回；跨 generation 不幂等 | `permission.asked/replied` 是 durable event，可按 seq 补发 |
| S7 permission ruleset | DB 行保留；host 重新加载 | 无影响（worker 只读） | 旧 worker 不得写 ruleset | 不回滚已批准规则 | 重复“always”写入需按 `(project, permission, pattern)` 去重 | 快照读取即可 |
| S8 question pending | 同 S6；无 approved 规则，全部按 turn 状态处理 | 同 S6 | 同 S6 | 同 S6 | 同 S6 | 同 S6 |
| S9 event/SSE | `host_event` 保留；SSE 客户端用 `Last-Event-ID` 从 seq+1 补发；超出保留窗口 → `stream_reset` | 已提交 durable event 不丢；worker 未提交的 transient delta 丢弃 | 旧 generation 事件丢弃并计数；不得写入新 seq | 发 `turn.cancelled` durable event | 重复 append 按 `dedupe_key` 幂等 | 现有 `Gap{dropped}` 只说明丢失数量；H1 用 durable log 消除 durable 事件丢失，transient 仍可 gap |
| S10 PTY ticket | host 重启后 ticket 全部失效（60s TTL 内也失效）；客户端重新 `POST /pty/:id/connect` 取 ticket | 若 ticket 由 worker 持有则丢失；H1 改为 host 持有 | 旧 generation 的 ticket 不接受 | 关闭 WS，ticket 可保留到 TTL 但不影响已关闭连接 | 新 ticket；旧 ticket 单次消费不可重用 | PTY 是 WS：无 Last-Event-ID；断开后只能重连并重新拿 ticket |
| S11 PTY session | 内存 session 不可重建；H1 不伪造 live PTY，也不新增 `orphaned`；由 Bun 侧按现有语义收尾 | 子进程可能存活；H1 host 只记录诊断，不改 registry | 旧 worker 不得再写该 PTY 的 registry 行 | Bun 侧 kill pgid；H1 host 只观察 | 新建 PtyID；旧 id 不复用 | WS 断开；buffer 不可恢复；客户端收到 reset 语义 |
| S12 process registry | 保留行；Bun 侧 lazy TTL + signal-0 sweep；**host 不 adopt、不写回**，只代理读取（读取本身会写 `expired`） | 子进程可能存活；H1 不判定归属，由 Bun/用户处理；H2 才引入 `orphaned` + adoption | H1 无 host ownership，因此不存在 host 侧旧 generation 写回；Bun 的 guarded UPDATE 仍生效 | Bun 侧 kill + `killed` exactly-once | 新 registry id | `process.changed` 是 transient；`readActiveProcesses` 是带清理副作用的权威读取 |
| S13 worker registry | 启动时扫描非终态行 → `crashed`/`unresponsive`；不自动复用 generation | 由 host 检测 heartbeat 超时 → `crashed`；写 exit_reason | 旧 generation 的行只读；新 spawn 分配新 generation | drain → 超时 kill → `killed` | 新 generation spawn；旧 generation 永不复用 | worker 状态事件可 transient；诊断查询走 DB |

### 6.1 关键行为说明

**Host 重启**

1. 打开主库，执行 migration preflight；版本不符则 fail closed。
2. 扫描 `host_worker` 非终态行 → `crashed`，记录 `exit_reason=host_restart`。
3. 扫描 `session_turn_checkpoint` 非终态行：
   - 有 `cancel_requested_at` → `cancelled`；
   - `commit_state=confirmed` 或 session 行证明已提交 → `completed`（`completion_source=recovered_confirmation`）；
   - 否则按 `resume_policy` 转 `interrupted` 或 `recoverable`；绝不静默重跑。
4. 扫描 `pending_request` 非终态行：turn 已断 → `orphaned`；turn recoverable → 保持 `pending` 但 `generation+1`，等待重新发布。
5. **不扫描/不接管 `chimera_process_registry`。** H1 只允许代理读取；`readActiveProcesses` 的 `expired` 清理是已知副作用，不作为 host 恢复动作。
6. 恢复 SSE：`host_event` 保留窗口内可 replay；窗口外 `stream_reset`。
7. 不自动 spawn worker，直到 HTTP ready 且显式策略允许。

**Worker crash**

1. host 从 IPC 断开或 heartbeat 超时感知；先标记 worker `crashed`，不等待 worker 自报。
2. 对该 worker generation 的 checkpoint 执行 §5.5 sweep：cancel intent → `cancelled`；有提交证据 → `completed`；其余 → `interrupted`。已终态行不动。
3. job 由 Bun 的 open-time reconcile 处理（`running` → `error`）；H1 host 不写 job 行。
4. pending request 转 `orphaned`。
5. PTY/子进程由 Bun 侧按 S11/S12 处理；H1 host 只记录诊断。
6. host 可立即 spawn 新 generation；旧 generation 的所有迟到帧丢弃。

**旧 generation**

- 任何写入必须携带 generation；host 在事务内比较，不匹配返回 `stale_generation`。
- 旧 generation 的 cancel ack 只用于清理，不改变终态。
- 旧 generation 的 event 不分配新 seq，不进入 replay log。
- 旧 generation 的 `commit.confirm` 不改变终态；其已写入的 session 行按 `turn_id` 隔离（§5.1.3）。
- 监控指标 `stale_generation_rejected_total` 必须可观测；持续非零说明 supervisor 或 fencing 有 bug。

**取消**

- cancel 先到 host；host 写 `cancel_requested_at`（checkpoint 字段；job 侧由 Bun 写）→ 发 cancel 帧 → 等待 ack 或超时。
- 超时后 host 终止 worker，按 crash 语义收尾；终态仍是 `cancelled`（因为 cancel 已请求），不是 `interrupted`。
- 重复 cancel 幂等；已终态返回当前终态。
- permission/question 的取消级联必须保留现有“同 session reject 其余 pending”的行为，但改为 host 写 durable 状态。

**重试**

- 重试是**新执行**，不是恢复旧 Fiber。
- 幂等键命中返回旧结果；显式 `retry=true` 且旧终态为 `interrupted/failed` 时创建新 turn/job id，generation+1。
- 有副作用的工具调用默认不自动重放；checkpoint 必须记录 `side_effect_state=unknown|committed|none`，未知时要求人工/上层策略确认。
- 重试预算和退避由 host 控制，worker 不得自行重试写操作。

**SSE gap**

- 现有 `GlobalEventStream` 的 `Gap{dropped}` 只报告队列丢弃数量，无法恢复内容；H1 host 必须增加 durable log。
- durable event：`Last-Event-ID` → 从 `host_event.seq+1` 补发；缺口即数据损坏。
- transient delta：允许 gap；客户端应重新拉取 part 快照。
- 保留窗口不足：`stream_reset` + `snapshot_seq`，客户端丢弃本地增量并重新同步。
- 不允许把 worker 内存缓冲当作 replay 来源。

**Commit confirmation / missing event 竞态**

1. worker 提交 session 行后、`commit.confirm` 到达前崩溃 → checkpoint 非终态 + `commit_state=committed_unconfirmed`；恢复时按 §5.1.2 判定 `completed` 或 `interrupted`。
2. host 写完 checkpoint 但写 `host_event` 前崩溃 → 恢复时用 `dedupe_key` 补写；若事件已存在则复用。
3. worker 重发同一 `commit_token` → 返回同一 ack；不重复插入事件、不重复推进 seq。
4. 不同 `commit_token` 但同一 turn/generation → 视为重复确认，记录诊断；若两次指向不同 `last_message_id`，以第一次已确认的为准，第二次不改变终态。

---

## 7. 当前缺口（按 H1 阻塞度排序）

| ID | 缺口 | 证据 | 影响 | H1 处理 |
|---|---|---|---|---|
| G1 | 无 turn intent/checkpoint | 只有 `session/message/part` 与 lease；无 turn 表 | 崩溃后无法判断“这个 turn 想做什么”，只能猜 | 新增 `session_turn_checkpoint` |
| G2 | lease 无 worker generation / turn id | `session_turn_lease` 仅 session/boot/pid/TTL | 无法 fence 同一 host 内的新旧 worker | H1 由 checkpoint 承载 fencing；lease 扩列是 additive 但 H1 不依赖（由 Bun 写），H2 才切 host 写 |
| G3 | session status 纯内存 | `SessionStatus` Map | 重启后 busy 丢失，客户端可能误判 | host 派生 + checkpoint |
| G4 | background job 无 owner/generation 关联字段 | 表只有 instance/id/generation/status/data；owner 在 JSON 内 | 旧 worker 可覆盖新 run；重试可重复建 job；跨 session 可见性/取消语义不透明 | H1 由 Bun 扩列并继续写；host 只读；H2 由 host 写 |
| G5 | permission pending 纯内存 | `Permission` pending Map；只持久化 approved | 重启丢审批；无法区分 crash 与 graceful | 新增 `pending_request` |
| G6 | question 完全无持久化 | `Question` 仅内存 Map | 重启丢问题 | 同 `pending_request` |
| G7 | SSE 无 Last-Event-ID / replay | `event.ts` 只订阅 Bus；`global-event-stream.ts` 内存队列；`event` 表仅实验 flag | 断线只能靠客户端全量刷新；durable 事件可能丢 | 新增 `host_event` + 游标 |
| G8 | PTY session/ticket 纯内存 | `pty/index.ts` Map；`ticket.ts` Cache | worker/host 重启后 PTY 不可恢复，ticket 失效 | host 持有 ticket；PTY 由 Bun 收尾 |
| G9 | process registry 无 H1 ownership | 状态只有 running/exited/killed/expired/released；host 无 adoption | H1 不需要解决；H2 才需要 orphaned/adopt | H1 只读/代理；H2 新增 `orphaned` + adopt |
| G10 | 无请求幂等层 | 代码中无通用 correlation/idempotency | 重试重复 turn/job/approval | 新增 `request_idempotency` |
| G11 | 两个数据库、两套迁移 | 主库 Drizzle；项目库 `user_version` | 跨库一致性无事务保证 | 明确表归属；跨库用补偿 |
| G12 | 无 worker registry/heartbeat/drain | 不存在 | host 无法监督/回收 | 新增 `host_worker` |
| G13 | 事件表受实验 flag 控制 | `sync/index.ts` 的 `OPENCODE_EXPERIMENTAL_WORKSPACES` | 默认部署没有 durable event | H1 host log 不依赖该 flag |
| G14 | 后台 job durable 行有 500 上限 | `DURABLE_ROWS_MAX` | 历史 job 被 prune，恢复窗口有限 | H1 明确保留策略与 checkpoint 优先级 |
| G15 | 无 session commit confirmation 协议 | worker 提交 message/part 与 host checkpoint 分属两个事务 | 中间崩溃无法判断“是否已提交” | 新增 `commit.confirm` + `commit_state` + 补偿规则 |
| G16 | `readActiveProcesses` 带写副作用 | `store.ts:2313-2346` 调 `expireStaleProcesses` 并翻转死 pid | 被误当纯只读探针 | H1 文档/诊断标注“带清理副作用的读取” |
| G17 | `host_command_replay` 归属未在恢复矩阵中说明 | IPC 文档定义 command 重放窗口 | 容易和 `host_event` 混为一谈 | §8.8 明确二者边界 |

---

## 8. H1 新增表候选

以下均为**候选 schema**，字段名遵循仓库 snake_case + `<table>_<column>_idx` 约定；未生成 migration，未应用。所有新表默认放在主库（与 checkpoint 同库），以便 host-owned 状态在同一事务内提交。`background_job` 与 `session/message/part` 仍在主库但 H1 由 Bun 写。PTY 进程 registry 保留在项目库。

### 8.1 `host_worker`

```text
host_worker
  worker_id            TEXT PRIMARY KEY          -- host 分配，ULID
  workspace_id         TEXT NOT NULL
  generation           INTEGER NOT NULL          -- 每 workspace 单调递增
  boot_id              TEXT NOT NULL             -- host 进程身份
  pid                  INTEGER NOT NULL
  pgid                 INTEGER
  status               TEXT NOT NULL             -- spawned|handshaking|ready|busy|draining|exited|crashed|killed|unresponsive
  protocol_version     TEXT NOT NULL
  capabilities         TEXT NOT NULL             -- JSON
  started_at           INTEGER NOT NULL
  heartbeat_at         INTEGER
  drain_requested_at   INTEGER
  exited_at            INTEGER
  exit_reason          TEXT
  last_error           TEXT
UNIQUE(workspace_id, generation)
-- 部分唯一索引：每 workspace 至多一个非终态 worker
CREATE UNIQUE INDEX host_worker_active_idx
  ON host_worker(workspace_id)
  WHERE status NOT IN ('exited','crashed','killed')
INDEX host_worker_status_heartbeat_idx(status, heartbeat_at)
INDEX host_worker_workspace_status_idx(workspace_id, status)
```

规则：`generation` 分配与插入同事务；只有 `ready|busy` 可接收命令；`exited/crashed/killed` 为终态，不可复活。

### 8.2 `host_state`

```text
host_state
  scope                  TEXT PRIMARY KEY        -- 'global' 或 workspace_id
  schema_version         INTEGER NOT NULL
  host_generation        INTEGER NOT NULL
  next_worker_generation INTEGER NOT NULL
  next_event_seq         INTEGER NOT NULL
  boot_id                TEXT
  updated_at             INTEGER NOT NULL
```

用途：generation/seq 计数器与 schema preflight。`next_event_seq` 也可由 `host_event` 的 `MAX(seq)+1` 在事务内取号；若采用计数器，必须与 event 插入同事务更新。`host_generation` 只增不减，启动时校验不回退。

### 8.3 `session_turn_checkpoint`

```text
session_turn_checkpoint
  session_id           TEXT NOT NULL
  turn_id              TEXT NOT NULL
  turn_seq             INTEGER NOT NULL
  generation           INTEGER NOT NULL          -- canonical 语义名 turn_generation（ipc-v0 §1.2）
  worker_id            TEXT
  worker_generation    INTEGER
  status               TEXT NOT NULL             -- accepted|running|waiting_permission|waiting_question|waiting_tool|cancelling|cancelled|completed|failed|interrupted
  commit_state         TEXT NOT NULL             -- uncommitted|committed_unconfirmed|confirmed
  commit_token         TEXT                      -- worker 提交确认幂等键
  completion_source    TEXT                      -- worker_confirmed|recovered_confirmation|host_derived
  terminal_source      TEXT                      -- worker|cancel|crash_sweep|recovery
  intent               TEXT NOT NULL             -- JSON: prompt/agent/model/parts 引用
  resume_policy        TEXT NOT NULL             -- none|retry_safe|manual
  side_effect_state    TEXT NOT NULL             -- none|committed|unknown
  last_message_id      TEXT
  last_event_seq       INTEGER
  cancel_requested_at  INTEGER
  error                TEXT
  created_at           INTEGER NOT NULL
  updated_at           INTEGER NOT NULL
  PRIMARY KEY(session_id, turn_id)
)
INDEX session_turn_checkpoint_session_status_idx(session_id, status)
INDEX session_turn_checkpoint_worker_idx(worker_id, worker_generation)
-- 部分唯一索引：每 session 至多一个非终态 turn
CREATE UNIQUE INDEX session_turn_checkpoint_active_idx
  ON session_turn_checkpoint(session_id)
  WHERE status IN ('accepted','running','waiting_permission','waiting_question','waiting_tool','cancelling')
```

`intent` 必须是有界 JSON：不得塞入完整消息历史；只存重建执行所需的引用和摘要。大 payload 留在 `message/part`，checkpoint 只存 id/水位。

### 8.4 `pending_request`

```text
pending_request
  request_id           TEXT PRIMARY KEY          -- 生命周期内稳定，重新发布不换
  request_key          TEXT NOT NULL             -- host 生成的幂等键：kind:turn_id:tool_call_id 或 kind:turn_id:ask_seq
  kind                 TEXT NOT NULL             -- permission|question
  session_id           TEXT NOT NULL
  turn_id              TEXT
  worker_id            TEXT
  worker_generation    INTEGER                   -- 本次发布的 worker generation
  tool_call_id         TEXT                      -- 可空
  status               TEXT NOT NULL             -- pending|answered|rejected|expired|orphaned
  payload              TEXT NOT NULL             -- JSON: 问题/权限模式/元数据
  answer               TEXT                      -- JSON
  generation           INTEGER NOT NULL          -- republish attempt generation，从 1 开始
  expires_at           INTEGER
  created_at           INTEGER NOT NULL
  updated_at           INTEGER NOT NULL
-- 非终态唯一性：tool_call_id 可空，因此不用裸 UNIQUE
CREATE UNIQUE INDEX pending_request_active_key_idx
  ON pending_request(session_id, request_key)
  WHERE status = 'pending'
INDEX pending_request_session_status_idx(session_id, status)
INDEX pending_request_status_expires_idx(status, expires_at)
```

规则：

- `request_id` 稳定；每次重新发布只 `generation+1`，并更新 `worker_generation` 与 `expires_at`。
- `request_key` 在创建时确定且不随重新发布变化；无 `tool_call_id` 的请求由 host 用 `ask_seq`（同 turn 内递增）填充，保证可唯一。
- 旧 generation 的 reply 必须被拒绝；同一 `(request_id, generation)` 的重复 reply 幂等返回。
- SQLite 的裸 `UNIQUE` 对 NULL 不生效，禁止用 `UNIQUE(session_id, turn_id, kind, tool_call_id)` 表达该约束。

### 8.5 `host_event`

```text
host_event
  seq                  INTEGER PRIMARY KEY       -- 全局 durable 游标，SSE Last-Event-ID
  event_id             TEXT NOT NULL UNIQUE     -- 稳定事件 id
  dedupe_key           TEXT NOT NULL UNIQUE     -- 幂等键，如 turn:<turn_id>:completed
  workspace_id         TEXT
  project_id           TEXT
  aggregate_id         TEXT NOT NULL            -- session/job/worker id
  aggregate_seq        INTEGER                  -- 每 aggregate 的 durable 顺序
  type                 TEXT NOT NULL
  worker_id            TEXT
  worker_generation    INTEGER
  payload              TEXT NOT NULL            -- JSON
  created_at           INTEGER NOT NULL
CREATE UNIQUE INDEX host_event_aggregate_seq_idx
  ON host_event(aggregate_id, aggregate_seq)
  WHERE aggregate_seq IS NOT NULL
INDEX host_event_created_idx(created_at)
```

规则：

- 只允许 host 写；**只存 durable**。`control`/`transient` 不进入此表，也不分配 `seq`/`aggregate_seq`。
- `seq` 与 `aggregate_seq` 在同一事务内取号 + 插入；禁止先广播后落库。
- `dedupe_key` 唯一索引承担幂等；重复插入返回已有行，不递增 `seq`。
- `transport_sequence` 不落此表；worker 重连的 command 重放走 `host_command_replay`（§8.8）。
- 保留策略必须是显式窗口（按行数/时间/字节），并记录 `retention_floor_seq`，供 `stream_reset` 判断。

### 8.6 `request_idempotency`

```text
request_idempotency
  scope                TEXT NOT NULL             -- workspace/session/instance
  idempotency_key      TEXT NOT NULL
  request_hash         TEXT NOT NULL             -- 防同 key 不同 body
  operation            TEXT NOT NULL             -- prompt|job.start|permission.reply|...
  status               TEXT NOT NULL             -- in_flight|completed|failed
  response_ref         TEXT                      -- turn_id/job_id/request_id
  response_body        TEXT
  generation           INTEGER                   -- 仅诊断，不用于放行
  owner_session_id     TEXT                      -- job.start 的可见性归属
  created_at           INTEGER NOT NULL
  expires_at           INTEGER NOT NULL
  PRIMARY KEY(scope, idempotency_key)
INDEX request_idempotency_expires_idx(expires_at)
```

同一 key 不同 `request_hash` 返回 409 `idempotency_conflict`；`in_flight` 重复请求返回 409/202（由 API 语义决定），不得并行执行两次。`generation` 字段只用于诊断与冲突定位，不参与写入闸门。

### 8.7 现有表的扩列（expand 阶段，不重建）

| 表 | 新增列 | H1 写者 | 目的 |
|---|---|---|---|
| `background_job` | `owner_session_id TEXT`、`owner_worker_id TEXT`、`worker_generation INTEGER`、`request_id TEXT`、`recovery_state TEXT NOT NULL DEFAULT 'none'`、`cancel_requested_at INTEGER` | **Bun**（host 只读） | owner/fencing/恢复维度；H2 才切 host 写 |
| `session_turn_lease` | `turn_id TEXT`、`worker_generation INTEGER`、`renewed_at INTEGER` | **Bun**（host 只读） | 与 checkpoint/worker 对齐；H2 才切 host 写 |
| `event` / `event_sequence` | 不改；H1 由 `host_event` 承担全局 replay | Bun | 避免破坏 workspace sync |
| `chimera_process_registry`（项目库） | H1 **不新增列**；`orphaned`/`adopted_by_boot_id` 留到 H2 | Bun | H1 不做 adoption |

字段关系（必须写清，避免实现时混用）：

- `owner_session_id`：可见性与 cancel 权利归属；来自 `Info.ownerSessionId` 的类型化投影。
- `owner_worker_id` + `worker_generation`：执行该 job 的 worker 代次；用于拒绝旧 generation 的完成通知。
- `request_id`：创建该 job 的幂等请求标识，指向 `request_idempotency.response_ref`；**不是 job id**，也不用于 fencing。
- `recovery_state`：恢复维度，由 `status` + owner 是否存活 + 显式策略派生；H1 由 Bun 写，host 只读。

### 8.8 `host_command_replay`（IPC-owned，非业务事实源）

`ipc-v0.md` 定义的 `host_command_replay` 是 host→worker durable command 的有界重放窗口，用于 worker 重连时从 `last_acked_command_sequence` 之后补发 command。它与本文的关系：

- **属于 IPC 传输层，不属于业务恢复矩阵。** 它的 `command_sequence` 不是 `host_event.seq`，也不是 `aggregate_seq`；不得用于客户端 SSE 的 `Last-Event-ID`。
- **不是 durable 业务事实。** command 重放窗口可以裁剪；裁剪后 worker 只能重新握手，不能假设 command 可无限重放。
- **生命周期绑定 worker generation。** worker generation 进入终态后，该 generation 的 replay 窗口可以被清理；清理不影响 `host_event`。
- **本文不定义其 schema。** 以 `ipc-v0.md` 为准；本文只在 §5.3.2 与本节声明三层序号的边界，避免把 command replay 误当事件日志。

### 8.9 可选/暂缓

- `pty_ticket` 持久表：**建议暂缓**。60s TTL + 单次消费 + host 单实例场景下，host 内存足够；host 重启后 ticket 失效是可接受语义。只有当 H1 需要多 host 共享 ticket 时才落库。
- `worker_heartbeat` 独立表：**不建**，heartbeat 写 `host_worker.heartbeat_at`，避免每 worker 高频小行。
- `process_orphan` 独立表：**H1 不建**。H2 用 `chimera_process_registry.status='orphaned'` + `adopted_by_boot_id`，并同时定义 adoption CAS 与 sweep 竞态处理。
- `session_commit_ledger` 独立表：**H1 不建**，提交确认状态放在 `session_turn_checkpoint.commit_state`/`commit_token`；若后续需要审计多次确认，再评估。

---

## 9. 迁移与回退顺序

### 9.1 迁移纪律（必须遵守）

1. 主库只用 Drizzle Kit：在 `packages/chimera` 执行 `bun run db generate --name <slug>`；产出 `migration/<timestamp>_<slug>/migration.sql` + `snapshot.json`，测试按 per-folder 布局读取，不依赖 `_journal.json`。
2. 绝不修改已应用的 migration；绝不把新列折进旧 `CREATE TABLE`（会产生 lineage 分叉）。
3. 需要幂等修复时走 `Database.applyMigrations` 的第二遍 repair，不在 migration SQL 里写裸 `ALTER TABLE ADD COLUMN` 期待它幂等。
4. 项目库（`src/chimera/store.ts`）使用 `PRAGMA user_version` 内联迁移；H1 不新增 version 9 对象（process registry 不变）；H2 再升版本。
5. H1 所有新表/列都是 **additive**；H1 不删除、不重命名现有列。
6. migration 由 host 在 spawn worker 之前执行；worker handshake 报告 `schema_version`，不匹配拒绝启动。
7. 执行 migration 前记录 WAL 状态；migration 后执行一次 `PRAGMA wal_checkpoint(PASSIVE)` 作为观测点，不把它当备份。

### 9.2 分阶段顺序

| 阶段 | 内容 | 写路径 | 读路径 | 回退 |
|---|---|---|---|---|
| M0 preflight | host 读取 `user_version`/drizzle 迁移表；检查 `host_state.schema_version`；检查 `host_generation` 不回退 | 无 | 只读 | 不满足则 fail closed，不启动 worker |
| M1 expand | 建 `host_worker`/`host_state`/`session_turn_checkpoint`/`pending_request`/`host_event`/`request_idempotency`；给 `background_job`/`session_turn_lease` 加可空列 | 只有 host 写新表；Bun 继续写旧表与新列 | 旧路径不读新表 | feature flag 关闭；新表留空，无副作用 |
| M2 shadow write | host 在现有流程旁写 checkpoint/pending/event；Bun 仍是 session 执行权威；host 不双写旧表 | host 写 host-owned 新表；Bun 写 session/job/lease | 仍读旧路径 | 关闭 host 新写；新表数据可保留或按 TTL 清理 |
| M3 read flip（逐面） | 依次翻转：worker registry → checkpoint → pending_request → event replay；**job owner 与 session 写者不翻** | 对应面 host 写/读 | 对应面 host 读 | 每个面独立 flag；回退到 Bun 读路径 |
| M4 contract | 仅在一次完整发布周期和 soak 后；删除旧内存路径/旧列 | host | host | 不提供 destructive down；用上一个二进制 + 兼容读 |
| M5 H2 writer flip | session/message/part、permission、background_job、lease 写者切到 host；引入同事务提交 | host | host | H2 单独设计；不在 H1 范围 |

### 9.3 回退规则

- **H1 不提供 down migration。** 回退 = 关闭 `host.enabled`/逐面 flag，恢复 Bun 直连；新表保留但不写。
- 回退后 Bun 路径不得依赖新表；若某面已经 read-flip，回退前必须确认旧路径仍能读到完整数据（新表只是附加，不是唯一来源）。
- 若 host 已写入 `pending_request`/`host_event` 后回退，Bun 必须忽略这些行；不能因为“表存在”就假设有 host。
- `host_generation` 一旦前进，旧二进制不得写回更小值；回退后的新 host 启动必须继续递增。
- 回退演练必须覆盖：已有新表、WAL 未 checkpoint、旧 worker 仍持有 lease、SSE 客户端带 `Last-Event-ID`、`commit_state=committed_unconfirmed` 的 checkpoint。

### 9.4 数据保留

| 表 | 保留策略 | 依据 |
|---|---|---|
| `session_turn_checkpoint` | 终态保留 N 天；非终态不 prune | 恢复窗口 |
| `pending_request` | 终态 + `expires_at` 后 N 天 | 审计/幂等 |
| `host_event` | 按行数/时间/字节显式窗口；记录 `retention_floor_seq` | replay 能力 |
| `request_idempotency` | 至少覆盖客户端重试窗口 | 防重复 |
| `host_worker` | 终态保留 N 天 | 诊断 |
| `background_job` | 现有 500/instance 上限；H1 需保证 checkpoint 不被 job prune 连带删除 | 恢复 |

所有保留策略必须有上限，禁止无界增长；这是 RUST_HOST_MIGRATION_PLAN 风险表中 “Rust host 自身增长” 的直接约束。

---

## 10. 测试矩阵

### 10.1 单元/契约

| ID | 场景 | 断言 |
|---|---|---|
| U1 | turn 状态机合法迁移 | 非法迁移抛错；终态不可再迁移 |
| U2 | generation 分配 | 四个层级各自严格 +1；重启后继续；互不替代 |
| U3 | 旧 generation 写入 | 返回 `stale_generation`；DB 不变 |
| U4 | 幂等键重复 | 同 key 同 body 返回首次结果；同 key 不同 body 409 |
| U5 | event seq 取号 | 并发 append 无重复 seq；失败事务不占号；`aggregate_seq` 与全局 `seq` 独立 |
| U6 | `Last-Event-ID` 边界 | 窗口内补发；窗口外 `stream_reset`；不映射 `aggregate_seq`/`transport_sequence` |
| U7 | pending request 唯一性 | 同 turn/tool_call 不产生第二条 pending；`tool_call_id` 为 NULL 时靠 `request_key` 去重 |
| U8 | cancel 幂等 | 重复 cancel 返回同一终态；只发一次 durable 事件 |
| U9 | job delivery generation | 旧 generation `markDelivered` no-op |
| U10 | checkpoint 部分唯一索引 | 同 session 第二个非终态 turn 插入失败 |
| U11 | 终态优先级 | completed/cancelled 不被 crash sweep 覆盖；cancel intent 优先于 interrupted |
| U12 | host_event 只存 durable | control/transient 插入被拒绝或不分配 seq |
| U13 | commit confirmation 幂等 | 同 `commit_token` 重发返回同一 ack；不重复插事件 |
| U14 | process registry 读取副作用 | `readActiveProcesses` 调用后死 pid 行变 `expired`；文档/诊断标注该副作用 |

### 10.2 集成/故障注入

| ID | 场景 | 注入 | 断言 |
|---|---|---|---|
| I1 | worker 在 turn 中 SIGKILL | kill -9 worker | turn → `interrupted`；已提交消息保留；无重复 turn |
| I2 | host 在 turn 中 SIGKILL | kill -9 host | 重启后 checkpoint 可读；turn 不自动重跑；lease 可回收 |
| I3 | permission 等待中 worker 崩溃 | kill worker | pending → `orphaned`；客户端 list 可见；reply 返回冲突/只读 |
| I4 | question 等待中 host 重启 | kill host | 同上；approved ruleset 不丢 |
| I5 | 同 prompt 重试 | 同 Idempotency-Key 两次 | 只创建一个 turn；第二次返回同一 turn_id |
| I6 | 同 job start 重试 | 同 job_id + generation | 不重复启动；返回既有快照 |
| I7 | cancel 与完成竞态 | cancel 与 worker completion 同时 | 终态恰好一个；cancel intent 先落库则 `cancelled`，否则 `completed` |
| I8 | 旧 worker 迟到 completion | 旧 generation 发完成帧 | 被拒绝；新 run 不受影响 |
| I9 | SSE 断线重连 | 带 `Last-Event-ID` | durable 事件无缺口；transient 可 gap 且有标记 |
| I10 | SSE 保留窗口外重连 | 旧 seq | `stream_reset` + 快照游标 |
| I11 | PTY worker 崩溃但子进程存活 | kill worker | H1 不伪造 live PTY、不写 registry；H2 才 `orphaned` + adopt |
| I12 | PTY ticket 单次消费 | 同 ticket 两次 connect | 第二次拒绝 |
| I13 | host 重启后 ticket | 旧 ticket | 失效；重新 issue 可用 |
| I14 | process registry 旧 host 行 | 新 boot 启动 | H1 只代理读取；读取会把死行 `expired`；不 adopt |
| I15 | background job open reconcile | 预置 running 行后重启 | 由 Bun 变 `error`；host 不写 job 行；不 phantom running |
| I16 | 双写冲突 | 两进程同时写同一表 | 单写者约束生效；`SQLITE_BUSY` 有界重试；无丢失更新 |
| I17 | migration 中断 | 在 migration 中杀 host | 下次启动可重入；不产生半表/半列 |
| I18 | 回退演练 | 关 flag 回 Bun 路径 | 旧路径可读；新表不阻塞；无重复 turn |
| I19 | worker 提交后、确认前崩溃 | kill worker between commit and confirm | checkpoint `committed_unconfirmed`；恢复为 `completed` 或 `interrupted`，不重放副作用 |
| I20 | host 写事件前崩溃 | kill host after checkpoint | 重启按 `dedupe_key` 补写一次事件；不重复分配 seq |
| I21 | 旧 worker 继续写 session 行 | 旧 generation 执行中 | 行保留但按 `turn_id` 隔离；不改变当前 turn 终态 |

### 10.3 Parity（双臂）

| ID | 场景 | 断言 |
|---|---|---|
| P1 | prompt/steer/abort | 状态码、错误体、SSE 帧与 Bun 直连一致 |
| P2 | permission/question reply | 重复 reply、reject 级联、错误码一致 |
| P3 | PTY create/connect/remove | ticket query/header、单次消费、WS 关闭码一致 |
| P4 | global SSE | connected/heartbeat/gap 帧形状一致；新增 `Last-Event-ID` 不破坏旧客户端 |
| P5 | OpenAPI | host 代理不改变 operation/schema；SDK 生成无漂移 |
| P6 | 取消/重试 | 终态、事件顺序、客户端可观察行为一致 |

### 10.4 迁移测试

| ID | 场景 | 断言 |
|---|---|---|
| M1 | 空库全量迁移 | 所有表/索引存在；`schema_version` 正确 |
| M2 | 从当前 HEAD 升级 | 旧数据完整；新表为空；旧列不丢 |
| M3 | 重复启动 | 迁移幂等；不重复建表 |
| M4 | 项目库不变 | H1 不新增 version 9 对象；旧 registry 行可读 |
| M5 | 回退后旧二进制 | 可启动；不读新表；不写更小 generation |
| M6 | lineage repair | `share_url` 修复路径不受新 migration 影响 |

---

## 11. 验收目标（candidate defaults，待 H0 校准）

> 本节所有数字都是**候选默认值（candidate defaults）**，用于 H1 设计与 H0 基线采集，**不是已批准的 hard gate**。H0 必须先给出 Bun-only 基线，H1 评审后再决定是否把这些数字写成硬门。语义正确性条目（C1–C5、C7–C9）没有数字，保持为 H1 语义要求；恢复时间与性能数字统一移到 §11.2 并标注“待校准”。

### 11.1 正确性目标（语义门，无数字）

| 门 | 指标 | 通过条件 |
|---|---|---|
| C1 | 重复 turn/job/approval | 故障注入 + 重试矩阵中 = 0 |
| C2 | 旧 generation 被接受 | = 0 |
| C3 | durable event 丢失 | = 0（保留窗口内） |
| C4 | SSE replay 收敛 | 重连后客户端状态与 DB 快照一致 |
| C5 | cancel 终态 | 每个 turn 恰好一个终态 |
| C7 | 进程归属 | H1 只要求不伪造归属；H2 才要求无 “running 但 pid 已死” 超过一个 sweep 周期 |
| C8 | 回退 | 关闭 flag 后旧路径可用；无重复副作用 |
| C9 | commit confirmation | 未确认提交不会被当成 `completed`，也不会被重放副作用 |

### 11.2 性能/恢复候选阈值（candidate defaults，待 H0 校准）

| 门 | 指标 | 候选默认值 |
|---|---|---|
| P1 | IPC 附加延迟 | p95 ≤ 10ms（控制帧）；不按 token 计 |
| P2 | 事件吞吐 | host_event 写入 ≥ 5k events/s（单库、批量事务） |
| P3 | SSE fan-out | 64 连接下 p95 帧延迟 ≤ 50ms；无队列持续满 |
| P4 | replay | 10k durable events 重放 ≤ 2s |
| P5 | DB 写 | turn checkpoint 提交 p95 ≤ 20ms；`SQLITE_BUSY` 比例 < 0.1% |
| P6 | worker 回收 | drain 到进程退出 ≤ 10s（无长工具时） |
| P7 | 恢复时间 | host 重启后 100 个非终态 session 的恢复 ≤ 30s |

> 阈值不是承诺；H0 必须先给出 Bun-only 基线，H1 只允许“不劣化超过预算”，不允许用混合平均数掩盖单面回归。

### 11.3 内存目标（候选）

| 门 | 指标 | 候选通过条件 |
|---|---|---|
| M1 | 空闲 host | 不 spawn worker；host RSS/footprint 可解释且稳定 |
| M2 | worker 回收 | worker 退出后其地址空间不再计入进程树；host 不吸收等量增长 |
| M3 | 24h soak | process tree 不随 session 数/时间单调增长 |
| M4 | 72h soak | 无持续增长的 event log/checkpoint/pending 行；保留策略生效 |
| M5 | 8 路并发 | 峰值可回落；worker churn 有上限 |

### 11.4 Soak 场景

1. 空闲 host 24h：无 worker、无 SSE、无请求。
2. 单项目 8 路 session 连续 24h：turn 循环、permission/question、cancel、SSE 重连。
3. 多项目（≥3）24h：workspace 隔离、process registry 跨项目、SSE 多连接。
4. 故障注入 72h：每小时随机 kill worker，每 6h kill host；统计恢复成功率、重复率、orphan 数。
5. 升级/回退演练：H1 二进制 → 回退 Bun → 再升级；检查 generation 不回退、新表不阻塞。
6. 保留策略压力：持续写入 event/checkpoint，验证窗口裁剪与 `stream_reset`。
7. commit confirmation 压力：worker 在提交与确认之间随机崩溃，验证 `committed_unconfirmed` 收敛。

### 11.5 证据产物

- 每次 run 输出：host/worker/process-tree 的 RSS、`phys_footprint`、compressed/swap、shared/file-backed、FD、线程、SQLite page cache/WAL 大小。
- 计数：worker 创建/回收/原因、stale_generation 拒绝数、replay 次数、gap 次数、orphan 数、重复 turn/job 数、`committed_unconfirmed` 数。
- 失败必须附 trace id / turn id / job id / worker generation，便于对账。

---

## 12. 外部参照（非 Chimera 事实源）

以下仅作为设计模式参考，**不得**把其文件快照、字段名或状态值当作 Chimera 的现状或契约。

### 12.1 本地 Codex app-server 的 recovery 模式

观察到的模式（本地只读参考）：

- 用**原子写**维护一个 recovery snapshot，记录 `interrupted` turn 候选；
- 只有具备本地执行身份/线程自有配置的 turn 才允许自动续跑；旧快照缺少身份信息时“重新加载但不续跑”；
- 恢复候选与 loaded 集合放在同一原子文件，避免 stale sidecar。

可借鉴的结论：

- 恢复候选必须原子落盘，不能靠内存；
- 自动续跑必须被身份（generation/worker/环境）门控；
- 身份不明时默认不续跑，转人工/可重试。

### 12.2 本地 Pinvou relay 的协议模式

观察到的模式（本地只读参考）：

- 协议消息带显式版本 `v`，未知版本拒绝而不是猜测；
- Web 客户端 join 携带 `stream_epoch` + `after_seq`，由**桌面端**拥有 replay/journal，relay 不分配 sequence；
- 历史不足时用 `stream_reset` 或 `desktop_snapshot`，不假装连续；
- lease takeover 有明确的替换通知与关闭码。

可借鉴的结论：

- epoch/generation + after-seq 是恢复协议的最小组合；
- 事件日志的所有者必须明确，不能让中间层猜；
- 无法补发时显式 reset，比静默 gap 更安全；
- lease 替换必须通知旧持有者。

---

## 13. 明确不做 / 未实现声明

- 本文没有创建任何表、migration、索引或运行时代码。
- 本文没有修改 `turn-lease`、`background-job`、`permission`、`question`、`pty`、`event`、process registry 的任何行为。
- 本文没有构建、安装或执行新的 host/worker 二进制。
- 本文没有声称 `host_worker`、`host_state`、`session_turn_checkpoint`、`pending_request`、`host_event`、`request_idempotency` 已存在。
- 本文没有把 session/message/part 的写者切到 host；H1 仍由 Bun worker 写，H2 才翻转。
- 本文没有引入 process registry 的 adoption、写回或 `orphaned` 状态；这些是 H2 范围。
- 本文没有改变 `OPENCODE_EXPERIMENTAL_WORKSPACES`、SQLite bridge 或任何 feature flag 的默认值。
- 本文没有把 Codex/Pinvou 的本地文件快照当作 Chimera 的数据来源或兼容性证据。
- 本文没有修改 `ipc-v0.md`、`RUST_HOST_MIGRATION_PLAN.md` 或任何运行时代码；`host_command_replay` 的 schema 与语义以 `ipc-v0.md` 为准。

---

## 14. 待父级/H1 评审拍板

### 14.1 协议语义

1. `session_turn_checkpoint` 的 `intent` 边界：只存引用，还是允许存压缩后的 prompt 摘要？
2. `pending_request` 在 host 重启后，recoverable turn 是“重新发布同 request_id + `generation+1`”，还是统一 `orphaned` 让客户端重问？
3. `host_event` 的保留窗口按时间、行数还是字节；默认值多少？
4. `commit.confirm` 的“提交完成”判定：以 assistant message 的终态 part 为准，还是以 worker 显式 `part_watermark` 为准？超时后 host 判定 `interrupted` 的阈值是多少？
5. H1 中旧 worker 已 append 的迟到 session 行，是否需要在 UI/查询层隐藏？按 `turn_id` 隔离是否足够？
6. `background_job` 是否新增 `interrupted` 状态，还是只加 `recovery_state` 保持 4 状态兼容（本文倾向后者）。H1 由 Bun 写该列是否可接受？
7. 项目库与主库的跨库一致性是否接受“补偿 + 只读代理”而不引入第二套事务协调。
8. `request_idempotency` 的 TTL 与客户端重试窗口如何对齐（SDK 默认重试策略需同步）。
9. H1 是否把 PTY ticket 收敛到 host 内存（本文倾向是），还是必须落库以支持多 host。

### 14.2 新增 schema/协议待决项

10. `pending_request.request_key` 在无 `tool_call_id` 时的生成规则：同 turn 内 `ask_seq` 由谁分配、worker 重连后如何保持稳定？
11. `host_event.aggregate_seq` 是否必须（还是允许 NULL 只靠全局 `seq`）；若必须，aggregate 的粒度是 session 还是 turn？
12. `host_event.dedupe_key` 的命名规范与冲突处理：同一 `dedupe_key` 但 payload 不同应返回 409 还是覆盖诊断？
13. `host_command_replay` 的保留窗口与清理时机是否完全由 `ipc-v0.md` 决定；恢复矩阵是否需要额外约束（本文倾向不需要）。
14. `background_job.owner_session_id` 作为独立列（由 Bun 写）是否与 `data` JSON 内的 `ownerSessionId` 产生双写漂移；是否需要 drift-guard 测试。
15. `session_turn_checkpoint.commit_state=committed_unconfirmed` 是否需要独立的超时/重试预算，还是统一走 `resume_policy`。
16. `host_state.next_event_seq` 计数器与 `MAX(seq)+1` 取号二选一；若用计数器，崩溃后如何校验不回退。

---

## 附录 A：证据锚点

| 主题 | 文件:行 |
|---|---|
| 主库路径/WAL/迁移应用 | `src/storage/db.ts:31-44`、`:109-177`、`:182-190`、`:224-242` |
| 迁移目录/repair | `src/storage/db.ts:61-68`、`:83-101`；`migration/` 29 个目录 |
| session/message/part 表 | `src/storage/tables/session.sql.ts:18-88` |
| permission ruleset 表 | `src/storage/tables/session.sql.ts:182-188` |
| turn lease 表 | `src/session/turn-lease.sql.ts:24-30` |
| lease TTL/renew/CAS | `src/session/turn-lease.ts:96-110`、`:114-152`、`:163-215` |
| Runner/lease 接入 | `src/session/run-state.ts:108-187` |
| session status 内存态 | `src/session/status.ts:10-26`、`:53-83` |
| background_job 表 | `src/agent/background-job.sql.ts:20-38` |
| job 状态/持久化/恢复 | `src/agent/background-job.ts:13-38`、`:167-261`、`:325-348`、`:459-532`、`:559-598` |
| job owner/visibility/cancel | `src/agent/background-job.ts:22`、`:114`、`:495-503`；`src/tool/task-cancel.ts:50-52`；`src/session/prompt.ts:508` |
| permission pending | `src/permission/index.ts:142-183`、`:185-279` |
| question pending | `src/question/index.ts:108-153`、`:155-221` |
| PTY session 内存态 | `src/pty/index.ts:135-153`、`:175-259` |
| PTY ticket | `src/pty/ticket.ts:9-55` |
| process registry 表/迁移 | `src/chimera/store.ts:598-623` |
| process registry 状态/TTL/sweep | `src/chimera/store.ts:2150-2346` |
| `readActiveProcesses` 清理副作用 | `src/chimera/store.ts:2313-2346`（`expireStaleProcesses` + 死 pid `expired` UPDATE） |
| process registry 高层 API | `src/chimera/process-registry.ts:18-125` |
| event 表/seq | `src/sync/event.sql.ts:3-17`；`src/sync/index.ts:155-175`、`:293-317` |
| sync history/replay | `src/server/routes/instance/sync.ts:67-121`、`:165-205` |
| SSE 内存队列/gap | `src/server/global-event-stream.ts:8-20`、`:87-186`、`:251-391` |
| legacy /event | `src/server/routes/instance/event.ts:39-111` |
| part orphan reconcile | `src/session/part-reconcile.ts:31-120`、`:209+` |
| host boot id 约定 | `src/session/turn-lease.ts:6-18`；`src/chimera/store.ts:195-205` |
| IPC 三层序号/generation | `specs/rust-host/ipc-v0.md` §1.1–§1.2、§7.3、§8.4 |
| `host_command_replay` | `specs/rust-host/ipc-v0.md` §1.1、§5.9、§7.3、附录表 |

## 附录 B：术语

- **Durable**：写入 SQLite 且跨 host/worker 重启仍可作为事实依据。
- **Transient**：允许丢失、可从快照重建的流式状态（token delta、心跳、发送缓冲）。
- **Fencing**：用单调 generation 拒绝旧执行体写入。
- **Checkpoint**：turn 级恢复锚点，记录意图、水位、策略，不复制完整消息历史。
- **Host-control commit-before-ack**：host 先把 host-owned 控制状态（checkpoint/pending/event/idempotency）落库，再向客户端或 worker 确认。
- **Session commit confirmation**：worker 提交 session 行后向 host 发送 `commit.confirm`，由 host 校验并推进 checkpoint；H1 用它弥补两个事务之间的原子性缺口。
- **Orphaned**：原 owner 已消失、资源可能仍存活、归属待定的状态；H1 不引入 process registry 的该状态，H2 才使用。
- **带清理副作用的读取**：像 `readActiveProcesses` 这样在读取过程中顺手把过期/死 pid 行改为 `expired` 的读操作，不能当纯只读探针。