export type Scenario = "s1" | "s2" | "s3" | "s4"

export type Agg = { min: number; p50: number; p95: number; max: number }

export type RunResult = {
  scenario: Scenario
  label: string
  repeat: number
  wall_total_ms: number
  timed_out: boolean
  planned: number
  completed: number
  errored: number
  pending: number
  missing_samples: number
  sampler_ok: boolean
  llm_hits: number
  dispatch: Agg | undefined
  exec: Agg | undefined
  result: Agg | undefined
  throughput: number
  overlap_factor: number
  round_gaps: number[]
  events: Record<string, number>
  errors: string[]
}

function pick(sorted: number[], q: number) {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
}

export function aggregate(values: number[]): Agg | undefined {
  if (!values.length) return
  const sorted = [...values].sort((a, b) => a - b)
  return { min: sorted[0], p50: pick(sorted, 0.5), p95: pick(sorted, 0.95), max: sorted[sorted.length - 1] }
}

export function median(values: number[]): number | undefined {
  if (!values.length) return
  return pick([...values].sort((a, b) => a - b), 0.5)
}

export function medianAgg(aggs: (Agg | undefined)[]): Agg | undefined {
  const list = aggs.filter((item): item is Agg => item !== undefined)
  if (!list.length) return
  return {
    min: median(list.map((item) => item.min)) ?? 0,
    p50: median(list.map((item) => item.p50)) ?? 0,
    p95: median(list.map((item) => item.p95)) ?? 0,
    max: median(list.map((item) => item.max)) ?? 0,
  }
}
