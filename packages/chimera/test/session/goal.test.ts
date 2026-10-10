import { beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Goal } from "@/session/goal"
import { MessageID, SessionID } from "@/session/schema"
import { GoalTable, MessageTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { Command } from "@/command"
import { SessionPrompt } from "@/session/prompt"
import { makePromptHarness, testProviderConfig } from "../fixture/prompt-harness"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Goal.defaultLayer)
const loopIt = testEffect(makePromptHarness())

// goal rows FK-reference session rows, which FK-reference project rows; seed the
// parent chain once per test, mirroring test/tool/workbrief.test.ts.
const sessionID = SessionID.make("ses_goal_test")

beforeEach(() => {
  Database.Client().$client.exec(`
    DELETE FROM goal;
    DELETE FROM part WHERE session_id = 'ses_goal_test';
    DELETE FROM message WHERE session_id LIKE 'ses_goal%';
    DELETE FROM session WHERE id LIKE 'ses_goal%';
    DELETE FROM project WHERE id = 'prj_goal_test';
    INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('prj_goal_test', '/tmp/goal-test', '[]', 0, 0);
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_goal_test', 'prj_goal_test', 'goal-test', '/tmp/goal-test', 'Goal Test', 'test', 0, 0);
  `)
})

function assistantMessage(
  targetSessionID: string,
  id: MessageID,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  completed = true,
) {
  const data = {
    role: "assistant",
    time: { created: 0, ...(completed ? { completed: 1 } : {}) },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
    },
    parentID: MessageID.ascending(),
    modelID: "test",
    providerID: "test",
    mode: "test",
    agent: "test",
    path: { cwd: "/", root: "/" },
  } as unknown as (typeof MessageTable.$inferInsert)["data"]
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(MessageTable)
        .values({ id, session_id: SessionID.make(targetSessionID), data })
        .run(),
    ),
  )
}

function insertAssistant(
  id: MessageID,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  completed = true,
) {
  return assistantMessage(sessionID, id, tokens, completed)
}

