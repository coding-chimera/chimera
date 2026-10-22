//! Host runtime assembly layer.
//!
//! This module wires the pieces that already exist as pure logic into one
//! driveable host runtime:
//!
//! - [`WorkerRegistry`] owns generation allocation, lifecycle transitions,
//!   crash accounting, and drain planning (`supervisor`).
//! - [`HostDriver`] owns exactly one worker connection (`host_driver`).
//! - [`Listener`] is the injected transport acceptor; [`Clock`] is the
//!   injected logical clock.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2.3 (connection
//! lifecycle), §9.3 (drain), §11.1 (crash recovery); `recovery-matrix.md`
//! §4.1-4.2 (host/worker lifecycle).
//!
//! The runtime is **single-step**: [`HostRuntime::accept_next`],
//! [`HostRuntime::tick`], [`HostRuntime::serve`], and
//! [`HostRuntime::collect_drain_outcomes`] each perform one bounded unit of
//! work. There is no internal blocking loop and no thread; the caller decides
//! the main-loop shape. Nothing here spawns processes, reads the wall clock,
//! or kills a worker.
//!
//! Ownership rules that shape the API:
//!
//! - **Idle hosts spawn nothing.** A worker is only spawned by an explicit
//!   [`HostRuntime::spawn_worker`] call, so an idle runtime keeps an empty
//!   registry and [`HostRuntime::accept_next`] never touches the listener
//!   while no spawn is pending.
//! - **One live driver per connection.** `accept_next` binds an accepted
//!   transport to the oldest pending spawn, runs the handshake, and stores the
//!   driver. Admission is FIFO because `Listener::accept` returns only the
//!   byte streams; the spawn order is the identity source.
//! - **Drain escalation stays with the caller.** [`HostRuntime::request_drain`]
//!   sends the frame and [`HostRuntime::collect_drain_outcomes`] gathers the
//!   [`DrainOutcome`]s. A timed-out drain is reported, never killed;
//!   [`HostRuntime::kill_worker`] is the explicit escalation.
//! - **Crash recovery stays with the caller.** A driver failure marks the
//!   worker crashed and schedules the §11.1 backoff;
//!   [`HostRuntime::rebuild_decision`] / [`HostRuntime::try_restart`] expose
//!   whether a respawn is allowed under the crash budget.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};

use crate::connection::{ConnectionError, FrameReader, FrameWriter};
use crate::handshake::HostConfig;
use crate::host_driver::{
    run_handshake, Clock, DrainOutcome, DrainReason, HostDriver, HostError, HostEvent,
    RequestRouter, ServeOutcome,
};
use crate::supervisor::{
    restart_backoff_with_jitter, DrainPlan, ExitReason, SupervisorError, WorkerRecord,
    WorkerRegistry, WorkerStatus, DRAIN_DEADLINE_MS, HEARTBEAT_TIMEOUT_MS,
};

/// Candidate default host heartbeat cadence (§2.3): one transient
/// `ipc.heartbeat` per connection every 10s.
///
/// The runtime does not write the heartbeat frame itself (the driver exposes
/// no generic event writer); [`HostRuntime::tick`] reports which connections
/// are due so the caller can emit it.
pub const HEARTBEAT_INTERVAL_MS: u64 = 10_000;

/// Candidate default heartbeat scan cadence. Ticks closer together than this
/// are coalesced; the timeout itself stays [`HEARTBEAT_TIMEOUT_MS`].
pub const HEARTBEAT_SCAN_INTERVAL_MS: u64 = 1_000;

/// Candidate default drain deadline (§9.3). Mirrors
/// [`crate::supervisor::DRAIN_DEADLINE_MS`] so the registry and the driver
/// frame agree when the config default is used.
pub const DRAIN_DEADLINE_CANDIDATE_MS: u64 = DRAIN_DEADLINE_MS;

/// Candidate default restart jitter (§11.1). The supervisor keeps jitter as
/// an explicit input; the default runtime is fully deterministic.
pub const RESTART_JITTER_MS: u64 = 0;

/// Runtime configuration. Every timing value is a candidate default that must
/// be calibrated by the H0 baseline / H1 benchmark (§2.3, §9.3, §11.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRuntimeConfig {
    /// Candidate default heartbeat cadence (§2.3).
    pub heartbeat_interval_ms: u64,
    /// Candidate default heartbeat scan cadence.
    pub heartbeat_scan_interval_ms: u64,
    /// Candidate default heartbeat loss timeout (§2.3): three missed 10s
    /// heartbeats.
    pub heartbeat_timeout_ms: u64,
    /// Candidate default drain deadline before the caller escalates to
    /// `SIGTERM` → `SIGKILL` (§9.3).
    pub drain_deadline_ms: u64,
    /// Candidate default restart jitter (§11.1). `0` keeps restarts exact.
    pub restart_jitter_ms: u64,
    /// One-time spawn nonce expected in `hello` (§2.2). `None` disables the
    /// check, which is only appropriate for tests.
    pub expected_nonce: Option<String>,
}

impl Default for HostRuntimeConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            heartbeat_scan_interval_ms: HEARTBEAT_SCAN_INTERVAL_MS,
            heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
            drain_deadline_ms: DRAIN_DEADLINE_CANDIDATE_MS,
            restart_jitter_ms: RESTART_JITTER_MS,
            expected_nonce: None,
        }
    }
}

/// Injected transport acceptor (§2.1).
///
/// `accept` returns one `(reader, writer)` byte-stream pair per worker
/// connection. Returning `Ok(None)` means "no connection is ready yet" and
/// leaves the runtime unchanged; the caller decides whether to poll again.
pub trait Listener {
    /// Read half of an accepted connection.
    type Reader: Read;
    /// Write half of an accepted connection.
    type Writer: Write;

    /// Accept at most one connection.
    fn accept(&mut self) -> io::Result<Option<(Self::Reader, Self::Writer)>>;
}

