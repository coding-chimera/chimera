import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { Schema } from "effect"
import { lazy } from "@/util/lazy"
import { zod } from "@/util/effect-zod"
import { ProcessItem, listActiveProcesses } from "./process-service"
import { jsonRequest } from "./trace"

// Importing this module also imports process-registry, which registers the
// `process.changed` BusEvent so it flows through the `/event` SSE union.
export const ProcessRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List active session processes",
      description:
        "Get all running child processes registered in the session process registry for the current project, joined with the owning session's title and agent.",
      operationId: "process.list",
      responses: {
        200: {
          description: "List of active processes",
          content: {
            "application/json": {
              schema: resolver(zod(Schema.Array(ProcessItem))),
            },
          },
        },
      },
    }),
    async (c) =>
      jsonRequest("ProcessRoutes.list", c, function* () {
        return yield* listActiveProcesses()
      }),
  ),
)
