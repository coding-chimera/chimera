import path from "path"
import fs from "fs/promises"
import { createHash, randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import type { ProjectID } from "../project/schema"
import { MemoryPaths } from "./paths"
import { MemorySecurity } from "./security"
import type { Scope } from "./store"

export const HEADER = "<!-- chimera-memory:v1 -->"
export const SUMMARY_FILE = "memory_summary.md"
export const MEMORY_FILE = "MEMORY.md"
export const RAW_FILE = "raw_memories.md"
export const GENERATION_FILE = "generation.json"
const MAX_ARTIFACT_BYTES = 64_000

export type Generation = {
  schemaVersion: 1
  id: string
  committedAt: number
  files: Record<string, string>
}

export type CommitInput = {
  memory: string
  summary: string
  raw: string
  rolloutSummaries?: Array<{ id: string; slug?: string; text: string }>
  notes?: Array<{ id: string; text: string }>
  expectedGeneration?: string | null
  now?: number
}

export function root(scope: Scope, dataRoot = Global.Path.data) {
  return scope.scope === "global" ? MemoryPaths.globalRoot(dataRoot) : MemoryPaths.projectRoot(scope.projectID, dataRoot)
}

async function resolvedRoot(scope: Scope, dataRoot = Global.Path.data) {
  return MemorySecurity.resolveSafeRelativePath(dataRoot, path.relative(dataRoot, root(scope, dataRoot)))
}

async function existingRoot(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await resolvedRoot(scope, dataRoot)
  const metadata = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return undefined
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new MemorySecurity.UnsafeMemoryPathError("memory scope root must be a directory")
  return directory
}

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

export function withHeader(input: string) {
  const text = input.trim()
  if (!text) return `${HEADER}\n`
  return text.startsWith(HEADER) ? `${text}\n` : `${HEADER}\n${text}\n`
}

export function hasHeader(input: string) {
  return input.startsWith(`${HEADER}\n`) || input === HEADER
}

function boundedUtf8(input: string, maxBytes: number) {
  if (Buffer.byteLength(input) <= maxBytes) return input
  return Buffer.from(input).subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/\uFFFD$/g, "").trimEnd()
}

function safeRelativePath(input: string) {
  try {
    MemorySecurity.validateRelativePath(input)
    return true
  } catch {
    return false
  }
}

export async function ensureRoot(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await resolvedRoot(scope, dataRoot)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await resolvedRoot(scope, dataRoot)
  await fs.chmod(directory, 0o700)
  if (scope.scope === "project") await MemoryPaths.writeProjectScopeMetadata(scope.projectID, dataRoot)
  if (scope.scope === "global") {
    const metadata = await safeFile(directory, "scope.json")
    if (!(await Bun.file(metadata).exists())) await writePrivate(metadata, `${JSON.stringify({ schemaVersion: 1, scope: "global" }, null, 2)}\n`)
  }
  return directory
}

async function safeFile(directory: string, relative: string) {
  return MemorySecurity.resolveSafeRelativePath(directory, relative)
}

async function writePrivate(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, content, { mode: 0o600 })
  await fs.chmod(file, 0o600)
}

async function readPrivate(directory: string, relative: string, maxBytes = MAX_ARTIFACT_BYTES) {
  const file = await safeFile(directory, relative)
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat?.isFile() || stat.size > maxBytes) return undefined
  return fs.readFile(file, "utf8")
}

export async function readGeneration(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await existingRoot(scope, dataRoot)
  if (!directory) return undefined
  const text = await readPrivate(directory, GENERATION_FILE, 32_000)
  if (!text) return undefined
  const parsed = await Promise.resolve(text)
    .then((value) => JSON.parse(value) as Partial<Generation>)
    .catch(() => undefined)
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || typeof parsed.committedAt !== "number") return undefined
  if (!parsed.files || typeof parsed.files !== "object") return undefined
  if (Object.entries(parsed.files).some(([relative, checksum]) => typeof checksum !== "string" || !safeRelativePath(relative))) return undefined
  return parsed as Generation
}

async function readArtifactFromGeneration(
  scope: Scope,
  relative: string,
  generation: Generation,
  dataRoot = Global.Path.data,
) {
  const directory = await existingRoot(scope, dataRoot)
  if (!directory) return undefined
  const expected = generation.files[relative]
  if (!expected) return undefined
  const text = await readPrivate(directory, relative)
  if (!text || hash(text) !== expected) return undefined
  return text
}

