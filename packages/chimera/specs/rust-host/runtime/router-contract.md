# WP-07 router 契约：front door 受控扩面与 96 条路由边界

> 状态：契约稿（WP-07，2026-10-30）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md` §1（H1 定位）、§4（终态架构）、§6 W2（front door 受控扩面）、§7（DAG）、§8（WP-04/WP-07）、§10（门禁）；`packages/chimera/specs/rust-host/h2-data-plane.md:229-380`；`manifest.yaml`（`contract_rev = cr-2026-10-30-r1`）。
> 范围：router 契约与 front door 扩面边界；不实现生产 router、不接任何真实路由。

## 0. 术语

| 术语 | 定义 |
|---|---|
| front door | 对外 HTTP/HTTPS 入口；当前是 Bun 进程内 `Server.listen`，目标是 Rust host。 |
| route | 一个 OpenAPI operation（`operationId` + method + path）。 |
| router | host 内把请求分类、选 worker、转发、回写响应的组件；H1 只有 `RequestRouter` trait。 |
| capability | `hello`/`ready` 协商的能力字符串（`session.runtime`、`provider.stream`、`tool.exec`、`graph.read` 等）。 |
| host-first | inventory 的初步分类：可优先由 host 承载；**不是**已批准的 allowlist。 |
| proxy-first | 需要 TS session/provider/plugin 语义，先由 host 代理到 Bun。 |
| special | SSE/WS/LSP 等特殊传输，单独设计。 |

## 1. 当前事实（H0 inventory 与 H1 router）

### 1.1 inventory 计数

`packages/chimera/test/fixtures/httpapi-inventory.json` 的当前冻结值：

| 指标 | 值 |
|---|---:|
| pathCount | 142 |
| operationCount | 170 |
| migrationClass host-first | 96 |
| migrationClass proxy-first | 50 |
| migrationClass special | 24 |
| parityCoverage exercise | 116 |
| parityCoverage none | 54 |

来源：`packages/chimera/script/httpapi-inventory.ts:30,107-130,133-204`；fixture 由 `Server.openapi()` 生成（`httpapi-inventory.ts:1-18`）。该分类是 **H0 first-pass freeze**，不是已批准实现计划（`httpapi-inventory.ts:14-17`）。

### 1.2 96 的含义

- “96”是 inventory 的 **初步 host-first 计数**，不是“96 条已可接”的清单。
- 其中包含 session 元数据/消息读取（`session.list`/`session.get`/`session.messages`/`v2.session.messages` 等，`httpapi-inventory.ts:140-165`），这些路由虽然读 durable state，但仍依赖 session 存储语义与目录/workspace 解析。
- `a0-scope-decisions.md:53` 明确“不接 96 条会话依赖路由”；本契约把它解释为：**首批不得整批接入 96 条初步 host-first 路由**；WP-04 必须按真实依赖重新分诊，产出 host-first / 依赖 session 二分清单（`RUST_FULL_MIGRATION_PLAN.md:258`）。
- 在 WP-04 产出 allowlist 前，任何具体 operation id 都不得被冻结为首批。

### 1.3 H1 router 现状

| 事实 | 证据 | 影响 |
|---|---|---|
| `RequestRouter` trait 存在 | `chimera-host/src/host_driver.rs:541-543` | 路由接口可被实现。 |
| driver 对每个 request 调用 `router.route` | `chimera-host/src/host_driver.rs:1382-1400` | 请求不会静默丢失；至少得到 response。 |
| bin 的 router 是 `Unrouted` | `chimera-host/src/bin/chimera-host.rs:194-207,315` | 所有请求返回 `not_implemented`；没有 worker 路由。 |
| 没有 HTTP listener | `chimera-host/` 无 HTTP server；TS `Server.listen` 仍是 front door（`packages/chimera/src/server/server.ts:199-237`） | W2 前不存在 host front door。 |
| 没有 capability→worker 路由表 | `host_driver.rs` 只有单连接 `route`；bin 不按 method/capability 选连接 | 多 worker 路由未实现。 |
| 没有 route-level kill switch | `h2-data-plane.md:470-492` 仍是设计 | `CHIMERA_HOST_ROUTE_*` 未实现。 |

## 2. Front door 受控扩面边界

### 2.1 首批允许的范围（建议）

首批 front door 只允许 **不依赖 TS session 语义、且有独立 parity 判据** 的路由。建议按以下层级准入：

| 层 | 类别 | 例子（仅类别，不冻结 operation id） | 首批 |
|---|---|---|---|
| L0 | 进程健康/版本/能力 | health、version、capability 自描述 | 允许（需 parity fixture） |
| L1 | 只读、无 session/provider/plugin 依赖 | 纯静态/元数据读取 | 逐条评审后允许 |
| L2 | durable 控制面读写 | project/workspace 元数据 | 需 WP-05 存储权威 + WP-04 allowlist |
| L3 | session 元数据/消息读取 | session.list/get/messages | **不在首批**；需 WP-05/WP-10 |
| L4 | session 执行 | prompt/command/shell/abort、tool 执行 | **不在首批**；W3 闭环后 |
| L5 | provider/permission/question/pty/mcp/sync/tui/v2 执行 | 对应 group | **不在首批**；按能力域单独迁移 |
| L6 | SSE/WS 特殊传输 | event.subscribe、global.event、pty.connect | **不在首批**；单独设计 gap/replay |

### 2.2 路由准入判据（C1–C8）

一个 route 只有同时满足以下条件才可进入 allowlist：

| 编号 | 判据 | 证据要求 |
|---|---|---|
| C1 | 不依赖 `Session`/`SessionPrompt`/`Provider`/`ToolRegistry`/`Permission`/`Question`/`BackgroundJob` 运行时对象 | 代码调用链审查 |
| C2 | 不写 session/message/part/turn/lease 事实 | 存储矩阵 + 代码审查 |
| C3 | 不需要 provider transport、plugin hook、PTY/LSP/browser 执行器 | 依赖清单 |
| C4 | auth/directory/workspace 语义已冻结，且有 parity fixture | WP-04 inventory + exercise |
| C5 | 有独立 kill switch（route 或 plane） | 配置矩阵 |
| C6 | 有 TS fallback，且回退不需要 down migration | 回退演练 |
| C7 | 有 W0 确定性/因果 oracle（至少 golden + 负例） | WP-02/WP-03 |
| C8 | OpenAPI 字节/结构不漂移 | WP-04 漂移门 |

### 2.3 明确不在首批的路由族

以下 group 在 inventory 中已标为 `proxy-first` 或 `special`，首批不得接入：

| group | inventory 分类 | 原因 | 证据 |
|---|---|---|---|
| `session` 执行类 | proxy-first（元数据读取有 host-first override） | 依赖 TS session/agent loop | `httpapi-inventory.ts:123,140-165` |
| `provider` | proxy-first | provider transport/auth 未迁移 | `httpapi-inventory.ts:120` |
| `permission` / `question` | proxy-first | pending request/交互语义在 worker | `httpapi-inventory.ts:117,122` |
| `mcp` | proxy-first | MCP 三 transport/OAuth 未迁移 | `httpapi-inventory.ts:115` |
| `sync` | proxy-first | sync 服务仍是 TS | `httpapi-inventory.ts:124` |
| `tui` | special | TUI 控制面 | `httpapi-inventory.ts:125` |
| `v2` / `v2 credentials` / `v2 integrations` / `v2 messages` | proxy-first | v2 session 语义 | `httpapi-inventory.ts:126-129` |
| `event` / `pty` | special | SSE/WS 传输与恢复 | `httpapi-inventory.ts:109,121`；`SPECIAL_OPERATIONS` `:136` |

## 3. Router 契约

### 3.1 请求生命周期

```text
HTTP request
  └─ auth / directory / workspace 解析
      └─ route 分类（operationId → class）
          ├─ 未准入 → route_not_admitted（不转发、不静默）
          ├─ proxy-first → 转发给具备对应 capability 的 worker
          ├─ host-first → host 本地处理或转发
          └─ special → 单独 transport 路径
              └─ 选 worker（workspace + current generation + capability）
                  ├─ 无可用 worker → worker_unavailable（retryable）或 legacy
                  └─ 有 worker → 写 request frame → 等 response → 回写 HTTP
