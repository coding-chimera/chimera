export * as ConfigSubagentRouting from "./subagent-routing"

import path from "path"
import { randomUUID } from "crypto"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ProjectID } from "@/project/schema"
import { NonNegativeInt } from "@/util/schema"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"

const Weight = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const PreferenceSignal = Schema.Struct({
  weight: Weight,
  activity: NonNegativeInt,
  revision: NonNegativeInt,
})
export type PreferenceSignal = Schema.Schema.Type<typeof PreferenceSignal>

export const Entry = Schema.Struct({
  preference: Schema.optional(PreferenceSignal),
  suppressedRevision: Schema.optional(NonNegativeInt),
})
export type Entry = Schema.Schema.Type<typeof Entry>

export const PreferenceLayer = Schema.Struct({
  providers: Schema.Record(Schema.String, Entry),
  routes: Schema.Record(Schema.String, Schema.Record(Schema.String, Entry)),
})
export type PreferenceLayer = Schema.Schema.Type<typeof PreferenceLayer>

export const State = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  activity: Schema.Struct({
    global: NonNegativeInt,
    projects: Schema.Record(Schema.String, NonNegativeInt),
  }),
  global: PreferenceLayer,
  projects: Schema.Record(Schema.String, PreferenceLayer),
})
export type State = Schema.Schema.Type<typeof State>

export type Scope = { type: "global" } | { type: "project"; projectID: ProjectID }
export type Target =
  | { type: "provider"; providerID: string }
  | { type: "route"; identity: string; providerID: string; model: string }

export interface Policy {
  halfLifeDelegations: number
  dormantScore: number
  signalWeight: number
  maxWeight: number
}

export const DEFAULT_POLICY = {
  halfLifeDelegations: 32,
  dormantScore: 0.125,
  signalWeight: 1,
  maxWeight: 8,
} as const satisfies Policy

export class StateFileError extends Schema.TaggedErrorClass<StateFileError>()("SubagentRoutingStateFileError", {
  operation: Schema.Literals(["read", "write", "lock"]),
  detail: Schema.String,
}) {
  override get message() {
    return `Subagent routing state ${this.operation} failed: ${this.detail}`
  }
}

export interface Interface {
  readonly get: () => Effect.Effect<State, StateFileError>
  readonly prefer: (input: { scope: Scope; target: Target }) => Effect.Effect<State, StateFileError>
  readonly suppress: (input: { scope: Scope; target: Target }) => Effect.Effect<State, StateFileError>
  readonly recordDelegation: (projectID: ProjectID) => Effect.Effect<State, StateFileError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentRouting") {}

const emptyLayer = (): PreferenceLayer => ({ providers: {}, routes: {} })

export function empty(): State {
  return {
    version: 1,
    revision: 0,
    activity: { global: 0, projects: {} },
    global: emptyLayer(),
    projects: {},
  }
}

export function activityFor(state: State, scope: Scope) {
  if (scope.type === "global") return state.activity.global
  return state.activity.projects[scope.projectID] ?? 0
}

export function score(
  signal: PreferenceSignal | undefined,
  activity: number,
  policy: Policy = DEFAULT_POLICY,
) {
  if (!signal) return 0
  const elapsed = Math.max(0, activity - signal.activity)
  return signal.weight * 2 ** (-elapsed / policy.halfLifeDelegations)
}

export function dormant(
  signal: PreferenceSignal | undefined,
  activity: number,
  policy: Policy = DEFAULT_POLICY,
) {
  return signal !== undefined && score(signal, activity, policy) <= policy.dormantScore
}

export function providerEntry(layer: PreferenceLayer | undefined, providerID: string) {
  return layer?.providers[providerID]
}

export function routeEntry(layer: PreferenceLayer | undefined, identity: string, model: string) {
  return layer?.routes[identity]?.[model]
}

function sortRecord<T>(record: Readonly<Record<string, T>>) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function canonicalLayer(value: PreferenceLayer): PreferenceLayer {
  return {
    providers: sortRecord(value.providers),
    routes: Object.fromEntries(
      Object.entries(value.routes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([identity, routes]) => [identity, sortRecord(routes)]),
    ),
  }
}

function canonical(value: State): State {
  return {
    version: 1,
    revision: value.revision,
    activity: {
      global: value.activity.global,
      projects: sortRecord(value.activity.projects),
    },
    global: canonicalLayer(value.global),
    projects: Object.fromEntries(
      Object.entries(value.projects)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([projectID, layer]) => [projectID, canonicalLayer(layer)]),
    ),
  }
}

function targetEntry(layer: PreferenceLayer, target: Target) {
  if (target.type === "provider") return providerEntry(layer, target.providerID)
  return routeEntry(layer, target.identity, target.model)
}

function setTargetEntry(layer: PreferenceLayer, target: Target, entry: Entry): PreferenceLayer {
  if (target.type === "provider") {
    return { ...layer, providers: { ...layer.providers, [target.providerID]: entry } }
  }
  return {
    ...layer,
    routes: {
      ...layer.routes,
      [target.identity]: {
        ...(layer.routes[target.identity] ?? {}),
        [target.model]: entry,
      },
    },
  }
}

function updateScope(state: State, scope: Scope, update: (layer: PreferenceLayer) => PreferenceLayer): State {
  if (scope.type === "global") return { ...state, global: update(state.global) }
  return {
    ...state,
    projects: {
      ...state.projects,
      [scope.projectID]: update(state.projects[scope.projectID] ?? emptyLayer()),
    },
  }
}

