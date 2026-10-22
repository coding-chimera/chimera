//! Host process assembly (lib layer, no binary).
//!
//! This module is the last mile between the pure pieces and a future
//! `chimera host` binary. It owns:
//!
//! - [`HostCliConfig`] — kill switches, data root, heartbeat/drain timings,
//!   and candidate worker limits, parsed from an explicit data root plus
//!   environment overrides. It performs **no argv parsing**; the future bin
//!   resolves the data root through the existing graph/data-root helpers and
//!   passes it here.
//! - [`HostPaths`] — `<data-root>/host/ipc/host.sock`, with a `0700` IPC
//!   directory. `.chimera/` and `.codegraph/` are never hard-coded.
//! - [`UnixSocketListener`] — the Unix implementation of
//!   [`Listener`](crate::runtime::Listener): bind, `0600` socket permissions,
//!   and an explicit stale-socket recovery policy.
//! - [`run_host`] — wires [`HostRuntime`] and [`HostStore`] into a
//!   [`HostHandle`] that exposes one bounded [`HostHandle::tick`] at a time.
//!   There is no internal main loop; the future bin chooses the event-loop
//!   shape.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2 (transport) and
//! §12.3 (kill switches). Candidate timings are inherited from
//! [`crate::runtime`] / [`crate::supervisor`] rather than re-derived here.

use std::cell::RefCell;
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::host_driver::{Clock, DurableEvent, HostError, HostEvent, RequestRouter, ServeOutcome};
use crate::runtime::{
    ConnectionServe, HostRuntime, HostRuntimeConfig, Listener, TickOutcome, WorkerRef,
    DRAIN_DEADLINE_CANDIDATE_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_SCAN_INTERVAL_MS,
    RESTART_JITTER_MS,
};
use crate::store::{HostStore, NewHostEvent, StoreError};
use crate::supervisor::HEARTBEAT_TIMEOUT_MS;

/// Environment key for the process-wide host mode (§12.3).
pub const HOST_MODE_ENV: &str = "CHIMERA_HOST_MODE";
/// Environment key for the IPC enforcement mode (§12.3).
pub const HOST_IPC_ENV: &str = "CHIMERA_HOST_IPC";
/// Environment key for the heartbeat cadence.
pub const HEARTBEAT_INTERVAL_ENV: &str = "CHIMERA_HOST_HEARTBEAT_INTERVAL_MS";
/// Environment key for the heartbeat scan cadence.
pub const HEARTBEAT_SCAN_INTERVAL_ENV: &str = "CHIMERA_HOST_HEARTBEAT_SCAN_INTERVAL_MS";
/// Environment key for the heartbeat loss timeout.
pub const HEARTBEAT_TIMEOUT_ENV: &str = "CHIMERA_HOST_HEARTBEAT_TIMEOUT_MS";
/// Environment key for the drain deadline.
pub const DRAIN_DEADLINE_ENV: &str = "CHIMERA_HOST_DRAIN_DEADLINE_MS";
/// Environment key for restart jitter.
pub const RESTART_JITTER_ENV: &str = "CHIMERA_HOST_RESTART_JITTER_MS";
/// Environment key for the candidate soft worker limit.
pub const WORKER_SOFT_LIMIT_ENV: &str = "CHIMERA_HOST_WORKER_SOFT_LIMIT";
/// Environment key for the candidate hard worker limit.
pub const WORKER_HARD_LIMIT_ENV: &str = "CHIMERA_HOST_WORKER_HARD_LIMIT";
/// Environment key for the one-time spawn nonce (§2.2).
pub const HOST_NONCE_ENV: &str = "CHIMERA_HOST_NONCE";

/// Candidate soft worker limit. The admission layer that enforces it is not
/// part of this module; the value is carried for the future bin.
pub const WORKER_SOFT_LIMIT_CANDIDATE: usize = 8;
/// Candidate hard worker limit. Same status as [`WORKER_SOFT_LIMIT_CANDIDATE`].
pub const WORKER_HARD_LIMIT_CANDIDATE: usize = 16;

/// Socket file name under the IPC directory.
pub const SOCKET_FILE_NAME: &str = "host.sock";

/// Process-wide host mode (`CHIMERA_HOST_MODE`, §12.3). Defaults to
/// [`HostMode::Legacy`] until H1 exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostMode {
    /// Existing in-process Bun path. The default.
    Legacy,
    /// Route through the Rust host but keep the legacy path authoritative.
    Proxy,
    /// Rust host is authoritative.
    Rust,
}

impl HostMode {
    /// Wire/config spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            HostMode::Legacy => "legacy",
            HostMode::Proxy => "proxy",
            HostMode::Rust => "rust",
        }
    }

    /// Parse the config spelling. Unknown values are `None`; callers must
    /// turn that into an explicit error, never a silent default.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "legacy" => Some(HostMode::Legacy),
            "proxy" => Some(HostMode::Proxy),
            "rust" => Some(HostMode::Rust),
            _ => None,
        }
    }
}

/// IPC enforcement mode (`CHIMERA_HOST_IPC`, §12.3). Defaults to
/// [`HostIpc::Off`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostIpc {
    /// IPC disabled.
    Off,
    /// Record frames and diffs; results are never authoritative.
    Observe,
    /// IPC results are authoritative.
    Enforce,
}

impl HostIpc {
    /// Wire/config spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            HostIpc::Off => "off",
            HostIpc::Observe => "observe",
            HostIpc::Enforce => "enforce",
        }
    }

    /// Parse the config spelling. Unknown values are `None`; callers must
    /// turn that into an explicit error, never a silent default.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(HostIpc::Off),
            "observe" => Some(HostIpc::Observe),
            "enforce" => Some(HostIpc::Enforce),
            _ => None,
        }
    }
}

