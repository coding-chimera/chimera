//! Read-only evidence-source port for swarm `from` fan-out (W2).
//!
//! Chimera's `from` sources read a project evidence store: pending/claimed/
//! stale/active obligations and failing/unknown oracles. W2 owns the port and
//! the empty-input contract; the obligation/oracle writers land in W4. Until
//! a writer materializes a store, a `from` fan-out fails loud with an
//! explicit empty-input error — never a fake item list, never a silently
//! successful run over zero items.
//!
//! The default implementation reads the same on-disk locations the Chimera
//! store owned (`<codegraph>/chimera/obligations.json` and
//! `oracle-results.jsonl`), read-only. A missing directory or an empty match
//! set is an error the model can act on, not a zero-item success.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::tools::spec::ToolError;

/// The evidence sources this port serves.
pub const EVIDENCE_SOURCES: &[&str] = &[
    "pending_obligations",
    "claimed_obligations",
    "stale_obligations",
    "active_obligations",
    "failing_oracles",
    "unknown_oracles",
    "failing_or_unknown_oracles",
];

/// The read-only port `from` fan-out consults.
pub trait SwarmEvidenceSource: Send + Sync {
    /// Materialize up to `limit` items for `source`. An empty result must be
    /// an `Err` (empty work input), never an empty fan-out.
    fn materialize(&self, source: &str, limit: u64) -> Result<Vec<Value>, ToolError>;
}

/// The default read-only store reader over the project's Chimera evidence
/// directory.
#[derive(Debug, Clone)]
pub struct FileEvidenceSource {
    root: PathBuf,
}

impl FileEvidenceSource {
    /// Build the reader for a project root (the workspace the parent session
    /// owns). The evidence directory is derived, not caller-supplied, so a
    /// model cannot point `from` at an arbitrary path.
    #[must_use]
    pub fn new(project_root: &Path) -> Self {
        Self {
            root: project_root.join(".codewhale").join("chimera"),
        }
    }

    /// The obligations store path.
    #[must_use]
    pub fn obligations_path(&self) -> PathBuf {
        self.root.join("obligations.json")
    }

    /// The oracle records path.
    #[must_use]
    pub fn oracles_path(&self) -> PathBuf {
        self.root.join("oracle-results.jsonl")
    }

    fn read_obligations(&self) -> Result<Vec<Value>, ToolError> {
        let path = self.obligations_path();
        let mut text = String::new();
        std::fs::File::open(&path)
            .and_then(|mut file| file.read_to_string(&mut text))
            .map_err(|error| ToolError::invalid_input(format!(
                "swarm from obligations store is unavailable at {}: {error}. Materialize the evidence store (W4) or pass explicit items.",
                path.display()
            )))?;
        let parsed: Value = serde_json::from_str(&text).map_err(|error| {
            ToolError::invalid_input(format!(
                "swarm from obligations store at {} is not valid JSON: {error}",
                path.display()
            ))
        })?;
        let obligations = parsed
            .get("obligations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(obligations)
    }

    fn read_oracles(&self) -> Result<Vec<Value>, ToolError> {
        let path = self.oracles_path();
        let mut text = String::new();
        std::fs::File::open(&path)
            .and_then(|mut file| file.read_to_string(&mut text))
            .map_err(|error| ToolError::invalid_input(format!(
                "swarm from oracle records are unavailable at {}: {error}. Materialize the evidence store (W4) or pass explicit items.",
                path.display()
            )))?;
        let mut records = Vec::new();
        for (line_number, line) in text.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let record: Value = serde_json::from_str(trimmed).map_err(|error| {
                ToolError::invalid_input(format!(
                    "swarm from oracle record at {}:{} is not valid JSON: {error}",
                    path.display(),
                    line_number + 1
                ))
            })?;
            records.push(record);
        }
        Ok(records)
    }
}

/// Obligation status filter per source (Chimera `batch-source.ts`).
fn obligation_matches(source: &str, status: Option<&str>) -> bool {
    let status = status.unwrap_or_default();
    match source {
        "pending_obligations" => status == "pending",
        "claimed_obligations" => status == "claimed",
        "stale_obligations" => status == "stale",
        // active: everything not resolved/ignored.
        _ => !matches!(status, "resolved" | "ignored"),
    }
}

/// Oracle status filter per source.
fn oracle_matches(source: &str, status: Option<&str>) -> bool {
    let status = status.unwrap_or_default();
    match source {
        "failing_oracles" => status == "fail",
        "unknown_oracles" => status == "unknown",
        _ => status == "fail" || status == "unknown",
    }
}

fn empty_source_error(source: &str, store: &str) -> ToolError {
    ToolError::invalid_input(format!(
        "swarm from '{source}' matched no evidence records in the {store} store. \
         Materialize the evidence store (W4 writers) or pass explicit items; \
         an empty work input cannot become a fan-out."
    ))
}

impl SwarmEvidenceSource for FileEvidenceSource {
    fn materialize(&self, source: &str, limit: u64) -> Result<Vec<Value>, ToolError> {
        if !EVIDENCE_SOURCES.contains(&source) {
            return Err(ToolError::invalid_input(format!(
                "swarm from must be one of {} (got '{source}')",
                EVIDENCE_SOURCES.join(", ")
            )));
        }
        let limit = (limit.clamp(1, 100)) as usize;
        if source.contains("obligations") {
            let obligations = self.read_obligations()?;
            let matched: Vec<Value> = obligations
                .into_iter()
                .filter(|item| {
                    obligation_matches(source, item.get("status").and_then(Value::as_str))
                })
                .take(limit)
                .collect();
            if matched.is_empty() {
                return Err(empty_source_error(source, "obligations"));
            }
            return Ok(matched);
        }
        let records = self.read_oracles()?;
        let matched: Vec<Value> = records
            .into_iter()
            .filter(|item| oracle_matches(source, item.get("status").and_then(Value::as_str)))
            .take(limit)
            .collect();
        if matched.is_empty() {
            return Err(empty_source_error(source, "oracles"));
        }
        Ok(matched)
    }
}

/// The in-memory port used when a host has no project store: every source
/// fails loud with the same empty-input error text the file reader produces.
#[derive(Debug, Clone, Default)]
pub struct NoopEvidenceSource {
    pub reason: String,
}

impl NoopEvidenceSource {
    #[must_use]
    pub fn new() -> Self {
        Self {
            reason: "the evidence store is not materialized for this project".to_string(),
        }
    }
}

impl SwarmEvidenceSource for NoopEvidenceSource {
    fn materialize(&self, source: &str, _limit: u64) -> Result<Vec<Value>, ToolError> {
        Err(ToolError::invalid_input(format!(
            "swarm from '{source}' has no evidence records: {}. \
             Materialize the evidence store (W4 writers) or pass explicit items; \
             an empty work input cannot become a fan-out.",
            self.reason
        )))
    }
}
