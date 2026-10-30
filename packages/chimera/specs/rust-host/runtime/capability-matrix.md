# WP-07 H1/H2 能力表：runtime / router / boot-path-capability / launcher

> 状态：契约稿（WP-07，2026-10-30）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §1（H1/H2 定位）、§4（终态架构）、§6（W1/W2/W3）、§8（WP-07）、§10（统一门禁）、§11（宿主最小运行时契约）；`packages/chimera/specs/rust-host/{ipc-v0.md,recovery-matrix.md,h2-data-plane.md}`；`packages/chimera/specs/rust-host/manifest.yaml`（`contract_rev = cr-2026-10-30-r1`）。
> 证据基线：HEAD `9600ee7f49ddcb065a33511f21f570d2b2d13a19` 工作树；`chimera-host/` 与 `packages/chimera/src/**` 为只读取证。
> 范围：只出能力表与契约，不实现生产 runtime、不编译 Rust、不构建可执行体。

## 0. 状态口径

本表只使用三个状态词，避免“部分实现”掩盖接线缺口：

| 状态 | 判定 |
|---|---|
| **已实现** | 代码存在，且被生产入口（`chimera-host` bin、CLI、server 启动路径）实际调用；单元/集成测试覆盖不算生产接线。 |
| **已实现（未接线）** | 代码与测试存在，但生产入口没有调用，或调用后结果被丢弃。 |
| **未实现** | 无实现；只有常量、注释、规格或测试桩也不算实现。 |

结论先行：

1. **H1 是协议/控制存储基础，不是生产 Rust runtime**。`chimera-host` bin 目前是“socket + 握手 + 六张控制表 + 有界 serve”的宿主壳；请求路由是 `Unrouted`，所有请求显式返回 `not_implemented`（`chimera-host/src/bin/chimera-host.rs:194-207,315`）。
2. **H1 的依赖面只有 `rusqlite`**（`chimera-host/Cargo.toml:15-23`）；没有 HTTP server、没有 tokio、没有 provider/transport、没有 launcher。
3. **TS Drizzle 是唯一 migrator**；Rust store 只打开并写六张 host-owned 控制表，从不建表/迁移（`chimera-host/src/store.rs:1-22,341-368`；迁移文件 `packages/chimera/migration/20261022022937_host_control_plane/migration.sql:1`）。
4. **H2 Step 0（非阻塞 serve）已实现并接线**；H2 的七个长驻数据面全部未实现（`packages/chimera/specs/rust-host/h2-data-plane.md:13-32`）。
5. **TS 启动路径仍是进程内 server**：`chimera run/serve/web` 与 TUI worker 都调用 `Server.listen`，没有 host launcher（`packages/chimera/src/cli/cmd/serve.ts:19`、`packages/chimera/src/cli/cmd/web.ts:49`、`packages/chimera/src/cli/cmd/tui/worker.ts:55,99`、`packages/chimera/src/server/server.ts:199-237`）。

## 1. H1 能力表

### 1.1 传输、帧与握手

