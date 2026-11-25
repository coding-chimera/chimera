import { createRequire } from "module"
import path from "path"

export interface ContractInfo {
  abiMajor: number
  abiMinor: number
  capabilities: string[]
}

export interface SpoolOptions {
  filePath: string
  maxLines: number
  maxBytes: number
  direction: "head" | "tail"
}

export interface SpoolFinish {
  content: string
  truncated: boolean
  outputPath?: string
  removed: number
  unit: "bytes" | "lines"
  totalBytes: number
  totalLines: number
}

export interface HistoryMessageInput {
  id: string
  timeCreated: number
  timeUpdated: number
  data: string
  eventId?: string
  eventData?: string
}

export interface HistoryPartInput {
  id: string
  messageId: string
  timeCreated: number
  timeUpdated: number
  data: string
  eventId?: string
  eventData?: string
}
export interface HistoryView {
  historyHash: string
  json: string
}

export interface CompactionView extends HistoryView {
  hasRemoteCompaction: boolean
}

export interface RemoveMessageInput {
  messageId: string
  timeUpdated: number
  eventId?: string
  eventData?: string
}

export interface RemovePartInput {
  partId: string
  messageId: string
  timeUpdated: number
  eventId?: string
  eventData?: string
}

export interface HistoryCounts {
  messages: number
  parts: number
}

export interface HistoryDriver {
  historyNew(sessionID: string): number
  historyRebuild(sessionID: string, dbPath: string): Promise<number>
  historyUpsertMessage(id: number, input: HistoryMessageInput): boolean
  historyUpsertPart(id: number, input: HistoryPartInput): boolean
  historyRemoveMessage(id: number, messageID: string): boolean
  historyRemovePart(id: number, partID: string): boolean
  historyHash(id: number): string
  historyCounts(id: number): HistoryCounts
  historyView(id: number, expectedHistoryHash?: string): HistoryView
  historyCompactionView(id: number, mode: "local" | "text", expectedHistoryHash?: string): CompactionView
  historyDrop(id: number): boolean
}

export interface SpoolDriver {
  contractInfo(): ContractInfo
  spoolStart(options: SpoolOptions): number
  spoolAppend(id: number, chunk: Uint8Array): Promise<void>
  spoolFinish(id: number): Promise<SpoolFinish>
  spoolAbort(id: number): void
}

export interface WriterOptions {
  dbPath: string
  sessionId: string
  expectedHistoryHash?: string
  eventV2: boolean
  workspaces: boolean
  failAfterCommit?: boolean
}

export interface SessionMetadataInput {
  data: string
  timeUpdated: number
  eventId?: string
  eventData?: string
}

export interface ToolResultInput {
  partId: string
  messageId: string
  timeCreated: number
  timeUpdated: number
  partData: string
  partEventId?: string
  partEventData?: string
  v2EventId?: string
  v2EventData?: string
  success: boolean
}

export interface WriterResult {
  status: "committed" | "already_committed" | "revision_conflict"
  changed: boolean
  historyHash?: string
  aggregateSeq?: number
}

export interface WriterDriver {
  writerNew(options: WriterOptions): number
  writerHistoryHash(id: number): Promise<string>
  writerUpsertMessage(id: number, input: HistoryMessageInput): Promise<WriterResult>
  writerUpsertPart(id: number, input: HistoryPartInput): Promise<WriterResult>
  writerRemoveMessage(id: number, input: RemoveMessageInput): Promise<WriterResult>
  writerRemovePart(id: number, input: RemovePartInput): Promise<WriterResult>
  writerProbeMessage(id: number, input: HistoryMessageInput): Promise<WriterResult>
  writerProbePart(id: number, input: HistoryPartInput): Promise<WriterResult>
  writerProbeRemoveMessage(id: number, input: RemoveMessageInput): Promise<WriterResult>
  writerProbeRemovePart(id: number, input: RemovePartInput): Promise<WriterResult>
  writerCommitToolResult(id: number, input: ToolResultInput): Promise<WriterResult>
  writerCreateSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerPatchSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerDeleteSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerProbeCreateSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerProbePatchSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerProbeDeleteSession(id: number, input: SessionMetadataInput): Promise<WriterResult>
  writerDrop(id: number): boolean
}

type NativeDriver = SpoolDriver & Partial<HistoryDriver & WriterDriver>

