//! Host-side driver for one worker connection.
//!
//! The driver owns the host end of a single transport connection: the
//! [`FrameReader`]/[`FrameWriter`] pair, the [`Handshake`] state machine, and
//! the workspace/generation identity that fences every inbound frame (§1.2).
//! It is pure logic: no process spawning, no wall-clock reads, no `kill`. All
//! time is injected through the [`Clock`] trait or explicit `now_ms` arguments,
//! and terminating a worker stays the caller's responsibility (§9.3).
//!
//! Lifecycle (§2.3):
//!
//! ```text
//! hello ──▶ accept_hello ──▶ ready ──▶ ack(hello_complete) ──▶ mark_ready
//! request/response/event/ack/cancel/drain/replay ...
//! drain ──▶ ack(drained) ──▶ caller escalates
//! ```
//!
//! Bodies are canonical JSON (§4.1). The crate has no external dependencies,
//! so the small [`Json`] value/parser/renderer in this module is the whole
//! control-plane codec; durable event commit and `ack(durable_committed)` are
//! upper-layer concerns (the driver only surfaces [`HostEvent`] values).

use std::io::{Read, Write};

use crate::connection::{ConnectionError, FrameReader, FrameWriter, NextFrame};
use crate::frame::{
    FrameError, FrameKind, Header, FLAG_DURABLE, FLAG_REPLAYABLE, PROTOCOL_VERSION_V0,
};
use crate::handshake::{
    Handshake, HandshakeReject, HandshakeState, Hello, HelloLimits, HelloResume, HostConfig,
    ProtocolRange, Ready, WorkerIdentity, Workspace, BODY_VERSION_V0,
};
pub use crate::supervisor::HEARTBEAT_TIMEOUT_MS;
use crate::supervisor::{ExitReason, SupervisorError, WorkerRegistry};

/// Failure of one driver step.
#[derive(Debug)]
pub enum HostError {
    /// Transport/frame failure.
    Connection(ConnectionError),
    /// Handshake negotiation rejected the worker (§6.3).
    Handshake(HandshakeReject),
    /// Supervisor refused a lifecycle transition.
    Supervisor(SupervisorError),
    /// Protocol-level refusal raised by the driver itself.
    Protocol {
        /// Stable §10.2 code.
        code: &'static str,
        /// Diagnostic message.
        message: String,
    },
    /// The worker sent a connection-level `error` frame.
    Remote {
        /// Code carried by the worker.
        code: String,
        /// Message carried by the worker.
        message: String,
    },
}

impl HostError {
    /// Stable §10.2 code.
    pub fn code(&self) -> &str {
        match self {
            HostError::Connection(err) => err.code(),
            HostError::Handshake(reject) => reject.code_str(),
            HostError::Supervisor(_) => "invariant_violation",
            HostError::Protocol { code, .. } => code,
            HostError::Remote { code, .. } => code,
        }
    }

    /// §10.2 category.
    pub fn category(&self) -> &str {
        match self {
            HostError::Connection(err) => err.category(),
            HostError::Handshake(reject) => reject.category(),
            HostError::Supervisor(_) => "internal",
            HostError::Protocol { .. } => "protocol",
            HostError::Remote { .. } => "protocol",
        }
    }

    fn protocol(code: &'static str, message: impl Into<String>) -> Self {
        HostError::Protocol { code, message: message.into() }
    }
}

impl From<ConnectionError> for HostError {
    fn from(err: ConnectionError) -> Self {
        HostError::Connection(err)
    }
}

impl From<HandshakeReject> for HostError {
    fn from(reject: HandshakeReject) -> Self {
        HostError::Handshake(reject)
    }
}

impl From<SupervisorError> for HostError {
    fn from(err: SupervisorError) -> Self {
        HostError::Supervisor(err)
    }
}

impl core::fmt::Display for HostError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            HostError::Connection(err) => write!(f, "{}: {}", err.code(), err),
            HostError::Handshake(reject) => write!(f, "{}: {}", reject.code_str(), reject.message),
            HostError::Supervisor(err) => write!(f, "supervisor: {err}"),
            HostError::Protocol { code, message } => write!(f, "{code}: {message}"),
            HostError::Remote { code, message } => write!(f, "{code}: {message}"),
        }
    }
}

impl std::error::Error for HostError {}

/// Failure to parse a canonical-JSON control body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    /// Character offset where parsing failed.
    pub offset: usize,
    /// Diagnostic message.
    pub message: String,
}

impl core::fmt::Display for JsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{} at offset {}", self.message, self.offset)
    }
}

impl std::error::Error for JsonError {}

/// A JSON number, keeping integer width where the parser can.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JsonNumber {
    /// Negative or explicitly signed integer.
    Int(i64),
    /// Non-negative integer that fits `u64`.
    UInt(u64),
    /// Any number written with a fraction or exponent.
    Float(f64),
}

/// Minimal JSON value used by the control plane.
///
/// Objects preserve insertion order in memory and render with sorted keys so
/// the wire bytes are canonical (§4.1). Duplicate keys parse successfully and
/// the last occurrence wins on lookup.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    /// `null`
    Null,
    /// `true` / `false`
    Bool(bool),
    /// A number.
    Number(JsonNumber),
    /// A string.
    String(String),
    /// An array.
    Array(Vec<Json>),
    /// An object.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// Build an object from borrowed keys.
    pub fn object(entries: Vec<(&str, Json)>) -> Self {
        Json::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    /// Build a string value.
    pub fn string(value: impl Into<String>) -> Self {
        Json::String(value.into())
    }

    /// Build an unsigned integer value.
    pub fn u64(value: u64) -> Self {
        Json::Number(JsonNumber::UInt(value))
    }

    /// Build a boolean value.
    pub fn bool(value: bool) -> Self {
        Json::Bool(value)
    }

    /// Build an array of strings.
    pub fn strings(values: &[String]) -> Self {
        Json::Array(values.iter().map(|value| Json::String(value.clone())).collect())
    }

    /// Look up an object member (last occurrence wins).
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => {
                entries.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value)
            }
            _ => None,
        }
    }

    /// Borrow the string payload.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(value) => Some(value),
            _ => None,
        }
    }

    /// Read a non-negative integer.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Json::Number(JsonNumber::UInt(value)) => Some(*value),
            Json::Number(JsonNumber::Int(value)) if *value >= 0 => Some(*value as u64),
            _ => None,
        }
    }

    /// Read a boolean.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// Borrow an array.
    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(values) => Some(values),
            _ => None,
        }
    }

    /// Parse one JSON document.
    pub fn parse(text: &str) -> Result<Self, JsonError> {
        Parser::parse(text)
    }

    /// Render canonical JSON (object keys sorted lexicographically).
    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(JsonNumber::Int(value)) => out.push_str(&value.to_string()),
            Json::Number(JsonNumber::UInt(value)) => out.push_str(&value.to_string()),
            Json::Number(JsonNumber::Float(value)) if value.is_finite() => {
                out.push_str(&value.to_string())
            }
            Json::Number(JsonNumber::Float(_)) => out.push_str("null"),
            Json::String(value) => write_json_string(out, value),
            Json::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write(out);
                }
                out.push(']');
            }
            Json::Object(entries) => {
                let mut sorted: Vec<&(String, Json)> = entries.iter().collect();
                sorted.sort_by(|left, right| left.0.cmp(&right.0));
                out.push('{');
                for (index, (key, value)) in sorted.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_json_string(out, key);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl core::fmt::Display for Json {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.render())
    }
}