// Subagent-style session rows with `parent_id` set, mirroring how child
// dispatch creates descendant sessions for the accounting tests.
function insertSession(id: string, parentID?: string) {
  return Effect.sync(() =>
    Database.Client().$client.exec(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
       VALUES ('${id}', 'prj_goal_test', ${parentID ? `'${parentID}'` : "NULL"}, '${id}', '/tmp/goal-test', 'Goal Test Session', 'test', 0, 0)`,
    ),
  )
}

// Direct row writer used to seed the pre-watermarks legacy goal shape.
function insertGoalData(data: Record<string, unknown>) {
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(GoalTable)
        .values({ session_id: sessionID, data: data as (typeof GoalTable.$inferInsert)["data"] })
        .run(),
    ),
  )
}

function finalizeAssistant(id: MessageID) {
  return Effect.sync(() =>
    Database.use((db) => {
      const row = db.select().from(MessageTable).where(eq(MessageTable.id, id)).get()
      if (!row) throw new Error(`goal test: missing message ${id}`)
      db.update(MessageTable)
        .set({ data: { ...row.data, time: { ...row.data.time, completed: 2 } } as typeof row.data })
        .where(eq(MessageTable.id, id))
        .run()
    }),
  )
}

function expectRejected<A>(fx: Effect.Effect<A, Error>, message: string) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(fx)
    if (Exit.isSuccess(exit)) return yield* Effect.die(new Error("expected the effect to fail"))
    expect((Cause.squash(exit.cause) as Error).message).toContain(message)
  })
}

describe("session.goal", () => {
  it.instance("create stores an active goal with zero usage", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const created = yield* goal.create({ sessionID, objective: "Ship  goal  phase 1 " })
      expect(created.objective).toBe("Ship goal phase 1")
      expect(created.status).toBe("active")
      expect(created.tokensUsed).toBe(0)

      const stored = yield* goal.get(sessionID)
      expect(stored?.objective).toBe("Ship goal phase 1")
      expect(stored?.status).toBe("active")
      expect(stored?.tokensUsed).toBe(0)
      expect(stored?.tokenBudget).toBeUndefined()
    }),
  )

  it.instance("duplicate create is rejected while an unfinished goal exists", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "first", tokenBudget: 500 })
      yield* expectRejected(
        goal.create({ sessionID, objective: "second" }),
        "cannot create a new goal because this session has an unfinished goal",
      )
      const stored = yield* goal.get(sessionID)
      expect(stored?.objective).toBe("first")
      expect(stored?.tokenBudget).toBe(500)
    }),
  )

  it.instance("create replaces a completed goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "first" })
      yield* goal.updateStatus({ sessionID, status: "complete" })
      const created = yield* goal.create({ sessionID, objective: "second" })
      expect(created.status).toBe("active")
      expect(created.tokensUsed).toBe(0)
      const stored = yield* goal.get(sessionID)
      expect(stored?.objective).toBe("second")
    }),
  )

  it.instance("status transitions follow the lifecycle rules", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service

      yield* goal.create({ sessionID, objective: "transitions" })
      const completed = yield* goal.updateStatus({ sessionID, status: "complete" })
      expect(completed.status).toBe("complete")

      yield* goal.create({ sessionID, objective: "replace" }).pipe(Effect.orDie)
      const paused = yield* goal.updateStatus({ sessionID, status: "paused" })
      expect(paused.status).toBe("paused")
      const resumed = yield* goal.updateStatus({ sessionID, status: "active" })
      expect(resumed.status).toBe("active")
      const blocked = yield* goal.updateStatus({ sessionID, status: "blocked" })
      expect(blocked.status).toBe("blocked")

      yield* expectRejected(
        goal.updateStatus({ sessionID, status: "active" }),
        "resuming is the user's call — ask them to run /goal resume",
      )
      yield* expectRejected(goal.updateStatus({ sessionID, status: "paused" }), "Cannot transition")

      const fromBlocked = yield* goal.updateStatus({ sessionID, status: "complete" })
      expect(fromBlocked.status).toBe("complete")
      yield* expectRejected(goal.updateStatus({ sessionID, status: "active" }), "already complete; create a new goal")
    }),
  )

  it.instance("resume moves a paused goal back to active and guards no-goal/active/complete sources", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* expectRejected(goal.resume(sessionID), "No goal is set for this session")
      yield* goal.create({ sessionID, objective: "resume me" })
      yield* expectRejected(goal.resume(sessionID), "already active")
      yield* goal.updateStatus({ sessionID, status: "paused" })
      const resumed = yield* goal.resume(sessionID)
      expect(resumed.status).toBe("active")
      expect(resumed.objective).toBe("resume me")
      expect((yield* goal.get(sessionID))?.status).toBe("active")

      yield* goal.updateStatus({ sessionID, status: "complete" })
      yield* expectRejected(goal.resume(sessionID), "already complete; create a new goal")
    }),
  )

  it.instance("resume from blocked zeroes the empty streak for a fresh blocked audit", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "blocked audit" })
      yield* goal.recordContinuation({ sessionID, productive: false })
      yield* goal.recordContinuation({ sessionID, productive: false })
      const blocked = yield* goal.recordContinuation({ sessionID, productive: false })
      expect(blocked?.status).toBe("blocked")
      expect(blocked?.consecutiveEmptyContinuations).toBe(3)

      const resumed = yield* goal.resume(sessionID)
      expect(resumed.status).toBe("active")
      expect(resumed.consecutiveEmptyContinuations).toBe(0)
      // the total continuation-turn cap keeps counting across a resume
      expect(resumed.consecutiveContinuations).toBe(3)

      // fresh audit: the next three unproductive continuations re-block
      yield* goal.recordContinuation({ sessionID, productive: false })
      yield* goal.recordContinuation({ sessionID, productive: false })
      expect((yield* goal.get(sessionID))?.status).toBe("active")
      const reblocked = yield* goal.recordContinuation({ sessionID, productive: false })
      expect(reblocked?.status).toBe("blocked")
      expect(reblocked?.consecutiveEmptyContinuations).toBe(3)
    }),
  )

  it.instance("resume refuses a budget_limited goal without touching the usage ledger", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "budgeted resume", tokenBudget: 100 })
      yield* insertAssistant(MessageID.ascending(), { input: 200, output: 0, cacheRead: 100, cacheWrite: 0 })
      yield* goal.account(sessionID)
      yield* expectRejected(goal.resume(sessionID), "budget limits take priority over resume")
      const stored = yield* goal.get(sessionID)
      expect(stored?.status).toBe("budget_limited")
      expect(stored?.tokensUsed).toBe(100)
    }),
  )

  it.instance("account sums billable tokens past the watermark without double counting", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "usage" })

      const first = MessageID.ascending()
      // billable: 1000 - 300 + 200 = 900
      yield* insertAssistant(first, { input: 1000, output: 200, cacheRead: 300, cacheWrite: 10 })
      const second = MessageID.ascending()
      // billable: 100 - 0 + 40 = 140
      yield* insertAssistant(second, { input: 100, output: 40, cacheRead: 0, cacheWrite: 5 })
      // the newest assistant message is still in flight: must not be counted yet
      const inflight = MessageID.ascending()
      yield* insertAssistant(inflight, { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }, false)

      yield* goal.account(sessionID)
      let stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(1040)
      expect(stored?.usageWatermarks).toEqual({ [sessionID]: second })

      yield* goal.account(sessionID)
      stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(1040)

      // completing the in-flight message is picked up on the next account call
      yield* finalizeAssistant(inflight)
      yield* goal.account(sessionID)
      stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(3040)
      expect(stored?.usageWatermarks).toEqual({ [sessionID]: inflight })
    }),
  )

  it.instance("account flips an over-budget active goal to budget_limited", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "budgeted", tokenBudget: 100 })
      yield* insertAssistant(MessageID.ascending(), { input: 200, output: 50, cacheRead: 100, cacheWrite: 0 })

      yield* goal.account(sessionID)
      const stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(150)
      expect(stored?.status).toBe("budget_limited")
    }),
  )

  it.instance("account is a no-op when no goal exists", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* insertAssistant(MessageID.ascending(), { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
      yield* goal.account(sessionID)
      expect(yield* goal.get(sessionID)).toBeUndefined()
    }),
  )

  it.instance("clear removes the goal row and reports whether one existed", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "clear me" })
      expect(yield* goal.clear(sessionID)).toBe(true)
      expect(yield* goal.get(sessionID)).toBeUndefined()
      expect(yield* goal.clear(sessionID)).toBe(false)
      // account stays a no-op after clearing
      yield* insertAssistant(MessageID.ascending(), { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
      yield* goal.account(sessionID)
      expect(yield* goal.get(sessionID)).toBeUndefined()
    }),
  )

  it.instance("legacy lastUsageMessageID rows normalize into per-session watermarks", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      const counted = MessageID.ascending()
      // a message already accounted under the legacy watermark (500 billable)
      yield* insertAssistant(counted, { input: 500, output: 100, cacheRead: 100, cacheWrite: 0 })
      yield* insertGoalData({
        objective: "legacy",
        status: "active",
        tokensUsed: 500,
        lastUsageMessageID: counted,
      })

      // `get` folds the legacy field into the goal session's watermark
      const stored = yield* goal.get(sessionID)
      expect(stored?.usageWatermarks).toEqual({ [sessionID]: counted })

      const fresh = MessageID.ascending()
      // billable: 100 - 0 + 10 = 110
      yield* insertAssistant(fresh, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
      yield* goal.account(sessionID)
      const accounted = yield* goal.get(sessionID)
      expect(accounted?.tokensUsed).toBe(610)
      expect(accounted?.usageWatermarks).toEqual({ [sessionID]: fresh })

      // the persisted row was rewritten without the legacy field
      const raw = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()),
      )
      expect((raw?.data as Record<string, unknown>).lastUsageMessageID).toBeUndefined()
    }),
  )

  it.instance("account aggregates descendant session tokens without double counting", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "aggregate" })
      yield* insertSession("ses_goal_child", "ses_goal_test")
      yield* insertSession("ses_goal_grand", "ses_goal_child")

      // billable: 1000 - 300 + 200 = 900 in the child
      const childMsg = MessageID.ascending()
      yield* assistantMessage("ses_goal_child", childMsg, { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0 })
      // billable: 50 - 0 + 10 = 60 in the grandchild (transitive closure)
      const grandMsg = MessageID.ascending()
      yield* assistantMessage("ses_goal_grand", grandMsg, { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 })
      // in-flight child message must not count yet
      yield* assistantMessage(
        "ses_goal_child",
        MessageID.ascending(),
        { input: 5000, output: 5000, cacheRead: 0, cacheWrite: 0 },
        false,
      )
      // an unrelated root session's usage must not leak into the goal
      yield* insertSession("ses_goal_other")
      yield* assistantMessage("ses_goal_other", MessageID.ascending(), {
        input: 400,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      })

      yield* goal.account(sessionID)
      let stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(960)
      // only sessions with new completed assistant rows get watermarks
      expect(stored?.usageWatermarks).toEqual({ ses_goal_child: childMsg, ses_goal_grand: grandMsg })

      // re-accounting does not double count
      yield* goal.account(sessionID)
      stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(960)

      // a new child created mid-goal counts its full history
      yield* insertSession("ses_goal_child2", "ses_goal_test")
      const newChildMsg = MessageID.ascending()
      // billable: 100 - 0 + 40 = 140
      yield* assistantMessage("ses_goal_child2", newChildMsg, { input: 100, output: 40, cacheRead: 0, cacheWrite: 5 })
      yield* goal.account(sessionID)
      stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(1100)
      expect(stored?.usageWatermarks).toEqual({
        ses_goal_child: childMsg,
        ses_goal_grand: grandMsg,
        ses_goal_child2: newChildMsg,
      })
    }),
  )

  it.instance("child-driven usage flips the root goal to budget_limited", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "budgeted subtree", tokenBudget: 100 })
      yield* insertSession("ses_goal_child", "ses_goal_test")
      // billable: 150 in the child alone crosses the root goal's budget
      yield* assistantMessage("ses_goal_child", MessageID.ascending(), {
        input: 150,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
      yield* goal.account(sessionID)
      const stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(150)
      expect(stored?.status).toBe("budget_limited")
    }),
  )

  it.instance("render reports the goal block and refreshes usage", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "render budgeted", tokenBudget: 100_000 })
      yield* insertAssistant(MessageID.ascending(), { input: 20_000, output: 340, cacheRead: 10_000, cacheWrite: 0 })

      const rendered = yield* goal.render(sessionID)
      expect(rendered).toContain("## Session Goal")
      expect(rendered).toContain("- Status: active")
      expect(rendered).toContain("- Objective: render budgeted")
      expect(rendered).toContain("- Tokens used: 10,340 / budget: 100,000 (89,660 remaining)")

      const stored = yield* goal.get(sessionID)
      expect(stored?.tokensUsed).toBe(10_340)
    }),
  )

  it.instance("render shows the no-budget line", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "no budget" })
      yield* insertAssistant(MessageID.ascending(), { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 })
      const rendered = yield* goal.render(sessionID)
      expect(rendered).toContain("- Tokens used: 10 (no budget set)")
      expect(rendered).not.toContain("The goal token budget is exhausted")
    }),
  )

  it.instance("render for a budget_limited goal appends the wrap-up steering and complete renders one line", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "tiny budget", tokenBudget: 10 })
      yield* insertAssistant(MessageID.ascending(), { input: 20, output: 10, cacheRead: 5, cacheWrite: 0 })

      const limited = yield* goal.render(sessionID)
      expect(limited).toContain("- Status: budget_limited")
      expect(limited).toContain(
        "The goal token budget is exhausted. Wrap up the current turn soon, do not start new substantive work for this goal, and report progress against the objective.",
      )

      yield* goal.updateStatus({ sessionID, status: "complete" })
      const done = yield* goal.render(sessionID)
      expect(done).toBe("## Session Goal\n- Status: complete · Objective: tiny budget")
    }),
  )

  it.instance("render returns undefined when no goal exists", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      expect(yield* goal.render(sessionID)).toBeUndefined()
    }),
  )

  it.instance("recordContinuation applies the breaker transitions and persists them", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "streak" })

      const first = yield* goal.recordContinuation({ sessionID, productive: false })
      expect(first?.consecutiveEmptyContinuations).toBe(1)
      expect(first?.consecutiveContinuations).toBe(1)
      expect(first?.status).toBe("active")

      yield* goal.recordContinuation({ sessionID, productive: false })
      const third = yield* goal.recordContinuation({ sessionID, productive: false })
      expect(third?.consecutiveEmptyContinuations).toBe(3)
      expect(third?.consecutiveContinuations).toBe(3)
      expect(third?.status).toBe("blocked")

      const stored = yield* goal.get(sessionID)
      expect(stored?.status).toBe("blocked")
      expect(stored?.consecutiveContinuations).toBe(3)

      const blockedAgain = yield* goal.recordContinuation({ sessionID, productive: false })
      expect(blockedAgain?.status).toBe("blocked")
      expect(blockedAgain?.consecutiveEmptyContinuations).toBe(4)
      expect(blockedAgain?.consecutiveContinuations).toBe(4)
    }),
  )

  it.instance("recordContinuation is a no-op without a goal row", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      expect(yield* goal.recordContinuation({ sessionID, productive: true })).toBeUndefined()
    }),
  )

  it.instance("resetContinuation clears the counters and is a no-op without a goal", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.resetContinuation(sessionID)
      expect(yield* goal.get(sessionID)).toBeUndefined()

      yield* goal.create({ sessionID, objective: "reset" })
      yield* goal.recordContinuation({ sessionID, productive: false })
      yield* goal.recordContinuation({ sessionID, productive: false })
      yield* goal.resetContinuation(sessionID)
      const stored = yield* goal.get(sessionID)
      expect(stored?.consecutiveEmptyContinuations).toBeUndefined()
      expect(stored?.consecutiveContinuations).toBeUndefined()
      expect(stored?.status).toBe("active")
      // idempotent: a second reset with no counters set changes nothing
      yield* goal.resetContinuation(sessionID)
      expect(yield* goal.get(sessionID)).toMatchObject({ status: "active" })
    }),
  )

  it.instance("render for an active goal documents the auto-continuation contract", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "auto" })
      const rendered = yield* goal.render(sessionID)
      expect(rendered).toContain(
        "- This goal auto-continues: when a turn ends with the goal active, a continuation turn starts automatically. Turns that end without any tool calls count as unproductive; 3 consecutive unproductive continuations mark the goal blocked.",
      )
      yield* goal.updateStatus({ sessionID, status: "paused" })
      expect(yield* goal.render(sessionID)).not.toContain("This goal auto-continues")
    }),
  )
})

describe("session.goal continuation decision", () => {
  const base: Goal.Info = { objective: "x", status: "active", tokensUsed: 0 }

  test("productive outcome resets the empty streak and extends the turn counter", () => {
    const outcome = Goal.continuationOutcome(base, { productive: true })
    expect(outcome.consecutiveEmptyContinuations).toBe(0)
    expect(outcome.consecutiveContinuations).toBe(1)
    expect(outcome.status).toBe("active")
  })

  test("unproductive outcome increments both counters from a fresh goal", () => {
    const outcome = Goal.continuationOutcome(base, { productive: false })
    expect(outcome.consecutiveEmptyContinuations).toBe(1)
    expect(outcome.consecutiveContinuations).toBe(1)
  })

  test("the third consecutive unproductive continuation flips an active goal to blocked", () => {
    const one = Goal.continuationOutcome(base, { productive: false })
    const two = Goal.continuationOutcome(one, { productive: false })
    const three = Goal.continuationOutcome(two, { productive: false })
    expect(one.consecutiveEmptyContinuations).toBe(1)
    expect(two.consecutiveEmptyContinuations).toBe(2)
    expect(two.status).toBe("active")
    expect(three.consecutiveEmptyContinuations).toBe(3)
    expect(three.consecutiveContinuations).toBe(3)
    expect(three.status).toBe("blocked")
  })

  test("a productive turn resets the near-broken streak", () => {
    const streak = Goal.continuationOutcome(Goal.continuationOutcome(base, { productive: false }), {
      productive: false,
    })
    const reset = Goal.continuationOutcome(streak, { productive: true })
    expect(reset.consecutiveEmptyContinuations).toBe(0)
    expect(reset.consecutiveContinuations).toBe(3)
    expect(reset.status).toBe("active")
  })

  test("the blocked flip only applies to active goals", () => {
    const paused: Goal.Info = {
      ...base,
      status: "paused",
      consecutiveEmptyContinuations: 2,
      consecutiveContinuations: 2,
    }
    const outcome = Goal.continuationOutcome(paused, { productive: false })
    expect(outcome.consecutiveEmptyContinuations).toBe(3)
    expect(outcome.status).toBe("paused")
  })

  test("an already blocked goal keeps counting but stays blocked", () => {
    const blocked: Goal.Info = {
      ...base,
      status: "blocked",
      consecutiveEmptyContinuations: 3,
      consecutiveContinuations: 3,
    }
    const outcome = Goal.continuationOutcome(blocked, { productive: true })
    expect(outcome.status).toBe("blocked")
    expect(outcome.consecutiveEmptyContinuations).toBe(0)
    expect(outcome.consecutiveContinuations).toBe(4)
  })

  test("phase-1 goals without counters behave as zero", () => {
    const outcome = Goal.continuationOutcome(base, { productive: false })
    expect(outcome.consecutiveContinuations).toBe(1)
    expect(Goal.canAutoContinue(base)).toBe(true)
  })

  test("canAutoContinue requires an active goal under the turn cap", () => {
    expect(Goal.canAutoContinue(undefined)).toBe(false)
    for (const status of ["paused", "blocked", "budget_limited", "complete"] as const)
      expect(Goal.canAutoContinue({ ...base, status })).toBe(false)
    expect(Goal.canAutoContinue({ ...base, consecutiveContinuations: Goal.MAX_CONTINUATION_TURNS - 1 })).toBe(true)
    expect(Goal.canAutoContinue({ ...base, consecutiveContinuations: Goal.MAX_CONTINUATION_TURNS })).toBe(false)
  })
})

// ── auto-continuation run-loop integration (harness-driven) ─────────────────

const continuationParts = (messages: MessageV2.WithParts[]) =>
  messages
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && part.metadata?.goalContinuation === true)

describe("session.goal auto-continuation loop", () => {
  loopIt.live("an active goal injects a synthetic continuation turn after a no-tool turn", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Auto continue",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "keep working" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        // real turn ends without tools -> continuation 1 is injected
        yield* llm.text("one")
        // the continuation turn finishes the goal with a tool call -> productive, loop stops
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")
        const messages = yield* sessions.messages({ sessionID: session.id })
        const continuations = continuationParts(messages)
        expect(continuations).toHaveLength(1)
        expect(continuations[0]?.text).toContain("<goal-continuation>")
        expect(continuations[0]?.synthetic).toBe(true)
        expect(yield* llm.calls).toBe(3)
        expect(yield* llm.pending).toBe(0)

        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("complete")
        expect(stored?.consecutiveContinuations).toBe(1)
        expect(stored?.consecutiveEmptyContinuations).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("3 consecutive unproductive continuations block the goal and stop continuation", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Empty streak",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "drift" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")
        yield* llm.text("two")
        yield* llm.text("three")
        yield* llm.text("four")

        yield* prompt.loop({ sessionID: session.id })
        // 4 assistant turns (real + 3 continuations); no fifth call after the block
        expect(yield* llm.calls).toBe(4)
        expect(yield* llm.pending).toBe(0)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(continuationParts(messages)).toHaveLength(3)

        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("blocked")
        expect(stored?.consecutiveEmptyContinuations).toBe(3)
        expect(stored?.consecutiveContinuations).toBe(3)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("a productive continuation turn resets the unproductive streak", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Productive streak",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "work in steps" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one") // real turn ends empty -> continuation 1
        yield* llm.text("two") // continuation 1 ends empty -> streak 1, continuation 2
        yield* llm.tool("goal_update", { status: "paused" }) // continuation 2 works with a tool
        yield* llm.text("four") // ends the turn -> productive record resets the streak

        yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.calls).toBe(4)
        expect(yield* llm.pending).toBe(0)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(continuationParts(messages)).toHaveLength(2)

        const stored = yield* goal.get(session.id)
        // paused by the productive continuation turn: the breaker stops here
        expect(stored?.status).toBe("paused")
        expect(stored?.consecutiveEmptyContinuations).toBe(0)
        expect(stored?.consecutiveContinuations).toBe(2)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("no continuation when no goal exists", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "No goal",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(0)
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("no continuation for paused or complete goals", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const paused = yield* sessions.create({
          title: "Paused goal",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: paused.id, objective: "pause" })
        yield* goal.updateStatus({ sessionID: paused.id, status: "paused" })
        yield* prompt.prompt({
          sessionID: paused.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")
        yield* prompt.loop({ sessionID: paused.id })

        const done = yield* sessions.create({
          title: "Complete goal",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: done.id, objective: "finish" })
        yield* goal.updateStatus({ sessionID: done.id, status: "complete" })
        yield* prompt.prompt({
          sessionID: done.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("two")
        yield* prompt.loop({ sessionID: done.id })

        expect(yield* llm.calls).toBe(2)
        expect(continuationParts(yield* sessions.messages({ sessionID: paused.id }))).toHaveLength(0)
        expect(continuationParts(yield* sessions.messages({ sessionID: done.id }))).toHaveLength(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("no continuation for a subagent session (parentID set)", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const parent = yield* sessions.create({ title: "Sub parent" })
        const child = yield* sessions.create({
          title: "Sub child",
          parentID: parent.id,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: child.id, objective: "child work" })
        yield* prompt.prompt({
          sessionID: child.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")

        yield* prompt.loop({ sessionID: child.id })
        expect(yield* llm.calls).toBe(1)
        expect(continuationParts(yield* sessions.messages({ sessionID: child.id }))).toHaveLength(0)
        const stored = yield* goal.get(child.id)
        expect(stored?.consecutiveContinuations).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("no continuation for structured-output (json_schema) requests", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Structured goal",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "schema" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          },
          parts: [{ type: "text", text: "answer" }],
        })
        // the model answers with plain text instead of the StructuredOutput tool
        yield* llm.text("plain answer")

        yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.calls).toBe(1)
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(0)
        const stored = yield* goal.get(session.id)
        expect(stored?.consecutiveContinuations).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

describe("session.goal /goal command", () => {
  loopIt.live("/goal registers, creates, shows, and refuses a second unfinished goal model-free", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const commands = yield* Command.Service

        const listed = yield* commands.list()
        expect(listed.some((command) => command.name === Command.Default.GOAL)).toBe(true)

        const session = yield* sessions.create({
          title: "Goal command",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const created = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "  ship the widget  ",
        })
        expect(created.info.role).toBe("assistant")
        expect(created.parts.find((part) => part.type === "text")?.text).toContain("- Objective: ship the widget")
        const stored = yield* goal.get(session.id)
        expect(stored?.objective).toBe("ship the widget")
        expect(stored?.status).toBe("active")

        // the typed command is echoed (trimmed) as a user text part, like /init-graph
        const messages = yield* sessions.messages({ sessionID: session.id })
        const echoed = messages
          .find((message) => message.info.role === "user")
          ?.parts.find((part) => part.type === "text")
        expect(echoed?.text).toBe("/goal ship the widget")

        // bare /goal renders the current state (objective, status, usage)
        const shown = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "",
        })
        const shownText = shown.parts.find((part) => part.type === "text")?.text
        expect(shownText).toContain("## Session Goal")
        expect(shownText).toContain("- Status: active")
        expect(shownText).toContain("- Objective: ship the widget")
        expect(shownText).toContain("Tokens used")

        // goal_create semantics: a second create is refused while unfinished
        const refused = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "another objective",
        })
        expect(refused.parts.find((part) => part.type === "text")?.text).toContain(
          "Goal not set: cannot create a new goal because this session has an unfinished goal",
        )
        expect((yield* goal.get(session.id))?.objective).toBe("ship the widget")
        expect(yield* llm.calls).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal clear removes the goal; unset sessions report no goal", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal clear",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const emptyShow = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "",
        })
        expect(emptyShow.parts.find((part) => part.type === "text")?.text).toBe("No goal is set for this session.")
        const emptyClear = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "clear",
        })
        expect(emptyClear.parts.find((part) => part.type === "text")?.text).toBe("No goal is set for this session.")

        yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "ship the widget",
        })
        const cleared = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "Clear",
        })
        expect(cleared.parts.find((part) => part.type === "text")?.text).toBe("Goal cleared: ship the widget")
        expect(yield* goal.get(session.id)).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal replaces a completed goal via the create path", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal replace",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "first objective" })
        yield* goal.updateStatus({ sessionID: session.id, status: "complete" })

        const replaced = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "second objective",
        })
        expect(replaced.parts.find((part) => part.type === "text")?.text).toContain("- Objective: second objective")
        const stored = yield* goal.get(session.id)
        expect(stored?.objective).toBe("second objective")
        expect(stored?.status).toBe("active")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal in a subagent session explains root-session scope and sets nothing", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const parent = yield* sessions.create({ title: "Goal sub parent" })
        const child = yield* sessions.create({
          title: "Goal sub child",
          parentID: parent.id,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        const result = yield* prompt.command({
          sessionID: child.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "child work",
        })
        expect(result.parts.find((part) => part.type === "text")?.text).toContain(
          "Session goals belong to the root session",
        )
        expect(yield* goal.get(child.id)).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal resume unblocks a blocked goal with a fresh audit and kicks a continuation turn", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal resume",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "drift" })
        yield* goal.recordContinuation({ sessionID: session.id, productive: false })
        yield* goal.recordContinuation({ sessionID: session.id, productive: false })
        yield* goal.recordContinuation({ sessionID: session.id, productive: false })
        const blocked = yield* goal.get(session.id)
        expect(blocked?.status).toBe("blocked")
        expect(blocked?.consecutiveEmptyContinuations).toBe(3)

        // the kicked continuation turn works with a tool call, then pauses
        yield* llm.tool("goal_update", { status: "paused" })
        yield* llm.text("paused for now")

        const result = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "resume",
        })
        const text = result.parts.find((part) => part.type === "text")?.text
        expect(text).toContain("Resumed (blocked streak reset): drift")
        expect(text).toContain("- Status: active")

        // resume does not wait for the next user turn: the synthetic
        // continuation message was injected and actually run
        const messages = yield* sessions.messages({ sessionID: session.id })
        const continuations = continuationParts(messages)
        expect(continuations).toHaveLength(1)
        expect(continuations[0]?.text).toContain("<goal-continuation>")
        expect(continuations[0]?.synthetic).toBe(true)
        expect(yield* llm.calls).toBe(2)
        expect(yield* llm.pending).toBe(0)

        // the resume counted as a real user turn: the breaker window is
        // fresh, and the productive continuation recorded a zeroed streak
        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("paused")
        expect(stored?.consecutiveEmptyContinuations).toBe(0)
        expect(stored?.consecutiveContinuations).toBe(1)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal Resume re-arms a paused goal and continues it immediately", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal resume paused",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "pause then resume" })
        yield* goal.updateStatus({ sessionID: session.id, status: "paused" })

        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("done")

        // case-insensitive keyword, like the existing Clear subcommand
        const result = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "Resume",
        })
        const text = result.parts.find((part) => part.type === "text")?.text
        expect(text).toContain("Resumed: pause then resume")
        expect(text).not.toContain("streak reset")
        expect(text).toContain("- Status: active")
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(1)
        expect(yield* llm.calls).toBe(2)
        expect((yield* goal.get(session.id))?.status).toBe("complete")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("/goal resume reports no-goal, no-op, and budget-priority refusal model-free", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal resume branches",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const send = (value: string) =>
          prompt.command({
            sessionID: session.id,
            command: Command.Default.GOAL,
            model: "test/test-model",
            arguments: value,
          })

        // no goal: same unset copy as bare /goal and clear
        const unset = yield* send("resume")
        expect(unset.parts.find((part) => part.type === "text")?.text).toBe("No goal is set for this session.")

        yield* goal.create({ sessionID: session.id, objective: "budget test", tokenBudget: 100 })

        // active: explicit no-op (keyword matching is case-insensitive)
        const active = yield* send("RESUME")
        const activeText = active.parts.find((part) => part.type === "text")?.text
        expect(activeText).toContain("Goal already active")
        expect(activeText).toContain("- Status: active")

        // whole-word keyword only: a multi-word "resume ..." is an objective
        const objective = yield* send("resume the build")
        expect(objective.parts.find((part) => part.type === "text")?.text).toContain(
          "Goal not set: cannot create a new goal because this session has an unfinished goal",
        )

        // cross the budget via account-on-render, then resume is refused
        yield* assistantMessage(session.id, MessageID.ascending(), {
          input: 200,
          output: 0,
          cacheRead: 100,
          cacheWrite: 0,
        })
        const shown = yield* send("")
        expect(shown.parts.find((part) => part.type === "text")?.text).toContain("- Status: budget_limited")
        const refusal = yield* send("resume")
        const refusalText = refusal.parts.find((part) => part.type === "text")?.text
        expect(refusalText).toContain("Goal not resumed: the token budget takes priority over resume")
        expect(refusalText).toContain("/goal <new objective>")
        expect(refusalText).toContain("goal_create")
        const stillLimited = yield* goal.get(session.id)
        expect(stillLimited?.status).toBe("budget_limited")
        expect(stillLimited?.tokensUsed).toBe(100)

        // complete: terminal, no revival
        yield* goal.updateStatus({ sessionID: session.id, status: "complete" })
        const done = yield* send("resume")
        const doneText = done.parts.find((part) => part.type === "text")?.text
        expect(doneText).toContain("Goal is complete and cannot be resumed")
        expect(doneText).toContain("- Status: complete")

        // subagent sessions keep the root-only refusal for resume
        const child = yield* sessions.create({
          title: "Goal resume sub child",
          parentID: session.id,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const sub = yield* prompt.command({
          sessionID: child.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "resume",
        })
        expect(sub.parts.find((part) => part.type === "text")?.text).toContain(
          "Session goals belong to the root session",
        )
        expect(yield* goal.get(child.id)).toBeUndefined()

        // none of these branches ran the model
        expect(yield* llm.calls).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})
