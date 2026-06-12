import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "@/util/queue"

describe("AsyncQueue", () => {
  test("drops oldest items when bounded queue is full", async () => {
    const queue = new AsyncQueue<number>({ capacity: 2, overflow: "drop-oldest" })

    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    expect(queue.push(3)).toBe(true)

    expect(queue.dropped).toBe(1)
    expect(await queue.next()).toBe(2)
    expect(await queue.next()).toBe(3)
  })

  test("force push preserves terminal sentinels when bounded queue is full", async () => {
    const queue = new AsyncQueue<string | null>({ capacity: 2, overflow: "drop-newest" })

    expect(queue.push("first")).toBe(true)
    expect(queue.push("second")).toBe(true)
    expect(queue.push("third")).toBe(false)
    expect(queue.push(null, { force: true })).toBe(true)

    expect(queue.dropped).toBe(2)
    expect(await queue.next()).toBe("second")
    expect(await queue.next()).toBe(null)
  })
})
