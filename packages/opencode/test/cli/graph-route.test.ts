import { describe, expect, test } from "bun:test"
import { graphCliArgs } from "@/cli/graph-route"

describe("graph CLI routing", () => {
  test("routes graph subcommand", () => {
    expect(graphCliArgs(["graph", "status", "."])).toEqual(["status", "."])
  })

  test("routes graph subcommand from Bun standalone argv fallback", () => {
    expect(graphCliArgs(["status", "."], ["graph", "status", "."])).toEqual(["status", "."])
    expect(graphCliArgs(["status", "."], ["/$bunfs/root/src/index.js", "graph", "status", "."])).toEqual([
      "status",
      ".",
    ])
    expect(
      graphCliArgs(["--help"], [
        "--user-agent=chimera/0.0.1",
        "--use-system-ca",
        "--",
        "graph",
        "status",
        ".",
      ]),
    ).toEqual(["status", "."])
  })

  test("routes --graph flag form", () => {
    expect(graphCliArgs(["--print-logs", "--graph", "status", "."])).toEqual(["status", "."])
  })

  test("routes --graph separator form", () => {
    expect(graphCliArgs(["--graph", "--", "status", "--json"])).toEqual(["status", "--json"])
  })

  test("shows graph help when no graph command is present", () => {
    expect(graphCliArgs(["graph"])).toEqual(["--help"])
    expect(graphCliArgs(["--graph", "--"])).toEqual(["--help"])
  })

  test("ignores normal agent arguments", () => {
    expect(graphCliArgs(["run", "hello"])).toBeUndefined()
  })
})
