# Coding Chimera agent package guide

## Package / CLI identity

- `packages/chimera` is the current complete Chimera agent package source.
- Publish/install identity is `@coding-chimera/chimera`; the only public bin is `chimera`.
- Do not add `opencode` or `codegraph` public bins. Graph commands route through `chimera graph ...` or `chimera --graph ...`.
- If changing installer, MCP, tool, prompt, build, or publish behavior, keep user-facing guidance aligned with `npm install -g @coding-chimera/chimera` + `chimera`.

## Install and release-matrix validation

- Use Bun for package-internal development commands in this checkout: build, test, typecheck, pack, and dependency installation while developing. Run commands from `packages/chimera`; do not run build, test, lint, or typecheck commands from the repository root.
- For source validation, use `bun typecheck` and focused `bun test --timeout 30000 <test-file>` as needed. Do not run `tsc` directly.
- For local tarball/user-install validation, build with `OPENCODE_CHANNEL=latest bun run build --single --skip-install`. WebUI assets embed by default, creating `dist/npm-tarballs/coding-chimera-chimera-with-webui-<version>.tgz` and the current-platform tarball such as `coding-chimera-chimera-darwin-arm64-with-webui-<version>.tgz`; pass `--no-webui` (or `--package-variant=no-webui`) to produce the MIT no-WebUI tarballs instead.
- To keep both variants for release assets, run the no-WebUI build first with `OPENCODE_CHANNEL=latest bun run build --single --skip-install --no-webui`, then a second build with `OPENCODE_CHANNEL=latest bun run build --single --skip-install --preserve-npm-tarballs` (WebUI is the default). This preserves the no-WebUI tarballs and adds `*-with-webui-<version>.tgz` tarballs. Keep no-WebUI and with-WebUI artifacts visibly separate in release notes.
- Use npm for user-facing global install validation and release-matrix install smoke tests. Published-package validation should exercise `npm install -g @coding-chimera/chimera`; local tarball smoke tests should install one variant at a time with npm, e.g. `npm install -g ./dist/npm-tarballs/coding-chimera-chimera-darwin-arm64-no-webui-<version>.tgz ./dist/npm-tarballs/coding-chimera-chimera-no-webui-<version>.tgz`.
- Verify npm installs with `command -v chimera`, `chimera --version`, and `npm ls -g --depth=0 @coding-chimera/chimera @coding-chimera/chimera-darwin-arm64`. When validating the with-WebUI package, also start `chimera web --open=false` and request `/` using Basic auth user `chimera` if `OPENCODE_SERVER_PASSWORD` is set; confirm it does not return the missing-assets message.
- Do not use `bun install -g` as release-matrix or user-install evidence; it only exercises Bun's global package store and can mask npm install/postinstall issues.

## Graph data root and tool behavior

- Current project-local graph data lives under `.chimera/`. Legacy `.codegraph/` is read for compatibility and explicit migration only.
- Use `src/graph/directory.ts` helpers such as `getGraphDataRootInfo` and `getCodeGraphDir` instead of hard-coding graph data paths.
- Read-only surfaces, including `status`, `query`/`search`, agent graph tools, prompt-context loading, and read-only `CodeGraph.open`, must not create `.chimera/`, `.codegraph/`, lock files, DBs, job files, or migration artifacts.
- When a project is uninitialized, read-only graph tools should return structured status such as `initialized`, `dataRoot`, `dataRootStatus`, and `jobStatus` rather than initializing automatically.
- Only explicit write flows (`chimera graph init`, `index`, `sync`, `migrate-data`) may create or migrate graph data. Never silently move, merge, or delete legacy `.codegraph/` data.
- When changing graph CLI, Chimera tools, prompt context, storage paths, watcher/extraction ignores, or installer behavior, update agent-facing prompt/tool guidance and focused tests in the same change.
- Keep `src/graph/` free of `@opencode-ai/core` imports: the lazy `require('../index')` sites in `src/graph/mcp/{engine,tools}.ts` must not transitively reach modules containing top-level await (for example `core/util/log` -> `core/global`), or `bun run build` fails to compile the single binary. Use graph-internal diagnostics instead (`defaultLogger` in `src/graph/errors.ts`, or `process.stderr` writes with the `[CodeGraph]` prefix).

