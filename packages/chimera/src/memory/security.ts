import path from "path"
import fs from "fs/promises"

const REDACTED = "[REDACTED]"
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi
const AUTHORIZATION = /\b(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;]+)/gi
const CREDENTIAL =
  /\b(api[_-]?key|client[_-]?secret|password|passwd|secret|session[_-]?token|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)(["']?)([^\s,"';]{8,})\3/gi
const KNOWN_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/_=-]{40,}/g

export class UnsafeMemoryPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeMemoryPathError"
  }
}

export const cleanText = (input: string, maxChars = 300) =>
  input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxChars))

function hasHighEntropySecret(input: string) {
  return [...input.matchAll(ENTROPY_CANDIDATE)].some((match) => {
    const value = match[0]
    if (/^[a-f0-9]+$/i.test(value)) return false
    return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)
  })
}

export function containsSecret(input: string) {
  PRIVATE_KEY.lastIndex = 0
  AUTHORIZATION.lastIndex = 0
  CREDENTIAL.lastIndex = 0
  KNOWN_TOKEN.lastIndex = 0
  return PRIVATE_KEY.test(input) || AUTHORIZATION.test(input) || CREDENTIAL.test(input) || KNOWN_TOKEN.test(input) || hasHighEntropySecret(input)
}

export function redactSecrets(input: string) {
  const redacted = input
    .replace(PRIVATE_KEY, REDACTED)
    .replace(AUTHORIZATION, (_, prefix: string) => `${prefix}${REDACTED}`)
    .replace(CREDENTIAL, (_, name: string, separator: string) => `${name}${separator}${REDACTED}`)
    .replace(KNOWN_TOKEN, REDACTED)
  return redacted.replace(ENTROPY_CANDIDATE, (value) => {
    if (/^[a-f0-9]+$/i.test(value)) return value
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) return value
    return REDACTED
  })
}

export function isPathContained(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export const isExternalPath = (root: string, candidate: string) => !isPathContained(root, candidate)

export function validateRelativePath(relativePath: string) {
  if (!relativePath || relativePath.includes("\0")) throw new UnsafeMemoryPathError("memory path must be a non-empty relative path")
  const portable = relativePath.replaceAll("\\", "/")
  if (portable.startsWith("/") || portable.startsWith("//") || /^[A-Za-z]:/.test(portable)) {
    throw new UnsafeMemoryPathError("memory path must stay within its scope root")
  }
  const components = portable.split("/")
  if (components.some((component) => !component || component === "." || component === ".." || component.startsWith("."))) {
    throw new UnsafeMemoryPathError("memory path contains a disallowed component")
  }
  return components.join(path.sep)
}

async function metadataOrUndefined(candidate: string) {
  return fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

export async function resolveSafeRelativePath(root: string, relativePath: string) {
  const normalized = validateRelativePath(relativePath)
  const rootMetadata = await fs.lstat(root)
  if (rootMetadata.isSymbolicLink()) throw new UnsafeMemoryPathError("memory scope root must not be a symbolic link")
  if (!rootMetadata.isDirectory()) throw new UnsafeMemoryPathError("memory scope root must be a directory")
  const realRoot = await fs.realpath(root)
  const candidate = path.resolve(realRoot, normalized)
  if (!isPathContained(realRoot, candidate)) throw new UnsafeMemoryPathError("memory path escapes its scope root")

  const components = normalized.split(path.sep)
  for (const [index, component] of components.entries()) {
    const current = path.join(realRoot, ...components.slice(0, index + 1))
    const metadata = await metadataOrUndefined(current)
    if (!metadata) break
    if (metadata.isSymbolicLink()) throw new UnsafeMemoryPathError("memory path traverses a symbolic link")
    if (index + 1 < components.length && !metadata.isDirectory()) {
      throw new UnsafeMemoryPathError("memory path traverses a non-directory component")
    }
    if (!isPathContained(realRoot, await fs.realpath(current))) {
      throw new UnsafeMemoryPathError("memory path escapes its scope root")
    }
  }
  return candidate
}

export async function resolveContainedPath(root: string, candidate: string) {
  if (!isPathContained(root, candidate)) throw new UnsafeMemoryPathError("memory path escapes its scope root")
  return resolveSafeRelativePath(root, path.relative(path.resolve(root), path.resolve(candidate)))
}

export * as MemorySecurity from "./security"
