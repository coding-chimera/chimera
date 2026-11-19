import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/contracts/session-ids"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// The unified output limit adds these fields in the Tool.define wrapper.
const outputMeta = (metadata: unknown) => metadata as { outputTruncated?: boolean; outputPath?: string }
async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

function exec(args: { url: string; format: "text" | "markdown" | "html" }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function execWith(
  client: ReturnType<typeof mockHttpClient>,
  args: { url: string; format: "text" | "markdown" | "html" },
) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(client, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.webfetch", () => {
  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.svg", url).toString(), format: "html" })
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/file.txt", url).toString(), format: "text" })
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("extracts HTML text while excluding non-content elements", async () => {
    const html = "<main>Hello <strong>world</strong><script>secret()</script><style>.hidden{}</style><p>after</p></main>"
    await withFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/page", url).toString(), format: "text" })
            expect(result.output).toContain("Hello world")
            expect(result.output).toContain("after")
            expect(result.output).not.toContain("secret")
            expect(result.output).not.toContain("hidden")
          },
        })
      },
    )
  })

  test("converts HTML to markdown while excluding scripts and styles", async () => {
    const html = "<h1>Title</h1><script>secret()</script><style>.hidden{}</style><p>Hello <strong>world</strong>.</p>"
    await withFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/page", url).toString(), format: "markdown" })
            expect(result.output).toContain("# Title")
            expect(result.output).toContain("**world**")
            expect(result.output).not.toContain("secret")
            expect(result.output).not.toContain("hidden")
          },
        })
      },
    )
  })

  test("fails when the HTTP response is not successful", async () => {
    await withFetch(
      () => new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } }),
      async (url) => {
        await WithInstance.provide({
          directory: projectRoot,
          fn: async () => {
            await expect(exec({ url: new URL("/failure", url).toString(), format: "text" })).rejects.toThrow()
          },
        })
      },
    )
  })

  test("rejects a content-length larger than the 5MB limit before reading the body", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const client = mockHttpClient(
          () =>
            new Response("tiny", {
              status: 200,
              headers: { "content-type": "text/plain", "content-length": String(5 * 1024 * 1024 + 1) },
            }),
        )
        await expect(
          execWith(client, { url: "https://example.com/huge.txt", format: "text" }),
        ).rejects.toThrow("exceeds 5MB limit")
      },
    })
  })

  test("accepts responses exactly at the 5MB limit", async () => {
    const size = 5 * 1024 * 1024
    const body = new Uint8Array(size).fill(97)
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const client = mockHttpClient(
          () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
        )
        const result = await execWith(client, { url: "https://example.com/limit.txt", format: "text" })
        // The fetch layer accepts a body of exactly 5MB; the unified tool output
        // limit then truncates it to a preview and saves the full text to disk.
        expect(outputMeta(result.metadata).outputTruncated).toBe(true)
        expect(typeof outputMeta(result.metadata).outputPath).toBe("string")
        const saved = await Bun.file(outputMeta(result.metadata).outputPath!).text()
        expect(Buffer.byteLength(saved, "utf-8")).toBe(size)
        expect(saved).toBe("a".repeat(size))
      },
    })
  })

  test("cancels chunked responses without content-length once they exceed the 5MB limit", async () => {
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024).fill(97)
    const client = mockHttpClient(() => {
      let sent = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 20) return controller.close()
          sent += 1
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })
    })

    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        await expect(
          execWith(client, { url: "https://example.com/chunked.txt", format: "text" }),
        ).rejects.toThrow("exceeds 5MB limit")
        for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10)
        expect(cancelled).toBe(true)
      },
    })
  })
})