## Agent tool visibility and permission allowlists

- A denied tool is not merely blocked at call time: `Permission.disabled()` (`src/permission/index.ts`) removes it from the model's tool list entirely, so the agent cannot even see that the tool exists.
- `explore` runs a `"*": "deny"` + allowlist ruleset in `src/agent/agent.ts`: grep/glob/list/bash/webfetch/websearch/read plus the four read-only Chimera graph tools (`chimera_status`, `chimera_search`, `chimera_file_symbols`, `chimera_impact`). Because `bash` stays allowed, a locked-down agent missing a needed tool silently degrades to shell workarounds — observed in practice: an explore subagent told to use `chimera_search` with `projectPath` fell back to `bash chimera graph ...` because the graph tools were not in its allowlist.
- When adding a new agent-facing tool, decide explicitly which restricted agents should get it and add narrow allowlist entries; do not use broad wildcards like `chimera_*` for `explore` — that would also grant write flows (`chimera_init_graph`, obligation/oracle tools) to a read-only explorer.
- `chimera_swarm` preset mapping (`src/tool/swarm.ts`): `file-review` workers always run as `explore`; other presets run as `general`, which inherits the permissive `defaults`. Keep this mapping in mind when shaping swarm items that depend on specific tools.
- Keep agent prompts aligned with the allowlist: `src/agent/prompt/explore.txt` tells explore to prefer the graph tools for structure questions. A tool that is allowed but never mentioned tends to go unused; a tool that is mentioned but denied produces silent CLI fallbacks.
- Change-tool results carry an inline propagation summary: successful `edit`/`write`/`apply_patch` outputs append a bounded probe line from `src/chimera/propagation-probe.ts` (`Propagation check: <N> dependent symbol(s) may be affected: <top 3 entries>.` or the no-dependents wording) as pure informational context, with no action invitation and no `chimera_audit_recent` reference (B4). The probe is symbol-granular: `edit` passes its computed before-ranges and `apply_patch` its old-side hunk ranges (writes stay file-level), seeds resolve through `nodesIntersectingRange` plus persisted predesign `seedNodes`, and the walk follows `incomingRelations` symbol-level edges (node-capped, cycle-safe via a visited set, continuing through pass-through-like small host files ≤40 lines). Same-file consumers of an edited symbol are contract bridges, not naming noise: they expand the walk ungated, are never named as entries, and surface only as `via <symbol>@<seedFile>` annotations — so an edited constant whose only readers are its own file's functions still reaches external callers. Depth counts cross-file hops only (bridge jumps are free), keeping the 4-hop budget for real consumer chains. Entries render as `symbol (file:line)` — a shared file-extraction regex constant keeps `prompt-context.ts` scope-drift reconciliation parsing both the new format and legacy bare paths from pre-upgrade session history. When the session has a predesign declaration, the probe additionally emits `Scope check:` lines reconciling the walk against the declared scope; out-of-scope entries are ranked deepest-hop-first and annotated `via <intermediate symbol>@<file>, <N> hops`, because multi-hop consumers are invisible to grep on the changed symbol and often hardcode the stale contract (TB6 bench: 3-hop and cascade fixtures). Symbol granularity is the flood fix: file-level projection named every module importer of a hub file (a private-function edit once flagged 5 unrelated TUI files; symbol seeding named 0 external dependents). When the graph is unavailable or the probe exceeds its 500ms budget, it degrades silently and no line is appended.
- Mutation audit evidence is recorded system-side, not by model ritual: `trackToolMutation` (`src/chimera/provenance.ts`) writes an `AuditRunRecord` (`source: "track-tool-mutation"`, keyed by `provenanceID`) right after the change facts, so the closeout gate is satisfied without a `chimera_audit_recent` call and apocalypse mode cannot be skipped by the model. `Closeout Signals` request `chimera_audit_recent` only when that auto-record is missing (degraded graph). Design evidence: 47 model-invoked audit/oracle ritual calls across 23 bench cells had a 2% action rate while costing ~17.5KB/cell of context.
- Failing/unknown oracles linked to recent mutations are inlined into the runtime context as one-line `Linked Verification Evidence` summaries (command, exit, last output line, `oracle:` ref; deduped, capped at 5) by `src/chimera/prompt-context.ts`; the gate asks the model to review them in place and use `chimera_oracle_get` for full output instead of recalling via `chimera_oracle_recent`.
- The `chimera_predesign` receipt is a compact gate-satisfaction record (~1.2KB: coverage, evidence counts, top-3 dependents/impacted); full seed/evidence detail stays in tool metadata and the recorded run. Keep it slim — the receipt averaged 9.4KB and was the largest per-call byte tax before the ritual-tax optimization. The predesign call itself is load-bearing: the declaration feeds the probe's scope reconciliation and the mutation gate, so never remove the call to save bytes.