| ID | 能力 | 状态 | 代码证据 | 边界说明 |
|---|---|---|---|---|
| H1-01 | 64 字节 header、长度前缀、CRC32C、`MORE` 分片重组、`transport_sequence` 连续性 | 已实现 | `chimera-host/src/frame.rs:1-120`；`chimera-host/src/connection.rs:1-60,457-512`；向量 `chimera-host/tests/ipc_frame_vectors.rs:1-100` | 纯库层；bin 通过 `FrameReader/FrameWriter` 使用。 |
| H1-02 | `hello`/`ready`/`ack` 握手、版本交集、能力协商、结构化拒绝 | 已实现 | `chimera-host/src/handshake.rs:425-455`；`chimera-host/src/host_driver.rs:1114-1140`；e2e `chimera-host/tests/e2e_bun_worker.rs:1-20` | TS 侧 `WorkerBootstrap` 与 Rust 侧双臂都有实现。 |
| H1-03 | 必选/已知 capability 集合（`frame.v1`、`control.json`、`event.batch`、`cancel`、`drain`、`replay.command` 等） | 已实现 | `chimera-host/src/handshake.rs:52-66`；规格 `packages/chimera/specs/rust-host/ipc-v0.md:570-598` | `replay.command` 只声明能力；重放流程未实现（见 H1-20）。 |
| H1-04 | 一次性 spawn nonce 校验 | 已实现 | `chimera-host/src/handshake.rs:436-441`；bin 生成/下发 `chimera-host/src/bin/chimera-host.rs:232-242,271-282` | 失败码 `unauthorized`；nonce 不写日志（`handshake.rs:323` 注释）。 |
| H1-05 | Unix socket 权限与 stale-socket 策略（目录 `0700`、socket `0600`、只删已死 socket、拒绝非 socket 文件） | 已实现 | `chimera-host/src/host.rs:418-422,451-460,500-526`；测试 `host.rs:993-1090` | 只覆盖 Unix domain socket；不是 TCP。 |
| H1-06 | peer credentials（`SO_PEERCRED`/`LOCAL_PEERCRED`）与 uid 一致性校验 | 未实现 | 规格自述 `packages/chimera/specs/rust-host/ipc-v0.md:128-136`；源码无 `getpeereid`/`SO_PEERCRED` 命中（`rg -n "getpeereid|SO_PEERCRED|LOCAL_PEERCRED" chimera-host/src` 为空） | 当前信任边界 = 目录/文件权限 + nonce；H2 缺口 G3（`h2-data-plane.md:650`）。 |
| H1-07 | Rust 侧握手读超时 | 未实现 | 规格 `packages/chimera/specs/rust-host/ipc-v0.md:138-150`；H2 缺口 G2（`h2-data-plane.md:648`）；阻塞读证据 `chimera-host/src/host_driver.rs:1499,1512,1592` | TS worker 侧有 `HANDSHAKE_TIMEOUT_MS`；Rust `run_handshake` 仍是阻塞读。 |

### 1.2 生命周期、监督与恢复

