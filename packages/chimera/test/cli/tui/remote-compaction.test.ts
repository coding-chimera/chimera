import { describe, expect, test } from "bun:test"
import type { CompactionPart, RemoteCompactionResolution } from "@opencode-ai/sdk/v2"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent, onMount } from "solid-js"
import { ToastProvider, useToast } from "../../../src/cli/cmd/tui/ui/toast"

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
  remoteCompactionShortAlert,
  remoteCompactionSummary,
  remoteCompactionTarget,
  reportRemoteCompactionFailure,
} = await import("../../../src/cli/cmd/tui/util/remote-compaction")
const { CompactionDivider } = await import("../../../src/cli/cmd/tui/routes/session/index")

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

  test("short alert hides normal local state, shows remote and blocked", () => {
    expect(remoteCompactionShortAlert(ready)).toBe("✓ remote")
    expect(remoteCompactionShortAlert(routeMismatch)).toBeUndefined()
    expect(remoteCompactionShortAlert(blocked)).toBe("⚠ blocked (provider/model mismatch)")
  })

  test("reports summarize failures and stays silent on success", async () => {
    const reported: string[] = []

    await reportRemoteCompactionFailure(Promise.resolve({ data: true, error: undefined }), (message) =>
      reported.push(message),
    )
    expect(reported).toEqual([])

    await reportRemoteCompactionFailure(
      Promise.resolve({ error: { name: "UnknownError", data: { message: "remote compaction timed out" } } }),
      (message) => reported.push(message),
    )
    expect(reported).toEqual(["remote compaction timed out"])
  })

  test("sanitizes stack traces, URLs, and credentials from summarize failures", async () => {
    const reported: string[] = []

    await reportRemoteCompactionFailure(
      Promise.reject(
        new Error(
          "remote compaction failed at https://user:secret@example.test/v1?api_key=sk-secret12345678\n    at handler (server.ts:1:1)",
        ),
      ),
      (message) => reported.push(message),
    )
    await reportRemoteCompactionFailure(
      Promise.resolve({
        error: {
          name: "UnknownError",
          data: { message: "upstream 500 authorization: Bearer topsecret token=abc123 password=hunter2" },
        },
      }),
      (message) => reported.push(message),
    )
    await reportRemoteCompactionFailure(
      Promise.resolve({
        error: { name: "UnknownError", data: { message: "Error: upstream 500\n    at handler (server.ts:1:1)" } },
      }),
      (message) => reported.push(message),
    )

    expect(reported).toEqual([
      "remote compaction failed at [redacted url]",
      "upstream 500 authorization: [redacted] token=[redacted] password=[redacted]",
      "Error: upstream 500",
    ])
  })

  test("falls back to a generic message for empty or unknown failures", async () => {
    const reported: string[] = []

    await reportRemoteCompactionFailure(Promise.resolve({ error: {} }), (message) => reported.push(message))
    await reportRemoteCompactionFailure(Promise.resolve({ error: "" }), (message) => reported.push(message))
    await reportRemoteCompactionFailure(Promise.reject(undefined), (message) => reported.push(message))

    expect(reported).toEqual(["unknown error", "unknown error", "unknown error"])
  })

  test("renders a sanitized summarize failure through the existing toast", async () => {
    let toast: ReturnType<typeof useToast> | undefined

    const Probe = () => {
      const value = useToast()
      toast = value
      onMount(() => {
        void reportRemoteCompactionFailure(
          Promise.reject(new Error("summarize failed at https://user:secret@example.test/v1?token=abc")),
          (message) => value.show({ variant: "error", message: `Compaction failed: ${message}`, duration: 5000 }),
        )
      })
      return null
    }

    const app = await testRender(() =>
      createComponent(ToastProvider, {
        get children() {
          return createComponent(Probe, {})
        },
      }),
    )

    try {
      const waitForToast = async () => {
        const start = Date.now()
        while (Date.now() - start <= 2000) {
          if (toast?.currentToast) return
          await Bun.sleep(10)
        }
        throw new Error("timed out waiting for toast")
      }
      await waitForToast()
      expect(toast?.currentToast).toMatchObject({
        variant: "error",
        message: "Compaction failed: summarize failed at [redacted url]",
      })
    } finally {
      app.renderer.destroy()
    }
  })

  const compactionPart = (remote_error?: CompactionPart["remote_error"]): CompactionPart => ({
    id: "prt_compaction",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "compaction",
    auto: false,
    ...(remote_error ? { remote_error } : {}),
  })

  test("renders remote compaction failure and local fallback from the compaction part", async () => {
    const app = await testRender(() =>
      createComponent(CompactionDivider, {
        part: compactionPart({
          providerID: "third-party",
          endpoint: "provider",
          implementation: "responses_compact",
          modelID: "logical-model",
          wireModelID: "wire-model",
          message: "upstream 500 token=secret-value",
          status: 500,
          retryable: true,
          time: 1,
        }),
        borderColor: RGBA.fromInts(255, 255, 255),
        errorColor: RGBA.fromInts(255, 0, 0),
        mutedColor: RGBA.fromInts(128, 128, 128),
      }),
    )

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Compaction")
      expect(frame).toContain("Remote compaction failed")
      expect(frame).toContain("upstream 500")
      expect(frame).toContain("Falling back to local compaction")
      expect(frame).not.toContain("secret-value")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the compaction divider without a failure notice for a successful part", async () => {
    const app = await testRender(() =>
      createComponent(CompactionDivider, {
        part: compactionPart(),
        borderColor: RGBA.fromInts(255, 255, 255),
        errorColor: RGBA.fromInts(255, 0, 0),
        mutedColor: RGBA.fromInts(128, 128, 128),
      }),
    )

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Compaction")
      expect(frame).not.toContain("Remote compaction failed")
      expect(frame).not.toContain("Falling back to local compaction")
    } finally {
      app.renderer.destroy()
    }
  })
})
