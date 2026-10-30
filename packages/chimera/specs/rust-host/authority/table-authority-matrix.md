# 表级权威矩阵（WP-05）

状态：契约阶段。contract_rev：`cr-2026-10-30-r1`。基线 HEAD：`9600ee7f49ddcb065a33511f21f570d2b2d13a19`。
本文件只读引用已应用迁移，不生成新 migration，不修改 `packages/chimera/src/**`。

## 1. 读法

- **覆盖口径**：主应用库 = `drizzle.config.ts` 的 `schema: "./src/**/*.sql.ts"` 声明的全部 Drizzle 表（37 张）+ Drizzle 迁移账本 `__drizzle_migrations`；项目图库 = 图核心 9 张 + FTS 虚表 1 张 + storage extension 目录 2 张 + Chimera overlay 14 张。合计 64 行。
- **8 列定义**：
  - `owner`：当前权威 owner 与 Rust 化目标 owner；未拍板的写“待拍板”。
  - `migrator`：创建/变更该表的迁移线；主库为 Drizzle 目录，项目图库为 graph migration 版本或 storage extension 版本。已应用迁移只引用、不改写。
  - `reader` / `writer`：主要读写入口，给 `file:line`；同一文件多个位置用逗号分隔。
  - `可重建性`：表内容能否从源文件/事件/上游事实重建；`否` 表示丢失即事实丢失。
  - `恢复`：崩溃/重启后的收敛方式；引用既有 `recovery-matrix.md` 章节时不再重复全文。
  - `保留`：TTL、裁剪、软删除、级联删除；已拍板与建议分开标注。
  - `换权协议`：该表从 TS/Bun 切到 Rust host（或反向回退）的前置、顺序与回退边界。
- **单写者原则**：任一表在任一时刻只有一个写入方；矩阵中的 `writer` 是当前实现事实，不是允许多写。H2 的“双写”只能是 shadow 计算 + 对账，不是两个进程同时 commit（`h2-data-plane.md` §0.3、§4.5）。

## 2. 主应用库：Drizzle 表（37 + 账本）

<!-- main-db:start -->

