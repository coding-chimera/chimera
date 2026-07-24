# HttpApi migration

Plan for replacing instance Hono route implementations with Effect `HttpApi` while preserving behavior, OpenAPI, and SDK output during the transition.

## End State

- JSON route contracts and handlers live in `src/server/routes/instance/httpapi/*`.
- Route modules own their `HttpApiGroup`, schemas, handlers, and route-level middleware.
- `httpapi/server.ts` only composes groups, instance lookup, observability, and the web handler bridge.
- Hono route implementations are deleted once their `HttpApi` replacements are default, tested, and represented in the SDK/OpenAPI pipeline.
- Streaming, SSE, and websocket routes move later through Effect HTTP primitives or another explicit replacement plan; they do not need to fit `HttpApi` if `HttpApi` is the wrong abstraction.

## Current State

- Effect `HttpApi` is the default instance-server backend.
- Set `CHIMERA_SERVER_HONO=1` or `OPENCODE_SERVER_HONO=1` to select the retained Hono fallback. The legacy `OPENCODE_EXPERIMENTAL_HTTPAPI=true` setting remains compatible and explicitly selects Effect.
- `server/backend.ts` selects `effect-httpapi` by default and forks to the pure Effect web handler or Hono fallback at startup; this is not an in-Hono bridge.
- SDK and OpenAPI generation use the Effect `HttpApi` surface by default. Hono generation is an explicit fallback for parity checks.
- `httpapi/public.ts` owns the compatibility normalization needed to preserve the established SDK contract, and the normalization plus bridge/SDK gates pass.
- Auth is centrally configured for the Effect backend via Effect `Config`, including Basic auth and the legacy `auth_token` query parameter through `HttpApiSecurity.apiKey`.
- Instance context is provided by `httpapi/server.ts` using `directory`, `workspace`, and `x-opencode-directory`.
- `Observability.layer` is provided in the Effect route layer and deduplicated through the shared `memoMap`.
- CORS middleware is wired into both the default Effect backend and the Hono fallback.
- Hono remains an intentional compatibility boundary. Its deletion and fallback retirement are still outstanding and must not be inferred from the Effect default.

## Migration Rules

- Preserve runtime behavior first. Semantic changes, new error behavior, or route shape changes need separate PRs.
- Migrate one route group, or one coherent subset of a route group, at a time.
- Reuse existing services. Do not re-architect service logic during HTTP boundary migration.
- Effect Schema owns route DTOs. Keep `.zod` only where the retained Hono fallback still requires compatibility.
- Regenerate the SDK after schema or OpenAPI-affecting changes and verify the diff is expected.
- Do not delete a Hono route until the fallback is intentionally retired and the route meets the deletion checklist.

## Route Slice Checklist

Use this checklist for each small HttpApi migration PR:

1. Read the legacy Hono route and copy behavior exactly, including default values, headers, operation IDs, response schemas, and status codes.
2. Put the new `HttpApiGroup`, route paths, DTO schemas, and handlers in `src/server/routes/instance/httpapi/*`.
3. Add the route to the default Effect composition; keep equivalent Hono behavior only in the explicit fallback.
4. Use `InstanceState.context` / `InstanceState.directory` inside HttpApi handlers instead of `Instance.directory`, `Instance.worktree`, or `Instance.project` ALS globals.
5. Reuse existing services directly. If a service returns plain objects, use `Schema.Struct`; use `Schema.Class` only when handlers return actual class instances.
6. Keep only the Hono and `.zod` compatibility required by the fallback; do not add new Hono-first contracts.
7. Add tests through the instance server boundary for auth, instance context, and route behavior, and cover the Hono fallback where compatibility is material.
8. Run `bun typecheck` and relevant `bun test --timeout 30000 ...` commands from `packages/chimera`; regenerate the SDK with `./packages/sdk/js/script/build.ts` from the repository root.

## Hono Deletion Checklist

Use this checklist before deleting any Hono route implementation. A route being `bridged` is not enough.

