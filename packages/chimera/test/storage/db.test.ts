import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "@/storage/db"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected =
      ["latest", "beta", "prod"].includes(InstallationChannel) || Flag.OPENCODE_DISABLE_CHANNEL_DB
      ? path.join(Global.Path.data, "chimera.db")
      : path.join(Global.Path.data, `chimera-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})


describe("Database.NotFoundError schema", () => {
  test("keeps Effect, Zod, and NamedError serialization aligned", () => {
    const data = { message: "row not found" }
    expect(Schema.decodeUnknownSync(Database.NotFoundErrorPayloadSchema)(data)).toEqual(data)
    expect(Database.NotFoundErrorPayload.parse(data)).toEqual(data)

    const error = new Database.NotFoundError(data)
    expect(error).toBeInstanceOf(NamedError)
    expect(error.toObject()).toEqual({ name: "NotFoundError", data })

    expect(() => Schema.decodeUnknownSync(Database.NotFoundErrorPayloadSchema)({ message: 1 })).toThrow()
    expect(Database.NotFoundErrorPayload.safeParse({ message: 1 }).success).toBe(false)
  })
})