| ID | 能力 | 状态 | 代码证据 | 边界说明 |
|---|---|---|---|---|
| H1-08 | worker registry、generation fencing、状态机（spawned→handshaking→ready→busy→draining→exited/crashed/killed/unresponsive） | 已实现 | `chimera-host/src/supervisor.rs:141-183,308-560`；runtime 接线 `chimera-host/src/runtime.rs:294-345` | 注册表是内存态；持久化行由 `HostStore` 另行写入。 |
| H1-09 | 心跳发送与失联扫描 | 已实现 | `chimera-host/src/runtime.rs:353-431`；`host_driver.rs` 的 `send_heartbeat` 路径 | bin 每轮调用 `tick`，但把结果丢弃（`chimera-host/src/bin/chimera-host.rs:335`）。 |
| H1-10 | 崩溃记账、退避调度、5 次/5 分钟暂停 | 已实现（未接线） | 退避常量 `chimera-host/src/supervisor.rs:33-44,659-675`；`runtime.rs:761-785`；`try_restart` `runtime.rs:706-743` | 崩溃记账经 `serve_round → settle_connection` 接线；**重启动作没有任何生产调用**（bin 无 `try_restart`）。 |
| H1-11 | graceful drain：`request_drain` / `collect_drain_outcomes` / `kill_worker` | 已实现（未接线） | `chimera-host/src/runtime.rs:593-703`；`supervisor.rs:513-539` | bin 没有信号处理（`chimera-host/src/bin/chimera-host.rs:43-49`），没有调用 `request_drain`；`tick` 的 `drain_expired` 也被丢弃。 |
| H1-12 | worker 崩溃后重启与 generation 递增 | 已实现（未接线） | `chimera-host/src/runtime.rs:706-743`；bin 只 `try_wait`/reap（`chimera-host/src/bin/chimera-host.rs:339-353`），注释明确 restart 不在 bin（`30-33`） | 当前 bin 的 worker 退出后不会补位；崩溃预算/暂停只存在于库层。 |
| H1-13 | host 启动时对非终态 durable 行做 sweep（`interrupted`/`cancelled` 收敛） | 未实现 | `chimera-host/src/store.rs:212-220` 只有状态字符串；bin 启动只 `HostStore::open`（`chimera-host/src/bin/chimera-host.rs:253-259`）；H2 缺口 G14（`h2-data-plane.md:661`） | 规格要求见 `ipc-v0.md:858-864`；当前 host 重启不会收敛 running 行。 |
| H1-14 | cancel 帧发送（host→worker） | 已实现（未接线） | `chimera-host/src/host_driver.rs:1043-1063`；帧类型 `frame.rs:62-63` | `send_cancel` 仅定义于 `host_driver.rs:1044`，唯一调用点是同文件测试 `host_driver.rs:2460`；生产入口没有路由触发它。 |
| H1-15 | cancel 执行（worker 停止目标工作、软/硬超时、终态写回） | 未实现 | TS worker serve 循环只处理 `drain`/`event`/`request`（`packages/chimera/src/host/worker-bootstrap.ts:466-492`），没有 `cancel` 分支；H2 缺口 G1（`h2-data-plane.md:648`） | `cancel_soft_timeout_ms`/`cancel_hard_timeout_ms` 只在 ready limits 中解析（`worker-bootstrap.ts:209-228`）。 |
| H1-16 | command replay（`host_command_replay` 表、分配器、重连补发） | 未实现 | 表未声明（`packages/chimera/src/storage/tables/host.sql.ts:8-13`）；handshake 只带 `replay_available`（`handshake.rs:228,552-554`）；replay 帧被忽略（`host_driver.rs:2403-2425`）；H2 缺口 G5（`h2-data-plane.md:652`） | 规格 `ipc-v0.md:866-874` 明确 not implemented。 |
| H1-17 | kill switch `CHIMERA_HOST_MODE`（legacy/proxy/rust）与 `CHIMERA_HOST_IPC`（off/observe/enforce） | 已实现（未接线） | 解析 `chimera-host/src/host.rs:199-256`；枚举 `host.rs:77-143`；bin 只在启动行打印（`chimera-host/src/bin/chimera-host.rs:303-312`） | 没有任何分支根据 `mode`/`ipc` 改变行为；`h2-data-plane.md:470-492` 也把 H1 记为“已解析，未 gate 行为”。 |
| H1-18 | worker spawn（host 作为父进程、注入 socket/nonce 环境） | 已实现 | `chimera-host/src/bin/chimera-host.rs:263-300` | 只 spawn + reap；没有 liveness monitor、没有 restart/backoff 接线。 |

### 1.3 存储与提交协议

| ID | 能力 | 状态 | 代码证据 | 边界说明 |
|---|---|---|---|---|
| H1-19 | 六张 host-owned 控制表（`host_worker`/`host_state`/`session_turn_checkpoint`/`pending_request`/`request_idempotency`/`host_event`）读写 | 已实现 | `chimera-host/src/store.rs:1-22,341-368`；schema `packages/chimera/src/storage/tables/host.sql.ts:8-13`；迁移 `packages/chimera/migration/20261022022937_host_control_plane/migration.sql:1` | 表由 TS Drizzle migration 创建；Rust 只打开/写入。 |
| H1-20 | TS Drizzle 作为唯一 migrator；Rust 不迁移 | 已实现 | `chimera-host/src/store.rs:16-22`（“The store never migrates”）；`HostStore::open` 注释 `341-348`；TS `applyMigrations` `packages/chimera/src/storage/db.ts:61-72` | 这是硬边界，不是临时约定。 |
| H1-21 | durable event commit-before-ack | 已实现 | `chimera-host/src/host.rs:659-760`；`HostHandle::serve_round` 先 `append_event` 再 `acknowledge_durable` | 失败时不 ack，连接保持；测试 `host.rs:1325-1353`。 |
| H1-22 | transient event 不落库、不 ack | 已实现 | `chimera-host/src/host.rs:689-728` | 只计数 `transient_accepted`；不写 `host_event`。 |
| H1-23 | canonical DB 路径解析（XDG/channel/`OPENCODE_DB`） | 未实现 | TS `packages/chimera/src/storage/db.ts:38-45`；bin 明确无法复现并默认 `<data-root>/host/host.db`（`chimera-host/src/bin/chimera-host.rs:51-59,180-181,253`） | Rust 侧未实现；该默认是 **candidate**，不是 canonical 主库；H2 要求 launcher 传 `--db`（`h2-data-plane.md:384-390`）。 |

