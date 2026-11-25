/**
 * Child process for env-before-start transport surfaces.
 *
 * The crate harvests proxy env and extra CA roots once at module init, so these
 * tests must set the environment BEFORE the process starts. This script starts
 * no server: the parent owns the hermetic target and passes its URL.
 */

import fs from "node:fs"

const index = process.env.CHILD_INDEX
const loaderPath = process.env.CHILD_LOADER
const caPath = process.env.CHILD_CA
const url = process.env.CHILD_URL
if (!index || !loaderPath || !caPath || !url) {
  console.log("CHILD_JSON:" + JSON.stringify({ ok: false, error: "missing child env" }))
  process.exit(0)
}

const { NativeTransport } = await import(index)
const { NativeTransportLoader } = await import(loaderPath)
NativeTransportLoader.resetTransportForTests()

// Two modes:
//   "env" — profile 0 (platform trust + env extra roots); used to prove that
//            an env CA root alone is trusted. No configureTls call.
//   "ca"  — explicit caPem profile (default); used by proxy/fallback tests
//            that need the fixture CA without relying on env roots.
const mode = process.env.CHILD_PROFILE === "env" ? "env" : "ca"
const profile = mode === "ca"
  ? NativeTransport.configureTls({
      caPem: fs.readFileSync(caPath, "utf8"),
      serverName: process.env.CHILD_SERVER_NAME || "localhost",
    })
  : { profileId: 0 }
if (profile === null) {
  console.log("CHILD_JSON:" + JSON.stringify({ ok: false, error: "configureTls returned null" }))
  process.exit(0)
}

const fallback = (async () => new Response("FALLBACK")) as unknown as typeof fetch
const fetchFn = NativeTransport.resolveFetch({ enabled: true, fallback, tlsProfile: profile.profileId })
const before = NativeTransport.stats()

let result: { ok: boolean; status?: number; text?: string; error?: string; cause?: string }
try {
  const response = await fetchFn(url, { method: "POST", body: "ping", headers: { "content-type": "text/plain" } })
  result = { ok: true, status: response.status, text: await response.text() }
} catch (error) {
  const failure = error as Error & { cause?: unknown }
  result = { ok: false, error: failure.message, cause: String(failure.cause) }
}

// Let the network task settle its terminal counters before reading stats.
await Bun.sleep(200)
const after = NativeTransport.stats()
const delta = {
  protocol: (after?.protocolFallbacks ?? 0) - (before?.protocolFallbacks ?? 0),
  route: (after?.routeFallbacks ?? 0) - (before?.routeFallbacks ?? 0),
  postSend: (after?.postSendErrors ?? 0) - (before?.postSendErrors ?? 0),
  cancelled: (after?.cancelledHandles ?? 0) - (before?.cancelledHandles ?? 0),
}
console.log("CHILD_JSON:" + JSON.stringify({ ...result, delta }))
process.exit(0)