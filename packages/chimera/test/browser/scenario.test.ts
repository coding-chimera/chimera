import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BrowserArtifact } from "../../src/browser/artifact"
import { BrowserRuntime } from "../../src/browser/runtime"
import { BrowserScenario } from "../../src/browser/scenario"

function snapshot(
  generation: number,
  text: string,
  refs: ReadonlyMap<string, { id: string; role: string; name?: string; nth?: number }>,
): BrowserRuntime.SnapshotResult {
  return {
    text: `[UNTRUSTED BROWSER CONTENT]\n${text}`,
    refs,
    truncated: false,
    omittedLines: 0,
    trust: {
      source: "browser",
      untrusted: true,
      url: "https://example.com/app",
      origin: "https://example.com",
    },
    tabID: "tab-1",
    generation,
    title: "Scenario",
  }
}

function makeArtifacts() {
  const data = new Map<string, Uint8Array | string>()
  const writes: BrowserArtifact.WriteInput[] = []
  const service: BrowserArtifact.Interface = {
    runtimeDirectory: Effect.succeed("/runtime"),
    sessionDirectory: () => Effect.succeed("/artifacts"),
    write: (input) =>
      Effect.sync(() => {
        writes.push(input)
        const filename = `${writes.length}-${input.name ?? input.kind}.${input.extension}`
        const artifact = {
          kind: input.kind,
          path: `/artifacts/${filename}`,
          filename,
          mime: input.mime,
        } satisfies BrowserArtifact.Artifact
        data.set(artifact.path, input.data)
        return artifact
      }),
    read: (artifact) =>
      Effect.sync(() => {
        const value = data.get(artifact.path)
        if (typeof value === "string") return new TextEncoder().encode(value)
        return value ?? new Uint8Array()
      }),
    attachment: (artifact) =>
      Effect.succeed({
        type: "file",
        mime: artifact.mime,
        filename: artifact.filename,
        url: `data:${artifact.mime};base64,ZmFrZQ==`,
      }),
  }
  return { service, data, writes }
}

function makeRuntime(options: {
  snapshots?: BrowserRuntime.SnapshotResult[]
  open?: BrowserRuntime.Interface["open"]
} = {}) {
  const calls = {
    open: [] as BrowserRuntime.OpenInput[],
    click: [] as BrowserRuntime.RefInput[],
    type: [] as Array<BrowserRuntime.RefInput & { readonly text: string }>,
    snapshotInputs: [] as Array<Parameters<BrowserRuntime.Interface["snapshot"]>[0]>,
    screenshots: 0,
    closes: 0,
    snapshots: 0,
    closed: false,
  }
  const snapshots =
    options.snapshots ??
    [snapshot(1, 'button "Continue" [ref=g1e1]', new Map([["g1e1", { id: "#continue", role: "button", name: "Continue" }]]))]
  const service: BrowserRuntime.Interface = {
    open:
      options.open ??
      ((input) =>
        Effect.sync(() => {
          calls.closed = false
          calls.open.push(input)
          return {
            id: "tab-1",
            sessionID: input.sessionID,
            url: input.url ?? "about:blank",
            title: "Scenario",
            current: true,
          }
        })),
    tabs: (sessionID) =>
      Effect.succeed([
        {
          id: "tab-1",
          sessionID,
          url: calls.open.at(-1)?.url ?? "https://example.com/app",
          title: "Scenario",
          current: true,
        },
      ]),
    select: () => Effect.void,
    snapshot: (input) => {
      if (calls.closed)
        return Effect.fail(new BrowserRuntime.RuntimeError({ operation: "snapshot", message: "Browser session is closed" }))
      return Effect.sync(() => {
        const value = snapshots[Math.min(calls.snapshots, snapshots.length - 1)]!
        calls.snapshotInputs.push(input)
        calls.snapshots += 1
        return value
      })
    },
    click: (input) =>
      Effect.sync(() => {
        calls.click.push(input)
      }),
    type: (input) =>
      Effect.sync(() => {
        calls.type.push(input)
      }),
    screenshot: () => {
      if (calls.closed)
        return Effect.fail(new BrowserRuntime.RuntimeError({ operation: "screenshot", message: "Browser session is closed" }))
      return Effect.sync(() => {
        calls.screenshots += 1
        return {
          artifact: {
            kind: "screenshot",
            path: `/artifacts/runtime-${calls.screenshots}.png`,
            filename: `runtime-${calls.screenshots}.png`,
            mime: "image/png",
          },
          attachment: {
            type: "file",
            mime: "image/png",
            filename: `runtime-${calls.screenshots}.png`,
            url: "data:image/png;base64,cG5n",
          },
        }
      })
    },
    closeTab: () => Effect.void,
    closeSession: () =>
      Effect.sync(() => {
        calls.closes += 1
        calls.closed = true
      }),
  }
  return { service, calls }
}

