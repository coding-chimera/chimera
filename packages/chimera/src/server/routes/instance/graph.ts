import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { graphFileSymbols, graphFiles, graphImpact, graphNode, graphSearch, graphStatus } from "./graph-service"
import { jsonRequest } from "./trace"

const Limit = z.coerce.number().int().min(1).max(100).optional()
const Depth = z.coerce.number().int().min(1).max(5).optional()
const GraphResponse = z.object({
  initialized: z.boolean(),
  projectRoot: z.string(),
  dataRoot: z.string(),
  dataRootStatus: z.string(),
  jobStatus: z.unknown().optional(),
})

const response = (description: string) => ({
  200: {
    description,
    content: {
      "application/json": {
        schema: resolver(GraphResponse.passthrough()),
      },
    },
  },
})

export const GraphRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get Chimera graph status",
        description: "Return read-only CodeGraph initialization, data-root, job, and snapshot status for the current project.",
        operationId: "graph.status",
        responses: response("Graph status"),
      }),
      async (c) =>
        jsonRequest("GraphRoutes.status", c, function* () {
          return yield* graphStatus()
        }),
    )
    .get(
      "/search",
      describeRoute({
        summary: "Search Chimera graph nodes",
        description: "Search indexed CodeGraph nodes in the current project without initializing or syncing graph data.",
        operationId: "graph.search",
        responses: response("Graph search results"),
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          kind: z.string().optional(),
          limit: Limit,
        }),
      ),
      async (c) =>
        jsonRequest("GraphRoutes.search", c, function* () {
          return yield* graphSearch(c.req.valid("query"))
        }),
    )
    .get(
      "/node/:nodeID",
      describeRoute({
        summary: "Get Chimera graph node",
        description: "Return an indexed CodeGraph node and semantic projection by node ID without initializing or syncing graph data.",
        operationId: "graph.node",
        responses: response("Graph node"),
      }),
      async (c) =>
        jsonRequest("GraphRoutes.node", c, function* () {
          return yield* graphNode({ nodeID: c.req.param("nodeID") })
        }),
    )
    .get(
      "/file/symbols",
      describeRoute({
        summary: "List Chimera graph symbols for a file",
        description: "Return indexed CodeGraph symbols for a project file or source range without initializing or syncing graph data.",
        operationId: "graph.file.symbols",
        responses: response("Graph file symbols"),
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          kind: z.string().optional(),
          startLine: z.coerce.number().int().min(1).optional(),
          endLine: z.coerce.number().int().min(1).optional(),
          limit: Limit,
        }),
      ),
      async (c) =>
        jsonRequest("GraphRoutes.fileSymbols", c, function* () {
          return yield* graphFileSymbols(c.req.valid("query"))
        }),
    )
    .get(
      "/files",
      describeRoute({
        summary: "List Chimera graph files",
        description: "Return indexed files for the current project without initializing or syncing graph data.",
        operationId: "graph.files",
        responses: response("Graph files"),
      }),
      async (c) =>
        jsonRequest("GraphRoutes.files", c, function* () {
          return yield* graphFiles()
        }),
    )
    .get(
      "/impact",
      describeRoute({
        summary: "Get Chimera graph impact",
        description: "Return node impact radius or file dependents for the current project without initializing or syncing graph data.",
        operationId: "graph.impact",
        responses: response("Graph impact results"),
      }),
      validator(
        "query",
        z.object({
          nodeID: z.string().optional(),
          path: z.string().optional(),
          depth: Depth,
        }),
      ),
      async (c) =>
        jsonRequest("GraphRoutes.impact", c, function* () {
          return yield* graphImpact(c.req.valid("query"))
        }),
    ),
)
