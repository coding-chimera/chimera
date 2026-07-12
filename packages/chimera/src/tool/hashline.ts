import { createHash } from "crypto"

const CID = "ZPMQVRWSNKTXJBYH"
export const DISPLAY_ALGORITHM = "omo-cid2"
export const SCHEMA_VERSION = 1
export const UNANCHORABLE_TOKEN = "--"
const SIGNIFICANT_CONTENT = /[\p{L}\p{N}]/u

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

function hashID(lineNumber: number, normalized: string) {
  const seed = SIGNIFICANT_CONTENT.test(normalized) ? 0 : lineNumber
  const hash = Number(Bun.hash.xxHash32(normalized, seed)) & 0xff
  return `${CID[(hash >> 4) & 0xf]}${CID[hash & 0xf]}`
}

export function lineHash(lineNumber: number, content: string) {
  return hashID(lineNumber, content.replace(/\r/g, "").trimEnd())
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

function equalsIgnoringWhitespace(a: string, b: string) {
  if (a === b) return true
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "")
}

function leadingWhitespace(line: string) {
  return line.match(/^\s*/)?.[0] ?? ""
}

function restoreLeadingIndent(template: string, line: string) {
  if (line.length === 0) return line
  const templateIndent = leadingWhitespace(template)
  if (templateIndent.length === 0) return line
  if (leadingWhitespace(line).length > 0) return line
  if (template.trim() === line.trim()) return line
  return templateIndent + line
}

function stripAllWhitespace(text: string) {
  return text.replace(/\s+/g, "")
}

function stripRangeBoundaryEcho(fileLines: string[], startLine: number, endLine: number, replacement: string[]) {
  const replacedCount = endLine - startLine + 1
  if (replacement.length <= 1 || replacement.length <= replacedCount) return replacement

  const beforeIndex = startLine - 2
  const withoutBefore =
    beforeIndex >= 0 && replacement[0] === fileLines[beforeIndex] ? replacement.slice(1) : replacement

  const afterIndex = endLine
  if (afterIndex < fileLines.length && withoutBefore.at(-1) === fileLines[afterIndex]) {
    return withoutBefore.slice(0, -1)
  }
  return withoutBefore
}

function restoreOldWrappedLines(oldLines: string[], replacement: string[]) {
  if (oldLines.length === 0 || replacement.length < 2) return replacement

  const canonicalToOld = new Map<string, { line: string; count: number }>()
  for (const line of oldLines) {
    const canonical = stripAllWhitespace(line)
    const hit = canonicalToOld.get(canonical)
    if (hit) {
      hit.count++
      continue
    }
    canonicalToOld.set(canonical, { line, count: 1 })
  }

  const candidates = replacement.flatMap((_, start) =>
    Array.from({ length: Math.min(10, replacement.length - start) - 1 }, (_, index) => index + 2).flatMap((length) => {
      const span = replacement.slice(start, start + length)
      if (span.some((line) => line.trim().length === 0)) return []
      const canonical = stripAllWhitespace(span.join(""))
      const old = canonicalToOld.get(canonical)
      if (!old || old.count !== 1 || canonical.length < 6) return []
      return [{ start, length, replacement: old.line, canonical }]
    }),
  )
  if (candidates.length === 0) return replacement

  const canonicalCounts = new Map<string, number>()
  for (const candidate of candidates) canonicalCounts.set(candidate.canonical, (canonicalCounts.get(candidate.canonical) ?? 0) + 1)

  const unique = candidates.filter((candidate) => canonicalCounts.get(candidate.canonical) === 1).toSorted((a, b) => b.start - a.start)
  if (unique.length === 0) return replacement

  const next = [...replacement]
  for (const candidate of unique) next.splice(candidate.start, candidate.length, candidate.replacement)
  return next
}

function restoreIndentForPairedReplacement(oldLines: string[], replacement: string[]) {
  if (oldLines.length !== replacement.length) return replacement
  return replacement.map((line, index) => restoreLeadingIndent(oldLines[index], line))
}

function matchesOldLinesIgnoringWhitespace(oldLines: string[], replacement: string[]) {
  return oldLines.length === replacement.length && oldLines.every((line, index) => equalsIgnoringWhitespace(line, replacement[index]))
}

function stripTrailingContinuationTokens(text: string) {
  return text.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "")
}

