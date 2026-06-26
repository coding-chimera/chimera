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
import { DISPLAY_ALGORITHM, SCHEMA_VERSION, UNANCHORABLE_TOKEN, formatLine, lineInfo } from "./hashline"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const READ_DEDUP_MESSAGES_EXTRA = "readDedupMessages"
const HASHLINE_PREFIX = /^(\d+)#([A-Za-z0-9-]{2})\|/

type ReadDedupWindow = {
  windowID: string
  anchors: Map<string, Set<string>>
  seededParts: Set<string>
}

type ReadDedupState = {
  sessions: Map<string, ReadDedupWindow>
}

function readDedupMessages(ctx: Tool.Context) {
  const value = ctx.extra?.[READ_DEDUP_MESSAGES_EXTRA]
  return Array.isArray(value) ? (value as WithParts[]) : ctx.messages
}

function contentSection(output: string) {
  const start = output.indexOf("<content>")
  if (start < 0) return ""
  const end = output.indexOf("</content>", start)
  if (end < 0) return ""
  return output.slice(start + "<content>".length, end)
}

function outputPath(output: string) {
  return output.match(/^<path>(.*)<\/path>$/m)?.[1]
}

function anchorKey(line: number, id: string) {
  return `${line}#${id}`
}

function addAnchor(anchors: Map<string, Set<string>>, filepath: string, line: number, id: string) {
  if (id === UNANCHORABLE_TOKEN) return
  const normalized = path.normalize(filepath)
  const existing = anchors.get(normalized) ?? new Set<string>()
  existing.add(anchorKey(line, id))
  anchors.set(normalized, existing)
}

function parseReadAnchors(output: string) {
  return contentSection(output)
    .split("\n")
    .flatMap((line) => {
      const match = HASHLINE_PREFIX.exec(line)
      if (!match || match[2] === UNANCHORABLE_TOKEN) return []
      return [{ line: Number(match[1]), id: match[2] }]
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
      if (part.type === "compaction" && part.tail_start_id) compaction = msg.info.id
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
    anchors: new Map<string, Set<string>>(),
    seededParts: new Set<string>(),
  }
}

function seedReadDedupWindow(state: ReadDedupState, ctx: Tool.Context) {
  const messages = readDedupMessages(ctx)
  const windowID = readDedupWindowID(messages)
  const sessionID = String(ctx.sessionID)
  const current = state.sessions.get(sessionID)
  const window = current?.windowID === windowID ? current : makeReadDedupWindow(windowID)
  state.sessions.set(sessionID, window)
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      if (window.seededParts.has(part.id)) continue
      const filepath = readPartPath(part)
      if (filepath) {
        for (const anchor of parseReadAnchors(part.state.output)) addAnchor(window.anchors, filepath, anchor.line, anchor.id)
      }
      window.seededParts.add(part.id)
    }
  }
  return window
}

function anchorSet(window: ReadDedupWindow, filepath: string) {
  const normalized = path.normalize(filepath)
  const existing = window.anchors.get(normalized) ?? new Set<string>()
  window.anchors.set(normalized, existing)
  return existing
}

function lineRanges(lines: number[]) {
  const sorted = Array.from(new Set(lines)).sort((a, b) => a - b)
  const ranges: string[] = []
  let start = sorted[0]
  let previous = sorted[0]
  for (const line of sorted.slice(1)) {
    if (line === previous + 1) {
      previous = line
      continue
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`)
    start = line
    previous = line
  }
  if (start !== undefined && previous !== undefined) ranges.push(start === previous ? String(start) : `${start}-${previous}`)
  return ranges.length > 12 ? `${ranges.slice(0, 12).join(", ")}, ...` : ranges.join(", ")
}

function readDedupNotice(skipped: number[], requested: number) {
  if (skipped.length === requested) {
    return `[Read dedup: all ${skipped.length} requested lines were already read in this compaction window with identical file_path+line+hash.]`
  }
  return `[Read dedup: skipped ${skipped.length} already-read lines (${lineRanges(skipped)}) in this compaction window with identical file_path+line+hash.]`
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

      const window = seedReadDedupWindow(yield* InstanceState.get(readDedup), ctx)
      const seen = anchorSet(window, filepath)
      const skipped: number[] = []
      const visible = file.raw.flatMap((line, i) => {
        const info = lineInfo(i + file.offset, line, !file.unanchorable.includes(i + file.offset))
        if (info.anchorable && info.id !== UNANCHORABLE_TOKEN && seen.has(anchorKey(info.line, info.id))) {
          skipped.push(info.line)
          return []
        }
        return [info]
      })
      for (const info of visible) addAnchor(window.anchors, filepath, info.line, info.id)

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += visible.map(formatLine).join("\n")
      if (skipped.length > 0) {
        if (visible.length > 0) output += "\n"
        output += readDedupNotice(skipped, file.raw.length)
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
          hashline: {
            schemaVersion: SCHEMA_VERSION,
            displayAlgorithm: DISPLAY_ALGORITHM,
            anchors: visible.filter((item) => item.anchorable && item.id !== UNANCHORABLE_TOKEN).length,
            unanchorable: file.unanchorable,
          },
          readDedup: {
            skipped: skipped.length,
            windowID: window.windowID,
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
