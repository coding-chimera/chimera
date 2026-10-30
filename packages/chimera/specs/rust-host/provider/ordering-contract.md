# WP-08 · 流式事件序与工具调用闭环对账契约

> 依据：`RUST_FULL_MIGRATION_PLAN.md:407-410`（§15.3 adapter 硬约束）、`:262`（WP-08 DoD）、`:296`（oracle 零 diff，不得排序掉因果错误）、`:320`（WP-02/WP-03 提供记录与比较框架）。
> 本文件定义 **provider-neutral 事件账本** 与 **可执行判定**；fixture 与 validator 在 `packages/chimera/test/oracle/provider/`。不实现生产 transport。

## 1. 事件账本词汇

canonical 词汇对齐 `packages/llm/src/schema/events.ts:78-208`；`FinishReason` 取值见 `packages/llm/src/schema/ids.ts:39`。fixture 的 `expected.events` 使用这套词汇，不直接使用 AI SDK 的 `start`/`start-step`/`finish-step`/`error` 拼写。

| canonical 事件 | 关键字段 | 当前 AI SDK / Codex 事件 | 证据 |
|---|---|---|---|
| `step-start` | `index` | `start` + `start-step` | `codex-responses.ts:250-276` |
| `text-start` | `id` | `text-start` | `codex-responses.ts:838-847` |
| `text-delta` | `id`、`text` | `text-delta` | `codex-responses.ts:875-883` |
| `text-end` | `id` | `text-end` | `codex-responses.ts:926-935` |
| `reasoning-start` | `id`、`providerMetadata` | `reasoning-start` | `codex-responses.ts:849-861,895-910` |
| `reasoning-delta` | `id`、`text` | `reasoning-delta` | `codex-responses.ts:911-925` |
| `reasoning-end` | `id`、`providerMetadata` | `reasoning-end` | `codex-responses.ts:936-953` |
| `tool-input-start` | `id`、`name` | `tool-input-start` | `codex-responses.ts:867-872` |
| `tool-input-delta` | `id`、`name`、`text` | `tool-input-delta` | `codex-responses.ts:884-893` |
| `tool-input-end` | `id`、`name` | `tool-input-end` | `codex-responses.ts:979-999` |
| `tool-call` | `id`、`name`、`input`、`providerExecuted?` | `tool-call` | `codex-responses.ts:988-997` |
| `tool-result` | `id`、`name`、`result`、`providerExecuted?` | `tool-result` | `codex-responses.ts:1170-1201` |
| `tool-error` | `id`、`name`、`message` | `tool-error` | `codex-responses.ts:1183-1200` |
| `step-finish` | `index`、`reason`、`usage?` | `finish-step` | `codex-responses.ts:454-482` |
| `finish` | `reason`、`usage?` | `finish` | `codex-responses.ts:478-482` |
| `provider-error` | `message`、`retryable?` | `error` | `codex-responses.ts:1001-1017` |

**映射规则**：canonical `step-start.index` 由 adapter 按回合内序号生成；当前 AI SDK 的 `start`/`start-step` 是两个事件，adapter 必须合并为一个 canonical `step-start`，不得把 `start-step.request` 的请求体泄漏到事件账本。`provider-error` 是终态，不产生 `finish`。

## 2. 保序不变量

| 代码 | 不变量 | 失败示例 |
|---|---|---|
| `PROVIDER_STREAM_SEQ` | 传输帧 `seq` 从 1 连续；不得重复/缺口；`[DONE]` 不是帧 | 丢一帧 / 重复一帧 |
| `PROVIDER_EVENT_SEQ` | canonical 事件 `seq` 从 1 连续 | 合并事件后序号跳号 |
| `PROVIDER_EVENT_ORDER` | 内容块 start→delta→end；tool-call 在 host 的 tool-input-end 之后；tool-result/error 在 tool-call 之后；同一调用恰好一个终态；`step-finish` 在 `finish` 前；终态后不得再有事件 | result 在 call 前 / 重复 result / 文本 delta 无 start |
| `PROVIDER_TOOL_CLOSURE` | 第 N 轮的 host tool call 必须在第 N+1 轮请求中带匹配输出；新出现的输出必须对应上一轮 call；历史输出可重放；call_id 稳定且不重复 | 缺 `function_call_output` / 孤立 tool 消息 |
| `PROVIDER_TERMINAL` | 恰好一个 `finish` 或 `provider-error`，且为最后事件；传输终帧与声明终态一致；Chat 的 usage-only chunk 可在 finish_reason 帧之后 | EOF 后补 `finish` / `response.completed` 后还有文本 |
| `PROVIDER_STREAM_EOF` | 不完整 SSE 块 / 终态前 EOF 必须报错，不得补成功 | 半截 `data:` 被当作成功 |
| `PROVIDER_RETRY_REPLAY` | 仅在未发出语义事件时重试；不得重复终态/工具执行；compaction 终态超时不跨协议重投 | 重试后出现两个 `finish` |
| `PROVIDER_AUTH` | auth 头/账号头与 auth fixture 一致；不得出现未脱敏凭据 | 请求头与 auth 声明不一致 |

