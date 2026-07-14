import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { MemoryLegacy } from "@/memory/legacy"
import { MemoryManagement } from "@/memory/management"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const MemoryPaths = {
  status: "/memory/status",
  notes: "/memory/notes",
  note: "/memory/notes/:id",
  reset: "/memory/reset",
  import: "/memory/import",
  rebuild: "/memory/rebuild",
} as const

const updateErrors = [MemoryManagement.BadRequestError, MemoryManagement.NotFoundError] as const

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("status", MemoryPaths.status, {
          query: MemoryManagement.StatusQuery,
          success: described(MemoryManagement.Status, "Memory status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.status",
            summary: "Get memory status",
            description: "Return current memory settings and scope statistics without exposing storage paths.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("notes", MemoryPaths.notes, {
          query: MemoryManagement.NotesQuery,
          success: described(Schema.Array(MemoryManagement.Note), "Memory notes"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.notes",
            summary: "List memory notes",
            description: "List active notes in the global or current-project memory scope.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("remember", MemoryPaths.notes, {
          payload: MemoryManagement.CreateInput,
          success: described(MemoryManagement.Note, "Created memory note"),
          error: MemoryManagement.BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.remember",
            summary: "Remember a memory note",
            description: "Create a normalized note in the global or current-project memory scope and queue consolidation.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.patch("update", MemoryPaths.note, {
          params: { id: Schema.String },
          payload: MemoryManagement.UpdateInput,
          success: described(MemoryManagement.Note, "Updated memory note"),
          error: updateErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.update",
            summary: "Update a memory note",
            description: "Update a visible global or current-project note and queue consolidation.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.delete("forget", MemoryPaths.note, {
          params: { id: Schema.String },
          success: described(MemoryManagement.DeleteResult, "Memory note forgotten"),
          error: MemoryManagement.NotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.forget",
            summary: "Forget a memory note",
            description: "Forget a visible global or current-project note and queue consolidation.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("reset", MemoryPaths.reset, {
          payload: MemoryManagement.ResetInput,
          success: described(MemoryManagement.ResetResult, "Memory scope reset"),
          error: MemoryManagement.BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.reset",
            summary: "Reset memory scope",
            description: "Clear database records and generated artifacts for one scope without changing configuration.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("import", MemoryPaths.import, {
          payload: MemoryLegacy.LegacyFile,
          success: described(MemoryManagement.ImportResult, "Legacy memory import result"),
          error: MemoryManagement.BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.import",
            summary: "Import legacy memory notes",
            description: "Idempotently import legacy schemaVersion 1 notes into global or current-project scopes.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("rebuild", MemoryPaths.rebuild, {
          payload: MemoryManagement.RebuildInput,
          success: described(MemoryManagement.RebuildResult, "Memory rebuild queued"),
          error: MemoryManagement.BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.rebuild",
            summary: "Queue memory rebuild",
            description: "Queue asynchronous Stage 2 consolidation for one memory scope.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "memory",
          description: "Current-project-scoped cross-session memory management routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "chimera memory HttpApi",
      version: "0.0.1",
      description: "Cross-session memory management surface.",
    }),
  )
