import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
// (R1) The effect-httpapi global SSE path shares ONE "event" listener across all
// connections (server/global-event-stream.ts shared hub); the legacy Hono path still
// adds one per SSE connection, plus a handful of fixed process-level consumers
// (tui worker, sync bridges). The default max-listeners warning threshold (10)
// fires spuriously with a few open WebUI tabs on the legacy path and trains
// operators to ignore the warning, so raise it to a level that only trips on a
// genuine listener leak (httpapi connections are additionally bounded by the
// global SSE connection cap, OPENCODE_GLOBAL_SSE_MAX_CONNECTIONS).
GlobalBus.setMaxListeners(1_000)
