import { Provider } from "@/provider/provider"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, NoSuchToolError, Output, type JSONSchema7, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { openai } from "@ai-sdk/openai"
import { mergeDeep } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { NativeLLMGating } from "@/provider/sdk/native-llm/gating"
import { NativeLLMLanguageModel } from "@/provider/sdk/native-llm/language-model"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { Agent } from "@/agent/agent"
import { lowestNonUltraVariant } from "@/agent/subagent-capability-prior"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { ContextEpoch } from "./context-epoch"
import { SessionSystemContext } from "./system-context"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/contracts/session-ids"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { CodexResponses } from "./codex-responses"
import { ToolSearch } from "./tool-search"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>
const OPENAI_HOSTED_WEB_SEARCH_TOOL = "web_search"
// Structured-output tool the session prompt injects when a user message asks
// for a json_schema format (SessionPrompt.createStructuredOutputTool).
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"

// Avoid re-instantiating remeda's deep merge types in this hot LLM path; the runtime behavior is still mergeDeep.
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

// alibailian relays (Model Studio endpoints and relays) 400 on
// tool_choice "required" whenever the request carries more than one tool
// ("Please set one tool in required mode"). Structured output on the
// responses wire still names the injected StructuredOutput tool; the chat
// wire no longer sends tool_choice at all (native response_format path).
// This guard is a defensive backstop for any other "required" caller.
/** @internal Exported for testing */
export function resolveToolChoice(
  input: {
    toolChoice?: StreamInput["toolChoice"]
    model: Pick<Provider.Model, "backend_semantics" | "providerID">
  },
  tools: Record<string, unknown>,
): StreamInput["toolChoice"] {
  const toolChoice = input.toolChoice
  if (toolChoice !== "required") return toolChoice
  if (input.model.backend_semantics !== "alibailian") return toolChoice
  if (Object.keys(tools).length <= 1) return toolChoice
  if (tools[STRUCTURED_OUTPUT_TOOL_NAME]) return { type: "tool", toolName: STRUCTURED_OUTPUT_TOOL_NAME }
  throw new Error(
    `Provider ${input.model.providerID} uses backend_semantics "alibailian", which rejects tool_choice "required" when more than one tool is present (the relay returns "Please set one tool in required mode"). Name the tool instead, e.g. toolChoice { type: "tool", toolName: "<tool>" }, or drop the extra tools. If this came from a structured-output request, make sure the StructuredOutput tool is registered for the call.`,
  )
}

// Native chat-completions structured output: the AI SDK maps `output` to
// `response_format`, validates the final text against the schema, and exposes
// the parsed object on the stream result. The chat wire + alibailian branch
// therefore sends no synthetic tool and no tool_choice.
/** @internal Exported for testing */
export function nativeStructuredOutputWire(
  model: Pick<Provider.Model, "backend_semantics" | "wire_api">,
  providerWireAPI?: Provider.Info["wire_api"],
) {
  return (model.wire_api ?? providerWireAPI) === "chat" && model.backend_semantics === "alibailian"
}

// The tool_choice a user-facing turn sends: structured output requires a tool
// call, text turns leave the choice to the model. Kept next to
// resolveToolChoice so the format gate and the alibailian downgrade share one
// tested path (SessionPrompt calls this).
/** @internal Exported for testing */
export function toolChoiceForFormat(
  format: { type: string },
  model: Pick<Provider.Model, "backend_semantics" | "providerID" | "wire_api">,
  tools: Record<string, unknown>,
  providerWireAPI?: Provider.Info["wire_api"],
): StreamInput["toolChoice"] {
  if (format.type !== "json_schema") return undefined
  // chat + alibailian takes the native response_format path: no synthetic
  // StructuredOutput tool exists, so there is nothing to name.
  if (nativeStructuredOutputWire(model, providerWireAPI)) return undefined
  return resolveToolChoice({ toolChoice: "required", model }, tools)
}

