import path from "path"
import fs from "fs"
import { Effect, Exit, Schema } from "effect"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import type { Tool } from "@/tool/tool"
import { classifyChangeRecord, classifyFileBoundary, collectFileProjections, collectIncidentRelations } from "./change-classifier"
import { CodeGraphAdapter } from "./codegraph-adapter"
import { getCodeGraphDir, isInitialized, type CodeGraphSnapshot, type IndexProgress as CodeGraphIndexProgress, type SyncResult as CodeGraphSyncResult } from "@/graph"
import { appendProvenanceRecord, databaseStorePath, readPredesignRuns, readProvenanceRecords, readRecentProvenanceRecords, recordOracleResult, writeChangeFacts, type OracleLinkedChange, type OracleStatus, type OracleVerificationKind } from "./store"
import { TOOL_MUTATION_PREDESIGN_REQUIRED } from "./guidance"

const ARTIFACT_SUBDIR = "chimera"
const TOOL_PROVENANCE_FILE = "tool-provenance.jsonl"
const ORACLE_RESULT_FILE = "oracle-results.jsonl"
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
  watch?: boolean
  onProgress?: (progress: CodeGraphIndexProgress) => void
}

export interface OpenProjectGraphInput {
  sync?: boolean
  watch?: boolean
  onProgress?: (progress: CodeGraphIndexProgress) => void
  init?: boolean
  readOnly?: boolean
}

export interface MutationPredesignInput {
  toolID: string
  ctx: Tool.Context
  files: string[]
  destructive?: boolean
  multiFile?: boolean
  rename?: boolean
}

export interface ToolOracleInput {
  kind: "shell" | "lsp"
  toolID: string
  ctx: Tool.Context
  status: OracleStatus
  startedAt?: string
  finishedAt?: string
  verificationKind?: OracleVerificationKind
  trusted?: boolean
  payload: unknown
  maxChanges?: number
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
const graphRootsByDirectory = new Map<string, string>()
const directoriesByGraphRoot = new Map<string, Set<string>>()
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

function artifactDir(root: string) {
  return path.join(getCodeGraphDir(root), ARTIFACT_SUBDIR)
}

function predesignArtifact(root: string) {
  return path.join(artifactDir(root), "predesign-runs.jsonl")
}

function toolProvenanceArtifact(root: string) {
  return path.join(artifactDir(root), TOOL_PROVENANCE_FILE)
}

function oracleArtifact(root: string) {
  return path.join(artifactDir(root), ORACLE_RESULT_FILE)
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

function metadataString(record: ToolMutationRecord, key: string) {
  const value = record.metadata?.[key]
  return typeof value === "string" ? value : undefined
}

function mutationSessionID(record: ToolMutationRecord) {
  return record.actor?.sessionID ?? record.tool.sessionID
}

function mutationBefore(record: ToolMutationRecord, finishedAt: string) {
  const mutationFinishedAt = Date.parse(record.finishedAt)
  const oracleFinishedAt = Date.parse(finishedAt)
  if (Number.isFinite(mutationFinishedAt) && Number.isFinite(oracleFinishedAt)) return mutationFinishedAt <= oracleFinishedAt
  return record.finishedAt <= finishedAt
}

function oracleLinkedChange(record: ToolMutationRecord): OracleLinkedChange {
  return {
    id: record.id,
    toolID: record.tool.id,
    status: record.status,
    finishedAt: record.finishedAt,
    beforeRevision: record.graph.before.revision,
    afterRevision: record.graph.after.revision,
    files: record.files.map((file) => file.graphPath ?? file.absolutePath),
    changeID: metadataString(record, "changeID"),
  }
}

function linkedOracleChanges(input: { records: ToolMutationRecord[]; root: string; sessionID: string; finishedAt: string; maxChanges: number }) {
  return input.records
    .filter((record) => record.project.root === input.root)
    .filter((record) => mutationSessionID(record) === input.sessionID)
    .filter((record) => mutationBefore(record, input.finishedAt))
    .toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id))
    .slice(-input.maxChanges)
    .map(oracleLinkedChange)
}

export function countOracleDiagnostics(diagnostics: Record<string, readonly unknown[]>) {
  return Object.values(diagnostics).reduce((sum, items) => sum + items.length, 0)
}

function recentToolKey(root: string, graphPath: string) {
  return `${root}\0${graphPath}`
}

function rememberGraphRoot(directory: string, root: string) {
  const previous = graphRootsByDirectory.get(directory)
  if (previous === root) return
  if (previous) {
    const directories = directoriesByGraphRoot.get(previous)
    directories?.delete(directory)
    if (directories?.size === 0) directoriesByGraphRoot.delete(previous)
  }
  graphRootsByDirectory.set(directory, root)
  const directories = directoriesByGraphRoot.get(root) ?? new Set<string>()
  directories.add(directory)
  directoriesByGraphRoot.set(root, directories)
}