function hasActivePreference(layer: PreferenceLayer | undefined, activity: number) {
  if (!layer) return false
  return [
    ...Object.values(layer.providers),
    ...Object.values(layer.routes).flatMap((routes) => Object.values(routes)),
  ].some(
    (entry) =>
      entry.preference !== undefined &&
      (entry.suppressedRevision ?? -1) < entry.preference.revision &&
      !dormant(entry.preference, activity),
  )
}

function validateMutation(input: { scope: Scope; target: Target }) {
  if (input.scope.type === "project" && input.scope.projectID === ProjectID.global) {
    return new StateFileError({ operation: "write", detail: "project scope cannot use the global project ID" })
  }
  if (input.target.type === "provider") return undefined
  const separator = input.target.model.indexOf("/")
  if (
    separator <= 0 ||
    separator === input.target.model.length - 1 ||
    input.target.model.slice(0, separator) !== input.target.providerID
  ) {
    return new StateFileError({ operation: "write", detail: "route provider does not match the concrete model route" })
  }
  return undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const global = yield* Global.Service
    const semaphore = Semaphore.makeUnsafe(1)
    const filepath = path.join(global.state, "subagent-routing.json")
    const lockKey = `subagent-routing:${filepath}`

    const read = Effect.fn("SubagentRouting.read")(function* () {
      const text = yield* fs.readFileStringSafe(filepath).pipe(
        Effect.mapError(() => new StateFileError({ operation: "read", detail: "unable to read state file" })),
      )
      if (text === undefined) return empty()
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: () => new StateFileError({ operation: "read", detail: "invalid JSON; original file was preserved" }),
      })
      const state = yield* Schema.decodeUnknownEffect(State)(parsed, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () => new StateFileError({ operation: "read", detail: "invalid or unsupported schema; original file was preserved" }),
        ),
      )
      if (Object.hasOwn(state.projects, ProjectID.global) || Object.hasOwn(state.activity.projects, ProjectID.global)) {
        return yield* new StateFileError({
          operation: "read",
          detail: "invalid project scope in state; original file was preserved",
        })
      }
      return state
    })

    const write = Effect.fn("SubagentRouting.write")(function* (state: State) {
      const temp = `${filepath}.${process.pid}.${randomUUID()}.tmp`
      const content = JSON.stringify(canonical(state), null, 2) + "\n"
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(filepath), { recursive: true, mode: 0o700 })
        yield* fs.writeFileString(temp, content)
        yield* fs.chmod(temp, 0o600)
        yield* fs.rename(temp, filepath)
      }).pipe(
        Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
        Effect.mapError(() => new StateFileError({ operation: "write", detail: "atomic state update failed" })),
      )
    })

    const mutate = Effect.fn("SubagentRouting.mutate")(function* (
      update: (state: State, revision: number) => State | undefined,
    ) {
      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* read()
          const next = update(current, current.revision + 1)
          if (!next) return current
          const validated = yield* Schema.decodeUnknownEffect(State)(canonical(next), { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              () => new StateFileError({ operation: "write", detail: "refused to encode invalid state" }),
            ),
          )
          yield* write(validated)
          return validated
        }).pipe(
          flock.withLock(lockKey),
          Effect.mapError((error) =>
            error instanceof StateFileError
              ? error
              : new StateFileError({ operation: "lock", detail: "unable to serialize state update" }),
          ),
        ),
      )
    })

    const get: Interface["get"] = () => read()

    const prefer: Interface["prefer"] = Effect.fn("SubagentRouting.prefer")(function* (input) {
      const error = validateMutation(input)
      if (error) return yield* error
      return yield* mutate((state, revision) => {
        const activity = activityFor(state, input.scope)
        return {
          ...updateScope(state, input.scope, (current) => {
            const entry = targetEntry(current, input.target)
            return setTargetEntry(current, input.target, {
              ...entry,
              preference: {
                weight: Math.min(
                  DEFAULT_POLICY.maxWeight,
                  score(entry?.preference, activity) + DEFAULT_POLICY.signalWeight,
                ),
                activity,
                revision,
              },
            })
          }),
          revision,
        }
      })
    })

    const suppress: Interface["suppress"] = Effect.fn("SubagentRouting.suppress")(function* (input) {
      const error = validateMutation(input)
      if (error) return yield* error
      return yield* mutate((state, revision) => ({
        ...updateScope(state, input.scope, (current) =>
          setTargetEntry(current, input.target, {
            ...targetEntry(current, input.target),
            suppressedRevision: revision,
          }),
        ),
        revision,
      }))
    })

    const recordDelegation: Interface["recordDelegation"] = Effect.fn("SubagentRouting.recordDelegation")(
      function* (projectID) {
        return yield* mutate((state, revision) => {
          const globalActive = hasActivePreference(state.global, state.activity.global)
          const projectActivity = state.activity.projects[projectID] ?? 0
          const projectActive =
            projectID !== ProjectID.global && hasActivePreference(state.projects[projectID], projectActivity)
          if (!globalActive && !projectActive) return undefined
          return {
            ...state,
            revision,
            activity: {
              global: state.activity.global + (globalActive ? 1 : 0),
              projects:
                projectActive
                  ? { ...state.activity.projects, [projectID]: projectActivity + 1 }
                  : state.activity.projects,
            },
          }
        })
      },
    )

    return Service.of({ get, prefer, suppress, recordDelegation })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Global.layer),
)
