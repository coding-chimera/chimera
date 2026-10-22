import { describe, expect, test } from "bun:test"
import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_MS,
  HOST_PROTOCOL_MAX,
  HOST_PROTOCOL_MIN,
  Handshake,
  negotiateProtocol,
  REQUIRED_CAPABILITIES,
  type AcceptContext,
  type Hello,
} from "../../src/host/ipc-handshake"
import { MAX_FRAGMENTS, MAX_FRAME_BYTES, MAX_FRAME_BYTES_HARD, MAX_REASSEMBLED_BYTES } from "../../src/host/ipc-frame"

const CONTEXT = { connection_id: 17n, worker_generation: 8n }

const ALL_CAPABILITIES = [
  "frame.v1",
  "control.json",
  "event.batch",
  "cancel",
  "drain",
  "replay.command",
  "encoding.msgpack",
  "session.runtime",
]

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    v: 1,
    kind: "hello",
    phase: "hello",
    nonce: "one-time-token",
    worker: {
      pid: 12345,
      build: "chimera-bun-worker@0.0.0",
      runtime: "bun@1.2.0",
      boot_id: "boot_1729550000000_12345",
    },
    protocol: { min: 0x0100, max: 0x0100 },
    encodings: ["json", "msgpack"],
    compressions: [],
    capabilities: [...ALL_CAPABILITIES],
    limits: { max_frame_bytes: MAX_FRAME_BYTES },
    workspace: { directory: "/abs/workspace", project_id: "prj_test" },
    ...overrides,
  }
}

function accept(overrides: Partial<Hello> = {}, context: AcceptContext = CONTEXT) {
  return new Handshake().acceptHello(hello(overrides), context)
}

describe("handshake happy path", () => {
  test("negotiates every §5.1 ready field", () => {
    const handshake = new Handshake()
    expect(handshake.state).toBe("awaiting_hello")

    const result = handshake.acceptHello(
      hello({ resume: { last_acked_command_sequence: 42, stream_epoch: "epoch_1" } }),
      CONTEXT,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(handshake.state).toBe("ready")
    expect(handshake.ready).toBe(result.ready)
    expect(result.ready).toEqual({
      v: 1,
      kind: "hello",
      phase: "ready",
      connection_id: 17n,
      worker_generation: 8n,
      protocol: 0x0100,
      encodings: ["json", "msgpack"],
      compressions: [],
      capabilities: ALL_CAPABILITIES,
      limits: {
        max_frame_bytes: MAX_FRAME_BYTES,
        max_reassembled_bytes: MAX_REASSEMBLED_BYTES,
        max_fragments: MAX_FRAGMENTS,
        heartbeat_ms: HEARTBEAT_MS,
        request_timeout_ms: 30_000,
        cancel_soft_timeout_ms: 5_000,
        cancel_hard_timeout_ms: 30_000,
      },
      resume: { from_command_sequence: 43, replay_available: true },
    })
  })

  test("candidate default timeouts are the documented values", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000)
    expect(HEARTBEAT_MS).toBe(10_000)
  })

  test("absent resume starts at command sequence 1 with no replay available", () => {
    const result = accept()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ready.resume).toEqual({ from_command_sequence: 1, replay_available: false })
  })
})

