import { Effect } from "effect"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { MemoryLegacy } from "@/memory/legacy"
import { MemoryManagement } from "@/memory/management"
import { lazy } from "@/util/lazy"
import { runRequest } from "./trace"

const errors = {
  400: {
    description: "Memory request rejected",
    content: { "application/json": { schema: resolver(MemoryManagement.BadRequestError.zod) } },
  },
  404: {
    description: "Memory note not found",
    content: { "application/json": { schema: resolver(MemoryManagement.NotFoundError.zod) } },
  },
} as const

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get memory status",
        description: "Return current memory settings and scope statistics without exposing storage paths.",
        operationId: "memory.status",
        responses: {
          200: {
            description: "Memory status",
            content: { "application/json": { schema: resolver(MemoryManagement.Status.zod) } },
          },
        },
      }),
      validator("query", MemoryManagement.StatusQuery.zod),
      async (c) =>
        c.json(
          await runRequest(
            "MemoryRoutes.status",
            c,
            MemoryManagement.Service.use((service) => service.status(c.req.valid("query").scope)),
          ),
        ),
    )
    .get(
      "/notes",
      describeRoute({
        summary: "List memory notes",
        description: "List active notes in the global or current-project memory scope.",
        operationId: "memory.notes",
        responses: {
          200: {
            description: "Memory notes",
            content: { "application/json": { schema: resolver(z.array(MemoryManagement.Note.zod)) } },
          },
        },
      }),
      validator("query", MemoryManagement.NotesQuery.zod),
      async (c) =>
        c.json(
          await runRequest(
            "MemoryRoutes.notes",
            c,
            MemoryManagement.Service.use((service) => service.list(c.req.valid("query").scope)),
          ),
        ),
    )
    .post(
      "/notes",
      describeRoute({
        summary: "Remember a memory note",
        description: "Create a normalized note in the global or current-project memory scope and queue consolidation.",
        operationId: "memory.remember",
        responses: {
          200: {
            description: "Created memory note",
            content: { "application/json": { schema: resolver(MemoryManagement.Note.zod) } },
          },
          400: errors[400],
        },
      }),
      validator("json", MemoryManagement.CreateInput.zod),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.remember",
          c,
          MemoryManagement.Service.use((service) => service.create(c.req.valid("json"))).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) return c.json(result.error, 400)
        return c.json(result.value)
      },
    )
    .patch(
      "/notes/:id",
      describeRoute({
        summary: "Update a memory note",
        description: "Update a visible global or current-project note and queue consolidation.",
        operationId: "memory.update",
        responses: {
          200: {
            description: "Updated memory note",
            content: { "application/json": { schema: resolver(MemoryManagement.Note.zod) } },
          },
          ...errors,
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", MemoryManagement.UpdateInput.zod),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.update",
          c,
          MemoryManagement.Service.use((service) => service.update(c.req.valid("param").id, c.req.valid("json"))).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) {
          return result.error instanceof MemoryManagement.NotFoundError
            ? c.json(result.error, 404)
            : c.json(result.error, 400)
        }
        return c.json(result.value)
      },
    )
    .delete(
      "/notes/:id",
      describeRoute({
        summary: "Forget a memory note",
        description: "Forget a visible global or current-project note and queue consolidation.",
        operationId: "memory.forget",
        responses: {
          200: {
            description: "Memory note forgotten",
            content: { "application/json": { schema: resolver(MemoryManagement.DeleteResult.zod) } },
          },
          404: errors[404],
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.forget",
          c,
          MemoryManagement.Service.use((service) => service.forget(c.req.valid("param").id)).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) return c.json(result.error, 404)
        return c.json(result.value)
      },
    )
    .post(
      "/reset",
      describeRoute({
        summary: "Reset memory scope",
        description: "Clear database records and generated artifacts for one scope without changing configuration.",
        operationId: "memory.reset",
        responses: {
          200: {
            description: "Memory scope reset",
            content: { "application/json": { schema: resolver(MemoryManagement.ResetResult.zod) } },
          },
          400: errors[400],
        },
      }),
      validator("json", MemoryManagement.ResetInput.zod),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.reset",
          c,
          MemoryManagement.Service.use((service) => service.reset(c.req.valid("json"))).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) return c.json(result.error, 400)
        return c.json(result.value)
      },
    )
    .post(
      "/import",
      describeRoute({
        summary: "Import legacy memory notes",
        description: "Idempotently import legacy schemaVersion 1 notes into global or current-project scopes.",
        operationId: "memory.import",
        responses: {
          200: {
            description: "Legacy memory import result",
            content: { "application/json": { schema: resolver(MemoryManagement.ImportResult.zod) } },
          },
          400: errors[400],
        },
      }),
      validator("json", MemoryLegacy.LegacyFile.zod),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.import",
          c,
          MemoryManagement.Service.use((service) => service.importLegacy(c.req.valid("json"))).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) return c.json(result.error, 400)
        return c.json(result.value)
      },
    )
    .post(
      "/rebuild",
      describeRoute({
        summary: "Queue memory rebuild",
        description: "Queue asynchronous Stage 2 consolidation for one memory scope.",
        operationId: "memory.rebuild",
        responses: {
          200: {
            description: "Memory rebuild queued",
            content: { "application/json": { schema: resolver(MemoryManagement.RebuildResult.zod) } },
          },
          400: errors[400],
        },
      }),
      validator("json", MemoryManagement.RebuildInput.zod),
      async (c) => {
        const result = await runRequest(
          "MemoryRoutes.rebuild",
          c,
          MemoryManagement.Service.use((service) => service.rebuild(c.req.valid("json"))).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        )
        if (!result.ok) return c.json(result.error, 400)
        return c.json(result.value)
      },
    ),
)
