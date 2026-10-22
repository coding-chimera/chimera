# Rust host ↔ Bun worker IPC schema v0

状态：**H1 已落地（implemented）**。协议稳定面——64 字节帧编解码、握手与能力协商、连接层、supervisor、host driver、runtime、host bin、bun-worker 入口——已在 `chimera-host/src/` 与 `packages/chimera/src/host/` 实现，并有 Rust/TS 双臂单测、23 条共享 golden vectors、跨语言 e2e 与 CI 腿。三处仍在并行接线的项标记为 **Status: landing**：§2.3 心跳、§5.5/§8.2 durable event commit-before-ack、§9.3 drain deadline 单一事实源。
服务对象：`RUST_HOST_MIGRATION_PLAN.md` 的 H1（Rust supervisor + front door）。
性质：H1 实现契约与状态记录。已落地小节按实现回写；未落地小节保留 proposed 措辞并显式标注。文中数值仍是 candidate default，不是已批准的最终容量或性能承诺。

## 0. 范围与非目标

### 0.1 本设计要解决的问题

H1 需要 Rust host 成为唯一长驻父进程，并把尚未迁移的 HTTP 路由、session runtime、provider、plugin 和工具执行代理给受监督的 Bun worker。IPC 必须同时满足：

- 版本协商和显式拒绝，而不是“猜一个兼容版本”；
- 请求幂等、generation fencing、durable/transient 分离；
- 批量 streaming delta，而不是每个 token 一个 JSON 小包；
- 有界队列、背压、取消、drain、重连和有限重放；
- 可分类错误，让 host 决定重试、回退或展示。

### 0.2 非目标（v0 明确不做）

**Status (2026-10-22): partially implemented** — host/worker 骨架已落地；下列条目区分“仍不做”与“已落地但不在 v0 承诺”。

- 不实现 Rust SDK、对外新二进制入口或对外 API 变更。H1 已实现内部 `chimera-host` bin 与隐藏的 `bun-worker` 入口，但两者都不是公开 CLI/API 承诺。
- 不迁移 session 逻辑、provider、plugin、PTY/LSP/browser；它们仍由 worker 承载。
- 不替代 HTTP/SSE/WebSocket 的对外契约。对外仍是现有 REST/SSE/PTY 语义，IPC 只是 host 与 worker 之间的内部边界；H1 尚未把 HTTP 路由代理到 IPC。
- 不定义 durable SQLite schema 的最终形态。H1 已有一个 host 控制表 migration（`migration/20261022022937_host_control_plane`），但最终 durable state/event log 设计仍需单独评审。
- 不把逐 token 帧、共享内存、零拷贝、TCP 远程传输、跨主机联邦纳入 v0。

### 0.3 设计原则

**Status (2026-10-22): implemented** — 五条原则作为实现约束落地；逐条覆盖见 §1–§12 的节首注记。

1. **host 是唯一权威**：session/job/permission/question/event log 的 durable 结论只由 host 提交；worker 不把恢复所需的唯一状态留在内存。
2. **显式失败优于静默降级**：未知版本、未知必选能力、未知必选字段一律拒绝并给出错误码；兼容只能通过协商或重启到 legacy 路径。
3. **控制面与数据面分开**：离散状态转换走控制 JSON；流式 delta 走批量 typed payload，二者不共用逐条 JSON 包装。
4. **先有界再优化**：所有队列、帧、重放窗口、缓存都有字节或条目上限；超限时只允许丢可重建的 transient。
5. **协议可演进**：minor 只做向后兼容的增量；删除、语义变化和编码切换走 major。

### 0.4 与 `RUST_HOST_MIGRATION_PLAN.md` §4.1 的差异（proposed delta）

**Status (2026-10-22): implemented** — 实现按下列 delta 落地；`RUST_HOST_MIGRATION_PLAN.md` 正文是否已回写由主计划 owner 维护，本文件不代为声明。D4 的控制面 canonical JSON 已采用，数据面 msgpack 仍是未实现候选（见 §4.2）。

主计划 §4.1 只给出 framed protocol 的字段清单与建议（控制帧 CBOR/MessagePack、`session_id`/`job_id` 可选出现在帧字段、8 种 `frame_kind`）。本文是它的细化，并在以下点上**有意偏离主计划正文**。这些 delta 已由 H1 实现采用：

| # | 主计划 §4.1 | 本文 v0 | 理由 |
|---|---|---|---|
| D1 | 只说“长度前缀 framed protocol” | 固定 **64 字节 header**（§3.2），显式给出偏移、保留位与 CRC 位置 | 双方可独立实现并做字节级 parity 向量 |
| D2 | 把 `session_id / job_id (可选)` 列为帧字段 | 移到 **typed body**（§5.2、§5.4），header 只放连接级身份 | 现有 ID 是带前缀字符串，放进定长 header 只能有损哈希 |
| D3 | 8 种 `frame_kind` | 增加 `replay`（§3.3），把 replay 区间标记与重发 command 分开 | 让“区间开始”和“区间内容”可分别校验 |
| D4 | 控制帧建议 CBOR/MessagePack | 控制面用 canonical JSON，数据面 msgpack 为 **candidate default**（§4） | JSON 控制面便于诊断；数据面仍保留二进制批量 |
| D5 | 单一 `sequence` | 拆成 transport / command / event 三层序号（§1.1） | 一个序号无法同时服务传输排序、command 重放和 SSE 游标 |

因此：**本文的实现部分已冻结为 H1 事实，但主计划正文仍以 owner 回写为准**。后续协议变更必须同时更新本文、实现和主计划，避免三处漂移。

## 1. 术语与所有权

**Status (2026-10-22): partially implemented** — `connection_id`/`worker_generation`/`transport_sequence` 已由连接层与 supervisor 实现；`event_seq` 已由 `host_event` 存储分配；`command_sequence` 尚未分配或持久化（`host_command_replay` 只有逻辑定义，见 §13）。

| 术语 | 含义 | 权威所有者 |
|---|---|---|
| host | Rust 长驻父进程：HTTP 前门、SQLite/WAL、graph、SSE、supervisor | — |
| worker | Bun 子进程：Effect session runtime、provider、plugin、未迁移工具 | — |
| `connection_id` | host 分配给一条 transport 连接的稳定 u64，同一次 host boot 内不复用 | host |
| `worker_generation` | host 在每次 spawn/resume worker 时单调递增的 u64；所有 durable 写入必须携带 | host |
| `correlation_id` | 请求方生成的 16 字节 UUIDv7，用于 request/response 配对和幂等键 | 请求方 |
| `transport_sequence` | 单条连接、单个发送方向的单调帧序号；重连即重置，只用于传输排序、去重和断点检测 | 发送方 |
| `command_sequence` | host→worker durable command 的逻辑游标，跨连接持续单调；只有进入 `host_command_replay` 窗口的 command 才分配 | host |
| `event_seq` | host durable event log 的全局单调序号（`host_event.seq`），客户端 `Last-Event-ID` 使用 | host |
| `stream_epoch` | host 事件流纪元（boot 或日志轮转时更换）；旧 epoch 的重放请求必须 reset | host |
| durable | 客户端重连或 worker 重启后必须仍可重建的状态/事件 | host 落库后才算成立 |
| transient | 可由已提交状态重建、允许丢弃的增量（文本 delta、进度、心跳） | worker 可持有 |
| turn | 一次用户输入驱动的 agent 执行区间，绑定 session 与 turn intent | host 记录意图，worker 执行 |

> 历史别名：旧文档/旧表描述里的 `log_sequence` 与 `event_seq` 是同一字段，**统一读作 `event_seq`**；新文档、新 schema 和新代码只使用 `event_seq`，不得同时暴露两个名字。

### 1.1 三层序号（不要混用）

**Status (2026-10-22): partially implemented** — `transport_sequence` 已由 `chimera-host/src/connection.rs` 与 `packages/chimera/src/host/ipc-connection.ts` 双向实现；`event_seq` 已由 `HostStore::append_event` 分配；`command_sequence` 的分配与 replay 窗口尚未实现。

| 名称 | 作用域 | 是否跨重连/重启 | 分配者 | 用途 |
|---|---|---|---|---|
| `transport_sequence` | 单连接 + 单发送方向 | 重连即重置（新连接从 1 开始） | 发送方 | 传输排序、去重、`MORE` 分片重组、连接内 gap 检测 |
| `command_sequence` | workspace 的 host→worker durable command | 跨连接持续；host 持久化在 `host_command_replay` | host | worker 重连后从 `last_acked_command_sequence` 之后重放未确认 command |
| `event_seq` | 全库 durable event log | 跨连接、跨 host 重启持续 | host | SSE `Last-Event-ID` 游标；`host_event.seq` |

规则：

- 三者互不映射：`Last-Event-ID` 只映射 `event_seq`，不映射 `transport_sequence`；replay 的起止只用 `command_sequence`。
- 客户端可见的补发由 `event_seq` 负责；worker 重连的 command 补发由 `command_sequence` 负责；两层独立，禁止互相推算。
- `transport_sequence` 允许 gap（transient）；`command_sequence` 与 `event_seq` 在各自窗口内必须连续，出现缺口按数据损坏处理。
- header 里的线上字段名仍是 `sequence`，其 canonical 语义名是 `transport_sequence`（§3.2）。

### 1.2 Generation 层级（不要混用）

**Status (2026-10-22): partially implemented** — `host_generation`/`worker_generation` 的存储与 supervisor fencing 已实现；turn/job/request 代次字段已进入 schema，但端到端写入闸门尚未接线。

| 名称 | 所在层 | 载体 | 作用域 | 何时递增 |
|---|---|---|---|---|
| `host_generation` | host 自身提交代次 | `host_state.host_generation` | 数据库 | 每次 host 启动；只增不减，禁止回退 |
| `worker_generation` | workspace worker fencing | header `worker_generation` + `host_worker.generation` | workspace | 每次 spawn/resume worker |
| `turn_generation` | turn 执行代次 | body / `session_turn_checkpoint.generation` | turn | turn 被重新发布或被新执行接管时 |
| `pending_request.generation` | 审批/问答重新发布代次 | body / `pending_request.generation` | request | 同一 `request_id` 重新发布时 |
| `job generation` | 单 job 运行代次 | body / `background_job.generation` | job | 同一 `job_id` 开始新一次 run 时 |

规则：

