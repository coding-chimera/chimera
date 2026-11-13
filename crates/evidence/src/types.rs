//! Shared evidence data types.
//!
//! Payloads are stored as JSON inside the SQLite store; every type here
//! round-trips through [`serde`] with stable field names so on-disk records
//! written by one build stay readable by the next.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default `limit` for swarm evidence sources and list queries.
pub const LIMIT_DEFAULT: usize = 20;
/// Maximum `limit` for swarm evidence sources and list queries.
pub const LIMIT_MAX: usize = 100;

/// Actor attribution stamped on obligation transitions and oracle records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor {
    /// Session that performed the action.
    pub session_id: String,
    /// Agent role name (worker, verifier, oracle...).
    pub agent: String,
    /// Optional tool call id for precise replay.
    pub call_id: Option<String>,
}

/// Obligation lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObligationStatus {
    /// Created by an audit, waiting for a worker.
    Pending,
    /// Exclusively owned by one actor.
    Claimed,
    /// Target no longer resolves in the current index.
    Stale,
    /// Work completed (terminal).
    Resolved,
    /// Explicitly waived with a reason (terminal).
    Ignored,
}

impl ObligationStatus {
    /// Stable wire string used in the database and JSON payloads.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ObligationStatus::Pending => "pending",
            ObligationStatus::Claimed => "claimed",
            ObligationStatus::Stale => "stale",
            ObligationStatus::Resolved => "resolved",
            ObligationStatus::Ignored => "ignored",
        }
    }
}

/// Actor + timestamp for a claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObligationActor {
    /// The actor that claimed.
    #[serde(flatten)]
    pub actor: Actor,
    /// RFC 3339 timestamp of the transition.
    pub at: String,
}

/// Actor + timestamp + note for a resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObligationResolveActor {
    /// The actor that resolved.
    #[serde(flatten)]
    pub actor: Actor,
    /// RFC 3339 timestamp of the transition.
    pub at: String,
    /// Optional note describing the resolving evidence.
    pub note: Option<String>,
}

/// Actor + timestamp + mandatory reason for an ignore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObligationIgnoreActor {
    /// The actor that ignored.
    #[serde(flatten)]
    pub actor: Actor,
    /// RFC 3339 timestamp of the transition.
    pub at: String,
    /// Required reason for ignoring.
    pub reason: String,
    /// Optional extra note.
    pub note: Option<String>,
}

/// Audit provenance of an obligation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObligationSource {
    /// Change/provenance id the obligation was derived from.
    #[serde(rename = "provenanceID")]
    pub provenance_id: Option<String>,
    /// Files changed in the producing audit run.
    pub changed_files: Vec<String>,
    /// Snapshot revision of the producing audit run.
    pub snapshot_revision: String,
}

/// A persisted obligation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Obligation {
    /// Storage schema version.
    pub schema_version: u64,
    /// Deterministic id (`obl_<16 hex>`).
    pub id: String,
    /// Full fingerprint the id was derived from.
    pub fingerprint: String,
    /// Lifecycle status.
    pub status: ObligationStatus,
    /// Human-readable target.
    pub target: String,
    /// Why the obligation exists.
    pub reason: String,
    /// Risk category label.
    pub risk: String,
    /// Optional classification label.
    pub classification: Option<String>,
    /// Evidence pointer backing the obligation.
    pub evidence: String,
    /// Audit provenance.
    pub source: ObligationSource,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 last-update timestamp.
    pub updated_at: String,
    /// Owner when claimed.
    pub claimed_by: Option<ObligationActor>,
    /// Resolver when resolved.
    pub resolved_by: Option<ObligationResolveActor>,
    /// Ignore record when ignored.
    pub ignored_by: Option<ObligationIgnoreActor>,
    /// Why the obligation went stale.
    pub stale_reason: Option<String>,
}

/// Oracle verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OracleStatus {
    /// The oracle passed.
    Pass,
    /// The oracle failed.
    Fail,
    /// The oracle could not decide.
    Unknown,
}

impl OracleStatus {
    /// Stable wire string used in the database and JSON payloads.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            OracleStatus::Pass => "pass",
            OracleStatus::Fail => "fail",
            OracleStatus::Unknown => "unknown",
        }
    }
}

/// Verification classification of an oracle result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OracleVerificationKind {
    /// LSP diagnostics oracle.
    Lsp,
    /// Test runner.
    Test,
    /// Type checker.
    Typecheck,
    /// Linter.
    Lint,
    /// Build system.
    Build,
    /// Explicitly declared by a user or tool.
    Explicit,
    /// Shell command that matched no known verification family.
    UnclassifiedShell,
    /// Unknown classification.
    Unknown,
}

