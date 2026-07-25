import { expect, test } from "bun:test"
import { ResponsesTransport } from "@/provider/responses-transport"

function make(options: Partial<Parameters<typeof ResponsesTransport.make>[0]> = {}) {
  return ResponsesTransport.make({
    providerID: "custom",
    modelID: "logical-model",
    wireModelID: "wire-model",
    baseURL: "https://api.example.test/v1",
    apiKey: "secret",
    headers: {},
    fetch: async () => new Response("ok", { status: 200 }),
    timeout: false,
    chunkTimeout: undefined,
    ...options,
  })
}

function stream(parts: Array<{ delay: number; value?: string }>) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        await Bun.sleep(part.delay)
        if (part.value === undefined) continue
        controller.enqueue(encoder.encode(part.value))
      }
      controller.close()
    },
  })
}

test("normalizes every supported base URL suffix", async () => {
  const cases = [
    ["https://api.example.test/v1", "/v1/responses", "/v1/responses/compact"],
    ["https://api.example.test/v1/", "/v1/responses", "/v1/responses/compact"],
    ["https://api.example.test/v1/responses", "/v1/responses", "/v1/responses/compact"],
    ["https://api.example.test/v1/responses/", "/v1/responses", "/v1/responses/compact"],
    ["https://api.example.test/v1/responses/compact", "/v1/responses", "/v1/responses/compact"],
    ["https://api.example.test/v1/responses/compact/", "/v1/responses", "/v1/responses/compact"],
  ] as const
  for (const [baseURL, responses, compact] of cases) {
    const calls: string[] = []
    const transport = make({
      baseURL,
      fetch: async (input: RequestInfo | URL) => {
        calls.push(new URL(input.toString()).pathname)
        return new Response("ok")
      },
    })
    await transport.execute("responses", { body: "{}" })
    await transport.execute("responses/compact", { body: "{}" })
    expect(calls).toEqual([responses, compact])
  }
})

test("injects provider bearer without official OAuth headers", async () => {
  let seen = new Headers()
  const transport = make({
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response("body", { status: 201 })
    },
  })
  expect(await transport.execute("responses", { body: "request" })).toEqual({ status: 201, body: "body" })
  expect(seen.get("authorization")).toBe("Bearer secret")
  expect(seen.get("chatgpt-account-id")).toBeNull()
  expect(seen.get("openai-beta")).toBeNull()
})

test("configured authorization wins case-insensitively without duplicates", async () => {
  let seen = new Headers()
  const transport = make({
    headers: { AUTHORIZATION: "Basic configured" },
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response("ok")
    },
  })
  await transport.execute("responses", { body: "{}" })
  expect(seen.get("authorization")).toBe("Basic configured")
  expect([...seen.keys()].filter((name) => name === "authorization")).toHaveLength(1)
  expect(transport.identity.auth).toBe("configured")
  expect(transport.identity.ready).toBe(true)
})

test("owns the closed v2 feature header", async () => {
  const seen: Array<string | null> = []
  const transport = make({
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("x-codex-beta-features"))
      return new Response("ok")
    },
  })
  await transport.execute("responses", { body: "{}", feature: "remote-compaction-v2" })
  expect(seen).toEqual(["remote_compaction_v2"])
  await expect(
    transport.execute("responses/compact", { body: "{}", feature: "remote-compaction-v2" }),
  ).rejects.toThrow("feature is not allowed")
  expect(() => make({ headers: { "X-Codex-Beta-Features": "override" } })).toThrow("not allowed")
})

test("rejects unsafe URLs and protected headers without leaking values", () => {
  const secret = "do-not-echo"
  const cases = [
    () => make({ baseURL: `https://${secret}@api.example.test/v1` }),
    () => make({ baseURL: `https://api.example.test/v1?token=${secret}` }),
    () => make({ baseURL: `https://api.example.test/v1#${secret}` }),
    () => make({ baseURL: `ftp://api.example.test/${secret}` }),
    () => make({ headers: { Host: secret } }),
    () => make({ headers: { Cookie: secret } }),
    () => make({ headers: { "Proxy-Authorization": secret } }),
    () => make({ headers: { Connection: secret } }),
    () => make({ headers: { "Content-Length": "1" } }),
  ]
  for (const run of cases) {
    const error = (() => {
      try {
        run()
      } catch (cause) {
        return cause as Error
      }
    })()
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).not.toContain(secret)
  }
})

test("rejects target injection and redirects without a second request", async () => {
  let calls = 0
  const transport = make({
    fetch: async () => {
      calls++
      return new Response(null, { status: 307, headers: { Location: "https://evil.test/responses" } })
    },
  })
  await expect(transport.execute("../responses" as ResponsesTransport.Target, { body: "{}" })).rejects.toThrow(
    "target is not allowed",
  )
  await expect(transport.execute("https://evil.test" as ResponsesTransport.Target, { body: "{}" })).rejects.toThrow(
    "target is not allowed",
  )
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("redirect")
  expect(calls).toBe(1)
})

test("rejects observed response origin, scheme, or port changes", async () => {
  for (const url of ["https://evil.test/v1/responses", "http://api.example.test/v1/responses", "https://api.example.test:444/v1/responses"]) {
    const transport = make({
      fetch: async () => {
        const response = new Response("ok")
        Object.defineProperty(response, "url", { value: url })
        return response
      },
    })
    await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow()
  }
})