### 2.1 session / 内容域（11 张）

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `session` | TS Session → Rust host（H2 flip #4） | Drizzle `20260127222353_familiar_lady_ursula`；ALTER `20260227213759`/`20260428004200`/`20260501142318`/`20260625093922`；`20260901000000` repair pass | `src/session/session.ts:754,1311-1404`；`src/session/prompt.ts:2437` | `src/session/projectors.ts:89,97,173`；`src/session/projectors-next.ts:123,133`；`src/project/project.ts:350` | 否：标题/模型/权限/归档元数据是权威；目录可再扫描但 id/时间不可重建 | 已提交行保留；checkpoint + part-reconcile 收敛；不自动重放副作用 | 已拍板 30 天（计划 §13:362）；实现为显式 `chimera session prune --older-than`（`src/cli/cmd/session.ts:92-113`），无自动任务 | H2 flip #4：读写 parity + checkpoint 同事务 + 读路径一个发布周期；回退 Bun 写 |
| `message` | TS Session/projectors → Rust host（H2 flip #6） | Drizzle `20260127222353_familiar_lady_ursula` | `src/session/message-v2.ts:1164-1166,1279-1285`；`src/session/part-reconcile.ts:169-175` | `src/session/projectors.ts:114-121,130-131`；`src/cli/cmd/import.ts:186` | 否：对话事实；只有完整 transcript 才可能重放 | 已提交保留；running/pending tool part 由 part-reconcile 转 error；未确认提交走 commit.confirm 补偿 | 随 session 级联删除（FK cascade）；30 天策略同 session | H2 flip #6：消息提交与 checkpoint/event 同事务；旧写者回退前只读验证 |
| `part` | TS Session/projectors → Rust host（H2 flip #7） | Drizzle `20260127222353_familiar_lady_ursula` | `src/session/message-v2.ts:1225-1241,1328-1355`；`src/session/part-reconcile.ts:122-141` | `src/session/projectors.ts:136-145`；`src/session/part-reconcile.ts:161-163`；`src/cli/cmd/import.ts:202` | 否：工具调用/输出事实；compaction 只清 tool output（`src/session/message-v2.ts:1209-1239`） | part-reconcile 增量扫描 watermark；running/pending → error | 随 session/message 级联删除；compaction 不删行 | H2 flip #7：part_watermark 生效；reconcile 由 host 承担 |
| `todo` | TS Session → Rust host | Drizzle `20260127222353_familiar_lady_ursula` | `src/session/todo.ts:70` | `src/session/todo.ts:49-51` | 是：todo 可由模型/会话重算，但当前内容视为会话事实 | 已提交保留；无独立 checkpoint | 随 session 级联删除 | 随 session flip；单表写者 |
| `work_brief` | TS Session → Rust host | Drizzle `20260603164428_work_brief` | `src/session/work-brief.ts:127`；`src/session/prompt.ts:536-538` | `src/session/work-brief.ts:136-138` | 部分：模型产物，丢失后不可精确重建 | 已提交保留 | 随 session 级联删除 | 随 session flip |
| `goal` | TS Session goal loop → Rust host | Drizzle `20261008000000_session_goal` | `src/session/goal.ts:207` | `src/session/goal.ts:240-241,279,342,354,364` | 否：objective/预算/水位是权威 | 已提交保留；continuation 计数用于断路器，崩溃后按 DB 恢复 | 随 session 级联删除 | 随 session flip；goal loop 状态机需 parity |
| `tool_reveal` | TS tool-search → Rust host | Drizzle `20261009060308_tool_reveal` | `src/session/tool-search.ts:429` | `src/session/tool-search.ts:448-451` | 是：可由会话内 reveal 历史重算，但时间戳丢失 | 已提交保留；compaction 边界提升依赖 revealedAt | 随 session 级联删除 | 随 session flip；wire tool array 不依赖该表 |
| `session_message` | TS v2 projector → Rust host（H2 flip #5） | Drizzle `20260427172553_slow_nightmare` | `src/v2/session.ts:308-367`；`src/session/projectors-next.ts:33-55` | `src/session/projectors-next.ts:62-101` | 是：v2 投影由 message/part 事件重放，需事件源完整 | 投影幂等 upsert；崩溃后可重放 | 随 session 级联删除 | H2 flip #5：v2 投影 parity |
| `permission` | TS Permission → Rust host（H2 flip #8） | Drizzle `20260127222353_familiar_lady_ursula` | `src/permission/index.ts:165` | 仅历史 JSON 导入 `src/storage/json-migration.ts:371`；运行时 approved 只写内存（`src/permission/index.ts:253-261`），无 DB 写回 | 否：approved ruleset 是安全权威，不可推断 | 已提交行保留；重启后新批准的 always 规则丢失（内存态），已知恢复缺口 | 随 project 级联删除；无 TTL | flip #8：必须先补运行时写回或明确 legacy；否则不得宣称已持久化 |
| `session_context_epoch` | TS system-context → Rust host | Drizzle `20260903000000_session_context_epoch` | `src/session/context-epoch.ts:41-51` | `src/session/context-epoch.ts:80-118,196` | 是：baseline 可由当前 system prompt 重算，但 epoch 稳定性丢失 | 已提交保留；epoch 失败降级默认 assembly | 随 session 级联删除 | 随 session flip；`experimental.system_context` 默认关闭 |
| `session_part_reconcile` | TS part-reconcile → Rust host | Drizzle `20261023034209_session_part_reconcile` | `src/session/part-reconcile.ts:111-113` | `src/session/part-reconcile.ts:194-196` | 是：watermark 可重建（全量扫描一次） | 崩溃后 watermark 不前进；重复扫描幂等 | 无 TTL；session 删除后残留行 inert（`src/storage/tables/session.sql.ts:208-221`） | 随 session flip；watermark 必须与 part 写者同侧 |

