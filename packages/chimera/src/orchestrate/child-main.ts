/**
 * Orchestrate worker bootstrap.
 *
 * HARD CONSTRAINT: this file may import Node/Bun builtins only. It is bundled
 * into the single-file executable, so any import from `src/` could transitively
 * pull in modules with top-level await and break the compile. The protocol
 * vocabulary is therefore duplicated in miniature here (frame shapes only, no
 * shared module import).
 *
 * Lifecycle: verify the CHIMERA_ORCH_CHILD marker -> `ready` -> read `boot` ->
 * expose the declared bindings as async functions on a null-prototype `orche`
 * object -> run the program -> emit exactly one `done` frame and flush stdout.
 */

import { createInterface } from "node:readline"
import { inspect } from "node:util"

const MAX_FRAME_BYTES = 4 * 1024 * 1024
const DEFAULT_LOG_BYTES = 64 * 1024
const DEFAULT_RESULT_BYTES = 1024 * 1024
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface Boot {
  readonly program: string
  readonly namespaces: Record<string, readonly string[]>
  readonly maxLogBytes: number
  readonly maxResultBytes: number
}

const marker = process.env.CHIMERA_ORCH_CHILD
if (!marker) {
  process.stderr.write("orchestrate worker: missing CHIMERA_ORCH_CHILD\n")
  process.exit(2)
}

let writeChain: Promise<void> = Promise.resolve()

function writeFrame(frame: unknown): Promise<void> {
  const line = JSON.stringify(frame) + "\n"
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

/** Serialized frame writer; write failures (host gone) are swallowed. */
function emit(frame: unknown) {
  writeChain = writeChain.then(() => writeFrame(frame)).catch(() => {})
  return writeChain
}

function lossless(value: unknown, path = "$", seen = new WeakSet<object>()): string | undefined {
  if (value === null) return undefined
  switch (typeof value) {
    case "boolean":
    case "string":
      return undefined
    case "number":
      return Number.isFinite(value) ? undefined : `${path}: non-finite number`
    case "object":
      break
    default:
      return `${path}: ${typeof value} is not JSON`
  }
  const object = value as object
  if (seen.has(object)) return `${path}: circular reference`
  seen.add(object)
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index++) {
      if (!(index in object)) return `${path}[${index}]: sparse array`
      const problem = lossless(object[index], `${path}[${index}]`, seen)
      if (problem) return problem
    }
    seen.delete(object)
    return undefined
  }
  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) return `${path}: non-plain object`
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string") return `${path}: non-string key`
    const problem = lossless((object as Record<string, unknown>)[key], `${path}.${key}`, seen)
    if (problem) return problem
  }
  seen.delete(object)
  return undefined
}

function encodeResult(value: unknown) {
  const problem = lossless(value)
  if (problem) return { ok: false as const, message: problem }
  try {
    return { ok: true as const, text: JSON.stringify(value) }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBoot(line: string): Boot | undefined {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.type !== "boot") return undefined
  if (typeof parsed.program !== "string") return undefined
  if (!isRecord(parsed.namespaces)) return undefined
  const namespaces: Record<string, readonly string[]> = {}
  for (const [namespace, names] of Object.entries(parsed.namespaces)) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) return undefined
    namespaces[namespace] = [...(names as string[])]
  }
  const budgets = parsed.budgets
  if (!isRecord(budgets)) return undefined
  const maxLogBytes = budgets.maxLogBytes
  const maxResultBytes = budgets.maxResultBytes
  return {
    program: parsed.program,
    namespaces,
    maxLogBytes: typeof maxLogBytes === "number" && Number.isFinite(maxLogBytes) ? maxLogBytes : DEFAULT_LOG_BYTES,
    maxResultBytes:
      typeof maxResultBytes === "number" && Number.isFinite(maxResultBytes) ? maxResultBytes : DEFAULT_RESULT_BYTES,
  }
}

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function bindingError(name: string, message: string) {
  const error = new Error(message)
  error.name = name
  return error
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value
  return inspect(value, { depth: 4, breakLength: Infinity, maxArrayLength: 100, maxStringLength: 10_000 })
}

