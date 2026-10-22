//! IPC v0 handshake and capability negotiation.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §2.3 (connection
//! lifecycle), §5.1 (`hello`/`ready` envelopes), §6 (version/capability
//! negotiation and explicit rejection) and §10 (error classification).
//!
//! This module operates on **already-decoded** `hello`/`ready` bodies. Canonical
//! JSON envelope encode/decode — the `kind`/`phase` tags, the body `v` field
//! versioning, and the outer frame — belongs to the connection layer. The crate
//! stays dependency-free: no JSON parser lives here, and tests construct the
//! structs directly.
//!
//! Lifecycle implemented by [`Handshake`]:
//!
//! ```text
//! awaiting_hello --accept_hello--> negotiating --> ready
//!                                              \-> rejected
//! ```
//!
//! `negotiating` is transient: [`Handshake::accept_hello`] performs the whole
//! synchronous negotiation and lands in a terminal state.

use crate::frame::{
    MAX_FRAGMENTS, MAX_FRAME_BYTES, MAX_FRAME_BYTES_HARD, MAX_REASSEMBLED_BYTES,
};

/// Candidate default handshake deadline (§2.3). Calibrated by H0 baseline +
/// H1 benchmark; do not treat as an approved capacity.
pub const HANDSHAKE_TIMEOUT_MS: u64 = 10_000;
/// Candidate default heartbeat interval (§2.3).
pub const HEARTBEAT_MS: u64 = 10_000;
/// Candidate default request deadline advertised in `ready.limits` (§5.1).
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Candidate default soft cancel deadline advertised in `ready.limits`.
pub const CANCEL_SOFT_TIMEOUT_MS: u64 = 5_000;
/// Candidate default hard cancel deadline advertised in `ready.limits`.
pub const CANCEL_HARD_TIMEOUT_MS: u64 = 30_000;

/// Lowest protocol version the host supports: `1.0` (`0x0100`).
pub const HOST_PROTOCOL_MIN: u16 = 0x0100;
/// Highest protocol version the host supports: major 1, any minor (`1.x`).
pub const HOST_PROTOCOL_MAX: u16 = 0x01FF;
/// Body envelope version for v0 (`v` in every body, §5).
pub const BODY_VERSION_V0: u16 = 1;

/// Capabilities both sides must declare (§6.2). Missing any is
/// `capability_missing`.
pub const REQUIRED_CAPABILITIES: [&str; 6] = [
    "frame.v1",
    "control.json",
    "event.batch",
    "cancel",
    "drain",
    "replay.command",
];

/// Every capability string v0 defines (§6.2). A non-`x-` string outside this
/// set is `unknown_capability`.
pub const KNOWN_CAPABILITIES: [&str; 14] = [
    "frame.v1",
    "control.json",
    "event.batch",
    "cancel",
    "drain",
    "replay.command",
    "encoding.msgpack",
    "encoding.zstd",
    "session.runtime",
    "provider.stream",
    "tool.exec",
    "plugin.loader",
    "graph.read",
    "pty.bridge",
];

/// An inclusive `major << 8 | minor` protocol window (§6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolRange {
    /// Lowest supported wire version.
    pub min: u16,
    /// Highest supported wire version.
    pub max: u16,
}

impl ProtocolRange {
    /// Build a window. A window with `min > max` never intersects anything.
    pub const fn new(min: u16, max: u16) -> Self {
        Self { min, max }
    }

    /// The exact v0 wire version `0x0100`.
    pub const fn v0() -> Self {
        Self { min: 0x0100, max: 0x0100 }
    }

    /// The host's declared `[1.0, 1.x]` window.
    pub const fn host_default() -> Self {
        Self { min: HOST_PROTOCOL_MIN, max: HOST_PROTOCOL_MAX }
    }

    /// Highest version in the intersection of two windows, or `None` when the
    /// windows do not overlap (§6.1).
    pub fn intersection_highest(&self, other: &Self) -> Option<u16> {
        if self.min > self.max || other.min > other.max {
            return None;
        }
        let low = self.min.max(other.min);
        let high = self.max.min(other.max);
        if low > high {
            return None;
        }
        Some(high)
    }
}

/// `worker` identity block from `hello` (§5.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerIdentity {
    /// Worker process id.
    pub pid: u32,
    /// Worker build string, e.g. `chimera-bun-worker@<version>`.
    pub build: String,
    /// Runtime string, e.g. `bun@<version>`.
    pub runtime: String,
    /// Boot identifier, e.g. `boot_<ms>_<pid>`.
    pub boot_id: String,
}

