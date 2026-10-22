# Rust Host H2：长驻数据面设计

**Status (2026-10-22): proposed — H1 已落地（见 ipc-v0.md/recovery-matrix.md 状态注记），本文档是 H2 设计提案，未经评审**

制定：2026-10-22  
服务对象：`RUST_HOST_MIGRATION_PLAN.md` §H2（迁移长驻数据面）  
性质：设计提案。H1 的实现契约以 `ipc-v0.md` / `recovery-matrix.md` 为准；本文只定义 H2 的迁移顺序、所有权切换、降级语义和验收门。文中所有超时、容量、百分比都是 **candidate default**，不是已批准的容量或性能承诺。

---

## 0. 范围与非目标

### 0.1 H2 的七个长驻数据面

H2 把下列七类状态从 Bun 进程逐步搬到 Rust host。顺序即迁移顺序，前一步的 parity 与回滚证据是后一步的开工前提。

| 步 | 数据面 | H1 现状 | H2 目标 owner | 复用资产 | capability |
|---:|---|---|---|---|---|
| 1 | graph database / read / query / traversal | TS `CodeGraph` + NAPI `codegraph-kernel` | host（`chimera-core`） | `codegraph-kernel` 的 store / resolver / extraction | `graph.read` |
| 2 | watcher + graph change stream | Bun `chokidar`（`src/graph/sync/watcher.ts`） | host | `chimera-core` change stream + FS backend | `graph.watch` |
| 3 | SQLite/WAL、session/job durable state | Bun 写主库；host 只写 host-owned 控制表 | host | `HostStore` + Drizzle schema | `storage.write` |
| 4 | static asset cache | Bun 内嵌 WebUI 资源 | host | 现有嵌入产物 | `static.serve` |
| 5 | SSE fan-out + event log | Bun `global-event-stream`；host 已有 `host_event` 表 | host | `host_event` + 现有 SSE 语义 | `sse.fanout` |
| 6 | workspace/project control-plane | Bun `src/control-plane/*` | host | 主库 `workspace` 表 + 现有路由契约 | `workspace.control` |
| 7 | process registry + worker policy | Bun 项目库 `chimera_process_registry`；supervisor 已有 generation | host | supervisor + 项目库 schema | `process.registry` / `worker.policy` |

每一步必须同时具备四件东西，缺一不得进入下一步：

1. **TS fallback**：旧路径仍能在同一发布周期内接管该面；
2. **独立 capability**：hello/ready 协商中的独立能力字符串，不与其他面捆绑；
3. **parity harness**：可重复的双臂对账，不是一次性手工比对；
4. **kill switch**：可单独把该面切回 legacy，而不要求重启整个 host 或回退所有面。

### 0.2 非目标（H2 不做）

- 不把 provider、plugin loader、PTY 字节流、LSP/browser 执行器迁进 host；它们仍属 worker 或后续阶段。
- 不引入分布式事务、跨库两阶段提交或第二个事实源。
- 不删除 JS SDK、不改变对外 OpenAPI/SSE/PTY 契约。
- 不在 H2 实现 Windows host（`chimera-host` 仍依赖 `std::os::unix`，Windows 一律走 legacy）。
- 不把 `msgpack` 数据面当作既定目标；是否做见 §7 与 §10。
- 不承诺“全部 Rust 化”；H2 只处理长驻数据面。

### 0.3 设计原则

1. **单面失败不得拖垮 host。** 每个数据面独立初始化、独立健康状态、独立降级；一个面不可用只影响该面的路由，host 仍必须 `ready` 并可服务其他面。
2. **Rust core 优先，NAPI 只作过渡。** 能抽到 `chimera-core` 的逻辑不放进 NAPI；NAPI 仅服务仍留在 Bun 的过渡读路径。
3. **单一写者。** 任一表在任一时刻只有一个写入方。H2 的“双写”一律解释为 **shadow 计算 + 对账**，不是两个进程同时 commit 同一张表（`recovery-matrix.md` §1.6）。
4. **先有界再优化。** 每个 cache、队列、event log、watcher 缓冲、进程表都有条目或字节上限；超限只允许丢可重建的 transient。
5. **显式降级。** capability 缺失、schema 不匹配、prebuild 缺失、parity 未通过时，返回结构化 `degraded`/`unavailable`，不猜测、不静默伪造连续状态。
6. **可回退。** 每个面有独立开关；回退不依赖 down migration，只关闭开关并恢复旧读写路径。

### 0.4 术语

| 术语 | 含义 |
|---|---|
| plane | 本文 §0.1 的七类长驻数据面之一 |
| capability | hello/ready 协商中的能力字符串；缺失时该面不可路由 |
| shadow | 新写者计算并记录预期写入，但不 commit；用于与旧写者实际行对账 |
| read flip | 读路径切到 host，写者仍为旧路径 |
| writer flip | 写路径切到 host，旧路径转只读 |
| parity harness | 同一输入下双臂结果比较；读路径比结果，写路径比对账 |
| degraded | 该面不可用但 host 可启动；路由按 kill switch 回退或返回 503 |
| legacy | 进程内 Bun 路径，H2 的最终回退目标 |

---

## 1. 现状证据基线

### 1.1 host 骨架：serve 仍是阻塞循环

- `UnixSocketListener::bind` 把 listener 设为非阻塞，但 `accept()` 在返回连接前执行 `stream.set_nonblocking(false)`（`chimera-host/src/host.rs:534-540`）。被接受的连接是阻塞流。
- `FrameReader::next_frame` 循环 `parse_buffered → fill`，`fill` 直接 `read`；没有完整帧时阻塞到下一个字节、EOF 或错误（`chimera-host/src/connection.rs:268-281`）。
- `HostDriver::serve` 是 `loop {}`：读帧、处理 request/event/ack，直到 EOF、drain 截止或错误（`chimera-host/src/host_driver.rs:1085-1162`）。drain deadline 只在帧边界检查，空闲连接会卡在阻塞 read 上。
- `HostHandle::serve_round` 已实现 commit-before-ack：durable event 先 `append_event`，再 `acknowledge_durable`（`chimera-host/src/host.rs:661-724`）。但 bin **没有驱动它**，注释明确说明阻塞 serve 会 park accept/tick/reap（`chimera-host/src/bin/chimera-host.rs:310-315`）。
- 当前 bin 循环只做 `accept_next → tick → reap → sleep(50ms)`；`serve_round` 仅由单测和跨语言 e2e 驱动。

结论：H2 的第一步不是任何业务数据面，而是让 `serve_round` 能被主循环安全、有界地驱动（§2）。

### 1.2 两个 SQLite 事实源

| 存储 | 路径/打开方式 | 迁移 | 当前承载 |
|---|---|---|---|
| 主应用库 | `Global.Path.data/chimera.db`（channel 变体见 `getChannelPath()`；`OPENCODE_DB` 可覆盖） | TS Drizzle `migration/<timestamp>_<slug>/`；`Database.applyMigrations` | session/message/part、permission、background_job、turn lease、host 控制表 |
| host 候选库 | `<data-root>/host/host.db`（bin 的 `default_db_path`） | 无；`HostStore::open` 明确“never migrates” | H1 单测/本地 smoke |
| 项目库 | `getDatabasePath(projectRoot)` | `src/chimera/store.ts` 内联 `PRAGMA user_version`（当前 8） | edit-intent、`chimera_process_registry` |

主库打开参数（`src/storage/db.ts`）：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`cache_size=-16000`、`foreign_keys=ON`、`journal_size_limit=64MB`，并有 5 分钟一次的 `wal_checkpoint(PASSIVE)`。`HostStore::open` 使用前四项中的 WAL/NORMAL/busy_timeout/foreign_keys，但**没有** `journal_size_limit`，也不跑 checkpoint。

H2 必须把 host 的 `--db` 固定到主库，并解决双进程 WAL 的写者、checkpoint 与迁移所有权（§4）。

### 1.3 graph：kernel 已覆盖 20 语言，wasm 仍是无 kernel 语言的唯一路径

