# WP-08 · Provider profile 准入表（genai 0.7.2 候选）

> 依据：`RUST_FULL_MIGRATION_PLAN.md:396-403`（§15.2 能力分诊）、`:389-392`（§15.1 职责）、`:432-454`（§15.6 Codex crates）、`:262`（WP-08 DoD）。
> 本文件只做准入判定与职责划分；不编译 genai、不调用真实 provider、不实现生产 transport（`packages/chimera/specs/rust-host/a0-scope-decisions.md:51,54`）。

## 1. 判定词汇

| 判定 | 含义 | 对 GP-0/GP-1 的含义 |
|---|---|---|
| **可接管**（takeover） | genai 0.7.2 可负责该 profile 的 HTTP/SSE 请求构造与响应解析；Chimera 只保留自有 request/LLMEvent/usage/tool schema/路由/错误/取消映射。 | GP-1 只需验证 adapter 映射与单回合行为；不需要额外协议实现。 |
| **需兼容**（compat） | genai 可作为传输底座，但存在已识别字段/行为缺口（账号头、刷新并发、加密 reasoning、`previous_response_id` 续接、hosted tool 事件等），必须由 Chimera adapter 或兼容分支补齐并独立对账。 | GP-0 必须逐项列出缺口；GP-1 必须证明补齐后的请求/事件与 fixture 一致；不能按 provider 名字推断。 |
| **未覆盖**（uncovered） | genai 0.7.2 没有完整原生契约；保留专用 transport 或经 oracle 验收的 provider-only 兼容执行体（Codex 路径优先 codex-api，§15.6）。 | GP-0 直接登记兼容分支；GP-4 再评估生产准入；未过项不阻塞其他 profile 的 W3 闭环。 |

判定是 **profile × 能力** 的，不是 provider 名字的。一个 provider 的 Chat/API-key 通过，不代表它的 Responses/OAuth/WS/tool_search/compaction 通过（`RUST_FULL_MIGRATION_PLAN.md:401-402`）。

## 2. 六项 profile 总表

| # | profile | 协议 / 传输 | auth | genai 判定 | 依据（file:line） | Chimera 自有职责 | fixture |
|---|---|---|---|---|---|---|---|
| P1 | **Chat/API-key** | OpenAI-compatible Chat Completions `/chat/completions`，SSE | API key header | **可接管** | `RUST_FULL_MIGRATION_PLAN.md:398`；`packages/llm/src/protocols/openai-chat.ts:26-29,91-108,481-499`；`packages/llm/src/route/auth.ts:112-150`；`packages/llm/src/providers/openai.ts:37-63` | request/LLMEvent 映射、usage、工具 schema、显式路由、错误/取消、retry/replaySafe | `chat-api-key.text-and-tool-call.json` |
| P2 | **Responses/API-key** | OpenAI Responses `/responses`，SSE | API key header | **可接管**（独立对账） | `RUST_FULL_MIGRATION_PLAN.md:399`；`packages/llm/src/protocols/openai-responses.ts:28-30,152-166,959-999`；`packages/chimera/src/session/codex-responses.ts:228-248` | instructions/store/`previous_response_id`/`response_id`、reasoning 加密捕获/回放、工具结果规范化、hosted tool 事件映射 | `responses-api-key.text-and-tool-call.json` |
| P3 | **Responses/OAuth** | Responses HTTP，SSE | OAuth bearer + account header | **需兼容** | `RUST_FULL_MIGRATION_PLAN.md:401`；`packages/chimera/src/session/llm.ts:455-483`；`packages/chimera/src/session/codex-responses.ts:278-287`；`packages/chimera/src/plugin/codex.ts:185-239,495-561` | token 刷新/去重/持久化、账号头、加密 reasoning 回放、401 重试策略 | `responses-oauth.reasoning-and-text.json` |
| P4 | **WS** | Codex 后端 Responses WebSocket JSON | OAuth bearer + account header | **未覆盖**（genai）；codex-api 有 WS client | `RUST_FULL_MIGRATION_PLAN.md:402,438-450`；`packages/chimera/src/session/codex-responses.ts:347-369,497-537,733-808` | WS 建连/重试/回退 HTTP、增量 `previous_response_id`、turn state、LRU 会话缓存 | `responses-websocket.incremental-turn.json` |
| P5 | **native tool_search** | Responses provider-defined `tool_search`（client execution） | 继承 P2/P3 | **未覆盖**（genai）；wire 格式可复用 | `RUST_FULL_MIGRATION_PLAN.md:402,443`；`packages/chimera/src/session/tool-search.ts:248-318`；`packages/chimera/src/session/llm.ts:965-978` | client-execution 循环、reveal 持久化/晋升、`tool_search_output` 回放、deferred schema 注入 | `native-tool-search.client-execution.json` |
| P6 | **compaction** | Responses compaction v2 SSE + legacy JSON | OAuth（Codex）或 provider transport | **未覆盖**（genai）；codex-api 不含 compaction | `RUST_FULL_MIGRATION_PLAN.md:402,442`；`packages/chimera/src/session/remote-compaction.ts:595-599,661-696,970-999,1114-1139` | eligibility 策略、协议顺序/回退、超时/重试、加密 compaction 输出回放、local fallback | `remote-compaction.v2-and-legacy.json` |

