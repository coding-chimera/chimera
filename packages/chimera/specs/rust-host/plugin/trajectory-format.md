# WP-09 · plugin hook 轨迹格式 v1（replay fixture 契约）

> 状态：**building 交付物**（WP-09，`contract_rev = cr-2026-10-30-r1`）。
> 依据：WP-02 transcript v1（`packages/chimera/test/oracle/transcript/README.md:52-85`、`format.ts:1-281`）；WP-09 DoD（`RUST_FULL_MIGRATION_PLAN.md:263`）；分区 `T/plugin/**`（`packages/chimera/specs/rust-host/partition-table.md:36,59`）。
> 本文定义 `test/oracle/plugin/` 下的轨迹格式与判定层；它是 fixture 契约，不是生产 recorder。

## 0. 结论先行

- 轨迹是 **canonical JSONL**：header 一行、event 1..N 行、footer 一行；`seq` 等于物理序号；footer 覆盖 header+events 的 sha256。与 WP-02 transcript v1 同构，但 `format` 独立，避免两种轨迹被互相误解析。
- 与 WP-02 的两个有意差异：
  1. `format = "chimera.oracle.plugin.hook-trace"`，`work_id = "WP-09"`，`synthetic` 必须为 `true`。
  2. **允许有限小数**：`chat.params` 的 `temperature`/`topP` 是浮点，WP-02 的 integer-only canonical JSON 会拒绝。本格式用 `JSON.stringify` 的稳定十进制表示；`NaN`/`Infinity` 拒绝。
- 判定分十层：完整性 → 注册顺序 → 取消 → 阶段顺序 → 重入 → hook 顺序 → mutation 链 → auth → 失败策略 → replay 字节一致。每层有稳定错误码；负例逐项断言精确码。
- 轨迹是**合成**的：header 的 `synthetic: true` 是硬校验；fixture 只使用 `synthetic://`、`ses_synthetic`、`demo.*`，不写真实 URL/路径/凭据/时间戳。

## 1. 行结构

```text
line 1              header   {"record":"header", ...}
line 2..N+1         event    {"kind":"<event-kind>","seq":1..N, ...}
line N+2            footer   {"record":"footer","event_count":N,"body_sha256":"<hex>"}
```

- 一行一个 JSON 对象，UTF-8，文件以换行结尾；空行不允许。
- `seq` 必须等于事件在文件中的物理序号（1 起连续）；物理顺序就是因果顺序。
- footer 的 `body_sha256` 覆盖 `header + 所有 event` 的精确字节（含末尾换行），不覆盖 footer 自身。
- 解析顺序：结构 → format/version/contract_rev/work_id/synthetic → body digest → event_count → 每行 JSON/kind/seq/字段。

### 1.1 Header

```json
{
  "record": "header",
  "format": "chimera.oracle.plugin.hook-trace",
  "version": 1,
  "contract_rev": "cr-2026-10-30-r1",
  "work_id": "WP-09",
  "trajectory": "session-six-hooks",
  "synthetic": true,
  "description": "Synthetic one-session hook trace: ..."
}
```

`synthetic` 必须是 `true`；缺失或 `false` 直接拒绝（`TRACE_SYNTHETIC`）。这是防止把合成 fixture 冒充真实录制。

### 1.2 Canonical JSON 规则

- 对象键递归排序；数组保持原序。
- 允许 `null` / boolean / string / 有限 number / array / object。
- number 用 `JSON.stringify` 的规范十进制（`0.5`、`1`、`1e+21`）；`NaN`/`Infinity` 拒绝（`TRACE_NUMBER`）。
- `undefined`（含对象属性值）拒绝（`TRACE_UNDEFINED`）；不能静默丢弃。
- 不写入时间戳、随机 id、绝对路径、host 名、凭据；资源用 `synthetic://...`。

> 与 WP-02 的关系：footer/digest/seq/canonical-key-order 规则相同；`canonicalJson` 的 integer-only 约束被本格式的 `canonicalTraceJson` 放宽。`sha256`/`utf8ByteLength` 直接复用 `../transcript/format.ts`（只读引用）。

## 2. 事件类型

