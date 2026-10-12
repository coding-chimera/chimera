import { Schema } from "effect"
import { type WorkspaceAdapter, WorkspaceInfo } from "../types"

const WorktreeConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  branch: Schema.String,
  directory: Schema.String,
})
const decodeWorktreeConfig = Schema.decodeUnknownSync(WorktreeConfig)

async function loadWorktree() {
  const { Worktree } = await import("@/worktree")
  return Worktree
}

export const WorktreeAdapter: WorkspaceAdapter = {
  name: "Worktree",
  description: "Create a git worktree",
  async configure(info) {
    const Worktree = await loadWorktree()
    const next = await Worktree.runtime.runPromise((svc) => svc.makeWorktreeInfo())
    return {
      ...info,
      name: next.name,
      branch: next.branch,
      directory: next.directory,
    }
  },
  async create(info) {
    const Worktree = await loadWorktree()
    const config = decodeWorktreeConfig(info)
    await Worktree.runtime.runPromise((svc) =>
      svc.createFromInfo({
        name: config.name,
        directory: config.directory,
        branch: config.branch,
      }),
    )
  },
  async remove(info) {
    const Worktree = await loadWorktree()
    const config = decodeWorktreeConfig(info)
    await Worktree.runtime.runPromise((svc) => svc.remove({ directory: config.directory }))
  },
  target(info) {
    const config = decodeWorktreeConfig(info)
    return {
      type: "local",
      directory: config.directory,
    }
  },
}