1. `HttpApi` parity is complete for the route path, method, auth behavior, query parameters, request body, response status, response headers, and error status.
2. The route is mounted by the default Effect backend, not only by the Hono fallback.
3. If a fallback flag exists, tests cover both the default `HttpApi` path and the fallback Hono path until the fallback is removed.
4. OpenAPI generation uses the Effect `HttpApi` route as the source for that path.
5. Generated SDK output is unchanged from the Hono-generated contract, or the SDK diff is intentionally reviewed and accepted.
6. The legacy Hono `describeRoute`, validator, and handler for that path are removed.
7. Any duplicate Zod-only DTOs are deleted or kept only as `.zod` compatibility on the canonical Effect Schema.
8. Bridge tests exist for auth, instance selection, success response, and route-specific side effects.
9. Mutation routes prove persisted side effects and cleanup behavior in tests. If the mutation disposes/reloads the active instance, disposal happens through an explicit post-response lifecycle hook rather than inline handler teardown.
10. Streaming, SSE, websocket, and UI bridge routes have a specific non-Hono replacement plan. Do not force them through `HttpApi` if raw Effect HTTP is a better fit.

Hono can be removed from the instance server only after all mounted Hono route groups meet this checklist and `server/routes/instance/index.ts` no longer depends on Hono routing for default behavior.

## Route Migration Guidance

Effect is now the default, so route work should preserve the established contract rather than add another experimental bridge:

- Add new JSON routes to Effect `HttpApi` and treat Hono only as an explicit compatibility fallback.
- Preserve behavior, operation IDs, response headers, status codes, and SDK-visible schemas.
- Use `InstanceState.context` for instance-bound handlers and separate stateful mutations into reviewable changes.
- For SSE, websocket, streaming, or UI-control routes, use raw Effect HTTP where `HttpApi` is not the right abstraction.
- Keep fallback coverage until Hono deletion is explicitly completed; do not describe defaulting to Effect as fallback retirement.

## Schema Notes

- Use `Schema.Struct(...).annotate({ identifier })` for named OpenAPI refs when handlers return plain objects.
- Use `Schema.Class` only when the handler returns real class instances or the constructor requirement is intentional.
- Keep nested anonymous shapes as `Schema.Struct` unless a named SDK type is useful.
- Avoid parallel hand-written Zod and Effect definitions for the same route boundary.

## Phases

### 1. Stabilize The Bridge

Before porting more routes, cover the bridge behavior that every route depends on.

- Add tests that hit the Hono-mounted `HttpApi` bridge, not just `HttpApiBuilder.layer` directly.
- Cover auth disabled, Basic auth success, `auth_token` success, missing credentials, and bad credentials.
- Cover `directory` and `x-opencode-directory` instance selection.
- Verify generated SDK output remains unchanged for non-SDK work.
- Fix or remove any implemented-but-unmounted `HttpApi` groups.

### 2. Complete The Inventory

Maintain the route inventory from actual Effect and Hono registrations, using rollout status rather than the superseded experimental-bridge vocabulary.

Statuses:

- `default/fallback`: served by Effect by default with an equivalent Hono fallback.
- `default`: served by Effect with no Hono implementation for that route.
- `fallback-only`: intentionally available only through Hono and blocks fallback retirement.
- `special`: SSE, websocket, streaming, or UI bridge behavior implemented with raw Effect HTTP or another explicit non-`HttpApi` replacement.

### 3. Finish JSON Route Parity

Port remaining JSON routes in small batches.

Good near-term candidates:

- top-level reads: `GET /path`, `GET /vcs`, `GET /vcs/diff`, `GET /command`, `GET /agent`, `GET /skill`, `GET /lsp`, `GET /formatter`
- simple mutations: `POST /instance/dispose`
- experimental JSON reads: console, tool, worktree list, resource list
- deferred JSON mutations: workspace/worktree create/remove/reset, file search, MCP auth flows

Keep large or stateful groups for later:

- `session`
- `sync`
- process-level experimental routes

### 4. Move OpenAPI And SDK Generation

Status: **complete**. Effect `HttpApi` is the default OpenAPI and SDK source. The Hono source remains available only as an explicit fallback for parity comparisons.

The compatibility normalization in `httpapi/public.ts` preserves the accepted SDK contract, including schema naming and shape differences, and the SDK normalization gate passes. Route deletion no longer depends on Hono OpenAPI, but it still depends on intentional fallback retirement and the Hono deletion checklist.

Ongoing rules:

- Keep operation IDs, schemas, status codes, and SDK type names stable unless a change is intentional.
- Compare Effect and Hono output when changing normalization while the fallback exists.
- Remove Hono OpenAPI stubs only with the corresponding Hono fallback routes.

