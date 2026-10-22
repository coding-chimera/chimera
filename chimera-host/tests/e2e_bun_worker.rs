//! Real cross-language end-to-end test for IPC v0.
//!
//! This is the first test that exercises both halves at once: the Rust host
//! (`chimera_host`) and the real Bun worker process (`bun run
//! packages/chimera/src/index.ts bun-worker`). Nothing is mocked:
//!
//! - a real Unix socket is bound through [`UnixSocketListener`];
//! - the worker is spawned as a child process and connects to that socket;
//! - the host runs the real [`run_handshake`] (including the one-time nonce
//!   check from §2.2), sends one `request`, then drains the worker and waits
//!   for it to exit with code 0.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2.3 (connection
//! lifecycle), §5 (bodies), §9.3 (drain exit codes).
//!
//! Every blocking step is bounded by [`STEP_TIMEOUT`] so a misbehaving worker
//! fails the test instead of hanging CI. The worker is expected to exit through
//! the drain path; the cleanup guard only kills it if that normal path failed.

use std::fs::{self, File};
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chimera_host::connection::{FrameReader, FrameWriter};
use chimera_host::frame::{FrameKind, Header, PROTOCOL_VERSION_V0};
use chimera_host::handshake::{HandshakeState, HostConfig};
use chimera_host::host::UnixSocketListener;
use chimera_host::host_driver::{run_handshake, DrainOutcome, DrainReason, Json};
use chimera_host::runtime::Listener;
use chimera_host::supervisor::WorkerRegistry;

/// Candidate per-step timeout. Any step that has not completed within this
/// window fails the test.
const STEP_TIMEOUT: Duration = Duration::from_secs(10);

const WORKSPACE: &str = "ws_e2e";
const CONNECTION_ID: u64 = 1;
const REQUEST_ID: &str = "e2e-request-1";
const REQUEST_METHOD: &str = "test.echo";

/// Copies every byte read from the worker into a shared buffer.
///
/// The host driver consumes the worker's `response` frame while waiting for the
/// drain ack (it treats it as an ignored frame), so the test keeps its own copy
/// of the inbound stream to assert on the stub response body.
struct TeeReader<R> {
    inner: R,
    captured: Arc<Mutex<Vec<u8>>>,
}

impl<R: Read> Read for TeeReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read > 0 {
            self.captured.lock().expect("capture lock").extend_from_slice(&buf[..read]);
        }
        Ok(read)
    }
}

/// Kills a still-running worker and removes the temporary directory on drop.
///
/// The normal path leaves the worker already exited and only removes the
/// directory; the kill is a CI-safety fallback, never the expected exit path.
struct Cleanup {
    child: Option<Child>,
    root: PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_millis() as u64
}

fn unique_root() -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_nanos();
    std::env::temp_dir().join(format!("ch-e2e-{}-{}", std::process::id(), nanos))
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("chimera-host lives directly under the repo root")
        .to_path_buf()
}

/// The Bun CLI package. `bun run` resolves the TypeScript path aliases and the
/// `@opentui/solid` JSX runtime relative to this directory's tsconfig, so the
/// worker is launched from here rather than the repo root.
fn package_dir() -> PathBuf {
    repo_root().join("packages/chimera")
}

fn wait_until<T>(step: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "{step} did not complete within {}s",
            STEP_TIMEOUT.as_secs()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_exit(child: &mut Child, step: &str) -> std::process::ExitStatus {
    wait_until(step, || child.try_wait().expect("poll worker process"))
}

fn read_stderr(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| format!("<could not read {}: {error}>", path.display()))
}

/// Reads every complete frame captured from the worker.
fn captured_frames(captured: &[u8]) -> Vec<(Header, Json)> {
    let mut reader = FrameReader::new(Cursor::new(captured.to_vec()));
    let mut frames = Vec::new();
    while let Some((header, payload)) = reader.next_frame().expect("captured frame parses") {
        frames.push((
            header,
            Json::parse(std::str::from_utf8(&payload).expect("captured body is utf-8"))
                .expect("captured body is JSON"),
        ));
    }
    frames
}

