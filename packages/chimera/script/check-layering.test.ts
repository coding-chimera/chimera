import { afterAll, describe, expect, test as bunTest } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Each fixture spawns the real gate (a fresh Bun process building a small TS program), which can
// exceed Bun's 5s default per-test budget on a cold start; give every case a generous timeout.
const test = (name: string, fn: () => void) => bunTest(name, fn, 30_000)

// Each fixture builds a two-file directory: `a.ts` carries the edge under test (an import/export
// from "./b"), and `b.ts` carries a plain side-effect import of "./a". The side-effect edge is
// always a value edge, so a counted `a -> b` edge closes a cycle (file-SCC = 2) and an excluded
// type-only edge leaves two acyclic files (file-SCC = 1). We run the real gate binary against the
// fixture root, so the assertion covers the shipped classification path end to end.
const SCRIPT = join(import.meta.dir, "check-layering.ts")
const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function runFixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "layering-fixture-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", SCRIPT, `--root=${dir}`, "--max-file-scc=1", "--max-module-scc=1"],
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = proc.stdout.toString()
  const fileScc = Number(out.match(/file-level: max SCC = (\d+)/)?.[1])
  const moduleScc = Number(out.match(/module-level: max SCC = (\d+)/)?.[1])
  return { exitCode: proc.exitCode, out, fileScc, moduleScc }
}

describe("check-layering type-edge classification", () => {
  test("baseline: a value import is counted (fixture harness closes a cycle)", () => {
    const r = runFixture({
      "a.ts": `import { A } from "./b"\nexport const y = A\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(r.fileScc).toBe(2)
    expect(r.exitCode).toBe(1)
  })

  test("(1) whole `import type` is excluded", () => {
    const r = runFixture({
      "a.ts": `import type { A } from "./b"\nexport const y = 1\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(r.fileScc).toBe(1)
    expect(r.moduleScc).toBe(1)
    expect(r.exitCode).toBe(0)
  })

  test("(2) multi-line `import type { ... } from` is excluded", () => {
    const r = runFixture({
      "a.ts": `import type {\n  A,\n  B,\n} from "./b"\nexport const y = 1\n`,
      "b.ts": `import "./a"\nexport const A = 1\nexport const B = 2\n`,
    })
    expect(r.fileScc).toBe(1)
    expect(r.exitCode).toBe(0)
  })

  test("(3) mixed `import { A, type B }` with a value use of A is counted", () => {
    const r = runFixture({
      "a.ts": `import { A, type B } from "./b"\nexport const y = A\n`,
      "b.ts": `import "./a"\nexport const A = 1\nexport type B = number\n`,
    })
    expect(r.fileScc).toBe(2)
    expect(r.exitCode).toBe(1)
  })

  test("(3b) mixed `import { A, type B }` where A is only a type use is excluded", () => {
    const r = runFixture({
      "a.ts": `import { A, type B } from "./b"\nexport type Y = A\nexport type Z = B\n`,
      "b.ts": `import "./a"\nexport type A = number\nexport type B = number\n`,
    })
    expect(r.fileScc).toBe(1)
    expect(r.exitCode).toBe(0)
  })

  test("(4) namespace value access NS.member is counted", () => {
    const r = runFixture({
      "a.ts": `import * as NS from "./b"\nexport const z = NS.A\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(r.fileScc).toBe(2)
    expect(r.exitCode).toBe(1)
  })

  test("(5) instanceof / new / Schema runtime value are counted", () => {
    const r = runFixture({
      "a.ts": [
        `import { A, B, SessionID } from "./b"`,
        `import { Schema } from "effect"`,
        `export const z = new A()`,
        `export const w = B instanceof A`,
        `export const s = Schema.Struct({ f: SessionID })`,
        ``,
      ].join("\n"),
      "b.ts": `import "./a"\nexport class A {}\nexport const B = 1\nexport const SessionID = 2\n`,
    })
    expect(r.fileScc).toBe(2)
    expect(r.exitCode).toBe(1)
  })

  test("(6) `export type { ... } from` is excluded", () => {
    const r = runFixture({
      "a.ts": `export type { A } from "./b"\nexport const y = 1\n`,
      "b.ts": `import "./a"\nexport type A = number\n`,
    })
    expect(r.fileScc).toBe(1)
    expect(r.exitCode).toBe(0)
  })

  test("(6b) a plain import whose bindings are never used is kept (dead code, not a type edge)", () => {
    const r = runFixture({
      "a.ts": `import { A } from "./b"\nexport const y = 1\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(r.fileScc).toBe(2)
    expect(r.exitCode).toBe(1)
  })
  test("(7) dynamic import() and require stay counted even for a type-only target", () => {
    const dynamic = runFixture({
      "a.ts": `export const load = () => import("./b")\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(dynamic.fileScc).toBe(2)
    expect(dynamic.exitCode).toBe(1)

    const required = runFixture({
      "a.ts": `export const load = () => require("./b")\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(required.fileScc).toBe(2)
    expect(required.exitCode).toBe(1)
  })

  test("(8) transparent type-edge statistic is reported", () => {
    const r = runFixture({
      "a.ts": `import type { A } from "./b"\nexport const y = 1\n`,
      "b.ts": `import "./a"\nexport const A = 1\n`,
    })
    expect(r.out).toContain("type-only edges excluded from ring edges: 1 (import/export type 1,")
  })
})