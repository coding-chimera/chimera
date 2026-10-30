# 跨库投影恢复演练（WP-05）

状态：契约阶段演练，已执行并记录。contract_rev：`cr-2026-10-30-r1`。
脚本：`cross-db-projection-drill.ts`；机读记录：`cross-db-projection-drill.result.json`。
运行环境：bun 1.4.0，`bun:sqlite`，本机临时目录（运行后清理；记录中不含绝对路径）。

## 1. 为什么需要这次演练

真实拓扑有两个独立的 SQLite 文件：

- **权威库 A**：主应用库 / 上游 durable 事实。证据：`src/storage/db.ts:31-44`（路径）、`src/storage/db.ts:169-207`（WAL + 迁移）。
- **投影库 B**：项目图库 / 下游 overlay。证据：`src/graph/directory.ts:25,123-155`（`<data-root>/codegraph.db`）、`src/chimera/store.ts:4,630-632`（Chimera store 复用 graph 路径）、`src/graph/db/extensions.ts:207-219`（只读打开不迁移）。

两库**没有跨文件事务**（`h2-data-plane.md` §4.3；`recovery-matrix.md` §5.4）。因此“先写 A 再写 B”的窗口里崩溃，必须靠 durable checkpoint + 幂等重放收敛，不能靠回滚。本次演练就是把这个契约跑成可复现证据。

## 2. 演练模型

| 角色 | 文件 | 表 | 说明 |
|---|---|---|---|
| 权威 | `authority.db` | `authority_fact(seq, fact_id, payload, created_at, writer_generation)` | 12 条单调事实，模拟主库/上游已提交事实 |
| 权威 | `authority.db` | `writer_lease(scope, generation, owner, acquired_at)` | generation CAS；旧 generation 不能获取 |
| 权威 | `authority.db` | `ack_cursor(scope, acked_seq, generation, updated_at)` | 只在投影 checkpoint 追上后前进 |
| 权威 | `authority.db` | trigger `authority_fact_generation_guard` | 旧 generation 插入直接 `RAISE(ABORT,'stale_generation')` |
| 投影 | `projection.db` | `projection_row(seq, fact_id, payload, generation)` | 下游投影事实 |
| 投影 | `projection.db` | `projection_checkpoint(scope, last_seq, generation, updated_at)` | durable 投影游标 |

写者子进程流程：

```text
acquire lease(generation=1)
A 事务：插入 fact 1..12
  ├─ crash=authority-only：SIGKILL（B 未写）
B 批 1（1..5）：投影行 + checkpoint=5 同事务
  ├─ crash=mid-projection：SIGKILL（批 2 未写）
B 批 2（6..10）：投影行 + checkpoint=10 同事务
  ├─ crash=projection-before-checkpoint：只提交投影行，checkpoint 仍 5，SIGKILL
B 批 3（11..12）：投影行 + checkpoint=12 同事务
  ├─ crash=after-ack：ACK=12 后 SIGKILL
正常退出（phantom-negative 用）
```

父进程在子进程被 SIGKILL 后：

1. 打开两库（WAL 恢复）。
2. 记录崩溃前状态：authority 行数、projection 行数、checkpoint、ack、`-wal` 是否存在/字节数。
3. **fencing**：用旧 generation 尝试 acquire → 必须失败；用 `lease+1` acquire → 必须成功；用旧 generation 插入 fact → trigger 必须拒绝。
4. **第一次对账**：从 projection checkpoint 重放 authority 中更大的 seq，`INSERT OR IGNORE`；投影行 + checkpoint 同事务；checkpoint 追上后推进 ACK。
5. **第二次对账**：必须写 0 行，checkpoint 不变（幂等）。
6. 比较 authority 与 projection 的 canonical checksum（`seq\0fact_id\0payload` 的 SHA-256）。

## 3. 场景与判定

| 场景 | 崩溃点 | 崩溃前投影状态 | 期望 | 实测 |
|---|---|---|---|---|
| `authority-only` | A 提交后、B 未写 | 0 行，checkpoint 0 | 重放 12 行 | PASS：replayed 12，checkpoint 0→12 |
| `mid-projection` | B 批 1 后 | 5 行，checkpoint 5 | 重放 7 行 | PASS：replayed 7，checkpoint 5→12 |
| `projection-before-checkpoint` | B 批 2 行已提交、checkpoint 5 | 10 行，checkpoint 5 | 重放 7 行，其中 5 行被 `INSERT OR IGNORE` 吸收 | PASS：replayed 2，checkpoint 5→12 |
| `after-ack` | B 完成 + ACK 后 | 12 行，checkpoint 12，ACK 12 | 0 行重放 | PASS：replayed 0 |
| `phantom-negative` | 无崩溃，人工注入 B 的 seq 999 | 13 行，checkpoint 12 | 对账报 phantom 并失败；清理后恢复 | PASS：detected phantoms 1；清理后 replayed 0 |

每次 SIGKILL 场景都验证：

