# Graph parity fixtures (WP-06)

Static input+expectation fixtures for the six graph faces. They are **not** an execution engine: the W0 recorder/comparator (WP-02/WP-03) will consume them. The contract prose lives in `packages/chimera/specs/rust-host/graph/`; this directory holds only fixtures + shape validation.

- contract_rev: `cr-2026-10-30-r1`
- fixture_version: `1`
- index: `index.json`
- schema: `schema.json`

## Layout

```text
test/oracle/graph/
├── index.json                 # machine-readable fixture list + coverage
├── schema.json                # JSON Schema for fixture files
├── validate-fixtures.ts       # shape/coverage/forbidden-content check
├── extraction/{golden,negative}/
├── store/{golden,negative}/
├── resolution/{golden,negative}/
├── query/{golden,negative}/
├── traversal/{golden,negative}/
└── pattern/{golden,negative}/
```

Each fixture is `<face>/<kind>/<slug>.json`; its `id` is the same path without `.json` (for example `extraction/golden/ts-basic`).

## Required fields

`fixture_version`, `contract_rev`, `id`, `face`, `kind`, `title`, `input`, `expect`, `provenance`.

`expect.status` is one of `ok` / `defer` / `error` / `empty`. `provenance.executed` records whether the expectation was derived by running the current TS engine (`true`) or read from code semantics only (`false`); it is not a live verification result.

## Canonicalization

- IDs in fixtures are symbolic (`n_*`, `fn_*`); the harness maps hashed IDs by `(kind,name,startLine,startColumn)` and stable-sorts nodes/edges/refs.
- Ranges are UTF-16 code units. The astral fixture also records the UTF-8 byte range as a counter-example; implementations returning bytes must fail.
- BM25 scores are not pinned; query fixtures pin order/names/term counts.
- `walPages`, `durationMs`, `updatedAt` are volatile and type-constrained only.

## Validate

From `packages/chimera`:

```bash
bun run test/oracle/graph/validate-fixtures.ts
```

The check verifies index/file correspondence, required fields, id=path, per-face coverage (≥1 golden + ≥1 negative), and scans for forbidden content (real backend URLs, home/workspace absolute paths, IPv4 literals, common credential prefixes).

## Adding a fixture

1. Create `<face>/<kind>/<slug>.json` using an existing fixture as the shape template.
2. Set `id` to the path without `.json`.
3. Add the entry to `index.json` and update `coverage`.
4. Run the validator.

See `packages/chimera/specs/rust-host/graph/parity-fixtures.md` for the full contract, and `known-pitfalls.md` for the three migration traps these fixtures target.