import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { CodeGraph, getCodeGraphDir, DatabaseConnection, getDatabasePath } from "@/graph"
import { Chimera } from "@/chimera"
import { EditIntentClaims } from "@/chimera/edit-intent"
import {
  currentHostBootID,
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

  test("waiter registration stamps the current host and the upsert re-stamps an explicit host", async () => {
    await using tmp = await dbDir()
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a" })
    const stamped = await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "waiting" })
    expect(stamped[0]!.hostPID).toBe(process.pid)
    expect(stamped[0]!.hostBootID).toBe(currentHostBootID())

    // A re-registration (same session+file) overwrites the host identity —
    // the post-restart repair path for rows stamped by a dead process.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 4242, bootID: "boot_1_4242" } })
    const restamped = await readEditIntentWaiters(tmp.path, { sessionID: "ses_b", status: "waiting" })
    expect(restamped).toHaveLength(1)
    expect(restamped[0]!.hostPID).toBe(4242)
    expect(restamped[0]!.hostBootID).toBe("boot_1_4242")

    // host: null keeps the pre-v6 shape (no host stamp).
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "f.ts", blockerSessionID: "ses_a", host: null })
    const unstamped = await readEditIntentWaiters(tmp.path, { sessionID: "ses_c", status: "waiting" })
    expect(unstamped[0]!.hostPID).toBeUndefined()
    expect(unstamped[0]!.hostBootID).toBeUndefined()
  })

  test("host-filtered take only flips that host's waiters and stays exactly-once under races", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_local", filePath: "f.ts", blockerSessionID: "ses_a" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_foreign", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 4242, bootID: "boot_1_4242" } })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_legacy", filePath: "f.ts", blockerSessionID: "ses_a", host: null })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")

    // A foreign host's take flips only the foreign row.
    const foreignWoken = await takeWokenEditIntentWaiters(tmp.path, ["f.ts"], { hostBootID: "boot_1_4242" })
    expect(foreignWoken.map((waiter) => waiter.sessionID)).toEqual(["ses_foreign"])

    // Same-host takers racing the local row still wake it exactly once.
    const results = await Promise.all([
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"], { hostBootID: currentHostBootID() }),
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"], { hostBootID: currentHostBootID() }),
      takeWokenEditIntentWaiters(tmp.path, ["f.ts"], { hostBootID: currentHostBootID() }),
    ])
    expect(results.flat().map((waiter) => waiter.sessionID)).toEqual(["ses_local"])

    // NULL-host rows match no host filter — only the unfiltered legacy take
    // (or the orphan sweep) can consume them.
    expect(await takeWokenEditIntentWaiters(tmp.path, ["f.ts"], { hostBootID: currentHostBootID() })).toHaveLength(0)
    const legacyWoken = await takeWokenEditIntentWaiters(tmp.path, ["f.ts"])
    expect(legacyWoken.map((waiter) => waiter.sessionID)).toEqual(["ses_legacy"])
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

