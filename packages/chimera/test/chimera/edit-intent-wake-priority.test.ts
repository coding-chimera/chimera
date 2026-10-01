import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { EditIntentClaims, WAKE_PRIORITY_WINDOW_MS } from "@/chimera/edit-intent"
import {
  cancelEditIntentWaiters,
  readActiveEditIntentClaims,
  readEditIntentWaiters,
  readWokenEditIntentWaiters,
  registerEditIntentClaims,
  registerEditIntentWaiter,
  releaseEditIntentClaims,
  takeWokenEditIntentWaiters,
} from "@/chimera/store"
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

function claimInput(id: string, sessionID: string, files: string[], intent = "declared work") {
  return { id, sessionID, agent: "build", files, intent }
}

function predesignInput(sessionID: string, predesignID: string, files: string[], intent = "re-claim after wake") {
  return { projectRoot: "", sessionID, agent: "build", predesignID, intent, files }
}

const MINUTE_MS = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** A holds the file; B and C queue as waiters (B first); A releases and both are woken FIFO. */
async function wakeTwoWaiters(root: string, options: { wakeNow?: string } = {}) {
  await registerEditIntentClaims(root, claimInput("predesign_a", "ses_a", ["shared.ts"]))
  await registerEditIntentWaiter(root, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a", now: ago(2_000) })
  await registerEditIntentWaiter(root, { sessionID: "ses_c", filePath: "shared.ts", blockerSessionID: "ses_a", now: ago(1_000) })
  await releaseEditIntentClaims(root, "ses_a", "session_idle")
  return takeWokenEditIntentWaiters(root, ["shared.ts"], options.wakeNow ? { now: options.wakeNow } : {})
}

describe("wake-priority handoff store primitives (G1)", () => {
  test("the wake stamps woken_at and the window read filters by recency and session", async () => {
    await using tmp = await dbDir()
    const woken = await wakeTwoWaiters(tmp.path)
    expect(woken.map((waiter) => waiter.sessionID)).toEqual(["ses_b", "ses_c"])
    expect(woken.every((waiter) => waiter.wokenAt !== undefined)).toBe(true)

    const inWindow = await readWokenEditIntentWaiters(tmp.path, {
      files: ["shared.ts"],
      wokenSince: ago(WAKE_PRIORITY_WINDOW_MS),
    })
    expect(inWindow.map((waiter) => waiter.sessionID)).toEqual(["ses_b", "ses_c"])

    const excludingB = await readWokenEditIntentWaiters(tmp.path, {
      files: ["shared.ts"],
      wokenSince: ago(WAKE_PRIORITY_WINDOW_MS),
      excludeSessionID: "ses_b",
    })
    expect(excludingB.map((waiter) => waiter.sessionID)).toEqual(["ses_c"])

    // A window start after the wake stamp finds nothing — expiry is the read filter.
    expect(await readWokenEditIntentWaiters(tmp.path, { files: ["shared.ts"], wokenSince: new Date(Date.now() + 1_000).toISOString() })).toHaveLength(0)
  })

  test("pre-v7 rows with NULL woken_at never enter the priority window (legacy compatibility)", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a" })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    // Simulate a wake performed by an old binary: status flipped, no stamp.
    const connection = DatabaseConnection.initialize(getDatabasePath(tmp.path))
    connection.getDb().prepare("UPDATE chimera_edit_intent_waiter SET status = 'woken', updated_at = ? WHERE session_id = 'ses_b'").run(ago(1_000))
    connection.close()

    expect(await readWokenEditIntentWaiters(tmp.path, { files: ["shared.ts"], wokenSince: ago(WAKE_PRIORITY_WINDOW_MS) })).toHaveLength(0)
    // A fresh arrival is not soft-blocked by an un-stamped legacy row: pre-G1 behavior.
    const registered = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_c", "predesign_c", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(registered.conflicts).toHaveLength(0)
    expect(registered.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])
  })

  test("a successful claim registration cancels the session's woken rows; a re-queue clears woken_at", async () => {
    await using tmp = await dbDir()
    await wakeTwoWaiters(tmp.path)

    await registerEditIntentClaims(tmp.path, claimInput("predesign_b", "ses_b", ["shared.ts"]))
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "woken" })).toHaveLength(0)
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "cancelled" })).toHaveLength(1)
    // The other session's in-window hold is untouched.
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_c", status: "woken" })).toHaveLength(1)

    // A blocked re-registration flips the woken row back to waiting and drops the stale stamp.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "shared.ts", blockerSessionID: "ses_b" })
    const requeued = await readEditIntentWaiters(tmp.path, { sessionID: "ses_c", status: "waiting" })
    expect(requeued).toHaveLength(1)
    expect(requeued[0]!.wokenAt).toBeUndefined()
  })

  test("dead woken sessions stop holding: session removal and dead-host sweeps cancel woken rows", async () => {
    await using tmp = await dbDir()
    // Session removal cancels the removed session's own woken hold immediately.
    await wakeTwoWaiters(tmp.path)
    await Effect.runPromise(EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_b", reason: "session_removed" }))
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "cancelled" })).toHaveLength(1)
    // C's registration is no longer soft-blocked by the removed session.
    const registered = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_c", "predesign_c", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(registered.conflicts).toHaveLength(0)

    // A dead host's woken rows are inert garbage: the stale-boot sweep cancels them.
    await using tmp2 = await dbDir()
    await registerEditIntentClaims(tmp2.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentWaiter(tmp2.path, {
      sessionID: "ses_dead",
      filePath: "f.ts",
      blockerSessionID: "ses_a",
      host: { pid: 99999997, bootID: "boot_1_99999997" },
    })
    await releaseEditIntentClaims(tmp2.path, "ses_a", "session_idle")
    expect(await takeWokenEditIntentWaiters(tmp2.path, ["f.ts"])).toHaveLength(1)
    expect(await Effect.runPromise(EditIntentClaims.sweepStaleHosts({ projectRoot: tmp2.path }))).toBe(1)
    expect(await readEditIntentWaiters(tmp2.path, { sessionID: "ses_dead", status: "cancelled" })).toHaveLength(1)
    expect(await cancelEditIntentWaiters(tmp2.path, "ses_dead")).toBe(0)
  })
})