let spoolDriver: SpoolDriver | null | undefined
let historyDriver: HistoryDriver | null | undefined
let writerDriver: WriterDriver | null | undefined
let writerTestDouble = false

function artifacts(directory: string) {
  const library = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"
  return [
    path.join(directory, "prebuilds", `${process.platform}-${process.arch}`, "chimera-session-data.node"),
    path.join(directory, "target", "debug", `libchimera_session_data.${library}`),
    path.join(directory, "target", "release", `libchimera_session_data.${library}`),
  ]
}

function candidates() {
  return [
    path.join(path.dirname(process.execPath), "session-data", "chimera-session-data.node"),
    ...artifacts(path.join(process.cwd(), "chimera-session-data")),
    ...artifacts(path.join(process.cwd(), "..", "..", "chimera-session-data")),
  ]
}

function load(): NativeDriver | null {
  if (process.env.CHIMERA_SESSION_DATA_PLANE === "0") return null
  const require = createRequire(import.meta.url)
  const explicit = process.env.CHIMERA_SESSION_DATA_PLANE_PATH
  for (const candidate of explicit ? [explicit] : candidates()) {
    try {
      const loaded = require(candidate) as NativeDriver
      const contract = loaded.contractInfo()
      if (contract.abiMajor !== 1) continue
      return loaded
    } catch {
      // Native acceleration is optional. Never build or write during discovery.
    }
  }
  return null
}

export function getSpoolDriver() {
  if (spoolDriver === undefined) {
    const loaded = load()
    spoolDriver = loaded?.contractInfo().capabilities.includes("tool-output.spool.v1") ? loaded : null
  }
  return spoolDriver
}

export function setSpoolDriverForTests(value: SpoolDriver | null | undefined) {
  spoolDriver = value
}

export function getHistoryDriver() {
  if (historyDriver === undefined) {
    const loaded = load()
    historyDriver = loaded && "historyNew" in loaded ? (loaded as HistoryDriver) : null
  }
  return historyDriver
}

export function setHistoryDriverForTests(value: HistoryDriver | null | undefined) {
  historyDriver = value
}

export function getWriterDriver() {
  if (writerDriver === undefined) {
    const loaded = load()
    const methods = [
      "writerNew",
      "writerUpsertMessage",
      "writerUpsertPart",
      "writerRemoveMessage",
      "writerRemovePart",
      "writerProbeMessage",
      "writerProbePart",
      "writerProbeRemoveMessage",
      "writerProbeRemovePart",
      "writerDrop",
    ] as const
    writerDriver =
      loaded && methods.every((method) => typeof loaded[method] === "function") ? (loaded as WriterDriver) : null
  }
  return writerDriver
}

export function setWriterDriverForTests(value: WriterDriver | null | undefined) {
  writerTestDouble = value !== undefined
  writerDriver = value
}

export function isWriterDriverTestDouble() {
  return writerTestDouble
}

type HistoryEntry = {
  driver: HistoryDriver
  handle?: number
  rebuilding?: Promise<number>
}

const histories = new Map<string, HistoryEntry>()
const blockedHistories = new Set<string>()
const blockedWriters = new Set<string>()

function historyKey(dbPath: string, sessionID: string) {
  return `${dbPath}\0${sessionID}`
}

function dropHistory(key: string) {
  const entry = histories.get(key)
  histories.delete(key)
  if (entry?.handle !== undefined) entry.driver.historyDrop(entry.handle)
}

async function historyHandle(dbPath: string, sessionID: string) {
  const key = historyKey(dbPath, sessionID)
  if (blockedHistories.has(key)) return
  const driver = getHistoryDriver()
  if (!driver) return
  let entry = histories.get(key)
  if (!entry) {
    entry = { driver }
    histories.set(key, entry)
  }
  if (entry.handle !== undefined) return entry.handle
  entry.rebuilding ??= driver.historyRebuild(sessionID, dbPath).then((handle) => {
    if (histories.get(key) !== entry) {
      driver.historyDrop(handle)
      throw new Error("history invalidated during rebuild")
    }
    entry.handle = handle
    return handle
  })
  try {
    return await entry.rebuilding
  } catch {
    if (histories.get(key) === entry) dropHistory(key)
    return
  }
}

function currentHistory(key: string, handle: number) {
  const entry = histories.get(key)
  return entry?.handle === handle ? entry : undefined
}

