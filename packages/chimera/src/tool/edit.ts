import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import { Chimera } from "@/chimera"
import { ulid } from "ulid"
import {
  DISPLAY_ALGORITHM,
  SCHEMA_VERSION,
  changedRange,
  fileHash,
  formatChangedBlock,
  joinText,
  lineHash,
  mismatchMessage,
  normalizeInsertLines,
  normalizeLineEndings,
  normalizeReplaceLines,
  normalizeReplacement,
  parseAnchor,
  rangeIDs,
  splitText,
  type LineAnchor,
} from "./hashline"

const Operation = Schema.Struct({
  op: Schema.Union([Schema.Literal("replace"), Schema.Literal("append"), Schema.Literal("prepend")]).annotate({
    description: "Edit operation to apply",
  }),
  pos: Schema.optional(Schema.String).annotate({ description: "Hashline anchor LINE#ID" }),
  end: Schema.optional(Schema.String).annotate({ description: "Optional end Hashline anchor LINE#ID" }),
  lines: Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description: "Replacement or inserted real file lines. Do not include Hashline prefixes.",
  }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  edits: Schema.Array(Operation).annotate({ description: "Hashline anchored edits to apply to one file" }),
  delete: Schema.optional(Schema.Boolean).annotate({ description: "Delete the file. Requires edits: [] and cannot be combined with rename." }),
  rename: Schema.optional(Schema.String).annotate({ description: "Move the final file content to this path and remove the original path." }),
  expectedFileHash: Schema.optional(Schema.String).annotate({ description: "Optional read-time file hash used only to report drift." }),
})

type EditInput = Schema.Schema.Type<typeof Operation>
type Params = Schema.Schema.Type<typeof Parameters>

type NormalizedEdit = {
  op: "replace" | "append" | "prepend"
  index: number
  startLine: number
  endLine: number
  lines: string[]
  anchored: boolean
  key: string
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

function withLocks<T, E, R>(filePaths: string[], effect: Effect.Effect<T, E, R>) {
  return [...new Set(filePaths.map(AppFileSystem.resolve))]
    .toSorted((a, b) => a.localeCompare(b))
    .reduceRight((next, filePath) => lock(filePath).withPermits(1)(next), effect)
}

function verifyAnchor(lines: string[], anchor: LineAnchor) {
  if (anchor.line < 1 || anchor.line > lines.length) {
    throw new Error(`Hashline anchor ${anchor.line}#${anchor.id} is outside the current file. Re-read the target range.`)
  }
  const current = lineHash(anchor.line, lines[anchor.line - 1] ?? "")
  if (current !== anchor.id) throw new Error(mismatchMessage(lines, anchor))
}

function normalizeEdit(input: EditInput, index: number, lines: string[], exists: boolean): NormalizedEdit {
  const rawReplacement = normalizeReplacement(input.lines)

  if (input.op === "replace") {
    const start = parseAnchor(input.pos, "replace.pos")
    const end = input.end ? parseAnchor(input.end, "replace.end") : start
    if (!exists) throw new Error("File not found; anchored replace cannot create files. Use unanchored append/prepend or write.")
    verifyAnchor(lines, start)
    verifyAnchor(lines, end)
    if (start.line > end.line) throw new Error(`Invalid replace range: ${input.pos} is after ${input.end}`)
    const replacement = normalizeReplaceLines(lines, start.line, end.line, rawReplacement)
    const key = JSON.stringify({ op: input.op, pos: input.pos?.trim(), end: input.end?.trim(), lines: replacement })
    return { op: input.op, index, startLine: start.line, endLine: end.line, lines: replacement, anchored: true, key }
  }

  const anchorText = input.pos ?? input.end
  if (!anchorText) {
    return {
      op: input.op,
      index,
      startLine: input.op === "append" ? lines.length : 0,
      endLine: input.op === "append" ? lines.length : 0,
      lines: rawReplacement,
      anchored: false,
      key: JSON.stringify({ op: input.op, pos: input.pos?.trim(), end: input.end?.trim(), lines: rawReplacement }),
    }
  }

  if (!exists) throw new Error("File not found; anchored insert cannot create files. Use unanchored append/prepend or write.")
  if (rawReplacement.length === 0) throw new Error(`Anchored ${input.op} requires non-empty lines.`)
  const anchor = parseAnchor(anchorText, `${input.op}.pos`)
  verifyAnchor(lines, anchor)
  const replacement = normalizeInsertLines(lines, anchor.line, input.op, rawReplacement)
  if (replacement.length === 0) throw new Error(`Anchored ${input.op} requires non-empty lines.`)
  const key = JSON.stringify({ op: input.op, pos: input.pos?.trim(), end: input.end?.trim(), lines: replacement })
  return { op: input.op, index, startLine: anchor.line, endLine: anchor.line, lines: replacement, anchored: true, key }
}

function normalizeEdits(edits: ReadonlyArray<EditInput>, lines: string[], exists: boolean) {
  const seen = new Set<string>()
  let deduplicated = 0
  const normalized = edits.flatMap((edit, index) => {
    const next = normalizeEdit(edit, index, lines, exists)
    if (!seen.has(next.key)) {
      seen.add(next.key)
      return [next]
    }
    deduplicated++
    return []
  })

  const replacements = normalized.filter((edit) => edit.op === "replace")
  for (let i = 0; i < replacements.length; i++) {
    for (let j = i + 1; j < replacements.length; j++) {
      const a = replacements[i]
      const b = replacements[j]
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) throw new Error("Overlapping replace ranges are not allowed.")
    }
  }

  for (const insert of normalized.filter((edit) => edit.op !== "replace" && edit.anchored)) {
    const replaced = replacements.find((edit) => edit.startLine <= insert.startLine && insert.startLine <= edit.endLine)
    if (replaced) throw new Error("Insert anchors cannot overlap a replace range in the same edit call.")
  }

  for (const op of ["append", "prepend"] as const) {
    const anchors = new Set<string>()
    for (const edit of normalized.filter((item) => item.op === op && item.anchored)) {
      const key = `${op}:${edit.startLine}`
      if (anchors.has(key)) throw new Error(`Multiple ${op} edits at the same anchor are ambiguous.`)
      anchors.add(key)
    }
  }

  return { edits: normalized, deduplicated }
}