describe("wake-priority handoff coordination (G1)", () => {
  test("three-session handoff: a fresh arrival is soft-blocked in-window, the first waiter re-claims cleanly and the arrival re-queues", async () => {
    await using tmp = await dbDir()
    const woken = await wakeTwoWaiters(tmp.path)
    expect(woken.map((waiter) => waiter.sessionID)).toEqual(["ses_b", "ses_c"])

    // C reacts first but the wake-priority window belongs to B: C gets no claim row.
    const cRegistration = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_c", "predesign_c", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(cRegistration.registered).toHaveLength(0)
    expect(cRegistration.conflicts).toHaveLength(1)
    expect(cRegistration.conflicts[0]!.wakePriority?.sessionID).toBe("ses_b")
    expect(cRegistration.conflicts[0]!.holder.sessionID).toBe("ses_b")
    expect(await readActiveEditIntentClaims(tmp.path, { files: ["shared.ts"] })).toHaveLength(0)
    // C re-queued as a waiter behind B so B's release reaches it.
    const cWaiter = await readEditIntentWaiters(tmp.path, { sessionID: "ses_c", status: "waiting" })
    expect(cWaiter).toHaveLength(1)
    expect(cWaiter[0]!.blockerSessionID).toBe("ses_b")

    // The mutation gate blocks C with the wake-priority wording and metadata.
    const gateConflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_c",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    expect(gateConflicts).toHaveLength(1)
    const blocked = EditIntentClaims.blockedResult({ toolID: "edit", conflicts: gateConflicts })
    expect(blocked.output).toContain("held in wake-priority window by session ses_b (first waiter, woken")
    expect(blocked.output).toContain("A wake-priority hold is time-bounded")
    const metadata = blocked.metadata as { conflicts: Array<Record<string, unknown>> }
    expect(metadata.conflicts[0]!.wakePrioritySessionID).toBe("ses_b")
    expect(typeof metadata.conflicts[0]!.wakePriorityWindowExpiresAt).toBe("string")

    // B's own registration is never blocked by its own priority row.
    const bRegistration = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_b", "predesign_b", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(bRegistration.conflicts).toHaveLength(0)
    expect(bRegistration.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])
    // B's woken row is cancelled so the window cannot keep blocking others.
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "woken" })).toHaveLength(0)

    // C's gate now sees B's real claim (normal queueing), and B's release wakes C.
    const afterClaim = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_c",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    expect(afterClaim).toHaveLength(1)
    expect(afterClaim[0]!.wakePriority).toBeUndefined()
    expect(afterClaim[0]!.holder.sessionID).toBe("ses_b")

    const targets = await Effect.runPromise(
      EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_b", reason: "session_idle" }),
    )
    expect(targets.map((target) => target.sessionID)).toEqual(["ses_c"])
  })

  test("window expiry falls back to the free race: a stale wake never deadlocks a fresh arrival", async () => {
    await using tmp = await dbDir()
    // Wake stamped 11 minutes in the past: outside the 10-minute window.
    await wakeTwoWaiters(tmp.path, { wakeNow: ago(WAKE_PRIORITY_WINDOW_MS + MINUTE_MS) })

    const registered = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_c", "predesign_c", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(registered.conflicts).toHaveLength(0)
    expect(registered.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])

    const gateConflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_b",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    // B is soft-blocked by nothing (its own row is self-skipped) but by C's real claim.
    expect(gateConflicts).toHaveLength(1)
    expect(gateConflicts[0]!.wakePriority).toBeUndefined()
    expect(gateConflicts[0]!.holder.sessionID).toBe("ses_c")
  })

  test("a claim that lands before the wake stamp keeps its FIFO rank at the gate", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a" })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    // Model the take/register interleave: B's wake stamps slightly ahead while
    // C's claim commits between the take's remaining-check and the stamp, so
    // C's claim predates wokenAt and C was never soft-blocked at registration.
    const woken = await takeWokenEditIntentWaiters(tmp.path, ["shared.ts"], { now: new Date(Date.now() + 5_000).toISOString() })
    expect(woken.map((waiter) => waiter.sessionID)).toEqual(["ses_b"])
    await registerEditIntentClaims(tmp.path, claimInput("predesign_c", "ses_c", ["shared.ts"]))

    // C's claim predates B's wake stamp: the pre-existing claim queue stays
    // authoritative and the gate must not soft-block C.
    const gateConflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_c",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    expect(gateConflicts).toHaveLength(0)

    // B's registration queues behind C's earlier claim and re-queues B as a waiter.
    const bRegistration = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_b", "predesign_b", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(bRegistration.conflicts).toHaveLength(1)
    expect(bRegistration.conflicts[0]!.wakePriority).toBeUndefined()
    expect(bRegistration.conflicts[0]!.holder.sessionID).toBe("ses_c")
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "waiting" })).toHaveLength(1)
  })

  test("a post-wake raced claim is yielded at re-registration so the handoff cannot invert", async () => {
    await using tmp = await dbDir()
    // Wake B with a stamp clearly in the past so C's raced claim is strictly newer.
    await wakeTwoWaiters(tmp.path, { wakeNow: ago(5_000) })
    // Old-binary style race: C grabs the file during B's window via the raw store.
    await registerEditIntentClaims(tmp.path, claimInput("predesign_c_race", "ses_c", ["shared.ts"]))

    // C's next predesign (new binary) yields the raced claim to the priority holder.
    const cRegistration = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_c", "predesign_c_2", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(cRegistration.registered).toHaveLength(0)
    expect(cRegistration.conflicts).toHaveLength(1)
    expect(cRegistration.conflicts[0]!.wakePriority?.sessionID).toBe("ses_b")
    expect(cRegistration.conflicts[0]!.yieldedOwnClaim).toBe(true)
    const raced = await readActiveEditIntentClaims(tmp.path, { files: ["shared.ts"], sessionID: "ses_c" })
    expect(raced).toHaveLength(0)
    const blocked = EditIntentClaims.blockedResult({ toolID: "edit", conflicts: cRegistration.conflicts })
    expect(blocked.output).toContain("your earlier queued claim was yielded to it")

    // C re-queued as a waiter; B's registration is clean; B's release wakes C.
    const cWaiter = await readEditIntentWaiters(tmp.path, { sessionID: "ses_c", status: "waiting" })
    expect(cWaiter).toHaveLength(1)
    expect(cWaiter[0]!.blockerSessionID).toBe("ses_b")
    const bRegistration = await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({ ...predesignInput("ses_b", "predesign_b", ["shared.ts"]), projectRoot: tmp.path }),
    )
    expect(bRegistration.conflicts).toHaveLength(0)
    expect(bRegistration.registered).toHaveLength(1)
    const targets = await Effect.runPromise(
      EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_b", reason: "session_idle" }),
    )
    expect(targets.map((target) => target.sessionID)).toEqual(["ses_c"])
  })
})
