# WP-08 · Provider profile fixture 与 validator

> 状态：**building 交付物**（WP-08，`contract_rev = cr-2026-10-30-r1`）。
> 依据：`RUST_FULL_MIGRATION_PLAN.md:262`（WP-08 DoD）、`packages/chimera/specs/rust-host/manifest.yaml:215-236`（WP-08 manifest 条目）、`packages/chimera/specs/rust-host/provider/`（profile 准入与保序契约）、`packages/chimera/test/oracle/transcript/`（WP-02 canonical JSON/摘要工具，只读复用）。
> 本目录只做 **合成 fixture、判定 harness、负例**；不调用真实 provider、不编译 Rust、不写生产 transport。

## 1. 结论先行

- 六项 profile 各 ≥1 组请求/流式事件 fixture：Chat/API-key、Responses/API-key、Responses/OAuth、WS、native tool_search、remote compaction。
- 每组 fixture 都有 **请求、auth 放置、传输帧、canonical 事件账本、终态**；validator 校验格式、流序号、事件序、工具调用闭环、终态与敏感信息。
- `bun run test/oracle/provider/run.ts` 当前 **6 fixtures / 6 profiles / 0 issues**；`bun test` 入口 12 pass / 0 fail。
- fixture 是 **协议级合成数据**，不是真实 cassette；真实网络 chunk 边界、真实账号/模型行为由 GP-0/GP-2 在隔离环境验证。

## 2. 目录结构

```text
packages/chimera/test/oracle/provider/
├── README.md                 # 本文件
├── format.ts                 # fixture v1 类型、profile 期望表、canonical 事件词汇、digest
├── validate.ts               # 纯校验函数 + 目录 suite runner + 渲染
├── run.ts                    # CLI 入口（默认校验 fixtures/）
├── provider.test.ts          # bun test 入口（含 9 组负例）
└── fixtures/
    ├── chat-api-key.text-and-tool-call.json
    ├── responses-api-key.text-and-tool-call.json
    ├── responses-oauth.reasoning-and-text.json
    ├── responses-websocket.incremental-turn.json
    ├── native-tool-search.client-execution.json
    └── remote-compaction.v2-and-legacy.json
```

## 3. fixture 格式 v1

### 3.1 顶层

```json
{
  "format": "chimera.oracle.provider-fixture",
  "version": 1,
  "contract_rev": "cr-2026-10-30-r1",
  "profile": "chat-api-key",
  "case": "text-and-tool-call",
  "description": "…",
  "capabilities": {
    "genai_verdict": "takeover",
    "transport": "sse",
    "auth": "api-key",
    "native_tool_search": false,
    "remote_compaction": false,
    "hosted_tools_exercised": [],
    "retry_owner": "chimera",
    "auth_refresh_owner": "chimera"
  },
  "turns": []
}
```

- `profile` 必须是 `format.ts` 的六个 id 之一；`capabilities` 必须与 `PROFILE_EXPECTATIONS` 一致（verdict/transport/auth/native/compaction）。
- `retry_owner` 与 `auth_refresh_owner` 固定为 `chimera`；这是 DoD 2 的机检点。
- `hosted_tools_exercised` 只列本 fixture 实际触达的 hosted/provider-defined 工具；native tool_search fixture 列 `tool_search`。

### 3.2 turn

```json
{
  "turn": 1,
  "request": {
    "method": "POST",
    "endpoint": "synthetic://provider/...",
    "headers": {},
    "body": {}
  },
  "auth": {
    "kind": "api-key",
    "placement": "header",
    "name": "authorization",
    "value": "Bearer <REDACTED:API_KEY>",
    "refresh": { "owner": "chimera", "strategy": "none", "dedupe_key": "none" }
  },
  "stream": {
    "transport": "sse",
    "terminal": "completed",
    "frames": [{ "seq": 1, "event": "…", "data": {} }]
  },
  "expected": {
    "terminal": "completed",
    "events": [{ "seq": 1, "type": "step-start", "index": 0 }],
    "tool_calls": [],
    "tool_results": [],
    "result": {}
  }
}
```

- `endpoint` 只能以 `synthetic://` 开头；禁止 `http(s)://`、`ws(s)://`、`file://`、IP、`localhost`、内网域名。
- `headers` 的 auth 头必须与 `auth.name`/`auth.value` 一致；OAuth 必须有 `account_header`，值固定 `acct-placeholder`。
- `stream.transport` 为 `sse`、`websocket-json`、`json`；`stream.terminal` 为 `completed`/`incomplete`/`failed`/`error`。
- `frames[].seq` 从 1 连续；SSE 的 `done_marker` 只能是 `[DONE]`；Chat 的 usage-only chunk 可以出现在 `finish_reason` 帧之后。
- `expected.events` 使用 canonical 词汇（`step-start` … `provider-error`），`seq` 从 1 连续；`expected.result` 用于非流式结果（compaction legacy/v2）。
- `expected.tool_calls[].executed_by` 为 `host` 或 `provider`；host call 必须在下一轮请求中有匹配输出。

### 3.3 canonical 事件词汇

