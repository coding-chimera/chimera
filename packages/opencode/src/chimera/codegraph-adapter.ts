import path from "path"
import {
  CodeGraph,
  type BuildContextOptions,
  type CodeGraphSnapshot,
  type FrozenSemanticObject,
  type Node as CodeGraphNode,
  type RangeQueryOptions,
  type SearchOptions,
  type SourceRange,
  type SyncResult as CodeGraphSyncResult,
  type TaskInput,
} from "../../../../../codegraph/dist/index.js"

export type {
  CodeGraphNode,
  CodeGraphSnapshot,
  CodeGraphSyncResult,
  FrozenSemanticObject,
  RangeQueryOptions,
  SearchOptions,
  SourceRange,
}

export interface OpenOptions {
  init?: boolean
  index?: boolean
  sync?: boolean
}

function emptySyncResult(): CodeGraphSyncResult {
  return {
    filesChecked: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    nodesUpdated: 0,
    durationMs: 0,
  }
}

export class CodeGraphAdapter {
  private constructor(
    readonly projectRoot: string,
    private readonly graph: CodeGraph,
  ) {}

  static async open(projectRoot: string, options: OpenOptions = {}) {
    const root = path.resolve(projectRoot)
    if (CodeGraph.isInitialized(root)) {
      return new CodeGraphAdapter(root, await CodeGraph.open(root, { sync: options.sync }))
    }
    if (!options.init) {
      throw new Error(`CodeGraph is not initialized in ${root}`)
    }
    return new CodeGraphAdapter(root, await CodeGraph.init(root, { index: options.index }))
  }

  close() {
    this.graph.close()
  }

  snapshot(): CodeGraphSnapshot {
    return this.graph.getSnapshot()
  }

  stats() {
    return this.graph.getStats()
  }

  backend() {
    return this.graph.getBackend()
  }

  journalMode() {
    return this.graph.getJournalMode()
  }

  async syncFiles(filePaths: string[]) {
    if (filePaths.length === 0) return emptySyncResult()
    return this.graph.syncFiles(filePaths)
  }

  sync() {
    return this.graph.sync()
  }

  nodesIntersectingRange(filePath: string, range: SourceRange, options: RangeQueryOptions = {}) {
    return this.graph.getNodesIntersectingRange(filePath, range, options)
  }

  node(id: string) {
    return this.graph.getNode(id)
  }

  nodesInFile(filePath: string) {
    return this.graph.getNodesInFile(filePath)
  }

  nodesByName(name: string) {
    return this.graph.getNodesByName(name)
  }

  searchNodes(query: string, options: SearchOptions = {}) {
    return this.graph.searchNodes(query, options)
  }

  files() {
    return this.graph.getFiles()
  }

  callers(nodeID: string, depth = 1) {
    return this.graph.getCallers(nodeID, depth)
  }

  callees(nodeID: string, depth = 1) {
    return this.graph.getCallees(nodeID, depth)
  }

  impactRadius(nodeID: string, depth = 2) {
    return this.graph.getImpactRadius(nodeID, depth)
  }

  fileDependents(filePath: string) {
    return this.graph.getFileDependents(filePath)
  }

  async buildContext(input: TaskInput, options: BuildContextOptions = {}) {
    return this.graph.buildContext(input, options)
  }

  projectNode(nodeOrId: CodeGraphNode | string, snapshot = this.snapshot()): FrozenSemanticObject | null {
    return this.graph.projectNode(nodeOrId, snapshot)
  }
}
