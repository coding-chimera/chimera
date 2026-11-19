import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { WithInstance } from "../../src/project/with-instance"
import { MessageID, SessionID } from "../../src/contracts/session-ids"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { tmpdir } from "../fixture/fixture"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = Schema.Struct({ input: Schema.String })

const toolCtx: Tool.Context = {
  sessionID: SessionID.descending(),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata() {
    return Effect.void
  },
  ask() {
    return Effect.void
  },
}

// Unified output truncation resolves the calling agent through InstanceState,
// so these cases run inside a real (temporary) instance context.
async function inInstance<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir()
  return WithInstance.provide({ directory: tmp.path, fn })
}

async function executeInInstance(tool: {
  execute: (args: { input: string }, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>
}) {
  return inInstance(() => Effect.runPromise(tool.execute({ input: "a" }, toolCtx)))
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  test("object-defined tool does not mutate the original init object", async () => {
    const original = makeTool("test")
    const originalExecute = original.execute

    const info = await runtime.runPromise(Tool.define("test-tool", Effect.succeed(original)))

    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())

    expect(original.execute).toBe(originalExecute)
  })

  test("effect-defined tool returns fresh objects and is unaffected", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      ),
    )

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("object-defined tool returns distinct objects per init() call", async () => {
    const info = await runtime.runPromise(Tool.define("test-copy", Effect.succeed(makeTool("test"))))

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("execute receives decoded parameters", async () => {
    const parameters = Schema.Struct({
      count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
    })
    const calls: Array<Schema.Schema.Type<typeof parameters>> = []
    const info = await runtime.runPromise(
      Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      ),
    )
    const ctx: Tool.Context = {
      sessionID: SessionID.descending(),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata() {
        return Effect.void
      },
      ask() {
        return Effect.void
      },
    }
    const tool = await Effect.runPromise(info.init())
    const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

    await inInstance(() => Effect.runPromise(execute({}, ctx)))
    await inInstance(() => Effect.runPromise(execute({ count: "7" }, ctx)))

    expect(calls).toEqual([{ count: 5 }, { count: 7 }])
  })
  test("applies unified output truncation even when the tool reports truncation", async () => {
    const output = "x".repeat(Truncate.MAX_BYTES + 1024)
    const info = await runtime.runPromise(
      Tool.define(
        "test-self-truncated",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "test", output, metadata: { truncated: true } })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const result = await executeInInstance(tool)

    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata.outputTruncated).toBe(true)
    expect(typeof result.metadata.outputPath).toBe("string")
    expect(result.output).toContain("truncated")
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(Buffer.byteLength(output, "utf-8"))
  })

  test("keeps tool truncation metadata when the output fits the unified limit", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-fits",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: true } })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const result = await executeInInstance(tool)

    expect(result.output).toBe("ok")
    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata.outputTruncated).toBeUndefined()
    expect(result.metadata.outputPath).toBeUndefined()
  })

  test("skips unified truncation when the tool reports outputTruncated", async () => {
    const output = "x".repeat(Truncate.MAX_BYTES + 1024)
    const info = await runtime.runPromise(
      Tool.define(
        "test-output-truncated",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({
              title: "test",
              output,
              metadata: { truncated: true, outputTruncated: true },
            })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const result = await executeInInstance(tool)

    expect(result.output).toBe(output)
    expect(result.metadata.truncated).toBe(true)
    expect(result.metadata.outputTruncated).toBe(true)
    expect(result.metadata.outputPath).toBeUndefined()
  })

  test("does not conflate result-set truncation with output limiting", async () => {
    const output = "x".repeat(Truncate.MAX_BYTES + 1024)
    const info = await runtime.runPromise(
      Tool.define(
        "test-not-truncated",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "test", output, metadata: { truncated: false } })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const result = await executeInInstance(tool)

    expect(result.metadata.truncated).toBe(false)
    expect(result.metadata.outputTruncated).toBe(true)
    expect(typeof result.metadata.outputPath).toBe("string")
  })
})
