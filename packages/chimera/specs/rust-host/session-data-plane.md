# ABI-stable Rust Session Data Plane

Status: active implementation
Baseline: main@0eae27d0c4 plus current workspace changes
Owner surface: `packages/chimera/src/session`, `src/sync`, `src/tool`, and the independent `chimera-session-data` crate

## 1. Objective

Implement a read/write Session Data Plane in Rust while keeping every public contract unchanged. TypeScript retains the public facade, session control flow, permissions, plugins, provider SDKs, and compatibility behavior. Rust owns streaming tool-output ingestion, the single canonical writer, and rebuildable history/context projections.

The work is complete only when all of the following hold:

- Public TypeScript/Effect, HTTP/OpenAPI/SDK, SQLite, ID/cursor, and event contracts have no unapproved delta.
- There is exactly one writer for each session's canonical message/part writes. Shadow operation never means two production commits.
- Large tool outputs can be spooled incrementally without repeatedly materializing them in JSC.
- The Rust history/context replica is disposable and rebuildable from SQLite, with strict read-your-writes fencing.
- Pre-commit fallback is transparent. Post-commit unknown outcomes are resolved by lookup, never blind replay.
- Focused behavior, fault-injection, ABI, and memory gates pass.

## 2. Frozen public ABI

The following are compatibility obligations, not optional cleanup targets:

- `Session.Interface` and `SyncEvent.Interface`: method signatures, generics, Effect laziness, return types, and errors. In particular `updateMessage<T> => Effect<T>` and `updatePart<T> => Effect<T>` do not become Promise-based APIs.
- `MessageV2.WithParts` and v2 `SessionMessage` remain separate public projections. `page`, `stream`, `recent`, `parts`, `get`, and cursor behavior remain stable.
- `part.delta` remains live-only. The unified writer must not start persisting it.
- `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` and `OPENCODE_EXPERIMENTAL_WORKSPACES` preserve their existing behavior. `session_message` and workspace event rows are only produced under their respective gates.
- SQLite schemas, migrations, row JSON shapes, indexes, ID generation, timestamp encoding, ordering, and opaque cursors remain compatible. Drizzle remains the only migrator.
- HTTP routes, OpenAPI, generated SDK types, error envelopes (`{name,data}`), SSE payload shapes, and cancel/compaction semantics remain stable.
- Internal `outputRef`, Rust handles, and revision metadata never leak into public parts, SDK messages, bus events, or plugin values. Public `part.state.output` and `outputPath` remain unchanged.
- Legacy mocks and clients are not forced to change. No lazy proxy is used to disguise a `WithParts` object.

## 3. Architecture

```text
Session / SessionPrompt / SyncEvent callers
                  │
        TS Compatibility Facade
                  │
       Internal Operation Router
          ┌───────┴────────┐
          │                │
   Legacy TS driver   Rust Session Data Plane
          │                │
          │        ┌───────┴────────┐
          │        │                │
          │     Writer path      Reader path
          │   per-session queue  incremental history/context
          │        │                │
          └────────┴──── SQLite ────┘
```

The router, not the caller, decides whether an operation is eligible. Unsupported operations return `legacy_required` before side effects and use the existing implementation.

Two read lanes exist:

1. Public compatibility lane: existing `Session.messages`, `MessageV2`, HTTP, export, fork, and revert behavior still materializes `WithParts` as required.
2. Internal hot lane: `SessionPrompt.runLoop` may consume a versioned context view without hydrating full history into JSC. This lane is internal and does not alter public return types.

JavaScript predicates, plugin transforms, and `toModelOutput` closures remain in TypeScript. Rust may filter candidates but never reimplements these callbacks behind the caller's back.

## 4. Internal versioned protocol

The public ABI is frozen; the facade/driver protocol is independently versioned.

```ts
type DataCommand = {
  abi: "session-data/1"
  operation: "message.upsert" | "message.remove" |
    "part.upsert" | "part.remove" | "tool-result.commit" |
    "tool-output.put" | "context.read"
  commandID: string
  sessionID: string
  expectedHistoryHash?: string
  payload: PackedPayload
}

type DataResult = {
  abi: "session-data/1"
  commandID: string
  status: "committed" | "already_committed" |
    "revision_conflict" | "legacy_required" | "error"
  historyHash?: string
  aggregateSeq?: number
  postcommitEvents?: PostcommitEvent[]
  error?: InternalError
}
```

Capabilities are independent: `writer.message.v1`, `writer.part.v1`, `writer.tool-result.v1`, `reader.compaction-view.v1`, `tool-output.spool.v1`, `projection.session-message.v1`, `projection.workspace-event.v1`, and `transport.sse.v1`.

## 5. Revision and read-your-writes

`aggregate_seq` remains the existing SyncEvent sequence for workspace replay and queue ordering.

`historyHash` is a content-derived session revision used by the data plane. It covers canonical message/part IDs, update timestamps, data hashes, and removals. It requires no new SQLite columns and can be recomputed after restart. TS and Rust compute it independently from committed facts.

The hot lane sends `expectedHistoryHash`. Rust must satisfy exact equality:

```text
replica.historyHash === expectedHistoryHash
```

