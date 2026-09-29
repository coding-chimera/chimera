import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { Database } from "../../src/storage/db"
import { Session as SessionNs } from "@/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionTurnLease } from "../../src/session/turn-lease"
import { SessionTurnLeaseTable } from "../../src/session/turn-lease.sql"
import { StorageMaintenanceTable } from "../../src/storage/maintenance.sql"
import { SessionID } from "../../src/session/schema"
import { SessionPartReconcile } from "../../src/session/part-reconcile"
import type { MessageV2 } from "../../src/session/message-v2"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

/** A pid that cannot exist on any supported platform, so kill(pid, 0) => ESRCH. */
const DEAD_PID = 2147483000

const dummy = {} as MessageV2.WithParts

const it = testEffect(
  Layer.mergeAll(
    SessionRunState.layer.pipe(Layer.provide(SessionStatus.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

function cleanup(sessionID: SessionID) {
  Database.use((db) => db.delete(SessionTurnLeaseTable).where(eq(SessionTurnLeaseTable.session_id, sessionID)).run())
}

describe("SessionTurnLease storage semantics", () => {
  test("acquire claims the session and release removes only the owner's row", () => {
    const sessionID = SessionID.descending()
    try {
      const now = Date.now()
      expect(SessionTurnLease.acquire(sessionID, { now }).acquired).toBe(true)
      const holder = SessionTurnLease.read(sessionID)
      expect(holder?.ownerBootID).toBe(SessionTurnLease.currentBootID())
      expect(holder?.ownerPID).toBe(process.pid)
      expect(holder?.acquiredAt).toBe(now)
      expect(holder?.expiresAt).toBe(now + SessionTurnLease.LEASE_TTL_MS)

      // A foreign release never touches the row (owner-guarded delete).
      SessionTurnLease.release(sessionID, { bootID: "boot_foreign" })
      expect(SessionTurnLease.read(sessionID)).toBeDefined()

      SessionTurnLease.release(sessionID)
      expect(SessionTurnLease.read(sessionID)).toBeUndefined()
    } finally {
      cleanup(sessionID)
    }
  })

  test("a live foreign lease blocks acquire and names the holder", () => {
    const sessionID = SessionID.descending()
    const bootID = `boot_sibling_${process.pid}`
    try {
      // Foreign boot id stamped with our own pid: while this process runs no
      // other process can hold the pid, so the liveness probe counts it alive.
      expect(SessionTurnLease.acquire(sessionID, { bootID, pid: process.pid }).acquired).toBe(true)

      const attempt = SessionTurnLease.acquire(sessionID)
      expect(attempt.acquired).toBe(false)
      if (!attempt.acquired) {
        expect(attempt.holder.ownerBootID).toBe(bootID)
        expect(attempt.holder.ownerPID).toBe(process.pid)
      }
      // The blocked acquire did not clobber the holder's row.
      expect(SessionTurnLease.read(sessionID)?.ownerBootID).toBe(bootID)
    } finally {
      cleanup(sessionID)
    }
  })

  test("an expired foreign lease is taken over", () => {
    const sessionID = SessionID.descending()
    const bootID = `boot_expired_${process.pid}`
    try {
      const stale = SessionTurnLease.acquire(sessionID, {
        bootID,
        pid: process.pid,
        now: Date.now() - SessionTurnLease.LEASE_TTL_MS - 1000,
      })
      expect(stale.acquired).toBe(true)

      const attempt = SessionTurnLease.acquire(sessionID)
      expect(attempt.acquired).toBe(true)
      expect(SessionTurnLease.read(sessionID)?.ownerBootID).toBe(SessionTurnLease.currentBootID())
    } finally {
      cleanup(sessionID)
    }
  })

  test("the same boot re-acquires and refreshes its own lease", () => {
    const sessionID = SessionID.descending()
    try {
      const first = Date.now() - 60_000
      expect(SessionTurnLease.acquire(sessionID, { now: first }).acquired).toBe(true)
      const second = Date.now()
      expect(SessionTurnLease.acquire(sessionID, { now: second }).acquired).toBe(true)
      const holder = SessionTurnLease.read(sessionID)
      expect(holder?.acquiredAt).toBe(second)
      expect(holder?.expiresAt).toBe(second + SessionTurnLease.LEASE_TTL_MS)
    } finally {
      cleanup(sessionID)
    }
  })

  test("an unexpired lease whose owner is provably dead is inherited without waiting out the TTL", () => {
    const sessionID = SessionID.descending()
    try {
      // Crash leftover: a killed host cannot release, so its row is unexpired.
      const leftover = SessionTurnLease.acquire(sessionID, { bootID: "boot_crashed_1", pid: DEAD_PID })
      expect(leftover.acquired).toBe(true)

      const attempt = SessionTurnLease.acquire(sessionID)
      expect(attempt.acquired).toBe(true)
      expect(SessionTurnLease.read(sessionID)?.ownerBootID).toBe(SessionTurnLease.currentBootID())
    } finally {
      cleanup(sessionID)
    }
  })

  test("renewAll extends own leases and leaves foreign rows untouched", () => {
    const own = SessionID.descending()
    const foreign = SessionID.descending()
    const foreignBoot = `boot_foreign_${process.pid}`
    try {
      expect(SessionTurnLease.acquire(own).acquired).toBe(true)
      expect(SessionTurnLease.acquire(foreign, { bootID: foreignBoot, pid: process.pid }).acquired).toBe(true)
      const foreignExpiry = SessionTurnLease.read(foreign)?.expiresAt

      const later = Date.now() + 5 * 60 * 1000
      SessionTurnLease.renewAll({ now: later })
      expect(SessionTurnLease.read(own)?.expiresAt).toBe(later + SessionTurnLease.LEASE_TTL_MS)
      expect(SessionTurnLease.read(foreign)?.expiresAt).toBe(foreignExpiry)
    } finally {
      cleanup(own)
      cleanup(foreign)
    }
  })
})

const waitForLease = (sessionID: SessionID, matches?: (holder: SessionTurnLease.Holder) => boolean) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < 500; tick++) {
      const holder = yield* Effect.sync(() => SessionTurnLease.read(sessionID))
      if (holder && (!matches || matches(holder))) return holder
      yield* Effect.sleep("10 millis")
    }
    throw new Error("turn lease never appeared")
  })

const waitForNoLease = (sessionID: SessionID) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < 500; tick++) {
      const holder = yield* Effect.sync(() => SessionTurnLease.read(sessionID))
      if (!holder) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error("turn lease was never released")
  })

