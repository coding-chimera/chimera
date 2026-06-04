import path from "path"
import {
  CodeGraph,
  type BuildContextOptions,
  type CodeGraphSnapshot,
  type FrozenSemanticObject,
  type IndexProgress,
  type Node as CodeGraphNode,
  type PendingFile as CodeGraphPendingFile,
  type RangeQueryOptions,
  type SearchOptions,
  type SourceRange,
  type SyncResult as CodeGraphSyncResult,
  type TaskInput,
  type WatchOptions,
} from "../../../../../codegraph/dist/index.js"

export type {
  CodeGraphNode,
  CodeGraphSnapshot,
  CodeGraphSyncResult,
  CodeGraphPendingFile,
  FrozenSemanticObject,
  IndexProgress as CodeGraphIndexProgress,
  RangeQueryOptions,
  SearchOptions,
  SourceRange,
  WatchOptions,
}

export interface OpenOptions {
  init?: boolean
  index?: boolean
  sync?: boolean
  onProgress?: (progress: IndexProgress) => void
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
      const adapter = new CodeGraphAdapter(root, await CodeGraph.open(root, { sync: false }))
      if (options.sync) await adapter.sync({ onProgress: options.onProgress })
      return adapter
    }
    if (!options.init) {
      throw new Error(`CodeGraph is not initialized in ${root}`)
    }
    const adapter = new CodeGraphAdapter(root, await CodeGraph.init(root, { index: false }))
    if (options.index) await adapter.graph.indexAll({ onProgress: options.onProgress })
    if (!options.index && options.sync) await adapter.sync({ onProgress: options.onProgress })
    return adapter
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

  async syncFiles(filePaths: string[], options: { onProgress?: (progress: IndexProgress) => void } = {}) {
    if (filePaths.length === 0) return emptySyncResult()
    return this.graph.syncFiles(filePaths, { onProgress: options.onProgress })
  }

  sync(options: { onProgress?: (progress: IndexProgress) => void } = {}) {
    return this.graph.sync({ onProgress: options.onProgress })
  }

  pendingFiles(): CodeGraphPendingFile[] {
    return this.graph.getPendingFiles()
  }

  changedFiles() {
    return this.graph.getChangedFiles()
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

  watch(options: WatchOptions = {}) {
    return this.graph.watch(options)
  }

  unwatch() {
    this.graph.unwatch()
  }

  isWatching() {
    return this.graph.isWatching()
  }

  projectNode(nodeOrId: CodeGraphNode | string, snapshot = this.snapshot()): FrozenSemanticObject | null {
    return this.graph.projectNode(nodeOrId, snapshot)
  }
}
