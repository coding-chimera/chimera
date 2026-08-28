import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Context, Effect, Layer, Semaphore } from "effect"

type Holder = {
  borrowedFrom?: SessionID
  lentTo?: SessionID
}

export interface Interface {
  readonly run: <A, E, R>(input: {
    parentSessionID: SessionID
    sessionID: SessionID
    effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DelegationLimiter") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* InstanceState.make(
      Effect.fn("DelegationLimiter.state")(function* () {
        const cfg = yield* config.get()
        const max = cfg.delegation?.max_concurrent ?? ConfigDelegation.DEFAULT_MAX_CONCURRENT
        return {
          max,
          semaphore: Semaphore.makeUnsafe(max),
          holders: new Map<SessionID, Holder>(),
        }
      }),
    )

    // Borrow the parent session's permit when it currently holds one and has not lent it out;
    // otherwise queue on the shared semaphore (FIFO). A parent blocked waiting on its child
    // therefore consumes no budget, which prevents ancestor-held-permit deadlocks.
    const acquire = Effect.fnUntraced(function* (parentSessionID: SessionID, sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const borrowed = yield* Effect.sync(() => {
        const parent = data.holders.get(parentSessionID)
        if (!parent || parent.lentTo) return false
        parent.lentTo = sessionID
        data.holders.set(sessionID, { borrowedFrom: parentSessionID })
        return true
      })
      if (borrowed) return
      yield* data.semaphore.take(1)
      yield* Effect.sync(() => data.holders.set(sessionID, {}))
    })

    const release = Effect.fnUntraced(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const toPool = yield* Effect.sync(() => {
        const entry = data.holders.get(sessionID)
        if (!entry) return false
        data.holders.delete(sessionID)
        // Permit is currently lent to a descendant chain; the borrower's release returns it
        // to the pool because this lender entry is gone.
        if (entry.lentTo) return false
        if (!entry.borrowedFrom) return true
        const lender = data.holders.get(entry.borrowedFrom)
        if (lender && lender.lentTo === sessionID) {
          lender.lentTo = undefined
          return false
        }
        return true
      })
      if (toPool) yield* data.semaphore.release(1)
    })

    const run = <A, E, R>(input: {
      parentSessionID: SessionID
      sessionID: SessionID
      effect: Effect.Effect<A, E, R>
    }): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        yield* acquire(input.parentSessionID, input.sessionID)
        return yield* input.effect
      }).pipe(Effect.ensuring(release(input.sessionID)))

    return Service.of({ run })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as DelegationLimiter from "./delegation-limiter"
