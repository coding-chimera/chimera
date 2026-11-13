//! Versioned project obligation/oracle evidence store for swarm fan-out and audit.
//!
//! This crate owns the Chimera-rs evidence contract described in
//! `docs/rfcs/CHIMERA_RS_MIGRATION_PLAN.md` §10.5: a versioned per-project
//! store for swarm obligation/oracle evidence. It is deliberately a plain
//! library — no Engine or ToolRegistry wiring; swarm and audit consumers
//! call it directly.
//!
//! Layout:
//!
//! - [`types`] — data model shared by storage and callers.
//! - [`store`] — the SQLite-backed [`EvidenceStore`] with the obligation
//!   state machine (`list`/`sync`/`claim`/`resolve`/`ignore`), oracle
//!   record/query, mutation audit trail, swarm source materialization and
//!   the one-time legacy import.
//! - [`display`] — display projections that truncate long outputs with an
//!   `outputTruncatedForDisplay` marker while storage keeps full evidence.
//!
//! Storage is one SQLite database per project root at
//! `<project>/.chimera/evidence.db`, so project isolation is a filesystem
//! property: two projects never share rows. Legacy `obligations.json` and
//! `oracle-results.jsonl` artifacts are imported once through
//! [`EvidenceStore::import_legacy`] and never written again.
#![forbid(unsafe_code)]

pub mod display;
pub mod store;
pub mod types;

pub use display::{
    DISPLAY_OUTPUT_MAX_CHARS, EvidenceItemDisplay, ObligationDisplay, OracleDisplay,
    compact_oracle_payload, display_item, display_items,
};
pub use store::{
    EVIDENCE_DB_FILE, EVIDENCE_DIR, EvidenceStore, ImportReport, LEGACY_OBLIGATIONS_FILE,
    LEGACY_ORACLE_RESULTS_FILE, MutationEvent, MutationRecord, MutationStatus, ObligationCounts,
    ObligationQuery, ObligationSeed, ObligationTransition, OracleQuery, OracleSeed, SyncOutcome,
    clamp_limit, evidence_db_path,
};
pub use types::{
    Actor, EvidenceItem, EvidenceSource, LIMIT_DEFAULT, LIMIT_MAX, Obligation, ObligationActor,
    ObligationIgnoreActor, ObligationResolveActor, ObligationSource, ObligationStatus,
    OracleLinkWindow, OracleLinkedChange, OracleRecord, OracleStatus, OracleVerification,
    OracleVerificationKind,
};

#[cfg(test)]
mod tests;
