import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AppRuntime } from "@/effect/app-runtime"
import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { AsyncQueue } from "@/util/queue"
import { Effect } from "effect"

const log = Log.create({ service: "server" })
const EVENT_QUEUE_CAPACITY = 1024

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      // Hold an instance lease for the lifetime of the stream so the LRU sweeper
      // treats this subscriber as active usage instead of evicting a watched project.
      const lease = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          InstanceState.context.pipe(Effect.flatMap((instance) => store.lease({ directory: instance.directory }))),
        ),
      )
      const releaseLease = () => {
        void AppRuntime.runPromise(lease.release).catch(() => {})
      }
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>({ capacity: EVENT_QUEUE_CAPACITY, overflow: "drop-oldest" })
        let done = false

        q.push(
          JSON.stringify({
            id: Bus.createID(),
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              id: Bus.createID(),
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          releaseLease()
          q.push(null, { force: true })
          log.info("event disconnected")
        }

        const unsub = Bus.subscribeAll((event) => {
          q.push(JSON.stringify(event))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