| `kind` | 关键字段 | 用途 |
|---|---|---|
| `plugin.registered` | `plugin_id`、`origin`（`internal`/`config`）、`order`、`hooks` | 注册顺序；`order` 必须 0..N-1；internal 必须在 config 之前 |
| `operation.start` | `op`、`op_id`、`detail` | 会话阶段边界；`op` 见下表 |
| `operation.end` | `op`、`op_id`、`status`（`ok`/`error`/`cancelled`）、`error_code` | 阶段终态；取消在这里体现 |
| `hook.start` | `hook`、`hook_class`、`scope`、`plugin_id`、`input`、`output` | 一次插件 hook 开始；`output` 是调用前的共享对象快照 |
| `hook.mutate` | `hook`、`scope`、`plugin_id`、`path`、`before`、`after` | 一次可观察修改；`path` 是点分路径；缺失字段的 `before` 为 `null` |
| `hook.end` | `hook`、`scope`、`plugin_id`、`status`、`error_code` | hook 正常/失败结束；取消的 hook 没有 end |
| `sdk.call` | `hook`、`scope`、`plugin_id`、`method`、`status`、`error_code` | hook 内对 host SDK 的嵌套调用（重入） |
| `auth.refresh` | `scope`、`provider_id`、`trigger`、`single_flight`、`concurrent_requests`、`persist`、`expires_delta_s` | 惰性 refresh 的事实 |
| `snapshot` | `scope`、`name`、`value` | 该 scope 的最终共享对象；用于 replay 对账 |

`operation` 取值：`bootstrap`、`provider.init`、`tool.list`、`llm.request`、`tool.execute`、`session.dispose`。

`hook` 取值（7 个 hook 名）：`config`、`tool.definition`、`chat.params`、`chat.headers`、`tool.execute.before`、`tool.execute.after`、`auth.loader`。`auth.refresh` 不是插件 hook，只出现在 `auth.refresh`/`sdk.call` 事件里。
`hook_class` 取值（6 类）：`config-bootstrap`、`tool-definition`、`chat-params-headers`、`tool-execute-before`、`tool-execute-after`、`auth-refresh`。`hook_class` 必须与 `hook` 匹配（例如 `chat.params`/`chat.headers` → `chat-params-headers`）。

### 2.1 输入归一化约定

`hook.start.input` 是**调用上下文**，不是 hook 实参的副本；`output` 是共享对象在该次调用前的快照。生产 TS 的 hook 实参使用 camelCase，轨迹统一为 snake_case；转换只发生在 recorder 边界（生产 → 轨迹），verifier 与 replay 不反向改写。Rust recorder 必须按下表归一化后再编码。

| 轨迹字段（snake_case） | 生产字段（camelCase / 来源） | 出现位置 |
|---|---|---|
| `tool_id` | `toolID`（`tool.definition` 的 input） | `tool.definition` 的 `hook.start.input` |
| `session_id` | `sessionID`（`chat.params`/`chat.headers`/`tool.execute.*` 的 input） | 对应 hook 的 `input`；`operation.start.detail` |
| `call_id` | `callID`（`tool.execute.before`/`tool.execute.after` 的 input） | 对应 hook 的 `input`；`operation.start.detail`；`before:`/`after:` scope |
| `provider_id` | `providerID`（provider 记录 id） | `auth.loader` 的 `input`；`auth.refresh`；`operation.start.detail` |
| `model_id` | `model.api.id`（模型对象里的字符串 id） | `operation.start.detail` |
| `auth_type` | `auth.type`（存储凭据的判别字段） | `auth.loader` 的 `input` |
| `tool` | `tool`（同形） | `tool.execute.before`/`after` 的 `input`；`operation.start.detail` |
| `agent` | `agent`（`input.agent.name` 的字符串） | `chat.params`/`chat.headers` 的 `input` |

归一化规则：

- 只保留关联键：`chat.params`/`chat.headers` 的生产 input 还带 `model`、`provider`、`message` 对象；轨迹不复制这些大对象，只保留 `session_id`/`agent`，模型身份放到 `operation.start.detail.model_id`。
- 未设置的可选值写 `null`（例如 `chat.params.maxOutputTokens`），不写 `undefined`（canonical JSON 拒绝 `undefined`）。
- 函数与运行时对象永不序列化：函数用布尔标记代替（见下文 `auth.loader`），Model/Provider/消息对象只取上述标量。
- `op_id` 是轨迹本地关联 id，不对应生产字段；生产侧没有稳定对应物时由 recorder 生成，并在 header 的 `trajectory` 内唯一。

**config（单参数直调）**：生产调用是 `hook.config?.(cfg)`，只有一个参数，插件原地修改同一个 config 对象。轨迹建模为：

