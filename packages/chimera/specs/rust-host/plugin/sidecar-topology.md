# WP-09 · JS 兼容拓扑：plugin-only Bun sidecar 与 IPC 契约

> 状态：**building 交付物**（WP-09，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:63-65`（终态与“删除 Bun session worker”决策）、`:92-114`（终态架构图）、`:129`（plugin loader/SDK 长期 Bun sidecar）、`:181`（W3 最小真实 hook sidecar）、`:200-202`（W5 生态硬化）、`:263`（WP-09 DoD）、`:353`（D2 单/双 sidecar 待拍板）；`packages/chimera/specs/rust-host/ipc-v0.md`（transport/帧/取消/drain/崩溃）；`packages/chimera/src/host/ipc-handshake.ts:40-60`（`plugin.loader` capability 已存在）。
> 本文是**契约与建议**，不实现生产 sidecar。标“建议”的数值/策略未拍板；标“待拍板”的拓扑选择由 §13 D2 决定。

## 0. 结论先行

- **一个 workspace 一个 plugin-only Bun sidecar（建议）**：sidecar 只加载插件、持有 `Hooks`、执行 hook 回调和插件定义的工具体；不承载 session/agent loop、历史、prompt 组装、provider transport、权限决策、工具调度、存储或 HTTP。
- **IPC 复用 ipc-v0 的 framed transport**：Unix domain socket（Windows named pipe），能力位 `plugin.loader`（`ipc-handshake.ts:57`），不监听 TCP（`ipc-v0.md:132-136`）。host 与 sidecar 双向 `request/response`；hook 内调用 SDK 走 sidecar → host 的嵌套请求。
- **host 是唯一权威**：顺序、deadline、取消意图、最终状态、auth store、config 写入、结果落库都由 host 决定；sidecar 返回“提议的 mutation + trace”，host 决定是否提交。这样崩溃/超时不会让 sidecar 成为第二事实源。
- **npm 单一 owner = sidecar**：只有 sidecar 调用 npm resolve/install、写 plugin-meta、打 config patch；host 永不执行 npm，也不写 plugin-meta。文件锁（`meta.ts:54-60`、`install.ts:344-349`）是跨进程兜底，不是多 owner 许可。
- **plugin-only 边界是硬约束**：sidecar 不持有 DB/HTTP listener/graph/MCP/session 状态；插件定义的工具体可以在 sidecar 执行，但工具循环、权限、结果持久化仍在 host。与计划 §2 决策 3 一致（`RUST_FULL_MIGRATION_PLAN.md:65`）。

## 1. 进程边界

### 1.1 拓扑

```text
┌────────────────────────────── Rust host（唯一长驻主进程） ──────────────────────────────┐
│ HTTP/OpenAPI · session runtime · prompt assembly · tool loop · permission · storage      │
│ auth store（唯一 writer） · config store（唯一 writer） · graph/MCP · SSE/事件 fan-out     │
│                                                                                          │
│   plugin 客户端（窄 RPC）                                                                 │
└───────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ ipc-v0 framed transport（Unix socket / named pipe；无 TCP）
                │ capability: plugin.loader
┌───────────────┴──────────────────────────────────────────────────────────────────────────┐
│ Bun plugin-host sidecar（每 workspace 一个，建议）                                          │
│  · 动态 ESM import + npm resolve/install（唯一 owner）                                     │
│  · 持有 Hooks 对象、按注册顺序执行 hook 回调                                                │
│  · 执行插件注册的工具体（plugin-defined tool body），但不拥有工具循环/权限/结果落库          │
│  · 通过 host RPC 读写 auth/config、调用 host SDK（session.message/session.get/auth.set…）   │
│  · 不持有 session 历史、DB、HTTP listener、graph、MCP、provider transport                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 进程生命周期

