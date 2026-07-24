import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
describe("cli.error", () => {
  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://console.chimera.ai/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://console.chimera.ai/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })
})


describe("UI.CancelledError schema", () => {
  test("keeps void payload validation and NamedError serialization aligned", () => {
    expect(Schema.decodeUnknownSync(UI.CancelledErrorPayloadSchema)(undefined)).toBeUndefined()
    expect(UI.CancelledErrorPayload.parse(undefined)).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(UI.CancelledErrorPayloadSchema)(null)).toThrow()
    expect(UI.CancelledErrorPayload.safeParse(null).success).toBe(false)

    const error = new UI.CancelledError()
    expect(error).toBeInstanceOf(NamedError)
    expect(error.toObject()).toEqual({ name: "UICancelledError", data: undefined })
    expect(FormatError(error)).toBe("")
  })
})
