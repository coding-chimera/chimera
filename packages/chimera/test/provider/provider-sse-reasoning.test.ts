import { describe, expect, test } from "bun:test"
import { Provider } from "@/provider/provider"

// W6 (responses-wire): SSE reasoning event rewriter. Relays on the responses
// wire may emit the non-standard "response.reasoning_text.delta"/".done" event
// names, which @ai-sdk/openai 3.0.88 does not map (zero grep hits for the bare
// names; unknown events fall into the unknown_chunk schema fallback at
// dist/index.js:4283-4287 and are silently dropped). The SDK does decode
// "response.reasoning_summary_text.delta" (dist/index.js:4258-4263 schema
// literal, 6734-6744 decode branch), so the fetch wrapper renames the events
// at the string level per complete SSE frame.

function sseResponse(chunks: string[], contentType = "text/event-stream") {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": contentType } },
  )
}

async function readBody(res: Response) {
  return await new Response(res.body).text()
}

describe("Provider.rewriteRelayReasoningEvents", () => {
  test("renames relay reasoning_text delta and done event names", async () => {
    const res = Provider.rewriteRelayReasoningEvents(
      sseResponse([
        `data: ${JSON.stringify({ type: "response.reasoning_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.reasoning_text.done", item_id: "rs_1", summary_index: 0 })}\n\n`,
      ]),
    )
    const body = await readBody(res)
    expect(body).toContain('"response.reasoning_summary_text.delta"')
    expect(body).toContain('"response.reasoning_summary_text.done"')
    expect(body).not.toContain('"response.reasoning_text.')
    expect(body).toContain('"delta":"thinking"')
  })

  test("is a no-op for non event-stream responses", async () => {
    const res = new Response('{"type":"response.reasoning_text.delta"}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
    expect(Provider.rewriteRelayReasoningEvents(res)).toBe(res)
  })

  test("passes streams without relay reasoning events through unchanged", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "hello" })}\n\n`,
      "data: [DONE]\n\n",
    ]
    const body = await readBody(Provider.rewriteRelayReasoningEvents(sseResponse(frames)))
    expect(body).toBe(frames.join(""))
  })

  test("renames event names split across chunk boundaries", async () => {
    const frame = `data: ${JSON.stringify({ type: "response.reasoning_text.delta", item_id: "rs_1", summary_index: 0, delta: "x" })}\n\n`
    const split = frame.indexOf("response.reasoning_text.") + 12
    const body = await readBody(
      Provider.rewriteRelayReasoningEvents(sseResponse([frame.slice(0, split), frame.slice(split)])),
    )
    expect(body).toContain('"response.reasoning_summary_text.delta"')
    expect(body).not.toContain('"response.reasoning_text.')
  })

  test("never JSON-parses frames: malformed relay frames only get the string rename", async () => {
    // F11 guard: a truncated/malformed frame must not throw or be dropped; the
    // rewriter operates purely on frame text.
    const malformed = 'data: {"type":"response.reasoning_text.delta","item_id": <<broken>>\n\n'
    const body = await readBody(Provider.rewriteRelayReasoningEvents(sseResponse([malformed])))
    expect(body).toBe('data: {"type":"response.reasoning_summary_text.delta","item_id": <<broken>>\n\n')
  })
})