- `input` 只放来源描述（fixture 为 `{ "source": "synthetic://workspace/chimera.json" }`），不是 config 副本；
- `output` 是该插件运行前共享 config 的快照；插件对 config 的每处原地修改编码为 `hook.mutate`；
- 后一个插件的 `output` 等于前一个插件修改后的状态；全部插件结束后用 `snapshot` 记录最终 config。

**auth.loader（函数形态）**：生产调用是 `loader(getAuth, provider)`，第一个参数是函数，第二个是 provider 对象。轨迹建模为：

- `input` 只记录调用时的凭据事实：`{ "provider_id": "<providerID>", "auth_type": "oauth" | "api" | "wellknown" }`（来自存储凭据的 `auth.type`）；`getAuth` 函数本身不序列化，其读取凭据的副作用不记为 `sdk.call`；
- `output` 是 loader 返回的 options patch，统一包成 `{ "options": ... }`（host 侧以 `{ options: <patch> }` 合并进 provider）；patch 内的函数字段（例如 `fetch`）用布尔标记表示（fixture 用 `options.fetch_override: true`），不写函数体；
- patch 的每个键编码为 `hook.mutate` 的 `options.<key>` 路径；`snapshot` 等于最终 patch。刷新持久化仍由独立的 `sdk.call(method="auth.set")` 记录。

## 3. scope 约定

scope 把同一 hook 的不同调用分组；order 断言按 `${hook}|${scope}` 建 key。

| hook | scope 形式 | 例子 |
|---|---|---|
| `config` | `config:<bootstrap-op>` | `config:bootstrap` |
| `auth.loader` | `auth:<provider_id>` | `auth:openai` |
| `tool.definition` | `tool:<tool_id>` | `tool:read` |
| `chat.params` | `params:<request-op>` | `params:op-llm` |
| `chat.headers` | `headers:<request-op>` | `headers:op-llm` |
| `tool.execute.before` | `before:<call_id>` | `before:call-1` |
| `tool.execute.after` | `after:<call_id>` | `after:call-1` |
| `auth.refresh` | `request:<request-op>` | `request:op-llm` |

`tool.execute.before` 与 `tool.execute.after` 用不同 scope，因为它们的 output 形状不同（`{args}` vs `{title,output,metadata}`），不能串成同一个 mutation 链。

## 4. 判定层

`verifyHookTrace(trace, expectation)` 按以下顺序执行；每层失败抛 `HookTraceError`，`code` 稳定。

### 4.1 完整性（`parseHookTrace`）

| 失败 | code |
|---|---|
| 非 JSON / 空行 / 少行 | `TRACE_JSON` / `TRACE_SHAPE` |
| format/version/contract_rev/work_id 不匹配 | `TRACE_FORMAT` / `TRACE_VERSION` / `TRACE_CONTRACT_REV` / `TRACE_WORK_ID` |
| 非合成轨迹 | `TRACE_SYNTHETIC` |
| footer digest 不匹配 | `TRACE_BODY_DIGEST` |
| event_count 不匹配 | `TRACE_EVENT_COUNT` |
| seq 与物理序号不一致 | `TRACE_SEQ_ORDER` |
| 未知 kind / 字段类型错误 | `TRACE_EVENT_KIND` / `TRACE_FIELD` / ... |

### 4.2 注册顺序

- `plugin.registered` 的 `order` 必须是 0..N-1，且无重复（`PLUGIN_ORDER` / `PLUGIN_DUPLICATE`）。
- 所有 `internal` 必须在 `config` 之前（`PLUGIN_ORDER`）。
- 第一个 `hook.start` 必须晚于最后一个 `plugin.registered`（`PLUGIN_ORDER`）。

### 4.3 取消

- 对每个 `operation.end(status=cancelled)`，操作区间内最多一个没有 `hook.end` 的 `hook.start`（`HOOK_CANCEL_ORDER`）。
- 取消后不得再出现同一 hook/scope/plugin 的 `hook.mutate`/`hook.end`（`HOOK_CANCEL_ORDER`）。
- 取消的 `tool.execute` 不得出现 `after:<call_id>` 的 `tool.execute.after`（`HOOK_AFTER_ON_CANCELLED_CALL`）。
- expectation 列出的取消项必须有对应的 cancelled op 与 in-flight start，且没有 end（`HOOK_CANCEL_MISSING` / `HOOK_CANCEL_ORDER`）。

> 语义：当前 TS 的 `executeGuarded` 在 abort 后停止等待，但不会取消 hook Promise（`prompt.ts:1249-1280`）。轨迹用“start 无 end + operation cancelled”表达“host 不再观察该 hook”；不声称插件 Promise 已停止。