- **绑定**：一条连接绑定一个 `worker_generation`（每帧 header 携带）；该连接上的 turn/job/request 记录还必须携带自己的代次。worker 代次匹配不代表 turn/job 代次匹配，两层都要校验。
- **旧写拒绝**：header `worker_generation` 小于当前值 → `stale_generation`，帧丢弃且不落库；turn/job/request 代次小于当前值 → 同样拒绝，且不得改变终态（只允许用于诊断）。
- 不要把 `connection_id` 当代次（它标识连接，不标识写入资格），也不要用 `worker_generation` 替代 turn/job 代次。
- 现有 `background_job` 的 `generation` 是“同一 job_id 的运行代数”，与 `worker_generation`（整条连接的写入代际）作用域不同，不可互换。

现有 Chimera 身份类型是带前缀的字符串（`src/contracts/session-ids.ts`：`SessionID`/`MessageID`/`PartID`，由 `src/id/id.ts` 生成），不是定长整数。因此 v0 **不把 session/job 放进定长 header**，而是放在 typed body 的 `session_id`/`job_id` 字段中，header 只承载连接级身份。这样避免对字符串 ID 做有损哈希。

## 2. Transport 假设

### 2.1 抽象

**Status (2026-10-22): partially implemented** — Unix domain socket、`0700`/`0600` 权限、stale-socket 恢复与 `Listener` 抽象已实现（`chimera-host/src/host.rs`）；Windows named pipe 未实现（crate 目前 Unix-only）。

v0 只支持本机、同用户的字节流 transport：

- Unix：Unix domain socket，默认路径 `<data-root>/host/ipc/host.sock`，目录 `0700`、socket `0600`；路径长度必须小于平台 `sun_path` 限制。**已实现。**
- Windows：named pipe，默认 `\\.\pipe\chimera-host-<user-scope>-<boot-scope>`；ACL 只允许当前用户。**未实现（proposed）。**
- 两端通过一个窄接口抽象：`TransportListener`（bind/accept）和 `TransportStream`（read/write/close/shutdown）。协议层不感知 Unix socket 与 pipe 的差异。**已实现为 `Listener` trait + `Read`/`Write` 半连接。**

`<data-root>` 必须由现有 graph/data-root 解析逻辑给出，不硬编码 `.chimera/` 或 `.codegraph/`。

### 2.2 本机约束

**Status (2026-10-22): partially implemented** — 不监听 TCP、nonce 校验已实现；同用户访问目前依赖 socket 目录 `0700`/文件 `0600`，peer credentials（`SO_PEERCRED`/`LOCAL_PEERCRED`）尚未实现。原“本轮不构建、不执行”已随 H1 落地失效，改为 CI-only 端到端验证。

- **不监听 TCP，不暴露网络端口**。IPC 是 host 与自有子进程之间的本地通道。
- **不监听 TCP，不暴露网络端口**。IPC 是 host 与自有子进程之间的本地通道。**已实现。**
- H1 已构建并执行 host/worker 二进制；transport 的端到端验证在 CI 的 Unix 腿执行（`chimera-host/tests/e2e_bun_worker.rs`），本地受管环境仍不做发布产物的安装/执行验证。
- 连接建立后必须做 peer 校验：Unix 上读取 peer credentials（Linux `SO_PEERCRED`，macOS `LOCAL_PEERCRED`），要求 uid 与 host 一致；Windows 上校验 pipe 客户端身份。peer 校验失败返回 `unauthorized` 并关闭。**未实现（proposed）；当前只依赖 socket 目录/文件权限与 nonce。**
- worker 由 host spawn，socket 路径和一次性 nonce 通过继承环境/句柄传递；nonce 只用于 `hello`，不写入日志。**已实现：`CHIMERA_HOST_SOCKET` + `CHIMERA_WORKER_NONCE`，host 侧与 TS 侧握手实现都校验 nonce。**

### 2.3 连接生命周期

**Status: landing** — 握手/ready/ack、drain、崩溃检测已实现；心跳帧发送 API 与 runtime tick 发送已落地，但 worker watchdog 与完整接线仍在并行推进。Rust 侧 `run_handshake` 目前没有读超时，`HANDSHAKE_TIMEOUT_MS` 仅在 TS worker 侧生效。

```text
host listen
  └─ worker spawn ──connect──▶ host accept
       worker ── hello ──────▶ host
       worker ◀──── ready ─── host        (connection_id, generation, limits)
       worker ── ack(hello) ─▶ host
       ... request/response/event/ack/cancel/drain/replay ...
       host ── drain ────────▶ worker ── ack(drained) ─▶ exit
```

- 握手超时 10s（candidate default，由 H0 基线 + H1 benchmark 校准）；超时关闭并返回 `handshake_timeout`。**TS worker 侧已实现；Rust host 侧常量已定义但阻塞读尚未加超时（landing）。**
- 心跳：host 每 10s（candidate default）发送一条 transient `ipc.heartbeat` event；连续 3 次（约 30s，candidate default）无任何入站帧视为失联，关闭连接并按 worker crash 处理。**Status: landing** — `HostDriver::send_heartbeat` 与 runtime tick 已实现，失联标记为 `unresponsive` 已实现，但关闭/回收策略仍由调用方决定。
- 正常情况下由 host 主动 `drain`；worker 不得在 host 仍存活时自行退出，除非遇到不可恢复错误并以约定退出码结束。**已实现（drain 见 §9.3）。**

## 3. 帧格式

### 3.1 长度前缀

**Status (2026-10-22): implemented** — `chimera-host/src/frame.rs` + `packages/chimera/src/host/ipc-frame.ts`；Rust 读取器 `connection.rs` 与 TS `ipc-connection.ts` 均先读满 header 再按长度读 body。截断 header/body 一律返回 `decode_error`，不 panic/不越界分配。

每帧 = **固定 64 字节 header + `payload_length` 字节 body**。header 与 body 均按小端编码。读取方必须先读满 64 字节，校验 header，再按 `payload_length` 读取 body；在通过 `MAX_FRAME_BYTES` 检查前不得按长度预分配大缓冲。

`payload_length` 是 body 的字节数，不含 header。一个逻辑消息可以由多个 frame 通过 `MORE` flag 分片；分片重组后的总大小不得超过 `MAX_FRAME_BYTES`。

### 3.2 Header 布局（64 bytes）

**Status (2026-10-22): implemented** — 双臂字节级一致，golden vectors 覆盖。解码器按裁决**不拒绝**任何 `protocol_version` 值（只透传），版本兼容由 §6.1 协商决定；magic 错误返回 `bad_magic`（不是 `bad_header`）。

| Offset | Size | Field | 说明 |
|---:|---:|---|---|
| 0 | 4 | `magic` | `0x50494843`，线上字节为 `43 48 49 50`（"CHIP"） |
| 4 | 2 | `protocol_version` | `major << 8 \| minor`；v0 = `0x0100` |
| 6 | 2 | `header_len` | 固定 `64`；用于未来扩展 header |
| 8 | 1 | `frame_kind` | 见 3.3 |
| 9 | 2 | `flags` | 见 3.4 |
| 11 | 1 | `reserved0` | 必须为 0；非 0 视为 `bad_header` |
| 12 | 4 | `payload_length` | body 字节数，u32 |
| 16 | 8 | `connection_id` | host 分配；握手前为 0 |
| 24 | 8 | `worker_generation` | 握手前为 0；握手后必须等于 host 当前 generation |
| 32 | 8 | `sequence`（canonical 语义名 `transport_sequence`） | 该连接、该发送方向的下一个单调序号，从 1 开始；重连后重置 |
| 40 | 16 | `correlation_id` | UUIDv7 原始 16 字节；无关联时为全 0 |
| 56 | 4 | `payload_crc32c` | 仅当 `CHECKSUM` flag 置位时有效，否则为 0 |
| 60 | 4 | `reserved1` | 必须为 0 |

约束：

- `connection_id == 0` 只允许出现在 worker 的首个 `hello` 帧；host 在 `ready` 中回填真实 id。
- `worker_generation == 0` 只允许出现在 `hello`；之后每帧必须携带 host 已分配的 generation。
- `correlation_id` 全 0 只允许用于无请求关联的心跳/事件；`request`/`response`/`ack` 必须非 0。
- `payload_length > MAX_FRAME_BYTES`、`header_len != 64`、magic 错误、reserved 非 0 一律在读取 body 前拒绝。

### 3.3 `frame_kind`

**Status (2026-10-22): implemented** — 1–9 全部有枚举；`replay` 的帧类型已定义，但重放流程本身尚未实现（见 §5.9）。

| 值 | 名称 | 方向 | 用途 |
|---:|---|---|---|
| 1 | `hello` | worker→host, host→worker | 握手与 capability 协商；`ready` 也使用该 kind，由 body 的 `phase` 区分 |
| 2 | `request` | 双向 | 需要 response 的控制请求 |
| 3 | `response` | 双向 | 对 `request` 的成功/失败响应 |
| 4 | `event` | 双向 | 单向事件；durable 或 transient 由 flags 决定 |
| 5 | `ack` | 双向 | durable 提交确认、drain 完成、replay 完成 |
| 6 | `cancel` | 双向 | 取消某个 request/turn/job |
| 7 | `drain` | host→worker | 优雅排空 |
| 8 | `error` | 双向 | 协议级/连接级错误（不是业务响应） |
| 9 | `replay` | host→worker | 重放未确认的 durable command 区间 |

未知 `frame_kind` 返回 `unknown_frame_kind` 并关闭连接；不得当作未知事件忽略。

### 3.4 `flags`

**Status (2026-10-22): implemented** — 未知 bit 返回 `bad_header`；`COMPRESSED` 未协商返回 `decode_error`；CRC32C 覆盖 payload 且按分片校验；reassembler 在 checksum/上限/压缩失败时立即 reset 丢弃半成品。

| Bit | 名称 | 语义 |
|---:|---|---|
| 0x0001 | `MORE` | 当前 frame 是同一逻辑消息的一个分片；接收方按 `transport_sequence` 连续重组 |
| 0x0002 | `DURABLE` | 该帧承载必须落库/可恢复的内容；未置位即 transient |
| 0x0004 | `REPLAYABLE` | 该帧可进入 host command replay 窗口（仅 host→worker durable command 使用） |
| 0x0008 | `COMPRESSED` | body 使用协商的压缩算法（v0 只允许 zstd，且必须双方声明） |
| 0x0010 | `FINAL` | 多分片消息的最后一帧；或 drain/replay 区间的结束标记 |
| 0x0020 | `CHECKSUM` | `payload_crc32c` 有效 |

