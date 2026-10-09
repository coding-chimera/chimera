// Live streaming tool-call preview.
//
// While the model streams tool-call arguments, the processor forwards the raw
// JSON fragments over `message.part.delta` with field "raw", and — for the
// `edit` / `apply_patch` tools only — one `field: "hunk"` delta per COMPLETED
// edit op or patch hunk, carrying a JSON.stringify'd StreamingHunk below.
// Both channels are live-only: nothing here is persisted into the tool part
// state. The completed/failed state written at completeToolCall remains the
// replayable boundary (and v2 `Tool.Input.Ended` stays the replayable raw
// boundary; the v2 projector for `Tool.Input.Delta` is a no-op by design).
//
// Failure isolation: every entry point swallows all causes and returns no
// hunks, and the snapshot read is bounded by a timeout. Any degradation
// silently falls back to raw-only so the preview path can never break or
// delay the tool-call path.

import * as path from "path"
import { Effect, Option } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import { lineHash, normalizeReplacement, parseAnchor, splitText, type LineAnchor } from "@/tool/hashline"

export type StreamingHunk = {
  index: number
  op: "replace" | "append" | "prepend" | "patch"
  filePath?: string
  pos?: string
  end?: string
  before: string
  after: string
}

type RawEditOp = {
  op?: string
  pos?: string
  end?: string
  lines?: string | string[] | null
}

export type Tracker = {
  tool: "edit" | "apply_patch"
  cwd: string
  parsedLength: number
  emitted: number
  filePath?: string
  snapshot: string[]
  snapshotRead: boolean
}

const PARSE_MIN_GROWTH = 256
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
const SNAPSHOT_TIMEOUT = "500 millis"

export function create(toolName: string, cwd: string): Tracker | undefined {
  if (toolName !== "edit" && toolName !== "apply_patch") return undefined
  return {
    tool: toolName,
    cwd,
    parsedLength: 0,
    emitted: 0,
    filePath: undefined,
    snapshot: [],
    snapshotRead: false,
  }
}

// ---------------------------------------------------------------------------
// Tolerant partial-JSON extraction. Cursor-based, never throws: values that
// are still streaming simply report closed=false and the extractor stops at
// that tail position, keeping everything that fully closed before it.
// ---------------------------------------------------------------------------

type Cursor = { source: string; index: number }

function isWhitespace(ch: string) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

function skipWs(c: Cursor) {
  while (isWhitespace(c.source.charAt(c.index))) c.index++
}

function readString(c: Cursor): { value: string; closed: boolean } {
  c.index++ // opening quote
  let out = ""
  while (c.index < c.source.length) {
    const ch = c.source.charAt(c.index)
    if (ch === '"') {
      c.index++
      return { value: out, closed: true }
    }
    if (ch !== "\\") {
      out += ch
      c.index++
      continue
    }
    c.index++
    const esc = c.source.charAt(c.index)
    if (esc === "u") {
      const hex = c.source.slice(c.index + 1, c.index + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, closed: false }
      out += String.fromCharCode(parseInt(hex, 16))
      c.index += 5
      continue
    }
    c.index++
    if (esc === "n") out += "\n"
    else if (esc === "t") out += "\t"
    else if (esc === "r") out += "\r"
    else if (esc === "b") out += "\b"
    else if (esc === "f") out += "\f"
    else if (esc === '"' || esc === "\\" || esc === "/") out += esc
    else return { value: out, closed: false }
  }
  return { value: out, closed: false }
}

function isDelimiter(ch: string) {
  return ch === "" || ch === "," || ch === "}" || ch === "]" || ch === ":" || isWhitespace(ch)
}

function isClosedPrimitive(token: string) {
  return token === "true" || token === "false" || token === "null" || (token.length > 0 && Number.isFinite(Number(token)))
}

function skipValue(c: Cursor): boolean {
  skipWs(c)
  const ch = c.source.charAt(c.index)
  if (ch === '"') return readString(c).closed
  if (ch === "{" || ch === "[") {
    const stack: string[] = [ch === "{" ? "}" : "]"]
    c.index++
    let inString = false
    let escape = false
    while (c.index < c.source.length) {
      const x = c.source.charAt(c.index)
      if (inString) {
        if (escape) escape = false
        else if (x === "\\") escape = true
        else if (x === '"') inString = false
      } else if (x === '"') inString = true
      else if (x === "{" || x === "[") stack.push(x === "{" ? "}" : "]")
      else if (x === "}" || x === "]") {
        if (stack.at(-1) !== x) return false
        stack.pop()
        if (stack.length === 0) {
          c.index++
          return true
        }
      }
      c.index++
    }
    return false
  }
  const start = c.index
  while (!isDelimiter(c.source.charAt(c.index))) c.index++
  const token = c.source.slice(start, c.index)
  if (c.index >= c.source.length) return isClosedPrimitive(token)
  return token.length > 0
}

