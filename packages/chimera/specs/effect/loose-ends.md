# Effect loose ends

Small follow-ups that do not fit neatly into the main facade, route, tool, or schema migration checklists.

## Config / TUI

- [x] `cli/cmd/tui/config/tui.ts` - complete the internal Effect migration while preserving config precedence and migration semantics.
- [x] TUI config callers — migrate `cli/cmd/tui/attach.ts`, `cli/cmd/tui/thread.ts`, and `cli/cmd/tui/plugin/runtime.ts` to yield `TuiConfig.Service` through the shared TUI runtime; the former service-local runtime facade has been deleted.
- [x] `env/index.ts` - already uses `InstanceState.make(...)`.

## ConfigPaths

- [x] `config/paths.ts` - separate pure helpers from effectful helpers; `fileInDirectory(...)` remains a plain function.
- **Superseded intentionally:** do not add a forwarding-only `ConfigPaths.Service`. `Config` and the TUI domain own reading and parsing, while `ConfigPaths` provides focused helpers.
- [x] `config/config.ts` and `cli/cmd/tui/config/tui.ts` - yield the effectful `ConfigPaths` helpers directly.
- [x] `cli/cmd/tui/config/tui-migrate.ts` - intentionally retain the plain async compatibility module rather than effectifying it.

## Instance cleanup

`project/instance.ts` is now a thin ALS compatibility shim, and route ambient reads are zero. Remaining retirement work:

- [ ] Remove the remaining `WithInstance` compatibility boundary after Hono and other entrypoints provide explicit instance context.
- [ ] Retire the remaining session/compatibility ALS fallback once all consumers receive explicit instance context.

## Notes

- Prefer small, semantics-preserving config migrations. Config precedence, legacy key migration, and plugin origin tracking are easy to break accidentally.
- When changing config loading internals, rerun the config and TUI suites first before broad package sweeps.
