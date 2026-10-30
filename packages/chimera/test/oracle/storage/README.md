# WP-05 storage oracle：矩阵机检与跨库投影恢复演练

状态：契约阶段，已执行。contract_rev：`cr-2026-10-30-r1`。
本目录只放 harness 与记录，不导入 `packages/chimera/src/**`，不改生产 schema/migration。

## 1. 文件

| 文件 | 作用 |
|---|---|
| `matrix-check.ts` | 解析 `specs/rust-host/authority/table-authority-matrix.md`，校验主库 Drizzle 表（37 + 账本）与项目图库表（26）全覆盖、每行 8 列、无重复 |
| `cross-db-projection-drill.ts` | `bun:sqlite` 跨库投影恢复演练：4 个 SIGKILL 崩溃点 + 1 个 phantom 负例 + writer fencing |
| `cross-db-projection-drill.result.json` | 最近一次演练机读记录（无绝对路径/凭据） |
| `cross-db-projection-drill.md` | 演练契约、场景、结果摘要与真实拓扑映射 |

## 2. 运行（从 `packages/chimera`）

```bash
# 矩阵覆盖 + 8 列校验
bun test/oracle/storage/matrix-check.ts

# 跨库投影恢复演练；刷新 result.json
bun test/oracle/storage/cross-db-projection-drill.ts
```

期望输出：

```text
PASS main-db: 38 rows (38 expected)
PASS project-db: 26 rows (26 expected)
PASS columns: 8 per row (9 cells incl. table name)
PASS total: 64 rows, no duplicates
```

```text
PASS authority-only: ... second_replayed=0 fencing=true
PASS mid-projection: ... second_replayed=0 fencing=true
PASS projection-before-checkpoint: ... second_replayed=0 fencing=true
PASS after-ack: ... second_replayed=0 fencing=true
PASS phantom-negative: ... phantoms:1 second_replayed=0 fencing=true
summary: 5/5 scenarios passed; record=cross-db-projection-drill.result.json
```

退出码：矩阵检查 0 = 全覆盖；演练 0 = 5/5 通过，否则 1。

## 3. 约束

- 演练只用 `bun:sqlite` + node 内置模块；不启动 host、不连接真实主库/图库。
- 临时 SQLite 文件在系统临时目录，运行结束递归删除；记录只写逻辑文件名（`authority.db`、`projection.db`）。
- SIGKILL 通过子进程 `process.kill(process.pid, "SIGKILL")` 实现；父进程断言 `signalCode = SIGKILL` / `exitCode = 137`。
- `matrix-check.ts` 的期望表集合来自源码：`src/**/*.sql.ts` 的 `sqliteTable("...")`、`src/graph/db/schema.sql` 的 `CREATE TABLE`/`CREATE VIRTUAL TABLE`、`src/chimera/store.ts` 的 `CREATE TABLE IF NOT EXISTS chimera_*`，再加 extension 目录两表。schema 变化时矩阵必须同步，否则机检失败。

## 4. 记录字段

`cross-db-projection-drill.result.json`：

```text
schema, generated_at, bun
model: { authority, projection, fact_count, batches, crash_signal }
scenarios[]:
  name, crash, child_exit_code, child_signal
  before: { authority_rows, projection_rows, checkpoint, acked_seq, wal_present, wal_bytes }
  fencing: { lease_before, stale_acquire_rejected, new_generation, new_acquire_ok, stale_insert_rejected }
  first_reconcile / second_reconcile: { ok, phantoms, replayed, checkpoint_before, checkpoint_after,
                                         acked_seq, authority_checksum, projection_checksum }
  pass, failures[]
summary: { total, passed, failed }
```

## 5. oracle_commands（建议写入 manifest WP-05）

```yaml
oracle_commands:
  - "cd packages/chimera && bun test/oracle/storage/matrix-check.ts"
  - "cd packages/chimera && bun test/oracle/storage/cross-db-projection-drill.ts"
  - "cd packages/chimera && bun test --timeout 30000 test/storage/host-schema.test.ts"
  - "git status --porcelain packages/chimera/migration"
```

前两条是本包新增证据；第三条确认既有 host 六表迁移仍幂等（本包未改迁移）；第四条必须为空，证明“已应用迁移不改”。