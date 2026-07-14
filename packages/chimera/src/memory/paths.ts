import path from "path"
import { createHash } from "crypto"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { resolveSafeRelativePath } from "./security"

export type ScopeMetadata = {
  schemaVersion: 1
  scope: "project"
  projectID: string
}

export type Roots = {
  memories: string
  global: string
  project: string
}

export const memoryRoot = (dataRoot = Global.Path.data) => path.join(dataRoot, "memories")

export const globalRoot = (dataRoot = Global.Path.data) => path.join(memoryRoot(dataRoot), "global")

export const projectKey = (projectID: string) => createHash("sha256").update(projectID).digest("hex")

export const projectRoot = (projectID: string, dataRoot = Global.Path.data) =>
  path.join(memoryRoot(dataRoot), "projects", projectKey(projectID))

export const scopeMetadataPath = (projectID: string, dataRoot = Global.Path.data) =>
  path.join(projectRoot(projectID, dataRoot), "scope.json")

export const roots = (projectID: string, dataRoot = Global.Path.data): Roots => ({
  memories: memoryRoot(dataRoot),
  global: globalRoot(dataRoot),
  project: projectRoot(projectID, dataRoot),
})

function parseScopeMetadata(input: unknown): ScopeMetadata | undefined {
  if (!input || typeof input !== "object") return undefined
  if (!("schemaVersion" in input) || input.schemaVersion !== 1) return undefined
  if (!("scope" in input) || input.scope !== "project") return undefined
  if (!("projectID" in input) || typeof input.projectID !== "string" || input.projectID.length === 0) return undefined
  return {
    schemaVersion: 1,
    scope: "project",
    projectID: input.projectID,
  }
}

export async function writeProjectScopeMetadata(projectID: string, dataRoot = Global.Path.data) {
  const metadata = { schemaVersion: 1, scope: "project", projectID } satisfies ScopeMetadata
  const relativePath = path.join("memories", "projects", projectKey(projectID), "scope.json")
  const filePath = await resolveSafeRelativePath(dataRoot, relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await resolveSafeRelativePath(dataRoot, relativePath)
  await fs.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(filePath, 0o600)
  return metadata
}

export async function readProjectScopeMetadata(projectID: string, dataRoot = Global.Path.data) {
  const filePath = await resolveSafeRelativePath(
    dataRoot,
    path.join("memories", "projects", projectKey(projectID), "scope.json"),
  )
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const metadata = await file.json().catch(() => undefined)
  const parsed = parseScopeMetadata(metadata)
  if (parsed?.projectID !== projectID) return undefined
  return parsed
}

export const writeScopeMetadata = writeProjectScopeMetadata
export const readScopeMetadata = readProjectScopeMetadata

export * as MemoryPaths from "./paths"
