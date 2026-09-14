import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { getGraphDataRootInfo, isInitialized } from "@/graph"
import type { Node, RelationEvidence, RelationQueryOptions, SourceRange } from "@/graph"
import type { SessionID } from "@/session/schema"
import { DependentRelations } from "./codegraph-adapter"
import { Chimera } from "./provenance"
import { readPredesignRuns, type PredesignRunRecord } from "./store"

/**
 * Hard wall-clock budget for the inline probe. Exceeding it degrades to a silent no-op.
 */
export const PROPAGATION_PROBE_TIMEOUT_MS = 500

const MAX_PROBE_DEPENDENTS = 5
const MAX_DISPLAY_DEPENDENTS = 3
const MAX_SCOPE_DISPLAY = 5
const MAX_WALK_DEPTH = 4
const MAX_WALK_NODES = 40
const MAX_FRONTIER_PER_DEPTH = 8
const PASS_THROUGH_MAX_LINES = 40
const MAX_SYMBOLS_PER_ENTRY = 4

/**
 * Node kinds that carry no consumer symbol. Usage edges (references/calls/
 * imports) attach to file, import, or statement nodes when the use site is
 * top-level rather than inside a named symbol; such dependents are named at
 * file granularity only (the legacy bare-path rendering) and are continued
 * through only under the pass-through file heuristic below.
 */
const FILE_LEVEL_KINDS = new Set<Node["kind"]>(["file", "import", "statement"])

/**
 * Tail ` (path/to/file.ts:line)` of a rendered symbol entry, capturing the
 * file path. Exported because prompt-context's drift scanner parses it while
 * reconciling session history; the probe renderer and that parser must share
 * one regex source so the two ends cannot drift apart. Legacy bare-path
 * entries simply do not match and stay parseable as whole-path items.
 */
export const PROPAGATION_ENTRY_FILE = /\(([^():\s]+):(\d+)\)$/

/**
 * One edit target for the probe. `ranges` are PRE-EDIT source ranges: the
 * probe queries the unsynced graph, so pre-edit coordinates are the ones the
 * graph still reflects (the same revision the edit tool anchored against).
 */
export type PropagationTarget = { file: string; ranges?: SourceRange[] }

function projectRoot(directory: string, worktree: string) {
  return worktree === "/" ? directory : worktree
}

/** Graph-relative seed path (forward slashes); inputs resolving outside the graph root return undefined. */
function graphSeed(root: string, file: string) {
  const relative = path.relative(root, path.resolve(root, file)).replaceAll("\\", "/")
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined
}

/** Graph-relative seed paths (forward slashes); inputs outside the graph root are skipped. */
function graphSeeds(root: string, files: string[]) {
  return [...new Set(files.flatMap((file) => graphSeed(root, file) ?? []))]
}

function graphTargets(root: string, targets: PropagationTarget[]) {
  const merged = new Map<string, SourceRange[] | undefined>()
  for (const target of targets) {
    const file = graphSeed(root, target.file)
    if (!file) continue
    const known = merged.get(file)
    if (target.ranges === undefined) {
      if (!merged.has(file)) merged.set(file, undefined)
    } else {
      merged.set(file, known ? [...known, ...target.ranges] : target.ranges)
    }
  }
  return [...merged].map(([file, ranges]) => ({ file, ranges }))
}

type WalkEntry = { file: string; symbols?: string[]; line?: number; via?: string; depth?: number }

/**
 * Renders one named entry: `symbolName (path/to/file.ts:line)` for symbol-level
 * dependents (merged symbol lists joined by spaces, one entry per file), or the
 * legacy bare path for file-granularity dependents. `PROPAGATION_ENTRY_FILE`
 * is the parse-side contract for the parenthesized tail.
 */
function formatNamed(entry: WalkEntry) {
  return entry.symbols?.length && entry.line !== undefined ? `${entry.symbols.join(" ")} (${entry.file}:${entry.line})` : entry.file
}

function formatProbe(dependents: WalkEntry[]) {
  if (dependents.length === 0) {
    return "Propagation check: no dependents found for the changed file(s)."
  }
  return `Propagation check: ${dependents.length} dependent file(s) may be affected: ${dependents.slice(0, MAX_DISPLAY_DEPENDENTS).map(formatNamed).join(", ")}.`
}

