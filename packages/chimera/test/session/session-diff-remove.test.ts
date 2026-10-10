import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { Storage } from "@/storage/storage"
import { SessionID } from "../../src/contracts/session-ids"
import { Snapshot } from "../../src/snapshot"

void Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function writeDiff(sessionID: SessionID, diffs: Snapshot.FileDiff[]) {
  return AppRuntime.runPromise(Storage.Service.use((svc) => svc.write(["session_diff", sessionID], diffs)))
}

function readDiff(sessionID: SessionID) {
  return AppRuntime.runPromise(
    Storage.Service.use((svc) => svc.read<Snapshot.FileDiff[]>(["session_diff", sessionID])),
  )
}

const diffs = [
  {
    file: "file.txt",
    additions: 1,
    deletions: 0,
    status: "modified" as const,
    patch: "@@ -0,0 +1 @@\n+x\n",
  },
]

describe("session.remove session_diff cleanup", () => {
  test("removes the session_diff storage file", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await create({})
        await writeDiff(info.id, diffs)
        expect(await readDiff(info.id)).toEqual(diffs)

        await remove(info.id)

        await expect(readDiff(info.id)).rejects.toThrow("NotFoundError")
      },
    })
  })

  test("removes session_diff files for child sessions recursively", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const parent = await create({})
        const child = await create({ parentID: parent.id })
        await writeDiff(parent.id, diffs)
        await writeDiff(child.id, diffs)

        await remove(parent.id)

        await expect(readDiff(parent.id)).rejects.toThrow("NotFoundError")
        await expect(readDiff(child.id)).rejects.toThrow("NotFoundError")
      },
    })
  })

  test("remove succeeds even when no session_diff file exists", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await create({})
        await expect(remove(info.id)).resolves.toBeUndefined()
        // Session row is gone even though cleanup was a no-op.
        await expect(
          AppRuntime.runPromise(
            SessionNs.Service.use((svc) => svc.get(info.id)).pipe(Effect.flatMap(() => Effect.succeed(true))),
          ),
        ).rejects.toThrow()
      },
    })
  })
})