V2 cleanup once SDK compatibility no longer needs the legacy Hono contract:

- Remove compatibility transforms that hide honest `HttpApi` metadata only through an intentional SDK contract change.
- Prefer direct `HttpApi` OpenAPI output where it preserves the accepted wire contract.
- Keep schema fixes that describe the actual wire format, but delete transforms that only preserve retired generator quirks.
- Re-evaluate `auth_token` as an OpenAPI security scheme once clients can consume the V2 spec.

### 5. Make HttpApi Default For JSON Routes

Status: **complete for runtime defaulting**.

- Effect serves JSON routes by default.
- `CHIMERA_SERVER_HONO=1` / `OPENCODE_SERVER_HONO=1` selects the Hono fallback; legacy `OPENCODE_EXPERIMENTAL_HTTPAPI=true` remains compatible.
- Bridge and SDK gates cover the default Effect path and retained compatibility boundary.
- Do not add new Hono handlers for JSON routes.
- Fallback retirement is intentionally deferred to Phase 6 and remains unchecked.

### 6. Delete Hono Route Implementations

Delete Hono routes group-by-group after each group meets the deletion criteria.

Deletion criteria:

- `HttpApi` route is mounted by default.
- Behavior is covered by bridge-level tests.
- OpenAPI/SDK generation comes from Effect for that path.
- SDK diff is zero or explicitly accepted.
- Legacy Hono route is no longer needed as a fallback.

After deleting a group:

- Remove its Hono route file or dead endpoints.
- Remove its `.route(...)` registration from `instance/index.ts`.
- Remove duplicate Zod-only route DTOs if Effect Schema now owns the type.
- Regenerate SDK and verify output.

### 7. Replace Special Routes

Special routes need explicit designs before Hono can disappear completely.

- `event`: SSE
- `pty`: websocket
- `tui`: UI/control bridge behavior
- streaming `session` endpoints

Use raw Effect HTTP routes where `HttpApi` does not fit. The goal is deleting Hono implementations, not forcing every transport shape through `HttpApi`.

## Current Route Status

| Area                      | Status             | Notes                                                                      |
| ------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `question`                | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `permission`              | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `provider`                | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `config`                  | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `project`                 | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `file`                    | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `mcp`                     | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `workspace`               | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| top-level instance routes | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| experimental JSON routes  | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `session`                 | `default/fallback` | Effect default, including streaming responses; Hono fallback retained      |
| `sync`                    | `default/fallback` | Effect default; equivalent Hono fallback retained                          |
| `event`                   | `default/fallback` | Raw Effect HTTP SSE default; Hono SSE fallback retained                     |
| `pty`                     | `default/fallback` | Raw Effect HTTP/websocket default; Hono fallback retained                   |
| `tui`                     | `default/fallback` | Non-Hono Effect compatibility path default; Hono fallback retained          |

## Full Route Checklist

This checklist tracks Effect replacement parity. Checked routes are served by the default Effect backend; retained Hono fallback deletion is tracked separately by the deletion checklist above.

### Top-Level Instance Routes

- [x] `POST /instance/dispose` - dispose active instance after response.
- [x] `GET /path` - current directory and worktree paths.
- [x] `GET /vcs` - current VCS status.
- [x] `GET /vcs/diff` - VCS diff summary.
- [x] `GET /command` - command catalog.
- [x] `GET /agent` - agent catalog.
- [x] `GET /skill` - skill catalog.
- [x] `GET /lsp` - LSP status.
- [x] `GET /formatter` - formatter status.

### Config Routes

- [x] `GET /config` - read config.
- [x] `PATCH /config` - update config and dispose active instance after response.
- [x] `GET /config/providers` - config provider summary.

### Project Routes

- [x] `GET /project` - list projects.
- [x] `GET /project/current` - current project.
- [x] `POST /project/git/init` - initialize git and reload active instance after response.
- [x] `PATCH /project/:projectID` - update project metadata.

### Provider Routes

- [x] `GET /provider` - list providers.
- [x] `GET /provider/auth` - list provider auth methods.
- [x] `POST /provider/:providerID/oauth/authorize` - start provider OAuth.
- [x] `POST /provider/:providerID/oauth/callback` - finish provider OAuth.

### Question Routes