function applyEdits(lines: string[], edits: NormalizedEdit[]) {
  const next = [...lines]
  for (const edit of edits.toSorted((a, b) => b.startLine - a.startLine || sameLinePriority(a) - sameLinePriority(b) || b.index - a.index)) {
    if (edit.op === "replace") {
      next.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.lines)
      continue
    }
    if (edit.op === "append") {
      next.splice(edit.startLine, 0, ...edit.lines)
      continue
    }
    next.splice(Math.max(edit.startLine - 1, 0), 0, ...edit.lines)
  }
  return next
}

function sameLinePriority(edit: NormalizedEdit) {
  if (edit.op === "append") return 0
  if (edit.op === "prepend") return 1
  return 2
}

function hashlineRange(lines: string[], startLine: number, endLine: number) {
  const lineIDs = rangeIDs(lines, startLine, endLine)
  return {
    startLine,
    endLine,
    startID: lineIDs[0] ?? "",
    endID: lineIDs.at(-1) ?? "",
    lineIDs,
  }
}

function beforeRanges(edits: NormalizedEdit[], lines: string[]) {
  return edits.flatMap((edit) => {
    if (edit.op === "replace") return [hashlineRange(lines, edit.startLine, edit.endLine)]
    if (!edit.anchored) return []
    return [hashlineRange(lines, edit.startLine, edit.startLine)]
  })
}

function afterRanges(before: string[], after: string[]) {
  const changed = changedRange(before, after)
  if (!changed || after.length === 0) return []
  return [hashlineRange(after, changed.afterStart, Math.min(changed.afterEnd, after.length))]
}

function targetRange(filePath: string, ranges: ReturnType<typeof afterRanges>) {
  const first = ranges[0]
  if (!first || first.lineIDs.length === 0) return `${filePath} none`
  return `${filePath} ${first.startID}..${first.endID}`
}

