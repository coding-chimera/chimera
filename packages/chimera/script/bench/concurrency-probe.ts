// Concurrency probe harness: event-loop lag + throughput decay as N in-process
// sessions run a typical step workload against the real storage stack.
//
// Each lane is one virtual session and repeats the same step:
//   1. read a page of message+part through `MessageV2.page` (real Database)
//   2. write one part event inside a synchronous drizzle transaction
//   3. read the `.chimera` store's active processes and edit-intent claims
//
// All lanes share one Bun process and one synchronous SQLite connection, which
// is the shape of the production stall: N sessions serialize on sqlite3_step on
// the main thread. `perf_hooks.monitorEventLoopDelay` samples that blocking.
//
// Run from packages/chimera:
//   bun script/bench/concurrency-probe.ts --smoke
//   bun script/bench/concurrency-probe.ts --lanes 1,26,50,100 --duration 10000
//   bun script/bench/concurrency-probe.ts --out /tmp/cbench-concurrency
//
// Parameters (env vars, all optional):
//   BENCH_CONCURRENCY_LANES=1,26,50,100
//   BENCH_CONCURRENCY_MS=10000        duration per lane count
//   BENCH_CONCURRENCY_MESSAGES=60     seeded messages per lane session
//   BENCH_CONCURRENCY_PARTS=4         seeded parts per message
//   BENCH_CONCURRENCY_OUT=/Volumes/workspace/cbench/concurrency
//
// Safety: all synthetic data goes to the system temp dir; the result archive
// directory is outside the repository. No src/ file is touched.
import fs from "fs"
import os from "os"
import path from "path"
import { monitorEventLoopDelay } from "node:perf_hooks"

const DEFAULT_OUT = "/Volumes/workspace/cbench/concurrency"
const DEFAULT_LEVELS = [1, 26, 50, 100]
const DEFAULT_DURATION_MS = 10_000
const SMOKE_TOTAL_MS = 10_000
const PAGE_SIZE = 50
const LAG_RESOLUTION_MS = 10

type LevelResult = {
  lanes: number
  durationMs: number
  elapsedMs: number
  steps: number
  stepsPerLane: number
  qps: number
  stepsPerLanePerSec: number
  ops: number
  opsPerSec: number
  reads: { pages: number; rows: number; parts: number }
  writes: number
  storeReads: number
  laneSteps: number[]
  lagMs: { p50: number; p95: number; p99: number; mean: number; max: number; samples: number }
}

function argValue(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) return "1"
  return value
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function readLevels(): number[] {
  const raw = argValue("lanes", process.env["BENCH_CONCURRENCY_LANES"]) ?? DEFAULT_LEVELS.join(",")
  const levels = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
  return levels.length > 0 ? levels : DEFAULT_LEVELS
}

function isolateHome(dir: string) {
  fs.mkdirSync(path.join(dir, "home"), { recursive: true })
  fs.mkdirSync(path.join(dir, "cache", "chimera"), { recursive: true })
  fs.writeFileSync(path.join(dir, "cache", "chimera", "version"), "14")
  process.env["XDG_DATA_HOME"] = path.join(dir, "share")
  process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
  process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
  process.env["XDG_STATE_HOME"] = path.join(dir, "state")
  process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
  process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"
  process.env["CHIMERA_INSTANCE_MEMORY_BUDGET_MB"] = "0"
  process.env["CHIMERA_GRAPH_STATE_IDLE_SWEEP_MS"] = "0"
}

function pad(value: number, width: number) {
  return String(value).padStart(width, "0")
}