/// Limits a worker advertises in `hello` (§5.1). Only `max_frame_bytes` is
/// negotiated; every other host limit is host-authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelloLimits {
    /// Largest frame body the worker can accept.
    pub max_frame_bytes: u32,
}

/// Workspace identity from `hello` (§5.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// Absolute workspace directory.
    pub directory: String,
    /// Stable project id, e.g. `prj_...`.
    pub project_id: String,
}

/// Resume cursor from `hello` (§5.1). Absent on a fresh worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloResume {
    /// Last durable host command the worker committed.
    pub last_acked_command_sequence: u64,
    /// Event stream epoch the worker last observed.
    pub stream_epoch: String,
}

/// Worker → host `hello` body (§5.1), already decoded from canonical JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    /// Body envelope version; v0 is [`BODY_VERSION_V0`].
    pub v: u16,
    /// One-time handshake token. Never logged.
    pub nonce: String,
    /// Worker process identity.
    pub worker: WorkerIdentity,
    /// Protocol window the worker supports.
    pub protocol: ProtocolRange,
    /// Body encodings the worker supports.
    pub encodings: Vec<String>,
    /// Compression algorithms the worker supports.
    pub compressions: Vec<String>,
    /// Capability strings (§6.2).
    pub capabilities: Vec<String>,
    /// Worker-side limits.
    pub limits: HelloLimits,
    /// Workspace this worker serves.
    pub workspace: Workspace,
    /// Resume cursor; `None` on a fresh start.
    pub resume: Option<HelloResume>,
}

impl Hello {
    /// Envelope `kind` tag.
    pub const KIND: &'static str = "hello";
    /// Envelope `phase` tag for the worker request.
    pub const PHASE: &'static str = "hello";
}

/// Limits the host advertises in `ready` (§5.1). All values are candidate
/// defaults; negotiation may only tighten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadyLimits {
    /// Negotiated frame body limit.
    pub max_frame_bytes: u32,
    /// Reassembled logical message limit.
    pub max_reassembled_bytes: u32,
    /// Fragments per logical message.
    pub max_fragments: u32,
    /// Host heartbeat interval.
    pub heartbeat_ms: u64,
    /// Request deadline.
    pub request_timeout_ms: u64,
    /// Soft cancel deadline.
    pub cancel_soft_timeout_ms: u64,
    /// Hard cancel deadline.
    pub cancel_hard_timeout_ms: u64,
}

impl ReadyLimits {
    /// Candidate defaults from §3.5/§5.1, before worker negotiation.
    pub const fn candidate_defaults() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_reassembled_bytes: MAX_REASSEMBLED_BYTES as u32,
            max_fragments: MAX_FRAGMENTS as u32,
            heartbeat_ms: HEARTBEAT_MS,
            request_timeout_ms: REQUEST_TIMEOUT_MS,
            cancel_soft_timeout_ms: CANCEL_SOFT_TIMEOUT_MS,
            cancel_hard_timeout_ms: CANCEL_HARD_TIMEOUT_MS,
        }
    }
}

/// Resume decision the host returns in `ready` (§5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadyResume {
    /// First command sequence the host will replay/send.
    pub from_command_sequence: u64,
    /// Whether the host can replay from that cursor.
    pub replay_available: bool,
}

/// Host → worker `ready` body (§5.1), already encoded/decoded by the
/// connection layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    /// Body envelope version; v0 is [`BODY_VERSION_V0`].
    pub v: u16,
    /// Host-assigned connection id.
    pub connection_id: u64,
    /// Host-assigned worker generation.
    pub worker_generation: u64,
    /// Selected wire version (`major << 8 | minor`).
    pub protocol: u16,
    /// Negotiated body encodings.
    pub encodings: Vec<String>,
    /// Negotiated compression algorithms.
    pub compressions: Vec<String>,
    /// Negotiated capability strings.
    pub capabilities: Vec<String>,
    /// Negotiated limits.
    pub limits: ReadyLimits,
    /// Resume decision derived from `hello.resume`.
    pub resume: ReadyResume,
}

impl Ready {
    /// Envelope `kind` tag (the host reply reuses `hello`).
    pub const KIND: &'static str = "hello";
    /// Envelope `phase` tag for the host reply.
    pub const PHASE: &'static str = "ready";
}