- `codegraph-kernel/src/langs.rs` 的 `LANGUAGES` 是 20 项：typescript/tsx/javascript/jsx/java/python/go/c/cpp/rust/csharp/ruby/php/swift/kotlin/r/lua/luau/scala/dart。
- `src/graph/extraction/kernel/index.ts` 的 `DEFAULT_ROUTED` 覆盖 20 项中的 19 项（`lua`/`luau` 在 wave 1，`r` 尚未路由），明确注明 objc 来自 `.h` 歧义展开，r/solidity/pascal/nix 仍走 wasm。
- `objc`、`pascal`、`nix` 有 TS/wasm 提取器（`src/graph/extraction/languages/{objc,pascal,nix}.ts`），但没有 kernel arm。用户 2026-10-22 已拍板：这三个语言迁入 kernel，随后删除 wasm 提取路径（§5）。
- kernel 的 `defer:` 安全阀仍依赖 wasm 处理 parse-error/栈保护文件（c/cpp 的 10–40% 政策带）。因此“删除 wasm”不是只补三个语言，还要消除或显式化 defer 依赖（§5.3）。

### 1.4 打包：host-prebuild CI 已有，但未进 npm 产物

- `publish.yml` 的 `host-prebuild` job 已存在：6 个 Unix leg（linux x64/arm64 glibc+musl、darwin x64/arm64），`continue-on-error: true`，产物只作为 workflow artifact；注释明确“intentionally NOT packaged into npm tarballs yet — the wiring lands when the runtime actually launches the host (H2)”。
- `build-host.sh` 已把可执行物 stage 到 `chimera-host/prebuilds/<platform>/chimera-host`。
- `script/build.ts` 只有 `copyKernelPrebuild`（`.node` → `bin/kernel/codegraph-kernel.node`），没有 host 二进制复制。
- `postinstall.mjs` 只探测 kernel `.node`，不探测 host。
- TS 侧没有 host 启动器（`rg chimera-host` 在 `src/` 无命中）。

### 1.5 H1 遗留缺口

`ipc-v0.md` §17 与 `recovery-matrix.md` §7 的 16 项未完成/部分完成项，统一在 §7 排入 H2，不另开 H3 前置。

---

## 2. 前置：非阻塞 serve（Step 0）

### 2.1 目标契约

在不破坏现有阻塞 `serve()` 契约（跨语言 e2e 与单测依赖它）的前提下，给主循环一个**有界、可返回**的 serve 变体：

- 没有完整帧时立即返回“本轮无进展”，不阻塞 accept/tick/reap；
- 已缓冲的完整帧必须在本轮处理，不能因为一次 read 超时就丢弃；
- EOF、协议错误、drain 完成/超时的语义与阻塞版完全一致；
- 单个连接的读超时不得被当成 crash，也不得被当成 `Closed`。

### 2.2 方案 A（推荐）：读超时 + `serve_available`

**传输层**：`UnixSocketListener::accept` 保持写方向阻塞，只给读方向设置 `set_read_timeout(Some(SERVE_READ_TIMEOUT_MS))`。理由：

- 写方向必须保持阻塞：`FrameWriter` 的 `write_all` 与 durable ack 依赖阻塞写；把整条 socket 设为非阻塞会让所有写路径需要重写并引入写队列。
- Unix socket 的 `O_NONBLOCK` 是文件描述级，`try_clone` 共享同一描述，无法只让读半非阻塞、写半阻塞；读超时是唯一低风险做法。
- macOS/Linux 的 `SO_RCVTIMEO` 在无数据时返回 `WouldBlock` 或 `TimedOut`，两者都归一化为“本轮未就绪”。

**读取层**：给 `FrameReader` 增加 `try_next_frame`：

```text
enum NextFrame {
  Frame(Header, Vec<u8>),  // 完整帧
  NotReady,                // 本轮没有新帧；已缓冲的半帧保留
  Eof,                     // 帧边界上的干净 EOF
}
```

规则：

- 先 `parse_buffered`；完整帧直接返回。
- 否则只做一次 `fill_once`；`WouldBlock`/`TimedOut` → `NotReady`，缓冲保留。
- `read == 0` 且缓冲为空 → `Eof`；缓冲非空 → `DecodeError`（与阻塞版一致）。
- `accept_sequence` 只在完整帧返回时执行；半帧不推进 `expected_sequence`。
- 现有 `next_frame` 保留，内部继续循环调用 `fill`；阻塞版行为不变。

**驱动层**：新增 `HostDriver::serve_available(registry, router, clock, budget)`：

```text
loop:
  if drain deadline passed -> DrainTimedOut
  match reader.try_next_frame():
    Frame -> handle_frame(...); frames += 1
    NotReady -> return Idle
    Eof -> return Closed
  if frames >= budget.max_frames or elapsed >= budget.max_ms -> return Idle
```

`budget`（candidate default）：`max_frames = 64`、`max_ms = 10`。两个上限取先到者，防止一个连接在帧洪峰下饿死 tick 与其他连接。

**阻塞版复用**：`serve()` 继续使用阻塞 `next_frame`，或实现为 `loop { serve_available(unbounded) }` 并把 `Idle` 视为继续。无论哪种，e2e 的 `ServeOutcome::Closed` 断言不变。

### 2.3 方案 B（不推荐 H2）：全非阻塞 + 写队列

把读和写都设为非阻塞，`FrameWriter` 改为有界写队列 + `drain` 回调，主循环同时驱动读队列和写队列。优点是单线程完全无阻塞；代价是：

- 所有 durable ack、response、heartbeat 都要经过队列，写失败/半写/重试语义需要重新证明；
- `FrameWriter` 当前是同步 `Write`，改动面覆盖 host driver、runtime、所有单测；
- 与 H1 已稳定的 commit-before-ack 顺序叠加，风险高于收益。

结论：H2 采用方案 A。若后续写阻塞成为实测瓶颈（例如慢 worker 的 ack 写阻塞 tick），再单独立项评估方案 B，不在 H2 引入。

### 2.4 `ServeOutcome` 语义变化

新增：

```text
ServeOutcome::Idle
```

| 变体 | 触发 | 是否终态 | `settle_connection` 行为 |
|---|---|---|---|
| `Closed` | 帧边界 EOF、协议错误 | 是 | 按 crash/关闭处理，移除连接（现状不变） |
| `Drained(ack)` | 收到 `ack(phase=drained)` | 是 | 标记 `exited(normal)`，移除连接 |
| `DrainTimedOut` | drain deadline 在步边界到期 | 是（由调用方升级） | 保持连接，由调用方 `SIGTERM`/`SIGKILL` |
| `Idle`（新） | 本轮没有完整帧或达到 step budget | 否 | no-op；连接保持，下一轮继续 |

对现有代码的影响：

- `serve_round` 的 `ConnectionReport.outcome` 允许出现 `Idle`；调用方不得把 `Idle` 当成关闭。
- `settle_connection` 增加 `Idle => {}` 分支；`Closed`/`Drained`/`DrainTimedOut` 分支不变。
- `serve()` 阻塞版永不返回 `Idle`。
- 所有对 `ServeOutcome` 的穷尽 match 必须显式处理 `Idle`；编译器会强制。

### 2.5 主循环与错误隔离

H2 的 bin 循环顺序固定为：

```text
loop:
  accept_next()            // 至多一个连接
  serve_round(router)      // 有界；每个 live connection 最多一个 step
  tick()                   // heartbeat scan/send、drain deadline 观察
  reap children
  sleep(POLL_INTERVAL)     // candidate default 50ms
```

约束：

- `serve_round` **不得**因为单个连接的 store 错误或协议错误中止整轮。设计上把 `serve_round` 的返回改为 `ServeRound { connections: Vec<ConnectionReport>, degraded: Vec<PlaneHealth> }`，store 失败记录到该连接报告并保持 durable event 未 ack（worker 会重发），host 继续服务。
- `tick` 的 heartbeat 写也必须设置写超时（candidate default `WRITE_TIMEOUT_MS = 100`）；写超时只标记 `unresponsive`，不阻塞循环、不直接 kill。
- 握手阶段使用独立的读超时（candidate default `HANDSHAKE_TIMEOUT_MS = 10_000`），超时返回 `handshake_timeout` 并关闭；完成握手后切换为 `SERVE_READ_TIMEOUT_MS`。这同时关闭 H1 遗留项“Rust 握手读超时”。
- `serve_round` 与 `tick` 之间不共享可变连接迭代器；先快照 `live_connections()`，再逐条驱动，避免借用冲突。