/// Host configuration for a future bin.
///
/// Built from an explicit data root (the bin resolves it via the existing
/// graph/data-root helpers) plus optional environment overrides. All timing
/// values are candidate defaults pending H0/H1 calibration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCliConfig {
    /// Project data root. The IPC path is derived from it, never hard-coded.
    pub data_root: PathBuf,
    /// Process-wide host mode.
    pub mode: HostMode,
    /// IPC enforcement mode.
    pub ipc: HostIpc,
    /// Candidate heartbeat cadence (§2.3).
    pub heartbeat_interval_ms: u64,
    /// Candidate heartbeat scan cadence.
    pub heartbeat_scan_interval_ms: u64,
    /// Candidate heartbeat loss timeout (§2.3).
    pub heartbeat_timeout_ms: u64,
    /// Candidate drain deadline (§9.3).
    pub drain_deadline_ms: u64,
    /// Candidate restart jitter (§11.1).
    pub restart_jitter_ms: u64,
    /// Candidate soft worker limit (carried, not enforced here).
    pub worker_soft_limit: usize,
    /// Candidate hard worker limit (carried, not enforced here).
    pub worker_hard_limit: usize,
    /// One-time spawn nonce expected in `hello` (§2.2). `None` disables the
    /// check, which is only appropriate for tests.
    pub expected_nonce: Option<String>,
}

impl HostCliConfig {
    /// Explicit-parameter configuration with every default applied.
    ///
    /// This is the constructor a bin uses before layering its own overrides;
    /// [`HostCliConfig::from_env`] is the environment-driven variant.
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self {
            data_root: data_root.into(),
            mode: HostMode::Legacy,
            ipc: HostIpc::Off,
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            heartbeat_scan_interval_ms: HEARTBEAT_SCAN_INTERVAL_MS,
            heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
            drain_deadline_ms: DRAIN_DEADLINE_CANDIDATE_MS,
            restart_jitter_ms: RESTART_JITTER_MS,
            worker_soft_limit: WORKER_SOFT_LIMIT_CANDIDATE,
            worker_hard_limit: WORKER_HARD_LIMIT_CANDIDATE,
            expected_nonce: None,
        }
    }

    /// Parse the process environment, keeping `data_root` explicit.
    pub fn from_env(data_root: impl Into<PathBuf>) -> Result<Self, HostSetupError> {
        Self::from_lookup(data_root, |key| std::env::var(key).ok())
    }

    /// Parse through an injected lookup, so tests never mutate process env.
    ///
    /// Every present value is validated. A malformed kill switch or number is
    /// an error; missing values keep the default.
    pub fn from_lookup<F>(data_root: impl Into<PathBuf>, lookup: F) -> Result<Self, HostSetupError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut config = Self::new(data_root);

        if let Some(value) = lookup(HOST_MODE_ENV) {
            config.mode = HostMode::parse(&value).ok_or(HostSetupError::UnknownKillSwitch {
                key: HOST_MODE_ENV,
                value,
            })?;
        }
        if let Some(value) = lookup(HOST_IPC_ENV) {
            config.ipc = HostIpc::parse(&value).ok_or(HostSetupError::UnknownKillSwitch {
                key: HOST_IPC_ENV,
                value,
            })?;
        }

        config.heartbeat_interval_ms = parse_u64(
            &lookup,
            HEARTBEAT_INTERVAL_ENV,
            config.heartbeat_interval_ms,
        )?;
        config.heartbeat_scan_interval_ms = parse_u64(
            &lookup,
            HEARTBEAT_SCAN_INTERVAL_ENV,
            config.heartbeat_scan_interval_ms,
        )?;
        config.heartbeat_timeout_ms =
            parse_u64(&lookup, HEARTBEAT_TIMEOUT_ENV, config.heartbeat_timeout_ms)?;
        config.drain_deadline_ms =
            parse_u64(&lookup, DRAIN_DEADLINE_ENV, config.drain_deadline_ms)?;
        config.restart_jitter_ms =
            parse_u64(&lookup, RESTART_JITTER_ENV, config.restart_jitter_ms)?;
        config.worker_soft_limit =
            parse_usize(&lookup, WORKER_SOFT_LIMIT_ENV, config.worker_soft_limit)?;
        config.worker_hard_limit =
            parse_usize(&lookup, WORKER_HARD_LIMIT_ENV, config.worker_hard_limit)?;
        config.expected_nonce = lookup(HOST_NONCE_ENV);

        if config.worker_hard_limit == 0 || config.worker_soft_limit > config.worker_hard_limit {
            return Err(HostSetupError::InvalidWorkerLimits {
                soft: config.worker_soft_limit,
                hard: config.worker_hard_limit,
            });
        }

        Ok(config)
    }

    /// Paths derived from [`HostCliConfig::data_root`].
    pub fn paths(&self) -> HostPaths {
        HostPaths::new(self.data_root.clone())
    }

    /// Convert the timing/nonce fields into the runtime configuration.
    pub fn runtime_config(&self) -> HostRuntimeConfig {
        HostRuntimeConfig {
            heartbeat_interval_ms: self.heartbeat_interval_ms,
            heartbeat_scan_interval_ms: self.heartbeat_scan_interval_ms,
            heartbeat_timeout_ms: self.heartbeat_timeout_ms,
            drain_deadline_ms: self.drain_deadline_ms,
            restart_jitter_ms: self.restart_jitter_ms,
            expected_nonce: self.expected_nonce.clone(),
        }
    }
}

