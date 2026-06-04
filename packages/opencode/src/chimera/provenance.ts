import path from "path"
import { Effect, Exit, Schema } from "effect"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"
import { CodeGraphAdapter, type CodeGraphIndexProgress, type CodeGraphSnapshot, type CodeGraphSyncResult } from "./codegraph-adapter"
import { appendProvenanceRecord, databaseStorePath, readProvenanceRecords } from "./store"

const ARTIFACT_DIR = path.join(".codegraph", "chimera")
const TOOL_PROVENANCE_FILE = "tool-provenance.jsonl"
const TOOL_DEDUPE_WINDOW_MS = 15_000

export const ToolMutationRecorded = BusEvent.define(
  "chimera.tool.mutation.recorded",
  Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    messageID: Schema.String,
    callID: Schema.optional(Schema.String),
    toolID: Schema.String,
    projectRoot: Schema.String,
    files: Schema.Array(Schema.String),
    status: Schema.Union([Schema.Literal("success"), Schema.Literal("failure")]),
    beforeRevision: Schema.String,
    afterRevision: Schema.String,
    artifact: Schema.String,
  }),
)

export const GraphReady = BusEvent.define(
  "chimera.graph.ready",
  Schema.Struct({
    projectRoot: Schema.String,
    revision: Schema.String,
    indexedAt: Schema.Number,
    fileCount: Schema.Number,
    nodeCount: Schema.Number,
    edgeCount: Schema.Number,
    source: Schema.String,
    sessionID: Schema.optional(Schema.String),
  }),
)

export interface ToolMutationInput {
  toolID: string
  ctx: Tool.Context
  files: string[]
  bus?: BusInterface
  metadata?: Record<string, unknown>
}

export interface InitProjectGraphInput {
  bus?: BusInterface
  source?: string
  sessionID?: string
  onProgress?: (progress: CodeGraphIndexProgress) => void
}

export interface OpenProjectGraphInput {
  sync?: boolean
  onProgress?: (progress: CodeGraphIndexProgress) => void
}

export interface ProvenanceFile {
  absolutePath: string
  graphPath?: string
  insideGraph: boolean
}

export interface ToolMutationRecord {
  schemaVersion: 1
  id: string
  origin?: "tool" | "filesystem" | "git"
  provenanceStrength?: "strong" | "weak"
  actor?: {
    sessionID: string
    messageID: string
    callID?: string
    agent: string
  }
  observer?: {
    id: string
    sessionID?: string
    agent: string
  }
  tool: {
    id: string
    callID?: string
    messageID: string
    sessionID: string
    agent: string
  }
  project: {
    root: string
    worktree: string
    directory: string
  }
  status: "success" | "failure"
  startedAt: string
  finishedAt: string
  graph: {
    before: CodeGraphSnapshot
    after: CodeGraphSnapshot
    sync: CodeGraphSyncResult
  }
  files: ProvenanceFile[]
  metadata?: Record<string, unknown>
}

export interface ProjectGraphState {
  graph: CodeGraphAdapter
  projectRoot: string
  artifact: string
  storePath: string
}

const graphStates = new Map<string, Promise<ProjectGraphState>>()
const recentToolFiles = new Map<string, number>()

function projectRoot(input: { directory: string; worktree: string }) {
  return input.worktree === "/" ? input.directory : input.worktree
}

function normalizeAbsolute(filePath: string, base: string) {
  return path.resolve(base, filePath)
}

function toProvenanceFile(root: string, filePath: string): ProvenanceFile {
  const absolutePath = path.resolve(filePath)
  const relative = path.relative(root, absolutePath).replaceAll("\\", "/")
  const insideGraph = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return {
    absolutePath,
    graphPath: insideGraph ? relative : undefined,
    insideGraph,
  }
}

function stableFiles(root: string, files: string[]) {
  const seen = new Set<string>()
  const result: ProvenanceFile[] = []
  for (const file of files) {
    const item = toProvenanceFile(root, file)
    if (seen.has(item.absolutePath)) continue
    seen.add(item.absolutePath)
    result.push(item)
  }
  return result
}

function safeMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined
  try {
    return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
  } catch {
    return { unserializable: true }
  }
}

function recentToolKey(root: string, graphPath: string) {
  return `${root}\0${graphPath}`
}