impl OracleVerificationKind {
    /// Stable wire string used in the database and JSON payloads.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            OracleVerificationKind::Lsp => "lsp",
            OracleVerificationKind::Test => "test",
            OracleVerificationKind::Typecheck => "typecheck",
            OracleVerificationKind::Lint => "lint",
            OracleVerificationKind::Build => "build",
            OracleVerificationKind::Explicit => "explicit",
            OracleVerificationKind::UnclassifiedShell => "unclassified_shell",
            OracleVerificationKind::Unknown => "unknown",
        }
    }

    /// Whether the kind is trusted for commit gating.
    #[must_use]
    pub fn is_trusted(self) -> bool {
        matches!(
            self,
            OracleVerificationKind::Lsp
                | OracleVerificationKind::Test
                | OracleVerificationKind::Typecheck
                | OracleVerificationKind::Lint
                | OracleVerificationKind::Build
                | OracleVerificationKind::Explicit
        )
    }
}

/// Same-session preceding-mutation window that produced the oracle links.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OracleLinkWindow {
    /// Number of mutations the window retains.
    pub max_changes: usize,
}

/// A mutation linked to an oracle result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OracleLinkedChange {
    /// Mutation event id.
    pub id: String,
    /// Mutating tool call id.
    pub tool_id: String,
    /// Mutation outcome.
    pub status: crate::store::MutationStatus,
    /// RFC 3339 finish timestamp.
    pub finished_at: String,
    /// Graph revision before the mutation.
    pub before_revision: String,
    /// Graph revision after the mutation.
    pub after_revision: String,
    /// Files the mutation touched.
    pub files: Vec<String>,
    /// Optional wider change group id.
    pub change_id: Option<String>,
}

/// A persisted oracle result. The payload is kept verbatim; only the
/// display projection ([`crate::display`]) truncates long outputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OracleRecord {
    /// Storage schema version.
    pub schema_version: u64,
    /// Deterministic id (`oracle_<16 hex>`).
    pub id: String,
    /// `shell` or `lsp`.
    pub kind: String,
    /// Verdict.
    pub status: OracleStatus,
    /// Tool call id that produced the result.
    pub tool_id: String,
    /// Actor of the tool run.
    #[serde(rename = "tool")]
    pub actor: Actor,
    /// Verification classification.
    pub verification_kind: OracleVerificationKind,
    /// Whether the verdict is trusted for commit gating.
    pub trusted: bool,
    /// RFC 3339 finish timestamp.
    pub finished_at: String,
    /// Full structured payload (never truncated in storage).
    pub payload: Value,
    /// Mutation link window metadata.
    pub link_window: OracleLinkWindow,
    /// Mutations resolved from the link window.
    pub linked_changes: Vec<OracleLinkedChange>,
}

/// Inference details for [`OracleRecord::infer_verification`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OracleVerification {
    /// The inferred kind.
    pub kind: OracleVerificationKind,
    /// Whether the inferred kind is trusted.
    pub trusted: bool,
}

impl OracleRecord {
    /// Infer the verification classification for a record.
    ///
    /// `explicit` wins over inference; `lsp` kind maps to [`OracleVerificationKind::Lsp`];
    /// shell payloads are classified from the command string; anything else
    /// stays `unknown`.
    #[must_use]
    pub fn infer_verification(
        kind: &str,
        payload: &Value,
        explicit: Option<OracleVerificationKind>,
    ) -> OracleVerification {
        let kind_explicit = explicit.unwrap_or_else(|| {
            if kind == "lsp" {
                OracleVerificationKind::Lsp
            } else {
                classify_shell_command(payload_shell_command(payload))
            }
        });
        OracleVerification {
            kind: kind_explicit,
            trusted: kind_explicit.is_trusted(),
        }
    }
}

fn payload_shell_command(payload: &Value) -> Option<&str> {
    payload.get("shell")?.get("command")?.as_str()
}

