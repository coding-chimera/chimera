import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { LLM, type LLMClientService, type LLMClientShape, type Model } from "@coding-chimera/llm"
import { LLMClient, RequestExecutor } from "@coding-chimera/llm/route"
import * as OpenAICompatible from "@coding-chimera/llm/providers/openai-compatible"
import { NativeLLMConvert } from "./convert"

// L4.4 native llm runtime pilot (flag: experimental.llm_runtime).
// A LanguageModelV3 implementation whose doStream/doGenerate execute on the
// @coding-chimera/llm route runtime (Protocol/Endpoint/Auth/Framing composed
// by Route.make, sent through RequestExecutor) instead of an AI SDK provider
// package. streamText keeps wrapping this model, so tool execution, repair,
// retries, telemetry, and usage aggregation are unchanged; only the wire
// transport and SSE parsing switch sides.

export type Config = {
  /** Fork providerID (kept as the AI SDK provider label for telemetry parity). */
  readonly providerID: string
  /** Wire model id (Provider.Model.api.id). */
  readonly wireModelID: string
  /** Resolved endpoint base, e.g. https://api.deepseek.com (path is appended by the route). */
  readonly baseURL: string | undefined
  /** Resolved API key (bearer). */
  readonly apiKey: string | undefined
  /** Static headers resolved from provider/model configuration. */
  readonly headers?: Record<string, string> | undefined
  /** Interleaved reasoning wire field, e.g. "reasoning_content". */
  readonly interleavedField?: string | undefined
  /** Key the fork writes call-level providerOptions under (providerID.split(".")[0] by default). */
  readonly providerOptionsKey?: string | undefined
  /** Test injection point; production resolves the shared managed runtime lazily. */
  readonly client?: LLMClientShape | undefined
}

let sharedRuntime: ManagedRuntime.ManagedRuntime<LLMClientService, never> | undefined
let sharedClient: Promise<LLMClientShape> | undefined

function client(): Promise<LLMClientShape> {
  sharedRuntime ??= ManagedRuntime.make(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer)))
  sharedClient ??= sharedRuntime.runPromise(
    Effect.gen(function* () {
      return yield* LLMClient.Service
    }),
  )
  return sharedClient
}

export class NativeTransportLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls = { image: [/^data:/, /^https:/] }

  private readonly model: Model
  private readonly convertConfig: NativeLLMConvert.ConvertConfig
  private readonly injected: LLMClientShape | undefined

  constructor(config: Config) {
    this.provider = config.providerID
    this.modelId = config.wireModelID
    this.injected = config.client
    this.convertConfig = {
      providerOptionsKey: config.providerOptionsKey ?? config.providerID.split(".")[0],
      interleavedField: config.interleavedField,
    }
    // The deepseek family facade pins the openai-compatible-chat route with
    // the canonical https://api.deepseek.com/v1 base; an explicitly resolved
    // fork baseURL (custom proxy, snapshot api url) overrides it so the wire
    // URL matches the AI SDK path byte for byte.
    this.model = OpenAICompatible.deepseek
      .configure({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers: config.headers,
      })
      .model(config.wireModelID)
  }

  private async llm(): Promise<LLMClientShape> {
    return this.injected ?? (await client())
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const llm = await this.llm()
    const lowering = NativeLLMConvert.lower(options, this.model, this.convertConfig)
    const response = await Effect.runPromise(
      llm.generate(LLM.request(lowering.request)).pipe(Effect.mapError(NativeLLMConvert.toApiCallError)),
    )
    const content = response.message.content.flatMap((part): LanguageModelV3Content[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
      if (part.type === "tool-call")
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
            providerExecuted: part.providerExecuted,
          },
        ]
      return []
    })
    return {
      content,
      finishReason: NativeLLMConvert.finishReason(response.finishReason),
      usage: NativeLLMConvert.usage(response.usage),
      warnings: lowering.warnings,
      providerMetadata: response.usage?.providerMetadata as SharedV3ProviderMetadata | undefined,
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const llm = await this.llm()
    const lowering = NativeLLMConvert.lower(options, this.model, this.convertConfig)
    const events = llm.stream(LLM.request(lowering.request)).pipe(
      Stream.mapError(NativeLLMConvert.toApiCallError),
      Stream.flatMap((event) => Stream.fromIterable(NativeLLMConvert.raise(event))),
    )
    const start: LanguageModelV3StreamPart = { type: "stream-start", warnings: lowering.warnings }
    const stream = Stream.toReadableStream(Stream.concat(Stream.make(start), events))
    // Cancellation closes the Effect scope, interrupting the HTTP fiber. While
    // a reader holds the stream the AI SDK cancels through the reader instead,
    // which propagates to the same scope.
    options.abortSignal?.addEventListener(
      "abort",
      () => {
        if (!stream.locked) void stream.cancel()
      },
      { once: true },
    )
    return { stream }
  }
}

export function languageModel(config: Config): LanguageModelV3 {
  return new NativeTransportLanguageModel(config)
}

export * as NativeLLMLanguageModel from "./language-model"