未定义 bit 必须为 0；收到未知 bit 返回 `bad_header`。`DURABLE` 与 `REPLAYABLE` 可以组合；`MORE` 分片的每一片必须携带相同的 durable/replayable 属性。

### 3.5 上限

**Status (2026-10-22): implemented** — 常量与实现一致（`frame.rs` / `ipc-frame.ts`）；所有数值仍是 candidate default，未做最终压测校准。

| 常量 | candidate default | 说明 |
|---|---:|---|
| `MAX_FRAME_BYTES` | 8 MiB（8,388,608） | 单帧 body 硬上限；hello 可协商更小值，不能超过 host 硬上限 |
| `MAX_FRAME_BYTES_HARD` | 16 MiB | host 接受的绝对上限，防止协商放大 |
| `MAX_REASSEMBLED_BYTES` | 32 MiB | `MORE` 分片重组后的逻辑消息上限 |
| `MAX_FRAGMENTS` | 256 | 单个逻辑消息的最大分片数 |
| `MAX_CONTROL_BODY` | 1 MiB | 控制 JSON body 上限；超过即 `payload_too_large` |
| `EVENT_BATCH_TARGET` | 64 KiB | 批量 delta 的目标大小 |
| `EVENT_BATCH_MAX` | 512 KiB | 单个批量 event body 上限 |

所有数值都是 **candidate default**（候选默认值），不是已批准容量。校准路径：H0 给出 Bun-only 基线与帧尺寸/事件率分布，H1 benchmark（`recovery-matrix.md` §11）给出附加延迟、吞吐和队列高水位后再定稿；实现只能从本文数值起步，不得把任何一个当作对外承诺。

## 4. Body 编码与边界

### 4.1 控制面：canonical JSON（proposed candidate）

**Status (2026-10-22): partially implemented** — 控制面已统一用 JSON：Rust `host_driver.rs` 使用按 key 排序的 `Json` 渲染器，TS 侧使用 `JSON.stringify`。**未实现 strict 解码**：双臂 `hello` 解析都忽略未知顶层字段，不返回 `validation_error`；TS 侧也没有 canonical key 排序编码器。这两点是 spec 与实现的已知偏差（见 §18 第 1 项）。

> **实现状态**：控制面选 JSON 已在 H1 落地；canonical 规则中的 key 排序仅在 Rust 侧成立，浮点表示、未知字段拒绝和长度/深度上限尚未双臂统一。

- 对象 key 按字典序输出；数字只用整数或有限小数，禁止 `NaN`/`Infinity`；
- 控制 envelope 严格解码：未知顶层字段返回 `validation_error`（不静默忽略）；
- 扩展只能放在 `ext` 对象中，key 必须以 `x-` 开头；host/worker 必须忽略不认识的 `x-` 字段；
- 字符串长度、数组长度、嵌套深度都有上限（v0：单字符串 1 MiB、数组 4096 项、深度 32）。

canonical JSON 只用于离散控制，不用于逐 token 数据。如果 H1 review 改选 CBOR/MessagePack 作为控制面编码，§4.1 的 canonical 规则（key 排序、禁止 NaN、未知字段拒绝、`ext`/`x-` 扩展）仍然适用，只替换字节编码器。

### 4.2 数据面：批量 typed payload（proposed candidate）

**Status (2026-10-22): not implemented (proposed)** — H1 只实现 `payload_encoding: "json"`；host 会协商 `encoding.msgpack` 能力，但双臂都没有 msgpack 编解码器，`bun-worker` 也只声明 `json`。

`event` 帧的 body 有两种形态，由 envelope 的 `payload_encoding` 声明。两种编码都仍是 **proposed candidate**：msgpack 是候选默认，json 是必选回退，最终选型见 §18 第 1 项。当前实现只使用 `json`。

- `json`：小批量或控制型事件，仍是 canonical JSON；
- `msgpack`：批量 transient delta 的候选默认形态。双方在 hello 中声明 `encoding.msgpack` 后才可使用；否则回退 `json`。

批量 delta 的最小结构（逻辑字段，不绑定具体 msgpack 字段顺序）：

```text
{
  "batch": [
    { "session_id": "ses_...", "message_id": "msg_...", "part_id": "prt_...",
      "field": "text" | "raw", "delta": "..." }
  ],
  "first_transport_sequence": 123,
  "last_transport_sequence": 130
}
```

规则：

- 只有可加性字段（现有 `global-event-stream.ts` 合并逻辑认可的 `text`/`raw`）可以进批量 delta；离散 payload（如 `hunk`）不得合并。
- worker 按 40ms 或 64 KiB 先到者聚合；host 向 SSE 客户端继续输出现有 `message.part.delta` 语义，不新增对外 JSON 层。
- 批量 delta 一律 transient（不带 `DURABLE`）；host 不为其分配 `event_seq`，只做连接内 `transport_sequence` 校验。
- 单个批量 body 超过 `EVENT_BATCH_MAX` 时拆分为多个 `MORE` 分片；不得退化成逐 token 帧。

#### 4.2.1 msgpack event body 的 envelope

**Status (2026-10-22): not implemented (proposed)** — 以下 envelope 是设计目标，不是当前线上格式。

`payload_encoding: "msgpack"` 时，**整个 `event` body 用 msgpack 编码**，不是“canonical JSON envelope 里塞一段 msgpack 字节”。body 顶层是一个 msgpack map，key 与 JSON 形态完全一致：

```text
{
  "v": 1,
  "kind": "event",
  "id": nil,
  "event": "message.part.delta",
  "session_id": "ses_...",
  "job_id": nil,
  "turn_id": "turn_...",
  "transport_sequence": 131,
  "event_seq": nil,
  "payload_encoding": "msgpack",
  "payload": { "batch": [ ... ], "first_transport_sequence": 123, "last_transport_sequence": 130 }
}
```

规则：

- 接收方先看 header `frame_kind`，再按连接协商结果选 body 解码器；`payload_encoding` 必须与协商结果一致，否则 `decode_error`。
- 同一连接上不得对同一逻辑事件混用 `json`/`msgpack` body；切换编码需要新连接或新 major。
- `payload` 内部字段的编码跟随外层：msgpack body 中 `batch` 是 msgpack array，不是 JSON 字符串。
- msgpack 的 canonical 要求（map key 顺序、整数宽度、字符串/二进制区分）同样是 **proposed candidate**，需 H1 review 固定为可测试规则；否则跨实现 parity 向量无法字节比较。

### 4.3 大文本/二进制

**Status (2026-10-22): implemented（分片路径）** — `MORE` 分片与 `MAX_REASSEMBLED_BYTES` 已实现；共享内存/临时文件仍不做。

v0 不引入共享内存或临时文件句柄。超过 `EVENT_BATCH_MAX` 的 payload 用 `MORE` 分片承载，总大小受 `MAX_REASSEMBLED_BYTES` 限制；更大的附件传输延期到 H2/H3 单独设计。

## 5. Envelope 定义

**Status (2026-10-22): partially implemented** — `hello`/`ready`/`request`/`response`/`event`/`ack`/`drain`/`error` 已实现；`replay` 未实现。body 级交叉校验（`id` vs `correlation_id`、body `transport_sequence` vs header `sequence`）目前未在双臂强制执行。

所有 body 都有 `v`（协议 minor 版本号，v0 = `1`）和 `kind`。header 与 body 的 `kind` 必须一致，不一致返回 `bad_header`。

### 5.1 `hello` / `ready`

**Status (2026-10-22): implemented** — `handshake.rs` + `ipc-handshake.ts`；`run_handshake` 写 `ready` 并等待 `ack(hello_complete)`。`limits.max_frame_bytes=0` 或非法值返回 `validation_error`；无 `resume` 游标时 `replay_available=false`；示例中的 `encodings` 含 `msgpack` 是目标形态，当前 worker 只声明 `json`。

worker → host：

```json
{
  "v": 1,
  "kind": "hello",
  "phase": "hello",
  "nonce": "one-time-token",
  "worker": {
    "pid": 12345,
    "build": "chimera-bun-worker@<version>",
    "runtime": "bun@<version>",
    "boot_id": "boot_<ms>_<pid>"
  },
  "protocol": { "min": 256, "max": 256 },
  "encodings": ["json", "msgpack"],
  "compressions": [],
  "capabilities": ["frame.v1", "control.json", "event.batch", "cancel", "drain", "replay.command", "session.runtime"],
  "limits": { "max_frame_bytes": 8388608 },
  "workspace": { "directory": "/abs/workspace", "project_id": "prj_..." },
  "resume": { "last_acked_command_sequence": 42, "stream_epoch": "..." }
}
```

host → worker：

```json
{
  "v": 1,
  "kind": "hello",
  "phase": "ready",
  "connection_id": 17,
  "worker_generation": 8,
  "protocol": 256,
  "encodings": ["json", "msgpack"],
  "compressions": [],
  "capabilities": ["frame.v1", "control.json", "event.batch", "cancel", "drain", "replay.command", "session.runtime"],
  "limits": {
    "max_frame_bytes": 8388608,
    "max_reassembled_bytes": 33554432,
    "max_fragments": 256,
    "heartbeat_ms": 10000,
    "request_timeout_ms": 30000,
    "cancel_soft_timeout_ms": 5000,
    "cancel_hard_timeout_ms": 30000
  },
  "resume": { "from_command_sequence": 43, "replay_available": true }
}
```

`limits` 中所有数值（以及 §3.5 的帧/批量上限）都是 **candidate default**；最终值由 H0 基线 + H1 benchmark 校准。协商只能收紧，不能放大 host 硬上限。

### 5.2 `request`

**Status (2026-10-22): implemented（结构）** — `host_driver.rs` 解析 `request` 并路由给 `RequestRouter`；`id`/`correlation_id` 一致性校验尚未强制执行。

```json
{
  "v": 1,
  "kind": "request",
  "id": "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a",
  "method": "session.prompt",
  "session_id": "ses_...",
  "job_id": null,
  "turn_id": "turn_...",
  "deadline_ms": 30000,
  "idempotency_key": "optional-explicit-key",
  "params": { "...": "..." },
  "ext": {}
}
```

