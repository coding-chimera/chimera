const DEFAULT_DISPOSER_TIMEOUT_MS = 4_000

type Disposer = (directory: string) => Promise<void>

type RegisteredDisposer = {
  id: number
  name: string
  dispose: Disposer
}

export type DisposeResult = {
  id: number
  name: string
  directory: string
  elapsed: number
  status: "fulfilled" | "rejected" | "timed_out"
  error?: string
}

const disposers = new Set<RegisteredDisposer>()
let nextDisposerID = 0

function envTimeout() {
  const raw = process.env.OPENCODE_INSTANCE_DISPOSER_TIMEOUT_MS
  if (!raw) return DEFAULT_DISPOSER_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISPOSER_TIMEOUT_MS
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function registerDisposer(disposer: Disposer, name = disposer.name || "anonymous-disposer") {
  const entry = { id: nextDisposerID++, name, dispose: disposer }
  disposers.add(entry)
  return () => {
    disposers.delete(entry)
  }
}

async function runDisposer(
  entry: RegisteredDisposer,
  directory: string,
  timeoutMs: number,
): Promise<DisposeResult> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race<
      { status: "fulfilled" } | { status: "rejected"; error: unknown } | { status: "timed_out" }
    >([
      Promise.resolve()
        .then(() => entry.dispose(directory))
        .then(
          () => ({ status: "fulfilled" as const }),
          (error) => ({ status: "rejected" as const, error }),
        ),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs)
      }),
    ])
    const elapsed = Date.now() - start
    if (result.status === "fulfilled") return { id: entry.id, name: entry.name, directory, elapsed, status: "fulfilled" }
    if (result.status === "timed_out") {
      return {
        id: entry.id,
        name: entry.name,
        directory,
        elapsed,
        status: "timed_out",
        error: `Timed out after ${timeoutMs}ms`,
      }
    }
    return {
      id: entry.id,
      name: entry.name,
      directory,
      elapsed,
      status: "rejected",
      error: toErrorMessage(result.error),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function disposeInstance(directory: string, options?: { timeoutMs?: number }) {
  const timeoutMs = options?.timeoutMs ?? envTimeout()
  return Promise.all([...disposers].map((entry) => runDisposer(entry, directory, timeoutMs)))
}