### 2.2 host 控制面（6 张，H1 已由 Rust host 写）

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `host_worker` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | 诊断 SQL / 恢复扫描（`store.rs` 未提供 read_worker）；TS 侧仅 schema 声明 `src/storage/schema.ts:21-26` | `chimera-host/src/store.rs:374-451` | 否：进程身份/代次是权威 | 启动扫描非终态行 → crashed/unresponsive（`recovery-matrix.md` §6.1） | 无 TTL；终态行保留用于诊断（窗口待拍板） | H1 已 host 写；回退=关闭 host 写，旧路径忽略该表（`h2-data-plane.md` §4.4 #0） |
| `host_state` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | `chimera-host/src/store.rs:458-482` | `chimera-host/src/store.rs:484-509` | 否：host_generation/seq 计数器是权威 | host_generation 只增不减；回退 fail closed（`recovery-matrix.md` §5.3.1） | 单行/每 scope；无 TTL | 同 #0；迁移所有权仍 TS Drizzle |
| `session_turn_checkpoint` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | host 恢复扫描直接 SQL（`store.rs` 无 read API） | `chimera-host/src/store.rs:515-608` | 部分：intent 可重放，commit_state 证据不可重建 | `recovery-matrix.md` §5.5 终态优先级；cancel > crash；已提交终态不可覆盖 | 无 TTL；终态行保留用于审计（窗口待拍板） | H1 host 写；H2 session flip 后与 message/part 同事务 |
| `pending_request` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | `chimera-host/src/store.rs:655-693` | `chimera-host/src/store.rs:610-742` | 部分：可从 checkpoint 重新发布同 request_id + generation+1 | host 重启：turn 断 → orphaned；recoverable → 保持 pending + generation+1（`recovery-matrix.md` §6.1） | expires_at 字段；无清理任务（H2 D8/D14 待定） | H1 host 写；H2 继续 host |
| `request_idempotency` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | `chimera-host/src/store.rs:788-880` | `chimera-host/src/store.rs:803-850` | 否：幂等结果必须 durable | in_flight 行重启后按 operation 收敛（未实现，`recovery-matrix.md` §5.2） | expires_at（调用方写）；H2 D14 建议 24h + 清理任务 | H1 host 写 |
| `host_event` | Rust host（H1 已翻转） | Drizzle `20261022022937_host_control_plane` | SSE replay / 恢复扫描直接 SQL（`store.rs` 只提供 append） | `chimera-host/src/store.rs:740-777` | 否：durable event log 是权威 | seq 缺口=数据损坏→degraded；dedupe_key 幂等补写（`recovery-matrix.md` §5.5 #6） | 无裁剪任务（H2 D9 待拍板：时间+行数+字节，retention_floor_seq） | H1 host 写；SSE Last-Event-ID 只映射 seq |

### 2.3 项目 / workspace / 账号 / 分享 / lease（7 张）

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `project` | TS Project → host control-plane（H2 step 6） | Drizzle `20260127222353_familiar_lady_ursula`；ALTER `20260211171708`/`20260423070820` | `src/session/session.ts:1413`；`src/project/project.ts:281,384`；`src/worktree/index.ts:430` | `src/project/project.ts:314,395,427,468,484,537`；`src/storage/json-migration.ts:180` | 部分：worktree 可再扫描，project id/time_initialized 不可重建 | 已提交保留；time_initialized CAS 更新 | 无 TTL；随项目删除/迁移 | 待拍板：H2 §4.4 只列 workspace；project 迁移需单独 parity |
| `workspace` | TS control-plane → Rust host（H2 flip #3） | Drizzle `20260225215848_workspace`；重建 `20260410174513`；ALTER `20260303231226` | `src/control-plane/workspace.ts:596,945,954,1046` | `src/control-plane/workspace.ts:661,993` | 部分：branch/directory 可再推导，extra 不可 | 已提交保留 | 无 TTL；随 project 级联删除 | H2 flip #3：workspace control-plane parity 通过；回退 Bun control-plane |
| `account` | TS account repo | Drizzle `20260228203230_blue_harpoon`；ALTER `20260309230000` | `src/account/repo.ts:58-64,82-90`（active/list 查询） | `src/account/repo.ts:115,130` | 否：凭据/刷新令牌是权威 | 已提交保留；刷新令牌失败需重新登录 | 无 TTL；随账号删除 | 待拍板（D-R4）：凭据表迁移涉及安全边界，不按普通 storage plane 处理 |
| `account_state` | TS account repo | Drizzle `20260228203230_blue_harpoon`；ALTER `20260309230000` | `src/account/repo.ts:58-64`（active 读取 state 指针） | `src/account/repo.ts:69,94` | 是：active 指针可由用户重新选择 | 已提交保留 | 无 TTL | 待拍板（D-R4） |
| `control_account` | LEGACY（TS account） | Drizzle `20260213144116_wakeful_the_professor` | `src/account/account.sql.ts:25-39`（仅 schema 声明；无运行时读取） | 无运行时写路径；仅历史数据 | 否：历史凭据 | 保留只读；不参与新登录 | 无 TTL；建议一个发布周期后删除 | 不迁移；只读保留一个发布周期 |
| `session_share` | TS share-next | Drizzle `20260127222353_familiar_lady_ursula` | `src/share/share-next.ts:230` | `src/share/share-next.ts:320,359` | 否：share secret/url 是权威 | 已提交保留；取消分享即删除 | 随 session 级联删除 | 不迁入 host；share 服务保持 TS |
| `session_turn_lease` | TS Session runner → Rust host（H2 flip #1） | Drizzle `20260929000000_session_turn_lease` | `src/session/turn-lease.ts:31` | `src/session/turn-lease.ts:120-212` | 是：transient coordination，可重新 acquire | TTL 30min + pid probe；崩溃后过期接管（`src/session/turn-lease.ts:104,110`） | TTL 30min（`LEASE_TTL_MS`）；过期行可清 | H2 flip #1：增加 turn_id/worker_generation/renewed_at；host 接管 CAS |

