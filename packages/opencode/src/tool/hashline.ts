import { createHash } from "crypto"

const CID = "ZPMQVRWSNKTXJBYH"
export const DISPLAY_ALGORITHM = "omo-cid2"
export const SCHEMA_VERSION = 1
export const UNANCHORABLE_TOKEN = "--"

export type LineAnchor = {
  line: number
  id: string
}

export type LineInfo = LineAnchor & {
  content: string
  anchorable: boolean
}

export type TextSnapshot = {
  lines: string[]
  lineEnding: "\n" | "\r\n"
  finalNewline: boolean
}

export function normalizeLineEndings(text: string) {
  return text.replaceAll("\r\n", "\n")
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

export function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

export function splitText(text: string): TextSnapshot {
  const normalized = normalizeLineEndings(text)
  const finalNewline = normalized.endsWith("\n")
  const body = finalNewline ? normalized.slice(0, -1) : normalized
  return {
    lines: body === "" ? [] : body.split("\n"),
    lineEnding: detectLineEnding(text),
    finalNewline,
  }
}

export function joinText(snapshot: TextSnapshot, lines = snapshot.lines) {
  return convertToLineEnding(lines.join("\n") + (snapshot.finalNewline ? "\n" : ""), snapshot.lineEnding)
}

export function fileHash(text: string) {
  return createHash("sha256").update(normalizeLineEndings(text)).digest("hex")
}

export function lineHash(lineNumber: number, content: string) {
  const stripped = content.replace(/\s+/g, "")
  const seed = /[A-Za-z0-9]/.test(stripped) ? 0 : lineNumber
  const hash = Number(Bun.hash.xxHash32(stripped, seed)) & 0xff
  return `${CID[(hash >> 4) & 0xf]}${CID[hash & 0xf]}`
}

export function lineInfo(lineNumber: number, content: string, anchorable = true): LineInfo {
  return {
    line: lineNumber,
    id: anchorable ? lineHash(lineNumber, content) : UNANCHORABLE_TOKEN,
    content,
    anchorable,
  }
}

export function snapshotLines(lines: string[], offset = 1, unanchorable = new Set<number>()) {
  return lines.map((content, index) => lineInfo(offset + index, content, !unanchorable.has(offset + index)))
}

export function formatLine(info: LineInfo) {
  return `${info.line}#${info.id}|${info.content}`
}

export function formatLines(lines: string[], startLine = 1) {
  return snapshotLines(lines, startLine).map(formatLine)
}

export function parseAnchor(input: string | undefined, label = "anchor"): LineAnchor {
  if (!input) throw new Error(`Missing ${label}`)
  const match = input.trim().match(/^(?:[>+\-\s]*)?(\d+)\s*#\s*([A-Za-z0-9-]{2})(?:\|.*)?$/)
  if (!match) throw new Error(`Invalid Hashline ${label}: ${input}. Use LINE#ID from read output.`)
  return {
    line: Number(match[1]),
    id: match[2],
  }
}

export function stripHashlinePrefix(line: string) {
  return line.replace(/^(?:[>\s]*)?\d+\s*#\s*[A-Za-z0-9-]{2}\|/, "")
}

function stripDiffPrefix(line: string) {
  return line.startsWith("+") && !line.startsWith("+++") ? line.slice(1) : line
}

export function normalizeReplacement(input: string | ReadonlyArray<string> | null | undefined) {
  if (input === null || input === undefined) return [] as string[]
  const raw = typeof input === "string" ? normalizeLineEndings(input).split("\n") : [...input]
  const lines = raw.at(-1) === "" ? raw.slice(0, -1) : raw
  const nonEmpty = lines.filter((line) => line.trim())
  const hashlinePrefixed = nonEmpty.filter((line) => /^(?:[>\s]*)?\d+\s*#\s*[A-Za-z0-9-]{2}\|/.test(line)).length
  const diffPrefixed = nonEmpty.filter((line) => /^\+(?!\+\+)/.test(line)).length
  if (nonEmpty.length > 0 && hashlinePrefixed > nonEmpty.length / 2) return lines.map(stripHashlinePrefix)
  if (nonEmpty.length > 0 && diffPrefixed > nonEmpty.length / 2) return lines.map(stripDiffPrefix)
  return lines
}

export function changedRange(before: string[], after: string[]) {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++

  let beforeEnd = before.length - 1
  let afterEnd = after.length - 1
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--
    afterEnd--
  }

  if (start >= before.length && start >= after.length) return undefined
  return {
    beforeStart: start + 1,
    beforeEnd: Math.max(start + 1, beforeEnd + 1),
    afterStart: start + 1,
    afterEnd: Math.max(start + 1, afterEnd + 1),
  }
}

export function rangeIDs(lines: string[], startLine: number, endLine: number) {
  if (lines.length === 0 || endLine < startLine) return [] as string[]
  return lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}#${lineHash(startLine + index, line)}`)
}

export function formatChangedBlock(lines: string[], startLine: number, endLine: number, limit = 20) {
  if (lines.length === 0 || endLine < startLine) return "Changed lines after edit: none"
  const block = formatLines(lines.slice(startLine - 1, endLine), startLine)
  if (block.length <= limit) return ["Changed lines after edit:", ...block].join("\n")
  const head = Math.floor(limit / 2)
  const tail = limit - head
  return [
    `Changed lines after edit: ${block.length} lines, showing ${limit}. Use read with offset=${startLine} for full block.`,
    ...block.slice(0, head),
    `... (${block.length - limit} lines omitted)`,
    ...block.slice(block.length - tail),
  ].join("\n")
}

export function mismatchMessage(lines: string[], anchor: LineAnchor) {
  const start = Math.max(1, anchor.line - 2)
  const end = Math.min(lines.length, anchor.line + 2)
  const context = snapshotLines(lines.slice(start - 1, end), start).map((line) => `${line.line === anchor.line ? ">>> " : "    "}${formatLine(line)}`)
  return [
    `Hashline anchor mismatch for ${anchor.line}#${anchor.id}. Re-read the target range and retry with the current LINE#ID.`,
    "Current context:",
    ...context,
  ].join("\n")
}