### 2.6 Step 0 验收

| 门 | 判据 |
|---|---|
| 不阻塞 | 空闲连接下 `accept_next`/`tick` 的间隔 p99 ≤ 2 × `POLL_INTERVAL`（candidate default） |
| 帧不丢 | 半帧跨多次 `NotReady` 后仍能完整重组；`transport_sequence` 不因 `Idle` 跳号 |
| 语义不变 | 现有 e2e 的 `Closed`/`Drained` 断言全部通过；新增 `Idle` 单测 |
| 隔离 | 单连接 store 失败不导致 `serve_round` 返回致命错误，其他连接继续 |
| 握手超时 | 不发 `hello` 的连接在 10s（candidate default）内被 `handshake_timeout` 关闭 |

---

## 3. 七个长驻数据面

### 3.1 Step 1：graph database / read / query / traversal

**所有权**：host 打开并拥有项目 graph DB（路径由 `src/graph/directory.ts` 的 data-root 解析逻辑给出，不硬编码 `.chimera/` 或 `.codegraph/`）；worker 不再直接打开 graph DB 做读/写，只通过 capability 路由请求。

**复用**：`codegraph-kernel` 已有 store（SQLite 读写）、resolver（`resolve_batch`）、extraction。H2 把这些抽成无 NAPI 的 `chimera-core` graph API；`codegraph-kernel` 的 NAPI 导出保留给仍留在 Bun 的过渡路径。`GraphQueryManager` / `GraphTraverser`（`src/graph/graph/queries.ts`、`traversal.ts`）的语义是 parity 的 oracle，不是要照搬的实现。

**capability**：`graph.read`（query/search/traversal/status）与 `graph.write`（index/sync）。两者分开，允许 host 只读、写仍由 Bun 或 CLI 承担。

**TS fallback**：进程内 `CodeGraph` + NAPI kernel；`CHIMERA_HOST_PLANE_GRAPH=legacy` 时完全走旧路径。

**边界与上限**：

- 单次 query 结果条目上限、traversal 节点/边上限、返回字节上限（candidate default：query 10k 行 / traversal 50k 节点 / 32 MiB）。
- host 侧 query cache 按条目 + 字节双重上限，LRU；不得无界增长。
- 读连接与写连接分离；host 的读事务不得包住长时间扫描。

**parity**：节点/边/ref 行 canonical 化后逐字段比较；query 结果按稳定排序比较；traversal 比较访问集合与深度/limit 语义。fixture corpus + in-repo sweep 双跑。

**退出条件**：读/query/traversal parity ≥ 99.99%（candidate default），零“静默不同行”；p95 ≤ 110% 的 Bun baseline；cache 有界。

### 3.2 Step 2：watcher + graph change stream

**所有权**：host 拥有 watcher 生命周期和 change stream；worker 不再直接持有 `chokidar` 实例作为权威。实现可以是：

- `chimera-core` 内的 FS backend（Rust `notify` 或平台原生接口）；或
- 受 host 监督的独立 watcher 子进程，通过同一 change-stream 契约上报。

二者对上层是同一个接口，H2 不把“必须用 Rust inotify”作为验收条件；验收的是 change stream 的语义。

**change stream 契约**：

```text
graph.changed {
  workspace_id, project_id,
  paths: [...], kind: "add"|"change"|"unlink"|"rename",
  stream_seq, stream_epoch
}
```

- `stream_seq` / `stream_epoch` 是 **graph 专用**序号，不是 `host_event.seq`、不是 `transport_sequence`、不是 `command_sequence`。
- change stream 是 **transient**：允许丢弃与 gap；gap 用 `graph.change-gap` 标记，客户端/同步器必须做一次全量 reconcile。
- graph DB 本身是事实源；change stream 不落 `host_event`。

**忽略规则**：`.chimera/`、`.codegraph/`、`.git` 内部对象、临时文件；沿用现有 watcher 的 `ignored` 语义（`src/graph/sync/watcher.ts`）。

**背压**：按路径合并（同一路径的连续 change 只保留最后状态）；有界队列（candidate default 4096 条 / 8 MiB）；溢出丢最旧并置 gap。

**capability**：`graph.watch`。

**TS fallback**：Bun `FileWatcher`；`CHIMERA_HOST_PLANE_WATCH=legacy`。

**parity**：同一文件事件序列下，最终 graph 状态一致；ready gate 一致；忽略目录一致；gap 后 reconcile 收敛。不要求事件条数逐条相同（合并策略允许不同）。

**退出条件**：事件到最终状态收敛 100%；无静默丢事件（丢必须有 gap）；watcher 退出/重启不产生重复索引。

### 3.3 Step 3：SQLite/WAL、session/job durable state

这是 H2 的核心，单独在 §4 展开。本节只固定数据面契约：

- **capability**：`storage.write`。
- **TS fallback**：Bun 直连主库（当前路径）；`CHIMERA_HOST_PLANE_STORAGE=legacy`。
- **独立健康状态**：storage 面 `degraded` 时，host 仍可服务 graph/static/SSE 的只读部分；session 写路由回退 legacy 或 503。
- **单面失败**：主库打不开、schema 不匹配、WAL 不可写时，host 不退出；标记 `storage: unavailable`，不 spawn 依赖写的 worker，或让 worker 走 legacy 写路径。

### 3.4 Step 4：static asset cache

**所有权**：host 直接服务内嵌 WebUI 资源与 manifest；不再把静态资源请求代理给 worker。

**缓存策略**：

- 内容哈希命名的资源：`Cache-Control: public, max-age=31536000, immutable`。
- `index.html` / manifest：`no-cache` + ETag，保证升级后立即生效。
- 条件请求：`If-None-Match` → 304；`Content-Type`、`Content-Encoding` 与现有 Bun 路径逐字节/逐头一致。
- 总缓存上限（candidate default 64 MiB）、单资源上限（candidate default 8 MiB）、LRU；禁止把整个 WebUI 树无限读入内存。

**capability**：`static.serve`。

**TS fallback**：Bun 静态路由。

**parity**：字节相等、headers 相等、304 行为相等、缺失资源 404 体一致。

**退出条件**：资源字节 100% 相等；header parity 100%；p95 ≤ 105% baseline；缓存有界。

### 3.5 Step 5：SSE fan-out + event log

**所有权**：host 终止 `/event`、`/global/event`，维护连接、heartbeat、`Last-Event-ID`、`stream_epoch` 和 gap recovery；worker 只发布内部事件。

**事件分层**（沿用 `ipc-v0.md` §8.4）：

| 类别 | 落 `host_event` | 分配 `event_seq` | replay | 例子 |
|---|---|---|---|---|
| durable | 是 | 是 | 是（保留窗口内） | `message.updated`、`turn.started`、`permission.asked`、`job.updated` |
| transient | 否 | 否 | 否；gap 标记 | `message.part.delta`、`tool.progress`、`ipc.heartbeat` |
| control | 否 | 否 | 否 | `connected`、`heartbeat`、`gap`、`stream_reset` |

**fan-out**：每连接有界队列（candidate default 1024 槽，drop-oldest，沿用现有语义）；durable 事件永不因连接队列压力丢弃，只影响实时性，客户端用 `Last-Event-ID` 补发；慢客户端超过高水位（candidate default 10s 持续满）断开并让其重连补发。

**重放**：

- `Last-Event-ID` 只映射 `host_event.seq`。
- 保留窗口按行数/时间/字节三选一或组合（§10 待拍板），并记录 `retention_floor_seq`。
- 请求的 seq 小于 `retention_floor_seq` → `stream_reset` + 当前快照游标，不伪造连续。
- `stream_epoch` 在 host boot 或 event log 轮转时更换；旧 epoch 的重连必须 reset。