- `id` 必须与 header 的 `correlation_id` 一致。
- `method` 必须在双方协商的 capability 对应 allowlist 内；未知方法返回 `unknown_method`。
- `deadline_ms` 是请求级软截止时间；超时后 host 发 `cancel`，不依赖 worker 自行退出。
- `idempotency_key` 缺省时使用 `id`；显式 key 允许客户端重试时复用同一逻辑操作。

### 5.3 `response`

**Status (2026-10-22): implemented** — `OutgoingResponse`/`response` 帧已实现，业务错误走 `response.error`。

```json
{
  "v": 1,
  "kind": "response",
  "id": "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a",
  "status": "ok",
  "result": { "...": "..." },
  "error": null,
  "meta": { "idempotent_replay": false }
}
```

失败时 `status: "error"`，`error` 使用第 10 节的分类结构，`result` 为 null。业务失败（provider/tool/permission）走 `response.error`，不占用 `error` frame；`error` frame 只用于协议/连接级错误。

### 5.4 `event`

**Status (2026-10-22): partially implemented** — `event` 帧解析、durable/transient 分类与 transient 发送已实现；body `transport_sequence` 与 header `sequence` 的一致性校验、durable event 的 commit/ack 尚未接线（见 §8.2）。

```json
{
  "v": 1,
  "kind": "event",
  "id": null,
  "event": "message.part.delta",
  "session_id": "ses_...",
  "job_id": null,
  "turn_id": "turn_...",
  "transport_sequence": 131,
  "event_seq": null,
  "payload_encoding": "msgpack",
  "payload": { "...": "..." }
}
```

- `DURABLE` event 的 `event_seq` 在 host 提交后由 `ack` 回填；worker 发送时可以为 null。
- transient event 的 `event_seq` 必须为 null。
- body 的 `transport_sequence` 必须等于同一帧 header 的 `sequence`；不一致返回 `bad_header`。它只用于连接内排序，不参与 SSE 游标。**未强制校验（已知偏差）。**
- `event` 名称沿用现有 Bus 事件名（如 `message.part.delta`、`permission.asked`、`session.error`），不另造平行命名；完整 allowlist 由 H0 的 operation/event 清单确定。

### 5.5 `ack`

**Status: landing** — `ack` 解析、`hello_complete`/`drained` 处理已实现，`send_durable_ack` API 已存在；但 durable event 的“先落 `host_event` 再 ack”上层接线仍在并行推进。

```json
{
  "v": 1,
  "kind": "ack",
  "id": "0192...",
  "ack_of": "0192...",
  "phase": "durable_committed",
  "durable_through_command_sequence": 120,
  "event_seq": 8801,
  "replay_complete": false
}
```

`phase` 取值：`hello_complete`、`durable_committed`、`drained`、`replay_complete`、`cancel_ack`。`durable_through_command_sequence` 是该连接已确认提交的最大 **command_sequence**（不是 transport sequence）；host 用它裁剪 `host_command_replay` 窗口。`event_seq` 仅在 `phase=durable_committed` 时非 null。

### 5.6 `cancel`

**Status (2026-10-22): partially implemented** — host 侧 `send_cancel` 已实现；worker 的 `serve` 循环目前只处理 `request`/`event`/`drain`，收到 `cancel` 不会停止目标工作；软/硬超时常量已定义但未执行。

```json
{
  "v": 1,
  "kind": "cancel",
  "id": "0192...",
  "target_id": "0192...",
  "target_transport_sequence": 120,
  "session_id": "ses_...",
  "job_id": null,
  "reason": "user_abort",
  "deadline_ms": 5000
}
```

取消是幂等的：同一 `target_id` 重复取消返回相同结果。worker 必须尽快停止目标工作并发送终态 `response`（`cancelled`）或 durable `event`（`turn.interrupted`）；host 在软超时（candidate default 5s）后标记 unresponsive，硬超时（candidate default 30s）后终止 worker。两个超时值均由 H1 benchmark 校准。**当前实现：host 会发 cancel 帧；worker 侧取消执行与超时终止尚未接线。**

### 5.7 `drain`

**Status: landing** — `drain` 帧、`ack(drained)`、worker 侧在途请求等待与退出码已实现；deadline 的单一事实源（host config vs supervisor vs worker 本地默认）仍在收敛。

```json
{
  "v": 1,
  "kind": "drain",
  "id": "0192...",
  "drain_id": "drain_...",
  "reason": "restart" | "upgrade" | "memory" | "shutdown",
  "deadline_ms": 30000,
  "allow_new_requests": false
}
```

worker 收到后：

1. 停止接受新的 `request`；
2. 对进行中的 turn 写 checkpoint（H1 至少记录 turn intent 与最后已提交 `event_seq`）；
3. 发送 `ack(phase=drained)`，附 `active_sessions` 和 `interrupted_turns`；
4. 在 deadline 内退出；超时由 host 发送 `SIGTERM`，再超时 `SIGKILL`。

`deadline_ms`（30s）与 `cancel` 的软/硬超时同样是 **candidate default**，由 H1 benchmark 校准；drain 超时后的 turn/job 状态见 §9.3。

### 5.8 `error`

**Status (2026-10-22): implemented** — 结构化 error frame、category/retryable 与握手拒绝均已实现。

```json
{
  "v": 1,
  "kind": "error",
  "id": "0192...",
  "error": {
    "code": "stale_generation",
    "category": "worker",
    "retryable": false,
    "retry_after_ms": null,
    "message": "frame generation 7 is older than current 8",
    "details": { "expected": 8, "received": 7 },
    "cause_chain": []
  }
}
```

`details` 和 `cause_chain` 都有长度上限（v0：8 KiB / 8 层），不得包含凭据或完整 provider 请求体。

### 5.9 `replay`

**Status (2026-10-22): not implemented (proposed)** — `replay` 帧类型已定义，但 command replay 窗口、`host_command_replay` 存储与重发流程均未实现。

```json
{
  "v": 1,
  "kind": "replay",
  "id": "0192...",
  "stream_epoch": "epoch_...",
  "from_command_sequence": 43,
  "to_command_sequence": 60,
  "count": 18,
  "truncated": false
}
```

`replay` 只是区间标记，自身不是 durable command，不占 `command_sequence`、不落 `host_command_replay`、也不分配 `event_seq`。紧随其后的是按原 `command_sequence` 重发的 durable command 帧（保留 `REPLAYABLE`），最后以 `ack(phase=replay_complete)` 结束。接收方必须按 `command_sequence` 去重，已提交过的 command 不得重复执行；重发帧的 `transport_sequence` 使用当前连接的新序号，不沿用旧连接的 transport sequence。

## 6. 握手与 capability 协商

**Status (2026-10-22): implemented** — 版本交集、必选/未知能力、nonce、limits 收紧与结构化拒绝均在双臂落地。

### 6.1 版本

**Status (2026-10-22): implemented** — `negotiateProtocol`/`intersection_highest` 返回最高共同版本；无交集返回 `unsupported_protocol_version`。解码层不拒绝版本（见 §3.2）。

- `protocol_version` 是 `major << 8 | minor`。v0 线上版本为 `0x0100`（major 1，minor 0）。
- host 维护 `supported = [1.x]`；worker 在 hello 中给出 `min`/`max`。交集为空 → `unsupported_protocol_version`，host 发送 error 后关闭。
- **禁止在连接内降级**。需要旧协议时，host 必须关闭连接并选择 legacy 进程内路径或重启为旧 worker；不得把 v2 消息改写成 v1。
- minor 升级只允许新增可选字段/能力；删除字段、改变字段语义、改变默认 durable 行为必须升 major。

### 6.2 能力集合

**Status (2026-10-22): implemented** — `REQUIRED_CAPABILITIES` 六项、`KNOWN_CAPABILITIES` 十四项；`missing` 先于 `unknown` 报错；`json` 编码必需；`pty.bridge` 保留但 host 不提供；`encoding.msgpack` 可协商但无编解码器。

v0 能力字符串（小写点分）：

| Capability | 必选 | 含义 |
|---|---|---|
| `frame.v1` | 是 | 支持本帧格式 |
| `control.json` | 是 | 控制面 canonical JSON（已实现；严格 canonical 规则见 §4.1） |
| `event.batch` | 是 | 支持批量 event payload |
| `cancel` | 是 | 支持 cancel 帧 |
| `drain` | 是 | 支持 drain 帧 |
| `replay.command` | 是 | 支持 host→worker durable command replay（能力已声明；重放流程未实现） |
| `encoding.msgpack` | 否 | 数据面 msgpack |
| `encoding.zstd` | 否 | `COMPRESSED` body |
| `session.runtime` | 按路由 | 可执行 session prompt/turn |
| `provider.stream` | 按路由 | 可执行 provider 流式调用 |
| `tool.exec` | 按路由 | 可执行未迁移工具 |
| `plugin.loader` | 按路由 | 可加载 JS plugin |
| `graph.read` | 按路由 | 可代理只读 graph 查询 |
| `pty.bridge` | 否 | 预留，v0 不启用 |

协商规则：

- 双方取交集；host 的必选集合缺任何一项 → `capability_missing`，附缺失列表，关闭连接。
- 未知 capability 字符串（不以 `x-` 开头）→ `unknown_capability`，关闭连接。`x-` 前缀能力可忽略。
- 路由选择以交集为准：host 只把某方法的请求发给声明了对应能力且 generation 当前的 worker；没有可用 worker 时返回 `worker_unavailable` 或回退 legacy（由 kill switch 决定）。

### 6.3 显式拒绝

**Status (2026-10-22): implemented** — 拒绝均走结构化 error frame 后关闭；`bad_magic` 与 `bad_header` 按裁决分开。

拒绝必须走结构化 error frame，随后关闭连接；不得只断开 socket：

| 场景 | code | 关闭 |
|---|---|---|
| magic 非法 | `bad_magic` | 是 |
| header 非法（header_len/reserved/flags/frame_kind） | `bad_header` | 是 |
| 版本交集为空 | `unsupported_protocol_version` | 是 |
| 缺必选能力 | `capability_missing` | 是 |
| 未知非 `x-` 能力 | `unknown_capability` | 是 |
| nonce 不匹配/peer 校验失败 | `unauthorized` | 是 |
| 握手超时 | `handshake_timeout` | 是 |

## 7. 幂等与 generation fencing

