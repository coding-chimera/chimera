# WP-07 boot-path-capability 契约：从 TS 进程内 server 到 Rust host

> 状态：契约稿（WP-07，2026-10-30）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §4（终态架构）、§6 W2/W3、§7（开工 DAG）、§10（门禁）、§11（最小运行时契约）；`packages/chimera/specs/rust-host/h2-data-plane.md:384-390,608-640`；`manifest.yaml`（`contract_rev = cr-2026-10-30-r1`）。
> 范围：boot-path-capability 与 launcher 契约；不实现生产 runtime、不编译 Rust、不构建可执行体。

## 0. 结论先行

- 当前所有用户入口（`run`、`serve`、`web`、TUI）都在 **Bun 进程内**启动 server；没有 host launcher、没有 host front door。
- host 目前只是 `chimera-host <data-root>` 的独立进程壳：Unix socket + 握手 + 六张控制表 + 有界 serve；请求路由 `Unrouted`。
- 因此 boot-path-capability 的契约不是“如何启动一个已经存在的 Rust runtime”，而是“**在什么条件下允许把启动权从 Bun 进程内 server 移交给 Rust host，以及失败时如何回到 legacy**”。

## 1. 当前 boot path（事实）

| 阶段 | 当前行为 | 证据 |
|---|---|---|
| S0 CLI 入口 | `src/index.ts` 先处理 `chimera graph ...` 早退，再由 yargs 注册 `run/serve/web/tui/bun-worker` 等命令 | `packages/chimera/src/index.ts:56-68,171-195` |
| S1 命令选择 | `run` 默认进程内 server（`--attach` 例外）；`serve`/`web` 直接 `Server.listen`；TUI 主线程 spawn Worker | `packages/chimera/src/cli/cmd/run.ts:252-257`；`packages/chimera/src/cli/cmd/serve.ts:7-20`；`packages/chimera/src/cli/cmd/web.ts:32-49`；`packages/chimera/src/cli/cmd/tui/thread.ts:95-99,167` |
| S2 实例/DB 解析 | `Database.Path` 由 `OPENCODE_DB`/XDG/channel 决定；Drizzle `applyMigrations` 建表/迁移 | `packages/chimera/src/storage/db.ts:38-45,61-72` |
| S3 server 监听 | `Server.listen` 选择 `effect-httpapi` 或 legacy backend；返回 `Listener.stop(close)` | `packages/chimera/src/server/server.ts:199-237` |
| S4 auth | Basic auth 由 `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` 决定，默认用户名 `chimera` | `packages/chimera/src/server/auth.ts:18-41` |
| S5 session runtime | session/agent loop、provider、tool、permission/question/job 全部在 Bun 进程内 | `RUST_FULL_MIGRATION_PLAN.md:92-114`；`h2-data-plane.md:13-32` |
| S6 TUI 托管 | TUI 主线程 `new Worker(file)`；worker 内 `Server.listen` 并代理 `fetch` | `packages/chimera/src/cli/cmd/tui/thread.ts:167`；`packages/chimera/src/cli/cmd/tui/worker.ts:55,99` |
| S7 host（当前旁路） | 独立 `chimera-host` 进程，Unix socket + handshake + store；没有 launcher 拉起它 | `chimera-host/src/bin/chimera-host.rs:226-356` |

关键事实：

- `chimera-host` 不读 XDG/channel 规则；默认 DB 是 `<data-root>/host/host.db` 的 **candidate** 路径（`chimera-host/src/bin/chimera-host.rs:51-59,180-181,253`）。
- `chimera-host` 没有 HTTP listener；`serve/serve_round` 只服务 Unix socket 上的 worker 连接（`chimera-host/src/host.rs:670-760`）。
- `chimera run --attach` 只连远程 server，不启动本地实例；这不是 host 启动路径（`packages/chimera/src/cli/cmd/run.ts:255-257`）。

## 2. 目标 boot path（契约）

目标形态：**TS launcher 负责解析路径/迁移/启动参数；Rust host 负责长驻进程、HTTP front door、worker 监督；TS 只保留薄客户端与 plugin/long-tail 兼容面**（`RUST_FULL_MIGRATION_PLAN.md:92-114`）。

```text
CLI (Bun)
  └─ resolve data root + canonical Database.Path
      └─ TS Drizzle applyMigrations（唯一 migrator）
          └─ resolve host binary
              ├─ missing → mode=legacy: 进程内 server
              │            mode=proxy: legacy + host_unavailable 告警
              │            mode=rust: 启动错误（或用户显式同意降级）
              └─ present → spawn chimera-host --db <canonical> <data-root> ...
                            └─ host: preflight → bind IPC → accept workers
                                └─ host: HTTP front door（受控 allowlist）
                                    └─ worker: session/provider/tool/plugin（按能力）
```