### 2.4 后台任务 / 遥测 / memory / event / 维护（13 张）

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `background_job` | TS BackgroundJob registry → Rust host（H2 flip #2） | Drizzle `20260918000000_background_job` | `src/agent/background-job.ts:219-233` | `src/agent/background-job.ts:194-206,255-256` | 部分：live registry 是运行权威；durable 行是 write-through 投影 | open-time `running` → `error`；不自动重启有副作用任务（`src/agent/background-job.ts` 文件头注释） | 每 instance 500 行，按 updated_at 最旧优先（`src/agent/background-job.ts:171-172,244-261`） | H2 flip #2：增加 owner_worker_id/worker_generation/recovery_state/cancel_requested_at/request_id；Bun write-through 恢复 |
| `model_telemetry_event` | TS ModelTelemetry | Drizzle `20260814000000_model_telemetry` | `src/agent/model-telemetry.ts:1174-1218,1500-1520` | `src/agent/model-telemetry.ts:1191` | 否：审计/委派遥测事实 | 已提交保留；幂等 event_id/checksum | 终态事件按 `compact()` 转 tombstone 后删除（`src/agent/model-telemetry.ts:1522-1610`）；窗口由调用方 before/retentionMs 决定 | 待拍板（D-R3）：计划 §13 的“遥测持久化移除”范围是否含本表 |
| `model_telemetry_tombstone` | TS ModelTelemetry | Drizzle `20260814000000_model_telemetry` | `src/agent/model-telemetry.ts:1582-1589` | `src/agent/model-telemetry.ts:1553,1594` | 是：可由事件删除记录重建，但只保留 checksum | 已提交保留 | tombstone 按 tombstoneBefore 裁剪（`src/agent/model-telemetry.ts:1578-1600`） | 同 D-R3 |
| `model_telemetry_session_binding` | TS ModelTelemetry | Drizzle `20260823000000_model_telemetry_delegation` | `getShadowSessionLineage`（`src/agent/model-telemetry.ts:1670-1698`） | `src/agent/model-telemetry.ts:1738,1748` | 部分：episode/attempt 绑定可由会话重算，但历史 attempt 计数不可精确恢复 | 已提交保留 | 随 session 级联删除 | 同 D-R3 |
| `model_telemetry_delegation` | TS ModelTelemetry | Drizzle `20260823000000_model_telemetry_delegation` | `src/agent/model-telemetry.ts:1174-1180` | `src/agent/model-telemetry.ts:1383,1770` | 部分：delegation 终态可由事件重算 | 已提交保留；terminal_* 字段幂等 | 随 session 级联删除；终态事件压缩 | 同 D-R3 |
| `model_telemetry_oracle_link` | TS ModelTelemetry | Drizzle `20260823000000_model_telemetry_delegation` | `recordShadowOracle` 幂等查询（`src/agent/model-telemetry.ts:1896-1906`） | `src/agent/model-telemetry.ts:1948` | 部分：可从 oracle/verification 事件重建 | 已提交保留 | 随 session 级联删除 | 同 D-R3 |
| `memory_note` | TS Memory worker | Drizzle `20260714000000_memory_system` | `src/memory/store.ts:189-262` | `src/memory/store.ts:136,162,270,287,305,329` | 否：模型生成的长期记忆 | 软删除 `time_deleted`；重启后按 DB 恢复 | 软删除 + `resetScope` 硬删除（`src/memory/store.ts:1264-1330`）；无时间 TTL | 待拍板：memory 是否随 session flip 进 host，还是保持 worker |
| `memory_stage1_output` | TS Memory worker | Drizzle `20260714000000_memory_system` | `src/memory/store.ts:96-99,1240-1300` | `src/memory/store.ts:642,701,742,812,1279` | 是：stage1 输出可由会话重跑，但成本高 | session 删除时 tombstone 或删除（`deleteSessionMemory`） | 随 session 删除；resetScope 删除 | 同 memory 待拍板 |
| `memory_job` | TS Memory worker | Drizzle `20260714000000_memory_system` | `src/memory/store.ts:346-347,960-1000` | `src/memory/store.ts:351,366,863,894,937,1000,1022,1099,1146,1225,1264` | 是：job 队列可从水位重建 | lease_until/ownership_token；过期重新入队 | 完成/失败后按 reset/session 删除；无时间 TTL | 同 memory 待拍板 |
| `memory_session_state` | TS Memory worker | Drizzle `20260714000000_memory_system` | `src/memory/store.ts:449-500,558` | `src/memory/store.ts:460,475,1269,1330` | 是：mode 可由配置/会话重建，pollution 历史不可 | 已提交保留 | 随 session 删除；resetScope 删除 | 同 memory 待拍板 |
| `event_sequence` | TS SyncEvent（实验 flag） | Drizzle `20260323234822_events`；ALTER `20260504145000_add_sync_owner` | `src/sync/index.ts:86-88,162-164` | `src/sync/index.ts:297-308,403-405` | 是：可由 event 重算 seq，但 event 受 flag 限制 | 已提交保留；seq mismatch 抛错 | 无 TTL；仅 `OPENCODE_EXPERIMENTAL_WORKSPACES` 时写（`src/sync/index.ts:296-317`） | 不翻转；host 用 `host_event`，本表保持实验/兼容 |
| `event` | TS SyncEvent（实验 flag） | Drizzle `20260323234822_events` | `src/server/routes/instance/sync.ts:200-202`；`src/server/routes/instance/httpapi/handlers/sync.ts:84-90` | `src/sync/index.ts:308-316` | 是：投影可由 projector 重放 | 已提交保留；重放按 seq | 无 TTL；实验 flag | 不翻转 |
| `storage_maintenance` | TS part-reconcile | Drizzle `20260917000000_storage_maintenance` | `src/session/part-reconcile.ts:211-213,244` | `src/session/part-reconcile.ts:201,217` | 是：marker 丢失最多重跑一次修复 | 幂等；同 prefix 旧 marker 被删除 | 无 TTL；完成标记常驻，旧 prefix 清理 | 随 session flip；marker key 语义必须保留 |
| `__drizzle_migrations` | TS Drizzle migrator（基础设施账本） | Drizzle `migrate()`（`src/storage/db.ts:52-68`） | drizzle migrator（`src/storage/db.ts:61-68`） | drizzle migrator（`src/storage/db.ts:61-68`） | 是：可重建（重新应用迁移） | 迁移账本；失败可重试 | 永久 | 永不交给 Rust host；host 只 preflight |