## Background job quota scope vs. ownership scope (known trap, unresolved)

- `BackgroundJob` quota is **instance-scoped, not session-scoped and not process-global**. The registry is built through `InstanceState.make` (`src/agent/background-job.ts:434`) and `InstanceState.get` keys its `ScopedCache` by **directory** (`src/effect/instance-state.ts:36,62-65`), so every opened project directory owns one independent registry. One process with N project directories open therefore has N separate pools and **no process-wide ceiling**.
- The cap counts every running job regardless of owner: `Array.from(jobs.values()).filter((job) => job.info.status === "running").length >= limit` (`src/agent/background-job.ts:264-266`). Ownership itself is typed since the 2026-09-10 migration: `StartInput.ownerSessionId` / `Info.ownerSessionId`, plus a per-job `delivery: "pending" | "delivered"` state machine (`markDelivered` / `waitOwnerQuiescent`) that the nested-background park relies on — the engine still enforces no per-session quota.
- But visibility and cancel rights **are** session-scoped: the `## Background Tasks` runtime-context block lists only jobs whose typed `ownerSessionId === input.sessionID` (`src/session/prompt.ts` backgroundTasks section), and `task_cancel` rejects anything not owned by the calling session (`src/tool/task-cancel.ts` ownership guard).
- Consequence: a session can be refused a background slot by jobs it can **neither see nor cancel**, while `BackgroundJobLimitError.message` (`src/agent/background-job.ts:78-80`) instructs it to "Complete or cancel a running background task before starting another" — an instruction the model cannot carry out in that state. Any fix must make the limit error state whose jobs are holding the pool, or make foreign jobs visible.
- Practical saturation: all sessions of one project share the single `delegation.background_concurrent` pool (default 16, `src/config/delegation.ts:10`). ~~An ultra root session dispatching a 16-worker `chimera_swarm` consumes it entirely~~ **(2026-09-23 F4-P2 起失效：`chimera_swarm` workers 已改为注册为引擎前台 job（`metadata.background === false`），task precheck 与引擎原子 cap 计数双层均豁免前台 job，swarm 不再占用 background_concurrent 池，只占 `DelegationLimiter` 信号量)**。后台 `task(background=true)` 仍受池闸；池满时后续后台派发被 limit 错误拒绝。The foreground pool is separate (`DelegationLimiter`, `max_concurrent` default 128, `src/agent/delegation-limiter.ts:26-36`); its per-session `holders` map exists only for parent->child permit borrowing, not for per-session quota.
- Engine teardown finalizer（2026-09-23 F4-P2, `179379cb3`）：引擎注册表在实例 scope 关闭时经显式 finalizer 对每个 running job 做终态迁移 + done Deferred + onInterrupt 钩子（finalizer-safe 原语，不回调 `cancel()`；`Effect.ignoreLogged` 在 effect v4 beta.83 **不存在**，用 `Effect.ignoreCause({log:true})`）。closeout 五条协议成文于 `src/agent/background-job.ts` 的 `make()` 前 doc block（子自收尾/delivery 双路径含 swarm 内联消费必须 markDelivered/父 park 无放弃超时/run 模式 quiescence drain/注入轮聚合）。Dispose 矩阵测试 `test/agent/background-job-dispose.test.ts` 覆盖三腿（实例 dispose 杀引擎 job/杀全部 session runner/session.remove 单层恰好一次）。
- Ownership was promoted from the untyped `metadata: Record<string, unknown>` bag to typed `StartInput`/`Info` fields (2026-09-10); `metadata.parentSessionId` / `metadata.sessionId` survive only as the engine-derived compatibility projection written inside `start()`. Any per-session fairness quota can now read the typed owner directly (job kind remains untyped).
- Ownership-typing migration (2026-09-10, batch P1 of the nested-background orphaning fix; **implemented the same day**): owner promoted to typed `StartInput.ownerSessionId` / `Info.ownerSessionId`; all four consumers read the typed field — backgroundTasks visibility filter (`src/session/prompt.ts`), `task_cancel` ownership guard (`src/tool/task-cancel.ts`), cancel-cascade BFS (`src/session/run-state.ts`), and `session.remove` cleanup (`src/session/session.ts`). The engine, and only the engine, derives `metadata.parentSessionId` from the typed field inside `start()` as a temporary compatibility projection (expand phase), so future upstream-ported code reading metadata keeps working and the two representations cannot drift by construction (single writer, single source of truth). The redundant `metadata.sessionId` (always equal to `job.id`) gets the same treatment: BFS reads `job.id`, engine keeps emitting the legacy key. A drift-guard test asserts projection == typed field after start/extend/settle (`test/agent/background-job.test.ts`). New code must always read the typed field; do not add new readers of the metadata representation.
- Contract phase (purification of the derived dual-write) deferred by user decision (2026-09-10): after the next F-line upstream-sync batch lands, confirm no fork readers of `metadata.parentSessionId` / `metadata.sessionId` remain, then remove the derived projection entirely as a cleanup/performance optimization (drops the redundant per-job fields). Do not remove the projection before that confirmation.
- Nested-background orphaning fix (2026-09-10, fork-specific; upstream has no equivalent protection — its task.test.ts even asserts background completion does not wait for the parent prompt): a subagent dispatch is no longer "finished" when the child's turn ends. `runPreparedCore` (`src/agent/subagent-dispatch.ts`) parks on `waitOwnerQuiescent(child)` while the child owns running or delivery-pending jobs, then re-reads the child's newest assistant message as the final output (foreground and background dispatch paths share this, so nested background mids are covered too). Delivery contract: `markDelivered` must run only **after** `injectSynthetic` returns (the woken turn has fully completed) — marking earlier would let a park exit before the aggregation turn. `chimera run` drains root-owned jobs after the prompt returns via `GET /session/:id/background/quiescence` (`drainBackgroundJobs` in `src/cli/cmd/run.ts`) and tears the SSE stream down with an AbortController grace abort so `--attach` sockets cannot hold the process open. Park has no abandonment timeout by user decision: foreground dispatch publishes `onParkProgress` metadata (parked / waitingBackgroundTasks / parkElapsedMs, default 30s cadence) and holds its DelegationLimiter permit for the whole park; the cancel cascade is the escape hatch.
- Background dispatch always returns immediately (2026-09-11): `task` with `background: true` either extends the running job (BACKGROUND_UPDATED) or restarts a fresh background run on the same session id (BACKGROUND_STARTED); resuming an already-settled job restarts in the background and its zombie settled-but-delivery-pending state is overwritten by the new job entry. The former `syncResume` degradation (background + settled-resume silently flipping to a synchronous foreground dispatch that parked the parent turn indefinitely on `waitOwnerQuiescent`) is removed; the no-park-timeout decision above now applies only to the intentional foreground path. Delivery marking is generation-safe (2026-09-11): every job entry carries a typed `Info.generation` (incremented each time `start` creates a new run on the same id; the running short-circuit returns the old generation unchanged) and notify fibers call `markDelivered(id, generation)`, where a stale-generation mark is a no-op — a same-id restart while the old notify fiber is still injecting would otherwise let the legacy by-id mark falsely deliver the new running entry, collapse `waitOwnerQuiescent`/quiescence early, and orphan the new run's result injection. `freshStart` detects `start()`'s running short-circuit via the generation comparison (the temporary `startNonce` metadata hack is removed; `markDelivered(id)` without a generation keeps the legacy by-id behavior for existing callers).
- Status: the quota-scope and visibility-asymmetry parts remain a parked known trap — do not silently change quota scope or the limit-error wording without resolving the visibility asymmetry in the same change. Ownership typing is implemented (expand phase); the contract phase (projection removal) stays deferred until the post-upstream-sync confirmation above.
## Detached tool work vs. oracle recording (known trap, deferred)