async function main() {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const lines = reader[Symbol.asyncIterator]()

  // Handshake first: the host waits for `ready` before it will send `boot`.
  void emit({ type: "ready" })

  const first = await lines.next()
  if (first.done) return process.exit(0)
  const boot = parseBoot(first.value)
  if (!boot) {
    await emit({ type: "done", error: { kind: "protocol", message: "worker expected a boot frame" } })
    return process.exit(1)
  }

  let finished = false
  let nextID = 1
  let logBytes = 0
  let logsOverflow = false
  let protocolFailure: string | undefined
  const pending = new Map<
    number,
    { name: string; resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >()

  const failPending = (message: string) => {
    for (const entry of pending.values()) entry.reject(bindingError(entry.name, message))
    pending.clear()
  }

  const emitLog = (text: string) => {
    if (finished || logsOverflow) return
    const bytes = Buffer.byteLength(text, "utf8")
    if (logBytes + bytes > boot.maxLogBytes) {
      logsOverflow = true
      return
    }
    logBytes += bytes
    void emit({ type: "log", text })
  }

  const shim: Record<string, (...args: unknown[]) => void> = {}
  for (const method of CONSOLE_METHODS) {
    shim[method] = (...args: unknown[]) => emitLog(args.map(formatValue).join(" "))
  }

  const makeBinding = (name: string) => async (args: unknown) => {
    const problem = lossless(args)
    if (problem) throw bindingError(name, `arguments are not lossless JSON: ${problem}`)
    if (finished) throw bindingError(name, "orchestration worker is shutting down")
    const id = nextID++
    const promise = new Promise<JsonValue>((resolve, reject) => pending.set(id, { name, resolve, reject }))
    await emit({ type: "call", id, name, args })
    return promise
  }

  const orche: Record<string, unknown> = Object.create(null)
  for (const [namespace, names] of Object.entries(boot.namespaces)) {
    const bindings: Record<string, unknown> = Object.create(null)
    for (const name of names) bindings[name] = makeBinding(name)
    orche[namespace] = bindings
  }

  // The host bindings live under the `orche` namespace, but the program's
  // primary surface is the `orche` object itself (`orche.agent(...)`,
  // `orche.parallel(...)`). Flatten that one namespace onto the container;
  // other namespaces keep their `orche.<namespace>.<name>` shape.
  const orcheNamespace = isRecord(orche.orche) ? (orche.orche as Record<string, unknown>) : undefined
  if (orcheNamespace) {
    for (const [name, binding] of Object.entries(orcheNamespace)) {
      if (!(name in orche)) orche[name] = binding
    }
  }

  // Child-side pure-JS helpers. These never cross the wire: `parallel` and
  // `pipeline` compose agent() results locally, `log` rides the existing log
  // frame channel through the console shim. Host-declared bindings win on a
  // name collision (the boot frame is host-generated, so this is defensive).
  const helpers: Record<string, unknown> = {
    parallel: (tasks: unknown) => {
      if (!Array.isArray(tasks)) throw bindingError("parallel", "orche.parallel expects an array")
      return Promise.all(tasks.map((task) => (typeof task === "function" ? (task as () => unknown)() : task)))
    },
    pipeline: (stages: unknown) => {
      if (!Array.isArray(stages)) throw bindingError("pipeline", "orche.pipeline expects an array of stages")
      return async (items: unknown) => {
        if (!Array.isArray(items)) throw bindingError("pipeline", "orche.pipeline(...) expects an array of items")
        return Promise.all(
          items.map(async (item) => {
            let value: unknown = item
            for (const stage of stages) {
              if (typeof stage !== "function") {
                throw bindingError("pipeline", "orche.pipeline stages must be functions")
              }
              try {
                value = await (stage as (input: unknown) => unknown)(value)
              } catch {
                return null
              }
              if (value === null) return null
            }
            return value
          }),
        )
      }
    },
    log: (...args: unknown[]) => {
      shim.log(...args)
    },
  }
  for (const [name, helper] of Object.entries(helpers)) {
    if (!(name in orche)) orche[name] = helper
  }

  const handleHostLine = (line: string) => {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      protocolFailure = "host frame exceeds the size limit"
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      protocolFailure = "host frame is not valid JSON"
      return
    }
    if (!isRecord(parsed) || parsed.type !== "reply") {
      protocolFailure = "host sent an unexpected frame"
      return
    }
    const id = parsed.id
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      protocolFailure = "reply.id must be a safe integer"
      return
    }
    const entry = pending.get(id)
    if (!entry) {
      protocolFailure = `reply for unknown call id ${id}`
      return
    }
    pending.delete(id)
    if (parsed.ok === true) {
      entry.resolve((Object.hasOwn(parsed, "value") ? parsed.value : null) as JsonValue)
      return
    }
    if (parsed.ok === false && typeof parsed.message === "string") {
      entry.reject(bindingError(entry.name, parsed.message))
      return
    }
    protocolFailure = "malformed reply frame"
  }

  const pump = (async () => {
    while (true) {
      const next = await lines.next()
      if (next.done) return
      if (finished) continue
      handleHostLine(next.value)
      if (protocolFailure) failPending(protocolFailure)
    }
  })()

  const finish = async (frame: Record<string, unknown>) => {
    if (finished) return
    finished = true
    reader.close()
    await emit(frame)
    await writeChain
    process.exit(0)
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>

  let outcome: { value?: unknown; error?: string } = {}
  try {
    outcome = { value: await new AsyncFunction("orche", "console", boot.program)(orche, shim) }
  } catch (error) {
    outcome = { error: messageOf(error) }
  }

  // Let the stdin pump settle (host may already be gone).
  void pump.catch(() => {})

  if (protocolFailure) {
    return finish({ type: "done", error: { kind: "protocol", message: protocolFailure } })
  }
  if (logsOverflow) {
    return finish({
      type: "done",
      error: { kind: "output-limit", message: `console output exceeded ${boot.maxLogBytes} bytes` },
    })
  }
  if (outcome.error !== undefined) {
    return finish({ type: "done", error: { kind: "exception", message: outcome.error } })
  }
  if (outcome.value === undefined) return finish({ type: "done" })

  const encoded = encodeResult(outcome.value)
  if (!encoded.ok) {
    return finish({
      type: "done",
      error: { kind: "invalid-output", message: `program result is not lossless JSON: ${encoded.message}` },
    })
  }
  if (Buffer.byteLength(encoded.text, "utf8") > boot.maxResultBytes) {
    return finish({
      type: "done",
      error: { kind: "output-limit", message: `program result exceeded ${boot.maxResultBytes} bytes` },
    })
  }
  return finish({ type: "done", value: JSON.parse(encoded.text) })
}

await main()
