import { Location } from "@opencode-ai/core/location"
import { ProjectID } from "@opencode-ai/schema/project-id"

// Minimal location fixture over the L5.1 seam shim: builds a Location.Interface
// without touching the upstream core project/git closure (see location.ts shim
// header and UPSTREAM_V2_MIGRATION_PLAN.md L5 decision ①).
export function location(ref: Location.Ref): Location.Interface {
  return {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
    project: { id: ProjectID.global, directory: ref.directory },
  }
}
