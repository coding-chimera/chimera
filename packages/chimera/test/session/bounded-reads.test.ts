import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/contracts/session-ids"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Log from "@opencode-ai/core/util/log"

const root = path.join(__dirname, "../..")
void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  childrenIDs(parentID: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.childrenIDs!(parentID)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

async function addUser(sessionID: SessionID, created: number) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text: `user ${id}`,
  } as MessageV2.TextPart)
  return id
}

async function addAssistant(
  sessionID: SessionID,
  parentID: MessageID,
  created: number,
  opts?: { summary?: boolean; finish?: string },
) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
  } as unknown as MessageV2.Info)
  return id
}

async function addToolPart(
  sessionID: SessionID,
  messageID: MessageID,
  input: { callID: string; tool: string; output: string; compacted?: number; attachments?: boolean },
) {
  const id = PartID.ascending()
  await svc.updatePart({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "completed",
      input: { cmd: input.callID },
      output: input.output,
      title: input.callID,
      metadata: {},
      time: { start: 1, end: 2, ...(input.compacted !== undefined ? { compacted: input.compacted } : {}) },
      ...(input.attachments
        ? {
            attachments: [
              {
                id: PartID.ascending(),
                sessionID,
                messageID,
                type: "file",
                mime: "image/png",
                filename: "shot.png",
                url: "data:image/png;base64,AAAA",
              },
            ],
          }
        : {}),
    },
  } as unknown as MessageV2.ToolPart)
  return id
}