function checkHistory(key: string, driver: HistoryDriver, handle: number, expected?: string) {
  if (!expected || driver.historyHash(handle) === expected) return true
  dropHistory(key)
  return false
}

export async function recordNativeMessage(
  dbPath: string,
  sessionID: string,
  input: HistoryMessageInput,
  expectedHistoryHash?: string,
) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return false
  const entry = currentHistory(key, handle)
  if (!entry) return false
  try {
    entry.driver.historyUpsertMessage(handle, input)
    return checkHistory(key, entry.driver, handle, expectedHistoryHash)
  } catch {
    dropHistory(key)
    return false
  }
}

export async function recordNativePart(
  dbPath: string,
  sessionID: string,
  input: HistoryPartInput,
  expectedHistoryHash?: string,
) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return false
  const entry = currentHistory(key, handle)
  if (!entry) return false
  try {
    entry.driver.historyUpsertPart(handle, input)
    return checkHistory(key, entry.driver, handle, expectedHistoryHash)
  } catch {
    dropHistory(key)
    return false
  }
}

export async function recordNativeRemoveMessage(
  dbPath: string,
  sessionID: string,
  messageID: string,
  expected?: string,
) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return false
  const entry = currentHistory(key, handle)
  if (!entry) return false
  try {
    entry.driver.historyRemoveMessage(handle, messageID)
    return checkHistory(key, entry.driver, handle, expected)
  } catch {
    dropHistory(key)
    return false
  }
}

export async function recordNativeRemovePart(dbPath: string, sessionID: string, partID: string, expected?: string) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return false
  const entry = currentHistory(key, handle)
  if (!entry) return false
  try {
    entry.driver.historyRemovePart(handle, partID)
    return checkHistory(key, entry.driver, handle, expected)
  } catch {
    dropHistory(key)
    return false
  }
}

export async function readNativeHistory(dbPath: string, sessionID: string, expectedHistoryHash?: string) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return
  const entry = currentHistory(key, handle)
  if (!entry || typeof entry.driver.historyView !== "function") {
    dropHistory(key)
    return
  }
  try {
    return entry.driver.historyView(handle, expectedHistoryHash)
  } catch {
    dropHistory(key)
    return
  }
}

export async function readNativeCompaction(
  dbPath: string,
  sessionID: string,
  mode: "local" | "text",
  expectedHistoryHash?: string,
) {
  const key = historyKey(dbPath, sessionID)
  const handle = await historyHandle(dbPath, sessionID)
  if (handle === undefined) return
  const entry = currentHistory(key, handle)
  if (!entry || typeof entry.driver.historyCompactionView !== "function") {
    dropHistory(key)
    return
  }
  try {
    return entry.driver.historyCompactionView(handle, mode, expectedHistoryHash)
  } catch {
    dropHistory(key)
    return
  }
}

export function disableNativeWriter(dbPath: string, sessionID: string) {
  blockedWriters.add(historyKey(dbPath, sessionID))
  disableNativeHistory(dbPath, sessionID)
}

export function isNativeWriterDisabled(dbPath: string, sessionID: string) {
  return blockedWriters.has(historyKey(dbPath, sessionID))
}

export function disableNativeHistory(dbPath: string, sessionID: string) {
  const key = historyKey(dbPath, sessionID)
  blockedHistories.add(key)
  dropHistory(key)
}

export function invalidateNativeHistory(dbPath: string, sessionID: string) {
  dropHistory(historyKey(dbPath, sessionID))
}

export function resetNativeHistoriesForTests() {
for (const key of [...histories.keys()]) dropHistory(key)
  blockedHistories.clear()
  blockedWriters.clear()
}

export async function spoolChunks(
  driver: SpoolDriver,
  options: SpoolOptions,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
) {
  const id = driver.spoolStart(options)
  try {
    for await (const chunk of chunks) await driver.spoolAppend(id, chunk)
    return await driver.spoolFinish(id)
  } catch (error) {
    driver.spoolAbort(id)
    throw error
  }
}

export function stringChunks(text: string, chunkBytes = 64 * 1024): Iterable<Uint8Array> {
  const bytes = Buffer.from(text, "utf-8")
  return {
    *[Symbol.iterator]() {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))
      }
    },
  }
}

export * as SessionDataPlane from "./data-plane"
