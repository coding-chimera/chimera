import { describe, expect, test } from "bun:test"
import {
  RemoteCompactionRewriteError,
  decodeRemoteCompactionInput,
  encodeRemoteCompactionInput,
  rewriteRemoteCompactionInput,
} from "../../src/session/remote-compaction-codec"

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

  test("rejects invalid remote compaction request bodies", () => {
    expect(() =>
      rewriteRemoteCompactionInput(
        JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify({ __chimera_remote_compaction: { version: 2, output: [] } }) }] }] }),
      ),
    ).toThrow(RemoteCompactionRewriteError)
  })
})
