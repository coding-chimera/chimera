import path from "path"
import {
  CodeGraph,
  type CodeGraphSnapshot,
  type FrozenSemanticObject,
  type Node as CodeGraphNode,
  type RangeQueryOptions,
  type SourceRange,
  type SyncResult as CodeGraphSyncResult,
} from "../../../../../codegraph/dist/index.js"

export type {
  CodeGraphNode,
  CodeGraphSnapshot,
  CodeGraphSyncResult,
  FrozenSemanticObject,
  RangeQueryOptions,
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

  async syncFiles(filePaths: string[]) {
    if (filePaths.length === 0) return emptySyncResult()
    return this.graph.syncFiles(filePaths)
  }

  nodesIntersectingRange(filePath: string, range: SourceRange, options: RangeQueryOptions = {}) {
    return this.graph.getNodesIntersectingRange(filePath, range, options)
  }

  projectNode(nodeOrId: CodeGraphNode | string, snapshot = this.snapshot()): FrozenSemanticObject | null {
    return this.graph.projectNode(nodeOrId, snapshot)
  }
}
