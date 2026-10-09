import { afterEach, describe, expect, test } from "bun:test"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { ProcessRegistry } from "@/chimera/process-registry"
import { markProcessExited, readActiveProcesses, registerProcess } from "@/chimera/store"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

/** Store functions only open an existing project DB; they must never create graph data. */
async function dbDir() {
  const tmp = await tmpdir()
  DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
  return tmp
}

describe("process registry store", () => {
  test("register then listActive returns running rows in started_at order", async () => {
    await using tmp = await dbDir()
    const first = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      pid: process.pid,
      pgid: process.pid,
      command: "bun test",
      cwd: tmp.path,
    })
    const second = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      pid: process.pid,
      command: "echo second",
    })
    expect(first?.status).toBe("running")
    expect(first?.hostBootID).toMatch(/^boot_\d+_\d+$/)
    expect(first?.cwd).toBe(tmp.path)
    expect(second?.pgid).toBeNull()

    const active = await ProcessRegistry.listActive(tmp.path)
    expect(active.map((entry) => entry.command)).toEqual(["bun test", "echo second"])
    expect(active.every((entry) => entry.status === "running")).toBe(true)
  })

  test("markExited sets status and exit code, drops from listActive, and is idempotent", async () => {
    await using tmp = await dbDir()
    const entry = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      pid: process.pid,
      command: "sleep 30",
    })
    expect(entry).toBeDefined()
    if (!entry) return

    const exited = await ProcessRegistry.markExited(tmp.path, entry.id, 7)
    expect(exited?.status).toBe("exited")
    expect(exited?.exitCode).toBe(7)
    expect(exited?.exitedAt).toStartWith("20")
    expect(await ProcessRegistry.listActive(tmp.path)).toHaveLength(0)
    // Exactly-once: the guarded UPDATE never re-flips a settled row.
    expect(await ProcessRegistry.markExited(tmp.path, entry.id, 9)).toBeUndefined()
  })

  test("markKilled flips only a running row", async () => {
    await using tmp = await dbDir()
    const entry = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      pid: process.pid,
      command: "bun run dev",
    })
    expect(entry).toBeDefined()
    if (!entry) return
    const killed = await ProcessRegistry.markKilled(tmp.path, entry.id)
    expect(killed?.status).toBe("killed")
    expect(await ProcessRegistry.markKilled(tmp.path, entry.id)).toBeUndefined()
    expect(await ProcessRegistry.listActive(tmp.path)).toHaveLength(0)
  })

  test("releaseForSession flips running rows to released and leaves other sessions alone", async () => {
    await using tmp = await dbDir()
    await ProcessRegistry.register({ projectRoot: tmp.path, sessionID: "ses_a", pid: process.pid, command: "one" })
    await ProcessRegistry.register({ projectRoot: tmp.path, sessionID: "ses_a", pid: process.pid, command: "two" })
    await ProcessRegistry.register({ projectRoot: tmp.path, sessionID: "ses_b", pid: process.pid, command: "three" })

    const released = await ProcessRegistry.releaseForSession(tmp.path, "ses_a")
    expect(released.map((entry) => entry.command).sort()).toEqual(["one", "two"])
    expect(released.every((entry) => entry.status === "released" && entry.exitedAt !== null)).toBe(true)

    const active = await ProcessRegistry.listActive(tmp.path)
    expect(active.map((entry) => entry.sessionID)).toEqual(["ses_b"])
  })

  test("lazy TTL expiry flips rows past expires_at and persists the flip", async () => {
    await using tmp = await dbDir()
    const entry = await ProcessRegistry.register({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      pid: process.pid,
      command: "bun test",
      ttlMs: 60_000,
    })
    expect(entry).toBeDefined()
    expect(await ProcessRegistry.listActive(tmp.path)).toHaveLength(1)

    const future = new Date(Date.now() + 61_000).toISOString()
    expect(await readActiveProcesses(tmp.path, { now: future })).toHaveLength(0)
    // Persisted, not just filtered: a current-time read stays empty.
    expect(await ProcessRegistry.listActive(tmp.path)).toHaveLength(0)
    if (entry) expect(await markProcessExited(tmp.path, entry.id, null)).toBeUndefined()
  })

  test("liveness sweep expires running rows whose pid is provably dead", async () => {
    await using tmp = await dbDir()
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    const deadPID = child.pid

    const stale = await registerProcess(tmp.path, { sessionID: "ses_a", pid: deadPID, pgid: deadPID, command: "gone" })
    expect(stale).toBeDefined()
    const alive = await registerProcess(tmp.path, { sessionID: "ses_b", pid: process.pid, command: "still here" })
    expect(alive).toBeDefined()

    const active = await ProcessRegistry.listActive(tmp.path)
    expect(active.map((entry) => entry.command)).toEqual(["still here"])
    // Sweep was persisted: the dead row can no longer transition.
    if (stale) expect(await markProcessExited(tmp.path, stale.id, null)).toBeUndefined()
  })
})