<!-- main-db:end -->

## 3. 项目图库：graph 核心 + extension 目录（12 张）

<!-- project-db:start -->

路径与同库事实见 [`README.md`](./README.md) §2.1。项目图库迁移由 `src/graph/db/migrations.ts`（`CURRENT_SCHEMA_VERSION = 14`）与 `CHIMERA_STORAGE_EXTENSION`（v1..v8）两套版本线管理。

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `schema_versions` | graph migrator（TS） | `src/graph/db/migrations.ts`（CURRENT_SCHEMA_VERSION=14）+ `schema.sql` | `getCurrentVersion`；`src/graph/db/index.ts:257-261` | `recordMigration`/`runMigrations`（`src/graph/db/migrations.ts:353-384`） | 是：重新应用迁移链 | 每个 migration 事务；版本落后自动迁移，只读连接拒绝 pending | 永久 | graph core → Rust `chimera-core`（WP-06）；迁移 owner 仍 TS 直到显式换权 |
| `nodes` | graph indexer | `schema.sql` + v1..v14 | `src/graph/db/queries.ts:940,1090,1474`（读取/搜索） | `src/graph/db/queries.ts:593,686,717,791`（insert/update/delete）；`src/graph/extraction/index.ts:2202`（sync） | 是：从源文件重索引 | `chimera graph index/sync`；失败保留旧图 | 派生数据，sync 替换；无 TTL | `graph.read`/`graph.write` capability（`h2-data-plane.md` §3.1） |
| `edges` | graph indexer | `schema.sql` + v1..v14 | `src/graph/db/queries.ts:2256,2290,2321` | `src/graph/db/queries.ts:2156,2185,2226`；`src/graph/resolution/index.ts:1349`（resolution 写回） | 是：从源文件重索引 | 同 nodes；失败保留旧图 | 派生数据；无 TTL | 同 graph |
| `files` | graph indexer | `schema.sql` + v1..v14 | `src/graph/db/queries.ts:2428,2439,2564` | `src/graph/db/queries.ts:2344,2393`；`src/graph/extraction/index.ts:2273`（sync upsert） | 是：文件系统扫描重建 | 同 nodes | 派生数据；无 TTL | 同 graph |
| `file_semantics` | graph classifier | migration v5（`src/graph/db/migrations.ts:70-92`） | `src/graph/db/queries.ts:2553` | `src/graph/db/queries.ts:2482,2539`；`src/graph/index.ts:1417,1439`（classifier/sync） | 是：re-extract 重建 | 同 nodes；classifier_version 不匹配时重算 | 派生数据；无 TTL | 同 graph |
| `unresolved_refs` | graph resolver | `schema.sql` v1 + v10（`src/graph/db/migrations.ts:234-244`） | `src/graph/db/queries.ts:2663,2676,2698,2737` | `src/graph/db/queries.ts:2579,2619,2772`；`src/graph/resolution/index.ts:1447-1449`（resolved 清理） | 是：resolution pass 重建 | 未解析行保留 failed 供后续 sync 重试 | 派生数据；resolved 删除 | 同 graph |
| `name_segment_vocab` | node write path | migration v9（`src/graph/db/migrations.ts:202-210`） | `src/graph/db/queries.ts:1392-1417`（search vocab arm） | `src/graph/db/queries.ts:849-877,929-934` | 是：full index 重建 | 迁移后为空，由 full index/sync 填充 | 派生数据；无 TTL | 同 graph |
| `synthesis_inputs` | synthesis stage | migration v13（`src/graph/db/migrations.ts:303-309`） | `src/graph/db/synthesis-stage.ts:107-111` | `src/graph/db/synthesis-stage.ts:107-111` | 是：synthesis 重算 | staging 事务失败回滚；成功替换 | 派生数据；无 TTL | 同 graph |
| `project_metadata` | graph indexer / extraction version | migration v2（`src/graph/db/migrations.ts:36`） | `src/graph/db/extraction-version.ts:187` | `src/graph/db/migrations.ts:309`；index stamp | 部分：stamp 可重算，extractor provenance 丢失 | 已提交保留；版本戳不匹配触发 reindex 提示 | 永久 | 同 graph |
| `nodes_fts` | SQLite FTS5 触发器 | `schema.sql:144-171` | `src/graph/db/queries.ts:1392-1417`（`nodes_fts` MATCH） | `src/graph/db/schema.sql:156-171`（AI/AD/AU 触发器） | 是：`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')` | 与 nodes 同事务维护；损坏可 rebuild | 派生数据；无 TTL | 同 graph；FTS 语义必须 parity |
| `codegraph_storage_extension` | `src/graph/db/extensions.ts` | `ensureStorageExtensionCatalog`（`extensions.ts:125-143`） | `getStorageExtensionVersion`（`src/graph/db/extensions.ts:161-170`） | `applyStorageExtension`（`src/graph/db/extensions.ts:207-239`） | 是：catalog 可重建 | 只读连接遇 pending migration 抛错，不落 DDL | 永久 | graph storage extension 机制；Rust core 接管时保留 catalog 语义 |
| `codegraph_storage_extension_migration` | `src/graph/db/extensions.ts` | `ensureStorageExtensionCatalog`（`extensions.ts:125-143`） | `getStorageExtensionHistory`（`src/graph/db/extensions.ts:172-196`） | `applyStorageExtension`（`src/graph/db/extensions.ts:207-239`） | 是：可由迁移历史重建 | 同 extension catalog | 永久 | 同上 |