**packages/llm 依据的读法**：P1/P2 在 packages/llm 有完整 protocol/route（Chat/Responses），所以判为可接管；P3 只有 auth/HTTP 基座，账号头/刷新/加密历史需 Chimera 补齐，所以判为需兼容；P4 只有通用 WS transport 基座（`packages/llm/src/route/transport/websocket.ts:7-33,125-136,209-277`），没有 Codex 增量/turn-state 语义；P5/P6 在 packages/llm 没有对应 protocol（hosted tool 事件映射只在 `openai-responses.ts:543-604`），所以判为未覆盖。这个读法避免把“有 transport 基座”误当成“有完整 profile 契约”。

## 3. 逐项 profile

### 3.1 P1 Chat/API-key

- **请求形状**：`model`、`messages`、`tools`、`tool_choice`、`stream`、`stream_options.include_usage`；工具是 `{type:"function", function:{name, description, parameters}}`。packages/llm 的 Chat body 字段见 `packages/llm/src/protocols/openai-chat.ts:91-108`。
- **流式形状**：`choices[].delta.content` 文本增量；`choices[].delta.tool_calls[]` 按 `index` 累计/增量（取决于 capture 模式）；`finish_reason`；usage chunk；`[DONE]`。fixture 使用 **delta** 模式，并在 `ordering-contract.md` §4 说明 cumulative 模式的归一化要求。
- **auth**：`Authorization: Bearer <API key>`；无刷新、无账号头。packages/llm 的 `Auth.bearer`/`Auth.header` 见 `packages/llm/src/route/auth.ts:112-150`。
- **genai 判定：可接管**。genai 的 `exec_chat`/`exec_chat_stream` 只执行一个 provider 回合，不执行本地工具、不自动继续 agent loop；Tool/ToolCall/ToolResponse/ChatRequest 提供声明与回放数据（`RUST_FULL_MIGRATION_PLAN.md:390`）。
- **Chimera adapter 职责**：自有 request/LLMEvent 映射、usage、工具参数模式、显式路由、错误/取消衔接；retry/replaySafe 由 Chimera 拥有（`RUST_FULL_MIGRATION_PLAN.md:391-392`）。
- **现有抽象**：`packages/llm/src/protocols/openai-chat.ts:26-29,481-499`；`packages/llm/src/providers/openai.ts:37-63`；显式 provider/baseURL profile 见 `providers/openai-compatible-profile.ts:1-4`；endpoint 覆盖见 `route/endpoint.ts:4-31`。
- **fixture**：`chat-api-key.text-and-tool-call.json`（2 turns：text + tool call → tool result replay → final text）。
- **已知缺口**：genai 的 `capture_tool_calls=true` 在 OpenAI chunk 上是累计快照，不能当 delta 拼接（`RUST_FULL_MIGRATION_PLAN.md:400`）；adapter 必须声明 capture 模式并归一化。

### 3.2 P2 Responses/API-key