// W2 (responses-wire): hosted web_search injection as capability resolution.
// The openai provider keeps its tuned args; alibailian-semantics providers on
// the responses wire get the bare tool — a bare openai.tools.webSearch()
// serializes to exactly {"type":"web_search"} (@ai-sdk/openai 3.0.88
// dist/index.js:4980-4992). hosted_web_search switches per provider or per
// model (model wins): false disables injection, true forces the bare tool on
// any non-openai responses-wire model.
function hostedWebSearchArgs(input: StreamRequest, provider: Provider.Info) {
  if (
    input.small ||
    input.toolChoice === "required" ||
    typeof input.toolChoice === "object" ||
    !input.model.capabilities.toolcall
  )
    return
  const flag = input.model.hosted_web_search ?? provider.hosted_web_search
  if (flag === false) return
  if (input.model.providerID === "openai") {
    return { externalWebAccess: true, searchContextSize: "medium" as const }
  }
  if ((input.model.wire_api ?? provider.wire_api) !== "responses") return
  if (input.model.backend_semantics === "alibailian" || flag === true) return {}
  return
}

type VariantProfile = {
  key?: string
  options: Record<string, any>
  unadvertisedUltra?: boolean
}

// Resolves the selected variant once so provider options and the multi-agent policy
// consume the same canonical profile. Exact advertised keys win; otherwise the
// selected name is matched case-insensitively against advertised variants.
// With nothing explicitly selected, the model's configured default_variant /
// default_effort (L4.3 capability layers) pick the advertised variant before
// the lowest-non-ultra fallback.
function resolveVariantProfile(
  model: Provider.Model,
  selected: string | undefined,
  hasConfiguredOptions: boolean,
): VariantProfile {
  const advertised = model.variants ?? {}
  if (!selected) {
    if (hasConfiguredOptions) return { options: {} }
    const preferred = model.default_variant ?? model.default_effort
    if (preferred) {
      if (advertised[preferred]) return { key: preferred, options: advertised[preferred] }
      const preferredCanonical = Object.keys(advertised).find((key) => key.toLowerCase() === preferred.toLowerCase())
      if (preferredCanonical) return { key: preferredCanonical, options: advertised[preferredCanonical] }
    }
    const fallback = lowestNonUltraVariant(Object.keys(advertised))
    if (fallback === undefined) return { options: {} }
    return { key: fallback, options: advertised[fallback] }
  }
  if (advertised[selected]) return { key: selected, options: advertised[selected] }
  const canonical = Object.keys(advertised).find((key) => key.toLowerCase() === selected.toLowerCase())
  if (canonical) return { key: canonical, options: advertised[canonical] }
  if (selected.toLowerCase() === "ultra") return { options: {}, unadvertisedUltra: true }
  return { options: {} }
}

