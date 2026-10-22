import { Effect } from "effect"
import { EOL } from "os"
import path from "path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { connectBunTransport } from "../../host/bun-transport"
import { REQUIRED_CAPABILITIES } from "../../host/ipc-handshake"
import {
  EXIT_INCOMPATIBLE,
  EXIT_TEMP_FAILURE,
  WorkerBootstrap,
  type HandshakeFailure,
  type RequestHandler,
  type WorkerIdentity,
} from "../../host/worker-bootstrap"
import { effectCmd } from "../effect-cmd"

const reportError = (error: Record<string, unknown>) => {
  process.stderr.write(JSON.stringify({ error }) + EOL)
}

/**
 * §9.3: a protocol/config rejection must not be retried; transport and
 * handshake-timeout failures are transient and the host may respawn.
 */
const handshakeExitCode = (failure: HandshakeFailure): number => {
  if (failure.code === "transport_error" || failure.code === "handshake_timeout") return EXIT_TEMP_FAILURE
  return EXIT_INCOMPATIBLE
}

/**
 * Hidden Bun worker entrypoint for the Rust host (schema v0). The host spawns
 * this command explicitly with `CHIMERA_HOST_SOCKET`, `CHIMERA_WORKER_NONCE`
 * and the workspace directory; it is not part of the public CLI surface
 * (`describe: false`) and no other command routes through it.
 *
 * Flow: connect → `WorkerBootstrap.runHandshake` → `serve` with a stub handler
 * that echoes the method name (host-side integration scaffolding). The serving
 * result is mapped onto the process exit code (§9.3) instead of exiting from
 * inside the bootstrap.
 */
export const BunWorkerCommand = effectCmd({
  command: "bun-worker [directory]",
  describe: false,
  // The worker only speaks the IPC socket; it must not load a project Instance.
  instance: false,
  builder: (yargs) =>
    yargs.positional("directory", {
      describe: "workspace directory served by this worker",
      type: "string",
    }),
  handler: Effect.fn("Cli.bunWorker")(function* (args) {
    const socketPath = process.env.CHIMERA_HOST_SOCKET
    const nonce = process.env.CHIMERA_WORKER_NONCE
    const directory = args.directory

    if (
      socketPath === undefined ||
      socketPath.length === 0 ||
      nonce === undefined ||
      nonce.length === 0 ||
      directory === undefined ||
      directory.length === 0
    ) {
      const missing = [
        socketPath === undefined || socketPath.length === 0 ? "CHIMERA_HOST_SOCKET" : undefined,
        nonce === undefined || nonce.length === 0 ? "CHIMERA_WORKER_NONCE" : undefined,
        directory === undefined || directory.length === 0 ? "directory argument" : undefined,
      ].filter((value): value is string => value !== undefined)
      reportError({
        code: "invalid_worker_bootstrap",
        message: `bun-worker is missing required bootstrap input: ${missing.join(", ")}`,
        missing,
      })
      process.exitCode = EXIT_INCOMPATIBLE
      return
    }

    const workspace = path.resolve(directory)
    const transport = yield* Effect.tryPromise({
      try: () => connectBunTransport(socketPath),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.catch((error) => {
        reportError({ code: "transport_connect_failed", message: error.message })
        process.exitCode = EXIT_TEMP_FAILURE
        return Effect.succeed(undefined)
      }),
    )
    if (transport === undefined) return
    const identity: WorkerIdentity = {
      pid: process.pid,
      build: `chimera-bun-worker@${InstallationVersion}`,
      runtime: `bun@${Bun.version}`,
      boot_id: `${Date.now()}_${process.pid}`,
      workspace: { directory: workspace, project_id: process.env.CHIMERA_WORKSPACE_ID ?? "unknown" },
      capabilities: [...REQUIRED_CAPABILITIES],
      encodings: ["json"],
    }
    const bootstrap = new WorkerBootstrap({ writer: transport.writer, reader: transport.reader, identity })

    const handshake = yield* Effect.promise(() => bootstrap.runHandshake(nonce))
    if (!handshake.ok) {
      reportError({
        code: handshake.code,
        message: handshake.message,
        ...(handshake.error === undefined ? {} : { detail: handshake.error }),
      })
      process.exitCode = handshakeExitCode(handshake)
      transport.close()
      return
    }

    // Integration stub: the host can verify framing/response correlation by
    // asking for any method and reading the echoed name back.
    const handler: RequestHandler = (request) => ({ result: { method: request.method } })
    const result = yield* Effect.promise(() => bootstrap.serve(handler))
    transport.close()
    process.exitCode = result.exitCode
  }),
})