- **请求形状**：`model`、`instructions`、`input`、`tools`、`tool_choice`、`reasoning`、`include`、`store`、`prompt_cache_key`、`text`、`stream`。当前 TS serializer 见 `codex-responses.ts:228-248`；packages/llm Responses body/WS message 见 `packages/llm/src/protocols/openai-responses.ts:152-166`。
- **流式形状**：`response.created`、`response.output_item.added/done`、`response.output_text.delta`、`response.function_call_arguments.delta`、`response.reasoning_summary_part.added`、`response.reasoning_summary_text.delta`、`response.completed/incomplete/failed/error`。当前 TS 映射见 `codex-responses.ts:822-1017`。
- **auth**：API key header；无刷新。
- **genai 判定：可接管（独立对账）**。§15.2 明确 0.7.2 有专用 adapter，覆盖 `instructions`、`store/previous_response_id`、`response_id`、工具、reasoning/usage；但 metadata/终态/续接 fidelity 必须验收（`RUST_FULL_MIGRATION_PLAN.md:399`）。
- **Chimera adapter 职责**：加密 reasoning 的捕获/回放（`include:["reasoning.encrypted_content"]`；当前 TS `codex-responses.ts:1256-1263`）、`ToolResponse.content` 为 String 时的 JSON 规范化、媒体/复合工具结果的单列适配、hosted tool 事件映射（`RUST_FULL_MIGRATION_PLAN.md:400`）。
- **fixture**：`responses-api-key.text-and-tool-call.json`（2 turns：message + function_call → function_call_output replay → final text）。
- **已知缺口**：`store`/`previous_response_id` 续接、`response_id` 元数据、reasoning 加密回放的字节级 fidelity 必须独立 GP-2 对账；不能由 Chat 通过推断。

### 3.3 P3 Responses/OAuth

- **请求形状**：同 P2；OAuth 分支当前把 system 拼进 `instructions`（`llm.ts:404-406`），并在请求头加 `authorization` 与 `ChatGPT-Account-ID`（`codex-responses.ts:278-287`）。
- **auth**：OAuth bearer + account header；刷新在请求前按 `expires` 触发，同一 credential 的刷新用 in-flight promise 去重，旋转后的 refresh/access/expiry/accountId 通过 `setAuth` 持久化（`plugin/codex.ts:185-239`；插件 loader 版本见 `:495-561`）。
- **genai 判定：需兼容**。genai 的 endpoint/token/headers 可由 caller 配置，但账号头、刷新并发、body、历史和加密数据等价性未验证；不能由 API-key Responses 成功推断（`RUST_FULL_MIGRATION_PLAN.md:401`）。
- **Chimera adapter 职责**：把 OAuth 凭据映射为请求头；在请求前完成刷新；401 时最多刷新一次并仅在 replaySafe 时重试；把旋转后的凭据写回 Chimera auth store；WS 建连若只支持同步 `add_auth_headers`，必须在 Chimera 侧先刷新或向上游提交补丁（`RUST_FULL_MIGRATION_PLAN.md:450`）。
- **fixture**：`responses-oauth.reasoning-and-text.json`（2 turns：encrypted reasoning + text → reasoning replay + text）。
- **已知缺口**：`AuthProvider` 异步路径只覆盖 HTTP；WS 当前同步头是 §15.6 明确列出的风险点。若 GP-4 未通过，P3/P4 保留 provider-only 兼容执行体。

### 3.4 P4 WS

- **协议**：`response.create` JSON 帧；首帧可带完整 `input`，后续帧用 `previous_response_id` + delta `input`；`client_metadata` 携带 turn state；当前 TS 还维护 endpoint+account+session 维度的 LRU 会话缓存（`codex-responses.ts:102-123,485-537`）。
- **auth**：OAuth bearer + account header；当前 WS 建连使用同步头（`codex-responses.ts:733-808`）。
- **genai 判定：未覆盖**。§15.2 明确 Codex WebSocket 尚无完整原生契约覆盖；保留专用 route/transport 或经 oracle 验收的 provider-only 兼容执行体。§15.6 指出 codex-api 有 `ResponsesWebsocketClient`，但只复用 wire 层。
- **Chimera 职责**：WS 建连/超时、可重试错误的有限重连、不可恢复时回退 HTTP、增量请求基线诊断、turn state 捕获/回写、会话缓存上限（当前 `WEBSOCKET_SESSION_CACHE_MAX = 256`，`codex-responses.ts:106`）。
- **fixture**：`responses-websocket.incremental-turn.json`（2 turns：full turn → `previous_response_id` 增量 turn）。
- **已知缺口**：codex-api 的 WS 客户端是 workspace 内部 crate、非发布依赖；vendoring/git pin、许可与上游同步策略未定（`RUST_FULL_MIGRATION_PLAN.md:447-448`）。

### 3.5 P5 native tool_search