function rememberToolFiles(root: string, files: ProvenanceFile[], now = Date.now()) {
  for (const file of files) {
    if (!file.graphPath) continue
    recentToolFiles.set(recentToolKey(root, file.graphPath), now)
  }
  for (const [key, at] of recentToolFiles) {
    if (now - at > TOOL_DEDUPE_WINDOW_MS) recentToolFiles.delete(key)
  }
}

async function hasRecentToolProvenance(artifact: string, root: string, files: string[], batchStartedAtMs: number) {
  const fileSet = new Set(files)
  const memoryHit = files.some((file) => {
    const at = recentToolFiles.get(recentToolKey(root, file))
    return at !== undefined && batchStartedAtMs - at <= TOOL_DEDUPE_WINDOW_MS
  })
  if (memoryHit) return true

  const records = await readProvenanceRecords(root, artifact)
  return records
    .slice(-20)
    .some((record) => {
      if ((record.origin ?? "tool") !== "tool") return false
      if (record.status !== "success") return false
      const finishedAt = Date.parse(record.finishedAt)
      if (!Number.isFinite(finishedAt) || batchStartedAtMs - finishedAt > TOOL_DEDUPE_WINDOW_MS) return false
      return record.files.some((file) => file.graphPath && fileSet.has(file.graphPath))
    })
}

function weakObserver() {
  return {
    id: "codegraph.watch",
    agent: "chimera",
  }
}

function syntheticTool(origin: "filesystem" | "git", batchID: string) {
  return {
    id: origin === "git" ? "git_checkout" : "filewatcher",
    messageID: batchID,
    sessionID: "observer",
    agent: "chimera",
  }
}

function startFilesystemWatcher(state: ProjectGraphState) {
  if (state.graph.isWatching()) return

  state.graph.watch({
    autoSync: false,
    includeNonSource: true,
    watchGitHead: true,
    onBatch: async (batch, api) => {
      if (batch.files.length === 0) return api.sync()

      const hasGitEvent = batch.events.some((event) => event.source === "git")
      if (hasGitEvent) {
        const before = api.snapshot()
        const sync = await api.sync()
        const after = api.snapshot()
        const record: ToolMutationRecord = {
          schemaVersion: 1,
          id: `git:${batch.id}`,
          origin: "git",
          provenanceStrength: "weak",
          observer: weakObserver(),
          tool: syntheticTool("git", batch.id),
          project: {
            root: state.projectRoot,
            worktree: state.projectRoot,
            directory: state.projectRoot,
          },
          status: "success",
          startedAt: new Date(batch.startedAtMs).toISOString(),
          finishedAt: new Date().toISOString(),
          graph: {
            before,
            after,
            sync,
          },
          files: stableFiles(
            state.projectRoot,
            (sync.changedFiles ?? []).map((file) => path.join(state.projectRoot, file.path)),
          ),
          metadata: {
            origin: "git",
            provenance_strength: "weak",
            batchID: batch.id,
            batchSource: batch.source,
            events: batch.events,
          },
        }

        await appendProvenanceRecord(state.projectRoot, state.artifact, record)
        return sync
      }

      const syncFiles = batch.files.map((file) => path.join(state.projectRoot, file))
      const freshnessOnly = await hasRecentToolProvenance(state.artifact, state.projectRoot, batch.files, batch.startedAtMs)
      if (freshnessOnly) return api.syncFiles(syncFiles)

      const before = api.snapshot()
      const sync = await api.syncFiles(syncFiles)
      const after = api.snapshot()
      const finishedAt = new Date().toISOString()
      const record: ToolMutationRecord = {
        schemaVersion: 1,
        id: `filesystem:${batch.id}`,
        origin: "filesystem",
        provenanceStrength: "weak",
        observer: weakObserver(),
        tool: syntheticTool("filesystem", batch.id),
        project: {
          root: state.projectRoot,
          worktree: state.projectRoot,
          directory: state.projectRoot,
        },
        status: "success",
        startedAt: new Date(batch.startedAtMs).toISOString(),
        finishedAt,
        graph: {
          before,
          after,
          sync,
        },
        files: stableFiles(
          state.projectRoot,
          batch.files.map((file) => path.join(state.projectRoot, file)),
        ),
        metadata: {
          origin: "filesystem",
          provenance_strength: "weak",
          batchID: batch.id,
          batchSource: batch.source,
          events: batch.events,
        },
      }

      await appendProvenanceRecord(state.projectRoot, state.artifact, record)
      return sync
    },
  })
}