**Status (2026-10-22): partially implemented** — `request_idempotency` 表与读写 API、supervisor generation fencing、transport sequence 校验已实现；HTTP/IPC 入口接线与 turn/job 代次闸门尚未完成。

### 7.1 幂等键

**Status (2026-10-22): partially implemented** — `HostStore::record_idempotency` / `lookup_idempotency` 已实现（含 request hash 冲突检测）；上表方法 allowlist 与 `meta.idempotent_replay` 的入口接线尚未实现。

host 对下列方法启用幂等记录（v0 allowlist）：

- `session.prompt`、`session.prompt_async`、`session.abort`
- `permission.reply`、`question.reply`、`question.reject`
- `job.cancel`

键：`(workspace_id, method, idempotency_key)`；`idempotency_key` 缺省为 `correlation_id`。

记录内容：canonical 请求摘要（BLAKE3）、状态（`in_flight`/`ok`/`error`）、响应字节、创建/过期时间、`worker_generation`。

行为：

- 相同键 + 相同摘要 + `in_flight` → 不重复执行，返回 `duplicate_in_flight`（`retry_after_ms`）或挂起等待原结果；
- 相同键 + 相同摘要 + 已完成 → 返回已记录响应，`meta.idempotent_replay = true`；
- 相同键 + 不同摘要 → `correlation_conflict`，不得覆盖原记录；
- 记录 TTL 24h，条目上限 100k，优先淘汰已终态的最旧记录；过期后同键视为新请求（`idempotency_expired` 仅用于显式查询场景）。

现有 `background_job` 已有 `generation` 语义（`src/agent/background-job.ts` 的 `Info.generation` 与 `src/agent/background-job.sql.ts`）。`job_id`、job generation 与 `request_idempotency` 的关系必须分清，三者不能互相替代：

- `job_id` 标识**一次逻辑 job**；同一 `job_id` 的新一次执行靠 `background_job.generation` 区分（见 §1.2）。
- `request_idempotency` 只去重“同一个可重试请求”（同 `method` + 同 `idempotency_key` + 同摘要），它返回首次记录的响应，不负责判断哪一代 job 可以写入。
- generation 校验是**写入闸门**：即使幂等键命中，旧 generation 的完成/失败通知也不得改变终态（§7.2）。
- 幂等记录中保存的 `worker_generation` 只用于诊断与冲突定位，不用于放行后续写入。

### 7.2 Generation fencing

**Status (2026-10-22): partially implemented** — header `worker_generation` 不匹配的帧被丢弃并计数（`stale_generation_dropped`）；`connection_id` 不匹配返回 `bad_header`。turn/job/request 代次闸门与重启后 `interrupted` 标记尚未接线。

§1.2 已定义 generation 层级。本节只讲 IPC 上的**绑定与拒绝**：

- host 在每次 spawn/resume worker 时分配新的 `worker_generation`，单调递增并持久化在 `host_worker`；worker 不能自选。
- 所有 `request`/`event`/`ack` 帧的 header `worker_generation` 必须等于 host 当前值；更小值 → `stale_generation`，帧丢弃且不落库，重复出现则关闭连接。
- host 只接受当前 generation 的 durable 写入；旧 generation 的 response/event 不得覆盖新状态，也不得分配新的 `event_seq`。
- turn/job/request 各自还有自己的代次（`turn_generation`、`job generation`、`pending_request.generation`）。worker 代次匹配 **不代表** turn/job 代次匹配；终态迁移必须同时满足两层校验。
- worker 重启后，host 把上一 generation 中 `running` 的 turn/job 标为 `interrupted`（参考 `background_job` 对上一进程 `running` 行的 reconcile 逻辑），再允许新 generation 接单。
- `connection_id` 与 generation 绑定：同一 generation 的短暂传输重连可以复用逻辑身份，但必须换新 `connection_id`，并通过 `resume.last_acked_command_sequence` 走 replay。

### 7.3 Sequence

**Status (2026-10-22): partially implemented** — `transport_sequence` 双向校验与 durable gap 拒绝已实现；`command_sequence` 重放与 `stream_epoch` 切换尚未实现；`event_seq` 由 store 分配但 SSE replay 未接线。

三层序号的职责见 §1.1。本节只讲接收侧校验：

- header `sequence`（`transport_sequence`）是**每条连接、每个发送方向**的单调计数器，从 1 开始；接收方发现跳号：
  - transient 流：记录 gap，允许继续，但必须向 SSE 层产生 `server.event-gap`（现有事件，见 `src/server/event.ts`）；
  - durable 流：`sequence_gap` 错误，停止提交，要求 replay 或重启 worker。
- `command_sequence` 只由 host 分配并持久化在 `host_command_replay`；worker 重连时用它作为重放游标，不得用 `transport_sequence` 代替。
- `event_seq` 只由 host 分配，持久化在 `host_event`；客户端 `Last-Event-ID` 映射到它，不映射到 header `sequence`，也不映射到 `command_sequence`。
- `stream_epoch` 在 host boot 或 event log 轮转时更换；旧 epoch 的 replay 请求返回 `replay_unavailable` 并要求客户端 reset，而不是伪造连续序号。

## 8. Durable / transient 边界

**Status (2026-10-22): partially implemented** — durable/transient 分类与 `HostEvent` 类型已实现；commit-before-ack 上层接线仍在 landing。

### 8.1 判定规则

**Status (2026-10-22): implemented（分类）/ partially implemented（提交）** — 表中分类已编码为 `HostEvent::Durable` / `Transient`；`commit.confirm` 与 checkpoint 推进未实现。

一个事件是 durable，当且仅当：客户端在断线重连后必须能重建它，或 host 重启后必须能据此恢复状态。其余为 transient。

| 类别 | 归属 | 例子 | 失败处理 |
|---|---|---|---|
| session/message/part 提交 | durable | `message.updated`、`message.part.updated`（committed）、`session.updated` | H1 Bun worker 在本地事务提交后发 `commit.confirm`；host 校验并推进 checkpoint/event；H2 才切 host 同事务提交 |
| turn 生命周期 | durable | `turn.started`、`turn.interrupted`、`session.error` | host 记录 checkpoint；worker 崩溃后按 H1 recovery matrix 收敛 |
| permission/question pending | durable | `permission.asked`、`question.asked` | H1 host 先落 `pending_request` 再 ack；approved ruleset 仍由 Bun 写 |
| job 终态 | durable | `job.updated`（completed/error/cancelled） | H1 Bun 写 `background_job`；host 只读取并在需要时写 host-owned durable event，H2 才切 host 写 |
| worker 生命周期 | durable（host 内部） | `worker.ready`、`worker.draining`、`worker.exited` | 写 host 审计/事件日志，供诊断 |
| 文本/参数 delta | transient | `message.part.delta`（`text`/`raw`） | 可丢；gap 用 `server.event-gap` 表示 |
| 进度/心跳 | transient | `tool.progress`、`ipc.heartbeat`、`server.heartbeat` | 可丢 |
| 日志行 | transient | `log.line` | 可丢；必要时采样 |

### 8.2 提交协议

**Status: landing** — `HostStore::append_event` 与 `HostDriver::send_durable_ack` 已提供，但 runtime/bin 尚未把“append → ack → SSE fan-out”串成单一流程；driver 目前只把 durable event 放进 `take_events()`。

durable event 的提交顺序：

```text
worker ── event(DURABLE) ──▶ host
host: validate worker_generation + transport_sequence → append host_event → commit SQLite/WAL
host ── ack(durable_committed, event_seq) ──▶ worker
host: fan-out SSE（只在此后）
```

- host 在落库前不得把 durable event 发给 SSE 客户端。
- worker 在收到 ack 前可以重发同一 durable event；host 按 `(connection_id, transport_sequence)` 或事件幂等键去重。
- transient event 不需要 ack；host 可直接 fan-out 或在队列满时丢弃。

### 8.3 现有实现的对应

**Status (2026-10-22): unchanged（行为参照）** — 现有 SSE 队列/合并语义未修改；host 尚未接管 `/event`。

- SSE 单连接队列当前是 1024、`drop-oldest`（`src/server/routes/instance/event.ts`）；host 接管后仍可保留该连接级上限，但**durable 事件已落 event log**，连接级丢弃只影响实时性，客户端可通过 `Last-Event-ID` 补发。
- 现有 `global-event-stream.ts` 的 40ms delta 合并和 `server.event-gap` 语义应保留；IPC 批量 delta 是它的上游批量化，不改变对外事件名。

### 8.4 durable / transient / control 映射

**Status (2026-10-22): partially implemented** — 映射规则已作为类型与 store 契约存在；`host_event` 表没有 `durability` 列，只有 durable 由调用方写入。

recovery-matrix §4.8 把事件分为 durable / transient / control 三类。本文的映射如下（三者互斥，不靠调用方自行解释）：

| 类别 | 是否落 `host_event` | 是否可 replay | 是否分配 `event_seq` | 是否需 `ack` | 例子 |
|---|---|---|---|---|---|
| durable | 是 | 是（保留窗口内） | 是 | 是 | `message.updated`、`turn.started`、`permission.asked`、`job.updated` |
| transient | 否 | 否；允许 gap，用 `server.event-gap` 标记 | 否 | 否 | `message.part.delta`、`tool.progress`、`ipc.heartbeat`、`log.line` |
| control | 否 | 否 | 否 | 仅连接级 phase 确认 | `connected`、`heartbeat`、`gap`、`stream_reset` |

规则：

- **control 不落 `host_event`、不 replay、无 `event_seq`**；它只表达连接状态，丢失后可重建，不得写入业务表。
- durable 与 transient 的区分是语义结论，不是发送方可以自选：worker 标记 `DURABLE` 但 host 判定为可重建时，仍以 host 的判定为准；反之，host 不得把已承诺 durable 的事件降级为 transient。
- `event_seq` 只分配给 durable event；transient 与 control 出现 `event_seq` 非 null 一律 `validation_error`。
- `recovery-matrix.md` §8.5 的 `host_event.durability` 列允许 `durable|control`；本文口径是 **control 不进 `host_event`**。该字段取值需在 H1 review 时统一（见 §18）。

## 9. 背压、取消、drain

**Status (2026-10-22): partially implemented** — drain 与退出码已实现；背压队列、取消执行与 drain deadline 单一事实源仍在收敛。

### 9.1 背压

**Status (2026-10-22): partially implemented** — 读取侧有 `MAX_FRAME_BYTES + 64` 缓冲上限，Bun transport 有 64 帧写队列与 drain 回调；表中按 session 的队列/字节上限尚未实现。

