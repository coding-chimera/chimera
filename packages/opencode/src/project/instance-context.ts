import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import fs from "fs"
import path from "path"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

function canonicalPath(input: string): string {
  const resolved = path.resolve(input)
  if (process.platform === "win32") return AppFileSystem.normalizePath(resolved)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    const parent = path.dirname(resolved)
    if (parent === resolved) return resolved
    return path.join(canonicalPath(parent), path.basename(resolved))
  }
}

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  const file = canonicalPath(filepath)
  if (AppFileSystem.contains(canonicalPath(ctx.directory), file)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return AppFileSystem.contains(canonicalPath(ctx.worktree), file)
}