### 4.4 阶段顺序

| 规则 | code |
|---|---|
| `config` 必须在 `bootstrap` 内 | `CONFIG_PHASE_ORDER` |
| `auth.loader` 必须在 `provider.init` 内，且早于第一个 `llm.request` | `AUTH_LOADER_ORDER` |
| `tool.definition` 必须在 `tool.list` 内 | `HOOK_PHASE_ORDER` |
| 同一请求的 `chat.params` 必须先于 `chat.headers` | `HOOK_PHASE_ORDER` |
| `tool.execute.after` 必须晚于同一 call 的 `tool.execute.before` end | `HOOK_PHASE_ORDER` |

### 4.5 重入

- 非 `auth.refresh` 的 `sdk.call` 必须落在同一 hook/scope/plugin 的 `hook.start` 与 `hook.end` 之间（`HOOK_REENTRANCY_ORDER`）。
- `auth.refresh` 的 `sdk.call` 必须有同 scope 的前置 `auth.refresh` 事件（`HOOK_REENTRANCY_ORDER`）。

### 4.6 hook 顺序

- 按 `${hook}|${scope}` 收集 `hook.start` 的 `plugin_id` 序列。
- 与 expectation 逐项比较：缺失/数量不符 → `HOOK_MISSING`；重复 → `HOOK_DUPLICATE`；顺序不符 → `HOOK_ORDER_MISMATCH`；expectation 未覆盖的 key → `HOOK_UNEXPECTED`。

### 4.7 mutation 链

- `hook.start` 的 `output` 必须等于该 scope 当前共享对象（首个 start 建立它）。
- `hook.mutate` 的 `before` 必须等于当前路径值（缺失视为 `null`）；然后把 `after` 写入。
- `snapshot` 必须等于该 scope 的最终共享对象；expectation 里的每个 snapshot 必须存在且相等（`HOOK_MUTATION_CHAIN` / `HOOK_SNAPSHOT_MISSING` / `HOOK_SNAPSHOT_MISMATCH`）。
- 这保证“后一个插件看到前一个插件的修改”，也保证负例篡改 before/after 会被抓住。

### 4.8 auth

- 指定 provider 的 `auth.loader` 恰好一次（`AUTH_LOADER_ORDER`）。
- 至少一个 `auth.refresh`；全部 `single_flight: true`、`persist: "auth.set"`、`concurrent_requests >= 2`、`expires_delta_s > 0`（`AUTH_REFRESH_POLICY`）。
- refresh 必须在某个 `llm.request` 内，且晚于该请求的 `chat.headers` start（`AUTH_REFRESH_ORDER`）。
- 必须有一个 `sdk.call(method=auth.set)` 记录持久化往返（`AUTH_REFRESH_ORDER`）。

### 4.9 失败策略

- expectation 必须覆盖 8 个 policy hook：7 个 hook 名 + `auth.refresh`；每个恰好一行，字段非空。
- `host_effect` 必须匹配固定映射（`HOOK_FAILURE_POLICY`）：
  - `config` → `HOOK_FAILURE_ISOLATED_CONFIG`
  - `tool.definition` → `HOOK_FAILURE_FATAL_TOOL_LIST`
  - `chat.params` / `chat.headers` → `HOOK_FAILURE_FATAL_LLM`
  - `tool.execute.before` → `HOOK_FAILURE_SKIP_TOOL`
  - `tool.execute.after` → `HOOK_FAILURE_DISCARD_RESULT`
  - `auth.loader` → `HOOK_FAILURE_PROVIDER_INIT`
  - `auth.refresh` → `HOOK_FAILURE_AUTH_REFRESH`

### 4.10 replay

- `parse -> encode` 必须逐字节还原源文件（`TRACE_ENCODING_UNSTABLE`）。
- `snapshot` 已由 mutation 链重建；不需要外部 DB/文件。

## 5. 负例与稳定码

| 负例 | 层 | 破坏 | 期望码 |
|---|---|---|---|
| `order-swap-chat-params` | semantic | 交换 chat.params 的 alpha/beta 块 | `HOOK_ORDER_MISMATCH` |
| `missing-tool-after-beta` | semantic | 删除 after 的 beta 块 | `HOOK_MISSING` |
| `duplicate-tool-before-alpha` | semantic | 复制 before 的 alpha 块 | `HOOK_DUPLICATE` |
| `tamper-before-args` | semantic | 改 before 的 `before` 值 | `HOOK_MUTATION_CHAIN` |
| `phase-after-before-before` | semantic | 把 after 块移到 before 块之前 | `HOOK_PHASE_ORDER` |
| `cancel-emits-after` | semantic | 给取消的 call-2 补 after 块 | `HOOK_AFTER_ON_CANCELLED_CALL` |
| `integrity-stale-footer` | integrity | 删一行但保留旧 footer | `TRACE_BODY_DIGEST` |
| `integrity-seq-order` | integrity | 改一个 seq 并重算 footer | `TRACE_SEQ_ORDER` |