fn write_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn parse(text: &str) -> Result<Json, JsonError> {
        let mut parser = Parser { chars: text.chars().collect(), pos: 0 };
        parser.skip_ws();
        let value = parser.value()?;
        parser.skip_ws();
        if parser.pos != parser.chars.len() {
            return Err(parser.error("trailing characters"));
        }
        Ok(value)
    }

    fn error(&self, message: &str) -> JsonError {
        JsonError { offset: self.pos, message: message.to_string() }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += 1;
        Some(ch)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Result<Json, JsonError> {
        match self.peek() {
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => self.string().map(Json::String),
            Some('t') => self.literal("true", Json::Bool(true)),
            Some('f') => self.literal("false", Json::Bool(false)),
            Some('n') => self.literal("null", Json::Null),
            Some('-' | '0'..='9') => self.number(),
            _ => Err(self.error("expected a JSON value")),
        }
    }

    fn literal(&mut self, expected: &str, value: Json) -> Result<Json, JsonError> {
        for expected_char in expected.chars() {
            if self.bump() != Some(expected_char) {
                return Err(self.error("invalid literal"));
            }
        }
        Ok(value)
    }

    fn object(&mut self) -> Result<Json, JsonError> {
        self.bump();
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some('}') {
            self.bump();
            return Ok(Json::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some('"') {
                return Err(self.error("expected an object key"));
            }
            let key = self.string()?;
            self.skip_ws();
            if self.bump() != Some(':') {
                return Err(self.error("expected ':' after object key"));
            }
            self.skip_ws();
            entries.push((key, self.value()?));
            self.skip_ws();
            match self.bump() {
                Some(',') => continue,
                Some('}') => break,
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
        Ok(Json::Object(entries))
    }

    fn array(&mut self) -> Result<Json, JsonError> {
        self.bump();
        self.skip_ws();
        let mut values = Vec::new();
        if self.peek() == Some(']') {
            self.bump();
            return Ok(Json::Array(values));
        }
        loop {
            self.skip_ws();
            values.push(self.value()?);
            self.skip_ws();
            match self.bump() {
                Some(',') => continue,
                Some(']') => break,
                _ => return Err(self.error("expected ',' or ']'")),
            }
        }
        Ok(Json::Array(values))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        if self.bump() != Some('"') {
            return Err(self.error("expected a string"));
        }
        let mut out = String::new();
        loop {
            let Some(ch) = self.bump() else {
                return Err(self.error("unterminated string"));
            };
            match ch {
                '"' => return Ok(out),
                '\\' => {
                    let Some(escape) = self.bump() else {
                        return Err(self.error("unterminated escape"));
                    };
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{0008}'),
                        'f' => out.push('\u{000C}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.unicode_escape()?),
                        _ => return Err(self.error("invalid escape")),
                    }
                }
                ch if (ch as u32) < 0x20 => return Err(self.error("control character in string")),
                ch => out.push(ch),
            }
        }
    }

    fn unicode_escape(&mut self) -> Result<char, JsonError> {
        let high = self.hex4()?;
        if (0xD800..=0xDBFF).contains(&high) {
            if self.peek() == Some('\\') {
                let saved = self.pos;
                self.bump();
                if self.bump() == Some('u') {
                    let low = self.hex4()?;
                    if (0xDC00..=0xDFFF).contains(&low) {
                        let combined = 0x1_0000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                        return char::from_u32(combined)
                            .ok_or_else(|| self.error("invalid surrogate pair"));
                    }
                }
                self.pos = saved;
            }
            return Ok('\u{FFFD}');
        }
        char::from_u32(high).ok_or_else(|| self.error("invalid unicode escape"))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let mut value = 0u32;
        for _ in 0..4 {
            let Some(ch) = self.bump() else {
                return Err(self.error("truncated unicode escape"));
            };
            let Some(digit) = ch.to_digit(16) else {
                return Err(self.error("invalid unicode escape"));
            };
            value = value * 16 + digit;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        while matches!(self.peek(), Some('-' | '+' | '.' | 'e' | 'E' | '0'..='9')) {
            self.pos += 1;
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        if text.contains('.') || text.contains('e') || text.contains('E') {
            return text
                .parse::<f64>()
                .map(|value| Json::Number(JsonNumber::Float(value)))
                .map_err(|_| self.error("invalid number"));
        }
        if text.starts_with('-') {
            return text
                .parse::<i64>()
                .map(|value| Json::Number(JsonNumber::Int(value)))
                .map_err(|_| self.error("invalid number"));
        }
        text.parse::<u64>()
            .map(|value| Json::Number(JsonNumber::UInt(value)))
            .or_else(|_| text.parse::<i64>().map(|value| Json::Number(JsonNumber::Int(value))))
            .map_err(|_| self.error("invalid number"))
    }
}

/// A decoded inbound `request` body (§5.2).
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingRequest {
    /// Correlation id; must match the header `correlation_id`.
    pub id: String,
    /// Method name (`session.prompt`, ...).
    pub method: String,
    /// Optional session scope.
    pub session_id: Option<String>,
    /// Optional job scope.
    pub job_id: Option<String>,
    /// Optional turn scope.
    pub turn_id: Option<String>,
    /// Request-level soft deadline in milliseconds.
    pub deadline_ms: Option<u64>,
    /// Explicit idempotency key; defaults to `id` (§7.1).
    pub idempotency_key: Option<String>,
    /// Method parameters.
    pub params: Json,
}

/// Upper-layer request handler. The driver calls this once per routed request.
pub trait RequestRouter {
    /// Route one request and produce its response.
    fn route(&mut self, request: IncomingRequest) -> OutgoingResponse;
}

/// `status` field of a `response` body (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseStatus {
    /// `ok`
    Ok,
    /// `error`
    Error,
}

impl ResponseStatus {
    /// Wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            ResponseStatus::Ok => "ok",
            ResponseStatus::Error => "error",
        }
    }
}

/// A response to be written back to the worker (§5.3).
#[derive(Debug, Clone, PartialEq)]
pub struct OutgoingResponse {
    /// Correlation id echoed from the request.
    pub id: String,
    /// Success or failure.
    pub status: ResponseStatus,
    /// Result body when `status == ok`.
    pub result: Option<Json>,
    /// §10.1 error object when `status == error`.
    pub error: Option<Json>,
    /// `meta.idempotent_replay`.
    pub idempotent_replay: bool,
}

impl OutgoingResponse {
    /// Successful response.
    pub fn ok(id: impl Into<String>, result: Json) -> Self {
        Self {
            id: id.into(),
            status: ResponseStatus::Ok,
            result: Some(result),
            error: None,
            idempotent_replay: false,
        }
    }

    /// Failed response carrying a §10.1 error object.
    pub fn error(
        id: impl Into<String>,
        code: &str,
        category: &str,
        retryable: bool,
        message: &str,
    ) -> Self {
        Self {
            id: id.into(),
            status: ResponseStatus::Error,
            result: None,
            error: Some(error_object(code, category, retryable, None, message, Json::Null)),
            idempotent_replay: false,
        }
    }

    fn to_json(&self) -> Json {
        Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("response")),
            ("id", Json::string(&self.id)),
            ("status", Json::string(self.status.as_str())),
            ("result", self.result.clone().unwrap_or(Json::Null)),
            ("error", self.error.clone().unwrap_or(Json::Null)),
            (
                "meta",
                Json::object(vec![("idempotent_replay", Json::bool(self.idempotent_replay))]),
            ),
        ])
    }
}

/// A durable inbound event (§5.4, §8.4).
#[derive(Debug, Clone, PartialEq)]
pub struct DurableEvent {
    /// Bus event name.
    pub event: String,
    /// Optional session scope.
    pub session_id: Option<String>,
    /// Optional job scope.
    pub job_id: Option<String>,
    /// Optional turn scope.
    pub turn_id: Option<String>,
    /// Host-assigned sequence; `None` before the host commits it.
    pub event_seq: Option<u64>,
    /// Frame `transport_sequence` the event arrived on. Unique per
    /// connection; used by the upper layer to build a stable event id.
    pub transport_sequence: u64,
    /// Event payload.
    pub payload: Json,
}

/// A transient inbound event (§5.4, §8.4). Transient events may be dropped and
/// never carry an `event_seq`.
#[derive(Debug, Clone, PartialEq)]
pub struct TransientEvent {
    /// Bus event name.
    pub event: String,
    /// Optional session scope.
    pub session_id: Option<String>,
    /// Optional turn scope.
    pub turn_id: Option<String>,
    /// Event payload.
    pub payload: Json,
}

/// Event surfaced to the upper layer, split by durability (§8.4).
#[derive(Debug, Clone, PartialEq)]
pub enum HostEvent {
    /// Must be committed to the event log before fan-out.
    Durable(DurableEvent),
    /// Rebuildable, droppable increment.
    Transient(TransientEvent),
}

/// `phase` of an `ack` body (§5.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckPhase {
    /// `hello_complete`
    HelloComplete,
    /// `durable_committed`
    DurableCommitted,
    /// `drained`
    Drained,
    /// `replay_complete`
    ReplayComplete,
    /// `cancel_ack`
    CancelAck,
    /// A phase this version does not know.
    Unknown(String),
}

impl AckPhase {
    fn from_str(value: &str) -> Self {
        match value {
            "hello_complete" => AckPhase::HelloComplete,
            "durable_committed" => AckPhase::DurableCommitted,
            "drained" => AckPhase::Drained,
            "replay_complete" => AckPhase::ReplayComplete,
            "cancel_ack" => AckPhase::CancelAck,
            other => AckPhase::Unknown(other.to_string()),
        }
    }

    /// Wire string.
    pub fn as_str(&self) -> &str {
        match self {
            AckPhase::HelloComplete => "hello_complete",
            AckPhase::DurableCommitted => "durable_committed",
            AckPhase::Drained => "drained",
            AckPhase::ReplayComplete => "replay_complete",
            AckPhase::CancelAck => "cancel_ack",
            AckPhase::Unknown(value) => value,
        }
    }
}

/// A decoded inbound `ack` body (§5.5).
#[derive(Debug, Clone, PartialEq)]
pub struct Ack {
    /// Ack id.
    pub id: Option<String>,
    /// Id of the frame being acknowledged.
    pub ack_of: Option<String>,
    /// Acknowledgement phase.
    pub phase: AckPhase,
    /// Largest committed `command_sequence` on this connection.
    pub durable_through_command_sequence: Option<u64>,
    /// Host-assigned event sequence (durable commits only).
    pub event_seq: Option<u64>,
    /// Whether a replay range finished.
    pub replay_complete: bool,
    /// Drain report: sessions still active.
    pub active_sessions: Option<u64>,
    /// Drain report: turns interrupted by the drain.
    pub interrupted_turns: Option<u64>,
}

impl Ack {
    fn from_json(value: &Json) -> Result<Self, HostError> {
        let phase = required_string(value, "phase")?;
        Ok(Ack {
            id: optional_string(value, "id"),
            ack_of: optional_string(value, "ack_of"),
            phase: AckPhase::from_str(&phase),
            durable_through_command_sequence: value
                .get("durable_through_command_sequence")
                .and_then(Json::as_u64),
            event_seq: value.get("event_seq").and_then(Json::as_u64),
            replay_complete: value.get("replay_complete").and_then(Json::as_bool).unwrap_or(false),
            active_sessions: value.get("active_sessions").and_then(Json::as_u64),
            interrupted_turns: value.get("interrupted_turns").and_then(Json::as_u64),
        })
    }
}

/// Worker report attached to `ack(phase=drained)` (§9.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainAck {
    /// `ack_of`, normally the drain id.
    pub ack_of: Option<String>,
    /// Sessions still active when the worker reported.
    pub active_sessions: u64,
    /// Turns interrupted by the drain.
    pub interrupted_turns: u64,
}

/// Why the host asked the worker to drain (§5.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainReason {
    /// Host restart.
    Restart,
    /// Binary upgrade.
    Upgrade,
    /// Memory reclaim.
    Memory,
    /// Host shutdown.
    Shutdown,
}

