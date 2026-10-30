import type { DbRow, TranscriptLayer } from "./format"

export type ScenarioTool = {
  call_id: string
  tool: string
  input: Record<string, unknown>
  status: "ok" | "error"
  output: Record<string, unknown>
}

export type ScenarioSseFrame = {
  stream_id: string
  event: string
  data: Record<string, unknown>
}

export type Scenario = {
  id: string
  layer: TranscriptLayer
  description: string
  // Golden filename under transcript/golden/.
  golden: string
  prompt: { key: string; content: string }[]
  tools: ScenarioTool[]
  db: { table: string; rows: DbRow[] }
  sse: ScenarioSseFrame[]
}