function multiAgentPolicy(
  input: Pick<StreamRequest, "model" | "parentSessionID" | "small">,
  variant: string | undefined,
) {
  if (input.small) return
  if (input.model.backend_semantics !== "codex" && variant !== "ultra") return
  const body = input.parentSessionID
    ? "Explicit-request-only multi-agent mode is active for this child session; proactive delegation from the parent does not carry over. Do not spawn subagents unless the delegated prompt explicitly requires further delegation and available permissions allow it."
    : variant === "ultra"
      ? "Proactive multi-agent delegation is active for this root session. Any earlier instruction requiring an explicit user request before spawning subagents no longer applies. The root session orchestrates: implementation edits (edit/write/apply_patch for features, fixes, and refactors) are delegated to `task` or `chimera_swarm` workers; the root plans, dispatches, synthesizes child reports, runs audit and verification, and applies only small single-file fixes. Before broad repository exploration or serially handling multiple work items, perform a delegation checkpoint: when current evidence shows at least two genuinely independent, non-overlapping work items with material parallel benefit, proactively delegate them with `task` or `chimera_swarm`. Do not fan out by item count alone. If a substantial task appears parallelizable but you keep it local, state the concrete blocker, such as shared files, ordering, provider limits, unsafe subagent runtime, or no material benefit. Fixed scope, conflict, parent-verification, and concurrency rules still apply. Both `task` and `chimera_swarm` accept `background` and `block_reason`: dispatch subagents with `background: true` by default; a foreground blocking dispatch must carry `block_reason` justifying why the result is needed inline. For large fan-outs, dependent multi-stage work, or results that need programmatic synthesis, prefer one `orchestrate` program over many individual `task`/`chimera_swarm` calls; its subagent results only re-enter context through the program's `return` and logs."
      : "Explicit-request-only multi-agent mode is active. Do not spawn subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask for subagents, delegation, or parallel agent work."
  return ["<multi_agent_mode>", body, "</multi_agent_mode>"].join("\n")
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  // Ids the ToolSearch defer filter removed from `tools` upstream
  // (SessionPrompt.resolveTools). Only the system-prompt capability layers
  // see them restored (see capabilityTools); the wire record never does.
  deferredHidden?: string[]
  // Deferred tools revealed for this session but not yet promoted by a
  // compaction boundary (SessionPrompt.resolveTools built these defs exactly
  // like registered ones). They are deliberately absent from the wire `tools`
  // record; the experimental_repairToolCall path executes a by-name call for an
  // id in this view through the normal execution closure. Promoted ids ride
  // `tools` instead.
  revealedCallable?: Record<string, Tool>
  // Provider-defined OpenAI tool_search (client execution) built by
  // SessionPrompt.resolveTools. Applied to the wire record only when the
  // model actually runs the OpenAI Responses transport with OpenAI/Codex
  // backend semantics (see isOpenaiNativeToolSearch); otherwise the function
  // tool already in `tools` stays. Never set for small (title/summary) calls.
  nativeToolSearch?: Tool
  abort?: AbortSignal
  retries?: number
  toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string }
  // Native chat-completions structured output. Set only by SessionPrompt for
  // the chat-wire + alibailian branch: the AI SDK maps it to `response_format`,
  // parses the final text against the schema, and hands the validated object to
  // onSuccess once the stream drains. The synthetic StructuredOutput tool path
  // stays for the responses wire and every other provider.
  structuredOutput?: {
    schema: Record<string, unknown>
    name?: string
    description?: string
    onSuccess: (output: unknown) => void
  }
}

export type StreamRequest = Omit<StreamInput, "abort"> & {
  abort: AbortSignal
}