- `child_signal = SIGKILL`、`child_exit_code = 137`（kill -9 等价）。
- `stale_acquire_rejected = true`、`new_acquire_ok = true`、`stale_insert_rejected = true`。
- 第一次对账 `ok = true`，authority/projection checksum 相等，`acked_seq = 12`。
- 第二次对账 `replayed = 0`，checkpoint 不变。

## 4. 最近一次执行结果（机读记录摘要）

```text
PASS authority-only: before={authority:12,projection:0,checkpoint:0,ack:0} first={replayed:12,checkpoint:0->12,phantoms:0} second_replayed=0 fencing=true
PASS mid-projection: before={authority:12,projection:5,checkpoint:5,ack:0} first={replayed:7,checkpoint:5->12,phantoms:0} second_replayed=0 fencing=true
PASS projection-before-checkpoint: before={authority:12,projection:10,checkpoint:5,ack:0} first={replayed:2,checkpoint:5->12,phantoms:0} second_replayed=0 fencing=true
PASS after-ack: before={authority:12,projection:12,checkpoint:12,ack:12} first={replayed:0,checkpoint:12->12,phantoms:0} second_replayed=0 fencing=true
PASS phantom-negative: before={authority:12,projection:13,checkpoint:12,ack:0} first={replayed:0,checkpoint:12->12,phantoms:1} second_replayed=0 fencing=true
summary: 5/5 scenarios passed; record=cross-db-projection-drill.result.json
```

记录字段（完整见 JSON）：

- `child_exit_code` / `child_signal`：SIGKILL 证据。
- `before.wal_present` / `before.wal_bytes`：崩溃后 WAL 仍存在，重开时由 SQLite 恢复。
- `fencing.*`：generation 级 fencing 三项。
- `first_reconcile` / `second_reconcile`：`replayed`、`checkpoint_before/after`、`acked_seq`、双库 checksum、`phantoms`。
- `summary.passed/failed`：5/0。

## 5. 如何运行

从 `packages/chimera`：

```bash
bun test/oracle/storage/cross-db-projection-drill.ts
```

- 脚本会在系统临时目录创建两个 SQLite 文件，结束后递归删除；不会写仓库数据。
- 子进程通过 `process.kill(process.pid, "SIGKILL")` 自杀，父进程用 `child.signalCode` / `child.exitCode` 记录 kill -9 语义。
- 每次运行都会刷新同目录的 `cross-db-projection-drill.result.json`。
- 退出码：5/5 通过为 0，否则为 1。

## 6. 与真实拓扑的映射与边界

| 演练 | 真实对应 | 证据 |
|---|---|---|
| authority.db | 主应用库 `chimera.db`（session/host 控制面/ack） | `src/storage/db.ts:31-44,169-207` |
| projection.db | 项目图库 `codegraph.db`（graph + audit/claims/process overlay） | `src/graph/directory.ts:25,123-155`；`src/chimera/store.ts:4,630-632` |
| authority fact | `message`/`part` 或 `host_event` 等已提交事实 | 矩阵 §2.1/§2.2 |
| projection checkpoint | `host_event.seq` / 投影库 durable 游标 | `recovery-matrix.md` §5.3.2；`h2-data-plane.md` D9 |
| writer lease generation | `host_generation`/`worker_generation`/turn generation | `recovery-matrix.md` §5.3.1 |
| ACK cursor | `host_event` commit-before-ack / `commit.confirm` | `recovery-matrix.md` §5.1 |

**边界**：

- 这是契约演练，不是生产迁移；没有接入真实 `src/**` 或 Rust host。
- 不模拟 SQLite 页损坏、磁盘满、文件锁超时；这些属于 WP-03 fault matrix 的其他类。
- 不证明跨库“原子性”；恰恰相反，它证明只能靠 checkpoint + 幂等重放收敛。
- `phantom-negative` 是人工注入的负例；真实系统应通过投影行的 authority 外键/来源校验避免 phantom，或在 reconcile 时拒绝并告警。

## 7. 对实现的直接约束

1. 投影写者必须把“行 + checkpoint”放在同一事务；分开提交就会出现 `projection-before-checkpoint` 场景，虽然可幂等修复，但会扩大窗口并增加读放大。
2. ACK 必须滞后于投影 checkpoint；先 ACK 后投影会在崩溃时丢失下游可读性。
3. reconcile 必须先检测 phantom，再重放；检测到 phantom 时不得推进 ACK。
4. 旧 generation 必须同时被 lease CAS 和写入 trigger/条件更新拒绝；只做其中一层会在并发窗口失效。
5. 保留/裁剪必须等投影 checkpoint 追上；否则重放源被删，投影永久缺口。

## 8. 证据索引

- `packages/chimera/specs/rust-host/authority/ack-rollback-retention.md` §7（跨库投影恢复契约）。
- `packages/chimera/specs/rust-host/authority/table-authority-matrix.md` §2.2（host_event/checkpoint）、§4（overlay）。
- `packages/chimera/specs/rust-host/h2-data-plane.md` §4.3/§4.5（WAL 并发、shadow 对账）、D9/D13。
- `packages/chimera/specs/rust-host/recovery-matrix.md` §5.1/§5.3/§5.5（ACK、generation、终态优先级）。