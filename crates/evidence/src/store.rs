//! Versioned per-project evidence store: obligation state machine, oracle
//! results, mutation audit trail and one-time legacy import.
//!
//! The store is one SQLite database per project root
//! (`<project>/.chimera/evidence.db`) so swarm fan-out, prompt closeout and
//! audit surfaces all read the same single source of truth. Legacy
//! `obligations.json` / `oracle-results.jsonl` artifacts are imported once
//! through [`EvidenceStore::import_legacy`] and are never written by the
//! runtime afterwards.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Actor, EvidenceItem, EvidenceSource, OracleRecord, OracleStatus, OracleVerificationKind,
    Obligation, ObligationActor, ObligationIgnoreActor, ObligationResolveActor, ObligationSource,
    ObligationStatus, OracleLinkWindow, LIMIT_DEFAULT, LIMIT_MAX,
};

/// Directory name (under the project root) holding the evidence database.
pub const EVIDENCE_DIR: &str = ".chimera";
/// File name of the evidence database inside [`EVIDENCE_DIR`].
pub const EVIDENCE_DB_FILE: &str = "evidence.db";
/// Legacy obligation artifact file name (inside the same directory).
pub const LEGACY_OBLIGATIONS_FILE: &str = "obligations.json";
/// Legacy oracle results artifact file name (inside the same directory).
pub const LEGACY_ORACLE_RESULTS_FILE: &str = "oracle-results.jsonl";

/// `user_version` written after the last schema step.
const SCHEMA_VERSION: u32 = 1;

/// Result of a successful obligation state transition.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObligationTransition {
    /// The updated obligation record after the transition.
    pub obligation: Obligation,
    /// All obligations counts after the transition.
    pub counts: ObligationCounts,
}

/// Per-status obligation counts, as surfaced by `list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct ObligationCounts {
    /// Number of obligations in `pending` state.
    pub pending: u64,
    /// Number of obligations in `claimed` state.
    pub claimed: u64,
    /// Number of obligations in `stale` state.
    pub stale: u64,
    /// Number of obligations in `active` (pending+claimed+stale) set.
    pub active: u64,
    /// Number of obligations in `resolved` state.
    pub resolved: u64,
    /// Number of obligations in `ignored` state.
    pub ignored: u64,
}

/// Query parameters for [`EvidenceStore::list_obligations`].
#[derive(Debug, Clone, Default)]
pub struct ObligationQuery {
    /// Restrict to one status. `None` lists the active set
    /// (pending + claimed + stale), mirroring the Chimera semantics.
    pub status: Option<ObligationStatus>,
    /// Refresh stale marks before reading (see
    /// [`EvidenceStore::refresh_stale_obligations`]).
    pub refresh_stale: bool,
    /// Maximum number of results. Defaults to [`LIMIT_DEFAULT`], capped at
    /// [`LIMIT_MAX`].
    pub limit: Option<usize>,
}

impl ObligationQuery {
    fn effective_limit(&self) -> usize {
        clamp_limit(self.limit)
    }
}

/// Clamps an optional limit: absent → [`LIMIT_DEFAULT`], always within
/// 1..=[`LIMIT_MAX`].
#[must_use]
pub fn clamp_limit(limit: Option<usize>) -> usize {
    match limit {
        None => LIMIT_DEFAULT,
        Some(value) => value.clamp(1, LIMIT_MAX),
    }
}

/// Parameters for creating or syncing an obligation from an audit snapshot.
#[derive(Debug, Clone)]
pub struct ObligationSeed {
    /// Human-readable target the obligation points at (file, symbol, ref...).
    pub target: String,
    /// Why the obligation exists.
    pub reason: String,
    /// Free-form evidence pointer backing the obligation.
    pub evidence: String,
    /// Risk category label.
    pub risk: String,
    /// Optional classification label.
    pub classification: Option<String>,
    /// Optional change/provenance id the obligation was derived from.
    pub provenance_id: Option<String>,
    /// Files changed in the audit run that produced this obligation.
    pub changed_files: Vec<String>,
    /// Snapshot revision of the audit run.
    pub snapshot_revision: String,
}

/// Outcome of [`EvidenceStore::sync_obligations`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncOutcome {
    /// Obligations created by this sync.
    pub created: u64,
    /// Existing obligations whose audit-derived fields were refreshed.
    pub updated: u64,
    /// Counts after the sync.
    pub counts: ObligationCounts,
}

/// Query parameters for oracle result reads.
#[derive(Debug, Clone, Default)]
pub struct OracleQuery {
    /// Restrict to one oracle status. `None` keeps failing + unknown
    /// (the swarm evidence window).
    pub status: Option<OracleStatus>,
    /// Include passing oracles as well. When set, `status` filters still apply.
    pub include_passing: bool,
    /// Restrict to records produced by one session.
    pub session_id: Option<String>,
    /// Restrict to records finished at or before this RFC 3339 timestamp.
    pub finished_before: Option<String>,
    /// Maximum number of results (default 20, cap 100).
    pub limit: Option<usize>,
}

