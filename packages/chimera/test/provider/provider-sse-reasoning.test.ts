import { describe, expect, test } from "bun:test"
import { Provider } from "@/provider/provider"

// W6 (responses-wire): SSE reasoning event rewriter. "response.reasoning_text.delta"
// /".done" are standard OpenAI Responses events, but @ai-sdk/openai 3.0.88 does not
// map them (zero grep hits for the bare names; unknown events fall into the
// unknown_chunk schema fallback at dist/index.js:4283-4287 and are silently
// dropped). The SDK does decode "response.reasoning_summary_text.delta"
// (dist/index.js:4258-4263 schema literal, 6734-6744 decode branch), and that
// schema requires "summary_index" — which the standard reasoning_text payload
// does not carry. The fetch wrapper therefore injects summary_index from
// content_index (or 0) and renames the events per complete SSE frame.

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

function dataPayload(body: string, type: string) {
  const line = body.split("\n").find((line) => line.startsWith("data: ") && line.includes(`"${type}"`))
  if (!line) throw new Error(`missing ${type} frame in ${body}`)
  return JSON.parse(line.slice("data: ".length))
}

describe("Provider.rewriteRelayReasoningEvents", () => {
  test("renames relay reasoning_text delta and done events and injects summary_index", async () => {
    const res = Provider.rewriteRelayReasoningEvents(
      sseResponse([
        `data: ${JSON.stringify({ type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "thinking" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.reasoning_text.done", item_id: "rs_1", content_index: 0 })}\n\n`,
      ]),
    )
    const body = await readBody(res)
    expect(body).toContain('"response.reasoning_summary_text.delta"')
    expect(body).toContain('"response.reasoning_summary_text.done"')
    expect(body).not.toContain('"response.reasoning_text.')
    expect(dataPayload(body, "response.reasoning_summary_text.delta")).toMatchObject({
      delta: "thinking",
      summary_index: 0,
    })
    expect(dataPayload(body, "response.reasoning_summary_text.done")).toMatchObject({ summary_index: 0 })
  })

  test("preserves an existing summary_index", async () => {
    const res = Provider.rewriteRelayReasoningEvents(
      sseResponse([
        `data: ${JSON.stringify({ type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, summary_index: 3, delta: "x" })}\n\n`,
      ]),
    )
    const body = await readBody(res)
    expect(body).toContain('"response.reasoning_summary_text.delta"')
    expect(dataPayload(body, "response.reasoning_summary_text.delta").summary_index).toBe(3)
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
    const frame = `data: ${JSON.stringify({ type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "x" })}\n\n`
    const split = frame.indexOf("response.reasoning_text.") + 12
    const body = await readBody(
      Provider.rewriteRelayReasoningEvents(sseResponse([frame.slice(0, split), frame.slice(split)])),
    )
    expect(body).toContain('"response.reasoning_summary_text.delta"')
    expect(body).not.toContain('"response.reasoning_text.')
    expect(dataPayload(body, "response.reasoning_summary_text.delta").summary_index).toBe(0)
  })

  test("falls back to the string rename for malformed relay frames without throwing", async () => {
    // F11 guard: a matched frame is JSON-parsed to inject summary_index, but a
    // truncated/malformed frame must not throw or be dropped — the data payload
    // stays untouched and the string rename still applies.
    const malformed = 'data: {"type":"response.reasoning_text.delta","item_id": <<broken>>\n\n'
    const body = await readBody(Provider.rewriteRelayReasoningEvents(sseResponse([malformed])))
    expect(body).toBe('data: {"type":"response.reasoning_summary_text.delta","item_id": <<broken>>\n\n')
  })
})
