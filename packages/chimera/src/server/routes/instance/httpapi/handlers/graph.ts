import { graphFileSymbols, graphFiles, graphImpact, graphNode, graphSearch, graphStatus } from "../../graph-service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { GraphFileSymbolsQuery, GraphImpactQuery, GraphSearchQuery } from "../groups/graph"

export const graphHandlers = HttpApiBuilder.group(InstanceHttpApi, "graph", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle("status", () => graphStatus())
      .handle("search", (ctx: { query: typeof GraphSearchQuery.Type }) => graphSearch(ctx.query))
      .handle("node", (ctx: { params: { nodeID: string } }) => graphNode(ctx.params))
      .handle("fileSymbols", (ctx: { query: typeof GraphFileSymbolsQuery.Type }) => graphFileSymbols(ctx.query))
      .handle("files", () => graphFiles())
      .handle("impact", (ctx: { query: typeof GraphImpactQuery.Type }) => graphImpact(ctx.query))
  }),
)