/// Stable reference to one supervised worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRef {
    /// Workspace the worker serves.
    pub workspace_id: String,
    /// Registry-assigned worker id.
    pub worker_id: u64,
    /// Fencing generation (§1.2).
    pub generation: u64,
}

/// Result of one [`HostRuntime::tick`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickOutcome {
    /// Whether the heartbeat scan ran or was coalesced by the scan cadence.
    pub scanned: bool,
    /// Workers newly marked `unresponsive` by this tick. Escalation (close /
    /// kill) is the caller's decision.
    pub unresponsive: Vec<WorkerRef>,
    /// Connections whose transient heartbeat was written by this tick (§2.3).
    ///
    /// The runtime emits the frame itself through
    /// [`HostDriver::send_heartbeat`]; a reference here means the frame was
    /// written successfully.
    pub heartbeats_due: Vec<WorkerRef>,
    /// Connections whose heartbeat frame could not be written this tick. The
    /// caller decides whether to close or reap them.
    pub heartbeat_send_failures: Vec<WorkerRef>,
    /// Drains whose deadline passed during this tick. The caller decides
    /// whether to escalate with [`HostRuntime::kill_worker`].
    pub drain_expired: Vec<WorkerRef>,
}

/// Whether a crashed workspace may be respawned (§11.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildDecision {
    /// No crash is awaiting a restart.
    NotScheduled,
    /// The workspace exceeded its crash budget; route to legacy or `503`.
    Paused,
    /// The §11.1 backoff has not elapsed yet.
    Backoff {
        /// Logical time at which a respawn becomes allowed.
        until_ms: u64,
    },
    /// The backoff elapsed and the crash budget allows a respawn.
    Allowed,
}

/// One drain outcome gathered from a live driver (§9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainOutcomeRecord {
    /// Workspace of the drained worker.
    pub workspace_id: String,
    /// Generation of the drained worker.
    pub generation: u64,
    /// Connection that carried the drain.
    pub connection_id: u64,
    /// Drain correlation id.
    pub drain_id: String,
    /// Driver outcome. A transport error is reported as
    /// [`DrainOutcome::Closed`] after the worker was marked crashed.
    pub outcome: DrainOutcome,
}

/// One spawn intent waiting for its transport connection.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingSpawn {
    workspace_id: String,
    worker_id: u64,
    generation: u64,
}

/// One admitted worker connection.
struct LiveConnection<R: Read, W: Write> {
    driver: HostDriver<R, W>,
    last_heartbeat_sent_ms: u64,
}

/// Events and outcome produced by driving one live connection.
///
/// The runtime surfaces events before applying terminal lifecycle effects so
/// the caller can commit durable events and ack them first
/// (commit-before-ack, §8.2). Use [`HostRuntime::settle_connection`] once the
/// events are handled.
#[derive(Debug)]
pub struct ConnectionServe {
    /// Workspace the connection serves.
    pub workspace_id: String,
    /// Fencing generation of the connection.
    pub generation: u64,
    /// Host-assigned connection id.
    pub connection_id: u64,
    /// Events surfaced by this serve step, in arrival order.
    pub events: Vec<HostEvent>,
    /// How the serve step stopped. A driver error is reported, not hidden.
    pub outcome: Result<ServeOutcome, HostError>,
}

/// Host runtime: registry + listener + clock + live drivers.
pub struct HostRuntime<L: Listener, C: Clock> {
    config: HostRuntimeConfig,
    registry: WorkerRegistry,
    listener: L,
    clock: C,
    connections: Vec<LiveConnection<L::Reader, L::Writer>>,
    pending: VecDeque<PendingSpawn>,
    next_connection_id: u64,
    crash_streaks: HashMap<String, u32>,
    restart_at: HashMap<String, u64>,
    last_scan_ms: Option<u64>,
}

impl<L: Listener, C: Clock> HostRuntime<L, C> {
    /// Build a runtime over an injected listener and clock.
    pub fn new(listener: L, clock: C, config: HostRuntimeConfig) -> Self {
        Self {
            config,
            registry: WorkerRegistry::new(),
            listener,
            clock,
            connections: Vec::new(),
            pending: VecDeque::new(),
            next_connection_id: 0,
            crash_streaks: HashMap::new(),
            restart_at: HashMap::new(),
            last_scan_ms: None,
        }
    }

    /// Runtime configuration.
    pub fn config(&self) -> &HostRuntimeConfig {
        &self.config
    }

    /// Supervisor registry.
    pub fn registry(&self) -> &WorkerRegistry {
        &self.registry
    }

    /// Mutable supervisor registry, for out-of-band recovery bookkeeping
    /// (for example a host-restart sweep).
    pub fn registry_mut(&mut self) -> &mut WorkerRegistry {
        &mut self.registry
    }

    /// Number of admitted connections.
    pub fn live_connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Number of spawn intents still waiting for a connection.
    pub fn pending_spawn_count(&self) -> usize {
        self.pending.len()
    }

    /// Whether the runtime holds no connections and no pending spawns.
    ///
    /// An idle runtime has also spawned nothing, so the registry is empty for
    /// every workspace it was never asked to serve.
    pub fn is_idle(&self) -> bool {
        self.connections.is_empty() && self.pending.is_empty()
    }

    /// Record a spawn intent and queue it for admission (§11.1).
    ///
    /// Returns [`SupervisorError::WorkspacePaused`] when the workspace exceeded
    /// its crash budget; the caller decides between legacy fallback and `503`.
    pub fn spawn_worker(
        &mut self,
        workspace_id: &str,
        now_ms: u64,
    ) -> Result<WorkerRecord, SupervisorError> {
        let record = self.registry.spawn_intent(workspace_id, now_ms)?;
        self.pending.push_back(PendingSpawn {
            workspace_id: record.workspace_id.clone(),
            worker_id: record.worker_id,
            generation: record.generation,
        });
        Ok(record)
    }