function readEditEntry(c: Cursor): { entry: RawEditOp; closed: boolean } {
  c.index++ // opening brace
  const entry: RawEditOp = {}
  for (;;) {
    skipWs(c)
    const ch = c.source.charAt(c.index)
    if (ch === "") return { entry, closed: false }
    if (ch === "}") {
      c.index++
      return { entry, closed: true }
    }
    if (ch === ",") {
      c.index++
      continue
    }
    if (ch !== '"') return { entry, closed: false }
    const key = readString(c)
    if (!key.closed) return { entry, closed: false }
    skipWs(c)
    if (c.source.charAt(c.index) !== ":") return { entry, closed: false }
    c.index++
    skipWs(c)
    const valueChar = c.source.charAt(c.index)
    if (key.value === "op" || key.value === "pos" || key.value === "end") {
      if (valueChar !== '"') return { entry, closed: false }
      const value = readString(c)
      if (!value.closed) return { entry, closed: false }
      if (key.value === "op") entry.op = value.value
      else if (key.value === "pos") entry.pos = value.value
      else entry.end = value.value
      continue
    }
    if (key.value === "lines") {
      if (valueChar === '"') {
        const value = readString(c)
        if (!value.closed) return { entry, closed: false }
        entry.lines = value.value
        continue
      }
      if (valueChar === "[") {
        c.index++
        const items: string[] = []
        for (;;) {
          skipWs(c)
          const itemChar = c.source.charAt(c.index)
          if (itemChar === "]") {
            c.index++
            break
          }
          if (itemChar !== '"') return { entry, closed: false }
          const item = readString(c)
          if (!item.closed) return { entry, closed: false }
          items.push(item.value)
          skipWs(c)
          const sep = c.source.charAt(c.index)
          if (sep === ",") {
            c.index++
            continue
          }
          if (sep === "]") {
            c.index++
            break
          }
          return { entry, closed: false }
        }
        entry.lines = items
        continue
      }
      if (valueChar === "n") {
        if (!skipValue(c)) return { entry, closed: false }
        entry.lines = null
        continue
      }
      return { entry, closed: false }
    }
    if (!skipValue(c)) return { entry, closed: false }
  }
}

function readEditArgs(raw: string): { filePath?: string; edits: RawEditOp[] } {
  const c = { source: raw, index: 0 }
  skipWs(c)
  if (c.source.charAt(c.index) !== "{") return { edits: [] }
  c.index++
  const edits: RawEditOp[] = []
  let filePath: string | undefined
  for (;;) {
    skipWs(c)
    const ch = c.source.charAt(c.index)
    if (ch === "" || ch === "}") break
    if (ch === ",") {
      c.index++
      continue
    }
    if (ch !== '"') break
    const key = readString(c)
    if (!key.closed) break
    skipWs(c)
    if (c.source.charAt(c.index) !== ":") break
    c.index++
    skipWs(c)
    const valueChar = c.source.charAt(c.index)
    if (key.value === "filePath") {
      if (valueChar !== '"') break
      const value = readString(c)
      if (!value.closed) break
      filePath = value.value
      continue
    }
    if (key.value === "edits") {
      if (valueChar !== "[") break
      c.index++
      for (;;) {
        skipWs(c)
        if (c.source.charAt(c.index) === "]") {
          c.index++
          break
        }
        if (c.source.charAt(c.index) !== "{") break
        const parsed = readEditEntry(c)
        if (parsed.closed) edits.push(parsed.entry)
        if (!parsed.closed) break
        skipWs(c)
        const sep = c.source.charAt(c.index)
        if (sep === ",") {
          c.index++
          continue
        }
        if (sep === "]") {
          c.index++
          break
        }
        break
      }
      continue
    }
    if (!skipValue(c)) break
  }
  return { filePath, edits }
}

function readPatchText(raw: string): string {
  const c = { source: raw, index: 0 }
  skipWs(c)
  if (c.source.charAt(c.index) !== "{") return ""
  c.index++
  for (;;) {
    skipWs(c)
    const ch = c.source.charAt(c.index)
    if (ch === "" || ch === "}") return ""
    if (ch === ",") {
      c.index++
      continue
    }
    if (ch !== '"') return ""
    const key = readString(c)
    if (!key.closed) return ""
    skipWs(c)
    if (c.source.charAt(c.index) !== ":") return ""
    c.index++
    skipWs(c)
    if (key.value === "patchText") {
      if (c.source.charAt(c.index) !== '"') return ""
      return readString(c).value
    }
    if (!skipValue(c)) return ""
  }
}

