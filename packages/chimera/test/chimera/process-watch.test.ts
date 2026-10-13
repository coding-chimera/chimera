import { afterEach, describe, expect, test } from "bun:test"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { ProcessWatch } from "@/chimera/process-watch"
import type { ProcessEntry } from "@/chimera/process-registry"
import { markProcessExited, readProcessesByPids, registerProcess } from "@/chimera/store"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  ProcessWatch.reset()
  await disposeAllInstances()
})

/** Store functions only open an existing project DB; they must never create graph data. */
async function dbDir() {
  const tmp = await tmpdir()
  DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
  return tmp
}

function entry(overrides: Partial<ProcessEntry> & { pid: number }): ProcessEntry {
  return {
    id: `entry_${overrides.pid}`,
    sessionID: "ses_a",
    hostBootID: null,
    pgid: null,
    command: "sleep 60",
    cwd: null,
    status: "running",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    exitedAt: null,
    ...overrides,
  }
}

describe("process watch subscription registry", () => {
  test("subscribe registers one subscription and listForSession returns it", () => {
    ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_a",
      pid: 4001,
      command: "sleep 60",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const listed = ProcessWatch.listForSession("/proj", "ses_a")
    expect(listed).toHaveLength(1)
    expect(listed[0]!.pid).toBe(4001)
    expect(listed[0]!.expiresAt).toBeNull()
  })

  test("take is a one-shot gate: the first take returns the subscription, the second is empty", () => {
    ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_a",
      pid: 4001,
      command: "sleep 60",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(ProcessWatch.take("/proj", "ses_a", 4001)?.pid).toBe(4001)
    expect(ProcessWatch.take("/proj", "ses_a", 4001)).toBeUndefined()
    expect(ProcessWatch.listForProject("/proj")).toHaveLength(0)
  })

  test("takeByPid fans out across sessions and removes every session's subscription", () => {
    for (const sessionID of ["ses_a", "ses_b", "ses_c"]) {
      ProcessWatch.subscribe({
        projectRoot: "/proj",
        sessionID,
        pid: 4002,
        command: "bun test",
        ownerSession: "ses_owner",
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    }
    // A different pid in another project must not be touched.
    ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_a",
      pid: 4003,
      command: "other",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const taken = ProcessWatch.takeByPid("/proj", 4002)
    expect(taken.map((sub) => sub.sessionID).sort()).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(ProcessWatch.listForProject("/proj").map((sub) => sub.pid)).toEqual([4003])
    expect(ProcessWatch.takeByPid("/proj", 4002)).toHaveLength(0)
  })

  test("releaseForSession drops only that session's subscriptions", () => {
    ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_a",
      pid: 4001,
      command: "a",
      ownerSession: "ses_a",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_b",
      pid: 4001,
      command: "a",
      ownerSession: "ses_a",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const dropped = ProcessWatch.releaseForSession("/proj", "ses_a")
    expect(dropped.map((sub) => sub.sessionID)).toEqual(["ses_a"])
    expect(ProcessWatch.listForSession("/proj", "ses_a")).toHaveLength(0)
    expect(ProcessWatch.listForSession("/proj", "ses_b")).toHaveLength(1)
  })

  test("subscribe records a timeout deadline when timeoutMs is given", () => {
    const before = Date.now()
    const sub = ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_a",
      pid: 4001,
      command: "sleep 60",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
      timeoutMs: 5_000,
    })
    expect(sub.expiresAt).toBeGreaterThanOrEqual(before + 5_000)
  })
})

