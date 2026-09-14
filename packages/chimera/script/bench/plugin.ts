// Sampler plugin for the burst benchmark. This file is *copied* (as text)
// into <tmp-project>/.chimera/plugin/bench-sampler.ts where the runtime
// auto-discovers it. Keep it dependency-free (no imports, structural types
// only) so it runs standalone under Bun in any directory, and never throw
// from a hook: the hooks only push plain samples onto globals that the
// harness reads back in the same process.

type BeforeSample = { callID: string; tool: string; t0: number }
type AfterSample = { callID: string; t1: number }

function bucket<T>(key: string): T[] {
  const store = globalThis as Record<string, unknown>
  const existing = store[key] as T[] | undefined
  if (existing) return existing
  const created: T[] = []
  store[key] = created
  return created
}

function bump(key: string, field: string) {
  const store = globalThis as Record<string, unknown>
  const counts = (store[key] as Record<string, number> | undefined) ?? {}
  counts[field] = (counts[field] ?? 0) + 1
  store[key] = counts
}

export default function () {
  return {
    async "tool.execute.before"(input: { tool: string; sessionID: string; callID: string }) {
      bucket<BeforeSample>("__benchBefore").push({ callID: input.callID, tool: input.tool, t0: Date.now() })
    },
    async "tool.execute.after"(input: { tool: string; sessionID: string; callID: string }) {
      bucket<AfterSample>("__benchAfter").push({ callID: input.callID, t1: Date.now() })
    },
    async event(input: { event: { type?: string } }) {
      bump("__benchEvents", input?.event?.type ?? "unknown")
    },
  }
}
