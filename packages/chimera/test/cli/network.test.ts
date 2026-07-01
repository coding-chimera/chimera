import { describe, expect, test } from "bun:test"
import { resolveNetworkOptionsNoConfig, type NetworkOptions } from "../../src/cli/network"

const defaults = {
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "chimera.local",
  cors: [],
} satisfies NetworkOptions

function withArgs<T>(argv: string[], fn: () => T) {
  const original = process.argv
  process.argv = [original[0] ?? "bun", original[1] ?? "chimera", ...argv]
  try {
    return fn()
  } finally {
    process.argv = original
  }
}

describe("cli.network", () => {
  test("defaults to port 0 so Server.listen can choose the stable fallback", () => {
    expect(withArgs([], () => resolveNetworkOptionsNoConfig(defaults).port)).toBe(0)
  })

  test("preserves explicit --port 0", () => {
    expect(withArgs(["--port", "0"], () => resolveNetworkOptionsNoConfig({ ...defaults, port: 0 }).port)).toBe(0)
  })
})
