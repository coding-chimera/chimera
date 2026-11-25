/**
 * Provider-seam regression for fix #2: a provider-pinned proxy must never be
 * bypassed when the loaded addon cannot register the profile (an old addon
 * without `configureTls`) or when a request is delegated (a FormData body).
 *
 * `transportProfileFor` is module-private, so these tests drive the real
 * provider path (`getModel` -> `getLanguage` -> resolveSDK) and read the SDK
 * model's `config.fetch` — the exact wrapper resolveSDK installed. A stub
 * `globalThis.fetch` observes the final Bun-fallback call and its injected
 * `proxy` init; the fake addon observes whether the native path was taken.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { WithInstance } from "../../src/project/with-instance"
import { AppRuntime } from "../../src/composition/app-runtime"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { HttpLimit } from "@/provider/http-limit"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import { CAPABILITY, REQUIRED_CAPABILITIES, type TransportAddon } from "@/provider/sdk/native-transport/layout"
import { clearTransportEnv } from "./fixtures/transport/helpers"

const PROVIDER_ID = ProviderID.make("proxy-profile")
const MODEL_ID = ModelID.make("m1")
const PINNED_PROXY = "http://127.0.0.1:3128"

const encoder = new TextEncoder()

function addonStats() {
  return {
    activeHandles: 0,
    bufferedBytes: 0,
    cancelledHandles: 0,
    postSendErrors: 0,
    workerThreads: 1,
  }
}

/** Old addon: advertises proxy-system but has NO configureTls export. */
function oldAddon() {
  let contracts = 0
  const addon: TransportAddon = {
    contractInfo: () => {
      contracts += 1
      return {
        abiMajor: 1,
        abiMinor: 2,
        capabilities: [...REQUIRED_CAPABILITIES, CAPABILITY.proxySystem],
        build: "fake-old-addon",
      }
    },
    startRequest: () => ({ handle: 1 }),
    awaitHeaders: async () => ({ status: 200, statusText: "OK", headers: [], url: "", redirected: false }),
    readBody: async () => null,
    cancel: () => {},
    release: () => {},
    stats: addonStats,
  }
  return { addon, contracts: () => contracts }
}

/** Native-capable addon: registers profiles and answers with "native". */
function usableAddon() {
  let started = 0
  const consumed = new Set<number>()
  const addon: TransportAddon = {
    contractInfo: () => ({
      abiMajor: 1,
      abiMinor: 2,
      capabilities: [
        ...REQUIRED_CAPABILITIES,
        CAPABILITY.tls,
        CAPABILITY.tlsPlatform,
        CAPABILITY.tlsCustomCa,
        CAPABILITY.mtls,
        CAPABILITY.proxySystem,
      ],
      build: "fake-usable-addon",
    }),
    startRequest: () => {
      started += 1
      return { handle: started }
    },
    awaitHeaders: async (handle) => ({
      status: 200,
      statusText: "OK",
      headers: [{ name: "content-type", value: "text/plain" }],
      url: "",
      redirected: false,
    }),
    readBody: async (handle) => {
      if (consumed.has(handle)) return null
      consumed.add(handle)
      return encoder.encode("native")
    },
    cancel: () => {},
    release: () => {},
    stats: addonStats,
    configureTls: () => ({ profileId: 7 }),
  }
  return { addon, started: () => started }
}

function providerConfig() {
  return {
    experimental: { rust_transport: true },
    provider: {
      [PROVIDER_ID]: {
        name: "Proxy Profile",
        npm: "@ai-sdk/openai-compatible",
        wire_api: "chat" as const,
        models: {
          [MODEL_ID]: {
            name: "Proxy Profile Model",
            tool_call: true,
            limit: { context: 128_000, output: 4_096 },
          },
        },
        options: {
          baseURL: "http://api.example.test/v1",
          apiKey: "test-key",
          proxy: PINNED_PROXY,
        },
      },
    },
  }
}

/** Resolve the fetch wrapper the provider installed on the SDK model. */
function resolveSdkFetch() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(PROVIDER_ID, MODEL_ID)
      const language = yield* provider.getLanguage(model)
      const fn = (language as unknown as { config?: { fetch?: typeof fetch } }).config?.fetch
      if (typeof fn !== "function") throw new Error("SDK model did not expose config.fetch")
      return fn
    }),
  )
}

type FetchCall = { input: RequestInfo | URL; init: RequestInit | undefined }

function stubFetch() {
  const original = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response("proxied")
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = clearTransportEnv()
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.setTransportForTests(null)
  NativeTransportLoader.resetTransportForTests()
  HttpLimit.dispose()
  restoreEnv()
})

test("an old addon cannot register a pinned proxy: the request falls back through Bun with the proxy injected", async () => {
  const old = oldAddon()
  NativeTransportLoader.setTransportForTests(old.addon)
  // The simulated old addon has no configureTls export, so registration fails.
  expect(NativeTransport.configureTls({ caPem: "irrelevant" })).toBeNull()

  await using tmp = await tmpdir({ config: providerConfig() })
  const fetchFn = await WithInstance.provide({ directory: tmp.path, fn: resolveSdkFetch })

  // transportProfileFor really ran: it consulted the addon's capabilities and
  // found the profile unusable (otherwise this would just be the native-off path).
  expect(old.contracts()).toBeGreaterThan(0)

  const stub = stubFetch()
  try {
    const response = await fetchFn("http://api.example.test/v1/chat")
    expect(await response.text()).toBe("proxied")
  } finally {
    stub.restore()
  }

  // The pinned proxy is the only route: Bun fetch received it, and the old
  // addon never started the request (profile 0 would have bypassed the proxy).
  expect(stub.calls.length).toBe(1)
  expect((stub.calls[0]!.init as { proxy?: string }).proxy).toBe(PINNED_PROXY)
})

test("a native-usable addon serves plain requests, and a delegated FormData request still honors the pinned proxy", async () => {
  const { addon, started } = usableAddon()
  NativeTransportLoader.setTransportForTests(addon)

  await using tmp = await tmpdir({ config: providerConfig() })
  const fetchFn = await WithInstance.provide({ directory: tmp.path, fn: resolveSdkFetch })

  // The profile registered (configureTls -> profileId 7) and a plain GET rides
  // the addon: proof the profile is usable rather than falling back.
  const native = await fetchFn("http://api.example.test/v1/chat")
  expect(await native.text()).toBe("native")
  expect(started()).toBe(1)

  // FormData cannot ride the addon, so the adapter delegates — and the Bun
  // fallback must still carry the pinned proxy.
  const stub = stubFetch()
  try {
    const delegated = await fetchFn("http://api.example.test/v1/chat", { method: "POST", body: new FormData() })
    expect(await delegated.text()).toBe("proxied")
  } finally {
    stub.restore()
  }

  expect(started()).toBe(1)
  expect(stub.calls.length).toBe(1)
  expect((stub.calls[0]!.init as { proxy?: string }).proxy).toBe(PINNED_PROXY)
})