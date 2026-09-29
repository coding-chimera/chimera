import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { and, asc, desc, eq, gt, gte, isNull, like, lt, or, type SQL } from "@/storage/db"
import * as Database from "@/storage/db"
import { Context, DateTime, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { SessionMessage } from "./session-message"
import { AgentAttachment, FileAttachment, Source, type Prompt } from "./session-prompt"
import { EventV2 } from "./event"
import { ProjectID } from "@/project/schema"
import { SessionEvent } from "./session-event"
import { SyncEvent } from "@/sync"
import { V2Schema } from "./schema"
import { optionalOmitUndefined } from "@/util/schema"
import { Modelv2 } from "./model"
import { SessionMessage as SchemaSessionMessage } from "@opencode-ai/schema/session-message"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "v2.session" })

// v2 Prompt -> v1 PromptInput parts. FileAttachment.source is intentionally
// dropped: v1 file sources are a typed union (file/symbol/resource carrying
// path/range/clientName) that cannot be reconstructed from the bare
// { start, end, text } span a v2 attachment provides.
function toParts(prompt: Prompt): SessionPrompt.PromptInput["parts"] {
  const files = (prompt.files ?? []).map((file) => ({
    type: "file" as const,
    mime: file.mime,
    url: file.uri,
    filename: file.name,
  }))
  const agents = (prompt.agents ?? []).map((attachment) => ({
    type: "agent" as const,
    name: attachment.name,
    source: attachment.source
      ? { value: attachment.source.text, start: attachment.source.start, end: attachment.source.end }
      : undefined,
  }))
  const text =
    prompt.text.length > 0 || (files.length === 0 && agents.length === 0)
      ? [{ type: "text" as const, text: prompt.text }]
      : []
  return [...text, ...files, ...agents]
}

// v1 user message -> v2 SessionMessage.User projection, mirroring the fold the
// engine's own Prompted dual-write performs in src/session/prompt.ts
// (createUserMessage). The returned id is the v1 message id; projector-
// materialized rows (src/session/projectors-next.ts) carry sync event ids
// while the TODO(v2) dual-write migration is in flight.
function toUserMessage(message: MessageV2.WithParts): SessionMessage.User {
  const prompt = message.parts.reduce(
    (result, part) => {
      if (part.type === "text" && !part.synthetic) result.text.push(part.text)
      if (part.type === "file")
        result.files.push(
          new FileAttachment({
            uri: part.url,
            mime: part.mime,
            name: part.filename,
            source: part.source
              ? new Source({
                  start: part.source.text.start,
                  end: part.source.text.end,
                  text: part.source.text.value,
                })
              : undefined,
          }),
        )
      if (part.type === "agent")
        result.agents.push(
          new AgentAttachment({
            name: part.name,
            source: part.source
              ? new Source({ start: part.source.start, end: part.source.end, text: part.source.value })
              : undefined,
          }),
        )
      return result
    },
    { text: [] as string[], files: [] as FileAttachment[], agents: [] as AgentAttachment[] },
  )
  return new SessionMessage.User({
    id: SessionMessage.ID.make(message.info.id),
    type: "user",
    text: prompt.text.join("\n"),
    files: prompt.files,
    agents: prompt.agents,
    time: { created: DateTime.makeUnsafe(message.info.time.created) },
  })
}

export const Delivery = Schema.Literals(["immediate", "deferred"]).annotate({
  identifier: "Session.Delivery",
})
export type Delivery = Schema.Schema.Type<typeof Delivery>

export const DefaultDelivery = "immediate" satisfies Delivery

export class Info extends Schema.Class<Info>("Session.Info")({
  id: SessionID,
  parentID: optionalOmitUndefined(SessionID),
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  path: optionalOmitUndefined(Schema.String),
  agent: optionalOmitUndefined(Schema.String),
  model: Modelv2.Ref.pipe(optionalOmitUndefined),
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: optionalOmitUndefined(V2Schema.DateTimeUtcFromMillis),
  }),
  title: Schema.String,
  /*
  slug: Schema.String,
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
  */
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionID,
}) {}

