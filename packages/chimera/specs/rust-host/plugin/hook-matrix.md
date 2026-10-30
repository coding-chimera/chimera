# WP-09 · 六类 hook 语义矩阵（现状 TS 基线）

> 状态：**building 交付物**（WP-09，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:263`（WP-09 DoD）、`:22`（W3 缺 hook 的风险条目）、`:181`（最小真实 hook sidecar）、`:200-202`（W5 生态硬化）；`packages/chimera/specs/rust-host/manifest.yaml:238-259`（WP-09 条目）；`packages/chimera/specs/rust-host/a0-scope-decisions.md:42`（范围）。
> 口径：本文只描述**当前 TS 实现**的 hook 顺序、可变性、取消与失败策略，并给出目标 sidecar 的契约建议。建议与待拍板分开标注；不把建议写成已实现事实。

## 0. 结论先行

- 六类口径：`config/bootstrap`、`tool.definition`、`chat.params/headers`、`tool.execute.before`、`tool.execute.after`、`auth refresh`。其中 `chat.params` 与 `chat.headers` 是两个独立触发点，`tool.execute.before` 与 `tool.execute.after` 因失败语义不同必须分列；因此矩阵共 6 行、覆盖 7 个 hook 名 + 1 个 auth 生命周期（`auth.loader` + lazy refresh）。
- 当前 `Plugin.trigger` 是**单进程内、按注册顺序串行 await、共享同一个 output 对象**的调用模型（`packages/chimera/src/plugin/index.ts:314-327`）。没有 per-hook 超时、没有 AbortSignal、没有 try/catch；hook 抛错会沿调用方 Effect 传播（`config`/`dispose` 是仅有的两个显式吞错点）。
- 注册顺序 = 内置插件固定顺序（`plugin/index.ts:97-108,190-199`）+ 外部插件配置顺序（`:201-205,249-272`）。外部模块的 import 是并行解析的（`loader.ts:193-200`），但 `applyPlugin` 串行执行，因此 hook 注册顺序不受 import 完成顺序影响（`:252-253` 注释）。
- `tool.definition` 对**不同工具**是 `concurrency: "unbounded"`（`tool/registry.ts:523-548`），所以跨工具的 hook 调用可以交错；**同一工具内**的插件顺序是确定的。轨迹 fixture 必须按 tool scope 断言，不能断言全局 tool 顺序。
- `tool.execute.after` 的 task 路径可能把 `undefined` 作为 output 传给 hook（`prompt.ts:1842-1846` 的 `result` 在失败时为 `undefined`），而 registry 工具路径总是传定义好的 output（`:1331-1344`）。目标契约必须显式处理这个不对称，不能默认 output 一定存在。
- `auth.loader` 只在**已存在存储凭据**时调用（`provider.ts:2030-2049`）；refresh 是插件 `fetch` 覆盖内的惰性行为，`auth.set` 会递增 auth revision（`auth/index.ts:84-104`），下一次 `Provider.list` 才重建 provider state 并重跑 loader（`provider.ts:2202-2224`）。同一 provider state 内的并发请求共享一个 refresh promise（`codex.ts:531-561`、`xai.ts:233-272`）。

## 1. 通用触发语义

### 1.1 注册与调用顺序

| 事实 | 证据 |
|---|---|
| `Hooks` 是普通对象；hook 名到回调的映射没有额外优先级字段 | `packages/plugin/src/index.ts:223-341` |
| 内置插件按固定数组顺序初始化，失败用 `Effect.option` 跳过 | `packages/chimera/src/plugin/index.ts:97-108,190-199` |
| 外部插件来自 `cfg.plugin_origins`；`OPENCODE_PURE` 时为空 | `plugin/index.ts:201-205` |
| 外部插件先并行 resolve/import，再按配置顺序串行 `applyPlugin` | `plugin/index.ts:207-272`；`loader.ts:193-228` |
| 注释明确要求串行以保持 hook 注册/执行顺序确定 | `plugin/index.ts:252-253` |
| `config` hook 在全部插件注册完成后按 `hooks` 数组顺序调用 | `plugin/index.ts:275-282` |
| `trigger` 按 `s.hooks` 数组顺序逐个 `yield*`，没有并发 | `plugin/index.ts:314-327` |
| 插件缺少某个 hook 时直接 `continue`，不产生空调用 | `plugin/index.ts:321-324` |

### 1.2 共享 output 与可变性

`trigger(name, input, output)` 把同一个 `output` 引用依次交给每个 hook，最后一个 hook 的修改就是返回值（`plugin/index.ts:314-327`）。因此：

- 后注册的插件能看到先注册插件的修改；hook 之间没有快照/回滚。
- `input` 没有冻结，也没有拷贝；hook 可以读也可以改，但当前调用方通常只读。
- 没有 schema 校验；hook 可以把字段改成任意类型，错误要到下游消费时才暴露（例如 `llm.ts:778-806` 直接把 `params` 字段传给 SDK）。

### 1.3 取消

- 所有 hook 签名都是 `(input, output) => Promise<void>`，没有 `AbortSignal` 参数（`packages/plugin/src/index.ts:223-341`）。
- `trigger` 用 `Effect.promise(async () => fn(input, output))` 等待 hook（`plugin/index.ts:324`），没有超时、没有 `Effect.race`、没有取消回调。
- 调用方 fiber 被中断时，`trigger` 循环停止等待；但已经进入的 JS Promise 不会被取消，也没有办法通知插件停止。唯一的例外是工具路径：`executeGuarded` 把整个工具 Effect 与 abort 信号 race（`prompt.ts:1249-1265`），中断后调用 `failToolCall`（`:1266-1279`），但同样不取消 hook Promise。
- `event` hook 是 fire-and-forget：`void hook["event"]?.(...)`（`plugin/index.ts:299-308`），既不等待也不处理 rejection。

### 1.4 失败策略总览

| 触发点 | 当前行为 | 证据 |
|---|---|---|
| `config` | `tryPromise` + `Effect.ignore`；记录日志后继续下一个插件，bootstrap 继续 | `plugin/index.ts:275-282` |
| 内置插件初始化 | `Effect.option`；失败的插件没有 hooks，其他插件继续 | `plugin/index.ts:190-199` |
| 外部插件 `server()` 初始化 | `tryPromise` + catch 日志；该插件跳过；原计划的总线错误事件被注释掉 | `plugin/index.ts:254-271`（`:263-269` 注释） |
| `dispose` | 每个 hook 单独 `tryPromise` + `Effect.ignore`；一个失败不影响其他 | `plugin/index.ts:284-296` |
| `tool.definition` | 没有 catch；异常让 `registry.tools()` 失败，工具列表无法构建 | `tool/registry.ts:523-556` |
| `chat.params` / `chat.headers` | 没有 catch；异常进入 LLM 请求错误通道，该轮失败 | `session/llm.ts:408-442` |
| `tool.execute.before` | 异常让工具不执行；`executeGuarded` 捕获并 `failToolCall` | `prompt.ts:1263-1280,1322-1330` |
| `tool.execute.after` | 工具体已执行；异常让本次调用标记失败，结果被丢弃 | `prompt.ts:1330-1348` |
| `auth.loader` | `Effect.promise` 的 rejection 成为 provider state 初始化 defect；没有 per-plugin 隔离 | `provider.ts:2030-2049` |
| `auth.refresh` | 刷新失败让请求失败；codex 的 `auth.set` 失败会向上抛（`codex.ts:538-547`），xai 的 `auth.set` 失败被吞掉（`xai.ts:253-263`） | 同左 |
| `event` | `void` 调用；rejection 不被观察 | `plugin/index.ts:299-308` |

## 2. 六类矩阵

### H1 · config/bootstrap

| 维度 | 现状 |
|---|---|
| 触发点 | `InstanceBootstrap.run` 先 `config.get()`，再 `plugin.init()`，然后才初始化 LSP/Format/File/...（`packages/chimera/src/project/bootstrap.ts:37-51`）。`plugin.init()` 触发 `InstanceState.get(state)`（`plugin/index.ts:334-336`），在 state 构造过程中加载插件并调用 `config` hook（`:275-282`）。 |
| 顺序 | 内置插件（固定顺序）→ 外部插件（配置顺序）→ `config` hook（按 hooks 数组顺序）→ 其他服务 init。`bootstrap.ts:42` 注释明确“Plugin can mutate config so it has to be initialized before anything else”；`provider.ts:1681-1685` 再次确认 provider 读取 config 前先取 `plugin.list()`。 |
| 可变性 | `config` hook 收到的是已解析的 config 对象本身，直接原地修改；修改对后续 `config.get()` 读者可见（`plugin/index.ts:275-282`；`bootstrap.ts:42`；`provider.ts:1681-1685`）。插件还可以通过 `Hooks.tool` 注册工具（`packages/plugin/src/index.ts:227-229`；`registry.ts:284-289`）。 |
| 取消 | `plugin.init()` 是 bootstrap Effect 的一部分；实例 scope 关闭会中断 Effect，但 `config` hook 的 JS Promise 没有取消通道（`plugin/index.ts:324`；hook 签名无 AbortSignal）。没有 per-hook 超时。 |
| 失败 | `config` 失败记录日志并忽略，其他插件的 `config` 继续，bootstrap 继续（`plugin/index.ts:275-282`）。插件初始化失败则整个插件跳过（`:190-199,254-271`）。`dispose` 失败也被忽略（`:284-296`）。 |
| Fixture | `config|config:bootstrap` 两个插件；`bootstrap` 操作内先注册后调用；失败策略行 `config → HOOK_FAILURE_ISOLATED_CONFIG`。 |
| 目标 sidecar 建议 | host 发 `plugin.hook(config)`，sidecar 必须按注册顺序执行；单个插件失败返回 `status:error` 但继续后续插件；host 只有在全部插件返回后才读取 config。超时/崩溃时 host 以“外部插件降级”继续 bootstrap，并显式记录 degraded 状态。 |

### H2 · tool.definition

| 维度 | 现状 |
|---|---|
| 触发点 | `ToolRegistry.tools()` 对每个过滤后的工具构造 `output = { description, parameters }`，然后 `plugin.trigger("tool.definition", { toolID }, output)`（`packages/chimera/src/tool/registry.ts:489-557`，触发在 `:527-531`）；hook 类型见 `packages/plugin/src/index.ts:340`。 |
| 顺序 | 同一工具内按 hooks 数组顺序串行；不同工具之间是 `Effect.forEach(..., { concurrency: "unbounded" })`（`:523-548`），所以跨工具可交错。工具列表缓存条目保存 `hooks` 引用并在命中时比较（`:492-503`），插件列表变化会使缓存失效。 |
| 可变性 | `description` 是字符串，后续与 task 描述拼接（`:532-542`）；`parameters` 是整对象替换（`:542`）。后注册插件看到前一个插件的 description/parameters。 |
| 取消 | 没有 per-hook 取消；工具列表构建被中断时，未完成的 definition hook 不再被等待，但 JS Promise 继续。没有超时。 |
| 失败 | `trigger` 没有 catch（`:531`），异常让 `tools()` 失败；缓存写入在循环之后（`:549-555`），所以不会缓存半成品。调用方（prompt 组装/LLM 请求）随之失败。 |
| Fixture | `tool.definition|tool:read`、`tool.definition|tool:bash` 各两个插件；跨工具事件刻意交错；失败策略行 `tool.definition → HOOK_FAILURE_FATAL_TOOL_LIST`。 |
| 目标 sidecar 建议 | 一个 `plugin.hook(tool.definition)` 请求只覆盖一个 toolID，sidecar 内部按注册顺序串行；host 可并发发多个 toolID 请求。任一次请求失败 → host 让工具列表构建失败（不缓存、不静默丢弃该工具定义）。超时视为失败，不返回未修改的定义。 |

### H3 · chat.params / chat.headers

| 维度 | 现状 |
|---|---|
| 触发点 | `session/llm.ts:408-428` 先 `chat.params`，`:430-442` 再 `chat.headers`；两者都在 system prompt 组装之后、provider 请求之前。`chat.params` 的输出在 `:778-788` 被消费；`chat.headers` 的输出在 `:790-806` 与模型 headers 合并（模型 headers 在前，插件 headers 在后，后者覆盖同名键）。 |
| 顺序 | 同一请求内 `chat.params` 先于 `chat.headers`；各自按 hooks 数组顺序串行。`chat.params` 内部先于 `chat.headers` 是调用点顺序，不是 hook 注册顺序。 |
| 可变性 | `chat.params` 输出：`temperature`、`topP`、`topK`、`presencePenalty`、`frequencyPenalty`、`maxOutputTokens`、`options`（`packages/plugin/src/index.ts:248-259`）。`maxOutputTokens` 类型允许 `undefined`；trace 用 `null` 表示 unset。`chat.headers` 输出 `{ headers: Record<string,string> }`（`:260-263`），直接 spread 到请求 headers（`llm.ts:790-806`）。 |
| 取消 | LLM 请求的 `abortSignal` 只传给 SDK（`llm.ts:789`），没有传给 hook；请求中断时 hook Promise 继续。没有 per-hook 超时。 |
| 失败 | 两个触发点都没有 catch；异常进入 LLM 请求错误通道，该轮失败（`llm.ts:408-442`）。已注册的内置插件用这两个 hook 做 provider 适配（`plugin/codex.ts:728-740`、`plugin/github-copilot/copilot.ts:344-374`、`plugin/cloudflare.ts:64`）。 |
| Fixture | `chat.params|params:op-llm` 与 `chat.headers|headers:op-llm` 各三个插件；`chat.headers` 内有一个 `sdk.call(session.message)` 演示重入；失败策略行 `chat.params/chat.headers → HOOK_FAILURE_FATAL_LLM`。 |
| 目标 sidecar 建议 | host 先发 `plugin.hook(chat.params)`，拿到最终 params 后再发 `plugin.hook(chat.headers)`；两个请求共享同一个 `request_id`，但 scope 分开（`params:<request>` / `headers:<request>`）。任一失败 → 请求失败，不发送未完成的请求。hook 内允许调用 host SDK（如 `session.message`），host 必须支持重入。 |

### H4 · tool.execute.before

| 维度 | 现状 |
|---|---|
| 触发点 | registry 工具：`prompt.ts:1322-1326`；MCP resource/list/read 等路径：`:1405-1409,1437-1441,1474-1478,1506-1510,1548-1552,1583-1587,1610-1614,1629-1633`；task 工具：`:1763-1767`。 |
| 顺序 | 在工具体执行前；同一调用内按 hooks 顺序串行。registry 工具路径的 `args` 对象就是随后传给 `item.execute(args, ctx)` 的同一引用（`:1322-1330`）。task 路径先构造 `taskArgs`，before 之后把同一个对象传给 `taskTool.execute`（`:1757-1781`）。 |
| 可变性 | 输出 `{ args }`；插件直接改 `args` 的属性，修改对工具体可见（`:1322-1330`）。没有深拷贝/冻结。 |
| 取消 | `executeGuarded` 把整个“before → execute → after”Effect 与 abort 信号 race（`:1249-1265`）；abort 后调用 `failToolCall`（`:1266-1279`）。hook 本身没有 AbortSignal；已进入的 before hook 会继续跑完，但结果不再被等待。 |
| 失败 | before 抛错 → 工具体不执行 → `failToolCall` 记录失败；同一批 sibling 调用继续（除非是 policy violation，`:1272-1275`）。 |
| Fixture | `tool.execute.before|before:call-1` 两个插件链式改 `args.path`；`before:call-2` 在 hook 中途被取消，没有 hook.end/after；失败策略行 `tool.execute.before → HOOK_FAILURE_SKIP_TOOL`。 |
| 目标 sidecar 建议 | host 发 `plugin.hook(tool.execute.before)`，sidecar 返回最终 args；host 用返回的 args 执行工具。取消时 host 发 `cancel`，sidecar 尽快返回 `cancelled`；host 不执行工具。超时/崩溃 → 工具不执行（安全侧）。 |

### H5 · tool.execute.after

| 维度 | 现状 |
|---|---|
| 触发点 | registry 工具：`prompt.ts:1331-1348`（先构造 `output = {...result, attachments}`，再 after，再 `processor.completeToolCall`）；MCP 路径：`:1437-1441,1506-1510,1583-1587,1629-1633`；task 路径：`:1842-1846`。 |
| 顺序 | 工具体返回后、结果落库/完成之前。同一调用内按 hooks 顺序串行。registry 路径的 output 是定义好的对象；task 路径的 `result` 在工具失败时可能是 `undefined`，仍被传给 `trigger`（`:1842-1846`）。 |
| 可变性 | 输出 `{ title, output, metadata }`（`packages/plugin/src/index.ts:277-284`）；registry 路径的修改会被 `completeToolCall` 持久化（`:1331-1348`）。task 路径的修改作用于 `result` 对象（若存在）。 |
| 取消 | 与 before 同一个 `executeGuarded` race；abort 后 `failToolCall`，after 可能根本没开始。没有 per-hook 取消。 |
| 失败 | 工具体已经执行（可能有副作用）；after 抛错 → `failToolCall`，结果被丢弃，调用标记失败。这是“副作用已发生但结果不可信”的窗口。 |
| Fixture | `tool.execute.after|after:call-1` 两个插件链式改 output/metadata；取消的 call-2 没有 after；失败策略行 `tool.execute.after → HOOK_FAILURE_DISCARD_RESULT`。 |
| 目标 sidecar 建议 | host 在工具体完成后发 `plugin.hook(tool.execute.after)`；sidecar 返回最终 result。after 失败/超时/崩溃 → 调用标记失败，并显式记录 `side_effect_state: unknown`（工具体已执行）；不自动重试。task 路径的 `undefined` 必须显式建模为 `result: null` 或跳过 after，不能把 `undefined` 塞进 JSON。 |

### H6 · auth refresh

| 维度 | 现状 |
|---|---|
| 注册 | `Hooks.auth` 是单个 `AuthHook`（`packages/plugin/src/index.ts:90-164,230`）；`ProviderAuth` 按 `auth.provider` 建 map（`provider/auth.ts:114-127`）。 |
| 触发点（loader） | provider state 初始化时，若该 provider 有存储凭据且插件有 `auth.loader`，调用 `loader(getAuth, provider)`，把返回的 options patch 合并进 provider（`provider.ts:2030-2049`）。没有存储凭据时 loader 不调用（`:2036-2038`）。 |
| 触发点（refresh） | 插件在返回的 `fetch` 覆盖里检查 `currentAuth.expires < Date.now()`（codex `plugin/codex.ts:525-561`；xai `plugin/xai.ts:224-272`；copilot loader `plugin/github-copilot/copilot.ts:100`）。刷新用 single-flight promise 合并并发请求（codex `:531-557`；xai `:242-269`）。 |
| 顺序 | provider.init → `auth.loader` → options 合并 → 第一次请求 → `chat.params/headers` → 需要时 refresh → `auth.set` → 用新 token 发请求。`auth.set` 递增 revision 并发布 change（`auth/index.ts:84-104`）；下一次 `Provider.list` 检测到 revision 变化后 invalidate/rebuild state，重跑 loader（`provider.ts:2202-2224`）。同一 state 内的第二个请求复用内存 token，不重复 refresh。 |
| 可变性 | loader 返回 provider options patch（apiKey/fetch/baseURL 等），通过 `mergeProvider` 合并（`provider.ts:2046-2048`）；refresh 通过 `input.client.auth.set` 写回 Auth store（codex `:538-547`；xai `:253-263`）。codex 在内存中更新 `currentAuth.access`/`accountId`（`:558-560`）；xai 构造新的 `currentAuth` 对象（`:270-271`）。 |
| 取消 | refresh 的 single-flight promise 没有 AbortSignal；sidecar 的 `cancel` 不能中断已经发出的 refresh HTTP 请求。host 必须用超时/终态策略兜底（建议值见 sidecar-topology §3）。 |
| 失败 | loader rejection → `Effect.promise` 把 rejection 作为 provider state 初始化 defect；没有 per-plugin 隔离（`provider.ts:2040-2045`）。refresh 失败 → fetch 失败 → 请求失败；codex 的 `auth.set` 失败会向上抛（`codex.ts:538-547`），xai 的 `auth.set` 失败被 `.catch(() => {})` 吞掉（`xai.ts:253-263`），后者会留下磁盘 stale 但本轮内存 token 可用。 |
| Fixture | `auth.loader|auth:openai` 一次；`auth.refresh` 一次（`single_flight: true`、`concurrent_requests: 2`、`persist: auth.set`）；`sdk.call(auth.set)` 在 refresh 之后；第二个 `llm.request` 不重复 refresh；失败策略行 `auth.loader → HOOK_FAILURE_PROVIDER_INIT`、`auth.refresh → HOOK_FAILURE_AUTH_REFRESH`。 |
| 目标 sidecar 建议 | auth store 归 host；sidecar 的 loader 通过 host RPC `auth.get` 读取凭据，refresh 通过 `auth.set` 写回。loader 失败 → provider state 初始化失败（显式错误，不静默跳过）；refresh 失败 → 请求失败，不回退 stale token；`auth.set` 失败必须显式上报，不能像 xai 那样静默吞掉（这是现状差异，见 §4）。 |

## 3. 相邻 hook（不在六类 DoD 内，但同一触发机制）

| Hook | 触发点 | 语义 | 证据 |
|---|---|---|---|
| `chat.message` | 用户消息落库前 | 可改 `message`/`parts`；串行 | `prompt.ts:2745-2755` |
| `command.execute.before` | 命令执行前 | 可改 `parts` | `prompt.ts:3690-3694` |
| `shell.env` | shell/pty 执行前 | 可追加 env | `tool/shell.ts:450-455`；`pty/index.ts:187-191`；`prompt.ts:2023-2026` |
| `event` | 总线事件 | fire-and-forget，不等待 | `plugin/index.ts:299-308` |
| `dispose` | 实例 scope 关闭 | 每个插件单独吞错 | `plugin/index.ts:284-296` |
| `experimental.chat.system.transform` | system prompt 组装后 | 可改 `system[]` | `llm.ts:349-360`；`agent/agent.ts:386`；`memory/model.ts:110,158` |
| `experimental.chat.messages.transform` | 消息发送前/compaction | 可改消息数组 | `prompt.ts:3283`；`compaction.ts:528` |
| `experimental.session.compacting` | compaction 前 | 可追加 context/替换 prompt | `compaction.ts:521-526` |
| `experimental.compaction.autocontinue` | compaction 后 | 可关闭合成 continue | `compaction.ts:425-430` |
| `experimental.text.complete` | 文本完成时 | 可改最终文本 | `processor.ts:884-888` |
| `permission.ask` | 类型已声明 | **当前 src 没有触发点**；不要把它当作已接线能力 | 声明 `packages/plugin/src/index.ts:264`；grep 未找到 `plugin.trigger("permission.ask")` |

## 4. 已知差异与陷阱（目标契约必须显式处理）

1. **task after 的 `undefined` output**：`prompt.ts:1842-1846` 把可能为 `undefined` 的 `result` 传给 `trigger`，而 `Hooks["tool.execute.after"]` 的 output 类型要求对象（`packages/plugin/src/index.ts:277-284`）。目标契约要么跳过 after（result 不存在），要么用 `null` 显式表示，不能默认 output 存在。
2. **跨工具 definition 交错**：`registry.tools()` 的 `concurrency: "unbounded"`（`registry.ts:547`）意味着不同工具的 `tool.definition` hook 可以交错；任何“全局 hook 顺序”断言都是错的。轨迹按 `tool:<id>` scope 断言。
3. **config hook 的静默失败**：`plugin/index.ts:275-282` 只记录日志；外部插件 `server()` 失败的总线事件被注释掉（`:263-269`）。目标契约要求显式 degraded 状态，不能继续“用户看不到插件没加载”。
4. **auth loader 的调用条件**：只有存储凭据存在时才调用（`provider.ts:2036-2038`）。没有凭据时 provider options 不会被 patch；OAuth fetch 覆盖也不会存在。目标契约必须把“无凭据”与“loader 失败”区分开。
5. **auth.set 失败的不对称**：codex 让失败向上抛（`codex.ts:538-547`），xai 吞掉（`xai.ts:253-263`）。目标契约统一为显式 `auth_refresh_persist_failed`，并标明“本轮内存 token 可用/磁盘 stale”的状态。
6. **`trigger` 没有 name 空值防御**：`if (!name) return output`（`plugin/index.ts:319`）只是类型层兜底；运行时空字符串会静默跳过所有 hook。sidecar 契约应拒绝空 hook 名。
7. **`event` hook 的 rejection 无人观察**：`void hook["event"]?.(...)`（`plugin/index.ts:299-308`）。目标契约要求 sidecar 捕获并记录，不能让 unhandled rejection 污染进程。
8. **`permission.ask` 声明未接线**：类型存在（`packages/plugin/src/index.ts:264`），但 src 没有触发点。目标契约不应把它列入 W3 必需面，直到 host 真正接线。

## 5. 目标 sidecar 语义摘要

详细拓扑见 `sidecar-topology.md`；这里只列与六类直接相关的约束：

- host 是顺序/截止时间/取消意图/最终状态的唯一权威；sidecar 只执行 JS hook 并返回 mutation + trace。
- 一次 `plugin.hook` 请求覆盖一个 hook 名 + 一个 scope；sidecar 内部按注册顺序串行执行该 scope 的所有插件。
- host 可以并发发多个 scope 的请求（例如不同 toolID 的 definition），sidecar 可以交错，但同一 scope 内必须串行。
- hook 内允许调用 host SDK（`client.*`）；host 必须支持重入，不能因为等待 hook 而阻塞嵌套请求。
- 取消通过 ipc-v0 `cancel` 帧；sidecar 必须尽快返回 `cancelled`，但已经发出的 refresh HTTP 不能被“取消成功”冒充。
- 失败按 §1.4/§2 的类映射为稳定错误码；不允许把失败 hook 当成“未修改”继续。

## 6. Fixture 覆盖映射

| 类 | Fixture 事件 | 断言 |
|---|---|---|
| H1 config/bootstrap | `config|config:bootstrap`（demo.alpha、demo.beta） | 注册顺序、config 链式修改、bootstrap 内调用 |
| H2 tool.definition | `tool.definition|tool:read`、`tool.definition|tool:bash` | 每工具 alpha→beta；跨工具交错不破坏 per-tool 顺序 |
| H3 chat.params/headers | `chat.params|params:op-llm`、`chat.headers|headers:op-llm` | params 先于 headers；三者链式修改；headers 重入 `session.message` |
| H4 tool.before | `tool.execute.before|before:call-1` | args 链式修改；before.end 早于 after.start |
| H5 tool.after | `tool.execute.after|after:call-1` | output/metadata 链式修改；取消的 call-2 没有 after |
| H6 auth refresh | `auth.loader|auth:openai` + `auth.refresh` | loader 一次；refresh 一次、single-flight、`auth.set`；第二个请求不重复 refresh |

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| WP-09 DoD | `RUST_FULL_MIGRATION_PLAN.md:263` |
| W3 缺 hook 的风险 | `RUST_FULL_MIGRATION_PLAN.md:22` |
| 最小真实 hook sidecar | `RUST_FULL_MIGRATION_PLAN.md:181` |
| W5 生态硬化 | `RUST_FULL_MIGRATION_PLAN.md:200-202` |
| WP-09 manifest | `packages/chimera/specs/rust-host/manifest.yaml:238-259` |
| WP-09 范围 | `packages/chimera/specs/rust-host/a0-scope-decisions.md:42` |
| Hooks 类型 | `packages/plugin/src/index.ts:223-341` |
| trigger 实现 | `packages/chimera/src/plugin/index.ts:314-327` |
| 插件注册顺序 | `packages/chimera/src/plugin/index.ts:97-108,190-205,249-272` |
| config hook | `packages/chimera/src/plugin/index.ts:275-282` |
| tool.definition | `packages/chimera/src/tool/registry.ts:489-557` |
| chat.params/headers | `packages/chimera/src/session/llm.ts:408-442,778-806` |
| tool.before/after | `packages/chimera/src/session/prompt.ts:1263-1280,1322-1348,1763-1767,1842-1846` |
| auth loader/refresh | `packages/chimera/src/provider/provider.ts:2030-2049,2202-2224`；`packages/chimera/src/plugin/codex.ts:497-561`；`packages/chimera/src/plugin/xai.ts:205-272` |
| auth store revision | `packages/chimera/src/auth/index.ts:84-104` |