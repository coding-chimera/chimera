import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { createTwoFilesPatch, parsePatch } from "diff"
import { EditTool, trimDiff } from "../../src/tool/edit"
import { WithInstance } from "../../src/project/with-instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { recordPredesignRun } from "@/chimera/store"
import { getCodeGraphDir } from "../../src/graph"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { lineHash } from "../../src/tool/hashline"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

const resolve = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const info = yield* EditTool
      return yield* info.init()
    }),
  )

const anchor = (line: number, content: string) => `${line}#${lineHash(line, content)}`

const predesign = (root: string, files: string[]) =>
  recordPredesignRun(root, path.join(getCodeGraphDir(root), "chimera", "predesign-runs.jsonl"), {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    callID: "call_predesign_edit_test",
    agent: ctx.agent,
    intent: "edit source fixture",
    files,
    seedNodes: [],
    impactedNodes: [],
    fileDependents: [],
    evidence: [],
    snapshotRevision: "test_revision",
    payload: {},
  })

const subscribeBus = <D extends BusEvent.Definition>(def: D, callback: () => unknown) =>
  runtime.runPromise(Bus.Service.use((bus) => bus.subscribeCallback(def, callback)))

async function onceBus<D extends BusEvent.Definition>(def: D) {
  const result = Promise.withResolvers<void>()
  const unsub = await subscribeBus(def, () => {
    unsub()
    result.resolve()
  })
  return {
    wait: result.promise,
    unsub,
  }
}