describe("SessionRunState turn-lease integration", () => {
  it.live(
    "a single-process turn acquires the lease on busy and releases it on idle",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const sessionID = SessionID.descending()
          try {
            const gate = yield* Deferred.make<void>()
            const fiber = yield* run
              .ensureRunning(sessionID, Effect.succeed(dummy), Deferred.await(gate).pipe(Effect.as(dummy)))
              .pipe(Effect.forkChild)

            const holder = yield* waitForLease(sessionID)
            expect(holder.ownerBootID).toBe(SessionTurnLease.currentBootID())
            expect(holder.ownerPID).toBe(process.pid)
            expect(holder.expiresAt).toBeGreaterThan(Date.now())
            // onBusy wiring: busy registry marked and the turn-start orphan
            // reconciliation ran (its boot marker is written even for a
            // session with zero residue).
            expect(SessionPartReconcile.isBusy(sessionID)).toBe(true)
            const marker = Database.use((db) =>
              db
                .select()
                .from(StorageMaintenanceTable)
                .where(eq(StorageMaintenanceTable.key, SessionPartReconcile.markerKey(sessionID, SessionTurnLease.currentBootID())))
                .get(),
            )
            expect(marker).toBeDefined()

            // A second turn start on the same session while busy must not
            // disturb the held lease (Runner serializes in-process).
            expect(SessionTurnLease.acquire(sessionID).acquired).toBe(true)
            expect(SessionTurnLease.read(sessionID)?.ownerBootID).toBe(SessionTurnLease.currentBootID())

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.await(fiber)
            yield* waitForNoLease(sessionID)
            expect(SessionPartReconcile.isBusy(sessionID)).toBe(false)
          } finally {
            cleanup(sessionID)
          }
        }),
      ),
    30_000,
  )

  it.live(
    "a live foreign lease turns assertNotBusy and ensureRunning into an actionable busy error",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const sessionID = SessionID.descending()
          const bootID = `boot_sibling_${process.pid}`
          try {
            const claimed = yield* Effect.sync(() => SessionTurnLease.acquire(sessionID, { bootID, pid: process.pid }))
            expect(claimed.acquired).toBe(true)

            const probe = yield* run.assertNotBusy(sessionID).pipe(Effect.exit)
            expect(Exit.isFailure(probe)).toBe(true)
            if (Exit.isFailure(probe)) {
              const err = Cause.squash(probe.cause)
              // Reuses the existing busy error family (middleware instanceof
              // mapping keeps working) with a holder-naming message.
              expect(err).toBeInstanceOf(SessionNs.BusyError)
              expect(err).toBeInstanceOf(SessionRunState.RemoteBusyError)
              expect((err as Error).message).toContain("another chimera process")
              expect((err as Error).message).toContain(bootID)
              expect((err as Error).message).toContain(String(process.pid))
            }

            const start = yield* run.ensureRunning(sessionID, Effect.succeed(dummy), Effect.succeed(dummy)).pipe(Effect.exit)
            expect(Exit.isFailure(start)).toBe(true)
            if (Exit.isFailure(start)) {
              expect(Cause.squash(start.cause)).toBeInstanceOf(SessionRunState.RemoteBusyError)
            }
            // The failed start left the foreign lease untouched.
            expect(SessionTurnLease.read(sessionID)?.ownerBootID).toBe(bootID)
          } finally {
            yield* Effect.sync(() => SessionTurnLease.release(sessionID, { bootID }))
            cleanup(sessionID)
          }
        }),
      ),
    30_000,
  )

  it.live(
    "a dead host's unexpired lease neither trips assertNotBusy nor blocks the next turn",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const sessionID = SessionID.descending()
          try {
            const leftover = yield* Effect.sync(() =>
              SessionTurnLease.acquire(sessionID, { bootID: "boot_dead_host", pid: DEAD_PID }),
            )
            expect(leftover.acquired).toBe(true)

            yield* run.assertNotBusy(sessionID)

            const gate = yield* Deferred.make<void>()
            const fiber = yield* run
              .ensureRunning(sessionID, Effect.succeed(dummy), Deferred.await(gate).pipe(Effect.as(dummy)))
              .pipe(Effect.forkChild)
            const holder = yield* waitForLease(sessionID, (item) => item.ownerBootID === SessionTurnLease.currentBootID())
            // The restarted process inherited the dead host's lease.
            expect(holder.ownerBootID).toBe(SessionTurnLease.currentBootID())

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.await(fiber)
            yield* waitForNoLease(sessionID)
          } finally {
            cleanup(sessionID)
          }
        }),
      ),
    30_000,
  )
})