impl DrainReason {
    /// Wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            DrainReason::Restart => "restart",
            DrainReason::Upgrade => "upgrade",
            DrainReason::Memory => "memory",
            DrainReason::Shutdown => "shutdown",
        }
    }
}

/// Active drain bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainState {
    /// Drain correlation id.
    pub drain_id: String,
    /// Reason reported to the worker.
    pub reason: DrainReason,
    /// Absolute logical deadline in milliseconds.
    pub deadline_ms: u64,
}

/// Result of waiting for a drain to finish (§9.3). The driver never kills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrainOutcome {
    /// Worker acknowledged the drain.
    Drained(DrainAck),
    /// The logical deadline passed before an ack arrived.
    TimedOut {
        /// Drain that timed out.
        drain_id: String,
    },
    /// The transport closed before an ack arrived.
    Closed {
        /// Drain that was still pending.
        drain_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServeOutcome {
    /// The transport reached a clean EOF at a frame boundary.
    Closed,
    /// The worker acknowledged the active drain.
    Drained(DrainAck),
    /// The active drain deadline passed.
    DrainTimedOut {
        /// Drain that timed out.
        drain_id: String,
    },
    /// No complete frame arrived this round, or the step budget was reached.
    ///
    /// Non-terminal: the connection stays live and the next round continues
    /// from the retained buffer (H2 Step 0, §2.4).
    Idle,
}

/// Per-step limits for [`HostDriver::serve_available`] (H2 Step 0, §2.2).
///
/// The two limits are a first-past-the-post pair: whichever is reached first
/// ends the step with [`ServeOutcome::Idle`], so one busy connection cannot
/// starve accept/tick/reap or other connections.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServeBudget {
    /// Maximum frames handled in one step.
    pub max_frames: usize,
    /// Maximum wall/logical time spent in one step.
    pub max_ms: u64,
}

impl ServeBudget {
    /// Candidate default frame cap (§2.2).
    pub const DEFAULT_MAX_FRAMES: usize = 64;
    /// Candidate default time cap in milliseconds (§2.2).
    pub const DEFAULT_MAX_MS: u64 = 10;
    /// Candidate default budget: `max_frames = 64`, `max_ms = 10`.
    pub const DEFAULT: Self = Self {
        max_frames: Self::DEFAULT_MAX_FRAMES,
        max_ms: Self::DEFAULT_MAX_MS,
    };
}

/// Injected logical clock. Implemented for `FnMut() -> u64` closures.
pub trait Clock {
    /// Current logical time in milliseconds.
    fn now_ms(&mut self) -> u64;
}

impl<F: FnMut() -> u64> Clock for F {
    fn now_ms(&mut self) -> u64 {
        self()
    }
}

/// Workspace/generation identity bound to one connection (§1.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    /// Workspace this connection serves.
    pub workspace_id: String,
    /// Host-assigned connection id.
    pub connection_id: u64,
    /// Host-assigned worker generation; every inbound frame must match.
    pub worker_generation: u64,
}

/// A `cancel` request the host sends to the worker (§5.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelRequest {
    /// Cancel id.
    pub id: String,
    /// Request/turn/job being cancelled.
    pub target_id: String,
    /// Transport sequence of the target frame, when known.
    pub target_transport_sequence: Option<u64>,
    /// Session scope.
    pub session_id: Option<String>,
    /// Job scope.
    pub job_id: Option<String>,
    /// Reason (`user_abort`, ...).
    pub reason: String,
    /// Soft deadline in milliseconds.
    pub deadline_ms: Option<u64>,
}

/// Host-side driver for exactly one worker connection.
#[derive(Debug)]
pub struct HostDriver<R: Read, W: Write> {
    reader: FrameReader<R>,
    writer: FrameWriter<W>,
    handshake: Handshake,
    identity: HostIdentity,
    last_inbound_ms: u64,
    stale_generation_dropped: u64,
    ignored_frames: u64,
    rejected_requests: u64,
    events: Vec<HostEvent>,
    last_acked_command_sequence: u64,
    drain: Option<DrainState>,
}

impl<R: Read, W: Write> HostDriver<R, W> {
    /// Connection identity.
    pub fn identity(&self) -> &HostIdentity {
        &self.identity
    }

    /// Handshake state after the handshake completed.
    pub fn handshake_state(&self) -> &HandshakeState {
        self.handshake.state()
    }

    /// Logical time of the last accepted inbound frame.
    pub fn last_inbound_ms(&self) -> u64 {
        self.last_inbound_ms
    }

    /// Frames dropped because their generation was stale (§7.2).
    pub fn stale_generation_dropped(&self) -> u64 {
        self.stale_generation_dropped
    }

    /// Known-but-unexpected frames safely ignored (replay, response, ...).
    pub fn ignored_frames(&self) -> u64 {
        self.ignored_frames
    }

    /// Requests refused because the worker is draining.
    pub fn rejected_requests(&self) -> u64 {
        self.rejected_requests
    }

    /// Largest committed `command_sequence` reported by the worker.
    pub fn last_acked_command_sequence(&self) -> u64 {
        self.last_acked_command_sequence
    }

    /// Active drain, if any.
    pub fn drain_state(&self) -> Option<&DrainState> {
        self.drain.as_ref()
    }

    /// Whether no inbound frame arrived within `timeout_ms` (§2.3).
    pub fn heartbeat_expired(&self, now_ms: u64, timeout_ms: u64) -> bool {
        now_ms.saturating_sub(self.last_inbound_ms) >= timeout_ms
    }

    /// Take the events surfaced since the last call.
    pub fn take_events(&mut self) -> Vec<HostEvent> {
        core::mem::take(&mut self.events)
    }

    /// Borrow the outbound writer.
    pub fn writer_mut(&mut self) -> &mut FrameWriter<W> {
        &mut self.writer
    }

    /// Consume the driver, returning both halves of the transport.
    pub fn into_parts(self) -> (FrameReader<R>, FrameWriter<W>) {
        (self.reader, self.writer)
    }