describe("tool.edit", () => {
  test("trims generated diff headers without dropping blank context lines", () => {
    const diff = createTwoFilesPatch("blank.txt", "blank.txt", "one\n\n", "one\ntwo\n\n")
    const trimmed = trimDiff(diff)

    expect(trimmed).toBe("@@ -1,2 +1,3 @@\n one\n+two\n ")
    expect(() => parsePatch(trimmed)).not.toThrow()
  })
  test("creates new files with unanchored append", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "newfile.txt")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [{ op: "append", lines: "new content" }],
            },
            ctx,
          ),
        )

        expect(result.output).toContain("Edit applied successfully")
        expect(result.output).toContain("changeID")
        expect(result.output).toContain("1#")
        expect(result.metadata.hashline?.operations).toContain("append")
        expect(await fs.readFile(filepath, "utf-8")).toBe("new content")
      },
    })
  })

  test("emits add event for created files", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "new.txt")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const { FileWatcher } = await import("../../src/file/watcher")
        const updated = await onceBus(FileWatcher.Event.Updated)
        try {
          const edit = await resolve()
          await Effect.runPromise(edit.execute({ filePath: filepath, edits: [{ op: "append", lines: "content" }] }, ctx))
          await updated.wait
        } finally {
          updated.unsub()
        }
      },
    })
  })

  test("replaces anchored lines", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "existing.txt")
    await fs.writeFile(filepath, "old content here\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [{ op: "replace", pos: anchor(1, "old content here"), lines: "new content here" }],
            },
            ctx,
          ),
        )

        expect(result.output).toContain("Changed lines after edit")
        expect(result.metadata.diff).toContain("-old content here")
        expect(result.metadata.diff).toContain("+new content here")
        expect(await fs.readFile(filepath, "utf-8")).toBe("new content here\n")
      },
    })
  })

  test("applies explicit multiline-to-single-line range replacements", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "single-line.txt")
    await fs.writeFile(filepath, "const a = 1;\nconst b = 2;\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [
                {
                  op: "replace",
                  pos: anchor(1, "const a = 1;"),
                  end: anchor(2, "const b = 2;"),
                  lines: "const a = 1; const b = 2;",
                },
              ],
            },
            ctx,
          ),
        )

        expect(await fs.readFile(filepath, "utf-8")).toBe("const a = 1; const b = 2;\n")
      },
    })
  })

  test("replaces anchored ranges and applies batch edits bottom-up", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "batch.txt")
    await fs.writeFile(filepath, "alpha\nbeta\ngamma\ndelta\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [
                { op: "replace", pos: anchor(2, "beta"), lines: "BETA" },
                { op: "replace", pos: anchor(4, "delta"), lines: "DELTA" },
              ],
            },
            ctx,
          ),
        )

        expect(await fs.readFile(filepath, "utf-8")).toBe("alpha\nBETA\ngamma\nDELTA\n")
      },
    })
  })

  test("supports append and prepend anchors", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "insert.txt")
    await fs.writeFile(filepath, "one\nthree\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [
                { op: "append", pos: anchor(1, "one"), lines: "two" },
                { op: "prepend", pos: anchor(2, "three"), lines: "two-point-five" },
              ],
            },
            ctx,
          ),
        )

        expect(await fs.readFile(filepath, "utf-8")).toBe("one\ntwo\ntwo-point-five\nthree\n")
      },
    })
  })

  test("rejects stale hash anchors", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "stale.txt")
    await fs.writeFile(filepath, "before\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await fs.writeFile(filepath, "after\n", "utf-8")
        await expect(
          Effect.runPromise(
            edit.execute(
              {
                filePath: filepath,
                edits: [{ op: "replace", pos: anchor(1, "before"), lines: "next" }],
              },
              ctx,
            ),
          ),
        ).rejects.toThrow("Hashline anchor mismatch")
      },
    })
  })

  test("rejects anchors after whitespace-only line drift", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "whitespace-drift.ts")
    await fs.writeFile(filepath, "if (a && b) {\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await fs.writeFile(filepath, "if(a&&b){\n", "utf-8")
        await predesign(tmp.path, ["whitespace-drift.ts"])
        await expect(
          Effect.runPromise(
            edit.execute(
              {
                filePath: filepath,
                edits: [{ op: "replace", pos: anchor(1, "if (a && b) {"), lines: "if (a || b) {" }],
              },
              ctx,
            ),
          ),
        ).rejects.toThrow("Hashline anchor mismatch")
      },
    })
  })

  test("rejects overlapping ranges and no-op edits", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "reject.txt")
    await fs.writeFile(filepath, "one\ntwo\nthree\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await expect(
          Effect.runPromise(
            edit.execute(
              {
                filePath: filepath,
                edits: [
                  { op: "replace", pos: anchor(1, "one"), end: anchor(2, "two"), lines: "x" },
                  { op: "replace", pos: anchor(2, "two"), end: anchor(3, "three"), lines: "y" },
                ],
              },
              ctx,
            ),
          ),
        ).rejects.toThrow("Overlapping")

        await expect(
          Effect.runPromise(edit.execute({ filePath: filepath, edits: [{ op: "replace", pos: anchor(1, "one"), lines: "one" }] }, ctx)),
        ).rejects.toThrow("no-op")
      },
    })
  })

  test("strips accidental Hashline prefixes from replacement lines", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "prefix.txt")
    await fs.writeFile(filepath, "old\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [{ op: "replace", pos: anchor(1, "old"), lines: `1#${lineHash(1, "new")}|new` }],
            },
            ctx,
          ),
        )

        expect(await fs.readFile(filepath, "utf-8")).toBe("new\n")
      },
    })
  })

  test("preserves BOM and CRLF line endings", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "existing.cs")
    const bom = String.fromCharCode(0xfeff)
    await fs.writeFile(filepath, `${bom}using System;\r\nclass Test {}\r\n`, "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [{ op: "replace", pos: anchor(1, "using System;"), lines: "using Up;" }],
            },
            ctx,
          ),
        )

        expect(result.metadata.diff).not.toContain(bom)
        const content = await fs.readFile(filepath, "utf-8")
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\r\nclass Test {}\r\n")
      },
    })
  })

  test("deletes files", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "delete.txt")
    await fs.writeFile(filepath, "remove me\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(edit.execute({ filePath: filepath, edits: [], delete: true }, ctx))
        expect(result.output).toContain("File deleted successfully")
        expect(await Bun.file(filepath).exists()).toBe(false)
      },
    })
  })

  test("renames files", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "old.txt")
    const next = path.join(tmp.path, "new.txt")
    await fs.writeFile(filepath, "move me\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(edit.execute({ filePath: filepath, edits: [], rename: next }, ctx))
        expect(result.title).toBe("new.txt")
        expect(await Bun.file(filepath).exists()).toBe(false)
        expect(await fs.readFile(next, "utf-8")).toBe("move me\n")
      },
    })
  })

  test("throws error when path is directory", async () => {
    await using tmp = await tmpdir()
    const dirpath = path.join(tmp.path, "adir")
    await fs.mkdir(dirpath)

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await expect(Effect.runPromise(edit.execute({ filePath: dirpath, edits: [] }, ctx))).rejects.toThrow("directory")
      },
    })
  })

  test("tracks file diff statistics", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "file.txt")
    await fs.writeFile(filepath, "line1\nline2\nline3\n", "utf-8")

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const result = await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              edits: [{ op: "replace", pos: anchor(2, "line2"), lines: "new line a\nnew line b" }],
            },
            ctx,
          ),
        )

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      },
    })
  })
})
