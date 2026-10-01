import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { EditIntentClaims } from "@/chimera/edit-intent"
import {
  cancelEditIntentWaiters,
  readEditIntentQueuePositions,
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

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

async function gate(root: string, sessionID: string, files: string[]) {
  return Effect.runPromise(
    EditIntentClaims.checkMutation({
      projectRoot: root,
      sessionID,
      toolID: "edit",
      files: files.map((file) => ({ absolutePath: file, graphPath: file })),
    }),
  )
}

describe("queue position store read (G2)", () => {
  test("counts waiting waiters per file and ranks the querying session in wake order", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["f1.ts", "f2.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "f1.ts", blockerSessionID: "ses_a", now: ago(3_000) })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "f1.ts", blockerSessionID: "ses_a", now: ago(2_000) })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_d", filePath: "f1.ts", blockerSessionID: "ses_a", now: ago(1_000) })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "f2.ts", blockerSessionID: "ses_a", now: ago(1_000) })

    const forC = await readEditIntentQueuePositions(tmp.path, { files: ["f1.ts", "f2.ts"], sessionID: "ses_c" })
    expect(forC).toEqual([
      { filePath: "f1.ts", depth: 3, position: 2 },
      { filePath: "f2.ts", depth: 1, position: 1 },
    ])

    // A session without a row still learns the depth, with no position.
    const forE = await readEditIntentQueuePositions(tmp.path, { files: ["f1.ts"], sessionID: "ses_e" })
    expect(forE).toEqual([{ filePath: "f1.ts", depth: 3 }])

    // Only still-waiting rows count: cancelling D shrinks the queue.
    await cancelEditIntentWaiters(tmp.path, "ses_d")
    expect(await readEditIntentQueuePositions(tmp.path, { files: ["f1.ts"], sessionID: "ses_c" })).toEqual([{ filePath: "f1.ts", depth: 2, position: 2 }])

    // Files without waiting rows are omitted; empty input short-circuits.
    expect(await readEditIntentQueuePositions(tmp.path, { files: ["nothing.ts"], sessionID: "ses_c" })).toEqual([])
    expect(await readEditIntentQueuePositions(tmp.path, { files: [], sessionID: "ses_c" })).toEqual([])
  })
})

describe("blocked gate queue visibility (G2)", () => {
  test("three queued sessions see #N of M in the block result text and metadata", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts"]))

    const first = await gate(tmp.path, "ses_b", ["shared.ts"])
    expect(first[0]!.queue).toEqual({ position: 1, depth: 1 })

    const second = await gate(tmp.path, "ses_c", ["shared.ts"])
    expect(second[0]!.queue).toEqual({ position: 2, depth: 2 })

    const third = await gate(tmp.path, "ses_d", ["shared.ts"])
    expect(third[0]!.queue).toEqual({ position: 3, depth: 3 })

    // Re-checking keeps the front rank (the upsert never re-dates created_at)
    // and reflects the grown depth.
    const recheck = await gate(tmp.path, "ses_b", ["shared.ts"])
    expect(recheck[0]!.queue).toEqual({ position: 1, depth: 3 })

    const blocked = EditIntentClaims.blockedResult({ toolID: "edit", conflicts: third })
    expect(blocked.output).toContain("held by session ses_a")
    expect(blocked.output).toContain("queue: #3 of 3 waiting")
    const metadata = blocked.metadata as { conflicts: Array<Record<string, unknown>> }
    expect(metadata.conflicts[0]!.queuePosition).toBe(3)
    expect(metadata.conflicts[0]!.queueDepth).toBe(3)
  })

  test("wake-priority soft conflicts carry queue annotations too", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts"]))
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_b", filePath: "shared.ts", blockerSessionID: "ses_a", now: ago(2_000) })
    await registerEditIntentWaiter(tmp.path, { sessionID: "ses_c", filePath: "shared.ts", blockerSessionID: "ses_a", now: ago(1_000) })
    await releaseEditIntentClaims(tmp.path, "ses_a", "session_idle")
    expect(await takeWokenEditIntentWaiters(tmp.path, ["shared.ts"])).toHaveLength(2)

    // C is soft-blocked by B's in-window wake and re-queued as the only
    // waiting row (B's row is woken, not waiting).
    const conflicts = await gate(tmp.path, "ses_c", ["shared.ts"])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.wakePriority?.sessionID).toBe("ses_b")
    expect(conflicts[0]!.queue).toEqual({ position: 1, depth: 1 })
    expect(EditIntentClaims.blockedResult({ toolID: "edit", conflicts }).output).toContain("queue: #1 of 1 waiting")
  })
})

describe("runtime context queue line (G2)", () => {
  test("contextLines renders per-file positions and the deepest-position summary", async () => {
    await using tmp = await dbDir()
    await registerEditIntentClaims(tmp.path, claimInput("predesign_a", "ses_a", ["shared.ts", "other.ts"]))
    await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({
        projectRoot: tmp.path,
        sessionID: "ses_b",
        agent: "build",
        predesignID: "predesign_b",
        intent: "queued work",
        files: ["shared.ts", "other.ts"],
      }),
    )
    await Effect.runPromise(
      EditIntentClaims.registerFromPredesign({
        projectRoot: tmp.path,
        sessionID: "ses_c",
        agent: "build",
        predesignID: "predesign_c",
        intent: "queued work",
        files: ["shared.ts"],
      }),
    )

    const forC = await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_c" }))
    const textC = forC.join("\n")
    expect(textC).toContain("blocked: shared.ts is claimed by session ses_a")
    expect(textC).toContain("you are #2 of 2 in the wake queue")
    expect(textC).toContain("- queued: you are waiting on 1 file(s) (deepest position #2 of 2 on shared.ts).")

    const forB = await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_b" }))
    const textB = forB.join("\n")
    expect(textB).toContain("you are #1 of 2 in the wake queue")
    expect(textB).toContain("you are #1 of 1 in the wake queue")
    expect(textB).toContain("- queued: you are waiting on 2 file(s)")

    // Without any blocked waiter there is no queue summary.
    const forA = await Effect.runPromise(EditIntentClaims.contextLines({ projectRoot: tmp.path, sessionID: "ses_a" }))
    expect(forA.join("\n")).not.toContain("queued:")
  })
})
