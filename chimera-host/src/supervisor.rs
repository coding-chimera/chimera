//! Worker lifecycle supervision state machine.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §1.2 (generation
//! levels), §2.3 (connection lifecycle), §9.3 (drain / exit codes) and §11.1
//! (worker crash recovery); `packages/chimera/specs/rust-host/recovery-matrix.md`
//! §4.2 (worker lifecycle enum) and §5.5 (terminal-state priority).
//!
//! This module is **pure logic**: it spawns no processes, reads no clock, and
//! performs no I/O. Every transition takes the caller's logical timestamp
//! (`now_ms`) so the host loop and tests stay deterministic. Jitter is an
//! explicit input for the same reason — the host computes it, this module only
//! applies it.
//!
//! Two invariants drive every transition:
//!
//! - **Generation fencing (§1.2).** A `(workspace_id, generation)` pair is the
//!   only write credential. A transition addressed at an older generation is
//!   rejected with [`SupervisorError::StaleGeneration`] and never touches the
//!   current worker.
//! - **Terminal states are final (§5.5).** Once a record reaches `exited`,
//!   `crashed`, or `killed`, no later transition may overwrite it — not a
//!   crash sweep, not a duplicate confirmation, not a late frame.
//!
//! Lifecycle (§4.2):
//!
//! ```text
//! spawned → handshaking → ready → busy → draining → exited
//!                      ↘ crashed / killed / unresponsive
//! ```

use std::collections::{HashMap, HashSet};

/// Candidate default restart backoff ladder (§11.1): 100ms, 500ms, 2s, 5s.
pub const RESTART_BACKOFF_MS: [u64; 4] = [100, 500, 2_000, 5_000];

/// Candidate default backoff ceiling (§11.1).
pub const RESTART_BACKOFF_CAP_MS: u64 = 30_000;

/// Candidate default crash budget: 5 crashes within 5 minutes pause a
/// workspace (§11.1).
pub const CRASH_PAUSE_THRESHOLD: usize = 5;

/// Candidate default crash budget window (§11.1): 5 minutes.
pub const CRASH_PAUSE_WINDOW_MS: u64 = 300_000;

/// Candidate default drain deadline before escalating to `SIGTERM` → `SIGKILL`
/// (§9.2/§9.3). This is only the default for
/// [`HostRuntimeConfig`](crate::runtime::HostRuntimeConfig); the registry takes
/// the configured deadline as an explicit argument so the runtime
/// configuration stays the single source of truth.
pub const DRAIN_DEADLINE_MS: u64 = 30_000;

/// Candidate default heartbeat loss timeout: three missed 10s heartbeats
/// (§2.3).
pub const HEARTBEAT_TIMEOUT_MS: u64 = 30_000;

/// Worker lifecycle state (§4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStatus {
    /// Process spawned; no connection yet.
    Spawned,
    /// Connection accepted; `hello`/`ready` negotiation in progress.
    Handshaking,
    /// Handshake complete; the worker may accept requests.
    Ready,
    /// Currently executing at least one request.
    Busy,
    /// Host asked the worker to finish in-flight work and exit.
    Draining,
    /// Exited normally (including a completed drain).
    Exited,
    /// Terminated by a crash, `OOM`, or an inferred failure.
    Crashed,
    /// Host forcibly terminated the worker after a drain deadline.
    Killed,
    /// Heartbeat lost; the host has decided to reclaim but exit is unconfirmed.
    Unresponsive,
}

impl WorkerStatus {
    /// Whether no further transition is allowed (§5.5).
    pub fn is_terminal(&self) -> bool {
        matches!(self, WorkerStatus::Exited | WorkerStatus::Crashed | WorkerStatus::Killed)
    }

    /// Whether the worker is still part of the live set. `unresponsive` is
    /// active: the host has decided to reclaim it but has not confirmed exit.
    pub fn is_active(&self) -> bool {
        !self.is_terminal()
    }

    /// Stable wire/diagnostic name.
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkerStatus::Spawned => "spawned",
            WorkerStatus::Handshaking => "handshaking",
            WorkerStatus::Ready => "ready",
            WorkerStatus::Busy => "busy",
            WorkerStatus::Draining => "draining",
            WorkerStatus::Exited => "exited",
            WorkerStatus::Crashed => "crashed",
            WorkerStatus::Killed => "killed",
            WorkerStatus::Unresponsive => "unresponsive",
        }
    }
}

