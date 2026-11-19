import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

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