```

### 3.2 契约条目

| 编号 | 契约 | 判定 |
|---|---|---|
| R-RT-1 | 每个请求必须恰好得到一个结果：response、结构化 error 或连接关闭；不得静默丢弃 | 请求计数 = response + error + close |
| R-RT-2 | 分类必须先于转发；未准入 route 返回 `route_not_admitted`，不得“先转发再判断” | 错误码稳定 |
| R-RT-3 | 只把请求发给声明了所需 capability 且 generation 当前的 worker | capability/generation 校验 |
| R-RT-4 | 不跨 workspace 复用 worker；workspace 解析失败返回 `workspace_not_found`/`validation_error` | 路由隔离 |
| R-RT-5 | 旧 generation 的 frame 必须被丢弃并计数；不得写入当前事实 | fencing 计数 |
| R-RT-6 | 可重试入口必须带 idempotency key；重复请求返回同一结果，不重复执行副作用 | `request_idempotency` |
| R-RT-7 | durable event 必须 commit-before-ack；transient 可丢但必须计数/gap | 提交顺序 |
| R-RT-8 | 背压只丢 transient；durable 不得丢；队列有界并暴露深度 | 队列指标 |
| R-RT-9 | drain 期间拒绝新请求（`worker_draining`）；在途请求按 deadline 收敛 | drain 状态 |
| R-RT-10 | `rust` 模式不得静默回退 legacy；`proxy` 模式可逐 route 回退并记录 | 模式矩阵 |
| R-RT-11 | 所有错误码稳定、可分类、可重试性明确；不得把内部错误文本直接暴露给客户端 | 错误码表 |
| R-RT-12 | router 必须暴露按 route/worker 的计数：admitted、proxied、rejected、worker_unavailable、fenced、draining | 指标可观测 |

### 3.3 错误码（建议最小集）

| code | 场景 | retryable | HTTP 映射（建议） |
|---|---|---|---|
| `not_implemented` | H1 `Unrouted` 占位 | false | 501 |
| `route_not_admitted` | 不在 allowlist | false | 404/403（按信息暴露策略） |
| `worker_unavailable` | 无具备 capability 的当前 worker | true | 503 |
| `worker_draining` | worker 正在 drain | true | 503 |
| `capability_missing` | 握手能力不足 | false | 500/503 |
| `unauthorized` | nonce/peer 校验失败 | false | 401 |
| `validation_error` | 请求体/header 不合法 | false | 400 |
| `storage_busy` | SQLite busy 重试耗尽 | true | 503 |
| `replay_unavailable` | command replay 窗口外 | false | 409/410 |
| `stream_reset` | SSE 恢复窗口外 | false | 409（SSE 事件） |

错误结构以 `ipc-v0.md:795-842` 为准；HTTP 映射只是建议，最终由 WP-04 的 OpenAPI 契约冻结。

### 3.4 capability 路由

- `hello` 的 capability 集合决定 worker 能接哪些 route（`ipc-v0.md:570-598`）。
- 必需能力：`frame.v1`、`control.json`、`event.batch`、`cancel`、`drain`、`replay.command`。
- 按路由能力：`session.runtime`、`provider.stream`、`tool.exec`、`plugin.loader`、`graph.read`、`graph.watch`、`storage.write`、`static.serve`、`sse.fanout`、`workspace.control`、`process.registry`、`worker.policy`（H2 §0.1）。
- 没有匹配 worker 时：`worker_unavailable` 或按 route 回退 legacy；不得把请求发给“能力不符但 generation 最新”的 worker。

### 3.5 generation fencing 与 sequence

- `worker_generation` 单调递增；旧 generation 的 request/event 必须拒绝或丢弃（`ipc-v0.md:647-659`）。
- `transport_sequence` 连续性由 connection 层校验；durable gap 触发 crash 处理（`host_driver.rs` 的 `SequenceGap` 路径）。
- `event_seq` 只用于 durable event 的聚合游标；不得与 `transport_sequence` 互推。
- `command_sequence` 当前未实现（`h2-data-plane.md:775` D5）；replay 契约见 R-RT-6/R-RT-11。

## 4. Front door HTTP 契约

| 编号 | 契约 | 判定 |
|---|---|---|
| R-FD-1 | OpenAPI 是唯一事实源；host front door 不得增删/改形状 | WP-04 漂移门零 diff |
| R-FD-2 | 认证沿用 Basic auth；用户名默认 `chimera`，密码来自 `OPENCODE_SERVER_PASSWORD` | 401/200 行为一致 |
| R-FD-3 | directory/workspace header 解析与 TS 现行为一致；不得把未解析目录当默认目录 | parity fixture |
| R-FD-4 | SSE/WS 是 special；不得用普通 request/response 路由承载 | 传输分类 |
| R-FD-5 | `Last-Event-ID`/`replay`/`retention_floor`/`reset` 是新增能力，必须单独标注，不冒充旧 parity | 文档/测试标签 |
| R-FD-6 | 错误体、状态码、content-type 与 TS 双臂对账 | `httpapi-exercise` 扩展 |
| R-FD-7 | host front door 不创建/迁移图数据；只读请求不初始化 `.chimera/`/`.codegraph/` | 目录快照 |

## 5. 扩面阶段

| 阶段 | 范围 | 进入条件 | 回退 |
|---|---|---|---|
| E0 | TS front door（当前） | 无 | — |
| E1 | host front door 仅 L0/L1，`proxy` 模式，TS 权威 | T1 + W0 G0 + WP-04 allowlist | 逐 route legacy |
| E2 | L0/L1/L2 在 `rust` 模式权威 | E1 parity 零 diff + WP-05 存储矩阵 | route/plane kill switch |
| E3 | session 元数据读取（L3） | WP-05 + WP-10 fixture + W0 因果层 | 逐 route legacy |
| E4 | session 执行（L4） | W3 闭环 + provider/hook/W0 fault matrix | 整波回退到 E2 |

**硬边界**：E1/E2 不得包含 L3–L6；96 条初步 host-first 不得整批进入 E1/E2。E3/E4 的 allowlist 必须由 WP-04 重分诊 + WP-05/WP-10 证据支撑。

## 6. 当前缺口与验收

| 缺口 | 证据 | 验收 |
|---|---|---|
| bin 仍是 `Unrouted` | `chimera-host/src/bin/chimera-host.rs:194-207,315` | `RT-BOOT-002` 源码探针 |
| 无 HTTP listener | `chimera-host/` 无 HTTP server | `RT-BOOT-003` 源码探针 |
| 无 route allowlist | 本文件只给判据，未冻结 id | WP-04 产出清单后补 fixture |
| 无 route-level kill switch | `h2-data-plane.md:470-492` | G12 |
| 无 capability→worker 路由 | `host_driver.rs` 单连接 route | 多 worker 集成 fixture |
| 无 SSE/WS front door | `ipc-v0.md:876-880` 仍是现状 | W2/W3 单独验收 |

## 7. 建议与待拍板

### 7.1 建议

- **RT-S1**：把 `route_not_admitted` 作为默认拒绝，而不是默认转发；首批 allowlist 之外的 route 一律显式拒绝。
- **RT-S2**：`proxy` 模式也必须逐 route 记录“为什么回退”，不能只记全局计数。
- **RT-S3**：在 E1 前先冻结 `operationId → class → capability → fallback` 四列 fixture；没有 fixture 的 route 不得进入 allowlist。
- **RT-S4**：SSE/WS 的 gap/replay 作为独立能力立项，不与普通 route 的 parity 混算。

### 7.2 待拍板

- **96 条重分诊结果**：WP-04 产出 host-first / 依赖 session 二分清单后，才能冻结 E1/E2 allowlist。
- **E1 的首批 operation 集合**：本文只给类别与判据，不列具体 id。
- **`route_not_admitted` 的 HTTP 映射**：404 还是 403，需与 OpenAPI/安全策略一起定。
- **route-level kill switch 的热重载机制**：`host_state.config_revision` 轮询 vs 控制 socket，需 H2 设计评审。