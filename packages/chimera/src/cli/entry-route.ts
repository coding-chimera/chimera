/**
 * Entry routing for the single executable / source entrypoint.
 *
 * `--orch-child` may appear directly (`chimera --orch-child`) or after a `--`
 * separator forwarded by a wrapper (`chimera -- --orch-child`); both shapes mean
 * "this process is an orchestrate worker". The check is an exact-argument scan,
 * so a `--` separator is transparent rather than a boundary.
 */
export function routeEntry(args: readonly string[]): "child" | "main" {
  return args.includes("--orch-child") ? "child" : "main"
}

export * as EntryRoute from "./entry-route"
