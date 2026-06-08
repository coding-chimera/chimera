import path from "path"
import fs from "fs"
import { Effect, Exit, Schema } from "effect"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"
import { classifyChangeRecord, classifyFileBoundary, collectFileProjections, collectIncidentRelations } from "./change-classifier"
import { CodeGraphAdapter } from "./codegraph-adapter"
import type { CodeGraphSnapshot, IndexProgress as CodeGraphIndexProgress, SyncResult as CodeGraphSyncResult } from "@colbymchenry/codegraph"
import { appendProvenanceRecord, databaseStorePath, readPredesignRuns, readProvenanceRecords, writeChangeFacts } from "./store"
import { TOOL_MUTATION_PREDESIGN_REQUIRED } from "./guidance"

const ARTIFACT_DIR = path.join(".codegraph", "chimera")
const TOOL_PROVENANCE_FILE = "tool-provenance.jsonl"
const TOOL_DEDUPE_WINDOW_MS = 15_000
const EMPTY_GRAPH_RETRY_MS = 2_000

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
  metadata?: Record<string, unknown> | (() => Record<string, unknown> | undefined)
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

export interface MutationPredesignInput {
  toolID: string
  ctx: Tool.Context
  files: string[]
  destructive?: boolean
  multiFile?: boolean
  rename?: boolean
}

type MutationPredesignRisk = {
  target: string
  classification: ReturnType<typeof classifyFileBoundary>["classification"]
  highRisk: boolean
}

type MutationPredesignDecision =
  | {
      required: boolean
      allowed: true
      files: ProvenanceFile[]
      risks: MutationPredesignRisk[]
      predesign?: Awaited<ReturnType<typeof readPredesignRuns>>[number]
    }
  | {
      required: true
      allowed: false
      files: ProvenanceFile[]
      risks: MutationPredesignRisk[]
      result: Tool.ExecuteResult
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
  lastRefreshAttemptAt?: number
  refreshPromise?: Promise<void>
}

const graphStates = new Map<string, Promise<ProjectGraphState>>()
const recentToolFiles = new Map<string, number>()
const PREDESIGN_FRESH_WINDOW_MS = 2 * 60 * 60 * 1000

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

function predesignArtifact(root: string) {
  return path.join(root, ARTIFACT_DIR, "predesign-runs.jsonl")
}

function predesignRisk(file: ProvenanceFile) {
  const target = file.graphPath ?? file.absolutePath
  const classification = classifyFileBoundary(target).classification
  const normalizedTarget = target.startsWith("/") ? target : `/${target}`
  const codeSurface = [
    "/src/tool/",
    "/src/session/prompt",
    "/src/session/system",
    "/src/provider/",
    "/src/config/",
    "/src/chimera/",
  ].some((needle) => normalizedTarget.includes(needle))
  const highRisk = ["source", "api_route", "config", "dependency", "generated"].includes(classification) || codeSurface
  return { target, classification, highRisk }
}

