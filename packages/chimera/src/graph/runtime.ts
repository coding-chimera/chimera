/**
 * Runtime identity helpers.
 *
 * `process.versions.node` is NOT a reliable Node version under Bun: Bun
 * publishes its Node-API compatibility target there (e.g. "26.3.0" on Bun
 * 1.4) while embedding its own V8 build. Anything that classifies Node
 * versions, or re-execs `process.execPath` with Node/V8 command-line flags,
 * must therefore branch on Bun first:
 *   - ./cli/chimera.ts — the Node 25+ hard block (a Node V8 turboshaft bug).
 *   - ./extraction/wasm-runtime-flags.ts — the `--liftoff-only` re-exec.
 */

/** True when the current process is Bun rather than Node. */
export function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === 'string';
}