// Assembles the attributed system prompt segments in send order. Joining the
// segment contents is byte-identical to the legacy unattributed assembly.
export function systemSegments(
  input: Pick<StreamRequest, "model" | "agent" | "small" | "parentSessionID" | "system" | "user"> & {
    tools: Record<string, unknown>
  },
  multiAgent: string | undefined,
  variant: string | undefined,
): SystemPrompt.Segment[] {
  return [
    // use agent prompt otherwise provider prompt
    ...(input.agent.prompt
      ? [{ key: "agent/system", content: input.agent.prompt }]
      : SystemPrompt.providerSegments(input.model)),
    ...SystemPrompt.overlaySegments(input.model),
    // capability layers (chimera/workbrief/browser) only in the non-override
    // branch: an agent.prompt override replaces the entire provider stack.
    ...(!input.agent.prompt ? SystemPrompt.capabilitySegments(input.tools) : []),
    ...(multiAgent ? [{ key: "policy/multi-agent", content: multiAgent }] : []),
    ...(!input.small && !input.parentSessionID ? SystemPrompt.ultraVariantSegments(input.model, variant) : []),
    // any custom prompt passed into this call
    ...input.system.flatMap((content, index) => (content ? [{ key: `input/system/${index}`, content }] : [])),
    // any custom prompt from last user message
    ...(input.user.system ? [{ key: "user/system/0", content: input.user.system }] : []),
  ]
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service | ContextEpoch.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const epoch = yield* ContextEpoch.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [cfg, item, info] = yield* Effect.all(
        [config.get(), provider.getProvider(input.model.providerID), auth.get(input.model.providerID)],
        { concurrency: "unbounded" },
      )

      // TODO: move this to a proper hook
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const profile: VariantProfile = input.small
        ? { options: {} }
        : resolveVariantProfile(
            input.model,
            input.user.model.variant,
            Object.keys(input.model.options ?? {}).length > 0 || Object.keys(input.agent.options ?? {}).length > 0,
          )
      if (profile.unadvertisedUltra) {
        return yield* Effect.fail(
          new Error(
            `Model ${input.model.providerID}/${input.model.id} does not advertise an "ultra" variant. Available variants: ${Object.keys(input.model.variants ?? {}).join(", ") || "none"}.`,
          ),
        )
      }
      const multiAgent = multiAgentPolicy(input, profile.key)
      // Resolve the permission-filtered tools first: capability segments
      // (core/chimera, core/workbrief, core/browser) must gate on the tools
      // the model can actually see, not the raw pre-permission list.
      const tools = resolveTools(input)
      const revealedCallable = revealedCallableTools(input)
      // Guardrail: alibailian relays 400 on "required" + multiple tools. The
      // normal structured-output path already names StructuredOutput in
      // SessionPrompt; this catches any other caller of the "required" shape.
      const toolChoice = resolveToolChoice(input, tools)
      // Capability layers must stay byte-identical to the pre-defer assembly:
      // gate on the permission-allowed view that re-includes the ids the
      // ToolSearch defer filter hid (capabilitySegments only checks key
      // presence), not on the wire record itself.
      const segments = systemSegments(
        { ...input, tools: capabilityTools(tools, input, revealedCallable) },
        multiAgent,
        profile.key,
      )
      // experimental.system_context: the first turn stores the assembled
      // baseline, later turns reuse it and inject source changes as an extra
      // system message. Small calls (title/summary) own no epoch. Epoch
      // failures degrade to the default assembly.
      const prepared =
        !input.small && cfg.experimental?.system_context
          ? Option.getOrUndefined(yield* SessionSystemContext.prepare(epoch, SessionID.make(input.sessionID), segments))
          : undefined
      const system: string[] = prepared
        ? [prepared.baseline, ...(prepared.delta ? [prepared.delta] : [])]
        : [segments.map((segment) => segment.content).join("\n")]

      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // rejoin to maintain 2-part structure for caching if header unchanged
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const topK = input.agent.topK ?? ProviderTransform.topK(input.model)
      const options = mergeOptions(
        mergeOptions(
          mergeOptions(
            mergeOptions(base, input.model.options),
            ProviderTransform.samplingOptions(input.model, {
              topK,
              minP: input.agent.minP,
              repetitionPenalty: input.agent.repetitionPenalty,
            }),
          ),
          input.agent.options,
        ),
        profile.options,
      )
      const effort = options.reasoningEffort
      if (
        item.wire_api === "chat" &&
        input.model.api.npm === "@ai-sdk/openai" &&
        input.model.backend_semantics === "codex" &&
        (effort === "max" || effort === "ultra")
      ) {
        return yield* Effect.fail(
          new Error(
            `Provider ${item.id} uses @ai-sdk/openai Chat, which does not support Codex reasoning effort "${effort}". Use wire_api "responses" or @ai-sdk/openai-compatible Chat.`,
          ),
        )
      }
      if (
        input.model.api.npm === "@ai-sdk/azure" &&
        (item.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
      ) {
        delete options.reasoningSummary
        delete options.include
      }
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }

      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK,
          presencePenalty: input.agent.presencePenalty,
          frequencyPenalty: input.agent.frequencyPenalty,
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const hostedWebSearch = hostedWebSearchArgs(input, item)
      if (hostedWebSearch && tools[OPENAI_HOSTED_WEB_SEARCH_TOOL] === undefined) {
        // @ai-sdk/openai 3.0.88 bundles @ai-sdk/provider 3.0.14 whose `unique
        // symbol` schema brand is type-incompatible with the top-level provider
        // 3.0.16 backing ai's Tool type. Runtime is safe: both copies register
        // the same global symbols (Symbol.for("vercel.ai.*")) (L4.1 SDK bump).
        tools[OPENAI_HOSTED_WEB_SEARCH_TOOL] = (Object.keys(hostedWebSearch).length > 0
          ? openai.tools.webSearch(hostedWebSearch)
          : openai.tools.webSearch()) as unknown as Tool
      }

      if (isOpenaiOauth) {
        if (info?.type !== "oauth") throw new Error("OpenAI OAuth auth missing")
        const directHeaders = {
          "x-session-affinity": input.sessionID,
          ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
          "User-Agent": `opencode/${InstallationVersion}`,
          ...input.model.headers,
          ...headers,
        }
        return {
          fullStream: CodexResponses.stream({
            sessionID: input.sessionID,
            parentSessionID: input.parentSessionID,
            model: input.model,
            system,
            messages: input.messages,
            tools,
            revealedCallable,
            // The Codex OAuth branch is the official openai provider, which is
            // never alibailian, so the named-tool form cannot reach it.
            toolChoice: typeof toolChoice === "string" ? toolChoice : undefined,
            params,
            headers: directHeaders,
            auth: info,
            setAuth: (next) => Effect.runPromise(auth.set("openai", next)),
            endpoint: typeof item.options.codexApiEndpoint === "string" ? item.options.codexApiEndpoint : undefined,
            abort: input.abort,
          }),
        } as Result
      }

      const resolvedLanguage = yield* provider.getLanguage(input.model)
      const isWorkflow = resolvedLanguage instanceof GitLabWorkflowLanguageModel
      // experimental.llm_runtime (L4.4 pilot): switch the transport for eligible
      // providers from the AI SDK provider package to the @coding-chimera/llm
      // route runtime. With the flag off (default) `language` is the exact AI
      // SDK model instance getLanguage returned and nothing from the llm
      // package is constructed, so the downstream path stays byte-identical.
      const nativeRequestOptions =
        !isWorkflow &&
        NativeLLMGating.eligible({
          llmRuntime: cfg.experimental?.llm_runtime,
          model: input.model,
          provider: item,
          auth: info,
        })
          ? yield* provider.getRequestOptions(input.model)
          : undefined
      // Progressive disclosure on the OpenAI Responses transport: swap the
      // function-tool gateway for the provider-defined tool_search so history
      // replay is a legal tool_search_output. The Codex OAuth serializer
      // returned above and the experimental native runtime keeps the function
      // tool, so both stay untouched.
      if (!nativeRequestOptions) applyNativeToolSearch(tools, input, item.wire_api, item.id)
      const language = nativeRequestOptions
        ? NativeLLMLanguageModel.languageModel({
            providerID: input.model.providerID,
            wireModelID: input.model.api.id,
            interleavedField:
              typeof input.model.capabilities.interleaved === "object" && input.model.capabilities.interleaved
                ? input.model.capabilities.interleaved.field
                : undefined,
            baseURL: nativeRequestOptions.baseURL,
            apiKey: nativeRequestOptions.apiKey ?? (info?.type === "api" ? info.key : undefined),
            headers: nativeRequestOptions.headers,
          })
        : resolvedLanguage
      const messages = isWorkflow
        ? input.messages
        : [
            ...system.map(
              (x): ModelMessage => ({
                role: "system",
                content: x,
              }),
            ),
            ...input.messages,
          ]

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = tools[toolName]
          if (!t || !t.execute) {
            return {
              result: "",
              error: ToolSearch.unknownToolGuidance(toolName),
            }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = InstanceState.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                // Consume the merged agent + session ruleset (input.permission is
                // session.permission from SessionPrompt) so persisted "always"
                // approvals survive host restarts.
                ruleset,
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const opencodeProjectID = input.model.providerID.startsWith("opencode")
        ? (yield* InstanceState.context).project.id
        : undefined
      // Native structured output (chat wire + alibailian, resolved by
      // SessionPrompt): let the AI SDK own the response_format mapping, JSON
      // parsing, and schema validation. Other providers keep the synthetic
      // StructuredOutput tool and never set this field.
      const structuredOutput = input.structuredOutput
        ? Output.object({
            schema: jsonSchema(input.structuredOutput.schema as JSONSchema7),
            name: input.structuredOutput.name,
            description: input.structuredOutput.description,
          })
        : undefined

      return streamText({
        // Copilot returns the authoritative billed amount only in provider-specific response fields.
        includeRawChunks: input.model.providerID.includes("github-copilot"),
        onError(error) {
          l.error("stream error", {
            error,
          })
        },
        async experimental_repairToolCall(failed) {
          const toolName = failed.toolCall.toolName
          const lower = toolName.toLowerCase()
          // Separator/case canonicalization: models routinely rename tools
          // (`tool-search`, `ToolSearch` for `tool_search`). A miss on the
          // gateway used to self-lock: the intercept guidance still pointed at
          // tool_search while the misnamed call could never reach it.
          const canonical = lower.replace(/[-\s]+/g, "_")
          const repaired = tools[lower] ? lower : tools[canonical] ? canonical : undefined
          if (repaired && repaired !== toolName) {
            l.info("repairing tool call", {
              tool: toolName,
              repaired,
            })
            return {
              ...failed.toolCall,
              toolName: repaired,
            }
          }
          // Progressive-disclosure execution loop: a revealed-but-unpromoted tool
          // is by design not in the wire tool array, so the SDK raises NoSuchToolError
          // for a by-name call. Splice the def — built by SessionPrompt.resolveTools
          // through the same registry/context/permission/plugin-trigger path as a
          // registered tool — into the live record and return the call unchanged: the
          // re-validation passes and it executes normally. The provider request was
          // already sent, so this never rewrites the request's tool array.
          if (revealedCallable && NoSuchToolError.isInstance(failed.error)) {
            const revealedId = revealedCallable[toolName]
              ? toolName
              : lower !== toolName && revealedCallable[lower]
                ? lower
                : undefined
            if (revealedId) {
              l.info("executing revealed tool via repair", { tool: toolName, resolved: revealedId })
              tools[revealedId] = revealedCallable[revealedId]
              return { ...failed.toolCall, toolName: revealedId }
            }
          }
          if (NoSuchToolError.isInstance(failed.error) && input.revealedCallable?.[toolName]) {
            // Revealed earlier but permission/user-filtered out of the callable
            // view: revealing never grants permission, say so instead of looping.
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: toolName,
                error: `Tool ${toolName} was revealed but is not permitted for this agent/session; do not retry it.`,
              }),
              toolName: "invalid",
            }
          }
          if (
            NoSuchToolError.isInstance(failed.error) &&
            (ToolSearch.isDeferredTool(toolName) || ToolSearch.isDeferredTool(lower))
          ) {
            // Deferred and never revealed: guide the model to reveal it first.
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: toolName,
                error: ToolSearch.unknownToolGuidance(toolName),
              }),
              toolName: "invalid",
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        presencePenalty: params.presencePenalty,
        frequencyPenalty: params.frequencyPenalty,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
        tools,
        toolChoice,
        output: structuredOutput,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort,
        headers: {
          ...(input.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": opencodeProjectID,
                "x-opencode-session": input.sessionID,
                "x-opencode-request": input.user.id,
                "x-opencode-client": Flag.OPENCODE_CLIENT,
                "User-Agent": `opencode/${InstallationVersion}`,
              }
            : {
                "x-session-affinity": input.sessionID,
                ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                "User-Agent": `opencode/${InstallationVersion}`,
              }),
          ...input.model.headers,
          ...headers,
        },
        maxRetries: input.retries ?? 0,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({
              ...input,
              abort: input.abort ? AbortSignal.any([input.abort, ctrl.signal]) : ctrl.signal,
            })

            const events = Stream.fromAsyncIterable(result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            )
            const structuredOutput = input.structuredOutput
            if (!structuredOutput) return events
            // Deliver the SDK-validated object after the stream drains. A
            // schema/JSON failure rejects here and leaves the callback unset, so
            // SessionPrompt's existing StructuredOutputError path still governs
            // retries (same semantics as a missing tool call on the responses
            // wire).
            return Stream.ensuring(
              events,
              Effect.tryPromise(async () => {
                structuredOutput.onSuccess(await result.output)
              }).pipe(Effect.catchCause(() => Effect.void)),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ContextEpoch.defaultLayer),
  ),
)