    /// Write a host→worker transient `event` frame (§5.4, §2.3).
    ///
    /// The body carries `transport_sequence` equal to the frame header's
    /// sequence, as §5.4 requires. `event_seq` stays null because transient
    /// events are never committed, and the correlation id is all-zero because
    /// the event is not tied to a request.
    pub fn send_transient_event(
        &mut self,
        event: &str,
        session_id: Option<&str>,
        job_id: Option<&str>,
        turn_id: Option<&str>,
        payload: Json,
    ) -> Result<u64, HostError> {
        let transport_sequence = self.writer.next_sequence();
        let body = Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("event")),
            ("id", Json::Null),
            ("event", Json::string(event)),
            ("session_id", session_id.map(Json::string).unwrap_or(Json::Null)),
            ("job_id", job_id.map(Json::string).unwrap_or(Json::Null)),
            ("turn_id", turn_id.map(Json::string).unwrap_or(Json::Null)),
            ("transport_sequence", Json::u64(transport_sequence)),
            ("event_seq", Json::Null),
            ("payload_encoding", Json::string("json")),
            ("payload", payload),
        ]);
        self.write_control(FrameKind::Event, 0, [0; 16], &body)
    }

    /// Send the §2.3 transient `ipc.heartbeat` event.
    ///
    /// The heartbeat is a transient event, so it is not stored and carries no
    /// `event_seq`. The payload records the host's logical send time so a
    /// worker can observe cadence without treating it as durable state.
    pub fn send_heartbeat(&mut self, now_ms: u64) -> Result<u64, HostError> {
        self.send_transient_event(
            "ipc.heartbeat",
            None,
            None,
            None,
            Json::object(vec![("sent_at_ms", Json::u64(now_ms))]),
        )
    }

    /// Acknowledge a committed durable event (§5.5, §8.2).
    ///
    /// The caller must have committed `event_seq` to `host_event` first;
    /// sending this frame before the commit would violate commit-before-ack.
    pub fn send_durable_ack(&mut self, event_seq: u64) -> Result<u64, HostError> {
        // §3.2 requires a non-zero correlation id on `ack`. The committed
        // `host_event.seq` is the only stable id the host owns for this event,
        // so derive a UUID-shaped id from it (32 hex digits).
        let ack_id = format!("{event_seq:032x}");
        let body = Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("ack")),
            ("id", Json::string(&ack_id)),
            ("ack_of", Json::string(&ack_id)),
            ("phase", Json::string(AckPhase::DurableCommitted.as_str())),
            ("durable_through_command_sequence", Json::Null),
            ("event_seq", Json::u64(event_seq)),
            ("replay_complete", Json::bool(false)),
        ]);
        self.write_control(FrameKind::Ack, 0, correlation_from_id(&ack_id), &body)
    }

    /// Write a `cancel` frame (§5.6). Cancel intent is host-authoritative, so
    pub fn send_cancel(&mut self, cancel: &CancelRequest) -> Result<u64, HostError> {
        let body = Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("cancel")),
            ("id", Json::string(&cancel.id)),
            ("target_id", Json::string(&cancel.target_id)),
            (
                "target_transport_sequence",
                cancel.target_transport_sequence.map(Json::u64).unwrap_or(Json::Null),
            ),
            ("session_id", optional_json(&cancel.session_id)),
            ("job_id", optional_json(&cancel.job_id)),
            ("reason", Json::string(&cancel.reason)),
            ("deadline_ms", cancel.deadline_ms.map(Json::u64).unwrap_or(Json::Null)),
        ]);
        self.write_control(
            FrameKind::Cancel,
            FLAG_DURABLE | FLAG_REPLAYABLE,
            correlation_from_id(&cancel.id),
            &body,
        )
    }

    /// Write a `drain` frame and stop routing new requests (§5.7, §9.3).
    ///
    /// `deadline_ms` is the absolute logical deadline; the wire body carries the
    /// remaining budget so the worker sees a duration, matching §5.7. The
    /// driver does not kill the worker when the deadline passes.
    pub fn initiate_drain(
        &mut self,
        drain_id: &str,
        reason: DrainReason,
        deadline_ms: u64,
        now_ms: u64,
    ) -> Result<DrainState, HostError> {
        if self.drain.is_some() {
            return Err(HostError::protocol(
                "validation_error",
                "a drain is already in progress on this connection",
            ));
        }
        let state = DrainState {
            drain_id: drain_id.to_string(),
            reason,
            deadline_ms,
        };
        let body = Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("drain")),
            ("id", Json::string(drain_id)),
            ("drain_id", Json::string(drain_id)),
            ("reason", Json::string(reason.as_str())),
            ("deadline_ms", Json::u64(deadline_ms.saturating_sub(now_ms))),
            ("allow_new_requests", Json::bool(false)),
        ]);
        self.write_control(
            FrameKind::Drain,
            FLAG_DURABLE | FLAG_REPLAYABLE,
            correlation_from_id(drain_id),
            &body,
        )?;
        self.drain = Some(state.clone());
        Ok(state)
    }

    /// Route frames until the transport closes or the active drain resolves.
    ///
    /// Durable `sequence` gaps close the connection and mark the worker
    /// `crashed` (§7.3, §11.1). Stale-generation frames are dropped and
    /// counted (§7.2). Durable event commit/ack stays with the caller.
    pub fn serve<T: RequestRouter, C: Clock>(
        &mut self,
        registry: &mut WorkerRegistry,
        router: &mut T,
        clock: &mut C,
    ) -> Result<ServeOutcome, HostError> {
        loop {
            if self.drain_deadline_passed(clock) {
                return Ok(ServeOutcome::DrainTimedOut {
                    drain_id: self
                        .drain
                        .as_ref()
                        .map(|state| state.drain_id.clone())
                        .unwrap_or_default(),
                });
            }
            let Some((header, payload)) = self.next_frame(registry, clock)? else {
                return Ok(ServeOutcome::Closed);
            };
            if let Some(outcome) = self.handle_frame(header, payload, router)? {
                return Ok(outcome);
            }
        }
    }

    /// One bounded, non-blocking serve step (H2 Step 0, §2.2).
    ///
    /// Reads at most until the transport has no complete frame this round
    /// ([`ServeOutcome::Idle`]), the connection closes, or the drain resolves.
    /// `budget` caps frames and elapsed time so one busy connection cannot
    /// starve accept/tick/reap or other connections. A read timeout is `Idle`,
    /// never `Closed`.
    pub fn serve_available<T: RequestRouter, C: Clock>(
        &mut self,
        registry: &mut WorkerRegistry,
        router: &mut T,
        clock: &mut C,
        budget: ServeBudget,
    ) -> Result<ServeOutcome, HostError> {
        let started_ms = clock.now_ms();
        let mut frames = 0usize;
        loop {
            if self.drain_deadline_passed(clock) {
                return Ok(ServeOutcome::DrainTimedOut {
                    drain_id: self
                        .drain
                        .as_ref()
                        .map(|state| state.drain_id.clone())
                        .unwrap_or_default(),
                });
            }
            match self.try_next_frame(registry, clock)? {
                NextFrame::Eof => return Ok(ServeOutcome::Closed),
                NextFrame::NotReady => return Ok(ServeOutcome::Idle),
                NextFrame::Frame(header, payload) => {
                    frames += 1;
                    if let Some(outcome) = self.handle_frame(header, payload, router)? {
                        return Ok(outcome);
                    }
                }
            }
            if frames >= budget.max_frames
                || clock.now_ms().saturating_sub(started_ms) >= budget.max_ms
            {
                return Ok(ServeOutcome::Idle);
            }
        }
    }

    /// Apply one inbound frame. `Ok(None)` means "keep serving".
    fn handle_frame<T: RequestRouter>(
        &mut self,
        header: Header,
        payload: Vec<u8>,
        router: &mut T,
    ) -> Result<Option<ServeOutcome>, HostError> {
        if header.worker_generation != self.identity.worker_generation {
            self.stale_generation_dropped = self.stale_generation_dropped.saturating_add(1);
            return Ok(None);
        }
        if header.connection_id != self.identity.connection_id {
            return Err(HostError::protocol(
                "bad_header",
                format!(
                    "frame connection_id {} does not match connection {}",
                    header.connection_id, self.identity.connection_id
                ),
            ));
        }
        match header.frame_kind {
            FrameKind::Request => {
                self.handle_request(&payload, router)?;
            }
            FrameKind::Event => {
                let body = parse_body(&payload)?;
                let durable = header.flags & FLAG_DURABLE != 0;
                self.events.push(HostEvent::from_json(&body, durable, header.sequence)?);
            }
            FrameKind::Ack => {
                let ack = Ack::from_json(&parse_body(&payload)?)?;
                if let Some(outcome) = self.apply_ack(ack) {
                    return Ok(Some(outcome));
                }
            }
            FrameKind::Error => {
                let body = parse_body(&payload)?;
                let error = body.get("error").unwrap_or(&body);
                return Err(HostError::Remote {
                    code: error
                        .get("code")
                        .and_then(Json::as_str)
                        .unwrap_or("internal_error")
                        .to_string(),
                    message: error
                        .get("message")
                        .and_then(Json::as_str)
                        .unwrap_or_default()
                        .to_string(),
                });
            }
            FrameKind::Hello => {
                return Err(HostError::protocol(
                    "validation_error",
                    "hello received after the handshake completed",
                ));
            }
            // `response`, `cancel`, `drain`, and `replay` are not expected
            // from a worker in v0. They carry no host action, so ignoring
            // them is safe; unknown numeric kinds never reach this match.
            FrameKind::Response | FrameKind::Cancel | FrameKind::Drain | FrameKind::Replay => {
                self.ignored_frames = self.ignored_frames.saturating_add(1);
            }
        }
        Ok(None)
    }

    /// Wait for `ack(phase=drained)` after [`HostDriver::initiate_drain`].
    ///
    /// Reads frames until the drain resolves, the transport closes, or the
    /// logical deadline passes at a frame boundary. Blocking transports should
    /// also enforce a read timeout so an idle worker cannot stall the wait.
    pub fn await_drain<C: Clock>(
        &mut self,
        registry: &mut WorkerRegistry,
        clock: &mut C,
    ) -> Result<DrainOutcome, HostError> {
        let Some(state) = self.drain.clone() else {
            return Err(HostError::protocol(
                "validation_error",
                "await_drain called without an active drain",
            ));
        };
        loop {
            if self.drain_deadline_passed(clock) {
                return Ok(DrainOutcome::TimedOut { drain_id: state.drain_id.clone() });
            }
            let Some((header, payload)) = self.next_frame(registry, clock)? else {
                return Ok(DrainOutcome::Closed { drain_id: state.drain_id.clone() });
            };
            if header.worker_generation != self.identity.worker_generation {
                self.stale_generation_dropped = self.stale_generation_dropped.saturating_add(1);
                continue;
            }
            match header.frame_kind {
                FrameKind::Ack => {
                    let ack = Ack::from_json(&parse_body(&payload)?)?;
                    if let Some(outcome) = self.apply_ack(ack) {
                        return Ok(match outcome {
                            ServeOutcome::Drained(ack) => DrainOutcome::Drained(ack),
                            ServeOutcome::DrainTimedOut { drain_id } => {
                                DrainOutcome::TimedOut { drain_id }
                            }
                            ServeOutcome::Closed => {
                                DrainOutcome::Closed { drain_id: state.drain_id.clone() }
                            }
                            // `apply_ack` never reports Idle; keep waiting.
                            ServeOutcome::Idle => continue,
                        });
                    }
                }
                FrameKind::Event => {
                    let body = parse_body(&payload)?;
                    let durable = header.flags & FLAG_DURABLE != 0;
                    self.events.push(HostEvent::from_json(&body, durable, header.sequence)?);
                }
                FrameKind::Error => {
                    let body = parse_body(&payload)?;
                    let error = body.get("error").unwrap_or(&body);
                    return Err(HostError::Remote {
                        code: error
                            .get("code")
                            .and_then(Json::as_str)
                            .unwrap_or("internal_error")
                            .to_string(),
                        message: error
                            .get("message")
                            .and_then(Json::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
                _ => {
                    self.ignored_frames = self.ignored_frames.saturating_add(1);
                }
            }
        }
    }

    fn drain_deadline_passed<C: Clock>(&self, clock: &mut C) -> bool {
        match &self.drain {
            Some(state) => clock.now_ms() >= state.deadline_ms,
            None => false,
        }
    }

    /// Read one frame, mapping a durable sequence gap to a worker crash.
    fn next_frame<C: Clock>(
        &mut self,
        registry: &mut WorkerRegistry,
        clock: &mut C,
    ) -> Result<Option<(Header, Vec<u8>)>, HostError> {
        match self.reader.next_frame() {
            Ok(frame) => {
                if frame.is_some() {
                    self.last_inbound_ms = clock.now_ms();
                }
                Ok(frame)
            }
            Err(err) => Err(self.map_read_error(err, registry, clock)),
        }
    }

    /// Read one frame without blocking past a single transport read.
    ///
    /// Same sequence-gap accounting as [`HostDriver::next_frame`]; a read
    /// timeout is surfaced as [`NextFrame::NotReady`] instead of an error.
    fn try_next_frame<C: Clock>(
        &mut self,
        registry: &mut WorkerRegistry,
        clock: &mut C,
    ) -> Result<NextFrame, HostError> {
        match self.reader.try_next_frame() {
            Ok(NextFrame::Frame(header, payload)) => {
                self.last_inbound_ms = clock.now_ms();
                Ok(NextFrame::Frame(header, payload))
            }
            Ok(other) => Ok(other),
            Err(err) => Err(self.map_read_error(err, registry, clock)),
        }
    }

    /// Map a reader error, recording a durable sequence gap as a crash.
    fn map_read_error<C: Clock>(
        &mut self,
        err: ConnectionError,
        registry: &mut WorkerRegistry,
        clock: &mut C,
    ) -> HostError {
        if matches!(err.as_frame_error(), Some(FrameError::SequenceGap { .. })) {
            let _ = registry.mark_crashed(
                &self.identity.workspace_id,
                self.identity.worker_generation,
                clock.now_ms(),
            );
        }
        HostError::Connection(err)
    }

    fn handle_request<T: RequestRouter>(
        &mut self,
        payload: &[u8],
        router: &mut T,
    ) -> Result<(), HostError> {
        let request = IncomingRequest::from_json(&parse_body(payload)?)?;
        if self.drain.is_some() {
            self.rejected_requests = self.rejected_requests.saturating_add(1);
            let response = OutgoingResponse::error(
                &request.id,
                "worker_draining",
                "worker",
                true,
                "worker is draining; the request was not routed",
            );
            return self.write_response(&response);
        }
        let response = router.route(request);
        self.write_response(&response)
    }

    fn write_response(&mut self, response: &OutgoingResponse) -> Result<(), HostError> {
        let correlation = correlation_from_id(&response.id);
        self.write_control(FrameKind::Response, 0, correlation, &response.to_json())?;
        Ok(())
    }

    fn apply_ack(&mut self, ack: Ack) -> Option<ServeOutcome> {
        if let Some(sequence) = ack.durable_through_command_sequence {
            self.last_acked_command_sequence = self.last_acked_command_sequence.max(sequence);
        }
        if ack.phase != AckPhase::Drained {
            return None;
        }
        if self.drain.is_none() {
            self.ignored_frames = self.ignored_frames.saturating_add(1);
            return None;
        }
        let drain = DrainAck {
            ack_of: ack.ack_of,
            active_sessions: ack.active_sessions.unwrap_or(0),
            interrupted_turns: ack.interrupted_turns.unwrap_or(0),
        };
        self.drain = None;
        Some(ServeOutcome::Drained(drain))
    }

    fn write_control(
        &mut self,
        kind: FrameKind,
        flags: u16,
        correlation_id: [u8; 16],
        body: &Json,
    ) -> Result<u64, HostError> {
        let header = Header {
            protocol_version: PROTOCOL_VERSION_V0,
            frame_kind: kind,
            flags,
            payload_length: 0,
            connection_id: self.identity.connection_id,
            worker_generation: self.identity.worker_generation,
            sequence: 0,
            correlation_id,
            payload_crc32c: 0,
        };
        let rendered = body.render();
        let sequence = self.writer.write_frame(header, rendered.as_bytes())?;
        self.writer.flush()?;
        Ok(sequence)
    }
}

impl HostEvent {
    fn from_json(value: &Json, durable: bool, transport_sequence: u64) -> Result<Self, HostError> {
        let event = required_string(value, "event")?;
        let payload = value.get("payload").cloned().unwrap_or(Json::Null);
        if durable {
            return Ok(HostEvent::Durable(DurableEvent {
                event,
                session_id: optional_string(value, "session_id"),
                job_id: optional_string(value, "job_id"),
                turn_id: optional_string(value, "turn_id"),
                event_seq: value.get("event_seq").and_then(Json::as_u64),
                transport_sequence,
                payload,
            }));
        }
        Ok(HostEvent::Transient(TransientEvent {
            event,
            session_id: optional_string(value, "session_id"),
            turn_id: optional_string(value, "turn_id"),
            payload,
        }))
    }
}

impl IncomingRequest {
    fn from_json(value: &Json) -> Result<Self, HostError> {
        Ok(Self {
            id: required_string(value, "id")?,
            method: required_string(value, "method")?,
            session_id: optional_string(value, "session_id"),
            job_id: optional_string(value, "job_id"),
            turn_id: optional_string(value, "turn_id"),
            deadline_ms: value.get("deadline_ms").and_then(Json::as_u64),
            idempotency_key: optional_string(value, "idempotency_key"),
            params: value.get("params").cloned().unwrap_or(Json::Null),
        })
    }
}

/// Run the handshake for one connection and return a ready driver.
///
/// Reads the worker `hello`, negotiates through [`Handshake::accept_hello`],
/// writes `ready`, and waits for `ack(phase=hello_complete)` before marking the
/// worker `ready` in `registry`. On rejection it writes a §5.8 `error` frame,
/// records a `protocol_error` exit, and returns the rejection.
pub fn run_handshake<R: Read, W: Write>(
    mut reader: FrameReader<R>,
    mut writer: FrameWriter<W>,
    registry: &mut WorkerRegistry,
    workspace_id: &str,
    config: HostConfig,
    now_ms: u64,
) -> Result<HostDriver<R, W>, HostError> {
    let connection_id = config.connection_id;
    let worker_generation = config.worker_generation;
    let mut handshake = Handshake::new(config);
    let _ = registry.mark_handshaking(workspace_id, worker_generation, now_ms);

    let first = match reader.next_frame() {
        Ok(frame) => frame,
        Err(err) => {
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                HostError::Connection(err),
                None,
            ));
        }
    };
    let Some((header, payload)) = first else {
        return Err(fail_handshake(
            writer,
            registry,
            workspace_id,
            worker_generation,
            connection_id,
            now_ms,
            HostError::protocol("validation_error", "connection closed before hello"),
            None,
        ));
    };
    if header.frame_kind != FrameKind::Hello {
        return Err(fail_handshake(
            writer,
            registry,
            workspace_id,
            worker_generation,
            connection_id,
            now_ms,
            HostError::protocol("validation_error", "the first frame must be hello"),
            None,
        ));
    }
    let hello = match parse_body(&payload).and_then(|body| decode_hello(&body)) {
        Ok(hello) => hello,
        Err(err) => {
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                err,
                None,
            ));
        }
    };
    let ready = match handshake.accept_hello(hello) {
        Ok(ready) => ready,
        Err(reject) => {
            let error = HostError::Handshake(reject.clone());
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                error,
                Some(&reject),
            ));
        }
    };
    write_frame(
        &mut writer,
        connection_id,
        worker_generation,
        FrameKind::Hello,
        0,
        [0; 16],
        &encode_ready(&ready),
    )?;

    let hello_ack_frame = match reader.next_frame() {
        Ok(frame) => frame,
        Err(err) => {
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                HostError::Connection(err),
                None,
            ));
        }
    };
    let Some((header, payload)) = hello_ack_frame else {
        return Err(fail_handshake(
            writer,
            registry,
            workspace_id,
            worker_generation,
            connection_id,
            now_ms,
            HostError::protocol("validation_error", "connection closed before hello ack"),
            None,
        ));
    };
    let ack = if header.frame_kind == FrameKind::Ack
        && header.worker_generation == worker_generation
    {
        parse_body(&payload).and_then(|body| Ack::from_json(&body))
    } else {
        Err(HostError::protocol(
            "validation_error",
            "expected ack(hello_complete) after ready",
        ))
    };
    let hello_ack = match ack {
        Ok(ack) if ack.phase == AckPhase::HelloComplete => ack,
        Ok(_) => {
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                HostError::protocol("validation_error", "expected ack phase hello_complete"),
                None,
            ));
        }
        Err(err) => {
            return Err(fail_handshake(
                writer,
                registry,
                workspace_id,
                worker_generation,
                connection_id,
                now_ms,
                err,
                None,
            ));
        }
    };
    registry.mark_ready(workspace_id, worker_generation, now_ms)?;

    Ok(HostDriver {
        reader,
        writer,
        handshake,
        identity: HostIdentity {
            workspace_id: workspace_id.to_string(),
            connection_id,
            worker_generation,
        },
        last_inbound_ms: now_ms,
        stale_generation_dropped: 0,
        ignored_frames: 0,
        rejected_requests: 0,
        events: Vec::new(),
        last_acked_command_sequence: hello_ack.durable_through_command_sequence.unwrap_or(0),
        drain: None,
    })
}

