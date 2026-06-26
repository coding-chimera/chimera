- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The tracked branch for this checkout is `chimera/acp-pruning`; local worktrees may still be on `main`.
- Check live git refs before choosing a diff base; do not assume `dev` or `main` is the intended base.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- `memory.md` is a temporary cross-session memory pad for this checkout. Read it when resuming interrupted local work, keep entries concise, remove stale notes, and never store secrets or durable project documentation there.

## Naming convention

- In this workspace, `opencode` no longer means upstream/original opencode by default.
- `chimera` is the public npm package and public CLI command for the complete Chimera distribution: the opencode-derived agent runtime plus the Chimera/CodeGraph graph and audit runtime.
- Do not add public `opencode` or `codegraph` bins; graph/runtime commands live under `chimera graph ...` and `chimera --graph ...`.
- When referring to the original upstream project, say **upstream opencode** or **original opencode** explicitly.

## Graph data root

- New project-local Chimera graph data belongs under `.chimera/`; `.codegraph/` is legacy compatibility data only.
- Do not hard-code `.codegraph/` or `.chimera/` paths when graph directory helpers can resolve the active data root.
- `status`, `query`/`search`, agent tool probes, and other read-only opens must not initialize, migrate, or create graph data. They should report `uninitialized`, `current`, `legacy`, `mixed`, or `custom` data-root status instead.
- Only explicit write flows such as `chimera graph init`, `chimera graph index`, `chimera graph sync`, or `chimera graph migrate-data` may create or migrate graph data.
- Do not silently move, merge, or delete legacy `.codegraph/` data. Use `chimera graph migrate-data` and preserve user data unless an explicit mode says otherwise.
- Watchers, extraction, git-status scans, and file traversal must ignore both `.chimera/` and `.codegraph/` during the compatibility window.

## Style Guide

### Agent-Facing Tools

- When adding or changing an agent-facing tool, update the corresponding agent guidance in the same change. This can include the tool description, system prompt, tool result hint, command template, or workflow instruction that teaches the model when and how to use the tool.
- Do not rely only on implementation or tests to make a new tool discoverable. If a tool is part of an expected workflow, add a high-salience prompt or tool-output reminder for that workflow.
- For Chimera tools specifically, keep tool names and workflow guidance aligned with `specs/coding-chimera/plan.md`.
- Tool guidance should be description-heavy and schema-short. The more freedom, risk, side effects, or selector ambiguity a tool has, the more model-facing description it needs to constrain when and how to use it; broad tools like `bash` justify long descriptions because the action space is large.
- Keep schemas concise and mechanical: name the required inputs, types, and local field meaning. Put workflow rules, negative guidance, examples, fallback paths, and sequencing in the tool description or prompt guidance rather than burying them in many optional schema fields.
- Avoid "large schema, thin description" designs. If a tool needs several optional seeds or modes, either split it into narrower tools, make the intended seed required where possible, or add strong description text that tells the model which field to choose and which fields to omit.
- Prefer one model-facing action per tool. Avoid teaching multi-mode tools that require `action`, `mode`, `recent`, or broad optional selector combinations when a workflow-specific tool name can carry the intent.
- For Chimera tools, prefer `chimera_audit_recent` for post-mutation closeout, `chimera_audit` for explicit audit seeds, and split obligation tools (`chimera_obligations_list`, `chimera_obligations_sync`, `chimera_obligation_claim`, `chimera_obligation_resolve`, `chimera_obligation_ignore`) over action-based umbrella tools.
- For Chimera graph/runtime references exposed to agents, prefer typed refs such as `node:<id>`, `audit:<id>`, `predesign:<id>`, `oracle:<id>`, `obligation:<id>`, and `change:<id>` in `ref` / `refs` fields; keep raw `nodeID`, `oracleID`, and `obligationID` fields as legacy compatibility paths when needed.

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/chimera`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/chimera`), never `tsc` directly.
