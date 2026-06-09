# Chimera package

`packages/chimera` is the graph/runtime compatibility package (`@opencode-ai/chimera`). It contains the CodeGraph-derived core plus the retained graph CLI/MCP surface used by the complete Coding Chimera agent package.

The public complete-agent npm package is `coding-chimera`, and the only public command it registers is `chimera`. In that package, graph commands are exposed as `chimera graph ...` and `chimera --graph ...`; do not add new public `opencode` or `codegraph` command paths.

## Build, test, run

Run commands from `chimera/packages/chimera`, not from the repository root.

```bash
bun run build        # tsc + copy schema.sql and wasm assets into dist/; chmods dist/cli/chimera.js
bun typecheck        # tsgo --noEmit
bun test             # vitest run
bun run test:eval    # evaluation suite only
node dist/cli/chimera.js --version
```

`copy-assets` is part of `bun run build`; any new SQL or vendored grammar wasm must be copied into `dist/` or it will not ship in npm/bun installs.

## Architecture

- `src/index.ts` is the public library surface. Keep `CodeGraph` compatible for existing consumers; add Chimera-named aliases rather than breaking opencode integration during migration.
- `src/cli/chimera.ts` is the retained graph CLI. Keep it importable by `packages/opencode` through `@opencode-ai/chimera/cli` so the full agent can route `chimera graph ...` without starting the TUI/session runtime.
- `src/db/schema.sql` and `src/extraction/wasm/*.wasm` are runtime assets and must work from source, tests, and `dist/`.
- `src/mcp/server-instructions.ts` is the single source of truth for standalone MCP agent-facing guidance. Installer targets should not duplicate that guidance into agent instruction files.
- `src/installer/targets/*` owns agent config writers. Preserve idempotent install/uninstall behavior and legacy CodeGraph cleanup paths.

## Compatibility constraints

- The default data directory remains `.codegraph` in this migration stage.
- Existing `codegraph_*` MCP tools and legacy installer markers remain compatibility surfaces unless a migration plan explicitly removes them.
- New user-facing install snippets should use `npm install -g coding-chimera` and `chimera`. Refer to this package as a graph compatibility/runtime surface when needed.
- opencode must consume this package through `@opencode-ai/chimera`; do not add reverse imports from this package into `packages/opencode` or `@/` aliases.

## Validation expectations

- For resource/path changes, build the package and smoke the CLI from `dist/cli/chimera.js`.
- For installer target changes, update or add target tests and preserve uninstall behavior for old `codegraph` config keys.
- For MCP/tool guidance changes, update `src/mcp/server-instructions.ts` in the same change.
