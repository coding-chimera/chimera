import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
  return Server.Legacy().app
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for event frame")), 5_000)),
  ])
  return {
    done: result.done,
    text: result.value ? new TextDecoder().decode(result.value) : "",
  }
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("legacy event instance context", () => {
  test("holds the routed instance lease until disposal closes the stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-chimera-directory": tmp.path }
    const response = await app().request("/event", { headers })
    if (!response.body) throw new Error("missing legacy event stream body")
    const reader = response.body.getReader()

    try {
      expect(response.status).toBe(200)
      expect((await readFrame(reader)).text).toContain('"type":"server.connected"')

      const disposed = await app().request("/instance/dispose", { method: "POST", headers })
      expect(disposed.status).toBe(200)
      expect(await disposed.json()).toBe(true)

      expect((await readFrame(reader)).text).toContain('"type":"server.instance.disposed"')
      expect((await readFrame(reader)).done).toBe(true)
    } finally {
      await reader.cancel().catch(() => {})
    }
  })
})