function run(
  scenario: BrowserScenario.Scenario,
  runtime: BrowserRuntime.Interface,
  artifacts: BrowserArtifact.Interface,
) {
  return BrowserScenario.run({ scenario, sessionID: "scenario-test" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(BrowserRuntime.Service, runtime),
        Layer.succeed(BrowserArtifact.Service, artifacts),
      ),
    ),
    Effect.runPromise,
  )
}

describe("browser scenario", () => {
  test("runs semantic steps and writes JSON plus JUnit artifacts", async () => {
    const runtime = makeRuntime({
      snapshots: [
        snapshot(
          1,
          'text "Ready"\nbutton "Continue" [ref=g1e1]',
          new Map([["g1e1", { id: "#continue", role: "button", name: "Continue" }]]),
        ),
        snapshot(
          2,
          'textbox "Email" [ref=g2e1]',
          new Map([["g2e1", { id: "#email", role: "textbox", name: "Email" }]]),
        ),
      ],
    })
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "Scenario & smoke",
        baseUrl: "https://example.com/base/",
        steps: [
          { type: "open", url: "/app" },
          { type: "snapshot" },
          { type: "assert", assertion: { type: "text", includes: "Ready" } },
          { type: "click", target: { role: "button", name: "Continue" } },
          { type: "snapshot" },
          { type: "type", target: { role: "textbox", name: "Email" }, text: "user@example.com" },
          { type: "assert", assertion: { type: "url", includes: "/app" } },
          { type: "screenshot", name: "success", fullPage: true },
          { type: "close" },
        ],
      },
      runtime.service,
      artifacts.service,
    )

    expect(output.result.status).toBe("passed")
    expect(output.result.steps).toHaveLength(9)
    expect(runtime.calls.open[0]?.url).toBe("https://example.com/app")
    expect(runtime.calls.click[0]?.ref).toBe("g1e1")
    expect(runtime.calls.type[0]?.ref).toBe("g2e1")
    expect(runtime.calls.type[0]?.text).toBe("user@example.com")
    expect(runtime.calls.closes).toBeGreaterThanOrEqual(1)
    expect(output.result.artifacts.map((artifact) => artifact.kind)).toEqual(["screenshot"])
    expect(output.json.mime).toBe("application/json")
    expect(output.junit.mime).toBe("application/xml")
    expect(artifacts.data.get(output.junit.path)).toContain('name="Scenario &amp; smoke"')
  })

  test("waits for semantic assertions with fresh snapshots", async () => {
    const runtime = makeRuntime({
      snapshots: [
        snapshot(1, 'text "Loading"', new Map()),
        snapshot(
          2,
          'button "Continue" [ref=g2e1]',
          new Map([["g2e1", { id: "#continue", role: "button", name: "Continue" }]]),
        ),
      ],
    })
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "semantic wait",
        steps: [
          { type: "open", url: "https://example.com/app" },
          {
            type: "wait",
            assertion: { type: "interactable", target: { role: "button", name: "Continue" } },
            timeout: 100,
            interval: 1,
            options: { preset: "efficient", maxChars: 321 },
          },
          { type: "click", target: { role: "button", name: "Continue" } },
        ],
      },
      runtime.service,
      artifacts.service,
    )

    expect(output.result.status).toBe("passed")
    expect(output.result.steps[1]?.type).toBe("wait")
    expect(runtime.calls.snapshots).toBe(2)
    expect(runtime.calls.snapshotInputs.map((input) => input.options)).toEqual([
      { preset: "efficient", maxChars: 321 },
      { preset: "efficient", maxChars: 321 },
    ])
    expect(runtime.calls.click[0]?.ref).toBe("g2e1")
  })

  test("fails semantic waits with the last assertion error and captures diagnostics", async () => {
    const runtime = makeRuntime({ snapshots: [snapshot(1, 'text "Loading"', new Map())] })
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "semantic wait timeout",
        steps: [
          { type: "open", url: "https://example.com/app" },
          {
            type: "wait",
            assertion: { type: "text", includes: "Ready" },
            timeout: 20,
            interval: 1,
            options: { maxChars: 123 },
          },
        ],
      },
      runtime.service,
      artifacts.service,
    )

    expect(output.result.status).toBe("failed")
    expect(output.result.error).toEqual({
      stepIndex: 1,
      stepType: "wait",
      message: 'Snapshot does not include "Ready"',
    })
    expect(runtime.calls.snapshotInputs[0]?.options).toEqual({ maxChars: 123 })
    expect(runtime.calls.snapshotInputs.at(-1)?.options).toEqual({ preset: "efficient" })
    expect(runtime.calls.snapshots).toBeGreaterThanOrEqual(2)
    expect(runtime.calls.screenshots).toBe(1)
    expect(runtime.calls.closes).toBeGreaterThanOrEqual(1)
  })

  test("rejects semantic target reuse after an action and captures failure artifacts", async () => {
    const runtime = makeRuntime()
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "stale target",
        steps: [
          { type: "open", url: "https://example.com/app" },
          { type: "snapshot" },
          { type: "click", target: { role: "button", name: "Continue" } },
          { type: "assert", assertion: { type: "interactable", target: { role: "button", name: "Continue" } } },
        ],
      },
      runtime.service,
      artifacts.service,
    )

    expect(output.result.status).toBe("failed")
    expect(output.result.error?.stepIndex).toBe(3)
    expect(output.result.error?.message).toContain("Take a new snapshot")
    expect(output.result.artifacts.map((artifact) => artifact.kind)).toEqual(["snapshot", "screenshot"])
    expect(runtime.calls.snapshots).toBe(2)
    expect(runtime.calls.screenshots).toBe(1)
    expect(runtime.calls.closes).toBeGreaterThanOrEqual(1)
  })

  test("escapes assertion failures in JUnit output", async () => {
    const runtime = makeRuntime()
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "failure <case>",
        steps: [
          { type: "open", url: "https://example.com/app" },
          { type: "snapshot" },
          { type: "assert", assertion: { type: "text", includes: "missing & <tag>" } },
        ],
      },
      runtime.service,
      artifacts.service,
    )
    const xml = artifacts.data.get(output.junit.path)

    expect(output.result.status).toBe("failed")
    expect(xml).toContain("failure &lt;case&gt;")
    expect(xml).toContain("missing &amp; &lt;tag&gt;")
    expect(xml).toContain("<failure")
  })

  test("times out and still closes the browser session", async () => {
    const runtime = makeRuntime({ open: () => Effect.never })
    const artifacts = makeArtifacts()
    const output = await run(
      {
        name: "timeout",
        timeout: 5,
        steps: [{ type: "open", url: "https://example.com/app" }],
      },
      runtime.service,
      artifacts.service,
    )

    expect(output.result.status).toBe("failed")
    expect(output.result.error?.message).toBe("Scenario timed out after 5ms")
    expect(output.result.steps[0]?.type).toBe("open")
    expect(runtime.calls.closes).toBe(1)
  })

  test("decodes valid scenarios and rejects unknown steps", async () => {
    const decoded = await Effect.runPromise(
      BrowserScenario.decode({ name: "decode", steps: [{ type: "close" }] }),
    )
    expect(decoded.steps[0]?.type).toBe("close")

    await expect(
      Effect.runPromise(BrowserScenario.decode({ name: "decode", steps: [{ type: "unknown" }] })),
    ).rejects.toBeInstanceOf(BrowserScenario.ParseError)
  })
})
