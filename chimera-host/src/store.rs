//! Durable host-control store (H1).
//!
//! Owns the six host-written tables defined by
//! `packages/chimera/src/storage/tables/host.sql.ts` and specified in
//! `packages/chimera/specs/rust-host/recovery-matrix.md` §8:
//!
//! - `host_worker` (§8.1) — worker registry, generation fencing, heartbeat
//! - `host_state` (§8.2) — generation / sequence counters, schema preflight
//! - `session_turn_checkpoint` (§8.3) — turn intent and commit confirmation
//! - `pending_request` (§8.4) — permission / question requests
//! - `request_idempotency` (§8.6) — retryable entry-point idempotency
//! - `host_event` (§8.5) — durable event log / SSE cursor
//!
//! Two boundaries are load-bearing:
//!
//! - **The store never migrates.** The TS-side Drizzle migration is the only
//!   creator of these tables (§9.1); this layer only opens and writes.
//! - **The host is the only writer of these tables** (§5.4). The Bun worker
//!   keeps writing session/message/part and must not write here.
//!
//! All SQL uses bound parameters. Every fallible operation reports
//! [`StoreError`].

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::fmt;
use std::path::Path;

use crate::supervisor::{ExitReason, WorkerRecord, WorkerStatus};

/// Failure from a durable store operation.
#[derive(Debug)]
pub enum StoreError {
    /// The underlying SQLite call failed.
    Sqlite(rusqlite::Error),
    /// The addressed row does not exist.
    NotFound {
        /// Table that was addressed.
        table: &'static str,
        /// Primary key of the missing row.
        key: String,
    },
    /// The same idempotency key was reused with a different request body
    /// (§8.6, `idempotency_conflict`).
    IdempotencyConflict {
        /// Idempotency scope.
        scope: String,
        /// Idempotency key.
        key: String,
    },
    /// A reply addressed a pending-request generation that is no longer
    /// current (§8.4).
    StaleGeneration {
        /// Request addressed by the caller.
        request_id: String,
        /// Generation carried by the reply.
        expected: i64,
        /// Generation currently recorded.
        found: i64,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(error) => write!(f, "sqlite error: {error}"),
            StoreError::NotFound { table, key } => {
                write!(f, "no {table} row for key {key}")
            }
            StoreError::IdempotencyConflict { scope, key } => write!(
                f,
                "idempotency key {key} in scope {scope} was reused with a different request body"
            ),
            StoreError::StaleGeneration {
                request_id,
                expected,
                found,
            } => write!(
                f,
                "pending request {request_id} generation {expected} is stale (current {found})"
            ),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}

/// One `host_worker` row (§8.1).
///
/// [`HostWorker::from_supervisor`] maps the supervisor's in-memory
/// [`WorkerRecord`] plus the spawn facts the supervisor does not track
/// (`boot_id`, process identity, protocol version, capabilities).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostWorker {
    /// Host-assigned worker id (ULID in production).
    pub worker_id: String,
    /// Workspace this worker belongs to.
    pub workspace_id: String,
    /// Monotonic fencing generation per workspace.
    pub generation: i64,
    /// Host process identity (`boot_<start-ms>_<pid>`).
    pub boot_id: String,
    /// Worker process id.
    pub pid: i64,
    /// Worker process group id, when known.
    pub pgid: Option<i64>,
    /// Lifecycle state.
    pub status: WorkerStatus,
    /// Negotiated wire protocol version.
    pub protocol_version: String,
    /// Capabilities JSON.
    pub capabilities: String,
    /// Spawn time.
    pub started_at: i64,
    /// Last heartbeat time.
    pub heartbeat_at: Option<i64>,
    /// Time drain was requested, while draining.
    pub drain_requested_at: Option<i64>,
    /// Time the worker reached a terminal state.
    pub exited_at: Option<i64>,
    /// Why the worker reached a terminal state.
    pub exit_reason: Option<ExitReason>,
    /// Last recorded error, if any.
    pub last_error: Option<String>,
    /// Row creation time.
    pub time_created: i64,
    /// Last row update time.
    pub time_updated: i64,
}

impl HostWorker {
    /// Build a durable row from a supervisor record plus the host-owned spawn
    /// facts. `created_at_ms` becomes both `started_at` and `time_created`,
    /// and the last status transition becomes `time_updated`.
    pub fn from_supervisor(
        record: &WorkerRecord,
        boot_id: impl Into<String>,
        pid: i64,
        pgid: Option<i64>,
        protocol_version: impl Into<String>,
        capabilities: impl Into<String>,
    ) -> Self {
        Self {
            worker_id: record.worker_id.to_string(),
            workspace_id: record.workspace_id.clone(),
            generation: record.generation as i64,
            boot_id: boot_id.into(),
            pid,
            pgid,
            status: record.status,
            protocol_version: protocol_version.into(),
            capabilities: capabilities.into(),
            started_at: record.created_at_ms as i64,
            heartbeat_at: Some(record.last_heartbeat_ms as i64),
            drain_requested_at: (record.status == WorkerStatus::Draining)
                .then_some(record.last_transition_ms as i64),
            exited_at: record.exited_at_ms.map(|value| value as i64),
            exit_reason: record.exit_reason,
            last_error: None,
            time_created: record.created_at_ms as i64,
            time_updated: record.last_transition_ms as i64,
        }
    }
}

