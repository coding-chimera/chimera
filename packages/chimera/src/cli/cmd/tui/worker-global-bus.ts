import { GlobalBus, type GlobalEvent } from "@/bus/global"

/**
 * (R1 B3) Pairs the worker's process-lifetime `GlobalBus.on("event", …)`
 * subscription with an explicit detach. The worker module used to register an
 * anonymous listener with no `off` anywhere in the file — the only unpaired
 * GlobalBus subscription in the repo (RUST_MIGRATION_PLAN §1.4 B3). The forwarder
 * is a single listener for the worker's lifetime, so the leak was bounded, but
 * `rpc.shutdown` now detaches it so a shutdown worker cannot keep emitting RPC
 * events into a torn-down channel and the pairing is auditable.
 *
 * Extracted from worker.ts so the attach/detach pairing is unit-testable without
 * executing the worker entrypoint (which boots logging, heap sampling, and RPC).
 */
export function attachGlobalBusForwarder(emit: (event: GlobalEvent) => void): () => void {
  const handler = (event: GlobalEvent) => emit(event)
  GlobalBus.on("event", handler)
  let detached = false
  return () => {
    if (detached) return
    detached = true
    GlobalBus.off("event", handler)
  }
}
