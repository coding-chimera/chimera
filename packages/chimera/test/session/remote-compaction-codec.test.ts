import { describe, expect, test } from "bun:test"
import {
  RemoteCompactionRewriteError,
  decodeRemoteCompactionInput,
  encodeRemoteCompactionInput,
  inspectRemoteCompactionRequest,
  rewriteRemoteCompactionInput,
  rewriteRemoteCompactionRequest,
} from "../../src/session/remote-compaction-codec"

const binding = {
  providerID: "test-provider",
  modelID: "logical-model",
  wireModelID: "wire-model",
  driver: "codex-responses" as const,
  format: "responses_compaction_v1" as const,
  wire_api: "responses" as const,
  compatibility_key: "compatibility-key",
}

const metadata = {
  providerID: binding.providerID,
  endpoint: "provider" as const,
  driver: binding.driver,
  profile: "codex-responses" as const,
  implementation: "responses_compaction_v2" as const,
  modelID: binding.modelID,
  wireModelID: binding.wireModelID,
  replay: {
    format: binding.format,
    wire_api: binding.wire_api,
    compatibility_key: binding.compatibility_key,
  },
  output: [{ type: "compaction" as const, encrypted_content: "encrypted" }],
}
describe("session.remote-compaction-codec", () => {
  test("encodes and decodes remote compaction replay items", () => {
    const items = [
      { type: "compaction" as const, encrypted_content: "encrypted-context" },
      { type: "compaction_summary" as const, encrypted_content: "encrypted-summary" },
    ]

    expect(decodeRemoteCompactionInput(encodeRemoteCompactionInput(items))).toEqual(items)
  })

  test("ignores unrelated text and invalid envelopes", () => {
    expect(decodeRemoteCompactionInput("ordinary text")).toBeUndefined()
    expect(
      decodeRemoteCompactionInput(
        JSON.stringify({ __chimera_remote_compaction: { version: 2, output: [{ type: "compaction", encrypted_content: "encrypted" }] } }),
      ),
    ).toBeUndefined()
    expect(
      decodeRemoteCompactionInput(JSON.stringify({ __chimera_remote_compaction: { version: 1, output: [{ type: "message" }] } })),
    ).toBeUndefined()
  })

  test("rewrites encoded Responses input into raw compaction items", () => {
    const body = JSON.stringify({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: encodeRemoteCompactionInput([{ type: "compaction", encrypted_content: "encrypted" }]) }] },
      ],
    })

    expect(JSON.parse(rewriteRemoteCompactionInput(body))).toEqual({ input: [{ type: "compaction", encrypted_content: "encrypted" }] })
  })

  test("detects reserved envelopes in Responses and Chat request shapes without matching ordinary prose", () => {
    const encoded = encodeRemoteCompactionInput(metadata)
    expect(
      inspectRemoteCompactionRequest(
        JSON.stringify({ input: [{ type: "message", content: [{ type: "input_text", text: encoded }] }] }),
      ),
    ).toBe("decoded")
    expect(
      inspectRemoteCompactionRequest(
        JSON.stringify({ messages: [{ role: "user", content: encoded }] }),
      ),
    ).toBe("decoded")
    expect(
      inspectRemoteCompactionRequest(
        JSON.stringify({ messages: [{ role: "user", content: "Discuss __chimera_remote_compaction safely" }] }),
      ),
    ).toBe("none")
    expect(
      inspectRemoteCompactionRequest(
        JSON.stringify({ messages: [{ role: "user", content: `{"__chimera_remote_compaction":` }] }),
      ),
    ).toBe("invalid")
  })

  test("reports the envelope kind while rewriting remote compaction requests", () => {
    const ordinary = JSON.stringify({ input: [{ type: "message", role: "user", content: "ordinary" }] })
    expect(rewriteRemoteCompactionRequest(ordinary)).toEqual({ body: ordinary, envelope: "none" })

    const official = rewriteRemoteCompactionRequest(
      JSON.stringify({
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: encodeRemoteCompactionInput(metadata.output) }],
          },
        ],
      }),
    )
    expect(official.envelope).toBe("official-v1")
    expect(JSON.parse(official.body)).toEqual({ input: metadata.output })

    const provider = rewriteRemoteCompactionRequest(
      JSON.stringify({
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: encodeRemoteCompactionInput(metadata) }],
          },
        ],
      }),
      binding,
    )
    expect(provider.envelope).toBe("provider-v2")
    expect(JSON.parse(provider.body)).toEqual({ input: metadata.output })
  })

  test("rejects invalid remote compaction request bodies", () => {
    expect(() =>
      rewriteRemoteCompactionInput(
        JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify({ __chimera_remote_compaction: { version: 2, output: [] } }) }] }] }),
      ),
    ).toThrow(RemoteCompactionRewriteError)
  })

  test("binds generic v2 envelopes to the expected provider transport", () => {
    const encoded = encodeRemoteCompactionInput(metadata)
    expect(decodeRemoteCompactionInput(encoded)).toBeUndefined()
    expect(decodeRemoteCompactionInput(encoded, binding)).toEqual(metadata.output)
    expect(
      decodeRemoteCompactionInput(encoded, { ...binding, compatibility_key: "different" }),
    ).toBeUndefined()
  })

  test("rewrites generic v2 envelopes only for the exact binding", () => {
    const body = JSON.stringify({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: encodeRemoteCompactionInput(metadata) }],
        },
      ],
    })
    const rewritten = rewriteRemoteCompactionInput(body, binding)
    expect(JSON.parse(rewritten)).toEqual({ input: metadata.output })
    expect(rewriteRemoteCompactionInput(rewritten, binding)).toBe(rewritten)
    expect(() => rewriteRemoteCompactionInput(body, { ...binding, wireModelID: "different" })).toThrow(
      RemoteCompactionRewriteError,
    )
  })

  test("rejects a v2 envelope when any output item is invalid", () => {
    const encoded = JSON.stringify({
      __chimera_remote_compaction: {
        version: 2,
        binding,
        output: [...metadata.output, { type: "message", encrypted_content: "invalid" }],
      },
    })
    expect(decodeRemoteCompactionInput(encoded, binding)).toBeUndefined()
    expect(() =>
      rewriteRemoteCompactionInput(
        JSON.stringify({
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: encoded }] }],
        }),
        binding,
      ),
    ).toThrow(RemoteCompactionRewriteError)
  })


  test("rejects official v1 envelopes when a generic binding is required", () => {
    const encoded = encodeRemoteCompactionInput(metadata.output)
    expect(decodeRemoteCompactionInput(encoded, binding)).toBeUndefined()
    expect(() =>
      rewriteRemoteCompactionInput(
        JSON.stringify({
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: encoded }] }],
        }),
        binding,
      ),
    ).toThrow(RemoteCompactionRewriteError)
  })

  test("rejects malformed reserved JSON but leaves ordinary prose untouched", () => {
    const malformed = `{"__chimera_remote_compaction":`
    expect(() =>
      rewriteRemoteCompactionInput(
        JSON.stringify({
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: malformed }] }],
        }),
        binding,
      ),
    ).toThrow(RemoteCompactionRewriteError)
    const prose = JSON.stringify({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Discuss __chimera_remote_compaction safely" }] }],
    })
    expect(rewriteRemoteCompactionInput(prose, binding)).toBe(prose)
  })

  test("rejects every generic binding mismatch", () => {
    const body = JSON.stringify({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: encodeRemoteCompactionInput(metadata) }] }],
    })
    const mismatches = [
      { providerID: "other" },
      { modelID: "other" },
      { wireModelID: "other" },
      { driver: "other" },
      { format: "other" },
      { wire_api: "chat" },
      { compatibility_key: "other" },
    ]
    for (const mismatch of mismatches)
      expect(() => rewriteRemoteCompactionInput(body, { ...binding, ...mismatch } as typeof binding)).toThrow(
        RemoteCompactionRewriteError,
      )
  })
})