export interface Interface {
  readonly create: (input?: {
    agent?: string
    model?: Modelv2.Ref
    parentID?: SessionID
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input: {
    limit?: number
    order?: "asc" | "desc"
    directory?: string
    path?: string
    workspaceID?: WorkspaceID
    roots?: boolean
    start?: number
    search?: string
    cursor?: {
      id: SessionID
      time: number
      direction: "previous" | "next"
    }
  }) => Effect.Effect<Info[], never>
  readonly messages: (input: {
    sessionID: SessionID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      time: number
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], never>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[], never>
  readonly prompt: (input: {
    id?: EventV2.ID
    sessionID: SessionID
    prompt: Prompt
    delivery?: Delivery
  }) => Effect.Effect<SessionMessage.User, never>
  readonly shell: (input: { id?: EventV2.ID; sessionID: SessionID; command: string }) => Effect.Effect<void, never>
  readonly skill: (input: { id?: EventV2.ID; sessionID: SessionID; skill: string }) => Effect.Effect<void, never>
  readonly subagent: (input: {
    id?: EventV2.ID
    parentID: SessionID
    prompt: Prompt
    agent: string
    model?: Modelv2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionID; agent: string }) => Effect.Effect<void, never>
  readonly switchModel: (input: { sessionID: SessionID; model: Modelv2.Ref }) => Effect.Effect<void, never>
  readonly compact: (sessionID: SessionID) => Effect.Effect<void, never>
  readonly wait: (sessionID: SessionID) => Effect.Effect<void, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sync = yield* SyncEvent.Service
    const sessions = yield* Session.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const compaction = yield* SessionCompaction.Service
    const revert = yield* SessionRevert.Service
    const status = yield* SessionStatus.Service
    const agents = yield* Agent.Service
    const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })

    function fromRow(row: typeof SessionTable.$inferSelect): Info {
      return new Info({
        id: SessionID.make(row.id),
        projectID: ProjectID.make(row.project_id),
        workspaceID: row.workspace_id ? WorkspaceID.make(row.workspace_id) : undefined,
        title: row.title,
        parentID: row.parent_id ? SessionID.make(row.parent_id) : undefined,
        path: row.path ?? "",
        agent: row.agent ?? undefined,
        model: row.model
          ? {
              id: Modelv2.ID.make(row.model.id),
              providerID: Modelv2.ProviderID.make(row.model.providerID),
              variant: Modelv2.VariantID.make(row.model.variant ?? "default"),
            }
          : undefined,
        time: {
          created: DateTime.makeUnsafe(row.time_created),
          updated: DateTime.makeUnsafe(row.time_updated),
          archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
        },
      })
    }