每个方向、每个 session 都有有界队列：

| 队列 | candidate default | 溢出策略 |
|---|---:|---|
| 连接出站控制队列 | 256 帧 / 16 MiB | 停止读取对端 socket（transport backpressure）；10s 仍满 → 标记 worker unresponsive |
| 连接出站 durable 队列 | 4096 帧 / 64 MiB | 不丢弃；阻塞上游；超过硬限 → `event_log_full`，进入 drain |
| 每 session transient 队列 | 1024 帧 / 1 MiB | 丢最旧 transient，累计 `dropped` 并产生 gap |
| 每 session durable 队列 | 4096 帧 / 32 MiB | 不丢弃；阻塞 worker 的 durable 发送 |
| worker 入站 in-flight 控制请求 | 128 | 超出返回 `worker_capacity` / `retry_after_ms` |

原则：

- **只允许丢 transient**；durable 永不因队列压力丢弃。
- host 对 SSE 慢客户端使用现有有界队列 + gap 语义，不把慢客户端压力反压到 worker 的 durable 路径。
- worker 出站前检查估算字节数；超过 `max_frame_bytes` 必须分片或返回 `payload_too_large`，不得让 host 读到截断帧。

### 9.2 取消

**Status (2026-10-22): partially implemented** — host `send_cancel` 已实现；取消意图持久化、worker 执行侧取消、软/硬超时终止尚未接线。

```text
client → host: session.abort / job.cancel
host: 记录取消意图（幂等）→ cancel 帧 → worker
worker: 停止目标工作 → response(cancelled) 或 event(turn.interrupted)
host: 软超时 5s（candidate default）→ 标记 unresponsive；硬超时 30s（candidate default）→ SIGTERM → SIGKILL
```

- 取消先到 host，host 是取消意图的权威记录者；worker 不自行决定“忽略取消”。
- 取消一个已完成的 request 返回原结果，不报错（幂等）。
- 取消与 worker crash 竞态：**取消意图优先**。只要 host 已持久化 `cancel_requested`（turn checkpoint / `background_job.cancel_requested_at`），后续无论 worker 自报完成、崩溃还是 drain 超时，终态都是 `cancelled`，不得被改写成 `interrupted` 或 `completed`。
- 仅当 host **未**记录取消意图时，crash/重启才把 turn/job 标为 `interrupted`。
- worker 恢复后不得复活已取消的 turn。
- 现有 `SessionRunState.cancel`（`src/session/run-state.ts`）和 `session.abort` 路由（`src/server/routes/instance/session.ts`）是行为参照，不是 IPC 实现。

### 9.3 Drain

**Status: landing** — drain 帧、`ack(drained)`、worker 在途请求等待与退出码（0/70/75/78）已实现；host 侧 `SIGTERM`/`SIGKILL` 升级由调用方执行，deadline 单一事实源仍在收敛（`supervisor::DRAIN_DEADLINE_MS`、runtime alias、`worker-bootstrap::DRAIN_TIMEOUT_MS`）。

- host 在升级、重启、内存回收、shutdown 时发 `drain`；`reason` 进入审计日志。
- drain 期间 host 停止向该 worker 路由新请求；已有请求继续，直到 deadline。
- worker 必须报告 `active_sessions`、`interrupted_turns` 和最后 checkpoint；host 据此把未完成 turn 标为 `interrupted`。
- **drain 超时后的状态**：host 强制终止（`SIGTERM` → `SIGKILL`）后，该 worker 上所有非终态 turn 置 `interrupted`，job 置 `status=error` + `recovery_state=interrupted`；`recovery_state=recoverable` 只在以下条件同时成立时设置：(a) checkpoint 存在且 `resume_policy != none`；(b) `side_effect_state != unknown`（或已人工确认）；(c) 没有已持久化的 cancel intent。
- 若 turn/job 已有 cancel intent，drain 超时后的终态仍是 `cancelled`，不是 `interrupted`（§9.2）。
- drain 超时后 host 强制终止；强制终止不等于数据丢失——durable 状态以 host 最后提交为准。
- 退出码约定：`0` 正常 drain；`70` 内部错误；`75` 临时失败（可重启）；`78` 配置/协议不兼容（不自动重启）。

## 10. 错误分类

**Status (2026-10-22): partially implemented** — 帧/握手/store 错误码已实现；完整 code 表与 HTTP 映射未全部落地。

### 10.1 结构

**Status (2026-10-22): implemented** — error frame 的 `code`/`category`/`retryable`/`message`/`details` 结构已实现。

```json
{
  "code": "provider_rate_limited",
  "category": "provider",
  "retryable": true,
  "retry_after_ms": 2000,
  "message": "provider rate limited the request",
  "details": {},
  "cause_chain": []
}
```

### 10.2 类别与稳定 code

**Status (2026-10-22): partially implemented** — `FrameError`/`HandshakeRejectCode`/`StoreError` 覆盖帧、握手与持久化子集；provider/tool/permission/cancel 类别尚未接入 IPC 层。

| Category | code | retryable | 说明 |
|---|---|---|---|
| `transport` | `bad_magic` / `bad_header` / `frame_too_large` / `payload_too_large` / `decode_error` | 否 | 帧不可解析；通常关闭连接 |
| `transport` | `unsupported_protocol_version` / `unknown_capability` / `capability_missing` | 否 | 握手拒绝；可回退 legacy |
| `transport` | `handshake_timeout` / `heartbeat_timeout` / `host_lost` / `unauthorized` | 视情况 | 连接级；host 决定重连/重启 |
| `worker` | `worker_crash` / `worker_unavailable` / `spawn_failed` | 是（有退避） | 可重建 worker |
| `worker` | `stale_generation` / `worker_draining` / `worker_capacity` | 否 / 是 | fencing 与容量 |
| `protocol` | `unknown_method` / `unknown_frame_kind` / `validation_error` / `correlation_conflict` / `sequence_gap` | 否 | 请求/协议错误 |
| `protocol` | `duplicate_in_flight` | 是（按 `retry_after_ms`） | 原请求仍在执行 |
| `protocol` | `not_found` / `busy` / `idempotency_expired` | 否 | 业务前置条件 |
| `cancel` | `cancelled` / `cancel_timeout` | 否 / 视情况 | 取消结果 |
| `provider` | `provider_error` / `provider_auth` / `provider_rate_limited` / `provider_unavailable` | 按子类 | 映射到现有 provider 错误 |
| `tool` | `tool_error` / `tool_timeout` / `tool_permission_denied` | 按子类 | 工具执行 |
| `permission` | `permission_denied` / `permission_timeout` | 否 | 审批/问答 |
| `persistence` | `storage_error` / `event_log_full` / `checkpoint_failed` | 视情况 | host 侧持久化 |
| `internal` | `internal_error` / `invariant_violation` | 否 | 不应重试；记录审计 |

### 10.3 HTTP 映射

**Status (2026-10-22): not implemented (proposed)** — host 尚未代理 HTTP 路由，因此映射表尚未接线。

host 代理未迁移路由时，把 IPC error 映射为现有 HTTP 错误形状（`src/server/error.ts` 的 400/404，`NamedError.Unknown` 的 400，以及 provider/tool 现有映射）：

- `validation_error` → 400；`not_found` → 404；`permission_denied` → 403；`busy` → 409 或现有 `Session.BusyError` 的 400 语义（以现有路由为准，不擅自改状态码）；
- `worker_unavailable` / `worker_crash` → 503 + `Retry-After`；
- `cancelled` → 现有取消路径的响应，不新增对外错误类型。

映射必须在 H0 的 109 operation 清单里逐项确认；本文只给类别，不替代逐路由对账。

## 11. 重连与重放

**Status (2026-10-22): partially implemented** — worker 崩溃退避/崩溃预算已实现；host 重启 sweep 与 command replay 未实现。

### 11.1 worker 崩溃

**Status (2026-10-22): partially implemented** — 连接关闭/durable gap 会标记 worker `crashed` 并计算退避（100/500/2000/5000ms，封顶 30s）与 5 次/5 分钟暂停；checkpoint 的 `interrupted` 标记未实现。

1. host 检测 socket EOF / heartbeat 超时；
2. 把该 generation 的 in-flight request 标为 `worker_crash`；
3. 把 `running` 的 turn/job 标为 `interrupted`（可恢复的写 `recoverable` 标记；已记录 cancel intent 的仍为 `cancelled`）；
4. 递增 `worker_generation`，按退避重启：100ms、500ms、2s、5s，封顶 30s，带 jitter；
5. 5 分钟内崩溃 5 次 → 暂停该 workspace 的 worker，路由回退 legacy 或 503。

### 11.2 host 重启

**Status (2026-10-22): not implemented (proposed)** — 尚无启动时扫描 durable 表并收敛非终态行的流程。

- host 启动时读取 durable 表，把所有没有当前 live generation 的 `running` 行标为 `interrupted`；已持久化 cancel intent 的行仍标 `cancelled`；不得假定 worker 还活着。
- worker 检测到 host 断开后，在 2s 宽限内退出；退出前可写最后 checkpoint，但不得继续提交 durable 状态。
- 客户端 SSE 通过 `Last-Event-ID` + `stream_epoch` 恢复；host 从 event log 补发，不依赖 worker 内存。

### 11.3 command replay

**Status (2026-10-22): not implemented (proposed)** — 没有 `host_command_replay` 存储，也没有 worker 重连补发流程；握手只返回 `replay_available` 布尔值。

- host 为每个 workspace 保留 host→worker 的 durable command 窗口：1024 帧 / 16 MiB（**candidate default**，与参考实现的 replay journal 量级一致；最终值需 H1 benchmark 校准）。
- worker 重连时带 `resume.last_acked_command_sequence`；host 从该 `command_sequence` 之后重发 `REPLAYABLE` command，直到窗口末尾。
- 若请求的起点早于窗口最旧记录 → `replay_unavailable`：host 不再假装连续，直接把相关 in-flight command 标为失败/中断，并要求 worker 从 checkpoint 恢复或重启。
- replay 只覆盖 host→worker 的 durable command；worker→host 的 durable event 以 host 落库为准，不从 worker 重放。
- 客户端可见的 replay 由 host 的 SSE event log 负责，与 IPC replay 是两层，不混用序号。

### 11.4 现有 SSE 语义

