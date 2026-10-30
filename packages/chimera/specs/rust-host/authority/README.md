# WP-05 库/表权威、schema/migrator、ACK/回退/保留契约

状态：**building（契约阶段）**。本目录只产出权威矩阵、ACK/回退/保留契约与跨库投影恢复演练，不写生产迁移、不改 schema、不做 writer flip。
owner：storage owner。work_id：WP-05。contract_rev：`cr-2026-10-30-r1`。
依据：`RUST_FULL_MIGRATION_PLAN.md` §8 / §9 / §10 / §13；`packages/chimera/specs/rust-host/manifest.yaml` WP-05；`a0-scope-decisions.md`；同树既有 `recovery-matrix.md`、`h2-data-plane.md`（只读引用，不改写）。

> 基线：HEAD `9600ee7f49ddcb065a33511f21f570d2b2d13a19`（与 manifest `base_hash` 一致）。本批开始前工作树已含未提交修订（计划正文等），本包不触碰 `packages/chimera/src/**` 与 `packages/chimera/migration/**`。所有 `file:line` 证据均按该工作树快照记录。

## 1. 范围与非目标

### 1.1 本包覆盖

1. **权威矩阵**：主应用库全部 Drizzle 表（`src/**/*.sql.ts`，37 张）与项目图库全部表（图核心 9 张 + FTS 1 张 + 扩展目录 2 张 + Chimera overlay 14 张），每表一行，含 8 列：owner / migrator / reader / writer / 可重建性 / 恢复 / 保留 / 换权协议。见 [`table-authority-matrix.md`](./table-authority-matrix.md)。
2. **ACK / 回退 / 保留契约**：写路径 drain、durable checkpoint、writer fencing 与换权、旧版兼容一个发布周期、保留与裁剪边界。见 [`ack-rollback-retention.md`](./ack-rollback-retention.md)。
3. **跨库投影恢复演练**：`bun` + `bun:sqlite` 最小演练，SIGKILL 模拟 `kill -9`，覆盖 4 个崩溃点 + 1 个负例 + writer fencing 对账。见 `packages/chimera/test/oracle/storage/cross-db-projection-drill.ts` 与同目录 `.result.json` 记录。

### 1.2 明确非目标

- 不新增/修改 `packages/chimera/migration/**` 下任何已应用迁移；不生成新 migration。
- 不修改 `packages/chimera/src/**`、`chimera-host/src/**` 或任何生产 schema。
- 不做 writer flip、不接 kill switch 行为、不实现 Rust host 存储层。
- 不把本目录的“建议”当成已拍板；建议与待拍板项在文中显式分节。
- 不复制真实凭据、后端 URL、内网域名、IP 或用户 home 绝对路径；文档中的路径均为仓库相对路径或占位符。

## 2. 两个 SQLite 事实源（拓扑）

当前 checkout 存在两个独立的 SQLite 事实源，任何“跨库事务”假设都不成立。

| 事实源 | 路径解析 | 迁移机制 | 当前承载 |
|---|---|---|---|
| 主应用库 | `Global.Path.data/chimera.db`；channel 变体见 `getChannelPath()`；`OPENCODE_DB` 可覆盖绝对路径或数据目录内文件名（`src/storage/db.ts:31-44`） | TS Drizzle Kit 目录 `packages/chimera/migration/<timestamp>_<slug>/migration.sql`；`Database.applyMigrations` 对 `20260901000000_add_session_share_url` 做第二遍 lineage repair（`src/storage/db.ts:55-68`）；`__drizzle_migrations` 为 Drizzle 账本 | session/message/part、permission ruleset、background_job、turn lease、goal/work_brief/tool_reveal、memory、model telemetry、host 控制面六表、event 实验表 |
| 项目图库 | `getGraphDataRootInfo(projectRoot).databasePath` = `<data-root>/codegraph.db`；data root 解析顺序：`CHIMERA_DATA_DIR`/`CODEGRAPH_DATA_DIR` → WSL `.chimera-wsl` → `.chimera/` → 兼容 `.codegraph/`（`src/graph/directory.ts:25,123-155`） | 图核心：`src/graph/db/migrations.ts`（`CURRENT_SCHEMA_VERSION = 14`）+ `schema_versions` 表；Chimera overlay：`CHIMERA_STORAGE_EXTENSION` v1..v8（`src/chimera/store.ts:314-628`）+ `codegraph_storage_extension` / `codegraph_storage_extension_migration` 目录表（`src/graph/db/extensions.ts:125-143`） | graph nodes/edges/files/file_semantics/unresolved_refs/name_segment_vocab/synthesis_inputs/project_metadata；Chimera change/audit/predesign/oracle/obligation/commit-summary/semantic snapshot；edit-intent claims/waiters；`chimera_process_registry` |