/**
 * Wrapper-likeness proxy for the transitive walk: small files tend to forward
 * a contract unchanged (re-export/thin wrapper), so the walk continues
 * through them; larger files adapt the contract locally and stop the walk —
 * they are reported as candidates instead, and if one of them is edited its
 * own probe run re-fires (the cascade extends effective reach without
 * unbounded static expansion). The heuristic stays file-granular at symbol
 * level on purpose: whether a consumer file adapts or forwards a contract is
 * a property of the whole file, and unbounded symbol continuation would let
 * big hubs eat the node budget with weak "consumers of consumers" noise —
 * the exact dilution the TB6 bench found weak models dismiss.
 */
function passThroughLike(graph: { nodesInFile(filePath: string): Array<{ endLine: number }> }, file: string) {
  const span = graph.nodesInFile(file).reduce((max, node) => Math.max(max, node.endLine), 0)
  return span > 0 && span <= PASS_THROUGH_MAX_LINES
}

/** Walk frontier vertex: a symbol node, or a bare file for the legacy file-level projection path. */
type WalkVertex = { file: string; node?: Node; depth: number }

type ProbeGraph = {
  nodesInFile(filePath: string): Node[]
  nodesIntersectingRange(filePath: string, range: SourceRange): Node[]
  incomingRelations(nodeID: string, options: RelationQueryOptions): RelationEvidence[]
  fileDependents(filePath: string): string[]
}

/**
 * Bounded dependents walk over the given targets. Targets whose ranges
 * resolve to symbols are seeded at symbol level and expanded through
 * `DependentRelations` incoming edges (which files, and which symbols in
 * them, actually consume the changed contract); every other target keeps the
 * legacy file-level `fileDependents` projection walk. Constraints are shared:
 * depth <= 4, <= 40 visited files, <= 8 frontier vertices per depth, visited
 * sets make it cycle-safe, and the caller's wall-clock budget is the backstop.
 */
function runWalk(graph: ProbeGraph, targets: Array<{ file: string; ranges?: SourceRange[] }>, maxDepth: number): WalkEntry[] {
  const seedFiles = new Set(targets.map((target) => target.file))
  const queried = new Set<string>()
  const passThrough = new Map<string, boolean>()
  const passThroughFile = (file: string) => {
    const cached = passThrough.get(file)
    if (cached !== undefined) return cached
    const small = passThroughLike(graph, file)
    passThrough.set(file, small)
    return small
  }
  const viaLabel = (vertex: WalkVertex) => (vertex.node ? `${vertex.node.name}@${vertex.file}` : vertex.file)
  let frontier: WalkVertex[] = targets.flatMap((target) => {
    const nodes = target.ranges?.length
      ? [...new Map(
          target.ranges
            .flatMap((range) => graph.nodesIntersectingRange(target.file, range))
            .filter((node) => !FILE_LEVEL_KINDS.has(node.kind))
            .map((node) => [node.id, node]),
        ).values()].slice(0, MAX_WALK_NODES)
      : []
    // Ranges that resolve to no symbols (a not-yet-indexed file, empty or
    // unparseable ranges) fall back to the file-level projection walk.
    if (nodes.length === 0) return [{ file: target.file, depth: 0 }]
    return nodes.map((node) => ({ file: target.file, node, depth: 0 }))
  })
  const entries = new Map<string, WalkEntry & { symbols: string[]; depth: number }>()
  while (frontier.length > 0) {
    const next: WalkVertex[] = []
    for (const vertex of frontier.slice(0, MAX_FRONTIER_PER_DEPTH)) {
      if (vertex.depth >= maxDepth) continue
      const via = vertex.depth === 0 ? undefined : viaLabel(vertex)
      const childDepth = vertex.depth + 1
      const continueThrough = childDepth < maxDepth
      if (!vertex.node) {
        for (const dependent of graph.fileDependents(vertex.file)) {
          if (seedFiles.has(dependent) || entries.has(dependent)) continue
          if (entries.size >= MAX_WALK_NODES) break
          entries.set(dependent, { file: dependent, symbols: [], via, depth: childDepth })
          if (continueThrough && passThroughFile(dependent)) next.push({ file: dependent, depth: childDepth })
        }
        continue
      }
      if (queried.has(vertex.node.id)) continue
      queried.add(vertex.node.id)
      for (const relation of graph.incomingRelations(vertex.node.id, { relations: DependentRelations })) {
        const other = relation.otherNode
        if (seedFiles.has(other.filePath) || entries.size >= MAX_WALK_NODES) continue
        const named = !FILE_LEVEL_KINDS.has(other.kind)
        const existing = entries.get(other.filePath)
        if (existing) {
          // Multiple consumer symbols in one file merge into a single entry
          // (bounded symbol list) so a hot dependent file cannot explode the
          // display; the first discovery keeps the via/depth attribution.
          if (named && !existing.symbols.includes(other.name) && existing.symbols.length < MAX_SYMBOLS_PER_ENTRY) {
            existing.symbols.push(other.name)
            existing.line = existing.line === undefined ? other.startLine : Math.min(existing.line, other.startLine)
          }
        } else {
          entries.set(other.filePath, { file: other.filePath, symbols: named ? [other.name] : [], line: named ? other.startLine : undefined, via, depth: childDepth })
        }
        if (!continueThrough || !passThroughFile(other.filePath)) continue
        if (named) {
          if (!queried.has(other.id)) next.push({ file: other.filePath, node: other, depth: childDepth })
        } else if (!existing) {
          // File-granularity dependent (top-level use or plain import): its
          // consumers attach to the file's own symbols, so a pass-through-like
          // wrapper expands through those symbols, mirroring the old walk.
          for (const node of graph.nodesInFile(other.filePath)) {
            if (!FILE_LEVEL_KINDS.has(node.kind) && !queried.has(node.id)) next.push({ file: other.filePath, node, depth: childDepth })
          }
        }
      }
    }
    frontier = next
  }
  return [...entries.values()]
}

