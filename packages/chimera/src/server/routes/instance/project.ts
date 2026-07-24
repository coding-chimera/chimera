import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProjectRoutes.current", c, function* () {
          return (yield* InstanceState.context).project
        }),
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProjectRoutes.initGit", c, function* () {
          const instance = yield* InstanceState.context
          const project = yield* Project.Service
          const next = yield* project.initGit({ directory: instance.directory, project: instance.project })
          if (
            next.id !== instance.project.id ||
            next.vcs !== instance.project.vcs ||
            next.worktree !== instance.project.worktree
          ) {
            const store = yield* InstanceStore.Service
            yield* store.reload({
              directory: instance.directory,
              worktree: instance.directory,
              project: next,
            })
          }
          return next
        }),
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.update", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.update({ ...body, projectID })
        }),
    ),
)
