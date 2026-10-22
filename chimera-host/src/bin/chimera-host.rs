//! `chimera-host` — standalone host process for the Rust host migration (H1).
//!
//! Usage:
//!
//! ```text
//! chimera-host <data-root> [--db <sqlite-path>] [--worker <n> --worker-cmd <cmd...>]
//! ```
//!
//! `<data-root>` is the project data root. The IPC directory and socket are
//! derived from it by [`HostCliConfig::paths`] (`<data-root>/host/ipc/host.sock`);
//! `.chimera/` and `.codegraph/` are never hard-coded here. All timings, kill
//! switches, and the spawn nonce come from [`HostCliConfig::from_env`].
//!
//! # Event loop
//!
//! [`run_host`] deliberately has no internal main loop, so this bin owns one:
//! each iteration accepts at most one pending worker connection, runs one
//! bounded `serve_round` over every live connection, runs one bounded `tick`,
//! then sleeps [`POLL_INTERVAL`]. The loop is single-threaded and adds no async
//! runtime.
//!
//! # Worker spawning
//!
//! With `--worker <n> --worker-cmd <cmd...>` the bin registers `n` spawn
//! intents on the runtime (`HostRuntime::spawn_worker`) and starts one child
//! process per intent. The host is the worker's parent, matching the production
//! topology. Children inherit the host environment plus `CHIMERA_HOST_SOCKET`
//! and `CHIMERA_WORKER_NONCE`.
//!
//! The bin only **reaps** children: every loop iteration calls `try_wait` and
//! logs one stderr line per exited worker. It does not monitor worker liveness,
//! escalate unresponsive workers, or restart crashed ones — restart/backoff is
//! the supervisor's job and this bin stays thin.
//!
//! # Nonce
//!
//! If `CHIMERA_HOST_NONCE` is set, [`HostCliConfig::from_env`] already carries
//! it and the same value is handed to every child. Otherwise, when at least one
//! worker is requested, the bin reads 16 bytes from `/dev/urandom`, hex-encodes
//! them, stores the value as `config.expected_nonce`, and passes it to the
//! children. This avoids a `rand` dependency.
//!
//! # Signals (intentional H1 limitation)
//!
//! There is no signal handling: `SIGTERM`/`SIGINT` terminate the process through
//! the default disposition. Graceful drain (§9.3) is exercised by the
//! cross-language e2e test, and production signal handling is a later
//! milestone — adding `signal-hook`/`tokio` here would expand the dependency
//! surface this milestone deliberately keeps at zero.
//!
//! # Default database path (candidate)
//!
//! The canonical main DB path is computed in
//! `packages/chimera/src/storage/db.ts` from the XDG data directory, the
//! installation channel, and `OPENCODE_DB`; none of those are derivable from
//! `<data-root>` alone, so this bin cannot replicate that rule. When `--db` is
//! omitted the default is the **candidate** path `<data-root>/host/host.db`,
//! pending a shared path resolver. Pass `--db` to point at the real main
//! database.
//!
//! [`HostCliConfig::paths`]: chimera_host::host::HostCliConfig::paths
//! [`run_host`]: chimera_host::host::run_host

#![forbid(unsafe_code)]

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chimera_host::host::{run_host, HostCliConfig, UnixSocketListener};
use chimera_host::host_driver::{IncomingRequest, OutgoingResponse, RequestRouter};
use chimera_host::store::HostStore;


/// Main-loop poll interval. The listener is non-blocking and `tick` is bounded,
/// so this only sets the maintenance/accept/reap cadence.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

const USAGE: &str =
    "usage: chimera-host <data-root> [--db <sqlite-path>] [--worker <n> --worker-cmd <cmd...>]";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr(), "chimera-host: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Parsed argv. Parsing is hand-written to keep the crate dependency-free.