/// Stable handshake rejection codes (§6.3, §10.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeRejectCode {
    /// No protocol version is supported by both sides.
    UnsupportedProtocolVersion,
    /// One or more required capabilities were not declared.
    CapabilityMissing,
    /// A non-`x-` capability string is not defined by v0.
    UnknownCapability,
    /// The host received `hello` outside `awaiting_hello`.
    ValidationError,
    /// The one-time spawn nonce did not match (§2.2).
    Unauthorized,
}

impl HandshakeRejectCode {
    /// Stable §10.2 code string.
    pub fn as_str(self) -> &'static str {
        match self {
            HandshakeRejectCode::UnsupportedProtocolVersion => "unsupported_protocol_version",
            HandshakeRejectCode::CapabilityMissing => "capability_missing",
            HandshakeRejectCode::UnknownCapability => "unknown_capability",
            HandshakeRejectCode::ValidationError => "validation_error",
            HandshakeRejectCode::Unauthorized => "unauthorized",
        }
    }

    /// §10.2 category.
    pub fn category(self) -> &'static str {
        match self {
            HandshakeRejectCode::ValidationError => "protocol",
            _ => "transport",
        }
    }

    /// §10.2 retryability. Handshake rejections are never retryable on the same
    /// connection; the host may fall back to legacy.
    pub fn retryable(self) -> bool {
        false
    }
}

/// Structured `details` payload of a rejection (§10.1 `details`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandshakeRejectDetails {
    /// Required capabilities absent from `hello.capabilities`.
    pub missing_capabilities: Vec<String>,
    /// Non-`x-` capabilities unknown to v0.
    pub unknown_capabilities: Vec<String>,
    /// Worker protocol window, when relevant.
    pub worker_protocol: Option<ProtocolRange>,
    /// Host protocol window, when relevant.
    pub host_protocol: Option<ProtocolRange>,
}

/// A structured handshake rejection (§6.3, §10). The connection layer wraps
/// this into an error frame and closes the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeReject {
    /// Stable rejection code.
    pub code: HandshakeRejectCode,
    /// Human-readable diagnostic. Never includes the nonce.
    pub message: String,
    /// Machine-readable details.
    pub details: HandshakeRejectDetails,
}

impl HandshakeReject {
    /// Stable §10.2 code string.
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    /// §10.2 category.
    pub fn category(&self) -> &'static str {
        self.code.category()
    }

    /// §10.2 retryability.
    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }
}

impl core::fmt::Display for HandshakeReject {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}: {}", self.code_str(), self.message)
    }
}

impl std::error::Error for HandshakeReject {}

/// Host-side handshake configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// Connection id assigned to this transport connection.
    pub connection_id: u64,
    /// Worker generation assigned to this spawn/resume.
    pub worker_generation: u64,
    /// Protocol window the host supports.
    pub protocol: ProtocolRange,
    /// Encodings the host supports, in preference order.
    pub encodings: Vec<String>,
    /// Compressions the host supports, in preference order.
    pub compressions: Vec<String>,
    /// Host limits before tightening.
    pub limits: ReadyLimits,
    /// One-time nonce handed to the worker at spawn; `hello.nonce` must match
    /// when set (§2.2). `None` disables the check (tests only).
    pub expected_nonce: Option<String>,
}

impl HostConfig {
    /// Config with candidate defaults and the host's `[1.x]` protocol window.
    pub fn new(connection_id: u64, worker_generation: u64) -> Self {
        Self {
            connection_id,
            worker_generation,
            protocol: ProtocolRange::host_default(),
            encodings: vec!["json".to_string(), "msgpack".to_string()],
            compressions: Vec::new(),
            limits: ReadyLimits::candidate_defaults(),
            expected_nonce: None,
        }
    }
}

/// Handshake state machine (§2.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeState {
    /// Waiting for the worker's `hello`.
    AwaitingHello,
    /// Validating `hello` and negotiating.
    Negotiating,
    /// Negotiation succeeded; the connection may proceed.
    Ready(Ready),
    /// Negotiation failed; the host must send the error and close.
    Rejected(HandshakeReject),
}

/// Host-side handshake driver.
#[derive(Debug, Clone)]
pub struct Handshake {
    config: HostConfig,
    state: HandshakeState,
}