**capability**：`sse.fanout`。

**TS fallback**：Bun `global-event-stream`；`CHIMERA_HOST_PLANE_SSE=legacy`。

**parity**：事件名、字段形状、顺序、heartbeat 间隔、gap/reset 语义与旧路径一致；durable 事件在保留窗口内零丢失；重连后客户端状态与 DB 快照一致。

**退出条件**：durable loss = 0（窗口内）；replay convergence 100%；frame shape parity 100%；p95 ≤ 110% baseline。

### 3.6 Step 6：workspace/project control-plane

**所有权**：host 解析 workspace/project、注入 `directory`/`workspace` header、维护 workspace 注册表与 worker 绑定；`workspace` 表由 host 写（写者切换见 §4.4）。

**capability**：`workspace.control`。

**TS fallback**：`src/control-plane/workspace.ts` 的 Effect 服务；`CHIMERA_HOST_PLANE_WORKSPACE=legacy`。

**parity**：workspace 列表/创建/查询的 JSON、状态码、错误体一致；directory header 重写规则一致；未知 workspace 的 404 一致；project id 解析一致。

**边界**：workspace 缓存有界（candidate default 1024 项）；不得把整个项目树元数据常驻。

**退出条件**：响应 parity 100%；多 workspace 隔离测试通过；无跨 workspace 串写。

### 3.7 Step 7：process registry + worker policy

**所有权**：host 写 `chimera_process_registry`（项目库，跨库，不与主库同事务）；新增 `orphaned` 与 `adopted_by_boot_id` 语义；host 负责 adoption CAS 与 signal-0 sweep 的 pid 复用竞态。

**adoption 规则**：

- worker 退出后，其子进程可能仍存活：host 把对应行标 `orphaned`，不立即 kill。
- host 认领必须 CAS：`UPDATE ... WHERE status='orphaned' AND adopted_by_boot_id IS NULL`；成功才接管。
- signal-0 sweep 只用于确认存活；pid 复用必须用启动时间/boot id 二次校验，不能只看 pid。
- `readActiveProcesses` 的“读取顺手把死 pid 改 `expired`”副作用在 host 侧必须显式建模：它是一次带清理的读取，不是纯探针。

**worker policy**：host 执行 soft/hard RSS、max_age、max_sessions、max_requests 五个上限（H0 后配置化，逐项目可覆盖）；达到 soft 停止接新 turn，达到 hard 或无心跳则 drain → `SIGTERM` → `SIGKILL`；回收后记录 exit_reason、generation、未完成 request 和恢复动作。

**PTY ticket**：H2 建议 host 内存持有（60s TTL、单次消费、容量 10000，沿用现有常量）；只有多 host 共享需求成立时才落库（§10）。

**capability**：`process.registry`、`worker.policy`。

**TS fallback**：Bun registry + 现有 supervisor；`CHIMERA_HOST_PLANE_PROCESS=legacy`。

**parity**：状态迁移一致；`exited/killed` exactly-once；无“running 但 pid 已死”超过一个 sweep 周期；adoption 不双认领；PTY ticket 单次消费。

**退出条件**：C7 门（`recovery-matrix.md` §11.1）通过；orphan 数与回收原因可解释；24h soak 无进程表单调增长。

---

## 4. 共享 DB 所有权与写者切换

### 4.1 canonical 路径与启动契约

- `Database.Path`（`src/storage/db.ts`）是唯一权威：`OPENCODE_DB` → 绝对路径或 `Global.Path.data/<name>`；否则 `getChannelPath()`（`latest/beta/prod` → `chimera.db`，其他 channel → `chimera-<safe>.db`）。
- host bin **不得**从 `<data-root>` 推导主库路径。H2 启动器（TS）计算 canonical 路径，并显式传 `--db <path>`（或 `CHIMERA_HOST_DB`，`--db` 优先）。
- H2 的 `rust`/`proxy` 模式下，缺少 `--db` 视为 `host_db_unresolved`，回退 legacy；**不得**创建 `<data-root>/host/host.db`。该候选路径只保留给隔离测试。
- `--db` 与 socket、nonce 一起由启动器传给 host；host 不读 XDG/channel 规则。

### 4.2 迁移所有权与 preflight

- **TS Drizzle 仍是唯一 migrator。** host 永远不执行 migration、不建表、不改列（`HostStore::open` 已明确“never migrates”，H2 保持）。
- 启动顺序：TS 完成 `Database.applyMigrations` → 启动 host → host 打开主库 → host preflight → spawn worker。
- host preflight 检查：
  1. Drizzle 迁移记录表（`__drizzle_migrations`）存在且最新时间戳 ≥ host 编译期期望；
  2. `host_state.schema_version` 与期望一致；
  3. `host_state.host_generation` 不小于上次已知值（回退即 fail closed）；
  4. WAL 文件存在且可写。
- preflight 失败：`storage` 面 `unavailable`，host 不 spawn 依赖写的 worker；HTTP 仍可启动并报告 `degraded`，不整体退出。
- worker handshake 必须报告 `schema_version`；不匹配拒绝启动该 worker。
- 无 down migration；回退靠开关 + 旧二进制兼容读。

### 4.3 WAL 双进程并发模型

SQLite WAL 允许“多读者 + 单写者”，但不提供业务级串行化。H2 的模型：

| 约束 | 设计 |
|---|---|
| 写者 | 任一表任一时刻只有一个写者；由表所有权注册表 + 启动断言保证，不依赖 SQLite |
| 写事务 | host 用 `BEGIN IMMEDIATE`；不在事务里包 provider 流、工具执行或长扫描 |
| busy | `busy_timeout=5000`（沿用）；仍 `SQLITE_BUSY` 时有界重试（candidate default 5 次，2/4/8/16/32ms 退避），最终返回 `storage_busy`，不静默丢写 |
| checkpoint | 同一时刻只有一个 checkpoint owner：`legacy` 模式 TS 拥有 5 分钟 PASSIVE 定时器；`proxy`/`rust` 模式 host 拥有，TS 关闭自己的定时器 |
| checkpoint 类型 | 只用 `PASSIVE`；禁止在另一进程仍有读者时 `TRUNCATE` |
| WAL 上限 | 两个进程都设置 `journal_size_limit=64MB`；host 监控 `-wal` 大小，超过阈值（candidate default 256MB）强制一次 PASSIVE checkpoint 并记录告警 |
| 读一致性 | 读路径不缓存跨事务快照；writer flip 期间禁止旧读缓存继续返回已翻转表 |

`journal_size_limit` 在 `HostStore::open` 中补上，与 TS 侧对齐；否则 host 连接会让 WAL 高水位不回落。

### 4.4 写者切换顺序

按“影响面从小到大、fencing 优先”排序：

| 序 | 表 | 切换前必须完成 | 回退 |
|---:|---|---|---|
| 0 | `host_worker` / `host_state` / `session_turn_checkpoint` / `pending_request` / `host_event` / `request_idempotency` | H1 已由 host 写 | 关闭 host 写，旧路径忽略这些表 |
| 1 | `session_turn_lease` | 增加 `turn_id` / `worker_generation` / `renewed_at`；host 接管 acquire/release CAS | Bun 重新接管 lease |
| 2 | `background_job` | 增加 `owner_worker_id` / `worker_generation` / `recovery_state` / `cancel_requested_at` / `request_id`；host 接管 open-time reconcile | Bun write-through 恢复 |
| 3 | `workspace` | workspace control-plane parity 通过 | Bun control-plane 恢复 |
| 4 | `session` | session metadata 读写 parity；checkpoint 与 session 同事务 | Bun 恢复写 |
| 5 | `session_message` | v2 投影 parity | Bun 恢复写 |
| 6 | `message` | 消息提交与 checkpoint/event 同事务 | Bun 恢复写 |
| 7 | `part` | `part_watermark` 生效；part reconcile 由 host 承担 | Bun `part-reconcile` 恢复 |
| 8 | `permission.data` | approved ruleset 读写 parity | Bun 恢复写 |