| 阶段 | 契约 | 证据/说明 |
|---|---|---|
| 启动 | host 在第一次需要插件时懒启动 sidecar；通过继承环境传 `CHIMERA_HOST_SOCKET` + 一次性 nonce（不写 argv/日志） | `ipc-v0.md:136` |
| 握手 | sidecar → host `hello`（runtime `bun`、protocol 1.x、capabilities 含 `plugin.loader`）；host → `ready` 或结构化拒绝 | `ipc-handshake.ts:105-153,241-310` |
| 加载 | host 发 `plugin.load`；sidecar 按“内置插件固定顺序 → 外部插件配置顺序”注册，返回插件清单与 degraded 列表 | 现状顺序见 `plugin/index.ts:97-108,190-205,249-272` |
| 运行 | host 发 `plugin.hook` / `plugin.tool.execute` / `plugin.event`；sidecar 返回 mutation + trace | 本文 §2 |
| 关闭 | host 发 `drain`；sidecar 等待在途 hook/工具回调，返回 `ack(drained)`，退出码 0/70/75/78 | `ipc-v0.md:779-789` |
| 崩溃 | host 按 worker crash 处理：in-flight 请求失败、generation 递增、退避重启；5 分钟 5 次崩溃暂停该 workspace 的插件面 | `ipc-v0.md:848-856` |

### 1.3 单 sidecar 还是多 sidecar（待拍板 D2）

| 方案 | 优点 | 风险 | 建议 |
|---|---|---|---|
| 每 workspace 一个 sidecar | 插件 `PluginInput` 是 workspace 作用域（`packages/plugin/src/index.ts:58-68`：`project/directory/worktree/client`）；`Plugin` state 本来就是 `InstanceState` per-directory（`plugin/index.ts:156-160`）；崩溃隔离好 | 多 workspace 时进程数上升；npm 全局缓存/plugin-meta 需要文件锁串行 | **建议 v0 采用** |
| 一个 sidecar 多 workspace 复用 | 进程数少；npm 缓存集中 | 插件模块可能在 init 时捕获 directory；per-workspace `Hooks` 状态需要显式隔离；一个插件崩溃影响所有 workspace | 作为 D2 的备选，不在 v0 默认 |

> 待拍板：`RUST_FULL_MIGRATION_PLAN.md:353` D2 明确“plugin + 长尾 provider + orchestrate sandbox 是单 sidecar 还是双 sidecar”未定。本文只固定“plugin sidecar 不承载 session/agent loop”，不替 D2 决定是否与长尾 provider 共用进程。若共用，provider transport 仍不得把 session 状态放进 sidecar。

## 2. IPC 通道

### 2.1 复用 ipc-v0，不另造协议

- 帧格式、header、分片、CRC、上限、握手、取消、drain、错误分类全部复用 `ipc-v0.md` §3–§11；plugin 面只增加**方法 allowlist**和 **plugin 专用 body**。
- 能力位：`plugin.loader` 已在 `KNOWN_CAPABILITIES`（`packages/chimera/src/host/ipc-handshake.ts:50-60`），host 的 v0 可路由能力包含它（`:62-63`）。
- 编码：控制面 canonical JSON；hook 的 input/output 是 JSON 值（见 `trajectory-format.md` 的 Json 规则）。大文本/二进制走 ipc-v0 §4.3 的引用/分片，不塞进控制 body。
- 关联：每个请求带 `id`，header 的 `correlation_id` 必须一致（`ipc-v0.md:383-406`）；hook 的 `call_id`/`scope` 放在 body，不替代 `id`。

### 2.2 方法 allowlist（建议）

Host → sidecar：

| method | 用途 | 关键参数 | 返回 |
|---|---|---|---|
| `plugin.load` | 加载/重载插件 | `workspace`, `origins`, `pure`, `deadline_ms` | `{plugins:[{plugin_id,origin,order,hooks}], degraded:[...]}` |
| `plugin.list` | 读取当前插件清单/状态 | `workspace` | 同上（只读） |
| `plugin.hook` | 执行一个 hook 名 + 一个 scope | `hook`, `scope`, `call_id`, `input`, `output`, `deadline_ms` | `{status, output, trace, error_code}` |
| `plugin.tool.execute` | 执行插件注册的工具体 | `tool_id`, `args`, `context`, `deadline_ms` | `{output, metadata}` |
| `plugin.event` | 投递总线事件给 `event` hook | `event` | `{status}`（host 可不等待） |
| `plugin.dispose` | 实例关闭 | `workspace` | `{status}` |

Sidecar → host（嵌套请求）：