    const result: Interface = {
      create: Effect.fn("V2Session.create")(function* (input) {
        const session = yield* sessions.create({
          parentID: input?.parentID,
          agent: input?.agent,
          workspaceID: input?.workspaceID,
          model: input?.model
            ? {
                id: ModelID.make(input.model.id),
                providerID: ProviderID.make(input.model.providerID),
                variant: input.model.variant,
              }
            : undefined,
        })
        return yield* result.get(session.id).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
        if (!row) return yield* new NotFoundError({ sessionID })
        return fromRow(row)
      }),
      list: Effect.fn("V2Session.list")(function* (input) {
        const direction = input.cursor?.direction ?? "next"
        let order = input.order ?? "desc"
        // Query the adjacent rows in reverse, then flip them back into the requested order below.
        if (direction === "previous" && order === "asc") order = "desc"
        if (direction === "previous" && order === "desc") order = "asc"
        const conditions: SQL[] = []
        if (input.directory) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.path)
          conditions.push(or(eq(SessionTable.path, input.path), like(SessionTable.path, `${input.path}/%`))!)
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if (input.roots) conditions.push(isNull(SessionTable.parent_id))
        if (input.start) conditions.push(gte(SessionTable.time_created, input.start))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.cursor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(SessionTable.time_created, input.cursor.time),
                  and(eq(SessionTable.time_created, input.cursor.time), gt(SessionTable.id, input.cursor.id)),
                )!
              : or(
                  lt(SessionTable.time_created, input.cursor.time),
                  and(eq(SessionTable.time_created, input.cursor.time), lt(SessionTable.id, input.cursor.id)),
                )!,
          )
        }
        const query = Database.Client()
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(SessionTable.time_created) : desc(SessionTable.time_created),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )

        const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const direction = input.cursor?.direction ?? "next"
        let order = input.order ?? "desc"
        // Query the adjacent rows in reverse, then flip them back into the requested order below.
        if (direction === "previous" && order === "asc") order = "desc"
        if (direction === "previous" && order === "desc") order = "asc"
        const boundary = input.cursor
          ? order === "asc"
            ? or(
                gt(SessionMessageTable.time_created, input.cursor.time),
                and(
                  eq(SessionMessageTable.time_created, input.cursor.time),
                  gt(SessionMessageTable.id, input.cursor.id),
                ),
              )
            : or(
                lt(SessionMessageTable.time_created, input.cursor.time),
                and(
                  eq(SessionMessageTable.time_created, input.cursor.time),
                  lt(SessionMessageTable.id, input.cursor.id),
                ),
              )
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)

        const rows = Database.use((db) => {
          const query = db
            .select()
            .from(SessionMessageTable)
            .where(where)
            .orderBy(
              order === "asc" ? asc(SessionMessageTable.time_created) : desc(SessionMessageTable.time_created),
              order === "asc" ? asc(SessionMessageTable.id) : desc(SessionMessageTable.id),
            )
          const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
          return direction === "previous" ? rows.toReversed() : rows
        })
        return rows.map((row) => decode(row))
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        const rows = Database.use((db) => {
          const compaction = db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
            .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
            .limit(1)
            .get()

          return db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                compaction
                  ? or(
                      gt(SessionMessageTable.time_created, compaction.time_created),
                      and(
                        eq(SessionMessageTable.time_created, compaction.time_created),
                        gte(SessionMessageTable.id, compaction.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
            .all()
        })
        return rows.map((row) => decode(row))
      }),
      prompt: Effect.fn("V2Session.prompt")(function* (input) {
        // Fork has no prompt queue: prompts are processed directly
        // (src/session/prompt.ts), so both deliveries run the same turn —
        // "immediate" inline before returning, "deferred" detached. There is
        // no queueing-semantics difference to honor until one exists.
        const user = yield* sessionPrompt
          .prompt({ sessionID: input.sessionID, noReply: true, parts: toParts(input.prompt) })
          .pipe(Effect.orDie)
        if (input.delivery === "deferred") {
          yield* sessionPrompt
            .loop({ sessionID: input.sessionID })
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach)
          return toUserMessage(user)
        }
        yield* sessionPrompt.loop({ sessionID: input.sessionID })
        return toUserMessage(user)
      }),
      shell: Effect.fn("V2Session.shell")(function* (input) {
        // Delegates to the fork's real shell engine, which runs the command,
        // drives the follow-up turn, and dual-writes the v2 Shell.Started/
        // Ended events itself (src/session/prompt.ts shellImpl) — no event
        // bridging is needed here. Note: v1 attaches the run to the session's
        // latest assistant message, so the session must have one.
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        yield* sessionPrompt.shell({
          sessionID: input.sessionID,
          agent: session.agent ?? (yield* agents.defaultAgent()),
          command: input.command,
        })
      }),
      skill: Effect.fn("V2Session.skill")(function* (input) {
        // Deliberate typed no-op: @opencode-ai/schema defines no skill
        // session event, and the fork engine exposes skills to the model as
        // the skill tool inside a turn, not as an imperative per-session
        // entrypoint. Logged instead of inventing an event schema or
        // silently pretending to run.
        log.warn("skill ignored: no v2 skill event or engine binding", {
          sessionID: input.sessionID,
          skill: input.skill,
        })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* EventV2.run(sync, SessionEvent.AgentSwitched.Sync, {
          sessionID: input.sessionID,
          messageID: SchemaSessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(Date.now()),
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        yield* EventV2.run(sync, SessionEvent.ModelSwitched.Sync, {
          sessionID: input.sessionID,
          messageID: SchemaSessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(Date.now()),
          model: SessionEvent.modelRef(input.model),
        })
      }),
      subagent: Effect.fn("V2Session.subagent")(function* (input) {
        const parent = yield* result.get(input.parentID)
        const session = yield* result.create({
          agent: input.agent,
          model: input.model,
          parentID: input.parentID,
          workspaceID: parent.workspaceID,
        })
        yield* Effect.gen(function* () {
          // Run the child turn inline in this detached fiber: the v1 prompt
          // returns the final assistant message, so delivery never depends
          // on a wait/poll race against the loop marking the session busy.
          const message = yield* sessionPrompt
            .prompt({ sessionID: session.id, agent: input.agent, parts: toParts(input.prompt) })
            .pipe(Effect.orDie)
          const text = message.parts
            .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
            .map((part) => part.text)
            .join("\n")
          if (!text) return
          // Deliver the child answer the way the fork's background task
          // delivery does: a synthetic message that wakes the parent turn.
          yield* sessionPrompt
            .injectSynthetic({ sessionID: input.parentID, text })
            .pipe(Effect.ignoreCause({ log: true }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("subagent run failed", { sessionID: session.id, cause })),
          ),
          Effect.forkDetach,
        )
      }),
      compact: Effect.fn("V2Session.compact")(function* (sessionID) {
        // Mirrors the v1 summarize route: clear any staged revert, stage a
        // manual compaction against the latest user turn's agent/model, then
        // drive the loop that performs the summarization turn.
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        yield* revert.cleanup(session)
        const messages = yield* sessions.messages({ sessionID })
        const lastUser = messages.findLast(
          (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
        )
        const model =
          lastUser?.info.model ??
          (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
        if (!model) {
          // A session that never prompted has nothing to compact and no
          // model to compact with.
          log.info("compact skipped: session has no prompted turn", { sessionID })
          return
        }
        yield* compaction.create({
          sessionID,
          agent: lastUser?.info.agent || (yield* agents.defaultAgent()),
          model,
          auto: false,
        })
        yield* sessionPrompt.loop({ sessionID })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        // SessionStatus is the fork's in-flight marker: the prompt loop
        // marks the session busy while an assistant turn (compaction
        // included) runs and idle when it settles (src/session/prompt.ts,
        // src/session/processor.ts). Polls on a short cadence instead of
        // only subscribing to the status bus: an idle transition landing
        // between a read and a later subscription would hang the waiter
        // forever, and wait must always resolve. Semantics: resolves when
        // the marker reads idle; a detached turn that has not marked the
        // session busy yet can resolve early.
        yield* Stream.fromEffectSchedule(status.get(sessionID), Schedule.spaced("50 millis")).pipe(
          Stream.dropWhile((info) => info.type !== "idle"),
          Stream.take(1),
          Stream.runDrain,
        )
      }),
    }

    return Service.of(result)
  }),
)

// The v2 write methods are thin aliases over the v1 engine, so the default
// layer carries the v1 stack. In the server build these are the same layer
// objects httpapi/server.ts provides for the v1 handlers, so Effect's layer
// memoization shares one instance across the whole graph — critically, wait
// and prompt must observe the same SessionStatus the prompt loop mutates.
export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      SyncEvent.defaultLayer,
      Session.defaultLayer,
      SessionPrompt.defaultLayer,
      SessionCompaction.defaultLayer,
      SessionRevert.defaultLayer,
      SessionStatus.defaultLayer,
      Agent.defaultLayer,
    ),
  ),
)

export * as SessionV2 from "./session"