/**
 * Compares the edit targets and their graph propagation (a bounded transitive
 * walk over dependents, continuing through pass-through-like small files and
 * annotated with the intermediate symbol@file and hop count) against the file
 * scope the session's latest predesign declared. Pure and bounded: each drift
 * kind surfaces at most one line with display-capped entries, deepest hops
 * first because grep on the changed symbol cannot reach them. The reminder
 * only exists when the model declared a scope itself — anchored to its own
 * declaration plus graph facts, never to guesswork.
 */
export function scopeDriftLines(predesignID: string, declared: string[], seeds: string[], propagation: WalkEntry[]) {
  const declaredSet = new Set(declared)
  const shown = declared.slice(0, MAX_SCOPE_DISPLAY).join(", ") + (declared.length > MAX_SCOPE_DISPLAY ? ", ..." : "")
  const lines: string[] = []
  const outsideTargets = seeds.filter((seed) => !declaredSet.has(seed))
  if (outsideTargets.length > 0) {
    lines.push(`Scope check: edit target(s) ${outsideTargets.slice(0, MAX_SCOPE_DISPLAY).join(", ")} not declared in ${predesignID} (declared: ${shown}) — confirm this is intended, or record a new predesign covering them.`)
  }
  const scope = new Set([...declared, ...seeds])
  const outside = propagation.filter((entry) => !scope.has(entry.file))
  if (outside.length > 0) {
    // Deepest hops first: 1-hop importers are trivially discoverable by the
    // model, while multi-hop consumers are invisible to grep on the changed
    // symbol and carry the highest stale-contract risk.
    const ranked = [...outside].sort((left, right) => (right.depth ?? 1) - (left.depth ?? 1))
    const extra = ranked.length > MAX_SCOPE_DISPLAY ? ` (+${ranked.length - MAX_SCOPE_DISPLAY} more)` : ""
    const named = ranked
      .slice(0, MAX_SCOPE_DISPLAY)
      .map((entry) => (entry.via ? `${formatNamed(entry)} (via ${entry.via}${entry.depth !== undefined && entry.depth >= 2 ? `, ${entry.depth} hops` : ""})` : formatNamed(entry)))
      .join(", ")
    const deepest = ranked.reduce((max, entry) => Math.max(max, entry.depth ?? (entry.via ? 2 : 1)), 1)
    lines.push(
      deepest >= 2
        ? `Scope check: propagation reaches ${named}${extra}, outside the scope declared in ${predesignID} (declared: ${shown}). Entries marked (via ..., N hops) are deep consumers up to ${deepest} hops away that grep on the changed symbol cannot reach; they often hardcode the old contract. For each named file, list its hardcoded literals and constants and check every one against the NEW behavior — clean-looking imports do not prove safety, and stale hardcoded values usually throw only at runtime. Complete this check before closeout.`
        : `Scope check: propagation reaches ${named}${extra}, outside the scope declared in ${predesignID} (declared: ${shown}); verify whether those files need changes too.`,
    )
  }
  return lines
}

async function latestPredesignFor(root: string, sessionID: SessionID) {
  const info = getGraphDataRootInfo(root)
  const artifacts = [...new Set([
    path.join(info.dataRoot, "chimera", "predesign-runs.jsonl"),
    path.join(info.legacyRoot, "chimera", "predesign-runs.jsonl"),
  ])]
  for (const artifact of artifacts) {
    const records = await readPredesignRuns(root, artifact, { sessionID, limit: 1 })
    if (records.length > 0) return records[0]
  }
  return undefined
}

