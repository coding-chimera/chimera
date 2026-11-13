//! Display projections over stored evidence.
//!
//! The rule this module enforces: long outputs are truncated **for display
//! only**, with an explicit `outputTruncatedForDisplay` marker plus the
//! original length; the underlying evidence in the store is never rewritten.
//! Callers that need the full output fetch it by id
//! ([`EvidenceStore::oracle`](crate::EvidenceStore::oracle)).

use serde::Serialize;
use serde_json::{Map, Value};

use crate::{EvidenceItem, Obligation, OracleRecord};

/// Maximum characters of a shell oracle output shown in a display
/// projection. Matches the Chimera swarm fan-out limit.
pub const DISPLAY_OUTPUT_MAX_CHARS: usize = 2_000;

/// Display projection of one obligation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObligationDisplay {
    /// Stable reference (`obligation:<id>`).
    pub reference: String,
    /// Obligation id.
    pub id: String,
    /// Lifecycle status.
    pub status: String,
    /// Human-readable target.
    pub target: String,
    /// Risk category label.
    pub risk: String,
    /// Optional classification label.
    pub classification: Option<String>,
    /// Why the obligation exists.
    pub reason: String,
    /// Evidence pointer.
    pub evidence: String,
    /// Why the obligation went stale, when it did.
    pub stale_reason: Option<String>,
    /// Owner session when claimed.
    pub claimed_by: Option<String>,
}

impl From<&Obligation> for ObligationDisplay {
    fn from(item: &Obligation) -> Self {
        ObligationDisplay {
            reference: format!("obligation:{}", item.id),
            id: item.id.clone(),
            status: item.status.as_str().to_string(),
            target: item.target.clone(),
            risk: item.risk.clone(),
            classification: item.classification.clone(),
            reason: item.reason.clone(),
            evidence: item.evidence.clone(),
            stale_reason: item.stale_reason.clone(),
            claimed_by: item
                .claimed_by
                .as_ref()
                .map(|owner| owner.actor.session_id.clone()),
        }
    }
}

/// Display projection of one oracle record.
///
/// When the payload's shell output exceeds
/// [`DISPLAY_OUTPUT_MAX_CHARS`] the projected output is truncated and
/// `output_truncated_for_display` is set with `output_original_chars`
/// recording the true length. The stored record is untouched.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OracleDisplay {
    /// Stable reference (`oracle:<id>`).
    pub reference: String,
    /// Oracle id.
    pub id: String,
    /// `shell` or `lsp`.
    pub kind: String,
    /// Verdict.
    pub status: String,
    /// Verification classification.
    pub verification_kind: String,
    /// Whether the verdict is trusted.
    pub trusted: bool,
    /// Tool call id that produced the result.
    pub tool_id: String,
    /// Session that produced the result.
    pub session_id: String,
    /// RFC 3339 finish timestamp.
    pub finished_at: String,
    /// Compacted payload for display.
    pub payload: Value,
}

impl From<&OracleRecord> for OracleDisplay {
    fn from(record: &OracleRecord) -> Self {
        OracleDisplay {
            reference: format!("oracle:{}", record.id),
            id: record.id.clone(),
            kind: record.kind.clone(),
            status: record.status.as_str().to_string(),
            verification_kind: record.verification_kind.as_str().to_string(),
            trusted: record.trusted,
            tool_id: record.tool_id.clone(),
            session_id: record.actor.session_id.clone(),
            finished_at: record.finished_at.clone(),
            payload: compact_oracle_payload(&record.payload),
        }
    }
}

/// Display projection of one evidence item.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvidenceItemDisplay {
    /// An obligation projection.
    Obligation(ObligationDisplay),
    /// An oracle projection.
    Oracle(OracleDisplay),
}

/// Project one evidence item for display.
#[must_use]
pub fn display_item(item: &EvidenceItem) -> EvidenceItemDisplay {
    match item {
        EvidenceItem::Obligation(item) => {
            EvidenceItemDisplay::Obligation(ObligationDisplay::from(item.as_ref()))
        }
        EvidenceItem::Oracle(record) => EvidenceItemDisplay::Oracle(OracleDisplay::from(record)),
    }
}

/// Project a batch of evidence items for display.
#[must_use]
pub fn display_items(items: &[EvidenceItem]) -> Vec<EvidenceItemDisplay> {
    items.iter().map(display_item).collect()
}

/// Compact an oracle payload for display: when `payload.shell.output` is a
/// string longer than [`DISPLAY_OUTPUT_MAX_CHARS`], the display copy is
/// truncated and stamped `outputTruncatedForDisplay: true` together with
/// `outputOriginalChars`. Every other field passes through unchanged.
#[must_use]
pub fn compact_oracle_payload(payload: &Value) -> Value {
    let Some(output) = payload
        .get("shell")
        .and_then(|shell| shell.get("output"))
        .and_then(Value::as_str)
    else {
        return payload.clone();
    };
    if output.chars().count() <= DISPLAY_OUTPUT_MAX_CHARS {
        return payload.clone();
    }
    let mut compacted = payload.clone();
    let Some(shell) = compacted.get_mut("shell") else {
        return payload.clone();
    };
    let Value::Object(shell_map) = shell else {
        return payload.clone();
    };
    let truncated: String = output.chars().take(DISPLAY_OUTPUT_MAX_CHARS).collect();
    let mut next = Map::new();
    for (key, value) in shell_map.iter() {
        if key == "output" {
            next.insert("output".into(), Value::String(truncated.clone()));
            next.insert("outputTruncatedForDisplay".into(), Value::Bool(true));
            next.insert(
                "outputOriginalChars".into(),
                Value::from(output.chars().count()),
            );
        } else {
            next.insert(key.clone(), value.clone());
        }
    }
    *shell = Value::Object(next);
    compacted
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shell_payload(output: &str) -> Value {
        json!({ "shell": { "command": "cargo test", "output": output } })
    }

    #[test]
    fn short_output_passes_through_untouched() {
        let payload = shell_payload("all good");
        assert_eq!(compact_oracle_payload(&payload), payload);
    }

    #[test]
    fn long_output_is_truncated_for_display_with_marker() {
        let output = "x".repeat(2_500);
        let payload = shell_payload(&output);
        let compacted = compact_oracle_payload(&payload);
        let shell = compacted.get("shell").unwrap();
        let shown = shell.get("output").unwrap().as_str().unwrap();
        assert_eq!(shown.chars().count(), DISPLAY_OUTPUT_MAX_CHARS);
        assert_eq!(
            shell.get("outputTruncatedForDisplay").unwrap(),
            &Value::Bool(true)
        );
        assert_eq!(
            shell.get("outputOriginalChars").unwrap(),
            &Value::from(2_500_usize)
        );
        // The original payload is untouched: full evidence is retained.
        assert_eq!(
            payload
                .get("shell")
                .unwrap()
                .get("output")
                .unwrap()
                .as_str()
                .unwrap(),
            &output
        );
        assert_eq!(
            payload
                .get("shell")
                .unwrap()
                .get("outputTruncatedForDisplay"),
            None
        );
    }

    #[test]
    fn non_shell_payload_passes_through() {
        let payload = json!({ "lsp": { "diagnostics": 3 } });
        assert_eq!(compact_oracle_payload(&payload), payload);
    }

    #[test]
    fn unicode_output_counts_chars_not_bytes() {
        let output = "é".repeat(2_500);
        let payload = shell_payload(&output);
        let compacted = compact_oracle_payload(&payload);
        let shown = compacted
            .get("shell")
            .unwrap()
            .get("output")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(shown.chars().count(), DISPLAY_OUTPUT_MAX_CHARS);
    }
}