- **协议**：Responses provider-defined `tool_search`，client execution 模式；模型发 `tool_search_call`，客户端返回 `tool_search_output`，其中包含带 `defer_loading: true` 的 function 定义；下一轮模型可调用被 reveal 的函数。当前 TS 的判定与构造见 `tool-search.ts:248-318`；wire-time 替换见 `llm.ts:965-978`。
- **genai 判定：未覆盖**。§15.2 明确 native tool_search 尚无完整原生契约覆盖；§15.6 明确只复用 `tool_search_call`/`tool_search_output`/`defer_loading` 的 wire 格式，client-execution 循环与 revealed tool 注入归 Chimera。
- **Chimera 职责**：搜索评分/限额、reveal 持久化（DB-backed，`tool-search.ts:373-399`）、compaction 边界的晋升、`tool_search_output` 的合法历史回放、deferred schema 的注入与权限过滤。
- **fixture**：`native-tool-search.client-execution.json`（3 turns：tool_search_call → tool_search_output + revealed function_call → function_call_output + final text）。
- **已知缺口**：不同 OpenAI-native backend 的 `tool_search` 事件名/字段可能漂移；fixture 固定当前 wire 形状，GP-2 需按实际 backend 重新对账。

### 3.6 P6 compaction

- **协议**：v2 走 `/responses` + `input` 末尾 `{type:"compaction_trigger"}` + `stream:true`，从 `response.output_item.done` 的 `compaction` item 取 `encrypted_content`；legacy 走 `/responses/compact` 的 JSON body。当前 TS 见 `remote-compaction.ts:970-999`（provider transport）与 `:1114-1139`（OAuth Codex 分支）；v2 解析见 `:661-696`；协议顺序见 `:595-599`。
- **auth**：OAuth（Codex）或 provider transport；当前 OAuth 分支设置 `originator`、`User-Agent`、`session_id` 等头（`remote-compaction.ts:1118-1129`）。
- **genai 判定：未覆盖**。§15.2 明确 remote compaction 尚无完整原生契约覆盖；§15.6 明确 codex-api 不含 compaction，只复用 wire 格式，端点与逻辑归 Chimera。
- **Chimera 职责**：eligibility（model/provider/credential/protocol）、v2→legacy 顺序与回退、超时/尝试次数、终态错误不跨协议重投、加密输出回放、local fallback。当前 retry/fallback 见 `remote-compaction.ts:1062-1097`。
- **fixture**：`remote-compaction.v2-and-legacy.json`（2 turns：v2 SSE + legacy JSON）。
- **已知缺口**：compaction 的 `encrypted_content` 是不透明 blob；fixture 只验证形状与顺序，不验证真实解密/续接。eligibility 与 provider capability 字段的最终形状由 GP-0 按实际路由回填。

## 4. Hosted tools

### 4.1 当前 TS 支持面

| hosted tool / 事件 | 当前 TS 证据 | packages/llm 映射 | genai 判定 | 归属 |
|---|---|---|---|---|
| `web_search` | `llm.ts:111-127,444-453` 注入；`codex-responses.ts:1298-1321` 序列化；`codex-responses.ts:955-977` 事件 | `openai-responses.ts:543-563,577-604` | 需兼容（声明可透传，事件/metadata 需 adapter） | Chimera adapter |
| `web_search_preview` | 同上；`codex-responses.ts:1308` | `openai-responses.ts:543-563` | 需兼容 | Chimera adapter |
| `file_search` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `code_interpreter` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `computer_use` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `image_generation` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `mcp` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `local_shell` | 当前 TS 未注入；packages/llm 映射存在 | `openai-responses.ts:543-563` | 需兼容（事件映射） | 兼容分支 |
| `tool_search`（provider-defined） | `tool-search.ts:248-318`；`llm.ts:965-978` | 无统一映射；wire 格式由 Chimera 定义 | 未覆盖 | Chimera 自有循环 |
| `compaction` | `remote-compaction.ts:661-696` | 无统一映射；wire 格式由 Chimera 定义 | 未覆盖 | Chimera 自有 |

### 4.2 统一规则

1. hosted tool 是 **provider-executed**：事件必须带 `providerExecuted: true`，结果在同一流内返回；宿主不得再执行一次（`packages/llm/src/protocols/openai-responses.ts:577-604`）。
2. hosted tool 的 `tool-call` 与 `tool-result` 必须使用同一 id；缺失结果或重复结果按 `ordering-contract.md` 的 `PROVIDER_EVENT_ORDER` 处理。
3. hosted tool 的声明/参数必须按 profile 白名单透传；未知 hosted tool 不得静默降级为 function tool（否则模型会按 function 调用，宿主却没有执行器）。
4. `tool_search` 是 client-execution 特例：`providerExecuted` 为 false，宿主执行搜索并返回 `tool_search_output`；不得与 hosted tool 的 provider-executed 规则混用。
5. 任何 hosted tool 的半回合失败都不能“换个后端重跑”成成功；保留片段用于诊断/落账（`RUST_FULL_MIGRATION_PLAN.md:409`）。