function stripMergeOperatorChars(text: string) {
  return text.replace(/[|&?]/g, "")
}

function maybeExpandSingleLineMerge(oldLines: string[], replacement: string[]) {
  if (replacement.length !== 1 || oldLines.length <= 1) return replacement

  const merged = replacement[0]
  const parts = oldLines.map((line) => line.trim()).filter((line) => line.length > 0)
  if (parts.length !== oldLines.length) return replacement

  const indices: number[] = []
  let offset = 0
  let orderedMatch = true
  for (const part of parts) {
    let index = merged.indexOf(part, offset)
    let matchedLength = part.length
    if (index === -1) {
      const stripped = stripTrailingContinuationTokens(part)
      if (stripped !== part) {
        index = merged.indexOf(stripped, offset)
        if (index !== -1) matchedLength = stripped.length
      }
    }
    if (index === -1) {
      const segment = merged.slice(offset)
      const segmentStripped = stripMergeOperatorChars(segment)
      const partStripped = stripMergeOperatorChars(part)
      const fuzzyIndex = segmentStripped.indexOf(partStripped)
      if (fuzzyIndex !== -1) {
        let strippedPosition = 0
        let originalPosition = 0
        while (strippedPosition < fuzzyIndex && originalPosition < segment.length) {
          if (!/[|&?]/.test(segment[originalPosition])) strippedPosition++
          originalPosition++
        }
        index = offset + originalPosition
        matchedLength = part.length
      }
    }
    if (index === -1) {
      orderedMatch = false
      break
    }
    indices.push(index)
    offset = index + matchedLength
  }

  const expanded = orderedMatch
    ? indices.map((start, index) => merged.slice(start, index + 1 < indices.length ? indices[index + 1] : merged.length).trim())
    : []
  if (expanded.length === oldLines.length && expanded.every((line) => line.length > 0)) {
    if (matchesOldLinesIgnoringWhitespace(oldLines, expanded)) return replacement
    return expanded
  }

  const semicolonSplit = merged
    .split(/;\s+/)
    .map((line, index, lines) => (index < lines.length - 1 && !line.endsWith(";") ? `${line};` : line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (semicolonSplit.length === oldLines.length) {
    if (matchesOldLinesIgnoringWhitespace(oldLines, semicolonSplit)) return replacement
    return semicolonSplit
  }

  return replacement
}

export function normalizeReplacement(input: string | ReadonlyArray<string> | null | undefined) {
  if (input === null || input === undefined) return [] as string[]
  const raw = typeof input === "string" ? normalizeLineEndings(input).split("\n") : [...input]
  const lines = typeof input === "string" && raw.at(-1) === "" ? raw.slice(0, -1) : raw
  const nonEmpty = lines.filter((line) => line.trim())
  const hashlinePrefixed = nonEmpty.filter((line) => /^(?:[>\s]*)?\d+\s*#\s*[A-Za-z0-9-]{2}\|/.test(line)).length
  const diffPrefixed = nonEmpty.filter((line) => /^\+(?!\+\+)/.test(line)).length
  if (nonEmpty.length > 0 && hashlinePrefixed >= nonEmpty.length / 2) return lines.map(stripHashlinePrefix)
  if (nonEmpty.length > 0 && diffPrefixed >= nonEmpty.length / 2) return lines.map(stripDiffPrefix)
  return lines
}

export function normalizeReplaceLines(fileLines: string[], startLine: number, endLine: number, replacement: string[]) {
  const oldLines = fileLines.slice(startLine - 1, endLine)
  return restoreIndentForPairedReplacement(
    oldLines,
    restoreOldWrappedLines(oldLines, maybeExpandSingleLineMerge(oldLines, stripRangeBoundaryEcho(fileLines, startLine, endLine, replacement))),
  )
}

export function normalizeInsertLines(fileLines: string[], anchorLine: number, op: "append" | "prepend", replacement: string[]) {
  if (replacement.length === 0) return replacement
  if (op === "append" && equalsIgnoringWhitespace(replacement[0], fileLines[anchorLine - 1] ?? "")) return replacement.slice(1)
  if (op === "prepend" && replacement.length > 1 && equalsIgnoringWhitespace(replacement.at(-1) ?? "", fileLines[anchorLine - 1] ?? "")) {
    return replacement.slice(0, -1)
  }
  return replacement
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
