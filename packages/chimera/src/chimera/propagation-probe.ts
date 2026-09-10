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
const MAX_SCOPE_DISPLAY = 3

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

/**
 * Compares the edit targets and their graph propagation against the file scope
 * the session's latest predesign declared. Pure and bounded: each drift kind
 * surfaces at most one line with display-capped file lists. The reminder only
 * exists when the model declared a scope itself — anchored to its own
 * declaration plus graph facts, never to guesswork.
 */
export function scopeDriftLines(predesignID: string, declared: string[], seeds: string[], dependents: string[]) {
  const declaredSet = new Set(declared)
  const shown = declared.slice(0, MAX_SCOPE_DISPLAY).join(", ") + (declared.length > MAX_SCOPE_DISPLAY ? ", ..." : "")
  const lines: string[] = []
  const outsideTargets = seeds.filter((seed) => !declaredSet.has(seed))
  if (outsideTargets.length > 0) {
    lines.push(`Scope check: edit target(s) ${outsideTargets.slice(0, MAX_SCOPE_DISPLAY).join(", ")} not declared in ${predesignID} (declared: ${shown}) — confirm this is intended, or record a new predesign covering them.`)
  }
  const scope = new Set([...declared, ...seeds])
  const outsidePropagation = dependents.filter((file) => !scope.has(file))
  if (outsidePropagation.length > 0) {
    const extra = outsidePropagation.length > MAX_SCOPE_DISPLAY ? ` (+${outsidePropagation.length - MAX_SCOPE_DISPLAY} more)` : ""
    lines.push(`Scope check: propagation reaches ${outsidePropagation.slice(0, MAX_SCOPE_DISPLAY).join(", ")}${extra}, outside the scope declared in ${predesignID} (declared: ${shown}); verify whether those files need changes too.`)
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
 * missed change surfaces surface at the moment of the edit.
 *
 * Degradation matrix: graph not initialized, all seeds outside the graph root,
 * the 500ms budget expiring, missing predesign records, or any open/query/read
 * failure (typed error or defect) all degrade silently (propagation line only,
 * or empty output) — a reminder without reliable anchors would be noise.
 */
export function inlinePropagationCheck(changedFiles: string[], sessionID?: SessionID): Effect.Effect<string> {
  const probe = Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance.directory, instance.worktree)
    if (!isInitialized(root)) return ""
    const seeds = graphSeeds(root, changedFiles)
    if (seeds.length === 0) return ""
    const dependents = yield* Chimera.withProjectGraph(
      { readOnly: false, sync: false, watch: false },
      (state) =>
        Effect.sync(() =>
          [...new Set(seeds.flatMap((seed) => state.graph.fileDependents(seed)))].filter((file) => !seeds.includes(file)),
        ),
    )
    const lines = [formatProbe(dependents.slice(0, MAX_PROBE_DEPENDENTS))]
    if (sessionID !== undefined) {
      const predesign = yield* Effect.promise(() => latestPredesignFor(root, sessionID))
      if (predesign && predesign.files.length > 0) {
        lines.push(...scopeDriftLines(predesign.id, graphSeeds(root, predesign.files), seeds, dependents))
      }
    }
    return lines.join("\n")
  })
  return probe.pipe(
    Effect.timeout(PROPAGATION_PROBE_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed("")),
    Effect.catchDefect(() => Effect.succeed("")),
  )
}
