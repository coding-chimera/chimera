import { raw, type Item } from "../../test/lib/llm-server"

export type Call = { name: string; args: Record<string, unknown> }

// Mirrors the line/chunk helpers in test/lib/llm-server.ts (:69-130); those
// are module-private, so the shapes are duplicated here deliberately.
function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-burst",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
  }
}

// One fake SSE response carrying N parallel tool calls emitted instantly,
// DeepSeek-flash style: assistant role line, then one delta per call with a
// DISTINCT choices[0].delta.tool_calls index, id, type, and the full JSON
// arguments inlined in that same delta, closed by finish_reason "tool_calls".
// `prefix` keeps call ids unique within one run.
export function burst(prefix: string, calls: Call[]): Item {
  return raw({
    chunks: [
      chunk({ role: "assistant" }),
      ...calls.map((call, index) =>
        chunk({
          tool_calls: [
            {
              index,
              id: `${prefix}_${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      ),
      chunk({}, "tool_calls"),
    ],
  })
}