### 2.1 关键事实：audit / process / claims 与 graph 同库

- `src/chimera/store.ts:4` 从 `@/graph` 导入 `getDatabasePath`；`src/chimera/store.ts:630-632` 直接返回 `getDatabasePath(projectRoot)`；`src/graph/db/index.ts:628-630` 将其解析为 `getGraphDataRootInfo(projectRoot).databasePath`。因此 **`chimera_change_*`、`chimera_audit_*`、`chimera_oracle_result`、`chimera_predesign_run`、`chimera_commit_change_summary`、`chimera_semantic_*`、`chimera_edit_intent_*`、`chimera_process_registry` 与 graph 表在同一个 `codegraph.db` 文件中**。
- 该 overlay 通过 storage extension 注册：`id = "chimera"`、`namespace = "chimera_"`（`src/chimera/store.ts:314-317`），打开时 `DatabaseConnection.open(dbPath, { readOnly, storageExtensions: [CHIMERA_STORAGE_EXTENSION] })`（`src/chimera/store.ts:862`）。extension 迁移版本记录在 `codegraph_storage_extension_migration`，与图核心的 `schema_versions` 是两套独立版本线。
- **只读打开不会建库/迁移**：`applyStorageExtension` 在 `readOnly` 且存在 pending migration 时抛错，不落任何 DDL（`src/graph/db/extensions.ts:207-219`）。这与仓库“只读探针不得初始化图数据”的规则一致。
- 与主库的关系：**没有跨文件事务**。audit/claims/process 与 graph 可以共享同一 SQLite 事务；与主库 session/message/host 控制面只能靠补偿/outbox 对账。`recovery-matrix.md` §3 S12 已把 `chimera_process_registry` 标为“项目库、跨库、host 只读/代理”，本矩阵沿用并补上迁移与保留细节。

### 2.2 迁移所有权

- 主库：**TS Drizzle 是唯一 migrator**。`drizzle.config.ts` 的 schema 为 `./src/**/*.sql.ts`，输出 `./migration`；生成命令 `bun run db generate --name <slug>`；运行期由 `Database.Client` 调 `applyMigrations`（`src/storage/db.ts:180-207`）。
- 项目图库：**TS graph migrator + storage extension** 是唯一 migrator；Rust host 不迁移。
- Rust host：`HostStore::open` 明确 “The schema must already exist: the store never migrates or creates tables”（`chimera-host/src/store.rs:348-353`）；连接参数与 TS 对齐 WAL / NORMAL / busy_timeout=5000 / foreign_keys=ON（`chimera-host/src/store.rs:361-368`）。H2 启动顺序要求 TS 先完成 `Database.applyMigrations`，再启动 host 并传 canonical `--db`（`h2-data-plane.md` §4.1-§4.2）。
- **已应用迁移只读**：本包未修改 `packages/chimera/migration/**` 任何文件；矩阵中的迁移目录仅作引用。最新目录为 `20261023034209_session_part_reconcile`（共 31 个迁移目录，实测 `ls packages/chimera/migration | wc -l` = 31）。

## 3. 文档索引

| 文件 | 内容 |
|---|---|
| [`table-authority-matrix.md`](./table-authority-matrix.md) | 主库 37 张 Drizzle 表 + `__drizzle_migrations` 账本；项目图库 26 张表；每表 8 列 |
| [`ack-rollback-retention.md`](./ack-rollback-retention.md) | commit-before-ack、durable checkpoint、writer fencing/换权、回退、保留与裁剪、跨库投影恢复契约 |
| `packages/chimera/test/oracle/storage/cross-db-projection-drill.ts` | SIGKILL 跨库投影恢复演练脚本（4 崩溃点 + 负例 + fencing） |
| `packages/chimera/test/oracle/storage/cross-db-projection-drill.result.json` | 最近一次演练的机读记录（无绝对路径/凭据） |
| `packages/chimera/test/oracle/storage/matrix-check.ts` | 矩阵覆盖机检：schema 表集合 vs 矩阵行集合、8 列校验 |

## 4. 结论摘要

