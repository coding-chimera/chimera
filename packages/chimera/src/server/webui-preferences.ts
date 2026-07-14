import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt } from "@/util/schema"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"

const key = ["global", "webui_preferences"]

export class Preferences extends Schema.Class<Preferences>("WebUIPreferences")({
  appearance: Schema.optional(
    Schema.Struct({
      presetId: Schema.optional(Schema.String),
      colorMode: Schema.optional(
        Schema.Union([Schema.Literal("system"), Schema.Literal("light"), Schema.Literal("dark")]),
      ),
    }),
  ),
  chat: Schema.optional(
    Schema.Struct({
      collapseUserMessages: Schema.optional(Schema.Boolean),
      renderUserMarkdown: Schema.optional(Schema.Boolean),
      reasoningDisplayMode: Schema.optional(
        Schema.Union([Schema.Literal("capsule"), Schema.Literal("italic"), Schema.Literal("markdown")]),
      ),
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export class Snapshot extends Schema.Class<Snapshot>("WebUIPreferencesSnapshot")({
  schemaVersion: Schema.Literal(1),
  revision: NonNegativeInt,
  initialized: Schema.Boolean,
  preferences: Preferences,
}) {
  static readonly zod = zod(this)
}

export class Update extends Schema.Class<Update>("WebUIPreferencesUpdate")({
  revision: NonNegativeInt,
  preferences: Preferences,
}) {
  static readonly zod = zod(this)
}

export class RevisionConflictError extends Schema.ErrorClass<RevisionConflictError>(
  "WebUIPreferencesRevisionConflictError",
)(
  {
    name: Schema.Literal("WebUIPreferencesRevisionConflictError"),
    data: Schema.Struct({
      expectedRevision: NonNegativeInt,
      actualRevision: NonNegativeInt,
    }),
  },
  { httpApiStatus: 409 },
) {
  static readonly zod = zod(this)
}

export interface Interface {
  readonly get: () => Effect.Effect<Snapshot>
  readonly update: (input: Update) => Effect.Effect<Snapshot, RevisionConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WebUIPreferences") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const semaphore = Semaphore.makeUnsafe(1)
    const initial = new Snapshot({
      schemaVersion: 1,
      revision: 0,
      initialized: false,
      preferences: new Preferences({}),
    })

    const load = Effect.fnUntraced(function* () {
      const stored = yield* storage.read<unknown>(key).pipe(
        Effect.catch((error) => {
          if (error instanceof Storage.NotFoundError) return Effect.succeed(initial)
          return Effect.fail(error)
        }),
      )
      return yield* Schema.decodeUnknownEffect(Snapshot)(stored, { onExcessProperty: "error" })
    })

    const get: Interface["get"] = () => semaphore.withPermits(1)(load()).pipe(Effect.orDie)

    const update: Interface["update"] = Effect.fn("WebUIPreferences.update")(function* (input: Update) {
      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* load()
          if (input.revision !== current.revision) {
            return yield* new RevisionConflictError({
              name: "WebUIPreferencesRevisionConflictError",
              data: {
                expectedRevision: input.revision,
                actualRevision: current.revision,
              },
            })
          }
          const snapshot = new Snapshot({
            schemaVersion: 1,
            revision: current.revision + 1,
            initialized: true,
            preferences: input.preferences,
          })
          yield* storage.write(key, snapshot)
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: "global.preferences.updated",
              properties: snapshot,
            },
          })
          return snapshot
        }),
      ).pipe(
        Effect.catch((error) =>
          error instanceof RevisionConflictError ? Effect.fail(error) : Effect.die(error),
        ),
      )
    })

    return Service.of({ get, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Storage.defaultLayer))

export * as WebUIPreferences from "./webui-preferences"