// ---------------------------------------------------------------------------
// apply_patch hunk extraction. A hunk counts as complete once the NEXT `@@`
// header or the next `*** ... File:` section header has arrived with its
// terminating newline (`*** End Patch` closes the last one), mirroring the
// semantics of the real Patch parser: before = context+removed lines,
// after = context+added lines. Delete sections carry no content and are
// skipped. Because the decoded patch text only grows by append, rescanning
// from scratch is deterministic; `tracker.emitted` yields each hunk exactly
// once, in order.
// ---------------------------------------------------------------------------

function completedPatchHunks(text: string): StreamingHunk[] {
  const cut = text.lastIndexOf("\n")
  if (cut < 0) return []
  const lines = text.slice(0, cut).split("\n")
  const out: StreamingHunk[] = []
  let index = 0
  let filePath: string | undefined
  let section: "add" | "update" | "delete" | undefined
  let inHunk = false
  let before: string[] = []
  let after: string[] = []
  let added: string[] = []

  const flushChunk = () => {
    if (inHunk && section === "update" && filePath !== undefined && (before.length > 0 || after.length > 0)) {
      out.push({ index: index++, op: "patch", filePath, before: before.join("\n"), after: after.join("\n") })
    }
    inHunk = false
    before = []
    after = []
  }
  const flushAdd = () => {
    if (section === "add" && filePath !== undefined && added.length > 0) {
      out.push({ index: index++, op: "patch", filePath, before: "", after: added.join("\n") })
    }
    added = []
  }

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flushChunk()
      if (section === "update") inHunk = true
      continue
    }
    if (line.startsWith("***")) {
      flushChunk()
      flushAdd()
      const header = /^\*\*\* (Add|Delete|Update) File:\s*(.*)$/.exec(line)
      if (header) {
        const kind = header[1]
        const next = (header[2] ?? "").trim()
        filePath = next
        section = kind === "Add" ? "add" : kind === "Delete" ? "delete" : "update"
      }
      if (/^\*\*\* End Patch/.test(line)) {
        section = undefined
        filePath = undefined
      }
      continue
    }
    if (section === "update" && inHunk) {
      if (line.startsWith("+")) after.push(line.slice(1))
      else if (line.startsWith("-")) before.push(line.slice(1))
      else if (line.startsWith(" ")) {
        before.push(line.slice(1))
        after.push(line.slice(1))
      }
      continue
    }
    if (section === "add" && line.startsWith("+")) added.push(line.slice(1))
  }
  return out
}

// ---------------------------------------------------------------------------
// edit hunk building
// ---------------------------------------------------------------------------

function verifyAnchorLine(lines: string[], anchor: LineAnchor): number | undefined {
  if (anchor.line >= 1 && anchor.line <= lines.length && lineHash(anchor.line, lines[anchor.line - 1] ?? "") === anchor.id)
    return anchor.line
  let found = 0
  let line = 0
  for (let i = 0; i < lines.length; i++) {
    if (lineHash(i + 1, lines[i] ?? "") === anchor.id) {
      found++
      line = i + 1
    }
  }
  if (found === 1) return line
  return undefined
}