describe("version negotiation", () => {
  test("picks the highest common minor", () => {
    expect(negotiateProtocol({ min: 0x0100, max: 0x0102 })).toBe(0x0102)
    expect(negotiateProtocol({ min: 0x0101, max: 0x0103 })).toBe(0x0103)
  })

  test("a disjoint worker range is unsupported_protocol_version", () => {
    const result = accept({ protocol: { min: 0x0200, max: 0x0200 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reject.code).toBe("unsupported_protocol_version")
    expect(result.reject.details).toEqual({
      worker_protocol: { min: 0x0200, max: 0x0200 },
      host_protocol: { min: HOST_PROTOCOL_MIN, max: HOST_PROTOCOL_MAX },
    })
  })

  test("a worker max below the host min is rejected", () => {
    const result = accept({ protocol: { min: 0x0001, max: 0x00ff } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reject.code).toBe("unsupported_protocol_version")
  })

  test("rejection moves the machine to rejected", () => {
    const handshake = new Handshake()
    handshake.acceptHello(hello({ protocol: { min: 0x0200, max: 0x0200 } }), CONTEXT)
    expect(handshake.state).toBe("rejected")
    expect(handshake.rejection?.code).toBe("unsupported_protocol_version")
  })
})

describe("capability negotiation", () => {
  test("a missing required capability lists every gap", () => {
    const result = accept({
      capabilities: ALL_CAPABILITIES.filter((capability) => capability !== "frame.v1" && capability !== "drain"),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reject.code).toBe("capability_missing")
    expect(result.reject.details).toEqual({ missing_capabilities: ["frame.v1", "drain"] })
  })

  test("every §6.2 required capability is enforced", () => {
    REQUIRED_CAPABILITIES.forEach((capability) => {
      const result = accept({ capabilities: ALL_CAPABILITIES.filter((entry) => entry !== capability) })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reject.code).toBe("capability_missing")
        expect(result.reject.details.missing_capabilities).toEqual([capability])
      }
    })
  })

  test("an unknown non-x capability is rejected and reported", () => {
    const result = accept({ capabilities: [...ALL_CAPABILITIES, "teleport.v9"] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reject.code).toBe("unknown_capability")
    expect(result.reject.details).toEqual({ unknown_capabilities: ["teleport.v9"] })
  })

  test("x- extension capabilities are ignored", () => {
    const result = accept({ capabilities: [...ALL_CAPABILITIES, "x-vendor.extra"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ready.capabilities).not.toContain("x-vendor.extra")
    expect(result.ready.capabilities).toEqual(ALL_CAPABILITIES)
  })

  test("reserved pty.bridge is not offered by a v0 host", () => {
    const result = accept({ capabilities: [...ALL_CAPABILITIES, "pty.bridge"] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ready.capabilities).not.toContain("pty.bridge")
  })

  test("encoding intersection keeps json as the mandatory fallback", () => {
    const result = accept({ encodings: ["json"] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ready.encodings).toEqual(["json"])
  })

  test("missing json encoding is a validation_error", () => {
    const result = accept({ encodings: ["msgpack"] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reject.code).toBe("validation_error")
  })
})

describe("limits", () => {
  test("a smaller worker limit is preserved", () => {
    const result = accept({ limits: { max_frame_bytes: 4096 } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ready.limits.max_frame_bytes).toBe(4096)
  })

  test("a limit above the candidate default is clamped to it (limits only tighten)", () => {
    const result = accept({ limits: { max_frame_bytes: MAX_FRAME_BYTES_HARD * 4 } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ready.limits.max_frame_bytes).toBe(MAX_FRAME_BYTES)
  })

  test("a non-positive limit is a validation_error", () => {
    const result = accept({ limits: { max_frame_bytes: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reject.code).toBe("validation_error")
  })
})

describe("state machine and reject shape", () => {
  test("a second hello is rejected without overwriting the decision", () => {
    const handshake = new Handshake()
    const first = handshake.acceptHello(hello(), CONTEXT)
    expect(first.ok).toBe(true)

    const second = handshake.acceptHello(hello(), CONTEXT)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reject.code).toBe("validation_error")
    expect(handshake.state).toBe("ready")
    expect(handshake.rejection).toBeUndefined()
  })

  test("nonce mismatch is unauthorized", () => {
    const result = accept({ nonce: "wrong" }, { ...CONTEXT, nonce: "expected" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reject.code).toBe("unauthorized")
  })

  test("every reject carries code, message and details", () => {
    const result = accept({ protocol: { min: 0x0200, max: 0x0200 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reject.code).toBe("unsupported_protocol_version")
    expect(typeof result.reject.message).toBe("string")
    expect(result.reject.message.length).toBeGreaterThan(0)
    expect(result.reject.details).toEqual(expect.any(Object))
  })
})