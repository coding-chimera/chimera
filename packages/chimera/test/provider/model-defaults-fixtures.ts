// Shared fixtures for the L4.3 model-capability data-table extraction.
// The golden snapshot (fixtures/model-defaults.golden.json) was captured from
// the pre-refactor hardcoded implementations using these exact fixtures, and
// test/provider/model-defaults.test.ts asserts the data-table implementation
// stays byte-identical on the default path.
import type { Provider } from "@/provider/provider"

export function fixtureModel(input: {
  id: string
  providerID?: string
  apiID?: string
  npm?: string
  reasoning?: boolean
  interleaved?: Provider.Model["capabilities"]["interleaved"]
  outputLimit?: number
  releaseDate?: string
  reasoningEfforts?: readonly string[]
  backendSemantics?: "openai" | "codex" | "alibailian"
  capabilityModelID?: string
  family?: string
}): Provider.Model {
  return {
    id: input.id as any,
    providerID: (input.providerID ?? input.id.split("/")[0]) as any,
    name: input.id,
    family: input.family,
    api: {
      id: input.apiID ?? input.id.split("/").slice(1).join("/") ?? input.id,
      url: "https://example.com",
      npm: input.npm ?? "@ai-sdk/openai-compatible",
    },
    status: "active",
    backend_semantics: input.backendSemantics,
    capability_model_id: input.capabilityModelID,
    reasoning_efforts: input.reasoningEfforts ? ([...input.reasoningEfforts] as any) : undefined,
    release_date: input.releaseDate ?? "",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: input.outputLimit ?? 65_536 },
    capabilities: {
      temperature: true,
      reasoning: input.reasoning ?? true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: input.interleaved ?? false,
      reasoning_protocol: undefined,
    },
    variants: {},
  } as any
}

// Models exercising the temperature/topP/topK id-matching chains.
export const samplingFixtures = [
  "north-mini-code",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen2.5-coder",
  "qwen",
  "claude-sonnet-4",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "glm-4.6",
  "glm-4.7",
  "glm-5.2",
  "minimax-m2",
  "minimax-m2.5",
  "minimax-m21",
  "kimi-k2",
  "kimi-k2-thinking",
  "kimi-k2.5",
  "kimi-k2p5",
  "kimi-k2-5",
  "kimi-k3",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
  "gpt-5.2",
  "some-unknown-model",
].map((id) => fixtureModel({ id: `provider/${id}`, providerID: "provider", apiID: id }))