/// Best-effort failure path: write an `error` frame when possible, then record
/// a `protocol_error` exit. The original error is always returned.
fn fail_handshake<W: Write>(
    mut writer: FrameWriter<W>,
    registry: &mut WorkerRegistry,
    workspace_id: &str,
    worker_generation: u64,
    connection_id: u64,
    now_ms: u64,
    error: HostError,
    reject: Option<&HandshakeReject>,
) -> HostError {
    let body = match reject {
        Some(reject) => encode_reject(reject),
        None => error_object(
            error.code(),
            error.category(),
            false,
            None,
            &error.to_string(),
            Json::Null,
        ),
    };
    let _ = write_frame(
        &mut writer,
        connection_id,
        worker_generation,
        FrameKind::Error,
        0,
        [0; 16],
        &Json::object(vec![
            ("v", Json::u64(BODY_VERSION_V0 as u64)),
            ("kind", Json::string("error")),
            ("id", Json::Null),
            ("error", body),
        ]),
    );
    let _ =
        registry.mark_exited(workspace_id, worker_generation, ExitReason::ProtocolError, now_ms);
    error
}

fn write_frame<W: Write>(
    writer: &mut FrameWriter<W>,
    connection_id: u64,
    worker_generation: u64,
    kind: FrameKind,
    flags: u16,
    correlation_id: [u8; 16],
    body: &Json,
) -> Result<u64, HostError> {
    let header = Header {
        protocol_version: PROTOCOL_VERSION_V0,
        frame_kind: kind,
        flags,
        payload_length: 0,
        connection_id,
        worker_generation,
        sequence: 0,
        correlation_id,
        payload_crc32c: 0,
    };
    let rendered = body.render();
    let sequence = writer.write_frame(header, rendered.as_bytes())?;
    writer.flush()?;
    Ok(sequence)
}