/// Why a worker left its live state (§4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// Clean exit, including a drain that finished before its deadline.
    Normal,
    /// Drain deadline expired and the worker was forcibly terminated.
    DrainTimeout,
    /// Unexpected termination / connection loss.
    Crash,
    /// Out-of-memory termination.
    Oom,
    /// Host-initiated `SIGTERM` → `SIGKILL`.
    Killed,
    /// Protocol violation that forced the host to close the connection.
    ProtocolError,
}

impl ExitReason {
    /// Stable wire/diagnostic name.
    pub fn as_str(&self) -> &'static str {
        match self {
            ExitReason::Normal => "normal",
            ExitReason::DrainTimeout => "drain_timeout",
            ExitReason::Crash => "crash",
            ExitReason::Oom => "oom",
            ExitReason::Killed => "killed",
            ExitReason::ProtocolError => "protocol_error",
        }
    }
}

/// One worker's supervised record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerRecord {
    /// Registry-assigned, monotonic worker id (distinct from a generation).
    pub worker_id: u64,
    /// Workspace this worker belongs to.
    pub workspace_id: String,
    /// Fencing generation assigned at spawn (§1.2).
    pub generation: u64,
    /// Current lifecycle state.
    pub status: WorkerStatus,
    /// Logical time the spawn intent was recorded.
    pub created_at_ms: u64,
    /// Logical time of the last inbound frame / heartbeat.
    pub last_heartbeat_ms: u64,
    /// Logical time of the last status transition.
    pub last_transition_ms: u64,
    /// Logical time the worker reached `ready`.
    pub ready_at_ms: Option<u64>,
    /// Absolute drain deadline while `draining`.
    pub drain_deadline_ms: Option<u64>,
    /// Logical time the worker reached a terminal state.
    pub exited_at_ms: Option<u64>,
    /// Why the worker reached a terminal state.
    pub exit_reason: Option<ExitReason>,
}

impl WorkerRecord {
    /// Whether the record is terminal.
    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    /// Whether the record is still live.
    pub fn is_active(&self) -> bool {
        self.status.is_active()
    }

    /// Whether the last heartbeat is at least `timeout_ms` old.
    pub fn heartbeat_expired(&self, now_ms: u64, timeout_ms: u64) -> bool {
        !self.is_terminal() && now_ms.saturating_sub(self.last_heartbeat_ms) >= timeout_ms
    }
}

/// Structured rejection from the supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorError {
    /// No worker exists for this workspace/generation.
    UnknownWorker {
        /// Workspace addressed by the caller.
        workspace_id: String,
        /// Generation addressed by the caller.
        generation: u64,
    },
    /// The addressed generation is older than the workspace's current one
    /// (§1.2). The transition was discarded and the current worker untouched.
    StaleGeneration {
        /// Workspace addressed by the caller.
        workspace_id: String,
        /// Generation addressed by the caller.
        generation: u64,
        /// Workspace's current generation.
        current: u64,
    },
    /// The record is already terminal and cannot be overwritten (§5.5).
    TerminalState {
        /// Workspace addressed by the caller.
        workspace_id: String,
        /// Generation addressed by the caller.
        generation: u64,
        /// Terminal status already committed.
        status: WorkerStatus,
    },
    /// The requested edge is not part of the lifecycle graph (§4.2).
    InvalidTransition {
        /// Workspace addressed by the caller.
        workspace_id: String,
        /// Generation addressed by the caller.
        generation: u64,
        /// Current status.
        from: WorkerStatus,
        /// Rejected target status.
        to: WorkerStatus,
    },
    /// The workspace exceeded its crash budget and is paused (§11.1).
    WorkspacePaused {
        /// Paused workspace.
        workspace_id: String,
    },
}

impl core::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SupervisorError::UnknownWorker { workspace_id, generation } => write!(
                f,
                "unknown worker for workspace {workspace_id} generation {generation}"
            ),
            SupervisorError::StaleGeneration { workspace_id, generation, current } => write!(
                f,
                "stale generation for workspace {workspace_id}: addressed {generation}, current {current}"
            ),
            SupervisorError::TerminalState { workspace_id, generation, status } => write!(
                f,
                "workspace {workspace_id} generation {generation} is terminal at {}",
                status.as_str()
            ),
            SupervisorError::InvalidTransition { workspace_id, generation, from, to } => write!(
                f,
                "invalid worker transition for workspace {workspace_id} generation {generation}: {} -> {}",
                from.as_str(),
                to.as_str()
            ),
            SupervisorError::WorkspacePaused { workspace_id } => {
                write!(f, "workspace {workspace_id} is paused after repeated worker crashes")
            }
        }
    }
}

