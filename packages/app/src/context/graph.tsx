import { createSimpleContext } from "@opencode-ai/ui/context"
import { queryOptions } from "@tanstack/solid-query"
import { useSDK } from "./sdk"

export const graphQueryKey = (directory: string) => [directory, "graph"] as const
export const graphStatusQueryKey = (directory: string) => [...graphQueryKey(directory), "status"] as const
export const graphFilesQueryKey = (directory: string) => [...graphQueryKey(directory), "files"] as const
export const graphSearchQueryKey = (directory: string, query: string, kind?: string, limit?: number) =>
  [...graphQueryKey(directory), "search", query, kind, limit] as const

export const { use: useGraph, provider: GraphProvider } = createSimpleContext({
  name: "Graph",
  init: () => {
    const sdk = useSDK()

    return {
      statusQuery() {
        return queryOptions({
          queryKey: graphStatusQueryKey(sdk.directory),
          queryFn: () => sdk.client.graph.status().then((r) => r.data),
        })
      },
      filesQuery() {
        return queryOptions({
          queryKey: graphFilesQueryKey(sdk.directory),
          queryFn: () => sdk.client.graph.files().then((r) => r.data),
        })
      },
      searchQuery(input: { query: string; kind?: string; limit?: number }) {
        return queryOptions({
          queryKey: graphSearchQueryKey(sdk.directory, input.query, input.kind, input.limit),
          queryFn: () => sdk.client.graph.search(input).then((r) => r.data),
        })
      },
      node(nodeID: string) {
        return sdk.client.graph.node({ nodeID }).then((r) => r.data)
      },
      fileSymbols(input: { path: string; kind?: string; startLine?: number; endLine?: number; limit?: number }) {
        return sdk.client.graph.file
          .symbols({
            ...input,
            startLine: input.startLine === undefined ? undefined : String(input.startLine),
            endLine: input.endLine === undefined ? undefined : String(input.endLine),
          })
          .then((r) => r.data)
      },
      impact(input: { nodeID?: string; path?: string; depth?: number }) {
        return sdk.client.graph.impact({
          ...input,
          depth: input.depth === undefined ? undefined : String(input.depth),
        }).then((r) => r.data)
      },
    }
  },
})
