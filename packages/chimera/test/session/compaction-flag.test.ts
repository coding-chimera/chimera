import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { RemoteCompaction } from "../../src/session/remote-compaction"
import { SessionCompaction } from "../../src/session/compaction"
import * as SessionProcessorModule from "../../src/session/processor"
import { Session as SessionNs } from "@/session/session"
import { SyncEvent } from "../../src/sync"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"
import { WithInstance } from "../../src/project/with-instance"
import { MemoryStore } from "@/memory/store"
import { Database } from "@/storage/db"
import { SessionTable } from "@/storage/tables/session.sql"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  get(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.get(id)))
  },
  messages(input: { sessionID: SessionID }) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function createModel(opts: { context: number; output: number }): Provider.Model {
  const id = "test-model"
  return {
    id,
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      output: opts.output,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id, npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

async function user(sessionID: SessionID, text: string) {
  const msg = await svc.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await svc.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await svc.updateMessage(msg)
  return msg
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    failToolCall: Effect.fn("TestSessionProcessor.failToolCall")(() => Effect.succeed(false)),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

const compactionLayer = SessionCompaction.layer.pipe(Layer.provide(SyncEvent.defaultLayer))

function runtime(
  result: "continue" | "compact",
  plugin = Plugin.defaultLayer,
  provider = ProviderTest.fake(),
  config = Config.defaultLayer,
) {
  const bus = Bus.layer
  return ManagedRuntime.make(
    Layer.mergeAll(compactionLayer, bus).pipe(
      Layer.provide(RemoteCompaction.disabledLayer),
      Layer.provide(provider.layer),
      Layer.provide(SessionNs.defaultLayer),
      Layer.provide(processorLayer(result)),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(plugin),
      Layer.provide(bus),
      Layer.provide(config),
    ),
  )
}

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function plugin(ready: ReturnType<typeof defer>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => ready.resolve()).pipe(Effect.andThen(Effect.never), Effect.as(output))
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("session time_compacting flag", () => {
  test("create sets the flag and excludes the session from memory stage1 until process clears it", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")

        // Make the session a deterministic memory stage1 candidate: idle long
        // enough and with an enabled memory session state row. Note that
        // SessionTable.time_updated carries a drizzle $onUpdate, so EVERY
        // session-row update (including the time_compacting patches below)
        // refreshes it; re-age the row before each candidate check so the
        // exclusion assertions depend only on the compacting flag and not on
        // the idle window.
        const idle = 60_000
        const age = () =>
          Database.use((db) =>
            db
              .update(SessionTable)
              .set({ time_updated: Date.now() - idle })
              .where(eq(SessionTable.id, session.id))
              .run(),
          )
        age()
        MemoryStore.ensureSessionState({ sessionID: session.id, watermark: Date.now() - idle * 2, mode: "enabled" })
        const candidateIDs = () =>
          MemoryStore.listStage1Candidates({
            projectID: session.projectID,
            idleMs: 30_000,
            maxAgeMs: 3_600_000,
            limit: 10,
          }).map((item) => item.session.id)

        expect(candidateIDs()).toContain(session.id)

        const rt = runtime("continue", Plugin.defaultLayer, wide())
        try {
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.create({ sessionID: session.id, agent: "build", model: ref, auto: false }),
            ),
          )

          // Window open: the flag is stamped and stage1 skips the session.
          const flagged = await svc.get(session.id)
          expect(typeof flagged.time.compacting).toBe("number")
          age()
          expect(candidateIDs()).not.toContain(session.id)

          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false }),
            ),
          )
          expect(result).toBe("continue")
        } finally {
          await rt.dispose()
        }

        // Window closed: the flag is cleared and stage1 includes the session again.
        const cleared = await svc.get(session.id)
        expect(cleared.time.compacting).toBeUndefined()
        age()
        expect(candidateIDs()).toContain(session.id)
      },
    })
  })

  test("process clears the flag when it fails", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const reply = await assistant(session.id, msg.id, tmp.path)
        const rt = runtime("continue", Plugin.defaultLayer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          await expect(
            rt.runPromise(
              SessionCompaction.Service.use((svc) =>
                svc.process({ parentID: reply.id, messages: msgs, sessionID: session.id, auto: false }),
              ),
            ),
          ).rejects.toThrow(`Compaction parent must be a user message: ${reply.id}`)
        } finally {
          await rt.dispose()
        }
        const after = await svc.get(session.id)
        expect(after.time.compacting).toBeUndefined()
      },
    })
  })

  test("process stamps the flag mid-window and clears it on interruption", async () => {
    const ready = defer()
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const msgs = await svc.messages({ sessionID: session.id })
        const abort = new AbortController()
        const rt = runtime("continue", plugin(ready), wide())
        let runExit: Promise<"continue" | "stop"> | undefined
        try {
          runExit = rt
            .runPromiseExit(
              SessionCompaction.Service.use((svc) =>
                svc.process({ parentID: msg.id, messages: msgs, sessionID: session.id, auto: false }),
              ),
              { signal: abort.signal },
            )
            .then((exit) => {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterrupts(exit.cause) && abort.signal.aborted) return "stop"
                throw Cause.squash(exit.cause)
              }
              return exit.value
            })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for compaction hook")
            }),
          ])

          // The compaction is parked inside the plugin hook: the flag must be
          // stamped even though process() has not finished.
          const midWindow = await svc.get(session.id)
          expect(typeof midWindow.time.compacting).toBe("number")

          abort.abort()
          expect(await runExit).toBe("stop")
        } finally {
          abort.abort()
          await rt.dispose()
          await runExit?.catch(() => undefined)
        }
        const after = await svc.get(session.id)
        expect(after.time.compacting).toBeUndefined()
      },
    })
  })
})