/// One `host_state` row (§8.2): generation and sequence counters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostState {
    /// `global` or a workspace id.
    pub scope: String,
    /// Schema version this host expects.
    pub schema_version: i64,
    /// Host generation; only increases.
    pub host_generation: i64,
    /// Next worker generation to hand out.
    pub next_worker_generation: i64,
    /// Next durable event sequence.
    pub next_event_seq: i64,
    /// Host process identity that last wrote the row.
    pub boot_id: Option<String>,
    /// Last update time.
    pub updated_at: i64,
}

/// One `session_turn_checkpoint` row (§8.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnCheckpoint {
    /// Session owning the turn.
    pub session_id: String,
    /// Turn id, unique within the session.
    pub turn_id: String,
    /// Per-session turn order.
    pub turn_seq: i64,
    /// Turn generation (canonical name `turn_generation`).
    pub generation: i64,
    /// Worker currently executing the turn.
    pub worker_id: Option<String>,
    /// Worker generation currently executing the turn.
    pub worker_generation: Option<i64>,
    /// `accepted|running|waiting_permission|waiting_question|waiting_tool|cancelling|cancelled|completed|failed|interrupted`.
    pub status: String,
    /// `uncommitted|committed_unconfirmed|confirmed`.
    pub commit_state: String,
    /// Idempotency key for worker commit confirmation.
    pub commit_token: Option<String>,
    /// `worker_confirmed|recovered_confirmation|host_derived`.
    pub completion_source: Option<String>,
    /// `worker|cancel|crash_sweep|recovery`.
    pub terminal_source: Option<String>,
    /// Bounded intent JSON (prompt/agent/model/part refs).
    pub intent: String,
    /// `none|retry_safe|manual`.
    pub resume_policy: String,
    /// `none|committed|unknown`.
    pub side_effect_state: String,
    /// Last committed message id.
    pub last_message_id: Option<String>,
    /// Last durable event sequence for this turn.
    pub last_event_seq: Option<i64>,
    /// Time cancellation was requested.
    pub cancel_requested_at: Option<i64>,
    /// Terminal error text.
    pub error: Option<String>,
    /// Row creation time.
    pub created_at: i64,
    /// Last update time.
    pub updated_at: i64,
}

/// One `pending_request` row (§8.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRequest {
    /// Stable for the request lifetime; republishing keeps it.
    pub request_id: String,
    /// Host idempotency key (`kind:turn_id:tool_call_id` or `kind:turn_id:ask_seq`).
    pub request_key: String,
    /// `permission|question`.
    pub kind: String,
    /// Session waiting on the request.
    pub session_id: String,
    /// Turn waiting on the request.
    pub turn_id: Option<String>,
    /// Worker that published the request.
    pub worker_id: Option<String>,
    /// Worker generation of the current publish.
    pub worker_generation: Option<i64>,
    /// Tool call id, when the request belongs to one.
    pub tool_call_id: Option<String>,
    /// `pending|answered|rejected|expired|orphaned`.
    pub status: String,
    /// Request payload JSON.
    pub payload: String,
    /// Answer JSON, once resolved.
    pub answer: Option<String>,
    /// Republish attempt generation, starting at 1.
    pub generation: i64,
    /// Expiry time.
    pub expires_at: Option<i64>,
    /// Row creation time.
    pub created_at: i64,
    /// Last update time.
    pub updated_at: i64,
}

/// One `request_idempotency` row (§8.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdempotencyRecord {
    /// `workspace|session|instance`.
    pub scope: String,
    /// Caller-supplied idempotency key.
    pub idempotency_key: String,
    /// Hash of the request body; guards same key with a different body.
    pub request_hash: String,
    /// `prompt|job.start|permission.reply|...`.
    pub operation: String,
    /// `in_flight|completed|failed`.
    pub status: String,
    /// `turn_id|job_id|request_id` of the first result.
    pub response_ref: Option<String>,
    /// Serialized first result.
    pub response_body: Option<String>,
    /// Diagnostics only; never a write gate.
    pub generation: Option<i64>,
    /// Visibility owner for `job.start`.
    pub owner_session_id: Option<String>,
    /// Row creation time.
    pub created_at: i64,
    /// Expiry time.
    pub expires_at: i64,
}

/// A durable event to append to `host_event` (§8.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewHostEvent {
    /// Stable event id.
    pub event_id: String,
    /// Idempotency key, e.g. `turn:<turn_id>:completed`.
    pub dedupe_key: String,
    /// Workspace the event belongs to.
    pub workspace_id: Option<String>,
    /// Project the event belongs to.
    pub project_id: Option<String>,
    /// Session/job/worker id.
    pub aggregate_id: String,
    /// Per-aggregate durable order, when the event is ordered.
    pub aggregate_seq: Option<i64>,
    /// Event type.
    pub event_type: String,
    /// Worker that produced the event.
    pub worker_id: Option<String>,
    /// Worker generation that produced the event.
    pub worker_generation: Option<i64>,
    /// Event payload JSON.
    pub payload: String,
    /// Event time.
    pub created_at: i64,
}