fn parse_u64<F>(lookup: &F, key: &'static str, default: u64) -> Result<u64, HostSetupError>
where
    F: Fn(&str) -> Option<String>,
{
    match lookup(key) {
        None => Ok(default),
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| HostSetupError::InvalidNumber { key, value }),
    }
}

fn parse_usize<F>(lookup: &F, key: &'static str, default: usize) -> Result<usize, HostSetupError>
where
    F: Fn(&str) -> Option<String>,
{
    match lookup(key) {
        None => Ok(default),
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| HostSetupError::InvalidNumber { key, value }),
    }
}

/// Failure while parsing host configuration or preparing the IPC transport.
#[derive(Debug)]
pub enum HostSetupError {
    /// A kill switch carried a value outside its documented enum.
    UnknownKillSwitch {
        /// Environment key that was read.
        key: &'static str,
        /// Value that failed to parse.
        value: String,
    },
    /// A numeric setting failed to parse.
    InvalidNumber {
        /// Environment key that was read.
        key: &'static str,
        /// Value that failed to parse.
        value: String,
    },
    /// Worker limits are inconsistent (hard must be non-zero and cover soft).
    InvalidWorkerLimits {
        /// Requested soft limit.
        soft: usize,
        /// Requested hard limit.
        hard: usize,
    },
    /// The socket path has no parent directory.
    InvalidSocketPath {
        /// Rejected path.
        path: PathBuf,
    },
    /// A non-socket file already occupies the socket path.
    SocketPathNotASocket {
        /// Rejected path.
        path: PathBuf,
    },
    /// A live host already accepts connections on the socket path.
    SocketPathInUse {
        /// Rejected path.
        path: PathBuf,
    },
    /// Filesystem or socket operation failed.
    Io(io::Error),
}

impl fmt::Display for HostSetupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostSetupError::UnknownKillSwitch { key, value } => {
                write!(f, "{key} has unknown value {value:?}")
            }
            HostSetupError::InvalidNumber { key, value } => {
                write!(f, "{key} has invalid numeric value {value:?}")
            }
            HostSetupError::InvalidWorkerLimits { soft, hard } => {
                write!(f, "worker limits are invalid: soft {soft}, hard {hard}")
            }
            HostSetupError::InvalidSocketPath { path } => {
                write!(f, "socket path {} has no parent directory", path.display())
            }
            HostSetupError::SocketPathNotASocket { path } => {
                write!(f, "{} exists and is not a socket", path.display())
            }
            HostSetupError::SocketPathInUse { path } => {
                write!(f, "{} is already served by a live host", path.display())
            }
            HostSetupError::Io(error) => write!(f, "io error: {error}"),
        }
    }
}

impl std::error::Error for HostSetupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            HostSetupError::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for HostSetupError {
    fn from(error: io::Error) -> Self {
        HostSetupError::Io(error)
    }
}

/// Data-root-relative host paths.
///
/// The data root is supplied by the caller; this type never assumes
/// `.chimera/` or `.codegraph/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    data_root: PathBuf,
}

impl HostPaths {
    /// Build paths over an explicit data root.
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self { data_root: data_root.into() }
    }

    /// The supplied data root.
    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    /// `<data-root>/host/ipc`.
    pub fn ipc_dir(&self) -> PathBuf {
        self.data_root.join("host").join("ipc")
    }

    /// `<data-root>/host/ipc/host.sock`.
    pub fn socket_path(&self) -> PathBuf {
        self.ipc_dir().join(SOCKET_FILE_NAME)
    }

    /// Create the IPC directory and enforce `0700` on it.
    ///
    /// Only the dedicated IPC directory is tightened; ancestor directories
    /// keep their existing permissions.
    pub fn ensure_ipc_dir(&self) -> io::Result<()> {
        let dir = self.ipc_dir();
        fs::create_dir_all(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
    }
}

/// Result of probing an existing socket path before bind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketProbe {
    /// Nothing exists at the path.
    Missing,
    /// A live process accepts connections there.
    Live,
    /// A socket file remains but nobody accepts connections.
    Stale,
    /// Something that is not a socket occupies the path.
    NotASocket,
}

/// Action chosen from a [`SocketProbe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketRecovery {
    /// Bind directly.
    Bind,
    /// Remove the stale socket file, then bind.
    RemoveStale,
    /// Refuse: another host owns the path.
    RefuseInUse,
    /// Refuse: never delete an arbitrary file.
    RefuseNotASocket,
}

/// Pure stale-socket policy: only a proven-dead socket is removed, and a
/// non-socket file is never deleted.
pub fn socket_recovery_decision(probe: SocketProbe) -> SocketRecovery {
    match probe {
        SocketProbe::Missing => SocketRecovery::Bind,
        SocketProbe::Stale => SocketRecovery::RemoveStale,
        SocketProbe::Live => SocketRecovery::RefuseInUse,
        SocketProbe::NotASocket => SocketRecovery::RefuseNotASocket,
    }
}

/// Probe a socket path without mutating it.
pub fn probe_socket(path: impl AsRef<Path>) -> Result<SocketProbe, HostSetupError> {
    let path = path.as_ref();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(SocketProbe::Missing),
        Err(error) => return Err(HostSetupError::Io(error)),
    };
    if !metadata.file_type().is_socket() {
        return Ok(SocketProbe::NotASocket);
    }
    match UnixStream::connect(path) {
        Ok(_) => Ok(SocketProbe::Live),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            Ok(SocketProbe::Stale)
        }
        Err(error) => Err(HostSetupError::Io(error)),
    }
}