/** @internal Exported for testing */
export function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  const filtered = Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  // tool_search never leaves the model-visible set: it is the gateway to the
  // deferred catalog and every disclosure guidance line points at it, so a
  // ruleset or per-message toggle that filters it out while the guidance stays
  // produces a self-lock (the model is told "reveal it with tool_search" but
  // cannot call tool_search). Revealing never grants permission — every
  // revealed tool still enforces its own gate at call time — so keeping the
  // gateway visible grants nothing itself. Utility agents whose whole set is
  // denied (title/summary/compaction, empty `filtered`) keep an empty record.
  if (
    Object.keys(filtered).length > 0 &&
    input.tools[ToolSearch.TOOL_SEARCH_ID] &&
    !filtered[ToolSearch.TOOL_SEARCH_ID]
  )
    filtered[ToolSearch.TOOL_SEARCH_ID] = input.tools[ToolSearch.TOOL_SEARCH_ID]
  // StructuredOutput is injected by SessionPrompt after permission resolution:
  // it is a session-internal control tool, not part of the user permission
  // domain. A restricted agent (for example explore's "*": "deny" allowlist)
  // would otherwise strip it from the wire while the caller already picked the
  // named tool_choice for it, producing "no function named StructuredOutput" on
  // the responses wire.
  if (input.tools[STRUCTURED_OUTPUT_TOOL_NAME] && !filtered[STRUCTURED_OUTPUT_TOOL_NAME])
    filtered[STRUCTURED_OUTPUT_TOOL_NAME] = input.tools[STRUCTURED_OUTPUT_TOOL_NAME]
  return filtered
}

