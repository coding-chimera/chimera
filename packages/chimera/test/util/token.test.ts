import { describe, expect, test } from "bun:test"
import { Token } from "@/util/token"

describe("Token (R1 hotspot-2)", () => {
  test("estimateLength matches estimate(JSON.stringify(array)) exactly for object arrays", () => {
    // The compaction estimator relies on this identity: an array serializes as
    // "[" + elements joined by "," + "]", so summing per-element serialized
    // lengths plus separators equals the length of the concatenated string.
    const arrays: Record<string, unknown>[][] = [
      [],
      [{ role: "user", content: "hello" }],
      [
        { role: "user", content: [{ type: "text", text: "a".repeat(1000) }] },
        { role: "assistant", content: "b".repeat(4001) },
        { role: "user", content: "" },
      ],
    ]
    for (const arr of arrays) {
      const viaConcat = Token.estimate(JSON.stringify(arr))
      const viaSum = Token.estimateLength(
        arr.length === 0 ? 2 : 2 + (arr.length - 1) + arr.reduce((n, m) => n + JSON.stringify(m).length, 0),
      )
      expect(viaSum).toBe(viaConcat)
    }
  })

  test("estimateLength clamps negatives like estimate clamps empty input", () => {
    expect(Token.estimateLength(-5)).toBe(0)
    expect(Token.estimateLength(0)).toBe(Token.estimate(""))
  })
})