// Models exercising baseVariants/variants across every npm switch case and the
// id-matching family detection chain.
export const variantFixtures: Provider.Model[] = [
  // openai-compatible: suppression chain (glm without efforts, deepseek, minimax, kimi, k2p, qwen, big-pickle)
  fixtureModel({ id: "zhipuai/glm-4.6", apiID: "glm-4.6", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({
    id: "zhipuai/glm-5.2",
    apiID: "glm-5.2",
    npm: "@ai-sdk/openai-compatible",
    reasoningEfforts: ["high", "max"],
  }),
  fixtureModel({ id: "deepseek/deepseek-chat", apiID: "deepseek-chat", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "deepseek/deepseek-reasoner", apiID: "deepseek-reasoner", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "deepseek/deepseek-r1", apiID: "deepseek-r1", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "deepseek/deepseek-v3", apiID: "deepseek-v3", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "deepseek/deepseek-v4-flash", apiID: "deepseek-v4-flash", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "minimax/minimax-m2", apiID: "minimax-m2", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "moonshotai/kimi-k2.5", apiID: "kimi-k2.5", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "moonshotai/k2p6", apiID: "k2p6", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "qwen/qwen3.8-max", apiID: "qwen3.8-max", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "pickles/big-pickle", apiID: "big-pickle", npm: "@ai-sdk/openai-compatible" }),
  // north-mini-code special efforts
  fixtureModel({ id: "north/north-mini-code", apiID: "north-mini-code", npm: "@ai-sdk/openai-compatible" }),
  // generic openai-compatible with max/xhigh progression
  fixtureModel({ id: "custom/some-model", apiID: "some-model", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({
    id: "custom/some-model-new",
    apiID: "some-model-new",
    npm: "@ai-sdk/openai-compatible",
    releaseDate: "2025-12-04",
  }),
  fixtureModel({ id: "custom/gpt-5-like", apiID: "gpt-5-like", npm: "@ai-sdk/openai-compatible" }),
  // claude via openai-compatible discovery gap
  fixtureModel({ id: "proxy/claude-sonnet-4", apiID: "claude-sonnet-4", npm: "@ai-sdk/openai-compatible" }),
  // tencent glm-5.2 discovery gap
  fixtureModel({
    id: "tencent/glm-5.2",
    providerID: "tencent",
    apiID: "glm-5.2",
    npm: "@ai-sdk/openai-compatible",
    reasoning: false,
  }),
  // nvidia kimi-k2.6
  fixtureModel({
    id: "nvidia/kimi-k2.6",
    providerID: "nvidia",
    apiID: "kimi-k2.6",
    npm: "@ai-sdk/openai-compatible",
  }),
  // grok generations
  fixtureModel({ id: "xai/grok-3-mini", apiID: "grok-3-mini", npm: "@ai-sdk/xai" }),
  fixtureModel({ id: "xai/grok-4.5", apiID: "grok-4.5", npm: "@ai-sdk/xai" }),
  fixtureModel({ id: "xai/grok-4-20-multi-agent", apiID: "grok-4-20-multi-agent", npm: "@ai-sdk/xai" }),
  fixtureModel({ id: "xai/grok-3", apiID: "grok-3", npm: "@ai-sdk/xai" }),
  fixtureModel({ id: "aijws/grok-4.5", apiID: "grok-4.5", npm: "@ai-sdk/openai-compatible" }),
  fixtureModel({ id: "openrouter/grok-3-mini", apiID: "grok-3-mini", npm: "@openrouter/ai-sdk-provider" }),
  // codex backend semantics
  fixtureModel({ id: "openai/gpt-5.2", apiID: "gpt-5.2", npm: "@ai-sdk/openai", backendSemantics: "codex" }),
  fixtureModel({ id: "openai/gpt-5.5", apiID: "gpt-5.5", npm: "@ai-sdk/openai", backendSemantics: "codex" }),
  fixtureModel({ id: "openai/gpt-5.6", apiID: "gpt-5.6", npm: "@ai-sdk/openai", backendSemantics: "codex" }),
  fixtureModel({
    id: "relay/gpt-5.6",
    providerID: "relay",
    apiID: "gpt-5.6",
    npm: "@ai-sdk/openai-compatible",
    backendSemantics: "codex",
    reasoningEfforts: ["low", "high", "max"],
  }),
  // openrouter
  fixtureModel({ id: "openrouter/openai/gpt-5.2", apiID: "openai/gpt-5.2", npm: "@openrouter/ai-sdk-provider" }),
  fixtureModel({ id: "openrouter/google/gemini-3-pro", apiID: "google/gemini-3-pro", npm: "@openrouter/ai-sdk-provider" }),
  fixtureModel({
    id: "openrouter/anthropic/claude-sonnet-4",
    apiID: "anthropic/claude-sonnet-4",
    npm: "@openrouter/ai-sdk-provider",
  }),
  fixtureModel({ id: "openrouter/meta-llama/llama-4", apiID: "meta-llama/llama-4", npm: "@openrouter/ai-sdk-provider" }),
  // cloudflare ai gateway
  fixtureModel({ id: "cf/openai/gpt-5.2", apiID: "openai/gpt-5.2", npm: "ai-gateway-provider" }),
  fixtureModel({
    id: "cf/openai/gpt-5-old",
    apiID: "openai/gpt-5-old",
    npm: "ai-gateway-provider",
    releaseDate: "2025-01-01",
  }),
  fixtureModel({ id: "cf/openai/gpt-5-pro", apiID: "openai/gpt-5-pro", npm: "ai-gateway-provider" }),
  fixtureModel({ id: "cf/anthropic/claude-x", apiID: "anthropic/claude-x", npm: "ai-gateway-provider" }),
  // @ai-sdk/gateway
  fixtureModel({ id: "gateway/anthropic/claude-opus-4.7", apiID: "anthropic/claude-opus-4.7", npm: "@ai-sdk/gateway" }),
  fixtureModel({ id: "gateway/anthropic/claude-sonnet-4", apiID: "anthropic/claude-sonnet-4", npm: "@ai-sdk/gateway" }),
  fixtureModel({ id: "gateway/google/gemini-2.5-pro", apiID: "google/gemini-2.5-pro", npm: "@ai-sdk/gateway" }),
  fixtureModel({ id: "gateway/google/gemini-3-pro", apiID: "google/gemini-3-pro", npm: "@ai-sdk/gateway" }),
  fixtureModel({ id: "gateway/openai/gpt-5.2", apiID: "openai/gpt-5.2", npm: "@ai-sdk/gateway" }),
  // github-copilot
  fixtureModel({ id: "github-copilot/gemini-3-pro", providerID: "github-copilot", apiID: "gemini-3-pro", npm: "@ai-sdk/github-copilot" }),
  fixtureModel({ id: "github-copilot/claude-sonnet-4", providerID: "github-copilot", apiID: "claude-sonnet-4", npm: "@ai-sdk/github-copilot" }),
  fixtureModel({ id: "github-copilot/gpt-5.1-codex-max", providerID: "github-copilot", apiID: "gpt-5.1-codex-max", npm: "@ai-sdk/github-copilot" }),
  fixtureModel({
    id: "github-copilot/gpt-5-new",
    providerID: "github-copilot",
    apiID: "gpt-5-new",
    npm: "@ai-sdk/github-copilot",
    releaseDate: "2025-12-04",
  }),
  fixtureModel({
    id: "github-copilot/gpt-5-old",
    providerID: "github-copilot",
    apiID: "gpt-5-old",
    npm: "@ai-sdk/github-copilot",
    releaseDate: "2025-01-01",
  }),
  // cerebras / togetherai / xai / deepinfra / venice / openai-compatible shared case
  fixtureModel({ id: "cerebras/llama-4", apiID: "llama-4", npm: "@ai-sdk/cerebras" }),
  fixtureModel({ id: "together/deepseek-v4", apiID: "deepseek-v4", npm: "@ai-sdk/togetherai" }),
  fixtureModel({ id: "deepinfra/qwen-x", apiID: "qwen-x", npm: "@ai-sdk/deepinfra" }),
  fixtureModel({ id: "venice/llama-4", apiID: "llama-4", npm: "venice-ai-sdk-provider" }),
  // azure
  fixtureModel({ id: "azure/o1-mini", apiID: "o1-mini", npm: "@ai-sdk/azure" }),
  fixtureModel({ id: "azure/gpt-5", apiID: "gpt-5", npm: "@ai-sdk/azure" }),
  fixtureModel({ id: "azure/gpt-4o", apiID: "gpt-4o", npm: "@ai-sdk/azure" }),
  // openai / bedrock mantle
  fixtureModel({ id: "openai/gpt-5-pro", apiID: "gpt-5-pro", npm: "@ai-sdk/openai" }),
  fixtureModel({ id: "openai/gpt-5.2-codex", apiID: "gpt-5.2-codex", npm: "@ai-sdk/openai" }),
  fixtureModel({ id: "openai/gpt-5-codex", apiID: "gpt-5-codex", npm: "@ai-sdk/openai" }),
  fixtureModel({ id: "openai/gpt-5", apiID: "gpt-5", npm: "@ai-sdk/openai", releaseDate: "2025-01-01" }),
  fixtureModel({ id: "openai/gpt-5-new", apiID: "gpt-5-new", npm: "@ai-sdk/openai", releaseDate: "2025-12-10" }),
  fixtureModel({ id: "mantle/gpt-5.2", apiID: "gpt-5.2", npm: "@ai-sdk/amazon-bedrock/mantle" }),
  // anthropic adaptive + budget variants
  fixtureModel({ id: "anthropic/claude-opus-4.7", apiID: "claude-opus-4.7", npm: "@ai-sdk/anthropic" }),
  fixtureModel({ id: "anthropic/claude-opus-4-6", apiID: "claude-opus-4-6", npm: "@ai-sdk/anthropic" }),
  fixtureModel({ id: "anthropic/claude-sonnet-4.6", apiID: "claude-sonnet-4.6", npm: "@ai-sdk/anthropic" }),
  fixtureModel({ id: "anthropic/claude-sonnet-4", apiID: "claude-sonnet-4", npm: "@ai-sdk/anthropic" }),
  fixtureModel({
    id: "anthropic/claude-small-out",
    apiID: "claude-small-out",
    npm: "@ai-sdk/anthropic",
    outputLimit: 10_000,
  }),
  fixtureModel({
    id: "github-copilot/claude-opus-4.7",
    providerID: "github-copilot",
    apiID: "claude-opus-4.7",
    npm: "@ai-sdk/anthropic",
  }),
  fixtureModel({ id: "vertex/claude-opus-4.7", apiID: "claude-opus-4.7", npm: "@ai-sdk/google-vertex/anthropic" }),
  // bedrock
  fixtureModel({ id: "bedrock/claude-opus-4-6", apiID: "claude-opus-4-6", npm: "@ai-sdk/amazon-bedrock" }),
  fixtureModel({ id: "bedrock/anthropic.claude-v3", apiID: "anthropic.claude-v3", npm: "@ai-sdk/amazon-bedrock" }),
  fixtureModel({ id: "bedrock/amazon.nova-2-lite", apiID: "amazon.nova-2-lite", npm: "@ai-sdk/amazon-bedrock" }),
  // google / vertex
  fixtureModel({ id: "google/gemini-2.5-pro", apiID: "gemini-2.5-pro", npm: "@ai-sdk/google" }),
  fixtureModel({ id: "google/gemini-3.1-pro", apiID: "gemini-3.1-pro", npm: "@ai-sdk/google" }),
  fixtureModel({ id: "google/gemini-3-pro", apiID: "gemini-3-pro", npm: "@ai-sdk/google" }),
  fixtureModel({ id: "vertex/gemini-2.5-pro", apiID: "gemini-2.5-pro", npm: "@ai-sdk/google-vertex" }),
  // mistral
  fixtureModel({ id: "mistral/mistral-small-2603", apiID: "mistral-small-2603", npm: "@ai-sdk/mistral" }),
  fixtureModel({ id: "mistral/mistral-large", apiID: "mistral-large", npm: "@ai-sdk/mistral" }),
  fixtureModel({
    id: "mistral/mistral-medium-3.5-noreason",
    apiID: "mistral-medium-3.5",
    npm: "@ai-sdk/mistral",
    reasoning: false,
  }),
  // cohere / groq / perplexity
  fixtureModel({ id: "cohere/command-r", apiID: "command-r", npm: "@ai-sdk/cohere" }),
  fixtureModel({ id: "groq/llama-4", apiID: "llama-4", npm: "@ai-sdk/groq" }),
  fixtureModel({ id: "perplexity/sonar", apiID: "sonar", npm: "@ai-sdk/perplexity" }),
  // sap
  fixtureModel({ id: "sap/claude-opus-4.7", apiID: "claude-opus-4.7", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  fixtureModel({ id: "sap/claude-sonnet-4", apiID: "claude-sonnet-4", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  fixtureModel({ id: "sap/gemini-2.5-pro", apiID: "gemini-2.5-pro", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  fixtureModel({ id: "sap/gpt-5.2", apiID: "gpt-5.2", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  fixtureModel({ id: "sap/o1-preview", apiID: "o1-preview", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  fixtureModel({ id: "sap/llama-4", apiID: "llama-4", npm: "@jerome-benoit/sap-ai-provider-v2" }),
  // gitlab (family-driven)
  fixtureModel({ id: "gitlab/gpt-5.2", apiID: "gpt-5.2", npm: "gitlab-ai-provider", family: "gpt" }),
  fixtureModel({ id: "gitlab/claude-x", apiID: "claude-x", npm: "gitlab-ai-provider", family: "claude" }),
  fixtureModel({
    id: "gitlab/claude-y",
    apiID: "claude-y",
    npm: "gitlab-ai-provider",
    family: "claude",
    reasoningEfforts: ["low", "high"],
  }),
  fixtureModel({ id: "gitlab/llama", apiID: "llama", npm: "gitlab-ai-provider", family: "llama" }),
  // no-reasoning guard
  fixtureModel({ id: "plain/no-reasoning", apiID: "no-reasoning", npm: "@ai-sdk/openai-compatible", reasoning: false }),
]

// Catalog fixtures exercising inferReasoningProtocol through normalizeCatalog.
export const catalogFixture = {
  zhipuai: {
    id: "zhipuai",
    name: "ZhipuAI",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-4.6": {
        id: "glm-4.6",
        name: "GLM 4.6",
        family: "glm",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "other-model": {
        id: "other-model",
        name: "Other",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
    },
  },
  tencent: {
    id: "tencent",
    name: "Tencent",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.2": {
        id: "glm-5.2",
        name: "GLM 5.2",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        reasoning_options: [{ type: "effort", values: ["high", "max"] }],
      },
    },
  },
  "alibaba-cn": {
    id: "alibaba-cn",
    name: "Alibaba CN",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "qwen3-max": {
        id: "qwen3-max",
        name: "Qwen3 Max",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "qwen3-noreason": {
        id: "qwen3-noreason",
        name: "Qwen3 NoReason",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "kimi-k2-thinking": {
        id: "kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
    },
  },
  baseten: {
    id: "baseten",
    name: "Baseten",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-4.6": {
        id: "glm-4.6",
        name: "GLM 4.6",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
    },
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    env: [],
    models: {
      "kimi-k2-thinking": {
        id: "kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        provider: { npm: "@ai-sdk/openai-compatible" },
      },
      "glm-4.6": {
        id: "glm-4.6",
        name: "GLM 4.6",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        provider: { npm: "@ai-sdk/openai-compatible" },
      },
      "gpt-5.2": {
        id: "gpt-5.2",
        name: "GPT 5.2",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        provider: { npm: "@ai-sdk/openai-compatible" },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: [],
    npm: "@ai-sdk/google",
    models: {
      "gemini-3-pro": {
        id: "gemini-3-pro",
        name: "Gemini 3 Pro",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "gemini-flash": {
        id: "gemini-flash",
        name: "Gemini Flash",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: [],
    npm: "@ai-sdk/anthropic",
    models: {
      "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "k2p6": {
        id: "k2p6",
        name: "K2P6",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
      },
      "claude-opus-4.7": {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 65536 },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
      },
    },
  },
} as any

export const codexIDFixtures = [
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6",
  "gpt-5.6-fast",
  "gpt-5.6-pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "openai/gpt-5.6",
  "openai.gpt-5.6",
  "codex/gpt-5.3-codex",
  "gpt-6.0-astra",
  "gpt-7",
  "gpt-5",
  "gpt-4o",
  "claude-opus-4.7",
  "deepseek-v4-flash",
]
