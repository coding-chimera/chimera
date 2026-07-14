import { createHash } from "crypto"
import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID } from "./schema"
import { Schema } from "effect"
import type { ModelMessage, Tool } from "ai"

const ContextMarker = "<runtime-context>"
const RuntimeContextTerms = ["## Current Work Brief", "## Chimera Execution Context", ContextMarker]

export const Block = Schema.Struct({
  kind: Schema.String,
  role: Schema.optional(Schema.String),
  chars: Schema.Number,
  bytes: Schema.Number,
  approxTokens: Schema.Number,
  hash: Schema.String,
})
export type Block = Schema.Schema.Type<typeof Block>

export const Info = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  stage: Schema.Literal("prepared"),
  step: Schema.Number,
  agent: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  createdAt: Schema.Number,
  totals: Schema.Struct({
    chars: Schema.Number,
    bytes: Schema.Number,
    approxTokens: Schema.Number,
    blocks: Schema.Number,
  }),
  fingerprints: Schema.Struct({
    system: Schema.String,
    history: Schema.String,
    runtime: Schema.String,
    current: Schema.String,
    memory: Schema.String,
    tools: Schema.String,
    request: Schema.String,
  }),
  blocks: Schema.Array(Block),
  warnings: Schema.Array(Schema.String),
})
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define("session.prompt.stats", Info),
}

function serialize(input: unknown) {
  if (input === undefined) return ""
  if (typeof input === "string") return input
  return JSON.stringify(input)
}

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

function summarizeBlock(kind: string, role: string | undefined, input: unknown): Block {
  const text = serialize(input)
  return {
    kind,
    ...(role ? { role } : {}),
    chars: text.length,
    bytes: Buffer.byteLength(text),
    approxTokens: Math.ceil(text.length / 4),
    hash: hash(text),
  }
}

function containsRuntimeContext(input: unknown) {
  const text = serialize(input)
  return RuntimeContextTerms.some((term) => text.includes(term))
}

function countRuntimeSections(input: unknown) {
  return (serialize(input).match(new RegExp(ContextMarker, "g")) ?? []).length
}

function toolSummary(tools: Record<string, Tool>) {
  return Object.entries(tools)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, tool]) => ({ id, description: tool.description, inputSchema: tool.inputSchema }))
}

export function summarizePreparedRequest(input: {
  sessionID: SessionID
  messageID: MessageID
  step: number
  agent: string
  providerID: string
  modelID: string
  system: string[]
  history: ModelMessage[]
  runtime: ModelMessage[]
  current: ModelMessage[]
  memory?: ModelMessage[]
  extra: ModelMessage[]
  tools: Record<string, Tool>
}): Info {
  const memory = input.memory ?? []
  const blocks = [
    summarizeBlock("system", "system", input.system),
    summarizeBlock("history", undefined, input.history),
    summarizeBlock("runtime_context", "user", input.runtime),
    summarizeBlock("memory_context", "user", memory),
    summarizeBlock("current_turn", "user", input.current),
    summarizeBlock("extra", undefined, input.extra),
    summarizeBlock("tools", undefined, toolSummary(input.tools)),
  ].filter((block) => block.chars > 0)
  const totals = blocks.reduce(
    (acc, block) => ({
      chars: acc.chars + block.chars,
      bytes: acc.bytes + block.bytes,
      approxTokens: acc.approxTokens + block.approxTokens,
      blocks: acc.blocks + 1,
    }),
    { chars: 0, bytes: 0, approxTokens: 0, blocks: 0 },
  )
  const warnings = [
    containsRuntimeContext(input.system) ? "runtime context leaked into system" : undefined,
    input.runtime.length > 1 ? "multiple runtime context messages" : undefined,
    countRuntimeSections(input.runtime) > 1 ? "duplicated runtime context markers" : undefined,
    memory.length > 1 ? "multiple memory context messages" : undefined,
    summarizeBlock("runtime_context", "user", input.runtime).bytes > 16_000 ? "runtime context over 16KB" : undefined,
    summarizeBlock("tools", undefined, toolSummary(input.tools)).bytes > 200_000 ? "tool schemas over 200KB" : undefined,
  ].filter((warning): warning is string => Boolean(warning))
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    stage: "prepared",
    step: input.step,
    agent: input.agent,
    providerID: input.providerID,
    modelID: input.modelID,
    createdAt: Date.now(),
    totals,
    fingerprints: {
      system: hash(serialize(input.system)),
      history: hash(serialize(input.history)),
      runtime: hash(serialize(input.runtime)),
      memory: hash(serialize(memory)),
      current: hash(serialize(input.current)),
      tools: hash(serialize(toolSummary(input.tools))),
      request: hash(serialize({ system: input.system, history: input.history, runtime: input.runtime, memory, current: input.current, extra: input.extra, tools: toolSummary(input.tools) })),
    },
    blocks,
    warnings,
  }
}

export * as PromptStats from "./prompt-stats"