fn classify_shell_command(command: Option<&str>) -> OracleVerificationKind {
    let Some(command) = command else {
        return OracleVerificationKind::UnclassifiedShell;
    };
    let value = command.to_ascii_lowercase();
    let words: Vec<&str> = value.split_whitespace().collect();
    // Subcommand following the first occurrence of `keyword`.
    let sub_after = |keyword: &str| -> Option<&str> {
        words
            .iter()
            .position(|word| *word == keyword)
            .and_then(|index| words.get(index + 1))
            .copied()
    };
    // Package-runner commands classify by their subcommand (pnpm lint → lint,
    // pnpm test → test) instead of the runner word itself.
    for runner in ["pnpm", "npm", "yarn", "bun", "just", "gradle", "mvn"] {
        if let Some(sub) = sub_after(runner) {
            match sub {
                "lint" | "eslint" | "ruff" | "clippy" => return OracleVerificationKind::Lint,
                "typecheck" | "tsc" | "mypy" | "pyright" | "check" => {
                    return OracleVerificationKind::Typecheck;
                }
                "test" | "vitest" | "jest" | "mocha" => return OracleVerificationKind::Test,
                "build" => return OracleVerificationKind::Build,
                _ => {}
            }
        }
    }
    for word in &words {
        match *word {
            "typecheck" | "type-check" | "tsc" | "tsgo" | "mypy" | "pyright" | "flow"
            | "vue-tsc" => return OracleVerificationKind::Typecheck,
            "lint" | "eslint" | "ruff" | "clippy" | "staticcheck" | "ktlint" | "swiftlint" => {
                return OracleVerificationKind::Lint;
            }
            "build" | "compile" | "xcodebuild" => return OracleVerificationKind::Build,
            "go" | "swift" => {
                // `go`/`swift` only count with a build/test subcommand.
                match sub_after(word) {
                    Some("build") => return OracleVerificationKind::Build,
                    Some("test") => return OracleVerificationKind::Test,
                    _ => {}
                }
            }
            "cargo" => {
                return match sub_after("cargo") {
                    Some("test") => OracleVerificationKind::Test,
                    Some("clippy") => OracleVerificationKind::Lint,
                    _ => OracleVerificationKind::Build,
                };
            }
            "test" | "pytest" | "vitest" | "jest" | "mocha" | "bun" | "pnpm" | "npm" | "yarn"
            | "just" | "gradle" | "mvn" => return OracleVerificationKind::Test,
            "biome" => {
                if sub_after("biome") == Some("lint") {
                    return OracleVerificationKind::Lint;
                }
            }
            _ => {}
        }
    }
    OracleVerificationKind::UnclassifiedShell
}

/// One of the seven swarm evidence sources addressable through `from`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceSource {
    /// `pending_obligations`.
    PendingObligations,
    /// `claimed_obligations`.
    ClaimedObligations,
    /// `stale_obligations`.
    StaleObligations,
    /// `active_obligations` (pending + claimed + stale).
    ActiveObligations,
    /// `failing_oracles`.
    FailingOracles,
    /// `unknown_oracles`.
    UnknownOracles,
    /// `failing_or_unknown_oracles`.
    FailingOrUnknownOracles,
}

impl EvidenceSource {
    /// Parse the `from` wire name. Unknown names are errors, not silently
    /// remapped defaults.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "pending_obligations" => Some(Self::PendingObligations),
            "claimed_obligations" => Some(Self::ClaimedObligations),
            "stale_obligations" => Some(Self::StaleObligations),
            "active_obligations" => Some(Self::ActiveObligations),
            "failing_oracles" => Some(Self::FailingOracles),
            "unknown_oracles" => Some(Self::UnknownOracles),
            "failing_or_unknown_oracles" => Some(Self::FailingOrUnknownOracles),
            _ => None,
        }
    }

    /// The `from` wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            EvidenceSource::PendingObligations => "pending_obligations",
            EvidenceSource::ClaimedObligations => "claimed_obligations",
            EvidenceSource::StaleObligations => "stale_obligations",
            EvidenceSource::ActiveObligations => "active_obligations",
            EvidenceSource::FailingOracles => "failing_oracles",
            EvidenceSource::UnknownOracles => "unknown_oracles",
            EvidenceSource::FailingOrUnknownOracles => "failing_or_unknown_oracles",
        }
    }

    /// All seven sources, in declaration order.
    #[must_use]
    pub fn all() -> [EvidenceSource; 7] {
        [
            EvidenceSource::PendingObligations,
            EvidenceSource::ClaimedObligations,
            EvidenceSource::StaleObligations,
            EvidenceSource::ActiveObligations,
            EvidenceSource::FailingOracles,
            EvidenceSource::UnknownOracles,
            EvidenceSource::FailingOrUnknownOracles,
        ]
    }
}

/// One materialized evidence item handed to swarm fan-out.
#[derive(Debug, Clone, PartialEq)]
pub enum EvidenceItem {
    /// An obligation record.
    Obligation(Box<Obligation>),
    /// An oracle record.
    Oracle(OracleRecord),
}

impl EvidenceItem {
    /// Stable reference string (`obligation:<id>` / `oracle:<id>`).
    #[must_use]
    pub fn reference(&self) -> String {
        match self {
            EvidenceItem::Obligation(item) => format!("obligation:{}", item.id),
            EvidenceItem::Oracle(record) => format!("oracle:{}", record.id),
        }
    }
}