- The shell tool records its Chimera oracle **before it returns**: `Chimera.recordToolOracle({ kind: "shell", status: shellOracleStatus(...), startedAt, finishedAt, payload })` at `src/tool/shell.ts:598-619`, with the status derived from exit code / timeout / abort at `src/tool/shell.ts:82-87`. The vocabulary is strictly binary — `pass` or `fail`. There is no "still running" / "result pending" state.
- The provenance layer carries a second binary status of its own (`success` | `failure`) at `src/chimera/provenance.ts:56,181`, plus an `OracleStatus` type referenced at `:25,116`. **Which enum must grow to express a non-terminal state is unresolved** — settle that before implementing, not during.
- Consequence for any tool that detaches work to the background (the planned `bash` background mode, which mirrors `task`'s `BackgroundJob` pattern): recording at return time files "just detached, outcome unknown" as a terminal pass/fail, so `chimera_oracle_recent` would report a verification result that never happened. That is worse than recording nothing, because closeout reasoning trusts oracle evidence.
- Deferring the record until the process actually exits is not free either: between detach and completion the command is invisible to `chimera_oracle_recent`, so a model asking "which verification ran?" inside that window gets no evidence and may re-run the same command.
- Status: **deferred on purpose** — the graph/audit tooling is being optimized concurrently, so the oracle vocabulary is a moving target. Do not extend it as part of background-shell work. Until this is re-decided, a background shell must adopt an explicit interim policy (defer the record, or emit a clearly-labelled non-outcome) instead of silently reusing `shellOracleStatus`.
# Ultra tier semantics

- `ultra` is a Chimera product-level reasoning tier (a model variant), **not a provider-offered tier**. It means the model's highest supported reasoning effort **plus** proactive multi-agent delegation with orchestrator discipline: the root session delegates implementation edits to `task`/`chimera_swarm` workers and keeps only planning, dispatch, synthesis, audit, verification, and small single-file fixes for itself (`src/session/prompt/ultra.txt`).
- Advertisement is universal, not membership-based: `variants()` in `src/provider/transform.ts` appends `ultra` to every model — a value copy of its highest advertised effort entry when the model declares efforts (it is **not always `max`**: models topping out at `xhigh` or `high` advertise that effort instead), or the pure orchestration profile `{ ultra: {} }` when the model has no tunable effort. Enable it per agent (`agent.<name>.variant = "ultra"`), via the TUI variant cycler, or per-model variant memory. The legacy `ultra_models` config key is deprecated: it still parses but no longer affects behavior. Users can disable ultra per model via config `variants.ultra.disabled`; selecting ultra on such a model fails the `unadvertisedUltra` check in `src/session/llm.ts`.
- The advertising layer translates `ultra` to that maximum value before any transport sees it; a raw `"ultra"` effort must never reach the wire. `lowerUltraEffort` in `src/provider/transform.ts` and `buildReasoning` in `src/session/codex-responses.ts` are defensive backstops.
- Selecting the `ultra` variant activates proactive multi-agent delegation via `multiAgentPolicy` in `src/session/llm.ts`. The `<multi_agent_mode>` block gates on the selected variant, not model identity: codex sessions always carry it; non-codex sessions only when `variant === "ultra"` (root gets the proactive orchestrator text; child sessions stay explicit-request-only; non-ultra sessions are byte-identical to before). Ultra root sessions also receive the generic `src/session/prompt/ultra.txt` layer plus a model-specific ultra layer when one is registered in `ULTRA_LAYERS` in `src/session/system.ts` (e.g. `deepseek-ultra.txt` for DeepSeek).
- Prompt layers are convention-based: `src/session/system.ts` matches ordered registry entries (`SPECIALIZATIONS`, `OVERLAYS`, `ULTRA_LAYERS`) against the model/provider id. Adding a layer for a new model family is normally a new txt file plus one registry entry. The Kimi layer (`kimi.txt`) is scoped to the K2.7 generation via a custom `match`: K2-family api ids (`kimi-k2…`) and the kimi-for-coding provider's K2.7 entry points match, while k3-generation ids (`k3`, `kimi-k3…`) intentionally receive no Kimi layer.
- Prompt assembly is Source-attributed: `systemSegments` in `src/session/llm.ts` builds the send-order segment list (`SystemPrompt.Segment` = `{key, content}`) from the layer registries plus `agent/system`, `policy/multi-agent`, `input/system/<i>`, and `user/system/0`; layer entries carry stable attribution keys (`core/default`, `core/workflow`, `model/<family>`, `overlay/<id>`, `core/chimera`, `core/workbrief`, `core/browser`, `variant/ultra`, `variant/ultra-<slug>`). The capability keys (`core/chimera`, `core/workbrief`, `core/browser`) come from `capabilitySegments` in `src/session/system.ts`, gated on the permission-filtered tool set the model can see and injected in that order after the overlay layers; they are assembled only in the branch where the agent has no `prompt` override — an override replaces the whole provider stack, so reduced prompts such as the `general` delegation prompt (`src/agent/prompt/general.txt`) never receive them. Joining segment contents is byte-identical to the legacy unattributed join.
- `experimental.system_context` (config, default off) gates context epoch persistence: when off, assembly does zero epoch DB access and stays byte-identical to the default path. When on, `src/session/system-context.ts` wraps the keyed segment list in one carrier `SystemContext.Source` (`prompt/system`) and `ContextEpoch` stores the first turn's baseline (= the default join) in `session_context_epoch`; unchanged turns reuse the stored baseline, source changes keep the baseline stable and ride a delta injected as an extra request-level system message (never persisted to session messages), compaction crossings replace the baseline, and epoch failures degrade to the default assembly. The carrier source is single because `SystemContext.initialize` joins distinct source baselines with `\n\n`, which could not reproduce the default path's `\n` join byte-for-byte.
- Subagents never run `ultra`: explicit subagent requests for `ultra` are rejected, and an inherited `ultra` variant is stripped before child dispatch.

# Remote compaction model eligibility

- Remote compaction (OpenAI Responses API compaction) is gated by a model-level capability list, not by provider claims: eligibility is determined by the model, not the provider.
- Membership is config-driven: `remote_compaction_models` in chimera.json extends the built-in trusted defaults (`DEFAULT_REMOTE_COMPACTION_MODELS` in `src/session/remote-compaction-registry.ts`). Config layers merge by union.
- Entries match `model.api.id` exactly or as a versioned prefix (`<entry>-...`), case-insensitively after trim; `"gpt-5.6"` covers `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and dated variants.
- Both resolution branches consult the merged list via `isModelRemoteCompactionCapable`: the OpenAI OAuth branch (`supportsOpenAIRemoteCompactionModel`) and the provider-transport branch. A miss resolves to reason `model_unsupported` with local fallback.
- When a new trusted OpenAI-native model family lands, add its base id to `DEFAULT_REMOTE_COMPACTION_MODELS`; user-specific or relay models belong in the `remote_compaction_models` config instead.
# Database guide

## Database

- **Schema**: Drizzle schema lives in `src/**/*.sql.ts`.
- **Naming**: tables and columns use snake*case; join columns are `<entity>_id`; indexes are `<table>*<column>\_idx`.
- **Migrations**: generated by Drizzle Kit using `drizzle.config.ts` (schema: `./src/**/*.sql.ts`, output: `./migration`).
- **Command**: `bun run db generate --name <slug>`.
- **Output**: creates `migration/<timestamp>_<slug>/migration.sql` and `snapshot.json`.
- **Tests**: migration tests should read the per-folder layout (no `_journal.json`).
- **Never edit an already-applied migration.** Folding a column into an old migration's `CREATE TABLE` (as happened with `familiar_lady_ursula` + `share_url`) forks database lineages: databases that applied it earlier never receive the column.
- **Lineage repairs must be idempotent.** A plain `ALTER TABLE ... ADD COLUMN` repair fails with "duplicate column" on databases that already have the column (including every fresh test database). Apply such repairs through `Database.applyMigrations` in `src/storage/db.ts`, which runs the known repair in a second pass only when the column is actually missing; every code path that applies migrations (including test helpers) must go through it.

# Module shape

Do not use `export namespace Foo { ... }` for module organization. It is not
standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript
runner. Use flat top-level exports combined with a self-reexport at the bottom
of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the
same file — they remain inaccessible to consumers (they are not projected by
`export * as`) but are usable by the file's own code.

## When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for
the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

## Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`,
`src/config/`), keep each sibling as its own file with its own self-reexport,
and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to
evaluate every sibling, which defeats tree-shaking and slows module load.