struct Args {
    data_root: PathBuf,
    db_path: Option<PathBuf>,
    /// `None` when `--worker` was not given.
    workers: Option<usize>,
    /// Remaining argv after `--worker-cmd`; `None` when the flag was absent.
    worker_cmd: Option<Vec<String>>,
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut data_root = None;
    let mut db_path = None;
    let mut workers = None;
    let mut worker_cmd = None;

    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--db" => {
                let value = argv.next().ok_or_else(|| format!("--db requires a path\n{USAGE}"))?;
                db_path = Some(PathBuf::from(value));
            }
            "--worker" => {
                let value = argv.next().ok_or_else(|| format!("--worker requires a count\n{USAGE}"))?;
                let count = value
                    .parse::<usize>()
                    .map_err(|_| format!("--worker expects a non-negative integer, got {value:?}\n{USAGE}"))?;
                workers = Some(count);
            }
            "--worker-cmd" => {
                // Everything after this flag is the worker command line, so it
                // must be the last host option.
                let command: Vec<String> = argv.collect();
                if command.is_empty() {
                    return Err(format!("--worker-cmd requires a command\n{USAGE}"));
                }
                worker_cmd = Some(command);
                break;
            }
            "--help" | "-h" => return Err(USAGE.to_string()),
            flag if flag.starts_with("--db=") => {
                db_path = Some(PathBuf::from(&flag["--db=".len()..]));
            }
            flag if flag.starts_with("--worker=") => {
                let value = &flag["--worker=".len()..];
                let count = value
                    .parse::<usize>()
                    .map_err(|_| format!("--worker expects a non-negative integer, got {value:?}\n{USAGE}"))?;
                workers = Some(count);
            }
            flag if flag.starts_with('-') => {
                return Err(format!("unknown flag {flag:?}\n{USAGE}"));
            }
            value => {
                if data_root.replace(PathBuf::from(value)).is_some() {
                    return Err(format!("data root given more than once\n{USAGE}"));
                }
            }
        }
    }

    let data_root = data_root.ok_or_else(|| format!("missing <data-root>\n{USAGE}"))?;
    match (workers, worker_cmd.is_some()) {
        (Some(count), true) => Ok(Args { data_root, db_path, workers: Some(count), worker_cmd }),
        (Some(_), false) => Err(format!("--worker requires --worker-cmd\n{USAGE}")),
        (None, true) => Err(format!("--worker-cmd requires --worker\n{USAGE}")),
        (None, false) => Ok(Args { data_root, db_path, workers: None, worker_cmd: None }),
    }
}

/// Workspace id for worker `index` out of `workers`.
///
/// A single worker uses `"default"`; multiple workers use `"default-1"` ..
/// `"default-<n>"` so each worker owns an isolated registry slot (the
/// supervisor fences generations per workspace).
fn workspace_id(workers: usize, index: usize) -> String {
    if workers == 1 {
        "default".to_string()
    } else {
        format!("default-{}", index + 1)
    }
}

/// Candidate default database path. See the module docs for why the canonical
/// `packages/chimera/src/storage/db.ts` rule cannot be reproduced here.
fn default_db_path(data_root: &Path) -> PathBuf {
    data_root.join("host").join("host.db")
}

/// 16 random bytes from `/dev/urandom`, hex-encoded (32 characters).
///
/// Both Linux and macOS provide the device, so this keeps the zero-dependency
/// constraint instead of pulling in `rand`.
fn random_nonce() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// H1 placeholder router. Request routing to workers is a later milestone, so
/// every request is refused explicitly instead of being silently dropped.
struct Unrouted;