describe("edit-intent cross-process poll bridge", () => {
  test("poll is inert without the pending hint: foreign-hosted waiters are never touched", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f.ts"]))
    // pid 1 (launchd/init) is always alive: the row stands in for a waiter
    // hosted by a live foreign process.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_remote", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 1, bootID: "boot_1_1" } })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")

    // No waiter was registered through this process's gate, so the poll hint
    // is unset and the tick costs zero DB access — the remote row stays put.
    expect(await Effect.runPromise(EditIntentClaims.pollCrossProcessWakes({ projectRoot: tmp.path }))).toHaveLength(0)
    const waiting = await readEditIntentWaiters(tmp.path, { status: "waiting" })
    expect(waiting.map((waiter) => waiter.sessionID)).toEqual(["ses_remote"])
  })

  test("poll wakes this host's parked waiters after a release in another process, exactly once", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_holder", "ses_holder", ["shared.ts"]))
    // The local session queues through the real gate path (sets the poll hint).
    const conflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_local",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    expect(conflicts).toHaveLength(1)

    // Model the holder's release happening in another process: the raw store
    // release flips the claim rows with no local bus event and no local take.
    await releaseEditIntentClaims(tmp.path, "ses_holder", "session_idle")

    const targets = await Effect.runPromise(EditIntentClaims.pollCrossProcessWakes({ projectRoot: tmp.path }))
    expect(targets.map((target) => target.sessionID)).toEqual(["ses_local"])
    expect(targets[0]!.files.map((file) => file.filePath)).toEqual(["shared.ts"])
    expect(targets[0]!.reason).toBeUndefined()
    expect(EditIntentClaims.wakeText(targets[0]!)).toContain("the holder finished")

    // Exactly-once: the row is woken; the next tick finds nothing, consumes
    // the hint, and further polls stay inert.
    expect(await Effect.runPromise(EditIntentClaims.pollCrossProcessWakes({ projectRoot: tmp.path }))).toHaveLength(0)
    expect(await Effect.runPromise(EditIntentClaims.pollCrossProcessWakes({ projectRoot: tmp.path }))).toHaveLength(0)
    expect(await readEditIntentWaiters(tmp.path, { sessionID: "ses_local", status: "woken" })).toHaveLength(1)
  })

  test("poll never steals a foreign-hosted wake and lazily cancels dead-host leftovers", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_holder", "ses_holder", ["shared.ts"]))
    const conflicts = await Effect.runPromise(
      EditIntentClaims.checkMutation({
        projectRoot: tmp.path,
        sessionID: "ses_local",
        toolID: "edit",
        files: [{ absolutePath: "shared.ts", graphPath: "shared.ts" }],
      }),
    )
    expect(conflicts).toHaveLength(1)
    // A live foreign host (pid 1): its wake belongs to its own process's poll.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_live_remote", filePath: "shared.ts", blockerSessionID: "ses_holder", host: { pid: 1, bootID: "boot_1_1" } })
    // A dead host's leftover: no process can ever have this pid.
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_dead_remote", filePath: "shared.ts", blockerSessionID: "ses_holder", host: { pid: 99999999, bootID: "boot_1_99999999" } })
    await releaseEditIntentClaims(tmp.path, "ses_holder", "session_idle")

    const targets = await Effect.runPromise(EditIntentClaims.pollCrossProcessWakes({ projectRoot: tmp.path }))
    expect(targets.map((target) => target.sessionID)).toEqual(["ses_local"])

    // The live foreign waiter stays waiting; the dead host's row was swept.
    const waiting = await readEditIntentWaiters(tmp.path, { status: "waiting" })
    expect(waiting.map((waiter) => waiter.sessionID)).toEqual(["ses_live_remote"])
    const cancelled = await readEditIntentWaiters(tmp.path, { status: "cancelled" })
    expect(cancelled.map((waiter) => waiter.sessionID)).toEqual(["ses_dead_remote"])
  })

  test("sweepStaleHosts cancels dead hosts immediately and NULL-host orphans only past the grace window", async () => {
    await using tmp = await dbDir()
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_dead", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 99999998, bootID: "boot_1_99999998" } })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_malformed", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 7, bootID: "not-a-boot-id" } })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_live", filePath: "f.ts", blockerSessionID: "ses_a", host: { pid: 1, bootID: "boot_1_1" } })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_self", filePath: "f.ts", blockerSessionID: "ses_a" })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_orphan_fresh", filePath: "f.ts", blockerSessionID: "ses_a", host: null })
    await registerEditIntentWaiter(tmp.path, {
      sessionID: "ses_orphan_old",
      filePath: "f.ts",
      blockerSessionID: "ses_a",
      host: null,
      now: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    })

    const cancelled = await Effect.runPromise(EditIntentClaims.sweepStaleHosts({ projectRoot: tmp.path }))
    expect(cancelled).toBe(3)

    const waiting = await readEditIntentWaiters(tmp.path, { status: "waiting" })
    expect(waiting.map((waiter) => waiter.sessionID).sort()).toEqual(["ses_live", "ses_orphan_fresh", "ses_self"])
    const cancelledRows = await readEditIntentWaiters(tmp.path, { status: "cancelled" })
    expect(cancelledRows.map((waiter) => waiter.sessionID).sort()).toEqual(["ses_dead", "ses_malformed", "ses_orphan_old"])
  })
})