function messageData(created: number, user: boolean) {
  if (user)
    return {
      role: "user",
      time: { created },
      agent: "bench",
      model: { providerID: "bench", modelID: "bench" },
      tools: {},
      mode: "",
    }
  return {
    role: "assistant",
    time: { created, completed: created + 1 },
    modelID: "bench",
    providerID: "bench",
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function partData(created: number, text: string) {
  return { type: "text", text, time: { start: created, end: created + 1 } }
}

type SeededSession = { sessionID: string; lastMessageID: string }

async function seedFixture(input: {
  root: string
  lanes: number
  messages: number
  parts: number
}): Promise<{ dbPath: string; sessions: SeededSession[] }> {
  const dbPath = path.join(input.root, "probe.db")
  process.env["OPENCODE_DB"] = dbPath
  const { Database } = await import("../../src/storage/db")
  const { sql } = await import("drizzle-orm")

  const projectID = "prj_concurrency_probe"
  const base = Date.now()
  Database.use((db) => {
    db.run(
      sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES (${projectID}, ${input.root}, ${JSON.stringify([])}, ${base}, ${base})`,
    )
  })

  const sessions: SeededSession[] = []
  for (let lane = 0; lane < input.lanes; lane++) {
    const sessionID = `ses_probe_${pad(lane, 4)}`
    const created = base + lane * 10_000_000
    Database.use((db) => {
      db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES (${sessionID}, ${projectID}, ${`probe-${lane}`}, ${input.root}, ${`probe session ${lane}`}, ${"bench"}, ${created}, ${created})`,
      )
    })
    Database.transaction((tx) => {
      for (let m = 0; m < input.messages; m++) {
        const messageID = `msg_probe_${pad(lane, 4)}_${pad(m, 5)}`
        const at = created + m * 1_000
        tx.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
              VALUES (${messageID}, ${sessionID}, ${at}, ${at}, ${JSON.stringify(messageData(at, m % 2 === 0))})`,
        )
        for (let p = 0; p < input.parts; p++) {
          const partID = `prt_probe_${pad(lane, 4)}_${pad(m, 5)}_${pad(p, 3)}`
          const text = `probe ${lane}/${m}/${p} ${"x".repeat(96)}`
          tx.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                VALUES (${partID}, ${messageID}, ${sessionID}, ${at + p}, ${at + p}, ${JSON.stringify(partData(at + p, text))})`,
          )
        }
      }
    })
    sessions.push({ sessionID, lastMessageID: `msg_probe_${pad(lane, 4)}_${pad(input.messages - 1, 5)}` })
  }

  return { dbPath, sessions }
}

type PartWriter = (input: { sessionID: string; messageID: string; id: string; created: number }) => void

