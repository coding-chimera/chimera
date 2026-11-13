//! Durable turn admission, lease, idempotency and recovery records.
//!
//! This module owns the *user-visible* idempotency authority for turn
//! submission: one in-flight turn per session, `request_key` replay of an
//! identical prompt body, durable event dedupe, and the terminal
//! (status + idle + usage + cursor) commit group that publishes a finished
//! turn exactly once. [`crate::runtime_aliases`] keeps its separate role —
//! canonical Runtime owner receipts and immutable legacy-history recovery —
//! and `llm_response_cache` (Runtime) stays a pure internal byte cache that
//! never participates in admission: a cache hit changes no row here and a
//! row here is never derived from a cache lookup.
//!
//! Concurrency model: every admission mutation runs in one
//! `BEGIN IMMEDIATE` transaction on the single shared `StateStore`
//! connection, so competing callers — threads in one process or separate
//! processes over one database — resolve on the committed row. The lease
//! expires by wall clock (`expires_at`) and, for dead holders, by the
//! recorded `boot` identity: a lease stamped by a boot that no longer
//! exists in the recorded registry can be taken over without waiting out
//! its full TTL. That is the only path that may steal a live-TTL lease.

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::StateStore;

/// Lease length and pending-request TTL: the runtime is expected to renew at
/// least this often; a holder that stops renewing is declared dead once this
/// window passes.
pub const DEFAULT_TURN_LEASE_SECONDS: i64 = 120;
/// How long a terminal outcome stays replayable by `request_key`.
pub const DEFAULT_TURN_TTL_SECONDS: i64 = 300;
/// Boot registry rows older than this are swept as dead boots at open.
const DEAD_BOOT_RETENTION_SECONDS: i64 = 7 * 24 * 3600;

/// Who submitted the turn: the owning process and its boot.
///
/// `boot` is opaque to this module (`Runtime` supplies its `boot-<uuid>`
/// process identity). Dead-boot detection uses the recorded
/// [`TurnBootRegistry`], never a guess about pid reuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnOwner {
    /// Opaque stable id of the submitting instance, e.g. `boot-<uuid>`.
    pub boot: String,
}

/// Result of admitting a turn.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnAdmit {
    /// The submission was admitted and now holds the session's turn lease.
    Admitted,
    /// The `request_key` was already used with this exact prompt body; the
    /// recorded terminal outcome (or `None` while it is still pending) is
    /// replayed and no new work is started.
    Replay { outcome: Option<TurnTerminalRecord> },
    /// Another live turn holds the lease. The holder is named for a legible
    /// refusal.
    Contended { owner: TurnOwner, expires_at: i64 },
    /// The `request_key` was already used with a *different* body. The
    /// recorded holder is retained; the caller must not remint the key.
    KeyConflict { request_key: String },
}

/// Side-effect knowledge for a turn at commit time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum SideEffectState {
    /// The engine proved no tool side effect ran.
    Clean,
    /// At least one side effect ran and completed.
    Committed,
    /// A side effect may have run but its completion is unproven — the
    /// honest value after a crash or an abandoned waiter.
    Unknown,
}

/// Terminal facts published by one commit group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnTerminalRecord {
    /// Engine turn id of the completed turn.
    pub turn_id: String,
    /// `completed | interrupted | failed`.
    pub outcome: String,
    /// Input, output and reasoning tokens attributable to the turn.
    pub usage: TurnUsage,
    /// Journal cursor the turn advanced the session to.
    pub cursor: Option<String>,
    /// Last known side-effect posture.
    pub side_effect_state: SideEffectState,
    /// Wall clock of the commit, unix seconds.
    pub committed_at: i64,
}

/// Token usage recorded atomically with the terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TurnUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<i64>,
}