不切换：`event` / `event_sequence`（实验 flag，继续由 Bun/实验路径维护；host 用 `host_event` 做 durable log）；`chimera_process_registry` 属项目库，按 §3.7 单独切换。

每张表翻转前必须同时满足：

1. shadow 对账窗口内零差异（§4.5）；
2. 该表的读路径已在 host 上运行至少一个发布周期；
3. 故障注入矩阵（`recovery-matrix.md` §10.2 的相关项）通过；
4. 回退演练通过：关闭该表开关后 Bun 能读到完整数据并继续写。

### 4.5 shadow 对账与 `commit.confirm` 落地顺序

**不做物理双写。** “proxy 模式双写”统一实现为：

```text
旧写者：commit 真实行
新写者：计算同一逻辑写入 -> 记录 shadow 指纹 (table, pk, hash, generation)
对账器：周期性比较 shadow 指纹与真实行
```

- shadow 记录放内存有界环形缓冲或 `host_write_shadow`（若需要跨重启对账）；不作为事实源。
- 对账窗口（candidate default：10k 次写或 24h，先到者）内差异必须为 0，才允许 `writer flip`。
- 差异分类：字段缺失、值不同、行缺失、重复行；任何一类非零都阻止 flip，并输出具体 pk。
- flip 后旧写者转只读；不允许“旧写者继续写、host 也写”的过渡态。

**`commit.confirm` 落地顺序**（H1 的补偿协议，`recovery-matrix.md` §5.1.2）：

1. 先补 schema：`part_watermark`、`commit_state`、`commit_token`（`commit_state` 已存在，写入流程未实现）。
2. worker 在本地事务提交 message/part 后发送 `commit.confirm(turn_id, turn_generation, worker_generation, commit_token, last_message_id, part_watermark)`。
3. host 在**一个 host 事务**内：锁 checkpoint → 校验 generation → 只读校验 message/part 行存在且属于该 turn → 写 `commit_state=confirmed` + `status=completed` → 插入 `host_event(dedupe_key=turn:<id>:completed)` → ack。
4. 未确认崩溃：checkpoint 保持 `committed_unconfirmed`；恢复时若行完整则 `completed(recovered_confirmation)`，否则 `interrupted`；绝不重放副作用。
5. 当某张表 flip 到 host 后，该表的提交与 checkpoint/event 在同一 SQLite 事务内完成，`commit.confirm` 对该表退化为内部函数调用；未 flip 的表继续走补偿协议。
6. `commit.confirm` 的幂等键是 `commit_token`；同一 token 重发返回同一 ack，不重复插事件、不重复推进 seq。

### 4.6 kill switch 粒度

现有（H1 已解析，未 gate 行为）：

| 开关 | 取值 | 默认 |
|---|---|---|
| `CHIMERA_HOST_MODE` | `legacy` / `proxy` / `rust` | `legacy` |
| `CHIMERA_HOST_IPC` | `off` / `observe` / `enforce` | `off` |

H2 增加两层，优先级 **route > plane > mode**：

| 开关 | 取值 | 作用 |
|---|---|---|
| `CHIMERA_HOST_PLANE_<PLANE>` | `legacy` / `shadow` / `enforce` / `off` | 单数据面粒度；`PLANE` ∈ `GRAPH`、`WATCH`、`STORAGE`、`STATIC`、`SSE`、`WORKSPACE`、`PROCESS` |
| `CHIMERA_HOST_ROUTE_<OPERATION>` | `legacy` / `proxy` / `rust` | 单 OpenAPI operation 粒度；`OPERATION` 为 operation id 的大写 snake（非字母数字 → `_`） |

行为：

- `legacy`：完全走进程内旧路径，host 不参与该面。
- `shadow`/`proxy`：host 计算并记录，但旧路径仍是权威；只用于对账，不返回 host 结果。
- `enforce`/`rust`：host 是权威；旧路径只读或关闭。
- `off`：该面在 host 内不初始化；路由直接走 legacy。
- 未识别的开关值：启动时 `unknown_kill_switch` 拒绝该面，不猜默认。
- **重载**：route/plane 级开关必须能在不重启 host 的情况下生效。H2 设计为 host 每 tick 读取 `host_state` 中的 `config_revision`/开关快照（candidate default 轮询 1s），或通过控制 socket 的 `host.reload_kill_switches` 请求；进程级 `CHIMERA_HOST_MODE` 允许要求重启。
- **单面失败**：每个面初始化结果写入 `PlaneHealth { plane, state: ready|degraded|unavailable, reason }`；`/health` 与 `/capability` 暴露；一个面 `unavailable` 不改变 host 的 `ready`，也不阻止其他面。
- 任何开关都不得把未知协议消息“猜”成兼容消息。

### 4.7 回退

- 回退 = 关闭对应 plane/route 开关，恢复 Bun 直连；不提供 down migration。
- 回退后旧路径不得依赖新表；若某表已 writer flip，回退前必须确认旧路径能读到完整数据（新表只是附加，不是唯一来源）。
- `host_generation` 一旦前进，旧二进制不得写回更小值；回退后的新 host 启动继续递增。
- 回退演练必须覆盖：已有新表、WAL 未 checkpoint、旧 worker 仍持有 lease、SSE 客户端带 `Last-Event-ID`、`commit_state=committed_unconfirmed` 的 checkpoint。

---

## 5. wasm fallback 退役

### 5.1 现状与拍板

- kernel 覆盖 20 语言；`objc`、`pascal`、`nix` 没有 kernel arm，仍由 wasm/TS 提取器处理。
- kernel 的 `defer:` 安全阀仍把 parse-error/栈保护文件送回 wasm；c/cpp 的 defer 是设计内行为。
- 用户 2026-10-22 拍板：三语言迁入 kernel，随后删除 wasm 提取路径。

### 5.2 三语言 kernel 落地

对每个语言：

1. 在 `codegraph-kernel/src/langs.rs` 增加 grammar 条目（vendored C 或 crate，revision 必须与 vendored wasm 对齐；`kernel-grammar-parity` 测试约束）。
2. 增加 walker 模块（参照 `tsjs/`、`go.rs` 等），输出节点/边/ref 行。
3. 在 `src/graph/extraction/kernel/index.ts` 加入 routing（先不默认）。
4. 用现有 wasm extractor 作为 oracle 跑 parity：`script/kernel-parity.ts` 增加三个语言 leg，fixture corpus + in-repo sweep 双跑。
5. parity 通过后加入 `DEFAULT_ROUTED`，保留 wasm arm 至少一个发布周期。

三语言的具体 walker 可行性、grammar revision 与 corpus 细节由并行 scout 补充；本文只固定顺序与门。

### 5.3 退役顺序

| 阶段 | 动作 | 门 |
|---:|---|---|
| R1 | 三语言 kernel arm 落地，routing 默认关闭 | 单测 + contractInfo 报告三语言 |
| R2 | parity gate 接入 CI（kernel-prebuild + parity job） | 三语言 zero-diff（或经批准的语义等价） |
| R3 | 加入 `DEFAULT_ROUTED`，wasm arm 保留 | 一个发布周期 soak；无新增 defer/error |
| R4 | 消除 defer 依赖：kernel 侧实现 parse-error 恢复，或把 defer 显式降级为“该文件无图节点”并计数 | `DEFER_ELIGIBLE_LANGUAGES` 为空，或 defer 率在批准阈值内 |
| R5 | 删除三语言 wasm extractor 与 grammar | 无 routing 引用；bundle 中无对应 `.wasm` |
| R6 | 删除通用 wasm 提取路径 | 所有 20+3 语言有 kernel arm；所有支持平台有 prebuild；graph 缺 kernel 时显式无图 |

R4 是硬前置：只要 kernel 仍把 parse-error 文件 defer 给 wasm，删除 wasm 就会让这些文件静默失去图节点。可接受的两条路：