function openGraphState(root: string, onProgress?: (progress: CodeGraphIndexProgress) => void): Promise<ProjectGraphState> {
  let promise = graphStates.get(root)
  if (!promise) {
    promise = CodeGraphAdapter.open(root, { init: true, index: true, sync: true, onProgress }).then((graph) => {
      const state = {
        graph,
        projectRoot: root,
        artifact: path.join(root, ARTIFACT_DIR, TOOL_PROVENANCE_FILE),
        storePath: databaseStorePath(root),
      }
      startFilesystemWatcher(state)
      return state
    })
    graphStates.set(root, promise)
  }
  return promise
}

export function trackToolMutation<A, E, R>(
  input: ToolMutationInput,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance)
    const s = yield* Effect.promise(() => openGraphState(root)).pipe(Effect.orDie)
    const startedAt = new Date().toISOString()
    const files = stableFiles(
      s.projectRoot,
      input.files.map((file) => normalizeAbsolute(file, instance.directory)),
    )
    rememberToolFiles(s.projectRoot, files)
    const syncFiles = files.filter((file) => file.insideGraph).map((file) => file.absolutePath)
    const before = s.graph.snapshot()
    const exit = yield* effect.pipe(Effect.exit)
    const sync = yield* Effect.promise(() => s.graph.syncFiles(syncFiles)).pipe(Effect.orDie)
    const after = s.graph.snapshot()
    const finishedAt = new Date().toISOString()
    const record: ToolMutationRecord = {
      schemaVersion: 1,
      id: `${input.ctx.sessionID}:${input.ctx.messageID}:${input.ctx.callID ?? input.toolID}:${Date.now()}`,
      origin: "tool",
      provenanceStrength: "strong",
      actor: {
        sessionID: input.ctx.sessionID,
        messageID: input.ctx.messageID,
        callID: input.ctx.callID,
        agent: input.ctx.agent,
      },
      tool: {
        id: input.toolID,
        callID: input.ctx.callID,
        messageID: input.ctx.messageID,
        sessionID: input.ctx.sessionID,
        agent: input.ctx.agent,
      },
      project: {
        root: s.projectRoot,
        worktree: instance.worktree,
        directory: instance.directory,
      },
      status: Exit.isSuccess(exit) ? "success" : "failure",
      startedAt,
      finishedAt,
      graph: {
        before,
        after,
        sync,
      },
      files,
      metadata: safeMetadata(input.metadata),
    }

    yield* Effect.promise(() => appendProvenanceRecord(s.projectRoot, s.artifact, record)).pipe(Effect.orDie)
    rememberToolFiles(s.projectRoot, files)
    if (input.bus) {
      yield* input.bus.publish(ToolMutationRecorded, {
        id: record.id,
        sessionID: record.tool.sessionID,
        messageID: record.tool.messageID,
        callID: record.tool.callID,
        toolID: record.tool.id,
        projectRoot: record.project.root,
        files: record.files.map((file) => file.graphPath ?? file.absolutePath),
        status: record.status,
        beforeRevision: record.graph.before.revision,
        afterRevision: record.graph.after.revision,
        artifact: s.artifact,
      })
    }

    if (Exit.isSuccess(exit)) return exit.value
    return yield* Effect.failCause(exit.cause)
  })
}

export const initProjectGraph = Effect.fn("Chimera.initProjectGraph")(function* (input: InitProjectGraphInput = {}) {
  const s = yield* openProjectGraph({ sync: true, onProgress: input.onProgress })
  const snapshot = s.graph.snapshot()
  if (input.bus) {
    yield* input.bus.publish(GraphReady, {
      projectRoot: s.projectRoot,
      revision: snapshot.revision,
      indexedAt: snapshot.indexedAt,
      fileCount: snapshot.fileCount,
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      source: input.source ?? "project.init",
      sessionID: input.sessionID,
    })
  }
  return snapshot
})

export const openProjectGraph = Effect.fn("Chimera.openProjectGraph")(function* (input: OpenProjectGraphInput = {}) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const s = yield* Effect.promise(() => openGraphState(root, input.onProgress)).pipe(Effect.orDie)
  if (input.sync) yield* Effect.promise(() => s.graph.sync({ onProgress: input.onProgress })).pipe(Effect.orDie)
  return s
})

export * as Chimera from "./provenance"