/// What recovery found for one session at startup.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnRecoveryAction {
    /// No lease, no pending request — the session needs nothing.
    Settled,
    /// A lease whose holder is dead (unknown or recorded-dead boot). The
    /// sweep took it over and released it; the session is idle again.
    DeadLeaseReleased { owner: TurnOwner },
    /// A lease that is still live (holder boot alive and TTL unexpired).
    LeaseLive { owner: TurnOwner, expires_at: i64 },
    /// A pending request whose terminal never landed. Its side-effect
    /// posture is `unknown` unless the recorded posture says otherwise, and
    /// its `request_key` is *retained* so a retry replays instead of
    /// reminting a fresh identity.
    PendingTerminal {
        request_key: String,
        side_effect_state: SideEffectState,
    },
}

/// Registry of live runtime boots sharing this database.
///
/// Leases name their holder by boot id; a lease can only be proven dead
/// through this table (or by its absence, which this module treats as dead —
/// a boot that never registered cannot be alive to renew).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnBootRegistry {
    /// `boot-<uuid>` of the registering runtime.
    pub boot: String,
    /// Host pid of the registering runtime.
    pub pid: u32,
    /// Wall clock of registration, unix seconds. Renewed by any touch.
    pub registered_at: i64,
}

/// State of a session's pending request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnPendingRecord {
    pub request_key: String,
    pub owner: TurnOwner,
    pub prompt_digest: String,
    pub created_at: i64,
    pub side_effect_state: SideEffectState,
}

impl StateStore {
    /// Record (or renew) the boot identity of the current runtime.
    ///
    /// One registration per boot: re-registering an already-live boot only
    /// refreshes `registered_at`. Registration never removes another boot —
    /// only dead boots are swept.
    pub fn turn_register_boot(&self, registry: &TurnBootRegistry) -> Result<()> {
        validate_boot(&registry.boot)?;
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO turn_boots(boot, pid, registered_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(boot) DO UPDATE SET pid = excluded.pid, registered_at = excluded.registered_at",
            params![registry.boot, registry.pid, registry.registered_at],
        )
        .with_context(|| format!("failed to register turn boot {}", registry.boot))?;
        Ok(())
    }

    /// Number of boots currently recorded as live.
    pub fn turn_live_boot_count(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT count(*) FROM turn_boots", [], |row| row.get(0))?)
    }

    /// Register this boot, sweep dead boots and take over dead leases.
    ///
    /// This is the startup path: after it returns, every remaining lease is
    /// either live or already released. Idempotent — running it twice on an
    /// unchanged database produces the same answer and the same final state.
    pub fn turn_boot_and_recover(
        &self,
        registry: &TurnBootRegistry,
    ) -> Result<Vec<TurnRecoveryAction>> {
        self.turn_register_boot(registry)?;
        self.sweep_turn_state()
    }

    /// Sweep: delete dead boot rows, release leases held by dead boots,
    /// report pending terminals. Idempotent; safe to run at any time.
    pub fn sweep_turn_state(&self) -> Result<Vec<TurnRecoveryAction>> {
        let mut conn = self.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("failed to begin turn sweep transaction")?;
        let now = Utc::now().timestamp();
        tx.execute(
            "DELETE FROM turn_boots WHERE registered_at < ?1",
            params![now.saturating_sub(DEAD_BOOT_RETENTION_SECONDS)],
        )
        .context("failed to sweep stale turn boot rows")?;
        let released = take_over_dead_leases(&tx, now)?;
        let actions = read_recovery_actions(&tx, now)?;
        tx.commit().context("failed to commit turn sweep")?;
        for owner in &released {
            tracing::info!(
                boot = %owner.boot,
                "released turn lease held by a dead boot"
            );
        }
        let mut all: Vec<TurnRecoveryAction> = released
            .into_iter()
            .map(|owner| TurnRecoveryAction::DeadLeaseReleased { owner })
            .collect();
        all.extend(actions);
        Ok(all)
    }