/// Result of [`HostStore::append_event`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendedEvent {
    /// Durable cursor assigned to the event (existing seq when deduped).
    pub seq: i64,
    /// Whether the `dedupe_key` already existed and no new row was written.
    pub deduped: bool,
}

/// Durable host-control store.
pub struct HostStore {
    conn: Connection,
}

impl HostStore {
    /// Open the shared main database at `path`.
    ///
    /// The schema must already exist: the store never migrates or creates
    /// tables.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::configure(Connection::open(path)?)
    }

    /// Open an in-memory database (tests). Callers create the schema.
    pub fn open_memory() -> Result<Self, StoreError> {
        Self::configure(Connection::open_in_memory()?)
    }

    /// Apply the connection parameters used by `src/storage/db.ts` so the host
    /// and the Bun worker agree on journaling and lock behaviour.
    fn configure(conn: Connection) -> Result<Self, StoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(Self { conn })
    }

    /// Insert or replace a worker row, keyed by `worker_id`.
    ///
    /// `time_created` is preserved on update; every other column is refreshed.
    pub fn upsert_worker(&self, worker: &HostWorker) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO host_worker (
                worker_id, workspace_id, generation, boot_id, pid, pgid, status,
                protocol_version, capabilities, started_at, heartbeat_at,
                drain_requested_at, exited_at, exit_reason, last_error,
                time_created, time_updated
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
             )
             ON CONFLICT(worker_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                generation = excluded.generation,
                boot_id = excluded.boot_id,
                pid = excluded.pid,
                pgid = excluded.pgid,
                status = excluded.status,
                protocol_version = excluded.protocol_version,
                capabilities = excluded.capabilities,
                started_at = excluded.started_at,
                heartbeat_at = excluded.heartbeat_at,
                drain_requested_at = excluded.drain_requested_at,
                exited_at = excluded.exited_at,
                exit_reason = excluded.exit_reason,
                last_error = excluded.last_error,
                time_updated = excluded.time_updated",
            params![
                worker.worker_id,
                worker.workspace_id,
                worker.generation,
                worker.boot_id,
                worker.pid,
                worker.pgid,
                worker.status.as_str(),
                worker.protocol_version,
                worker.capabilities,
                worker.started_at,
                worker.heartbeat_at,
                worker.drain_requested_at,
                worker.exited_at,
                worker.exit_reason.map(|reason| reason.as_str()),
                worker.last_error,
                worker.time_created,
                worker.time_updated,
            ],
        )?;
        Ok(())
    }

    /// Move a worker to `status`, recording `exit_reason` when given.
    ///
    /// A terminal status stamps `exited_at` once and never overwrites an
    /// existing value (§5.5: committed terminal state is not re-derived).
    pub fn update_worker_status(
        &self,
        worker_id: &str,
        status: WorkerStatus,
        exit_reason: Option<ExitReason>,
        now: i64,
    ) -> Result<(), StoreError> {
        let changed = self.conn.execute(
            "UPDATE host_worker SET
                status = ?2,
                exit_reason = COALESCE(?3, exit_reason),
                exited_at = CASE WHEN ?4 THEN COALESCE(exited_at, ?5) ELSE exited_at END,
                time_updated = ?5
             WHERE worker_id = ?1",
            params![
                worker_id,
                status.as_str(),
                exit_reason.map(|reason| reason.as_str()),
                status.is_terminal(),
                now,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                table: "host_worker",
                key: worker_id.to_string(),
            });
        }
        Ok(())
    }

    /// Read a `host_state` row by scope.
    pub fn read_host_state(&self, scope: &str) -> Result<Option<HostState>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT scope, schema_version, host_generation, next_worker_generation,
                        next_event_seq, boot_id, updated_at
                   FROM host_state
                  WHERE scope = ?1",
                params![scope],
                |row| {
                    Ok(HostState {
                        scope: row.get(0)?,
                        schema_version: row.get(1)?,
                        host_generation: row.get(2)?,
                        next_worker_generation: row.get(3)?,
                        next_event_seq: row.get(4)?,
                        boot_id: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .optional()?)
    }

    /// Insert or replace a `host_state` row, keyed by `scope`.
    pub fn write_host_state(&self, state: &HostState) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO host_state (
                scope, schema_version, host_generation, next_worker_generation,
                next_event_seq, boot_id, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(scope) DO UPDATE SET
                schema_version = excluded.schema_version,
                host_generation = excluded.host_generation,
                next_worker_generation = excluded.next_worker_generation,
                next_event_seq = excluded.next_event_seq,
                boot_id = excluded.boot_id,
                updated_at = excluded.updated_at",
            params![
                state.scope,
                state.schema_version,
                state.host_generation,
                state.next_worker_generation,
                state.next_event_seq,
                state.boot_id,
                state.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Insert a new turn checkpoint.
    ///
    /// `session_turn_checkpoint_active_idx` rejects a second non-terminal turn
    /// for the same session; that rejection surfaces as a SQLite constraint
    /// error rather than being silently resolved.
    pub fn insert_checkpoint(&self, checkpoint: &TurnCheckpoint) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO session_turn_checkpoint (
                session_id, turn_id, turn_seq, generation, worker_id,
                worker_generation, status, commit_state, commit_token,
                completion_source, terminal_source, intent, resume_policy,
                side_effect_state, last_message_id, last_event_seq,
                cancel_requested_at, error, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20
             )",
            params![
                checkpoint.session_id,
                checkpoint.turn_id,
                checkpoint.turn_seq,
                checkpoint.generation,
                checkpoint.worker_id,
                checkpoint.worker_generation,
                checkpoint.status,
                checkpoint.commit_state,
                checkpoint.commit_token,
                checkpoint.completion_source,
                checkpoint.terminal_source,
                checkpoint.intent,
                checkpoint.resume_policy,
                checkpoint.side_effect_state,
                checkpoint.last_message_id,
                checkpoint.last_event_seq,
                checkpoint.cancel_requested_at,
                checkpoint.error,
                checkpoint.created_at,
                checkpoint.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Update the mutable columns of an existing checkpoint, keyed by
    /// `(session_id, turn_id)`. `created_at` is not rewritten.
    pub fn update_checkpoint(&self, checkpoint: &TurnCheckpoint) -> Result<(), StoreError> {
        let changed = self.conn.execute(
            "UPDATE session_turn_checkpoint SET
                turn_seq = ?3,
                generation = ?4,
                worker_id = ?5,
                worker_generation = ?6,
                status = ?7,
                commit_state = ?8,
                commit_token = ?9,
                completion_source = ?10,
                terminal_source = ?11,
                intent = ?12,
                resume_policy = ?13,
                side_effect_state = ?14,
                last_message_id = ?15,
                last_event_seq = ?16,
                cancel_requested_at = ?17,
                error = ?18,
                updated_at = ?19
             WHERE session_id = ?1 AND turn_id = ?2",
            params![
                checkpoint.session_id,
                checkpoint.turn_id,
                checkpoint.turn_seq,
                checkpoint.generation,
                checkpoint.worker_id,
                checkpoint.worker_generation,
                checkpoint.status,
                checkpoint.commit_state,
                checkpoint.commit_token,
                checkpoint.completion_source,
                checkpoint.terminal_source,
                checkpoint.intent,
                checkpoint.resume_policy,
                checkpoint.side_effect_state,
                checkpoint.last_message_id,
                checkpoint.last_event_seq,
                checkpoint.cancel_requested_at,
                checkpoint.error,
                checkpoint.updated_at,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                table: "session_turn_checkpoint",
                key: format!("{}/{}", checkpoint.session_id, checkpoint.turn_id),
            });
        }
        Ok(())
    }

    /// Insert a pending request, or refresh the existing row with the same
    /// `request_id` (republish keeps `request_id`/`request_key` and advances
    /// `generation`, §8.4).
    pub fn insert_pending_request(&self, request: &PendingRequest) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO pending_request (
                request_id, request_key, kind, session_id, turn_id, worker_id,
                worker_generation, tool_call_id, status, payload, answer,
                generation, expires_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
             )
             ON CONFLICT(request_id) DO UPDATE SET
                request_key = excluded.request_key,
                kind = excluded.kind,
                session_id = excluded.session_id,
                turn_id = excluded.turn_id,
                worker_id = excluded.worker_id,
                worker_generation = excluded.worker_generation,
                tool_call_id = excluded.tool_call_id,
                status = excluded.status,
                payload = excluded.payload,
                answer = excluded.answer,
                generation = excluded.generation,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at",
            params![
                request.request_id,
                request.request_key,
                request.kind,
                request.session_id,
                request.turn_id,
                request.worker_id,
                request.worker_generation,
                request.tool_call_id,
                request.status,
                request.payload,
                request.answer,
                request.generation,
                request.expires_at,
                request.created_at,
                request.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Read a pending request by id.
    pub fn pending_request(&self, request_id: &str) -> Result<Option<PendingRequest>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT request_id, request_key, kind, session_id, turn_id, worker_id,
                        worker_generation, tool_call_id, status, payload, answer,
                        generation, expires_at, created_at, updated_at
                   FROM pending_request
                  WHERE request_id = ?1",
                params![request_id],
                |row| {
                    Ok(PendingRequest {
                        request_id: row.get(0)?,
                        request_key: row.get(1)?,
                        kind: row.get(2)?,
                        session_id: row.get(3)?,
                        turn_id: row.get(4)?,
                        worker_id: row.get(5)?,
                        worker_generation: row.get(6)?,
                        tool_call_id: row.get(7)?,
                        status: row.get(8)?,
                        payload: row.get(9)?,
                        answer: row.get(10)?,
                        generation: row.get(11)?,
                        expires_at: row.get(12)?,
                        created_at: row.get(13)?,
                        updated_at: row.get(14)?,
                    })
                },
            )
            .optional()?)
    }

    /// Resolve a pending request at a specific `generation`.
    ///
    /// Returns `true` when the row transitioned to `status`, and `false` when
    /// the same generation already resolved it (idempotent repeat reply). A
    /// reply carrying an older generation is rejected with
    /// [`StoreError::StaleGeneration`] (§8.4).
    pub fn resolve_pending_request(
        &self,
        request_id: &str,
        generation: i64,
        status: &str,
        answer: Option<&str>,
        now: i64,
    ) -> Result<bool, StoreError> {
        let current = self
            .conn
            .query_row(
                "SELECT generation, status FROM pending_request WHERE request_id = ?1",
                params![request_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((found, current_status)) = current else {
            return Err(StoreError::NotFound {
                table: "pending_request",
                key: request_id.to_string(),
            });
        };
        if found != generation {
            return Err(StoreError::StaleGeneration {
                request_id: request_id.to_string(),
                expected: generation,
                found,
            });
        }
        if current_status != "pending" {
            return Ok(false);
        }
        let changed = self.conn.execute(
            "UPDATE pending_request SET
                status = ?3, answer = ?4, updated_at = ?5
             WHERE request_id = ?1 AND generation = ?2 AND status = 'pending'",
            params![request_id, generation, status, answer, now],
        )?;
        Ok(changed > 0)
    }

    /// Append a durable event.
    ///
    /// Sequence allocation and insertion share one `BEGIN IMMEDIATE`
    /// transaction (§8.5). When `dedupe_key` already exists the existing row is
    /// returned and no sequence is consumed.
    pub fn append_event(&self, event: &NewHostEvent) -> Result<AppendedEvent, StoreError> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT seq FROM host_event WHERE dedupe_key = ?1",
                params![event.dedupe_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(seq) = existing {
            return Ok(AppendedEvent { seq, deduped: true });
        }
        let seq = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM host_event", [], |row| {
            row.get::<_, i64>(0)
        })?;
        tx.execute(
            "INSERT INTO host_event (
                seq, event_id, dedupe_key, workspace_id, project_id, aggregate_id,
                aggregate_seq, type, worker_id, worker_generation, payload, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                seq,
                event.event_id,
                event.dedupe_key,
                event.workspace_id,
                event.project_id,
                event.aggregate_id,
                event.aggregate_seq,
                event.event_type,
                event.worker_id,
                event.worker_generation,
                event.payload,
                event.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(AppendedEvent { seq, deduped: false })
    }

    /// Record an idempotent operation.
    ///
    /// Re-recording the same `(scope, idempotency_key)` with the same
    /// `request_hash` updates the row; a different hash is rejected with
    /// [`StoreError::IdempotencyConflict`] (§8.6).
    pub fn record_idempotency(&self, record: &IdempotencyRecord) -> Result<(), StoreError> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT request_hash FROM request_idempotency
                  WHERE scope = ?1 AND idempotency_key = ?2",
                params![record.scope, record.idempotency_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match existing {
            Some(hash) if hash != record.request_hash => {
                return Err(StoreError::IdempotencyConflict {
                    scope: record.scope.clone(),
                    key: record.idempotency_key.clone(),
                })
            }
            Some(_) => {
                tx.execute(
                    "UPDATE request_idempotency SET
                        operation = ?3, status = ?4, response_ref = ?5,
                        response_body = ?6, generation = ?7,
                        owner_session_id = ?8, expires_at = ?9
                     WHERE scope = ?1 AND idempotency_key = ?2",
                    params![
                        record.scope,
                        record.idempotency_key,
                        record.operation,
                        record.status,
                        record.response_ref,
                        record.response_body,
                        record.generation,
                        record.owner_session_id,
                        record.expires_at,
                    ],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO request_idempotency (
                        scope, idempotency_key, request_hash, operation, status,
                        response_ref, response_body, generation, owner_session_id,
                        created_at, expires_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        record.scope,
                        record.idempotency_key,
                        record.request_hash,
                        record.operation,
                        record.status,
                        record.response_ref,
                        record.response_body,
                        record.generation,
                        record.owner_session_id,
                        record.created_at,
                        record.expires_at,
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Look up an idempotency record.
    pub fn lookup_idempotency(
        &self,
        scope: &str,
        key: &str,
    ) -> Result<Option<IdempotencyRecord>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT scope, idempotency_key, request_hash, operation, status,
                        response_ref, response_body, generation, owner_session_id,
                        created_at, expires_at
                   FROM request_idempotency
                  WHERE scope = ?1 AND idempotency_key = ?2",
                params![scope, key],
                |row| {
                    Ok(IdempotencyRecord {
                        scope: row.get(0)?,
                        idempotency_key: row.get(1)?,
                        request_hash: row.get(2)?,
                        operation: row.get(3)?,
                        status: row.get(4)?,
                        response_ref: row.get(5)?,
                        response_body: row.get(6)?,
                        generation: row.get(7)?,
                        owner_session_id: row.get(8)?,
                        created_at: row.get(9)?,
                        expires_at: row.get(10)?,
                    })
                },
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Schema copied verbatim from
    /// `packages/chimera/migration/20261022022937_host_control_plane/migration.sql`.
    /// The store itself never migrates; tests stand up the real tables so the
    /// partial unique indexes are exercised.
    const TEST_SCHEMA: &str = r#"
CREATE TABLE `host_event` (
	`seq` integer PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`dedupe_key` text NOT NULL UNIQUE,
	`workspace_id` text,
	`project_id` text,
	`aggregate_id` text NOT NULL,
	`aggregate_seq` integer,
	`type` text NOT NULL,
	`worker_id` text,
	`worker_generation` integer,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE TABLE `host_state` (
	`scope` text PRIMARY KEY,
	`schema_version` integer NOT NULL,
	`host_generation` integer NOT NULL,
	`next_worker_generation` integer NOT NULL,
	`next_event_seq` integer NOT NULL,
	`boot_id` text,
	`updated_at` integer NOT NULL
);
CREATE TABLE `host_worker` (
	`worker_id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`generation` integer NOT NULL,
	`boot_id` text NOT NULL,
	`pid` integer NOT NULL,
	`pgid` integer,
	`status` text NOT NULL,
	`protocol_version` text NOT NULL,
	`capabilities` text NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer,
	`drain_requested_at` integer,
	`exited_at` integer,
	`exit_reason` text,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
CREATE TABLE `pending_request` (
	`request_id` text PRIMARY KEY,
	`request_key` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`worker_id` text,
	`worker_generation` integer,
	`tool_call_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`answer` text,
	`generation` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `request_idempotency` (
	`scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`response_ref` text,
	`response_body` text,
	`generation` integer,
	`owner_session_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `request_idempotency_pk` PRIMARY KEY(`scope`, `idempotency_key`)
);
CREATE TABLE `session_turn_checkpoint` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`generation` integer NOT NULL,
	`worker_id` text,
	`worker_generation` integer,
	`status` text NOT NULL,
	`commit_state` text NOT NULL,
	`commit_token` text,
	`completion_source` text,
	`terminal_source` text,
	`intent` text NOT NULL,
	`resume_policy` text NOT NULL,
	`side_effect_state` text NOT NULL,
	`last_message_id` text,
	`last_event_seq` integer,
	`cancel_requested_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `session_turn_checkpoint_pk` PRIMARY KEY(`session_id`, `turn_id`)
);
CREATE UNIQUE INDEX `host_event_aggregate_seq_idx` ON `host_event` (`aggregate_id`,`aggregate_seq`) WHERE aggregate_seq IS NOT NULL;
CREATE INDEX `host_event_created_idx` ON `host_event` (`created_at`);
CREATE UNIQUE INDEX `host_worker_workspace_generation_idx` ON `host_worker` (`workspace_id`,`generation`);
CREATE UNIQUE INDEX `host_worker_active_idx` ON `host_worker` (`workspace_id`) WHERE status NOT IN ('exited', 'crashed', 'killed');
CREATE INDEX `host_worker_status_heartbeat_idx` ON `host_worker` (`status`,`heartbeat_at`);
CREATE INDEX `host_worker_workspace_status_idx` ON `host_worker` (`workspace_id`,`status`);
CREATE UNIQUE INDEX `pending_request_active_key_idx` ON `pending_request` (`session_id`,`request_key`) WHERE status = 'pending';
CREATE INDEX `pending_request_session_status_idx` ON `pending_request` (`session_id`,`status`);
CREATE INDEX `pending_request_status_expires_idx` ON `pending_request` (`status`,`expires_at`);
CREATE INDEX `request_idempotency_expires_idx` ON `request_idempotency` (`expires_at`);
CREATE INDEX `session_turn_checkpoint_session_status_idx` ON `session_turn_checkpoint` (`session_id`,`status`);
CREATE INDEX `session_turn_checkpoint_worker_idx` ON `session_turn_checkpoint` (`worker_id`,`worker_generation`);
CREATE UNIQUE INDEX `session_turn_checkpoint_active_idx` ON `session_turn_checkpoint` (`session_id`) WHERE status IN ('accepted', 'running', 'waiting_permission', 'waiting_question', 'waiting_tool', 'cancelling');
"#;

    fn store() -> HostStore {
        let store = HostStore::open_memory().expect("open in-memory store");
        store.conn.execute_batch(TEST_SCHEMA).expect("create schema");
        store
    }

    fn supervisor_record(status: WorkerStatus) -> WorkerRecord {
        WorkerRecord {
            worker_id: 7,
            workspace_id: "ws-a".into(),
            generation: 1,
            status,
            created_at_ms: 1_000,
            last_heartbeat_ms: 1_100,
            last_transition_ms: 1_050,
            ready_at_ms: Some(1_050),
            drain_deadline_ms: None,
            exited_at_ms: None,
            exit_reason: None,
        }
    }

    fn checkpoint(status: &str) -> TurnCheckpoint {
        TurnCheckpoint {
            session_id: "ses-1".into(),
            turn_id: "turn-1".into(),
            turn_seq: 1,
            generation: 1,
            worker_id: None,
            worker_generation: None,
            status: status.into(),
            commit_state: "uncommitted".into(),
            commit_token: None,
            completion_source: None,
            terminal_source: None,
            intent: "{\"prompt\":\"hi\"}".into(),
            resume_policy: "none".into(),
            side_effect_state: "none".into(),
            last_message_id: None,
            last_event_seq: None,
            cancel_requested_at: None,
            error: None,
            created_at: 100,
            updated_at: 100,
        }
    }

    fn pending_request() -> PendingRequest {
        PendingRequest {
            request_id: "req-1".into(),
            request_key: "permission:turn-1:call-1".into(),
            kind: "permission".into(),
            session_id: "ses-1".into(),
            turn_id: Some("turn-1".into()),
            worker_id: Some("7".into()),
            worker_generation: Some(1),
            tool_call_id: Some("call-1".into()),
            status: "pending".into(),
            payload: "{\"mode\":\"ask\"}".into(),
            answer: None,
            generation: 1,
            expires_at: Some(5_000),
            created_at: 100,
            updated_at: 100,
        }
    }

    fn idempotency(hash: &str) -> IdempotencyRecord {
        IdempotencyRecord {
            scope: "ws-a".into(),
            idempotency_key: "key-1".into(),
            request_hash: hash.into(),
            operation: "prompt".into(),
            status: "in_flight".into(),
            response_ref: None,
            response_body: None,
            generation: None,
            owner_session_id: Some("ses-1".into()),
            created_at: 100,
            expires_at: 9_999,
        }
    }

    fn event(event_id: &str, dedupe_key: &str, created_at: i64) -> NewHostEvent {
        NewHostEvent {
            event_id: event_id.into(),
            dedupe_key: dedupe_key.into(),
            workspace_id: Some("ws-a".into()),
            project_id: None,
            aggregate_id: "ses-1".into(),
            aggregate_seq: Some(created_at),
            event_type: "turn.started".into(),
            worker_id: Some("7".into()),
            worker_generation: Some(1),
            payload: "{}".into(),
            created_at,
        }
    }

    #[test]
    fn worker_upsert_and_status_update() {
        let store = store();
        let record = supervisor_record(WorkerStatus::Ready);
        let worker = HostWorker::from_supervisor(&record, "boot_1000_42", 42, Some(41), "v0", "{}");
        assert_eq!(worker.worker_id, "7");
        assert_eq!(worker.started_at, 1_000);
        assert_eq!(worker.time_updated, 1_050);

        store.upsert_worker(&worker).expect("insert worker");
        let mut heartbeat = worker.clone();
        heartbeat.heartbeat_at = Some(1_400);
        heartbeat.time_updated = 1_400;
        store.upsert_worker(&heartbeat).expect("upsert worker");

        let (rows, heartbeat_at): (i64, Option<i64>) = store
            .conn
            .query_row(
                "SELECT COUNT(*), MAX(heartbeat_at) FROM host_worker WHERE worker_id = '7'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read worker");
        assert_eq!(rows, 1);
        assert_eq!(heartbeat_at, Some(1_400));

        store
            .update_worker_status("7", WorkerStatus::Exited, Some(ExitReason::Normal), 2_000)
            .expect("update status");
        let (status, exited_at, exit_reason): (String, Option<i64>, Option<String>) = store
            .conn
            .query_row(
                "SELECT status, exited_at, exit_reason FROM host_worker WHERE worker_id = '7'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read status");
        assert_eq!(status, "exited");
        assert_eq!(exited_at, Some(2_000));
        assert_eq!(exit_reason.as_deref(), Some("normal"));

        // A terminal row never rewrites exited_at on a later status write.
        store
            .update_worker_status("7", WorkerStatus::Killed, Some(ExitReason::Killed), 3_000)
            .expect("update status");
        let exited_at: Option<i64> = store
            .conn
            .query_row(
                "SELECT exited_at FROM host_worker WHERE worker_id = '7'",
                [],
                |row| row.get(0),
            )
            .expect("read exited_at");
        assert_eq!(exited_at, Some(2_000));

        assert!(matches!(
            store
                .update_worker_status("missing", WorkerStatus::Ready, None, 1)
                .expect_err("unknown worker"),
            StoreError::NotFound { .. }
        ));
    }

    #[test]
    fn host_state_round_trips() {
        let store = store();
        assert_eq!(store.read_host_state("global").expect("read"), None);

        let state = HostState {
            scope: "global".into(),
            schema_version: 1,
            host_generation: 3,
            next_worker_generation: 5,
            next_event_seq: 9,
            boot_id: Some("boot_1000_42".into()),
            updated_at: 100,
        };
        store.write_host_state(&state).expect("insert state");
        assert_eq!(
            store.read_host_state("global").expect("read"),
            Some(state.clone())
        );

        let bumped = HostState {
            host_generation: 4,
            next_worker_generation: 6,
            next_event_seq: 10,
            updated_at: 200,
            ..state
        };
        store.write_host_state(&bumped).expect("update state");
        assert_eq!(
            store.read_host_state("global").expect("read"),
            Some(bumped)
        );
    }

    #[test]
    fn checkpoint_lifecycle() {
        let store = store();
        let mut checkpoint = checkpoint("accepted");
        store.insert_checkpoint(&checkpoint).expect("insert checkpoint");

        checkpoint.status = "running".into();
        checkpoint.worker_id = Some("7".into());
        checkpoint.worker_generation = Some(1);
        checkpoint.updated_at = 200;
        store
            .update_checkpoint(&checkpoint)
            .expect("update checkpoint");

        let (status, worker_id, worker_generation, created_at): (
            String,
            Option<String>,
            Option<i64>,
            i64,
        ) = store
            .conn
            .query_row(
                "SELECT status, worker_id, worker_generation, created_at
                   FROM session_turn_checkpoint
                  WHERE session_id = 'ses-1' AND turn_id = 'turn-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read checkpoint");
        assert_eq!(status, "running");
        assert_eq!(worker_id.as_deref(), Some("7"));
        assert_eq!(worker_generation, Some(1));
        assert_eq!(created_at, 100);

        checkpoint.status = "completed".into();
        checkpoint.commit_state = "confirmed".into();
        checkpoint.completion_source = Some("worker_confirmed".into());
        checkpoint.terminal_source = Some("worker".into());
        checkpoint.updated_at = 300;
        store
            .update_checkpoint(&checkpoint)
            .expect("complete checkpoint");

        let (rows, status): (i64, String) = store
            .conn
            .query_row(
                "SELECT COUNT(*), MAX(status) FROM session_turn_checkpoint",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read completed checkpoint");
        assert_eq!(rows, 1);
        assert_eq!(status, "completed");

        let missing = TurnCheckpoint {
            turn_id: "turn-missing".into(),
            ..checkpoint
        };
        assert!(matches!(
            store
                .update_checkpoint(&missing)
                .expect_err("missing checkpoint"),
            StoreError::NotFound { .. }
        ));
    }

    #[test]
    fn pending_request_republish_and_resolution_are_generation_fenced() {
        let store = store();
        let mut request = pending_request();
        store
            .insert_pending_request(&request)
            .expect("insert pending request");

        // Republish keeps one row and advances the generation.
        request.generation = 2;
        request.worker_generation = Some(2);
        request.expires_at = Some(6_000);
        request.updated_at = 200;
        store
            .insert_pending_request(&request)
            .expect("republish pending request");

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM pending_request", [], |row| row.get(0))
            .expect("count pending requests");
        assert_eq!(rows, 1);
        assert_eq!(
            store
                .pending_request("req-1")
                .expect("read pending request")
                .expect("row exists")
                .generation,
            2
        );

        // A reply addressed at the previous generation is rejected.
        assert!(matches!(
            store
                .resolve_pending_request("req-1", 1, "answered", Some("{}"), 300)
                .expect_err("stale generation"),
            StoreError::StaleGeneration { expected: 1, found: 2, .. }
        ));

        assert!(store
            .resolve_pending_request("req-1", 2, "answered", Some("{\"ok\":true}"), 300)
            .expect("resolve"));
        let resolved = store
            .pending_request("req-1")
            .expect("read resolved request")
            .expect("row exists");
        assert_eq!(resolved.status, "answered");
        assert_eq!(resolved.answer.as_deref(), Some("{\"ok\":true}"));

        // Repeating the same generation's reply is an idempotent no-op.
        assert!(!store
            .resolve_pending_request("req-1", 2, "rejected", Some("{}"), 400)
            .expect("repeat resolve"));
        assert_eq!(
            store
                .pending_request("req-1")
                .expect("read request")
                .expect("row exists")
                .status,
            "answered"
        );

        assert!(matches!(
            store
                .resolve_pending_request("req-missing", 1, "answered", None, 400)
                .expect_err("missing request"),
            StoreError::NotFound { .. }
        ));
    }

    #[test]
    fn event_sequence_is_contiguous_and_dedupe_returns_existing_row() {
        let store = store();
        let first = store
            .append_event(&event("ev-1", "turn:turn-1:started", 100))
            .expect("append first event");
        assert_eq!(first, AppendedEvent { seq: 1, deduped: false });

        let second = store
            .append_event(&event("ev-2", "turn:turn-1:completed", 200))
            .expect("append second event");
        assert_eq!(second, AppendedEvent { seq: 2, deduped: false });

        let duplicate = store
            .append_event(&event("ev-1", "turn:turn-1:started", 100))
            .expect("append duplicate event");
        assert_eq!(duplicate, AppendedEvent { seq: 1, deduped: true });

        let third = store
            .append_event(&event("ev-3", "turn:turn-1:cancelled", 300))
            .expect("append third event");
        assert_eq!(third, AppendedEvent { seq: 3, deduped: false });

        let (rows, max_seq): (i64, i64) = store
            .conn
            .query_row("SELECT COUNT(*), MAX(seq) FROM host_event", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("count events");
        assert_eq!(rows, 3);
        assert_eq!(max_seq, 3);
    }

    #[test]
    fn idempotency_records_and_guards_request_hash() {
        let store = store();
        store
            .record_idempotency(&idempotency("hash-a"))
            .expect("record idempotency");
        assert_eq!(
            store.lookup_idempotency("ws-a", "key-1").expect("lookup"),
            Some(idempotency("hash-a"))
        );
        assert_eq!(
            store.lookup_idempotency("ws-a", "key-missing").expect("lookup"),
            None
        );

        // Same key, different body: rejected.
        assert!(matches!(
            store
                .record_idempotency(&idempotency("hash-b"))
                .expect_err("hash conflict"),
            StoreError::IdempotencyConflict { .. }
        ));

        // Same key, same body: the row advances to the first result.
        let mut completed = idempotency("hash-a");
        completed.status = "completed".into();
        completed.response_ref = Some("turn-1".into());
        store
            .record_idempotency(&completed)
            .expect("complete idempotency");
        let found = store
            .lookup_idempotency("ws-a", "key-1")
            .expect("lookup")
            .expect("row exists");
        assert_eq!(found.status, "completed");
        assert_eq!(found.response_ref.as_deref(), Some("turn-1"));

        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM request_idempotency", [], |row| {
                row.get(0)
            })
            .expect("count idempotency rows");
        assert_eq!(rows, 1);
    }
}