import { Config } from "@/config/config"
import { ConfigDelegation } from "@/config/delegation"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/contracts/session-ids"
import { Context, Effect, Layer, Semaphore } from "effect"

/**
 * One acquired permit, owned by exactly one run. Registration is keyed by holder
 * identity (not by session id), so concurrent runs on the same session each keep
 * their own registration and release exactly the permit they acquired.
 */
type Holder = {
  sessionID: SessionID
  /** Lender this permit was borrowed from (parent -> child chains). */
  borrowedFrom?: Holder
  /** Borrower this permit is currently lent to. The lender releases without
   * returning the permit to the pool, because the borrower now owns it. */
  lentTo?: Holder
  /** Set when the lender ran its own release while `lentTo` was set: the
   * borrower's release must then return the permit to the pool instead of
   * handing it back to a lender that no longer exists. */
  released?: boolean
}

type Holders = Map<SessionID, Set<Holder>>

const register = (holders: Holders, holder: Holder) => {
  const set = holders.get(holder.sessionID)
  if (set) set.add(holder)
  else holders.set(holder.sessionID, new Set([holder]))
}

const unregister = (holders: Holders, holder: Holder) => {
  const set = holders.get(holder.sessionID)
  if (!set) return
  set.delete(holder)
  if (set.size === 0) holders.delete(holder.sessionID)
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
          holders: new Map<SessionID, Set<Holder>>(),
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
        const lender = parent && Array.from(parent).find((holder) => holder.lentTo === undefined)
        if (!lender) return undefined
        const holder: Holder = { sessionID, borrowedFrom: lender }
        lender.lentTo = holder
        register(data.holders, holder)
        return holder
      })
      if (borrowed) return borrowed
      // The take-to-register window is uninterruptible: `Semaphore.take` is
      // interruptible while queueing, but an interrupt delivered after it
      // succeeded and before the holder is registered would leave the permit
      // with no holder for release to return (permanent leak).
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const holder: Holder = { sessionID }
          yield* restore(data.semaphore.take(1))
          yield* Effect.sync(() => register(data.holders, holder))
          return holder
        }),
      )
    })

    const release = Effect.fnUntraced(function* (holder: Holder) {
      const data = yield* InstanceState.get(state)
      const toPool = yield* Effect.sync(() => {
        unregister(data.holders, holder)
        // Permit is currently lent to a descendant chain; the borrower's release returns it
        // to the pool because this lender entry is gone.
        if (holder.lentTo) {
          holder.released = true
          return false
        }
        if (!holder.borrowedFrom) return true
        const lender = holder.borrowedFrom
        if (lender.lentTo !== holder) return true
        lender.lentTo = undefined
        // The lender already released while lending, so nobody else will hand the
        // permit back: return it now. A live lender returns it on its own release.
        return lender.released === true
      })
      if (toPool) yield* data.semaphore.release(1)
    })

    const run = <A, E, R>(input: {
      parentSessionID: SessionID
      sessionID: SessionID
      effect: Effect.Effect<A, E, R>
    }): Effect.Effect<A, E, R> =>
      // acquireUseRelease closes the acquire-to-use interruption window: once the
      // permit is registered, release runs even if the run is interrupted before
      // its effect body starts.
      Effect.acquireUseRelease(
        acquire(input.parentSessionID, input.sessionID),
        () => input.effect,
        (holder) => release(holder),
      )

    return Service.of({ run })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as DelegationLimiter from "./delegation-limiter"