    /// Accept at most one connection and bind it to the oldest pending spawn.
    ///
    /// Returns `Ok(None)` when nothing is pending or the listener has no
    /// connection yet. A handshake failure consumes the spawn intent and
    /// returns the driver error; `run_handshake` has already recorded the
    /// worker's `protocol_error` exit.
    pub fn accept_next(&mut self) -> Result<Option<WorkerRef>, HostError> {
        let Some(pending) = self.pending.front().cloned() else {
            // Idle hosts do not touch the listener (§2.3: no spawn, no accept).
            return Ok(None);
        };
        let Some((reader, writer)) = self.listener.accept().map_err(ConnectionError::from)? else {
            return Ok(None);
        };
        self.pending.pop_front();
        self.next_connection_id = self.next_connection_id.saturating_add(1);
        let connection_id = self.next_connection_id;
        let now_ms = self.clock.now_ms();
        let mut config = HostConfig::new(connection_id, pending.generation);
        config.expected_nonce = self.config.expected_nonce.clone();
        let driver = run_handshake(
            FrameReader::new(reader),
            FrameWriter::new(writer),
            &mut self.registry,
            &pending.workspace_id,
            config,
            now_ms,
        )?;
        // A ready worker ends the crash streak for its workspace.
        self.crash_streaks.remove(&pending.workspace_id);
        self.restart_at.remove(&pending.workspace_id);
        self.connections.push(LiveConnection { driver, last_heartbeat_sent_ms: now_ms });
        Ok(Some(WorkerRef {
            workspace_id: pending.workspace_id,
            worker_id: pending.worker_id,
            generation: pending.generation,
        }))
    }

    /// One bounded maintenance step: heartbeat scan, heartbeat emission due
    /// list, and drain deadline observation.
    ///
    /// Workers past [`HostRuntimeConfig::heartbeat_timeout_ms`] are marked
    /// `unresponsive` through the registry. The runtime never closes or kills
    /// them; the caller owns that escalation (§2.3, §9.3).
    pub fn tick(&mut self, now_ms: u64) -> TickOutcome {
        let mut outcome = TickOutcome::default();
        let scanned = self.last_scan_ms.map_or(true, |last| {
            now_ms.saturating_sub(last) >= self.config.heartbeat_scan_interval_ms
        });
        if scanned {
            self.last_scan_ms = Some(now_ms);
            outcome.scanned = true;
            for index in 0..self.connections.len() {
                let identity = self.connections[index].driver.identity().clone();
                let expired = self.connections[index]
                    .driver
                    .heartbeat_expired(now_ms, self.config.heartbeat_timeout_ms);
                if !expired {
                    continue;
                }
                let already = self
                    .registry
                    .get(&identity.workspace_id, identity.worker_generation)
                    .map(|record| record.status == WorkerStatus::Unresponsive)
                    .unwrap_or(true);
                if already {
                    continue;
                }
                if self
                    .registry
                    .mark_unresponsive(&identity.workspace_id, identity.worker_generation, now_ms)
                    .is_ok()
                {
                    if let Some(reference) =
                        self.worker_ref(&identity.workspace_id, identity.worker_generation)
                    {
                        outcome.unresponsive.push(reference);
                    }
                }
            }
        }

        for index in 0..self.connections.len() {
            let due = now_ms.saturating_sub(self.connections[index].last_heartbeat_sent_ms)
                >= self.config.heartbeat_interval_ms;
            if !due {
                continue;
            }
            let identity = self.connections[index].driver.identity().clone();
            let sent = self.connections[index].driver.send_heartbeat(now_ms).is_ok();
            if sent {
                self.connections[index].last_heartbeat_sent_ms = now_ms;
            }
            let Some(reference) =
                self.worker_ref(&identity.workspace_id, identity.worker_generation)
            else {
                continue;
            };
            if sent {
                outcome.heartbeats_due.push(reference);
            } else {
                outcome.heartbeat_send_failures.push(reference);
            }
        }

        for index in 0..self.connections.len() {
            let expired = match self.connections[index].driver.drain_state() {
                Some(state) => now_ms >= state.deadline_ms,
                None => false,
            };
            if !expired {
                continue;
            }
            let identity = self.connections[index].driver.identity().clone();
            if let Some(reference) =
                self.worker_ref(&identity.workspace_id, identity.worker_generation)
            {
                outcome.drain_expired.push(reference);
            }
        }

        outcome
    }

    /// Drive one admitted connection until it closes or its drain resolves.
    ///
    /// Crash handling (§11.1): a closed transport, a driver error, or a durable
    /// sequence gap marks the worker `crashed`, schedules the §11.1 backoff,
    /// and drops the connection. A completed drain marks it `exited(normal)`.
    /// A timed-out drain leaves the connection live for the caller to escalate.
    pub fn serve<T: RequestRouter>(
        &mut self,
        workspace_id: &str,
        generation: u64,
        router: &mut T,
    ) -> Result<ServeOutcome, HostError> {
        let served = self.serve_connection(workspace_id, generation, router).ok_or_else(|| {
            HostError::Supervisor(SupervisorError::UnknownWorker {
                workspace_id: workspace_id.to_string(),
                generation,
            })
        })?;
        self.settle_connection(workspace_id, generation, &served.outcome);
        served.outcome
    }

    /// Snapshot `(workspace_id, generation)` for every live connection.
    pub fn live_connections(&self) -> Vec<(String, u64)> {
        self.connections
            .iter()
            .map(|connection| {
                let identity = connection.driver.identity();
                (identity.workspace_id.clone(), identity.worker_generation)
            })
            .collect()
    }

    /// Drive one connection until it closes or its drain resolves, collecting
    /// the events it surfaced without applying terminal lifecycle effects.
    ///
    /// Returns `None` when the connection is unknown. The caller handles the
    /// events (durable commit + ack, commit-before-ack) and then calls
    /// [`HostRuntime::settle_connection`] so crash/drain accounting happens
    /// exactly once.
    pub fn serve_connection<T: RequestRouter>(
        &mut self,
        workspace_id: &str,
        generation: u64,
        router: &mut T,
    ) -> Option<ConnectionServe> {
        let index = self.connection_index(workspace_id, generation)?;
        let identity = self.connections[index].driver.identity().clone();
        let outcome = self.connections[index].driver.serve(&mut self.registry, router, &mut self.clock);
        let events = self.connections[index].driver.take_events();
        Some(ConnectionServe {
            workspace_id: identity.workspace_id,
            generation: identity.worker_generation,
            connection_id: identity.connection_id,
            events,
            outcome,
        })
    }

