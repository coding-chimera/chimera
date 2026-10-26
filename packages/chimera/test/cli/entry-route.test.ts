import { describe, expect, test } from "bun:test"
import { routeEntry } from "@/cli/entry-route"

describe("routeEntry", () => {
  test("routes a direct child flag", () => {
    expect(routeEntry(["--orch-child"])).toBe("child")
  })

  test("routes a child flag after a -- separator", () => {
    expect(routeEntry(["--", "--orch-child"])).toBe("child")
  })

  test("routes the standalone binary shape", () => {
    expect(routeEntry(["/$bunfs/root/src/entry.js", "--orch-child"])).toBe("child")
  })

  test("defaults to the main entrypoint without the flag", () => {
    expect(routeEntry([])).toBe("main")
    expect(routeEntry(["--version"])).toBe("main")
    expect(routeEntry(["run", "--", "echo", "hi"])).toBe("main")
  })
})
