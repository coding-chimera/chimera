import { Schema } from "effect"
import { zod } from "@/util/effect-zod"

export type LegacyMemoryScope = "global" | "project"
export type LegacySourceKind = "explicit-user-directive" | "manual"

export type LegacyMemoryNote = {
  id: string
  text: string
  scope: LegacyMemoryScope
  source: {
    kind: LegacySourceKind
    sessionID?: string
    messageID?: string
  }
  time_created: number
}

export type LegacyNotesFile = {
  schemaVersion: 1
  notes: LegacyMemoryNote[]
}


export class LegacyNote extends Schema.Class<LegacyNote>("LegacyMemoryNote")({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.Union([Schema.Literal("global"), Schema.Literal("project")]),
  source: Schema.Struct({
    kind: Schema.Union([Schema.Literal("explicit-user-directive"), Schema.Literal("manual")]),
    sessionID: Schema.optional(Schema.String),
    messageID: Schema.optional(Schema.String),
  }),
  time_created: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export class LegacyFile extends Schema.Class<LegacyFile>("LegacyMemoryFileV1")({
  schemaVersion: Schema.Literal(1),
  notes: Schema.Array(LegacyNote),
}) {
  static readonly zod = zod(this)
}

export type LegacyImportNote = {
  id: string
  text: string
  scope: LegacyMemoryScope
  sourceKind: LegacySourceKind
  sourceSessionID?: string
  sourceMessageID?: string
  createdAt: number
}

export type LegacyImportDecode = {
  schemaVersion: 1
  notes: LegacyImportNote[]
  skipped: number
}

function optionalString(input: object, key: string) {
  const value = Reflect.get(input, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseNote(input: unknown): LegacyMemoryNote | undefined {
  if (!input || typeof input !== "object") return undefined
  if (!("id" in input) || typeof input.id !== "string" || input.id.length === 0) return undefined
  if (!("text" in input) || typeof input.text !== "string" || input.text.trim().length === 0) return undefined
  if (!("scope" in input) || (input.scope !== "global" && input.scope !== "project")) return undefined
  if (!("source" in input) || !input.source || typeof input.source !== "object") return undefined
  if (!("kind" in input.source) || (input.source.kind !== "explicit-user-directive" && input.source.kind !== "manual")) return undefined
  if (!("time_created" in input) || typeof input.time_created !== "number" || !Number.isFinite(input.time_created)) return undefined
  return {
    id: input.id,
    text: input.text,
    scope: input.scope,
    source: {
      kind: input.source.kind,
      ...(optionalString(input.source, "sessionID") ? { sessionID: optionalString(input.source, "sessionID") } : {}),
      ...(optionalString(input.source, "messageID") ? { messageID: optionalString(input.source, "messageID") } : {}),
    },
    time_created: input.time_created,
  }
}

export function parseLegacyNotes(input: unknown): LegacyNotesFile | undefined {
  if (!input || typeof input !== "object") return undefined
  if (!("schemaVersion" in input) || input.schemaVersion !== 1) return undefined
  if (!("notes" in input) || !Array.isArray(input.notes)) return undefined
  return {
    schemaVersion: 1,
    notes: input.notes.flatMap((note) => {
      const parsed = parseNote(note)
      return parsed ? [parsed] : []
    }),
  }
}

function decodeLegacyValue(input: string | Uint8Array) {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input)
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function decodeLegacyNotes(input: string | Uint8Array) {
  return parseLegacyNotes(decodeLegacyValue(input))
}

export function decodeLegacyImport(input: unknown): LegacyImportDecode | undefined {
  const source = typeof input === "string" || input instanceof Uint8Array ? decodeLegacyValue(input) : input
  const parsed = parseLegacyNotes(source)
  if (!parsed) return undefined
  const total = typeof source === "object" && source && "notes" in source && Array.isArray(source.notes) ? source.notes.length : 0
  return {
    schemaVersion: 1,
    notes: parsed.notes.map((note) => ({
      id: note.id,
      text: note.text,
      scope: note.scope,
      sourceKind: note.source.kind,
      ...(note.source.sessionID ? { sourceSessionID: note.source.sessionID } : {}),
      ...(note.source.messageID ? { sourceMessageID: note.source.messageID } : {}),
      createdAt: note.time_created,
    })),
    skipped: total - parsed.notes.length,
  }
}

export async function readLegacyNotes(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  return decodeLegacyNotes(await file.bytes())
}

export const parseNotes = parseLegacyNotes
export const decodeImport = decodeLegacyImport

export * as MemoryLegacy from "./legacy"
