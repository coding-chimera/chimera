import { Effect, Layer, Context, Schema, Types } from "effect"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { MessageID, SessionID } from "./schema"
import { GoalTable, MessageTable, SessionTable } from "./session.sql"
import type { MessageV2 } from "./message-v2"

const MAX_OBJECTIVE_CHARS = 800

// Circuit breakers for goal auto-continuation: a continuation turn that ends
// without any tool call counts as unproductive; MAX_EMPTY_CONTINUATIONS
// consecutive unproductive continuations flip an active goal to blocked, and
// continuation stops after MAX_CONTINUATION_TURNS consecutive continuation
// turns regardless of productivity.
export const MAX_EMPTY_CONTINUATIONS = 3
export const MAX_CONTINUATION_TURNS = 25

const BUDGET_LIMITED_GUIDANCE =
  "The goal token budget is exhausted. Wrap up the current turn soon, do not start new substantive work for this goal, and report progress against the objective."

export const Status = Schema.Literals(["active", "paused", "blocked", "budget_limited", "complete"])
  .annotate({ identifier: "GoalStatus" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Status = Schema.Schema.Type<typeof Status>

export const Info = Schema.Struct({
  objective: Schema.String,
  status: Status,
  tokenBudget: Schema.optional(Schema.Number),
  tokensUsed: Schema.Number,
  usageWatermarks: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  consecutiveEmptyContinuations: Schema.optional(Schema.Number),
  consecutiveContinuations: Schema.optional(Schema.Number),
})
  .annotate({ identifier: "Goal" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: BusEvent.define(
    "goal.updated",
    Schema.Struct({
      sessionID: SessionID,
      goal: Info,
    }),
  ),
  Cleared: BusEvent.define(
    "goal.cleared",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly create: (input: {
    sessionID: SessionID
    objective: string
    tokenBudget?: number
  }) => Effect.Effect<Info, Error>
  readonly updateStatus: (input: { sessionID: SessionID; status: Status }) => Effect.Effect<Info, Error>
  readonly resume: (sessionID: SessionID) => Effect.Effect<Info, Error>
  readonly account: (sessionID: SessionID) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly recordContinuation: (input: { sessionID: SessionID; productive: boolean }) => Effect.Effect<Info | undefined>
  readonly resetContinuation: (sessionID: SessionID) => Effect.Effect<void>
  readonly render: (sessionID: SessionID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

function compact(input: string) {
  const value = input.replace(/\s+/g, " ").trim()
  return value.length > MAX_OBJECTIVE_CHARS ? `${value.slice(0, MAX_OBJECTIVE_CHARS - 3)}...` : value
}

// Allowed model-side status transitions: active -> complete|blocked|paused,
// paused -> active (user-requested resume), and anything -> complete.
// Resuming a blocked or budget_limited goal is not model-expressible:
// paused/blocked resume rides the separate user-side `resume` method, and a
// budget_limited goal needs a new goal (the budget cap takes priority over
// resume). Mirrors codex ext/goal, where resume is a user/system controlled
// channel and budget limits outrank pause/resume.
function isAllowedTransition(from: Status, to: Status) {
  if (to === "complete") return true
  if (from === "active") return to === "blocked" || to === "paused"
  return from === "paused" && to === "active"
}

export function billableTokens(tokens: MessageV2.TokenUsage) {
  return Math.max(0, tokens.input - tokens.cache.read + tokens.output)
}

// Rows persisted before token accounting became per-session carry a single
// `lastUsageMessageID` watermark that applied to the goal's own session.
// `get` folds that field into `usageWatermarks` on read; new writes never
// include it.
type LegacyWatermark = { lastUsageMessageID?: string }

// Transitive closure of the session subtree rooted at `sessionID`: child
// (subagent) sessions discovered one `parent_id` hop at a time, each level a
// single lookup on the indexed `session_parent_idx`. The visited set also
// guards against accidental parent cycles.
function descendantIDs(db: Database.TxOrDb, sessionID: SessionID) {
  const seen = new Set<SessionID>()
  let frontier: SessionID[] = [sessionID]
  while (frontier.length > 0) {
    const next: SessionID[] = []
    for (const row of db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, frontier))
      .all()) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      next.push(row.id)
    }
    frontier = next
  }
  return [...seen]
}

// Outcome of one finished continuation turn. A productive turn resets the
// empty streak; an unproductive one extends it. Three consecutive empty
// streak flips an active goal to blocked (the circuit breaker).
export function continuationOutcome(goal: Info, input: { productive: boolean }): Info {
  const consecutiveEmptyContinuations = input.productive ? 0 : (goal.consecutiveEmptyContinuations ?? 0) + 1
  const next: Info = {
    ...goal,
    consecutiveEmptyContinuations,
    consecutiveContinuations: (goal.consecutiveContinuations ?? 0) + 1,
  }
  if (consecutiveEmptyContinuations >= MAX_EMPTY_CONTINUATIONS && next.status === "active")
    return { ...next, status: "blocked" }
  return next
}

// Whether the run loop should inject another synthetic continuation turn for
// this goal: it must exist, be active, and stay under the turn cap.
export function canAutoContinue(goal: Info | undefined) {
  return goal !== undefined && goal.status === "active" && (goal.consecutiveContinuations ?? 0) < MAX_CONTINUATION_TURNS
}

const formatTokens = (value: number) => value.toLocaleString("en-US")

const AUTO_CONTINUATION_GUIDANCE =
  "- This goal auto-continues: when a turn ends with the goal active, a continuation turn starts automatically. Turns that end without any tool calls count as unproductive; 3 consecutive unproductive continuations mark the goal blocked."

export function format(goal: Info) {
  if (goal.status === "complete")
    return [`## Session Goal`, `- Status: complete · Objective: ${compact(goal.objective)}`].join("\n")
  const usage =
    goal.tokenBudget === undefined
      ? `- Tokens used: ${formatTokens(goal.tokensUsed)} (no budget set)`
      : `- Tokens used: ${formatTokens(goal.tokensUsed)} / budget: ${formatTokens(goal.tokenBudget)} (${formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed))} remaining)`
  return [
    "## Session Goal",
    `- Status: ${goal.status}`,
    `- Objective: ${compact(goal.objective)}`,
    usage,
    ...(goal.status === "active" ? [AUTO_CONTINUATION_GUIDANCE] : []),
    ...(goal.status === "budget_limited" ? [BUDGET_LIMITED_GUIDANCE] : []),
  ].join("\n")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      const data = yield* Effect.sync(
        () =>
          Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).limit(1).get())
            ?.data,
      )
      if (!data) return undefined
      const legacy = (data as LegacyWatermark).lastUsageMessageID
      if (legacy === undefined) return data
      const goal: Info = { ...data, usageWatermarks: { [sessionID]: legacy, ...data.usageWatermarks } }
      delete (goal as LegacyWatermark).lastUsageMessageID
      return goal
    })

    const create = Effect.fn("Goal.create")(function* (input: {
      sessionID: SessionID
      objective: string
      tokenBudget?: number
    }) {
      const objective = compact(input.objective)
      if (!objective) return yield* Effect.fail(new Error("The goal objective must not be empty."))
      const existing = yield* get(input.sessionID)
      if (existing && existing.status !== "complete")
        return yield* Effect.fail(
          new Error(
            "cannot create a new goal because this session has an unfinished goal; complete or update the existing goal first",
          ),
        )
      const goal: Info = {
        objective,
        status: "active",
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        tokensUsed: 0,
      }
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(GoalTable).where(eq(GoalTable.session_id, input.sessionID)).run()
          db.insert(GoalTable)
            .values([{ session_id: input.sessionID, data: goal }])
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, goal })
      return goal
    })

    const updateStatus = Effect.fn("Goal.updateStatus")(function* (input: { sessionID: SessionID; status: Status }) {
      const current = yield* get(input.sessionID)
      if (!current) return yield* Effect.fail(new Error("No goal is set for this session; create one first."))
      if (current.status === input.status) return yield* Effect.fail(new Error(`The goal is already ${input.status}.`))
      if (!isAllowedTransition(current.status, input.status)) {
        if (input.status === "active" && current.status === "blocked")
          return yield* Effect.fail(
            new Error(
              "You cannot resume a blocked goal with goal_update; resuming is the user's call — ask them to run /goal resume.",
            ),
          )
        if (input.status === "active" && current.status === "budget_limited")
          return yield* Effect.fail(
            new Error(
              "You cannot resume a budget_limited goal with goal_update: the token budget takes priority over resume. The user must create a new goal with a fresh budget (/goal <objective> or goal_create).",
            ),
          )
        if (current.status === "complete")
          return yield* Effect.fail(
            new Error("This goal is already complete; create a new goal to start further work."),
          )
        return yield* Effect.fail(new Error(`Cannot transition the goal from ${current.status} to ${input.status}.`))
      }
      const goal: Info = { ...current, status: input.status }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(GoalTable).set({ data: goal }).where(eq(GoalTable.session_id, input.sessionID)).run(),
        ),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, goal })
      return goal
    })

    // Incremental token accounting across the session subtree: for the goal's
    // own session and every descendant (subagent) session, sum billable tokens
    // of completed assistant messages newer than that session's watermark,
    // advance the watermarks, and persist the aggregate once. Sessions without
    // a watermark (e.g. children created after the goal) count their full
    // history, matching how the goal's own session is accounted from scratch.
    // Never rescans full history; a no-op when no goal row exists.
    const account = Effect.fn("Goal.account")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return
      const scanned = yield* Effect.sync(() =>
        Database.use((db) =>
          [sessionID, ...descendantIDs(db, sessionID)].map((id) => {
            const watermark = current.usageWatermarks?.[id]
            const rows = db
              .select()
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.session_id, id),
                  watermark ? gt(MessageTable.id, MessageID.make(watermark)) : undefined,
                  sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
                  sql`json_extract(${MessageTable.data}, '$.time.completed') IS NOT NULL`,
                ),
              )
              .orderBy(MessageTable.id)
              .all()
            const last = rows.at(-1)?.id
            if (last === undefined) return undefined
            const delta = rows.reduce((total, row) => {
              const message = row.data as MessageV2.Info
              if (message.role !== "assistant") return total
              return total + billableTokens(message.tokens)
            }, 0)
            return { sessionID: id, last, delta }
          }),
        ),
      )
      const advanced = scanned.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      if (advanced.length === 0) return
      const delta = advanced.reduce((total, entry) => total + entry.delta, 0)
      const accounted: Info = {
        ...current,
        tokensUsed: current.tokensUsed + delta,
        usageWatermarks: Object.fromEntries([
          ...Object.entries(current.usageWatermarks ?? {}),
          ...advanced.map((entry) => [entry.sessionID, entry.last] as const),
        ]),
      }
      const goal: Info =
        accounted.status === "active" &&
        accounted.tokenBudget !== undefined &&
        accounted.tokensUsed >= accounted.tokenBudget
          ? { ...accounted, status: "budget_limited" }
          : accounted
      yield* Effect.sync(() =>
        Database.use((db) => db.update(GoalTable).set({ data: goal }).where(eq(GoalTable.session_id, sessionID)).run()),
      )
      yield* bus.publish(Event.Updated, { sessionID, goal })
    })

    // Remove the goal row and publish `goal.cleared`; consumers drop the goal
    // from their view of the session. Idempotent: reports whether a goal
    // existed to clear.
    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return false
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(GoalTable).where(eq(GoalTable.session_id, sessionID)).run()),
      )
      yield* bus.publish(Event.Cleared, { sessionID })
      return true
    })

    // Persist a goal row and publish the update; shared by the continuation
    // bookkeeping methods below.
    const persist = Effect.fnUntraced(function* (sessionID: SessionID, goal: Info) {
      yield* Effect.sync(() =>
        Database.use((db) => db.update(GoalTable).set({ data: goal }).where(eq(GoalTable.session_id, sessionID)).run()),
      )
      yield* bus.publish(Event.Updated, { sessionID, goal })
      return goal
    })

    // Record one finished auto-continuation turn; no-op (undefined) when the
    // session has no goal row.
    const recordContinuation = Effect.fn("Goal.recordContinuation")(function* (input: {
      sessionID: SessionID
      productive: boolean
    }) {
      const current = yield* get(input.sessionID)
      if (!current) return undefined
      return yield* persist(input.sessionID, continuationOutcome(current, { productive: input.productive }))
    })

    // A real user turn clears the continuation streak so each new user message
    // starts a fresh breaker window.
    const resetContinuation = Effect.fn("Goal.resetContinuation")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return
      if (current.consecutiveEmptyContinuations === undefined && current.consecutiveContinuations === undefined) return
      const goal: Info = { ...current }
      delete goal.consecutiveEmptyContinuations
      delete goal.consecutiveContinuations
      yield* persist(sessionID, goal)
    })

    // User-side resume (`/goal resume`). Deliberately separate from
    // updateStatus: the model-facing transition table keeps blocked -> active
    // unavailable (codex: resume is user/system controlled, never a model tool
    // capability). paused -> active re-arms auto-continuation; blocked ->
    // active additionally zeroes the consecutive-empty-continuation streak so
    // the breaker starts a fresh blocked audit (3 more unproductive
    // continuations are needed to re-block), while the total-turn cap counter
    // is kept. budget_limited refuses — the budget limit takes priority over
    // resume, so a new goal with a fresh budget is required and the existing
    // usage ledger stays untouched. complete is terminal.
    const resume = Effect.fn("Goal.resume")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return yield* Effect.fail(new Error("No goal is set for this session; create one first."))
      if (current.status === "active") return yield* Effect.fail(new Error("The goal is already active."))
      if (current.status === "complete")
        return yield* Effect.fail(new Error("This goal is already complete; create a new goal to start further work."))
      if (current.status === "budget_limited")
        return yield* Effect.fail(
          new Error(
            "The goal token budget is exhausted; budget limits take priority over resume. Create a new goal with a fresh budget instead.",
          ),
        )
      const goal: Info = {
        ...current,
        status: "active",
        ...(current.status === "blocked" ? { consecutiveEmptyContinuations: 0 } : {}),
      }
      return yield* persist(sessionID, goal)
    })

    const render = Effect.fn("Goal.render")(function* (sessionID: SessionID) {
      yield* account(sessionID)
      const goal = yield* get(sessionID)
      if (!goal) return undefined
      return format(goal)
    })

    return Service.of({
      get,
      create,
      updateStatus,
      resume,
      account,
      clear,
      recordContinuation,
      resetContinuation,
      render,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Goal from "./goal"
