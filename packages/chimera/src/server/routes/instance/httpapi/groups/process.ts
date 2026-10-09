import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProcessItem } from "../../process-service"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const ProcessPaths = {
  list: "/process",
} as const

export const ProcessApi = HttpApi.make("process")
  .add(
    HttpApiGroup.make("process")
      .add(
        HttpApiEndpoint.get("list", ProcessPaths.list, {
          success: described(Schema.Array(ProcessItem), "List of active processes"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "process.list",
            summary: "List active session processes",
            description:
              "Get all running child processes registered in the session process registry for the current project, joined with the owning session's title and agent.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "process",
          description: "Experimental HttpApi session process registry routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "chimera process HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for the session process registry.",
    }),
  )
