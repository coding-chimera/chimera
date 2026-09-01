import path from "path"
import { Context, Effect, Layer, PubSub, Record, Result, Schema, Semaphore, Stream } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt } from "@/util/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

export const OAUTH_DUMMY_KEY = "chimera-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type Change = {
  readonly revision: number
}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly revision: () => Effect.Effect<number>
  readonly changes: Stream.Stream<Change>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)
    const mutationSemaphore = Semaphore.makeUnsafe(1)
    const changeSignal = yield* PubSub.sliding<Change>(1)
    yield* Effect.addFinalizer(() => PubSub.shutdown(changeSignal))
    let currentRevision = 0

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const persist = Effect.fnUntraced(function* (data: Record<string, Info>, next: Record<string, Info>) {
      const content = JSON.stringify(next)
      if (content === JSON.stringify(data)) return
      yield* fsys.writeJson(file, next, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      if (process.env.OPENCODE_AUTH_CONTENT) process.env.OPENCODE_AUTH_CONTENT = content
      currentRevision += 1
      yield* PubSub.publish(changeSignal, { revision: currentRevision })
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          const next = { ...data, [norm]: info }
          if (norm !== key) delete next[key]
          delete next[norm + "/"]
          yield* persist(data, next)
        }).pipe(Effect.uninterruptible),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          const next = { ...data }
          delete next[key]
          delete next[norm]
          yield* persist(data, next)
        }).pipe(Effect.uninterruptible),
      )
    })

    const revision = Effect.fn("Auth.revision")(function* () {
      return currentRevision
    })

    return Service.of({ get, all, set, remove, revision, changes: Stream.fromPubSub(changeSignal) })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
