import * as path from "path"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./ast_edit.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { Ripgrep } from "../file/ripgrep"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { Snapshot } from "@/snapshot"
import { Chimera, type ProjectGraphState } from "@/chimera"
import { inlinePropagationCheck } from "@/chimera/propagation-probe"
import { GraphSchemaMigrationRequiredError, isInitialized, type Node as CodeGraphNode } from "@/graph"
import type { CodeGraphAdapter } from "@/chimera/codegraph-adapter"
import { detectLanguage, hasTreeSitterGrammar } from "@/graph/extraction/grammars"
import { MAX_SOURCE_FILE_SIZE_BYTES } from "@/graph/file-limits"
import type { Node as SyntaxNode } from "@/graph/web-tree-sitter-types"
import {
  applyReplacements,
  compilePattern,
  ensureGrammarLoaded,
  findMatchesInTree,
  parseSource,
  renderTemplateReplacement,
  type CompileResult,
} from "@/graph/pattern"
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

const Rewrite = Schema.Struct({
  pattern: Schema.String.annotate({
    description:
      "Structural pattern that must parse as ONE ast node: $NAME captures one node, $_ matches any node without capturing it, $$$NAME matches zero or more siblings. Names are UPPERCASE whole-node placeholders; a name repeated in the pattern must match identical code."
  }),
  replacement: Schema.String.annotate({
    description:
      "Text written in place of EVERY match, with the pattern's metavariables spliced back in (console.log($$$ARGS) -> logger.info($$$ARGS)). Multi-line captures are re-indented to the match. An empty string deletes each matched node."
  }),
})

