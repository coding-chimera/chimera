import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { EditIntentClaims } from "@/chimera/edit-intent"
import {
  currentHostBootID,
  readEditIntentWaiters,
  registerEditIntentClaims,
  registerEditIntentWaiter,
  releaseEditIntentClaims,
  takeWokenEditIntentWaiters,
  type EditIntentWaiterRecord,
} from "@/chimera/store"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "edit-intent-cross-process-worker.ts")

/**
 * Real dual-process integration for the cross-process poll→inject bridge at
 * the storage/coordination layer: two bun processes (TS source — the allowed
 * lane, no fresh executables) share one project DB and exercise the exact
 * ownership rules two chimera CLI processes would: host-stamped waiter
 * registration, host-filtered takes that never steal a foreign wake, and a
 * stale-boot sweep against a genuinely dead process.
 *
 * The full agent-level cross-process E2E (two real servers, a truly parked
 * session woken through injectSynthetic) needs built binaries/endpoints and
 * is CI-only per the endpoint safety red line; the fiber-level equivalent
 * (watcher poll fiber → inject → auto-continue) is covered in
 * test/session/edit-intent-wake.test.ts.
 */
describe("edit-intent cross-process bridge (dual bun processes, shared project DB)", () => {
  test("a release in the parent wakes the child's hosted waiter via its own host-filtered poll, and the parent's take never steals it", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    await registerEditIntentClaims(tmp.path, {
      id: "predesign_parent",
      sessionID: "ses_holder",
      agent: "build",
      files: ["shared.ts"],
      intent: "holder work in the parent process",
    })

    const child = Bun.spawn({
      cmd: [process.execPath, worker, tmp.path, "shared.ts", "ses_holder"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    try {
      // Wait for the child's registration to surface in the shared DB (the
      // DB is the sync medium, not stdout; this also absorbs bun cold start).
      let childRow: EditIntentWaiterRecord | undefined
      for (let i = 0; i < 300 && !childRow; i++) {
        const waiting = await readEditIntentWaiters(tmp.path, { status: "waiting" })
        childRow = waiting.find((waiter) => waiter.hostBootID !== undefined && waiter.hostBootID !== currentHostBootID())
        if (!childRow) await Bun.sleep(100)
      }
      expect(childRow).toBeDefined()
      expect(childRow!.hostPID).not.toBe(process.pid)
      expect(childRow!.sessionID).toBe(`ses_child_${childRow!.hostPID}`)

      // Attribution filter across real processes: the parent's host-scoped
      // take must not flip the child's waiter — stealing it would strand the
      // wake forever, because the parent cannot inject into the child's
      // sessions. The child's own poll cannot fire yet either: the holder's
      // claim is still active.
      expect(await takeWokenEditIntentWaiters(tmp.path, ["shared.ts"], { hostBootID: currentHostBootID() })).toHaveLength(0)
      expect(await readEditIntentWaiters(tmp.path, { status: "waiting" })).toHaveLength(1)

      // The holder releases in the parent process; only the child's own
      // host-filtered poll can wake its waiter now.
      await releaseEditIntentClaims(tmp.path, "ses_holder", "session_idle")

      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `child waiter exited with code ${code}`)
      expect(stdout).toContain("WOKEN")

      // Exactly-once bookkeeping in the shared DB: the row flipped to woken
      // and kept the child's host identity.
      const woken = await readEditIntentWaiters(tmp.path, { status: "woken" })
      expect(woken).toHaveLength(1)
      expect(woken[0]!.hostBootID).toBe(childRow!.hostBootID)
      expect(woken[0]!.sessionID).toBe(childRow!.sessionID)

      // The child has now genuinely exited: its host identity is provably
      // dead, so a stale-boot sweep by any poller cancels leftovers stamped
      // with it — real dead-process cleanup, no synthetic pids. G1: the
      // child's woken row is swept too — a dead host can never act on its
      // wake, so its wake-priority hold must not outlive the sweep.
      await registerEditIntentWaiter(tmp.path, {
        sessionID: "ses_ghost",
        filePath: "shared.ts",
        blockerSessionID: "ses_holder",
        host: { pid: childRow!.hostPID!, bootID: childRow!.hostBootID! },
      })
      expect(await Effect.runPromise(EditIntentClaims.sweepStaleHosts({ projectRoot: tmp.path }))).toBe(2)
      expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_ghost", status: "cancelled" })).toHaveLength(1)
      expect(await readEditIntentWaiters(tmp.path, { sessionID: childRow!.sessionID, status: "cancelled" })).toHaveLength(1)
    } finally {
      child.kill()
    }
  }, 60_000)

  test("a wake stamped by a foreign process holds its G1 priority window in this process until the dead host is swept", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    await registerEditIntentClaims(tmp.path, {
      id: "predesign_parent",
      sessionID: "ses_holder",
      agent: "build",
      files: ["shared.ts"],
      intent: "holder work in the parent process",
    })

    const child = Bun.spawn({
      cmd: [process.execPath, worker, tmp.path, "shared.ts", "ses_holder"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    try {
      // Wait for the child's registration to surface in the shared DB.
      let childRow: EditIntentWaiterRecord | undefined
      for (let i = 0; i < 300 && !childRow; i++) {
        const waiting = await readEditIntentWaiters(tmp.path, { status: "waiting" })
        childRow = waiting.find((waiter) => waiter.hostBootID !== undefined && waiter.hostBootID !== currentHostBootID())
        if (!childRow) await Bun.sleep(100)
      }
      expect(childRow).toBeDefined()

      // Release in the parent; only the child's own host-filtered poll can
      // wake its waiter, stamping woken_at from the child process.
      await releaseEditIntentClaims(tmp.path, "ses_holder", "session_idle")
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `child waiter exited with code ${code}`)
      expect(stdout).toContain("WOKEN")

      // The foreign-stamped woken row is visible in the shared DB with its
      // window stamp set by the child process, not by this one.
      const woken = await readEditIntentWaiters(tmp.path, { sessionID: childRow!.sessionID, status: "woken" })
      expect(woken).toHaveLength(1)
      expect(woken[0]!.wokenAt).toBeDefined()

      // A fresh session in THIS process is soft-blocked by the child's
      // in-window wake: the priority window crosses the process boundary
      // through the shared DB, and no claim row is inserted for the newcomer.
      const blocked = await Effect.runPromise(
        EditIntentClaims.registerFromPredesign({
          projectRoot: tmp.path,
          sessionID: "ses_newcomer",
          agent: "build",
          predesignID: "predesign_newcomer",
          intent: "fresh arrival racing the woken child",
          files: ["shared.ts"],
        }),
      )
      expect(blocked.registered).toHaveLength(0)
      expect(blocked.conflicts).toHaveLength(1)
      expect(blocked.conflicts[0]!.wakePriority?.sessionID).toBe(childRow!.sessionID)

      // The child has exited: its host is provably dead, so the sweep drops
      // its inert priority hold and the newcomer registration then proceeds.
      expect(await Effect.runPromise(EditIntentClaims.sweepStaleHosts({ projectRoot: tmp.path }))).toBe(1)
      const cleared = await Effect.runPromise(
        EditIntentClaims.registerFromPredesign({
          projectRoot: tmp.path,
          sessionID: "ses_newcomer",
          agent: "build",
          predesignID: "predesign_newcomer_2",
          intent: "fresh arrival after the dead host was swept",
          files: ["shared.ts"],
        }),
      )
      expect(cleared.conflicts).toHaveLength(0)
      expect(cleared.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])
    } finally {
      child.kill()
    }
  }, 60_000)
})