### 1.4 路由、HTTP front door 与启动器

| ID | 能力 | 状态 | 代码证据 | 边界说明 |
|---|---|---|---|---|
| H1-24 | `RequestRouter` 抽象与请求/响应分发 | 已实现（未接线） | trait `chimera-host/src/host_driver.rs:541-543`；分发 `1382-1400`；bin 的 `Unrouted` `chimera-host/src/bin/chimera-host.rs:194-207,315` | bin 对所有请求返回 `not_implemented`；没有 worker 路由表。 |
| H1-25 | HTTP/HTTPS front door（host 侧监听、OpenAPI、auth） | 未实现 | `chimera-host/` 无 HTTP listener；TS 侧 `Server.listen` `packages/chimera/src/server/server.ts:199-237`；`serve.ts:19`、`web.ts:49` | 当前 front door 仍是 Bun 进程内 server；host 只提供 Unix socket。 |
| H1-26 | TS host launcher（解析二进制、canonical DB、启动 host、降级） | 未实现 | 不存在 `packages/chimera/src/host/launcher.ts`；无 `CHIMERA_HOST_BIN` 命中；规格提案 `h2-data-plane.md:608-630` | 当前没有代码把 host 拉起来；`bun-worker` 只作为 host 的被动子进程存在（`packages/chimera/src/cli/cmd/bun-worker.ts:31-38`）。 |
| H1-27 | host 二进制进入 npm 产物 / postinstall 探测 / 版本探测 | 未实现 | `packages/chimera/script/build.ts:118,400` 只有 `copyKernelPrebuild`；`packages/chimera/script/postinstall.mjs:29,62` 只探测 kernel；`.github/workflows/publish.yml:173-190` 明确 host prebuild “not packaged into npm tarballs yet” | host-prebuild CI 有 6 个 Unix leg，但只是 workflow artifact。 |
| H1-28 | Windows host transport | 未实现 | `chimera-host/src/host.rs:29-30` 直接 `use std::os::unix::...`；bin 读 `/dev/urandom`（`chimera-host/src/bin/chimera-host.rs:190`）；`.github/workflows/publish.yml:189` 注释“no Windows: chimera-host imports std::os::unix”；H2 非目标 `h2-data-plane.md:39` | Windows 当前只能走 legacy；D3 仍待拍板。 |
| H1-29 | TS worker bootstrap（真实 Bun 子进程） | 已实现 | `packages/chimera/src/cli/cmd/bun-worker.ts:31-38,80-116`；`worker-bootstrap.ts:438-528` | handler 是 echo stub（`bun-worker.ts:113-115`），不承载 session/agent loop；生产接线待 W3。 |
| H1-30 | host 侧 Basic auth / SSE / WebSocket | 未实现 | TS auth `packages/chimera/src/server/auth.ts:18-41`；host 无对应代码 | H1 不拥有 HTTP 面；这些属于 H2/W2。 |

## 2. H2 能力表

H2 的七个数据面定义见 `packages/chimera/specs/rust-host/h2-data-plane.md:13-32`。本表按该顺序逐项标注当前状态。