/// Unix-domain-socket implementation of [`Listener`].
///
/// Bind policy (§2.1): the socket is `0600`; a newly created parent directory
/// is `0700`; a stale socket left by a dead host is removed, while a live
/// socket or a non-socket file is refused. `accept` is non-blocking and
/// returns `Ok(None)` when no connection is queued.
pub struct UnixSocketListener {
    listener: UnixListener,
    path: PathBuf,
}

impl UnixSocketListener {
    /// Bind the listener at `path`.
    pub fn bind(path: impl AsRef<Path>) -> Result<Self, HostSetupError> {
        let path = path.as_ref().to_path_buf();
        let parent = path
            .parent()
            .ok_or_else(|| HostSetupError::InvalidSocketPath { path: path.clone() })?;
        let parent_existed = parent.exists();
        fs::create_dir_all(parent)?;
        if !parent_existed {
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }

        match socket_recovery_decision(probe_socket(&path)?) {
            SocketRecovery::Bind => {}
            SocketRecovery::RemoveStale => fs::remove_file(&path)?,
            SocketRecovery::RefuseInUse => {
                return Err(HostSetupError::SocketPathInUse { path })
            }
            SocketRecovery::RefuseNotASocket => {
                return Err(HostSetupError::SocketPathNotASocket { path })
            }
        }

        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self { listener, path })
    }

    /// Bound socket path.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Listener for UnixSocketListener {
    type Reader = UnixStream;
    type Writer = UnixStream;

    fn accept(&mut self) -> io::Result<Option<(Self::Reader, Self::Writer)>> {
        match self.listener.accept() {
            Ok((stream, _address)) => {
                stream.set_nonblocking(false)?;
                let reader = stream.try_clone()?;
                Ok(Some((reader, stream)))
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// Clock shared between [`HostHandle`] and its [`HostRuntime`].
///
/// The handle is single-threaded by design; the runtime never spawns threads.
pub struct SharedClock<C>(Rc<RefCell<C>>);

impl<C> SharedClock<C> {
    /// Wrap a clock.
    pub fn new(clock: C) -> Self {
        Self(Rc::new(RefCell::new(clock)))
    }
}

impl<C> Clone for SharedClock<C> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

impl<C: Clock> Clock for SharedClock<C> {
    fn now_ms(&mut self) -> u64 {
        self.0.borrow_mut().now_ms()
    }
}

/// One connection handled by [`HostHandle::serve_round`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionReport {
    /// Workspace the connection serves.
    pub workspace_id: String,
    /// Fencing generation of the connection.
    pub generation: u64,
    /// Host-assigned connection id.
    pub connection_id: u64,
    /// How the serve step stopped; `None` when the driver returned an error.
    pub outcome: Option<ServeOutcome>,
    /// Driver error text when the serve step failed.
    pub error: Option<String>,
    /// Durable events committed and acknowledged this round.
    pub durable_committed: usize,
    /// Transient events accepted this round (never stored, §8.2).
    pub transient_accepted: usize,
}

/// Result of one [`HostHandle::serve_round`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServeRound {
    /// One report per connection that was live when the round started.
    pub connections: Vec<ConnectionReport>,
}

/// Driveable host handle returned by [`run_host`].
///
/// It owns the runtime and the durable store. Each call is one bounded step;
/// the future bin owns the loop, signal handling, and worker spawning.
pub struct HostHandle<L: Listener, C: Clock> {
    config: HostCliConfig,
    paths: HostPaths,
    runtime: HostRuntime<L, SharedClock<C>>,
    store: HostStore,
    clock: SharedClock<C>,
}

impl<L: Listener, C: Clock> HostHandle<L, C> {
    /// Configuration the handle was built from.
    pub fn config(&self) -> &HostCliConfig {
        &self.config
    }

    /// Derived data-root paths.
    pub fn paths(&self) -> &HostPaths {
        &self.paths
    }

    /// Host runtime (registry + listener + live drivers).
    pub fn runtime(&self) -> &HostRuntime<L, SharedClock<C>> {
        &self.runtime
    }

    /// Mutable host runtime, for caller-driven spawn/drain/serve steps.
    pub fn runtime_mut(&mut self) -> &mut HostRuntime<L, SharedClock<C>> {
        &mut self.runtime
    }

    /// Durable host-control store.
    pub fn store(&self) -> &HostStore {
        &self.store
    }

    /// Current logical time.
    pub fn now_ms(&mut self) -> u64 {
        self.clock.now_ms()
    }

    /// One bounded maintenance step at the current logical time.
    pub fn tick(&mut self) -> TickOutcome {
        let now_ms = self.clock.now_ms();
        self.runtime.tick(now_ms)
    }

    /// Accept at most one pending worker connection.
    pub fn accept_next(&mut self) -> Result<Option<WorkerRef>, HostError> {
        self.runtime.accept_next()
    }

    /// Serve one bounded round: drive every live connection, commit durable
    /// events, and acknowledge them in commit-before-ack order (§8.2, §8.5).
    ///
    /// For each [`HostEvent::Durable`] the event is appended to `host_event`
    /// first; only a successful append sends `ack(phase=durable_committed)`.
    /// Transient events are accepted without a store write and never acked
    /// (§8.2: transient events need no ack). A store failure is logged to
    /// stderr, leaves the failing event unacknowledged, and is returned to the
    /// caller instead of being swallowed. Driver errors are recorded per
    /// connection; the round continues with the next connection.
    pub fn serve_round<T: RequestRouter>(
        &mut self,
        router: &mut T,
    ) -> Result<ServeRound, StoreError> {
        let mut round = ServeRound::default();
        let now_ms = self.clock.now_ms();
        for (workspace_id, generation) in self.runtime.live_connections() {
            let Some(served) = self.runtime.serve_connection(&workspace_id, generation, router)
            else {
                continue;
            };
            let mut durable_committed = 0;
            let mut transient_accepted = 0;
            for event in &served.events {
                match event {
                    HostEvent::Durable(event) => {
                        let new_event = self.new_host_event(&served, event, now_ms);
                        let appended = match self.store.append_event(&new_event) {
                            Ok(appended) => appended,
                            Err(error) => {
                                let _ = writeln!(
                                    io::stderr(),
                                    "chimera-host: durable event commit failed workspace={} generation={} connection={} event={}: {error}",
                                    served.workspace_id,
                                    served.generation,
                                    served.connection_id,
                                    event.event
                                );
                                return Err(error);
                            }
                        };
                        match self.runtime.acknowledge_durable(
                            &workspace_id,
                            generation,
                            appended.seq as u64,
                        ) {
                            Ok(()) => durable_committed += 1,
                            Err(error) => {
                                let _ = writeln!(
                                    io::stderr(),
                                    "chimera-host: durable ack failed workspace={} generation={} event_seq={}: {error}",
                                    workspace_id, generation, appended.seq
                                );
                            }
                        }
                    }
                    HostEvent::Transient(_) => transient_accepted += 1,
                }
            }
            let error = served.outcome.as_ref().err().map(|error| error.to_string());
            let outcome = served.outcome.as_ref().ok().cloned();
            self.runtime.settle_connection(&workspace_id, generation, &served.outcome);
            round.connections.push(ConnectionReport {
                workspace_id,
                generation,
                connection_id: served.connection_id,
                outcome,
                error,
                durable_committed,
                transient_accepted,
            });
        }
        Ok(round)
    }

    /// Map one durable inbound event onto the `host_event` row (§8.5).
    fn new_host_event(
        &self,
        served: &ConnectionServe,
        event: &DurableEvent,
        now_ms: u64,
    ) -> NewHostEvent {
        let aggregate_id = event
            .session_id
            .clone()
            .or_else(|| event.job_id.clone())
            .unwrap_or_else(|| format!("{}:{}", served.workspace_id, served.generation));
        let event_id = format!(
            "evt_{}_{}_{}_{}",
            served.workspace_id,
            served.generation,
            served.connection_id,
            event.transport_sequence
        );
        let dedupe_key = match event.event_seq {
            Some(seq) => format!("{aggregate_id}:{}:{seq}", event.event),
            None => event_id.clone(),
        };
        NewHostEvent {
            event_id,
            dedupe_key,
            workspace_id: Some(served.workspace_id.clone()),
            project_id: None,
            aggregate_id,
            aggregate_seq: event.event_seq.map(|seq| seq as i64),
            event_type: event.event.clone(),
            worker_id: self
                .runtime
                .registry()
                .get(&served.workspace_id, served.generation)
                .map(|record| record.worker_id.to_string()),
            worker_generation: Some(served.generation as i64),
            payload: event.payload.render(),
            created_at: now_ms as i64,
        }
    }
}

/// Assemble the runtime and store into a tickable handle.
///
/// No loop is started, no directory is created, and no worker is spawned. The
/// caller binds [`UnixSocketListener`] (or another [`Listener`]) first and
/// opens [`HostStore`] against the already-migrated database.
pub fn run_host<L: Listener, C: Clock>(
    config: HostCliConfig,
    listener: L,
    clock: C,
    store: HostStore,
) -> HostHandle<L, C> {
    let paths = config.paths();
    let shared = SharedClock::new(clock);
    let runtime = HostRuntime::new(listener, shared.clone(), config.runtime_config());
    HostHandle { config, paths, runtime, store, clock: shared }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
        move |key| map.get(key).cloned()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("ch-{tag}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn defaults_are_legacy_off_with_candidate_timings() {
        let config = HostCliConfig::from_lookup("/data/root", lookup(&[])).unwrap();
        assert_eq!(config.data_root, PathBuf::from("/data/root"));
        assert_eq!(config.mode, HostMode::Legacy);
        assert_eq!(config.ipc, HostIpc::Off);
        assert_eq!(config.heartbeat_interval_ms, HEARTBEAT_INTERVAL_MS);
        assert_eq!(config.heartbeat_scan_interval_ms, HEARTBEAT_SCAN_INTERVAL_MS);
        assert_eq!(config.heartbeat_timeout_ms, HEARTBEAT_TIMEOUT_MS);
        assert_eq!(config.drain_deadline_ms, DRAIN_DEADLINE_CANDIDATE_MS);
        assert_eq!(config.restart_jitter_ms, RESTART_JITTER_MS);
        assert_eq!(config.worker_soft_limit, WORKER_SOFT_LIMIT_CANDIDATE);
        assert_eq!(config.worker_hard_limit, WORKER_HARD_LIMIT_CANDIDATE);
        assert_eq!(config.expected_nonce, None);
    }

    #[test]
    fn environment_overrides_are_applied() {
        let config = HostCliConfig::from_lookup(
            "/data/root",
            lookup(&[
                (HOST_MODE_ENV, "rust"),
                (HOST_IPC_ENV, "enforce"),
                (HEARTBEAT_INTERVAL_ENV, "2500"),
                (HEARTBEAT_SCAN_INTERVAL_ENV, "250"),
                (HEARTBEAT_TIMEOUT_ENV, "9000"),
                (DRAIN_DEADLINE_ENV, "4000"),
                (RESTART_JITTER_ENV, "125"),
                (WORKER_SOFT_LIMIT_ENV, "3"),
                (WORKER_HARD_LIMIT_ENV, "5"),
                (HOST_NONCE_ENV, "one-time-token"),
            ]),
        )
        .unwrap();
        assert_eq!(config.mode, HostMode::Rust);
        assert_eq!(config.ipc, HostIpc::Enforce);
        assert_eq!(config.heartbeat_interval_ms, 2_500);
        assert_eq!(config.heartbeat_scan_interval_ms, 250);
        assert_eq!(config.heartbeat_timeout_ms, 9_000);
        assert_eq!(config.drain_deadline_ms, 4_000);
        assert_eq!(config.restart_jitter_ms, 125);
        assert_eq!(config.worker_soft_limit, 3);
        assert_eq!(config.worker_hard_limit, 5);
        assert_eq!(config.expected_nonce.as_deref(), Some("one-time-token"));
    }

    #[test]
    fn kill_switch_matrix_parses_every_documented_combination() {
        let modes = [
            ("legacy", HostMode::Legacy),
            ("proxy", HostMode::Proxy),
            ("rust", HostMode::Rust),
        ];
        let ipc_modes = [
            ("off", HostIpc::Off),
            ("observe", HostIpc::Observe),
            ("enforce", HostIpc::Enforce),
        ];
        for (mode_text, mode) in modes {
            for (ipc_text, ipc) in ipc_modes {
                let config = HostCliConfig::from_lookup(
                    "/data/root",
                    lookup(&[(HOST_MODE_ENV, mode_text), (HOST_IPC_ENV, ipc_text)]),
                )
                .unwrap();
                assert_eq!(config.mode, mode);
                assert_eq!(config.ipc, ipc);
                assert_eq!(config.mode.as_str(), mode_text);
                assert_eq!(config.ipc.as_str(), ipc_text);
            }
        }
    }

    #[test]
    fn unknown_kill_switch_values_are_errors_not_defaults() {
        let mode = HostCliConfig::from_lookup("/data/root", lookup(&[(HOST_MODE_ENV, "bogus")]));
        assert!(matches!(
            mode,
            Err(HostSetupError::UnknownKillSwitch { key: HOST_MODE_ENV, .. })
        ));

        let ipc = HostCliConfig::from_lookup("/data/root", lookup(&[(HOST_IPC_ENV, "maybe")]));
        assert!(matches!(
            ipc,
            Err(HostSetupError::UnknownKillSwitch { key: HOST_IPC_ENV, .. })
        ));

        let empty = HostCliConfig::from_lookup("/data/root", lookup(&[(HOST_MODE_ENV, "")]));
        assert!(matches!(empty, Err(HostSetupError::UnknownKillSwitch { .. })));
    }

    #[test]
    fn malformed_numbers_and_limits_are_errors() {
        let number = HostCliConfig::from_lookup(
            "/data/root",
            lookup(&[(DRAIN_DEADLINE_ENV, "soon")]),
        );
        assert!(matches!(
            number,
            Err(HostSetupError::InvalidNumber { key: DRAIN_DEADLINE_ENV, .. })
        ));

        let inverted = HostCliConfig::from_lookup(
            "/data/root",
            lookup(&[(WORKER_SOFT_LIMIT_ENV, "9"), (WORKER_HARD_LIMIT_ENV, "4")]),
        );
        assert!(matches!(
            inverted,
            Err(HostSetupError::InvalidWorkerLimits { soft: 9, hard: 4 })
        ));

        let zero = HostCliConfig::from_lookup(
            "/data/root",
            lookup(&[(WORKER_SOFT_LIMIT_ENV, "0"), (WORKER_HARD_LIMIT_ENV, "0")]),
        );
        assert!(matches!(
            zero,
            Err(HostSetupError::InvalidWorkerLimits { hard: 0, .. })
        ));
    }

    #[test]
    fn runtime_config_carries_timings_and_nonce() {
        let config = HostCliConfig::from_lookup(
            "/data/root",
            lookup(&[
                (HEARTBEAT_INTERVAL_ENV, "111"),
                (DRAIN_DEADLINE_ENV, "222"),
                (HOST_NONCE_ENV, "nonce"),
            ]),
        )
        .unwrap();
        let runtime = config.runtime_config();
        assert_eq!(runtime.heartbeat_interval_ms, 111);
        assert_eq!(runtime.drain_deadline_ms, 222);
        assert_eq!(runtime.expected_nonce.as_deref(), Some("nonce"));
    }

    #[test]
    fn socket_path_is_derived_from_the_data_root() {
        let paths = HostPaths::new("/var/lib/chimera");
        assert_eq!(paths.data_root(), Path::new("/var/lib/chimera"));
        assert_eq!(paths.ipc_dir(), PathBuf::from("/var/lib/chimera/host/ipc"));
        assert_eq!(
            paths.socket_path(),
            PathBuf::from("/var/lib/chimera/host/ipc/host.sock")
        );
        assert!(!paths.socket_path().to_string_lossy().contains(".chimera"));
        assert!(!paths.socket_path().to_string_lossy().contains(".codegraph"));

        let config = HostCliConfig::new("/var/lib/chimera");
        assert_eq!(config.paths().socket_path(), paths.socket_path());
    }

    #[test]
    fn ensure_ipc_dir_creates_0700_directory() {
        let root = temp_dir("paths");
        let paths = HostPaths::new(&root);
        paths.ensure_ipc_dir().unwrap();
        let metadata = fs::metadata(paths.ipc_dir()).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stale_socket_policy_only_removes_dead_sockets() {
        assert_eq!(socket_recovery_decision(SocketProbe::Missing), SocketRecovery::Bind);
        assert_eq!(
            socket_recovery_decision(SocketProbe::Stale),
            SocketRecovery::RemoveStale
        );
        assert_eq!(
            socket_recovery_decision(SocketProbe::Live),
            SocketRecovery::RefuseInUse
        );
        assert_eq!(
            socket_recovery_decision(SocketProbe::NotASocket),
            SocketRecovery::RefuseNotASocket
        );
    }

    #[test]
    fn bind_creates_0600_socket_and_accepts_one_connection() {
        let root = temp_dir("bind");
        let path = root.join("host.sock");
        let mut listener = UnixSocketListener::bind(&path).unwrap();
        assert_eq!(listener.path(), path);
        let metadata = fs::metadata(&path).unwrap();
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let parent = fs::metadata(&root).unwrap();
        assert_eq!(parent.permissions().mode() & 0o777, 0o700);

        // Non-blocking listener with an empty queue.
        assert!(listener.accept().unwrap().is_none());

        let mut client = UnixStream::connect(&path).unwrap();
        let (mut reader, mut writer) = listener.accept().unwrap().expect("accepted");
        client.write_all(b"ping").unwrap();
        let mut buffer = [0u8; 4];
        reader.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"ping");
        writer.write_all(b"pong").unwrap();
        client.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"pong");

        drop(listener);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stale_socket_is_replaced_after_the_old_listener_drops() {
        let root = temp_dir("stale");
        let path = root.join("host.sock");
        let first = UnixSocketListener::bind(&path).unwrap();
        drop(first);
        assert!(path.exists(), "the dropped listener leaves a stale socket file");

        let mut second = UnixSocketListener::bind(&path).unwrap();
        let mut client = UnixStream::connect(&path).unwrap();
        let (mut reader, _writer) = second.accept().unwrap().expect("accepted");
        client.write_all(b"ok").unwrap();
        let mut buffer = [0u8; 2];
        reader.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"ok");

        drop(second);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bind_refuses_a_live_socket() {
        let root = temp_dir("live");
        let path = root.join("host.sock");
        let _first = UnixSocketListener::bind(&path).unwrap();
        let second = UnixSocketListener::bind(&path);
        assert!(matches!(second, Err(HostSetupError::SocketPathInUse { .. })));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bind_refuses_to_delete_a_non_socket_file() {
        let root = temp_dir("not-a-socket");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("host.sock");
        fs::write(&path, b"do not delete me").unwrap();
        let result = UnixSocketListener::bind(&path);
        assert!(matches!(result, Err(HostSetupError::SocketPathNotASocket { .. })));
        assert_eq!(fs::read(&path).unwrap(), b"do not delete me");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn run_host_returns_a_tickable_handle_without_starting_a_loop() {
        let root = temp_dir("run-host");
        let config = HostCliConfig::new(&root);
        let expected_socket = config.paths().socket_path();
        // Bind at a short direct path: the derived IPC path can exceed
        // `sun_path` when the temporary directory is long.
        let path = root.join("h.sock");
        let listener = UnixSocketListener::bind(&path).unwrap();
        let store = HostStore::open_memory().unwrap();
        let mut handle = run_host(config, listener, || 1_000u64, store);

        assert_eq!(handle.paths().socket_path(), expected_socket);
        assert_eq!(handle.now_ms(), 1_000);
        let outcome = handle.tick();
        assert!(outcome.scanned);
        assert!(outcome.unresponsive.is_empty());
        assert!(handle.runtime().is_idle());
        assert_eq!(handle.accept_next().unwrap(), None);

        drop(handle);
        fs::remove_dir_all(&root).unwrap();
    }

    // --- serve_round / commit-before-ack ------------------------------------

    use crate::connection::FrameReader;
    use crate::frame::{FrameKind, Header, FLAG_DURABLE, PROTOCOL_VERSION_V0};
    use crate::host_driver::{IncomingRequest, Json, OutgoingResponse, RequestRouter};
    use std::collections::VecDeque;
    use std::io::Cursor;

    const CONNECTION: u64 = 1;

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

    #[derive(Default)]
    struct TestListener {
        queued: VecDeque<(Cursor<Vec<u8>>, SharedSink)>
    }

    impl TestListener {
        fn push(&mut self, input: Vec<u8>) -> SharedSink {
            let sink = SharedSink::default();
            self.queued.push_back((Cursor::new(input), sink.clone()));
            sink
        }
    }

    impl Listener for TestListener {
        type Reader = Cursor<Vec<u8>>;
        type Writer = SharedSink;

        fn accept(&mut self) -> io::Result<Option<(Self::Reader, Self::Writer)>> {
            Ok(self.queued.pop_front())
        }
    }

    struct EchoRouter;

    impl RequestRouter for EchoRouter {
        fn route(&mut self, request: IncomingRequest) -> OutgoingResponse {
            OutgoingResponse::ok(request.id, Json::object(vec![("echo", Json::bool(true))]))
        }
    }

    fn fixed_clock() -> u64 {
        1_000
    }

    fn raw_frame(
        kind: FrameKind,
        flags: u16,
        sequence: u64,
        generation: u64,
        body: &str,
    ) -> Vec<u8> {
        Header {
            protocol_version: PROTOCOL_VERSION_V0,
            frame_kind: kind,
            flags,
            payload_length: 0,
            connection_id: CONNECTION,
            worker_generation: generation,
            sequence,
            correlation_id: [0; 16],
            payload_crc32c: 0,
        }
        .encode(body.as_bytes())
    }

    fn hello_json() -> String {
        r#"{
            "v": 1,
            "kind": "hello",
            "phase": "hello",
            "nonce": "one-time-token",
            "worker": { "pid": 1, "build": "test", "runtime": "bun", "boot_id": "boot" },
            "protocol": { "min": 256, "max": 256 },
            "encodings": ["json"],
            "compressions": [],
            "capabilities": [
                "frame.v1", "control.json", "event.batch", "cancel", "drain",
                "replay.command", "session.runtime"
            ],
            "limits": { "max_frame_bytes": 8388608 },
            "workspace": { "directory": "/abs/workspace", "project_id": "prj_test" }
        }"#
        .to_string()
    }

    fn handshake_input(generation: u64) -> Vec<u8> {
        let mut input = raw_frame(FrameKind::Hello, 0, 1, 0, &hello_json());
        input.extend(raw_frame(
            FrameKind::Ack,
            0,
            2,
            generation,
            r#"{"v":1,"kind":"ack","id":"a1","ack_of":"hello","phase":"hello_complete","durable_through_command_sequence":42,"event_seq":null,"replay_complete":false}"#,
        ));
        input
    }

    fn event_frame(sequence: u64, generation: u64, durable: bool, body: &str) -> Vec<u8> {
        let flags = if durable { FLAG_DURABLE } else { 0 };
        raw_frame(FrameKind::Event, flags, sequence, generation, body)
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

    /// Real `host_event` schema from the migration, created through rusqlite so
    /// the store's insert path is exercised (the store never migrates).
    fn store_with_event_schema(root: &Path) -> HostStore {
        let db = root.join("host.db");
        {
            let conn = rusqlite::Connection::open(&db).expect("open db");
            conn.execute_batch(
                "CREATE TABLE host_event (
                    seq integer PRIMARY KEY,
                    event_id text NOT NULL UNIQUE,
                    dedupe_key text NOT NULL UNIQUE,
                    workspace_id text,
                    project_id text,
                    aggregate_id text NOT NULL,
                    aggregate_seq integer,
                    type text NOT NULL,
                    worker_id text,
                    worker_generation integer,
                    payload text NOT NULL,
                    created_at integer NOT NULL
                );",
            )
            .expect("create host_event");
        }
        HostStore::open(&db).expect("open store")
    }

    fn durable_event_body() -> &'static str {
        r#"{"v":1,"kind":"event","event":"message.updated","session_id":"ses_1","job_id":null,"turn_id":"turn_1","event_seq":9,"payload":{"a":1}}"#
    }

    fn transient_event_body() -> &'static str {
        r#"{"v":1,"kind":"event","event":"message.part.delta","session_id":"ses_1","turn_id":"turn_1","event_seq":null,"payload":{"delta":"x"}}"#
    }

    #[test]
    fn serve_round_commits_durable_event_then_acks_it() {
        let root = temp_dir("serve-round");
        fs::create_dir_all(&root).unwrap();
        let config = HostCliConfig::new(&root);
        let mut listener = TestListener::default();
        let mut input = handshake_input(1);
        input.extend(event_frame(3, 1, true, durable_event_body()));
        input.extend(event_frame(4, 1, false, transient_event_body()));
        let sink = listener.push(input);
        let store = store_with_event_schema(&root);
        let mut handle = run_host(config, listener, fixed_clock as fn() -> u64, store);

        let record = handle.runtime_mut().spawn_worker("ws_test", 0).expect("spawn");
        assert_eq!(record.generation, 1);
        handle.accept_next().unwrap().expect("admit");

        let mut router = EchoRouter;
        let round = handle.serve_round(&mut router).expect("serve round");
        assert_eq!(round.connections.len(), 1);
        let report = &round.connections[0];
        assert_eq!(report.durable_committed, 1);
        assert_eq!(report.transient_accepted, 1);
        assert_eq!(report.outcome, Some(ServeOutcome::Closed));
        assert_eq!(report.error, None);

        let frames = frames_from(&sink);
        let ack = frames
            .iter()
            .find(|(header, _)| header.frame_kind == FrameKind::Ack)
            .expect("durable ack");
        assert_eq!(ack.1.get("phase").and_then(Json::as_str), Some("durable_committed"));
        assert_eq!(ack.1.get("event_seq").and_then(Json::as_u64), Some(1));
        assert_ne!(ack.0.correlation_id, [0; 16], "ack must carry a correlation id");
        assert_eq!(ack.1.get("id"), ack.1.get("ack_of"));

        drop(handle);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn serve_round_returns_store_error_and_does_not_ack_on_commit_failure() {
        let root = temp_dir("serve-round-fail");
        fs::create_dir_all(&root).unwrap();
        let config = HostCliConfig::new(&root);
        let mut listener = TestListener::default();
        let mut input = handshake_input(1);
        input.extend(event_frame(3, 1, true, durable_event_body()));
        let sink = listener.push(input);
        // No schema: append_event must fail, and no ack may be written.
        let store = HostStore::open_memory().expect("open memory store");
        let mut handle = run_host(config, listener, fixed_clock as fn() -> u64, store);

        handle.runtime_mut().spawn_worker("ws_test", 0).expect("spawn");
        handle.accept_next().unwrap().expect("admit");

        let mut router = EchoRouter;
        let error = handle.serve_round(&mut router).expect_err("commit fails");
        assert!(matches!(error, StoreError::Sqlite(_)));

        let frames = frames_from(&sink);
        assert!(
            frames.iter().all(|(header, _)| header.frame_kind != FrameKind::Ack),
            "commit-before-ack: a failed commit must not emit an ack"
        );

        drop(handle);
        fs::remove_dir_all(&root).unwrap();
    }
}