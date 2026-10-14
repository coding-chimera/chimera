import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpOAuthProvider, type McpOAuthCallbacks } from "../../src/mcp/oauth-provider"
import { McpAuth } from "../../src/mcp/auth"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"

async function makeProvider(callbacks: McpOAuthCallbacks) {
  const auth = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* McpAuth.Service
    }).pipe(Effect.provide(McpAuth.defaultLayer)),
  )
  return new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", {}, callbacks, auth)
}

describe("McpOAuthProvider.redirectToAuthorization", () => {
  test("forwards http and https authorization URLs", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: string[] = []
        const provider = await makeProvider({ onRedirect: (url) => void seen.push(url.href) })
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=1"))
        await provider.redirectToAuthorization(new URL("http://127.0.0.1:8080/authorize"))
        expect(seen).toEqual(["https://auth.example.com/authorize?state=1", "http://127.0.0.1:8080/authorize"])
      },
    })
  })

  test("rejects authorization URLs that are not http or https", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: string[] = []
        const provider = await makeProvider({ onRedirect: (url) => void seen.push(url.href) })
        await expect(provider.redirectToAuthorization(new URL("file:///tmp/authorize"))).rejects.toThrow(
          "returned a file: authorization URL",
        )
        expect(seen).toEqual([])
      },
    })
  })
})