function diffHash(diff: string) {
  return fileHash(diff).slice(0, 16)
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = AppFileSystem.resolve(path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath))
          const renamePath = params.rename
            ? AppFileSystem.resolve(path.isAbsolute(params.rename) ? params.rename : path.join(instance.directory, params.rename))
            : undefined
          const finalPath = renamePath ?? filePath
          const displayRoot = instance.worktree === "/" ? instance.directory : instance.worktree
          yield* assertExternalDirectoryEffect(ctx, filePath)
          if (renamePath) yield* assertExternalDirectoryEffect(ctx, renamePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let formatterTouched = false
          let create = false
          let deleted = false
          let deduplicatedEdits = 0
          let hashline: Record<string, unknown> | undefined
          const changeID = `chg_${ulid()}`

          const predesign = yield* Chimera.requirePredesignForMutation({
            toolID: "edit",
            ctx,
            files: renamePath ? [filePath, renamePath] : [filePath],
            destructive: params.delete,
            rename: Boolean(renamePath),
            multiFile: Boolean(renamePath),
          })
          if (!predesign.allowed) return predesign.result

          yield* Chimera.trackToolMutation(
            {
              toolID: "edit",
              ctx,
              files: renamePath ? [filePath, renamePath] : [filePath],
              bus,
              metadata: () => ({
                create,
                delete: params.delete ?? false,
                renameTo: renamePath,
                filePath,
                diff,
                changeID,
                ...(hashline ? { hashline } : {}),
              }),
            },
            withLocks(
              renamePath ? [filePath, renamePath] : [filePath],
              Effect.gen(function* () {
                if (params.delete && renamePath) throw new Error("delete=true cannot be combined with rename.")
                if (params.delete && params.edits.length > 0) throw new Error("delete=true requires edits: [].")

                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (info?.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
                if (!info && params.delete) throw new Error(`File ${filePath} not found`)
                if (!info && renamePath) throw new Error(`File ${filePath} not found`)
                if (!info && params.edits.length === 0) throw new Error(`File ${filePath} not found`)

                const source = info ? yield* Bom.readFile(afs, filePath) : { bom: false, text: "" }
                const before = splitText(source.text)
                contentOld = source.text
                create = !info

                if (params.delete) {
                  contentNew = ""
                  deleted = true
                } else {
                  const normalized = normalizeEdits(params.edits, before.lines, Boolean(info))
                  deduplicatedEdits = normalized.deduplicated
                  if (!info && normalized.edits.some((edit) => edit.anchored)) throw new Error(`File ${filePath} not found`)
                  if (!info && !normalized.edits.every((edit) => edit.op === "append" || edit.op === "prepend")) {
                    throw new Error("Missing files can only be created with unanchored append/prepend edits. Prefer write for new files.")
                  }
                  const afterLines = applyEdits(before.lines, normalized.edits)
                  contentNew = joinText(before, afterLines)
                  if (!renamePath && contentOld === contentNew) throw new Error("No changes to apply: Hashline edits are a no-op.")
                  const beforeRangeList = normalized.edits.length > 0 ? beforeRanges(normalized.edits, before.lines) : before.lines.length ? [hashlineRange(before.lines, 1, before.lines.length)] : []
                  const computedAfterRanges = afterRanges(before.lines, afterLines)
                  const afterRangeList = computedAfterRanges.length > 0 ? computedAfterRanges : renamePath && afterLines.length ? [hashlineRange(afterLines, 1, afterLines.length)] : []
                  hashline = {
                    schemaVersion: SCHEMA_VERSION,
                    displayAlgorithm: DISPLAY_ALGORITHM,
                    operations: [...normalized.edits.map((edit) => edit.op), ...(renamePath ? ["rename"] : [])],
                    filePath,
                    ...(renamePath ? { renameTo: renamePath } : {}),
                    fileHashBefore: fileHash(contentOld),
                    expectedFileHash: params.expectedFileHash,
                    expectedFileHashMatched: params.expectedFileHash ? params.expectedFileHash === fileHash(contentOld) : undefined,
                    formatterTouched: false,
                    noopEdits: 0,
                    deduplicatedEdits,
                    beforeRanges: beforeRangeList,
                    afterRanges: afterRangeList,
                    diffHunks: [],
                  }
                }

                diff = trimDiff(createTwoFilesPatch(filePath, finalPath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)))
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(displayRoot, filePath), ...(renamePath ? [path.relative(displayRoot, renamePath)] : [])],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })

                if (deleted) {
                  yield* afs.remove(filePath)
                  yield* bus.publish(File.Event.Edited, { file: filePath })
                  yield* bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "unlink" })
                } else {
                  const next = Bom.split(contentNew)
                  const desiredBom = source.bom || next.bom
                  yield* afs.writeWithDirs(finalPath, Bom.join(next.text, desiredBom))
                  if (renamePath && info) {
                    yield* afs.remove(filePath)
                    yield* bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "unlink" })
                  }
                  formatterTouched = yield* format.file(finalPath)
                  if (formatterTouched) contentNew = yield* Bom.syncFile(afs, finalPath, desiredBom)
                  yield* bus.publish(File.Event.Edited, { file: finalPath })
                  yield* bus.publish(FileWatcher.Event.Updated, { file: finalPath, event: info && !renamePath ? "change" : "add" })
                }

                const after = splitText(contentNew)
                const beforeLines = splitText(contentOld).lines
                const computedAfterRanges = deleted ? [] : afterRanges(beforeLines, after.lines)
                const afterRangeList = computedAfterRanges.length > 0 ? computedAfterRanges : renamePath && after.lines.length ? [hashlineRange(after.lines, 1, after.lines.length)] : []
                diff = trimDiff(createTwoFilesPatch(filePath, finalPath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)))
                hashline = {
                  ...(hashline ?? {
                    schemaVersion: SCHEMA_VERSION,
                    displayAlgorithm: DISPLAY_ALGORITHM,
                    operations: deleted ? ["delete"] : [renamePath ? "rename" : "replace"],
                    filePath,
                    fileHashBefore: fileHash(contentOld),
                    beforeRanges: beforeLines.length ? [hashlineRange(beforeLines, 1, beforeLines.length)] : [],
                  }),
                  fileHashAfter: fileHash(contentNew),
                  formatterTouched,
                  afterRanges: afterRangeList,
                  diffHunks: [
                    {
                      beforeLineIDs: beforeLines.length ? rangeIDs(beforeLines, 1, beforeLines.length) : [],
                      afterLineIDs: after.lines.length ? rangeIDs(after.lines, 1, after.lines.length) : [],
                      diffHash: diffHash(diff),
                    },
                  ],
                }
              }),
            ),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: finalPath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
              changeID,
              hashline,
            },
          })

          const after = splitText(contentNew)
          const afterRangeList = (hashline?.afterRanges as ReturnType<typeof afterRanges> | undefined) ?? []
          const afterRange = afterRangeList[0]
          const changedBlock = afterRange ? formatChangedBlock(after.lines, afterRange.startLine, afterRange.endLine) : "Changed lines after edit: none"
          let output = [
            deleted ? "File deleted successfully." : "Edit applied successfully.",
            "",
            "Change:",
            `- changeID: ${changeID}`,
            "",
            "Resolved target:",
            `- before: ${targetRange(path.relative(displayRoot, filePath), (hashline?.beforeRanges as ReturnType<typeof beforeRanges> | undefined) ?? [])}`,
            `- after: ${targetRange(path.relative(displayRoot, finalPath), afterRangeList)}`,
            "",
            changedBlock,
          ].join("\n")
          if (!deleted) yield* lsp.touchFile(finalPath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const diagnosticCount = Chimera.countOracleDiagnostics(diagnostics)
          yield* Chimera.recordToolOracle({
            kind: "lsp",
            toolID: "edit",
            ctx,
            status: diagnosticCount === 0 ? "pass" : "fail",
            payload: {
              lsp: {
                diagnostics,
                files: [finalPath],
                diagnosticCount,
              },
            },
          }).pipe(Effect.ignore)
          const normalizedFilePath = AppFileSystem.normalizePath(finalPath)
          const block = LSP.Diagnostic.report(finalPath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
              changeID,
              hashline,
            },
            title: `${path.relative(displayRoot, finalPath)}`,
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const headerEndIndex = lines.findIndex((line) => line.startsWith("@@"))
  if (headerEndIndex === -1) return diff.trim()
  return lines.slice(headerEndIndex).join("\n").trim()
}
