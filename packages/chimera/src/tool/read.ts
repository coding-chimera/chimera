import { createHash } from "crypto"
import { Effect, Option, Schema, Scope } from "effect"
import { NonNegativeInt } from "@/util/schema"
import { createReadStream } from "fs"
import * as path from "path"
import { createInterface } from "readline"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import type { ToolPart, WithParts } from "../session/message-v2"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import { DISPLAY_ALGORITHM, SCHEMA_VERSION, UNANCHORABLE_TOKEN, formatLine, lineInfo, type LineInfo } from "./hashline"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const READ_DEDUP_MESSAGES_EXTRA = "readDedupMessages"
const HASHLINE_PREFIX = /^(\d+)#([A-Za-z0-9-]{2})\|/

function isDedupCapable(modelID: string): boolean {
  const gptMatch = /^gpt-(\d+)\.(\d+)/.exec(modelID)
  if (gptMatch) {
    const major = Number(gptMatch[1])
    const minor = Number(gptMatch[2])
    return major > 5 || (major === 5 && minor >= 4)
  }
  const opusMatch = /^claude-opus[-.]?(\d+)[-.]?(\d+)?/.exec(modelID)
  if (opusMatch) {
    const major = Number(opusMatch[1])
    const minor = opusMatch[2] ? Number(opusMatch[2]) : 0
    return major > 4 || (major === 4 && minor >= 6)
  }
  const sonnetMatch = /^claude-sonnet[-.]?(\d+)[-.]?(\d+)?/.exec(modelID)
  if (sonnetMatch) {
    const major = Number(sonnetMatch[1])
    const minor = sonnetMatch[2] ? Number(sonnetMatch[2]) : 0
    return major > 4 || (major === 4 && minor >= 6)
  }
  if (/^claude-fable[-.]?5/.test(modelID)) return true
  if (/^deepseek-v4-pro/.test(modelID)) return true
  if (/(^|\/)hy3($|[.\-])/.test(modelID)) return true
  return false
}


type ReadSpanLine = {
  line: number
  id: string
  content: string
}

type ReadSpanRef = {
  ref: string
  filepath: string
  start: number
  end: number
  contentHash: string
}

type ReadAnchorSource = {
  line: number
  id: string
  span: ReadSpanRef
}

type ReadDedupHit = {
  span: ReadSpanRef
  start: number
  end: number
}

type ReadDedupWindow = {
  windowID: string
  anchors: Map<string, Map<string, ReadAnchorSource>>
  seededParts: Set<string>
}

type ReadDedupState = {
  sessions: Map<string, ReadDedupWindow>
}

function readDedupMessages(ctx: Tool.Context) {
  const value = ctx.extra?.[READ_DEDUP_MESSAGES_EXTRA]
  return Array.isArray(value) ? (value as WithParts[]) : ctx.messages
}

function section(output: string, tag: string) {
  const start = output.indexOf(`<${tag}>`)
  if (start < 0) return ""
  const body = start + tag.length + 2
  const end = output.indexOf(`</${tag}>`, body)
  if (end < 0) return ""
  return output.slice(body, end)
}

function contentSection(output: string) {
  return section(output, "content")
}

function readRefsSection(output: string) {
  return section(output, "read_refs")
}

function outputPath(output: string) {
  return output.match(/^<path>(.*)<\/path>$/m)?.[1]
}

function anchorKey(line: number, id: string) {
  return `${line}#${id}`
}

function normalizeReadRefPath(filepath: string, worktree?: string) {
  const relative = worktree ? path.relative(worktree, filepath) : ""
  const insideWorktree =
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  const target = insideWorktree ? relative : path.normalize(filepath)
  return target.replaceAll(path.sep, "/").replaceAll("\\", "/")
}

function readSpanContentHash(filepath: string, lines: ReadSpanLine[]) {
  const hash = createHash("sha256")
  hash.update(path.normalize(filepath))
  for (const line of lines) hash.update(`\n${line.line}#${line.id}|${line.content}`)
  return `sha256:${hash.digest("hex")}`
}

function readRefLineRange(start: number, end: number) {
  return `L${start}-L${end}`
}

function formatLineRange(start: number, end: number) {
  if (start === end) return `L${start}`
  return `L${start}-L${end}`
}

