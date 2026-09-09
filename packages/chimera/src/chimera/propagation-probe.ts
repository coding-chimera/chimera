import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isInitialized } from "@/graph"
import { Chimera } from "./provenance"

/**
 * Hard wall-clock budget for the inline probe. Exceeding it degrades to a silent no-op.
 */
export const PROPAGATION_PROBE_TIMEOUT_MS = 500

const MAX_PROBE_DEPENDENTS = 5
const MAX_DISPLAY_DEPENDENTS = 3

function projectRoot(directory: string, worktree: string) {
  return worktree === "/" ? directory : worktree
}

/** Graph-relative seed paths (forward slashes); files outside the graph root are skipped. */
function graphSeeds(root: string, files: string[]) {
  return [...new Set(files.flatMap((file) => {
    const relative = path.relative(root, path.resolve(file)).replaceAll("\\", "/")
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
 * Bounded inline propagation probe for change-tool success output.
 *
 * Reuses the audit/impact core path: the same `openProjectGraph` state used by
 * `chimera_audit`/`chimera_impact` and the same `graph.fileDependents` query the
 * impact evidence builder seeds with changed files. No init, sync, or watch is
 * started, so the probe never creates or migrates graph data.
 *
 * Degradation matrix: graph not initialized, all seeds outside the graph root,
 * the 500ms budget expiring, or any open/query failure (typed error or defect)
 * all degrade silently (empty output) — no audit evidence is available in
 * those states either, so an invitation line would be noise.
 */
export function inlinePropagationCheck(changedFiles: string[]): Effect.Effect<string> {
  const probe = Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const root = projectRoot(instance.directory, instance.worktree)
    if (!isInitialized(root)) return ""
    const seeds = graphSeeds(root, changedFiles)
    if (seeds.length === 0) return ""
    return yield* Chimera.withProjectGraph(
      { readOnly: false, sync: false, watch: false },
      (state) =>
        Effect.gen(function* () {
          const dependents = [...new Set(
            seeds.flatMap((seed) => state.graph.fileDependents(seed)),
          )]
            .filter((file) => !seeds.includes(file))
            .slice(0, MAX_PROBE_DEPENDENTS)
          return formatProbe(dependents)
        }),
    )
  })
  return probe.pipe(
    Effect.timeout(PROPAGATION_PROBE_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed("")),
    Effect.catchDefect(() => Effect.succeed("")),
  )
}