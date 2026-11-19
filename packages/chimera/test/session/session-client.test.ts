import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { AppRuntime } from "../../src/composition/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/storage/tables/session.sql"
import { tmpdir } from "../fixture/fixture"

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function fork(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.fork({ sessionID })))
}

function setTitle(input: { sessionID: SessionNs.Info["id"]; title: string }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setTitle(input)))
}

function touch(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.touch(sessionID)))
}

function rowClient(id: SessionNs.Info["id"]) {
  return Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())?.client
}

describe("Session client freeze", () => {
  test("F1: body client is persisted on Info and the row", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await create({ client: "webui" })
        expect(info.client).toBe("webui")
        expect(rowClient(info.id)).toBe("webui")
        expect((await get(info.id)).client).toBe("webui")
        await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(info.id)))
      },
    })
  })

  test("F5: no client leaves the field undefined and the column NULL", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await create({})
        expect(info.client).toBeUndefined()
        expect(rowClient(info.id)).toBeNull()
        await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(info.id)))
      },
    })
  })

  test("F6: child sessions inherit the parent client unless overridden", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await create({ client: "webui" })
        const inherited = await create({ parentID: parent.id })
        const overridden = await create({ parentID: parent.id, client: "cli" })

        expect(inherited.client).toBe("webui")
        expect(rowClient(inherited.id)).toBe("webui")
        expect(overridden.client).toBe("cli")

        await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(parent.id)))
      },
    })
  })

  test("F7: fork inherits the original session client", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const original = await create({ client: "webui" })
        const forked = await fork(original.id)

        expect(forked.client).toBe("webui")
        expect(rowClient(forked.id)).toBe("webui")

        await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(original.id)))
      },
    })
  })

  test("F8: update and touch never patch the frozen client", async () => {
    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await create({ client: "webui" })
        await setTitle({ sessionID: info.id, title: "renamed" })
        await touch(info.id)

        const updated = await get(info.id)
        expect(updated.title).toBe("renamed")
        expect(updated.client).toBe("webui")
        expect(rowClient(info.id)).toBe("webui")

        await AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(info.id)))
      },
    })
  })

  test("F14: toRow/fromRow round-trip preserves client and undefined", () => {
    const base = {
      id: "ses_roundtrip",
      slug: "slug",
      projectID: "prj_roundtrip",
      directory: "/tmp",
      title: "t",
      version: "1",
      time: { created: 1, updated: 1 },
    } as unknown as SessionNs.Info

    const withClient = { ...base, client: "acp" } as SessionNs.Info
    expect(SessionNs.fromRow(SessionNs.toRow(withClient) as never).client).toBe("acp")
    expect(SessionNs.fromRow(SessionNs.toRow(base) as never).client).toBeUndefined()
  })
})

describe("default prompt client-neutral identity", () => {
  test("F11: identity and response-contract lines are client-neutral", () => {
    const file = readFileSync(path.join(import.meta.dir, "../../src/session/prompt/default.txt"), "utf8")
    const lines = file.split("\n")
    expect(lines[0]).toBe(
      "You are Chimera, an interactive coding agent that helps users with software engineering tasks on their computer. Chimera is the opencode-derived agent runtime plus the Chimera/CodeGraph graph and audit runtime.",
    )
    expect(lines[14]?.startsWith("Be concise and direct; use GitHub-flavored Markdown when it helps.")).toBe(true)
    expect(file).not.toContain("interactive CLI coding agent")
    expect(file).not.toContain("your output renders in a CLI")
  })
})