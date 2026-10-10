import { beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { Database } from "@/storage/db"
import { Goal } from "@/session/goal"
import { MessageID, SessionID } from "@/contracts/session-ids"
import { GoalTable, MessageTable } from "@/storage/tables/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { Command } from "@/command"
import { SessionPrompt } from "@/session/prompt"
import { BackgroundJob } from "@/agent/background-job"
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

  it.instance("block trips only an active goal, records the reason, and clears on resume/update", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      expect(yield* goal.block({ sessionID, reason: "no goal yet" })).toBeUndefined()

      yield* goal.create({ sessionID, objective: "breaker" })
      const blocked = yield* goal.block({ sessionID, reason: "turn ended with a non-retryable error: boom" })
      expect(blocked?.status).toBe("blocked")
      expect(blocked?.blockedReason).toContain("non-retryable")
      expect((yield* goal.get(sessionID))?.blockedReason).toContain("boom")

      // a second trip does not overwrite an already non-active goal
      // a second trip against the already-blocked goal is a no-op and keeps
      // the first reason
      expect(yield* goal.block({ sessionID, reason: "ignored" })).toBeUndefined()
      expect((yield* goal.get(sessionID))?.blockedReason).toContain("boom")

      // resume from blocked clears the recorded reason for a fresh audit
      const resumed = yield* goal.resume(sessionID)
      expect(resumed.status).toBe("active")
      expect(resumed.blockedReason).toBeUndefined()

      // and a model-side status change clears a stale reason too
      yield* goal.block({ sessionID, reason: "stale" }).pipe(Effect.orDie)
      const done = yield* goal.updateStatus({ sessionID, status: "complete" })
      expect(done.blockedReason).toBeUndefined()
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

  it.instance("resume from blocked zeroes the tool-failure streak too", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "tool audit" })
      yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false] })
      yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false] })
      const blocked = yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false] })
      expect(blocked?.status).toBe("blocked")
      expect(blocked?.consecutiveToolFailures).toBe(3)

      const resumed = yield* goal.resume(sessionID)
      expect(resumed.status).toBe("active")
      expect(resumed.consecutiveToolFailures).toBe(0)

      // fresh audit: one failure now stays active, three re-block
      yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false] })
      expect((yield* goal.get(sessionID))?.status).toBe("active")
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

  it.instance("recordContinuation folds toolOutcomes into the persisted streak", () =>
    Effect.gen(function* () {
      const goal = yield* Goal.Service
      yield* goal.create({ sessionID, objective: "tool streak" })

      const one = yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false, false] })
      expect(one?.consecutiveToolFailures).toBe(2)
      expect(one?.status).toBe("active")

      const reset = yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [true, false] })
      expect(reset?.consecutiveToolFailures).toBe(1)

      const blocked = yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false, false] })
      expect(blocked?.consecutiveToolFailures).toBe(3)
      expect(blocked?.status).toBe("blocked")

      // omitting toolOutcomes leaves the streak untouched but keeps counting turns
      const untouched = yield* goal.recordContinuation({ sessionID, productive: true })
      expect(untouched?.consecutiveToolFailures).toBe(3)
      expect(untouched?.consecutiveContinuations).toBe(4)
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
      yield* goal.recordContinuation({ sessionID, productive: true, toolOutcomes: [false] })
      yield* goal.resetContinuation(sessionID)
      const stored = yield* goal.get(sessionID)
      expect(stored?.consecutiveEmptyContinuations).toBeUndefined()
      expect(stored?.consecutiveContinuations).toBeUndefined()
      expect(stored?.consecutiveToolFailures).toBeUndefined()
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
        "- This goal auto-continues: when a turn ends with the goal active, a continuation turn starts automatically. Turns that end without any tool calls count as unproductive; 3 consecutive unproductive continuations mark the goal blocked. 3 consecutive failing tool calls in continuation turns, or a turn ending on a non-retryable error, also mark it blocked.",
      )
      yield* goal.render(sessionID).pipe(Effect.asVoid)
      const blocked = yield* goal.block({ sessionID, reason: "turn ended with a non-retryable error: boom" })
      expect(blocked?.status).toBe("blocked")
      expect((yield* goal.render(sessionID)) ?? "").toContain(
        "- Status: blocked · Reason: turn ended with a non-retryable error: boom",
      )
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

  test("tool outcomes fold a streak, reset on success, and block at three", () => {
    const one = Goal.continuationOutcome(base, { productive: true, toolOutcomes: [false] })
    expect(one.consecutiveToolFailures).toBe(1)
    expect(one.status).toBe("active")

    const two = Goal.continuationOutcome(one, { productive: true, toolOutcomes: [false] })
    expect(two.consecutiveToolFailures).toBe(2)

    // a success anywhere in the turn zeroes the streak (codex semantics: any
    // progress resets the failure audit)
    const reset = Goal.continuationOutcome(two, { productive: true, toolOutcomes: [false, true] })
    expect(reset.consecutiveToolFailures).toBe(0)
    expect(reset.status).toBe("active")

    const three = Goal.continuationOutcome(
      Goal.continuationOutcome(Goal.continuationOutcome(base, { productive: true, toolOutcomes: [false] }), {
        productive: true,
        toolOutcomes: [false],
      }),
      { productive: true, toolOutcomes: [false] },
    )
    expect(three.consecutiveToolFailures).toBe(3)
    expect(three.status).toBe("blocked")
  })

  test("omitting toolOutcomes leaves an existing streak untouched", () => {
    const streak = Goal.continuationOutcome(base, { productive: true, toolOutcomes: [false, false] })
    const untouched = Goal.continuationOutcome(streak, { productive: true })
    expect(untouched.consecutiveToolFailures).toBe(2)
    expect(untouched.status).toBe("active")
  })
})