- **A（推荐）**：kernel 内实现与 wasm 等价（或经批准更优）的错误恢复；`defer` 只保留为遥测，不再跨运行时。
- **B**：明确接受“defer 文件无图节点”，但必须计入 parity 报告、在 `graph status` 暴露，并且不得把不完整图当作 current。

### 5.4 缺 prebuild 平台的降级语义

wasm 退役后，缺失 kernel prebuild 的平台从“wasm 图”退化为“无图”：

- loader 返回 null → `kernelSupports()` false。
- 该平台的 graph 面 `unavailable`；`chimera graph init/index/sync` 返回结构化 `kernel_unavailable`，不创建半成品图。
- 已有 graph DB 可只读查询，但标记 `stale`/`extraction: disabled`；不得把旧图冒充当前图。
- `chimera web` 仍可启动；graph 路由返回 503/降级状态，不影响 session/SSE/static。
- 这是有意的产品取舍：宁可无图，也不维护一条与 kernel 长期分叉的 wasm 提取路径。

### 5.5 parity gate 接线

- 复用 `script/kernel-parity.ts`；新增三语言 leg 与 corpus 清单。
- CI：`kernel-prebuild` 产出 → parity job 跑全语言 → 失败阻止 `DEFAULT_ROUTED` 变更（不阻止无关发布）。
- parity 结果落 `cbench/kernel-parity/*.json`，带 kernel build hash、grammar revision、corpus 指纹；host/graph 启动不依赖该文件，但 release 检查依赖。
- 删除 wasm 前，parity 报告必须显示三语言零差异（或经批准的语义等价）且 defer 依赖已消除。

### 5.6 风险

- 三语言 walker 工作量大、corpus 小，容易“fixture 绿、真实仓库红”；必须用 in-repo sweep 与多仓库 corpus。
- `objc` 的 `.h` 歧义展开（#1628）需要单独验证，不能只测 `.m`。
- 删除 wasm 会让不支持平台永久无图；发布矩阵必须提前确认 6 个 leg 全部有 host+kernel prebuild。
- wasm 退役与 AOT（§9）正交：AOT 不会让 wasm 重新可用，也不改变 kernel 的 native 路径。

---

## 6. npm 打包接线

### 6.1 现状

- `publish.yml` 的 `host-prebuild` 已产出 `chimera-host/prebuilds/<platform>/chimera-host`，但明确“not packaged into npm tarballs yet”。
- `build.ts` 只有 `copyKernelPrebuild`，没有 host 复制。
- `postinstall.mjs` 只探测 kernel。
- 没有 TS 启动器。

### 6.2 build-cli：`copyHostPrebuild`

在 `script/build.ts` 增加与 `copyKernelPrebuild` 对称的函数：

```text
copyHostPrebuild(targetBinDir, target):
  platformDir = kernelPrebuildPlatformDir(target)   // 复用同一 (os, arch, abi) 轴
  source = <repo>/chimera-host/prebuilds/<platformDir>/chimera-host
  if missing: warn "host: no prebuild for <platform> — shipping without host; legacy mode applies"; return
  copy -> <targetBinDir>/host/chimera-host
  chmod 0755
```

- 缺失 prebuild 是 **warning，不是 build failure**：host 是可选加速器，缺失时该平台永远走 legacy。
- 与 kernel 一样，CI 在 build-cli 前下载 `host-prebuild-*` artifact 到 `chimera-host/prebuilds/`。
- `build-host.sh` 的 6 个 leg 与 `kernelPrebuildPlatformDir` 的命名必须保持同一套（`darwin-arm64`、`linux-x64-musl` 等）；package-variant 的单测作为 drift guard。

### 6.3 package-variant

- 平台包 `files: ["bin", ...]` 已覆盖 `bin/host/`；不需要新包。
- 可选方案是独立 `@coding-chimera/chimera-host-<platform>` 包；H2 不采用，避免发布矩阵膨胀（主计划 §8 风险表）。
- `os`/`cpu`/`libc` 字段沿用现有平台包；Windows 无 host 产物，安装后走 legacy。

### 6.4 postinstall

- 增加 host 探测，与 kernel 探测并列，**warn-only**：
  - 查找 `bin/host/chimera-host`（主包或平台包）；
  - 检查文件存在、可执行、大小 > 0；
  - 可选执行 `chimera-host --version`/`--probe`（短超时，candidate default 2s），失败只告警；
  - 不启动长驻进程、不创建数据目录。
- 输出明确：“Chimera host: native binary present / missing — legacy mode will be used”。

### 6.5 loader / launcher

新增 `packages/chimera/src/host/launcher.ts`（H2）：

```text
resolveHostBinary():
  1. CHIMERA_HOST_BIN（显式覆盖）
  2. <dir of process.execPath>/host/chimera-host   // 发布产物
  3. <repo>/chimera-host/prebuilds/<platform>/chimera-host  // dev
spawn(args):
  --db <canonical Database.Path>
  <data-root>
  --worker ... --worker-cmd ...
  env: CHIMERA_HOST_SOCKET, CHIMERA_WORKER_NONCE
```

- 找不到二进制：
  - `CHIMERA_HOST_MODE=legacy`：正常 legacy；
  - `proxy`/`rust`：不崩溃，记录 `host_unavailable`，降级 legacy；若用户显式要求 `rust` 且不允许回退，返回启动错误。
- host 启动失败（preflight/schema/socket）：同样按面降级，不把整个 CLI 拖死。
- launcher 不复制 host 逻辑（路径解析、migration、DB）到 Rust；只传参。

### 6.6 降级矩阵

| 条件 | legacy | proxy | rust |
|---|---|---|---|
| 无 host 二进制 | 正常 | 降级 legacy + 告警 | 启动错误或显式降级 |
| host 启动失败 | 正常 | 降级 legacy | 启动错误 |
| schema 不匹配 | 正常 | 降级 legacy | 启动错误 |
| 单面初始化失败 | 正常 | 该面 legacy，其他面 proxy | 该面 503/legacy，host ready |
| kernel prebuild 缺失 | graph 无图/只读旧图 | 同左 | 同左 |

---

## 7. H1 遗留缺口进 H2 排期

来源：`ipc-v0.md` §17/§18 与 `recovery-matrix.md` §7/§14 的未完成项。编号沿用本文，便于排期。

| # | 缺口 | H2 步骤 | 阻塞级别 | 验收 |
|---:|---|---|---|---|
| G1 | cancel 的 worker 侧执行（软/硬超时） | Step 0 / Step 3 | 高 | worker 停止目标工作、返回 `cancelled`/`turn.interrupted`；5s/30s 超时（candidate default）后 host 终止 |
| G2 | Rust 握手读超时 | Step 0 | 高 | 10s（candidate default）无 hello → `handshake_timeout` |
| G3 | peer credentials（`SO_PEERCRED`/`LOCAL_PEERCRED`） | Step 0 | 中 | uid 不一致 → `unauthorized`；仅依赖目录权限的现状关闭 |
| G4 | body 交叉校验（`request.id` vs `correlation_id`、body `transport_sequence` vs header `sequence`） | Step 0 | 高 | 不一致 → `bad_header`/`validation_error`，双臂一致 |
| G5 | command replay（`host_command_replay` 表 + 分配器 + 重发） | Step 0 / Step 3 | 中 | 重连从 `last_acked_command_sequence` 补发；窗口外 `replay_unavailable` |
| G6 | `host_state.next_event_seq` 接入 | Step 3 | 低 | 与 `MAX(seq)+1` 二选一；崩溃后不回退（§10） |
| G7 | §8.7 扩列（`owner_worker_id`/`worker_generation`/`recovery_state`/`cancel_requested_at`） | Step 3 | 高 | `background_job`/lease 扩列落地；drift-guard |
| G8 | `part_watermark` 列 | Step 3 | 高 | `commit.confirm` 可用；完成判定可测试 |
| G9 | `host_event.durability` 列 | Step 5 | 中 | 只允许 durable 落表；control/transient 不落；取值集合统一 |
| G10 | 未知顶层字段严格拒绝 | Step 0 | 中 | 双臂 `validation_error`；`ext`/`x-` 例外 |
| G11 | canonical JSON 双臂统一（TS 侧 canonical 编码器） | Step 0 | 中 | key 排序、浮点、长度/深度限制双臂一致；golden vectors 扩展 |
| G12 | 路由级 kill switch | Step 0（全平面） | 高 | `CHIMERA_HOST_ROUTE_<OPERATION>` 生效、可热重载 |
| G13 | msgpack 数据面 | 不排期 | 决策 | 见 §10；推荐 H2 不做 |
| G14 | host 重启 sweep | Step 3 | 高 | 启动扫描非终态行，按 cancel/commit/resume_policy 收敛 |
| G15 | PTY ticket 落库 | Step 7 | 低 | 多 host 需求成立才做；否则 host 内存 |
| G16 | SSE 重放游标 | Step 5 | 高 | `Last-Event-ID` → `event_seq`；窗口外 `stream_reset` |