async function addCompactionPart(sessionID: SessionID, messageID: MessageID, tailStartID: MessageID) {
  const id = PartID.ascending()
  await svc.updatePart({
    id,
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as MessageV2.CompactionPart)
  return id
}

function toolParts(msg: MessageV2.WithParts) {
  return msg.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool")
}

describe("B4 bounded reads", () => {
  test("filterCompactedEffect keeps the exact full-read message sequence across a compaction boundary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const base = Date.now() - 100_000
        // Chronology: U1/A1 (pre-tail history), Ut/At (retained tail), then the
        // compaction user message (tail_start_id -> Ut) and its summary assistant.
        const u1 = await addUser(session.id, base + 1)
        await addAssistant(session.id, u1, base + 2)
        const ut = await addUser(session.id, base + 3)
        const at = await addAssistant(session.id, ut, base + 4)
        const freshOutput = "fresh tool output that must survive the projection"
        await addToolPart(session.id, at, { callID: "call-fresh", tool: "bash", output: freshOutput })
        const compactedOutput = "O".repeat(100_000)
        await addToolPart(session.id, at, {
          callID: "call-compacted",
          tool: "read",
          output: compactedOutput,
          compacted: base,
          attachments: true,
        })
        const uc = await addUser(session.id, base + 5)
        await addCompactionPart(session.id, uc, ut)
        const asst = await addAssistant(session.id, uc, base + 6, { summary: true, finish: "stop" })

        // Baseline: the untouched full-materialization read chain.
        const baseline = MessageV2.filterCompacted(Array.from(MessageV2.stream(session.id)))
        const actual = await Effect.runPromise(MessageV2.filterCompactedEffect(session.id))

        expect(actual.map((msg) => [msg.info.id, msg.info.role])).toEqual(
          baseline.map((msg) => [msg.info.id, msg.info.role]),
        )
        // The boundary reorder kept the tail and dropped pre-tail history.
        expect(actual.map((msg) => msg.info.id)).toEqual([uc, asst, ut, at])

        for (let i = 0; i < actual.length; i++) {
          const expectedParts = baseline[i]!.parts
          const actualParts = actual[i]!.parts
          expect(actualParts.map((part) => part.id)).toEqual(expectedParts.map((part) => part.id))
          for (let j = 0; j < actualParts.length; j++) {
            const expectedPart = expectedParts[j]!
            const actualPart = actualParts[j]!
            if (actualPart.type !== "tool") {
              expect(actualPart as MessageV2.Part).toEqual(expectedPart as MessageV2.Part)
              continue
            }
            const before = expectedPart as MessageV2.ToolPart
            const after = actualPart as MessageV2.ToolPart
            if (before.state.status !== "completed" || before.state.time.compacted === undefined) {
              expect(after).toEqual(before)
              if (after.state.status === "completed") expect(after.state.output).toBe(freshOutput)
              continue
            }
            if (after.state.status !== "completed") throw new Error("projection changed tool state status")
            // Compacted payload: replaced by the same marker toModelMessages
            // sends, attachments dropped, everything else untouched.
            expect(before.state.output).toBe(compactedOutput)
            expect(after.state.output).toBe(MessageV2.CLEARED_TOOL_OUTPUT)
            expect(after.state.attachments).toBeUndefined()
            const { output: _beforeOutput, attachments: _beforeAttachments, ...restBefore } = before.state
            const { output: _afterOutput, attachments: _afterAttachments, ...restAfter } = after.state
            expect(restAfter).toEqual(restBefore)
          }
        }

        await svc.remove(session.id)
      },
    })
  })

  test("filterCompactedEffect on a missing session rejects like the full-read chain", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const missing = SessionID.descending()
        const lean = await Effect.runPromise(MessageV2.filterCompactedEffect(missing)).then(
          () => undefined,
          (error) => String(error),
        )
        const full = await Effect.runPromise(
          Effect.sync(() => MessageV2.filterCompacted(Array.from(MessageV2.stream(missing)))),
        ).then(
          () => undefined,
          (error) => String(error),
        )
        // Both chains must fail identically (the NotFoundError propagates as
        // a defect through the same filterCompacted drive loop).
        expect(lean).toBeDefined()
        expect(lean).toBe(full)
        expect(lean).toContain("NotFoundError")
      },
    })
  })

  test("hydrate returns every part in order when messages span multiple part batches", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const base = Date.now() - 100_000
        const messages = 25 // > HYDRATE_BATCH (20)
        const partsPerMessage = 3
        const expected: Array<{ messageID: MessageID; partIDs: string[]; texts: string[] }> = []
        for (let i = 0; i < messages; i++) {
          const id = MessageID.ascending()
          await svc.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            time: { created: base + i },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)
          const partIDs: string[] = []
          const texts: string[] = []
          for (let j = 0; j < partsPerMessage; j++) {
            const partID = PartID.ascending()
            const text = `m${i}p${j}`
            await svc.updatePart({
              id: partID,
              sessionID: session.id,
              messageID: id,
              type: "text",
              text,
            } as MessageV2.TextPart)
            partIDs.push(partID)
            texts.push(text)
          }
          expected.push({ messageID: id, partIDs, texts })
        }

        const result = MessageV2.page({ sessionID: session.id, limit: messages })
        expect(result.more).toBe(false)
        expect(result.items).toHaveLength(messages)
        // page() items are oldest-first; part ids ascending within each message.
        for (let i = 0; i < messages; i++) {
          const item = result.items[i]!
          expect(item.info.id).toBe(expected[i]!.messageID)
          expect(item.parts.map((part) => part.id as string).sort()).toEqual([...expected[i]!.partIDs].sort())
          const texts = item.parts
            .filter((part): part is MessageV2.TextPart => part.type === "text")
            .map((part) => part.text)
          expect(new Set(texts)).toEqual(new Set(expected[i]!.texts))
          expect(texts).toHaveLength(partsPerMessage)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("childrenIDs matches children ids without materializing full rows", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const parent = await svc.create({})
        const childA = await svc.create({ parentID: parent.id })
        const childB = await svc.create({ parentID: parent.id })
        const ids = await svc.childrenIDs(parent.id)
        expect([...ids].sort()).toEqual([childA.id, childB.id].sort())
        const leaf = await svc.childrenIDs(childA.id)
        expect(leaf).toEqual([])
        await svc.remove(parent.id)
      },
    })
  })
})