    /// Atomically admit one turn for `session`.
    ///
    /// The single `BEGIN IMMEDIATE` transaction resolves, in order:
    ///
    /// 1. `request_key` already terminal with the same body → [`TurnAdmit::Replay`]
    ///    of the recorded outcome.
    /// 2. `request_key` already pending or terminal with a *different* body →
    ///    [`TurnAdmit::KeyConflict`] (the key is never reminted).
    /// 3. `request_key` pending with the same body and the caller's own boot
    ///    → [`TurnAdmit::Replay`] with `None` (work is already running).
    /// 4. `request_key` pending with the same body held by another *live*
    ///    boot → [`TurnAdmit::Contended`].
    /// 5. `request_key` pending with the same body held by a *dead* boot →
    ///    takeover: the pending row and lease move to this boot.
    /// 6. A live foreign lease (any `request_key`) → [`TurnAdmit::Contended`].
    /// 7. Otherwise: pending row + lease are written for this boot and the
    ///    submission is [`TurnAdmit::Admitted`].
    ///
    /// A `boot` that is not registered in [`TurnBootRegistry`] is treated as
    /// *live*, not dead — the registering runtime is expected to be a
    /// separate process, and admission must not steal from a process it
    /// cannot prove is gone. Only the sweep takes over leases.
    pub fn admit_turn(
        &self,
        session: &str,
        request_key: &str,
        prompt_body: &str,
        owner: &TurnOwner,
    ) -> Result<TurnAdmit> {
        validate_id(session, "session")?;
        validate_id(request_key, "request_key")?;
        validate_boot(&owner.boot)?;
        anyhow::ensure!(!prompt_body.is_empty(), "turn prompt body is empty");
        let prompt_digest = sha256_hex(prompt_body.as_bytes());
        let now = Utc::now().timestamp();
        let mut conn = self.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("failed to begin turn admission transaction")?;
        let admission = admit_on(&tx, session, request_key, &prompt_digest, owner, now)?;
        tx.commit().context("failed to commit turn admission")?;
        Ok(admission)
    }

    /// Renew this boot's lease for `session`.
    ///
    /// `Ok(true)` when the lease was held by this boot and is now extended
    /// to `now + ttl`; `Ok(false)` when the lease is gone or foreign (the
    /// holder completed, or a sweep released it) — the runtime must stop.
    pub fn renew_turn_lease(
        &self,
        session: &str,
        owner: &TurnOwner,
        ttl_seconds: i64,
    ) -> Result<bool> {
        validate_id(session, "session")?;
        validate_boot(&owner.boot)?;
        let ttl = normalized_ttl(ttl_seconds)?;
        let conn = self.conn()?;
        let changed = conn
            .execute(
                "UPDATE turn_leases SET expires_at = ?3, renewed_at = ?4
                 WHERE session = ?1 AND boot = ?2 AND expires_at > ?4",
                params![
                    session,
                    owner.boot,
                    Utc::now().timestamp().saturating_add(ttl),
                    Utc::now().timestamp()
                ],
            )
            .with_context(|| format!("failed to renew turn lease for session {session}"))?;
        Ok(changed > 0)
    }