排期原则：

- Step 0 必须收口 G1–G4、G10–G12，否则后续面的 parity 没有可信的协议底座。
- Step 3 必须收口 G5–G8、G14，否则写者切换无法证明“不丢已提交事实”。
- Step 5 必须收口 G9、G16，否则 SSE parity 只是形状一致，不保证可恢复。
- G13 默认不做；G15 默认不做（host 内存）。

---

## 8. H2 验收门

### 8.1 每数据面的 parity 判据（判据数值均为 candidate default）

| 面 | 读路径判据 | 写路径判据 |
|---|---|---|
| graph | fixture corpus 上 query/traversal 结果 canonical 后 100% 相等；随机 corpus ≥ 99.99% | index/sync 输出与旧路径语义一致；无重复节点/边 |
| watcher | 文件事件序列 → 最终 graph 状态 100% 收敛 | 无静默丢事件；gap 必须可见并可 reconcile |
| storage | 已提交行读取 100% 相等 | shadow 对账窗口内 0 差异；故障注入 0 重复副作用 |
| static | 资源字节 100% 相等；header 100% 相等 | 不适用 |
| SSE | durable 事件在保留窗口内 0 丢失；replay 100% 收敛 | 事件顺序与 `event_seq` 一致；无重复分配 |
| workspace | JSON/状态码/错误体 100% 相等 | workspace 行 shadow 0 差异 |
| process | 状态迁移一致；无 false orphan | `exited/killed` exactly-once；adoption 0 双认领 |

“100%”指在固定 corpus/fixture 上；随机 corpus 的 99.99% 必须附差异分类与批准记录，不允许用平均值掩盖单语言/单路由回归。

### 8.2 性能门槛（candidate default）

| 门 | 指标 | candidate default |
|---|---|---|
| P1 | 单面 p95 延迟劣化 | ≤ 10% vs Bun-only baseline |
| P2 | 单面吞吐 | ≥ 90% baseline |
| P3 | graph query p95 | ≤ 110% baseline |
| P4 | graph index 吞吐 | ≥ 95% baseline |
| P5 | SSE fan-out p95（64 连接） | ≤ 110% baseline；无队列持续满 |
| P6 | DB 写 p95（checkpoint/commit） | ≤ 20ms；`SQLITE_BUSY` < 0.1% |
| P7 | IPC 附加延迟 | 控制帧 p95 ≤ 10ms |
| P8 | 事件吞吐 | `host_event` 写入 ≥ 5k events/s（单库、批量事务） |
| P9 | replay | 10k durable events ≤ 2s |
| P10 | worker 回收 | drain 到进程退出 ≤ 10s（无长工具时） |

所有数字必须用同一场景、同一采样口径与 Bun baseline 对比；不得用混合平均数掩盖单面回归。

### 8.3 内存验收（引用 H1 基线）

H1 实测（`/Volumes/workspace/cbench/h1-mem`，darwin/arm64，2026-10-22）：

| 配置 | procs | host RSS | worker RSS | tree RSS | footprint |
|---|---:|---:|---:|---:|---:|
| host+worker（20s，35 样本） | 2 | 1.3 MB | 146.5 MB | 146.7–147.8 MB（flat） | 351 MB |
| bare `bun -e` idle | 1 | — | — | 58.6 MB peak | — |

H2 门（candidate default）：

| 门 | 判据 |
|---|---|
| M1 | 空闲 host RSS ≤ 10 MB；不 spawn worker |
| M2 | 1 worker 的空闲 tree ≤ 160 MB（H1 147 MB + 余量） |
| M3 | worker 退出后其地址空间不再计入 tree；host 不吸收等量增长 |
| M4 | 24h soak tree 增长 ≤ 5% 或 ≤ 10 MB，且无单调趋势 |
| M5 | 每个面的 cache/队列/event log 有显式上限；72h 不出现按 session/时间单调增长 |
| M6 | 8 路并发峰值可回落；worker churn 有上限 |

### 8.4 单面失败隔离门

对每个 plane 注入初始化失败（缺二进制/缺 prebuild/schema 错/DB 打不开/capability 未协商）：

- host 在 2s（candidate default）内进入 `ready`；
- `/health` 报告该面 `degraded`/`unavailable` 与 reason；
- 其他面 parity 仍通过；
- 该面路由按 kill switch 回退 legacy 或返回 503；
- 无 crash loop、无反复 spawn。

### 8.5 Soak 场景

沿用 `recovery-matrix.md` §11.4 并增加 H2 面：

1. 空闲 host 24h（无 worker/SSE/请求）；
2. 单项目 8 路 session 24h（turn/permission/question/cancel/SSE 重连）；
3. 多项目（≥3）24h（workspace 隔离、process registry 跨项目）；
4. 故障注入 72h（每小时 kill worker，每 6h kill host）；
5. 升级/回退演练（H2 → legacy → H2）；
6. 保留策略压力（event/checkpoint/change stream 裁剪）；
7. commit confirmation 压力（提交与确认之间随机崩溃）；
8. graph 全量索引 + watcher 并发（3 语言退役后）。

---

## 9. AOT 观测注记

Bun PR #45631（AOT 机器码）在跟踪中，尚未采用。对 H2 的含义：

- **预期收益在 worker 侧**：减少 JSC 启动/JIT warmup，可能降低短生命周期 worker 的 CPU 与冷启动延迟；对长驻 host 无直接影响（host 是 Rust）。
- **采用前提**：类型审计（无 eval/动态代码、无依赖 JIT 热路径的插件）、Bun 版本与 ABI 稳定、插件/工具链兼容性验证、cold start/RSS 前后对比。
- **与 wasm 退役正交**：AOT 不会让 wasm 提取路径重新可用，也不改变 kernel 的 native 执行；两者不要互相作为前置。
- H2 只记录基线（worker cold start、首 token 延迟、RSS），不在 H2 切换 AOT；是否采用留到 H6 终态决策。

---

## 10. H2 开工前待拍板

从 `ipc-v0.md` §18 与 `recovery-matrix.md` §14 收敛；每条给出实现侧现状与推荐。未拍板时按“现状”运行。

### 10.1 协议与编码

| # | 议题 | 实现侧现状（一句话） | 推荐 |
|---:|---|---|---|
| D1 | 控制面/数据面编码 | 控制面 JSON；数据面只有 `json`；`encoding.msgpack` 可协商但无编解码器 | H2 保持 JSON；msgpack 不排期（G13），除非 profiling 证明序列化是主瓶颈 |
| D2 | 未知顶层字段 | 双臂都忽略，不返回 `validation_error` | 严格拒绝；扩展只走 `ext`/`x-` |
| D3 | canonical JSON | Rust 侧按 key 排序；TS 侧 `JSON.stringify`，无 canonical 编码器 | TS 补 canonical 编码器；golden vectors 扩到控制面 |
| D4 | `host_event.durability` | 无该列；control/transient 不落表 | 加列，取值 `durable` 为唯一落表值；control/transient 永不落表 |
| D5 | 三层序号 | `transport_sequence`/`event_seq` 已实现；`command_sequence` 未实现 | 保持三层互不推算；command replay 按 §7 G5 补 |