// Permission-filter the revealed-but-unpromoted defs exactly like
// resolveTools filters the wire record: the repair path must not execute a
// revealed tool that the agent/session ruleset denies or the user message's
// per-tool toggles turned off.
function revealedCallableTools(input: Pick<StreamInput, "revealedCallable" | "agent" | "permission" | "user">) {
  const revealed = input.revealedCallable
  if (!revealed || Object.keys(revealed).length === 0) return undefined
  const disabled = Permission.disabled(
    Object.keys(revealed),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(revealed, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Builds the capability-layer tool view for systemSegments: re-adds the ids the
// ToolSearch defer filter removed, gated by the same permission/user-tool
// filters resolveTools applies, so core/browser et al. cannot distinguish a
// deferred-hidden tool from a never-registered one. Placeholder values are
// fine: capabilitySegments only checks truthiness of the key.
function capabilityTools(tools: Record<string, Tool>, input: StreamInput, revealedCallable?: Record<string, Tool>) {
  const hidden = input.deferredHidden
  if (!hidden?.length && !revealedCallable) return tools
  const disabled = hidden?.length
    ? Permission.disabled(hidden, Permission.merge(input.agent.permission, input.permission ?? []))
    : new Set<string>()
  const view: Record<string, unknown> = { ...tools }
  for (const id of hidden ?? []) {
    if (disabled.has(id)) continue
    if (input.user.tools?.[id] === false) continue
    view[id] ??= true
  }
  // Revealed tools are callable through the repair path even while off the
  // array, so capability layers must see them (the callable view is already
  // permission-filtered).
  for (const id of Object.keys(revealedCallable ?? {})) view[id] ??= true
  return view
}

// Wire-time switch from the Chimera function-tool gateway to the provider-
// defined OpenAI tool_search (client execution). Only the OpenAI Responses
// transport with OpenAI/Codex backend semantics gets the native tool; every
// other provider keeps the function tool. Mutates the per-request record in
// place, like the hosted web_search injection above.
export function applyNativeToolSearch(
  tools: Record<string, Tool>,
  input: {
    model: Pick<Provider.Model, "api" | "wire_api" | "backend_semantics">
    nativeToolSearch?: Tool
  },
  providerWireAPI: Provider.Info["wire_api"],
  providerID?: string,
) {
  const native = input.nativeToolSearch
  if (!native || !tools[ToolSearch.TOOL_SEARCH_ID]) return
  if (!ToolSearch.isOpenaiNativeToolSearch(input.model, providerWireAPI, providerID)) return
  tools[ToolSearch.TOOL_SEARCH_ID] = native
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