function freshPredesign(input: { records: Awaited<ReturnType<typeof readPredesignRuns>>; sessionID: string; files: ProvenanceFile[] }) {
  const now = Date.now()
  const targetFiles = new Set(input.files.flatMap((file) => (file.graphPath ? [file.graphPath] : [])))
  return input.records.find((record) => {
    if (record.sessionID !== input.sessionID) return false
    const createdAt = Date.parse(record.createdAt)
    if (!Number.isFinite(createdAt) || now - createdAt > PREDESIGN_FRESH_WINDOW_MS) return false
    if (record.files.length === 0) return true
    return record.files.some((file) => targetFiles.has(file))
  })
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

function safeMetadata(input: ToolMutationInput["metadata"]) {
  const metadata = typeof input === "function" ? input() : input
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

function hasIndexedFiles(stats: { fileCount: number }) {
  return stats.fileCount > 0
}

function hasGitMetadata(root: string) {
  return fs.existsSync(path.join(root, ".git"))
}

function uniqueAbsolute(root: string, files: string[]) {
  return [...new Set(files.map((file) => path.join(root, file)))]
}

async function refreshProjectGraph(state: ProjectGraphState, onProgress?: (progress: CodeGraphIndexProgress) => void) {
  if (state.refreshPromise) return state.refreshPromise

  const now = Date.now()
  const empty = !hasIndexedFiles(state.graph.stats())
  if (empty && state.lastRefreshAttemptAt && now - state.lastRefreshAttemptAt < EMPTY_GRAPH_RETRY_MS) return

  state.refreshPromise = (async () => {
    if (empty) {
      state.lastRefreshAttemptAt = now
      await state.graph.sync({ onProgress })
      return
    }

    const pendingFiles = uniqueAbsolute(state.projectRoot, state.graph.pendingFiles().map((file) => file.path))
    if (pendingFiles.length > 0) {
      await state.graph.syncFiles(pendingFiles, { onProgress })
      return
    }

    const gitChangedFiles = hasGitMetadata(state.projectRoot) ? state.graph.changedFiles() : undefined
    const changedFiles = gitChangedFiles
      ? uniqueAbsolute(state.projectRoot, [
          ...gitChangedFiles.added,
          ...gitChangedFiles.modified,
          ...gitChangedFiles.removed,
        ])
      : []
    if (changedFiles.length > 0) {
      await state.graph.syncFiles(changedFiles, { onProgress })
    }
  })().finally(() => {
    delete state.refreshPromise
  })

  return state.refreshPromise
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
    promise = CodeGraphAdapter.open(root, { init: true, index: true, sync: false, onProgress }).then((graph) => {
      const state: ProjectGraphState = {
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
    const beforeNodes = collectFileProjections(s.graph, files, before)
    const beforeRelations = collectIncidentRelations(s.graph, beforeNodes, before)
    const exit = yield* effect.pipe(Effect.exit)
    const sync = yield* Effect.promise(() => s.graph.syncFiles(syncFiles)).pipe(Effect.orDie)
    const after = s.graph.snapshot()
    const afterNodes = collectFileProjections(s.graph, files, after)
    const afterRelations = collectIncidentRelations(s.graph, afterNodes, after)
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
    if (Exit.isSuccess(exit)) {
      const facts = classifyChangeRecord({ record, beforeNodes, afterNodes, beforeRelations, afterRelations })
      yield* Effect.promise(() => writeChangeFacts(s.projectRoot, facts)).pipe(Effect.orDie)
    }
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

export const requirePredesignForMutation: (input: MutationPredesignInput) => Effect.Effect<MutationPredesignDecision> = Effect.fn(
  "Chimera.requirePredesignForMutation",
)(function* (input: MutationPredesignInput) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const files = stableFiles(
    root,
    input.files.map((file) => normalizeAbsolute(file, instance.directory)),
  )
  const risks = files.map(predesignRisk)
  const risky = risks.filter((risk) => risk.highRisk)
  const destructiveRisk = Boolean(input.destructive || input.rename || input.multiFile) && risky.length > 0
  const required = risky.length > 0 || destructiveRisk
  if (!required) return { required, allowed: true as const, files, risks }

  const records = yield* Effect.promise(() =>
    readPredesignRuns(root, predesignArtifact(root), { sessionID: input.ctx.sessionID, limit: 20 }),
  ).pipe(Effect.orDie)
  const match = freshPredesign({ records, sessionID: input.ctx.sessionID, files })
  if (match) return { required, allowed: true as const, files, risks, predesign: match }

  const output = [
    TOOL_MUTATION_PREDESIGN_REQUIRED,
    "",
    "Risk surface:",
    ...risky.map((risk) => `- ${risk.target}: ${risk.classification}`),
  ].join("\n")
  return {
    required,
    allowed: false as const,
    files,
    risks,
    result: {
      title: "Chimera pre-design required",
      output,
      metadata: {
        chimeraPredesignRequired: true,
        toolID: input.toolID,
        files: files.map((file) => file.graphPath ?? file.absolutePath),
        risks,
      },
    },
  }
})

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
  if (input.sync) yield* Effect.promise(() => refreshProjectGraph(s, input.onProgress)).pipe(Effect.orDie)
  return s
})

export * as Chimera from "./provenance"