A mismatch marks the replica stale and triggers rebuild or `revision_conflict`. `>=` is forbidden because the replica could observe a prompt that the TS loop has not consumed yet, breaking steer/coalescing semantics.

## 6. Canonical writer

Each session has an ordered writer queue with command and byte budgets. There are also global byte limits. Backpressure is applied before unbounded allocation.

`tool-result.commit` is an internal composite operation that replaces the current `EventV2.run` followed by `completeToolCall` sequence when enabled:

```text
BEGIN IMMEDIATE
  validate command, generation, and expected history
  write or reuse tool output
  upsert part
  if EventV2 is enabled: update session_message in the same transaction
  if WORKSPACES is enabled: append event/event_sequence
  derive new historyHash
COMMIT
```

Post-commit events retain their existing order. When the combined operation is unsupported, the original two calls execute unchanged.

Other methods, including session metadata, fork/remove/revert, and compaction writes, migrate incrementally. An eligible session never mixes TS and Rust message/part writers.

## 7. Tool-output spool

Current truncation writes a complete JavaScript string, splits it into lines, joins a preview, and writes the full output. The spool accepts bounded chunks in Rust and produces the existing preview and output path contracts.

Public results remain `{content,truncated:false}` or `{content,truncated:true,outputPath}`. Internal output references are not exposed.

Spool requirements:

- stream UTF-8 bytes without changing byte/line boundary behavior;
- preserve head/tail direction, maxLines/maxBytes, and truncation hints;
- retain the full output only at the configured file/spool destination, not as repeated strings;
- bound queued and preview memory independently of full output size;
- abort and release handles on every exit path;
- use content addressing only as a later disk optimization, never as a reason to alter public part shape.

## 8. Rebuildable reader/context replica

SQLite is authoritative. The replica is a disposable projection containing incremental history, compaction boundaries, byte/token estimates, context revisions, and optional provider projections.

It may not change canonical rows, advance the Runner, make permission decisions, or invoke plugins.

Crash behavior:

- Rust crash: hot operations fall back to legacy, then a fresh replica is rebuilt from SQLite and checked by `historyHash`.
- Bun restart: the old replica is considered invalid and rebuilt.
- Gap or tombstone mismatch: full rebuild, never silent application of a gap.

## 9. Idempotency and failures

Database writes are idempotent. Existing live-only Bus/SSE delivery remains best-effort and is not upgraded as a side effect of migration.

- Existing event IDs dedupe `(operation,event.id)` when available.
- Workspace events are deduped by their persisted event ID.
- Natural message/part keys plus payload hashes make retries safe.
- If a row already equals the desired state, return `already_committed` without incrementing sequence or republishing.

Failure rules:

- Pre-commit errors may fall back to legacy with no Rust side effects.
- Revision conflicts require a fresh read and operation reevaluation, not blind retry.
- Post-commit unknown outcomes are arbitrated by natural key/event ID/hash lookup. Return `already_committed` when proven, otherwise propagate the original error.
- Provider requests are never reissued merely because an arm failed mid-stream.

## 10. Delivery plan and gates

### Phase 0 — Contract and memory baseline

- Freeze interface fixtures and four flag combinations.
- Record request/row/event parity and current known bugs separately.
- Add a real turn-loop memory benchmark with runtime stamps and independent processes.

### Phase 1 — Spool and read-only shadow

- Implement Rust spool, abort/release lifecycle, and compatibility adapter.
- Implement read-only historyHash and replica rebuild.
- Gate: output shape unchanged, large-output peaks fall, replica deletion is harmless.

### Phase 2 — Isolated writer shadow

- Implement message/part upsert/remove, tool-result commit, ordered queues, and transaction-local projections in an isolated database.
- Gate: row-level zero diff, flag matrix parity, no v1/v2 drift under crash injection, bounded writer bytes, no persisted deltas.

### Phase 3 — Limited enforce

- Enable only eligible sessions/operations. All message/part writes for an eligible session use Rust; other sessions and operations stay legacy.
- Gate: pre-commit fallback, post-commit arbitration, kill-switch continuation, and no total-footprint regression.

### Phase 4 — Expand read/write coverage

- Add session metadata, fork/remove/revert, compaction writes, part reconcile, hot-context projection, and provider profiles incrementally.
- Each operation keeps the same public ABI and an independent fallback.

### Phase 5 — Carrier decision

Compare N-API, independent host, and TS revision cache using the same workload. Move to a host only if address-space isolation is required and its launcher, IPC backpressure, recovery, worker kill, and retention are ready.

## 11. Verification

Required checks from `packages/chimera` and the Rust crate:

- `bun typecheck` and focused `bun test --timeout 30000` for touched surfaces.
- Rust format/check/unit/integration tests when execution of fresh binaries is explicitly approved.
- Row-level and event-level TS/Rust parity with independent recorders and intentionally failing meta-tests.
- Repeated fresh-process A/B runs in alternating order; do not compare different Bun/git/platform stamps.
- Measure JSC stats, GC-before/after allocation, RSS, macOS phys_footprint categories, DB/WAL bytes, and actual queue/cache bytes. `external` and `arrayBuffers` are diagnostic only on affected Bun versions.
- Demonstrate actual memory return or process reclamation; `free`/GC alone is not proof.

No commit, release, or production writer flip is implied by this document.