async function closeGraphRoot(root: string) {
  const promise = graphStates.get(root)
  graphStates.delete(root)
  for (const key of recentToolFiles.keys()) {
    if (key.startsWith(`${root}\0`)) recentToolFiles.delete(key)
  }
  if (!promise) return
  try {
    const state = await promise
    await state.graph.close()
  } catch {
    // Failed opens have no live watcher/db to close.
  }
}

registerDisposer(async (directory) => {
  const root = graphRootsByDirectory.get(directory)
  if (!root) return
  graphRootsByDirectory.delete(directory)
  const directories = directoriesByGraphRoot.get(root)
  directories?.delete(directory)
  if (directories && directories.size > 0) return
  directoriesByGraphRoot.delete(root)
  await closeGraphRoot(root)
}, "chimera-provenance-graph")

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

  const records = await readRecentProvenanceRecords(root, artifact, { limit: 20 })
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

function openGraphState(
  root: string,
  options: { init?: boolean; readOnly?: boolean; watch?: boolean; onProgress?: (progress: CodeGraphIndexProgress) => void } = {},
): Promise<ProjectGraphState> {
  const cached = options.readOnly ? undefined : graphStates.get(root)
  if (cached) {
    if (options.watch) cached.then(startFilesystemWatcher).catch(() => undefined)
    return cached
  }

  const init = options.init ?? false
  const promise = CodeGraphAdapter.open(root, {
    init,
    index: init,
    sync: false,
    readOnly: options.readOnly,
    onProgress: options.onProgress,
  }).then((graph) => {
    const state: ProjectGraphState = {
      graph,
      projectRoot: root,
      artifact: toolProvenanceArtifact(root),
      storePath: databaseStorePath(root),
    }
    if (options.watch && !options.readOnly) startFilesystemWatcher(state)
    return state
  })
  if (options.readOnly) return promise
  const tracked = promise.catch((error) => {
    graphStates.delete(root)
    throw error
  })
  graphStates.set(root, tracked)
  return tracked
}

export const recordToolOracle = Effect.fn("Chimera.recordToolOracle")(function* (input: ToolOracleInput) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const finishedAt = input.finishedAt ?? new Date().toISOString()
  const maxChanges = Math.max(1, Math.min(100, Math.floor(input.maxChanges ?? 20)))
  const records = yield* Effect.promise(() => readRecentProvenanceRecords(root, toolProvenanceArtifact(root), { sessionID: input.ctx.sessionID, finishedBefore: finishedAt, limit: maxChanges }))
  const linkedChanges = linkedOracleChanges({ records, root, sessionID: input.ctx.sessionID, finishedAt, maxChanges })
  return yield* Effect.promise(() =>
    recordOracleResult(root, oracleArtifact(root), {
      kind: input.kind,
      status: input.status,
      tool: {
        id: input.toolID,
        callID: input.ctx.callID,
        messageID: input.ctx.messageID,
        sessionID: input.ctx.sessionID,
        agent: input.ctx.agent,
      },
      project: {
        root,
        worktree: instance.worktree,
        directory: instance.directory,
      },
      startedAt: input.startedAt,
      finishedAt,
      linkWindow: {
        source: "same_session_preceding_mutations",
        sessionID: input.ctx.sessionID,
        projectRoot: root,
        finishedBefore: finishedAt,
        maxChanges,
      },
      linkedChanges,
      verificationKind: input.verificationKind,
      trusted: input.trusted,
      payload: input.payload,
    }),
  )
})

export function trackToolMutation<A, E, R>(
  input: ToolMutationInput,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance)
    if (!isInitialized(root)) return yield* effect
    const s = yield* Effect.promise(() => openGraphState(root, { init: false, watch: false })).pipe(Effect.orDie)
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
  if (!isInitialized(root)) return { required: false, allowed: true as const, files, risks }
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
  const s = yield* openProjectGraph({ init: true, sync: true, watch: input.watch ?? true, onProgress: input.onProgress })
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
  yield* Effect.sync(() => rememberGraphRoot(instance.directory, root))
  const s = yield* Effect.promise(() => openGraphState(root, { init: input.init, readOnly: input.readOnly, watch: input.watch ?? !input.readOnly, onProgress: input.onProgress })).pipe(Effect.orDie)
  if (input.sync && !input.readOnly) yield* Effect.promise(() => refreshProjectGraph(s, input.onProgress)).pipe(Effect.orDie)
  return s
})

export function withProjectGraph<A, E, R>(
  input: OpenProjectGraphInput,
  use: (state: ProjectGraphState) => Effect.Effect<A, E, R>,
) {
  const readOnly = input.readOnly === true
  return Effect.acquireUseRelease(
    openProjectGraph(input),
    use,
    (state) => readOnly ? Effect.promise(() => state.graph.close()).pipe(Effect.ignore) : Effect.sync(() => state.graph.shrink()),
  )
}

export * as Chimera from "./provenance"