// Resolved once per level: dynamic imports inside a `.then` chain lose their
// closure when the callback runs under the storage transaction (Bun 1.4), so
// the tag and Database are captured by a plain factory closure instead.
async function makePartWriter(): Promise<PartWriter> {
  const { Database } = await import("../../src/storage/db")
  const { sql } = await import("drizzle-orm")
  return (input) => {
    Database.transaction((tx) => {
      tx.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
            VALUES (${input.id}, ${input.messageID}, ${input.sessionID}, ${input.created}, ${input.created}, ${JSON.stringify(partData(input.created, `event ${input.id}`))})`,
      )
    })
  }
}

function lagMs(ns: number) {
  return Math.round((ns / 1e6) * 1000) / 1000
}

async function runLevel(input: {
  levelIndex: number
  lanes: number
  durationMs: number
  sessions: SeededSession[]
  storeRoot: string
}): Promise<LevelResult> {
  const { MessageV2 } = await import("../../src/session/message-v2")
  const { ChimeraStore } = await import("../../src/chimera/store")
  const writePartEvent = await makePartWriter()
  type SessionID = Parameters<typeof MessageV2.page>[0]["sessionID"]

  const readPage = (sessionID: string) => MessageV2.page({ sessionID: sessionID as SessionID, limit: PAGE_SIZE })
  const writePart = (session: SeededSession, seq: number) =>
    writePartEvent({
      sessionID: session.sessionID,
      messageID: session.lastMessageID,
      id: `prt_evt_${pad(input.levelIndex, 2)}_${pad(seq, 8)}_${session.sessionID.slice(-4)}`,
      created: Date.now(),
    })

  const counters = Array.from({ length: input.lanes }, () => ({
    steps: 0,
    rows: 0,
    parts: 0,
    writes: 0,
    storeReads: 0,
    seq: 0,
  }))

  // Warm the per-session page markers, store connection and drizzle cache so
  // the sampled window measures steady-state work instead of one-off setup.
  await Promise.all(
    counters.map(async (counter, lane) => {
      const page = readPage(input.sessions[lane].sessionID)
      counter.rows += page.items.length
      counter.parts += page.items.reduce((sum, item) => sum + item.parts.length, 0)
      await writePart(input.sessions[lane], counter.seq++)
      await ChimeraStore.readActiveProcesses(input.storeRoot)
      await ChimeraStore.readActiveEditIntentClaims(input.storeRoot)
      counter.steps = 0
      counter.rows = 0
      counter.parts = 0
      counter.writes = 0
      counter.storeReads = 0
    }),
  )

  const histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS })
  histogram.enable()
  const startedAt = performance.now()
  const deadline = startedAt + input.durationMs

  const lane = async (laneIndex: number) => {
    const session = input.sessions[laneIndex]
    const counter = counters[laneIndex]
    while (performance.now() < deadline) {
      const page = readPage(session.sessionID)
      counter.steps++
      counter.rows += page.items.length
      counter.parts += page.items.reduce((sum, item) => sum + item.parts.length, 0)
      await writePart(session, counter.seq++)
      counter.writes++
      await ChimeraStore.readActiveProcesses(input.storeRoot)
      await ChimeraStore.readActiveEditIntentClaims(input.storeRoot)
      counter.storeReads += 2
      await Bun.sleep(0)
    }
  }

  await Promise.all(counters.map((_, laneIndex) => lane(laneIndex)))

  const elapsedMs = performance.now() - startedAt
  histogram.disable()

  const steps = counters.reduce((sum, counter) => sum + counter.steps, 0)
  const ops = steps * 4
  const elapsedSec = elapsedMs / 1000
  const samples = histogram.count
  return {
    lanes: input.lanes,
    durationMs: input.durationMs,
    elapsedMs: Math.round(elapsedMs),
    steps,
    stepsPerLane: Math.round((steps / input.lanes) * 100) / 100,
    qps: Math.round((steps / elapsedSec) * 100) / 100,
    stepsPerLanePerSec: Math.round((steps / input.lanes / elapsedSec) * 100) / 100,
    ops,
    opsPerSec: Math.round((ops / elapsedSec) * 100) / 100,
    reads: {
      pages: steps,
      rows: counters.reduce((sum, counter) => sum + counter.rows, 0),
      parts: counters.reduce((sum, counter) => sum + counter.parts, 0),
    },
    writes: counters.reduce((sum, counter) => sum + counter.writes, 0),
    storeReads: counters.reduce((sum, counter) => sum + counter.storeReads, 0),
    laneSteps: counters.map((counter) => counter.steps),
    lagMs: {
      p50: samples > 0 ? lagMs(histogram.percentile(50)) : 0,
      p95: samples > 0 ? lagMs(histogram.percentile(95)) : 0,
      p99: samples > 0 ? lagMs(histogram.percentile(99)) : 0,
      mean: samples > 0 ? lagMs(histogram.mean) : 0,
      max: samples > 0 ? lagMs(histogram.max) : 0,
      samples,
    },
  }
}

function stamp(date: Date) {
  const two = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

function decayCurve(levels: LevelResult[]) {
  const baseline = levels[0]
  return levels.slice(1).map((level) => ({
    from: baseline.lanes,
    to: level.lanes,
    qpsRatio: baseline.qps > 0 ? Math.round((level.qps / baseline.qps) * 1000) / 1000 : 0,
    perLaneRatio:
      baseline.stepsPerLanePerSec > 0
        ? Math.round((level.stepsPerLanePerSec / baseline.stepsPerLanePerSec) * 1000) / 1000
        : 0,
  }))
}

async function setupStore(projectRoot: string) {
  const { ChimeraStore } = await import("../../src/chimera/store")
  await ChimeraStore.registerEditIntentClaims(projectRoot, {
    id: "predesign_probe",
    sessionID: "ses_probe_0000",
    agent: "concurrency-probe",
    files: ["src/bench-probe.ts"],
    intent: "concurrency probe fixture",
  })
  await ChimeraStore.registerProcess(projectRoot, {
    sessionID: "ses_probe_0000",
    pid: process.pid,
    command: "concurrency-probe",
    cwd: projectRoot,
  })
}

async function main() {
  const smoke = hasFlag("smoke")
  const levels = readLevels()
  const durationArg = Number(argValue("duration", process.env["BENCH_CONCURRENCY_MS"]))
  const durationMs =
    Number.isInteger(durationArg) && durationArg > 0
      ? durationArg
      : smoke
        ? Math.max(1_000, Math.round(SMOKE_TOTAL_MS / levels.length))
        : DEFAULT_DURATION_MS
  const messages = envInt("BENCH_CONCURRENCY_MESSAGES", 60)
  const parts = envInt("BENCH_CONCURRENCY_PARTS", 4)
  const label = argValue("label", smoke ? "smoke" : "run") ?? "run"
  const outRoot = argValue("out", process.env["BENCH_CONCURRENCY_OUT"] ?? DEFAULT_OUT) ?? DEFAULT_OUT
  const keepTemp = hasFlag("keep-temp")

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chimera-concurrency-probe-"))
  isolateHome(tempDir)
  const storeRoot = path.join(tempDir, "project")
  fs.mkdirSync(storeRoot, { recursive: true })

  const maxLanes = Math.max(...levels)
  console.log(
    `concurrency-probe: lanes=${levels.join(",")} duration=${durationMs}ms/lane-count seed=${maxLanes}x${messages}x${parts}`,
  )
  const seeded = await seedFixture({ root: tempDir, lanes: maxLanes, messages, parts })
  await setupStore(storeRoot)
  const { Database } = await import("../../src/storage/db")
  const { ChimeraStore } = await import("../../src/chimera/store")

  const results: LevelResult[] = []
  try {
    for (const [index, lanes] of levels.entries()) {
      console.log(`lanes=${lanes} running ${durationMs}ms ...`)
      const result = await runLevel({
        levelIndex: index,
        lanes,
        durationMs,
        sessions: seeded.sessions.slice(0, lanes),
        storeRoot,
      })
      results.push(result)
      console.log(
        `lanes=${lanes} qps=${result.qps} perLane=${result.stepsPerLanePerSec}/s ` +
          `lag p50=${result.lagMs.p50}ms p95=${result.lagMs.p95}ms p99=${result.lagMs.p99}ms max=${result.lagMs.max}ms`,
      )
    }

    const decay = decayCurve(results)
    const revision = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: path.join(import.meta.dir, "../.."),
    })
    const payload = {
      meta: {
        generatedAt: new Date().toISOString(),
        label,
        smoke,
        levels,
        durationMsPerLevel: durationMs,
        pageSize: PAGE_SIZE,
        seed: { lanes: maxLanes, messages, parts },
        dbPath: seeded.dbPath,
        storeRoot,
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
        git: revision.exitCode === 0 ? revision.stdout.toString().trim() : "unknown",
      },
      levels: results,
      decay,
    }

    fs.mkdirSync(outRoot, { recursive: true })
    const resultPath = path.join(outRoot, `concurrency-${label}-${stamp(new Date())}.json`)
    fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2))

    console.log("")
    console.log("lanes | qps    | per-lane/s | p50ms | p95ms | p99ms | maxms")
    for (const level of results)
      console.log(
        [
          String(level.lanes).padEnd(5),
          level.qps.toFixed(1).padStart(6),
          level.stepsPerLanePerSec.toFixed(1).padStart(10),
          level.lagMs.p50.toFixed(2).padStart(5),
          level.lagMs.p95.toFixed(2).padStart(5),
          level.lagMs.p99.toFixed(2).padStart(5),
          level.lagMs.max.toFixed(2).padStart(5),
        ].join(" | "),
      )
    for (const point of decay)
      console.log(
        `decay ${point.from}->${point.to}: qps x${point.qpsRatio} per-lane x${point.perLaneRatio}`,
      )
    console.log(`result: ${resultPath}`)
  } finally {
    ChimeraStore.closeStoreConnections()
    Database.close()
    if (!keepTemp) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

await main()