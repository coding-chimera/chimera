import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MemoryManagement } from "@/memory/management"
import { InstanceHttpApi } from "../api"

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* MemoryManagement.Service

    return handlers
      .handle("status", (ctx) => memory.status(ctx.query.scope))
      .handle("notes", (ctx) => memory.list(ctx.query.scope))
      .handle("remember", (ctx) => memory.create(ctx.payload))
      .handle("update", (ctx) => memory.update(ctx.params.id, ctx.payload))
      .handle("forget", (ctx) => memory.forget(ctx.params.id))
      .handle("reset", (ctx) => memory.reset(ctx.payload))
      .handle("import", (ctx) => memory.importLegacy(ctx.payload))
      .handle("rebuild", (ctx) => memory.rebuild(ctx.payload))
  }),
)