/// Parameters for recording a mutation audit event.
#[derive(Debug, Clone)]
pub struct MutationEvent {
    /// Stable id of the mutating tool call.
    pub tool_id: String,
    /// Actor session that owns the mutation, if attributed.
    pub actor: Option<Actor>,
    /// `success` or `failure` of the mutation.
    pub status: MutationStatus,
    /// Project-relative files the mutation touched.
    pub files: Vec<String>,
    /// Graph revision before the mutation.
    pub before_revision: String,
    /// Graph revision after the mutation.
    pub after_revision: String,
    /// Optional change id linking the mutation to a wider change group.
    pub change_id: Option<String>,
    /// Extra structured context retained verbatim.
    pub metadata: Option<Value>,
}

/// Status of a mutation audit event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationStatus {
    /// The mutation reported success.
    Success,
    /// The mutation reported failure.
    Failure,
}

impl MutationStatus {
    /// Stable wire string used in the database and JSON payloads.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            MutationStatus::Success => "success",
            MutationStatus::Failure => "failure",
        }
    }
}

/// A mutation audit event as persisted and returned to readers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MutationRecord {
    /// Stable id (same as the creating tool call id).
    pub id: String,
    /// Stable id of the mutating tool call.
    pub tool_id: String,
    /// Actor session that owns the mutation, if attributed.
    pub actor: Option<Actor>,
    /// `success` or `failure` of the mutation.
    pub status: MutationStatus,
    /// Project-relative files the mutation touched.
    pub files: Vec<String>,
    /// Graph revision before the mutation.
    pub before_revision: String,
    /// Graph revision after the mutation.
    pub after_revision: String,
    /// Optional change id linking the mutation to a wider change group.
    pub change_id: Option<String>,
    /// Extra structured context retained verbatim.
    pub metadata: Option<Value>,
    /// RFC 3339 timestamp of when the mutation finished.
    pub finished_at: String,
}

/// Parameters for recording an oracle result.
#[derive(Debug, Clone)]
pub struct OracleSeed {
    /// `shell` or `lsp`.
    pub kind: String,
    /// Pass/fail/unknown verdict.
    pub status: OracleStatus,
    /// Tool identity producing the result.
    pub tool_id: String,
    /// Actor of the tool run.
    pub actor: Actor,
    /// Verification classification; when omitted it is inferred from the
    /// payload (see [`OracleRecord::infer_verification`]).
    pub verification_kind: Option<OracleVerificationKind>,
    /// Whether the oracle verdict is trusted for commit gating.
    pub trusted: Option<bool>,
    /// Full structured payload. Stored verbatim: display truncation never
    /// rewrites the stored bytes.
    pub payload: Value,
}

/// Outcome of the one-time legacy import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    /// Legacy obligations imported (duplicates of existing ids are counted
    /// here as `skipped`).
    pub obligations_imported: u64,
    /// Legacy obligations skipped because the id already existed.
    pub obligations_skipped: u64,
    /// Legacy oracle results imported.
    pub oracles_imported: u64,
    /// Legacy oracle results skipped (id already existed).
    pub oracles_skipped: u64,
}

/// The per-project evidence store.
///
/// Open with [`EvidenceStore::open`] for a project root, or
/// [`EvidenceStore::open_at`] for an explicit database path. All mutating
/// operations run inside `BEGIN IMMEDIATE` transactions so concurrent store
/// clones and processes serialize on the SQLite write lock.
#[derive(Debug, Clone)]
pub struct EvidenceStore {
    project_root: PathBuf,
    db_path: PathBuf,
    conn: Arc<Mutex<Connection>>,
}

impl EvidenceStore {
    /// Open (or create) the evidence store for a project root, at
    /// `<root>/.chimera/evidence.db`.
    pub fn open(project_root: &Path) -> Result<Self> {
        let db_path = evidence_db_path(project_root);
        Self::open_at(project_root, &db_path)
    }