impl Handshake {
    /// Start a handshake in `awaiting_hello`.
    pub fn new(config: HostConfig) -> Self {
        Self { config, state: HandshakeState::AwaitingHello }
    }

    /// Current state.
    pub fn state(&self) -> &HandshakeState {
        &self.state
    }

    /// Accept and negotiate a worker `hello`.
    ///
    /// On success the state becomes `ready` and the `ready` body is returned.
    /// On failure the state becomes `rejected` and the structured rejection is
    /// returned; the caller must send it and close the connection.
    pub fn accept_hello(&mut self, hello: Hello) -> Result<Ready, HandshakeReject> {
        if !matches!(self.state, HandshakeState::AwaitingHello) {
            let reject = HandshakeReject {
                code: HandshakeRejectCode::ValidationError,
                message: "hello received outside awaiting_hello".to_string(),
                details: HandshakeRejectDetails::default(),
            };
            self.state = HandshakeState::Rejected(reject.clone());
            return Err(reject);
        }
        self.state = HandshakeState::Negotiating;
        // The spawn nonce is checked before any negotiation (§2.2).
        if let Some(expected) = &self.config.expected_nonce {
            if hello.nonce != *expected {
                let reject = HandshakeReject {
                    code: HandshakeRejectCode::Unauthorized,
                    message: "hello nonce mismatch".to_string(),
                    details: HandshakeRejectDetails::default(),
                };
                self.state = HandshakeState::Rejected(reject.clone());
                return Err(reject);
            }
        }
        match self.negotiate(&hello) {
            Ok(ready) => {
                self.state = HandshakeState::Ready(ready.clone());
                Ok(ready)
            }
            Err(reject) => {
                self.state = HandshakeState::Rejected(reject.clone());
                Err(reject)
            }
        }
    }

    fn negotiate(&self, hello: &Hello) -> Result<Ready, HandshakeReject> {
        let Some(protocol) = self.config.protocol.intersection_highest(&hello.protocol) else {
            return Err(HandshakeReject {
                code: HandshakeRejectCode::UnsupportedProtocolVersion,
                message: format!(
                    "no protocol intersection: worker {}..{}, host {}..{}",
                    format_version(hello.protocol.min),
                    format_version(hello.protocol.max),
                    format_version(self.config.protocol.min),
                    format_version(self.config.protocol.max),
                ),
                details: HandshakeRejectDetails {
                    missing_capabilities: Vec::new(),
                    unknown_capabilities: Vec::new(),
                    worker_protocol: Some(hello.protocol),
                    host_protocol: Some(self.config.protocol),
                },
            });
        };

        let missing_capabilities: Vec<String> = REQUIRED_CAPABILITIES
            .iter()
            .filter(|required| !hello.capabilities.iter().any(|cap| cap == **required))
            .map(|required| (*required).to_string())
            .collect();
        if !missing_capabilities.is_empty() {
            return Err(HandshakeReject {
                code: HandshakeRejectCode::CapabilityMissing,
                message: format!(
                    "worker is missing required capabilities: {}",
                    missing_capabilities.join(", "),
                ),
                details: HandshakeRejectDetails {
                    missing_capabilities,
                    ..HandshakeRejectDetails::default()
                },
            });
        }

        let unknown_capabilities = dedup(
            hello
                .capabilities
                .iter()
                .filter(|cap| !cap.starts_with("x-") && !KNOWN_CAPABILITIES.contains(&cap.as_str()))
                .cloned()
                .collect(),
        );
        if !unknown_capabilities.is_empty() {
            return Err(HandshakeReject {
                code: HandshakeRejectCode::UnknownCapability,
                message: format!(
                    "worker declared unknown capabilities: {}",
                    unknown_capabilities.join(", "),
                ),
                details: HandshakeRejectDetails {
                    unknown_capabilities,
                    ..HandshakeRejectDetails::default()
                },
            });
        }

        // Limits only tighten (§3.5/§5.1). `max_frame_bytes` is the only
        // worker-negotiated value; it may never exceed the host hard cap. A
        // zero limit is a protocol violation (TS-arm rule: `validation_error`).
        if hello.limits.max_frame_bytes == 0 {
            return Err(HandshakeReject {
                code: HandshakeRejectCode::ValidationError,
                message: "invalid limits.max_frame_bytes".to_string(),
                details: HandshakeRejectDetails::default(),
            });
        }
        let mut limits = self.config.limits;
        limits.max_frame_bytes = self
            .config
            .limits
            .max_frame_bytes
            .min(hello.limits.max_frame_bytes)
            .min(MAX_FRAME_BYTES_HARD);

        // The control plane is canonical JSON; a worker that cannot read `json`
        // cannot be served at all (TS-arm rule).
        if !hello.encodings.iter().any(|encoding| encoding == "json") {
            return Err(HandshakeReject {
                code: HandshakeRejectCode::ValidationError,
                message: "json encoding is required".to_string(),
                details: HandshakeRejectDetails::default(),
            });
        }

        let resume = match &hello.resume {
            Some(resume) => ReadyResume {
                from_command_sequence: resume.last_acked_command_sequence.saturating_add(1),
                replay_available: true,
            },
            None => ReadyResume { from_command_sequence: 1, replay_available: false },
        };

        Ok(Ready {
            v: BODY_VERSION_V0,
            connection_id: self.config.connection_id,
            worker_generation: self.config.worker_generation,
            protocol,
            encodings: intersect(&self.config.encodings, &hello.encodings),
            compressions: intersect(&self.config.compressions, &hello.compressions),
            capabilities: KNOWN_CAPABILITIES
                .iter()
                // `pty.bridge` is reserved but not offered by a v0 host (§6.2).
                .filter(|known| **known != "pty.bridge")
                .filter(|known| hello.capabilities.iter().any(|cap| cap == *known))
                .map(|known| (*known).to_string())
                .collect(),
            limits,
            resume,
        })
    }
}