impl std::error::Error for SupervisorError {}

/// One worker selected by a [`DrainPlan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainTarget {
    /// Worker to drain.
    pub worker_id: u64,
    /// Generation of the worker to drain.
    pub generation: u64,
    /// Status at plan time.
    pub status: WorkerStatus,
    /// Absolute deadline for this target.
    pub deadline_ms: u64,
}

/// Drain orchestration decision: which workers to drain, when the plan
/// expires, and which workers escalate to a forced kill after the deadline
/// (§9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainPlan {
    /// Workspace being drained.
    pub workspace_id: String,
    /// Live workers covered by this plan.
    pub targets: Vec<DrainTarget>,
    /// Absolute plan deadline; targets already draining may have earlier
    /// per-target deadlines.
    pub deadline_ms: u64,
}

impl DrainPlan {
    /// Whether the plan covers no workers.
    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    /// Workers to force-kill once `now_ms` has reached the plan deadline.
    /// Before the deadline this is empty; at or after it every target is
    /// escalated.
    pub fn escalate_to_kill(&self, now_ms: u64) -> Vec<DrainTarget> {
        if now_ms >= self.deadline_ms {
            return self.targets.clone();
        }
        Vec::new()
    }
}

/// Per-workspace worker supervisor. Owns generation allocation, lifecycle
/// transitions, crash accounting, and drain planning.
#[derive(Debug, Clone, Default)]
pub struct WorkerRegistry {
    /// Current (highest allocated) generation per workspace.
    generations: HashMap<String, u64>,
    /// Records keyed by `(workspace_id, generation)`; a generation has at most
    /// one record (§4.2).
    workers: HashMap<(String, u64), WorkerRecord>,
    /// Crash timestamps per workspace, used for the crash budget.
    crashes: HashMap<String, Vec<u64>>,
    /// Workspaces paused after exceeding the crash budget.
    paused: HashSet<String>,
    /// Monotonic worker id allocator.
    next_worker_id: u64,
}

impl WorkerRegistry {
    /// An empty registry with no workers or paused workspaces.
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocate a new generation for `workspace_id` and record a spawn intent.
    ///
    /// Returns [`SupervisorError::WorkspacePaused`] when the workspace exceeded
    /// its crash budget; the caller decides whether to fall back to legacy or
    /// surface `503`.
    pub fn spawn_intent(
        &mut self,
        workspace_id: &str,
        now_ms: u64,
    ) -> Result<WorkerRecord, SupervisorError> {
        if self.paused.contains(workspace_id) {
            return Err(SupervisorError::WorkspacePaused { workspace_id: workspace_id.to_string() });
        }
        let generation = {
            let generation = self.generations.entry(workspace_id.to_string()).or_insert(0);
            *generation += 1;
            *generation
        };
        self.next_worker_id = self.next_worker_id.saturating_add(1);
        let record = WorkerRecord {
            worker_id: self.next_worker_id,
            workspace_id: workspace_id.to_string(),
            generation,
            status: WorkerStatus::Spawned,
            created_at_ms: now_ms,
            last_heartbeat_ms: now_ms,
            last_transition_ms: now_ms,
            ready_at_ms: None,
            drain_deadline_ms: None,
            exited_at_ms: None,
            exit_reason: None,
        };
        self.workers.insert((workspace_id.to_string(), generation), record.clone());
        Ok(record)
    }

    /// Move a spawned worker into handshaking. Optional: [`Self::mark_ready`]
    /// also accepts `spawned` for callers that skip the explicit step.
    pub fn mark_handshaking(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.transition(workspace_id, generation, WorkerStatus::Handshaking, now_ms)?;
        Ok(())
    }

    /// Mark the handshake complete.
    pub fn mark_ready(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.transition(workspace_id, generation, WorkerStatus::Ready, now_ms)?;
        let record = self.lookup_mut(workspace_id, generation)?;
        if record.ready_at_ms.is_none() {
            record.ready_at_ms = Some(now_ms);
        }
        Ok(())
    }

    /// Mark the worker busy (at least one in-flight request).
    pub fn mark_busy(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.transition(workspace_id, generation, WorkerStatus::Busy, now_ms)?;
        Ok(())
    }

    /// Return a busy worker to idle (`ready`).
    pub fn mark_idle(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.transition(workspace_id, generation, WorkerStatus::Ready, now_ms)?;
        Ok(())
    }