1. **表级单写者仍然成立，但只在主库的 host 六表上已实现**：`host_worker` / `host_state` / `session_turn_checkpoint` / `pending_request` / `request_idempotency` / `host_event` 由 Rust host 写，Bun 侧只有 Drizzle schema 声明（`src/storage/schema.ts:21-26`），没有 TS 读写路径。其余主库表仍由 TS 进程写。
2. **项目图库是“graph + audit/claims/process”的同库 overlay**，不是第二个 graph 库；备份、WAL、retention、只读打开必须按一个文件处理。跨主库一致性只能补偿，不能分布式事务。
3. **`permission` 表是历史读路径，不是运行时写路径**：运行时 approved ruleset 只在 `InstanceState` 内存中增长（`src/permission/index.ts:161-170,253-261`），重启后新批准的规则丢失；只有 JSON 导入会写该表（`src/storage/json-migration.ts:371`）。这必须在 W1/W3 前修正，否则“permission 已持久化”是错误前提。
4. **保留期已拍板但多数未自动执行**：session 与图审计证据 30 天（计划 §13:362）。session 目前只有显式 `chimera session prune --older-than`（`src/cli/cmd/session.ts:92-113`）；审计证据压缩有 30 天默认值（`src/chimera/store.ts:294,2706-2707`）；`host_event`、`request_idempotency`、`background_job` 终态行的裁剪窗口仍需拍板或补任务。
5. **换权不是 toggle**：必须按“停新写 → drain → durable checkpoint → writer fencing → 旧版读写兼容验证 → 关闭 plane/route 开关”执行；旧实现至少保留一个发布周期（计划 §10:298）。矩阵每行的“换权协议”列给出该表的前置与回退。

## 5. 建议 vs 待拍板

以下条目在正文中也有标注，这里汇总，避免把建议当成结论。

### 5.1 建议（本包提出，待 parent/用户确认）

- **S1**：把 `host_event` 保留窗口定为“时间 30 天 + 行数 1,000,000 + 字节 256 MiB，先到者裁剪”，并持久化 `retention_floor_seq`；窗口外 `Last-Event-ID` 返回 `stream_reset`（对齐 `h2-data-plane.md` D9 的候选方向）。
- **S2**：`request_idempotency` TTL 固定 24h，并增加清理任务；过期重复 key 返回 `idempotency_expired`，不静默当新请求。
- **S3**：`session` 30 天保留从“显式 prune”升级为“默认 dry-run 提醒 + 显式 `--yes` 执行”，不在后台自动删除活跃/有子会话的会话；自动删除需单独拍板。
- **S4**：`permission` 表要么恢复运行时写回（approved ruleset 持久化），要么在矩阵/文档中明确标记为 legacy 并在一个发布周期后删除；当前“读表 + 内存增长”是恢复缺口。
- **S5**：`chimera_process_registry` 保留 24h TTL（现有常量 `PROCESS_REGISTRY_TTL_MS`，`src/chimera/store.ts:2152`），与 session/审计 30 天分开；不把进程表并入审计证据保留期。

### 5.2 待拍板

- **D-R1**：`host_event` 裁剪窗口的具体数值与裁剪 owner（host 内置任务 vs TS 维护命令）。
- **D-R2**：`session_turn_checkpoint` / `pending_request` / `host_worker` 终态行的保留窗口；当前无裁剪任务。
- **D-R3**：`model_telemetry_*` 是否继续持久化。计划 §13 已拍板“遥测 DB 持久化移除；调度速度信号改进程内存态”，但 delegation telemetry 表仍在写；需要明确“移除”的范围是否包含 `model_telemetry_*`。
- **D-R4**：`account` / `account_state` 的 owner 是否迁入 host；凭据表迁移涉及安全边界，不能只按 storage plane 处理。
- **D-R5**：项目图库与主库的备份/恢复是否要求同一快照点；当前无跨库一致性机制。

## 6. 机检

从 `packages/chimera` 运行：

```bash
bun test/oracle/storage/matrix-check.ts
bun test/oracle/storage/cross-db-projection-drill.ts
```

第一条校验矩阵覆盖与 8 列；第二条执行跨库投影恢复演练并刷新 `cross-db-projection-drill.result.json`。两条命令都不触碰 `src/**` 或 `migration/**`。

## 7. 证据索引（本文件引用）

- `src/storage/db.ts:31-44,55-68,169-178,180-207` — 主库路径、WAL/pragma、迁移应用与 repair。
- `src/graph/directory.ts:25,123-155` — graph data root 与 `codegraph.db` 路径。
- `src/graph/db/index.ts:628-630` — `getDatabasePath`。
- `src/chimera/store.ts:4,314-317,630-632,862,2152` — overlay 与 graph 同库、extension 注册、进程 TTL。
- `src/graph/db/extensions.ts:125-143,207-219` — extension 目录表与只读迁移拒绝。
- `chimera-host/src/store.rs:348-368` — host 不迁移、连接参数。
- `src/permission/index.ts:161-170,253-261` — permission 表只读、approved 仅内存。
- `src/storage/json-migration.ts:371` — permission 唯一写路径（历史导入）。
- `src/cli/cmd/session.ts:92-113` — 显式 session prune。
- `src/chimera/store.ts:294,2706-2707` — 审计证据 30 天默认值。