## 3. 工具调用闭环

### 3.1 一轮 assistant 的调用集合

1. 同一 assistant 回合的多个工具调用必须在 **同一组** `tool-input-start/delta/end` 之后，以 **一个** `tool-call` 事件集合回放；不得把 call 和它的 result 交错进同一个 assistant 消息。
2. 下一轮请求先回放 assistant 消息（包含完整调用集合），再回放每个 tool result；Chat 用 `role:"tool"` + `tool_call_id`，Responses/WS 用 `{type:"function_call_output", call_id, output}`。
3. `call_id` 在请求、流、历史回放中保持稳定；不得重新编号或按位置猜配。
4. 同一 `call_id` 只能有一个 `tool-result` 或 `tool-error`；重复终态是 `PROVIDER_EVENT_ORDER`。

### 3.2 非法/截断输入

- 工具参数 JSON 非法或截断时，**不得执行**；adapter 必须按 registry schema 报错或进入可审计恢复（`RUST_FULL_MIGRATION_PLAN.md:408`）。
- 不能把 SDK 的 String 容错当作已验证工具输入；保留片段用于诊断/落账，清理由 host 显式负责（`RUST_FULL_MIGRATION_PLAN.md:409`）。
- EOF/取消/超时不得补成成功，也不得执行半截 tool-call；已发出的片段保留，终态写 `provider-error` 或 `tool-error`。

### 3.3 provider-executed 与 client-execution

| 类型 | `providerExecuted` | 结果位置 | 宿主是否执行 |
|---|---|---|---|
| hosted tool（web_search/file_search/...） | `true` | 同一流内 `tool-result` | 否；宿主不得重复执行 |
| native `tool_search`（client execution） | `false` | 同一轮 `tool-result` + 下一轮 `tool_search_output` | 是；搜索/reveal 由 Chimera 执行 |
| 普通 function tool | 省略/false | 下一轮请求的 tool result | 是；由测试 caller / host 执行 |

`tool_search` 的 `tool_search_output` 必须作为合法历史项回放，不能改写成 function tool 的 `tool_result` 形状；否则 OpenAI-native 后端会拒绝历史（`packages/chimera/src/session/tool-search.ts:285-289`）。

## 4. Chat 工具参数的 capture 模式

genai 的 OpenAI streamer 在 `capture_tool_calls=true` 时，chunk 里是 **累计快照**，不是 delta；不能再当 delta 拼接（`RUST_FULL_MIGRATION_PLAN.md:400,427`）。adapter 必须显式声明模式：

| 模式 | 输入 | 归一化 |
|---|---|---|
| `delta` | 每个 chunk 只带新增片段 | 直接累加为完整 arguments |
| `cumulative` | 每个 chunk 带截至当前的完整 arguments | 用当前快照替换，不拼接；只发一个 `tool-call` |

fixture `chat-api-key.text-and-tool-call.json` 使用 `delta` 模式；GP-1 必须用同一 cassette 分别以 `delta`/`cumulative` 两种 chunk 切法重放，证明归一化后事件账本一致（`RUST_FULL_MIGRATION_PLAN.md:198`）。

## 5. SSE / WS / JSON framing

### 5.1 SSE

- 以空行分隔 block；每个 block 的 `data:` 行用 `\n` 连接；`[DONE]` 忽略；支持 `\r\n`。
- 尾部不完整 block 必须抛 `UnexpectedSSEEOFError`，不得静默丢弃或补成功（`codex-responses.ts:1203-1244`）。
- 终帧：
  - Responses：`response.completed` / `response.incomplete` / `response.failed` / `error`。
  - Chat：`choices[0].finish_reason` 非 null；usage-only chunk（`choices: []`）可在其后。
- 不得把 `event:` 名称当唯一判据；以 `data.type`/`finish_reason` 为准，`event:` 只作辅助。

### 5.2 WebSocket

- 每条消息是一个 JSON 对象；无 SSE 的 `data:`/空行 framing。
- 请求是 `{type:"response.create", ...}`；首轮带完整 `input`，增量轮带 `previous_response_id` + delta `input`。
- `client_metadata` 可携带 turn state；不得把 turn state 写进日志或 fixture 的真实值（fixture 用 `turn-state-placeholder`）。
- WS 消息的 `seq` 由 fixture 的物理顺序定义；真实 WS 没有 SSE 的 `seq` 字段，adapter 必须在归一化时生成。

### 5.3 legacy JSON

- compaction legacy 是一次 JSON body，不是流；`terminal` 固定 `completed`，结果从 `output` 数组取。
- JSON body 不得被当作 SSE 再解析一遍；transport 由 profile 声明。

## 6. 对账算法