    /// Write `ack(phase=durable_committed, event_seq)` on a live connection.
    ///
    /// Call this only after the durable event is committed to `host_event`.
    pub fn acknowledge_durable(
        &mut self,
        workspace_id: &str,
        generation: u64,
        event_seq: u64,
    ) -> Result<(), HostError> {
        let index = self.connection_index(workspace_id, generation).ok_or_else(|| {
            HostError::Supervisor(SupervisorError::UnknownWorker {
                workspace_id: workspace_id.to_string(),
                generation,
            })
        })?;
        self.connections[index].driver.send_durable_ack(event_seq)?;
        Ok(())
    }

    /// Apply the lifecycle effects of a completed serve step (§11.1).
    ///
    /// Crash handling: a closed transport, a driver error, or a durable
    /// sequence gap marks the worker `crashed`, schedules the §11.1 backoff,
    /// and drops the connection. A completed drain marks it `exited(normal)`.
    /// A timed-out drain leaves the connection live for the caller to escalate.
    pub fn settle_connection(
        &mut self,
        workspace_id: &str,
        generation: u64,
        outcome: &Result<ServeOutcome, HostError>,
    ) {
        let now_ms = self.clock.now_ms();
        let Some(index) = self.connection_index(workspace_id, generation) else {
            return;
        };
        match outcome {
            Ok(ServeOutcome::Drained(_)) => {
                let _ =
                    self.registry
                        .mark_exited(workspace_id, generation, ExitReason::Normal, now_ms);
                self.connections.remove(index);
            }
            Ok(ServeOutcome::Closed) => {
                self.note_crash(workspace_id, generation, now_ms);
                self.connections.remove(index);
            }
            Ok(ServeOutcome::DrainTimedOut { .. }) => {
                // The driver stopped at the deadline; the caller escalates.
            }
            Err(_) => {
                self.note_crash(workspace_id, generation, now_ms);
                self.connections.remove(index);
            }
        }
    }

    /// Ask every live worker in `workspace_id` to drain (§9.3).
    ///
    /// Records the registry deadline, sends the `drain` frame, and returns the
    /// registry's plan. Drivers already draining are left alone. The caller
    /// gathers outcomes with [`HostRuntime::collect_drain_outcomes`] and decides
    /// whether to kill at the deadline.
    pub fn request_drain(
        &mut self,
        workspace_id: &str,
        reason: DrainReason,
        now_ms: u64,
    ) -> Result<DrainPlan, HostError> {
        let generations: Vec<u64> = self
            .connections
            .iter()
            .filter(|connection| connection.driver.identity().workspace_id == workspace_id)
            .map(|connection| connection.driver.identity().worker_generation)
            .collect();
        for generation in generations {
            let Some(index) = self.connection_index(workspace_id, generation) else {
                continue;
            };
            if self.connections[index].driver.drain_state().is_some() {
                continue;
            }
            self.registry
                .request_drain(workspace_id, generation, now_ms, self.config.drain_deadline_ms)?;
            let deadline = now_ms.saturating_add(self.config.drain_deadline_ms);
            let drain_id = format!("drain_{workspace_id}_{generation}");
            self.connections[index]
                .driver
                .initiate_drain(&drain_id, reason, deadline, now_ms)?;
        }
        Ok(self.registry.plan_drain(workspace_id, now_ms, self.config.drain_deadline_ms))
    }

    /// Gather one [`DrainOutcome`] per connection with an active drain.
    ///
    /// `Drained` marks the worker `exited(normal)` and drops the connection;
    /// `TimedOut` keeps it live so the caller can call
    /// [`HostRuntime::kill_worker`]; `Closed` and transport errors mark the
    /// worker crashed.
    pub fn collect_drain_outcomes(&mut self, now_ms: u64) -> Vec<DrainOutcomeRecord> {
        let mut records = Vec::new();
        let mut index = 0;
        while index < self.connections.len() {
            let drain_state = self.connections[index].driver.drain_state().cloned();
            let Some(state) = drain_state else {
                index += 1;
                continue;
            };
            let identity = self.connections[index].driver.identity().clone();
            let mut clock = || now_ms;
            let outcome = self.connections[index]
                .driver
                .await_drain(&mut self.registry, &mut clock);
            let (outcome, terminal) = match outcome {
                Ok(outcome) => {
                    let terminal = match &outcome {
                        DrainOutcome::Drained(_) => {
                            let _ = self.registry.mark_exited(
                                &identity.workspace_id,
                                identity.worker_generation,
                                ExitReason::Normal,
                                now_ms,
                            );
                            true
                        }
                        DrainOutcome::Closed { .. } => {
                            self.note_crash(
                                &identity.workspace_id,
                                identity.worker_generation,
                                now_ms,
                            );
                            true
                        }
                        DrainOutcome::TimedOut { .. } => false,
                    };
                    (outcome, terminal)
                }
                Err(_) => {
                    self.note_crash(&identity.workspace_id, identity.worker_generation, now_ms);
                    (DrainOutcome::Closed { drain_id: state.drain_id.clone() }, true)
                }
            };
            records.push(DrainOutcomeRecord {
                workspace_id: identity.workspace_id.clone(),
                generation: identity.worker_generation,
                connection_id: identity.connection_id,
                drain_id: state.drain_id,
                outcome,
            });
            if terminal {
                self.connections.remove(index);
            } else {
                index += 1;
            }
        }
        records
    }