    /// Ask the worker to drain and record the absolute deadline. Repeated calls
    /// keep the original deadline. `drain_deadline_ms` is the configured
    /// deadline (candidate default [`DRAIN_DEADLINE_MS`]); the registry never
    /// reads a hard-coded value.
    pub fn request_drain(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
        drain_deadline_ms: u64,
    ) -> Result<(), SupervisorError> {
        let previous = self.transition(workspace_id, generation, WorkerStatus::Draining, now_ms)?;
        if previous != WorkerStatus::Draining {
            let record = self.lookup_mut(workspace_id, generation)?;
            record.drain_deadline_ms = Some(now_ms.saturating_add(drain_deadline_ms));
        }
        Ok(())
    }

    /// Record a terminal exit. The status is derived from `reason`:
    /// `killed`/`drain_timeout` → [`WorkerStatus::Killed`], `crash`/`oom` →
    /// [`WorkerStatus::Crashed`], everything else → [`WorkerStatus::Exited`].
    pub fn mark_exited(
        &mut self,
        workspace_id: &str,
        generation: u64,
        reason: ExitReason,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        let status = terminal_status_for(reason);
        self.transition(workspace_id, generation, status, now_ms)?;
        {
            let record = self.lookup_mut(workspace_id, generation)?;
            record.exit_reason = Some(reason);
            record.exited_at_ms = Some(now_ms);
            record.drain_deadline_ms = None;
        }
        if status == WorkerStatus::Crashed {
            self.record_crash(workspace_id, now_ms);
        }
        Ok(())
    }

    /// Record an inferred crash (§11.1). Equivalent to
    /// `mark_exited(..., ExitReason::Crash, ...)`.
    pub fn mark_crashed(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.mark_exited(workspace_id, generation, ExitReason::Crash, now_ms)
    }

    /// Mark a live worker unresponsive after heartbeat loss (§2.3).
    pub fn mark_unresponsive(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        self.transition(workspace_id, generation, WorkerStatus::Unresponsive, now_ms)?;
        Ok(())
    }

    /// Update the heartbeat timestamp for a live worker.
    pub fn record_heartbeat(
        &mut self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), SupervisorError> {
        let record = self.lookup_mut(workspace_id, generation)?;
        if record.status.is_terminal() {
            return Err(SupervisorError::TerminalState {
                workspace_id: workspace_id.to_string(),
                generation,
                status: record.status,
            });
        }
        record.last_heartbeat_ms = now_ms;
        Ok(())
    }