function contiguousLineGroups<T extends { line: number }>(items: T[]) {
  return [...items]
    .sort((a, b) => a.line - b.line)
    .reduce<T[][]>((groups, item) => {
      const last = groups.at(-1)
      if (last?.at(-1)?.line === item.line - 1) {
        last.push(item)
        return groups
      }
      groups.push([item])
      return groups
    }, [])
}

function readSpanRefs(filepath: string, worktree: string | undefined, lines: ReadSpanLine[]): ReadSpanRef[] {
  return contiguousLineGroups(lines.filter((line) => line.id !== UNANCHORABLE_TOKEN)).map((group) => {
    const start = group[0]?.line ?? 0
    const end = group.at(-1)?.line ?? start
    const contentHash = readSpanContentHash(filepath, group)
    const shortHash = contentHash.slice("sha256:".length, "sha256:".length + 12)
    return {
      ref: `readref://${normalizeReadRefPath(filepath, worktree)}@${shortHash}#${readRefLineRange(start, end)}`,
      filepath: normalizeReadRefPath(filepath, worktree),
      start,
      end,
      contentHash,
    }
  })
}

function parseReadRefs(output: string, filepath: string): ReadSpanRef[] {
  return readRefsSection(output)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*-\s+ref:\s+(readref:\/\/.+#L(\d+)-L(\d+))\s*$/)
      if (!match) return []
      const contentHash = match[1].match(/@([^@#]+)#L\d+-L\d+$/)?.[1] ?? ""
      return [
        {
          ref: match[1],
          filepath,
          start: Number(match[2]),
          end: Number(match[3]),
          contentHash: contentHash.length > 0 ? `sha256:${contentHash}` : "",
        },
      ]
    })
}

function spanForLine(spans: ReadSpanRef[], line: number) {
  return spans.find((span) => line >= span.start && line <= span.end)
}

function addAnchor(
  anchors: Map<string, Map<string, ReadAnchorSource>>,
  filepath: string,
  line: number,
  id: string,
  span: ReadSpanRef,
) {
  if (id === UNANCHORABLE_TOKEN) return
  const normalized = path.normalize(filepath)
  const existing = anchors.get(normalized) ?? new Map<string, ReadAnchorSource>()
  existing.set(anchorKey(line, id), { line, id, span })
  anchors.set(normalized, existing)
}

function parseReadAnchors(output: string): ReadSpanLine[] {
  return contentSection(output)
    .split("\n")
    .flatMap((line) => {
      const match = HASHLINE_PREFIX.exec(line)
      if (!match || match[2] === UNANCHORABLE_TOKEN) return []
      return [{ line: Number(match[1]), id: match[2], content: line.slice(match[0].length) }]
    })
}

function readPartPath(part: ToolPart) {
  if (part.state.status !== "completed") return undefined
  return outputPath(part.state.output) ?? (typeof part.state.input.filePath === "string" ? part.state.input.filePath : undefined)
}

function readDedupWindowID(messages: WithParts[]) {
  let compaction = "initial"
  let compacted = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "compaction") compaction = `${msg.info.id}:${part.id}`
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      compacted = Math.max(compacted, part.state.time.compacted ?? 0)
    }
  }
  return `${compaction}:${compacted}`
}

function makeReadDedupWindow(windowID: string): ReadDedupWindow {
  return {
    windowID,
    anchors: new Map<string, Map<string, ReadAnchorSource>>(),
    seededParts: new Set<string>(),
  }
}

