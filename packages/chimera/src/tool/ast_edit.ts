import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./ast_edit.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { Snapshot } from "@/snapshot"
import { Chimera, type ProjectGraphState } from "@/chimera"
import { inlinePropagationCheck } from "@/chimera/propagation-probe"
import { GraphSchemaMigrationRequiredError, isInitialized, type Node as CodeGraphNode } from "@/graph"
import type { CodeGraphAdapter } from "@/chimera/codegraph-adapter"
import { trimDiff } from "./edit"
import { formatChangedBlock } from "./hashline"
import { ulid } from "ulid"

const Operation = Schema.Struct({
  ref: Schema.String.annotate({
    description:
      "Graph node ref 'node:<id>' (the Ref: line emitted by chimera_search / chimera_file_symbols / chimera_impact)",
  }),
  op: Schema.Union([
    Schema.Literal("replace"),
    Schema.Literal("delete"),
    Schema.Literal("insert_before"),
    Schema.Literal("insert_after"),
  ]).annotate({ description: "Structural operation anchored to the ref'd syntax node" }),
  content: Schema.optional(Schema.String).annotate({
    description:
      "Verbatim replacement/insert text, correctly indented, WITHOUT a trailing newline. Required for replace/insert_before/insert_after; forbidden for delete.",
  }),
})

