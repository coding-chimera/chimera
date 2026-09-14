// Chimera tool-burst benchmark harness.
//
// Measures how the runtime digests N tool calls emitted instantly in one
// assistant turn (DeepSeek-flash style): an in-process TestLLMServer streams
// a single SSE response whose delta.tool_calls carry DISTINCT indexes, the
// full prompt stack runs against a throwaway tmp project, and a sampler
// plugin records per-call wall timestamps that are stitched to the persisted
// tool-part state (state.time.start / state.time.end).
//
// Run from packages/chimera:
//   bun run script/bench/burst.ts [--sizes 1,5,10,25,50] [--scenario s1,s2,s3]
//     [--rounds 10] [--repeat 3] [--timeout 60] [--out results.json]
//
// Scenarios:
//   s1 one response with N parallel glob calls, varied patterns
//   s2 N calls round-robin glob/grep/read, varied args
//   s3 K rounds x 5 mixed calls in one loop (K queued bursts, auto-"ok" ends)
//   s4 N write calls creating N new files (opt-in; may self-skip if the
//      mutation predesign gate blocks writes in an uninitialized-graph tmpdir)
import "./env"

import path from "path"
import { Cause, Duration, Effect, Exit, Logger, Option } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { initProjectors } from "../../src/server/projectors"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { makePromptHarness, testProviderConfig } from "../../test/fixture/prompt-harness"
import { provideTmpdirServer } from "../../test/fixture/fixture"
import { TestLLMServer, type Item } from "../../test/lib/llm-server"
import { burst, type Call } from "./sse"
import { aggregate, median, medianAgg, type Agg, type RunResult, type Scenario } from "./metrics"

void Log.init({ print: false, dev: true, level: "INFO" })
initProjectors()

const DIR_COUNT = 8
const FILE_COUNT = 10
const SCENARIOS: Scenario[] = ["s1", "s2", "s3", "s4"]

type BeforeSample = { callID: string; tool: string; t0: number }
type AfterSample = { callID: string; t1: number }

type CellSpec = {
  scenario: Scenario
  label: string
  planned: number
  build: (dir: string) => Item[]
}

function readBucket<T>(key: string): T[] {
  return ((globalThis as Record<string, unknown>)[key] as T[] | undefined) ?? []
}

function resetSampler() {
  const store = globalThis as Record<string, unknown>
  store.__benchBefore = []
  store.__benchAfter = []
  store.__benchEvents = {}
}

function readEvents(): Record<string, number> {
  return ((globalThis as Record<string, unknown>).__benchEvents as Record<string, number> | undefined) ?? {}
}

// Pre-create the known file tree: 8 dirs x 10 small .txt files, each carrying
// a unique `tok_<dir>_<file>` marker for grep, plus an empty gen/ target dir.
// Also drop the sampler plugin into the auto-discovered project plugin dir.
async function prepareProject(dir: string, samplerSource: string) {
  await Promise.all([
    Bun.write(path.join(dir, ".chimera", "plugin", "bench-sampler.ts"), samplerSource),
    Bun.write(path.join(dir, "gen", ".keep"), ""),
    ...Array.from({ length: DIR_COUNT * FILE_COUNT }, (_, k) => {
      const d = k % DIR_COUNT
      const f = Math.floor(k / DIR_COUNT)
      const body = Array.from({ length: 5 }, (_, line) => `bench row ${line} payload ${d}-${f}`).join("\n")
      return Bun.write(path.join(dir, `dir${d}`, `file${f}.txt`), `tok_${d}_${f}\n${body}\n`)
    }),
  ])
}

// Args are varied per index everywhere so the doom-loop guard
// (src/session/processor.ts:476-501, 3x identical tool+input) never fires.
function globCall(i: number): Call {
  return { name: "glob", args: { path: `dir${(i * 7) % DIR_COUNT}`, pattern: `file${(i * 3) % FILE_COUNT}.txt` } }
}

function grepCall(i: number): Call {
  return { name: "grep", args: { pattern: `tok_${(i * 7) % DIR_COUNT}_${(i * 3) % FILE_COUNT}` } }
}

