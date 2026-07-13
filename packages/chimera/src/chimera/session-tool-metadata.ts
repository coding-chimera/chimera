import path from "path"
import { createHash } from "crypto"
import { getGraphDataRootInfo } from "@/graph"
import { isRecord } from "@/util/record"
import { readAuditRunReadonly, readOracleResultReadonly, readPredesignRunReadonly } from "./store"

const KEY = "$chimeraStoreRef" as const
const AUDIT_TOOLS = new Set(["chimera_audit", "chimera_audit_recent"])
const PREDESIGN_TOOLS = new Set(["chimera_predesign"])
const ORACLE_TOOLS = new Set(["chimera_oracle_recent", "chimera_oracle_get"])

type StoreKind = "audit" | "predesign" | "oracle"

type ResultMetadata = {
  truncated?: boolean
  outputPath?: string
}

export type Envelope = {
  version: 1
  kind: StoreKind
  tool: string
  projectRoot: string
  refs: string[]
  artifact?: string
  result?: ResultMetadata
  metadataHash: string
}

export type Persisted = {
  [KEY]: Envelope
}

export type Recovery =
  | { status: "not-envelope" }
  | { status: "invalid"; reason: string; envelope?: Envelope }
  | { status: "recovered"; envelope: Envelope; metadata: Record<string, unknown> }