    /// Open (or create) the evidence store at an explicit database path.
    pub fn open_at(project_root: &Path, db_path: &Path) -> Result<Self> {
        let project_root = project_root.to_path_buf();
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create evidence dir {}", parent.display())
                })?;
            }
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("failed to open evidence db {}", db_path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .with_context(|| format!("failed to set busy_timeout for {}", db_path.display()))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .with_context(|| format!("failed to enable foreign keys for {}", db_path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            project_root,
            db_path: db_path.to_path_buf(),
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Filesystem path of the underlying database.
    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Project root this store was opened for.
    #[must_use]
    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| anyhow::anyhow!("evidence db connection mutex poisoned"))
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        let user_version: u32 = conn.query_row("PRAGMA user_version;", [], |row| row.get(0))?;
        if user_version == SCHEMA_VERSION {
            return Ok(());
        }
        if user_version > SCHEMA_VERSION {
            bail!(
                "evidence db at schema version {user_version} is newer than this build ({SCHEMA_VERSION}); upgrade the binary"
            );
        }
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let migrated = (|| {
            conn.execute_batch(SCHEMA_SQL)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            conn.execute_batch("COMMIT;")
                .context("failed to commit the evidence db schema migration")
        })();
        if migrated.is_err() {
            let _ = conn.execute_batch("ROLLBACK;");
        }
        migrated
    }

    // ------------------------------------------------------------------
    // Obligations: list / sync / claim / resolve / ignore
    // ------------------------------------------------------------------

    /// List obligations matching `query`, ordered by creation then id
    /// (oldest first, matching the Chimera store ordering).
    pub fn list_obligations(&self, query: &ObligationQuery) -> Result<Vec<Obligation>> {
        if query.refresh_stale {
            self.refresh_stale_obligations(None)?;
        }
        let limit = query.effective_limit();
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(
            r#"
            SELECT payload_json FROM obligation
            WHERE status = COALESCE(?1, status)
              AND (?1 IS NOT NULL OR status != 'resolved' AND status != 'ignored')
            ORDER BY created_at ASC, id ASC
            LIMIT ?2
            "#,
        )?;
        let status = query.status.map(|status| status.as_str());
        let rows = statement
            .query_map(params![status, limit as i64], row_payload::<Obligation>)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Counts of obligations per status.
    pub fn obligation_counts(&self) -> Result<ObligationCounts> {
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(
            "SELECT status, COUNT(*) FROM obligation GROUP BY status",
        )?;
        let mut counts = ObligationCounts::default();
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (status, count) in rows {
            let count = u64::try_from(count).unwrap_or(0);
            match status.as_str() {
                "pending" => counts.pending = count,
                "claimed" => counts.claimed = count,
                "stale" => counts.stale = count,
                "resolved" => counts.resolved = count,
                "ignored" => counts.ignored = count,
                _ => {}
            }
        }
        counts.active = counts.pending + counts.claimed + counts.stale;
        Ok(counts)
    }

    /// Sync (upsert) audit-derived obligations.
    ///
    /// New seeds are inserted as `pending` with a deterministic
    /// fingerprint-derived id. Existing ids keep their lifecycle fields
    /// (status, claim/resolve/ignore actors) and have their audit-derived
    /// fields refreshed. Duplicate seeds within one call collapse onto the
    /// same id.
    pub fn sync_obligations(&self, seeds: &[ObligationSeed]) -> Result<SyncOutcome> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut created: u64 = 0;
        let mut updated: u64 = 0;
        let mut seen = std::collections::HashSet::new();
        for seed in seeds {
            let obligation = obligation_from_seed(seed, &now);
            if !seen.insert(obligation.id.clone()) {
                continue;
            }
            let existing: Option<Obligation> = tx
                .query_row(
                    "SELECT payload_json FROM obligation WHERE id = ?1",
                    params![obligation.id],
                    row_payload::<Obligation>,
                )
                .optional()
                .with_context(|| format!("failed to load obligation {}", obligation.id))?;
            let was_existing = existing.is_some();
            let merged = match existing {
                Some(existing) => {
                    // Lifecycle fields (status, actors) survive; audit-derived
                    // fields are refreshed from the new seed.
                    let mut merged = obligation.clone();
                    merged.status = existing.status;
                    merged.claimed_by = existing.claimed_by;
                    merged.resolved_by = existing.resolved_by;
                    merged.ignored_by = existing.ignored_by;
                    merged.stale_reason = existing.stale_reason;
                    merged.created_at = existing.created_at;
                    merged
                }
                None => obligation.clone(),
            };
            let payload = serde_json::to_string(&merged)?;
            tx.execute(
                r#"
                INSERT INTO obligation (id, fingerprint, status, target, risk, classification,
                                        reason, evidence, payload_json, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(id) DO UPDATE SET
                    fingerprint = excluded.fingerprint,
                    status = excluded.status,
                    target = excluded.target,
                    risk = excluded.risk,
                    classification = excluded.classification,
                    reason = excluded.reason,
                    evidence = excluded.evidence,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                "#,
                params![
                    merged.id,
                    merged.fingerprint,
                    merged.status.as_str(),
                    merged.target,
                    merged.risk,
                    merged.classification,
                    merged.reason,
                    merged.evidence,
                    payload,
                    merged.created_at,
                    merged.updated_at,
                ],
            )?;
            if was_existing {
                updated += 1;
            } else {
                created += 1;
            }
        }
        let counts = counts_on(&tx)?;
        tx.commit()?;
        Ok(SyncOutcome {
            created,
            updated,
            counts,
        })
    }

    /// Claim a pending obligation for `actor`.
    ///
    /// Only the current owner may re-claim (idempotent); any other
    /// non-pending status or a foreign owner is an error. A `stale`
    /// obligation can be re-claimed: claiming it marks the audit data as
    /// being actively worked on.
    pub fn claim_obligation(
        &self,
        obligation_id: &str,
        actor: &Actor,
    ) -> Result<ObligationTransition> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_obligation(&tx, obligation_id)?;
        let allowed = match current.status {
            ObligationStatus::Pending => true,
            ObligationStatus::Claimed => current
                .claimed_by
                .as_ref()
                .is_some_and(|owner| owner.actor == *actor),
            ObligationStatus::Stale => true,
            ObligationStatus::Resolved | ObligationStatus::Ignored => false,
        };
        anyhow::ensure!(
            allowed,
            "obligation {} is {} and cannot be claimed",
            obligation_id,
            current.status.as_str()
        );
        let mut next = current.clone();
        next.status = ObligationStatus::Claimed;
        next.claimed_by = Some(ObligationActor {
            actor: actor.clone(),
            at: now.clone(),
        });
        // Claiming an obligation clears any stale mark: the audit data is
        // being actively worked on again.
        next.stale_reason = None;
        next.updated_at = now;
        write_obligation(&tx, &next)?;
        let counts = counts_on(&tx)?;
        tx.commit()?;
        Ok(ObligationTransition {
            obligation: next,
            counts,
        })
    }

    /// Resolve an obligation.
    ///
    /// The resolver must be the claim owner when the obligation is claimed;
    /// pending/stale obligations may be resolved by any actor (they were
    /// never exclusively owned).
    pub fn resolve_obligation(
        &self,
        obligation_id: &str,
        actor: &Actor,
        note: Option<&str>,
    ) -> Result<ObligationTransition> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_obligation(&tx, obligation_id)?;
        ensure_not_terminal(&current, "resolve")?;
        ensure_owner(&current, actor, "resolve")?;
        let mut next = current.clone();
        next.status = ObligationStatus::Resolved;
        next.resolved_by = Some(ObligationResolveActor {
            actor: actor.clone(),
            at: now.clone(),
            note: note.map(str::to_string),
        });
        next.updated_at = now;
        write_obligation(&tx, &next)?;
        let counts = counts_on(&tx)?;
        tx.commit()?;
        Ok(ObligationTransition {
            obligation: next,
            counts,
        })
    }

    /// Ignore an obligation with a mandatory reason.
    ///
    /// The ignoring actor must be the claim owner when the obligation is
    /// claimed.
    pub fn ignore_obligation(
        &self,
        obligation_id: &str,
        actor: &Actor,
        reason: &str,
        note: Option<&str>,
    ) -> Result<ObligationTransition> {
        anyhow::ensure!(
            !reason.trim().is_empty(),
            "ignoring an obligation requires a reason"
        );
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = load_obligation(&tx, obligation_id)?;
        ensure_not_terminal(&current, "ignore")?;
        ensure_owner(&current, actor, "ignore")?;
        let mut next = current.clone();
        next.status = ObligationStatus::Ignored;
        next.ignored_by = Some(ObligationIgnoreActor {
            actor: actor.clone(),
            at: now.clone(),
            reason: reason.to_string(),
            note: note.map(str::to_string),
        });
        next.updated_at = now;
        write_obligation(&tx, &next)?;
        let counts = counts_on(&tx)?;
        tx.commit()?;
        Ok(ObligationTransition {
            obligation: next,
            counts,
        })
    }

    /// Mark obligations whose target no longer resolves in the given
    /// `current_targets` set as `stale`, and clear the stale mark when the
    /// target is present again.
    ///
    /// `current_targets` is the set of live targets in the current graph
    /// index (e.g. all known codegraph node ids / file paths). When `None`
    /// no marks change; callers that cannot read the graph pass `None` and
    /// obligations keep their current lifecycle.
    pub fn refresh_stale_obligations(&self, current_targets: Option<&std::collections::HashSet<String>>) -> Result<u64> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows: Vec<Obligation> = {
            let mut statement = tx.prepare_cached(
                "SELECT payload_json FROM obligation ORDER BY created_at ASC, id ASC",
            )?;
            statement
                .query_map([], row_payload::<Obligation>)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut changed: u64 = 0;
        for item in rows {
            if matches!(
                item.status,
                ObligationStatus::Resolved | ObligationStatus::Ignored
            ) {
                continue;
            }
            let Some(live) = current_targets else {
                continue;
            };
            let target_present = live.contains(&item.target);
            let next = match (item.status, target_present) {
                (ObligationStatus::Stale, true) => Some(revive_obligation(item, &now)),
                (ObligationStatus::Pending | ObligationStatus::Claimed, false) => Some(
                    stale_obligation(item, "target no longer resolves in the current index", &now),
                ),
                _ => None,
            };
            if let Some(next) = next {
                write_obligation(&tx, &next)?;
                changed += 1;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Load one obligation by id.
    pub fn obligation(&self, obligation_id: &str) -> Result<Option<Obligation>> {
        let conn = self.conn()?;
        let mut statement =
            conn.prepare_cached("SELECT payload_json FROM obligation WHERE id = ?1")?;
        let row = statement
            .query_row(params![obligation_id], row_payload::<Obligation>)
            .optional()?;
        Ok(row)
    }

    // ------------------------------------------------------------------
    // Oracles: record / read / full output
    // ------------------------------------------------------------------

    /// Record an oracle result. The id is deterministic over
    /// `(finished_at, payload)` so re-recording the same result is
    /// idempotent; linked changes are resolved from the mutation audit
    /// trail over the same-session preceding-mutation window.
    pub fn record_oracle(&self, seed: OracleSeed) -> Result<OracleRecord> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = oracle_from_seed(seed, &now);
        let linked = self.linked_changes_on(&tx, &record)?;
        let mut record = record;
        record.linked_changes = linked;
        let payload = serde_json::to_string(&record)?;
        tx.execute(
            r#"
            INSERT INTO oracle_result (id, kind, status, tool_id, session_id,
                                       verification_kind, trusted, finished_at, payload_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                payload_json = excluded.payload_json,
                finished_at = excluded.finished_at,
                status = excluded.status,
                verification_kind = excluded.verification_kind,
                trusted = excluded.trusted
            "#,
            params![
                record.id,
                record.kind,
                record.status.as_str(),
                record.tool_id,
                record.actor.session_id,
                record.verification_kind.as_str(),
                record.trusted,
                record.finished_at,
                payload,
            ],
        )?;
        tx.commit()?;
        Ok(record)
    }

    /// Query oracle results (default: failing + unknown, newest first).
    pub fn list_oracles(&self, query: &OracleQuery) -> Result<Vec<OracleRecord>> {
        let limit = clamp_limit(query.limit);
        let statuses: Vec<&str> = match query.status {
            Some(OracleStatus::Pass) => vec!["pass"],
            Some(OracleStatus::Fail) => vec!["fail"],
            Some(OracleStatus::Unknown) => vec!["unknown"],
            None if query.include_passing => vec!["pass", "fail", "unknown"],
            None => vec!["fail", "unknown"],
        };
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(
            r#"
            SELECT payload_json FROM oracle_result
            WHERE status IN (SELECT json_each.value FROM json_each(?1))
              AND (?2 IS NULL OR session_id = ?2)
              AND (?3 IS NULL OR finished_at <= ?3)
            ORDER BY finished_at DESC, id DESC
            LIMIT ?4
            "#,
        )?;
        let statuses_json = serde_json::to_string(&statuses)?;
        let rows = statement
            .query_map(
                params![
                    statuses_json,
                    query.session_id,
                    query.finished_before,
                    limit as i64
                ],
                row_payload::<OracleRecord>,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Fetch one oracle record with the full, untruncated output.
    pub fn oracle(&self, oracle_id: &str) -> Result<Option<OracleRecord>> {
        let conn = self.conn()?;
        let mut statement =
            conn.prepare_cached("SELECT payload_json FROM oracle_result WHERE id = ?1")?;
        let row = statement
            .query_row(params![oracle_id], row_payload::<OracleRecord>)
            .optional()?;
        Ok(row)
    }

    /// Mutations that finished at or before `finished_at` in the same
    /// session, oldest-first, at most `limit` (the "wide window" backing
    /// oracle linked changes).
    pub fn linked_mutations(
        &self,
        session_id: &str,
        finished_at: &str,
        limit: usize,
    ) -> Result<Vec<MutationRecord>> {
        let limit = clamp_limit(Some(limit));
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(
            r#"
            SELECT payload_json FROM mutation_event
            WHERE session_id = ?1 AND finished_at <= ?2
            ORDER BY finished_at ASC, id ASC
            LIMIT ?3
            "#,
        )?;
        let rows = statement
            .query_map(params![session_id, finished_at, limit as i64], row_payload::<MutationRecord>)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ------------------------------------------------------------------
    // Mutation audit
    // ------------------------------------------------------------------

    /// Record a mutation audit event. Re-inserting the same `tool_id`
    /// replaces the event (audit stays keyed by the tool call).
    pub fn record_mutation(&self, event: MutationEvent) -> Result<MutationRecord> {
        let now = now_iso();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let record = mutation_from_event(event, &now);
        let payload = serde_json::to_string(&record)?;
        tx.execute(
            r#"
            INSERT INTO mutation_event (id, tool_id, session_id, status, finished_at, payload_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                tool_id = excluded.tool_id,
                session_id = excluded.session_id,
                status = excluded.status,
                finished_at = excluded.finished_at,
                payload_json = excluded.payload_json
            "#,
            params![
                record.id,
                record.tool_id,
                record.actor.as_ref().map(|actor| &actor.session_id),
                record.status.as_str(),
                record.finished_at,
                payload,
            ],
        )?;
        tx.commit()?;
        Ok(record)
    }

    /// Read the mutation audit trail, newest first.
    pub fn list_mutations(&self, limit: Option<usize>) -> Result<Vec<MutationRecord>> {
        let limit = clamp_limit(limit);
        let conn = self.conn()?;
        let mut statement = conn.prepare_cached(
            "SELECT payload_json FROM mutation_event ORDER BY finished_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![limit as i64], row_payload::<MutationRecord>)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ------------------------------------------------------------------
    // Swarm source materialization
    // ------------------------------------------------------------------

    /// Materialize one of the seven swarm evidence sources.
    ///
    /// `limit` defaults to 20 and is capped at 100. Long oracle shell
    /// outputs are truncated for display only; the stored evidence keeps
    /// the full output and [`EvidenceStore::oracle`] returns it untouched.
    /// Missing store or no matches yields an empty vector — callers turn
    /// that into an explicit "no work input" error, never a fake item.
    pub fn swarm_source(
        &self,
        source: EvidenceSource,
        limit: Option<usize>,
    ) -> Result<Vec<EvidenceItem>> {
        let limit = clamp_limit(limit);
        match source {
            EvidenceSource::PendingObligations
            | EvidenceSource::ClaimedObligations
            | EvidenceSource::StaleObligations
            | EvidenceSource::ActiveObligations => {
                let status = match source {
                    EvidenceSource::PendingObligations => Some(ObligationStatus::Pending),
                    EvidenceSource::ClaimedObligations => Some(ObligationStatus::Claimed),
                    EvidenceSource::StaleObligations => Some(ObligationStatus::Stale),
                    EvidenceSource::ActiveObligations => None,
                    _ => None,
                };
                let obligations = self.list_obligations(&ObligationQuery {
                    status,
                    refresh_stale: false,
                    limit: Some(limit),
                })?;
                Ok(obligations
                    .into_iter()
                    .map(|obligation| EvidenceItem::Obligation(Box::new(obligation)))
                    .collect())
            }
            EvidenceSource::FailingOracles
            | EvidenceSource::UnknownOracles
            | EvidenceSource::FailingOrUnknownOracles => {
                let status = match source {
                    EvidenceSource::FailingOracles => Some(OracleStatus::Fail),
                    EvidenceSource::UnknownOracles => Some(OracleStatus::Unknown),
                    EvidenceSource::FailingOrUnknownOracles => None,
                    _ => None,
                };
                let records = self.list_oracles(&OracleQuery {
                    status,
                    include_passing: false,
                    session_id: None,
                    finished_before: None,
                    limit: Some(limit),
                })?;
                Ok(records
                    .into_iter()
                    .map(EvidenceItem::Oracle)
                    .collect())
            }
        }
    }

    // ------------------------------------------------------------------
    // One-time legacy import
    // ------------------------------------------------------------------

    /// Import legacy `obligations.json` and `oracle-results.jsonl` once.
    ///
    /// Reads the files next to the database (`<dir>/obligations.json`,
    /// `<dir>/oracle-results.jsonl` — the same `.chimera` directory the
    /// Chimera artifact layout used). The files are only read, never
    /// written, and no runtime path re-reads them: after this call the
    /// SQLite store is the only truth. Records whose id already exists are
    /// skipped so the import is idempotent.
    pub fn import_legacy(&self) -> Result<ImportReport> {
        let dir = self
            .db_path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let obligations_path = dir.join(LEGACY_OBLIGATIONS_FILE);
        let oracles_path = dir.join(LEGACY_ORACLE_RESULTS_FILE);
        let mut report = ImportReport {
            obligations_imported: 0,
            obligations_skipped: 0,
            oracles_imported: 0,
            oracles_skipped: 0,
        };
        if obligations_path.is_file() {
            let text = fs::read_to_string(&obligations_path).with_context(|| {
                format!("failed to read legacy obligations {}", obligations_path.display())
            })?;
            let imported = self.import_legacy_obligations(&text)?;
            report.obligations_imported = imported.0;
            report.obligations_skipped = imported.1;
        }
        if oracles_path.is_file() {
            let text = fs::read_to_string(&oracles_path).with_context(|| {
                format!("failed to read legacy oracle results {}", oracles_path.display())
            })?;
            let imported = self.import_legacy_oracles(&text)?;
            report.oracles_imported = imported.0;
            report.oracles_skipped = imported.1;
        }
        Ok(report)
    }

    fn import_legacy_obligations(&self, text: &str) -> Result<(u64, u64)> {
        let parsed: ObligationLegacyFile = serde_json::from_str(text)
            .with_context(|| "legacy obligations.json is not the expected store shape")?;
        let conn = self.conn()?;
        let mut imported: u64 = 0;
        let mut skipped: u64 = 0;
        for item in parsed.obligations {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM obligation WHERE id = ?1)",
                    params![item.id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if exists {
                skipped += 1;
                continue;
            }
            let payload = serde_json::to_string(&item)?;
            conn.execute(
                r#"
                INSERT INTO obligation (id, fingerprint, status, target, risk, classification,
                                        reason, evidence, payload_json, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
                params![
                    item.id,
                    item.fingerprint,
                    item.status.as_str(),
                    item.target,
                    item.risk,
                    item.classification,
                    item.reason,
                    item.evidence,
                    payload,
                    item.created_at,
                    item.updated_at,
                ],
            )?;
            imported += 1;
        }
        Ok((imported, skipped))
    }

    fn import_legacy_oracles(&self, text: &str) -> Result<(u64, u64)> {
        let conn = self.conn()?;
        let mut imported: u64 = 0;
        let mut skipped: u64 = 0;
        for (line_no, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let record: OracleRecord = match serde_json::from_str(line) {
                Ok(record) => record,
                Err(error) => {
                    return Err(anyhow::anyhow!(
                        "legacy oracle-results.jsonl line {} is not a valid record: {error}",
                        line_no + 1
                    ))
                }
            };
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM oracle_result WHERE id = ?1)",
                    params![record.id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if exists {
                skipped += 1;
                continue;
            }
            let payload = serde_json::to_string(&record)?;
            conn.execute(
                r#"
                INSERT INTO oracle_result (id, kind, status, tool_id, session_id,
                                           verification_kind, trusted, finished_at, payload_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    record.id,
                    record.kind,
                    record.status.as_str(),
                    record.tool_id,
                    record.actor.session_id,
                    record.verification_kind.as_str(),
                    record.trusted,
                    record.finished_at,
                    payload,
                ],
            )?;
            imported += 1;
        }
        Ok((imported, skipped))
    }

    /// Resolve the oracle link window from the mutation audit trail.
    fn linked_changes_on(
        &self,
        tx: &rusqlite::Transaction<'_>,
        record: &OracleRecord,
    ) -> Result<Vec<crate::OracleLinkedChange>> {
        let mut statement = tx.prepare_cached(
            r#"
            SELECT payload_json FROM mutation_event
            WHERE session_id = ?1 AND finished_at <= ?2
            ORDER BY finished_at ASC, id ASC
            LIMIT ?3
            "#,
        )?;
        let rows: Vec<MutationRecord> = statement
            .query_map(
                params![
                    record.actor.session_id,
                    record.finished_at,
                    record.link_window.max_changes as i64
                ],
                row_payload::<MutationRecord>,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|mutation| crate::OracleLinkedChange {
                id: mutation.id,
                tool_id: mutation.tool_id,
                status: mutation.status,
                finished_at: mutation.finished_at,
                before_revision: mutation.before_revision,
                after_revision: mutation.after_revision,
                files: mutation.files,
                change_id: mutation.change_id,
            })
            .collect())
    }
}

/// Compute the evidence database path for a project root.
#[must_use]
pub fn evidence_db_path(project_root: &Path) -> PathBuf {
    project_root.join(EVIDENCE_DIR).join(EVIDENCE_DB_FILE)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn row_payload<T: for<'de> Deserialize<'de>>(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<T> {
    let payload: String = row.get(0)?;
    serde_json::from_str(&payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn counts_on(tx: &rusqlite::Transaction<'_>) -> Result<ObligationCounts> {
    let mut statement = tx.prepare_cached("SELECT status, COUNT(*) FROM obligation GROUP BY status")?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut counts = ObligationCounts::default();
    for (status, count) in rows {
        let count = u64::try_from(count).unwrap_or(0);
        match status.as_str() {
            "pending" => counts.pending = count,
            "claimed" => counts.claimed = count,
            "stale" => counts.stale = count,
            "resolved" => counts.resolved = count,
            "ignored" => counts.ignored = count,
            _ => {}
        }
    }
    counts.active = counts.pending + counts.claimed + counts.stale;
    Ok(counts)
}

fn load_obligation(tx: &rusqlite::Transaction<'_>, obligation_id: &str) -> Result<Obligation> {
    let mut statement = tx.prepare_cached("SELECT payload_json FROM obligation WHERE id = ?1")?;
    let record = statement
        .query_row(params![obligation_id], row_payload::<Obligation>)
        .optional()
        .with_context(|| format!("failed to load obligation {obligation_id}"))?;
    anyhow::ensure!(
        record.is_some(),
        "unknown Chimera obligation: {obligation_id}"
    );
    Ok(record.expect("checked above"))
}

fn ensure_owner(obligation: &Obligation, actor: &Actor, action: &str) -> Result<()> {
    if obligation.status == ObligationStatus::Claimed {
        let owned = obligation
            .claimed_by
            .as_ref()
            .is_some_and(|owner| owner.actor == *actor);
        anyhow::ensure!(
            owned,
            "obligation {} is claimed by {} and cannot be {}d by {}",
            obligation.id,
            obligation
                .claimed_by
                .as_ref()
                .map(|owner| owner.actor.session_id.as_str())
                .unwrap_or("another actor"),
            action,
            actor.session_id
        );
    }
    Ok(())
}

fn ensure_not_terminal(obligation: &Obligation, action: &str) -> Result<()> {
    anyhow::ensure!(
        !matches!(
            obligation.status,
            ObligationStatus::Resolved | ObligationStatus::Ignored
        ),
        "obligation {} is {} and cannot be {}d",
        obligation.id,
        obligation.status.as_str(),
        action
    );
    Ok(())
}

fn write_obligation(tx: &rusqlite::Transaction<'_>, obligation: &Obligation) -> Result<()> {
    let payload = serde_json::to_string(obligation)?;
    tx.execute(
        r#"
        UPDATE obligation
        SET status = ?1, payload_json = ?2, updated_at = ?3
        WHERE id = ?4
        "#,
        params![
            obligation.status.as_str(),
            payload,
            obligation.updated_at,
            obligation.id
        ],
    )?;
    Ok(())
}

fn stale_obligation(mut item: Obligation, reason: &str, now: &str) -> Obligation {
    item.status = ObligationStatus::Stale;
    item.stale_reason = Some(reason.to_string());
    item.updated_at = now.to_string();
    item
}

fn revive_obligation(mut item: Obligation, now: &str) -> Obligation {
    // Reviving an obligation returns it to the state it had before it went
    // stale: a claim that still has an owner stays claimed, everything else
    // goes back to pending.
    item.status = if item.claimed_by.is_some() {
        ObligationStatus::Claimed
    } else {
        ObligationStatus::Pending
    };
    item.stale_reason = None;
    item.updated_at = now.to_string();
    item
}

fn obligation_from_seed(seed: &ObligationSeed, now: &str) -> Obligation {
    let fingerprint = obligation_fingerprint(seed);
    Obligation {
        schema_version: 1,
        id: format!("obl_{}", &fingerprint[..16]),
        fingerprint: fingerprint.clone(),
        status: ObligationStatus::Pending,
        target: seed.target.clone(),
        reason: seed.reason.clone(),
        risk: seed.risk.clone(),
        classification: seed.classification.clone(),
        evidence: seed.evidence.clone(),
        source: ObligationSource {
            provenance_id: seed.provenance_id.clone(),
            changed_files: seed.changed_files.clone(),
            snapshot_revision: seed.snapshot_revision.clone(),
        },
        created_at: now.to_string(),
        updated_at: now.to_string(),
        claimed_by: None,
        resolved_by: None,
        ignored_by: None,
        stale_reason: None,
    }
}

fn obligation_fingerprint(seed: &ObligationSeed) -> String {
    use sha2::{Digest, Sha256};
    let material = json!({
        "provenance": seed.provenance_id,
        "changed_files": seed.changed_files,
        "target": seed.target,
        "evidence": seed.evidence,
        "reason": seed.reason,
    });
    let canonical = serde_json::to_string(&material).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn oracle_from_seed(seed: OracleSeed, now: &str) -> OracleRecord {
    let payload_json = serde_json::to_string(&seed.payload).unwrap_or_else(|_| "null".into());
    let id = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(now.as_bytes());
        hasher.update(b":");
        hasher.update(payload_json.as_bytes());
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(digest.len() * 2);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
        }
        format!("oracle_{}", &hex[..16])
    };
    let verification = OracleRecord::infer_verification(
        &seed.kind,
        &seed.payload,
        seed.verification_kind,
    );
    let trusted = seed.trusted.unwrap_or(verification.trusted);
    OracleRecord {
        schema_version: 1,
        id,
        kind: seed.kind,
        status: seed.status,
        tool_id: seed.tool_id,
        actor: seed.actor,
        verification_kind: verification.kind,
        trusted,
        finished_at: now.to_string(),
        payload: seed.payload,
        link_window: OracleLinkWindow {
            max_changes: LIMIT_DEFAULT,
        },
        linked_changes: Vec::new(),
    }
}

fn mutation_from_event(event: MutationEvent, now: &str) -> MutationRecord {
    MutationRecord {
        id: event.tool_id.clone(),
        tool_id: event.tool_id,
        actor: event.actor,
        status: event.status,
        files: event.files,
        before_revision: event.before_revision,
        after_revision: event.after_revision,
        change_id: event.change_id,
        metadata: event.metadata,
        finished_at: now.to_string(),
    }
}

#[derive(Deserialize)]
struct ObligationLegacyFile {
    #[serde(default)]
    #[allow(dead_code)] // schema version is validated only by shape compatibility
    schema_version: Option<u64>,
    #[serde(default)]
    obligations: Vec<Obligation>,
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS obligation (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','claimed','stale','resolved','ignored')),
    target TEXT NOT NULL,
    risk TEXT NOT NULL,
    classification TEXT,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS obligation_status_idx ON obligation(status);
CREATE INDEX IF NOT EXISTS obligation_updated_at_idx ON obligation(updated_at);

CREATE TABLE IF NOT EXISTS oracle_result (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pass','fail','unknown')),
    tool_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    verification_kind TEXT NOT NULL,
    trusted INTEGER NOT NULL,
    finished_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oracle_result_status_idx ON oracle_result(status);
CREATE INDEX IF NOT EXISTS oracle_result_session_finished_idx ON oracle_result(session_id, finished_at);
CREATE INDEX IF NOT EXISTS oracle_result_tool_idx ON oracle_result(tool_id);

CREATE TABLE IF NOT EXISTS mutation_event (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mutation_event_session_finished_idx ON mutation_event(session_id, finished_at);
"#;
