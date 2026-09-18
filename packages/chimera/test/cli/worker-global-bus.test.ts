import { describe, expect, test } from "bun:test"
import { GlobalBus } from "@/bus/global"
import { attachGlobalBusForwarder } from "@/cli/cmd/tui/worker-global-bus"

describe("attachGlobalBusForwarder (R1 B3)", () => {
  test("forwards global events while attached and stops after detach", () => {
    const forwarded: unknown[] = []
    const detach = attachGlobalBusForwarder((event) => forwarded.push(event))
    const before = GlobalBus.listenerCount("event")
    expect(before).toBeGreaterThanOrEqual(1)

    const event = { directory: "test", payload: { id: "evt_test", type: "test.event", properties: {} } }
    GlobalBus.emit("event", event)
    expect(forwarded).toEqual([event])

    detach()
    GlobalBus.emit("event", event)
    expect(forwarded.length).toBe(1)
    expect(GlobalBus.listenerCount("event")).toBe(before - 1)
  })

  test("detach is idempotent", () => {
    const detach = attachGlobalBusForwarder(() => {})
    const count = GlobalBus.listenerCount("event")
    detach()
    detach()
    expect(GlobalBus.listenerCount("event")).toBe(count - 1)
  })
})