```text
1. decode transport frames
   - SSE: split blocks, join data lines, ignore [DONE], reject partial tail
   - WS: parse each JSON message
   - JSON: parse body once
2. normalize to canonical events
   - map provider item types -> canonical event types
   - synthesize step-start index
   - apply capture mode (delta/cumulative) for Chat tool args
3. per-stream sequence check
   - frame seq contiguous; event seq contiguous
4. causal order check
   - block start/delta/end; call before result; step-finish before finish; terminal last
5. terminal check
   - exactly one finish/provider-error; transport terminal matches declared terminal
6. cross-turn tool closure
   - every host call has a next-turn output; new output matches previous call;
     historical outputs may replay; no orphan/duplicate
7. compare to expected
   - canonical JSON compare; first difference reported with path
8. never globally sort
   - sorting hides lost/duplicate events; duplicates are errors, not dedupe
```

**禁止**：为让 diff 通过而排序事件、过滤丢失事件、把重复事件去重、把 `provider-error` 改写成 `finish`。这些都属于 `approved_delta` 才能引入的行为（`RUST_FULL_MIGRATION_PLAN.md:296`）。

## 7. 重试/刷新与保序的交互

- **重试前**：只有 `replaySafe = true`（尚未发出语义事件）才允许重试；一旦发出 `text-delta`/`tool-call`/`tool-result`，重试必须终止，保留片段并报错（`codex-responses.ts:83-97,324`）。
- **auth 刷新**：在请求前完成；401 最多刷新一次并重试一次；不得重放已执行的工具调用。
- **WS 重连**：可重试错误有限重连；不可恢复时回退 HTTP；已发出的语义事件不重放（`codex-responses.ts:347-369`）。
- **compaction**：终态超时不得跨协议重投；只有可重试的 429/5xx 才按 attempts 重试（`remote-compaction.ts:1062-1097`）。
- **工具执行**：重试/刷新永远不重新执行工具；工具结果只能从已记录的历史回放。

## 8. 负例与期望代码

| 负例 | 破坏方式 | 期望代码 |
|---|---|---|
| `real-endpoint` | `synthetic://` 改为非 `synthetic://` 端点 | `PROVIDER_ENDPOINT` |
| `leaked-api-key` | `Authorization` 写入非脱敏 Bearer 值 | `PROVIDER_SECRET` |
| `home-path` | description 写入 home 绝对路径 | `PROVIDER_SECRET` |
| `unknown-profile` | profile 改为未知值 | `PROVIDER_PROFILE` |
| `capability-drift` | Chat 的 verdict 改为 `uncovered` | `PROVIDER_CAPABILITY` |
| `result-before-call` | 把 `tool-result` 移到 `tool-call` 前 | `PROVIDER_EVENT_ORDER` |
| `missing-tool-result` | 删掉下一轮 `role:"tool"` 消息 | `PROVIDER_TOOL_CLOSURE` |
| `missing-call-replay` | 删掉下一轮请求中 assistant 的 `tool_search_call`/`function_call` 回放 | `PROVIDER_TOOL_CLOSURE` |
| `duplicate-tool-output` | 同一请求内重复同一 `call_id` 的 tool output | `PROVIDER_TOOL_CLOSURE` |
| `sse-seq-gap` | 删一帧但保留后续 seq | `PROVIDER_STREAM_SEQ` |
| `terminal-after-error` | `provider-error` 后再加 `finish` | `PROVIDER_EVENT_ORDER` |
| `unclosed-text` | 删 `text-end` | `PROVIDER_EVENT_ORDER` |

前九组已由 `provider.test.ts` 覆盖；其余是 WP-03 fault matrix 的扩展点，不在本包实现。

## 9. Fixture 覆盖

| profile | 覆盖的保序点 |
|---|---|
| P1 Chat/API-key | Chat delta tool args、tool-call→下一轮 tool 消息、usage-only chunk |
| P2 Responses/API-key | message/function_call、`function_call_output` 闭环、usage 终帧 |
| P3 Responses/OAuth | encrypted reasoning start/delta/end、reasoning 历史回放、text 块 |
| P4 WS | WS JSON framing、`previous_response_id` 增量轮、turn state |
| P5 native tool_search | `tool_search_call`→`tool_search_output`→revealed function_call→output、历史输出重放 |
| P6 compaction | v2 SSE `compaction` item、legacy JSON、无事件流的结果账本 |

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| canonical 事件 schema | `packages/llm/src/schema/events.ts:78-208` |
| FinishReason | `packages/llm/src/schema/ids.ts:39` |
| Codex 流事件映射 | `packages/chimera/src/session/codex-responses.ts:822-1017` |
| Codex 终态/finish | `packages/chimera/src/session/codex-responses.ts:454-482,1001-1017` |
| Codex SSE parser | `packages/chimera/src/session/codex-responses.ts:1203-1244` |
| Codex 工具执行 | `packages/chimera/src/session/codex-responses.ts:1170-1201` |
| Codex 重试/回退 | `packages/chimera/src/session/codex-responses.ts:124-181,347-369` |
| compaction 协议/解析 | `packages/chimera/src/session/remote-compaction.ts:595-599,661-696,1062-1097` |
| native tool_search wire | `packages/chimera/src/session/tool-search.ts:248-318` |
| §15.3 硬约束 | `RUST_FULL_MIGRATION_PLAN.md:407-410` |
| oracle 零 diff / 不排序 | `RUST_FULL_MIGRATION_PLAN.md:296` |