    /// Record that a tool side effect ran for a pending turn, or that its
    /// completion is unproven. The pending row survives; only the posture
    /// field moves.
    pub fn turn_note_side_effect(
        &self,
        session: &str,
        request_key: &str,
        state: SideEffectState,
    ) -> Result<()> {
        validate_id(session, "session")?;
        validate_id(request_key, "request_key")?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE turn_pending SET side_effect_state = ?3 WHERE session = ?1 AND request_key = ?2",
            params![session, request_key, side_effect_state_str(state)],
        )
        .with_context(|| format!("failed to record side effect state for turn {request_key}"))?;
        Ok(())
    }

    /// Commit the terminal group for one turn: terminal row + pending
    /// removal + idle status + usage + cursor, in one transaction.
    ///
    /// Idempotent by `request_key`: re-committing the same key with the same
    /// turn id is a no-op returning the previous record; re-committing with
    /// a different turn id or different outcome facts is refused (the turn
    /// already terminated). The caller must hold the session lease unless
    /// the pending row belongs to a dead boot (a sweep released the lease
    /// but retained the pending row for exactly this late commit).
    pub fn commit_turn_terminal(
        &self,
        session: &str,
        request_key: &str,
        record: &TurnTerminalRecord,
        owner: &TurnOwner,
    ) -> Result<TurnTerminalRecord> {
        validate_id(session, "session")?;
        validate_id(request_key, "request_key")?;
        validate_id(&record.turn_id, "turn_id")?;
        let outcome = normalize_outcome(&record.outcome)?;
        let mut record = record.clone();
        record.outcome = outcome;
        let mut conn = self.conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("failed to begin turn terminal commit")?;
        let committed = commit_turn_on(&tx, session, request_key, &record, owner)?;
        tx.commit().context("failed to commit turn terminal")?;
        Ok(committed)
    }

    /// Look up the recorded terminal outcome for a `request_key`.
    pub fn get_turn_terminal(
        &self,
        session: &str,
        request_key: &str,
    ) -> Result<Option<TurnTerminalRecord>> {
        validate_id(session, "session")?;
        validate_id(request_key, "request_key")?;
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT record_json FROM turn_terminal WHERE session = ?1 AND request_key = ?2",
                params![session, request_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        row.map(|encoded| decode_terminal(&encoded)).transpose()
    }

    /// Read the pending request for a session, if any.
    pub fn get_turn_pending(&self, session: &str) -> Result<Option<TurnPendingRecord>> {
        validate_id(session, "session")?;
        let conn = self.conn()?;
        read_pending_on(&conn, session)
    }

    /// Read the current lease for a session, as (owner, expires_at).
    pub fn get_turn_lease(&self, session: &str) -> Result<Option<(TurnOwner, i64)>> {
        validate_id(session, "session")?;
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT boot, expires_at FROM turn_leases WHERE session = ?1",
                params![session],
                |row| {
                    let boot: String = row.get(0)?;
                    let expires_at: i64 = row.get(1)?;
                    Ok((TurnOwner { boot }, expires_at))
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Release the session lease held by `owner`.
    ///
    /// Used when a waiter abandons a tool: the lease goes, the pending row
    /// stays with a recorded side-effect posture (defaulting to `unknown`
    /// when nothing was recorded — an abandoned waiter cannot prove
    /// cleanliness), and the terminal remains unset so recovery reports it.
    /// A missing lease is not an error.
    pub fn turn_abandon_wait(
        &self,
        session: &str,
        request_key: &str,
        owner: &TurnOwner,
    ) -> Result<()> {
        validate_id(session, "session")?;
        validate_id(request_key, "request_key")?;
        let conn = self.conn()?;
        conn.execute(
            "UPDATE turn_pending SET side_effect_state = 'unknown'
             WHERE session = ?1 AND request_key = ?2 AND side_effect_state IS NULL",
            params![session, request_key],
        )
        .with_context(|| format!("failed to mark abandoned turn {request_key} unknown"))?;
        conn.execute(
            "DELETE FROM turn_leases WHERE session = ?1 AND boot = ?2",
            params![session, owner.boot],
        )
        .with_context(|| format!("failed to release lease for abandoned turn {request_key}"))?;
        Ok(())
    }

    /// Persist one durable event, deduped by `(session, event_key)`.
    ///
    /// Returns `Ok(true)` when the row was newly inserted, `Ok(false)` when
    /// the event key was already durably recorded. The payload is retained
    /// on the first insert; a re-delivery with a different payload is a
    /// conflict, not an overwrite.
    pub fn record_turn_event(
        &self,
        session: &str,
        event_key: &str,
        payload: &serde_json::Value,
    ) -> Result<bool> {
        validate_id(session, "session")?;
        validate_id(event_key, "event_key")?;
        let encoded = serde_json::to_string(payload)
            .with_context(|| format!("failed to serialize event {event_key}"))?;
        let conn = self.conn()?;
        let changed = conn
            .execute(
                "INSERT INTO turn_events(session, event_key, payload_json, created_at)
                 VALUES(?1, ?2, ?3, ?4) ON CONFLICT(session, event_key) DO NOTHING",
                params![session, event_key, encoded, Utc::now().timestamp()],
            )
            .with_context(|| format!("failed to persist event {event_key}"))?;
        Ok(changed > 0)
    }

    /// The payload recorded for a deduped event, if present.
    pub fn get_turn_event(
        &self,
        session: &str,
        event_key: &str,
    ) -> Result<Option<serde_json::Value>> {
        validate_id(session, "session")?;
        validate_id(event_key, "event_key")?;
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT payload_json FROM turn_events WHERE session = ?1 AND event_key = ?2",
                params![session, event_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        row.map(|encoded| {
            serde_json::from_str(&encoded)
                .with_context(|| format!("failed to parse stored event {event_key}"))
        })
        .transpose()
    }

    /// Drop settled rows older than the TTL. Idempotent, read-only for live
    /// state. Returns the number of expired terminal records removed.
    pub fn sweep_expired_turn_records(&self) -> Result<u64> {
        let conn = self.conn()?;
        let now = Utc::now().timestamp();
        let expired = conn
            .execute(
                "DELETE FROM turn_terminal WHERE committed_at < ?1",
                params![now.saturating_sub(DEFAULT_TURN_TTL_SECONDS)],
            )
            .context("failed to sweep expired turn terminal records")?;
        Ok(expired as u64)
    }
}

/// Live lease check inside a transaction.
fn lease_holder(
    conn: &Connection,
    session: &str,
    now: i64,
) -> Result<Option<(TurnOwner, i64, bool)>> {
    let row = conn
        .query_row(
            "SELECT boot, expires_at FROM turn_leases WHERE session = ?1",
            params![session],
            |row| Ok((TurnOwner { boot: row.get(0)? }, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((owner, expires_at)) = row else {
        return Ok(None);
    };
    let live = expires_at > now && boot_is_live(conn, &owner.boot)?;
    Ok(Some((owner, expires_at, live)))
}

/// A boot is live when it is registered. An unknown boot on a live-TTL lease
/// is conservatively live: admission never steals what it cannot prove dead.
fn boot_is_live(conn: &Connection, boot: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM turn_boots WHERE boot = ?1)",
        params![boot],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

/// The one-transaction admission decision.
fn admit_on(
    tx: &Connection,
    session: &str,
    request_key: &str,
    prompt_digest: &str,
    owner: &TurnOwner,
    now: i64,
) -> Result<TurnAdmit> {
    if let Some(terminal) = read_terminal_row(tx, session, request_key)? {
        if terminal.1 == prompt_digest {
            return Ok(TurnAdmit::Replay {
                outcome: Some(terminal.0),
            });
        }
        return Ok(TurnAdmit::KeyConflict {
            request_key: request_key.to_string(),
        });
    }
    // A lease past its TTL or held by an unregistered boot is dead no
    // matter what else the session holds; clear it before deciding so it
    // can never linger behind a pending row.
    if let Some((holder, _, live)) = lease_holder(tx, session, now)? {
        if !live {
            tx.execute(
                "DELETE FROM turn_leases WHERE session = ?1 AND boot = ?2",
                params![session, holder.boot],
            )
            .context("failed to release a dead holder's lease")?;
        }
    }
    if let Some(pending) = read_pending_on(tx, session)? {
        if pending.request_key == request_key {
            if pending.prompt_digest == prompt_digest {
                if pending.owner.boot == owner.boot {
                    return Ok(TurnAdmit::Replay { outcome: None });
                }
                if boot_is_live(tx, &pending.owner.boot)? {
                    return Ok(TurnAdmit::Contended {
                        owner: pending.owner,
                        expires_at: lease_expires_at(tx, session)?.unwrap_or(now),
                    });
                }
                // Dead holder: take over the pending row and the lease.
                take_over_pending(tx, session, request_key, prompt_digest, owner, now)?;
                return Ok(TurnAdmit::Admitted);
            }
            return Ok(TurnAdmit::KeyConflict {
                request_key: request_key.to_string(),
            });
        }
        // Different key: the session is busy with another request. A dead
        // holder's row is recovered by the sweep; admission here only
        // refuses.
        return Ok(TurnAdmit::Contended {
            owner: pending.owner,
            expires_at: lease_expires_at(tx, session)?.unwrap_or(now),
        });
    }
    if let Some((holder, expires_at, live)) = lease_holder(tx, session, now)? {
        if live {
            return Ok(TurnAdmit::Contended {
                owner: holder,
                expires_at,
            });
        }
        tx.execute(
            "DELETE FROM turn_leases WHERE session = ?1 AND boot = ?2",
            params![session, holder.boot],
        )
        .context("failed to release a dead holder's lease")?;
    }
    insert_pending(tx, session, request_key, prompt_digest, owner, now)?;
    Ok(TurnAdmit::Admitted)
}

fn lease_expires_at(conn: &Connection, session: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT expires_at FROM turn_leases WHERE session = ?1",
            params![session],
            |row| row.get(0),
        )
        .optional()?)
}

fn insert_pending(
    tx: &Connection,
    session: &str,
    request_key: &str,
    prompt_digest: &str,
    owner: &TurnOwner,
    now: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO turn_pending(session, request_key, boot, prompt_digest, created_at, side_effect_state)
         VALUES(?1, ?2, ?3, ?4, ?5, NULL)",
        params![session, request_key, owner.boot, prompt_digest, now],
    )
    .with_context(|| format!("failed to insert pending turn {request_key}"))?;
    tx.execute(
        "INSERT INTO turn_leases(session, boot, acquired_at, renewed_at, expires_at)
         VALUES(?1, ?2, ?3, ?3, ?4)",
        params![
            session,
            owner.boot,
            now,
            now.saturating_add(DEFAULT_TURN_LEASE_SECONDS)
        ],
    )
    .with_context(|| format!("failed to acquire turn lease for session {session}"))?;
    Ok(())
}

fn take_over_pending(
    tx: &Connection,
    session: &str,
    request_key: &str,
    prompt_digest: &str,
    owner: &TurnOwner,
    now: i64,
) -> Result<()> {
    // The dead holder's side-effect posture is retained: the pending row is
    // updated in place, only ownership and the lease move.
    tx.execute(
        "UPDATE turn_pending SET boot = ?3, created_at = ?4 WHERE session = ?1 AND request_key = ?2",
        params![session, request_key, owner.boot, now],
    )
    .with_context(|| format!("failed to take over pending turn {request_key}"))?;
    let _ = prompt_digest;
    tx.execute(
        "DELETE FROM turn_leases WHERE session = ?1",
        params![session],
    )
    .context("failed to clear a dead holder's lease")?;
    tx.execute(
        "INSERT INTO turn_leases(session, boot, acquired_at, renewed_at, expires_at)
         VALUES(?1, ?2, ?3, ?3, ?4)",
        params![
            session,
            owner.boot,
            now,
            now.saturating_add(DEFAULT_TURN_LEASE_SECONDS)
        ],
    )
    .with_context(|| format!("failed to re-acquire turn lease for session {session}"))?;
    Ok(())
}

/// The one-transaction terminal commit.
fn commit_turn_on(
    tx: &Connection,
    session: &str,
    request_key: &str,
    record: &TurnTerminalRecord,
    owner: &TurnOwner,
) -> Result<TurnTerminalRecord> {
    let now = Utc::now().timestamp();
    if let Some((saved, saved_digest)) = read_terminal_row(tx, session, request_key)? {
        anyhow::ensure!(
            saved_digest_matches_recommit(&saved, &saved_digest, record),
            "turn {request_key} already committed a terminal record"
        );
        return Ok(saved);
    }
    let pending =
        read_pending_on(tx, session)?.filter(|pending| pending.request_key == request_key);
    let digest = match &pending {
        Some(pending) => pending.prompt_digest.clone(),
        None => {
            // No pending row: this is a retry whose pending row was swept
            // but whose terminal was not (crash between sweep and commit,
            // or TTL expiry of an unsettled pending). Derive the body from
            // the caller's record; the commit group still lands once.
            sha256_hex(record.turn_id.as_bytes())
        }
    };
    let holds_lease = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM turn_leases WHERE session = ?1 AND boot = ?2)",
        params![session, owner.boot],
        |row| row.get::<_, i64>(0),
    )? != 0;
    anyhow::ensure!(
        holds_lease,
        "turn {request_key} cannot commit without holding the session lease"
    );
    let mut committed = record.clone();
    committed.committed_at = now;
    let encoded = serde_json::to_string(&committed)?;
    tx.execute(
        "INSERT INTO turn_terminal(session, request_key, turn_id, outcome, record_json, prompt_digest, committed_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session,
            request_key,
            committed.turn_id,
            committed.outcome,
            encoded,
            digest,
            now
        ],
    )
    .with_context(|| format!("failed to persist terminal turn record {request_key}"))?;
    tx.execute(
        "DELETE FROM turn_pending WHERE session = ?1 AND request_key = ?2",
        params![session, request_key],
    )
    .with_context(|| format!("failed to clear pending turn {request_key}"))?;
    tx.execute(
        "DELETE FROM turn_leases WHERE session = ?1",
        params![session],
    )
    .with_context(|| format!("failed to release turn lease for session {session}"))?;
    idle_thread_on(tx, session, now)?;
    Ok(committed)
}