### 10.2 存储与 schema

| # | 议题 | 实现侧现状（一句话） | 推荐 |
|---:|---|---|---|
| D6 | host 用主库还是独立库 | 主库有 host 控制表；bin 默认仍可能落到 `<data-root>/host/host.db` | H2 统一主库；`--db` 必传，缺省回退 legacy |
| D7 | `session_turn_checkpoint.intent` 边界 | `TEXT NOT NULL`，store 当不透明 JSON，无大小校验 | 只存引用 + 有界摘要（candidate default ≤ 16 KiB）；不存完整历史 |
| D8 | `pending_request` 重启语义 | 无 host 重启 sweep，行按原状态保留 | recoverable turn → 同 `request_id` + `generation+1` 重发；否则 `orphaned` |
| D9 | `host_event` 保留窗口 | 无裁剪任务，只增不减 | 时间 + 行数 + 字节组合窗口；记录 `retention_floor_seq`；窗口外 `stream_reset` |
| D10 | `commit.confirm` 完成判据 | 无实现；只有 `last_message_id`/`last_event_seq` | assistant 终态 part + `part_watermark`；超时（candidate default 30s）转 `interrupted` |
| D11 | 旧 worker 迟到 session 行 | 无隔离/隐藏逻辑 | 按 `turn_id` 隔离为历史；不隐藏、不改变当前终态 |
| D12 | `background_job` 是否加 `interrupted` 状态 | 保持 4 状态，无 `recovery_state` | 保持 4 状态 + `recovery_state`；不重命名 |
| D13 | 跨库一致性 | host 只打开主库，不访问项目库 | 接受“补偿 + 只读代理”；不引入分布式事务 |
| D14 | `request_idempotency` TTL | `expires_at` 由调用方写，无清理任务 | 24h；与 SDK 重试窗口对齐；加清理任务 |
| D15 | `next_event_seq` 计数器 | 列存在但未用；`append_event` 用 `MAX(seq)+1` | 保持事务内 `MAX(seq)+1`；计数器仅诊断，或删除 |
| D16 | `request_key` / `ask_seq` | 由调用方提供，无生成器 | host 在同 turn 内分配 `ask_seq`；republish 不变 |
| D17 | `aggregate_seq` | 可空，部分唯一索引仅非 NULL 生效 | session/job aggregate 必填；host 内部 aggregate 可空 |
| D18 | `dedupe_key` payload 冲突 | 命中已有 key 直接返回已有行，不比较 payload | 返回已有行 + 记录冲突诊断；仅幂等键冲突返回 409 |
| D19 | `owner_session_id` 双写漂移 | 未加列；仍读 `data` JSON | 加类型化列 + drift-guard 测试 |
| D20 | `committed_unconfirmed` 超时预算 | 未实现 | 统一走 `resume_policy` + 超时（candidate default 60s） |

### 10.3 迁移、发布与产品语义

| # | 议题 | 实现侧现状（一句话） | 推荐 |
|---:|---|---|---|
| D21 | worker 粒度 | 每 workspace 一个 worker；soft/hard 只解析不强制 | workspace 绑定 + 硬上限；soak 后再调 |
| D22 | 写者切换顺序 | 只切了 host 控制表 | lease → job → workspace → session → session_message → message → part → permission |
| D23 | proxy “双写”含义 | 无 shadow 对账 | 只做 shadow 计算 + 对账；禁止物理双写 |
| D24 | 非阻塞 serve 方案 | 阻塞 read loop；bin 不驱动 serve_round | 读超时 + bounded `serve_available`（方案 A） |
| D25 | route 级 kill switch | 只有进程级 mode/ipc，route 未实现 | `CHIMERA_HOST_ROUTE_<OPERATION>` + plane 级；route > plane > mode |
| D26 | host 二进制发布 | CI 产出 artifact，未进 npm；无启动器 | 复用平台包 `bin/host/`；不新增独立包 |
| D27 | wasm 退役的 defer 前置 | kernel 仍把 parse-error 文件 defer 给 wasm | 先消除 defer 依赖（kernel 恢复或显式无图），再删 wasm |
| D28 | PTY ticket | host 未实现；Bun 内存 60s TTL | H2 host 内存；多 host 需求成立才落库 |
| D29 | cancel 的对外呈现 | host 发 cancel；worker 不执行 | 终态 `cancelled`；保留现有 `session.error`/interrupted 语义，不新增对外错误类型 |
| D30 | H1 §0.4 五项 delta | 实现已按 delta 落地，主计划正文未回写 | 追认并回写主计划，避免三处漂移 |

---

## 附录 A：数据面 capability / kill switch 矩阵

| 面 | capability | plane 开关 | 主要 fallback | 关键上限（candidate default） |
|---|---|---|---|---|
| graph | `graph.read` / `graph.write` | `CHIMERA_HOST_PLANE_GRAPH` | 进程内 CodeGraph + NAPI | query 10k 行 / traversal 50k 节点 / 32 MiB |
| watcher | `graph.watch` | `CHIMERA_HOST_PLANE_WATCH` | Bun chokidar | 4096 条 / 8 MiB |
| storage | `storage.write` | `CHIMERA_HOST_PLANE_STORAGE` | Bun 直连主库 | busy 5 次退避 / WAL 256 MB 告警 |
| static | `static.serve` | `CHIMERA_HOST_PLANE_STATIC` | Bun 静态路由 | 64 MiB 总 / 8 MiB 单资源 |
| SSE | `sse.fanout` | `CHIMERA_HOST_PLANE_SSE` | Bun global-event-stream | 1024 槽/连接；慢客户端 10s |
| workspace | `workspace.control` | `CHIMERA_HOST_PLANE_WORKSPACE` | Bun control-plane | 1024 项缓存 |
| process | `process.registry` / `worker.policy` | `CHIMERA_HOST_PLANE_PROCESS` | Bun registry + supervisor | soft 8 / hard 16 worker（candidate） |

## 附录 B：证据锚点

| 主题 | 文件 |
|---|---|
| 阻塞 serve / 帧读取 | `chimera-host/src/host_driver.rs:1085-1162`、`chimera-host/src/connection.rs:268-281` |
| accept 设置阻塞 | `chimera-host/src/host.rs:534-540` |
| bin 不驱动 serve_round | `chimera-host/src/bin/chimera-host.rs:310-315` |
| commit-before-ack | `chimera-host/src/host.rs:661-724` |
| host 候选库默认 | `chimera-host/src/bin/chimera-host.rs:176-180` |
| 主库 canonical 路径 / WAL | `packages/chimera/src/storage/db.ts`（`getChannelPath`、`Path`、WAL 常量） |
| host store 不迁移 | `chimera-host/src/store.rs:16`、`:348-366` |
| kernel 语言表 | `codegraph-kernel/src/langs.rs:39-86` |
| kernel routing / defer | `packages/chimera/src/graph/extraction/kernel/index.ts:164-200`、`:282-320` |
| watcher | `packages/chimera/src/graph/sync/watcher.ts` |
| graph query/traversal | `packages/chimera/src/graph/graph/queries.ts`、`traversal.ts` |
| SSE | `packages/chimera/src/server/global-event-stream.ts`、`src/server/routes/instance/event.ts` |
| workspace | `packages/chimera/src/control-plane/workspace.ts`、`workspace.sql.ts` |
| process registry | `packages/chimera/src/chimera/process-registry.ts`、`store.ts` |
| kernel prebuild 复制 | `packages/chimera/script/build.ts:96-131` |
| host prebuild CI | `.github/workflows/publish.yml:173-260` |
| host 构建 staging | `packages/chimera/script/build-host.sh` |
| kernel loader | `packages/chimera/src/graph/extraction/kernel/loader.ts:100-190` |
| postinstall 探测 | `packages/chimera/script/postinstall.mjs:14-95` |
| H1 内存基线 | `/Volumes/workspace/cbench/h1-mem/README.md` |
| H1 协议/恢复契约 | `packages/chimera/specs/rust-host/ipc-v0.md`、`recovery-matrix.md` |