| method | 用途 | 约束 |
|---|---|---|
| `auth.get` | 读取凭据 | 只读；返回 `Auth.Info \| null` |
| `auth.set` | refresh 后写回 | 唯一 writer 是 host；sidecar 只能通过该 RPC 请求写入 |
| `config.get` | 读取当前 config 快照 | 只读；config 写入仍由 host 的 `config` hook 提交流程完成 |
| `sdk.call` | 代理插件 `input.client.*` 调用 | 方法 allowlist 由 WP-04 的 operation 清单收敛；v0 至少允许 `session.message`、`session.get`、`auth.set`（现状证据：`copilot.ts:60,376-412`；`codex.ts:538-547`） |

> 建议：`sdk.call` 的 allowlist 按 hook 类进一步收窄（例如 `auth.set` 只允许在 `auth.refresh` 内；`session.message/get` 只允许只读 hook）。未知方法返回 `unknown_method`，不转发到任意 HTTP。

### 2.3 `plugin.hook` body（建议）

```json
{
  "v": 1,
  "kind": "request",
  "id": "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a",
  "method": "plugin.hook",
  "deadline_ms": 5000,
  "params": {
    "workspace": "synthetic://workspace",
    "hook": "chat.headers",
    "scope": "headers:op-llm",
    "call_id": null,
    "plugin_order": ["builtin.codex-auth", "demo.alpha", "demo.beta"],
    "input": { "session_id": "ses_synthetic", "agent": "build" },
    "output": { "headers": {} }
  }
}
```

返回：

```json
{
  "v": 1,
  "kind": "response",
  "id": "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a",
  "status": "ok",
  "result": {
    "status": "ok",
    "output": { "headers": { "x-synthetic-auth": "oauth" } },
    "trace": [
      { "plugin_id": "builtin.codex-auth", "status": "ok" },
      { "plugin_id": "demo.alpha", "status": "ok" },
      { "plugin_id": "demo.beta", "status": "ok" }
    ],
    "error_code": null
  },
  "error": null
}
```

- `plugin_order` 由 host 从 `plugin.load` 的注册顺序复制，sidecar 必须按该顺序执行；sidecar 不能自行重排。
- `trace` 是 host 写轨迹 fixture 的最小事实：每个插件的开始/结束/错误码；更细的 mutation 由 sidecar 在 `trace` 中返回 `mutations:[{path,before,after}]`（可选，受 body 上限约束）。
- `status: "error"` 时 `output` 仍是“失败前最后一次成功的共享对象”，host 必须按失败策略丢弃/失败，不能当成成功结果。

### 2.4 重入（必须显式支持）

插件 hook 可以调用 `input.client.*`。现状证据：

- `github-copilot` 的 `chat.headers` 在 hook 内调用 `sdk.session.message` 与 `sdk.session.get`（`packages/chimera/src/plugin/github-copilot/copilot.ts:376-412`）。
- `codex`/`xai` 的 refresh 在 fetch 覆盖内调用 `input.client.auth.set`（`codex.ts:538-547`；`xai.ts:253-263`）。

因此：

- host 在等待 `plugin.hook` 响应时，必须继续处理 sidecar 发来的嵌套 `request`；不能用一个全局锁把入站请求串行化。
- 嵌套请求的 `correlation_id` 与外层 hook 请求不同；host 用 `id` 关联，不靠“当前只有一个请求”的假设。
- 嵌套请求的完成必须早于外层 hook 响应；sidecar 在 hook 内 await 嵌套调用，host 不能在嵌套请求未完成时提前返回外层成功。
- 轨迹用 `sdk.call` 事件记录嵌套调用（`trajectory-format.md` §3）；verifier 断言它发生在 hook.start 与 hook.end 之间。
- 死锁规避：host 的 IPC reader 与业务 await 必须分离（reader task 只负责分发/写响应，业务 task 等待 hook）。如果 host 在单线程事件循环里同步等待 hook，嵌套请求永远无法被服务。

### 2.5 事件与顺序

- `event` hook 是 fire-and-forget（现状 `plugin/index.ts:299-308`）；host 发 `plugin.event` 后可以不等待响应，但 sidecar 必须捕获 rejection 并在 `plugin.status`/日志中体现。
- `plugin.hook` 的并发：host 可以对不同 scope 并发发请求（例如不同 toolID 的 `tool.definition`）；sidecar 可以交错执行，但**同一 scope 内必须串行**。这与现状 `registry.tools()` 的 `concurrency: "unbounded"` + per-tool 串行一致（`registry.ts:523-548`）。
- `chat.params` 必须先于 `chat.headers`；host 不要并发发这两个请求（现状调用点顺序 `llm.ts:408-442`）。

