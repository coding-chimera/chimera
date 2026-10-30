// WP-09 synthetic session trajectory: one session, all six hook classes.
//
// This fixture is hand-built from the current TS source paths, not captured
// from a live run. It is explicitly synthetic (`header.synthetic: true`) and
// uses only synthetic resources (`synthetic://...`, `ses_synthetic`, plugin ids
// `demo.*`). It must not be read as evidence that a real session produced these
// bytes.
//
// Source anchors for the event order (see hook-matrix.md for the full table):
//   config/bootstrap      packages/chimera/src/project/bootstrap.ts:41-43
//   plugin registration   packages/chimera/src/plugin/index.ts:190-199,249-272
//   config hook           packages/chimera/src/plugin/index.ts:275-282
//   tool.definition       packages/chimera/src/tool/registry.ts:489-557
//   chat.params/headers   packages/chimera/src/session/llm.ts:408-442
//   auth.loader/refresh   packages/chimera/src/provider/provider.ts:2030-2049
//                         packages/chimera/src/plugin/codex.ts:497-561
//   tool.before/after     packages/chimera/src/session/prompt.ts:1322-1348
//   cancellation          packages/chimera/src/session/prompt.ts:1249-1280

import {
  CONTRACT_REV,
  HOOK_CLASS_OF,
  HOOK_TRACE_FORMAT,
  HOOK_TRACE_VERSION,
  WORK_ID,
  type FailurePolicyRow,
  type HookName,
  type HookTraceExpectation,
  type HookTraceHeader,
  type Json,
  type TraceEventInput,
} from "../trajectory"

export const TRAJECTORY_ID = "session-six-hooks"
export const GOLDEN_FILE = "session-six-hooks.jsonl"

export const HEADER: HookTraceHeader = {
  record: "header",
  format: HOOK_TRACE_FORMAT,
  version: HOOK_TRACE_VERSION,
  contract_rev: CONTRACT_REV,
  work_id: WORK_ID,
  trajectory: TRAJECTORY_ID,
  synthetic: true,
  description:
    "Synthetic one-session hook trace: config/bootstrap, tool.definition, chat.params, chat.headers, tool.execute.before/after, auth.loader+refresh. Derived from current TS call sites; not a live capture.",
}

type Mutation = { path: string; before: Json; after: Json }

type SdkCall = { method: string; status?: "ok" | "error"; error_code?: string | null }

function block(
  hook: HookName,
  scope: string,
  plugin_id: string,
  input: Json,
  output: Json,
  mutations: Mutation[] = [],
  sdk: SdkCall[] = [],
): TraceEventInput[] {
  return [
    { kind: "hook.start", hook, hook_class: HOOK_CLASS_OF[hook], scope, plugin_id, input, output },
    ...sdk.map(
      (call): TraceEventInput => ({
        kind: "sdk.call",
        hook,
        scope,
        plugin_id,
        method: call.method,
        status: call.status ?? "ok",
        error_code: call.error_code ?? null,
      }),
    ),
    ...mutations.map(
      (mutation): TraceEventInput => ({
        kind: "hook.mutate",
        hook,
        scope,
        plugin_id,
        path: mutation.path,
        before: mutation.before,
        after: mutation.after,
      }),
    ),
    { kind: "hook.end", hook, scope, plugin_id, status: "ok", error_code: null },
  ]
}

const READ_PARAMS: Json = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
}

const BASH_PARAMS: Json = {
  type: "object",
  properties: {
    command: { type: "string" },
    timeout: { type: "integer", minimum: 0 },
  },
  required: ["command"],
}

const INITIAL_CONFIG: Json = {
  provider: {
    demoProvider: {
      name: "Demo",
      options: { timeout: 5000 },
    },
  },
}

const CONFIG_AFTER_ALPHA: Json = {
  provider: {
    demoProvider: {
      name: "Demo Provider",
      options: { timeout: 5000 },
    },
  },
}

const INITIAL_PARAMS: Json = {
  temperature: 1,
  topP: 1,
  topK: 40,
  presencePenalty: 0,
  frequencyPenalty: 0,
  maxOutputTokens: 4096,
  options: { reasoningEffort: "low" },
}