### 2.1 阶段与 capability 门

| 阶段 | 目标 owner | 进入条件 | 失败回退 |
|---|---|---|---|
| B0 路径解析 | TS launcher | 无 | 直接报错 |
| B1 migration | TS Drizzle | 无 | 报错；不得让 host 建表 |
| B2 host 二进制解析 | TS launcher | 平台有 host 产物或显式 `CHIMERA_HOST_BIN` | legacy（proxy）/启动错误（rust） |
| B3 host preflight | Rust host | `--db` 指向已迁移主库；WAL 可写；schema 版本匹配 | 该面 `unavailable`，HTTP 可降级启动；不 spawn 依赖写的 worker |
| B4 IPC bind | Rust host | socket 目录可创建；stale/live 策略通过 | 启动失败；按模式回退 |
| B5 worker spawn | Rust host | nonce/身份/能力协商通过 | 该 worker 不接入；legacy 或 503 |
| B6 HTTP front door | Rust host | runtime foundation + router 就绪；allowlist 已批准 | 该 route 回退 legacy |
| B7 session runtime | Rust host（W3 起） | provider 通路 + hook sidecar + W0 因果/fault oracle 就绪 | 该 route/plane 回退 |

### 2.2 启动契约（R-BOOT）

| 编号 | 契约 | 判定 |
|---|---|---|
| R-BOOT-1 | launcher 必须先完成 TS Drizzle migration，再启动 host；host 永不迁移 | migration 记录表存在且最新 |
| R-BOOT-2 | launcher 必须把 canonical `Database.Path` 通过 `--db` 显式传给 host；`--db` 优先于任何环境变量 | host 打开的路径 = `Database.Path` |
| R-BOOT-3 | `proxy`/`rust` 模式下缺少 `--db` 返回 `host_db_unresolved`，不得创建 `<data-root>/host/host.db` | 不产生候选库文件 |
| R-BOOT-4 | host 二进制解析顺序：`CHIMERA_HOST_BIN` → 安装产物 `bin/host/chimera-host` → dev prebuild；不得从 PATH 任意同名程序解析 | 解析结果可审计 |
| R-BOOT-5 | host 缺失/启动失败：`legacy` 正常；`proxy` 降级 + 告警；`rust` 启动错误或显式同意降级 | 退出码/日志稳定 |
| R-BOOT-6 | host 不得在只读打开（status/query/search）时初始化/迁移图数据；图数据根由 TS helper 解析 | 无新建 `.chimera/`/`.codegraph/` |
| R-BOOT-7 | host 的 `CHIMERA_HOST_MODE`/`CHIMERA_HOST_IPC` 必须 gate 行为；未接线前不得宣称 `rust`/`enforce` 生效 | 行为矩阵 |
| R-BOOT-8 | worker 只能由 host spawn；worker 继承 socket/nonce，不自行解析数据根/主库 | 环境变量/argv 审计 |
| R-BOOT-9 | host 启动失败只降级该面，不拖垮整个 CLI；`rust` 模式例外，必须显式失败 | 失败矩阵 |
| R-BOOT-10 | launcher 不复制 host 的路径解析/migration/DB 逻辑；只传参 | 代码审查 |

### 2.3 host 启动参数（候选）

```text
chimera-host <data-root> \
  --db <canonical-database-path> \
  [--worker <n> --worker-cmd <cmd...>]
```

- `<data-root>` 由 TS 的图数据根 helper 解析；host 不硬编码 `.chimera/`/`.codegraph/`（`chimera-host/src/host.rs:384-412`）。
- `--db` 必须是 canonical 主库；缺省 candidate 路径只允许隔离测试（`h2-data-plane.md:384-390`）。
- nonce 由 host 生成并通过 `CHIMERA_WORKER_NONCE` 传给子进程；不写日志（`chimera-host/src/bin/chimera-host.rs:232-242,271-282`）。
- `--worker-cmd` 是 host 的最后参数；之后全部归 worker 命令（`chimera-host/src/bin/chimera-host.rs:124-133`）。

## 3. capability 门与 kill switch

### 3.1 当前可解析的开关

| 开关 | 取值 | 当前行为 | 证据 |
|---|---|---|---|
| `CHIMERA_HOST_MODE` | `legacy`/`proxy`/`rust` | 解析并打印，不 gate | `chimera-host/src/host.rs:199-256`；bin `303-312` |
| `CHIMERA_HOST_IPC` | `off`/`observe`/`enforce` | 解析并打印，不 gate | 同上 |
| `CHIMERA_HOST_HEARTBEAT_*` | 数字 | 进入 runtime config | `host.rs:226-245`；`runtime.rs:80-126` |
| `CHIMERA_HOST_DRAIN_DEADLINE_MS` | 数字 | 进入 runtime config | `host.rs:238-239` |
| `CHIMERA_HOST_WORKER_SOFT/HARD_LIMIT` | 数字 | 校验后携带，未做 admission | `host.rs:242-253` |