export const Parameters = Schema.Struct({
  file: Schema.optional(Schema.String).annotate({
    description:
      "Absolute or project-relative path of the one target file. Ref mode requires it; in pattern mode it is the single-file addressing sugar.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Pattern mode only: files, directories, or globs (each entry) addressed by one atomic multi-file codemod, max 100 files per call. Exactly one of file / paths in a pattern call; paths never mixes with edits.",
  }),
  edits: Schema.optional(Schema.Array(Operation)).annotate({
    description: "Ref mode: AST-anchored edits resolved through graph node refs. Provide edits OR rewrites, never both in one call.",
  }),
  rewrites: Schema.optional(Schema.Array(Rewrite)).annotate({
    description: "Pattern mode: structural codemod rewrites applied to every match in the addressed file(s) (`file` or `paths`); needs no graph. Provide rewrites OR edits, never both in one call.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type EditInput = Schema.Schema.Type<typeof Operation>
type AstOp = "replace" | "delete" | "insert_before" | "insert_after"
type RewriteInput = Schema.Schema.Type<typeof Rewrite>

/** A call is exactly one of the two addressing modes. */
type Mode =
  | { kind: "refs"; edits: readonly EditInput[] }
  | { kind: "patterns"; rewrites: readonly RewriteInput[] }

/**
 * Fully resolved call: ref mode is always single-file; pattern mode takes
 * either one explicit `file` (strict semantics) or `paths` (multi-file
 * codemod semantics).
 */
type Resolved =
  | { kind: "refs"; file: string; edits: readonly EditInput[] }
  | { kind: "pattern-file"; file: string; rewrites: readonly RewriteInput[] }
  | { kind: "pattern-paths"; paths: readonly string[]; rewrites: readonly RewriteInput[] }

/** One {pattern, replacement} codemod rewrite and what it matched. */
type RewritePlan = {
  index: number
  pattern: string
  replacement: string
  render: "delete" | "template"
  matches: number
}

/** A pending pattern-mode splice, tagged with the rewrite that produced it. */
type PatternSplice = {
  rewrite: number
  start: number
  end: number
  replacement: string
}

type FileText = {
  text: string
  /** newline-split content lines (includes the trailing empty sentinel for files ending with a newline) */
  lines: string[]
  /** starts[i] = character offset where line i+1 begins; a trailing sentinel equals text.length */
  starts: number[]
}

/** One addressed file's before/after state, carried through the shared commit path. */
type TouchedFile = {
  filePath: string
  relative: string
  hadBom: boolean
  contentOld: string
  contentNew: string
  diff: string
  formatterTouched: boolean
  /** pre-write line ranges the propagation probe seeds from */
  probe: { startLine: number; endLine: number }[]
}

/** A rewrite plan annotated with how many collapsed splices the file actually applies. */
type AppliedRewrite = RewritePlan & { applied: number }

/** Per-file skip/no-match report for a multi-file pattern-mode call. */
type FileReport = {
  file: string
  language: string
  status: "skipped" | "unmatched"
  reason: string
  rewrites: AppliedRewrite[]
}

/**
 * A file whose splices are fully computed for a multi-file pattern-mode call —
 * computed before anything is written, so one file's conflict can fail the whole
 * call atomically.
 */
type PlannedFile = {
  filePath: string
  relative: string
  language: string
  text: string
  bom: boolean
  edits: PatternSplice[]
  finalText: string
  plans: AppliedRewrite[]
  probe: { startLine: number; endLine: number }[]
}

/** What analyzing one addressed file of a multi-file pattern-mode call produced. */
type PlanResult =
  | { kind: "planned"; file: PlannedFile }
  | { kind: "skipped"; report: FileReport }
  | { kind: "conflict"; file: { relative: string; conflicts: string[] } }

/** A multi-file pattern-mode run either stops at the predesign gate or yields its outcome. */
type ModeRun =
  | { blocked: true; result: Tool.ExecuteResult }
  | { blocked: false; outcome: ModeOutcome }

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

/** Maximum files one pattern-mode `paths` call may address. */
const MAX_PATTERN_FILES = 100

/** Glob magic that routes a `paths` entry through discovery instead of a direct stat. */
const GLOB_MAGIC = /[*?[\]{}]/
const NODE_MODULES_SEGMENT = /(^|[\\/])node_modules([\\/]|$)/

/**
 * Whether decoded content smells binary: NUL bytes in the head, or a
 * file-limits-style share of non-whitespace control bytes — compressed payload
 * like the MPEG-TS clips that squat the `.ts` extension, or the replacement
 * characters a lossy UTF-8 decode of arbitrary bytes produces.
 */
function looksBinary(text: string) {
  const head = text.slice(0, 8192)
  if (head.includes("\u0000")) return true
  let control = 0
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i)
    if ((code < 0x20 && (code < 0x09 || code > 0x0d)) || code === 0xfffd) control++
  }
  return head.length > 0 && control >= head.length / 64
}

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

/**
 * A call addresses the file either by graph refs (`edits`) or by structural
 * patterns (`rewrites`) — never both, so the two modes never compete over one
 * splice and the error surface stays unambiguous.
 */
function resolveMode(params: Params): Mode {
  const edits = params.edits
  const rewrites = params.rewrites
  if (edits !== undefined && rewrites !== undefined) {
    throw new Error(
      `ast_edit: one mode per call — this call passed both edits (${edits.length}) and rewrites (${rewrites.length}). Split it into a ref-mode call (edits) and a pattern-mode call (rewrites).`,
    )
  }
  if (edits !== undefined) {
    if (edits.length === 0) throw new Error("ast_edit requires at least one edit.")
    return { kind: "refs", edits }
  }
  if (rewrites !== undefined) {
    if (rewrites.length === 0) throw new Error("ast_edit requires at least one rewrite.")
    return { kind: "patterns", rewrites }
  }
  throw new Error(
    "ast_edit: no mode given — pass edits: [{ ref, op, content? }] for graph-ref mode, or rewrites: [{ pattern, replacement }] for pattern-codemod mode (exactly one of the two per call).",
  )
}

/**
 * Resolve mode and addressing in one discriminated result: pattern mode
 * addresses its files either with one explicit `file` or with `paths`
 * (files, directories, globs) — never both, so the addressing is
 * unambiguous. Ref mode never multi-files: every ref must resolve inside
 * the one file named by `file`.
 */
function resolveCall(params: Params): Resolved {
  const mode = resolveMode(params)
  if (mode.kind === "refs") {
    if (params.paths !== undefined && params.paths.length > 0) {
      throw new Error(
        "ast_edit: `paths` is pattern-mode only — ref mode edits one file per call via `file`; split ref work into one call per file.",
      )
    }
    if (!params.file) {
      throw new Error("ast_edit: ref mode requires `file` — every edit ref resolves inside that single file.")
    }
    return { kind: "refs", file: params.file, edits: mode.edits }
  }
  if (params.file && params.paths !== undefined && params.paths.length > 0) {
    throw new Error(
      "ast_edit: pattern mode takes exactly one of `file` (single file) or `paths` (multi-file codemod) — this call passed both.",
    )
  }
  if (params.file) return { kind: "pattern-file", file: params.file, rewrites: mode.rewrites }
  if (params.paths !== undefined && params.paths.length > 0)
    return { kind: "pattern-paths", paths: params.paths, rewrites: mode.rewrites }
  throw new Error(
    "ast_edit: no addressing given for the pattern rewrites — pass `file` for one file or `paths` (files, directories, or globs, max 100 files) for a multi-file codemod.",
  )
}

/**
 * 1-based lines carrying tree-sitter ERROR or MISSING nodes, capped at `limit`
 * for a short refusal message. An error node's own subtree is noise, so the
 * walk does not descend past it.
 */
function syntaxErrorLines(node: SyntaxNode, limit: number, into: number[] = []): number[] {
  if (into.length >= limit) return into
  if (node.isError || node.isMissing) {
    const line = node.startPosition.row + 1
    if (!into.includes(line)) into.push(line)
    return into
  }
  for (const child of node.children) syntaxErrorLines(child, limit, into)
  return into
}

function spliceLabel(splice: PatternSplice, plans: RewritePlan[], file: FileText) {
  const lines = rangeLines(file, splice.start, splice.end)
  return `rewrite ${splice.rewrite + 1} "${plans[splice.rewrite].pattern}" (lines ${lines.startLine}-${lines.endLine})`
}

/**
 * Collapse byte-identical matches (two rewrites spelling the same fix on the
 * same span keep one, attributed to the first rewrite in call order), then
 * compute remaining overlaps with the same strictness as ref mode: touching
 * spans are fine, nested or equal-but-different spans are not. Sweeping the
 * start-sorted list against the widest end seen so far catches a match that
 * contains several others, which adjacent-only comparison would miss.
 * Single-file callers reject conflicts through collapsePatternEdits; multi-file
 * callers collect them into an atomic no-write failure.
 */
function collapseSplices(splices: PatternSplice[], plans: RewritePlan[], file: FileText) {
  const unique = new Map<string, PatternSplice>()
  for (const splice of splices) {
    const key = `${splice.start}\u0000${splice.end}\u0000${splice.replacement}`
    if (!unique.has(key)) unique.set(key, splice)
  }
  const ordered = [...unique.values()].toSorted((a, b) => a.start - b.start || a.end - b.end)
  const conflicts: string[] = []
  let widest: PatternSplice | undefined
  for (const splice of ordered) {
    if (widest && splice.start < widest.end)
      conflicts.push(`${spliceLabel(splice, plans, file)} overlaps ${spliceLabel(widest, plans, file)}`)
    if (!widest || widest.end < splice.end) widest = splice
  }
  return { ordered, conflicts }
}

function collapsePatternEdits(splices: PatternSplice[], plans: RewritePlan[], file: FileText, relative: string) {
  const { ordered, conflicts } = collapseSplices(splices, plans, file)
  if (conflicts.length > 0) {
    throw new Error(
      `ast_edit: overlapping pattern matches in ${relative}; split the rewrites into separate calls or narrow the patterns so they never match nested ranges:\n${conflicts.map((line) => `- ${line}`).join("\n")}`,
    )
  }
  return ordered
}

type ModeOutcome = {
  /** mode-specific bullet block, appended under the shared success header */
  head: string
  /** extra section (ref-mode self-heal notes); "" when there is none */
  notes: string
  /** post-write content lines, for the changed-block window */
  newLines: string[]
  windowStart: number
  windowEnd: number
  /** before/after state of every file this call wrote (one entry per file) */
  touched: TouchedFile[]
  /** ast_edit payload published mid-call through ctx.metadata */
  liveMetadata: Record<string, unknown>
  /** ast_edit payload on the returned result; the tail adds formatterTouched */
  metadata: Record<string, unknown>
}

export const AstEditTool = Tool.define(
  "ast_edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const call = resolveCall(params)
          const displayRoot = instance.worktree === "/" ? instance.directory : instance.worktree
          const changeID = `chg_${ulid()}`

          /**
           * Render the diff for one addressed file. Called before the permission
           * ask so the diff shown always matches what will be written.
           */
          const stage = (rec: TouchedFile, text: string) => {
            rec.contentNew = text
            rec.diff = trimDiff(createTwoFilesPatch(rec.filePath, rec.filePath, rec.contentOld, text))
          }

          /**
           * Per-file half of the shared commit path: BOM-preserving write,
           * formatter, File/FileWatcher bus events. Single-file calls run it
           * under their per-file permission ask; the multi-file call asks once
           * for the whole set and then loops this over every changed file.
           */
          const writeFormatted = (rec: TouchedFile) =>
            Effect.gen(function* () {
              const next = Bom.split(rec.contentNew)
              const desiredBom = rec.hadBom || next.bom
              yield* afs.writeWithDirs(rec.filePath, Bom.join(next.text, desiredBom))
              rec.formatterTouched = yield* format.file(rec.filePath)
              if (rec.formatterTouched) rec.contentNew = yield* Bom.syncFile(afs, rec.filePath, desiredBom)
              yield* bus.publish(File.Event.Edited, { file: rec.filePath })
              yield* bus.publish(FileWatcher.Event.Updated, { file: rec.filePath, event: "change" })
            })

          /**
           * Write one file and ride the shared single-file mutation side
           * effects: no-op guard, permission ask, BOM-preserving write,
           * formatter, File/FileWatcher bus events. Both single-file modes
           * call it inside their own trackToolMutation so the provenance
           * record is identical.
           */
          const commit = (rec: TouchedFile, text: string, noOp: string) =>
            Effect.gen(function* () {
              if (text === rec.contentOld) throw new Error(noOp)
              stage(rec, text)
              yield* ctx.ask({
                permission: "edit",
                patterns: [rec.relative],
                always: ["*"],
                metadata: {
                  filepath: rec.filePath,
                  diff: rec.diff,
                },
              })
              yield* writeFormatted(rec)
            })

          const runRefMode = (edits: readonly EditInput[], filePath: string, rec: TouchedFile) =>
            Effect.gen(function* () {
              const planned = yield* Chimera.withProjectGraph(
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
                    const identities = edits.map((edit) => {
                      const node = state.graph.node(parseNodeRef(edit.ref))
                      return node ? { node, chain: parentChain(state.graph, node.id) } : undefined
                    })

                    yield* Effect.promise(() => state.graph.syncFiles([filePath]))
                    const source = yield* Bom.readFile(afs, filePath)
                    rec.contentOld = source.text
                    rec.hadBom = source.bom
                    const file = fileText(source.text)

                    const plans = edits.map((edit, index) => planEdit(state, relative, edit, index, identities[index], file))
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
                          diff: rec.diff,
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
                        yield* commit(rec, spliced.text, "No changes to apply: ast_edit splices are a no-op.")
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

              const results = planned.plans.map((plan) => ({
                op: plan.op,
                ref: `node:${plan.refID}`,
                kind: plan.node.kind,
                name: plan.node.name,
                beforeLines: { startLine: plan.node.startLine, endLine: plan.node.endLine },
                afterLines: planned.spans.get(plan.index),
                relocated: plan.relocated,
                freshRef: planned.fresh.get(plan.index) ? `node:${planned.fresh.get(plan.index)}` : undefined,
              }))
              const relocations = planned.plans.filter((plan) => plan.relocated).map((plan) => plan.note)
              const final = fileText(rec.contentNew)
              const windowStart = planned.plans.reduce((min, plan) => Math.min(min, planned.spans.get(plan.index)?.startLine ?? plan.node.startLine), final.lines.length)
              const windowEnd = planned.plans.reduce((max, plan) => Math.max(max, planned.spans.get(plan.index)?.endLine ?? plan.node.endLine), 1)
              rec.probe = planned.plans.map((plan) => ({ startLine: plan.node.startLine, endLine: plan.node.endLine }))

              return {
                head: [
                  "Applied edits:",
                  ...planned.plans.map((plan) => {
                    const span = planned.spans.get(plan.index)
                    const where =
                      plan.op === "delete"
                        ? `was lines ${plan.node.startLine}-${plan.node.endLine}`
                        : span
                          ? `now lines ${span.startLine}-${span.endLine}`
                          : `lines ${plan.node.startLine}-${plan.node.endLine}`
                    const fresh = planned.fresh.get(plan.index)
                    const verb =
                      plan.op === "replace" ? "replaced" : plan.op === "delete" ? "deleted" : plan.op === "insert_before" ? "inserted before" : "inserted after"
                    return [`- ${verb} ${plan.node.kind} ${plan.node.name} (${where})`, fresh ? `  ref: node:${fresh}` : undefined]
                      .filter(Boolean)
                      .join("\n")
                  }),
                ].join("\n"),
                notes:
                  relocations.length > 0 ? `Self-healed refs:\n${relocations.map((note) => `- ${note}`).join("\n")}` : "",
                newLines: final.lines,
                windowStart,
                windowEnd,
                touched: [rec],
                liveMetadata: { schemaVersion: 1, results },
                metadata: { schemaVersion: 1, results, relocations },
              } satisfies ModeOutcome
            })

          /**
           * Single-file pattern mode: one parse, every structural match rewritten
           * in a single splice pass. It deliberately needs no graph surface —
           * refs are not involved, so it runs the same pipeline in uninitialized
           * projects. Strict per-file semantics: syntax errors and uncompilable
           * patterns REFUSE the call; the lenient skip contract belongs to the
           * multi-file `paths` call.
           */
          const runPatternMode = (rewrites: readonly RewriteInput[], filePath: string, rec: TouchedFile) =>
            Effect.gen(function* () {
              const relative = rec.relative
              const exists = yield* afs.existsSafe(filePath)
              if (!exists) {
                throw new Error(`ast_edit: file ${relative} does not exist. Use the write tool to create files; ast_edit only edits existing files.`)
              }
              const source = yield* Bom.readFile(afs, filePath)
              rec.contentOld = source.text
              rec.hadBom = source.bom
              const file = fileText(source.text)
              const language = detectLanguage(filePath, source.text)
              if (!hasTreeSitterGrammar(language)) {
                throw new Error(
                  `ast_edit: pattern mode has no tree-sitter grammar for ${relative} (detected language "${language}"). Verified pattern languages: typescript, tsx, javascript, python (other languages the graph carries a grammar for are attempted as-is). Use the edit tool for this file.`,
                )
              }
              yield* Effect.promise(() => ensureGrammarLoaded(language))
              const tree = parseSource(language, source.text)
              if (!tree) {
                throw new Error(
                  `ast_edit: the ${language} grammar did not load, so ${relative} cannot be pattern-matched. Use the edit tool instead.`,
                )
              }

              const plans: RewritePlan[] = []
              const splices: PatternSplice[] = []
              try {
                const broken = syntaxErrorLines(tree.rootNode, 3)
                if (broken.length > 0) {
                  throw new Error(
                    `ast_edit: ${relative} has syntax errors (ERROR/MISSING nodes at lines ${broken.join(", ")}); pattern rewriting is unsafe here. Fix the file first, or use the edit tool for a text-anchored change.`,
                  )
                }
                for (const [index, rewrite] of rewrites.entries()) {
                  const compiled = compilePattern(rewrite.pattern, language)
                  if (!compiled.ok) {
                    throw new Error(`ast_edit: rewrite ${index + 1} is not a usable ${language} pattern — ${compiled.error.message}`)
                  }
                  const matches = findMatchesInTree(compiled.pattern, tree, source.text)
                  for (const match of matches) {
                    splices.push({
                      rewrite: index,
                      start: match.replacedRange.start,
                      end: match.replacedRange.end,
                      replacement:
                        rewrite.replacement === "" ? "" : renderTemplateReplacement(rewrite.replacement, match, source.text),
                    })
                  }
                  plans.push({
                    index,
                    pattern: rewrite.pattern,
                    replacement: rewrite.replacement,
                    render: rewrite.replacement === "" ? "delete" : "template",
                    matches: matches.length,
                  })
                }
              } finally {
                tree.delete()
              }

              const edits = collapsePatternEdits(splices, plans, file, relative)
              const summary = plans.map((plan) => ({
                ...plan,
                applied: edits.filter((edit) => edit.rewrite === plan.index).length,
              }))
              if (edits.length === 0) {
                throw new Error(
                  `No changes to apply: none of the ${summary.length} pattern(s) matched in ${relative}. A rewrite that matches nothing is fine on its own (it reports 0 replacements); this call matched nothing at all.`,
                )
              }
              const patternMetadata = { schemaVersion: 1, pattern: { language, rewrites: summary } }

              yield* Chimera.trackToolMutation(
                {
                  toolID: "ast_edit",
                  ctx,
                  files: [filePath],
                  bus,
                  metadata: () => ({
                    create: false,
                    filePath,
                    diff: rec.diff,
                    changeID,
                    astEdit: patternMetadata,
                  }),
                },
                Effect.gen(function* () {
                  yield* commit(
                    rec,
                    applyReplacements(source.text, edits),
                    "No changes to apply: ast_edit pattern rewrites are a no-op.",
                  )
                }),
              )

              // Offset every edit by the length change of the ones before it (the
              // engine splices left to right) to point at the written content.
              let shift = 0
              const final = fileText(rec.contentNew)
              const spans = edits.map((edit) => {
                const start = edit.start + shift
                shift += edit.replacement.length - (edit.end - edit.start)
                return rangeLines(final, start, start + edit.replacement.length)
              })

              rec.probe = edits.map((edit) => rangeLines(file, edit.start, edit.end))

              return {
                head: [
                  "Applied rewrites:",
                  ...summary.map((plan) => `- pattern "${plan.pattern}": ${plan.matches} replacement(s)`),
                ].join("\n"),
                notes: "",
                newLines: final.lines,
                windowStart: spans.reduce((min, span) => Math.min(min, span.startLine), final.lines.length),
                windowEnd: spans.reduce((max, span) => Math.max(max, span.endLine), 1),
                touched: [rec],
                liveMetadata: patternMetadata,
                metadata: patternMetadata,
              } satisfies ModeOutcome
            })

          /**
           * Expand `paths` entries — files, directories, or globs — into concrete
           * files through the repo's established gitignore-aware `rg --files` walk
           * (the same Ripgrep service the grep tool uses). Directories and globs
           * prune `node_modules` unless the entry itself names it, and skip hidden
           * files. The 100-file cap fails the call outright — no silent
           * truncation, and a call that addresses nothing is an error, not a
           * success.
           */
          const discoverPatternFiles = Effect.fnUntraced(function* (inputs: readonly string[]) {
            const found = new Set<string>()
            const walk = (cwd: string, globs: string[], named: boolean) =>
              rg
                .files({
                  cwd,
                  glob: named ? globs : [...globs, "!node_modules/**", "!**/node_modules/**"],
                  hidden: false,
                  signal: ctx.abort,
                })
                .pipe(
                  Stream.take(MAX_PATTERN_FILES + 1),
                  Stream.runForEach((file) => Effect.sync(() => found.add(AppFileSystem.resolve(path.join(cwd, file))))),
                )
            const project = AppFileSystem.resolve(instance.directory)
            for (const input of inputs) {
              const entry = input.trim()
              if (!entry) throw new Error("ast_edit: paths contains a blank entry.")
              const absolute = path.isAbsolute(entry)
              const resolved = AppFileSystem.resolve(absolute ? entry : path.join(instance.directory, entry))
              if (!GLOB_MAGIC.test(entry)) {
                const info = yield* afs.stat(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`ast_edit: paths entry "${entry}" does not exist.`)
                if (info.type === "File") {
                  found.add(resolved)
                  continue
                }
                if (info.type === "Directory") {
                  yield* walk(resolved, [], NODE_MODULES_SEGMENT.test(entry))
                  continue
                }
                throw new Error(`ast_edit: paths entry "${entry}" is neither a file nor a directory.`)
              }
              if (!absolute) {
                yield* walk(project, [entry], NODE_MODULES_SEGMENT.test(entry))
                continue
              }
              const inside = path.relative(project, resolved)
              if (inside.startsWith("..") || path.isAbsolute(inside))
                throw new Error(
                  `ast_edit: glob entries must address files inside the project directory — "${entry}" resolves outside it. Name a single file directly or use the edit tool.`,
                )
              yield* walk(project, [inside], NODE_MODULES_SEGMENT.test(entry))
            }
            if (found.size > MAX_PATTERN_FILES)
              throw new Error(
                `ast_edit: the paths of this call address more than ${MAX_PATTERN_FILES} files (pattern-mode cap: ${MAX_PATTERN_FILES} per call); narrow the paths or split the codemod into separate calls.`,
              )
            if (found.size === 0)
              throw new Error(`ast_edit: paths matched no files: ${inputs.map((entry) => `"${entry}"`).join(", ")}.`)
            return [...found].toSorted()
          })

          /**
           * Analyze one addressed file of a multi-file call: size/binary/grammar
           * gates, a parse in the file's own detected language, per-rewrite
           * compilation for that language, and the shared collapse/overlap rules.
           * Anything that makes the file unsafe or unmatchable is a skipped report
           * (partial coverage is normal in a codemod sweep); only an overlap
           * conflict is a hard failure, carried out for the atomic no-write abort.
           */
          const planPatternFile = Effect.fnUntraced(function* (
            filePath: string,
            rewrites: readonly RewriteInput[],
            compiled: Map<string, CompileResult>,
          ) {
            const relative = path.relative(displayRoot, filePath)
            const skipped = (language: string, reason: string): PlanResult => ({
              kind: "skipped",
              report: { file: relative, language, status: "skipped", reason, rewrites: [] },
            })
            const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info || info.type !== "File") return skipped("unknown", "the path is not an existing regular file")
            if (info.size > MAX_SOURCE_FILE_SIZE_BYTES)
              return skipped(
                detectLanguage(filePath),
                `file is ${info.size} bytes, above the ${MAX_SOURCE_FILE_SIZE_BYTES}-byte graph size limit`,
              )
            const source = yield* Bom.readFile(afs, filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!source) return skipped(detectLanguage(filePath), "the file could not be read")
            const language = detectLanguage(filePath, source.text)
            if (looksBinary(source.text)) return skipped(language, "binary content")
            if (!hasTreeSitterGrammar(language))
              return skipped(language, `no tree-sitter grammar for language \"${language}\"`)
            yield* Effect.promise(() => ensureGrammarLoaded(language))
            const tree = parseSource(language, source.text)
            if (!tree) return skipped(language, `the ${language} grammar did not load`)
            const file = fileText(source.text)
            const plans: RewritePlan[] = []
            const splices: PatternSplice[] = []
            let issue: string | undefined
            try {
              const broken = syntaxErrorLines(tree.rootNode, 3)
              if (broken.length > 0)
                issue = `syntax errors (ERROR/MISSING nodes at lines ${broken.join(", ")}); pattern rewriting is unsafe here`
              for (const [index, rewrite] of rewrites.entries()) {
                if (issue) break
                const key = `${language}\u0000${rewrite.pattern}`
                let hit = compiled.get(key)
                if (!hit) {
                  hit = compilePattern(rewrite.pattern, language)
                  compiled.set(key, hit)
                }
                if (!hit.ok) {
                  issue = `rewrite ${index + 1} does not compile in ${language}: ${hit.error.message}`
                  break
                }
                const matches = findMatchesInTree(hit.pattern, tree, source.text)
                for (const match of matches) {
                  splices.push({
                    rewrite: index,
                    start: match.replacedRange.start,
                    end: match.replacedRange.end,
                    replacement:
                      rewrite.replacement === "" ? "" : renderTemplateReplacement(rewrite.replacement, match, source.text),
                  })
                }
                plans.push({
                  index,
                  pattern: rewrite.pattern,
                  replacement: rewrite.replacement,
                  render: rewrite.replacement === "" ? "delete" : "template",
                  matches: matches.length,
                })
              }
            } finally {
              tree.delete()
            }
            if (issue) return skipped(language, issue)
            const collapsed = collapseSplices(splices, plans, file)
            if (collapsed.conflicts.length > 0) {
              const conflict: PlanResult = { kind: "conflict", file: { relative, conflicts: collapsed.conflicts } }
              return conflict
            }
            const summaries: AppliedRewrite[] = plans.map((plan) => ({
              ...plan,
              applied: collapsed.ordered.filter((edit) => edit.rewrite === plan.index).length,
            }))
            if (collapsed.ordered.length === 0) {
              const report: PlanResult = {
                kind: "skipped",
                report: { file: relative, language, status: "unmatched", reason: "", rewrites: summaries },
              }
              return report
            }
            const planned: PlanResult = {
              kind: "planned",
              file: {
                filePath,
                relative,
                language,
                text: source.text,
                bom: source.bom,
                edits: collapsed.ordered,
                finalText: applyReplacements(source.text, collapsed.ordered),
                plans: summaries,
                probe: collapsed.ordered.map((edit) => rangeLines(file, edit.start, edit.end)),
              },
            }
            return planned
          })

          /**
           * Multi-file pattern mode: discovery, then every file is fully spliced
           * BEFORE anything is written — one overlap conflict anywhere fails the
           * call with zero files touched. The successful write rides one
           * trackToolMutation over all changed files, one permission ask carrying
           * every relative path, and per-file BOM/format/bus effects.
           */
          const runPatternPaths = (rewrites: readonly RewriteInput[], inputs: readonly string[]) =>
            Effect.gen(function* () {
              const found = yield* discoverPatternFiles(inputs)
              for (const filePath of found) yield* assertExternalDirectoryEffect(ctx, filePath)
              const predesign = yield* Chimera.requirePredesignForMutation({
                toolID: "ast_edit",
                ctx,
                files: found,
                multiFile: found.length > 1,
              })
              if (!predesign.allowed) return { blocked: true as const, result: predesign.result }

              const compiled = new Map<string, CompileResult>()
              const results: PlanResult[] = []
              for (const filePath of found) results.push(yield* planPatternFile(filePath, rewrites, compiled))

              const conflicts = results.flatMap((result) =>
                result.kind === "conflict" ? result.file.conflicts.map((line) => `${result.file.relative}: ${line}`) : [],
              )
              if (conflicts.length > 0) {
                throw new Error(
                  `ast_edit: overlapping pattern matches; no files were written — split the rewrites into separate calls or narrow the patterns so they never match nested ranges:\n${conflicts.map((line) => `- ${line}`).join("\n")}`,
                )
              }

              const planned = results.flatMap((result) => (result.kind === "planned" ? [result.file] : []))
              const changed = planned.filter((item) => item.finalText !== item.text)
              if (changed.length === 0) {
                const matched = planned.reduce((sum, item) => sum + item.edits.length, 0)
                throw new Error(
                  `No changes to apply: ${rewrites.length} pattern(s) matched ${matched} time(s) across ${found.length} addressed file(s) and rewrote nothing. A rewrite that matches nothing is fine on its own (it reports 0 replacements); this call changed no bytes anywhere.`,
                )
              }

              const touched: TouchedFile[] = changed.map((item) => {
                const rec: TouchedFile = {
                  filePath: item.filePath,
                  relative: item.relative,
                  hadBom: item.bom,
                  contentOld: item.text,
                  contentNew: item.finalText,
                  diff: "",
                  formatterTouched: false,
                  probe: item.probe,
                }
                stage(rec, rec.contentNew)
                return rec
              })

              const fileMetadata = results.flatMap<{
                file: string
                language: string
                status: "skipped" | "unmatched" | "no-change" | "changed"
                reason?: string
                replacements?: number
                rewrites: AppliedRewrite[]
              }>((result) => {
                if (result.kind === "conflict") return []
                if (result.kind === "skipped")
                  return [
                    {
                      file: result.report.file,
                      language: result.report.language,
                      status: result.report.status,
                      reason: result.report.reason || undefined,
                      rewrites: result.report.rewrites,
                    },
                  ]
                const item = result.file
                return [
                  {
                    file: item.relative,
                    language: item.language,
                    status: item.finalText === item.text ? "no-change" : "changed",
                    replacements: item.finalText === item.text ? 0 : item.edits.length,
                    rewrites: item.plans,
                  },
                ]
              })
              const skippedCount = results.filter((r) => r.kind === "skipped" && r.report.status === "skipped").length
              const unmatchedCount = results.filter((r) => r.kind === "skipped" && r.report.status === "unmatched").length
              const noChangeCount = planned.length - changed.length
              const totalReplacements = changed.reduce((sum, item) => sum + item.edits.length, 0)
              const astEdit = {
                schemaVersion: 1,
                pattern: {
                  addressing: "paths",
                  paths: [...inputs],
                  cap: MAX_PATTERN_FILES,
                  totals: {
                    addressed: found.length,
                    changed: touched.length,
                    replacements: totalReplacements,
                    noChange: noChangeCount,
                    unmatched: unmatchedCount,
                    skipped: skippedCount,
                  },
                  files: fileMetadata,
                },
              }

              yield* Chimera.trackToolMutation(
                {
                  toolID: "ast_edit",
                  ctx,
                  files: touched.map((rec) => rec.filePath),
                  bus,
                  metadata: () => ({
                    create: false,
                    filePaths: touched.map((rec) => rec.filePath),
                    diff: touched.map((rec) => rec.diff).join("\n"),
                    changeID,
                    astEdit,
                  }),
                },
                Effect.gen(function* () {
                  yield* ctx.ask({
                    permission: "edit",
                    patterns: touched.map((rec) => rec.relative),
                    always: ["*"],
                    metadata: {
                      filepath: touched.map((rec) => rec.relative).join(", "),
                      diff: touched.map((rec) => rec.diff).join("\n"),
                      files: touched.map((rec) => ({
                        filePath: rec.filePath,
                        relativePath: rec.relative,
                        type: "update",
                        patch: rec.diff,
                      })),
                    },
                  })
                  for (const rec of touched) yield* writeFormatted(rec)
                }),
              )

              const lines = results.flatMap((result) => {
                if (result.kind === "conflict") return []
                if (result.kind === "skipped")
                  return [
                    result.report.status === "unmatched"
                      ? `- ${result.report.file}: 0 replacement(s)`
                      : `- ${result.report.file}: skipped: ${result.report.reason}`,
                  ]
                const item = result.file
                if (item.finalText === item.text)
                  return [`- ${item.relative}: 0 replacement(s) (the matches rewrote identical text)`]
                return [`- ${item.relative}: ${item.edits.length} replacement(s)`]
              })
              const head = [
                `Pattern codemod over ${found.length} addressed file(s):`,
                ...lines,
                `Totals: ${touched.length} file(s) changed with ${totalReplacements} replacement(s); ${noChangeCount} identical, ${unmatchedCount} without a match, ${skippedCount} skipped`,
              ].join("\n")

              // The changed-block window renders only when exactly one file
              // changed; multi-file diffs stay in metadata. Offset every edit by
              // the length change of the ones before it (the engine splices left
              // to right) to point at the written content.
              let newLines: string[] = []
              let windowStart = 1
              let windowEnd = 0
              if (touched.length === 1) {
                const item = changed[0]
                const final = fileText(touched[0].contentNew)
                let shift = 0
                const spans = item.edits.map((edit) => {
                  const start = edit.start + shift
                  shift += edit.replacement.length - (edit.end - edit.start)
                  return rangeLines(final, start, start + edit.replacement.length)
                })
                newLines = final.lines
                windowStart = spans.reduce((min, span) => Math.min(min, span.startLine), final.lines.length)
                windowEnd = spans.reduce((max, span) => Math.max(max, span.endLine), 1)
              }

              return {
                blocked: false as const,
                outcome: {
                  head,
                  notes: "",
                  newLines,
                  windowStart,
                  windowEnd,
                  touched,
                  liveMetadata: astEdit,
                  metadata: astEdit,
                } satisfies ModeOutcome,
              }
            })

          /** Shared mutation tail: diff stats, metadata, output, LSP oracle, propagation. */
          const finish = (outcome: ModeOutcome) =>
            Effect.gen(function* () {
              const touched = outcome.touched
              const multiple = touched.length > 1
              const filediffs: Snapshot.FileDiff[] = []
              let additions = 0
              let deletions = 0
              for (const rec of touched) {
                let fileAdditions = 0
                let fileDeletions = 0
                for (const change of diffLines(rec.contentOld, rec.contentNew)) {
                  if (change.added) fileAdditions += change.count || 0
                  if (change.removed) fileDeletions += change.count || 0
                }
                additions += fileAdditions
                deletions += fileDeletions
                filediffs.push({ file: rec.filePath, patch: rec.diff, additions: fileAdditions, deletions: fileDeletions })
              }
              const diff = multiple ? touched.map((rec) => rec.diff).join("\n") : touched[0].diff

              yield* ctx.metadata({
                metadata: {
                  diff,
                  ...(multiple ? { filediffs } : { filediff: filediffs[0] }),
                  changeID,
                  astEdit: outcome.liveMetadata,
                },
              })

              let output = [
                "AST edit applied successfully.",
                "",
                "Change:",
                `- changeID: ${changeID}`,
                "",
                outcome.head,
              ].join("\n")
              if (outcome.notes) output += `\n\n${outcome.notes}`
              if (outcome.newLines.length > 0 && outcome.windowEnd >= outcome.windowStart) {
                output += `\n\n${formatChangedBlock(outcome.newLines, outcome.windowStart, outcome.windowEnd)}`
              }

              for (const rec of touched) yield* lsp.touchFile(rec.filePath, "document")
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
                    files: touched.map((rec) => rec.filePath),
                    diagnosticCount,
                  },
                },
              }).pipe(Effect.ignore)
              for (const rec of touched) {
                const block = LSP.Diagnostic.report(rec.filePath, diagnostics[AppFileSystem.normalizePath(rec.filePath)] ?? [])
                if (!block) continue
                output += multiple
                  ? `\n\nLSP errors detected in ${rec.relative}, please fix:\n${block}`
                  : `\n\nLSP errors detected in this file, please fix:\n${block}`
              }

              output += `\n\n${yield* inlinePropagationCheck(
                touched.map((rec) => ({ file: rec.filePath, ranges: rec.probe })),
                ctx.sessionID,
              )}`

              return {
                title: multiple
                  ? `AST edit applied to ${touched.length} files:\n${touched.map((rec) => `- ${rec.relative}`).join("\n")}`
                  : touched[0].relative,
                output,
                metadata: {
                  diagnostics,
                  diff,
                  ...(multiple ? { filediffs } : { filediff: filediffs[0] }),
                  changeID,
                  astEdit: {
                    ...outcome.metadata,
                    formatterTouched: multiple ? touched.some((rec) => rec.formatterTouched) : touched[0].formatterTouched,
                  },
                },
              }
            })

          if (call.kind === "pattern-paths") {
            const run = yield* runPatternPaths(call.rewrites, call.paths)
            if (run.blocked) return run.result
            return yield* finish(run.outcome)
          }

          const filePath = AppFileSystem.resolve(
            path.isAbsolute(call.file) ? call.file : path.join(instance.directory, call.file),
          )
          yield* assertExternalDirectoryEffect(ctx, filePath)
          if (call.kind === "refs" && !isInitialized(displayRoot)) {
            throw new Error(
              `ast_edit: the Chimera graph surface is not initialized for this project, so node refs are unavailable. ` +
                `Ask the user to run 'chimera graph init' then 'chimera graph index' (or call chimera_init_graph if that tool is available to you), ` +
                `or use the edit tool for text-anchored changes instead. Pattern mode (rewrites) needs no graph.`,
            )
          }
          const predesign = yield* Chimera.requirePredesignForMutation({
            toolID: "ast_edit",
            ctx,
            files: [filePath],
          })
          if (!predesign.allowed) return predesign.result
          const rec: TouchedFile = {
            filePath,
            relative: path.relative(displayRoot, filePath),
            hadBom: false,
            contentOld: "",
            contentNew: "",
            diff: "",
            formatterTouched: false,
            probe: [],
          }
          const applied =
            call.kind === "refs"
              ? yield* runRefMode(call.edits, filePath, rec)
              : yield* runPatternMode(call.rewrites, filePath, rec)
          return yield* finish(applied)
        }).pipe(Effect.orDie),
    }
  }),
)