export const EVENTS: TraceEventInput[] = [
  // -------------------------------------------------------------------------
  // bootstrap: registration order then config hooks
  // -------------------------------------------------------------------------
  { kind: "operation.start", op: "bootstrap", op_id: "op-bootstrap", detail: { directory: "synthetic://workspace" } },
  {
    kind: "plugin.registered",
    plugin_id: "builtin.codex-auth",
    origin: "internal",
    order: 0,
    hooks: ["auth.loader", "chat.params", "chat.headers"],
  },
  {
    kind: "plugin.registered",
    plugin_id: "demo.alpha",
    origin: "config",
    order: 1,
    hooks: ["config", "tool.definition", "chat.params", "chat.headers", "tool.execute.before", "tool.execute.after"],
  },
  {
    kind: "plugin.registered",
    plugin_id: "demo.beta",
    origin: "config",
    order: 2,
    hooks: ["config", "tool.definition", "chat.params", "chat.headers", "tool.execute.before", "tool.execute.after"],
  },
  ...block(
    "config",
    "config:bootstrap",
    "demo.alpha",
    { source: "synthetic://workspace/chimera.json" },
    INITIAL_CONFIG,
    [{ path: "provider.demoProvider.name", before: "Demo", after: "Demo Provider" }],
  ),
  ...block("config", "config:bootstrap", "demo.beta", { source: "synthetic://workspace/chimera.json" }, CONFIG_AFTER_ALPHA, [
    { path: "provider.demoProvider.options.timeout", before: 5000, after: 15000 },
  ]),
  {
    kind: "snapshot",
    scope: "config:bootstrap",
    name: "final",
    value: { provider: { demoProvider: { name: "Demo Provider", options: { timeout: 15000 } } } },
  },
  { kind: "operation.end", op: "bootstrap", op_id: "op-bootstrap", status: "ok", error_code: null },

  // -------------------------------------------------------------------------
  // provider.init: auth loader runs once for a stored OAuth credential
  // -------------------------------------------------------------------------
  { kind: "operation.start", op: "provider.init", op_id: "op-provider", detail: { provider_id: "openai" } },
  ...block(
    "auth.loader",
    "auth:openai",
    "builtin.codex-auth",
    { provider_id: "openai", auth_type: "oauth" },
    { options: {} },
    [
      { path: "options.auth_mode", before: null, after: "oauth" },
      { path: "options.fetch_override", before: null, after: true },
    ],
  ),
  { kind: "snapshot", scope: "auth:openai", name: "final", value: { options: { auth_mode: "oauth", fetch_override: true } } },
  { kind: "operation.end", op: "provider.init", op_id: "op-provider", status: "ok", error_code: null },

  // -------------------------------------------------------------------------
  // tool.list: per-tool definition hooks are sequential; different tools may
  // interleave because registry.tools uses concurrency "unbounded".
  // -------------------------------------------------------------------------
  { kind: "operation.start", op: "tool.list", op_id: "op-tools", detail: { tool_count: 2 } },
  ...block("tool.definition", "tool:read", "demo.alpha", { tool_id: "read" }, { description: "Read a file", parameters: READ_PARAMS }, [
    { path: "description", before: "Read a file", after: "Read a file (alpha)" },
  ]),
  ...block(
    "tool.definition",
    "tool:bash",
    "demo.alpha",
    { tool_id: "bash" },
    { description: "Run a shell command", parameters: BASH_PARAMS },
    [{ path: "description", before: "Run a shell command", after: "Run a shell command (alpha)" }],
  ),
  ...block(
    "tool.definition",
    "tool:read",
    "demo.beta",
    { tool_id: "read" },
    { description: "Read a file (alpha)", parameters: READ_PARAMS },
    [{ path: "description", before: "Read a file (alpha)", after: "Read a file (alpha) (beta)" }],
  ),
  ...block(
    "tool.definition",
    "tool:bash",
    "demo.beta",
    { tool_id: "bash" },
    { description: "Run a shell command (alpha)", parameters: BASH_PARAMS },
    [{ path: "parameters.properties.timeout.minimum", before: 0, after: 1 }],
  ),
  {
    kind: "snapshot",
    scope: "tool:read",
    name: "final",
    value: { description: "Read a file (alpha) (beta)", parameters: READ_PARAMS },
  },
  {
    kind: "snapshot",
    scope: "tool:bash",
    name: "final",
    value: {
      description: "Run a shell command (alpha)",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1 } },
        required: ["command"],
      },
    },
  },
  { kind: "operation.end", op: "tool.list", op_id: "op-tools", status: "ok", error_code: null },

  // -------------------------------------------------------------------------
  // llm.request #1: chat.params -> chat.headers -> lazy auth refresh -> send
  // -------------------------------------------------------------------------
  { kind: "operation.start", op: "llm.request", op_id: "op-llm", detail: { provider_id: "openai", model_id: "claude-sonnet-4-6" } },
  ...block("chat.params", "params:op-llm", "builtin.codex-auth", { session_id: "ses_synthetic", agent: "build" }, INITIAL_PARAMS, [
    { path: "maxOutputTokens", before: 4096, after: null },
  ]),
  ...block(
    "chat.params",
    "params:op-llm",
    "demo.alpha",
    { session_id: "ses_synthetic", agent: "build" },
    { ...(INITIAL_PARAMS as Record<string, Json>), maxOutputTokens: null },
    [{ path: "temperature", before: 1, after: 0.5 }],
  ),
  ...block(
    "chat.params",
    "params:op-llm",
    "demo.beta",
    { session_id: "ses_synthetic", agent: "build" },
    { ...(INITIAL_PARAMS as Record<string, Json>), maxOutputTokens: null, temperature: 0.5 },
    [{ path: "options.reasoningEffort", before: "low", after: "medium" }],
  ),
  {
    kind: "snapshot",
    scope: "params:op-llm",
    name: "final",
    value: {
      temperature: 0.5,
      topP: 1,
      topK: 40,
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxOutputTokens: null,
      options: { reasoningEffort: "medium" },
    },
  },
  ...block("chat.headers", "headers:op-llm", "builtin.codex-auth", { session_id: "ses_synthetic", agent: "build" }, { headers: {} }, [
    { path: "headers.x-synthetic-auth", before: null, after: "oauth" },
  ]),
  ...block(
    "chat.headers",
    "headers:op-llm",
    "demo.alpha",
    { session_id: "ses_synthetic", agent: "build" },
    { headers: { "x-synthetic-auth": "oauth" } },
    [{ path: "headers.x-alpha-trace", before: null, after: "1" }],
    [{ method: "session.message" }],
  ),
  ...block(
    "chat.headers",
    "headers:op-llm",
    "demo.beta",
    { session_id: "ses_synthetic", agent: "build" },
    { headers: { "x-synthetic-auth": "oauth", "x-alpha-trace": "1" } },
    [{ path: "headers.x-beta-trace", before: null, after: "1" }],
  ),
  {
    kind: "snapshot",
    scope: "headers:op-llm",
    name: "final",
    value: { headers: { "x-synthetic-auth": "oauth", "x-alpha-trace": "1", "x-beta-trace": "1" } },
  },
  {
    kind: "auth.refresh",
    scope: "request:op-llm",
    provider_id: "openai",
    trigger: "expires_lt_now",
    single_flight: true,
    concurrent_requests: 2,
    persist: "auth.set",
    expires_delta_s: 3600,
  },
  {
    kind: "sdk.call",
    hook: "auth.refresh",
    scope: "request:op-llm",
    plugin_id: "builtin.codex-auth",
    method: "auth.set",
    status: "ok",
    error_code: null,
  },
  { kind: "operation.end", op: "llm.request", op_id: "op-llm", status: "ok", error_code: null },

  // A second request in the same provider state: no second loader and no
  // second refresh, because the refreshed token is reused in memory.
  { kind: "operation.start", op: "llm.request", op_id: "op-llm-2", detail: { provider_id: "openai", model_id: "claude-sonnet-4-6", small: true } },
  { kind: "operation.end", op: "llm.request", op_id: "op-llm-2", status: "ok", error_code: null },

  // -------------------------------------------------------------------------
  // tool.execute call-1: before hooks mutate args, after hooks mutate result
  // -------------------------------------------------------------------------
  {
    kind: "operation.start",
    op: "tool.execute",
    op_id: "op-tool-1",
    detail: { call_id: "call-1", tool: "read", session_id: "ses_synthetic" },
  },
  ...block(
    "tool.execute.before",
    "before:call-1",
    "demo.alpha",
    { tool: "read", session_id: "ses_synthetic", call_id: "call-1" },
    { args: { path: "synthetic://input.txt" } },
    [{ path: "args.path", before: "synthetic://input.txt", after: "synthetic://input-alpha.txt" }],
  ),
  ...block(
    "tool.execute.before",
    "before:call-1",
    "demo.beta",
    { tool: "read", session_id: "ses_synthetic", call_id: "call-1" },
    { args: { path: "synthetic://input-alpha.txt" } },
    [{ path: "args.path", before: "synthetic://input-alpha.txt", after: "synthetic://input-beta.txt" }],
  ),
  { kind: "snapshot", scope: "before:call-1", name: "final", value: { args: { path: "synthetic://input-beta.txt" } } },
  ...block(
    "tool.execute.after",
    "after:call-1",
    "demo.alpha",
    { tool: "read", session_id: "ses_synthetic", call_id: "call-1", args: { path: "synthetic://input-beta.txt" } },
    { title: "read", output: "synthetic file contents", metadata: {} },
    [{ path: "output", before: "synthetic file contents", after: "synthetic file contents\n[alpha]" }],
  ),
  ...block(
    "tool.execute.after",
    "after:call-1",
    "demo.beta",
    { tool: "read", session_id: "ses_synthetic", call_id: "call-1", args: { path: "synthetic://input-beta.txt" } },
    { title: "read", output: "synthetic file contents\n[alpha]", metadata: {} },
    [{ path: "metadata.alpha", before: null, after: true }],
  ),
  {
    kind: "snapshot",
    scope: "after:call-1",
    name: "final",
    value: { title: "read", output: "synthetic file contents\n[alpha]", metadata: { alpha: true } },
  },
  { kind: "operation.end", op: "tool.execute", op_id: "op-tool-1", status: "ok", error_code: null },

  // -------------------------------------------------------------------------
  // tool.execute call-2: cancellation while tool.execute.before is in flight.
  // The host stops awaiting; the plugin promise is not aborted (no AbortSignal
  // is passed to hooks). No after hook may be emitted for this call.
  // -------------------------------------------------------------------------
  {
    kind: "operation.start",
    op: "tool.execute",
    op_id: "op-tool-2",
    detail: { call_id: "call-2", tool: "bash", session_id: "ses_synthetic" },
  },
  {
    kind: "hook.start",
    hook: "tool.execute.before",
    hook_class: "tool-execute-before",
    scope: "before:call-2",
    plugin_id: "demo.alpha",
    input: { tool: "bash", session_id: "ses_synthetic", call_id: "call-2" },
    output: { args: { command: "synthetic-command" } },
  },
  {
    kind: "hook.mutate",
    hook: "tool.execute.before",
    scope: "before:call-2",
    plugin_id: "demo.alpha",
    path: "args.command",
    before: "synthetic-command",
    after: "synthetic-command --dry-run",
  },
  { kind: "snapshot", scope: "before:call-2", name: "final", value: { args: { command: "synthetic-command --dry-run" } } },
  { kind: "operation.end", op: "tool.execute", op_id: "op-tool-2", status: "cancelled", error_code: "user_abort" },

  // -------------------------------------------------------------------------
  // dispose: plugin dispose hooks are adjacent (not one of the six classes)
  // -------------------------------------------------------------------------
  { kind: "operation.start", op: "session.dispose", op_id: "op-dispose", detail: {} },
  { kind: "operation.end", op: "session.dispose", op_id: "op-dispose", status: "ok", error_code: null },
]