    /// Force a worker out of the live set and record its terminal reason.
    ///
    /// This is the caller's escalation after a drain deadline (§9.3); the
    /// runtime itself never signals a process.
    pub fn kill_worker(
        &mut self,
        workspace_id: &str,
        generation: u64,
        reason: ExitReason,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        if let Some(index) = self.connection_index(workspace_id, generation) {
            self.connections.remove(index);
        }
        self.registry.mark_exited(workspace_id, generation, reason, now_ms)
    }

    /// Whether a crashed workspace may be respawned (§11.1).
    pub fn rebuild_decision(&self, workspace_id: &str, now_ms: u64) -> RebuildDecision {
        if self.registry.is_paused(workspace_id) {
            return RebuildDecision::Paused;
        }
        match self.restart_at.get(workspace_id) {
            None => RebuildDecision::NotScheduled,
            Some(until_ms) if now_ms < *until_ms => RebuildDecision::Backoff { until_ms: *until_ms },
            Some(_) => RebuildDecision::Allowed,
        }
    }

    /// Spawn a replacement worker when the §11.1 backoff and crash budget
    /// allow it.
    ///
    /// Returns `Ok(None)` while the backoff is still running,
    /// `Err(WorkspacePaused)` when the crash budget paused the workspace, and
    /// `Ok(Some(record))` after allocating the next generation. The old
    /// generation can no longer write: the registry fences it (§1.2).
    pub fn try_restart(
        &mut self,
        workspace_id: &str,
        now_ms: u64,
    ) -> Result<Option<WorkerRecord>, SupervisorError> {
        if self.registry.is_paused(workspace_id) {
            return Err(SupervisorError::WorkspacePaused { workspace_id: workspace_id.to_string() });
        }
        match self.rebuild_decision(workspace_id, now_ms) {
            RebuildDecision::Backoff { .. } => Ok(None),
            RebuildDecision::Paused => {
                Err(SupervisorError::WorkspacePaused { workspace_id: workspace_id.to_string() })
            }
            RebuildDecision::NotScheduled | RebuildDecision::Allowed => {
                let record = self.spawn_worker(workspace_id, now_ms)?;
                self.restart_at.remove(workspace_id);
                Ok(Some(record))
            }
        }
    }

    fn connection_index(&self, workspace_id: &str, generation: u64) -> Option<usize> {
        self.connections.iter().position(|connection| {
            let identity = connection.driver.identity();
            identity.workspace_id == workspace_id && identity.worker_generation == generation
        })
    }

    fn worker_ref(&self, workspace_id: &str, generation: u64) -> Option<WorkerRef> {
        self.registry.get(workspace_id, generation).map(|record| WorkerRef {
            workspace_id: record.workspace_id.clone(),
            worker_id: record.worker_id,
            generation: record.generation,
        })
    }