## 5. 重试归属

**总原则**：genai 不拥有 retry/replaySafe；它只暴露单回合结果与错误分类。Chimera 决定是否重试、重试几次、是否回退协议/后端，并保证工具调用不重复执行（`RUST_FULL_MIGRATION_PLAN.md:389-392`）。

| 层 | Chimera 行为 | 证据 | genai 角色 | 守卫 |
|---|---|---|---|---|
| HTTP 状态重试 | 429/503/504/529（packages/llm）与 408/409/425/429（Codex）可重试；读取 `Retry-After`/`retry-after-ms` | `packages/llm/src/route/executor.ts:91-97,345-378`；`codex-responses.ts:128-160` | 只返回 status/headers/error；不内部重试 | 只在未发出语义事件时重试 |
| 流式传输重试 | 可重试传输错误（ECONNRESET/ETIMEDOUT 等）有限重试；不可重试 TLS 错误直接失败 | `codex-responses.ts:140-181` | 不重试；adapter 设 `maxRetries=0` 或等价 | `state.replaySafe`（`codex-responses.ts:83-97,324`） |
| WS 重连 | 最多 `WEBSOCKET_STREAM_RETRIES = 5`；不可恢复时 `fallbackHttp = true` | `codex-responses.ts:124-126,347-369` | 不适用（未覆盖） | 重连前 reset session；已发出事件不重放 |
| compaction 尝试/协议 | 每个协议按 attempts 重试 429/5xx；v2 失败后按顺序回退 legacy；终态超时不跨协议重投 | `remote-compaction.ts:1062-1097` | 不适用（未覆盖） | `timeout` 与 `retryable` 分开；`startedAttempts` 记账 |
| auth 401 | 最多刷新一次并重试一次；工具调用不重放 | `plugin/codex.ts:185-239`；`llm.ts:455-483` | 只接收 caller 提供的 token | 无语义输出才允许重试 |

**禁止**：genai 内部隐藏重试、自动继续 tool loop、自动把半截流补成 `finish`。任何新增重试语义必须走 `approved_delta` 并补 fixture（`RUST_FULL_MIGRATION_PLAN.md:296,409`）。

## 6. Token 刷新归属

| 项 | 归属与规则 | 证据 |
|---|---|---|
| API key | 无刷新；请求头直接注入；缺失即失败，不重试 | `packages/llm/src/route/auth.ts:112-150` |
| OAuth 刷新触发 | 请求前若 `access` 缺失或 `expires <= now`，先刷新 | `plugin/codex.ts:185-239`；插件 loader `:531-561` |
| 并发去重 | 同一 credential key 的刷新共享一个 in-flight promise；完成后删除 | `plugin/codex.ts:185-239` |
| 持久化 | 旋转后的 `refresh/access/expires/accountId` 通过 `setAuth` 写回 Chimera auth store | `plugin/codex.ts:217-239`；`llm.ts:455-483` |
| 账号头 | `ChatGPT-Account-ID` 由 accountId 派生；缺失时不发送 | `plugin/codex.ts:238-240` |
| 401/403 | 最多刷新一次并重试一次；不重放已执行的工具调用 | 本包规则；当前 TS 在 `plugin/codex.ts:531-561` 先刷新 |
| WS | 当前 WS 建连只走同步头；异步刷新必须在建连前完成，或按 §15.6 向上游提交补丁 | `codex-responses.ts:733-808`；`RUST_FULL_MIGRATION_PLAN.md:450` |
| genai | 允许异步 resolver 供应动态 token；不得拥有 OAuth 登录/刷新/持久化生命周期 | `RUST_FULL_MIGRATION_PLAN.md:392` |

## 7. Auth 归属矩阵

| profile | credential | 请求头 | 刷新 | 账号头 | 失败策略 |
|---|---|---|---|---|---|
| P1 Chat/API-key | API key | `Authorization: Bearer <key>` | 无 | 无 | 缺失即失败；401 不自动换 key |
| P2 Responses/API-key | API key | 同上 | 无 | 无 | 同上 |
| P3 Responses/OAuth | OAuth | `Authorization: Bearer <access>` | before-expiry，dedupe by credential | `ChatGPT-Account-ID` | 401 最多刷新一次 + 重试一次 |
| P4 WS | OAuth | 同上（WS 建连头） | 建连前完成 | 同上 | 建连失败按 WS 重试/回退 |
| P5 native tool_search | 继承 P2/P3 | 同 P2/P3 | 同 P2/P3 | 同 P2/P3 | 搜索失败返回 `tool-error`，不自动换后端 |
| P6 compaction | OAuth（Codex）或 provider transport | bearer + 账号头 + `originator`/`session_id` | before-expiry | 同上 | 429/5xx 有限重试；终态超时不跨协议 |