describe("kill gate parser", () => {
  test("extracts numeric pids from direct kill invocations", () => {
    expect(ProcessRegistry.extractKillTargets("kill 123")).toEqual([123])
    expect(ProcessRegistry.extractKillTargets("kill -9 123 456")).toEqual([123, 456])
    expect(ProcessRegistry.extractKillTargets("kill -SIGKILL 42")).toEqual([42])
    expect(ProcessRegistry.extractKillTargets("kill -TERM 7; kill 8")).toEqual([7, 8])
    expect(ProcessRegistry.extractKillTargets("echo hi && kill 7")).toEqual([7])
    expect(ProcessRegistry.extractKillTargets("kill -- -45")).toEqual([45])
    expect(ProcessRegistry.extractKillTargets("/bin/kill 123")).toEqual([123])
    expect(ProcessRegistry.extractKillTargets("kill 123 123")).toEqual([123])
  })

  test("pattern-based kills and non-kill commands yield no targets", () => {
    expect(ProcessRegistry.extractKillTargets("pkill -f node")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("killall node")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("ls -la")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("bun test --timeout 30000")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("kill $PID")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("kill 0")).toEqual([])
  })

  test("CHIMERA_KILL_CONFIRM=1 anywhere in the command text passes the gate", () => {
    expect(ProcessRegistry.extractKillTargets("CHIMERA_KILL_CONFIRM=1 kill 123")).toEqual([])
    expect(ProcessRegistry.extractKillTargets("export CHIMERA_KILL_CONFIRM=1; kill 123")).toEqual([])
    // The confirmation must be exactly 1, not another value.
    expect(ProcessRegistry.extractKillTargets("CHIMERA_KILL_CONFIRM=0 kill 123")).toEqual([123])
  })

  test("findForeignKillTarget matches pid or pgid of another session only", () => {
    // Pure matcher over hand-built entries: fake DB pids are dead and would be
    // liveness-swept out of listActive before the assertions could run.
    const entries: ProcessRegistry.ProcessEntry[] = [
      {
        id: "entry_a",
        sessionID: "ses_a",
        hostBootID: null,
        pid: 4001,
        pgid: 4001,
        command: "bun test",
        cwd: null,
        status: "running",
        exitCode: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        exitedAt: null,
      },
      {
        id: "entry_b",
        sessionID: "ses_b",
        hostBootID: null,
        pid: 4002,
        pgid: null,
        command: "sleep 5",
        cwd: null,
        status: "running",
        exitCode: null,
        startedAt: "2026-01-01T00:00:01.000Z",
        exitedAt: null,
      },
    ]

    expect(ProcessRegistry.findForeignKillTarget(entries, [4001], "ses_b")?.sessionID).toBe("ses_a")
    expect(ProcessRegistry.findForeignKillTarget(entries, [4002], "ses_b")).toBeUndefined()
    expect(ProcessRegistry.findForeignKillTarget(entries, [4001], "ses_a")).toBeUndefined()
    expect(ProcessRegistry.findForeignKillTarget(entries, [], "ses_b")).toBeUndefined()
    // pgid hit on a different session blocks too.
    expect(ProcessRegistry.findForeignKillTarget(entries, [4001], "ses_c")?.pid).toBe(4001)
  })

  test("degrade-open: reads against an uninitialized project yield empty lists", async () => {
    await using tmp = await tmpdir()
    expect(await ProcessRegistry.listActive(tmp.path)).toEqual([])
    expect(await ProcessRegistry.releaseForSession(tmp.path, "ses_missing")).toEqual([])
    expect(
      await ProcessRegistry.register({ projectRoot: tmp.path, sessionID: "ses_a", pid: process.pid, command: "x" }),
    ).toBeUndefined()
  })
})