| ID | H2 能力 | 状态 | 代码/规格证据 | 边界说明 |
|---|---|---|---|---|
| H2-00 | Step 0：非阻塞 `serve_available` + 有界 `serve_round` + `Idle` 语义 | 已实现 | `chimera-host/src/host_driver.rs:814-860,1142-1180`；`chimera-host/src/host.rs:670-760`；bin 主循环 `chimera-host/src/bin/chimera-host.rs:316-356` | 每连接预算 `ServeBudget::DEFAULT`（64 帧 / 10ms）；`Idle` 非终态；bin 每轮 accept/serve/tick/reap。 |
| H2-01 | graph database / read / query / traversal | 未实现 | `h2-data-plane.md:18`；`chimera-host/src` 无 graph store/query 模块 | 目标 owner 是 host 的 `chimera-core`；当前仍 TS `CodeGraph` + NAPI kernel。 |
| H2-02 | watcher + graph change stream | 未实现 | `h2-data-plane.md:19`；`chimera-host/src` 无 watcher | 当前 Bun `chokidar`。 |
| H2-03 | SQLite/WAL、session/job durable state | 未实现 | `h2-data-plane.md:20`；`chimera-host/src/store.rs:1-22` 只拥有六张控制表 | session/message/part/background_job/lease 仍由 Bun 写；host 只写控制表。 |
| H2-04 | static asset cache | 未实现 | `h2-data-plane.md:21`；`chimera-host/src` 无 static/asset 代码 | WebUI 资源仍由 TS server 嵌入/服务。 |
| H2-05 | SSE fan-out + event log | 未实现 | `h2-data-plane.md:22`；`chimera-host/src/store.rs` 有 `host_event` append，但无 SSE server/fan-out | 只有 durable event 落表；`Last-Event-ID`/`stream_epoch` 恢复未实现（G16）。 |
| H2-06 | workspace/project control-plane | 未实现 | `h2-data-plane.md:23`；`chimera-host/src` 无 workspace/control-plane 模块 | 当前 TS `src/control-plane/*`。 |
| H2-07 | process registry + worker policy | 未实现 | `h2-data-plane.md:24`；`chimera-host/src/supervisor.rs` 只有内存 registry/策略原语，无项目库 process registry | supervisor 的 generation/backoff 是 H1 资产；H2 才落 process registry。 |
| H2-08 | host 打包接线：`copyHostPrebuild`、postinstall 探测、launcher | 未实现 | `h2-data-plane.md:567-640`（现状与目标）；`packages/chimera/script/build.ts:118,400`、`packages/chimera/script/postinstall.mjs:29,62`、`.github/workflows/publish.yml:173-190` | 6 个 Unix prebuild leg 已产出 artifact，但未进 npm。 |
| H2-09 | Windows host | 未实现 | `h2-data-plane.md:39`；`chimera-host/src/host.rs:29-30`；`.github/workflows/publish.yml:189` | 明确非目标，直到 D3 拍板。 |
| H2-10 | wasm fallback 退役 | 未实现 | `h2-data-plane.md:505-566` | 属 graph 域（WP-06），不是 WP-07 的实现面；此处只登记为 host 能力前置。 |
| H2-11 | plane/route 级 kill switch（`CHIMERA_HOST_PLANE_*` / `CHIMERA_HOST_ROUTE_*`） | 未实现 | `h2-data-plane.md:470-492` | 当前只有 mode/ipc 两个开关的解析，且未 gate 行为（H1-17）；探针 `rg -n "CHIMERA_HOST_PLANE_|CHIMERA_HOST_ROUTE_" chimera-host packages/chimera/src` 无结果（2026-10-30），确认无实现。 |

## 3. 已知事实的代码核对

