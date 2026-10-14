import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { redactConfig } from "@/cli/cmd/debug/redact"
import { cliIt } from "../lib/cli-process"

const config = {
  provider: {
    example: {
      options: {
        apiKey: "sk-example",
        timeout: 1200,
        headers: { Authorization: "Bearer example", "X-API-Key": "key" },
      },
      models: { demo: { variants: { fast: { api_key: "variant-secret" } } } },
    },
  },
  mcp: {
    remote: { oauth: { clientSecret: "oauth-secret", clientId: "public" }, headers: { "x-custom": "opaque" } },
    local: { environment: { SERVICE_TOKEN: "env-secret", PATH: "/usr/bin" } },
  },
  url: "https://user:pass@example.com/path",
  normal: { context_tokens: 200000, name: "example" },
}

describe("debug config redaction", () => {
  cliIt.live("always masks resolved credentials", ({ opencode }) =>
    Effect.gen(function* () {
      const content = JSON.stringify({ provider: config.provider })
      const env = { OPENCODE_CONFIG_CONTENT: content }
      const result = yield* opencode.spawn(["debug", "config"], { env })
      opencode.expectExit(result, 0, "debug config")
      expect(JSON.parse(result.stdout).provider.example.options).toMatchObject({
        apiKey: "***",
        timeout: 1200,
        headers: { Authorization: "***", "X-API-Key": "***" },
      })
      expect(result.stdout).not.toContain("sk-example")
      expect(result.stdout).not.toContain("Bearer example")
    }),
  )

  test("does not mutate the input and preserves unrelated settings", () => {
    const before = structuredClone(config)
    expect(redactConfig(config)).toEqual({
      provider: {
        example: {
          options: { apiKey: "***", timeout: 1200, headers: { Authorization: "***", "X-API-Key": "***" } },
          models: { demo: { variants: { fast: { api_key: "***" } } } },
        },
      },
      mcp: {
        remote: { oauth: { clientSecret: "***", clientId: "public" }, headers: { "x-custom": "***" } },
        local: { environment: { SERVICE_TOKEN: "***", PATH: "/usr/bin" } },
      },
      url: "***",
      normal: config.normal,
    })
    expect(config).toEqual(before)
  })

  test("redacts fork-shaped credentials and credential URLs without over-masking", () => {
    const input = {
      provider: {
        example: {
          options: { apiKey: "sk-live", baseURL: "https://user:pass@relay.example.com/v1", timeout: 1200 },
          models: { demo: { options: { api_key: "model-key" }, variants: { fast: { api_key: "variant-key" } } } },
        },
      },
      mcp: {
        local: {
          type: "local",
          command: ["npx", "-y", "srv"],
          environment: { SERVICE_TOKEN: "env-secret", PATH: "/usr/bin" },
        },
        remote: {
          type: "remote",
          url: "https://mcp.example.com/sse?api_key=qsecret&mode=debug",
          headers: { "x-custom": "opaque", Authorization: "Bearer tok" },
          oauth: { clientSecret: "oauth-secret", clientId: "public" },
        },
      },
      url: "https://user:pass@example.com/path",
      normal: { context_tokens: 200000, name: "example", max_tokens: 100 },
    }
    const before = structuredClone(input)
    expect(redactConfig(input)).toEqual({
      provider: {
        example: {
          options: { apiKey: "***", baseURL: "***", timeout: 1200 },
          models: { demo: { options: { api_key: "***" }, variants: { fast: { api_key: "***" } } } },
        },
      },
      mcp: {
        local: { type: "local", command: ["npx", "-y", "srv"], environment: { SERVICE_TOKEN: "***", PATH: "/usr/bin" } },
        remote: {
          type: "remote",
          url: "***",
          headers: { "x-custom": "***", Authorization: "***" },
          oauth: { clientSecret: "***", clientId: "public" },
        },
      },
      url: "***",
      normal: { context_tokens: 200000, name: "example", max_tokens: 100 },
    })
    expect(input).toEqual(before)
  })

  test("masks an unparseable credential-looking URL and keeps plain values", () => {
    expect(
      redactConfig({ endpoint: "http://[not a url", name: "keep", retries: 3, nested: [{ key: "v" }] }),
    ).toEqual({ endpoint: "***", name: "keep", retries: 3, nested: [{ key: "v" }] })
  })
})