const tryAnchor = Effect.fnUntraced(function* (input: string | undefined) {
  return yield* Effect.try({
    try: () => parseAnchor(input, "anchor"),
    catch: (cause) => new Error("invalid hashline anchor", { cause }),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
})

// The preview reads the target file BEFORE the permission ask (streaming
// hunks render pre-approval). This mirrors the exposure the UI already gets
// from the read tool and from the completed-diff display — the edit tool
// itself computes and sends the same diff in its permission metadata before
// approval — and degrades to raw-only on any miss, so an unreadable file
// leaks nothing.
const readSnapshot = Effect.fnUntraced(function* (tracker: Tracker) {
  tracker.snapshotRead = true
  const filePath = tracker.filePath
  if (!filePath) return
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(tracker.cwd, filePath)
  const loaded = yield* Effect.gen(function* () {
    const afs = yield* AppFileSystem.Service
    const info = yield* afs.stat(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info || info.type === "Directory" || info.size > SNAPSHOT_MAX_BYTES) return undefined
    return yield* afs.readFileStringSafe(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
  }).pipe(Effect.provide(AppFileSystem.defaultLayer), Effect.timeoutOption(SNAPSHOT_TIMEOUT))
  if (Option.isNone(loaded)) return
  const text = loaded.value
  if (text === undefined) return
  tracker.snapshot = splitText(Bom.split(text).text).lines
})

type EditHunkResult = { status: "emit"; hunk: StreamingHunk } | { status: "skip" } | { status: "defer" }

const buildEditHunk: (tracker: Tracker, index: number, entry: RawEditOp) => Effect.Effect<EditHunkResult> = Effect.fnUntraced(function* (tracker: Tracker, index: number, entry: RawEditOp) {
  const op = entry.op
  if (op !== "replace" && op !== "append" && op !== "prepend") return { status: "skip" }
  const anchorText = op === "replace" ? entry.pos : (entry.pos ?? entry.end)
  if (op === "replace" && anchorText === undefined) return { status: "skip" }

  if (anchorText === undefined) {
    const inserted = normalizeReplacement(entry.lines)
    if (inserted.length === 0) return { status: "skip" }
    return {
      status: "emit",
      hunk: {
        index,
        op,
        filePath: tracker.filePath,
        pos: entry.pos,
        end: entry.end,
        before: "",
        after: inserted.join("\n"),
      },
    }
  }

  if (tracker.filePath === undefined) return { status: "defer" }
  if (!tracker.snapshotRead) yield* readSnapshot(tracker)
  const anchor = yield* tryAnchor(anchorText)
  if (!anchor) return { status: "skip" }
  const start = verifyAnchorLine(tracker.snapshot, anchor)
  if (start === undefined) return { status: "skip" }

  if (op !== "replace") {
    const inserted = normalizeReplacement(entry.lines)
    if (inserted.length === 0) return { status: "skip" }
    return {
      status: "emit",
      hunk: { index, op, filePath: tracker.filePath, pos: entry.pos, end: entry.end, before: "", after: inserted.join("\n") },
    }
  }

  let endLine = start
  if (entry.end) {
    const endAnchor = yield* tryAnchor(entry.end)
    if (!endAnchor) return { status: "skip" }
    const resolvedEnd = verifyAnchorLine(tracker.snapshot, endAnchor)
    if (resolvedEnd === undefined || resolvedEnd < start) return { status: "skip" }
    endLine = resolvedEnd
  }
  return {
    status: "emit",
    hunk: {
      index,
      op,
      filePath: tracker.filePath,
      pos: entry.pos,
      end: entry.end,
      before: tracker.snapshot.slice(start - 1, endLine).join("\n"),
      after: normalizeReplacement(entry.lines).join("\n"),
    },
  }
})

const runEdit = Effect.fnUntraced(function* (tracker: Tracker, raw: string, force: boolean) {
  const out: StreamingHunk[] = []
  if (!force && raw.length - tracker.parsedLength < Math.max(PARSE_MIN_GROWTH, Math.floor(raw.length / 32))) return out
  tracker.parsedLength = raw.length
  const args = readEditArgs(raw)
  if (args.filePath !== undefined) tracker.filePath = args.filePath
  while (tracker.emitted < args.edits.length) {
    const index = tracker.emitted
    const entry = args.edits[index]
    if (!entry) break
    const built = yield* buildEditHunk(tracker, index, entry)
    if (built.status === "defer") break
    if (built.status === "emit") out.push(built.hunk)
    tracker.emitted = index + 1
  }
  if (force) tracker.snapshot = []
  return out
})

const runPatch = Effect.fnUntraced(function* (tracker: Tracker, raw: string, force: boolean) {
  const out: StreamingHunk[] = []
  if (!force && raw.length - tracker.parsedLength < Math.max(PARSE_MIN_GROWTH, Math.floor(raw.length / 32))) return out
  tracker.parsedLength = raw.length
  const hunks = completedPatchHunks(readPatchText(raw))
  out.push(...hunks.slice(tracker.emitted))
  tracker.emitted = hunks.length
  return out
})

function feed(tracker: Tracker, raw: string, force: boolean): Effect.Effect<StreamingHunk[]> {
  return Effect.suspend(() => (tracker.tool === "edit" ? runEdit(tracker, raw, force) : runPatch(tracker, raw, force))).pipe(
    Effect.catchCause(() => Effect.succeed<StreamingHunk[]>([])),
  )
}

export function update(tracker: Tracker, raw: string) {
  return feed(tracker, raw, false)
}

export function finalize(tracker: Tracker, raw: string) {
  return feed(tracker, raw, true)
}

export * as StreamingPreview from "./streaming-preview"