export const Parameters = Schema.Struct({
  file: Schema.String.annotate({
    description: "Absolute or project-relative path of the target file. All refs in one call must resolve to nodes in this file.",
  }),
  edits: Schema.Array(Operation).annotate({ description: "AST-anchored edits to apply to this one file" }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type EditInput = Schema.Schema.Type<typeof Operation>
type AstOp = "replace" | "delete" | "insert_before" | "insert_after"

type FileText = {
  text: string
  /** newline-split content lines (includes the trailing empty sentinel for files ending with a newline) */
  lines: string[]
  /** starts[i] = character offset where line i+1 begins; a trailing sentinel equals text.length */
  starts: number[]
}

/**
 * The pre-sync identity of a stale ref: the graph record captured before the
 * file was re-extracted, plus its enclosing-parent chain (kind:name hops via
 * `contains` edges). Node ids embed the declaration start line, so a shifted
 * line changes the id; the identity triple survives and drives relocation.
 */
type RefIdentity = {
  node: CodeGraphNode
  chain: string[]
}

type Planned = {
  index: number
  refID: string
  op: AstOp
  node: CodeGraphNode
  relocated: boolean
  /** relocation note, present only when relocated */
  note: string
  /** splice range; zero-length for insert ops */
  start: number
  end: number
  /** splice offset: range start for replace/delete, boundary point for inserts */
  point: number
  isInsert: boolean
  /** text written at the splice point ("" for delete) */
  payload: string
}

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n")

function fileText(text: string): FileText {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return { text, lines: text.split(/\r?\n/), starts }
}

/** character offset where `line` (1-based) begins; clamps past EOF to text length */
function lineStart(file: FileText, line: number) {
  if (line <= 1) return 0
  return file.starts[line - 1] ?? file.text.length
}

/** offset just after the last content character of `line`, excluding its newline */
function lineContentEnd(file: FileText, line: number) {
  const next = file.starts[line] ?? file.text.length
  if (file.text.charCodeAt(next - 1) === 10) {
    const eol = file.text.charCodeAt(next - 2) === 13 ? 2 : 1
    return Math.max(lineStart(file, line), next - eol)
  }
  return next
}

function lineOfOffset(file: FileText, offset: number) {
  let line = 1
  while (line < file.starts.length && file.starts[line] <= offset) line++
  return line
}

function rangeLines(file: FileText, start: number, end: number) {
  return { startLine: lineOfOffset(file, start), endLine: lineOfOffset(file, Math.max(start, end - 1)) }
}

function nodeLinesValid(file: FileText, node: CodeGraphNode) {
  return node.startLine >= 1 && node.endLine >= node.startLine && node.endLine <= file.starts.length
}

/**
 * Convert a graph node's 1-based line / 0-based UTF-16-column range into a
 * splice range on the current text. Multi-line nodes snap to whole lines
 * (their own leading indentation is consumed); single-line nodes keep exact
 * column boundaries unless the column prefix is pure indentation.
 */
function nodeSpliceRange(file: FileText, node: CodeGraphNode) {
  const s = node.startLine
  const e = node.endLine
  const multi = e > s
  const firstLineStart = lineStart(file, s)
  const rawStart = multi ? firstLineStart : Math.min(firstLineStart + node.startColumn, lineContentEnd(file, s))
  const start = !multi && file.text.slice(firstLineStart, rawStart).trim() === "" ? firstLineStart : rawStart
  const end = multi ? lineContentEnd(file, e) : Math.min(lineStart(file, s) + node.endColumn, lineContentEnd(file, s))
  if (end < start) return { start, end: start }
  return { start, end }
}

function kindFromNodeID(id: string) {
  const separator = id.indexOf(":")
  return separator > 0 ? id.slice(0, separator) : undefined
}

function parseNodeRef(ref: string) {
  const value = ref.trim()
  if (!value.startsWith("node:")) {
    throw new Error(
      `ast_edit: invalid ref "${ref}". Pass the typed node ref from graph tool output, formatted as node:<id> (see the "Ref:" lines from chimera_search / chimera_file_symbols / chimera_impact).`,
    )
  }
  const id = value.slice("node:".length)
  if (!id) throw new Error(`ast_edit: invalid ref "${ref}" — no node id after "node:".`)
  return id
}

function parentChain(graph: CodeGraphAdapter, startID: string) {
  const chain: string[] = []
  let current = startID
  for (let depth = 0; depth < 3; depth++) {
    const parentID = graph.incomingEdges(current, ["contains"])[0]?.source
    const parent = parentID ? graph.node(parentID) : undefined
    if (!parent) break
    chain.push(`${parent.kind}:${parent.name}`)
    if (parent.kind === "file") break
    current = parent.id
  }
  return chain
}

function formatCandidate(node: CodeGraphNode) {
  const signature = node.signature ? node.signature.split(/\r?\n/)[0] : undefined
  return `- node:${node.id}  ${node.kind} ${node.name} (lines ${node.startLine}-${node.endLine})${signature ? `  ${signature}` : ""}`
}

function candidatesInFile(graph: CodeGraphAdapter, graphPath: string, kind?: string, name?: string) {
  const nodes = graph.nodesInFile(graphPath)
  if (!kind) return nodes.filter((node) => node.kind !== "file")
  return nodes.filter((node) => node.kind === kind && (!name || node.name === name))
}

function candidateList(graph: CodeGraphAdapter, graphPath: string, kind?: string, name?: string) {
  const all = graph.nodesInFile(graphPath).filter((node) => node.kind !== "file")
  const byKind = kind ? all.filter((node) => node.kind === kind) : []
  const byName = kind && name ? byKind.filter((node) => node.name === name) : []
  const pool = byName.length > 0 ? byName : byKind.length > 0 ? byKind : all
  const label = byName.length > 0 ? `${kind} ${name}` : byKind.length > 0 ? `${kind}` : "indexed symbol"
  const header =
    pool.length > 0
      ? `Current ${label} candidates in ${graphPath}:`
      : `${graphPath} has no indexed symbols (unsupported, excluded, or unindexed file). Use the edit tool instead.`
  const lines = pool.slice(0, 20).map(formatCandidate)
  return [header, ...lines, ...(pool.length > 20 ? [`- ... ${pool.length - 20} more`] : [])].join("\n")
}

/**
 * Resolve one ref to a live graph node in the target file. Push philosophy: a
 * stale ref is re-anchored automatically by symbol identity (kind + name,
 * disambiguated by the enclosing-parent chain) against the freshly synced
 * graph, and the relocation is reported. Only genuinely gone or ambiguous
 * nodes fail — and the error carries the fresh candidate list inline so the
 * caller can pick a ref without another search round-trip.
 */
function resolveTarget(
  state: ProjectGraphState,
  graphPath: string,
  refID: string,
  identity: RefIdentity | undefined,
  file: FileText,
): { node: CodeGraphNode; relocated: boolean; note: string } {
  const graph = state.graph
  const live = graph.node(refID)
  if (live && live.filePath !== graphPath) {
    throw new Error(`ast_edit: ref node:${refID} belongs to ${live.filePath}, but this call targets ${graphPath}. Keep every ref in a single file.`)
  }
  if (identity && identity.node.filePath !== graphPath) {
    throw new Error(
      `ast_edit: ref node:${refID} resolves to ${identity.node.filePath} in the current graph, but this call targets ${graphPath}. Keep every ref in a single file.`,
    )
  }
  if (live && nodeLinesValid(file, live)) return { node: live, relocated: false, note: "" }

  const kind = identity?.node.kind ?? kindFromNodeID(refID)
  const name = identity?.node.name
  const oldRange = identity ? `lines ${identity.node.startLine}-${identity.node.endLine}` : "lines ?-?"
  const candidates = candidatesInFile(graph, graphPath, kind, name)
  const pool =
    candidates.length > 1 && identity ? candidates.filter((node) => parentChain(graph, node.id).join("/") === identity.chain.join("/")) : candidates
  const chosen = pool.length === 1 ? pool[0] : undefined
  if (chosen) {
    const note =
      identity && !live
        ? `relocated ${chosen.kind} ${chosen.name} (${oldRange} -> lines ${chosen.startLine}-${chosen.endLine}; node:${refID} -> node:${chosen.id})`
        : `re-anchored ${chosen.kind} ${chosen.name} (node:${refID} -> node:${chosen.id} lines ${chosen.startLine}-${chosen.endLine})`
    return { node: chosen, relocated: true, note }
  }
  if (candidates.length > 1) {
    throw new Error(
      [
        `ast_edit: ref node:${refID} (${kind ?? "node"}${name ? ` ${name}` : ""}) no longer resolves in ${graphPath} and relocation is ambiguous — ${candidates.length} candidate symbols remain (expected ${oldRange}).`,
        candidateList(graph, graphPath, kind, name),
        `Pick one candidate ref above and retry the ast_edit call with it.`,
      ].join("\n"),
    )
  }
  throw new Error(
    [
      `ast_edit: ref node:${refID} does not resolve — no ${name ? `${kind} named ${name}` : "symbol"}${kind && !name ? " matching the ref id kind" : ""} remains in ${graphPath} (expected ${oldRange}).`,
      candidateList(graph, graphPath, kind),
      `Pick one candidate ref above, or use the edit tool for text-anchored changes.`,
    ].join("\n"),
  )
}

function planEdit(
  state: ProjectGraphState,
  graphPath: string,
  edit: EditInput,
  index: number,
  identity: RefIdentity | undefined,
  file: FileText,
): Planned {
  const refID = parseNodeRef(edit.ref)
  if (edit.op === "delete") {
    if (edit.content !== undefined) {
      throw new Error(`ast_edit: op delete must not carry content (edit ${index + 1}, ref ${edit.ref}).`)
    }
  }
  if (edit.op === "replace") {
    if (edit.content === undefined) throw new Error(`ast_edit: op replace requires content (edit ${index + 1}, ref ${edit.ref}).`)
    if (edit.content === "") {
      throw new Error(`ast_edit: replace content must not be empty (edit ${index + 1}); use op delete to remove the node.`)
    }
  }
  if ((edit.op === "insert_before" || edit.op === "insert_after") && (edit.content === undefined || edit.content.trim() === "")) {
    throw new Error(`ast_edit: ${edit.op} requires non-blank content (edit ${index + 1}, ref ${edit.ref}).`)
  }
  const content = edit.content ?? ""
  const resolved = resolveTarget(state, graphPath, refID, identity, file)
  const isInsert = edit.op === "insert_before" || edit.op === "insert_after"
  const base = { index, refID, op: edit.op, node: resolved.node, relocated: resolved.relocated, note: resolved.note, isInsert }
  if (edit.op === "delete") {
    const range = nodeSpliceRange(file, resolved.node)
    let end = range.end
    // Whole-line deletes swallow the trailing newline so no blank line is left behind.
    const whole = range.start === lineStart(file, resolved.node.startLine) && end === lineContentEnd(file, resolved.node.endLine)
    if (whole) {
      if (file.text.charCodeAt(end) === 13 && file.text.charCodeAt(end + 1) === 10) end += 2
      else if (file.text.charCodeAt(end) === 10) end += 1
      // Deleting a block framed by blank separator lines on both sides swallows
      // the following blank line too, so the surviving separator stays singular.
      if (resolved.node.startLine >= 2 && file.lines[resolved.node.startLine - 2]?.trim() === "" && file.lines[resolved.node.endLine]?.trim() === "") {
        if (file.text.charCodeAt(end) === 13 && file.text.charCodeAt(end + 1) === 10) end += 2
        else if (file.text.charCodeAt(end) === 10) end += 1
      }
    }
    return { ...base, start: range.start, end, point: range.start, payload: "" }
  }
  if (edit.op === "replace") {
    const range = nodeSpliceRange(file, resolved.node)
    return { ...base, start: range.start, end: range.end, point: range.start, payload: content }
  }
  const eol = eolOf(file.text)
  const block = content.replace(/(?:\r\n|\r|\n)+$/, "")
  if (edit.op === "insert_before") {
    const point = lineStart(file, resolved.node.startLine)
    return { ...base, start: point, end: point, point, payload: block + eol }
  }
  const anchorEnd = lineStart(file, resolved.node.endLine + 1)
  const needsLead = anchorEnd >= file.text.length && file.text.length > 0 && file.text.charCodeAt(file.text.length - 1) !== 10
  return { ...base, start: anchorEnd, end: anchorEnd, point: anchorEnd, payload: (needsLead ? eol : "") + block + eol }
}

function checkOverlaps(plans: Planned[], graphPath: string) {
  const conflicts: string[] = []
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i]
      const b = plans[j]
      const clash = a.isInsert ? (b.isInsert ? false : b.start < a.point && a.point < b.end) : b.isInsert ? a.start < b.point && b.point < a.end : a.start < b.end && b.start < a.end
      if (clash) {
        conflicts.push(
          `edit ${i + 1} (${a.op} ${a.node.kind} ${a.node.name}, lines ${a.node.startLine}-${a.node.endLine}) conflicts with edit ${j + 1} (${b.op} ${b.node.kind} ${b.node.name}, lines ${b.node.startLine}-${b.node.endLine})`,
        )
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `ast_edit: overlapping edits are rejected for ${graphPath}; split conflicting edits into separate calls:\n${conflicts.map((line) => `- ${line}`).join("\n")}`,
    )
  }
}

/**
 * Apply all splices in reverse document order (higher offsets first, so each
 * applied splice never disturbs the offsets of the ones still pending). At an
 * identical offset: range edits apply before point inserts (the insert lands
 * in front of the replacement), and multiple inserts keep their given order.
 */
function applySplices(file: FileText, plans: Planned[]) {
  const ordered = plans.toSorted(
    (a, b) => b.point - a.point || Number(a.isInsert) - Number(b.isInsert) || b.index - a.index,
  )
  let text = file.text
  for (const plan of ordered) {
    text = text.slice(0, plan.start) + plan.payload + text.slice(plan.end)
  }
  const final = fileText(text)
  const deltas = plans.map((plan) => ({ point: plan.point, isInsert: plan.isInsert, index: plan.index, value: plan.payload.length - (plan.end - plan.start) }))
  const appliedAfter = (self: { point: number; isInsert: boolean; index: number }, other: { point: number; isInsert: boolean; index: number }) =>
    other.point < self.point ||
    (other.point === self.point &&
      (self.isInsert
        ? other.isInsert && other.index < self.index
        : other.isInsert))
  const spans = new Map<number, { startLine: number; endLine: number }>()
  for (const plan of plans) {
    const self = { point: plan.point, isInsert: plan.isInsert, index: plan.index }
    const shift = deltas.reduce((sum, other, otherIndex) => (otherIndex === plan.index ? sum : appliedAfter(self, other) ? sum + other.value : sum), 0)
    if (plan.op === "delete") {
      const at = lineOfOffset(final, plan.start + shift)
      spans.set(plan.index, { startLine: at, endLine: at })
      continue
    }
    if (plan.isInsert) {
      const at = lineOfOffset(final, plan.point + shift)
      spans.set(plan.index, { startLine: at, endLine: at })
      continue
    }
    const start = plan.start + shift
    spans.set(plan.index, rangeLines(final, start, start + plan.payload.length))
  }
  return { text, spans }
}

/**
 * After the write, the graph is re-synced (inside trackToolMutation). Node ids
 * embed the declaration start line, so ids shift whenever the symbol moved;
 * re-anchor edited symbols by identity (kind+name, line-window tie-break) to
 * hand back fresh refs that follow-up ast_edit calls can chain from.
 */
function freshRefs(state: ProjectGraphState, graphPath: string, plans: Planned[], spans: Map<number, { startLine: number; endLine: number }>) {
  const fresh = new Map<number, string>()
  for (const plan of plans) {
    if (plan.op === "delete") continue
    if (state.graph.node(plan.node.id)) {
      fresh.set(plan.index, plan.node.id)
      continue
    }
    const candidates = candidatesInFile(state.graph, graphPath, plan.node.kind, plan.node.name)
    const span = spans.get(plan.index)
    const hit =
      candidates.length === 1
        ? candidates[0]
        : span
          ? candidates.find((node) => node.startLine >= span.startLine - 1 && node.startLine <= span.endLine + 1)
          : undefined
    if (hit) fresh.set(plan.index, hit.id)
  }
  return fresh
}

export const AstEditTool = Tool.define(
  "ast_edit",
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
          if (params.edits.length === 0) throw new Error("ast_edit requires at least one edit.")
          const filePath = AppFileSystem.resolve(
            path.isAbsolute(params.file) ? params.file : path.join(instance.directory, params.file),
          )
          yield* assertExternalDirectoryEffect(ctx, filePath)
          const displayRoot = instance.worktree === "/" ? instance.directory : instance.worktree
          if (!isInitialized(displayRoot)) {
            throw new Error(
              `ast_edit: the Chimera graph surface is not initialized for this project, so node refs are unavailable. ` +
                `Ask the user to run 'chimera graph init' then 'chimera graph index' (or call chimera_init_graph if that tool is available to you), ` +
                `or use the edit tool for text-anchored changes instead.`,
            )
          }
          const changeID = `chg_${ulid()}`

          const predesign = yield* Chimera.requirePredesignForMutation({
            toolID: "ast_edit",
            ctx,
            files: [filePath],
          })
          if (!predesign.allowed) return predesign.result

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let formatterTouched = false

          const outcome = yield* Chimera.withProjectGraph(
            { watch: false },
            (state) =>
              Effect.gen(function* () {
                const relative = path.relative(state.projectRoot, filePath).replaceAll("\\", "/")
                if (relative.startsWith("..") || path.isAbsolute(relative)) {
                  throw new Error(
                    `ast_edit: ${filePath} lies outside the graph project root ${state.projectRoot}; node refs cannot resolve. Use the edit tool instead.`,
                  )
                }
                const exists = yield* afs.existsSafe(filePath)
                if (!exists) {
                  throw new Error(`ast_edit: file ${relative} does not exist. Use the write tool to create files; ast_edit only edits existing files that the graph can index.`)
                }

                // Pre-sync identities: a stale ref id still resolves in the
                // un-synced graph when the file moved externally, giving the
                // kind/name/parent-chain anchors that survive the sync rewrite.
                const identities = params.edits.map((edit) => {
                  const node = state.graph.node(parseNodeRef(edit.ref))
                  return node ? { node, chain: parentChain(state.graph, node.id) } : undefined
                })

                yield* Effect.promise(() => state.graph.syncFiles([filePath]))
                const source = yield* Bom.readFile(afs, filePath)
                contentOld = source.text
                const file = fileText(source.text)

                const plans = params.edits.map((edit, index) => planEdit(state, relative, edit, index, identities[index], file))
                checkOverlaps(plans, relative)

                const applied = yield* Chimera.trackToolMutation(
                  {
                    toolID: "ast_edit",
                    ctx,
                    files: [filePath],
                    bus,
                    metadata: () => ({
                      create: false,
                      filePath,
                      diff,
                      changeID,
                      astEdit: {
                        schemaVersion: 1,
                        edits: plans.map((plan) => ({
                          op: plan.op,
                          ref: `node:${plan.refID}`,
                          appliedRef: `node:${plan.node.id}`,
                          kind: plan.node.kind,
                          name: plan.node.name,
                          relocated: plan.relocated,
                        })),
                      },
                    }),
                  },
                  Effect.gen(function* () {
                    const spliced = applySplices(file, plans)
                    contentNew = spliced.text
                    if (contentOld === contentNew) throw new Error("No changes to apply: ast_edit splices are a no-op.")
                    diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
                    yield* ctx.ask({
                      permission: "edit",
                      patterns: [path.relative(displayRoot, filePath)],
                      always: ["*"],
                      metadata: {
                        filepath: filePath,
                        diff,
                      },
                    })
                    const next = Bom.split(contentNew)
                    const desiredBom = source.bom || next.bom
                    yield* afs.writeWithDirs(filePath, Bom.join(next.text, desiredBom))
                    formatterTouched = yield* format.file(filePath)
                    if (formatterTouched) contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                    yield* bus.publish(File.Event.Edited, { file: filePath })
                    yield* bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
                    return spliced
                  }),
                )

                // trackToolMutation re-synced the file after the write; the DB
                // nodes now describe the final content.
                const fresh = freshRefs(state, relative, plans, applied.spans)
                return { plans, spans: applied.spans, fresh }
              }),
          ).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof GraphSchemaMigrationRequiredError
                ? Effect.fail(
                    new Error(
                      `ast_edit: ${defect.message} — ask the user to run 'chimera graph index' in this project to migrate the graph, or use the edit tool meanwhile.`,
                    ),
                  )
                : Effect.die(defect),
            ),
            Effect.orDie,
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          const results = outcome.plans.map((plan) => ({
            op: plan.op,
            ref: `node:${plan.refID}`,
            kind: plan.node.kind,
            name: plan.node.name,
            beforeLines: { startLine: plan.node.startLine, endLine: plan.node.endLine },
            afterLines: outcome.spans.get(plan.index),
            relocated: plan.relocated,
            freshRef: outcome.fresh.get(plan.index) ? `node:${outcome.fresh.get(plan.index)}` : undefined,
          }))

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              changeID,
              astEdit: { schemaVersion: 1, results },
            },
          })

          const final = fileText(contentNew)
          const windowStart = outcome.plans.reduce((min, plan) => Math.min(min, outcome.spans.get(plan.index)?.startLine ?? plan.node.startLine), final.lines.length)
          const windowEnd = outcome.plans.reduce((max, plan) => Math.max(max, outcome.spans.get(plan.index)?.endLine ?? plan.node.endLine), 1)
          let output = [
            "AST edit applied successfully.",
            "",
            "Change:",
            `- changeID: ${changeID}`,
            "",
            "Applied edits:",
            ...outcome.plans.map((plan) => {
              const span = outcome.spans.get(plan.index)
              const where =
                plan.op === "delete"
                  ? `was lines ${plan.node.startLine}-${plan.node.endLine}`
                  : span
                    ? `now lines ${span.startLine}-${span.endLine}`
                    : `lines ${plan.node.startLine}-${plan.node.endLine}`
              const fresh = outcome.fresh.get(plan.index)
              const verb =
                plan.op === "replace" ? "replaced" : plan.op === "delete" ? "deleted" : plan.op === "insert_before" ? "inserted before" : "inserted after"
              return [`- ${verb} ${plan.node.kind} ${plan.node.name} (${where})`, fresh ? `  ref: node:${fresh}` : undefined]
                .filter(Boolean)
                .join("\n")
            }),
          ].join("\n")

          const relocations = outcome.plans.filter((plan) => plan.relocated).map((plan) => plan.note)
          if (relocations.length > 0) {
            output += `\n\nSelf-healed refs:\n${relocations.map((note) => `- ${note}`).join("\n")}`
          }
          if (final.lines.length > 0 && windowEnd >= windowStart) {
            output += `\n\n${formatChangedBlock(final.lines, windowStart, windowEnd)}`
          }

          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const diagnosticCount = Chimera.countOracleDiagnostics(diagnostics)
          yield* Chimera.recordToolOracle({
            kind: "lsp",
            toolID: "ast_edit",
            ctx,
            status: diagnosticCount === 0 ? "pass" : "fail",
            payload: {
              lsp: {
                diagnostics,
                files: [filePath],
                diagnosticCount,
              },
            },
          }).pipe(Effect.ignore)
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          const ranges = outcome.plans.map((plan) => ({ startLine: plan.node.startLine, endLine: plan.node.endLine }))
          output += `\n\n${yield* inlinePropagationCheck([{ file: filePath, ranges }], ctx.sessionID)}`

          return {
            title: path.relative(displayRoot, filePath),
            output,
            metadata: {
              diagnostics,
              diff,
              filediff,
              changeID,
              astEdit: {
                schemaVersion: 1,
                results,
                relocations,
                formatterTouched,
              },
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
