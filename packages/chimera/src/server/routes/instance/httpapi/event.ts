import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"

const log = Log.create({ service: "server" })

export const EventPaths = {
  event: "/event",
} as const

export const EventApi = HttpApi.make("event").add(
  HttpApiGroup.make("event")
    .add(
      HttpApiEndpoint.get("subscribe", EventPaths.event, {
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "event.subscribe",
          summary: "Subscribe to events",
          description: "Get events",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "event", description: "Instance event stream route." })),
)

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventStream(bus: Bus.Interface) {
  const events = bus.subscribeAll().pipe(Stream.takeUntil((event) => event.type === Bus.InstanceDisposed.type))
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ id: Bus.createID(), type: "server.heartbeat", properties: {} })),
  )

  return Stream.make({ id: Bus.createID(), type: "server.connected", properties: {} }).pipe(
    Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
    Stream.map(eventData),
    Stream.pipeThroughChannel(Sse.encode()),
    Stream.encodeText,
    Stream.ensuring(Effect.sync(() => log.info("event disconnected"))),
  )
}

// (R1 B2) The lease used to be acquired in the handler and released via
// Stream.ensuring on the response body: a response whose stream never ran
// (client gone between handler return and body pull) leaked both the lease and
// the Bus subscription. Acquisition now lives inside Stream.unwrap + scoped, so
// nothing is held unless the stream actually executes, and the scope finalizer
// releases the lease on completion or interruption.
function eventResponse(bus: Bus.Interface, acquireLease: Effect.Effect<Effect.Effect<void>>) {
  return HttpServerResponse.stream(
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          const release = yield* acquireLease
          yield* Effect.addFinalizer(() => release)
          log.info("event connected")
          return eventStream(bus)
        }),
      ),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* InstanceStore.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        // Hold an instance lease for the stream lifetime so the LRU sweeper treats
        // this subscriber as active usage instead of evicting a watched project.
        const ref = yield* InstanceRef
        return eventResponse(
          bus,
          ref
            ? store.lease({ directory: ref.directory }).pipe(Effect.map((lease) => lease.release))
            : Effect.succeed(Effect.void),
        )
      }),
    )
  }),
)