## 3. 超时与崩溃策略

### 3.1 超时（建议值，待 H1/H0 校准）

| hook 类 | 建议 soft deadline | 超时后的 host 行为 | 依据 |
|---|---:|---|---|
| `config` | 10s | 该插件记为 degraded，继续其他插件与 bootstrap | 现状 config 失败被忽略（`plugin/index.ts:275-282`） |
| `tool.definition` | 2s | 工具列表构建失败；不缓存 | 现状无 catch（`registry.ts:531`） |
| `chat.params` / `chat.headers` | 2s | 请求失败；不发送 | 现状无 catch（`llm.ts:408-442`） |
| `tool.execute.before` | 5s | 工具不执行；`failToolCall` | `executeGuarded` 的 abort grace 是现状参照（`prompt.ts:1249-1265`） |
| `tool.execute.after` | 5s | 调用标记失败；记录 `side_effect_state: unknown` | 工具体可能已执行（`prompt.ts:1330-1348`） |
| `auth.loader` | 10s | provider state 初始化失败；不静默降级 | 现状 defect（`provider.ts:2040-2045`） |
| `auth.refresh` | 30s | 请求失败；不回退 stale token；`auth.set` 失败显式上报 | refresh 是网络操作（`codex.ts:525-561`） |

> 这些数值是**建议**，不是已批准容量。`ipc-v0.md:240` 明确所有 candidate default 都要由 H0/H1 校准；WP-09 只给起点，不把任何一个当承诺。

### 3.2 崩溃矩阵

| 崩溃时机 | host 行为 | 是否自动重试 |
|---|---|---|
| `plugin.load` / `config` 期间 | 外部插件面降级为“未加载”；内置插件若已在 sidecar 内也一并丢失；bootstrap 继续；显式 `plugin_degraded` 状态 | 否（下次显式 reload） |
| `tool.definition` | 工具列表构建失败；该轮失败 | 只读 hook，可重试 1 次（重启后） |
| `chat.params` / `chat.headers` | 请求失败 | 只读 hook，可重试 1 次 |
| `tool.execute.before` | 工具不执行；调用失败 | **否**（避免重复副作用） |
| `tool.execute.after` | 工具体可能已执行；调用标记失败；记录 `side_effect_state: unknown` | **否** |
| `auth.loader` | provider state 初始化失败 | 否（重启后下一次 `Provider.list` 自然重跑） |
| `auth.refresh` | 请求失败；已发出的 refresh 可能已被 provider 消费；不回退 stale token | **否**；记录 `auth_refresh_unknown` |
| `plugin.event` | 事件丢失；记录 dropped 计数 | 否（fire-and-forget 语义） |

崩溃后的重启遵循 ipc-v0：100ms/500ms/2s/5s，封顶 30s，5 分钟 5 次暂停（`ipc-v0.md:848-856`）。sidecar 重启后必须重新 `plugin.load`；hook 注册顺序从 `plugin.load` 重新建立，host 不能复用旧 generation 的 trace。

### 3.3 失败码

建议稳定错误码（host 侧对外）：

| 场景 | code | retryable |
|---|---|---|
| sidecar 崩溃 | `plugin_worker_crash` | 视 hook 类（见上） |
| hook 超时 | `plugin_hook_timeout` | 视 hook 类 |
| hook 抛错 | `plugin_hook_failed` | 否 |
| 插件加载/安装失败 | `plugin_load_failed` / `plugin_install_failed` | 安装失败可按退避重试一次 |
| 版本不兼容 | `plugin_incompatible` | 否 |
| auth refresh 持久化失败 | `plugin_auth_refresh_persist_failed` | 否（需重新登录/人工处理） |
| 未知 SDK 方法 | `unknown_method` | 否（ipc-v0 已有该码，`ipc-v0.md:822`） |

## 4. npm 包单一 owner

### 4.1 owner 边界

