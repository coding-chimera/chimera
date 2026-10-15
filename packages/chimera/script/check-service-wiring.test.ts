import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Each fixture spawns the real gate against a small temp src root, so the assertion covers
// the shipped tokenizer path (string/comment masking, brace-depth nesting, provide-chain
// search, pragma waiver) end to end.
const SCRIPT = join(import.meta.dir, "check-service-wiring.ts")
const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function runFixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "service-wiring-fixture-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", SCRIPT, `--root=${dir}`],
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

const LAYER_BODY = (capture: string, pragma = "") =>
  [
    `import { Context, Effect, Layer } from "effect"`,
    `export class Other extends Context.Service<Other, { id: string }>()("fixture/Other") {}`,
    `export class Service extends Context.Service<Service, { ok: boolean }>()("fixture/Service") {}`,
    `export const layer = Layer.effect(`,
    `  Service,`,
    `  Effect.gen(function* () {`,
    pragma,
    `    ${capture}`,
    `    return { ok: true }`,
    `  }),`,
    `)`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n")

describe("check-service-wiring construction-time serviceOption gate", () => {
  test("construction-time capture without a same-file provide is gated", () => {
    const r = runFixture({ "a.ts": LAYER_BODY(`const other = yield* Effect.serviceOption(Other.Service)`) })
    expect(r.exitCode).toBe(1)
    expect(r.err).toContain("service-wiring gate FAILED")
    expect(r.err).toContain("a.ts:7 serviceOption(Other.Service)")
    expect(r.err).toContain("Layer.provide(Other.defaultLayer)")
  })

  test("wrapped capture form (Option.getOrUndefined(yield* serviceOption(...))) is also gated", () => {
    const r = runFixture({
      "a.ts": LAYER_BODY(`const other = Option.getOrUndefined(yield* Effect.serviceOption(Other.Service))`),
    })
    expect(r.exitCode).toBe(1)
    expect(r.err).toContain("serviceOption(Other.Service)")
  })

  test("pragma on the line above waives the capture and is reported", () => {
    const r = runFixture({
      "a.ts": LAYER_BODY(
        `const other = yield* Effect.serviceOption(Other.Service)`,
        `    // service-wiring: optional degrades by design when Other is absent`,
      ),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("waived: a.ts:8 serviceOption(Other.Service) — pragma: degrades by design when Other is absent")
    expect(r.out).toContain("service-wiring gate PASS")
  })

  test("same-file provide chain (Layer.provide(Other.defaultLayer)) passes the gate", () => {
    const r = runFixture({
      "a.ts": [
        LAYER_BODY(`const other = yield* Effect.serviceOption(Other.Service)`),
        `export const defaultLayer = layer.pipe(`,
        `  Layer.provide(Other.defaultLayer),`,
        `)`,
        ``,
      ].join("\n"),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("provided: a.ts:7 serviceOption(Other.Service)")
    expect(r.out).toContain("service-wiring gate PASS")
  })

  test("provide nested inside Layer.mergeAll counts as provided", () => {
    const r = runFixture({
      "a.ts": [
        LAYER_BODY(`const other = yield* Effect.serviceOption(Other.Service)`),
        `export const defaultLayer = layer.pipe(`,
        `  Layer.provide(Layer.mergeAll(Other.defaultLayer)),`,
        `)`,
        ``,
      ].join("\n"),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("provided: a.ts:7 serviceOption(Other.Service)")
  })

  test("serviceOption inside a nested closure is runtime-safe and not flagged", () => {
    const r = runFixture({
      "a.ts": [
        `import { Context, Effect, Layer } from "effect"`,
        `export class Other extends Context.Service<Other, { id: string }>()("fixture/Other") {}`,
        `export class Service extends Context.Service<Service, { run: () => Effect.Effect<unknown> }>()("fixture/Service") {}`,
        `export const layer = Layer.effect(`,
        `  Service,`,
        `  Effect.gen(function* () {`,
        `    const run = Effect.fn("fixture.run")(function* () {`,
        `      return yield* Effect.serviceOption(Other.Service)`,
        `    })`,
        `    return { run }`,
        `  }),`,
        `)`,
        ``,
      ].join("\n"),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("construction-time serviceOption captures: 0")
    expect(r.out).toContain("service-wiring gate PASS")
  })

  test("serviceOption outside any Layer constructor (plain Effect.gen) is not flagged", () => {
    const r = runFixture({
      "a.ts": [
        `import { Context, Effect } from "effect"`,
        `export class Other extends Context.Service<Other, { id: string }>()("fixture/Other") {}`,
        `export const register = Effect.gen(function* () {`,
        `  const other = yield* Effect.serviceOption(Other.Service)`,
        `  return other`,
        `})`,
        ``,
      ].join("\n"),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("construction-time serviceOption captures: 0")
  })

  test("serviceOption mentions inside strings and comments are not counted", () => {
    const r = runFixture({
      "a.ts": [
        LAYER_BODY(`const note = "Effect.serviceOption(Other.Service) in a string" // and in a comment`),
        ``,
      ].join("\n"),
    })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain("construction-time serviceOption captures: 0")
  })
})
