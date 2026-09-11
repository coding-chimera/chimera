import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { getGraphDataRootInfo, isInitialized } from "@/graph"
import type { SessionID } from "@/session/schema"
import { Chimera } from "./provenance"
import { readPredesignRuns } from "./store"

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

function projectRoot(directory: string, worktree: string) {
  return worktree === "/" ? directory : worktree
}

/** Graph-relative seed paths (forward slashes); relative inputs resolve against the graph root, files outside it are skipped. */
function graphSeeds(root: string, files: string[]) {
  return [...new Set(files.flatMap((file) => {
    const relative = path.relative(root, path.resolve(root, file)).replaceAll("\\", "/")
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? [relative] : []
  }))]
}

function formatProbe(dependents: string[]) {
  if (dependents.length === 0) {
    return "Propagation check: no dependents found for the changed file(s)."
  }
  return `Propagation check: ${dependents.length} dependent file(s) may be affected: ${dependents.slice(0, MAX_DISPLAY_DEPENDENTS).join(", ")}.`
}

type WalkEntry = { file: string; via?: string; depth?: number }

/**
 * Wrapper-likeness proxy for the transitive walk: small files tend to forward
 * a contract unchanged (re-export/thin wrapper), so the walk continues
 * through them; larger files adapt the contract locally and stop the walk —
 * they are reported as candidates instead, and if one of them is edited its
 * own probe run re-fires (the cascade extends effective reach without
 * unbounded static expansion).
 */
function passThroughLike(graph: { nodesInFile(filePath: string): Array<{ endLine: number }> }, file: string) {
  const span = graph.nodesInFile(file).reduce((max, node) => Math.max(max, node.endLine), 0)
  return span > 0 && span <= PASS_THROUGH_MAX_LINES
}

/**
 * Compares the edit targets and their graph propagation (a bounded transitive
 * walk over dependents, continuing through pass-through-like small files and
 * annotated with the intermediate file and hop count) against the file scope
 * the session's latest predesign declared. Pure and bounded: each drift kind
 * surfaces at most one line with display-capped file lists, deepest hops
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
      .map((entry) => (entry.via ? `${entry.file} (via ${entry.via}${entry.depth !== undefined && entry.depth >= 2 ? `, ${entry.depth} hops` : ""})` : entry.file))
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
 * Bounded inline propagation probe for change-tool success output.
 *
 * Reuses the audit/impact core path: the same `openProjectGraph` state used by
 * `chimera_audit`/`chimera_impact` and the same `graph.fileDependents` query the
 * impact evidence builder seeds with changed files. No init, sync, or watch is
 * started, so the probe never creates or migrates graph data.
 *
 * When `sessionID` is provided, the probe additionally reconciles the edit
 * against the session's latest predesign declaration: targets or propagation
 * outside the declared file scope append a bounded `Scope check:` reminder so
 * missed change surfaces surface at the moment of the edit. Reconciliation
 * propagation is a bounded transitive walk (depth-capped, node-capped,
 * cycle-safe via a visited set) that continues through pass-through-like
 * small files, so a chain of thin wrappers cannot hide the real contract
 * consumer; the plain propagation line stays 1-hop and the walk only runs
 * when a declaration exists.
 */
export function inlinePropagationCheck(changedFiles: string[], sessionID?: SessionID): Effect.Effect<string> {
  const probe = Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance.directory, instance.worktree)
    if (!isInitialized(root)) return ""
    const seeds = graphSeeds(root, changedFiles)
    if (seeds.length === 0) return ""
    const predesign = sessionID !== undefined ? yield* Effect.promise(() => latestPredesignFor(root, sessionID)) : undefined
    const scoped = predesign !== undefined && predesign.files.length > 0
    const { dependents, walk } = yield* Chimera.withProjectGraph(
      { readOnly: false, sync: false, watch: false },
      (state) =>
        Effect.sync(() => {
          const dependents = [...new Set(seeds.flatMap((seed) => state.graph.fileDependents(seed)))].filter((file) => !seeds.includes(file))
          if (!scoped) return { dependents, walk: [] as WalkEntry[] }
          // Bounded transitive walk (declared scopes only): a contract can
          // flow through any number of pass-through wrappers (A -> B -> C ->
          // D where only D hardcodes the old vocabulary) and dependency
          // cycles (a -> b -> c -> a) are common in long-wired projects. The
          // visited set makes the walk cycle-safe, depth/node caps keep it
          // inside the 500ms budget, and continuation through small files
          // only keeps the expansion narrow along wrapper chains.
          const seen = new Set(seeds)
          const walk: WalkEntry[] = []
          let frontier = seeds.map((file) => ({ file, depth: 0 }))
          while (frontier.length > 0) {
            const next: Array<{ file: string; depth: number }> = []
            for (const node of frontier.slice(0, MAX_FRONTIER_PER_DEPTH)) {
              if (node.depth >= MAX_WALK_DEPTH) continue
              for (const dep of state.graph.fileDependents(node.file)) {
                if (seen.size >= MAX_WALK_NODES) break
                if (seen.has(dep)) continue
                seen.add(dep)
                walk.push({ file: dep, via: node.depth === 0 ? undefined : node.file, depth: node.depth + 1 })
                if (passThroughLike(state.graph, dep)) next.push({ file: dep, depth: node.depth + 1 })
              }
            }
            frontier = next
          }
          return { dependents, walk }
        }),
    )
    const lines = [formatProbe(dependents.slice(0, MAX_PROBE_DEPENDENTS))]
    if (predesign && predesign.files.length > 0) {
      lines.push(...scopeDriftLines(predesign.id, graphSeeds(root, predesign.files), seeds, walk))
    }
    return lines.join("\n")
  })
  return probe.pipe(
    Effect.timeout(PROPAGATION_PROBE_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed("")),
    Effect.catchDefect(() => Effect.succeed("")),
  )
}
