/**
 * Native-transport loader — finds, loads, and contract-verifies the
 * chimera-transport .node addon, mirroring the codegraph-kernel loader
 * discipline (src/graph/extraction/kernel/loader.ts).
 *
 * The addon is OPTIONAL everywhere: every failure mode (no binary for this
 * platform, dlopen error, ABI/capability mismatch) caches null and the fetch
 * seam keeps using Bun fetch — a missing or stale addon must never break
 * model traffic, only skip the speedup. Set OPENCODE_RUST_TRANSPORT_DEBUG=1
 * to see why an addon didn't load.
 *
 * Negotiation is additive within abiMajor 1: REQUIRED_CAPABILITIES is only the
 * floor, so an older addon without tls/http2/proxy capabilities still loads.
 * Capabilities are consulted at the seam instead — https delegates to the
 * fallback unless the addon advertises "tls", and env proxies delegate unless
 * it advertises "proxy-system".
 *
 * Kill switch: OPENCODE_RUST_TRANSPORT=0 disables the transport entirely
 * (checked per call by resolveFetch so tests and embedders can flip it at
 * runtime; this loader itself does not check it).
 *
 * Search order:
 *   1. OPENCODE_RUST_TRANSPORT_PATH — explicit .node path (dev/testing override)
 *   2. <dir of process.execPath>/transport/chimera-transport.node — the
 *      release bundle layout (.node shipped beside the compiled binary)
 *   3. <repo root>/chimera-transport/prebuilds/<platform>-<arch>/chimera-transport.node
 *      — from-source runs and tests
 */

import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"
import { MINOR_FLOOR, REQUIRED_CAPABILITIES, REQUIRED_MAJOR } from "./layout"
import type { ContractInfo, TransportAddon } from "./layout"

const debugEnabled = () => process.env.OPENCODE_RUST_TRANSPORT_DEBUG === "1"
function debug(msg: string) {
  if (debugEnabled()) process.stderr.write(`[chimera-transport] ${msg}\n`)
}

/** undefined = not attempted yet; null = attempted and unavailable. */
let cached: TransportAddon | null | undefined

/** Repo root from src/provider/sdk/native-transport/ (dev/test runs only —
 *  inside a compiled binary this path doesn't exist and the candidate is skipped). */
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..")

function candidatePaths(): string[] {
  const candidates: string[] = []
  if (process.env.OPENCODE_RUST_TRANSPORT_PATH) candidates.push(process.env.OPENCODE_RUST_TRANSPORT_PATH)
  candidates.push(path.join(path.dirname(process.execPath), "transport", "chimera-transport.node"))
  candidates.push(
    path.join(
      repoRoot,
      "chimera-transport",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "chimera-transport.node",
    ),
  )
  return candidates
}

/**
 * Negotiate the private ABI: same major, minor at or above the floor, and
 * every required capability present. Within major 1 the crate only adds
 * fields, so a newer minor with extra capabilities is accepted unchanged;
 * newer capabilities are optional and gate behavior at the fetch seam.
 */
export function acceptsContract(info: ContractInfo): boolean {
  if (info.abiMajor !== REQUIRED_MAJOR) {
    debug(`ABI major ${info.abiMajor} != required ${REQUIRED_MAJOR} — ignoring addon`)
    return false
  }
  if (info.abiMinor < MINOR_FLOOR) {
    debug(`ABI minor ${info.abiMinor} < floor ${MINOR_FLOOR} — ignoring addon`)
    return false
  }
  const missing = REQUIRED_CAPABILITIES.filter((cap) => !info.capabilities.includes(cap))
  if (missing.length > 0) {
    debug(`missing capabilities '${missing.join("', '")}' — ignoring addon`)
    return false
  }
  return true
}

const EXPECTED_EXPORTS = [
  "contractInfo",
  "startRequest",
  "awaitHeaders",
  "readBody",
  "cancel",
  "release",
  "stats",
] as const

/**
 * Load (once per process) and return the verified addon, or null when
 * unavailable. The kill switch is NOT checked here — resolveFetch and the
 * management plane check it per call.
 */
export function getTransport(): TransportAddon | null {
  if (cached !== undefined) return cached
  cached = null
  for (const candidate of candidatePaths()) {
    try {
      if (!fs.existsSync(candidate)) continue
      // createRequire: works identically from CJS output and future ESM.
      const mod = createRequire(import.meta.url)(candidate) as TransportAddon
      if (EXPECTED_EXPORTS.some((name) => typeof mod[name] !== "function")) {
        debug(`${candidate}: missing expected exports — ignoring`)
        continue
      }
      const info = mod.contractInfo()
      if (!acceptsContract(info)) {
        debug(`${candidate}: contract mismatch (${info.build})`)
        continue
      }
      debug(`loaded ${candidate} (${info.build})`)
      cached = mod
      break
    } catch (err) {
      debug(`${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return cached
}

/** Test hook: forget the loaded module so a changed env is re-evaluated. */
export function resetTransportForTests(): void {
  cached = undefined
}

/** Test hook: install a fake addon directly, bypassing the search/contract
 *  path (the negotiation gate itself is covered through acceptsContract).
 *  Pass null to simulate "attempted and unavailable". */
export function setTransportForTests(mod: TransportAddon | null): void {
  cached = mod
}

export * as NativeTransportLoader from "./loader"