fn parse_body(payload: &[u8]) -> Result<Json, HostError> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| HostError::protocol("decode_error", "control body is not valid UTF-8"))?;
    Json::parse(text)
        .map_err(|err| HostError::protocol("validation_error", format!("invalid json body: {err}")))
}

fn decode_hello(value: &Json) -> Result<Hello, HostError> {
    let worker = value
        .get("worker")
        .ok_or_else(|| HostError::protocol("validation_error", "hello.worker is required"))?;
    let protocol = value
        .get("protocol")
        .ok_or_else(|| HostError::protocol("validation_error", "hello.protocol is required"))?;
    let limits = value
        .get("limits")
        .ok_or_else(|| HostError::protocol("validation_error", "hello.limits is required"))?;
    let workspace = value
        .get("workspace")
        .ok_or_else(|| HostError::protocol("validation_error", "hello.workspace is required"))?;
    Ok(Hello {
        v: required_u64(value, "v")? as u16,
        nonce: required_string(value, "nonce")?,
        worker: WorkerIdentity {
            pid: worker.get("pid").and_then(Json::as_u64).unwrap_or(0) as u32,
            build: optional_string(worker, "build").unwrap_or_default(),
            runtime: optional_string(worker, "runtime").unwrap_or_default(),
            boot_id: optional_string(worker, "boot_id").unwrap_or_default(),
        },
        protocol: ProtocolRange::new(
            required_u64(protocol, "min")? as u16,
            required_u64(protocol, "max")? as u16,
        ),
        encodings: string_list(value, "encodings")?,
        compressions: string_list(value, "compressions").unwrap_or_default(),
        capabilities: string_list(value, "capabilities")?,
        limits: HelloLimits { max_frame_bytes: required_u64(limits, "max_frame_bytes")? as u32 },
        workspace: Workspace {
            directory: required_string(workspace, "directory")?,
            project_id: required_string(workspace, "project_id")?,
        },
        resume: match value.get("resume") {
            Some(resume) if *resume != Json::Null => Some(HelloResume {
                last_acked_command_sequence: required_u64(resume, "last_acked_command_sequence")?,
                stream_epoch: required_string(resume, "stream_epoch")?,
            }),
            _ => None,
        },
    })
}

fn encode_ready(ready: &Ready) -> Json {
    Json::object(vec![
        ("v", Json::u64(ready.v as u64)),
        ("kind", Json::string(Ready::KIND)),
        ("phase", Json::string(Ready::PHASE)),
        ("connection_id", Json::u64(ready.connection_id)),
        ("worker_generation", Json::u64(ready.worker_generation)),
        ("protocol", Json::u64(ready.protocol as u64)),
        ("encodings", Json::strings(&ready.encodings)),
        ("compressions", Json::strings(&ready.compressions)),
        ("capabilities", Json::strings(&ready.capabilities)),
        (
            "limits",
            Json::object(vec![
                ("max_frame_bytes", Json::u64(ready.limits.max_frame_bytes as u64)),
                (
                    "max_reassembled_bytes",
                    Json::u64(ready.limits.max_reassembled_bytes as u64),
                ),
                ("max_fragments", Json::u64(ready.limits.max_fragments as u64)),
                ("heartbeat_ms", Json::u64(ready.limits.heartbeat_ms)),
                ("request_timeout_ms", Json::u64(ready.limits.request_timeout_ms)),
                (
                    "cancel_soft_timeout_ms",
                    Json::u64(ready.limits.cancel_soft_timeout_ms),
                ),
                (
                    "cancel_hard_timeout_ms",
                    Json::u64(ready.limits.cancel_hard_timeout_ms),
                ),
            ]),
        ),
        (
            "resume",
            Json::object(vec![
                ("from_command_sequence", Json::u64(ready.resume.from_command_sequence)),
                ("replay_available", Json::bool(ready.resume.replay_available)),
            ]),
        ),
    ])
}

fn encode_reject(reject: &HandshakeReject) -> Json {
    let mut details = vec![
        ("missing_capabilities", Json::strings(&reject.details.missing_capabilities)),
        ("unknown_capabilities", Json::strings(&reject.details.unknown_capabilities)),
    ];
    if let Some(range) = reject.details.worker_protocol {
        details.push(("worker_protocol", encode_protocol_range(range)));
    }
    if let Some(range) = reject.details.host_protocol {
        details.push(("host_protocol", encode_protocol_range(range)));
    }
    error_object(
        reject.code_str(),
        reject.category(),
        reject.retryable(),
        None,
        &reject.message,
        Json::object(details),
    )
}

fn encode_protocol_range(range: ProtocolRange) -> Json {
    Json::object(vec![("min", Json::u64(range.min as u64)), ("max", Json::u64(range.max as u64))])
}

fn error_object(
    code: &str,
    category: &str,
    retryable: bool,
    retry_after_ms: Option<u64>,
    message: &str,
    details: Json,
) -> Json {
    Json::object(vec![
        ("code", Json::string(code)),
        ("category", Json::string(category)),
        ("retryable", Json::bool(retryable)),
        ("retry_after_ms", retry_after_ms.map(Json::u64).unwrap_or(Json::Null)),
        ("message", Json::string(message)),
        ("details", details),
        ("cause_chain", Json::Array(Vec::new())),
    ])
}

fn optional_json(value: &Option<String>) -> Json {
    value.as_ref().map(Json::string).unwrap_or(Json::Null)
}

fn optional_string(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(|value| value.to_string())
}

fn required_string(value: &Json, key: &str) -> Result<String, HostError> {
    value
        .get(key)
        .and_then(Json::as_str)
        .map(|value| value.to_string())
        .ok_or_else(|| HostError::protocol("validation_error", format!("missing string field {key}")))
}

fn required_u64(value: &Json, key: &str) -> Result<u64, HostError> {
    value
        .get(key)
        .and_then(Json::as_u64)
        .ok_or_else(|| HostError::protocol("validation_error", format!("missing integer field {key}")))
}

fn string_list(value: &Json, key: &str) -> Result<Vec<String>, HostError> {
    let Some(items) = value.get(key).and_then(Json::as_array) else {
        return Err(HostError::protocol("validation_error", format!("missing array field {key}")));
    };
    items
        .iter()
        .map(|item| {
            item.as_str().map(|value| value.to_string()).ok_or_else(|| {
                HostError::protocol("validation_error", format!("{key} must contain strings"))
            })
        })
        .collect()
}

