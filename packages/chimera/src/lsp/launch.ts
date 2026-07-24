import { NodeStream } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { PassThrough } from "node:stream"

export interface Child {
  readonly pid: number | null
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exited: Promise<number>
  stop(): Promise<void>
}

type Options = {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
}

export function spawn(cmd: string, args: string[], opts?: Options): Child
export function spawn(cmd: string, opts?: Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Options, opts?: Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const scope = Effect.runSync(Scope.make())
  const started = Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(cmd, args, {
          cwd: cfg?.cwd,
          env:
            cfg?.env === null
              ? {}
              : Object.fromEntries(
                  Object.entries(cfg?.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
          extendEnv: cfg?.env !== null,
          stdin: NodeStream.fromReadable({
            evaluate: () => stdin,
            onError: (error) => error,
          }).pipe(Stream.orDie),
          forceKillAfter: "5 seconds",
        }),
      )
      NodeStream.toReadableNever(handle.stdout).pipe(stdout)
      NodeStream.toReadableNever(handle.stderr).pipe(stderr)
      return handle
    }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer), Effect.provideService(Scope.Scope, scope)),
  )
  void started.catch((error) => {
    stdin.destroy(error)
    stdout.destroy(error)
    stderr.destroy(error)
  })

  return {
    pid: null,
    stdin,
    stdout,
    stderr,
    exited: started.then((handle) => Effect.runPromise(handle.exitCode)).then(Number),
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