负例的语义层会重新编码并重算 footer，确保它们进入语义层而不是被完整性层提前拦截；`integrity-*` 专门验证格式层。

## 6. 合成与隐私

- header 的 `synthetic: true` 是硬校验；本目录的 golden 是手工构造的合成轨迹，不是真实 session 录制。
- 禁止写入：真实后端 URL、内网域名、IP、凭据、用户 home 绝对路径、内部部署型号后缀；模型只用公开通用名（fixture 用 `claude-sonnet-4-6`）。
- 资源统一 `synthetic://...`；session id 用 `ses_synthetic`；插件 id 用 `demo.*` 或 `builtin.*`。
- 测试会断言 golden 不含 `os.homedir()`、`/Users/`、`/home/`、`/Volumes/`、`file://`、`http://`、`https://`。

## 7. 运行方式

以下命令均从 `packages/chimera` 执行：

```bash
# 主判定：golden + replay + 六类 + 负例 + 隐私（19 项）
bun run test/oracle/plugin/run.ts

# 保留产物到指定目录
bun run test/oracle/plugin/run.ts --out <out-dir>

# 只在 fixture 有意变更时重生成 golden
bun run test/oracle/plugin/run.ts --write-golden

# bun test 入口
bun test --timeout 30000 test/oracle/plugin/trajectory.test.ts
```

产物：`<out>/summary.json`（checks + coverage，不含完整轨迹）。golden 固定在 `test/oracle/plugin/golden/session-six-hooks.jsonl`。

## 8. 与 WP-02 / WP-10 的边界

- **WP-02**：本格式复用其 header/event/footer、digest、seq 规则；不修改 `test/oracle/transcript/`。WP-02 的 `parseTranscript` 不接受本格式（kind 白名单不同），这是有意隔离。
- **WP-03**：本包只做 fixture 级负例，不实现 fault matrix/统计门；WP-03 可以在本格式上扩展丢失/乱序/重复/中断等故障注入。
- **WP-10**：control-plane 的 hook/permission/question/job family 轨迹可以复用 `hook.start`/`hook.end`/`sdk.call` 形状，但需要自己的 event kind 与 verifier；不要直接把 plugin 轨迹当 control 轨迹。
- **Rust host**：格式是语言无关的 JSONL；Rust recorder 只需按 §1/§2（含 §2.1 输入归一化）编码，不需要依赖本 TS 实现。

## 9. 待拍板

1. 本格式是否升级为跨语言共享契约（若升级，按 `partition-table.md:133` 递增 `contract_rev`）。
2. 有限小数的 `JSON.stringify` 表示是否足够作为 Rust/JS 字节 parity 的规范；是否需要固定小数位（例如 `chat.params` 只保留 6 位）。
3. `sdk.call` 的 `method` 命名是否直接采用 SDK 方法名（`session.message`）还是 host RPC 名（`sdk.call` + path）；本文暂用 SDK 方法名。
4. 真实录制（非 synthetic）的隐私边界与采样策略；本包只冻结格式，不定义真实录制。

## 10. 证据索引

| 证据 | 位置 |
|---|---|
| WP-02 transcript v1 行结构/canonical 规则 | `packages/chimera/test/oracle/transcript/README.md:52-85`；`format.ts:144-178,236-281` |
| WP-02 双臂/golden/负例 | `packages/chimera/test/oracle/transcript/harness.ts:150-228` |
| WP-09 DoD | `RUST_FULL_MIGRATION_PLAN.md:263` |
| WP-09 分区 | `packages/chimera/specs/rust-host/partition-table.md:36,59` |
| 六类 hook 语义 | `packages/chimera/specs/rust-host/plugin/hook-matrix.md` |
| sidecar 拓扑 | `packages/chimera/specs/rust-host/plugin/sidecar-topology.md` |
| 合成轨迹 fixture | `packages/chimera/test/oracle/plugin/fixtures/session-trajectory.ts` |
| golden | `packages/chimera/test/oracle/plugin/golden/session-six-hooks.jsonl` |