## 4. 项目图库：Chimera overlay（14 张）

这些表与 graph 核心同库，但版本线是 `CHIMERA_STORAGE_EXTENSION` v1..v8（`src/chimera/store.ts:314-628`），迁移账本在 `codegraph_storage_extension_migration`。**不要**把它们当成主库表，也不要用主库 Drizzle 迁移管理。

| 表 | owner（当前 → 目标） | migrator | reader | writer | 可重建性 | 恢复 | 保留 | 换权协议 |
|---|---|---|---|---|---|---|---|---|
| `chimera_change_event` | `src/chimera/store.ts` + provenance | extension v1 | `readChangeFacts`/`readRecentProvenanceRecords`（`src/chimera/store.ts:1409,1531`） | `appendProvenanceRecord`（`src/chimera/store.ts:1386`）、`writeChangeFacts`（`src/chimera/store.ts:1467`） | 否：变更审计事实 | 已提交保留；id 幂等 | 30 天证据压缩（`src/chimera/store.ts:294,2706-2707`）；压缩不删未提交证据 | WP-06/WP-10 共同定义；graph/audit owner 换权需保持同库事务 |
| `chimera_change_file` | 同上 | extension v1 | 无运行时读取路径（仅 append 投影） | `writeProvenanceRecordToDb`（`src/chimera/store.ts:1363-1382`） | 否：事件文件清单 | 随 event 级联删除 | 30 天压缩 | 同上 |
| `chimera_change_fact` | 同上 | extension v1 | `readChangeFacts`（`src/chimera/store.ts:1531`） | `writeChangeFacts`（`src/chimera/store.ts:1467`） | 否：语义变更事实 | 随 event 级联删除 | 30 天压缩 payload（`src/chimera/store.ts:2787-2789`） | 同上 |
| `chimera_audit_run` | audit runtime | extension v1 | `readAuditRuns`（`src/chimera/store.ts:1598`） | `recordAuditRun`（`src/chimera/store.ts:1562`） | 否：审计结论 | 已提交保留；id 幂等 | 30 天证据压缩 | WP-10 控制面 owner |
| `chimera_audit_obligation` | obligation store | extension v1 | `readPersistentObligationStore`（`src/chimera/store.ts:2971`） | `writePersistentObligationStore`（`src/chimera/store.ts:3004`） | 否：tracked decision | 已提交保留；fingerprint UNIQUE 幂等 | **不随 30 天证据压缩删除 pending**；必须 resolve/ignore | WP-10；obligation 生命周期不得被 retention 静默清理 |
| `chimera_semantic_snapshot` | semantic snapshot | extension v1 | `hydrateFactFromSemanticSnapshots`（`src/chimera/store.ts:1222-1276`） | `writeChangeFacts`（`src/chimera/store.ts:1055-1107,1467-1508`） | 部分：可由 change event 重算，但 hash_version 语义需保留 | 已提交保留；FK cascade | 30 天压缩删除（`src/chimera/store.ts` compact 统计 deletedSemanticSnapshots） | WP-06 graph/semantic owner |
| `chimera_semantic_object` | semantic snapshot | extension v1 | `readSemanticNode`/`readSemanticRelations`（`src/chimera/store.ts:1194-1208`） | `writeChangeFacts`（`src/chimera/store.ts:1033-1053,1467-1508`） | 部分：content-addressed，可重算 | 已提交保留；hash 幂等 | 30 天压缩删除 | WP-06 |
| `chimera_semantic_snapshot_ref` | semantic snapshot | extension v1 | `hydrateFactFromSemanticSnapshots`（`src/chimera/store.ts:1222-1276`） | `writeChangeFacts`（`src/chimera/store.ts:1092-1102,1467-1508`） | 部分：可由 snapshot 重算 | 随 snapshot 级联删除 | 30 天压缩 | WP-06 |
| `chimera_predesign_run` | predesign store | extension v2 | `readPredesignRuns`（`src/chimera/store.ts:1684`） | `recordPredesignRun`（`src/chimera/store.ts:1631`） | 否：pre-edit 证据 | 已提交保留；id 幂等 | 30 天待统一（当前 compact 只覆盖 committed change evidence） | WP-06/WP-10 |
| `chimera_oracle_result` | oracle store | extension v3/v4 | `readOracleResults`（`src/chimera/store.ts:2488`） | `recordOracleResult`（`src/chimera/store.ts:2470`） | 否：验证证据 | 已提交保留；id 幂等 | 30 天证据压缩 | WP-10 |
| `chimera_commit_change_summary` | commit summary | extension v4 | `readCommitChangeSummaries`（`src/chimera/store.ts:2925`） | `compactCommittedChangeEvidence`（`src/chimera/store.ts:2794`） | 是：可由 event/fact 重算 | 已提交保留；compacted_at 索引 | 30 天压缩目标 | WP-10 |
| `chimera_edit_intent_claim` | edit-intent | extension v5 | `readActiveEditIntentClaims`（`src/chimera/store.ts:1851`） | claim/release API（`src/chimera/store.ts:1884,1913`） | 是：transient coordination | expires_at TTL；崩溃后过期（默认 2h，`src/chimera/store.ts:190`） | TTL + 显式 release；无长期保留 | 待拍板：host 接管跨进程 coordination 时保持 claim 语义 |
| `chimera_edit_intent_waiter` | edit-intent | extension v5/v6/v7 | `readEditIntentWaiters`（`src/chimera/store.ts:2024`） | waiter API（`src/chimera/store.ts:2024-2124`） | 是：transient coordination | host_boot_id/woken_at；崩溃后按 host 身份清理 | TTL；woken_at 窗口 | 同 edit-intent |
| `chimera_process_registry` | TS process registry | extension v8 | `readActiveProcesses`（`src/chimera/store.ts:2331-2354`） | `registerProcess`（`src/chimera/store.ts:2258`）、`markProcessExited`（`src/chimera/store.ts:2291`）、`markProcessKilled`（`src/chimera/store.ts:2309`）、`releaseProcessesForSession`（`src/chimera/store.ts:2357`） | 部分：running 行的 pid/pgid 是权威；终态可由事件重建 | `sweepExpiredStoreRows` 每 5 分钟持久化清理（`src/chimera/store.ts:2244-2256`；节流 `src/chimera/edit-intent.ts:39,45-50`）；`readActiveProcesses` 是纯读取（`src/chimera/store.ts:2331-2354`） | 24h TTL（`PROCESS_REGISTRY_TTL_MS`，`src/chimera/store.ts:2152`） | H2 step 7：host 接管 adoption CAS；H1 只读/代理，不 adopt |

