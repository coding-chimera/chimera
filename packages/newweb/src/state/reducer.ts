import type { Event, GlobalEvent, Part, PermissionRequest, QuestionRequest, Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"
import type { SetStoreFunction } from "solid-js/store"
import type { MessageRow, NewWebState } from "./store"

type NewWebEvent = Event | GlobalEvent["payload"]

function upsertByID<T extends { id: string }>(items: Array<T>, item: T) {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [item, ...items]
  return items.map((existing) => (existing.id === item.id ? item : existing))
}

function removeByID<T extends { id: string }>(items: Array<T>, id: string) {
  return items.filter((item) => item.id !== id)
}

function removeSessionMessages(items: Record<string, Array<MessageRow>>, sessionID: string) {
  return Object.fromEntries(Object.entries(items).filter(([id]) => id !== sessionID)) as Record<string, Array<MessageRow>>
}

function upsertMessage(rows: Array<MessageRow>, row: MessageRow) {
  const index = rows.findIndex((existing) => existing.info.id === row.info.id)
  if (index === -1) return [...rows, row]
  return rows.map((existing) => (existing.info.id === row.info.id ? { ...existing, info: row.info } : existing))
}

function upsertPart(rows: Array<MessageRow>, part: Part) {
  return rows.map((row) => {
    if (row.info.id !== part.messageID) return row
    const index = row.parts.findIndex((existing) => existing.id === part.id)
    if (index === -1) return { ...row, parts: [...row.parts, part] }
    return { ...row, parts: row.parts.map((existing) => (existing.id === part.id ? part : existing)) }
  })
}

function removePart(rows: Array<MessageRow>, messageID: string, partID: string) {
  return rows.map((row) => {
    if (row.info.id !== messageID) return row
    return { ...row, parts: row.parts.filter((part) => part.id !== partID) }
  })
}

function appendTextDelta(part: Part, delta: string) {
  if (part.type === "text") return { ...part, text: part.text + delta }
  if (part.type === "reasoning") return { ...part, text: part.text + delta }
  return part
}

function applyPartDelta(rows: Array<MessageRow>, messageID: string, partID: string, delta: string) {
  return rows.map((row) => {
    if (row.info.id !== messageID) return row
    return { ...row, parts: row.parts.map((part) => (part.id === partID ? appendTextDelta(part, delta) : part)) }
  })
}

function clearPermission(items: Array<PermissionRequest>, requestID: string) {
  return items.filter((item) => item.id !== requestID)
}

function clearQuestion(items: Array<QuestionRequest>, requestID: string) {
  return items.filter((item) => item.id !== requestID)
}

function applySyncEvent(setStore: SetStoreFunction<NewWebState>, event: Extract<GlobalEvent["payload"], { type: "sync" }>) {
  switch (event.name) {
    case "session.created.1":
      setStore("sessions", "list", (items) => upsertByID(items, event.data.info))
      return
    case "session.deleted.1":
      setStore("sessions", "list", (items) => removeByID(items, event.data.sessionID))
      setStore("messages", "bySessionID", (items) => removeSessionMessages(items, event.data.sessionID))
      return
    case "message.updated.1":
      setStore("messages", "bySessionID", event.data.sessionID, (rows = []) =>
        upsertMessage(rows, { info: event.data.info, parts: [] }),
      )
      return
    case "message.removed.1":
      setStore("messages", "bySessionID", event.data.sessionID, (rows = []) =>
        rows.filter((row) => row.info.id !== event.data.messageID),
      )
      return
    case "message.part.updated.1":
      setStore("messages", "bySessionID", event.data.sessionID, (rows = []) => upsertPart(rows, event.data.part))
      return
    case "message.part.removed.1":
      setStore("messages", "bySessionID", event.data.sessionID, (rows = []) =>
        removePart(rows, event.data.messageID, event.data.partID),
      )
      return
    default:
      return
  }
}

export function applyNewWebEvent(setStore: SetStoreFunction<NewWebState>, directory: string, event: NewWebEvent) {
  if (event.type === "sync") {
    applySyncEvent(setStore, event)
    return
  }

  switch (event.type) {
    case "session.created":
    case "session.updated":
      setStore("sessions", "list", (items) => upsertByID(items, event.properties.info as Session))
      return
    case "session.deleted":
      setStore("sessions", "list", (items) => removeByID(items, event.properties.sessionID))
      setStore("messages", "bySessionID", (items) => removeSessionMessages(items, event.properties.sessionID))
      return
    case "message.updated":
      setStore("messages", "bySessionID", event.properties.sessionID, (rows = []) =>
        upsertMessage(rows, { info: event.properties.info, parts: [] }),
      )
      return
    case "message.removed":
      setStore("messages", "bySessionID", event.properties.sessionID, (rows = []) =>
        rows.filter((row) => row.info.id !== event.properties.messageID),
      )
      return
    case "message.part.updated":
      setStore("messages", "bySessionID", event.properties.sessionID, (rows = []) => upsertPart(rows, event.properties.part))
      return
    case "message.part.removed":
      setStore("messages", "bySessionID", event.properties.sessionID, (rows = []) =>
        removePart(rows, event.properties.messageID, event.properties.partID),
      )
      return
    case "message.part.delta":
      setStore("messages", "bySessionID", event.properties.sessionID, (rows = []) =>
        applyPartDelta(rows, event.properties.messageID, event.properties.partID, event.properties.delta),
      )
      return
    case "session.status":
      setStore("sessions", "statusByID", event.properties.sessionID, event.properties.status)
      return
    case "session.diff":
      setStore("preview", "diffBySessionID", event.properties.sessionID, event.properties.diff as Array<SnapshotFileDiff>)
      return
    case "permission.asked":
      setStore("requests", "permissions", (items) => upsertByID(items, event.properties))
      return
    case "permission.replied":
      setStore("requests", "permissions", (items) => clearPermission(items, event.properties.requestID))
      return
    case "question.asked":
      setStore("requests", "questions", (items) => upsertByID(items, event.properties))
      return
    case "question.replied":
    case "question.rejected":
      setStore("requests", "questions", (items) => clearQuestion(items, event.properties.requestID))
      return
    case "todo.updated":
    case "work_brief.updated":
      return
    default:
      return
  }
}

export function eventDirectory(event: GlobalEvent | Event, fallback: string) {
  if ("payload" in event) return event.directory || fallback
  return fallback
}

export function eventPayload(event: GlobalEvent | Event): NewWebEvent {
  if ("payload" in event) return event.payload
  return event
}