    /// Whether the worker's heartbeat is at least `timeout_ms` old.
    pub fn heartbeat_expired(
        &self,
        workspace_id: &str,
        generation: u64,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Result<bool, SupervisorError> {
        let record = self.lookup(workspace_id, generation)?;
        Ok(record.heartbeat_expired(now_ms, timeout_ms))
    }

    /// This is a read-only planning step: it does not mutate worker state.
    /// Already-draining workers keep their recorded deadline; the plan deadline
    /// is the latest target deadline (or `now_ms + drain_deadline_ms` when the
    /// plan is empty). `drain_deadline_ms` comes from the runtime configuration.
    pub fn plan_drain(
        &self,
        workspace_id: &str,
        now_ms: u64,
        drain_deadline_ms: u64,
    ) -> DrainPlan {
        let targets: Vec<DrainTarget> = self
            .workers
            .values()
            .filter(|record| record.workspace_id == workspace_id && record.is_active())
            .map(|record| DrainTarget {
                worker_id: record.worker_id,
                generation: record.generation,
                status: record.status,
                deadline_ms: record
                    .drain_deadline_ms
                    .unwrap_or_else(|| now_ms.saturating_add(drain_deadline_ms)),
            })
            .collect();
        let deadline_ms = targets
            .iter()
            .map(|target| target.deadline_ms)
            .max()
            .unwrap_or_else(|| now_ms.saturating_add(drain_deadline_ms));
        DrainPlan { workspace_id: workspace_id.to_string(), targets, deadline_ms }
    }

    /// The record for a workspace/generation, if present.
    pub fn get(&self, workspace_id: &str, generation: u64) -> Option<&WorkerRecord> {
        self.workers.get(&(workspace_id.to_string(), generation))
    }

    /// The current (highest allocated) generation for a workspace; `0` when no
    /// worker was ever spawned.
    pub fn current_generation(&self, workspace_id: &str) -> u64 {
        self.generations.get(workspace_id).copied().unwrap_or(0)
    }

    /// Whether the workspace is paused after exceeding its crash budget.
    pub fn is_paused(&self, workspace_id: &str) -> bool {
        self.paused.contains(workspace_id)
    }

    /// Clear a workspace's pause and crash history so the caller can resume
    /// supervision (for example after routing back from legacy).
    pub fn resume_workspace(&mut self, workspace_id: &str) {
        self.paused.remove(workspace_id);
        self.crashes.remove(workspace_id);
    }

    fn transition(
        &mut self,
        workspace_id: &str,
        generation: u64,
        to: WorkerStatus,
        now_ms: u64,
    ) -> Result<WorkerStatus, SupervisorError> {
        let record = self.lookup_mut(workspace_id, generation)?;
        if record.status.is_terminal() {
            return Err(SupervisorError::TerminalState {
                workspace_id: workspace_id.to_string(),
                generation,
                status: record.status,
            });
        }
        let from = record.status;
        if from == to {
            record.last_transition_ms = now_ms;
            return Ok(from);
        }
        if !can_transition(from, to) {
            return Err(SupervisorError::InvalidTransition {
                workspace_id: workspace_id.to_string(),
                generation,
                from,
                to,
            });
        }
        record.status = to;
        record.last_transition_ms = now_ms;
        Ok(from)
    }

    fn lookup(&self, workspace_id: &str, generation: u64) -> Result<&WorkerRecord, SupervisorError> {
        match self.generations.get(workspace_id).copied() {
            Some(current) if generation < current => Err(SupervisorError::StaleGeneration {
                workspace_id: workspace_id.to_string(),
                generation,
                current,
            }),
            Some(current) if generation == current => self
                .workers
                .get(&(workspace_id.to_string(), generation))
                .ok_or_else(|| SupervisorError::UnknownWorker {
                    workspace_id: workspace_id.to_string(),
                    generation,
                }),
            _ => Err(SupervisorError::UnknownWorker {
                workspace_id: workspace_id.to_string(),
                generation,
            }),
        }
    }

    fn lookup_mut(
        &mut self,
        workspace_id: &str,
        generation: u64,
    ) -> Result<&mut WorkerRecord, SupervisorError> {
        match self.generations.get(workspace_id).copied() {
            Some(current) if generation < current => Err(SupervisorError::StaleGeneration {
                workspace_id: workspace_id.to_string(),
                generation,
                current,
            }),
            Some(current) if generation == current => self
                .workers
                .get_mut(&(workspace_id.to_string(), generation))
                .ok_or_else(|| SupervisorError::UnknownWorker {
                    workspace_id: workspace_id.to_string(),
                    generation,
                }),
            _ => Err(SupervisorError::UnknownWorker {
                workspace_id: workspace_id.to_string(),
                generation,
            }),
        }
    }

    fn record_crash(&mut self, workspace_id: &str, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(CRASH_PAUSE_WINDOW_MS);
        let count = {
            let crashes = self.crashes.entry(workspace_id.to_string()).or_default();
            crashes.retain(|timestamp| *timestamp > cutoff);
            crashes.push(now_ms);
            crashes.len()
        };
        if count >= CRASH_PAUSE_THRESHOLD {
            self.paused.insert(workspace_id.to_string());
        }
    }
}

/// Deterministic restart delay for a 1-based crash count (§11.1):
/// `100ms, 500ms, 2s, 5s`, then doubling up to the 30s cap. `0` means no
/// restart is scheduled.
pub fn restart_backoff(crash_count: u32) -> u64 {
    match crash_count {
        0 => 0,
        1 => RESTART_BACKOFF_MS[0],
        2 => RESTART_BACKOFF_MS[1],
        3 => RESTART_BACKOFF_MS[2],
        4 => RESTART_BACKOFF_MS[3],
        5 => RESTART_BACKOFF_MS[3] * 2,
        6 => RESTART_BACKOFF_MS[3] * 4,
        _ => RESTART_BACKOFF_CAP_MS,
    }
}

/// Restart delay plus caller-supplied jitter. The function stays deterministic:
/// the caller owns jitter generation.
pub fn restart_backoff_with_jitter(crash_count: u32, jitter_ms: u64) -> u64 {
    restart_backoff(crash_count).saturating_add(jitter_ms)
}

fn terminal_status_for(reason: ExitReason) -> WorkerStatus {
    match reason {
        // A drain that missed its deadline is forcibly terminated (§9.3).
        ExitReason::DrainTimeout | ExitReason::Killed => WorkerStatus::Killed,
        ExitReason::Crash | ExitReason::Oom => WorkerStatus::Crashed,
        ExitReason::Normal | ExitReason::ProtocolError => WorkerStatus::Exited,
    }
}

fn can_transition(from: WorkerStatus, to: WorkerStatus) -> bool {
    match from {
        WorkerStatus::Spawned => matches!(
            to,
            WorkerStatus::Handshaking
                | WorkerStatus::Ready
                | WorkerStatus::Draining
                | WorkerStatus::Unresponsive
                | WorkerStatus::Exited
                | WorkerStatus::Crashed
                | WorkerStatus::Killed
        ),
        WorkerStatus::Handshaking => matches!(
            to,
            WorkerStatus::Ready
                | WorkerStatus::Draining
                | WorkerStatus::Unresponsive
                | WorkerStatus::Exited
                | WorkerStatus::Crashed
                | WorkerStatus::Killed
        ),
        WorkerStatus::Ready | WorkerStatus::Busy => matches!(
            to,
            WorkerStatus::Ready
                | WorkerStatus::Busy
                | WorkerStatus::Draining
                | WorkerStatus::Unresponsive
                | WorkerStatus::Exited
                | WorkerStatus::Crashed
                | WorkerStatus::Killed
        ),
        WorkerStatus::Draining => matches!(
            to,
            WorkerStatus::Unresponsive
                | WorkerStatus::Exited
                | WorkerStatus::Crashed
                | WorkerStatus::Killed
        ),
        WorkerStatus::Unresponsive => matches!(
            to,
            WorkerStatus::Draining
                | WorkerStatus::Exited
                | WorkerStatus::Crashed
                | WorkerStatus::Killed
        ),
        WorkerStatus::Exited | WorkerStatus::Crashed | WorkerStatus::Killed => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_worker(registry: &mut WorkerRegistry, workspace_id: &str, now_ms: u64) -> u64 {
        let worker = registry.spawn_intent(workspace_id, now_ms).expect("spawn");
        registry.mark_ready(workspace_id, worker.generation, now_ms).expect("ready");
        worker.generation
    }

    #[test]
    fn happy_path_walks_the_full_lifecycle() {
        let mut registry = WorkerRegistry::new();
        let worker = registry.spawn_intent("ws-a", 1_000).expect("spawn");
        assert_eq!(worker.generation, 1);
        assert_eq!(worker.worker_id, 1);
        assert_eq!(worker.status, WorkerStatus::Spawned);
        assert!(worker.is_active());

        registry.mark_handshaking("ws-a", worker.generation, 1_100).expect("handshaking");
        assert_eq!(registry.get("ws-a", 1).unwrap().status, WorkerStatus::Handshaking);

        registry.mark_ready("ws-a", worker.generation, 1_200).expect("ready");
        assert_eq!(registry.get("ws-a", 1).unwrap().ready_at_ms, Some(1_200));

        registry.mark_busy("ws-a", worker.generation, 1_300).expect("busy");
        assert_eq!(registry.get("ws-a", 1).unwrap().status, WorkerStatus::Busy);

        registry.mark_idle("ws-a", worker.generation, 1_400).expect("idle");
        assert_eq!(registry.get("ws-a", 1).unwrap().status, WorkerStatus::Ready);

        registry
            .request_drain("ws-a", worker.generation, 1_500, DRAIN_DEADLINE_MS)
            .expect("drain");
        let draining = registry.get("ws-a", 1).unwrap();
        assert_eq!(draining.status, WorkerStatus::Draining);
        assert_eq!(draining.drain_deadline_ms, Some(1_500 + DRAIN_DEADLINE_MS));

        registry
            .mark_exited("ws-a", worker.generation, ExitReason::Normal, 1_600)
            .expect("exit");
        let exited = registry.get("ws-a", 1).unwrap();
        assert_eq!(exited.status, WorkerStatus::Exited);
        assert_eq!(exited.exit_reason, Some(ExitReason::Normal));
        assert_eq!(exited.exited_at_ms, Some(1_600));
        assert_eq!(exited.drain_deadline_ms, None);
        assert!(exited.is_terminal());
        assert!(!exited.is_active());
        assert_eq!(WorkerStatus::Exited.as_str(), "exited");
        assert_eq!(ExitReason::Normal.as_str(), "normal");
    }

    #[test]
    fn stale_generation_writes_are_rejected_without_touching_the_new_worker() {
        let mut registry = WorkerRegistry::new();
        let first = registry.spawn_intent("ws-a", 0).expect("first spawn");
        registry.mark_ready("ws-a", first.generation, 10).expect("ready");

        let second = registry.spawn_intent("ws-a", 20).expect("second spawn");
        assert_eq!(second.generation, first.generation + 1);

        let err = registry.mark_ready("ws-a", first.generation, 30).unwrap_err();
        assert_eq!(
            err,
            SupervisorError::StaleGeneration {
                workspace_id: "ws-a".to_string(),
                generation: first.generation,
                current: second.generation,
            }
        );

        let err = registry
            .mark_exited("ws-a", first.generation, ExitReason::Crash, 40)
            .unwrap_err();
        assert!(matches!(err, SupervisorError::StaleGeneration { .. }));

        // The old record is untouched and the new generation is unaffected.
        assert_eq!(registry.get("ws-a", first.generation).unwrap().status, WorkerStatus::Ready);
        assert_eq!(registry.get("ws-a", second.generation).unwrap().status, WorkerStatus::Spawned);
    }

    #[test]
    fn terminal_states_cannot_be_overwritten() {
        let mut registry = WorkerRegistry::new();
        let generation = ready_worker(&mut registry, "ws-a", 0);
        registry
            .mark_exited("ws-a", generation, ExitReason::Normal, 10)
            .expect("exit");

        for result in [
            registry.mark_crashed("ws-a", generation, 20),
            registry.mark_ready("ws-a", generation, 30),
            registry.request_drain("ws-a", generation, 40, DRAIN_DEADLINE_MS),
            registry.mark_exited("ws-a", generation, ExitReason::Killed, 50),
        ] {
            assert!(matches!(
                result,
                Err(SupervisorError::TerminalState {
                    status: WorkerStatus::Exited,
                    ..
                })
            ));
        }

        let record = registry.get("ws-a", generation).unwrap();
        assert_eq!(record.status, WorkerStatus::Exited);
        assert_eq!(record.exit_reason, Some(ExitReason::Normal));
        assert_eq!(record.exited_at_ms, Some(10));
    }

    #[test]
    fn exit_reason_maps_to_the_expected_terminal_status() {
        let cases = [
            (ExitReason::Normal, WorkerStatus::Exited),
            (ExitReason::DrainTimeout, WorkerStatus::Killed),
            (ExitReason::Crash, WorkerStatus::Crashed),
            (ExitReason::Oom, WorkerStatus::Crashed),
            (ExitReason::Killed, WorkerStatus::Killed),
            (ExitReason::ProtocolError, WorkerStatus::Exited),
        ];
        for (reason, expected) in cases {
            let mut registry = WorkerRegistry::new();
            let generation = ready_worker(&mut registry, "ws-a", 0);
            registry.mark_exited("ws-a", generation, reason, 10).expect("exit");
            assert_eq!(registry.get("ws-a", generation).unwrap().status, expected);
        }
    }

    #[test]
    fn drain_plan_escalates_to_kill_at_the_deadline() {
        let mut registry = WorkerRegistry::new();
        let worker = registry.spawn_intent("ws-a", 0).expect("spawn");
        registry.mark_ready("ws-a", worker.generation, 10).expect("ready");

        let plan = registry.plan_drain("ws-a", 1_000, DRAIN_DEADLINE_MS);
        assert_eq!(plan.targets.len(), 1);
        assert_eq!(plan.targets[0].worker_id, worker.worker_id);
        assert_eq!(plan.deadline_ms, 1_000 + DRAIN_DEADLINE_MS);
        assert!(plan.escalate_to_kill(plan.deadline_ms - 1).is_empty());
        let escalated = plan.escalate_to_kill(plan.deadline_ms);
        assert_eq!(escalated.len(), 1);
        assert_eq!(escalated[0].generation, worker.generation);

        // An explicit drain keeps its original deadline across re-planning.
        registry
            .request_drain("ws-a", worker.generation, 2_000, DRAIN_DEADLINE_MS)
            .expect("drain");
        let replanned = registry.plan_drain("ws-a", 5_000, DRAIN_DEADLINE_MS);
        assert_eq!(replanned.deadline_ms, 2_000 + DRAIN_DEADLINE_MS);
        assert_eq!(replanned.targets[0].status, WorkerStatus::Draining);
    }

    #[test]
    fn drain_deadline_is_an_explicit_input_not_a_hard_coded_constant() {
        let mut registry = WorkerRegistry::new();
        let generation = ready_worker(&mut registry, "ws-a", 0);

        // The configured deadline is the only source: 250ms here, not 30s.
        registry.request_drain("ws-a", generation, 1_000, 250).expect("drain");
        assert_eq!(
            registry.get("ws-a", generation).unwrap().drain_deadline_ms,
            Some(1_250)
        );

        // A re-plan keeps the recorded deadline even with another configured value.
        let replanned = registry.plan_drain("ws-a", 5_000, 9_000);
        assert_eq!(replanned.deadline_ms, 1_250);

        // A fresh worker's plan uses the deadline passed by the caller.
        let mut other = WorkerRegistry::new();
        ready_worker(&mut other, "ws-b", 0);
        let plan = other.plan_drain("ws-b", 2_000, 250);
        assert_eq!(plan.deadline_ms, 2_250);
    }

    #[test]
    fn restart_backoff_follows_the_ladder_and_caps() {
        assert_eq!(restart_backoff(0), 0);
        assert_eq!(restart_backoff(1), 100);
        assert_eq!(restart_backoff(2), 500);
        assert_eq!(restart_backoff(3), 2_000);
        assert_eq!(restart_backoff(4), 5_000);
        assert_eq!(restart_backoff(5), 10_000);
        assert_eq!(restart_backoff(6), 20_000);
        assert_eq!(restart_backoff(7), RESTART_BACKOFF_CAP_MS);
        assert_eq!(restart_backoff(u32::MAX), RESTART_BACKOFF_CAP_MS);

        assert_eq!(restart_backoff_with_jitter(1, 37), 137);
        assert_eq!(restart_backoff_with_jitter(7, 250), 30_250);
    }

    #[test]
    fn crash_budget_pauses_the_workspace_at_the_threshold() {
        let mut registry = WorkerRegistry::new();
        for index in 0..4u64 {
            let generation = registry
                .spawn_intent("ws-a", index * 1_000)
                .expect("spawn")
                .generation;
            registry.mark_crashed("ws-a", generation, index * 1_000 + 1).expect("crash");
        }
        assert!(!registry.is_paused("ws-a"));

        let generation = registry.spawn_intent("ws-a", 10_000).expect("spawn").generation;
        registry.mark_crashed("ws-a", generation, 10_001).expect("crash");
        assert!(registry.is_paused("ws-a"));

        assert_eq!(
            registry.spawn_intent("ws-a", 20_000),
            Err(SupervisorError::WorkspacePaused { workspace_id: "ws-a".to_string() })
        );

        registry.resume_workspace("ws-a");
        assert!(!registry.is_paused("ws-a"));
        let resumed = registry.spawn_intent("ws-a", 30_000).expect("spawn after resume");
        assert_eq!(resumed.generation, 6);
    }

    #[test]
    fn crash_budget_only_counts_crashes_inside_the_window() {
        let mut registry = WorkerRegistry::new();
        for index in 0..4u64 {
            let generation = registry
                .spawn_intent("ws-a", index * 1_000)
                .expect("spawn")
                .generation;
            registry.mark_crashed("ws-a", generation, index * 1_000 + 1).expect("crash");
        }
        // A crash after the 5-minute window prunes the earlier ones.
        let generation = registry.spawn_intent("ws-a", 400_000).expect("spawn").generation;
        registry.mark_crashed("ws-a", generation, 400_001).expect("crash");
        assert!(!registry.is_paused("ws-a"));
    }

    #[test]
    fn workspaces_are_isolated_for_generations_and_crash_budgets() {
        let mut registry = WorkerRegistry::new();

        for index in 0..5u64 {
            let generation = registry
                .spawn_intent("ws-a", index * 1_000)
                .expect("spawn a")
                .generation;
            registry.mark_crashed("ws-a", generation, index * 1_000 + 1).expect("crash a");
        }
        assert!(registry.is_paused("ws-a"));

        // ws-b is unaffected and allocates its own generation series.
        let generation_b = registry.spawn_intent("ws-b", 100).expect("spawn b").generation;
        assert_eq!(generation_b, 1);
        assert!(!registry.is_paused("ws-b"));

        for index in 0..4u64 {
            let generation = registry
                .spawn_intent("ws-b", 200 + index * 1_000)
                .expect("spawn b")
                .generation;
            registry.mark_crashed("ws-b", generation, 201 + index * 1_000).expect("crash b");
        }
        assert!(!registry.is_paused("ws-b"));
        assert!(registry.is_paused("ws-a"));
        assert_eq!(registry.current_generation("ws-a"), 5);
        assert_eq!(registry.current_generation("ws-b"), 5);
    }
}