## 8. Fixture 映射与覆盖

| profile | fixture | turns | 证明点 |
|---|---|---|---|
| P1 | `chat-api-key.text-and-tool-call.json` | 2 | Chat delta 文本 + delta tool call + tool result 回放 |
| P2 | `responses-api-key.text-and-tool-call.json` | 2 | Responses message/function_call + `function_call_output` 回放 |
| P3 | `responses-oauth.reasoning-and-text.json` | 2 | OAuth 头 + 加密 reasoning 捕获/回放 + text |
| P4 | `responses-websocket.incremental-turn.json` | 2 | WS 首轮 + `previous_response_id` 增量轮 |
| P5 | `native-tool-search.client-execution.json` | 3 | `tool_search_call` → `tool_search_output` → revealed function_call → output |
| P6 | `remote-compaction.v2-and-legacy.json` | 2 | v2 SSE + legacy JSON 的 compaction item 形状 |

覆盖矩阵的判定命令与负例见 `packages/chimera/test/oracle/provider/README.md`。

## 9. 建议与待拍板

### 9.1 建议（未拍板）

- 首个闭环只接 P1；P2 作为第二个独立对账项；P3/P4/P5/P6 先按兼容分支设计。
- genai 固定 `=0.7.2`；adapter 关闭 genai 内部重试；所有 retry/replaySafe 由 Chimera 外层拥有。
- P3 优先用 genai + Chimera auth adapter；若账号头/刷新并发/加密历史任一项未过 GP-2，P3 降级为兼容边。
- P4/P5/P6 优先评估 codex-api 的 wire 层；compaction 与 tool_search 的循环仍归 Chimera；不引入 codex-core。
- 任何 profile 的“通过”必须绑定 fixture + GP-0 的实际路由/model/auth/options 回填，不接受按 provider 名字的批量结论。

### 9.2 待拍板

- D1：首个 profile 是否按“Chat/API-key 先闭环，Responses/OAuth/WS 分开验收”执行（`RUST_FULL_MIGRATION_PLAN.md:352`）。
- D8：是否接受 codex-api vendoring/git pin、Apache-2.0 LICENSE+NOTICE 与上游同步策略（`RUST_FULL_MIGRATION_PLAN.md:359,447-448`）。
- provider 长尾：是否接受“主力 Rust + 长尾 Bun 兼容边”（`RUST_FULL_MIGRATION_PLAN.md:349`）。
- P2 是否在 GP-1 通过后直接进入 W3，还是保留 TS 对照一个发布周期。
- P4/P5/P6 未过 GP-4 时的兼容执行体归属（与 §13 D2 的 sidecar 拓扑一起定）。

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| §15.1 职责 | `RUST_FULL_MIGRATION_PLAN.md:389-392` |
| §15.2 能力分诊 | `RUST_FULL_MIGRATION_PLAN.md:396-403` |
| §15.3 adapter 硬约束 | `RUST_FULL_MIGRATION_PLAN.md:407-410` |
| §15.6 Codex crates | `RUST_FULL_MIGRATION_PLAN.md:432-454` |
| Chat 协议/route | `packages/llm/src/protocols/openai-chat.ts:26-29,91-108,481-499` |
| Responses 协议/route/WS | `packages/llm/src/protocols/openai-responses.ts:28-30,152-166,543-604,959-1021` |
| auth 抽象 | `packages/llm/src/route/auth.ts:17-40,112-150` |
| retry 抽象 | `packages/llm/src/route/executor.ts:91-97,345-378` |
| Codex OAuth 分支 | `packages/chimera/src/session/llm.ts:455-483` |
| Codex 请求/流/WS | `packages/chimera/src/session/codex-responses.ts:228-248,278-287,347-369,497-537,822-1017` |
| Codex auth 刷新 | `packages/chimera/src/plugin/codex.ts:185-239,495-561` |
| native tool_search | `packages/chimera/src/session/tool-search.ts:248-318,373-399`；`llm.ts:965-978` |
| remote compaction | `packages/chimera/src/session/remote-compaction.ts:595-599,661-696,970-999,1062-1097,1114-1139` |