### 3.2 目标 capability 门

- **mode > plane > route** 的优先级由 H2 §4.6 定义（`h2-data-plane.md:470-492`）：
  - `CHIMERA_HOST_PLANE_<PLANE>`：`legacy|shadow|enforce|off`，单数据面。
  - `CHIMERA_HOST_ROUTE_<OPERATION>`：`legacy|proxy|rust`，单 OpenAPI operation。
- 未知开关值必须 `unknown_kill_switch` 拒绝该面，不猜默认。
- route/plane 级开关必须能热重载（候选：host 每 tick 读 `host_state.config_revision`，或控制 socket `host.reload_kill_switches`）。
- 单面失败写 `PlaneHealth { plane, state, reason }`，`/health` 与 `/capability` 暴露；一个面 `unavailable` 不改变 host 整体 `ready`。

### 3.3 启动能力矩阵（建议）

| 能力 | 首个可用阶段 | 前置 | 不允许 |
|---|---|---|---|
| IPC handshake + nonce | H1（已实现） | host 二进制 | 把 nonce 当日志/URL 参数 |
| 六张控制表读写 | H1（已实现） | TS migration | host 建表/迁移 |
| HTTP front door（host-first allowlist） | W2（T1 后） | router + OpenAPI parity | 整批接 96 条 |
| session prompt/turn | W3 | provider + hook + W0 因果/fault | 用 Bun worker 承载 session |
| SSE/WS | W2/W3 | event log + gap 恢复 | 把新增恢复语义冒充旧 parity |
| Windows host | 待 D3 | named pipe + ACL | 假设 Unix socket |

## 4. 失败与降级矩阵

| 失败点 | 检测 | legacy | proxy | rust |
|---|---|---|---|---|
| host 二进制缺失 | `resolveHostBinary` 返回空 | 正常 | legacy + `host_unavailable` | 启动错误 |
| `--db` 缺失 | launcher 参数检查 | 正常 | `host_db_unresolved` → legacy | 启动错误 |
| migration 失败 | Drizzle 抛错 | 报错 | 报错 | 报错 |
| host preflight 失败 | schema/WAL/`host_generation` | 正常 | 该面 legacy | 启动错误 |
| IPC bind 失败 | socket 错误 | 正常 | legacy | 启动错误 |
| worker handshake 失败 | `unauthorized`/`capability_*` | 正常 | 该 worker 不接入 | 503/启动错误 |
| HTTP route 未在 allowlist | router 分类 | 正常 | 该 route legacy | 503 |
| drain 超时 | deadline | 正常 | 强制终止 + `interrupted` | 同左 |

## 5. 与 W2/W3 的门禁关系

- **W2 前置**：T1 runtime foundation（router/boot/launcher/IPC 安全基础）可用；W0 oracle 已过 G0；WP-04 产出 host-first/依赖 session 二分清单。
- **W3 前置**：至少一条经 oracle 验收的 provider 通路；最小真实 hook sidecar；W0 因果层/fault matrix 就绪（`RUST_FULL_MIGRATION_PLAN.md:176-182`）。
- **不得抢跑**：在 boot-path-capability 未满足 R-BOOT-1..R-BOOT-10 前，不得把 96 条初步 host-first 路由整批接到 host；不得用 Bun worker 作为 session 执行体（已拍板取消）。
- **验收向量**：boot/router 现状与目标见 `packages/chimera/test/oracle/runtime/boot-router.vectors.json`（`RT-BOOT-001`..`RT-BOOT-004`）。

## 6. 建议与待拍板

### 6.1 建议

- **B-S1**：launcher 先做“只解析/只传参”的薄层，不把 host 的 migration/preflight 逻辑复制到 TS。
- **B-S2**：把 `host_db_unresolved`、`host_unavailable`、`worker_unavailable`、`route_not_admitted` 作为稳定错误码，进入 CLI 输出与 oracle。
- **B-S3**：boot path 的每个阶段都要有独立 kill switch；不能用一个 `CHIMERA_HOST_MODE` 控制全部面。
- **B-S4**：TUI 的 `new Worker` 托管 server 是迁移对象；W3 前不能因为“UI 不迁”保留 TS session 执行体（`RUST_FULL_MIGRATION_PLAN.md:131`）。

### 6.2 待拍板

- **D3**：Windows host transport 与兜底时点。
- **D5**：host 能力首次发布版本与两变体/CI hard gate 的绑定。
- **launcher 归属**：`packages/chimera/src/host/launcher.ts` 的具体 owner/接口签名；本文只给契约，不落实现。
- **route allowlist 冻结时点**：WP-04 重分诊结果出来前，不冻结具体 operation id。