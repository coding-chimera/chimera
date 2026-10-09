import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Image } from "../../src/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { DatabaseConnection, getDatabasePath } from "@/graph"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { StreamingPreview } from "../../src/session/streaming-preview"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@/storage/db"
import { EventTable } from "../../src/sync/event.sql"
import { SyncEvent } from "../../src/sync"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { lineHash } from "../../src/tool/hashline"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

// The stub LLM below replays `toolEvents`, so each test sets its stream right
// before handle.process() reads it (streams are consumed sequentially).
let toolEvents: LLM.Event[] = []

const stubLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => Stream.fromIterable(toolEvents),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  stubLLM,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provideMerge(deps),
)

const it = testEffect(env)

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

function chunkSize(text: string, size: number) {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const runStream = Effect.fn("test.runStream")(function* (input: {
  dir: string
  tool: string
  args: string
  chunk?: number
  toolInput?: Record<string, unknown>
}) {
  const { processors, session, provider } = yield* boot()
  const bus = yield* Bus.Service
  const chat = yield* session.create({})
  const parent = yield* user(chat.id, "preview")
  const msg = yield* assistant(chat.id, parent.id, path.resolve(input.dir))
  const events: { field: string; delta: string }[] = []
  const off = yield* bus.subscribeCallback(MessageV2.Event.PartDelta, (event) => {
    if (event.properties.messageID !== msg.id) return
    events.push({ field: event.properties.field, delta: event.properties.delta })
  })
  const toolInput = input.toolInput ?? {}
  const deltas: LLM.Event[] = chunkSize(input.args, input.chunk ?? 90).map((delta) => ({
    type: "tool-input-delta",
    id: "call_preview",
    delta,
  }))
  toolEvents = [
    { type: "start" },
    { type: "tool-input-start", id: "call_preview", toolName: input.tool },
    ...deltas,
    { type: "tool-input-end", id: "call_preview" },
    { type: "tool-call", toolCallId: "call_preview", toolName: input.tool, input: toolInput },
    { type: "tool-result", toolCallId: "call_preview", toolName: input.tool, input: toolInput, output: "ok" },
    { type: "finish" },
  ] as LLM.Event[]
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  let value: SessionProcessor.Result | undefined
  try {
    value = yield* handle.process({
      user: {
        id: parent.id,
        sessionID: chat.id,
        role: "user",
        time: parent.time,
        agent: parent.agent,
        model: { providerID: ref.providerID, modelID: ref.modelID },
      } satisfies MessageV2.User,
      sessionID: chat.id,
      model: mdl,
      agent: agent(),
      system: [],
      messages: [{ role: "user", content: "preview" }],
      tools: {},
    })
  } finally {
    off()
  }
  const raws = events.filter((item) => item.field === "raw").map((item) => item.delta)
  const hunks = events
    .filter((item) => item.field === "hunk")
    .map((item) => JSON.parse(item.delta) as StreamingPreview.StreamingHunk)
  return { chat, msg, events, raws, hunks, value }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("streams raw tool-input deltas (and the v2 Tool.Input.Delta dual-write) for non-edit tools", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
          }),
        )
        DatabaseConnection.initialize(getDatabasePath(dir)).close()
        const args = JSON.stringify({ command: `echo ${"x".repeat(300)}` })
        const run = yield* runStream({ dir, tool: "bash", args })

        expect(run.value).toBe("continue")
        expect(run.raws.join("")).toBe(args)
        expect(run.raws.length).toBe(Math.ceil(args.length / 90))
        // bash (and every other non-preview tool) stays raw-only: no hunks.
        expect(run.hunks).toEqual([])
        expect(run.events.every((item) => item.field === "raw")).toBe(true)

        const deltaEvent = Database.use((db) =>
          db
            .select()
            .from(EventTable)
            .all()
            .find((event) => event.type === "session.next.tool.input.delta.1" && event.aggregate_id === run.chat.id),
        )
        expect(deltaEvent).toBeDefined()
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

it.live("emits edit hunks exactly once per completed op, in order, against the fixture file", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "target.txt")
        const lines = ["alpha", "beta", "gamma", "delta"]
        yield* Effect.promise(() => Bun.write(target, lines.join("\n") + "\n"))
        const anchor = (line: number) => `${line}#${lineHash(line, lines[line - 1] ?? "")}`
        const pad = "x".repeat(400)
        const args = JSON.stringify({
          filePath: target,
          edits: [
            { op: "replace", pos: anchor(2), end: anchor(3), lines: ["BETA", pad] },
            { op: "append", pos: anchor(4), lines: ["tail"] },
          ],
        })
        const run = yield* runStream({ dir, tool: "edit", args, toolInput: JSON.parse(args) })

        expect(run.value).toBe("continue")
        expect(run.raws.join("")).toBe(args)
        expect(run.hunks).toEqual([
          {
            index: 0,
            op: "replace",
            filePath: target,
            pos: anchor(2),
            end: anchor(3),
            before: "beta\ngamma",
            after: `BETA\n${pad}`,
          },
          { index: 1, op: "append", filePath: target, pos: anchor(4), before: "", after: "tail" },
        ])
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

it.live("degrades to raw-only when edit anchors do not verify", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, "target.txt")
        const lines = ["alpha", "beta", "gamma"]
        yield* Effect.promise(() => Bun.write(target, lines.join("\n") + "\n"))
        const args = JSON.stringify({
          filePath: target,
          edits: [{ op: "replace", pos: "2#zz", lines: ["y".repeat(400)] }],
        })
        const run = yield* runStream({ dir, tool: "edit", args })

        expect(run.value).toBe("continue")
        expect(run.raws.join("")).toBe(args)
        expect(run.hunks).toEqual([])
      }),
    { git: true, config: providerCfg("http://localhost:1/v1") },
  ),
)

it.live("apply_patch preview closes a hunk when the next header arrives", () =>
  Effect.gen(function* () {
    const tracker = StreamingPreview.create("apply_patch", "/tmp")
    expect(tracker).toBeDefined()
    if (!tracker) return
    const patch =
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "@@",
        " ctx",
        "+more",
        "*** End Patch",
      ].join("\n") + "\n"
    const first = patch.indexOf("@@")
    const second = patch.indexOf("@@", first + 2)
    // Up to (and including) the second "@@" header line: the first chunk is
    // closed, the second one is still open.
    const cut = patch.slice(0, second + 3)
    const partial = yield* StreamingPreview.finalize(tracker, JSON.stringify({ patchText: cut }))
    expect(partial).toEqual([{ index: 0, op: "patch", filePath: "src/a.ts", before: "old", after: "new" }])

    const rest = yield* StreamingPreview.finalize(tracker, JSON.stringify({ patchText: patch }))
    expect(rest).toEqual([{ index: 1, op: "patch", filePath: "src/a.ts", before: "ctx", after: "ctx\nmore" }])
  }),
)

it.live("unanchored append to a missing file previews as a pure addition", () =>
  Effect.gen(function* () {
    const tracker = StreamingPreview.create("edit", "/tmp")
    expect(tracker).toBeDefined()
    if (!tracker) return
    const target = "/tmp/streaming-preview-test-missing/new-file.txt"
    const hunks = yield* StreamingPreview.finalize(
      tracker,
      JSON.stringify({ filePath: target, edits: [{ op: "append", lines: ["hi", "there"] }] }),
    )
    expect(hunks).toEqual([{ index: 0, op: "append", filePath: target, before: "", after: "hi\nthere" }])
  }),
)
