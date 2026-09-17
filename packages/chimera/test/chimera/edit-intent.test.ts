import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { CodeGraph, getCodeGraphDir, DatabaseConnection, getDatabasePath } from "@/graph"
import { Chimera } from "@/chimera"
import { EditIntentClaims } from "@/chimera/edit-intent"
import {
  readActiveEditIntentClaims,
  readEditIntentWaiters,
  recordPredesignRun,
  registerEditIntentClaims,
  registerEditIntentWaiter,
  releaseEditIntentClaims,
  takeWokenEditIntentWaiters,
} from "@/chimera/store"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdir, TestInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

function claimInput(id: string, sessionID: string, files: string[], intent = "declared work") {
  return { id, sessionID, agent: "build", files, intent }
}

function gateCtx(sessionID: string) {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_edit_intent_test"),
    callID: `call_${sessionID}`,
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

/** Store functions only open an existing project DB; they must never create graph data. */
async function dbDir() {
  const tmp = await tmpdir()
  DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
  return tmp
}

describe("edit-intent claims store", () => {
  test("claim lifecycle: register, read with filters, release, wake exactly once", async () => {
    await using tmp = await dbDir()
    const registered = await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts", "other.ts"]))
    expect(registered.map((claim) => claim.filePath)).toEqual(["shared.ts", "other.ts"])
    expect(registered.every((claim) => claim.status === "active")).toBe(true)

    const active = await readActiveEditIntentClaims(tmp.path, { files: ["shared.ts"] })
    expect(active).toHaveLength(1)
    expect(active[0]!.sessionID).toBe("ses_a")
    expect(await readActiveEditIntentClaims(tmp.path, { files: ["shared.ts"], excludeSessionID: "ses_a" })).toHaveLength(0)
    expect(await readActiveEditIntentClaims(tmp.path, { sessionID: "ses_a" })).toHaveLength(2)

    // Waiter registration is an upsert per (session, file): a repeated block
    // while waiting must not create duplicate wake targets.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a", reason: "mutation_gate:edit" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a", reason: "mutation_gate:edit" })
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "waiting" })).toHaveLength(1)

    const released = await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    expect(released.map((claim) => claim.filePath).sort()).toEqual(["other.ts", "shared.ts"])
    expect(released.every((claim) => claim.status === "released" && claim.releaseReason === "session_idle")).toBe(true)
    expect(await readActiveEditIntentClaims(tmp.path)).toHaveLength(0)

    const woken = await takeWokenEditIntentWaiters(tmp.path, ["shared.ts", "other.ts"])
    expect(woken).toHaveLength(1)
    expect(woken[0]!.sessionID).toBe("ses_b")
    expect(woken[0]!.filePath).toBe("shared.ts")
    // Exactly-once: the flipped row never wakes again.
    expect(await takeWokenEditIntentWaiters(tmp.path, ["shared.ts"])).toHaveLength(0)
  })

  test("TTL is a lazy crash fallback: expired claims stop blocking and flip status", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, { ...claimInput("predesign_ttl", "ses_a", ["x.ts"]), ttlMs: 60_000 })
    const future = new Date(Date.now() + 61_000).toISOString()
    expect(await readActiveEditIntentClaims(tmp.path, { now: future })).toHaveLength(0)
    // The expiry was persisted, not just filtered: a current-time read stays empty.
    expect(await readActiveEditIntentClaims(tmp.path)).toHaveLength(0)
    // An expired holder no longer suppresses waiter wakes.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "x.ts", blockerSessionID: "ses_a" })
    expect(await takeWokenEditIntentWaiters(tmp.path, ["x.ts"])).toHaveLength(1)
  })

  test("a waiter wakes only after the last holder of the file releases", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentClaims(tmp.path, claimInput("predesign_c", "ses_c", ["f.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a" })

    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    expect(await takeWokenEditIntentWaiters(tmp.path, ["f.ts"])).toHaveLength(0)

    await releaseEditIntentClaims(tmp.path, "ses_c", "session_idle")
    expect(await takeWokenEditIntentWaiters(tmp.path, ["f.ts"])).toHaveLength(1)
  })

  test("concurrent takers racing the same release wake a waiter exactly once", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "f.ts", blockerSessionID: "ses_a" })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")

    const results = await Promise.all([
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"]),
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"]),
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"]),
    ])
    const woken = results.flat()
    expect(woken).toHaveLength(2)
    expect(new Set(woken.map((waiter) => waiter.sessionID))).toEqual(new Set(["ses_b", "ses_c"]))
    for (const batch of results) {
      for (const waiter of batch) expect(waiter.status).toBe("woken")
    }
  })

  test("releaseForSession groups wake targets per waiting session and renders the wake text", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f1.ts", "f2.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f1.ts", blockerSessionID: "ses_a" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f2.ts", blockerSessionID: "ses_a" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "f1.ts", blockerSessionID: "ses_a" })

    const targets = await Effect.runPromise(
      EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_a", reason: "session_idle" }),
    )
    expect(targets).toHaveLength(2)
    const b = targets.find((target) => target.sessionID === "ses_b")!
    expect(b.files.map((file) => file.filePath).sort()).toEqual(["f1.ts", "f2.ts"])
    expect(b.reason).toBe("session_idle")
    const text = EditIntentClaims.wakeText(b)
    expect(text).toContain("<edit_intent_release>")
    expect(text).toContain("</edit_intent_release>")
    expect(text).toContain("f1.ts (was held by session ses_a)")
    expect(text).toContain("the holder's run completed")
    // Idempotent: a second release for the same session yields no targets.
    expect(
      await Effect.runPromise(EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_a", reason: "session_idle" })),
    ).toHaveLength(0)
  })

  test("session removal releases claims and cancels the removed session's own waiters", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_a", filePath: "g.ts", blockerSessionID: "ses_z" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a" })

    const targets = await Effect.runPromise(
      EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_a", reason: "session_removed" }),
    )
    expect(targets.map((target) => target.sessionID)).toEqual(["ses_b"])
    expect(targets[0]!.reason).toBe("session_removed")
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_a", status: "waiting" })).toHaveLength(0)
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_a", status: "cancelled" })).toHaveLength(1)
  })

  test("drainForSession wakes a session's own waiters that freed up while it was busy", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a" })
    // Model a release whose wake pass could not reach ses_b (busy loop): the
    // raw store release leaves the waiter pending.
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")

    const targets = await Effect.runPromise(EditIntentClaims.drainForSession({ projectRoot: tmp.path, sessionID: "ses_b" }))
    expect(targets).toHaveLength(1)
    expect(targets[0]!.files.map((file) => file.filePath)).toEqual(["f.ts"])
    expect(targets[0]!.reason).toBeUndefined()
    expect(await Effect.runPromise(EditIntentClaims.drainForSession({ projectRoot: tmp.path, sessionID: "ses_b" }))).toHaveLength(0)
  })

  test("claims degrade open when no database exists", async () => {
    await using tmp = await tmpdir()
    const conflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_b",
        toolID: "edit",
        files: [{ absolutePath: path.join(tmp.path, "f.ts"), graphPath: "f.ts" }],
      }),
    )
    expect(conflicts).toHaveLength(0)
    expect(await Effect.runPromise(EditIntentClaims.releaseForSession({ projectRoot: tmp.path, sessionID: "ses_a", reason: "session_idle" }))).toHaveLength(0)
    expect(await Effect.runPromise(EditIntentClaims.drainForSession({ projectRoot: tmp.path, sessionID: "ses_b" }))).toHaveLength(0)
    expect(await Effect.runPromise(EditIntentClaims.registerFromPredesign({
      projectRoot: tmp.path,
      sessionID: "ses_a",
      agent: "build",
      predesignID: "predesign_a",
      intent: "no db",
      files: ["f.ts"],
    }))).toEqual({ registered: [], conflicts: [] })
  })
})