| 事实 | 证据 | 影响 |
|---|---|---|
| host bin 当前 `Unrouted`，所有请求 `not_implemented` | `chimera-host/src/bin/chimera-host.rs:194-207,315` | W2 不能假设 H1 可直接承载任何 HTTP 路由；router 契约见 `router-contract.md`。 |
| host crate 只有 `rusqlite` 依赖 | `chimera-host/Cargo.toml:15-23` | 没有 tokio/HTTP/serde/utoipa；H2 的异步/HTTP 面需要新增依赖与 CI build-root 单写者。 |
| TS Drizzle 是唯一 migrator | `chimera-host/src/store.rs:16-22,341-348`；`packages/chimera/src/storage/db.ts:61-72` | host 不得建表/改列；启动顺序必须先 TS migration 再 host open。 |
| host bin 默认 DB 是 `<data-root>/host/host.db`，不是 canonical 主库 | `chimera-host/src/bin/chimera-host.rs:51-59,180-181,253` | 当前不能直接接生产主库；H2 要求 launcher 传 `--db`，缺省应 `host_db_unresolved` 而非创建候选库（`h2-data-plane.md:384-390`）。 |
| host bin 无信号处理 | `chimera-host/src/bin/chimera-host.rs:43-49` | SIGTERM/SIGINT 走默认处置，不能保证 drain；平台契约见 `platform-contract.md` §1。 |
| host bin 不重启 worker | `chimera-host/src/bin/chimera-host.rs:30-33,339-353`；`runtime.rs:706-743` 未被调用 | 崩溃后 workspace 不会自动恢复；supervisor 原语存在但未接线。 |
| kill switch 已解析但未 gate 行为 | `chimera-host/src/host.rs:199-256`；bin `303-312` 只打印 | 不能把 `CHIMERA_HOST_MODE=rust` 当作“已启用 Rust 权威”。 |
| IPC 信任只有目录/文件权限 + nonce | `host.rs:418-422,500-526`；`handshake.rs:436-441` | peer uid 校验缺失；IPC enforce 前必须补 G3。 |
| Windows 无 host 产物 | `host.rs:29-30`；`.github/workflows/publish.yml:189`；`h2-data-plane.md:39` | Windows 一律 legacy；D3 决定 transport/兜底时点。 |
| 无 TS launcher / host 未进 npm | 无 `src/host/launcher.ts`；`packages/chimera/script/build.ts:118,400`；`packages/chimera/script/postinstall.mjs:29,62`；`.github/workflows/publish.yml:173-190` | host 能力对用户不可启用；发布门禁前移（§10）尚未满足。 |

## 4. 与 WP-07 DoD 的对应

| DoD | 落点 |
|---|---|
| H1/H2 能力表逐项标 已实现/未接线/未实现 | 本文件 §1、§2、§3 |
| 关闭/重启、IPC trust、Windows、两变体安装各 ≥1 条可执行验收向量 | `packages/chimera/test/oracle/runtime/{shutdown-restart,ipc-trust,windows,install-variants}.vectors.json`；说明见同目录 `README.md` |
| boot-path-capability 与 router 契约成文 | `packages/chimera/specs/rust-host/runtime/boot-path-capability.md`、`router-contract.md` |
| 不实现生产 runtime | 本批只新增契约/向量文件；未改 `chimera-host/**`、未编译 Rust、未构建可执行体 |

## 5. 建议与待拍板

### 5.1 建议（可执行，不需新拍板）

- **R1**：在 router 里程碑之前保留 `Unrouted` 的显式拒绝，不允许静默丢请求或返回空响应；任何新 router 必须保留 `not_implemented`/`worker_unavailable` 的结构化错误。
- **R2**：在 `proxy`/`rust` 模式下，launcher 必须显式传 canonical `--db`；缺省时返回 `host_db_unresolved` 并回退 legacy，不创建 `<data-root>/host/host.db`（与 `h2-data-plane.md:384-390` 一致）。
- **R3**：在 IPC `enforce` 前补齐 peer credentials（G3）与 Rust 握手读超时（G2）；否则 `enforce` 的信任边界仍弱于规格。
- **R4**：把 host 的 `mode`/`ipc` 解析结果接入启动决策；在接线前，文档与 CLI 输出不得声称 `rust` 模式已生效。
- **R5**：W2 首批只接 WP-04 重新分诊后的 host-first allowlist；96 条初步 host-first 不得整批接入（见 `router-contract.md` §3）。

### 5.2 待拍板

- **D3（Windows）**：host 传输与兜底策略（随包发布 named pipe / 延迟 / 不支持）必须在首个 host 能力发布前定；当前事实是 Windows 无 host 产物，只能 legacy。
- **D5（发布门禁时点）**：首个用户可启用 host 能力的版本即启用 npm 两变体 + CI hard gate；host prebuild 是否随该版本进入平台包，需与发布 owner 确认。
- **host 二进制归属**：H2 建议不新增独立 `@coding-chimera/chimera-host-<platform>` 包，复用平台包 `bin/host/`；该选择尚未经发布矩阵评审（`h2-data-plane.md:593-597`）。
- **96 路由重分诊结果**：WP-04 产出 host-first / 依赖 session 二分清单前，首批 allowlist 不冻结具体 operation id。