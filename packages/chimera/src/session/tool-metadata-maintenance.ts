import { Database as BunDatabase } from "bun:sqlite"
import { SessionToolMetadata } from "@/chimera/session-tool-metadata"
import { isRecord } from "@/util/record"

export type Input = {
  dbPath: string
  apply?: boolean
  sessionID?: string
}

export type Rejection = {
  surface: "part" | "event"
  id: string
  reason: string
}

export type Result = {
  dbPath: string
  sessionID?: string
  dryRun: boolean
  scannedParts: number
  scannedEvents: number
  candidates: number
  validated: number
  rejected: number
  rewrittenParts: number
  rewrittenEvents: number
  bytesBefore: number
  bytesAfter: number
  bytesSaved: number
  rejections: Rejection[]
}

type Row = {
  id: string
  data: string
}

type EventRow = Row & {
  aggregate_id: string
  type: string
}

type Change = {
  surface: "part" | "event"
  id: string
  previous: string
  next: string
}

function record(input: string) {
  try {
    const value = JSON.parse(input)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function tableExists(db: BunDatabase, table: string) {
  return Boolean(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function bytes(input: string) {
  return Buffer.byteLength(input)
}

export async function run(input: Input): Promise<Result> {
  const apply = input.apply === true
  const db = apply ? new BunDatabase(input.dbPath) : new BunDatabase(input.dbPath, { readonly: true })
  const changes: Change[] = []
  const rejections: Rejection[] = []
  let scannedParts = 0
  let scannedEvents = 0
  let candidates = 0

  const reject = (surface: Change["surface"], id: string, reason: string) => {
    candidates++
    rejections.push({ surface, id, reason })
  }

  const add = async (
    surface: Change["surface"],
    id: string,
    tool: string,
    metadata: Record<string, unknown>,
    previous: string,
    nextData: (metadata: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    if (SessionToolMetadata.isPersisted(metadata)) return
    const compacted = SessionToolMetadata.forPersistence(tool, metadata)
    if (!SessionToolMetadata.isPersisted(compacted)) return
    candidates++
    const recovered = await SessionToolMetadata.recover(compacted)
    if (recovered.status !== "recovered") {
      rejections.push({ surface, id, reason: recovered.status === "invalid" ? recovered.reason : "metadata did not produce an envelope" })
      return
    }
    changes.push({ surface, id, previous, next: JSON.stringify(nextData(compacted)) })
  }

  try {
    if (tableExists(db, "part")) {
      const where = [
        "json_valid(data)",
        "json_extract(data, '$.type') = 'tool'",
        "json_extract(data, '$.state.status') = 'completed'",
        ...(input.sessionID ? ["session_id = ?"] : []),
      ].join(" AND ")
      const rows = db.query(`SELECT id, data FROM part WHERE ${where} ORDER BY id`).all(...(input.sessionID ? [input.sessionID] : [])) as Row[]
      scannedParts = rows.length
      for (const row of rows) {
        const data = record(row.data)
        const state = isRecord(data?.state) ? data.state : undefined
        const metadata = isRecord(state?.metadata) ? state.metadata : undefined
        if (!data || !state) {
          reject("part", row.id, "completed tool part data is malformed")
          continue
        }
        if (typeof data.tool !== "string" || !data.tool) {
          reject("part", row.id, "completed tool part lacks a tool name")
          continue
        }
        if (!metadata) {
          reject("part", row.id, "completed tool part lacks structured metadata")
          continue
        }
        await add("part", row.id, data.tool, metadata, row.data, (next) => ({ ...data, state: { ...state, metadata: next } }))
      }
    }

    if (tableExists(db, "event")) {
      const where = [
        "type IN ('session.next.tool.called', 'session.next.tool.success')",
        ...(input.sessionID ? ["aggregate_id = ?"] : []),
      ].join(" AND ")
      const rows = db.query(`SELECT id, aggregate_id, type, data FROM event WHERE ${where} ORDER BY aggregate_id, seq, id`).all(...(input.sessionID ? [input.sessionID] : [])) as EventRow[]
      scannedEvents = rows.filter((row) => row.type === "session.next.tool.success").length
      const tools = new Map<string, string>()
      for (const row of rows) {
        const data = record(row.data)
        const callID = typeof data?.callID === "string" && data.callID ? data.callID : undefined
        if (row.type === "session.next.tool.called") {
          if (callID && typeof data?.tool === "string" && data.tool) tools.set(`${row.aggregate_id}\0${callID}`, data.tool)
          continue
        }
        if (!data) {
          reject("event", row.id, "tool success event data is malformed")
          continue
        }
        if (!callID) {
          reject("event", row.id, "tool success event lacks a call ID")
          continue
        }
        const metadata = isRecord(data.structured) ? data.structured : undefined
        if (!metadata) {
          reject("event", row.id, "tool success event lacks structured metadata")
          continue
        }
        if (SessionToolMetadata.isPersisted(metadata)) continue
        const tool = tools.get(`${row.aggregate_id}\0${callID}`)
        if (!tool) {
          reject("event", row.id, "tool success event lacks called-event tool context")
          continue
        }
        await add("event", row.id, tool, metadata, row.data, (next) => ({ ...data, structured: next }))
      }
    }

    if (apply && rejections.length > 0) {
      throw new Error(`tool metadata maintenance rejected ${rejections.length} candidate${rejections.length === 1 ? "" : "s"}; no rows were rewritten`)
    }

    if (apply && changes.length > 0) {
      const updatePart = db.query("UPDATE part SET data = ? WHERE id = ? AND data = ?")
      const updateEvent = db.query("UPDATE event SET data = ? WHERE id = ? AND data = ?")
      db.transaction(() => {
        for (const change of changes) {
          const updated = (change.surface === "part" ? updatePart : updateEvent).run(change.next, change.id, change.previous)
          if (updated.changes !== 1) throw new Error(`metadata row changed during maintenance: ${change.surface}:${change.id}`)
        }
      })()
    }
  } finally {
    db.close()
  }

  const bytesBefore = changes.reduce((total, change) => total + bytes(change.previous), 0)
  const bytesAfter = changes.reduce((total, change) => total + bytes(change.next), 0)
  return {
    dbPath: input.dbPath,
    sessionID: input.sessionID,
    dryRun: !apply,
    scannedParts,
    scannedEvents,
    candidates,
    validated: changes.length,
    rejected: rejections.length,
    rewrittenParts: apply ? changes.filter((change) => change.surface === "part").length : 0,
    rewrittenEvents: apply ? changes.filter((change) => change.surface === "event").length : 0,
    bytesBefore,
    bytesAfter,
    bytesSaved: bytesBefore - bytesAfter,
    rejections: rejections.slice(0, 100),
  }
}

export * as ToolMetadataMaintenance from "./tool-metadata-maintenance"
