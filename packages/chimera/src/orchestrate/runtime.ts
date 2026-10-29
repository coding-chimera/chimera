/**
 * OrchestrateRuntime — host-side seam for running a model-authored orchestration
 * program in a dedicated worker process.
 *
 * Two-phase contract:
 * - `resolve(request)` validates/normalizes everything (absolute cwd, clamped
 *   budgets, binding index) and returns a fully resolved spec.
 * - `run(spec)` spawns the worker and returns a result. A failing *program* is
 *   reported through `result.error`; only caller misuse rejects.
 *
 * The worker is a hostile peer: it runs arbitrary model code and can write
 * arbitrary stdout bytes. Every inbound line is re-parsed through
 * `protocol.ts`, and ids/bindings/args are re-validated here.
 */

import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Queue, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  PROTOCOL_LIMITS,
  checkLosslessJson,
  encodeLosslessJson,
  isStrictlyIncreasingCallID,
  parseChildFrame,
  utf8ByteLength,
  type HostFrame,
  type JsonValue,
} from "@/orchestrate/protocol"

export type ErrorKind =
  | "exception"
  | "timeout"
  | "abort"
  | "worker-exit"
  | "invalid-output"
  | "output-limit"
  | "protocol"

export interface ResultError {
  readonly kind: ErrorKind
  readonly message: string
}

export interface Result {
  readonly value?: JsonValue
  readonly logs: string[]
  readonly error?: ResultError
}

/** A host-side binding exposed to the program under a namespace. */
export type Binding = (args: JsonValue) => JsonValue | Promise<JsonValue>

export type Bindings = Readonly<Record<string, Readonly<Record<string, Binding>>>>

export interface Request {
  readonly code: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxPending?: number
  readonly maxLogBytes?: number
  readonly maxResultBytes?: number
  readonly signal?: AbortSignal
  readonly bindings?: Bindings
  /** Called once per program log line as it arrives; never used for the final result snapshot. */
  readonly onLog?: (line: string) => void
}

export interface Spec {
  readonly code: string
  readonly cwd: string
  readonly timeoutMs?: number
  readonly maxPending: number
  readonly maxLogBytes: number
  readonly maxResultBytes: number
  readonly signal?: AbortSignal
  readonly bindings: Bindings
  readonly namespaces: Readonly<Record<string, readonly string[]>>
  /** Binding name -> implementation. Names are globally unique across namespaces. */
  readonly bindingIndex: ReadonlyMap<string, Binding>
  readonly onLog?: (line: string) => void
}

export class OrchestrateConfigError extends Schema.TaggedErrorClass<OrchestrateConfigError>()(
  "OrchestrateConfigError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly resolve: (request: Request) => Effect.Effect<Spec, OrchestrateConfigError>
  /** Program failures are returned as `result.error`; this effect never fails. */
  readonly run: (spec: Spec) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrateRuntime") {}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const RESERVED = new Set(["__proto__", "prototype", "constructor"])
const POSIX_PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "LANG"]
const WINDOWS_PASSTHROUGH = ["SystemRoot", "windir", "PATHEXT", "COMSPEC"]
const FORBIDDEN_ENV = ["BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS"]
const CHILD_ERROR_KINDS = new Set<ErrorKind>(["exception", "protocol", "invalid-output", "output-limit"])

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** Optional wall-clock budget: absent or non-positive means no timer at all; positive values floor at 1ms. */
function positiveMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value <= 0) return undefined
  return Math.max(Math.trunc(value), 1)
}

function isStandaloneExecutable() {
  const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun
  return bun?.isStandaloneExecutable === true
}

/**
 * Two argv shapes only:
 * - packaged single binary: re-enter self with the child flag
 * - source mode: bun <entry.ts> --orch-child (never read process.argv[1])
 */
function workerArgv() {
  if (isStandaloneExecutable()) return [process.execPath, "--orch-child"]
  return [process.execPath, fileURLToPath(new URL("../entry.ts", import.meta.url)), "--orch-child"]
}