function seedReadDedupWindow(state: ReadDedupState, ctx: Tool.Context) {
  const messages = readDedupMessages(ctx)
  const windowID = readDedupWindowID(messages)
  const sessionID = String(ctx.sessionID)
  const current = state.sessions.get(sessionID)
  const window = current?.windowID === windowID ? current : makeReadDedupWindow(windowID)
  let startMessage = 0
  let startPart = 0
  state.sessions.set(sessionID, window)
  for (const [messageIndex, msg] of messages.entries()) {
    for (const [partIndex, part] of msg.parts.entries()) {
      if (part.type !== "compaction") continue
      startMessage = messageIndex
      startPart = partIndex + 1
    }
  }
  for (const [messageIndex, msg] of messages.entries()) {
    if (messageIndex < startMessage) continue
    for (const [partIndex, part] of msg.parts.entries()) {
      if (messageIndex === startMessage && partIndex < startPart) continue
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      if (window.seededParts.has(part.id)) continue
      const filepath = readPartPath(part)
      if (filepath) {
        const anchors = parseReadAnchors(part.state.output)
        const spans = parseReadRefs(part.state.output, filepath)
        const fallbackSpans = spans.length > 0 ? spans : readSpanRefs(filepath, undefined, anchors)
        for (const anchor of anchors) {
          const span = spanForLine(fallbackSpans, anchor.line)
          if (span) addAnchor(window.anchors, filepath, anchor.line, anchor.id, span)
        }
      }
      window.seededParts.add(part.id)
    }
  }
  return window
}

function anchorSources(window: ReadDedupWindow, filepath: string) {
  const normalized = path.normalize(filepath)
  const existing = window.anchors.get(normalized) ?? new Map<string, ReadAnchorSource>()
  window.anchors.set(normalized, existing)
  return existing
}

function lineRangeSegments(lines: number[]) {
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b)
  const ranges: Array<{ start: number; end: number }> = []
  for (const line of sorted) {
    const last = ranges.at(-1)
    if (last && line === last.end + 1) {
      last.end = line
      continue
    }
    ranges.push({ start: line, end: line })
  }
  return ranges
}

function lineRanges(lines: number[]) {
  const ranges = lineRangeSegments(lines).map((range) =>
    range.start === range.end ? String(range.start) : `${range.start}-${range.end}`,
  )
  return ranges.length > 12 ? `${ranges.slice(0, 12).join(", ")}, ...` : ranges.join(", ")
}

function readDedupHits(skipped: ReadAnchorSource[]): ReadDedupHit[] {
  const grouped = new Map<string, { span: ReadSpanRef; lines: number[] }>()
  for (const source of skipped) {
    const existing = grouped.get(source.span.ref) ?? { span: source.span, lines: [] }
    existing.lines.push(source.line)
    grouped.set(source.span.ref, existing)
  }
  return Array.from(grouped.values())
    .flatMap((item) => lineRangeSegments(item.lines).map((range) => ({ span: item.span, ...range })))
    .sort((a, b) => a.start - b.start)
}

function readDedupBlock(hits: ReadDedupHit[], requestedStart: number, requestedEnd: number, newSpans: ReadSpanRef[]) {
  if (hits.length === 0) return ""
  const continuity = newSpans.flatMap((span) => {
    const hit = hits.find((hit) => hit.end + 1 === span.start)
    if (!hit) return []
    return [
      `- Treat ${hit.span.ref} ${formatLineRange(hit.start, hit.end)} as immediate preceding context for ${formatLineRange(span.start, span.start)}.`,
    ]
  })
  return [
    "<read_dedup>",
    `Requested range: ${formatLineRange(requestedStart, requestedEnd)}`,
    "Folded ranges:",
    ...hits.flatMap((hit) => [
      `- ${formatLineRange(hit.start, hit.end)} already read in:`,
      `  ref: ${hit.span.ref}`,
      `  subrange: ${formatLineRange(hit.start, hit.end)}`,
    ]),
    ...(continuity.length > 0 ? ["Continuity:", ...continuity] : []),
    "</read_dedup>",
  ].join("\n")
}

function readRefsBlock(spans: ReadSpanRef[]) {
  if (spans.length === 0) return ["<read_refs>", "New: none", "</read_refs>"].join("\n")
  return [
    "<read_refs>",
    "New:",
    ...spans.flatMap((span) => [
      `- ref: ${span.ref}`,
      `  file: ${span.filepath}`,
      `  lines: ${formatLineRange(span.start, span.end)}`,
      `  content_hash: ${span.contentHash}`,
    ]),
    "</read_refs>",
  ].join("\n")
}

function readSpanMetadata(span: ReadSpanRef) {
  return {
    ref: span.ref,
    file: span.filepath,
    start: span.start,
    end: span.end,
    contentHash: span.contentHash,
  }
}