`step-start`、`text-start`、`text-delta`、`text-end`、`reasoning-start`、`reasoning-delta`、`reasoning-end`、`tool-input-start`、`tool-input-delta`、`tool-input-end`、`tool-call`、`tool-result`、`tool-error`、`step-finish`、`finish`、`provider-error`。

与 AI SDK 事件的映射见 `packages/chimera/specs/rust-host/provider/ordering-contract.md` §1。

## 4. 校验规则

### 4.1 格式与 profile

- `format`/`version`/`contract_rev` 精确匹配。
- `profile` 必须是六个之一；`capabilities` 与 `PROFILE_EXPECTATIONS` 一致。
- `turns.length` 不少于 profile 的最小轮数；每轮 `turn` 序号从 1 连续。
- native tool_search profile 的请求必须包含 `type:"tool_search"` 工具声明；compaction profile 必须包含 `type:"compaction_trigger"` 输入。

### 4.2 传输与终态

- 帧 `seq` 连续；最后一个终帧必须匹配 `stream.terminal`。
- SSE：`response.completed`/`incomplete`/`failed`/`error`，或 Chat 的 `finish_reason`；终帧后只允许 usage-only chunk。
- WS：`response.*` 终态；JSON：单 body。
- `done_marker` 出现时必须是 `[DONE]`。

### 4.3 事件序

- 内容块 start→delta→end；不得重复 start、不得无 start 的 delta/end。
- host `tool-call` 必须在 `tool-input-end` 之后；`tool-result`/`tool-error` 必须在 `tool-call` 之后；同一调用恰好一个终态。
- `step-finish` 在 `finish` 前；`finish` 是最后事件；`provider-error` 是终态，不得再出现事件。
- 事件 `seq` 连续；不得排序/去重/过滤。

### 4.4 工具调用闭环

- 第 N 轮 host call 必须在第 N+1 轮请求中有匹配输出（Chat `role:"tool"` + `tool_call_id`；Responses/WS `function_call_output`/`tool_search_output`）。
- 请求必须先回放 assistant 的调用项（Chat `tool_calls[]`；Responses/WS `function_call`/`tool_search_call`），再回放对应输出；缺 call 回放按 `PROVIDER_TOOL_CLOSURE` 报错。增量 WS 请求以 `previous_response_id` 引用服务端历史，不要求本地重放 call。
- 新出现的输出必须对应上一轮 call；历史输出可以重放；同一请求内同一 `call_id` 只允许一个输出项，不得有孤立/重复输出。
- provider-executed 调用必须同流有结果；host 调用不得在流内伪造结果。

### 4.5 敏感信息

- 禁止真实 URL、IP、`localhost`、内网域名、`.local`、home 绝对路径、API key/GitHub/Slack/AWS/PEM/未脱敏 Bearer。
- auth 字段只允许 `<REDACTED:...>`、`Bearer <REDACTED:...>`、`acct-placeholder`、`session-placeholder`。
- 模型只允许公开通用名或 `codex 后端` 占位。

## 5. 覆盖矩阵

| profile | fixture | turns | 覆盖点 |
|---|---|---|---|
| Chat/API-key | `chat-api-key.text-and-tool-call.json` | 2 | Chat delta 文本 + delta tool call + 下一轮 tool 消息 + usage-only chunk |
| Responses/API-key | `responses-api-key.text-and-tool-call.json` | 2 | message/function_call + `function_call_output` 回放 + usage 终帧 |
| Responses/OAuth | `responses-oauth.reasoning-and-text.json` | 2 | OAuth 头 + encrypted reasoning 捕获/回放 + text |
| WS | `responses-websocket.incremental-turn.json` | 2 | WS JSON + `previous_response_id` 增量轮 + turn state |
| native tool_search | `native-tool-search.client-execution.json` | 3 | `tool_search_call` → `tool_search_output` → revealed function_call → output |
| remote compaction | `remote-compaction.v2-and-legacy.json` | 2 | v2 SSE compaction item + legacy JSON body |

## 6. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 主判定：六项 profile + 事件序 + 工具闭环 + 敏感信息
bun run test/oracle/provider/run.ts

# bun test：覆盖矩阵 + digest 稳定性 + 9 组负例
bun test --timeout 30000 test/oracle/provider/provider.test.ts