#[test]
fn bun_worker_end_to_end() {
    let root = unique_root();
    fs::create_dir_all(&root).expect("create temp root");
    let mut cleanup = Cleanup { child: None, root: root.clone() };

    // Isolated XDG roots: the worker must never touch the real user config,
    // state, cache, or data directories.
    let xdg = root.join("xdg");
    for dir in ["data", "config", "state", "cache", "home"] {
        fs::create_dir_all(xdg.join(dir)).expect("create isolated XDG directory");
    }
    let home = xdg.join("home");

    let socket_path = root.join("h.sock");
    let workspace_dir = root.join("workspace");
    fs::create_dir_all(&workspace_dir).expect("create workspace directory");

    let mut listener = UnixSocketListener::bind(&socket_path).expect("bind host socket");

    let nonce = format!("e2e-nonce-{}-{}", std::process::id(), now_ms());
    let entry = package_dir().join("src/index.ts");
    let stderr_path = root.join("worker.stderr.log");
    let stderr = File::create(&stderr_path).expect("create worker stderr log");

    let child = Command::new("bun")
        .arg("run")
        .arg(&entry)
        .arg("bun-worker")
        .arg(&workspace_dir)
        .current_dir(package_dir())
        .env("CHIMERA_HOST_SOCKET", &socket_path)
        .env("CHIMERA_WORKER_NONCE", &nonce)
        .env("CHIMERA_WORKSPACE_ID", "prj_e2e")
        .env("XDG_DATA_HOME", xdg.join("data"))
        .env("XDG_CONFIG_HOME", xdg.join("config"))
        .env("XDG_STATE_HOME", xdg.join("state"))
        .env("XDG_CACHE_HOME", xdg.join("cache"))
        .env("HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr))
        .spawn()
        .unwrap_or_else(|error| {
            panic!(
                "failed to spawn the Bun worker with `bun run {} bun-worker {}`: {error}. \
                 This end-to-end test requires a working `bun` on PATH.",
                entry.display(),
                workspace_dir.display()
            )
        });
    cleanup.child = Some(child);

    // Accept the worker's real socket connection.
    let (reader, writer) = wait_until("worker connect", || {
        listener.accept().expect("accept worker connection")
    });
    reader.set_read_timeout(Some(STEP_TIMEOUT)).expect("set read timeout");
    reader.set_write_timeout(Some(STEP_TIMEOUT)).expect("set write timeout");

    let captured = Arc::new(Mutex::new(Vec::new()));
    let tee = TeeReader { inner: reader, captured: Arc::clone(&captured) };

    let now = now_ms();
    let mut registry = WorkerRegistry::new();
    let record = registry.spawn_intent(WORKSPACE, now).expect("spawn intent");
    let mut config = HostConfig::new(CONNECTION_ID, record.generation);
    config.expected_nonce = Some(nonce.clone());

    // Real handshake: hello -> ready -> ack(hello_complete). A nonce mismatch
    // rejects here instead of reaching the request stage.
    let mut driver = run_handshake(
        FrameReader::new(tee),
        FrameWriter::new(writer),
        &mut registry,
        WORKSPACE,
        config,
        now,
    )
    .expect("host/worker handshake completes");
    assert!(
        matches!(driver.handshake_state(), HandshakeState::Ready(_)),
        "handshake must reach the ready state"
    );

    // Send one request through the driver's writer so the send-direction
    // transport sequence stays owned by the driver.
    let body = format!(
        r#"{{"v":1,"kind":"request","id":"{REQUEST_ID}","method":"{REQUEST_METHOD}","session_id":"ses_e2e","job_id":null,"turn_id":"turn_e2e","deadline_ms":10000,"idempotency_key":null,"params":{{}},"ext":{{}}}}"#
    );
    let sequence = driver
        .writer_mut()
        .write_frame(
            Header {
                protocol_version: PROTOCOL_VERSION_V0,
                frame_kind: FrameKind::Request,
                flags: 0,
                payload_length: 0,
                connection_id: CONNECTION_ID,
                worker_generation: record.generation,
                sequence: 0,
                correlation_id: [0x2a; 16],
                payload_crc32c: 0,
            },
            body.as_bytes(),
        )
        .expect("write request frame");
    driver.writer_mut().flush().expect("flush request frame");
    assert_eq!(sequence, 2, "the ready frame owns transport_sequence 1");

    // Drain the worker and wait for its ack. The stub response arrives first
    // and is captured by the tee reader; `await_drain` ignores it.
    let drain_id = format!("drain_{WORKSPACE}_{}", record.generation);
    driver
        .initiate_drain(&drain_id, DrainReason::Shutdown, now + 10_000, now)
        .expect("initiate drain");
    let mut clock = move || now;
    let outcome = driver.await_drain(&mut registry, &mut clock).expect("await drain");
    match outcome {
        DrainOutcome::Drained(ack) => assert_eq!(ack.ack_of.as_deref(), Some(drain_id.as_str())),
        other => panic!("expected the worker to drain cleanly, got {other:?}"),
    }
    assert!(driver.ignored_frames() >= 1, "the stub response frame must have been read");

    // Assert the worker's stub response echoed the request method.
    let frames = captured_frames(&captured.lock().expect("capture lock"));
    let response = frames
        .iter()
        .find(|(header, _)| header.frame_kind == FrameKind::Response)
        .map(|(_, body)| body)
        .expect("worker sent a response frame");
    assert_eq!(response.get("status").and_then(Json::as_str), Some("ok"));
    assert_eq!(response.get("id").and_then(Json::as_str), Some(REQUEST_ID));
    assert_eq!(
        response.get("result").and_then(|result| result.get("method")).and_then(Json::as_str),
        Some(REQUEST_METHOD)
    );

    // The worker must exit through the drain path with code 0.
    let child = cleanup.child.as_mut().expect("worker handle");
    let status = wait_for_exit(child, "worker exit after drain");
    assert!(
        status.success(),
        "worker exited with {status}; stderr:\n{}",
        read_stderr(&stderr_path)
    );
    cleanup.child = None;

    // Normal teardown: drop the driver (closing the socket) and remove the
    // temporary directory.
    drop(driver);
    drop(listener);
    drop(cleanup);
    assert!(!root.exists(), "temporary directory must be removed");
}