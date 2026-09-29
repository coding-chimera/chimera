import { describe, expect, test } from "bun:test"
import path from "path"
import { Database as Sqlite } from "bun:sqlite"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "turn-lease-worker.ts")

/**
 * Real dual-process integration for the session turn lease: two bun processes
 * (TS source — the allowed lane, no fresh executables) share one file-backed
 * chimera.db via OPENCODE_DB and exercise the exact mutual-exclusion rules two
 * chimera CLI processes would — a live sibling blocks with the holder named,
 * and a SIGKILLed holder's unexpired lease is inherited immediately through
 * the pid-liveness probe instead of stalling the session for the whole TTL.
 * Modeled on test/chimera/edit-intent-cross-process.test.ts; the DB is the
 * sync medium (not stdout), which also absorbs bun cold start.
 */

type LeaseRow = { owner_boot_id: string; owner_pid: number; expires_at: number }

function leaseRow(dbPath: string, sessionID: string): LeaseRow | undefined {
  const db = new Sqlite(dbPath)
  try {
    const row = db
      .query("SELECT owner_boot_id, owner_pid, expires_at FROM session_turn_lease WHERE session_id = ?")
      .get(sessionID) as LeaseRow | null
    return row ?? undefined
  } catch {
    // Table not created yet (first worker still applying migrations).
    return undefined
  } finally {
    db.close()
  }
}

function spawn(mode: "hold" | "take", sessionID: string, dbPath: string, holdMs?: number) {
  return Bun.spawn({
    cmd: [process.execPath, worker, mode, sessionID, ...(holdMs === undefined ? [] : [String(holdMs)])],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DB: dbPath },
  })
}

async function settled(child: ReturnType<typeof spawn>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ])
  return { code, stdout, stderr }
}

describe("turn-lease cross-process mutex (dual bun processes, shared file DB)", () => {
  test(
    "a live sibling blocks with the holder named, and a killed holder's lease is inherited without waiting out the TTL",
    async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "shared.db")
      const sessionID = "ses_xproc_turn_lease"
      const holder = spawn("hold", sessionID, dbPath, 60_000)
      try {
        // Wait for the holder's acquire to surface in the shared DB.
        let row: LeaseRow | undefined
        for (let tick = 0; tick < 300 && !row; tick++) {
          row = leaseRow(dbPath, sessionID)
          if (!row) await Bun.sleep(100)
        }
        expect(row).toBeDefined()
        expect(row!.owner_pid).not.toBe(process.pid)
        expect(row!.expires_at).toBeGreaterThan(Date.now())

        // Live sibling: the second process is refused and its BUSY line names
        // the holder identity, so the surfaced error is actionable.
        const blocked = await settled(spawn("take", sessionID, dbPath))
        expect(blocked.code).toBe(1)
        expect(blocked.stdout).toContain("BUSY")
        expect(blocked.stdout).toContain(row!.owner_boot_id)
        expect(leaseRow(dbPath, sessionID)?.owner_boot_id).toBe(row!.owner_boot_id)

        // SIGKILL the holder (crash simulation — it cannot release), and reap
        // it so its pid is provably dead for the liveness probe.
        holder.kill(9)
        await holder.exited
        const leftover = leaseRow(dbPath, sessionID)
        expect(leftover).toBeDefined()
        expect(leftover!.expires_at).toBeGreaterThan(Date.now())

        // The "restarted" process inherits the crash leftover immediately
        // instead of stalling for the remaining TTL.
        const heir = await settled(spawn("take", sessionID, dbPath))
        if (heir.code !== 0) throw new Error(heir.stderr.trim() || heir.stdout.trim() || `heir exited ${heir.code}`)
        expect(heir.stdout).toContain("ACQUIRED")
        expect(heir.stdout).toContain("RELEASED")
        expect(leaseRow(dbPath, sessionID)).toBeUndefined()
      } finally {
        holder.kill()
      }
    },
    90_000,
  )
})