| 动作 | 唯一 owner | 证据 |
|---|---|---|
| npm resolve/install | plugin sidecar（`Npm.add`） | 现状 `plugin/index.ts:160` 的 `resolveTarget`；`loader.ts:193-228` |
| 动态 ESM import | plugin sidecar | 现状 `loader.ts:121-130` |
| plugin-meta 读写 | plugin sidecar | `meta.ts:50-60`（store path + flock） |
| 插件 config patch | plugin sidecar（写），host 只读 config | `install.ts:344-349`（flock + JSONC patch） |
| 兼容性 gate（`engines.opencode`） | plugin sidecar | `shared.ts:193-204` |
| auth/config 持久化 | host | `auth/index.ts:84-104`；config store 是 host 的 `Config.Service` |

### 4.2 约定

- **host 永不执行 npm**，也不写 `plugin-meta.json`、不改 `chimera.json` 的 `plugin` 字段；这些是 sidecar 的独占写面。
- 同一 workspace 只允许一个 sidecar 实例写该 workspace 的 plugin-meta；跨 workspace 共享全局 meta 时，`EffectFlock` 的文件锁（`meta.ts:54-60`）串行化写，但“单 owner”仍按 workspace 解释：每个 meta 文件只有一个活跃 writer。
- 安装失败必须显式上报（现状通过 `publishPluginError` 发 `Session.Event.Error`，`plugin/index.ts:224-244`）；目标契约要求 `plugin.load` 返回 `degraded` 列表，host 把状态暴露给 UI/日志，不能静默跳过。
- 安装/加载顺序：先安装（npm），再 entry 解析，再兼容性 gate，再动态 import（`loader.ts:70-118`）。sidecar 必须保持这个顺序；host 不参与。
- 崩溃恢复：sidecar 重启后重新 resolve/load；已安装的包可复用 npm 缓存；半写入的 config patch 由文件锁 + JSONC 原子写保护（现状 `install.ts:344-349` 使用 `EffectFlock`）。
- 版本兼容：`engines.opencode` 语义保留（`shared.ts:193-204`）；目标 Rust host 的版本号需要映射到同一 semver 检查，或由 sidecar 读取 host 提供的兼容版本。此项待 D2/发布矩阵拍板。

## 5. plugin-only 边界（不承载 session/agent loop）

### 5.1 允许

- 加载插件模块、持有 `Hooks`、执行六类 hook 回调与相邻 hook。
- 执行插件注册的工具体（`Hooks.tool`，`packages/plugin/src/index.ts:227-229`；`registry.ts:221-267`）——**只执行 body**，工具循环/权限/结果落库在 host。
- 通过 host RPC 读写 auth/config、调用 host SDK（`session.message/get` 等）。
- npm resolve/install、plugin-meta、config patch。

### 5.2 禁止

| 禁止面 | 原因 |
|---|---|
| session 状态机 / 消息历史 / compaction | 计划 §2 决策 3：任何 Bun 进程都不得成为 session 执行体（`RUST_FULL_MIGRATION_PLAN.md:65`） |
| agent loop / prompt assembly / tool_search | host 的控制面职责；sidecar 只返回 hook mutation |
| provider transport（LLM 请求/流） | 主力 provider 在 host；长尾 provider 的归属按 §13 另定（`:69,353`） |
| 权限决策 / 工具调度 / 结果持久化 | host 是权威；sidecar 不能直接写 session DB |
| SQLite / 任何 host 数据库句柄 | sidecar 只通过 RPC 访问事实 |
| HTTP/SSE listener / WebUI | host 的 front door；sidecar 不监听端口 |
| graph / MCP client / watcher | 独立子系统；sidecar 不持有 |
| background job / delegation / lease | host 的调度与恢复职责 |

### 5.3 判定规则

- 如果某个 hook 实现需要“记住上一轮 session 的某个状态”，该状态必须由 host 在 `plugin.hook` 的 `input` 中传入，或由插件通过 host RPC 读取；sidecar 不得自建 session 缓存。
- 如果某个插件工具需要执行副作用（写文件、发网络请求），副作用由插件的 JS body 直接执行（现状如此），但**工具调用的生命周期/权限/审计**仍在 host；sidecar 崩溃后 host 必须能把该调用标为 `unknown_side_effect`。
- 如果某个能力需要 host 的 DB/HTTP/graph，sidecar 只能通过 RPC 请求 host 执行，不能在 sidecar 内重建。