/// Decode a UUIDv7-shaped correlation id into its raw 16 bytes. Any id that is
/// not 32 hex digits (hyphens ignored) yields the all-zero "uncorrelated" value.
fn correlation_from_id(id: &str) -> [u8; 16] {
    let mut nibbles = Vec::with_capacity(32);
    for ch in id.chars() {
        if ch == '-' {
            continue;
        }
        match ch.to_digit(16) {
            Some(digit) => nibbles.push(digit as u8),
            None => return [0; 16],
        }
    }
    if nibbles.len() != 32 {
        return [0; 16];
    }
    let mut out = [0u8; 16];
    for index in 0..16 {
        out[index] = (nibbles[index * 2] << 4) | nibbles[index * 2 + 1];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::WorkerStatus;
    use std::cell::RefCell;
    use std::io::{self, Cursor};
    use std::rc::Rc;

    const CONNECTION: u64 = 17;
    const NONCE: &str = "one-time-token";

    /// In-memory transport that keeps the written bytes inspectable even when
    /// the driver (or a failed handshake) consumes the `FrameWriter`.
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

    fn registry_and_generation() -> (WorkerRegistry, u64) {
        let mut registry = WorkerRegistry::new();
        let record = registry.spawn_intent("ws_test", 0).expect("spawn intent");
        (registry, record.generation)
    }

    fn hello_json() -> String {
        r#"{
            "v": 1,
            "kind": "hello",
            "phase": "hello",
            "nonce": "one-time-token",
            "worker": {
                "pid": 12345,
                "build": "chimera-bun-worker@0.1.0",
                "runtime": "bun@1.2.3",
                "boot_id": "boot_1_12345"
            },
            "protocol": { "min": 256, "max": 256 },
            "encodings": ["json", "msgpack"],
            "compressions": [],
            "capabilities": [
                "frame.v1", "control.json", "event.batch", "cancel", "drain",
                "replay.command", "session.runtime"
            ],
            "limits": { "max_frame_bytes": 8388608 },
            "workspace": { "directory": "/abs/workspace", "project_id": "prj_test" },
            "resume": { "last_acked_command_sequence": 42, "stream_epoch": "epoch_1" }
        }"#
        .to_string()
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

    fn ack_hello_frame(generation: u64) -> Vec<u8> {
        raw_frame(
            FrameKind::Ack,
            0,
            2,
            generation,
            CONNECTION,
            r#"{"v":1,"kind":"ack","id":"a1","ack_of":"hello","phase":"hello_complete","durable_through_command_sequence":42,"event_seq":null,"replay_complete":false}"#,
        )
    }

    fn handshake_input(generation: u64) -> Vec<u8> {
        let mut input = hello_frame();
        input.extend(ack_hello_frame(generation));
        input
    }

    fn request_frame(sequence: u64, generation: u64, id: &str, method: &str) -> Vec<u8> {
        let body = format!(
            r#"{{"v":1,"kind":"request","id":"{id}","method":"{method}","session_id":"ses_1","job_id":null,"turn_id":"turn_1","deadline_ms":30000,"idempotency_key":null,"params":{{"text":"hi"}},"ext":{{}}}}"#
        );
        raw_frame(FrameKind::Request, 0, sequence, generation, CONNECTION, &body)
    }

    fn drain_ack_frame(generation: u64, sequence: u64) -> Vec<u8> {
        raw_frame(
            FrameKind::Ack,
            0,
            sequence,
            generation,
            CONNECTION,
            r#"{"v":1,"kind":"ack","id":"a2","ack_of":"drain_1","phase":"drained","durable_through_command_sequence":42,"event_seq":null,"replay_complete":false,"active_sessions":3,"interrupted_turns":1}"#,
        )
    }

    fn event_frame(sequence: u64, generation: u64, durable: bool, body: &str) -> Vec<u8> {
        let flags = if durable { FLAG_DURABLE } else { 0 };
        raw_frame(FrameKind::Event, flags, sequence, generation, CONNECTION, body)
    }

    fn config(generation: u64) -> HostConfig {
        let mut config = HostConfig::new(CONNECTION, generation);
        config.expected_nonce = Some(NONCE.to_string());
        config
    }

    fn handshake_driver(
        input: Vec<u8>,
        registry: &mut WorkerRegistry,
        generation: u64,
    ) -> (HostDriver<Cursor<Vec<u8>>, SharedSink>, SharedSink) {
        let reader = FrameReader::new(Cursor::new(input));
        let sink = SharedSink::default();
        let writer = FrameWriter::new(sink.clone());
        let driver = run_handshake(reader, writer, registry, "ws_test", config(generation), 0)
            .expect("handshake succeeds");
        (driver, sink)
    }

    fn frames_from(sink: &SharedSink) -> Vec<(Header, Json)> {
        let mut reader = FrameReader::new(Cursor::new(sink.bytes()));
        let mut frames = Vec::new();
        while let Some((header, payload)) = reader.next_frame().expect("output frame") {
            frames.push((header, Json::parse(std::str::from_utf8(&payload).unwrap()).unwrap()));
        }
        frames
    }

    fn fixed_clock(value: u64) -> impl FnMut() -> u64 {
        move || value
    }

    #[test]
    fn handshake_then_request_response_happy_path() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(request_frame(
            3,
            generation,
            "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a",
            "session.prompt",
        ));
        let (mut driver, sink) = handshake_driver(input, &mut registry, generation);

        assert_eq!(driver.identity().worker_generation, generation);
        assert!(matches!(driver.handshake_state(), HandshakeState::Ready(_)));
        assert_eq!(registry.get("ws_test", generation).unwrap().status, WorkerStatus::Ready);
        assert_eq!(driver.last_acked_command_sequence(), 42);

        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(10);
        let outcome = driver.serve(&mut registry, &mut router, &mut clock).expect("serve");
        assert_eq!(outcome, ServeOutcome::Closed);
        assert_eq!(router.seen.len(), 1);
        assert_eq!(router.seen[0].method, "session.prompt");
        assert_eq!(router.seen[0].session_id.as_deref(), Some("ses_1"));
        assert_eq!(driver.last_inbound_ms(), 10);

        let frames = frames_from(&sink);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0.frame_kind, FrameKind::Hello);
        assert_eq!(frames[0].1.get("phase").and_then(Json::as_str), Some("ready"));
        assert_eq!(
            frames[0].1.get("connection_id").and_then(Json::as_u64),
            Some(CONNECTION)
        );
        assert_eq!(frames[1].0.frame_kind, FrameKind::Response);
        assert_eq!(frames[1].1.get("status").and_then(Json::as_str), Some("ok"));
        assert_eq!(
            frames[1].1.get("id").and_then(Json::as_str),
            Some("0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a")
        );
        assert_eq!(frames[1].0.correlation_id[0], 0x01);
    }

    #[test]
    fn handshake_rejection_writes_error_frame_and_records_protocol_error() {
        let (mut registry, generation) = registry_and_generation();
        // Drop the required `drain` capability from hello.
        let hello = hello_json().replace("\"cancel\", \"drain\",", "\"cancel\",");
        let mut input = raw_frame(FrameKind::Hello, 0, 1, 0, 0, &hello);
        input.extend(ack_hello_frame(generation));

        let sink = SharedSink::default();
        let error = run_handshake(
            FrameReader::new(Cursor::new(input)),
            FrameWriter::new(sink.clone()),
            &mut registry,
            "ws_test",
            config(generation),
            0,
        )
        .expect_err("handshake must be rejected");
        assert_eq!(error.code(), "capability_missing");

        let record = registry.get("ws_test", generation).expect("worker record");
        assert_eq!(record.status, WorkerStatus::Exited);
        assert_eq!(record.exit_reason, Some(ExitReason::ProtocolError));

        let frames = frames_from(&sink);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].0.frame_kind, FrameKind::Error);
        let error_body = frames[0].1.get("error").expect("error object");
        assert_eq!(error_body.get("code").and_then(Json::as_str), Some("capability_missing"));
        let missing = error_body
            .get("details")
            .and_then(|details| details.get("missing_capabilities"))
            .and_then(Json::as_array)
            .expect("missing capabilities");
        assert_eq!(missing, &[Json::string("drain")]);
        assert_eq!(error_body.get("retryable").and_then(Json::as_bool), Some(false));
    }

    #[test]
    fn stale_generation_frames_are_dropped_and_counted() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(request_frame(3, generation + 1, "stale-id", "session.abort"));
        input.extend(request_frame(4, generation, "fresh-id", "session.prompt"));
        let (mut driver, sink) = handshake_driver(input, &mut registry, generation);

        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(1);
        assert_eq!(
            driver.serve(&mut registry, &mut router, &mut clock).expect("serve"),
            ServeOutcome::Closed
        );
        assert_eq!(driver.stale_generation_dropped(), 1);
        assert_eq!(router.seen.len(), 1);
        assert_eq!(router.seen[0].id, "fresh-id");
        let frames = frames_from(&sink);
        assert_eq!(frames.len(), 2, "only ready + the fresh response");
    }

    #[test]
    fn durable_sequence_gap_closes_and_marks_worker_crashed() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        // Reader expects transport_sequence 3; a durable frame at 5 is fatal.
        input.extend(event_frame(
            5,
            generation,
            true,
            r#"{"v":1,"kind":"event","event":"message.updated","event_seq":null,"payload":{}}"#,
        ));
        let (mut driver, _sink) = handshake_driver(input, &mut registry, generation);

        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(2);
        let error = driver.serve(&mut registry, &mut router, &mut clock).expect_err("gap");
        assert_eq!(error.code(), "sequence_gap");
        let record = registry.get("ws_test", generation).expect("worker record");
        assert_eq!(record.status, WorkerStatus::Crashed);
        assert_eq!(record.exit_reason, Some(ExitReason::Crash));
    }

    #[test]
    fn drain_writes_frame_waits_for_ack_and_reports_result() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(drain_ack_frame(generation, 3));
        let (mut driver, sink) = handshake_driver(input, &mut registry, generation);

        let state = driver
            .initiate_drain("drain_1", DrainReason::Restart, 5_000, 1_000)
            .expect("drain frame");
        assert_eq!(state.deadline_ms, 5_000);
        let frames = frames_from(&sink);
        let (header, body) = frames.last().expect("drain frame");
        assert_eq!(header.frame_kind, FrameKind::Drain);
        assert_eq!(body.get("kind").and_then(Json::as_str), Some("drain"));
        assert_eq!(body.get("reason").and_then(Json::as_str), Some("restart"));
        assert_eq!(body.get("allow_new_requests").and_then(Json::as_bool), Some(false));
        assert_eq!(body.get("deadline_ms").and_then(Json::as_u64), Some(4_000));

        let mut clock = fixed_clock(1_500);
        let outcome = driver.await_drain(&mut registry, &mut clock).expect("drain");
        assert_eq!(
            outcome,
            DrainOutcome::Drained(DrainAck {
                ack_of: Some("drain_1".to_string()),
                active_sessions: 3,
                interrupted_turns: 1,
            })
        );
        assert!(driver.drain_state().is_none());
    }

    #[test]
    fn drain_deadline_reports_timeout_without_killing() {
        let (mut registry, generation) = registry_and_generation();
        let (mut driver, _sink) = handshake_driver(handshake_input(generation), &mut registry, generation);

        driver
            .initiate_drain("drain_1", DrainReason::Shutdown, 100, 0)
            .expect("drain frame");
        let mut clock = fixed_clock(200);
        let outcome = driver.await_drain(&mut registry, &mut clock).expect("drain");
        assert_eq!(outcome, DrainOutcome::TimedOut { drain_id: "drain_1".to_string() });
        // The registry is untouched: escalation (SIGTERM/SIGKILL) is the caller's job.
        assert_eq!(registry.get("ws_test", generation).unwrap().status, WorkerStatus::Ready);
    }

    #[test]
    fn requests_during_drain_are_refused_without_routing() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(request_frame(3, generation, "late-id", "session.prompt"));
        let (mut driver, sink) = handshake_driver(input, &mut registry, generation);

        driver
            .initiate_drain("drain_1", DrainReason::Upgrade, 10_000, 0)
            .expect("drain frame");
        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(5);
        assert_eq!(
            driver.serve(&mut registry, &mut router, &mut clock).expect("serve"),
            ServeOutcome::Closed
        );
        assert!(router.seen.is_empty());
        assert_eq!(driver.rejected_requests(), 1);

        let frames = frames_from(&sink);
        let (header, body) = frames.last().expect("refusal response");
        assert_eq!(header.frame_kind, FrameKind::Response);
        assert_eq!(body.get("status").and_then(Json::as_str), Some("error"));
        assert_eq!(
            body.get("error").and_then(|error| error.get("code")).and_then(Json::as_str),
            Some("worker_draining")
        );
    }

    #[test]
    fn heartbeat_tracks_last_inbound_frame() {
        let (mut registry, generation) = registry_and_generation();
        let (driver, _sink) =
            handshake_driver(handshake_input(generation), &mut registry, generation);
        assert_eq!(driver.last_inbound_ms(), 0);
        assert!(driver.heartbeat_expired(30_000, HEARTBEAT_TIMEOUT_MS));

        let mut input = Vec::new();
        input.extend(event_frame(
            3,
            generation,
            false,
            r#"{"v":1,"kind":"event","event":"ipc.heartbeat","event_seq":null,"payload":{}}"#,
        ));
        let reader = FrameReader::new(Cursor::new(input));
        let writer = FrameWriter::new(SharedSink::default());
        let mut driver = HostDriver {
            reader,
            writer,
            handshake: Handshake::new(config(generation)),
            identity: driver.identity().clone(),
            last_inbound_ms: 0,
            stale_generation_dropped: 0,
            ignored_frames: 0,
            rejected_requests: 0,
            events: Vec::new(),
            last_acked_command_sequence: 0,
            drain: None,
        };
        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(500);
        driver.serve(&mut registry, &mut router, &mut clock).expect("serve");
        assert_eq!(driver.last_inbound_ms(), 500);
        assert!(!driver.heartbeat_expired(700, 400));
        assert!(driver.heartbeat_expired(900, 400));
    }

    #[test]
    fn durable_and_transient_events_are_separated() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(event_frame(
            3,
            generation,
            true,
            r#"{"v":1,"kind":"event","event":"message.updated","session_id":"ses_1","job_id":null,"turn_id":"turn_1","event_seq":9,"payload":{"a":1}}"#,
        ));
        input.extend(event_frame(
            4,
            generation,
            false,
            r#"{"v":1,"kind":"event","event":"message.part.delta","session_id":"ses_1","turn_id":"turn_1","event_seq":null,"payload":{"delta":"x"}}"#,
        ));
        let (mut driver, _sink) = handshake_driver(input, &mut registry, generation);

        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(1);
        driver.serve(&mut registry, &mut router, &mut clock).expect("serve");
        let events = driver.take_events();
        assert_eq!(events.len(), 2);
        match &events[0] {
            HostEvent::Durable(event) => {
                assert_eq!(event.event, "message.updated");
                assert_eq!(event.event_seq, Some(9));
                assert_eq!(event.job_id, None);
            }
            other => panic!("expected durable event, got {other:?}"),
        }
        match &events[1] {
            HostEvent::Transient(event) => {
                assert_eq!(event.event, "message.part.delta");
                assert_eq!(event.session_id.as_deref(), Some("ses_1"));
            }
            other => panic!("expected transient event, got {other:?}"),
        }
        assert!(driver.take_events().is_empty());
    }

    #[test]
    fn replay_frames_are_ignored_and_unknown_kinds_fail_safely() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        input.extend(raw_frame(
            FrameKind::Replay,
            0,
            3,
            generation,
            CONNECTION,
            r#"{"v":1,"kind":"replay","stream_epoch":"epoch_1","from_command_sequence":43,"to_command_sequence":60,"count":18,"truncated":false}"#,
        ));
        input.extend(request_frame(4, generation, "after-replay", "session.prompt"));
        let (mut driver, _sink) = handshake_driver(input, &mut registry, generation);

        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(1);
        assert_eq!(
            driver.serve(&mut registry, &mut router, &mut clock).expect("serve"),
            ServeOutcome::Closed
        );
        assert_eq!(driver.ignored_frames(), 1);
        assert_eq!(router.seen.len(), 1);
        assert_eq!(router.seen[0].id, "after-replay");

        // An unknown numeric frame_kind is rejected by the codec, not matched.
        let (mut registry, generation) = registry_and_generation();
        let (driver, _sink) =
            handshake_driver(handshake_input(generation), &mut registry, generation);
        let mut unknown = request_frame(3, generation, "unknown", "session.prompt");
        unknown[8] = 42;
        let reader = FrameReader::new(Cursor::new(unknown));
        let writer = FrameWriter::new(SharedSink::default());
        let mut driver = HostDriver {
            reader,
            writer,
            handshake: Handshake::new(config(generation)),
            identity: driver.identity().clone(),
            last_inbound_ms: 0,
            stale_generation_dropped: 0,
            ignored_frames: 0,
            rejected_requests: 0,
            events: Vec::new(),
            last_acked_command_sequence: 0,
            drain: None,
        };
        let error = driver
            .serve(&mut registry, &mut router, &mut clock)
            .expect_err("unknown kind");
        assert_eq!(error.code(), "unknown_frame_kind");
    }

    #[test]
    fn cancel_frame_carries_target_and_durable_flags() {
        let (mut registry, generation) = registry_and_generation();
        let (mut driver, sink) =
            handshake_driver(handshake_input(generation), &mut registry, generation);
        driver
            .send_cancel(&CancelRequest {
                id: "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2a".to_string(),
                target_id: "0192f0c4-7a3e-7c1b-9d2a-8f6e5d4c3b2b".to_string(),
                target_transport_sequence: Some(120),
                session_id: Some("ses_1".to_string()),
                job_id: None,
                reason: "user_abort".to_string(),
                deadline_ms: Some(5_000),
            })
            .expect("cancel frame");

        let frames = frames_from(&sink);
        let (header, body) = frames.last().expect("cancel frame");
        assert_eq!(header.frame_kind, FrameKind::Cancel);
        assert_eq!(header.flags & FLAG_DURABLE, FLAG_DURABLE);
        assert_eq!(body.get("kind").and_then(Json::as_str), Some("cancel"));
        assert_eq!(body.get("reason").and_then(Json::as_str), Some("user_abort"));
        assert_eq!(body.get("target_transport_sequence").and_then(Json::as_u64), Some(120));
        assert_eq!(body.get("job_id"), Some(&Json::Null));
    }

    #[test]
    fn json_parser_round_trips_escapes_and_numbers() {
        let parsed = Json::parse(r#"{"s":"a\"b\\c\n","n":-3,"u":18446744073709551615,"f":1.5,"a":[true,null]}"#)
            .expect("parse");
        assert_eq!(parsed.get("s").and_then(Json::as_str), Some("a\"b\\c\n"));
        assert_eq!(parsed.get("n").and_then(Json::as_u64), None);
        assert_eq!(parsed.get("u").and_then(Json::as_u64), Some(u64::MAX));
        assert_eq!(parsed.get("a").and_then(Json::as_array).map(|items| items.len()), Some(2));
        assert!(Json::parse("{").is_err());
        assert!(Json::parse("{} trailing").is_err());
    }

    #[test]
    fn serve_available_returns_idle_at_frame_budget_then_resumes() {
        let (mut registry, generation) = registry_and_generation();
        let mut input = handshake_input(generation);
        for sequence in 3..=6 {
            input.extend(event_frame(
                sequence,
                generation,
                false,
                r#"{"v":1,"kind":"event","event":"message.part.delta","session_id":"ses_1","turn_id":"turn_1","event_seq":null,"payload":{"delta":"x"}}"#,
            ));
        }
        let (mut driver, _sink) = handshake_driver(input, &mut registry, generation);

        let budget = ServeBudget { max_frames: 2, max_ms: u64::MAX };
        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(1);

        assert_eq!(
            driver
                .serve_available(&mut registry, &mut router, &mut clock, budget)
                .expect("first step"),
            ServeOutcome::Idle
        );
        assert_eq!(driver.take_events().len(), 2, "budget stops the step at 2 frames");

        assert_eq!(
            driver
                .serve_available(&mut registry, &mut router, &mut clock, budget)
                .expect("second step"),
            ServeOutcome::Idle
        );
        assert_eq!(driver.take_events().len(), 2, "the remaining frames resume next step");

        assert_eq!(
            driver
                .serve_available(&mut registry, &mut router, &mut clock, budget)
                .expect("third step"),
            ServeOutcome::Closed,
            "Idle is non-terminal; the next step still sees EOF"
        );
    }

    /// Reader that reports one read timeout, then EOF.
    struct TimeoutThenEof {
        timed_out: bool,
    }

    impl Read for TimeoutThenEof {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            if self.timed_out {
                return Ok(0);
            }
            self.timed_out = true;
            Err(io::Error::new(io::ErrorKind::WouldBlock, "no data this round"))
        }
    }

    #[test]
    fn serve_available_read_timeout_is_idle_not_closed() {
        let (mut registry, generation) = registry_and_generation();
        let mut driver = HostDriver {
            reader: FrameReader::new(TimeoutThenEof { timed_out: false }),
            writer: FrameWriter::new(SharedSink::default()),
            handshake: Handshake::new(config(generation)),
            identity: HostIdentity {
                workspace_id: "ws_test".to_string(),
                connection_id: CONNECTION,
                worker_generation: generation,
            },
            last_inbound_ms: 0,
            stale_generation_dropped: 0,
            ignored_frames: 0,
            rejected_requests: 0,
            events: Vec::new(),
            last_acked_command_sequence: 0,
            drain: None,
        };
        let mut router = RecordingRouter::new();
        let mut clock = fixed_clock(1);

        assert_eq!(
            driver
                .serve_available(&mut registry, &mut router, &mut clock, ServeBudget::DEFAULT)
                .expect("timeout is not an error"),
            ServeOutcome::Idle
        );
        assert_eq!(driver.last_inbound_ms(), 0, "Idle does not count as inbound traffic");

        assert_eq!(
            driver
                .serve_available(&mut registry, &mut router, &mut clock, ServeBudget::DEFAULT)
                .expect("eof"),
            ServeOutcome::Closed,
            "the Closed semantics are unchanged"
        );
    }
}