- [x] `GET /question` - list questions.
- [x] `POST /question/:requestID/reply` - reply to question.
- [x] `POST /question/:requestID/reject` - reject question.

### Permission Routes

- [x] `GET /permission` - list permission requests.
- [x] `POST /permission/:requestID/reply` - reply to permission request.

### File Routes

- [x] `GET /find` - text search.
- [x] `GET /find/file` - file search.
- [x] `GET /find/symbol` - symbol search.
- [x] `GET /file` - list directory entries.
- [x] `GET /file/content` - read file content.
- [x] `GET /file/status` - file status.

### MCP Routes

- [x] `GET /mcp` - MCP status.
- [x] `POST /mcp` - add MCP server at runtime.
- [x] `POST /mcp/:name/auth` - start MCP OAuth.
- [x] `POST /mcp/:name/auth/callback` - finish MCP OAuth callback.
- [x] `POST /mcp/:name/auth/authenticate` - run MCP OAuth authenticate flow.
- [x] `DELETE /mcp/:name/auth` - remove MCP OAuth credentials.
- [x] `POST /mcp/:name/connect` - connect MCP server.
- [x] `POST /mcp/:name/disconnect` - disconnect MCP server.

### Experimental Routes

- [x] `GET /experimental/console` - active Console provider metadata.
- [x] `GET /experimental/console/orgs` - switchable Console orgs.
- [x] `POST /experimental/console/switch` - switch active Console org.
- [x] `GET /experimental/tool/ids` - tool IDs.
- [x] `GET /experimental/tool` - tools for provider/model.
- [x] `GET /experimental/worktree` - list worktrees.
- [x] `POST /experimental/worktree` - create worktree.
- [x] `DELETE /experimental/worktree` - remove worktree.
- [x] `POST /experimental/worktree/reset` - reset worktree.
- [x] `GET /experimental/session` - global session list.
- [x] `GET /experimental/resource` - MCP resources.

### Workspace Routes

- [x] `GET /experimental/workspace/adapter` - list workspace adapters.
- [x] `POST /experimental/workspace` - create workspace.
- [x] `GET /experimental/workspace` - list workspaces.
- [x] `GET /experimental/workspace/status` - workspace status.
- [x] `DELETE /experimental/workspace/:id` - remove workspace.
- [x] `POST /experimental/workspace/:id/session-restore` - restore session into workspace.

### Sync Routes

- [x] `POST /sync/start` - start workspace sync.
- [x] `POST /sync/replay` - replay sync events.
- [x] `POST /sync/history` - list sync event history.

### Session Routes

- [x] `GET /session` - list sessions.
- [x] `GET /session/status` - session status map.
- [x] `GET /session/:sessionID` - get session.
- [x] `GET /session/:sessionID/children` - get child sessions.
- [x] `GET /session/:sessionID/todo` - get session todos.
- [x] `POST /session` - create session.
- [x] `DELETE /session/:sessionID` - delete session.
- [x] `PATCH /session/:sessionID` - update session metadata.
- [x] `POST /session/:sessionID/init` - run project init command.
- [x] `POST /session/:sessionID/fork` - fork session.
- [x] `POST /session/:sessionID/abort` - abort session.
- [x] `POST /session/:sessionID/share` - share session.
- [x] `GET /session/:sessionID/diff` - session diff.
- [x] `DELETE /session/:sessionID/share` - unshare session.
- [x] `POST /session/:sessionID/summarize` - summarize session.
- [x] `GET /session/:sessionID/message` - list session messages.
- [x] `GET /session/:sessionID/message/:messageID` - get message.
- [x] `DELETE /session/:sessionID/message/:messageID` - delete message.
- [x] `DELETE /session/:sessionID/message/:messageID/part/:partID` - delete part.
- [x] `PATCH /session/:sessionID/message/:messageID/part/:partID` - update part.
- [x] `POST /session/:sessionID/message` - prompt with streaming response.
- [x] `POST /session/:sessionID/prompt_async` - async prompt.
- [x] `POST /session/:sessionID/command` - run command.
- [x] `POST /session/:sessionID/shell` - run shell command.
- [x] `POST /session/:sessionID/revert` - revert message.
- [x] `POST /session/:sessionID/unrevert` - restore reverted messages.
- [x] `POST /session/:sessionID/permissions/:permissionID` - deprecated permission response route.

