/**
 * Extraction Semantics Versioning
 *
 * The third invalidation axis of a graph database, next to content-hash
 * incremental sync and the schema-migration ladder (migrations.ts): a stamp
 * recording which extractor semantics actually produced the rows the database
 * holds today. The schema version only guarantees the tables can *store*
 * current shapes; it cannot tell whether the content was *extracted* by the
 * current extractor. Read-only surfaces must never repair either gap, so they
 * report: schema drift surfaces as needsMigration (the
 * GraphSchemaMigrationRequiredError), semantics drift surfaces as
 * needsReindex (this module, report-only).
 *
 * The stamp is written by `CodeGraph.indexAll()` on success, and by
 * `CodeGraph.sync()` only when the database was still empty before the sync
 * (that sync re-extracts every indexable file, so the guarantee is identical
 * to a full index — and it is the flow tool/MCP graph creation uses). An
 * incremental sync over existing content re-extracts only a content-changed
 * subset, so it must not (re)write the stamp: claiming "current" after a
 * partial sync would erase the reindex signal.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * project_metadata key holding the extraction-semantics stamp. The value is a
 * small JSON object (see ExtractionSemanticsStamp) so the stamping extractor's
 * package version travels with the semantics version for triage.
 */
export const EXTRACTION_SEMANTICS_METADATA_KEY = 'extraction_semantics_version';

/**
 * Version of the extractor's output form: what a file's stored
 * nodes/edges/fields look like when produced by the current binary.
 *
 * Bump this whenever previously-stored content becomes semantically stale
 * while remaining schema-valid, i.e. when only a full re-extraction
 * (`chimera graph index`) can bring an existing database up to date:
 *   - an extraction kernel route changes for a language (e.g. a language moves
 *     from the tree-sitter path to the Rust kernel, or back);
 *   - a pinned grammar version bump that changes parse/output shapes;
 *   - extraction or resolution field-semantics changes (how a symbol kind,
 *     edge kind, signature, or stored field value is derived from source).
 *
 * Division of labour with CURRENT_SCHEMA_VERSION (migrations.ts): the schema
 * version governs storage layout and old databases migrate *forward* on any
 * writable open (additive ALTERs repair storage without touching content).
 * The extraction semantics version governs content and is never "migrated" —
 * bumping it only flips the needsReindex signal until the next full index.
 * A change needing both bumps both, and the needsMigration posture wins on a
 * read-only surface (the stale-schema database fails open before content is
 * ever queried).
 */
// v2: wasm grammar alignment batch — 14 languages re-vendored to the
// kernel-pinned grammar revisions (src/graph/extraction/wasm/MANIFEST.md);
// node-kind table changes alter stored extraction output.
// v3: kernel first-wave routing — lua/luau move to the Rust kernel arm.
//     Byte-parity gate passed except acceptable non-byte diffs (kernel-side
//     docstring comment-marker normalization "-- x" -> "x" and lua's 1:1
//     calls-ref rename "(handler)" -> "handler"), which change stored field
//     values; see DEFAULT_ROUTED in src/graph/extraction/kernel/index.ts
//     for the decision rule (byte-identical routing = no bump).
// v4: kernel third-wave routing — kotlin/scala/dart move to the Rust kernel
//     arm after their walkers were re-aligned to the fork's pre-#708/#750/
//     #897 wasm oracles (21/21 corpus files byte-identical, losses and
//     enrichments both zero). Conservative bump under the route-change
//     clause above despite byte-parity: the per-language corpus is short
//     (<20 files — the in-repo ceiling) and the batch ships a re-built
//     kernel binary, so any out-of-corpus divergence must force a full
//     re-extraction instead of silently mixing kernel and wasm shapes in
//     one database. See DEFAULT_ROUTED (third-wave note) in
//     src/graph/extraction/kernel/index.ts.
export const EXTRACTION_SEMANTICS_VERSION = 4;

/** Decoded shape of the stamp row. */
export interface ExtractionSemanticsStamp {
  version: number;
  codegraphVersion: string | null;
}

/** Result of the read-only stamp check consumed by status surfaces. */
export interface ExtractionSemanticsStatus {
  /** True only when a stamp exists and differs from EXTRACTION_SEMANTICS_VERSION. */
  needsReindex: boolean;
  /** Version recorded in the database, or null when absent/unreadable (lenient). */
  storedVersion: number | null;
  /** The version this binary's extractor produces (EXTRACTION_SEMANTICS_VERSION). */
  currentVersion: number;
  /** codegraphVersion recorded alongside the stamp, or null when unknown. */
  storedCodegraphVersion: string | null;
}

/** Serialize the stamp this binary would write after a full index. */
export function encodeExtractionSemanticsStamp(codegraphVersion: string): string {
  return JSON.stringify({ version: EXTRACTION_SEMANTICS_VERSION, codegraphVersion });
}

function decodeExtractionSemanticsStamp(raw: string | null): ExtractionSemanticsStamp | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const stamp = parsed as Partial<ExtractionSemanticsStamp>;
  if (typeof stamp.version !== 'number' || !Number.isInteger(stamp.version) || stamp.version < 1) return null;
  return { version: stamp.version, codegraphVersion: typeof stamp.codegraphVersion === 'string' ? stamp.codegraphVersion : null };
}

/**
 * Read the extraction-semantics stamp and compare it against the current
 * extractor. Pure `SELECT`: safe on a read-only connection and it never
 * creates, stamps, or migrates anything — that is the whole point of this
 * signal existing on the read side.
 *
 * Lenient-by-decision: an absent or unparseable stamp (a database indexed
 * before this mechanism shipped, a pre-stamp backup restore, or a hand-edited
 * row) reports `needsReindex: false` with `storedVersion: null` rather than
 * warning. Treating absence as a signal would light needsReindex for every
 * existing user the moment this ships, and the next full index stamps the
 * database anyway; only a present-but-different version is real drift. A
 * mismatch is bidirectional (stored > current means the database was written
 * by a future extractor after a binary downgrade, which is equally stale for
 * this binary).
 */
export function checkExtractionSemantics(db: SqliteDatabase): ExtractionSemanticsStatus {
  const stamp = decodeExtractionSemanticsStamp(readStampRow(db));
  return {
    needsReindex: stamp !== null && stamp.version !== EXTRACTION_SEMANTICS_VERSION,
    storedVersion: stamp?.version ?? null,
    currentVersion: EXTRACTION_SEMANTICS_VERSION,
    storedCodegraphVersion: stamp?.codegraphVersion ?? null,
  };
}

function readStampRow(db: SqliteDatabase): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .get(EXTRACTION_SEMANTICS_METADATA_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    // project_metadata missing entirely (pre-v2 lineage reached without
    // migration) or an unreadable row: indistinguishable from unstamped, so
    // the lenient path above applies.
    return null;
  }
}