export async function readArtifact(scope: Scope, relative: string, dataRoot = Global.Path.data) {
  const generation = await readGeneration(scope, dataRoot)
  if (!generation) return undefined
  return readArtifactFromGeneration(scope, relative, generation, dataRoot)
}

export async function readSummary(scope: Scope, dataRoot = Global.Path.data, maxBytes = 12_000) {
  const text = await readArtifact(scope, SUMMARY_FILE, dataRoot)
  if (!text || !hasHeader(text)) return undefined
  const bounded = boundedUtf8(text, maxBytes).trim()
  return bounded && hasHeader(bounded) ? bounded : undefined
}

async function readPromptScope(
  alias: "global" | "project",
  scope: Scope,
  dataRoot: string,
  maxBytes: number,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = await readGeneration(scope, dataRoot)
    if (!generation) return undefined
    const files = await Promise.all(
      Object.keys(generation.files).map(async (relative) => ({
        relative,
        content: await readArtifactFromGeneration(scope, relative, generation, dataRoot),
      })),
    )
    const current = await readGeneration(scope, dataRoot)
    if (current?.id !== generation.id) continue
    const complete = files.filter((item): item is { relative: string; content: string } => item.content !== undefined)
    if (complete.length !== files.length) continue
    const summary = complete.find((item) => item.relative === SUMMARY_FILE)?.content
    if (!summary || !hasHeader(summary)) return undefined
    const bounded = boundedUtf8(summary, maxBytes).trim()
    if (!bounded || !hasHeader(bounded)) return undefined
    return {
      summary: bounded,
      generationID: generation.id,
      allowedAliases: new Map(
        complete.map((item) => [
          `${alias}/${item.relative}`,
          item.content.endsWith("\n") ? item.content.slice(0, -1).split(/\r?\n/).length : item.content.split(/\r?\n/).length,
        ]),
      ),
    }
  }
  return undefined
}

export async function readPromptMemory(projectID: ProjectID, dataRoot = Global.Path.data, maxBytes = 12_000) {
  const project = await readPromptScope("project", { scope: "project", projectID }, dataRoot, maxBytes)
  const global = await readPromptScope(
    "global",
    { scope: "global" },
    dataRoot,
    Math.max(0, maxBytes - Buffer.byteLength(project?.summary ?? "")),
  )
  const sections = [
    global ? `### Global memory\n${global.summary}` : undefined,
    project ? `### Project memory\n${project.summary}` : undefined,
  ].filter((value): value is string => Boolean(value))
  if (sections.length === 0) return undefined
  const text = sections.join("\n\n")
  return {
    text,
    bytes: Buffer.byteLength(text),
    hash: hash(text),
    scopes: { global: Boolean(global), project: Boolean(project) },
    allowedAliases: new Map([...(global?.allowedAliases ?? []), ...(project?.allowedAliases ?? [])]),
    generationIDs: {
      ...(global ? { global: global.generationID } : {}),
      ...(project ? { project: project.generationID } : {}),
    },
  }
}

export async function listAllowedAliases(projectID: ProjectID, dataRoot = Global.Path.data) {
  const scopes: Array<["global" | "project", Scope]> = [
    ["global", { scope: "global" }],
    ["project", { scope: "project", projectID }],
  ]
  const output = new Map<string, number>()
  for (const [alias, scope] of scopes) {
    const generation = await readGeneration(scope, dataRoot)
    if (!generation) continue
    for (const relative of Object.keys(generation.files)) {
      const content = await readArtifact(scope, relative, dataRoot)
      if (content === undefined) continue
      output.set(
        `${alias}/${relative}`,
        content.endsWith("\n") ? content.slice(0, -1).split(/\r?\n/).length : content.split(/\r?\n/).length,
      )
    }
  }
  return output
}

async function pruneUnlisted(directory: string, generation: Generation) {
  const allowed = new Set([...Object.keys(generation.files), GENERATION_FILE, "scope.json", "scope.lock"])
  const walk = async (current: string, prefix = "") => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith("staging-")) {
          await fs.rm(candidate, { recursive: true, force: true })
          continue
        }
        await walk(candidate, relative)
        await fs.rmdir(candidate).catch(() => undefined)
        continue
      }
      if (entry.isFile() && !allowed.has(relative)) await fs.rm(candidate, { force: true })
    }
  }
  await walk(directory)
}

export async function cleanup(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await existingRoot(scope, dataRoot)
  if (!directory) return
  const release = await acquireScopeLock(scope, dataRoot).catch((error) => {
    if (error instanceof Error && error.message === "memory scope is locked") return undefined
    throw error
  })
  if (!release) return
  try {
    const generation = await readGeneration(scope, dataRoot)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("staging-"))
        .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: true, force: true })),
    )
    if (generation) await pruneUnlisted(directory, generation)
  } finally {
    await release()
  }
}