/**
 * Symbol seeds persisted by a predesign record: each seed node was resolved
 * against the graph when the predesign ran, so its stored file + range can
 * re-seed the reconciliation walk at symbol level when the caller passed no
 * ranges of its own (predesign seeds take priority; the file-level walk is
 * the fallback for legacy or degraded records with empty seedNodes).
 */
function predesignSeedRanges(predesign: PredesignRunRecord) {
  const ranges = new Map<string, SourceRange[]>()
  for (const seed of predesign.seedNodes) {
    const payload = (seed as { payload?: { filePath?: unknown; range?: { startLine?: unknown; endLine?: unknown } } } | null)?.payload
    const file = typeof payload?.filePath === "string" && payload.filePath.length > 0 ? payload.filePath : undefined
    const startLine = Number(payload?.range?.startLine)
    if (!file || !Number.isFinite(startLine) || startLine < 1) continue
    const endLine = Number(payload?.range?.endLine)
    ranges.set(file, [...(ranges.get(file) ?? []), { startLine, endLine: Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine }])
  }
  return ranges
}

/**
 * Bounded inline propagation probe for change-tool success output.
 *
 * Reuses the audit/impact core path: the same `openProjectGraph` state used by
 * `chimera_audit`/`chimera_impact` and the same symbol incoming-relation set
 * the impact evidence builder walks. No init, sync, or watch is started, so
 * the probe never creates or migrates graph data.
 *
 * Targets carrying pre-edit source ranges are named at symbol level (seed
 * resolved via `nodesIntersectingRange`, dependents via symbol incoming
 * relations) so a change to one internal symbol no longer names every file
 * that merely imports anything from the changed file; targets without
 * resolvable ranges keep the file-level projection walk. When `sessionID` is
 * provided, the probe additionally reconciles the edit against the session's
 * latest predesign declaration: targets or propagation outside the declared
 * file scope append a bounded `Scope check:` reminder so missed change
 * surfaces surface at the moment of the edit. Reconciliation propagation is a
 * bounded transitive walk (depth-capped, node-capped, cycle-safe via visited
 * sets) that continues through pass-through-like small files, so a chain of
 * thin wrappers cannot hide the real contract consumer; the plain propagation
 * line stays 1-hop and the walk only runs when a declaration exists. When the
 * graph is unavailable or the probe exceeds its 500ms budget it degrades
 * silently and no line is appended.
 */
export function inlinePropagationCheck(targets: PropagationTarget[], sessionID?: SessionID): Effect.Effect<string> {
  const probe = Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance.directory, instance.worktree)
    if (!isInitialized(root)) return ""
    const seeds = graphTargets(root, targets)
    if (seeds.length === 0) return ""
    const predesign = sessionID !== undefined ? yield* Effect.promise(() => latestPredesignFor(root, sessionID)) : undefined
    const seededRanges = predesign ? predesignSeedRanges(predesign) : new Map<string, SourceRange[]>()
    // Declared scope prefers the predesign's persisted symbol seeds (their
    // files are graph-resolved facts) and keeps the declared file paths as
    // fallback/union so a predesign whose seeds are empty, or that declared a
    // file the graph never indexed, still counts as declaring it.
    const declared = predesign
      ? [...new Set([...seededRanges.keys(), ...graphSeeds(root, predesign.files)])]
      : []
    const { dependents, walk } = yield* Chimera.withProjectGraph(
      { readOnly: false, sync: false, watch: false },
      (state) =>
        Effect.sync(() => {
          if (declared.length === 0) return { dependents: runWalk(state.graph, seeds, 1), walk: [] as WalkEntry[] }
          // The walk doubles as the 1-hop source: depth-1 entries are exactly
          // what the old separate `fileDependents` pass produced. Targets
          // without caller ranges re-seed from the predesign's persisted
          // symbol seeds before falling back to the file-level projection.
          const walkSeeds = seeds.map((target) => (target.ranges?.length || !seededRanges.has(target.file) ? target : { file: target.file, ranges: seededRanges.get(target.file) }))
          const full = runWalk(state.graph, walkSeeds, MAX_WALK_DEPTH)
          return { dependents: full.filter((entry) => entry.depth === 1), walk: full }
        }),
    )
    const lines = [formatProbe(dependents.slice(0, MAX_PROBE_DEPENDENTS))]
    if (predesign && declared.length > 0) {
      lines.push(...scopeDriftLines(predesign.id, declared, seeds.map((target) => target.file), walk))
    }
    return lines.join("\n")
  })
  return probe.pipe(
    Effect.timeout(PROPAGATION_PROBE_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed("")),
    Effect.catchDefect(() => Effect.succeed("")),
  )
}
