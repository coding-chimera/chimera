/**
 * 300 concurrent https SSE streams through the native transport (TLS variant of
 * native-transport-linux300). Linux-only + explicit opt-in:
 *
 *   OPENCODE_RUST_TRANSPORT_HTTPS300=1 bun test test/provider/https300.test.ts
 *
 * Everywhere else every test is skipped. The fixture is a local h2 server on
 * 127.0.0.1; no external network. It verifies that neither the JS adapter nor
 * the addon serializes h2 streams behind a hidden cap, that every stream is
 * intact, and that h2 connection reuse is observable (sessions < streams).
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import os from "node:os"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportFetch } from "@/provider/sdk/native-transport/fetch"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import {
  caProfile,
  clearTransportEnv,
  postInit,
  startH2,
  statsDelta,
  statsNow,
  tlsAddonAvailable,
} from "./fixtures/transport/helpers"

const RUN = process.platform === "linux" && process.env.OPENCODE_RUST_TRANSPORT_HTTPS300 === "1"
const it = RUN ? test : test.skip

const STREAMS = 300
const CHUNKS = 6

let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = clearTransportEnv()
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.resetTransportForTests()
  restoreEnv()
})

function expectedText(id: number) {
  return Array.from({ length: CHUNKS }, (_, index) => `data: {"s":${id},"i":${index}}\n\n`).join("")
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(10)
  }
}

it("300 concurrent h2 https streams complete intact with no hidden cap and observable reuse", async () => {
  if (!tlsAddonAvailable()) throw new Error("OPENCODE_RUST_TRANSPORT_HTTPS300=1 requires a TLS-capable chimera-transport prebuild")

  let active = 0
  let peak = 0
  const server = await startH2({
    handler: (stream) => {
      active += 1
      peak = Math.max(peak, active)
      stream.respond({ ":status": 200, "content-type": "text/event-stream" })
      let index = 0
      const tick = () => {
        if (index >= CHUNKS) {
          active -= 1
          stream.end()
          return
        }
        stream.write(`data: {"s":${Number(stream.id)},"i":${index}}\n\n`)
        index += 1
        setTimeout(tick, 2)
      }
      tick()
    },
  })

  try {
    const profileId = caProfile()
    const fn = NativeTransport.resolveFetch({ enabled: true, fallback: fetch, tlsProfile: profileId })
    if (fn === fetch) throw new Error("resolveFetch returned the Bun fallback despite a loaded addon")
    const fallbackBefore = NativeTransportFetch.preSendFallbackCount()
    const before = statsNow()
    const started = performance.now()

    const outcomes = await Promise.allSettled(
      Array.from({ length: STREAMS }, (_, id) => fn(server.url(`/${id}`), postInit("{}")).then((response) => response.text())),
    )
    const wallMs = performance.now() - started

    const rejected = outcomes.filter((outcome) => outcome.status === "rejected")
    expect(rejected).toEqual([])
    outcomes.forEach((outcome, id) => {
      expect(outcome.status).toBe("fulfilled")
      if (outcome.status === "fulfilled") expect(outcome.value).toBe(expectedText(id))
    })

    // Every stream was simultaneously in flight: no 64/256-style cap anywhere.
    expect(peak).toBe(STREAMS)
    expect(server.alpn.length).toBeGreaterThan(0)
    expect(server.alpn.every((protocol) => protocol === "h2")).toBe(true)
    // h2 multiplexing/reuse: far fewer TLS sessions than logical streams.
    expect(server.sessions()).toBeLessThan(STREAMS)
    expect(NativeTransportFetch.preSendFallbackCount() - fallbackBefore).toBe(0)

    const delta = statsDelta(before, statsNow())
    expect(delta.protocol).toBe(0)
    expect(delta.route).toBe(0)
    expect(delta.postSend).toBe(0)

    // A final request proves every handle/permit was released.
    const probe = await fn(server.url(`/${STREAMS}`), postInit("{}"))
    expect(probe.status).toBe(200)
    await probe.text()
    await waitFor(() => NativeTransport.stats()?.activeHandles === 0)

    console.log(
      `[native-transport-https300] ${JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
        workerThreads: NativeTransport.stats()?.workerThreads,
        parallel: os.availableParallelism(),
        wallMs: Number(wallMs.toFixed(1)),
        peakStreams: peak,
        sessions: server.sessions(),
        stats: NativeTransport.stats(),
      })}`,
    )
  } finally {
    server.close()
  }
})