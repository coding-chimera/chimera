/**
 * Synthesis staging overlay (fork port of upstream db/synthesis-stage.ts,
 * #1988/#2033).
 *
 * An incremental sync that changes a synthesis input must REPLACE the whole
 * owned-edge set, not merely add to it: a registration that moved or vanished
 * leaves an obsolete dispatch edge no additive pass ever removes. Recomputing
 * every pass against the live database would let the passes read their own
 * previous output (and each other's stale edges), so the refresh runs against
 * this private overlay instead:
 *
 *   - a TEMP `edges` VIEW shadows the real table: passes see every ORDINARY
 *     base edge plus the edges staged so far, never a previously synthesized
 *     edge — the same clean base a full index computes against, which is what
 *     makes sync converge to a rebuild;
 *   - an INSTEAD OF INSERT trigger routes the passes' insertEdges into the
 *     TEMP `synthesis_edges` table (identity-deduped exactly like the real
 *     table's idx_edges_identity) without ever shadowing an existing base
 *     edge;
 *   - `publish()` atomically swaps the owned set in ONE immediate transaction
 *     on this second connection: delete every owned edge from main, insert
 *     the staged set, replace synthesis_inputs. A failure (or a crash) rolls
 *     back to the OLD synthesized edges; the sync's `synthesis_pending`
 *     marker stays set and the next sync retries.
 *
 * Fork adaptations vs upstream: publish is synchronous (the fork's
 * synthesizeCallbackEdges has no yielding/backpressure path, and the whole
 * replacement is one bounded pair of set-based statements), and the stage
 * connection is a plain TS db-layer connection — synthesis writes never route
 * through the R3 store bridge (the bridge covers the extraction-phase write
 * path only). Concurrency: refreshSynthesis runs inside CodeGraph's
 * fileLock/indexMutex sync window, so BEGIN IMMEDIATE only arbitrates against
 * foreign processes (busy_timeout 5s, same as every other fork connection).
 */
import { createDatabase, type SqliteDatabase } from './sqlite-adapter';
import { QueryBuilder } from './queries';

// Ownership is independent of provenance: a structural synthesized edge may
// carry no provenance stamp. CASE short-circuits malformed metadata JSON so a
// broken row can never throw inside the overlay view/trigger or the publish
// DELETE (upstream #2038).
export const SYNTHESIZED_EDGE = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.synthesizedBy') END IS NOT NULL";

/** A private edge overlay: passes see base edges plus their own new edges. */
export class SynthesisStage {
  readonly db: SqliteDatabase;
  readonly queries: QueryBuilder;

  constructor(dbPath: string) {
    this.db = createDatabase(dbPath).db;
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL');
      // Staging writes are TEMP-only; the publish transaction folds into the
      // main WAL and the owning sync's runMaintenance/checkpoint handles it —
      // never auto-checkpoint mid-publish from this side connection.
      this.db.pragma('wal_autocheckpoint = 0');
      this.db.exec(`
        CREATE TEMP TABLE synthesis_inputs (file_path TEXT PRIMARY KEY);
        CREATE TEMP TABLE synthesis_edges (
          id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT,
          metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
        );
        CREATE UNIQUE INDEX temp.synthesis_identity ON synthesis_edges
          (source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
        CREATE INDEX temp.synthesis_source ON synthesis_edges(source, kind);
        CREATE INDEX temp.synthesis_target ON synthesis_edges(target, kind);
        CREATE TEMP VIEW edges AS
          SELECT * FROM main.edges WHERE NOT COALESCE((${SYNTHESIZED_EDGE}), 0)
          UNION ALL SELECT * FROM synthesis_edges;
        CREATE TEMP TRIGGER synthesis_insert INSTEAD OF INSERT ON edges BEGIN
          INSERT OR IGNORE INTO synthesis_edges
            (source, target, kind, metadata, line, col, provenance)
          SELECT NEW.source, NEW.target, NEW.kind, NEW.metadata, NEW.line, NEW.col, NEW.provenance
          WHERE NOT EXISTS (
            SELECT 1 FROM main.edges WHERE source = NEW.source AND target = NEW.target
              AND kind = NEW.kind AND IFNULL(line, -1) = IFNULL(NEW.line, -1)
              AND IFNULL(col, -1) = IFNULL(NEW.col, -1)
              AND NOT COALESCE((${SYNTHESIZED_EDGE}), 0)
          );
        END;
      `);
      // No store bridge on the stage connection: every write stays on the TS
      // arm against the overlay (see the fork-adaptation note above).
      this.queries = new QueryBuilder(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Atomically replace the owned-edge set and the synthesis-input gate set.
   * Other connections see either the old set or the new one, never a gap;
   * any failure rolls back to the old set (the caller keeps
   * `synthesis_pending` armed for a retry).
   */
  publish(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`DELETE FROM main.edges WHERE ${SYNTHESIZED_EDGE}`);
      this.db.exec(`
        INSERT OR IGNORE INTO main.edges
          (source, target, kind, metadata, line, col, provenance)
        SELECT source, target, kind, metadata, line, col, provenance
        FROM temp.synthesis_edges
      `);
      this.db.exec(`
        DELETE FROM main.synthesis_inputs;
        INSERT INTO main.synthesis_inputs(file_path) SELECT file_path FROM temp.synthesis_inputs
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