describe("edit-intent claim gate (requirePredesignForMutation)", () => {
  const initGraph = Effect.fnUntraced(function* () {
    const test = yield* TestInstance
    const graph = yield* Effect.promise(() => CodeGraph.init(test.directory))
    graph.close()
    return test
  })

  it.instance("blocks another session's mutation on a claimed file and queues it as a waiter", () =>
    Effect.gen(function* () {
      const test = yield* initGraph()
      yield* EditIntentClaims.registerFromPredesign({
        projectRoot: test.directory,
        sessionID: "ses_holder",
        agent: "build",
        predesignID: "predesign_holder",
        intent: "holder refactor of the shared surface",
        files: ["shared.ts"],
      })

      const decision = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_waiter"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(decision.allowed).toBe(false)
      if (decision.allowed) return
      expect(decision.blockedBy).toBe("edit-intent-claim")
      expect(decision.result.title).toBe("Chimera edit-intent claim conflict")
      expect(decision.result.output).toContain("ses_holder")
      expect(decision.result.output).toContain("holder refactor of the shared surface")
      expect(decision.result.output).toContain("Do not retry this mutation in a loop")
      // The blocked session queued itself for the release wake.
      const waiters = yield* Effect.promise(() => readEditIntentWaiters(test.directory, { sessionID: "ses_waiter", status: "waiting" }))
      expect(waiters).toHaveLength(1)
      expect(waiters[0]!.filePath).toBe("shared.ts")
      expect(waiters[0]!.blockerSessionID).toBe("ses_holder")
    }),
  )

  it.instance("gates non-risky claimed files too, and releasing unblocks the waiter", () =>
    Effect.gen(function* () {
      const test = yield* initGraph()
      yield* Effect.promise(() => registerEditIntentClaims(test.directory, claimInput("predesign_a", "ses_a", ["notes.md"])))

      const blocked = yield* Chimera.requirePredesignForMutation({
        toolID: "write",
        ctx: gateCtx("ses_b"),
        files: [path.join(test.directory, "notes.md")],
      })
      expect(blocked.allowed).toBe(false)
      if (!blocked.allowed) expect(blocked.blockedBy).toBe("edit-intent-claim")

      yield* EditIntentClaims.releaseForSession({ projectRoot: test.directory, sessionID: "ses_a", reason: "session_idle" })
      const allowed = yield* Chimera.requirePredesignForMutation({
        toolID: "write",
        ctx: gateCtx("ses_b"),
        files: [path.join(test.directory, "notes.md")],
      })
      expect(allowed.allowed).toBe(true)
      if (allowed.allowed) expect(allowed.required).toBe(false)
    }),
  )

  it.instance("never blocks the holder's own mutation on its claimed file", () =>
    Effect.gen(function* () {
      const test = yield* initGraph()
      yield* Effect.promise(() => registerEditIntentClaims(test.directory, claimInput("predesign_self", "ses_self", ["shared.ts"])))
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, path.join(getCodeGraphDir(test.directory), "chimera", "predesign-runs.jsonl"), {
          sessionID: SessionID.make("ses_self"),
          messageID: MessageID.make("msg_self"),
          agent: "build",
          intent: "own declared work",
          files: ["shared.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test_revision",
          payload: {},
        }),
      )

      const decision = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_self"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(decision.allowed).toBe(true)
    }),
  )

  it.instance("queues a later predesign behind the active holder and reports the conflict with queued state", () =>
    Effect.gen(function* () {
      const test = yield* initGraph()
      yield* Effect.promise(() => registerEditIntentClaims(test.directory, claimInput("predesign_a", "ses_a", ["shared.ts"], "first refactor")))
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, path.join(getCodeGraphDir(test.directory), "chimera", "predesign-runs.jsonl"), {
          sessionID: SessionID.make("ses_a"),
          messageID: MessageID.make("msg_a"),
          agent: "build",
          intent: "first refactor",
          files: ["shared.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test_revision",
          payload: {},
        }),
      )
      yield* Effect.promise(() =>
        recordPredesignRun(test.directory, path.join(getCodeGraphDir(test.directory), "chimera", "predesign-runs.jsonl"), {
          sessionID: SessionID.make("ses_b"),
          messageID: MessageID.make("msg_b"),
          agent: "build",
          intent: "second refactor",
          files: ["shared.ts"],
          seedNodes: [],
          impactedNodes: [],
          fileDependents: [],
          evidence: [],
          snapshotRevision: "test_revision",
          payload: {},
        }),
      )

      const queued = yield* EditIntentClaims.registerFromPredesign({
        projectRoot: test.directory,
        sessionID: "ses_b",
        agent: "build",
        predesignID: "predesign_b",
        intent: "second refactor",
        files: ["shared.ts"],
      })
      expect(queued.registered.map((claim) => claim.filePath)).toEqual(["shared.ts"])
      expect(queued.conflicts).toHaveLength(1)
      expect(queued.conflicts[0]!.holder.sessionID).toBe("ses_a")
      expect(queued.conflicts[0]!.ownClaimQueued).toBe(true)
      // Queued at predesign time even without attempting the edit.
      const waiters = yield* Effect.promise(() => readEditIntentWaiters(test.directory, { sessionID: "ses_b", status: "waiting" }))
      expect(waiters).toHaveLength(1)

      // The gate now reports the queued state and drops the "record predesign" hint.
      const blocked = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_b"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(blocked.allowed).toBe(false)
      if (blocked.allowed) return
      expect(blocked.result.output).toContain("your claim is queued behind it")
      expect(blocked.result.output).not.toContain("Record chimera_predesign declaring shared.ts")

      // First-come-first-served: the holder still passes while the queued session waits.
      const holder = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_a"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(holder.allowed).toBe(true)

      // Holder release flips the queue: ses_b now passes with its own predesign evidence.
      const targets = yield* EditIntentClaims.releaseForSession({ projectRoot: test.directory, sessionID: "ses_a", reason: "session_idle" })
      expect(targets.map((target) => target.sessionID)).toEqual(["ses_b"])
      const after = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_b"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(after.allowed).toBe(true)
    }),
  )

  it.instance("two sessions racing the gate on a claimed file both block and both queue", () =>
    Effect.gen(function* () {
      const test = yield* initGraph()
      yield* Effect.promise(() => registerEditIntentClaims(test.directory, claimInput("predesign_a", "ses_holder", ["shared.ts"])))
      const file = path.join(test.directory, "shared.ts")

      // Real concurrent fibers hitting the gate + SQLite at the same time.
      const [first, second] = yield* Effect.all(
        [
          Chimera.requirePredesignForMutation({ toolID: "edit", ctx: gateCtx("ses_b"), files: [file] }),
          Chimera.requirePredesignForMutation({ toolID: "edit", ctx: gateCtx("ses_c"), files: [file] }),
        ],
        { concurrency: 2 },
      )
      expect(first.allowed).toBe(false)
      expect(second.allowed).toBe(false)

      const waiting = yield* Effect.promise(() => readEditIntentWaiters(test.directory, { status: "waiting" }))
      expect(waiting.map((waiter) => waiter.sessionID).sort()).toEqual(["ses_b", "ses_c"])

      const targets = yield* EditIntentClaims.releaseForSession({ projectRoot: test.directory, sessionID: "ses_holder", reason: "session_idle" })
      expect(targets.map((target) => target.sessionID).sort()).toEqual(["ses_b", "ses_c"])
    }),
  )

  it.instance("degrades open when the graph is uninitialized", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const decision = yield* Chimera.requirePredesignForMutation({
        toolID: "edit",
        ctx: gateCtx("ses_b"),
        files: [path.join(test.directory, "shared.ts")],
      })
      expect(decision.allowed).toBe(true)
      if (decision.allowed) expect(decision.required).toBe(false)
    }),
  )
})

