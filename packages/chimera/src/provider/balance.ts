import { Auth } from "@/auth"
import { codexAuthHeaders, codexEndpointUrl } from "@/plugin/codex"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { zod } from "@/util/effect-zod"
import { optionalOmitUndefined, withStatics } from "@/util/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const DEEPSEEK_PROVIDER_ID = ProviderID.make("deepseek")
const OPENAI_PROVIDER_ID = ProviderID.openai
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"

export const BalanceInfo = Schema.Struct({
  currency: Schema.String,
  total_balance: Schema.String,
  granted_balance: Schema.String,
  topped_up_balance: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type BalanceInfo = Schema.Schema.Type<typeof BalanceInfo>

export const QuotaLimit = Schema.Struct({
  label: Schema.String,
  used_percent: Schema.Number,
  remaining_percent: Schema.Number,
  window_minutes: optionalOmitUndefined(Schema.Number),
  resets_at: optionalOmitUndefined(Schema.Number),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type QuotaLimit = Schema.Schema.Type<typeof QuotaLimit>

const Status = Schema.Literals(["available", "unavailable", "not_configured", "unsupported", "error"])

export const BillingResult = Schema.Struct({
  kind: Schema.Literal("billing"),
  providerID: ProviderID,
  status: Status,
  is_available: optionalOmitUndefined(Schema.Boolean),
  balance_infos: Schema.Array(BalanceInfo),
  message: optionalOmitUndefined(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type BillingResult = Schema.Schema.Type<typeof BillingResult>

export const QuotaResult = Schema.Struct({
  kind: Schema.Literal("quota"),
  providerID: ProviderID,
  status: Status,
  label: optionalOmitUndefined(Schema.String),
  plan_type: optionalOmitUndefined(Schema.String),
  limits: Schema.Array(QuotaLimit),
  message: optionalOmitUndefined(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type QuotaResult = Schema.Schema.Type<typeof QuotaResult>

const DeepSeekBalanceResponse = Schema.Struct({
  is_available: Schema.Boolean,
  balance_infos: Schema.Array(BalanceInfo),
})

const CodexRateLimitWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.Number,
  reset_at: Schema.Number,
})

const CodexRateLimitDetails = Schema.Struct({
  primary_window: optionalOmitUndefined(Schema.NullOr(CodexRateLimitWindow)),
  secondary_window: optionalOmitUndefined(Schema.NullOr(CodexRateLimitWindow)),
})

const CodexUsageResponse = Schema.Struct({
  plan_type: Schema.String,
  rate_limit: optionalOmitUndefined(Schema.NullOr(CodexRateLimitDetails)),
})

export const Result = Schema.Union([BillingResult, QuotaResult])
  .annotate({ discriminator: "kind", identifier: "ProviderBalanceResult" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Result = Schema.Schema.Type<typeof Result>

export interface Interface {
  readonly get: (providerID: ProviderID) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderBalance") {}

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  return trimmed
}

function authApiKey(info: Auth.Info | undefined) {
  if (info?.type !== "api") return
  return stringValue(info.key)
}

function secondsToMinutes(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  return Math.ceil(seconds / 60)
}

function approximateWindow(minutes: number | undefined, expected: number) {
  if (minutes === undefined) return false
  return minutes >= expected * 0.95 && minutes <= expected * 1.05
}

function quotaLabel(windowMinutes: number | undefined, fallback: string) {
  if (approximateWindow(windowMinutes, 5 * 60)) return "5h"
  if (approximateWindow(windowMinutes, 24 * 60)) return "daily"
  if (approximateWindow(windowMinutes, 7 * 24 * 60)) return "weekly"
  if (approximateWindow(windowMinutes, 30 * 24 * 60)) return "monthly"
  return fallback
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function quotaLimit(window: typeof CodexRateLimitWindow.Type, fallback: string): QuotaLimit {
  const windowMinutes = secondsToMinutes(window.limit_window_seconds)
  const used = clampPercent(window.used_percent)
  return {
    label: quotaLabel(windowMinutes, fallback),
    used_percent: used,
    remaining_percent: 100 - used,
    ...(windowMinutes === undefined ? {} : { window_minutes: windowMinutes }),
    ...(window.reset_at > 0 ? { resets_at: window.reset_at } : {}),
  }
}

function headersObject(headers: Headers) {
  return Object.fromEntries(headers.entries())
}

export const layer: Layer.Layer<Service, never, Auth.Service | Provider.Service | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const http = yield* HttpClient.HttpClient
    const client = HttpClient.filterStatusOk(http)

    const deepSeekApiKey = Effect.fn("ProviderBalance.deepSeekApiKey")(function* () {
      const providerKey = yield* provider.getProvider(DEEPSEEK_PROVIDER_ID).pipe(
        Effect.map((info) => (info ? stringValue(info.key) ?? stringValue(info.options.apiKey) : undefined)),
        Effect.orElseSucceed(() => undefined),
      )
      if (providerKey) return providerKey
      return authApiKey(yield* auth.get(DEEPSEEK_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined)))
    })

    const codexUsageEndpoint = Effect.fn("ProviderBalance.codexUsageEndpoint")(function* () {
      const info = yield* provider.getProvider(OPENAI_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
      return codexEndpointUrl("usage", stringValue(info?.options.codexApiEndpoint))
    })

    const getDeepSeekBalance = Effect.fn("ProviderBalance.getDeepSeekBalance")(function* () {
      const key = yield* deepSeekApiKey()
      if (!key) {
        return {
          kind: "billing" as const,
          providerID: DEEPSEEK_PROVIDER_ID,
          status: "not_configured" as const,
          balance_infos: [],
          message: "DeepSeek API key is not configured.",
        }
      }

      return yield* HttpClientRequest.get(DEEPSEEK_BALANCE_URL).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        }),
        client.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DeepSeekBalanceResponse)),
        Effect.map((response) => ({
          kind: "billing" as const,
          providerID: DEEPSEEK_PROVIDER_ID,
          status: response.is_available ? "available" as const : "unavailable" as const,
          is_available: response.is_available,
          balance_infos: response.balance_infos,
        })),
        Effect.timeout("10 seconds"),
        Effect.catch(() =>
          Effect.succeed({
            kind: "billing" as const,
            providerID: DEEPSEEK_PROVIDER_ID,
            status: "error" as const,
            balance_infos: [],
            message: "Failed to load DeepSeek balance.",
          }),
        ),
      )
    })

    const getCodexQuota = Effect.fn("ProviderBalance.getCodexQuota")(function* () {
      const oauth = yield* auth.get(OPENAI_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
      if (oauth?.type !== "oauth") {
        return {
          kind: "quota" as const,
          providerID: OPENAI_PROVIDER_ID,
          status: "not_configured" as const,
          label: "Codex Usage",
          limits: [],
          message: "OpenAI Codex OAuth is not configured.",
        }
      }

      const headers = yield* Effect.promise(() =>
        codexAuthHeaders({
          auth: oauth,
          setAuth: (next) => Effect.runPromise(auth.set(OPENAI_PROVIDER_ID, next).pipe(Effect.orDie)),
        }),
      )
      headers.headers.set("Accept", "application/json")

      return yield* HttpClientRequest.get(yield* codexUsageEndpoint()).pipe(
        HttpClientRequest.setHeaders(headersObject(headers.headers)),
        client.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CodexUsageResponse)),
        Effect.map((response) => {
          const windows = [
            response.rate_limit?.primary_window ? quotaLimit(response.rate_limit.primary_window, "usage") : undefined,
            response.rate_limit?.secondary_window ? quotaLimit(response.rate_limit.secondary_window, "secondary usage") : undefined,
          ].filter((item): item is QuotaLimit => item !== undefined)
          return {
            kind: "quota" as const,
            providerID: OPENAI_PROVIDER_ID,
            status: windows.length > 0 ? "available" as const : "unavailable" as const,
            label: "Codex Usage",
            plan_type: response.plan_type,
            limits: windows,
            ...(windows.length > 0 ? {} : { message: "No Codex quota details returned." }),
          }
        }),
        Effect.timeout("10 seconds"),
        Effect.catch(() =>
          Effect.succeed({
            kind: "quota" as const,
            providerID: OPENAI_PROVIDER_ID,
            status: "error" as const,
            label: "Codex Usage",
            limits: [],
            message: "Failed to load Codex usage.",
          }),
        ),
      )
    })

    const get = Effect.fn("ProviderBalance.get")(function* (providerID: ProviderID) {
      if (providerID === DEEPSEEK_PROVIDER_ID) return yield* getDeepSeekBalance()
      if (providerID === OPENAI_PROVIDER_ID) return yield* getCodexQuota()
      return {
        kind: "billing" as const,
        providerID,
        status: "unsupported" as const,
        balance_infos: [],
        message: "Provider balance is not supported for this provider.",
      }
    })

    return Service.of({ get })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as ProviderBalance from "./balance"
