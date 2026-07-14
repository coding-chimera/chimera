import z from "zod"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { zod } from "@/util/effect-zod"
import { MemoryArtifacts } from "./artifacts"
import { MemoryLegacy } from "./legacy"
import { Memory } from "./memory"
import { MemorySecurity } from "./security"
import { MemoryStore, type Scope as StoreScope } from "./store"

const MAX_TEXT_CHARS = 4_000

export const Scope = Schema.Union([Schema.Literal("global"), Schema.Literal("project")])
export type Scope = Schema.Schema.Type<typeof Scope>

export const StatusScope = Schema.Union([Schema.Literal("global"), Schema.Literal("project"), Schema.Literal("all")])
export type StatusScope = Schema.Schema.Type<typeof StatusScope>

export class Note extends Schema.Class<Note>("MemoryNote")({
  id: Schema.String,
  text: Schema.String,
  scope: Scope,
  sourceKind: Schema.Union([
    Schema.Literal("explicit"),
    Schema.Literal("automatic"),
    Schema.Literal("manual"),
    Schema.Literal("legacy_import"),
  ]),
  sourceSessionID: Schema.optional(Schema.String),
  sourceMessageID: Schema.optional(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class ScopeStats extends Schema.Class<ScopeStats>("MemoryScopeStats")({
  notes: Schema.Struct({
    total: Schema.Number,
    active: Schema.Number,
    deleted: Schema.Number,
  }),
  outputs: Schema.Struct({
    total: Schema.Number,
    active: Schema.Number,
    tombstoned: Schema.Number,
  }),
  jobs: Schema.Record(Schema.String, Schema.Number),
}) {
  static readonly zod = zod(this)
}

export class Status extends Schema.Class<Status>("MemoryStatus")({
  scope: StatusScope,
  enabled: Schema.Boolean,
  useMemories: Schema.Boolean,
  generateMemories: Schema.Boolean,
  global: Schema.optional(ScopeStats),
  project: Schema.optional(ScopeStats),
}) {
  static readonly zod = zod(this)
}

export class StatusQuery extends Schema.Class<StatusQuery>("MemoryStatusQuery")({
  scope: Schema.optional(StatusScope),
}) {
  static readonly zod = z.object({ scope: z.enum(["global", "project", "all"]).optional() })
}

export class NotesQuery extends Schema.Class<NotesQuery>("MemoryNotesQuery")({
  scope: Schema.optional(Scope),
}) {
  static readonly zod = z.object({ scope: z.enum(["global", "project"]).optional() })
}

export class CreateInput extends Schema.Class<CreateInput>("MemoryCreateInput")({
  text: Schema.String,
  scope: Schema.optional(Scope),
}) {
  static readonly zod = zod(this)
}

export class UpdateInput extends Schema.Class<UpdateInput>("MemoryUpdateInput")({
  text: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class ResetInput extends Schema.Class<ResetInput>("MemoryResetInput")({
  scope: Scope,
  confirm: Schema.Literal(true),
}) {
  static readonly zod = zod(this)
}

export class RebuildInput extends Schema.Class<RebuildInput>("MemoryRebuildInput")({
  scope: Scope,
}) {
  static readonly zod = zod(this)
}

export class DeleteResult extends Schema.Class<DeleteResult>("MemoryDeleteResult")({
  deleted: Schema.Literal(true),
}) {
  static readonly zod = zod(this)
}

export class ResetResult extends Schema.Class<ResetResult>("MemoryResetResult")({
  scope: Scope,
  notes: Schema.Number,
  outputs: Schema.Number,
  stage1Jobs: Schema.Number,
  stage2Jobs: Schema.Number,
  sessions: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class ImportResult extends Schema.Class<ImportResult>("MemoryImportResult")({
  imported: Schema.Number,
  skipped: Schema.Number,
  total: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class RebuildResult extends Schema.Class<RebuildResult>("MemoryRebuildResult")({
  scope: Scope,
  queued: Schema.Literal(true),
}) {
  static readonly zod = zod(this)
}

export class BadRequestError extends Schema.ErrorClass<BadRequestError>("MemoryBadRequestError")(
  {
    name: Schema.Literal("MemoryBadRequestError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {
  static readonly zod = zod(this)
}

export class NotFoundError extends Schema.ErrorClass<NotFoundError>("MemoryNotFoundError")(
  {
    name: Schema.Literal("MemoryNotFoundError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 404 },
) {
  static readonly zod = zod(this)
}

export type Error = BadRequestError | NotFoundError

export interface Interface {
  readonly status: (scope?: StatusScope) => Effect.Effect<Status>
  readonly list: (scope?: Scope) => Effect.Effect<Note[]>
  readonly create: (input: CreateInput) => Effect.Effect<Note, BadRequestError>
  readonly update: (id: string, input: UpdateInput) => Effect.Effect<Note, Error>
  readonly forget: (id: string) => Effect.Effect<DeleteResult, NotFoundError>
  readonly reset: (input: ResetInput) => Effect.Effect<ResetResult, BadRequestError>
  readonly importLegacy: (input: unknown) => Effect.Effect<ImportResult, BadRequestError>
  readonly rebuild: (input: RebuildInput) => Effect.Effect<RebuildResult, BadRequestError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryManagement") {}

function badRequest(message: string) {
  return new BadRequestError({ name: "MemoryBadRequestError", data: { message } })
}

function notFound() {
  return new NotFoundError({ name: "MemoryNotFoundError", data: { message: "Memory note not found" } })
}

type StoredNote = NonNullable<ReturnType<typeof MemoryStore.getNote>>

function publicNote(note: StoredNote) {
  return new Note({
    id: note.id,
    text: note.text,
    scope: note.scope,
    sourceKind: note.source_kind,
    ...(note.source_session_id ? { sourceSessionID: note.source_session_id } : {}),
    ...(note.source_message_id ? { sourceMessageID: note.source_message_id } : {}),
    timeCreated: note.time_created,
    timeUpdated: note.time_updated,
  })
}

function cleanText(input: string) {
  const text = MemorySecurity.cleanText(input, MAX_TEXT_CHARS)
  if (!text) return Effect.fail(badRequest("Memory text must not be empty"))
  if (MemorySecurity.containsSecret(input)) return Effect.fail(badRequest("Memory text appears to contain a secret"))
  return Effect.succeed(text)
}


export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    const scopes = Effect.fn("MemoryManagement.scopes")(function* () {
      const ctx = yield* InstanceState.context
      return {
        global: MemoryStore.globalScope(),
        project: MemoryStore.projectScope(ctx.project.id),
      }
    })

    const requireWritable = Effect.fn("MemoryManagement.requireWritable")(function* () {
      const settings = yield* memory.settings()
      if (!settings.enabled || !settings.generateMemories) {
        return yield* badRequest("Memory generation is disabled")
      }
    })

    const selectedScope = Effect.fn("MemoryManagement.selectedScope")(function* (scope: Scope = "project") {
      const current = yield* scopes()
      return scope === "global" ? current.global : current.project
    })

    const find = Effect.fn("MemoryManagement.find")(function* (id: string) {
      const current = yield* scopes()
      const project = MemoryStore.getNote(current.project, id)
      if (project) return { scope: current.project, note: project }
      const global = MemoryStore.getNote(current.global, id)
      if (global) return { scope: current.global, note: global }
      return yield* notFound()
    })

    const status = Effect.fn("MemoryManagement.status")(function* (scope: StatusScope = "all") {
      const settings = yield* memory.settings()
      const current = yield* scopes()
      return new Status({
        scope,
        enabled: settings.enabled,
        useMemories: settings.useMemories,
        generateMemories: settings.generateMemories,
        ...(scope === "global" || scope === "all"
          ? { global: new ScopeStats(MemoryStore.getStats(current.global)) }
          : {}),
        ...(scope === "project" || scope === "all"
          ? { project: new ScopeStats(MemoryStore.getStats(current.project)) }
          : {}),
      })
    })

    const list = Effect.fn("MemoryManagement.list")(function* (scope: Scope = "project") {
      return MemoryStore.listNotes(yield* selectedScope(scope)).map(publicNote)
    })

    const create = Effect.fn("MemoryManagement.create")(function* (input: CreateInput) {
      yield* requireWritable()
      const text = yield* cleanText(input.text)
      return publicNote(
        MemoryStore.upsertNoteAndEnqueue({
          scope: yield* selectedScope(input.scope),
          text,
          sourceKind: "manual",
        }).note,
      )
    })

    const update = Effect.fn("MemoryManagement.update")(function* (id: string, input: UpdateInput) {
      const current = yield* find(id)
      yield* requireWritable()
      const text = yield* cleanText(input.text)
      const updated = MemoryStore.updateNoteAndEnqueue(current.scope, id, { text })
      if (!updated) return yield* notFound()
      return publicNote(updated.note)
    })

    const forget = Effect.fn("MemoryManagement.forget")(function* (id: string) {
      const current = yield* find(id)
      if (!MemoryStore.forgetNoteAndEnqueue(current.scope, id)) return yield* notFound()
      return new DeleteResult({ deleted: true })
    })

    const reset = Effect.fn("MemoryManagement.reset")(function* (input: ResetInput) {
      if (input.confirm !== true) return yield* badRequest("Memory reset requires confirmation")
      const scope = yield* selectedScope(input.scope)
      const result = yield* Effect.tryPromise({
        try: () =>
          MemoryArtifacts.withScopeLock(scope, async () => {
            const reset = MemoryStore.resetScope(scope)
            await MemoryArtifacts.clearLocked(scope)
            return reset
          }),
        catch: () => badRequest("Memory scope could not be reset safely"),
      })
      return new ResetResult({ scope: input.scope, ...result })
    })

    const importLegacy = Effect.fn("MemoryManagement.importLegacy")(function* (input: unknown) {
      yield* requireWritable()
      const decoded = MemoryLegacy.decodeLegacyImport(input)
      if (!decoded) return yield* badRequest("Invalid legacy memory schema; expected schemaVersion 1")
      const current = yield* scopes()
      for (const note of decoded.notes) {
        const text = yield* cleanText(note.text)
        const scope = note.scope === "global" ? current.global : current.project
        MemoryStore.upsertNoteAndEnqueue({
          scope,
          text,
          sourceKind: "legacy_import",
          idempotencyKey: `legacy:${note.id}`,
          ...(note.sourceSessionID ? { sourceSessionID: SessionID.make(note.sourceSessionID) } : {}),
          ...(note.sourceMessageID ? { sourceMessageID: MessageID.make(note.sourceMessageID) } : {}),
          now: note.createdAt,
        })
      }
      return new ImportResult({
        imported: decoded.notes.length,
        skipped: decoded.skipped,
        total: decoded.notes.length + decoded.skipped,
      })
    })

    const rebuild = Effect.fn("MemoryManagement.rebuild")(function* (input: RebuildInput) {
      yield* requireWritable()
      const scope = yield* selectedScope(input.scope)
      MemoryStore.enqueueJob({ kind: "stage2", jobKey: MemoryStore.scopeKey(scope), inputWatermark: Date.now() })
      return new RebuildResult({ scope: input.scope, queued: true })
    })

    return Service.of({ status, list, create, update, forget, reset, importLegacy, rebuild })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Memory.defaultLayer))

export * as MemoryManagement from "./management"