**Status (2026-10-22): unchanged** — 现有 SSE 行为未修改；host 接管是后续里程碑。

`/event`、`/global/event` 继续由 host 终止连接，保留 heartbeat（现有 10s）、`Last-Event-ID`、`server.event-gap` 和事件名。IPC 不把每个 SSE 帧再包一层 JSON；host 只做一次事件判别和 wire serialization。

## 12. 兼容性与版本演进

**Status (2026-10-22): partially implemented** — 版本/能力演进规则已编码；编码演进与完整 kill switch 行为未落地。

### 12.1 规则

**Status (2026-10-22): implemented（版本/能力）/ partially implemented（未知字段拒绝）** — minor/major 规则与协议版本常量已实现；未知必选字段的 strict 拒绝尚未双臂统一。

- **minor**：只允许新增可选字段、可选 capability、新的 `x-` 扩展；旧端必须能忽略。默认行为不得改变。
- **major**：字段删除/重命名、语义变化、durable/transient 归属变化、编码默认值变化、frame kind 复用。
- host 在滚动升级期可同时支持 N 和 N-1 两个 major；同一连接只用一个版本。
- 未知必选字段/能力 → 拒绝；未知可选字段 → 仅在 `ext` 或明确标记 optional 时忽略。
- 协议版本不写入 SQLite 业务表；只在 host 的 worker/connection 审计表中记录，便于诊断。

### 12.2 编码演进

**Status (2026-10-22): not implemented（msgpack/CBOR）/ implemented（zstd 拒绝路径）** — 当前只用 JSON；未协商 `COMPRESSED` 返回 `decode_error`。

- v0 控制面用 canonical JSON、数据面默认 `msgpack`（双方声明后），否则 `json`；这两项都是 **proposed candidate**，需 H1 review 批准（§18 第 1 项）。
- CBOR 或其他编码延期；引入时必须作为新 capability + 新 `payload_encoding` 值，不能静默替换 `msgpack` 的字节语义。
- 压缩只允许协商后的 zstd；未协商时 `COMPRESSED` 帧返回 `decode_error`。

### 12.3 Kill switch

**Status (2026-10-22): partially implemented** — `CHIMERA_HOST_MODE` 与 `CHIMERA_HOST_IPC` 已解析并校验（默认 `legacy`/`off`）；`CHIMERA_HOST_ROUTE_<OPERATION>` 未实现，模式也尚未 gate 实际路由。

v0 需要三层开关，默认全部保守：

| 开关 | 取值 | 默认 | 作用 |
|---|---|---|---|
| `CHIMERA_HOST_MODE` | `legacy` / `proxy` / `rust` | `legacy` | 整体 host 模式；H1 退出前默认 legacy |
| `CHIMERA_HOST_IPC` | `off` / `observe` / `enforce` | `off` | IPC 是否只观测、只代理或强制 |
| `CHIMERA_HOST_ROUTE_<OPERATION>` | `legacy` / `proxy` | `legacy` | 单路由粒度回退 |

行为：

- 握手失败、版本不兼容、连续 worker crash 达阈值 → 若 `legacy_fallback=true`，回到进程内 Bun 路径；否则 503，不静默改变协议。
- `observe` 模式只记录帧和差异，不把结果作为权威响应。
- kill switch 必须可在不重启 host 的情况下通过配置重载生效（至少 `proxy`/`legacy` 的路由级切换）；进程级模式可以要求重启。
- 任何开关都不得把未知协议消息“猜”成兼容消息。

## 13. H1 durable 状态（逻辑表，不是迁移文件）

**Status (2026-10-22): implemented（六表）/ not implemented（`host_command_replay`）** — 首个 Drizzle migration `20261022022937_host_control_plane` 已创建 `host_worker`/`host_state`/`session_turn_checkpoint`/`pending_request`/`request_idempotency`/`host_event`，`HostStore` 提供读写；`host_command_replay` 仍只有逻辑定义。

H1 需要 host 侧新增/复用的逻辑存储。以下只定义职责，最终 schema 由 durable state 设计评审：

| 逻辑表 | H1 写者 | H1 读者/用途 | 与现有表的关系 |
|---|---|---|---|
| `host_worker` | host | 诊断、generation、heartbeat、drain | 新增；与 recovery matrix canonical 名称一致 |
| `host_state` | host | host generation、计数器和 fencing 审计 | 新增；与 recovery matrix canonical 名称一致 |
| `request_idempotency` | host | HTTP/IPC 可重试入口去重 | 新增；覆盖 request/response 与 HTTP 重试入口 |
| `host_command_replay` | host（IPC 层） | worker 重连时的有界 command replay | 新增；IPC 专用、可裁剪，不是业务事实源 |
| `host_event` | host | durable event、`event_seq`、`stream_epoch`、客户端补发 | 新增；只存 durable，不复制 `message`/`part` 事实 |
| `session_turn_checkpoint` | host | turn intent、提交确认、interrupted/recoverable | 新增；H3 扩展为完整 checkpoint |
| `pending_request` | host | permission/question pending 与 generation | 新增；worker 只通过 IPC 请求/回复 |
| `session` / `message` / `part` / `session_message` | Bun worker | host 只读校验；H2 才切 host 写者 | 复用 `src/storage/tables/session.sql.ts` |
| `permission` / `background_job` / `session_turn_lease` | Bun worker | host 只读/诊断；H2 才切 host 写者 | 复用现有表；H1 保持 fallback |
| H1 约束：host 只对 host-owned control tables 做 commit-before-ack；worker session 事务通过 `commit.confirm` 与 host checkpoint/event 补偿协议衔接。

## 14. 与现有 Chimera 路由/服务的对应

**Status (2026-10-22): not implemented (proposed)** — 下表是迁移目标映射；H1 尚未把任何 HTTP 路由代理到 IPC，host bin 只提供 socket + supervisor + store。

| IPC 概念 | 现有锚点 | H1 处理 |
|---|---|---|
| session prompt/abort/command/shell | `src/server/routes/instance/session.ts`（`session.prompt`、`session.prompt_async`、`session.abort` 等） | host 先代理到 worker；未迁移前不改变响应形状 |
| SSE `/event` | `src/server/routes/instance/event.ts` | host 终止连接，保留 1024 队列、10s heartbeat、gap |
| global event/delta 合并 | `src/server/global-event-stream.ts`、`src/server/event.ts` | 批量 delta 的上游；对外事件名不变 |
| permission reply/list | `src/server/routes/instance/permission.ts`、`src/permission/*` | host 持有 pending，reply 幂等 |
| question reply/reject | `src/server/routes/instance/question.ts` | 同上 |
| process registry | `src/server/routes/instance/process.ts`、`src/chimera/process-registry.ts` | H1 先只读/代理；进程所有权 H2 |
| workspace/control-plane | `src/server/routes/control/workspace.ts`、`src/control-plane/schema.ts` | host 解析 workspace 并注入 IPC 上下文 |
| background job | `src/agent/background-job.ts`、`src/agent/background-job.sql.ts` | H1 Bun 继续写投影；host 只读 generation/状态并通过 IPC 发 cancel；H2 才接管 |
| turn 互斥 | `src/session/turn-lease.ts`、`src/session/run-state.ts` | H1 Bun 持有 lease；host 只读 advisory evidence；H2 才切换 |
| auth | `src/server/auth.ts` | HTTP 鉴权留在 host；IPC 用 peer 校验 + nonce |
| storage | `src/storage/db.ts`、`src/storage/tables/*.sql.ts` | H1 host 只写 host-owned control tables；session/job/lease 仍由 Bun 写，H2 才统一 |
| graph 只读路由 | `src/server/routes/instance/graph.ts`、`src/graph/*` | H1 可先在 host 本地只读，不经 worker |

## 15. 参考实现（只读证据，不复制未验证细节）

**Status (2026-10-22): unchanged（只读参考）** — 本节不描述 Chimera 实现状态。

以下路径来自本地只读参考仓库，用于验证设计形状；本文不声称这些实现可直接复用，也不复制其内部未公开语义。

### 15.1 Codex (`/Volumes/workspace/codex/codex-rs`)

| 路径 | 可借鉴点 | 不照搬的点 |
|---|---|---|
| `app-server-protocol/src/rpc.rs` | request/response 用 `RequestId` 关联；明确“不是完整 JSON-RPC 2.0” | 不采用 JSON-RPC 方法名/错误对象作为 IPC 契约 |
| `app-server-transport/src/outgoing_message.rs` | `ConnectionId(u64)` 作为稳定连接标识 | 不把连接 id 当 generation |
| `app-server-transport/src/transport/mod.rs` | `CHANNEL_CAPACITY = 128` 的有界通道 | 不作为我们的最终队列值 |
| `app-server-transport/src/transport/unix_socket.rs` | Unix socket `0600`、父目录权限、启动锁、单帧上限声明 | 不复制其 socket 路径/锁文件布局 |
| `app-server-transport/src/daemon_recovery.rs` | 持久化 interrupted turn 快照，重启后恢复候选 | 不复制其 JSON 快照格式 |
| `app-server-transport/src/transport/remote_control/segment.rs` | 100 KiB 目标 / 150 KiB 上限分片、100 MiB 重组上限、分片数上限 | v0 只做 8 MiB/32 MiB 的更小窗口 |
| `app-server-transport/src/transport/remote_control/protocol.rs` | `ClientId`/`StreamId` 分离连接与流 | 不引入远程控制 enrollment |

### 15.2 Pinvou (`/Volumes/workspace/pinvou-agent`)

| 路径 | 可借鉴点 | 不照搬的点 |
|---|---|---|
| `remote-control-relay/PROTOCOL.md` | 精确数字 `v`、缺省/错误版本直接拒绝且不升级；显式错误码表；`stream_epoch` + `after_seq`；桌面端拥有 seq/replay journal | 它是 relay 协议，不是 host↔worker；不复制其租约/端点模型 |
| 同上 | replay journal 1024 帧 / 16 MiB，超界发 `stream_reset` 而不是伪造 gap | 我们的窗口按 workspace 计，且由 host 持有 |
| 同上 | `MAX_PAYLOAD_BYTES` 下限 4 MiB、慢消费者按 bufferedAmount 高水位终止 | v0 用 8 MiB 帧上限，具体值待压测 |
| `remote-control-relay/server.js` | 有界 endpoint/socket/ingress 常量、心跳、背压高水位 | 不复制其 relay 业务状态 |
| `CodeWhale/crates/protocol/src/runtime/mod.rs` | `schema_version` + `seq` 的事件 envelope、固定 capability map | 不复制其 HTTP API 形状 |
| `CodeWhale/crates/protocol/src/lib.rs` | `EventFrame` tagged event、approval request/reply 的 `request_id` 关联 | 不复制其完整事件枚举 |