function readDedupNotice(skipped: number[], requested: number) {
  if (skipped.length === requested) {
    return `[Read dedup: all ${skipped.length} requested lines were already read in this compaction window with identical file_path+line+hash; see <read_dedup> refs.]`
  }
  return `[Read dedup: skipped ${skipped.length} already-read lines (${lineRanges(skipped)}) in this compaction window with identical file_path+line+hash; see <read_dedup> refs.]`
}

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope
    const readDedup = yield* InstanceState.make(
      Effect.fn("ReadTool.dedupState")(() =>
        Effect.succeed({
          sessions: new Map<string, ReadDedupWindow>(),
        }),
      ),
    )

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath).pipe(Effect.ignore, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset || 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      const file = yield* Effect.promise(() =>
        lines(filepath, { limit: params.limit ?? DEFAULT_READ_LIMIT, offset: params.offset || 1 }),
      )
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      const useDedup = isDedupCapable(String((ctx.extra?.model as any)?.id ?? ""))
      const skipped: ReadAnchorSource[] = []
      let window: ReadDedupWindow | undefined
      let visible: LineInfo[]
      let newSpans: ReadSpanRef[]

      if (useDedup) {
        window = seedReadDedupWindow(yield* InstanceState.get(readDedup), ctx)
        const seen = anchorSources(window, filepath)
        visible = file.raw.flatMap((line, i) => {
          const info = lineInfo(i + file.offset, line, !file.unanchorable.includes(i + file.offset))
          const source = seen.get(anchorKey(info.line, info.id))
          if (info.anchorable && info.id !== UNANCHORABLE_TOKEN && source) {
            skipped.push(source)
            return []
          }
          return [info]
        })
        newSpans = readSpanRefs(filepath, instance.worktree, visible)
        for (const info of visible) {
          const span = spanForLine(newSpans, info.line)
          if (span) addAnchor(window.anchors, filepath, info.line, info.id, span)
        }
      } else {
        visible = file.raw.map((line, i) =>
          lineInfo(i + file.offset, line, !file.unanchorable.includes(i + file.offset)),
        )
        newSpans = readSpanRefs(filepath, instance.worktree, visible)
      }

      const skippedLines = skipped.map((item) => item.line)
      const dedupHits = readDedupHits(skipped)
      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += visible.map(formatLine).join("\n")
      if (skippedLines.length > 0) {
        if (visible.length > 0) output += "\n"
        output += readDedupNotice(skippedLines, file.raw.length)
      }
      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"
      const dedupBlock = readDedupBlock(dedupHits, file.offset, last, newSpans)
      if (dedupBlock.length > 0) output += `\n\n${dedupBlock}`
      output += `\n\n${readRefsBlock(newSpans)}`

      yield* warm(filepath)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: visible.slice(0, 20).map((item) => item.content).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
          readRefs: newSpans.map(readSpanMetadata),
          hashline: {
            schemaVersion: SCHEMA_VERSION,
            displayAlgorithm: DISPLAY_ALGORITHM,
            anchors: visible.filter((item) => item.anchorable && item.id !== UNANCHORABLE_TOKEN).length,
            unanchorable: file.unanchorable,
          },
          readDedup: {
            skipped: skippedLines.length,
            windowID: window?.windowID ?? "disabled",
            hits: dedupHits.map((hit) => ({
              ref: hit.span.ref,
              file: hit.span.filepath,
              start: hit.start,
              end: hit.end,
              sourceStart: hit.span.start,
              sourceEnd: hit.span.end,
            })),
          }
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult>,
    }
  }),
)

async function lines(filepath: string, opts: { limit: number; offset: number }) {
  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({
    input: stream,
    // Note: we use the crlfDelay option to recognize all instances of CR LF
    // ('\r\n') in file as a single line break.
    crlfDelay: Infinity,
  })

  const start = opts.offset - 1
  const raw: string[] = []
  const unanchorable: number[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of rl) {
      count += 1
      if (count <= start) continue

      if (raw.length >= opts.limit) {
        more = true
        continue
      }

      const truncatedLine = text.length > MAX_LINE_LENGTH
      const line = truncatedLine ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }

      raw.push(line)
      if (truncatedLine) unanchorable.push(count)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset, unanchorable }
}