function readCall(root: string, i: number): Call {
  return {
    name: "read",
    args: { filePath: path.join(root, `dir${(i * 7) % DIR_COUNT}`, `file${(i * 3 + 5) % FILE_COUNT}.txt`) },
  }
}

function writeCall(root: string, i: number): Call {
  return { name: "write", args: { filePath: path.join(root, "gen", `bench_${i}.txt`), content: `bench write ${i}\n` } }
}

function mixedCall(root: string, i: number): Call {
  if (i % 3 === 0) return globCall(i)
  if (i % 3 === 1) return grepCall(i)
  return readCall(root, i)
}

function buildSpecs(scenarios: Scenario[], sizes: number[], rounds: number): CellSpec[] {
  return scenarios.flatMap((scenario): CellSpec[] => {
    if (scenario === "s3") {
      return [
        {
          scenario,
          label: `5x${rounds}`,
          planned: rounds * 5,
          build: (dir: string) =>
            Array.from({ length: rounds }, (_, r) =>
              burst(`r${r}`, Array.from({ length: 5 }, (_, j) => mixedCall(dir, r * 5 + j))),
            ),
        },
      ]
    }
    return sizes.map((size) => ({
      scenario,
      label: `n=${size}`,
      planned: size,
      build: (dir: string) => [
        burst(
          scenario,
          Array.from({ length: size }, (_, i) =>
            scenario === "s1" ? globCall(i) : scenario === "s4" ? writeCall(dir, i) : mixedCall(dir, i),
          ),
        ),
      ],
    }))
  })
}

function computeRun(
  spec: CellSpec,
  repeat: number,
  wall: number,
  timedOut: boolean,
  messages: MessageV2.WithParts[],
  hits: number,
): RunResult {
  const before = new Map(readBucket<BeforeSample>("__benchBefore").map((s) => [s.callID, s]))
  const after = new Map(readBucket<AfterSample>("__benchAfter").map((s) => [s.callID, s]))
  const parts = messages.flatMap((m) => m.parts).filter((p): p is MessageV2.ToolPart => p.type === "tool")
  const dispatch: number[] = []
  const exec: number[] = []
  const rest: number[] = []
  const t0s: number[] = []
  const t1s: number[] = []
  const rounds = new Map<string, { start: number; end: number }>()
  const errors: string[] = []
  let completed = 0
  let errored = 0
  let pending = 0
  let missing = 0
  for (const part of parts) {
    const st = part.state
    if (st.status === "error") {
      errored += 1
      if (errors.length < 4) errors.push(`${part.tool}: ${st.error.replace(/\s+/g, " ").slice(0, 200)}`)
      continue
    }
    if (st.status !== "completed") {
      pending += 1
      continue
    }
    completed += 1
    const sample = before.get(part.callID)
    const done = after.get(part.callID)
    if (sample && done) {
      dispatch.push(sample.t0 - st.time.start)
      exec.push(done.t1 - sample.t0)
      rest.push(st.time.end - done.t1)
      t0s.push(sample.t0)
      t1s.push(done.t1)
    } else {
      missing += 1
    }
    const round = rounds.get(part.messageID)
    if (!round) {
      rounds.set(part.messageID, { start: st.time.start, end: st.time.end })
      continue
    }
    round.start = Math.min(round.start, st.time.start)
    round.end = Math.max(round.end, st.time.end)
  }
  const span = t1s.length ? Math.max(...t1s) - Math.min(...t0s) : 0
  const ordered = [...rounds.values()].sort((a, b) => a.start - b.start)
  return {
    scenario: spec.scenario,
    label: spec.label,
    repeat,
    wall_total_ms: wall,
    timed_out: timedOut,
    planned: spec.planned,
    completed,
    errored,
    pending,
    missing_samples: missing,
    sampler_ok: completed === 0 ? parts.length === 0 : missing < completed,
    llm_hits: hits,
    dispatch: aggregate(dispatch),
    exec: aggregate(exec),
    result: aggregate(rest),
    throughput: wall > 0 ? completed / (wall / 1000) : 0,
    overlap_factor: span > 0 ? exec.reduce((a, b) => a + b, 0) / span : 0,
    round_gaps: ordered.slice(1).map((round, i) => round.start - ordered[i].end),
    events: { ...readEvents() },
    errors,
  }
}

