import { describe, expect, test } from "bun:test"
import { TuiInfo } from "../../../src/cli/cmd/tui/config/tui-schema"

describe("tui prompt size config (upstream 0de5f1ff36)", () => {
  test("accepts prompt max_height and max_width", () => {
    const parsed = TuiInfo.parse({ prompt: { max_height: 12, max_width: "auto" } })
    expect(parsed.prompt).toEqual({ max_height: 12, max_width: "auto" })
    const fixed = TuiInfo.parse({ prompt: { max_width: 100 } })
    expect(fixed.prompt).toEqual({ max_width: 100 })
  })

  test("prompt section is optional", () => {
    expect(TuiInfo.parse({}).prompt).toBeUndefined()
  })

  test("rejects non-positive sizes", () => {
    expect(() => TuiInfo.parse({ prompt: { max_height: 0 } })).toThrow()
    expect(() => TuiInfo.parse({ prompt: { max_width: -3 } })).toThrow()
  })
})