export const EXPECTED_ORDER: Record<string, string[]> = {
  "config|config:bootstrap": ["demo.alpha", "demo.beta"],
  "auth.loader|auth:openai": ["builtin.codex-auth"],
  "tool.definition|tool:read": ["demo.alpha", "demo.beta"],
  "tool.definition|tool:bash": ["demo.alpha", "demo.beta"],
  "chat.params|params:op-llm": ["builtin.codex-auth", "demo.alpha", "demo.beta"],
  "chat.headers|headers:op-llm": ["builtin.codex-auth", "demo.alpha", "demo.beta"],
  "tool.execute.before|before:call-1": ["demo.alpha", "demo.beta"],
  "tool.execute.after|after:call-1": ["demo.alpha", "demo.beta"],
  "tool.execute.before|before:call-2": ["demo.alpha"],
}

export const EXPECTED_SNAPSHOTS: Record<string, Json> = {
  "config:bootstrap#final": { provider: { demoProvider: { name: "Demo Provider", options: { timeout: 15000 } } } },
  "auth:openai#final": { options: { auth_mode: "oauth", fetch_override: true } },
  "tool:read#final": { description: "Read a file (alpha) (beta)", parameters: READ_PARAMS },
  "tool:bash#final": {
    description: "Run a shell command (alpha)",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1 } },
      required: ["command"],
    },
  },
  "params:op-llm#final": {
    temperature: 0.5,
    topP: 1,
    topK: 40,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxOutputTokens: null,
    options: { reasoningEffort: "medium" },
  },
  "headers:op-llm#final": { headers: { "x-synthetic-auth": "oauth", "x-alpha-trace": "1", "x-beta-trace": "1" } },
  "before:call-1#final": { args: { path: "synthetic://input-beta.txt" } },
  "after:call-1#final": { title: "read", output: "synthetic file contents\n[alpha]", metadata: { alpha: true } },
  "before:call-2#final": { args: { command: "synthetic-command --dry-run" } },
}