test("custom fetch sees only the constrained destination and body and is replay-ineligible", async () => {
  const calls: Array<{ url: string; body: BodyInit | null | undefined; redirect: RequestRedirect | undefined }> = []
  const transport = make({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), body: init?.body, redirect: init?.redirect })
      return new Response("ok")
    },
  })
  await transport.execute("responses", { body: "payload" })
  expect(calls).toEqual([
    { url: "https://api.example.test/v1/responses", body: "payload", redirect: "manual" },
  ])
  expect(transport.identity.replay).toEqual({ eligible: false, reason: "custom_fetch" })
})

test("safe identity is stable across key rotation and contains no routing details or secrets", () => {
  const first = make({ apiKey: "first-secret", fetch: undefined, headers: { Accept: "application/json" } }).identity
  const second = make({ apiKey: "second-secret", fetch: undefined, headers: { Accept: "application/json" } }).identity
  expect(first.compatibilityKey).toBe(second.compatibilityKey)
  expect(first.replay).toEqual({ eligible: true })
  expect(first).toMatchObject({
    providerID: "custom",
    modelID: "logical-model",
    wireModelID: "wire-model",
    wireAPI: "responses",
    auth: "provider-bearer",
    ready: true,
  })
  const text = JSON.stringify(first)
  expect(text).not.toContain("secret")
  expect(text).not.toContain("api.example.test")
  expect(text).not.toContain("/v1")
  expect(make({ headers: { "x-tenant": "route-a" }, fetch: undefined }).identity.replay).toEqual({
    eligible: false,
    reason: "routing_headers",
  })
})

test("does not call the network when credentials are missing", async () => {
  let called = false
  const transport = make({
    apiKey: undefined,
    headers: {},
    fetch: async () => {
      called = true
      return new Response()
    },
  })
  expect(transport.identity).toMatchObject({ auth: "missing", ready: false })
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("not ready")
  expect(called).toBe(false)
})

test("total timeout covers fetch before headers even when custom fetch ignores signal", async () => {
  const transport = make({
    timeout: 10,
    fetch: async () => new Promise<Response>(() => undefined),
  })
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("total timeout")
})

test("total timeout covers stalled body after headers", async () => {
  let cancelled = false
  const transport = make({
    timeout: 15,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("total timeout")
  expect(cancelled).toBe(true)
})

test("v2 chunk idle timeout cancels a stalled SSE body", async () => {
  let cancelled = false
  const transport = make({
    timeout: 100,
    chunkTimeout: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("idle timeout")
  expect(cancelled).toBe(true)
})

test("ongoing SSE chunks cannot extend the total timeout", async () => {
  const transport = make({
    timeout: 25,
    chunkTimeout: 15,
    fetch: async () => new Response(stream(Array.from({ length: 20 }, () => ({ delay: 5, value: "data: x\n\n" })))),
  })
  await expect(transport.execute("responses", { body: "{}" })).rejects.toThrow("total timeout")
})

test("legacy JSON body remains under the total timeout without SSE idle semantics", async () => {
  let cancelled = false
  const transport = make({
    timeout: 15,
    chunkTimeout: 5,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  await expect(transport.execute("responses/compact", { body: "{}" })).rejects.toThrow("total timeout")
  expect(cancelled).toBe(true)
})


test("per-attempt timeout applies when provider timeout is absent", async () => {
  const transport = make({
    timeout: false,
    fetch: async () => new Promise<Response>(() => undefined),
  })
  await expect(transport.execute("responses", { body: "{}", timeout: 10 })).rejects.toThrow("total timeout")
})

test("configured provider timeout may be stricter than parent attempt timeout", async () => {
  const started = Date.now()
  const transport = make({
    timeout: 10,
    fetch: async () => new Promise<Response>(() => undefined),
  })
  await expect(transport.execute("responses", { body: "{}", timeout: 1_000 })).rejects.toThrow("total timeout")
  expect(Date.now() - started).toBeLessThan(500)
})

test("sanitizes native and custom fetch rejections as network errors", async () => {
  const secret = "fetch-rejection-secret-marker"
  const assertNetworkError = async (transport: ResponsesTransport.Transport) => {
    const result = await transport.execute("responses", { body: "{}" }).catch((cause) => cause)
    expect(result).toBeInstanceOf(ResponsesTransport.Error)
    expect(result.kind).toBe("network")
    expect(result.message).toBe("Responses transport network request failed")
    expect(result.message).not.toContain(secret)
  }

  await assertNetworkError(
    make({
      fetch: async () => {
        throw new TypeError(secret)
      },
    }),
  )

  const nativeFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      throw new TypeError(secret)
    },
    { preconnect: nativeFetch.preconnect },
  )
  try {
    await assertNetworkError(make({ fetch: undefined }))
  } finally {
    globalThis.fetch = nativeFetch
  }
})


test("rejects oversized success and error bodies without exposing content", async () => {
  const secret = "secret-marker"
  for (const status of [200, 500]) {
    const transport = make({
      fetch: async () => new Response(`${secret}${"x".repeat(1_048_576)}`, { status }),
    })
    const result = await transport.execute("responses", { body: "{}" }).catch((cause) => cause as Error)
    expect(result).toBeInstanceOf(ResponsesTransport.Error)
    if (!(result instanceof Error)) throw new Error("expected transport error")
    expect(result.message).toContain("size limit")
    expect(result.message).not.toContain(secret)
  }
})
