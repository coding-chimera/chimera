# Tool migration

Practical reference for the current tool-migration state in `packages/chimera`.

## Status

`Tool.Def.execute` and `Tool.Info.init` already return `Effect` on this branch, and the built-in tool surface is now largely on the target shape.

The current exported tools in `src/tool` use `Tool.define(...)` with Effect-based initialization and execution. The tracked internal migrations are also complete: tool I/O now uses the intended Effect services, with deliberate bounded compatibility boundaries called out below.

There are no open implementation items in this tool-migration tracker.

## Current shape

`Tool.define(...)` is already the Effect-native helper here.

- `init` is an `Effect`
- `info.init()` returns an `Effect`
- `execute(...)` returns an `Effect`

A tool counts as migrated when its initialization, execution, resource lifetime, and platform-service boundaries stay Effect-native.

## Tests

Tool tests should use the existing Effect helpers in `packages/chimera/test/lib/effect.ts`:

- Use `testEffect(...)` / `it.live(...)` instead of creating fake local wrappers around effectful tools.
- Yield the real tool export, then initialize it: `const info = yield* ReadTool`, `const tool = yield* info.init()`.
- Run tests inside a real instance with `provideTmpdirInstance(...)` or `provideInstance(tmpdirScoped(...))` so instance-scoped services resolve exactly as they do in production.

This keeps tool tests aligned with the production service graph and makes follow-up cleanup mostly mechanical.

## Exported tools

These exported tool definitions currently use `Tool.define(...)` in `src/tool`:

- [x] `apply_patch.ts`
- [x] `shell.ts`
- [x] `edit.ts`
- [x] `glob.ts`
- [x] `grep.ts`
- [x] `invalid.ts`
- [x] `lsp.ts`
- [x] `plan.ts`
- [x] `question.ts`
- [x] `read.ts`
- [x] `skill.ts`
- [x] `task.ts`
- [x] `todo.ts`
- [x] `webfetch.ts`
- [x] `websearch.ts`
- [x] `write.ts`

Notes:

- There is no current `ls.ts` tool file on this branch.
- `truncate.ts` is an Effect service used by tools, not a tool definition itself.
- `mcp-exa.ts`, `external-directory.ts`, and `schema.ts` are support modules, not standalone tool definitions.

## Completed cleanup

The tool-adjacent cleanup tracked by this specification is complete:

- [x] `read.ts` — reads scoped, bounded `AppFileSystem` chunks; binary detection and chunk lifetime remain inside the Effect scope.
- [x] `shell.ts` — uses an `Effect.cached` parser and a scoped Effect file writer; these are intentional lifecycle boundaries rather than deferred raw-platform cleanup.
- [x] `webfetch.ts` — uses Effect `HttpClient` and keeps HTML extraction behind a controlled, cancellable `HTMLRewriter` boundary.
- [x] `file/ripgrep.ts` — uses `AppFileSystem` and `ChildProcessSpawner` for filesystem and process work.
- [x] `patch/index.ts` — keeps patch calculation as a pure transform and performs preflight through Effect `AppFileSystem` before application.

The previous raw-fs checklist is superseded by these implementations and has been removed rather than recorded as false completion work.

## Separate architecture follow-up

Hono route deletion and fallback retirement are architecture work tracked in `routes.md`; they are not tool-migration backlog.