// ── auto-continuation run-loop integration (harness-driven) ─────────────────

const continuationParts = (messages: MessageV2.WithParts[]) =>
  messages
    .flatMap((msg) => msg.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && part.metadata?.goalContinuation === true)

// A job whose run never settles, registered as owned by `ownerSessionID`.
// The goal continuation stop-gate counts family ownership, not the
// foreground/background flag (mirrors background-tasks-context.test.ts).
const startHeldJob = Effect.fnUntraced(function* (ownerSessionID: SessionID, id: string) {
  const jobs = yield* BackgroundJob.Service
  yield* jobs.start({ id, type: "task", title: "held", ownerSessionId: ownerSessionID, run: Effect.never })
})

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

  loopIt.live("a run-loop exit while the family still runs a job is not a stop: no injection, no counter change", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const jobs = yield* BackgroundJob.Service
        const session = yield* sessions.create({
          title: "True stop",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "wait for the family" })
        // Pre-seed a mid-breaker window (streak 2, cont 2): if the waiting beat
        // reached any bookkeeping, resetContinuation would clear the counters
        // (a real user turn) or recordContinuation would extend the streak
        // toward a false blocked flip (a continuation turn).
        yield* goal.recordContinuation({ sessionID: session.id, productive: false })
        yield* goal.recordContinuation({ sessionID: session.id, productive: false })

        yield* startHeldJob(session.id, "stop-waiting")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one") // the real turn ends without a tool call
        yield* llm.text("two") // bait a pre-fix racing continuation would burn
        yield* prompt.loop({ sessionID: session.id })

        // True stop has not happened: the beat is skipped whole — no injected
        // continuation, no extra model call, counters untouched.
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(1)
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(0)
        const waiting = yield* goal.get(session.id)
        expect(waiting?.status).toBe("active")
        expect(waiting?.consecutiveEmptyContinuations).toBe(2)
        expect(waiting?.consecutiveContinuations).toBe(2)

        // The family job settles; the next turn end is a true stop and
        // continuation works exactly as before the fix.
        yield* jobs.cancel("stop-waiting")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "again" }],
        })
        yield* llm.tool("goal_update", { status: "complete" }) // productive continuation turn
        yield* llm.text("done")
        yield* prompt.loop({ sessionID: session.id })

        expect(yield* llm.calls).toBe(4)
        expect(yield* llm.pending).toBe(0)
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(1)
        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("complete")
        expect(stored?.consecutiveEmptyContinuations).toBe(0)
        expect(stored?.consecutiveContinuations).toBe(1)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("a running job owned by a descendant session also defers the continuation beat", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const jobs = yield* BackgroundJob.Service
        const root = yield* sessions.create({
          title: "Family root",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const child = yield* sessions.create({
          title: "Family child",
          parentID: root.id,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: root.id, objective: "orchestrate" })
        yield* startHeldJob(child.id, "stop-descendant")
        yield* prompt.prompt({
          sessionID: root.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.text("one")
        yield* llm.text("two")
        yield* prompt.loop({ sessionID: root.id })

        // The gate walks the whole session family (sessionFamilyIDs BFS), so a
        // descendant-owned job defers the root's continuation too.
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(1)
        expect(continuationParts(yield* sessions.messages({ sessionID: root.id }))).toHaveLength(0)
        expect((yield* goal.get(root.id))?.status).toBe("active")

        yield* jobs.cancel("stop-descendant")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("three consecutive failing tool calls in continuation turns block the goal", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Failing tools",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "flaky tools" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        // user turn ends without tools -> continuation 1; three continuation
        // turns each end on a single failing tool call (productive, so the
        // empty-streak breaker stays blind to it — the F4 breaker catches it)
        yield* llm.text("one")
        for (let turn = 0; turn < 3; turn++) {
          yield* llm.tool("read", { filePath: "/nonexistent-goal-bench-file" })
          yield* llm.text(`fail ${turn + 1}`)
        }

        yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.calls).toBe(7)
        expect(yield* llm.pending).toBe(0)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(continuationParts(messages)).toHaveLength(3)

        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("blocked")
        expect(stored?.consecutiveToolFailures).toBe(3)
        expect(stored?.consecutiveEmptyContinuations).toBe(0)
        expect(stored?.consecutiveContinuations).toBe(3)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("a success zeroes the tool streak and user-turn failures do not count", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Streak reset",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "recover" })
        // the real user turn already ends on a failing tool call: resetContinuation
        // clears the streak, so that failure must never enter the counter
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* llm.tool("read", { filePath: "/nonexistent-goal-bench-file" })
        yield* llm.text("user turn done")
        // continuation 1: failure -> streak 1
        yield* llm.tool("read", { filePath: "/nonexistent-goal-bench-file" })
        yield* llm.text("cont 1")
        // continuation 2: success (the fixture config file exists) -> streak 0
        yield* llm.tool("read", { filePath: path.join(dir, "chimera.json") })
        yield* llm.text("cont 2")
        // continuation 3 ends the chain: the goal is paused by a productive tool
        yield* llm.tool("goal_update", { status: "paused" })
        yield* llm.text("cont 3")

        yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.pending).toBe(0)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(continuationParts(messages)).toHaveLength(3)

        const stored = yield* goal.get(session.id)
        // the user-turn failure was not counted (else the streak would sit
        // one higher and the sequence could re-block), and the mid-chain
        // success zeroed what continuation 1 had accumulated
        expect(stored?.status).toBe("paused")
        expect(stored?.consecutiveToolFailures).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

describe("session.goal turn-error breaker (F3)", () => {
  loopIt.live("a non-retryable turn error blocks the active goal and stops continuation", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Turn error",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "crash course" })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        // a 400 response is a non-retryable API error: the turn halts after
        // SessionRetry declines to retry it, and the F3 breaker trips
        yield* llm.error(400, { error: { message: "invalid_request: boom" } })

        yield* prompt.loop({ sessionID: session.id })
        // the pre-fix loop injected a continuation after the error turn; the
        // F3 breaker exits instead (no second model call)
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(0)
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(0)

        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("blocked")
        expect(stored?.blockedReason).toContain("non-retryable")
        expect(stored?.blockedReason).toContain("invalid_request")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("a retryable failure does not trip the goal breaker", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Retryable error",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "rate limited" })
        // four identical 500s: the first is the call, three are SessionRetry
        // attempts (the default retry limit, with backoff waits); the exhausted
        // retryable error must NOT flip the goal, and the continuation the
        // pre-existing stop-site flow injects finishes it
        for (let attempt = 0; attempt < 4; attempt++) yield* llm.error(500, { error: { message: "server overloaded" } })
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        yield* prompt.loop({ sessionID: session.id })

        expect(yield* llm.calls).toBe(6)
        expect(yield* llm.pending).toBe(0)
        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("complete")
        expect(stored?.blockedReason).toBeUndefined()
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

describe("session.goal external kick (F1) and reopen kick (F2)", () => {
  loopIt.live("kickGoalContinuation starts an active goal on an idle session", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "External kick",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // one real user turn gives the session the history/kick precondition
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        yield* llm.text("hi")
        yield* prompt.loop({ sessionID: session.id })

        // goal lands via the service (what HTTP PUT drives, minus the route);
        // the kicked continuation turn completes it
        yield* goal.create({ sessionID: session.id, objective: "goal from outside" })
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("all done")

        expect(yield* prompt.kickGoalContinuation(session.id)).toBe(true)
        // drive the forked run to completion and inspect the result
        yield* prompt.loop({ sessionID: session.id })
        expect(yield* llm.calls).toBe(3)
        expect(yield* llm.pending).toBe(0)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(continuationParts(messages)).toHaveLength(1)

        const stored = yield* goal.get(session.id)
        expect(stored?.status).toBe("complete")
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("kickGoalContinuation skips goals that must not auto-continue", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service

        // paused: nothing to kick
        const paused = yield* sessions.create({
          title: "Kick paused",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: paused.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        yield* llm.text("hi")
        yield* prompt.loop({ sessionID: paused.id })
        yield* goal.create({ sessionID: paused.id, objective: "paused goal" })
        yield* goal.updateStatus({ sessionID: paused.id, status: "paused" })
        expect(yield* prompt.kickGoalContinuation(paused.id)).toBe(false)

        // no goal at all
        expect(yield* prompt.kickGoalContinuation(sessionID)).toBe(false)

        // a brand-new session with no user message: nothing to inherit
        // agent/model from, the first real turn's loop exit covers it
        const fresh = yield* sessions.create({
          title: "Kick fresh",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: fresh.id, objective: "fresh goal" })
        expect(yield* prompt.kickGoalContinuation(fresh.id)).toBe(false)
        expect(continuationParts(yield* sessions.messages({ sessionID: fresh.id }))).toHaveLength(0)

        // subagent-owned goals are never kicked
        const child = yield* sessions.create({
          title: "Kick sub",
          parentID: paused.id,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: child.id, objective: "child goal" })
        expect(yield* prompt.kickGoalContinuation(child.id)).toBe(false)

        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )

  loopIt.live("resumeGoalOnOpen kicks once per instance and never for inactive goals", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Reopen kick",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        yield* llm.text("hi")
        yield* prompt.loop({ sessionID: session.id })

        yield* goal.create({ sessionID: session.id, objective: "recover after restart" })
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("recovered")

        // first "open" after a (simulated) restart enters the live runtime: the
        // goal is kicked and actually runs
        expect(yield* prompt.resumeGoalOnOpen(session.id)).toBe(true)
        yield* prompt.loop({ sessionID: session.id })
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(1)
        expect((yield* goal.get(session.id))?.status).toBe("complete")

        // repeated opens of the same session in the same instance are idempotent
        expect(yield* prompt.resumeGoalOnOpen(session.id)).toBe(false)
        expect(yield* llm.calls).toBe(3)
        expect(yield* llm.pending).toBe(0)
      }),
      { git: true, config: testProviderConfig },
    ),
  )
})

describe("session.goal /goal command", () => {
  loopIt.live("/goal create-then-start kicks the continuation; show and refuse stay model-free", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const commands = yield* Command.Service

        const listed = yield* commands.list()
        expect(listed.some((command) => command.name === Command.Default.GOAL)).toBe(true)

        // create is no longer model-free (F1, codex apply_external_goal_set ->
        // continue_if_idle): the command kicks a continuation turn and blocks on
        // it; the queued replies finish the goal inside that run.
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("widget shipped")
        const kicked = yield* sessions.create({
          title: "Goal command kick",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const created = yield* prompt.command({
          sessionID: kicked.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "  ship the widget  ",
        })
        expect(created.info.role).toBe("assistant")
        expect(created.parts.find((part) => part.type === "text")?.text).toContain("- Objective: ship the widget")
        const kickedStored = yield* goal.get(kicked.id)
        expect(kickedStored?.objective).toBe("ship the widget")
        // the kicked loop ran (and finished) before the command returned
        expect(kickedStored?.status).toBe("complete")

        // the typed command is echoed (trimmed) as a user text part, like /init-graph
        const messages = yield* sessions.messages({ sessionID: kicked.id })
        const echoed = messages
          .find((message) => message.info.role === "user")
          ?.parts.find((part) => part.type === "text")
        expect(echoed?.text).toBe("/goal ship the widget")
        expect(continuationParts(messages)).toHaveLength(1)
        expect(yield* llm.calls).toBe(2)
        expect(yield* llm.pending).toBe(0)

        // with a pre-existing unfinished goal the branches that must not run
        // the model still do not: goal.create via the service does not kick,
        // bare /goal renders state, and a second create is refused
        const session = yield* sessions.create({
          title: "Goal command",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "ship the widget" })

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
        expect(yield* llm.calls).toBe(2)
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

  loopIt.live("/goal replaces a completed goal via the create path and starts it", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const session = yield* sessions.create({
          title: "Goal replace",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* goal.create({ sessionID: session.id, objective: "first objective" })
        yield* goal.updateStatus({ sessionID: session.id, status: "complete" })

        // the replacement create kicks its continuation turn (F1); the queued
        // replies finish the new goal before the command returns
        yield* llm.tool("goal_update", { status: "complete" })
        yield* llm.text("second objective done")
        const replaced = yield* prompt.command({
          sessionID: session.id,
          command: Command.Default.GOAL,
          model: "test/test-model",
          arguments: "second objective",
        })
        expect(replaced.parts.find((part) => part.type === "text")?.text).toContain("- Objective: second objective")
        const stored = yield* goal.get(session.id)
        expect(stored?.objective).toBe("second objective")
        expect(stored?.status).toBe("complete")
        expect(continuationParts(yield* sessions.messages({ sessionID: session.id }))).toHaveLength(1)
        expect(yield* llm.calls).toBe(2)
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
