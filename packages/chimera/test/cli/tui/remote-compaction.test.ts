import { describe, expect, test } from "bun:test"
import type { RemoteCompactionResolution } from "@opencode-ai/sdk/v2"

const {
  nextRemoteCompactionMode,
  nextRemoteCompactionProtocol,
  remoteCompactionCredential,
  remoteCompactionDescription,
  remoteCompactionLock,
  remoteCompactionModeDescription,
  remoteCompactionModePatch,
  remoteCompactionModeTitle,
  remoteCompactionModelChangeBlocked,
  remoteCompactionModelLockMessage,
  remoteCompactionProtocolDescription,
  remoteCompactionProtocolPatch,
  remoteCompactionProtocolTitle,
  remoteCompactionProtocols,
  remoteCompactionReason,
  remoteCompactionReplay,
  remoteCompactionSummary,
  remoteCompactionTarget,
} = await import("../../../src/cli/cmd/tui/util/remote-compaction")

const ready = {
  configured: { mode: "auto", protocol: "auto" },
  requested: { providerID: "third-party", modelID: "logical-model" },
  effective: { providerID: "third-party", modelID: "logical-model", wireModelID: "wire-model" },
  mode: "remote",
  target: "provider",
  profile: "codex-responses",
  driver: "codex-responses",
  credential: "provider-bearer",
  protocols: ["legacy", "v2"],
  localFallback: true,
  reason: "ready",
  binding: {
    providerID: "third-party",
    modelID: "logical-model",
    wireModelID: "wire-model",
    driver: "codex-responses",
    format: "responses_compaction_v1",
    wire_api: "responses",
    compatibility_key: "safe-binding",
  },
  lock: { status: "none" },
  replay: { mode: "none", reason: "no_lock" },
} satisfies RemoteCompactionResolution

const routeMismatch = {
  ...ready,
  mode: "local",
  target: "local",
  reason: "routing_identity_unsafe",
  credential: "configured",
  protocols: [],
  lock: {
    status: "route_mismatch",
    endpoint: "provider",
    providerID: "third-party",
    modelID: "logical-model",
  },
  replay: { mode: "full_history", reason: "binding_mismatch" },
} satisfies RemoteCompactionResolution

const blocked = {
  ...ready,
  mode: "local",
  target: "local",
  reason: "model_disabled",
  credential: "unavailable",
  protocols: [],
  lock: {
    status: "model_mismatch",
    endpoint: "provider",
    providerID: "third-party",
    modelID: "logical-model",
  },
  replay: { mode: "blocked", reason: "model_mismatch" },
} satisfies RemoteCompactionResolution

describe("TUI remote compaction helpers", () => {
  test("cycles only user-configured mode and protocol fields", () => {
    expect((["auto", "on", "off"] as const).map(nextRemoteCompactionMode)).toEqual(["on", "off", "auto"])
    expect((["auto", "v2", "legacy"] as const).map(nextRemoteCompactionProtocol)).toEqual(["v2", "legacy", "auto"])
    expect(remoteCompactionModePatch(ready)).toEqual({ remote: "on" })
    expect(remoteCompactionProtocolPatch(ready)).toEqual({ remote_protocol: "v2" })
    expect(remoteCompactionModeTitle(ready)).toBe("Remote compaction mode: auto (switch to on)")
    expect(remoteCompactionProtocolTitle(ready)).toBe("Remote compaction protocol: auto (switch to v2)")
  })

  test("formats provider-neutral authoritative production state", () => {
    expect(remoteCompactionTarget(ready)).toBe("provider third-party/logical-model")
    expect(remoteCompactionCredential(ready)).toBe("provider bearer")
    expect(remoteCompactionProtocols(ready)).toBe("legacy → v2")
    expect(remoteCompactionReason(ready)).toBe("ready")
    expect(remoteCompactionReplay(ready)).toBe("none (no installed state)")
    expect(remoteCompactionLock(ready)).toBe("none")
    expect(remoteCompactionSummary(ready)).toBe(
      "remote · provider third-party/logical-model · protocol legacy → v2 · credential provider bearer · replay none · lock none · local fallback",
    )
    expect(remoteCompactionModeDescription(ready)).toContain("provider third-party/logical-model")
    expect(remoteCompactionProtocolDescription(ready)).toContain("authoritative attempt order legacy → v2")
  })

  test("presents full-history route mismatch without treating it as a model lock", () => {
    expect(remoteCompactionReplay(routeMismatch)).toBe("full_history (route binding changed)")
    expect(remoteCompactionLock(routeMismatch)).toBe("route_mismatch third-party/logical-model")
    expect(remoteCompactionDescription(routeMismatch)).toContain("local fallback available")
    expect(remoteCompactionModelChangeBlocked(routeMismatch)).toBe(false)
  })

  test("blocks only authoritative replay/model lock mismatches", () => {
    expect(remoteCompactionModelChangeBlocked(ready)).toBe(false)
    expect(remoteCompactionModelChangeBlocked(blocked)).toBe(true)
    expect(remoteCompactionModelLockMessage(blocked)).toContain("blocked (provider/model mismatch)")
  })
})