# opencode Effect rules

Use these rules when writing or migrating Effect code.

See `specs/effect/migration.md` for the compact pattern reference and examples.

## Core

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects and `Effect.fnUntraced` for internal helpers.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators as extra arguments, so avoid unnecessary outer `.pipe()` wrappers.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)` when you need a `Date`.

## Module conventions

- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

## Schemas and errors

- Use `Schema.Class` for multi-field data.
- Use branded schemas (`Schema.brand`) for single-value types.
- Use `Schema.TaggedErrorClass` for typed errors.
- Use `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Runtime vs InstanceState

- Use `makeRuntime` (from `src/effect/run-service.ts`) for all services. It returns `{ runPromise, runFork, runCallback }` backed by a shared `memoMap` that deduplicates layers.
- Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory or per-project state that needs per-instance cleanup. It uses `ScopedCache` keyed by directory — each open project gets its own state, automatically cleaned up on disposal.
- If two open directories should not share one copy of the service, it needs `InstanceState`.
- Do the work directly in the `InstanceState.make` closure — `ScopedCache` handles run-once semantics. Don't add fibers, `ensure()` callbacks, or `started` flags on top.
- Use `Effect.addFinalizer` or `Effect.acquireRelease` inside the `InstanceState.make` closure for cleanup (subscriptions, process teardown, etc.).
- Use `Effect.forkScoped` inside the closure for background stream consumers — the fiber is interrupted when the instance is disposed.
- To make a service's `init()` non-blocking, fork `InstanceState.get(state)` at the `init()` call site (e.g. `Effect.forkIn(scope)`), not by forking work inside the `InstanceState.make` closure. Forking inside the closure leaves state incomplete for other methods that read it.
- `src/project/bootstrap.ts` already wraps every service `init()` in `Effect.forkDetach`, so `init()` is fire-and-forget in production. Keep `init()` methods synchronous internally; the caller controls concurrency.

