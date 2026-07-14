import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { MemoryArtifacts } from "@/memory/artifacts"
import { MemoryPaths } from "@/memory/paths"
import type { ProjectID } from "@/project/schema"

const projectID = "project:/artifact-test" as ProjectID
const project = { scope: "project" as const, projectID }

describe("memory artifacts", () => {
  test("commits generation last with private files and cleans staging", async () => {
    await using tmp = await tmpdir()
    const generation = await MemoryArtifacts.commit(project, {
      memory: "# Detailed\nproject detail",
      summary: `${MemoryArtifacts.HEADER}\n# Summary\nproject priority`,
      raw: "# Raw\nsource",
      rolloutSummaries: [{ id: "ses_1", text: "rollout" }],
      notes: [{ id: "note_1", text: "note" }],
    }, tmp.path)

    expect((await MemoryArtifacts.readGeneration(project, tmp.path))?.id).toBe(generation.id)
    expect(await MemoryArtifacts.readSummary(project, tmp.path)).toContain("project priority")
    expect((await MemoryArtifacts.listAllowedAliases(projectID, tmp.path)).get("project/memory_summary.md")).toBe(3)
    expect(await fs.readdir(MemoryPaths.projectRoot(projectID, tmp.path))).not.toContainEqual(expect.stringMatching(/^staging-/))
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(MemoryPaths.projectRoot(projectID, tmp.path), "memory_summary.md"))).mode & 0o777).toBe(0o600)
    }
  })

  test("prioritizes project memory under the combined read budget", async () => {
    await using tmp = await tmpdir()
    await MemoryArtifacts.commit({ scope: "global" }, {
      memory: "global",
      summary: `${MemoryArtifacts.HEADER}\n${"global ".repeat(200)}`,
      raw: "global",
    }, tmp.path)
    await MemoryArtifacts.commit(project, {
      memory: "project",
      summary: `${MemoryArtifacts.HEADER}\nproject survives budget`,
      raw: "project",
    }, tmp.path)

    const prompt = await MemoryArtifacts.readPromptMemory(projectID, tmp.path, 100)
    expect(prompt?.text).toContain("project survives budget")
    expect(prompt?.bytes).toBeLessThanOrEqual(180)
  })

  test("keeps reads side-effect free and validates committed hashes", async () => {
    await using tmp = await tmpdir()
    const root = MemoryPaths.projectRoot(projectID, tmp.path)
    expect(await MemoryArtifacts.readSummary(project, tmp.path)).toBeUndefined()
    expect(await fs.stat(root).then(() => true).catch(() => false)).toBe(false)

    await MemoryArtifacts.commit(project, {
      memory: "detail",
      summary: `${MemoryArtifacts.HEADER}\ntrusted summary`,
      raw: "raw",
    }, tmp.path)
    await fs.writeFile(path.join(root, MemoryArtifacts.SUMMARY_FILE), `${MemoryArtifacts.HEADER}\ntampered\n`)

    expect(await MemoryArtifacts.readSummary(project, tmp.path)).toBeUndefined()
    expect((await MemoryArtifacts.listAllowedAliases(projectID, tmp.path)).has("project/memory_summary.md")).toBe(false)
  })

  test("removes artifacts omitted from the next committed generation", async () => {
    await using tmp = await tmpdir()
    const note = path.join(MemoryPaths.projectRoot(projectID, tmp.path), "extensions", "ad_hoc", "notes", "note-old.md")
    await MemoryArtifacts.commit(project, {
      memory: "detail",
      summary: `${MemoryArtifacts.HEADER}\nsummary`,
      raw: "raw",
      notes: [{ id: "note-old", text: "old note" }],
    }, tmp.path)
    expect(await Bun.file(note).exists()).toBe(true)

    await MemoryArtifacts.commit(project, {
      memory: "detail",
      summary: `${MemoryArtifacts.HEADER}\nsummary`,
      raw: "raw",
    }, tmp.path)
    expect(await Bun.file(note).exists()).toBe(false)
  })

  test("does not remove staging data while another worker holds the scope lock", async () => {
    await using tmp = await tmpdir()
    const root = await MemoryArtifacts.ensureRoot(project, tmp.path)
    const staging = path.join(root, "staging-active")
    await fs.mkdir(staging)
    const release = await MemoryArtifacts.acquireScopeLock(project, tmp.path)
    try {
      await MemoryArtifacts.cleanup(project, tmp.path)
      expect(await fs.stat(staging).then((value) => value.isDirectory()).catch(() => false)).toBe(true)
    } finally {
      await release()
    }
    await MemoryArtifacts.cleanup(project, tmp.path)
    expect(await fs.stat(staging).then(() => true).catch(() => false)).toBe(false)
  })

  test("rejects symlink traversal during commit", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const root = await MemoryArtifacts.ensureRoot(project, tmp.path)
    const outside = path.join(tmp.path, "outside")
    await fs.mkdir(outside)
    await fs.mkdir(path.join(root, "extensions", "ad_hoc"), { recursive: true })
    await fs.symlink(outside, path.join(root, "extensions", "ad_hoc", "notes"))
    await expect(MemoryArtifacts.commit(project, {
      memory: "safe",
      summary: `${MemoryArtifacts.HEADER}\nsafe`,
      raw: "safe",
      notes: [{ id: "note_1", text: "safe" }],
    }, tmp.path)).rejects.toThrow("symbolic link")
  })
  test("rejects symlinked scope roots during reset cleanup", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const root = MemoryPaths.projectRoot(projectID, tmp.path)
    const outside = path.join(tmp.path, "outside-root")
    await fs.mkdir(path.dirname(root), { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, root)
    await expect(MemoryArtifacts.clear(project, tmp.path)).rejects.toThrow("symbolic link")
  })

  test("keeps prompt aliases bound to the captured generation", async () => {
    await using tmp = await tmpdir()
    await MemoryArtifacts.commit(project, {
      memory: "first",
      summary: `${MemoryArtifacts.HEADER}\nfirst`,
      raw: "first",
      notes: [{ id: "note-first", text: "first" }],
    }, tmp.path)
    const captured = await MemoryArtifacts.readPromptMemory(projectID, tmp.path)
    await MemoryArtifacts.commit(project, {
      memory: "second",
      summary: `${MemoryArtifacts.HEADER}\nsecond`,
      raw: "second",
      notes: [{ id: "note-second", text: "second" }],
    }, tmp.path)
    const fresh = await MemoryArtifacts.readPromptMemory(projectID, tmp.path)

    expect(captured?.allowedAliases.has("project/extensions/ad_hoc/notes/note-first.md")).toBeTrue()
    expect(captured?.allowedAliases.has("project/extensions/ad_hoc/notes/note-second.md")).toBeFalse()
    expect(fresh?.allowedAliases.has("project/extensions/ad_hoc/notes/note-first.md")).toBeFalse()
    expect(fresh?.allowedAliases.has("project/extensions/ad_hoc/notes/note-second.md")).toBeTrue()
  })

  test("serializes commits with the scope lock", async () => {
    await using tmp = await tmpdir()
    const release = await MemoryArtifacts.acquireScopeLock(project, tmp.path)
    try {
      await expect(MemoryArtifacts.commit(project, {
        memory: "blocked",
        summary: `${MemoryArtifacts.HEADER}\nblocked`,
        raw: "blocked",
      }, tmp.path)).rejects.toThrow("memory scope is locked")
    } finally {
      await release()
    }
    expect((await MemoryArtifacts.commit(project, {
      memory: "committed",
      summary: `${MemoryArtifacts.HEADER}\ncommitted`,
      raw: "committed",
    }, tmp.path)).id).toBeString()
  })

  test("does not let a stale lock owner remove its successor", async () => {
    await using tmp = await tmpdir()
    const root = await MemoryArtifacts.ensureRoot(project, tmp.path)
    const lock = path.join(root, "scope.lock")
    const first = await MemoryArtifacts.acquireScopeLock(project, tmp.path)
    await fs.utimes(lock, new Date(0), new Date(0))
    const second = await MemoryArtifacts.acquireScopeLock(project, tmp.path)
    await first()
    await expect(MemoryArtifacts.acquireScopeLock(project, tmp.path)).rejects.toThrow("memory scope is locked")
    await second()
    const third = await MemoryArtifacts.acquireScopeLock(project, tmp.path)
    await third()
  })

})