<!-- project-db:end -->

## 5. 覆盖与机检

- 主库 Drizzle 表：37 张（session 域 11 + host 6 + identity/control 7 + jobs/telemetry/memory/event/maintenance 13）。加 `__drizzle_migrations` 账本后 38 行。
- 项目图库：graph 核心 9 + `nodes_fts` 1 + extension 目录 2 + Chimera overlay 14 = 26 行。
- 合计：64 行。
- 机检命令（从 `packages/chimera`）：

```bash
bun test/oracle/storage/matrix-check.ts
```

该命令会：
1. 从 `src/**/*.sql.ts` 解析全部 `sqliteTable("...")` 表名，与 `<!-- main-db:start -->` / `<!-- main-db:end -->` 之间的行集合比较（期望 37，另加账本 1）。
2. 从 `src/graph/db/schema.sql` 解析 graph 表（含 `nodes_fts`），从 `src/chimera/store.ts` 解析 `chimera_*` 表，并加入 extension 目录两表，与 `<!-- project-db:start -->` / `<!-- project-db:end -->` 之间的行集合比较（期望 26）。
3. 校验每行恰好 9 个 `|` 分隔单元（表名 + 8 列），并检查重复行。

## 6. 已应用迁移不改的说明

- 本文件引用的 31 个主库迁移目录全部是**已应用历史**；本包没有新增、重排、改写或删除任何 `migration.sql` / `snapshot.json`。
- 主库最新目录：`20261023034209_session_part_reconcile`（`session_part_reconcile` 表）。host 六表由 `20261022022937_host_control_plane` 创建，`packages/chimera/test/storage/host-schema.test.ts:112-120` 已断言该迁移 additive-only。
- 项目图库：graph `CURRENT_SCHEMA_VERSION = 14`（`src/graph/db/migrations.ts:13`）；Chimera extension 当前 v8（`src/chimera/store.ts:603-626`）。两者都是“只向前迁移”，不提供 down migration；回退靠开关与旧二进制兼容读（`h2-data-plane.md` §4.2、§4.7）。
- 任何未来 schema 变更必须走对应 migrator：主库 `bun run db generate --name <slug>`；项目图库 graph migration 或 storage extension 版本递增。不得手改已应用迁移（`packages/chimera/AGENTS.md` “Database guide”）。