/**
 * Full env replacement (never inherit): only OS/locale plumbing survives, plus
 * the worker marker and process role. Bun/Node option injection and every
 * credential variable are dropped by construction.
 */
function childEnv(token: string) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const allowed =
      POSIX_PASSTHROUGH.includes(key) ||
      key.startsWith("LC_") ||
      (process.platform === "win32" && WINDOWS_PASSTHROUGH.includes(key))
    if (allowed) env[key] = value
  }
  for (const key of FORBIDDEN_ENV) delete env[key]
  env.CHIMERA_ORCH_CHILD = token
  env.OPENCODE_PROCESS_ROLE = "worker"
  return env
}

function childErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function normalizedKind(kind: string): ErrorKind {
  return CHILD_ERROR_KINDS.has(kind as ErrorKind) ? (kind as ErrorKind) : "exception"
}

const resolve = Effect.fn("OrchestrateRuntime.resolve")(function* (request: Request) {
  if (typeof request.code !== "string" || request.code.trim().length === 0) {
    return yield* new OrchestrateConfigError({ message: "code must be a non-empty string" })
  }

  const bindings: Record<string, Record<string, Binding>> = {}
  const bindingIndex = new Map<string, Binding>()
  const namespaces: Record<string, readonly string[]> = {}
  for (const [namespace, group] of Object.entries(request.bindings ?? {})) {
    if (!IDENTIFIER.test(namespace) || RESERVED.has(namespace)) {
      return yield* new OrchestrateConfigError({ message: `invalid namespace name: ${namespace}` })
    }
    const target: Record<string, Binding> = {}
    for (const [name, binding] of Object.entries(group)) {
      if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
        return yield* new OrchestrateConfigError({ message: `invalid binding name: ${name}` })
      }
      if (typeof binding !== "function") {
        return yield* new OrchestrateConfigError({ message: `binding ${name} must be a function` })
      }
      // Call frames carry a bare name, so names must be globally unique.
      if (bindingIndex.has(name)) {
        return yield* new OrchestrateConfigError({ message: `duplicate binding name across namespaces: ${name}` })
      }
      target[name] = binding
      bindingIndex.set(name, binding)
    }
    bindings[namespace] = target
    namespaces[namespace] = Object.keys(target)
  }

  return {
    code: request.code,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    timeoutMs: positiveMs(request.timeoutMs),
    maxPending: clamp(request.maxPending, PROTOCOL_LIMITS.maxPendingCalls, 1, PROTOCOL_LIMITS.maxPendingCalls),
    maxLogBytes: clamp(request.maxLogBytes, PROTOCOL_LIMITS.defaultLogBytes, 1, PROTOCOL_LIMITS.maxFrameBytes),
    maxResultBytes: clamp(request.maxResultBytes, PROTOCOL_LIMITS.defaultResultBytes, 1, PROTOCOL_LIMITS.maxFrameBytes),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onLog ? { onLog: request.onLog } : {}),
    bindings,
    namespaces,
    bindingIndex,
  } satisfies Spec
})