export async function clearLocked(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await existingRoot(scope, dataRoot)
  if (!directory) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.name !== "scope.lock")
      .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true })),
  )
}

export async function clear(scope: Scope, dataRoot = Global.Path.data) {
  return withScopeLock(scope, () => clearLocked(scope, dataRoot), dataRoot)
}

export async function acquireScopeLock(scope: Scope, dataRoot = Global.Path.data) {
  const directory = await ensureRoot(scope, dataRoot)
  const lock = await safeFile(directory, "scope.lock")
  const token = randomUUID()
  const acquire = async (): Promise<fs.FileHandle> =>
    fs.open(lock, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      const stat = await fs.stat(lock).catch(() => undefined)
      if (!stat || Date.now() - stat.mtimeMs > 10 * 60_000) {
        await fs.rm(lock, { force: true })
        return acquire()
      }
      throw new Error("memory scope is locked")
    })
  const handle = await acquire()
  await handle.writeFile(`${token}\n`, "utf8")
  const refresh = setInterval(() => {
    const now = new Date()
    void handle.utimes(now, now).catch(() => undefined)
  }, 60_000)
  refresh.unref?.()
  return async () => {
    clearInterval(refresh)
    await handle.close().catch(() => undefined)
    const owner = await fs.readFile(lock, "utf8").catch(() => undefined)
    if (owner?.trim() === token) await fs.rm(lock, { force: true })
  }
}

export async function withScopeLock<A>(scope: Scope, work: () => Promise<A>, dataRoot = Global.Path.data) {
  const release = await acquireScopeLock(scope, dataRoot)
  try {
    return await work()
  } finally {
    await release()
  }
}

export async function commitLocked(scope: Scope, input: CommitInput, dataRoot = Global.Path.data) {
  const directory = await ensureRoot(scope, dataRoot)
  const current = await readGeneration(scope, dataRoot)
  if (input.expectedGeneration !== undefined && (current?.id ?? null) !== input.expectedGeneration) {
    throw new Error("memory generation changed during consolidation")
  }
  const id = `${input.now ?? Date.now()}-${randomUUID()}`
  const staging = await safeFile(directory, `staging-${id}`)
  await fs.mkdir(staging, { mode: 0o700 })
  const files = new Map<string, string>([
    [MEMORY_FILE, withHeader(input.memory)],
    [SUMMARY_FILE, withHeader(input.summary)],
    [RAW_FILE, withHeader(input.raw)],
    ...(input.rolloutSummaries ?? []).map((item): [string, string] => [
      path.posix.join("rollout_summaries", `${item.id}${item.slug ? `-${item.slug.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}` : ""}.md`),
      withHeader(item.text),
    ]),
    ...(input.notes ?? []).map((item): [string, string] => [
      path.posix.join("extensions", "ad_hoc", "notes", `${item.id}.md`),
      withHeader(item.text),
    ]),
  ])
  if ([...files.values()].some((value) => Buffer.byteLength(value) > MAX_ARTIFACT_BYTES)) throw new Error("memory artifact exceeds size limit")
  if ([...files.values()].some(MemorySecurity.containsSecret)) throw new Error("memory artifact contains a secret")
  try {
    for (const [relative, content] of files) await writePrivate(await safeFile(staging, relative), content)
    for (const relative of files.keys()) {
      const target = await safeFile(directory, relative)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.rename(await safeFile(staging, relative), target)
      await fs.chmod(target, 0o600)
    }
    const generation: Generation = {
      schemaVersion: 1,
      id,
      committedAt: input.now ?? Date.now(),
      files: Object.fromEntries([...files].map(([relative, content]) => [relative, hash(content)])),
    }
    const stagedGeneration = await safeFile(staging, GENERATION_FILE)
    await writePrivate(stagedGeneration, `${JSON.stringify(generation, null, 2)}\n`)
    const generationFile = await safeFile(directory, GENERATION_FILE)
    await fs.rename(stagedGeneration, generationFile)
    await fs.chmod(generationFile, 0o600)
    await pruneUnlisted(directory, generation)
    return generation
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

export async function commit(scope: Scope, input: CommitInput, dataRoot = Global.Path.data) {
  return withScopeLock(scope, () => commitLocked(scope, input, dataRoot), dataRoot)
}

export * as MemoryArtifacts from "./artifacts"