function stableJson(input: unknown): string {
  if (input === undefined) return "null"
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`
  return `{${Object.keys(input)
    .sort()
    .flatMap((key) => {
      const value = (input as Record<string, unknown>)[key]
      return value === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(value)}`]
    })
    .join(",")}}`
}

function metadataHash(metadata: Record<string, unknown>) {
  return createHash("sha256").update(stableJson(JSON.parse(JSON.stringify(metadata)))).digest("hex")
}

function refID(ref: string, kind: StoreKind) {
  const prefix = `${kind}:`
  if (!ref.startsWith(prefix) || ref.length === prefix.length) return undefined
  return ref.slice(prefix.length)
}

function projectRoot(metadata: Record<string, unknown>) {
  return typeof metadata.projectRoot === "string" && path.isAbsolute(metadata.projectRoot)
    ? path.resolve(metadata.projectRoot)
    : undefined
}

function resultMetadata(metadata: Record<string, unknown>): ResultMetadata | undefined {
  const truncated = typeof metadata.truncated === "boolean" ? metadata.truncated : undefined
  const outputPath = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined
  if (truncated === undefined && outputPath === undefined) return undefined
  return {
    ...(truncated !== undefined ? { truncated } : {}),
    ...(outputPath !== undefined ? { outputPath } : {}),
  }
}

function artifactPaths(root: string, file: string) {
  const info = getGraphDataRootInfo(root)
  return [...new Set([path.join(info.dataRoot, "chimera", file), path.join(info.legacyRoot, "chimera", file)].map((item) => path.resolve(item)))]
}

function singleRef(metadata: Record<string, unknown>, kind: StoreKind, legacyKey: string) {
  const ref = typeof metadata.ref === "string" ? metadata.ref : undefined
  const legacy = typeof metadata[legacyKey] === "string" ? metadata[legacyKey] : undefined
  const id = ref ? refID(ref, kind) : legacy
  if (!id) return undefined
  if (legacy && legacy !== id) return undefined
  return `${kind}:${id}`
}

function oracleRefs(metadata: Record<string, unknown>) {
  const values = Array.isArray(metadata.oracles)
    ? metadata.oracles
    : isRecord(metadata.oracle)
      ? [metadata.oracle]
      : []
  const refs = values.flatMap((value) =>
    isRecord(value) && typeof value.id === "string" && value.id ? [`oracle:${value.id}`] : [],
  )
  return refs.length === values.length ? refs : []
}

function envelope(tool: string, metadata: Record<string, unknown>): Envelope | undefined {
  if (isPersisted(metadata)) return metadata[KEY]
  const root = projectRoot(metadata)
  if (!root) return undefined
  const result = resultMetadata(metadata)
  if (AUDIT_TOOLS.has(tool)) {
    const ref = singleRef(metadata, "audit", "auditRunID")
    if (!ref) return undefined
    return { version: 1, kind: "audit", tool, projectRoot: root, refs: [ref], ...(result ? { result } : {}), metadataHash: metadataHash(metadata) }
  }
  if (PREDESIGN_TOOLS.has(tool)) {
    const ref = singleRef(metadata, "predesign", "runID")
    if (!ref) return undefined
    return { version: 1, kind: "predesign", tool, projectRoot: root, refs: [ref], ...(result ? { result } : {}), metadataHash: metadataHash(metadata) }
  }
  if (!ORACLE_TOOLS.has(tool)) return undefined
  const artifact = typeof metadata.artifact === "string" ? path.resolve(metadata.artifact) : undefined
  if (!artifact || !artifactPaths(root, "oracle-results.jsonl").includes(artifact)) return undefined
  const refs = oracleRefs(metadata)
  if (refs.length === 0) return undefined
  if (tool === "chimera_oracle_get" && refs.length !== 1) return undefined
  return { version: 1, kind: "oracle", tool, projectRoot: root, refs, artifact, ...(result ? { result } : {}), metadataHash: metadataHash(metadata) }
}

export function isPersisted(input: unknown): input is Persisted {
  if (!isRecord(input) || Object.keys(input).length !== 1 || !isRecord(input[KEY])) return false
  const value = input[KEY]
  if (value.version !== 1) return false
  const kind = value.kind
  if (kind !== "audit" && kind !== "predesign" && kind !== "oracle") return false
  if (typeof value.tool !== "string" || typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot)) return false
  if (!Array.isArray(value.refs) || value.refs.length === 0 || !value.refs.every((ref) => typeof ref === "string" && Boolean(refID(ref, kind)))) return false
  if (value.artifact !== undefined && typeof value.artifact !== "string") return false
  if (value.result !== undefined) {
    if (!isRecord(value.result) || Object.keys(value.result).some((key) => key !== "truncated" && key !== "outputPath")) return false
    if (value.result.truncated !== undefined && typeof value.result.truncated !== "boolean") return false
    if (value.result.outputPath !== undefined && typeof value.result.outputPath !== "string") return false
  }
  if (typeof value.metadataHash !== "string" || !/^[a-f0-9]{64}$/.test(value.metadataHash)) return false
  if (kind === "audit" && !AUDIT_TOOLS.has(value.tool)) return false
  if (kind === "predesign" && !PREDESIGN_TOOLS.has(value.tool)) return false
  if (kind === "oracle" && !ORACLE_TOOLS.has(value.tool)) return false
  return true
}

export function forPersistence(tool: string, metadata: Record<string, unknown>) {
  const value = envelope(tool, metadata)
  return value ? { [KEY]: value } satisfies Persisted : metadata
}

export async function recover(input: unknown): Promise<Recovery> {
  if (!isPersisted(input)) return { status: "not-envelope" }
  const value = input[KEY]
  const invalid = (reason: string): Recovery => ({ status: "invalid", reason, envelope: value })
  const ref = value.refs[0]
  const id = refID(ref, value.kind)
  if (!id) return invalid("invalid typed ref")

  let metadata: Record<string, unknown> | undefined
  if (value.kind === "audit") {
    const record = await readAuditRunReadonly(value.projectRoot, id)
    if (!record || !isRecord(record.payload)) return invalid("audit store record not found")
    metadata = { ...record.payload, auditRunID: record.id, ref }
  }
  if (value.kind === "predesign") {
    let record
    for (const artifact of artifactPaths(value.projectRoot, "predesign-runs.jsonl")) {
      record = await readPredesignRunReadonly(value.projectRoot, artifact, id)
      if (record) break
    }
    const payload = isRecord(record?.payload) ? record.payload : undefined
    const sessionMetadata = isRecord(payload?.sessionMetadata) ? payload.sessionMetadata : undefined
    if (!record || !sessionMetadata || !isRecord(sessionMetadata.snapshot) || !isRecord(sessionMetadata.coverage)) {
      return invalid("predesign store record lacks recoverable session metadata")
    }
    metadata = {
      projectRoot: value.projectRoot,
      snapshot: sessionMetadata.snapshot,
      runID: record.id,
      ref,
      intent: record.intent,
      files: record.files,
      seeds: record.seedNodes,
      impacted: record.impactedNodes,
      fileDependents: record.fileDependents,
      evidence: record.evidence,
      coverage: sessionMetadata.coverage,
    }
  }
  if (value.kind === "oracle") {
    const artifact = value.artifact ? path.resolve(value.artifact) : undefined
    if (!artifact || !artifactPaths(value.projectRoot, "oracle-results.jsonl").includes(artifact)) {
      return invalid("oracle artifact is outside the project graph data roots")
    }
    const oracles = await Promise.all(
      value.refs.map((item) => readOracleResultReadonly(value.projectRoot, artifact, refID(item, "oracle")!)),
    )
    if (oracles.some((oracle) => !oracle)) return invalid("oracle store record not found")
    const records = oracles.filter((oracle): oracle is NonNullable<typeof oracle> => Boolean(oracle))
    metadata = value.tool === "chimera_oracle_get"
      ? { projectRoot: value.projectRoot, artifact, action: "get", oracle: records[0], oracles: records }
      : { projectRoot: value.projectRoot, artifact, action: "recent", oracles: records }
  }
  if (!metadata) return invalid("unsupported metadata envelope")
  metadata = { ...metadata, ...(value.result ?? {}) }
  if (metadataHash(metadata) !== value.metadataHash) return invalid("recovered metadata hash mismatch")
  return { status: "recovered", envelope: value, metadata }
}

export * as SessionToolMetadata from "./session-tool-metadata"