export const FAILURE_POLICY: FailurePolicyRow[] = [
  {
    hook: "config",
    hook_class: "config-bootstrap",
    failing_plugin_effect: "logged; this plugin contributes no hooks; already-registered plugins keep their hooks",
    other_plugins: "continue",
    operation_effect: "bootstrap continues; later config hooks still run",
    host_effect: "HOOK_FAILURE_ISOLATED_CONFIG",
    stable_code: "plugin.config.failed",
  },
  {
    hook: "tool.definition",
    hook_class: "tool-definition",
    failing_plugin_effect: "the definition mutation is lost; the exception aborts the tool-list build",
    other_plugins: "not-run",
    operation_effect: "registry.tools fails; the turn/LLM request that needed the tool list fails",
    host_effect: "HOOK_FAILURE_FATAL_TOOL_LIST",
    stable_code: "plugin.tool_definition.failed",
  },
  {
    hook: "chat.params",
    hook_class: "chat-params-headers",
    failing_plugin_effect: "the parameter mutation is lost; the exception aborts request assembly",
    other_plugins: "not-run",
    operation_effect: "LLM request fails before dispatch",
    host_effect: "HOOK_FAILURE_FATAL_LLM",
    stable_code: "plugin.chat_params.failed",
  },
  {
    hook: "chat.headers",
    hook_class: "chat-params-headers",
    failing_plugin_effect: "the header mutation is lost; the exception aborts request assembly",
    other_plugins: "not-run",
    operation_effect: "LLM request fails before dispatch",
    host_effect: "HOOK_FAILURE_FATAL_LLM",
    stable_code: "plugin.chat_headers.failed",
  },
  {
    hook: "tool.execute.before",
    hook_class: "tool-execute-before",
    failing_plugin_effect: "the args mutation is lost; the tool body never runs",
    other_plugins: "not-run",
    operation_effect: "tool call is marked failed (failToolCall); sibling calls continue",
    host_effect: "HOOK_FAILURE_SKIP_TOOL",
    stable_code: "plugin.tool_before.failed",
  },
  {
    hook: "tool.execute.after",
    hook_class: "tool-execute-after",
    failing_plugin_effect: "the result mutation is lost; the completed tool result is discarded",
    other_plugins: "not-run",
    operation_effect: "tool call is marked failed even though the tool body may have run",
    host_effect: "HOOK_FAILURE_DISCARD_RESULT",
    stable_code: "plugin.tool_after.failed",
  },
  {
    hook: "auth.loader",
    hook_class: "auth-refresh",
    failing_plugin_effect: "no provider options patch is applied; the rejection becomes a defect in provider state init",
    other_plugins: "not-run",
    operation_effect: "provider state materialization fails; no per-plugin isolation",
    host_effect: "HOOK_FAILURE_PROVIDER_INIT",
    stable_code: "plugin.auth_loader.failed",
  },
  {
    hook: "auth.refresh",
    hook_class: "auth-refresh",
    failing_plugin_effect: "refresh HTTP/auth.set fails; no stale-token fallback is attempted",
    other_plugins: "not-run",
    operation_effect: "the provider request fails; auth.set failure may leave disk state stale",
    host_effect: "HOOK_FAILURE_AUTH_REFRESH",
    stable_code: "plugin.auth_refresh.failed",
  },
]

export const EXPECTATION: HookTraceExpectation = {
  order: EXPECTED_ORDER,
  snapshots: EXPECTED_SNAPSHOTS,
  cancelled: [{ op_id: "op-tool-2", scope: "before:call-2", in_flight_plugin: "demo.alpha" }],
  auth: { provider_id: "openai", loader_scope: "auth:openai", refresh_scope: "request:op-llm" },
  failure_policy: FAILURE_POLICY,
}