describe("edit-intent claim context lines", () => {
  test("renders held and blocked lines and stays empty without claims", async () => {
    await using tmp = await tmpdir()
    DatabaseConnection.initialize(getDatabasePath(tmp.path)).close()
    expect(await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_b" }))).toEqual([])

    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts"], "holder intent"))
    const registration = await Effect.runPromise(EditIntentClaims.registerFromPredesign({
      projectRoot: tmp.path,
      sessionID: "ses_b",
      agent: "build",
      predesignID: "predesign_b",
      intent: "queued intent",
      files: ["shared.ts", "own.ts"],
    }))
    expect(registration.conflicts).toHaveLength(1)

    const lines = await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_b" }))
    expect(lines[0]).toBe("Edit Intent Claims:")
    expect(lines.join("\n")).toContain("held by you: own.ts, shared.ts")
    expect(lines.join("\n")).toContain("blocked: shared.ts is claimed by session ses_a")
    expect(lines.join("\n")).toContain("your claim is queued")

    // After the holder releases, the blocked line disappears; held claims remain.
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    await takeWokenEditIntentWaiters(tmp.path, ["shared.ts"])
    const after = await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_b" }))
    expect(after.join("\n")).toContain("held by you")
    expect(after.join("\n")).not.toContain("blocked:")
  })
})