# 包级类型检查（统一门禁）
bun typecheck
```

输出示例：

```text
PASS chat-api-key.text-and-tool-call.json profile=chat-api-key turns=2 events=17 frames=8 digest=…
…
RESULT: PASS (6 fixtures, 6/6 profiles, 0 issues)
```

`digest` 是 fixture 的 canonical JSON SHA-256；两次运行 digest 一致证明 fixture 字节稳定，不依赖时间/路径/随机源。

## 7. 负例

`provider.test.ts` 覆盖 9 组故意破坏：

| 负例 | 破坏方式 | 期望代码 |
|---|---|---|
| `real-endpoint` | endpoint 改为非 `synthetic://` 端点 | `PROVIDER_ENDPOINT` |
| `leaked-api-key` | `Authorization` 写入非脱敏 Bearer 值 | `PROVIDER_SECRET` |
| `home-path` | description 写入 home 绝对路径 | `PROVIDER_SECRET` |
| `unknown-profile` | profile 改为未知值 | `PROVIDER_PROFILE` |
| `capability-drift` | Chat verdict 改为 `uncovered` | `PROVIDER_CAPABILITY` |
| `result-before-call` | `tool-result` 移到 `tool-call` 前 | `PROVIDER_EVENT_ORDER` |
| `missing-tool-result` | 删掉下一轮 `role:"tool"` 消息 | `PROVIDER_TOOL_CLOSURE` |
| `missing-call-replay` | 删掉下一轮请求中 assistant 的 `tool_search_call` 回放 | `PROVIDER_TOOL_CLOSURE` |
| `duplicate-tool-output` | 同一请求内重复同一 `call_id` 的 tool output | `PROVIDER_TOOL_CLOSURE` |

这些负例只验证 **validator 会报错**；完整 fault matrix（丢失/乱序/重复/中断/部分写/超时/取消/重放）是 WP-03 的范围（`RUST_FULL_MIGRATION_PLAN.md:257`）。

## 8. 与 WP-02 的关系

- `format.ts` 复用 `packages/chimera/test/oracle/transcript/format.ts` 的 `canonicalJson` 与 `sha256`（只读引用，不修改）。
- fixture 不写时间戳、随机 id、host 路径；auth 只写占位符；因此 digest 可跨环境稳定。
- WP-02 的 transcript 记录的是 session 级四类事件；本目录记录的是 provider 协议级请求/流事件。两者通过 canonical JSON 与“物理序 = 因果序”原则对齐，但不共享 golden 文件。

## 9. 已知限制

- **不是真实 cassette**：不证明真实 provider 的 chunk 边界、错误体、账号行为；GP-0/GP-2 必须在隔离环境重放真实/录制数据。
- **不覆盖多工具同帧**：当前 fixture 每轮一个 host call；多调用同帧、碎片/累计参数、reasoning/text 混合由 GP-2 扩展。
- **不覆盖故障矩阵**：EOF/取消/超时/429/重放由 WP-03 + GP-2 覆盖；本包只给事件序与终态判据。
- **compaction 的 encrypted blob 是不透明的**：fixture 只验证形状/顺序，不验证真实解密/续接。
- **WS 的真实 `seq` 不存在**：fixture 的 `seq` 是物理帧序；adapter 归一化时必须生成，不得假设 wire 带序号。

## 10. 建议与待拍板

### 10.1 建议（未拍板）

- 把本目录的六项 fixture 作为 GP-0 的最小重放集；GP-2 只扩展，不另起事件词汇。
- GP-1 用同一 cassette 以 `delta`/`cumulative` 两种 chunk 切法重放 Chat，证明归一化后账本一致。
- fixture digest 进 GP-0/GP-1 结果记录；不要提交生成的 golden，除非 parent 决定纳入 `approved_delta` 流程。

### 10.2 待拍板

- fixture v1 是否升级为跨语言共享契约（若升级，按 `partition-table.md:133` 递增 `contract_rev`）。
- 真实 cassette 的隐私边界（哪些 prompt/tool 字段必须脱敏、是否允许落盘）由哪个包定义。
- P4/P5/P6 的真实 wire 形状是否需要在 GP-0 按实际 backend 重新录制。

## 11. 自验记录（本批实测）

| 命令 | 结果 |
|---|---|
| `cd packages/chimera && bun run test/oracle/provider/run.ts` | PASS（6 fixtures，6/6 profiles，0 issues） |
| `cd packages/chimera && bun test --timeout 30000 test/oracle/provider/provider.test.ts` | 12 pass / 0 fail（29 assertions） |
| `cd packages/chimera && bun typecheck` | 通过（tsgo --noEmit，无输出）；新增 TS 只依赖既有 `test/oracle/transcript/format.ts` 与 Node/Bun 标准库 |

## 12. 证据索引

| 证据 | 位置 |
|---|---|
| WP-08 DoD | `RUST_FULL_MIGRATION_PLAN.md:262` |
| §15.4 GP-0..GP-4 | `RUST_FULL_MIGRATION_PLAN.md:414-420` |
| §15.6 Codex crates | `RUST_FULL_MIGRATION_PLAN.md:432-454` |
| profile 准入表 | `packages/chimera/specs/rust-host/provider/profile-admission.md` |
| 保序契约 | `packages/chimera/specs/rust-host/provider/ordering-contract.md` |
| genai 准入 | `packages/chimera/specs/rust-host/provider/genai-admission.md` |
| WP-02 canonical JSON | `packages/chimera/test/oracle/transcript/format.ts:136-160` |
| packages/llm 事件 schema | `packages/llm/src/schema/events.ts:78-208` |
| packages/llm recorded-golden | `packages/llm/test/recorded-golden.ts:58-93` |
| packages/llm recorded-scenarios | `packages/llm/test/recorded-scenarios.ts:91-121,206-213,275-284` |