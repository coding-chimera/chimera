import path from "path"
import { appendFile, mkdir } from "fs/promises"
import { Effect, Exit, Schema } from "effect"
import type { Interface as BusInterface } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"
import { CodeGraphAdapter, type CodeGraphSnapshot, type CodeGraphSyncResult } from "./codegraph-adapter"

const ARTIFACT_DIR = path.join(".codegraph", "chimera")
const TOOL_PROVENANCE_FILE = "tool-provenance.jsonl"

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
}

export interface ProvenanceFile {
  absolutePath: string
  graphPath?: string
  insideGraph: boolean
}

export interface ToolMutationRecord {
  schemaVersion: 1
  id: string
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
}

const graphStates = new Map<string, Promise<ProjectGraphState>>()

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

async function appendRecord(file: string, record: ToolMutationRecord) {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8")
}

function openGraphState(root: string): Promise<ProjectGraphState> {
  let promise = graphStates.get(root)
  if (!promise) {
    promise = CodeGraphAdapter.open(root, { init: true, index: true, sync: true }).then((graph) => ({
      graph,
      projectRoot: root,
      artifact: path.join(root, ARTIFACT_DIR, TOOL_PROVENANCE_FILE),
    }))
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
    const syncFiles = files.filter((file) => file.insideGraph).map((file) => file.absolutePath)
    const before = s.graph.snapshot()
    const exit = yield* effect.pipe(Effect.exit)
    const sync = yield* Effect.promise(() => s.graph.syncFiles(syncFiles)).pipe(Effect.orDie)
    const after = s.graph.snapshot()
    const finishedAt = new Date().toISOString()
    const record: ToolMutationRecord = {
      schemaVersion: 1,
      id: `${input.ctx.sessionID}:${input.ctx.messageID}:${input.ctx.callID ?? input.toolID}:${Date.now()}`,
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

    yield* Effect.promise(() => appendRecord(s.artifact, record)).pipe(Effect.orDie)
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
  const s = yield* openProjectGraph({ sync: true })
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

export const openProjectGraph = Effect.fn("Chimera.openProjectGraph")(function* (input: { sync?: boolean } = {}) {
  const instance = yield* InstanceState.context
  const root = projectRoot(instance)
  const s = yield* Effect.promise(() => openGraphState(root)).pipe(Effect.orDie)
  if (input.sync) yield* Effect.promise(() => s.graph.sync()).pipe(Effect.orDie)
  return s
})

export * as Chimera from "./provenance"