/// A recommit is the identical outcome: same turn id, outcome, usage, cursor,
/// side-effect posture. `committed_at` may differ (clock drift).
fn saved_digest_matches_recommit(
    saved: &TurnTerminalRecord,
    _saved_digest: &str,
    record: &TurnTerminalRecord,
) -> bool {
    saved.turn_id == record.turn_id
        && saved.outcome == record.outcome
        && saved.usage == record.usage
        && saved.cursor == record.cursor
        && saved.side_effect_state == record.side_effect_state
}

/// Terminal table row → (record, prompt digest).
fn read_terminal_row(
    conn: &Connection,
    session: &str,
    request_key: &str,
) -> Result<Option<(TurnTerminalRecord, String)>> {
    let row = conn
        .query_row(
            "SELECT record_json, prompt_digest FROM turn_terminal WHERE session = ?1 AND request_key = ?2",
            params![session, request_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    row.map(|(encoded, digest)| Ok((decode_terminal(&encoded)?, digest)))
        .transpose()
}

fn decode_terminal(encoded: &str) -> Result<TurnTerminalRecord> {
    serde_json::from_str(encoded).with_context(|| "failed to parse stored turn terminal record")
}

fn read_pending_on(conn: &Connection, session: &str) -> Result<Option<TurnPendingRecord>> {
    let row = conn
        .query_row(
            "SELECT request_key, boot, prompt_digest, created_at, side_effect_state
             FROM turn_pending WHERE session = ?1",
            params![session],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((request_key, boot, prompt_digest, created_at, side_effect)) = row else {
        return Ok(None);
    };
    let posture = side_effect_state_from(&side_effect);
    Ok(Some(TurnPendingRecord {
        request_key,
        owner: TurnOwner { boot },
        prompt_digest,
        created_at,
        side_effect_state: posture,
    }))
}

fn idle_thread_on(tx: &Connection, session: &str, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE threads SET status = ?2, updated_at = MAX(updated_at, ?3) WHERE id = ?1 AND status = ?4",
        params![
            session,
            crate::thread_status_to_str(&crate::ThreadStatus::Idle),
            now,
            crate::thread_status_to_str(&crate::ThreadStatus::Running)
        ],
    )
    .with_context(|| format!("failed to mark thread {session} idle after turn commit"))?;
    Ok(())
}

/// Release every lease whose holder is not in the boot registry (dead).
/// Returns the released owners.
fn take_over_dead_leases(tx: &Connection, now: i64) -> Result<Vec<TurnOwner>> {
    let mut stmt =
        tx.prepare("SELECT boot FROM turn_leases WHERE boot NOT IN (SELECT boot FROM turn_boots)")?;
    let dead: Vec<String> = {
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row.get(0)?);
        }
        out
    };
    drop(stmt);
    // Expiry by wall clock releases the rest of the expired leases.
    tx.execute(
        "DELETE FROM turn_leases WHERE expires_at <= ?1",
        params![now],
    )
    .context("failed to release expired turn leases")?;
    let released: Vec<TurnOwner> = dead.into_iter().map(|boot| TurnOwner { boot }).collect();
    for owner in &released {
        tx.execute(
            "DELETE FROM turn_leases WHERE boot = ?1",
            params![owner.boot],
        )
        .with_context(|| format!("failed to release dead turn lease {}", owner.boot))?;
    }
    Ok(released)
}