describe("process watch resolution", () => {
  test("resolveWatchTarget reports missing for no rows", () => {
    expect(ProcessWatch.resolveWatchTarget([]).kind).toBe("missing")
  })

  test("resolveWatchTarget reports terminal for a settled row", () => {
    const resolution = ProcessWatch.resolveWatchTarget([entry({ pid: 4001, status: "exited", exitCode: 0, exitedAt: "2026-01-01T00:01:00.000Z" })])
    expect(resolution.kind).toBe("terminal")
    if (resolution.kind === "terminal") expect(resolution.entry.exitCode).toBe(0)
  })

  test("resolveWatchTarget prefers the newest running row (pid reuse) over a newer terminal row", () => {
    const resolution = ProcessWatch.resolveWatchTarget([
      entry({ pid: 4001, status: "exited", startedAt: "2026-01-01T00:00:00.000Z", exitedAt: "2026-01-01T00:01:00.000Z" }),
      entry({ pid: 4001, status: "running", startedAt: "2026-01-01T00:02:00.000Z" }),
    ])
    expect(resolution.kind).toBe("subscribe")
    if (resolution.kind === "subscribe") expect(resolution.entry.startedAt).toBe("2026-01-01T00:02:00.000Z")
  })

  test("resolveWatchTarget picks the newest running row when several are running", () => {
    const resolution = ProcessWatch.resolveWatchTarget([
      entry({ pid: 4001, status: "running", startedAt: "2026-01-01T00:00:00.000Z" }),
      entry({ pid: 4001, status: "running", startedAt: "2026-01-01T00:05:00.000Z" }),
    ])
    if (resolution.kind === "subscribe") expect(resolution.entry.startedAt).toBe("2026-01-01T00:05:00.000Z")
  })

  test("latestPerPid keeps the newest row per pid", () => {
    const latest = ProcessWatch.latestPerPid([
      entry({ pid: 1, status: "exited", startedAt: "2026-01-01T00:00:00.000Z" }),
      entry({ pid: 1, status: "running", startedAt: "2026-01-01T00:03:00.000Z" }),
      entry({ pid: 2, status: "running", startedAt: "2026-01-01T00:01:00.000Z" }),
    ])
    expect(latest.map((row) => [row.pid, row.status])).toEqual([
      [1, "running"],
      [2, "running"],
    ])
  })
})

describe("process watch payloads", () => {
  test("exitText carries pid, status, exit code, owner and detection channel", () => {
    const sub = ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_watch",
      pid: 63981,
      command: 'sleep "60"',
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const text = ProcessWatch.exitText(sub, entry({ pid: 63981, status: "exited", exitCode: 0, exitedAt: "2026-01-01T00:01:00.000Z" }), "owner-report")
    expect(text).toContain('<process_exited pid="63981"')
    expect(text).toContain('status="exited"')
    expect(text).toContain('exit_code="0"')
    expect(text).toContain('owner_session="ses_owner"')
    expect(text).toContain('detected="owner-report"')
    expect(text).toContain("&quot;60&quot;")
    expect(text).toEndWith("</process_exited>")
  })

  test("exitText reports the liveness-poll channel and a null exit code", () => {
    const sub = ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_watch",
      pid: 42,
      command: "bun test",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
    })
    const text = ProcessWatch.exitText(sub, entry({ pid: 42, status: "expired", exitedAt: "2026-01-01T00:01:00.000Z" }), "liveness-poll")
    expect(text).toContain('status="expired"')
    expect(text).toContain('exit_code="-"')
    expect(text).toContain('detected="liveness-poll"')
  })

  test("timeoutText carries pid and command", () => {
    const sub = ProcessWatch.subscribe({
      projectRoot: "/proj",
      sessionID: "ses_watch",
      pid: 42,
      command: "bun run dev",
      ownerSession: "ses_owner",
      startedAt: "2026-01-01T00:00:00.000Z",
      timeoutMs: 1_000,
    })
    const text = ProcessWatch.timeoutText(sub)
    expect(text).toContain('<process_watch_timeout pid="42"')
    expect(text).toContain('command="bun run dev"')
    expect(text).toEndWith("</process_watch_timeout>")
  })
})

describe("process registry read-by-pids", () => {
  test("returns terminal rows too, filtered to the requested pids", async () => {
    await using tmp = await dbDir()
    const a = await registerProcess(tmp.path, { sessionID: "ses_a", pid: process.pid, command: "sleep 30" })
    const b = await registerProcess(tmp.path, { sessionID: "ses_b", pid: process.pid, command: "other" })
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (!a) return
    await markProcessExited(tmp.path, a.id, 7)

    const rows = await readProcessesByPids(tmp.path, [a.pid])
    // Both rows share the same pid here; both must come back (caller resolves).
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.some((row) => row.id === a.id && row.status === "exited" && row.exitCode === 7)).toBe(true)
    expect(await readProcessesByPids(tmp.path, [999_999])).toEqual([])
  })

  test("liveness sweep returns a dead-but-running row as expired (persisted)", async () => {
    await using tmp = await dbDir()
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    const stale = await registerProcess(tmp.path, { sessionID: "ses_a", pid: child.pid, command: "gone" })
    expect(stale).toBeDefined()
    if (!stale) return

    const rows = await readProcessesByPids(tmp.path, [child.pid])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("expired")
    // Persisted, not just filtered: a later transition cannot re-flip it.
    expect(await markProcessExited(tmp.path, stale.id, null)).toBeUndefined()
  })

  test("degrade-open: reads against an uninitialized project yield no rows", async () => {
    await using tmp = await tmpdir()
    expect(await readProcessesByPids(tmp.path, [process.pid])).toEqual([])
  })
})