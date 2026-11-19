import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testProviderConfig } from "../fixture/prompt-harness"
import { it } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app(experimental: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

async function createSession(
  experimental: boolean,
  directory: string,
  input: { headers?: Record<string, string>; body?: unknown },
) {
  const headers: Record<string, string> = { "x-chimera-directory": directory, ...input.headers }
  const init: RequestInit = { method: "POST", headers }
  if (input.body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(input.body)
  }
  return app(experimental).request(SessionPaths.create, init)
}

// F2-F5 parity: both server backends resolve the frozen client identically.
for (const experimental of [false, true]) {
  const label = experimental ? "HttpApi" : "legacy Hono"

  describe(`session create client capture (${label})`, () => {
    test("F2: header only freezes the client", async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
      const response = await createSession(experimental, tmp.path, {
        headers: { "x-chimera-client": "webui" },
        body: {},
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { client?: string }).client).toBe("webui")
    })

    test("F3: body client wins over the header", async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
      const response = await createSession(experimental, tmp.path, {
        headers: { "x-chimera-client": "webui" },
        body: { client: "cli" },
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { client?: string }).client).toBe("cli")
    })

    test("F4: invalid header is ignored, invalid body is rejected", async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

      const ignored = await createSession(experimental, tmp.path, {
        headers: { "x-chimera-client": "not-a-client" },
        body: {},
      })
      expect(ignored.status).toBe(200)
      expect(((await ignored.json()) as { client?: string }).client).toBeUndefined()

      const rejected = await createSession(experimental, tmp.path, {
        body: { client: "not-a-client" },
      })
      expect(rejected.status).toBe(400)
    })

    test("F5: no header and no body leaves the client undefined", async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
      const response = await createSession(experimental, tmp.path, {})
      expect(response.status).toBe(200)
      expect(((await response.json()) as { client?: string }).client).toBeUndefined()
    })
  })
}

// Compaction boundary resync: both server backends capture x-chimera-client
// on the summarize route and adopt it once compaction succeeds.
for (const experimental of [false, true]) {
  const label = experimental ? "HttpApi" : "legacy Hono"

  describe(`session compaction client resync (${label})`, () => {
    it.live("summarize with a webui header resyncs a tui session to webui", () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() =>
            tmpdir({ git: true, config: { formatter: false, lsp: false, ...testProviderConfig(llm.url) } }),
          ),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
        )
        yield* Effect.tryPromise(async () => {
          const call = (path: string, init: RequestInit) => app(experimental).request(path, init)
          const directory = { "x-chimera-directory": tmp.path }
          const json = { ...directory, "content-type": "application/json" }

          const created = await call(SessionPaths.create, {
            method: "POST",
            headers: { ...json, "x-chimera-client": "tui" },
            body: "{}",
          })
          const sessionID = ((await created.json()) as { id: string }).id

          const prompted = await call(SessionPaths.prompt.replace(":sessionID", sessionID), {
            method: "POST",
            headers: json,
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello" }],
            }),
          })
          await prompted.text()

          const summarized = await call(SessionPaths.summarize.replace(":sessionID", sessionID), {
            method: "POST",
            headers: { ...json, "x-chimera-client": "webui" },
            body: JSON.stringify({ providerID: "test", modelID: "test-model" }),
          })
          expect(summarized.status).toBe(200)

          const got = await call(SessionPaths.get.replace(":sessionID", sessionID), { headers: directory })
          expect(((await got.json()) as { client?: string }).client).toBe("webui")
        })
      }).pipe(Effect.provide(TestLLMServer.layer)),
    )

    it.live("an invalid client header is ignored on the prompt route", () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true, config: { formatter: false, lsp: false } })),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
        )
        yield* Effect.tryPromise(async () => {
          const call = (path: string, init: RequestInit) => app(experimental).request(path, init)
          const directory = { "x-chimera-directory": tmp.path }
          const json = { ...directory, "content-type": "application/json" }

          const created = await call(SessionPaths.create, {
            method: "POST",
            headers: { ...json, "x-chimera-client": "tui" },
            body: "{}",
          })
          const sessionID = ((await created.json()) as { id: string }).id

          const accepted = await call(SessionPaths.promptAsync.replace(":sessionID", sessionID), {
            method: "POST",
            headers: { ...json, "x-chimera-client": "not-a-client" },
            body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "hello" }] }),
          })
          expect(accepted.status).toBe(204)

          const got = await call(SessionPaths.get.replace(":sessionID", sessionID), { headers: directory })
          expect(((await got.json()) as { client?: string }).client).toBe("tui")
        })
      }),
    )

    it.live("an invalid client header is ignored on the summarize route", () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() =>
            tmpdir({ git: true, config: { formatter: false, lsp: false, ...testProviderConfig(llm.url) } }),
          ),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.ignore),
        )
        yield* Effect.tryPromise(async () => {
          const call = (path: string, init: RequestInit) => app(experimental).request(path, init)
          const directory = { "x-chimera-directory": tmp.path }
          const json = { ...directory, "content-type": "application/json" }

          const created = await call(SessionPaths.create, {
            method: "POST",
            headers: { ...json, "x-chimera-client": "tui" },
            body: "{}",
          })
          const sessionID = ((await created.json()) as { id: string }).id

          const prompted = await call(SessionPaths.prompt.replace(":sessionID", sessionID), {
            method: "POST",
            headers: json,
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello" }],
            }),
          })
          await prompted.text()

          const summarized = await call(SessionPaths.summarize.replace(":sessionID", sessionID), {
            method: "POST",
            headers: { ...json, "x-chimera-client": "not-a-client" },
            body: JSON.stringify({ providerID: "test", modelID: "test-model" }),
          })
          expect(summarized.status).toBe(200)

          const got = await call(SessionPaths.get.replace(":sessionID", sessionID), { headers: directory })
          expect(((await got.json()) as { client?: string }).client).toBe("tui")
        })
      }).pipe(Effect.provide(TestLLMServer.layer)),
    )
  })
}