## 6. 版本、能力协商与 kill switch

- 协议版本：复用 ipc-v0 §6.1 的 `major << 8 | minor` 协商（`ipc-v0.md:561-598`）；plugin 面不单独版本化，但 `plugin.load` 的 body 带 `plugin_contract_rev`（建议 `cr-2026-10-30-r1`），不匹配时拒绝加载并返回 `plugin_incompatible`。
- 能力：`plugin.loader` 是必需能力；sidecar 还可以声明 `x-plugin-*` 扩展（ipc-v0 §6.2 允许 `x-` 前缀，`ipc-v0.md:570-598`）。
- kill switch：现状 `OPENCODE_PURE` 会跳过外部插件（`plugin/index.ts:201-205`）；目标 host 提供等价开关，开启时不启动外部插件 sidecar（内置插件是否仍加载由发布矩阵决定）。关闭 sidecar 时，host 必须以 `plugin_disabled` 显式状态运行，不能把“没有 hook”伪装成“hook 都成功”。
- 降级：sidecar 不可用时，host 仍可提供不依赖插件的核心会话；但依赖插件的 provider auth（codex/copilot/xai 等）必须显式报错，不能静默使用错误凭据。现状这些内置插件是 provider 可用性的前提（`plugin/index.ts:97-108`；`provider.ts:2030-2049`）。

## 7. 待拍板

1. **D2 拓扑**：plugin sidecar 是否与长尾 provider/orchestrate sandbox 共用进程（`RUST_FULL_MIGRATION_PLAN.md:353`）。本文建议 plugin-only 独立；若共用，§5 的禁止面仍适用于 plugin 部分。
2. **超时数值**：§3.1 全部是建议起点，需 H0/H1 校准后签定。
3. **重试策略**：只读 hook 的“重启后重试 1 次”是否足够；`tool.after` 的 `unknown_side_effect` 是否需要人工确认流程。
4. **内置插件归属**：codex/copilot/xai 等内置 auth 插件是否也迁移到 sidecar（本文按“是”设计，因为它们已经是 JS `Hooks`），还是由 host 原生实现（那会改变 auth refresh 契约）。
5. **`sdk.call` allowlist**：按 WP-04 的 operation 清单逐项收敛；本文只列出现状观测到的最小集合。
6. **版本兼容**：`engines.opencode` 如何映射到 Rust host 版本；是否需要新的 `engines.chimera` 字段。

## 8. 证据索引

| 证据 | 位置 |
|---|---|
| 终态架构与 Bun 兼容 sidecar | `RUST_FULL_MIGRATION_PLAN.md:92-114` |
| 删除 Bun session worker / plugin-only 边界 | `RUST_FULL_MIGRATION_PLAN.md:65` |
| plugin loader/SDK 长期 Bun sidecar | `RUST_FULL_MIGRATION_PLAN.md:129` |
| W3 最小真实 hook sidecar | `RUST_FULL_MIGRATION_PLAN.md:181` |
| W5 生态硬化 | `RUST_FULL_MIGRATION_PLAN.md:200-202` |
| WP-09 DoD | `RUST_FULL_MIGRATION_PLAN.md:263` |
| D2 待拍板 | `RUST_FULL_MIGRATION_PLAN.md:353` |
| ipc-v0 transport/握手/取消/drain/崩溃 | `packages/chimera/specs/rust-host/ipc-v0.md:114-154,383-488,737-789,848-856` |
| `plugin.loader` capability | `packages/chimera/src/host/ipc-handshake.ts:40-63` |
| 插件注册顺序 | `packages/chimera/src/plugin/index.ts:97-108,190-205,249-272` |
| npm resolve/import | `packages/chimera/src/plugin/loader.ts:70-130,193-228` |
| plugin-meta / flock | `packages/chimera/src/plugin/meta.ts:50-60` |
| config patch / flock | `packages/chimera/src/plugin/install.ts:344-349` |
| 兼容性 gate | `packages/chimera/src/plugin/shared.ts:193-204` |
| 插件 SDK 重入 | `packages/chimera/src/plugin/github-copilot/copilot.ts:60,376-412`；`packages/chimera/src/plugin/codex.ts:538-547` |
| 插件工具注册 | `packages/chimera/src/tool/registry.ts:221-267,284-289` |