function cellEffect(spec: CellSpec, repeat: number, timeoutMs: number, samplerSource: string) {
  return provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }: { dir: string; llm: TestLLMServer["Service"] }) {
      yield* Effect.promise(() => prepareProject(dir, samplerSource))
      resetSampler()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: `bench ${spec.scenario} ${spec.label}`,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        parts: [{ type: "text", text: "emit the planned tool burst" }],
      })
      yield* llm.push(...spec.build(dir))
      const wall0 = Date.now()
      const outcome = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
      const wall = Date.now() - wall0
      const messages = yield* MessageV2.filterCompactedEffect(session.id)
      const hits = yield* llm.calls
      return computeRun(spec, repeat, wall, Option.isNone(outcome), messages, hits)
    }),
    { config: (url: string) => ({ ...testProviderConfig(url), snapshot: false }) },
  ).pipe(Effect.scoped, Effect.provide(Logger.layer([])), Effect.provide(makePromptHarness()))
}

async function runCell(spec: CellSpec, repeat: number, timeoutMs: number, samplerSource: string): Promise<RunResult> {
  const exit = await Effect.runPromise(
    Effect.exit(cellEffect(spec, repeat, timeoutMs, samplerSource)),
  )
  if (Exit.isSuccess(exit)) return exit.value
  const message = Cause.pretty(exit.cause).replace(/\s+/g, " ").slice(0, 400)
  return {
    scenario: spec.scenario,
    label: spec.label,
    repeat,
    wall_total_ms: -1,
    timed_out: false,
    planned: spec.planned,
    completed: 0,
    errored: 0,
    pending: 0,
    missing_samples: 0,
    sampler_ok: false,
    llm_hits: 0,
    dispatch: undefined,
    exec: undefined,
    result: undefined,
    throughput: 0,
    overlap_factor: 0,
    round_gaps: [],
    events: {},
    errors: [`run failed: ${message}`],
  }
}

function flagValue(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith("--")) return fallback
  return value
}

function fmt(n: number | undefined, digits = 0) {
  if (n === undefined) return "-"
  return n.toFixed(digits)
}

function fmtAgg(a: Agg | undefined) {
  if (!a) return "-"
  return `${a.p50}(${a.min}/${a.max})/${a.p95}`
}

function renderTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ")
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n")
}

type Summary = {
  scenario: Scenario
  label: string
  planned: number
  repeats: number
  wall: number | undefined
  dispatch: Agg | undefined
  exec: Agg | undefined
  result: Agg | undefined
  tput: number | undefined
  overlap: number | undefined
  completed: number | undefined
  errored: number
  missing: number
  timeouts: number
  gapMedian: number | undefined
}

function summarize(runs: RunResult[]): Summary {
  const first = runs[0]
  return {
    scenario: first.scenario,
    label: first.label,
    planned: first.planned,
    repeats: runs.length,
    wall: median(runs.map((r) => r.wall_total_ms)),
    dispatch: medianAgg(runs.map((r) => r.dispatch)),
    exec: medianAgg(runs.map((r) => r.exec)),
    result: medianAgg(runs.map((r) => r.result)),
    tput: median(runs.map((r) => r.throughput)),
    overlap: median(runs.map((r) => r.overlap_factor)),
    completed: median(runs.map((r) => r.completed)),
    errored: runs.reduce((a, r) => a + r.errored, 0),
    missing: runs.reduce((a, r) => a + r.missing_samples, 0),
    timeouts: runs.filter((r) => r.timed_out).length,
    gapMedian: median(runs.flatMap((r) => r.round_gaps)),
  }
}