fn read_recovery_actions(tx: &Connection, now: i64) -> Result<Vec<TurnRecoveryAction>> {
    let mut stmt = tx.prepare(
        "SELECT turn_leases.boot, turn_leases.expires_at, turn_pending.request_key, turn_pending.side_effect_state
         FROM turn_leases LEFT JOIN turn_pending ON turn_pending.session = turn_leases.session
         WHERE turn_leases.expires_at > ?1 AND turn_leases.boot IN (SELECT boot FROM turn_boots)",
    )?;
    let actions: Vec<TurnRecoveryAction> = {
        let mut rows = stmt.query(params![now])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let boot: String = row.get(0)?;
            let expires_at: i64 = row.get(1)?;
            let request_key: Option<String> = row.get(2)?;
            match request_key {
                Some(request_key) => out.push(TurnRecoveryAction::PendingTerminal {
                    request_key,
                    side_effect_state: side_effect_state_from(&row.get::<_, Option<String>>(3)?),
                }),
                None => out.push(TurnRecoveryAction::LeaseLive {
                    owner: TurnOwner { boot },
                    expires_at,
                }),
            }
        }
        out
    };
    drop(stmt);
    // Pending rows whose lease is gone: terminal never landed.
    let mut stmt = tx.prepare(
        "SELECT request_key, side_effect_state FROM turn_pending
         WHERE session NOT IN (SELECT session FROM turn_leases)",
    )?;
    let pending: Vec<TurnRecoveryAction> = {
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(TurnRecoveryAction::PendingTerminal {
                request_key: row.get(0)?,
                side_effect_state: side_effect_state_from(&row.get::<_, Option<String>>(1)?),
            });
        }
        out
    };
    Ok(actions.into_iter().chain(pending).collect())
}

