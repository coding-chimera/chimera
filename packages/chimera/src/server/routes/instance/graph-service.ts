import path from "path"
import { Chimera, type ProjectGraphState } from "@/chimera"
import * as InstanceState from "@/effect/instance-state"
import {
  CodeGraph,
  NODE_KINDS,
  getGraphDataRootInfo,
  readIndexJob,
  type CodeGraphSnapshot,
  type Node,
  type NodeKind,
  type SourceRange,
} from "@/graph"
import { Effect } from "effect"

const NODE_KIND_SET = new Set<string>(NODE_KINDS)

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

function limit(value: number | undefined, fallback = 20) {
  return Math.max(1, Math.min(100, Math.floor(value ?? fallback)))
}

function depth(value: number | undefined) {
  return Math.max(1, Math.min(5, Math.floor(value ?? 2)))
}

function graphFile(root: string, base: string, filePath: string) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath)
  const relative = path.relative(root, absolute).replaceAll("\\", "/")
  const insideGraph = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return {
    graphPath: insideGraph ? relative : filePath.replaceAll("\\", "/"),
  }
}

function kinds(kind: string | undefined) {
  if (!kind) return undefined
  if (!NODE_KIND_SET.has(kind)) return undefined
  return [kind as NodeKind]
}

function statusBase(root: string) {
  const dataRoot = getGraphDataRootInfo(root)
  return {
    initialized: CodeGraph.isInitialized(root),
    projectRoot: root,
    dataRoot: dataRoot.dataRoot,
    dataRootStatus: dataRoot.dataRootStatus,
    jobStatus: readIndexJob(root),
  }
}

const openReadOnlyGraph = Effect.fn("GraphService.openReadOnlyGraph")(function* () {
  return yield* Chimera.openProjectGraph({ readOnly: true, watch: false, sync: false })
})

function nodeResult(state: ProjectGraphState, snapshot: CodeGraphSnapshot, node: Node, score?: number) {
  return {
    score,
    node,
    projection: state.graph.projectNode(node, snapshot),
  }
}

export const graphStatus = Effect.fn("GraphService.status")(function* () {
  const root = projectRoot(yield* InstanceState.context)
  const base = statusBase(root)
  if (!base.initialized) return base
  const state = yield* openReadOnlyGraph()
  return {
    ...base,
    snapshot: state.graph.snapshot(),
    stats: state.graph.stats(),
    backend: state.graph.backend(),
    journalMode: state.graph.journalMode(),
  }
})

export const graphSearch = Effect.fn("GraphService.search")(function* (input: {
  query: string
  kind?: string
  limit?: number
}) {
  const root = projectRoot(yield* InstanceState.context)
  const base = statusBase(root)
  if (!base.initialized || !input.query.trim()) return { ...base, results: [] }
  const state = yield* openReadOnlyGraph()
  const snapshot = state.graph.snapshot()
  return {
    ...base,
    snapshot,
    results: state.graph
      .searchNodes(input.query, { kinds: kinds(input.kind), limit: limit(input.limit) })
      .map((result) => nodeResult(state, snapshot, result.node, result.score)),
  }
})

export const graphNode = Effect.fn("GraphService.node")(function* (input: { nodeID: string }) {
  const root = projectRoot(yield* InstanceState.context)
  const base = statusBase(root)
  if (!base.initialized) return { ...base, node: null, projection: null }
  const state = yield* openReadOnlyGraph()
  const snapshot = state.graph.snapshot()
  const node = state.graph.node(input.nodeID)
  return {
    ...base,
    snapshot,
    node,
    projection: node ? state.graph.projectNode(node, snapshot) : null,
  }
})

export const graphFileSymbols = Effect.fn("GraphService.fileSymbols")(function* (input: {
  path: string
  kind?: string
  startLine?: number
  endLine?: number
  limit?: number
}) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const base = statusBase(root)
  const file = graphFile(root, instance.directory, input.path)
  if (!base.initialized) return { ...base, path: file.graphPath, results: [] }
  const state = yield* openReadOnlyGraph()
  const snapshot = state.graph.snapshot()
  const range = input.startLine
    ? ({ startLine: input.startLine, endLine: input.endLine ?? input.startLine } satisfies SourceRange)
    : undefined
  const nodes = range
    ? state.graph.nodesIntersectingRange(file.graphPath, range, { kinds: kinds(input.kind), smallestOnly: false })
    : state.graph.nodesInFile(file.graphPath).filter((node) => !input.kind || node.kind === input.kind)
  return {
    ...base,
    snapshot,
    path: file.graphPath,
    results: nodes.slice(0, limit(input.limit)).map((node) => nodeResult(state, snapshot, node)),
  }
})

export const graphFiles = Effect.fn("GraphService.files")(function* () {
  const root = projectRoot(yield* InstanceState.context)
  const base = statusBase(root)
  if (!base.initialized) return { ...base, files: [] }
  const state = yield* openReadOnlyGraph()
  return {
    ...base,
    snapshot: state.graph.snapshot(),
    files: state.graph.files(),
  }
})

export const graphImpact = Effect.fn("GraphService.impact")(function* (input: {
  nodeID?: string
  path?: string
  depth?: number
}) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const base = statusBase(root)
  if (!base.initialized) return { ...base, results: [] }
  const state = yield* openReadOnlyGraph()
  const snapshot = state.graph.snapshot()
  return {
    ...base,
    snapshot,
    results: input.nodeID
      ? state.graph.impactRadius(input.nodeID, depth(input.depth))
      : input.path
        ? state.graph.fileDependents(graphFile(root, instance.directory, input.path).graphPath)
        : [],
  }
})