    /// Record a crash and schedule the §11.1 restart backoff.
    fn note_crash(&mut self, workspace_id: &str, generation: u64, now_ms: u64) {
        if self.registry.mark_crashed(workspace_id, generation, now_ms).is_err() {
            return;
        }
        let streak = {
            let entry = self.crash_streaks.entry(workspace_id.to_string()).or_insert(0);
            *entry = entry.saturating_add(1);
            *entry
        };
        if self.registry.is_paused(workspace_id) {
            self.restart_at.remove(workspace_id);
            return;
        }
        let delay = restart_backoff_with_jitter(streak, self.config.restart_jitter_ms);
        self.restart_at.insert(workspace_id.to_string(), now_ms.saturating_add(delay));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{FrameKind, Header, FLAG_DURABLE, PROTOCOL_VERSION_V0};
    use crate::host_driver::{IncomingRequest, Json, OutgoingResponse};
    use std::cell::{Cell, RefCell};
    use std::io::Cursor;
    use std::rc::Rc;

    const NONCE: &str = "one-time-token";

    /// In-memory transport that keeps written bytes inspectable after the
    /// driver owns the writer.
    #[derive(Debug, Clone, Default)]
    struct SharedSink(Rc<RefCell<Vec<u8>>>);

    impl SharedSink {
        fn bytes(&self) -> Vec<u8> {
            self.0.borrow().clone()
        }
    }

    impl Write for SharedSink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Listener backed by a FIFO of pre-built transports.
    #[derive(Default)]
    struct FakeListener {
        queued: VecDeque<(Cursor<Vec<u8>>, SharedSink)>,
    }

    impl FakeListener {
        fn push(&mut self, input: Vec<u8>) -> SharedSink {
            let sink = SharedSink::default();
            self.queued.push_back((Cursor::new(input), sink.clone()));
            sink
        }
    }

    impl Listener for FakeListener {
        type Reader = Cursor<Vec<u8>>;
        type Writer = SharedSink;

        fn accept(&mut self) -> io::Result<Option<(Self::Reader, Self::Writer)>> {
            Ok(self.queued.pop_front())
        }
    }

    /// Manually advanced logical clock.
    #[derive(Clone)]
    struct ManualClock(Rc<Cell<u64>>);

    impl ManualClock {
        fn new(now_ms: u64) -> Self {
            Self(Rc::new(Cell::new(now_ms)))
        }

        fn set(&self, now_ms: u64) {
            self.0.set(now_ms);
        }
    }

    impl Clock for ManualClock {
        fn now_ms(&mut self) -> u64 {
            self.0.get()
        }
    }

    struct RecordingRouter {
        seen: Vec<IncomingRequest>,
    }

    impl RecordingRouter {
        fn new() -> Self {
            Self { seen: Vec::new() }
        }
    }

    impl RequestRouter for RecordingRouter {
        fn route(&mut self, request: IncomingRequest) -> OutgoingResponse {
            let id = request.id.clone();
            self.seen.push(request);
            OutgoingResponse::ok(id, Json::object(vec![("echo", Json::bool(true))]))
        }
    }

    fn runtime() -> (HostRuntime<FakeListener, ManualClock>, ManualClock) {
        let clock = ManualClock::new(0);
        let runtime =
            HostRuntime::new(FakeListener::default(), clock.clone(), HostRuntimeConfig::default());
        (runtime, clock)
    }

    fn hello_json() -> String {
        format!(
            r#"{{
                "v": 1,
                "kind": "hello",
                "phase": "hello",
                "nonce": "{NONCE}",
                "worker": {{
                    "pid": 12345,
                    "build": "chimera-bun-worker@0.1.0",
                    "runtime": "bun@1.2.3",
                    "boot_id": "boot_1_12345"
                }},
                "protocol": {{ "min": 256, "max": 256 }},
                "encodings": ["json", "msgpack"],
                "compressions": [],
                "capabilities": [
                    "frame.v1", "control.json", "event.batch", "cancel", "drain",
                    "replay.command", "session.runtime"
                ],
                "limits": {{ "max_frame_bytes": 8388608 }},
                "workspace": {{ "directory": "/abs/workspace", "project_id": "prj_test" }},
                "resume": {{ "last_acked_command_sequence": 42, "stream_epoch": "epoch_1" }}
            }}"#
        )
    }

    fn raw_frame(
        kind: FrameKind,
        flags: u16,
        sequence: u64,
        generation: u64,
        connection: u64,
        body: &str,
    ) -> Vec<u8> {
        Header {
            protocol_version: PROTOCOL_VERSION_V0,
            frame_kind: kind,
            flags,
            payload_length: 0,
            connection_id: connection,
            worker_generation: generation,
            sequence,
            correlation_id: [0; 16],
            payload_crc32c: 0,
        }
        .encode(body.as_bytes())
    }

    fn hello_frame() -> Vec<u8> {
        raw_frame(FrameKind::Hello, 0, 1, 0, 0, &hello_json())
    }

    fn ack_hello_frame(generation: u64, connection: u64) -> Vec<u8> {
        raw_frame(
            FrameKind::Ack,
            0,
            2,
            generation,
            connection,
            r#"{"v":1,"kind":"ack","id":"a1","ack_of":"hello","phase":"hello_complete","durable_through_command_sequence":42,"event_seq":null,"replay_complete":false}"#,
        )
    }

    fn handshake_input(generation: u64, connection: u64) -> Vec<u8> {
        let mut input = hello_frame();
        input.extend(ack_hello_frame(generation, connection));
        input
    }

    fn request_frame(sequence: u64, generation: u64, connection: u64, id: &str) -> Vec<u8> {
        let body = format!(
            r#"{{"v":1,"kind":"request","id":"{id}","method":"session.prompt","session_id":"ses_1","job_id":null,"turn_id":"turn_1","deadline_ms":30000,"idempotency_key":null,"params":{{"text":"hi"}},"ext":{{}}}}"#
        );
        raw_frame(FrameKind::Request, 0, sequence, generation, connection, &body)
    }

    fn drain_ack_frame(generation: u64, connection: u64, drain_id: &str) -> Vec<u8> {
        let body = format!(
            r#"{{"v":1,"kind":"ack","id":"a2","ack_of":"{drain_id}","phase":"drained","durable_through_command_sequence":42,"event_seq":null,"replay_complete":false,"active_sessions":3,"interrupted_turns":1}}"#
        );
        raw_frame(FrameKind::Ack, 0, 3, generation, connection, &body)
    }

    fn frames_from(sink: &SharedSink) -> Vec<(Header, Json)> {
        let mut reader = FrameReader::new(Cursor::new(sink.bytes()));
        let mut frames = Vec::new();
        while let Some((header, payload)) = reader.next_frame().expect("output frame") {
            frames.push((
                header,
                Json::parse(std::str::from_utf8(&payload).unwrap()).unwrap(),
            ));
        }
        frames
    }

    #[test]
    fn idle_host_spawns_no_worker_and_does_not_accept() {
        let (mut runtime, _clock) = runtime();
        let outcome = runtime.tick(0);
        assert!(outcome.scanned);
        assert!(outcome.unresponsive.is_empty());
        assert!(runtime.is_idle());
        assert_eq!(runtime.registry().current_generation("ws_test"), 0);
        assert_eq!(runtime.accept_next().unwrap(), None);
        assert!(runtime.is_idle());
    }

    #[test]
    fn multiple_workers_are_admitted_with_isolated_generations() {
        let (mut runtime, clock) = runtime();
        let record_a = runtime.spawn_worker("ws_a", 0).expect("spawn a");
        let record_b = runtime.spawn_worker("ws_b", 0).expect("spawn b");
        assert_eq!(record_a.generation, 1);
        assert_eq!(record_b.generation, 1);
        assert_eq!(runtime.pending_spawn_count(), 2);

        let connection_a = 1;
        let connection_b = 2;
        let mut input_a = handshake_input(record_a.generation, connection_a);
        input_a.extend(request_frame(3, record_a.generation, connection_a, "req_a"));
        runtime.listener.push(input_a);
        runtime.listener.push(handshake_input(record_b.generation, connection_b));

        let admitted_a = runtime.accept_next().unwrap().expect("admit a");
        let admitted_b = runtime.accept_next().unwrap().expect("admit b");
        assert_eq!(admitted_a.workspace_id, "ws_a");
        assert_eq!(admitted_a.generation, 1);
        assert_eq!(admitted_b.workspace_id, "ws_b");
        assert_eq!(admitted_b.generation, 1);
        assert_eq!(runtime.live_connection_count(), 2);
        assert_eq!(runtime.registry().get("ws_a", 1).unwrap().status, WorkerStatus::Ready);
        assert_eq!(runtime.registry().get("ws_b", 1).unwrap().status, WorkerStatus::Ready);

        clock.set(10);
        let mut router = RecordingRouter::new();
        assert_eq!(
            runtime.serve("ws_a", 1, &mut router).expect("serve a"),
            ServeOutcome::Closed
        );
        assert_eq!(router.seen.len(), 1);
        assert_eq!(router.seen[0].method, "session.prompt");

        // ws_a crashed; ws_b is untouched and still owns generation 1.
        assert_eq!(runtime.registry().get("ws_a", 1).unwrap().status, WorkerStatus::Crashed);
        assert_eq!(runtime.registry().get("ws_b", 1).unwrap().status, WorkerStatus::Ready);

        clock.set(20);
        assert_eq!(
            runtime.serve("ws_b", 1, &mut router).expect("serve b"),
            ServeOutcome::Closed
        );
        assert_eq!(router.seen.len(), 1);

        // A respawn allocates generation 2 and the old generation can no longer
        // write (§1.2 fencing).
        clock.set(200);
        let record_a2 = runtime.spawn_worker("ws_a", 200).expect("respawn a");
        assert_eq!(record_a2.generation, 2);
        assert_eq!(runtime.registry().current_generation("ws_a"), 2);
        assert_eq!(runtime.registry().get("ws_b", 1).unwrap().generation, 1);
        assert!(matches!(
            runtime.registry_mut().mark_ready("ws_a", 1, 201),
            Err(SupervisorError::StaleGeneration { .. })
        ));
    }

    #[test]
    fn crash_schedules_backoff_then_allows_rebuild() {
        let (mut runtime, clock) = runtime();
        let record = runtime.spawn_worker("ws_test", 0).expect("spawn");
        runtime.listener.push(handshake_input(record.generation, 1));
        runtime.accept_next().unwrap().expect("admit");

        clock.set(50);
        assert_eq!(
            runtime
                .serve("ws_test", record.generation, &mut RecordingRouter::new())
                .expect("serve"),
            ServeOutcome::Closed
        );
        assert_eq!(runtime.live_connection_count(), 0);
        assert_eq!(
            runtime.registry().get("ws_test", record.generation).unwrap().status,
            WorkerStatus::Crashed
        );

        // First crash: 100ms candidate backoff (§11.1).
        assert_eq!(
            runtime.rebuild_decision("ws_test", 50),
            RebuildDecision::Backoff { until_ms: 150 }
        );
        assert_eq!(runtime.try_restart("ws_test", 149).unwrap(), None);
        assert_eq!(runtime.rebuild_decision("ws_test", 150), RebuildDecision::Allowed);

        let rebuilt = runtime.try_restart("ws_test", 150).unwrap().expect("rebuild");
        assert_eq!(rebuilt.generation, record.generation + 1);
        assert_eq!(runtime.pending_spawn_count(), 1);
        assert_eq!(runtime.rebuild_decision("ws_test", 150), RebuildDecision::NotScheduled);
    }

    #[test]
    fn drain_request_emits_frame_and_collects_ack() {
        let (mut runtime, clock) = runtime();
        let record = runtime.spawn_worker("ws_test", 0).expect("spawn");
        let drain_id = format!("drain_ws_test_{}", record.generation);
        let mut input = handshake_input(record.generation, 1);
        input.extend(drain_ack_frame(record.generation, 1, &drain_id));
        let sink = runtime.listener.push(input);
        runtime.accept_next().unwrap().expect("admit");

        clock.set(1_000);
        let plan = runtime
            .request_drain("ws_test", DrainReason::Restart, 1_000)
            .expect("request drain");
        assert_eq!(plan.targets.len(), 1);
        assert_eq!(plan.deadline_ms, 1_000 + DRAIN_DEADLINE_CANDIDATE_MS);
        assert_eq!(
            runtime.registry().get("ws_test", record.generation).unwrap().status,
            WorkerStatus::Draining
        );

        let frames = frames_from(&sink);
        let drain = frames
            .iter()
            .find(|(header, _)| header.frame_kind == FrameKind::Drain)
            .expect("drain frame");
        assert_eq!(drain.1.get("kind").and_then(Json::as_str), Some("drain"));
        assert_eq!(drain.1.get("reason").and_then(Json::as_str), Some("restart"));
        assert_eq!(
            drain.1.get("deadline_ms").and_then(Json::as_u64),
            Some(DRAIN_DEADLINE_CANDIDATE_MS)
        );
        assert_eq!(drain.1.get("allow_new_requests").and_then(Json::as_bool), Some(false));

        let outcomes = runtime.collect_drain_outcomes(1_000);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].workspace_id, "ws_test");
        assert_eq!(outcomes[0].generation, record.generation);
        assert_eq!(outcomes[0].drain_id, drain_id);
        match &outcomes[0].outcome {
            DrainOutcome::Drained(ack) => {
                assert_eq!(ack.active_sessions, 3);
                assert_eq!(ack.interrupted_turns, 1);
                assert_eq!(ack.ack_of.as_deref(), Some(drain_id.as_str()));
            }
            other => panic!("expected drained, got {other:?}"),
        }
        assert_eq!(runtime.live_connection_count(), 0);
        let exited = runtime.registry().get("ws_test", record.generation).unwrap();
        assert_eq!(exited.status, WorkerStatus::Exited);
        assert_eq!(exited.exit_reason, Some(ExitReason::Normal));
    }

    #[test]
    fn drain_timeout_is_reported_and_left_for_the_caller_to_kill() {
        let (mut runtime, clock) = runtime();
        let record = runtime.spawn_worker("ws_test", 0).expect("spawn");
        runtime.listener.push(handshake_input(record.generation, 1));
        runtime.accept_next().unwrap().expect("admit");

        clock.set(1_000);
        runtime
            .request_drain("ws_test", DrainReason::Shutdown, 1_000)
            .expect("request drain");

        let deadline = 1_000 + DRAIN_DEADLINE_CANDIDATE_MS;
        let outcomes = runtime.collect_drain_outcomes(deadline);
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(outcomes[0].outcome, DrainOutcome::TimedOut { .. }));
        // Still live: the runtime does not kill.
        assert_eq!(runtime.live_connection_count(), 1);

        let tick = runtime.tick(deadline);
        assert_eq!(tick.drain_expired.len(), 1);

        runtime
            .kill_worker("ws_test", record.generation, ExitReason::DrainTimeout, deadline)
            .expect("kill");
        assert_eq!(runtime.live_connection_count(), 0);
        let killed = runtime.registry().get("ws_test", record.generation).unwrap();
        assert_eq!(killed.status, WorkerStatus::Killed);
        assert_eq!(killed.exit_reason, Some(ExitReason::DrainTimeout));
    }

    #[test]
    fn paused_workspace_rejects_new_spawns() {
        let (mut runtime, _clock) = runtime();
        for index in 0..5u64 {
            let record = runtime.spawn_worker("ws_test", index * 1_000).expect("spawn");
            runtime
                .registry_mut()
                .mark_crashed("ws_test", record.generation, index * 1_000 + 1)
                .expect("crash");
        }
        assert!(runtime.registry().is_paused("ws_test"));
        assert_eq!(
            runtime.spawn_worker("ws_test", 10_000),
            Err(SupervisorError::WorkspacePaused { workspace_id: "ws_test".to_string() })
        );
        assert_eq!(
            runtime.try_restart("ws_test", 10_000),
            Err(SupervisorError::WorkspacePaused { workspace_id: "ws_test".to_string() })
        );
        assert_eq!(runtime.rebuild_decision("ws_test", 10_000), RebuildDecision::Paused);
    }

    #[test]
    fn heartbeat_scan_marks_unresponsive_and_reports_due_heartbeats() {
        let (mut runtime, _clock) = runtime();
        let record = runtime.spawn_worker("ws_test", 0).expect("spawn");
        runtime.listener.push(handshake_input(record.generation, 1));
        runtime.accept_next().unwrap().expect("admit");

        let first = runtime.tick(0);
        assert!(first.scanned);
        assert!(first.unresponsive.is_empty());
        assert!(first.heartbeats_due.is_empty());

        // Coalesced by the scan cadence.
        let coalesced = runtime.tick(500);
        assert!(!coalesced.scanned);

        let due = runtime.tick(HEARTBEAT_INTERVAL_MS);
        assert!(due.scanned);
        assert_eq!(due.heartbeats_due.len(), 1);
        assert_eq!(due.heartbeats_due[0].generation, record.generation);
        assert!(due.unresponsive.is_empty());

        let expired = runtime.tick(HEARTBEAT_TIMEOUT_MS);
        assert_eq!(expired.unresponsive.len(), 1);
        assert_eq!(expired.unresponsive[0].workspace_id, "ws_test");
        assert_eq!(
            runtime.registry().get("ws_test", record.generation).unwrap().status,
            WorkerStatus::Unresponsive
        );
        // The runtime does not close the connection.
        assert_eq!(runtime.live_connection_count(), 1);

        // A second scan does not duplicate the unresponsive report.
        let again = runtime.tick(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_SCAN_INTERVAL_MS);
        assert!(again.unresponsive.is_empty());
    }

    #[test]
    fn due_heartbeat_writes_a_transient_ipc_heartbeat_frame() {
        let (mut runtime, _clock) = runtime();
        let record = runtime.spawn_worker("ws_test", 0).expect("spawn");
        let sink = runtime.listener.push(handshake_input(record.generation, 1));
        runtime.accept_next().unwrap().expect("admit");

        // Admission seeds last_heartbeat_sent_ms, so nothing is due at t=0.
        runtime.tick(0);
        let before = frames_from(&sink).len();

        let outcome = runtime.tick(HEARTBEAT_INTERVAL_MS);
        assert_eq!(outcome.heartbeats_due.len(), 1);
        assert!(outcome.heartbeat_send_failures.is_empty());

        let frames = frames_from(&sink);
        assert_eq!(frames.len(), before + 1, "exactly one heartbeat frame");
        let (header, body) = frames.last().expect("heartbeat frame");
        assert_eq!(header.frame_kind, FrameKind::Event);
        assert_eq!(header.flags & FLAG_DURABLE, 0, "heartbeats are transient");
        assert_eq!(body.get("event").and_then(Json::as_str), Some("ipc.heartbeat"));
        assert_eq!(body.get("event_seq"), Some(&Json::Null));
        assert_eq!(
            body.get("transport_sequence").and_then(Json::as_u64),
            Some(header.sequence)
        );
        assert_eq!(
            body.get("payload")
                .and_then(|payload| payload.get("sent_at_ms"))
                .and_then(Json::as_u64),
            Some(HEARTBEAT_INTERVAL_MS)
        );
    }

    #[test]
    fn interleaved_steps_are_deterministic() {
        let (mut runtime, clock) = runtime();
        let record_a = runtime.spawn_worker("ws_a", 0).expect("spawn a");
        let record_b = runtime.spawn_worker("ws_b", 0).expect("spawn b");
        runtime.listener.push(handshake_input(record_a.generation, 1));
        runtime.listener.push(handshake_input(record_b.generation, 2));

        runtime.tick(0);
        runtime.accept_next().unwrap().expect("admit a");
        clock.set(500);
        runtime.tick(500);
        runtime.accept_next().unwrap().expect("admit b");
        clock.set(1_000);
        assert_eq!(
            runtime.serve("ws_a", 1, &mut RecordingRouter::new()).unwrap(),
            ServeOutcome::Closed
        );
        clock.set(1_000);
        assert_eq!(
            runtime.serve("ws_b", 1, &mut RecordingRouter::new()).unwrap(),
            ServeOutcome::Closed
        );

        // Both crashed at the same logical time, so both backoffs land at
        // 1_100 and rebuilds are generation-stable.
        assert_eq!(
            runtime.rebuild_decision("ws_a", 1_099),
            RebuildDecision::Backoff { until_ms: 1_100 }
        );
        assert_eq!(
            runtime.rebuild_decision("ws_b", 1_099),
            RebuildDecision::Backoff { until_ms: 1_100 }
        );
        assert_eq!(runtime.try_restart("ws_a", 1_100).unwrap().unwrap().generation, 2);
        assert_eq!(runtime.try_restart("ws_b", 1_100).unwrap().unwrap().generation, 2);
        assert_eq!(runtime.live_connection_count(), 0);
        assert_eq!(runtime.pending_spawn_count(), 2);
    }
}