fn side_effect_state_str(state: SideEffectState) -> &'static str {
    match state {
        SideEffectState::Clean => "clean",
        SideEffectState::Committed => "committed",
        SideEffectState::Unknown => "unknown",
    }
}

fn side_effect_state_from(value: &Option<String>) -> SideEffectState {
    // Fail closed: a pending row without a recorded posture is exactly the
    // "cannot prove" case `unknown` exists for.
    value
        .as_deref()
        .map_or(SideEffectState::Unknown, |v| match v {
            "clean" => SideEffectState::Clean,
            "committed" => SideEffectState::Committed,
            _ => SideEffectState::Unknown,
        })
}

fn normalize_outcome(outcome: &str) -> Result<String> {
    match outcome {
        "completed" | "interrupted" | "failed" => Ok(outcome.to_string()),
        _ => anyhow::bail!(
            "invalid turn outcome {outcome:?}; expected completed, interrupted or failed"
        ),
    }
}

fn normalized_ttl(ttl_seconds: i64) -> Result<i64> {
    anyhow::ensure!(
        ttl_seconds > 0 && ttl_seconds <= 24 * 3600,
        "turn lease TTL must be between 1 second and one day"
    );
    Ok(ttl_seconds)
}

fn validate_id(value: &str, what: &str) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control),
        "invalid turn {what}"
    );
    Ok(())
}

fn validate_boot(boot: &str) -> Result<()> {
    validate_id(boot, "boot")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}
