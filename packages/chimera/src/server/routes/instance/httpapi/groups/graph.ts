import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const Limit = Schema.optional(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
)
const Depth = Schema.optional(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5)),
)

export const GraphPaths = {
  status: "/graph/status",
  search: "/graph/search",
  node: "/graph/node/:nodeID",
  fileSymbols: "/graph/file/symbols",
  files: "/graph/files",
  impact: "/graph/impact",
} as const

export const GraphSearchQuery = Schema.Struct({
  query: Schema.String,
  kind: Schema.optional(Schema.String),
  limit: Limit,
})

export const GraphFileSymbolsQuery = Schema.Struct({
  path: Schema.String,
  kind: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  endLine: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  limit: Limit,
})

export const GraphImpactQuery = Schema.Struct({
  nodeID: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  depth: Depth,
})

const GraphBaseFields = {
  initialized: Schema.Boolean,
  projectRoot: Schema.String,
  dataRoot: Schema.String,
  dataRootStatus: Schema.String,
  jobStatus: Schema.Unknown,
  snapshot: Schema.optional(Schema.Unknown),
}

export const GraphStatusResponse = Schema.Struct({
  ...GraphBaseFields,
  stats: Schema.optional(Schema.Unknown),
  backend: Schema.optional(Schema.String),
  journalMode: Schema.optional(Schema.String),
})

export const GraphNodeResult = Schema.Struct({
  score: Schema.optional(Schema.Number),
  node: Schema.Unknown,
  projection: Schema.optional(Schema.NullOr(Schema.Unknown)),
})

export const GraphSearchResponse = Schema.Struct({
  ...GraphBaseFields,
  results: Schema.Array(GraphNodeResult),
})

export const GraphNodeResponse = Schema.Struct({
  ...GraphBaseFields,
  node: Schema.NullOr(Schema.Unknown),
  projection: Schema.NullOr(Schema.Unknown),
})

export const GraphFileSymbolsResponse = Schema.Struct({
  ...GraphBaseFields,
  path: Schema.String,
  results: Schema.Array(GraphNodeResult),
})

export const GraphFilesResponse = Schema.Struct({
  ...GraphBaseFields,
  files: Schema.Array(Schema.Unknown),
})

export const GraphImpactResponse = Schema.Struct({
  ...GraphBaseFields,
  results: Schema.Unknown,
})

export const GraphApi = HttpApi.make("graph")
  .add(
    HttpApiGroup.make("graph")
      .add(
        HttpApiEndpoint.get("status", GraphPaths.status, {
          success: described(GraphStatusResponse, "Graph status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.status",
            summary: "Get Chimera graph status",
            description: "Return read-only CodeGraph initialization, data-root, job, and snapshot status for the current project.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("search", GraphPaths.search, {
          query: GraphSearchQuery,
          success: described(GraphSearchResponse, "Graph search results"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.search",
            summary: "Search Chimera graph nodes",
            description: "Search indexed CodeGraph nodes in the current project without initializing or syncing graph data.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("node", GraphPaths.node, {
          params: { nodeID: Schema.String },
          success: described(GraphNodeResponse, "Graph node"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.node",
            summary: "Get Chimera graph node",
            description: "Return an indexed CodeGraph node and semantic projection by node ID without initializing or syncing graph data.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("fileSymbols", GraphPaths.fileSymbols, {
          query: GraphFileSymbolsQuery,
          success: described(GraphFileSymbolsResponse, "Graph file symbols"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.file.symbols",
            summary: "List Chimera graph symbols for a file",
            description: "Return indexed CodeGraph symbols for a project file or source range without initializing or syncing graph data.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("files", GraphPaths.files, {
          success: described(GraphFilesResponse, "Graph files"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.files",
            summary: "List Chimera graph files",
            description: "Return indexed files for the current project without initializing or syncing graph data.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("impact", GraphPaths.impact, {
          query: GraphImpactQuery,
          success: described(GraphImpactResponse, "Graph impact results"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "graph.impact",
            summary: "Get Chimera graph impact",
            description: "Return node impact radius or file dependents for the current project without initializing or syncing graph data.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "graph",
          description: "Read-only Chimera CodeGraph routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "chimera graph HttpApi",
      version: "0.0.1",
      description: "Read-only Chimera CodeGraph HTTP surface.",
    }),
  )