/// Preserve host preference order while keeping only worker-supported values.
fn intersect(host: &[String], worker: &[String]) -> Vec<String> {
    host.iter().filter(|value| worker.contains(value)).cloned().collect()
}

/// Stable de-duplication that preserves first-seen order.
fn dedup(values: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique
}

fn format_version(version: u16) -> String {
    format!("{}.{}", version >> 8, version & 0xFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    fn hello() -> Hello {
        Hello {
            v: BODY_VERSION_V0,
            nonce: "one-time-token".to_string(),
            worker: WorkerIdentity {
                pid: 12345,
                build: "chimera-bun-worker@0.1.0".to_string(),
                runtime: "bun@1.2.3".to_string(),
                boot_id: "boot_1_12345".to_string(),
            },
            protocol: ProtocolRange::v0(),
            encodings: caps(&["json", "msgpack"]),
            compressions: Vec::new(),
            capabilities: caps(&[
                "frame.v1",
                "control.json",
                "event.batch",
                "cancel",
                "drain",
                "replay.command",
                "session.runtime",
            ]),
            limits: HelloLimits { max_frame_bytes: 8 * 1024 * 1024 },
            workspace: Workspace {
                directory: "/abs/workspace".to_string(),
                project_id: "prj_test".to_string(),
            },
            resume: Some(HelloResume {
                last_acked_command_sequence: 42,
                stream_epoch: "epoch_1".to_string(),
            }),
        }
    }

    fn handshake() -> Handshake {
        Handshake::new(HostConfig::new(17, 8))
    }

    #[test]
    fn full_handshake_negotiates_every_field() {
        let mut handshake = handshake();
        let ready = handshake.accept_hello(hello()).expect("handshake succeeds");

        assert_eq!(ready.v, BODY_VERSION_V0);
        assert_eq!(ready.connection_id, 17);
        assert_eq!(ready.worker_generation, 8);
        assert_eq!(ready.protocol, 0x0100);
        assert_eq!(ready.encodings, caps(&["json", "msgpack"]));
        assert!(ready.compressions.is_empty());
        assert_eq!(
            ready.capabilities,
            caps(&[
                "frame.v1",
                "control.json",
                "event.batch",
                "cancel",
                "drain",
                "replay.command",
                "session.runtime",
            ])
        );
        assert_eq!(ready.limits, ReadyLimits::candidate_defaults());
        assert_eq!(
            ready.resume,
            ReadyResume { from_command_sequence: 43, replay_available: true }
        );
        assert!(matches!(handshake.state(), HandshakeState::Ready(_)));
        assert_eq!(Hello::KIND, "hello");
        assert_eq!(Hello::PHASE, "hello");
        assert_eq!(Ready::KIND, "hello");
        assert_eq!(Ready::PHASE, "ready");
    }

    #[test]
    fn protocol_without_intersection_is_rejected() {
        let mut input = hello();
        input.protocol = ProtocolRange::new(0x0200, 0x0201);

        let reject = handshake().accept_hello(input).expect_err("no intersection");
        assert_eq!(reject.code, HandshakeRejectCode::UnsupportedProtocolVersion);
        assert_eq!(reject.code_str(), "unsupported_protocol_version");
        assert_eq!(reject.category(), "transport");
        assert!(!reject.retryable());
        assert!(reject.message.contains("no protocol intersection"));
        assert_eq!(reject.details.worker_protocol, Some(ProtocolRange::new(0x0200, 0x0201)));
        assert_eq!(reject.details.host_protocol, Some(ProtocolRange::host_default()));
        assert!(reject.details.missing_capabilities.is_empty());
        assert!(reject.details.unknown_capabilities.is_empty());
    }

    #[test]
    fn highest_minor_in_intersection_is_selected() {
        let mut input = hello();
        input.protocol = ProtocolRange::new(0x0100, 0x0105);

        let ready = handshake().accept_hello(input).expect("intersection exists");
        assert_eq!(ready.protocol, 0x0105);
    }

    #[test]
    fn missing_required_capability_is_rejected_with_list() {
        let mut input = hello();
        input.capabilities.retain(|cap| cap != "cancel" && cap != "drain");

        let reject = handshake().accept_hello(input).expect_err("missing required");
        assert_eq!(reject.code, HandshakeRejectCode::CapabilityMissing);
        assert_eq!(reject.code_str(), "capability_missing");
        assert_eq!(reject.category(), "transport");
        assert_eq!(reject.details.missing_capabilities, caps(&["cancel", "drain"]));
        assert!(reject.details.unknown_capabilities.is_empty());
        assert_eq!(
            reject.details.worker_protocol, None,
            "protocol details only accompany version rejections"
        );
    }

    #[test]
    fn unknown_non_extension_capability_is_rejected() {
        let mut input = hello();
        input.capabilities.push("quantum.teleport".to_string());

        let reject = handshake().accept_hello(input).expect_err("unknown capability");
        assert_eq!(reject.code, HandshakeRejectCode::UnknownCapability);
        assert_eq!(reject.code_str(), "unknown_capability");
        assert_eq!(reject.details.unknown_capabilities, caps(&["quantum.teleport"]));
        assert!(reject.details.missing_capabilities.is_empty());
    }

    #[test]
    fn x_prefixed_capability_is_ignored() {
        let mut input = hello();
        input.capabilities.push("x-acme.trace".to_string());

        let ready = handshake().accept_hello(input).expect("x- capabilities are ignored");
        assert!(!ready.capabilities.iter().any(|cap| cap == "x-acme.trace"));
        assert_eq!(
            ready.capabilities,
            caps(&[
                "frame.v1",
                "control.json",
                "event.batch",
                "cancel",
                "drain",
                "replay.command",
                "session.runtime",
            ])
        );
    }

    #[test]
    fn limits_only_tighten_to_worker_value() {
        let mut input = hello();
        input.limits.max_frame_bytes = 1024 * 1024;

        let ready = handshake().accept_hello(input).expect("handshake succeeds");
        assert_eq!(ready.limits.max_frame_bytes, 1024 * 1024);
        // Host-authoritative limits are unchanged.
        assert_eq!(ready.limits.max_reassembled_bytes, MAX_REASSEMBLED_BYTES as u32);
        assert_eq!(ready.limits.max_fragments, MAX_FRAGMENTS as u32);
    }

    #[test]
    fn limits_never_exceed_hard_cap() {
        let mut config = HostConfig::new(1, 1);
        config.limits.max_frame_bytes = MAX_FRAME_BYTES_HARD;
        let mut handshake = Handshake::new(config);
        let mut input = hello();
        input.limits.max_frame_bytes = 64 * 1024 * 1024;

        let ready = handshake.accept_hello(input).expect("handshake succeeds");
        assert_eq!(ready.limits.max_frame_bytes, MAX_FRAME_BYTES_HARD);
    }

    #[test]
    fn resume_cursor_is_passed_through() {
        let mut input = hello();
        input.resume = Some(HelloResume {
            last_acked_command_sequence: 99,
            stream_epoch: "epoch_2".to_string(),
        });

        let ready = handshake().accept_hello(input).expect("handshake succeeds");
        assert_eq!(
            ready.resume,
            ReadyResume { from_command_sequence: 100, replay_available: true }
        );
    }

    #[test]
    fn fresh_worker_starts_at_sequence_one_without_replay() {
        let mut input = hello();
        input.resume = None;

        let ready = handshake().accept_hello(input).expect("handshake succeeds");
        assert_eq!(
            ready.resume,
            ReadyResume { from_command_sequence: 1, replay_available: false }
        );
    }

    #[test]
    fn rejection_details_are_structured_and_default_empty() {
        let mut input = hello();
        input.capabilities.retain(|cap| cap != "frame.v1");

        let reject = handshake().accept_hello(input).expect_err("missing frame.v1");
        assert_eq!(reject.code, HandshakeRejectCode::CapabilityMissing);
        assert_eq!(reject.category(), "transport");
        assert!(!reject.retryable());
        assert!(!reject.message.is_empty());
        assert_eq!(reject.details.missing_capabilities, caps(&["frame.v1"]));
        assert_eq!(reject.details, HandshakeRejectDetails {
            missing_capabilities: caps(&["frame.v1"]),
            unknown_capabilities: Vec::new(),
            worker_protocol: None,
            host_protocol: None,
        });
        assert_eq!(reject.to_string(), format!("capability_missing: {}", reject.message));
    }

    #[test]
    fn second_hello_is_rejected_in_ready_state() {
        let mut handshake = handshake();
        handshake.accept_hello(hello()).expect("first handshake succeeds");

        let reject = handshake.accept_hello(hello()).expect_err("second hello");
        assert_eq!(reject.code, HandshakeRejectCode::ValidationError);
        assert_eq!(reject.code_str(), "validation_error");
        assert_eq!(reject.category(), "protocol");
        assert!(matches!(handshake.state(), HandshakeState::Rejected(_)));
    }

    #[test]
    fn protocol_range_intersection_helpers() {
        assert_eq!(
            ProtocolRange::new(0x0100, 0x0102).intersection_highest(&ProtocolRange::new(0x0101, 0x0105)),
            Some(0x0102)
        );
        assert_eq!(
            ProtocolRange::new(0x0100, 0x0100).intersection_highest(&ProtocolRange::new(0x0101, 0x0102)),
            None
        );
        assert_eq!(
            ProtocolRange::new(0x0200, 0x0100).intersection_highest(&ProtocolRange::v0()),
            None,
            "inverted windows never intersect"
        );
    }

    #[test]
    fn nonce_mismatch_is_unauthorized() {
        let mut handshake = Handshake::new(HostConfig {
            expected_nonce: Some("expected".to_string()),
            ..HostConfig::new(17, 8)
        });
        let mut input = hello();
        input.nonce = "wrong".to_string();

        let reject = handshake.accept_hello(input).expect_err("nonce mismatch");
        assert_eq!(reject.code, HandshakeRejectCode::Unauthorized);
        assert_eq!(reject.code_str(), "unauthorized");
        assert!(matches!(handshake.state(), HandshakeState::Rejected(_)));
    }

    #[test]
    fn matching_nonce_passes() {
        let mut handshake = Handshake::new(HostConfig {
            expected_nonce: Some("one-time-token".to_string()),
            ..HostConfig::new(17, 8)
        });
        assert!(handshake.accept_hello(hello()).is_ok());
    }

    #[test]
    fn missing_json_encoding_is_validation_error() {
        let mut input = hello();
        input.encodings = vec!["msgpack".to_string()];

        let reject = handshake().accept_hello(input).expect_err("json is mandatory");
        assert_eq!(reject.code, HandshakeRejectCode::ValidationError);
        assert_eq!(reject.message, "json encoding is required");
    }

    #[test]
    fn pty_bridge_is_never_offered() {
        let mut input = hello();
        input.capabilities.push("pty.bridge".to_string());

        let ready = handshake().accept_hello(input).expect("pty.bridge is reserved");
        assert!(!ready.capabilities.iter().any(|cap| cap == "pty.bridge"));
    }

    #[test]
    fn zero_frame_limit_is_a_validation_error() {
        let mut input = hello();
        input.limits.max_frame_bytes = 0;

        let reject = handshake().accept_hello(input).expect_err("zero limit");
        assert_eq!(reject.code, HandshakeRejectCode::ValidationError);
        assert_eq!(reject.message, "invalid limits.max_frame_bytes");
    }
}