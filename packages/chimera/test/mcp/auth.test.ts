import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { McpAuth } from "../../src/mcp/auth"

describe("McpAuth schemas", () => {
  test("keeps Effect and Zod decoding aligned", () => {
    const input = {
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: 1_800_000_000,
        scope: "openid profile",
      },
      clientInfo: {
        clientId: "client-id",
        clientSecret: "client-secret",
        clientIdIssuedAt: 1_700_000_000,
        clientSecretExpiresAt: 1_900_000_000,
      },
      codeVerifier: "verifier",
      oauthState: "state",
      serverUrl: "https://mcp.example.com",
    }

    expect(Schema.decodeUnknownSync(McpAuth.EntrySchema)(input)).toEqual(input)
    expect(McpAuth.Entry.parse(input)).toEqual(input)
  })

  test("rejects invalid nested auth data through both decoders", () => {
    const input = { tokens: { accessToken: 42 } }

    expect(() => Schema.decodeUnknownSync(McpAuth.EntrySchema)(input)).toThrow()
    expect(() => McpAuth.Entry.parse(input)).toThrow()
  })
})