function waitForAbort(signal: AbortSignal) {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

const makeRun = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.fn("OrchestrateRuntime.run")(function* (spec: Spec) {
    const logs: string[] = []
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const encoder = new TextEncoder()
        let logBytes = 0
        let stderr = ""
        let lastCallID = 0
        let booted = false
        const pending = new Set<number>()

        const finished = yield* Deferred.make<Result>()
        const exitCode = yield* Deferred.make<number>()
        const inbox = yield* Queue.unbounded<Uint8Array, Cause.Done>()

        const result = (extra: { value?: JsonValue; error?: ResultError }): Result => {
          const snapshot: Result = { logs: [...logs] }
          if (extra.error) return { ...snapshot, error: extra.error }
          return extra.value === undefined ? snapshot : { ...snapshot, value: extra.value }
        }

        const complete = (extra: { value?: JsonValue; error?: ResultError }) =>
          Deferred.succeed(finished, result(extra)).pipe(Effect.asVoid)

        const fail = (error: ResultError) => complete({ error })

        const send = (frame: HostFrame) => Queue.offer(inbox, encoder.encode(JSON.stringify(frame) + "\n"))

        const handleLine = (line: string) =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(finished)) return
            if (utf8ByteLength(line) > PROTOCOL_LIMITS.maxFrameBytes) {
              return yield* fail({
                kind: "protocol",
                message: `worker frame exceeds ${PROTOCOL_LIMITS.maxFrameBytes} bytes`,
              })
            }
            const parsed = parseChildFrame(line)
            if (!parsed.ok) return yield* fail({ kind: "protocol", message: parsed.message })
            const frame = parsed.frame

            if (frame.type === "ready") {
              if (booted) return yield* fail({ kind: "protocol", message: "duplicate ready frame" })
              booted = true
              yield* send({
                type: "boot",
                program: spec.code,
                namespaces: spec.namespaces,
                budgets: {
                  ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
                  maxPending: spec.maxPending,
                  maxLogBytes: spec.maxLogBytes,
                  maxResultBytes: spec.maxResultBytes,
                  maxFrameBytes: PROTOCOL_LIMITS.maxFrameBytes,
                },
              })
              return
            }

            if (!booted) return yield* fail({ kind: "protocol", message: `received ${frame.type} before ready` })

            if (frame.type === "log") {
              const bytes = utf8ByteLength(frame.text)
              if (logBytes + bytes > spec.maxLogBytes) {
                return yield* fail({ kind: "output-limit", message: `logs exceeded ${spec.maxLogBytes} bytes` })
              }
              logBytes += bytes
              logs.push(frame.text)
              // A host callback must never break protocol handling: swallow any defect it throws.
              yield* Effect.sync(() => spec.onLog?.(frame.text)).pipe(Effect.catchCause(() => Effect.void))
              return
            }

            if (frame.type === "call") {
              if (!isStrictlyIncreasingCallID(lastCallID, frame.id)) {
                return yield* fail({ kind: "protocol", message: `call id ${frame.id} is not strictly increasing` })
              }
              const binding = spec.bindingIndex.get(frame.name)
              if (!binding) return yield* fail({ kind: "protocol", message: `unknown binding: ${frame.name}` })
              const argsProblem = checkLosslessJson(frame.args)
              if (argsProblem) {
                return yield* fail({ kind: "protocol", message: `call args are not lossless JSON: ${argsProblem}` })
              }
              if (pending.size >= spec.maxPending) {
                return yield* fail({ kind: "protocol", message: `pending calls exceeded ${spec.maxPending}` })
              }
              lastCallID = frame.id
              pending.add(frame.id)
              yield* Effect.forkScoped(invokeBinding(frame.id, frame.name, binding, frame.args))
              return
            }

            // done
            if (frame.error) {
              return yield* complete({
                error: { kind: normalizedKind(frame.error.kind), message: frame.error.message },
              })
            }
            if (frame.value === undefined) return yield* complete({})
            const problem = checkLosslessJson(frame.value)
            if (problem) {
              return yield* fail({ kind: "invalid-output", message: `program result is not lossless JSON: ${problem}` })
            }
            const encoded = encodeLosslessJson(frame.value)
            if (!encoded.ok) return yield* fail({ kind: "invalid-output", message: encoded.message })
            if (utf8ByteLength(encoded.text) > spec.maxResultBytes) {
              return yield* fail({
                kind: "output-limit",
                message: `program result exceeded ${spec.maxResultBytes} bytes`,
              })
            }
            return yield* complete({ value: frame.value })
          })

        const invokeBinding = (id: number, name: string, binding: Binding, args: JsonValue): Effect.Effect<void> =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              Effect.tryPromise({
                try: () => Promise.resolve(binding(args)),
                catch: (error) => error,
              }),
            )
            pending.delete(id)
            if (yield* Deferred.isDone(finished)) return
            if (Exit.isFailure(exit)) {
              yield* send({ type: "reply", id, ok: false, message: childErrorMessage(Cause.squash(exit.cause)) })
              return
            }
            const problem = checkLosslessJson(exit.value)
            if (problem) {
              yield* send({
                type: "reply",
                id,
                ok: false,
                message: `binding ${name} returned non-lossless JSON: ${problem}`,
              })
              return
            }
            yield* send({ type: "reply", id, ok: true, value: exit.value as JsonValue })
          })

        const workerExit = Effect.gen(function* () {
          const code = yield* Deferred.await(exitCode).pipe(
            Effect.timeoutOption("1 second"),
            Effect.map((option) => Option.getOrUndefined(option)),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          const detail = stderr.trim()
          yield* Deferred.succeed(
            finished,
            result({
              error: {
                kind: "worker-exit",
                message: `orchestration worker exited${code === undefined ? "" : ` with code ${code}`} before completing${
                  detail ? `: ${detail}` : ""
                }`,
              },
            }),
          )
        })

        const signal = (name: "SIGTERM" | "SIGKILL") =>
          Effect.suspend(() => {
            if (process.platform === "win32") return handle.kill({ killSignal: name }).pipe(Effect.ignore)
            try {
              process.kill(-Number(handle.pid), name)
              return Effect.void
            } catch {
              return handle.kill({ killSignal: name }).pipe(Effect.ignore)
            }
          })

        const terminate = Effect.gen(function* () {
          yield* Queue.end(inbox).pipe(Effect.ignore)
          const running = yield* handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false)))
          if (!running) return
          yield* signal("SIGTERM")
          const exited = yield* handle.exitCode.pipe(
            Effect.timeoutOption("3 seconds"),
            Effect.catch(() => Effect.succeed(Option.none())),
          )
          if (Option.isSome(exited)) return
          yield* signal("SIGKILL")
          yield* handle.exitCode.pipe(Effect.ignore)
        })

        const [command, ...args] = workerArgv()
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd: spec.cwd,
            env: childEnv(randomUUID()),
            extendEnv: false,
            stdin: Stream.fromQueue(inbox),
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
          }),
        )

        yield* Effect.forkScoped(
          handle.exitCode.pipe(
            Effect.map((code) => Number(code)),
            Effect.catch(() => Effect.succeed(-1)),
            Effect.flatMap((code) => Deferred.succeed(exitCode, code)),
            Effect.asVoid,
          ),
        )

        yield* Effect.forkScoped(
          Stream.decodeText(handle.stderr).pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                if (utf8ByteLength(stderr) >= PROTOCOL_LIMITS.maxStderrBytes) return
                stderr += chunk
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        yield* Effect.forkScoped(
          Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.runForEach(handleLine),
            Effect.catchCause((cause) => fail({ kind: "protocol", message: Cause.pretty(cause) })),
            Effect.flatMap(() => workerExit),
          ),
        )

        if (spec.timeoutMs !== undefined) {
          const timeoutMs = spec.timeoutMs
          yield* Effect.forkScoped(
            Effect.sleep(timeoutMs).pipe(
              Effect.andThen(fail({ kind: "timeout", message: `orchestration exceeded ${timeoutMs}ms` })),
              Effect.asVoid,
            ),
          )
        }

        if (spec.signal) {
          yield* Effect.forkScoped(
            waitForAbort(spec.signal).pipe(
              Effect.andThen(fail({ kind: "abort", message: "orchestration aborted" })),
              Effect.asVoid,
            ),
          )
        }

        const outcome = yield* Deferred.await(finished)
        yield* terminate
        return outcome
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          logs: [...logs],
          error: { kind: "worker-exit", message: Cause.pretty(cause) },
        } satisfies Result),
      ),
    )
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return Service.of({ resolve, run: makeRun(spawner) })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

export * as OrchestrateRuntime from "./runtime"