impl RequestRouter for Unrouted {
    fn route(&mut self, request: IncomingRequest) -> OutgoingResponse {
        OutgoingResponse::error(
            request.id,
            "not_implemented",
            "host",
            false,
            "request routing is not wired in the H1 host bin",
        )
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Stop children started before a later startup failure so a failed launch does
/// not leave orphans behind.
fn kill_children(children: &mut [Child]) {
    for child in children {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn run() -> Result<(), String> {
    let args = parse_args(env::args().skip(1))?;

    let mut config = HostCliConfig::from_env(&args.data_root)
        .map_err(|error| format!("invalid host configuration: {error}"))?;

    // Reuse the env-provided nonce, or mint one when workers are requested.
    let nonce = match config.expected_nonce.clone() {
        Some(nonce) => Some(nonce),
        None if args.workers.unwrap_or(0) > 0 => {
            let nonce = random_nonce()
                .map_err(|error| format!("cannot read /dev/urandom for the worker nonce: {error}"))?;
            config.expected_nonce = Some(nonce.clone());
            Some(nonce)
        }
        None => None,
    };

    let paths = config.paths();
    paths
        .ensure_ipc_dir()
        .map_err(|error| format!("cannot prepare IPC directory {}: {error}", paths.ipc_dir().display()))?;

    let listener = UnixSocketListener::bind(paths.socket_path()).map_err(|error| {
        format!("cannot bind socket {}: {error}", paths.socket_path().display())
    })?;

    let db_path = args.db_path.unwrap_or_else(|| default_db_path(config.data_root.as_path()));
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create database directory {}: {error}", parent.display()))?;
    }
    let store = HostStore::open(&db_path)
        .map_err(|error| format!("cannot open database {}: {error}", db_path.display()))?;

    let mut handle = run_host(config, listener, now_ms, store);

    // Register spawn intents first, then start one child per intent. Intents
    // must exist before the accept loop runs: `accept_next` is a no-op while
    // the pending queue is empty.
    let mut children: Vec<Child> = Vec::new();
    if let (Some(workers), Some(command)) = (args.workers, args.worker_cmd.as_ref()) {
        let now = handle.now_ms();
        // Requesting workers above guarantees a nonce: either the env-provided
        // one or the generated one stored on the config.
        let worker_nonce = nonce.clone().unwrap_or_default();
        for index in 0..workers {
            let workspace = workspace_id(workers, index);
            if let Err(error) = handle.runtime_mut().spawn_worker(&workspace, now) {
                kill_children(&mut children);
                return Err(format!("cannot register spawn intent for workspace {workspace}: {error}"));
            }
            let child = match Command::new(&command[0])
                .args(&command[1..])
                .env("CHIMERA_HOST_SOCKET", paths.socket_path())
                .env("CHIMERA_WORKER_NONCE", &worker_nonce)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    kill_children(&mut children);
                    return Err(format!(
                        "cannot spawn worker {workspace} with {:?}: {error}",
                        command[0]
                    ));
                }
            };
            let _ = writeln!(
                io::stderr(),
                "chimera-host worker workspace={workspace} pid={}",
                child.id()
            );
            children.push(child);
        }
    }

    // One structured startup line on stderr, then silence.
    let _ = writeln!(
        io::stderr(),
        "chimera-host started socket={} db={} pid={} mode={} ipc={} workers={}",
        paths.socket_path().display(),
        db_path.display(),
        std::process::id(),
        handle.config().mode.as_str(),
        handle.config().ipc.as_str(),
        children.len(),
    );


    let mut router = Unrouted;
    loop {
        match handle.accept_next() {
            Ok(_) => {}
            // A failed handshake already recorded the worker's protocol exit;
            // the host itself keeps serving.
            Err(error) => {
                let _ = writeln!(io::stderr(), "chimera-host: accept failed: {error}");
            }
        }
        // One bounded serve step per live connection (H2 Step 0): a step
        // returns `Idle` instead of blocking accept/tick/reap until the
        // connection closes, and a per-connection store error does not abort
        // the round.
        if let Err(error) = handle.serve_round(&mut router) {
            let _ = writeln!(io::stderr(), "chimera-host: serve round failed: {error}");
        }

        // Escalation for unresponsive/drain-expired workers is a later
        // milestone; the tick is still required to run the heartbeat scan.
        let _ = handle.tick();

        // Reap exited workers so the host never accumulates zombies. Restart
        // orchestration is deliberately out of scope for this bin.
        children.retain_mut(|child| match child.try_wait() {
            Ok(Some(status)) => {
                let _ = writeln!(io::stderr(), "chimera-host worker pid={} exited {status}", child.id());
                false
            }
            Ok(None) => true,
            Err(error) => {
                let _ = writeln!(
                    io::stderr(),
                    "chimera-host worker pid={} wait failed: {error}",
                    child.id()
                );
                false
            }
        });

        std::thread::sleep(POLL_INTERVAL);
    }
}