## Effect v4 beta API

- `Effect.fork` and `Effect.forkDaemon` do not exist. Use `Effect.forkIn(scope)` to fork a fiber into a specific scope.

## Preferred Effect services

- In effectified services, prefer yielding existing Effect services over dropping down to ad hoc platform APIs.
- Prefer `FileSystem.FileSystem` instead of raw `fs/promises` for effectful file I/O.
- Prefer `ChildProcessSpawner.ChildProcessSpawner` with `ChildProcess.make(...)` instead of custom process wrappers.
- Prefer `HttpClient.HttpClient` instead of raw `fetch`.
- Prefer `Path.Path`, `Config`, `Clock`, and `DateTime` when those concerns are already inside Effect code.
- For background loops or scheduled tasks, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.

## Effect.cached for deduplication

Use `Effect.cached` when multiple concurrent callers should share a single in-flight computation rather than storing `Fiber | undefined` or `Promise | undefined` manually. See `specs/effect/migration.md` for the full pattern.

## Instance.bind — ALS for native callbacks

`Instance.bind(fn)` captures the current Instance AsyncLocalStorage context and restores it synchronously when called.

Use it for native addon callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, etc.) that need to call `Bus.publish` or anything that reads `Instance.directory`.

You do not need it for `setTimeout`, `Promise.then`, `EventEmitter.on`, or Effect fibers.

```typescript
const cb = Instance.bind((err, evts) => {
  Bus.publish(MyEvent, { ... })
})
nativeAddon.subscribe(dir, cb)
```