async function main() {
  const sizes = flagValue("sizes", "1,5,10,25,50")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  const requested = flagValue("scenario", "s1,s2,s3")
    .split(",")
    .map((s) => s.trim().toLowerCase())
  const scenarios = [...new Set(requested.includes("all") ? SCENARIOS : requested)].filter((s): s is Scenario =>
    SCENARIOS.includes(s as Scenario),
  )
  const rounds = Math.max(1, Number(flagValue("rounds", "10")) || 10)
  const repeat = Math.max(1, Number(flagValue("repeat", "3")) || 3)
  const timeoutMs = Math.max(1, Number(flagValue("timeout", "60")) || 60) * 1000
  const out = flagValue("out", "")

  if (!scenarios.length || !sizes.length) {
    console.error("no valid --scenario / --sizes selection")
    process.exit(1)
  }

  const samplerSource = await Bun.file(path.join(import.meta.dir, "plugin.ts")).text()
  const specs = buildSpecs(scenarios, sizes, rounds)
  const skipped = new Map<string, string>()
  const results: RunResult[] = []

  console.log(
    `bench: scenarios=${scenarios.join(",")} sizes=${sizes.join(",")} rounds=${rounds} repeat=${repeat} timeout=${timeoutMs / 1000}s`,
  )
  for (const spec of specs) {
    for (let r = 0; r < repeat; r++) {
      const cell0 = performance.now()
      const run = await runCell(spec, r, timeoutMs, samplerSource)
      results.push(run)
      process.stdout.write(
        `  ${spec.scenario} ${spec.label.padEnd(6)} r${r + 1}: wall=${run.wall_total_ms}ms completed=${run.completed}/${run.planned} err=${run.errored} miss=${run.missing_samples} hits=${run.llm_hits} (cell ${(performance.now() - cell0) / 1000}ms)\n`,
      )
      if (run.errored || run.timed_out || !run.sampler_ok) {
        for (const err of run.errors) process.stdout.write(`    note: ${err}\n`)
        if (run.timed_out) process.stdout.write(`    note: loop exceeded ${timeoutMs / 1000}s (captured finding)\n`)
        if (!run.sampler_ok && run.completed > 0) process.stdout.write(`    note: sampler plugin appears NOT loaded\n`)
      }
      if (spec.scenario === "s4" && r === 0) {
        const gated = run.errored > 0 && run.completed === 0
        if (gated) {
          skipped.set(`${spec.scenario}:${spec.label}`, run.errors[0] ?? "writes blocked in uninitialized-graph tmpdir")
          process.stdout.write(`  s4 ${spec.label}: skipped: ${run.errors[0] ?? "no completed writes"}\n`)
          break
        }
      }
    }
  }

  const groups = results
    .filter((r) => !skipped.has(`${r.scenario}:${r.label}`) || r.scenario !== "s4")
    .reduce<Map<string, RunResult[]>>((map, run) => {
      const key = `${run.scenario}:${run.label}`
      const list = map.get(key) ?? []
      list.push(run)
      map.set(key, list)
      return map
    }, new Map())
  const summaries = [...groups.values()].map(summarize)
  const headers = [
    "scenario",
    "case",
    "planned",
    "reps",
    "wall_ms",
    "disp p50(min/max)/p95",
    "exec p50(min/max)/p95",
    "res p50(min/max)/p95",
    "tput/s",
    "overlap",
    "errors",
    "miss",
    "to",
    "gap p50",
  ]
  const rows = summaries.map((s) => [
    s.scenario,
    s.label,
    String(s.planned),
    String(s.repeats),
    fmt(s.wall),
    fmtAgg(s.dispatch),
    fmtAgg(s.exec),
    fmtAgg(s.result),
    fmt(s.tput, 1),
    fmt(s.overlap, 2),
    String(s.errored),
    String(s.missing),
    String(s.timeouts),
    fmt(s.gapMedian),
  ])
  for (const [key, reason] of skipped) rows.push([key.split(":")[0], key.split(":")[1], "-", "-", `skipped: ${reason}`])

  console.log()
  console.log(renderTable(headers, rows))
  console.log("\ncolumns: disp/exec/res = per-call dispatch_delay|exec|result_delay in ms; wall covers prompt.loop only")

  const payload = {
    meta: {
      generated_at: new Date().toISOString(),
      args: { sizes, scenarios, rounds, repeat, timeout_ms: timeoutMs, out },
      db: "sqlite :memory: (mirrors test/preload.ts)",
    },
    skipped: Object.fromEntries(skipped),
    runs: results,
    cells: summaries,
  }
  if (out) {
    await Bun.write(path.resolve(out), JSON.stringify(payload, null, 2))
    console.log(`\nwrote ${path.resolve(out)}`)
  }
}

void main().then(() => process.exit(0))