## 16. 测试向量

**Status (2026-10-22): implemented（向量）/ not implemented（fuzz）** — `chimera-host/tests/vectors/ipc-frame-v0.hex` 有 23 条向量，Rust `ipc_frame_vectors.rs` 与 TS `ipc-frame.test.ts` 字节级对拉；跨语言 e2e 在 `e2e_bun_worker.rs`。没有独立的 fuzz/属性测试 harness。

以下向量用于 Rust/Bun 双方的协议单测和 CI parity；不执行任何新二进制。

### 16.1 Header 向量

**Status (2026-10-22): implemented** — 下列字节与 `frame.rs` 单测、TS `ipc-frame.test.ts` 一致。

一个 durable `request` 帧：connection 1、generation 7、transport_sequence 1、payload 123 字节、correlation id 为示意 UUID：

```text
43 48 49 50  00 01  40 00  02  02 00  00  7b 00 00 00
01 00 00 00 00 00 00 00
07 00 00 00 00 00 00 00
01 00 00 00 00 00 00 00
01 8f 2a 7c 3d 4e 5f 60 71 82 93 a4 b5 c6 d7 e8
00 00 00 00
00 00 00 00
```

期望：解析为 `protocol_version=0x0100`、`frame_kind=request`、`flags=DURABLE`、`payload_length=123`、`connection_id=1`、`worker_generation=7`、`sequence`（transport_sequence）=1。

### 16.2 必测场景

**Status (2026-10-22): partially implemented** — 帧级场景 1–7、16–18 已有单测；幂等/取消/drain/重连/replay/SSE 场景依赖尚未接线的上层，未作为端到端用例。

| # | 场景 | 期望 |
|---:|---|---|
| 1 | magic 错误 | `bad_magic`，不读 body，关闭 |
| 2 | `payload_length = MAX_FRAME_BYTES + 1` | `frame_too_large`，不分配 body |
| 3 | hello 版本 `min=0x0200` | `unsupported_protocol_version`，关闭 |
| 4 | hello 缺 `frame.v1` | `capability_missing`，列出缺失项 |
| 5 | hello 带未知非 `x-` 能力 | `unknown_capability`，关闭 |
| 6 | ready 前发 request | `validation_error` / 关闭 |
| 7 | 旧 generation 发 durable event | `stale_generation`，不落库 |
| 8 | 同 correlation 同 payload 重发 | 返回原响应，`idempotent_replay=true`，不重复建 job/turn |
| 9 | 同 correlation 不同 payload | `correlation_conflict` |
| 10 | durable event 落库前 worker 重发 | 只提交一次，ack 一次 |
| 11 | transient 队列溢出 | 丢最旧 delta，产生 `server.event-gap`，durable 不受影响 |
| 12 | cancel 后 worker 5s（candidate default）无响应 | host 标记 unresponsive，30s（candidate default）后终止 |
| 13 | drain 超时 | 强制终止；无 cancel intent 的 turn 标 interrupted，job `recovery_state=interrupted`；有 cancel intent 的保持 `cancelled` |
| 14 | worker crash 后重连 | 新 generation；旧 in-flight 请求 `worker_crash`；running turn interrupted |
| 15 | replay 起点早于窗口 | `replay_unavailable`，不伪造连续 |
| 16 | 未知 frame_kind | `unknown_frame_kind`，关闭 |
| 17 | `MORE` 分片超 `MAX_FRAGMENTS` | `payload_too_large` |
| 18 | `COMPRESSED` 未协商 | `decode_error` |
| 19 | 慢 SSE 客户端 | 连接级 drop + gap；durable event 仍可从 log 补发 |
| 20 | host 重启 | 无 live generation 的 running 行标 interrupted；客户端按 epoch/Last-Event-ID 恢复 |

### 16.3 Fuzz/属性测试

**Status (2026-10-22): not implemented (proposed)** — 目前只有针对截断/超限/跳号的定向单测，没有随机 fuzz 或属性测试。

- 随机截断 header/body：必须返回结构化错误或安全关闭，不得 panic/越界分配。
- 随机 `payload_length` 与 `MORE` 组合：重组上限必须生效。
- 随机 `transport_sequence` 跳号：transient 允许 gap，durable 必须拒绝。
- 幂等键随机重排：响应必须与首次一致。

## 17. H1 必做 vs 延期

**Status (2026-10-22): partially implemented** — 逐项状态见 §17.1 末尾注记。

### 17.1 v0 必做（H1 退出门的一部分）

**Status (2026-10-22): partially implemented** — 第 1–4、13（向量部分）已落地；5–9、11–12 部分落地；10 与 13（fuzz）未落地。

1. 64 字节 header、长度前缀、`MAX_FRAME_BYTES` 和分片上限。
2. `protocol_version` 协商、hello/ready/ack、显式拒绝和错误码。
3. capability 交集与按能力路由；未知必选项拒绝。
4. `connection_id`、`worker_generation`、`correlation_id`、`transport_sequence` 的生成、校验和 fencing；以及 `command_sequence` / `event_seq` 的分配与游标校验。
5. request/response/ack 控制面；`session.prompt`、`session.abort`、`permission.reply`、`question.reply`、`job.cancel` 的幂等。
6. durable/transient 边界、durable 先落库后 ack、transient 批量 delta 与 gap。
7. 有界队列与背压：只丢 transient，durable 不丢。
8. cancel 软/硬超时、drain 与强制终止。
9. worker crash/host restart 的 interrupted 标记和 generation 递增。
10. 有界 command replay 与 `replay_unavailable`。
11. 错误分类与 HTTP 映射表（按 H0 operation 清单逐项确认）。
12. kill switch：legacy/proxy/rust、observe/enforce、路由级回退。
13. 测试向量 1–20 和 framing fuzz。

**逐项状态（2026-10-22）**：1–4 implemented；5 request/response/ack 结构 implemented、入口幂等 partial；6 durable 分类 implemented、commit-before-ack landing、批量 msgpack 未实现；7 队列 partial；8 cancel/drain partial（drain 实现、cancel 执行与超时未接线）；9 worker crash 退避 implemented、host restart sweep 未实现；10 command replay 未实现；11 错误分类 partial、HTTP 映射未实现；12 kill switch 解析 implemented、路由级与行为 gate 未实现；13 向量 implemented、fuzz 未实现。

### 17.2 延期（不在 H1 承诺）

**Status (2026-10-22): unchanged** — 以下仍未实现。

- 共享内存/零拷贝、临时文件句柄传输大附件；
- zstd 之外的压缩、CBOR 编码；
- 多 worker 负载均衡、跨 workspace worker 池；
- TCP/远程 transport、跨主机 replay；
- PTY WebSocket 字节帧经 IPC 转发（H1 先由 host 终止并保留现有 PTY owner）；
- 完整 turn checkpoint（H3 扩展）；
- provider 流式协议直通、Rust plugin ABI；
- Rust SDK 生成和对外 API 变更；
- 生产级 Windows named pipe ACL 细化（v0 只要求同用户可访问）；
- 精确容量值、队列深度、超时的最终调参（需 H1 压测）。

## 18. 未决问题（交父级/评审）

1. 编码选型（**proposed candidate**）：控制面 canonical JSON 与数据面 msgpack 都是本文推荐、待 H1 review 批准的候选，不是冻结事实；若评审改选 CBOR 或全 msgpack，需要改 `payload_encoding` 枚举、canonical 规则和测试向量，并同步回写主计划 §4.1。**当前实现默认行为**：控制面统一 JSON；数据面只用 `json`；`encoding.msgpack` 可协商但没有编解码器。
2. worker 粒度（每 workspace / 每 N session / 每 turn）按迁移计划 §9.1 仍未拍板；本文假设“workspace 绑定 + 硬上限”，但协议本身不绑定粒度。**当前实现默认行为**：每个 workspace 一条 spawn intent/一个 worker；soft/hard limit 只解析不强制。
3. host durable store 是否复用现有 SQLite/WAL 事实源（计划建议复用）还是先独立 host DB；本文按复用设计表关系。**当前实现默认行为**：复用主库，host 控制表由 Drizzle migration 创建，`HostStore` 只打开不迁移。
4. `MAX_FRAME_BYTES`、replay 窗口、队列上限的最终值需要 H1 压测；本文数值只用于实现起点。**当前实现默认行为**：使用本文 candidate defaults（8 MiB / 32 MiB / 256 片等），未做校准。
5. H1 是否只代理 `chimera web`，还是同时覆盖 CLI/graph daemon；协议不区分调用方，但 capability 路由需要该决定。**当前实现默认行为**：只有独立 host bin + 隐藏 `bun-worker`，没有 HTTP/CLI 路由代理。
6. 取消后的 turn 状态对外如何呈现（现有 `session.error` / interrupted 语义）需要在 H0 状态机对账中确认。**当前实现默认行为**：host 可发 `cancel` 帧；worker 尚未处理 cancel，终态呈现未接线。
7. `host_event.durability` 的取值集合：本文口径是 control 不进 `host_event`（§8.4），但 `recovery-matrix.md` §8.5 允许 `durable|control`；需在 H1 review 时统一，并与主计划 §4.1 同步。**当前实现默认行为**：`host_event` 没有 `durability` 列，只有 durable event 由调用方写入；control/transient 不落表。
8. 本文 §0.4 列出的 5 项 delta（64 字节 header、session/job 移 body、`replay` frame、编码、三层序号）需主计划 owner 批准；未批准前不进入实现。**当前实现默认行为**：实现已按这 5 项 delta 落地；主计划正文回写待 owner 确认。

## 19. 非声明

- 本文现在描述 H1 已落地实现与仍在 landing 的部分；不是“零实现”声明。
- H1 已构建并执行 host/worker 二进制；transport 端到端验证在 CI 的 Unix 腿执行。
- 文中出现的 Codex/Pinvou 路径仅作只读参考，不表示其实现细节已被验证为可直接复用。
- 文中所有数值仍是 candidate default；在 H1 压测校准前不得当作已批准容量或对外承诺。