### Event Routes

- [x] `GET /event` - SSE event stream via raw Effect HTTP.

### PTY Routes

- [x] `GET /pty` - list PTY sessions.
- [x] `POST /pty` - create PTY session.
- [x] `GET /pty/:ptyID` - get PTY session.
- [x] `PUT /pty/:ptyID` - update PTY session.
- [x] `DELETE /pty/:ptyID` - remove PTY session.
- [x] `GET /pty/:ptyID/connect` - PTY websocket; replace with raw Effect HTTP/websocket support.

### TUI Routes

- [x] `POST /tui/append-prompt` - append prompt.
- [x] `POST /tui/open-help` - open help.
- [x] `POST /tui/open-sessions` - open sessions.
- [x] `POST /tui/open-themes` - open themes.
- [x] `POST /tui/open-models` - open models.
- [x] `POST /tui/submit-prompt` - submit prompt.
- [x] `POST /tui/clear-prompt` - clear prompt.
- [x] `POST /tui/execute-command` - execute command.
- [x] `POST /tui/show-toast` - show toast.
- [x] `POST /tui/publish` - publish TUI event.
- [x] `POST /tui/select-session` - select session.
- [x] `GET /tui/control/next` - get next TUI request.
- [x] `POST /tui/control/response` - submit TUI control response.

## Remaining PR Plan

Prefer smaller PRs from here so route behavior and SDK/OpenAPI fallout stays reviewable.

1. [x] Bridge `PATCH /project/:projectID`.
2. [x] Bridge MCP add/connect/disconnect routes.
3. [x] Bridge MCP OAuth routes: start, callback, authenticate, remove.
4. [x] Bridge experimental console switch and tool list routes.
5. [x] Bridge experimental global session list.
6. [x] Bridge workspace create/remove/session-restore routes.
7. [x] Bridge sync start/replay/history routes.
8. [x] Bridge session read routes: list, status, get, children, todo, diff, messages.
9. [x] Bridge session lifecycle mutation routes: create, delete, update, fork, abort.
10. [x] Bridge remaining session mutation and prompt routes.
11. [x] Replace event SSE with non-Hono Effect HTTP for the default backend. Raw Effect HTTP serves `/event`; the Hono `streamSSE` implementation remains only in the explicit fallback and is deleted with Hono.
12. [x] Replace pty websocket/control routes with non-Hono Effect HTTP for the Effect backend. Hono `pty.ts` remains in the Hono fallback.
13. [x] Replace tui bridge routes or explicitly isolate them behind a non-Hono compatibility layer for the Effect backend. Hono `tui.ts` remains in the Hono fallback.
14. [x] Switch OpenAPI/SDK generation to Effect routes and pass normalization and SDK parity gates. Hono generation remains an explicit comparison fallback.
15. [x] Make Effect the runtime default and retain explicit Hono fallback flags, including legacy `OPENCODE_EXPERIMENTAL_HTTPAPI=true` compatibility.
16. Final architecture follow-up: delete the Hono route implementations and retire the Hono fallback; canonical completion tracking lives in `routes.md`.

## Checklist

- [x] Add first `HttpApi` JSON route slices.
- [x] Bridge selected `HttpApi` routes behind `OPENCODE_EXPERIMENTAL_HTTPAPI`. (Now backend-fork-at-startup rather than in-Hono path mounting.)
- [x] Reuse existing Effect services in handlers.
- [x] Provide auth, instance lookup, and observability in the Effect route layer.
- [x] Centralize auth via Effect `Config` for the Effect backend.
- [x] Support `auth_token` as a query security scheme.
- [x] Add bridge-level auth and instance tests.
- [x] Complete exact Hono route inventory.
- [x] Resolve implemented-but-unmounted route groups.
- [x] Port remaining top-level JSON reads.
- [x] Implement Effect `HttpApi` OpenAPI generation and retain explicit Hono comparison generation.
- [x] Close Effect-vs-Hono OpenAPI schema-shape gaps and make Effect the SDK generator default.
- [x] Make `effect-httpapi` the runtime default with explicit Hono fallback flags.
- Hono route deletion and fallback retirement remain outstanding and are tracked canonically in `routes.md`.
- [x] Effect replacements exist for SSE, websocket, streaming, and UI bridge routes; Hono deletion remains part of that architecture follow-up.
