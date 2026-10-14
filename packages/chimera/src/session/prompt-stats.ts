import { createHash } from "crypto"
import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID } from "@/contracts/session-ids"
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

function summarizeBlock(kind: string, role: string | undefined, text: string): Block {
  return {
    kind,
    ...(role ? { role } : {}),
    chars: text.length,
    bytes: Buffer.byteLength(text),
    approxTokens: Math.ceil(text.length / 4),
    hash: hash(text),
  }
}

function containsRuntimeContext(text: string) {
  return RuntimeContextTerms.some((term) => text.includes(term))
}

function countRuntimeSections(text: string) {
  return (text.match(new RegExp(ContextMarker, "g")) ?? []).length
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
  // Serialize each input exactly once and reuse it for blocks, warnings and
  // fingerprints. The previous version re-serialized history three times and
  // rebuilt toolSummary four times per LLM step.
  const systemText = serialize(input.system)
  const historyText = serialize(input.history)
  const runtimeText = serialize(input.runtime)
  const memoryText = serialize(memory)
  const currentText = serialize(input.current)
  const extraText = serialize(input.extra)
  const toolsText = serialize(toolSummary(input.tools))
  const runtimeBlock = summarizeBlock("runtime_context", "user", runtimeText)
  const toolsBlock = summarizeBlock("tools", undefined, toolsText)
  const blocks = [
    summarizeBlock("system", "system", systemText),
    summarizeBlock("history", undefined, historyText),
    runtimeBlock,
    summarizeBlock("memory_context", "user", memoryText),
    summarizeBlock("current_turn", "user", currentText),
    summarizeBlock("extra", undefined, extraText),
    toolsBlock,
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
    containsRuntimeContext(systemText) ? "runtime context leaked into system" : undefined,
    input.runtime.length > 1 ? "multiple runtime context messages" : undefined,
    countRuntimeSections(runtimeText) > 1 ? "duplicated runtime context markers" : undefined,
    memory.length > 1 ? "multiple memory context messages" : undefined,
    runtimeBlock.bytes > 16_000 ? "runtime context over 16KB" : undefined,
    toolsBlock.bytes > 200_000 ? "tool schemas over 200KB" : undefined,
  ].filter((warning): warning is string => Boolean(warning))
  const fingerprints = {
    system: hash(systemText),
    history: hash(historyText),
    runtime: hash(runtimeText),
    memory: hash(memoryText),
    current: hash(currentText),
    tools: hash(toolsText),
  }
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
      ...fingerprints,
      // Chained digest of the per-block hashes instead of re-serializing the
      // whole request into a second giant string. Consumers (TUI sidebar,
      // `chimera run` event stream) use `request` only as an opaque display /
      // equality id, never comparing it across versions, so determinism plus
      // input-sensitivity is preserved without the extra full serialization.
      request: hash(
        [fingerprints.system, fingerprints.history, fingerprints.runtime, fingerprints.memory, fingerprints.current, hash(extraText), fingerprints.tools].join(":"),
      ),
    },
    blocks,
    warnings,
  }
}

export * as PromptStats from "./prompt-stats"
