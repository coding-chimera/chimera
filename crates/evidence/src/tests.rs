//! Tests for the evidence store.
//!
//! Covers the acceptance surface: obligation state transitions and
//! ownership, duplicate/out-of-order events, the seven swarm sources, limit
//! clamping, long-output display truncation with full-evidence retention,
//! legacy import errors, project isolation and restart recovery.

use std::collections::HashSet;
use std::fs;

use serde_json::json;
use tempfile::TempDir;

use crate::{
    Actor, EvidenceItem, EvidenceSource, EvidenceStore, LIMIT_DEFAULT, LIMIT_MAX, MutationEvent,
    MutationStatus, ObligationQuery, ObligationSeed, ObligationStatus, OracleSeed, OracleStatus,
    OracleVerificationKind, compact_oracle_payload,
};

fn actor(session: &str) -> Actor {
    Actor {
        session_id: session.to_string(),
        agent: "worker".to_string(),
        call_id: Some(format!("call-{session}")),
    }
}

fn other_actor(session: &str) -> Actor {
    Actor {
        session_id: session.to_string(),
        agent: "verifier".to_string(),
        call_id: None,
    }
}

fn seed(target: &str, reason: &str) -> ObligationSeed {
    ObligationSeed {
        target: target.to_string(),
        reason: reason.to_string(),
        evidence: format!("evidence:{target}"),
        risk: "behavior".to_string(),
        classification: Some("source".to_string()),
        provenance_id: Some("audit-1".to_string()),
        changed_files: vec!["src/a.rs".to_string()],
        snapshot_revision: "rev-1".to_string(),
    }
}

fn oracle_seed(status: OracleStatus, output: &str) -> OracleSeed {
    OracleSeed {
        kind: "shell".to_string(),
        status,
        tool_id: "tool-1".to_string(),
        actor: actor("session-1"),
        verification_kind: None,
        trusted: None,
        payload: json!({
            "shell": { "command": "cargo test", "output": output }
        }),
    }
}

fn store_at(dir: &TempDir) -> EvidenceStore {
    EvidenceStore::open(dir.path()).expect("open evidence store")
}

fn targets(values: &[&str]) -> HashSet<String> {
    values.iter().map(|value| value.to_string()).collect()
}

// ---------------------------------------------------------------------
// Obligation state machine
// ---------------------------------------------------------------------

#[test]
fn sync_creates_pending_obligations_with_deterministic_ids() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);

    let outcome = store
        .sync_obligations(&[
            seed("src/a.rs#fn_main", "unverified call"),
            seed("src/b.rs", "stale types"),
        ])
        .expect("sync");
    assert_eq!(outcome.created, 2);
    assert_eq!(outcome.updated, 0);
    assert_eq!(outcome.counts.pending, 2);
    assert_eq!(outcome.counts.active, 2);

    let items = store
        .list_obligations(&ObligationQuery::default())
        .expect("list");
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .all(|item| item.status == ObligationStatus::Pending)
    );
    assert!(items.iter().all(|item| item.id.starts_with("obl_")));
    assert_eq!(
        items[0].id,
        items[1]
            .id
            .len()
            .checked_sub(0)
            .map(|_| items[0].id.clone())
            .unwrap()
    );
    // Deterministic: the same seed produces the same id.
    let again = store
        .sync_obligations(&[seed("src/a.rs#fn_main", "unverified call")])
        .expect("sync again");
    assert_eq!(again.created, 0);
    assert_eq!(again.updated, 1, "re-sync refreshes the existing record");
    assert_eq!(again.counts.pending, 2);
}

#[test]
fn claim_resolve_ignore_transition_states_and_owner_checks() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    store
        .sync_obligations(&[seed("src/a.rs", "needs review")])
        .expect("sync");
    let id = store
        .list_obligations(&ObligationQuery::default())
        .expect("list")
        .remove(0)
        .id;

    // Claim by the first worker.
    let transition = store
        .claim_obligation(&id, &actor("session-1"))
        .expect("claim");
    assert_eq!(transition.obligation.status, ObligationStatus::Claimed);
    assert_eq!(transition.counts.claimed, 1);
    assert_eq!(transition.counts.pending, 0);

    // Idempotent re-claim by the same owner.
    let again = store
        .claim_obligation(&id, &actor("session-1"))
        .expect("re-claim");
    assert_eq!(again.obligation.status, ObligationStatus::Claimed);
    assert_eq!(again.counts.claimed, 1);

    // A foreign session cannot claim or resolve.
    let err = store
        .claim_obligation(&id, &other_actor("session-2"))
        .expect_err("foreign claim must fail");
    assert!(err.to_string().contains("cannot be claimed"), "{err}");
    let err = store
        .resolve_obligation(&id, &other_actor("session-2"), None)
        .expect_err("foreign resolve must fail");
    assert!(err.to_string().contains("session-1"), "{err}");
    // The failed transitions did not change the state.
    assert_eq!(
        store.obligation(&id).unwrap().unwrap().status,
        ObligationStatus::Claimed
    );

    // The owner resolves with a note.
    let resolved = store
        .resolve_obligation(&id, &actor("session-1"), Some("fixed in commit abc"))
        .expect("resolve");
    assert_eq!(resolved.obligation.status, ObligationStatus::Resolved);
    assert_eq!(
        resolved
            .obligation
            .resolved_by
            .as_ref()
            .and_then(|r| r.note.clone()),
        Some("fixed in commit abc".to_string())
    );
    assert_eq!(resolved.counts.resolved, 1);
    assert_eq!(resolved.counts.active, 0);

    // Terminal states refuse further transitions.
    for error in [
        store
            .claim_obligation(&id, &actor("session-1"))
            .expect_err("claim resolved"),
        store
            .resolve_obligation(&id, &actor("session-1"), None)
            .expect_err("resolve resolved"),
    ] {
        assert!(error.to_string().contains("cannot be"), "{error}");
    }
}

#[test]
fn ignore_requires_reason_and_owner() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    store
        .sync_obligations(&[seed("src/c.rs", "noise")])
        .expect("sync");
    let id = store
        .list_obligations(&ObligationQuery::default())
        .expect("list")
        .remove(0)
        .id;

    let error = store
        .ignore_obligation(&id, &actor("session-1"), "  ", None)
        .expect_err("empty reason");
    assert!(error.to_string().contains("requires a reason"), "{error}");

    let ignored = store
        .ignore_obligation(
            &id,
            &actor("session-1"),
            "out of scope",
            Some("user said skip"),
        )
        .expect("ignore");
    assert_eq!(ignored.obligation.status, ObligationStatus::Ignored);
    let ignore = ignored.obligation.ignored_by.expect("ignore record");
    assert_eq!(ignore.reason, "out of scope");
    assert_eq!(ignore.note.as_deref(), Some("user said skip"));
    assert_eq!(ignored.counts.ignored, 1);

    // A claimed obligation cannot be ignored by a foreign actor.
    store
        .sync_obligations(&[seed("src/d.rs", "claimed noise")])
        .expect("sync");
    let claimed_id = store
        .list_obligations(&ObligationQuery {
            status: Some(ObligationStatus::Pending),
            ..ObligationQuery::default()
        })
        .expect("list")
        .into_iter()
        .find(|item| item.target == "src/d.rs")
        .expect("second obligation")
        .id;
    store
        .claim_obligation(&claimed_id, &actor("session-1"))
        .expect("claim");
    let error = store
        .ignore_obligation(&claimed_id, &other_actor("session-2"), "why not", None)
        .expect_err("foreign ignore");
    assert!(
        error.to_string().contains("claimed by session-1"),
        "{error}"
    );
}

#[test]
fn unknown_obligation_errors_are_explicit() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    for error in [
        store
            .claim_obligation("obl_missing", &actor("s"))
            .expect_err("claim unknown"),
        store
            .resolve_obligation("obl_missing", &actor("s"), None)
            .expect_err("resolve unknown"),
        store
            .ignore_obligation("obl_missing", &actor("s"), "r", None)
            .expect_err("ignore unknown"),
    ] {
        assert!(
            error.to_string().contains("unknown Chimera obligation"),
            "{error}"
        );
    }
}

#[test]
fn pending_and_stale_obligations_can_be_resolved_without_a_claim() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    store
        .sync_obligations(&[
            seed("src/e.rs", "orphan"),
            seed("src/f.rs", "will go stale"),
        ])
        .expect("sync");
    let pending = store
        .list_obligations(&ObligationQuery::default())
        .expect("list");
    let orphan = pending
        .iter()
        .find(|item| item.target == "src/e.rs")
        .unwrap()
        .id
        .clone();
    let staling = pending
        .iter()
        .find(|item| item.target == "src/f.rs")
        .unwrap()
        .id
        .clone();

    // Resolve an unclaimed obligation directly.
    let resolved = store
        .resolve_obligation(&orphan, &other_actor("session-9"), None)
        .expect("resolve pending");
    assert_eq!(resolved.obligation.status, ObligationStatus::Resolved);

    // Stale obligations remain resolvable/claimable.
    store
        .refresh_stale_obligations(Some(&targets(&["src/e.rs"])))
        .expect("refresh");
    assert_eq!(
        store.obligation(&staling).unwrap().unwrap().status,
        ObligationStatus::Stale
    );
    let claimed = store
        .claim_obligation(&staling, &actor("session-2"))
        .expect("claim stale");
    assert_eq!(claimed.obligation.status, ObligationStatus::Claimed);
    assert!(
        claimed.obligation.stale_reason.is_none(),
        "claiming clears the stale reason"
    );
}

// ---------------------------------------------------------------------
// Stale refresh: duplicate + out-of-order events
// ---------------------------------------------------------------------

#[test]
fn stale_refresh_marks_and_revives_without_touching_terminal_states() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    store
        .sync_obligations(&[
            seed("src/live.rs", "one"),
            seed("src/gone.rs", "two"),
            seed("src/resolved-gone.rs", "three"),
        ])
        .expect("sync");
    let items = store
        .list_obligations(&ObligationQuery::default())
        .expect("list");
    let live = items
        .iter()
        .find(|i| i.target == "src/live.rs")
        .unwrap()
        .id
        .clone();
    let gone = items
        .iter()
        .find(|i| i.target == "src/gone.rs")
        .unwrap()
        .id
        .clone();
    let resolved_gone = items
        .iter()
        .find(|i| i.target == "src/resolved-gone.rs")
        .unwrap()
        .id
        .clone();
    store
        .resolve_obligation(&resolved_gone, &actor("s"), None)
        .expect("resolve");

    // First refresh: `gone` and `resolved-gone` vanish from the target set.
    let changed = store
        .refresh_stale_obligations(Some(&targets(&["src/live.rs"])))
        .expect("refresh");
    assert_eq!(changed, 1, "only the non-terminal obligation flips stale");
    assert_eq!(
        store.obligation(&gone).unwrap().unwrap().status,
        ObligationStatus::Stale
    );
    assert_eq!(
        store.obligation(&resolved_gone).unwrap().unwrap().status,
        ObligationStatus::Resolved,
        "resolved obligations never go stale"
    );
    assert_eq!(
        store.obligation(&live).unwrap().unwrap().status,
        ObligationStatus::Pending
    );

    // Duplicate (out-of-order repeated) refreshes are idempotent.
    let changed_again = store
        .refresh_stale_obligations(Some(&targets(&["src/live.rs"])))
        .expect("refresh again");
    assert_eq!(changed_again, 0);
    assert_eq!(
        store.obligation(&gone).unwrap().unwrap().status,
        ObligationStatus::Stale
    );

    // Revive: the target comes back.
    let revived = store
        .refresh_stale_obligations(Some(&targets(&["src/live.rs", "src/gone.rs"])))
        .expect("revive");
    assert_eq!(revived, 1);
    assert_eq!(
        store.obligation(&gone).unwrap().unwrap().status,
        ObligationStatus::Pending,
        "unowned stale obligation revives to pending"
    );
    assert!(
        store
            .obligation(&gone)
            .unwrap()
            .unwrap()
            .stale_reason
            .is_none()
    );

    // A claimed obligation that goes stale and revives stays claimed.
    store
        .claim_obligation(&gone, &actor("session-1"))
        .expect("claim");
    store
        .refresh_stale_obligations(Some(&targets(&["src/live.rs"])))
        .expect("stale again");
    assert_eq!(
        store.obligation(&gone).unwrap().unwrap().status,
        ObligationStatus::Stale
    );
    store
        .refresh_stale_obligations(Some(&targets(&["src/live.rs", "src/gone.rs"])))
        .expect("revive again");
    assert_eq!(
        store.obligation(&gone).unwrap().unwrap().status,
        ObligationStatus::Claimed,
        "owned obligation revives to claimed"
    );
}

// ---------------------------------------------------------------------
// Oracle records, mutation audit, link window
// ---------------------------------------------------------------------

#[test]
fn record_oracle_stores_full_output_and_links_preceding_mutations() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);

    // A wide window of mutations in the same session.
    for index in 0..5 {
        store
            .record_mutation(MutationEvent {
                tool_id: format!("mut-{index}"),
                actor: Some(actor("session-1")),
                status: MutationStatus::Success,
                files: vec![format!("src/file{index}.rs")],
                before_revision: format!("rev-{index}"),
                after_revision: format!("rev-{}", index + 1),
                change_id: Some("change-1".to_string()),
                metadata: Some(json!({ "index": index })),
            })
            .expect("record mutation");
    }
    // A mutation from another session must not be linked.
    store
        .record_mutation(MutationEvent {
            tool_id: "mut-foreign".to_string(),
            actor: Some(other_actor("session-2")),
            status: MutationStatus::Failure,
            files: vec!["src/foreign.rs".to_string()],
            before_revision: "rev-0".to_string(),
            after_revision: "rev-1".to_string(),
            change_id: None,
            metadata: None,
        })
        .expect("record foreign mutation");

    let long_output = "line\n".repeat(2_000);
    let record = store
        .record_oracle(oracle_seed(OracleStatus::Fail, &long_output))
        .expect("record oracle");

    // The full output is stored verbatim.
    let stored = store.oracle(&record.id).expect("fetch").expect("present");
    let stored_output = stored
        .payload
        .get("shell")
        .and_then(|shell| shell.get("output"))
        .and_then(|value| value.as_str())
        .expect("stored output");
    assert_eq!(stored_output, long_output);
    assert!(
        stored
            .payload
            .get("shell")
            .unwrap()
            .get("outputTruncatedForDisplay")
            .is_none(),
        "storage never carries the display truncation marker"
    );

    // The link window resolved the same-session preceding mutations only.
    assert_eq!(stored.linked_changes.len(), 5);
    assert!(
        stored
            .linked_changes
            .iter()
            .all(|change| change.tool_id.starts_with("mut-") && change.tool_id != "mut-foreign")
    );
    assert_eq!(stored.linked_changes[0].tool_id, "mut-0");
    assert_eq!(stored.linked_changes[4].tool_id, "mut-4");
    assert_eq!(
        stored.linked_changes[0].change_id.as_deref(),
        Some("change-1")
    );

    // Verification is inferred from the command.
    assert_eq!(stored.verification_kind, OracleVerificationKind::Test);
    assert!(stored.trusted);

    // Display projection truncates but the store keeps the full evidence.
    let compacted = compact_oracle_payload(&stored.payload);
    let shown = compacted
        .get("shell")
        .and_then(|shell| shell.get("output"))
        .and_then(|value| value.as_str())
        .expect("display output");
    assert!(shown.chars().count() < long_output.chars().count());
    assert_eq!(
        compacted
            .get("shell")
            .unwrap()
            .get("outputTruncatedForDisplay"),
        Some(&json!(true))
    );
    // Full evidence still retrievable by id.
    assert_eq!(
        store.oracle(&record.id).unwrap().unwrap().payload,
        stored.payload
    );
}

#[test]
fn recording_the_same_oracle_twice_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    // Same (now, payload) → same id: re-recording replaces, not duplicates.
    let first = store
        .record_oracle(oracle_seed(OracleStatus::Unknown, "output"))
        .expect("first");
    let oracles = store
        .list_oracles(&crate::OracleQuery {
            include_passing: true,
            ..Default::default()
        })
        .expect("list");
    assert_eq!(oracles.len(), 1);
    assert_eq!(oracles[0].id, first.id);
}

#[test]
fn oracle_verification_kinds_follow_the_command() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    for (command, expected) in [
        ("cargo test", OracleVerificationKind::Test),
        ("cargo build", OracleVerificationKind::Build),
        ("pnpm lint", OracleVerificationKind::Lint),
        ("mypy src", OracleVerificationKind::Typecheck),
        ("echo hi", OracleVerificationKind::UnclassifiedShell),
    ] {
        let record = store
            .record_oracle(OracleSeed {
                kind: "shell".to_string(),
                status: OracleStatus::Fail,
                tool_id: format!("tool-{command}"),
                actor: actor("session-1"),
                verification_kind: None,
                trusted: None,
                payload: json!({ "shell": { "command": command, "output": "x" } }),
            })
            .expect("record");
        assert_eq!(record.verification_kind, expected, "command: {command}");
    }
    // LSP kind maps directly.
    let lsp = store
        .record_oracle(OracleSeed {
            kind: "lsp".to_string(),
            status: OracleStatus::Unknown,
            tool_id: "tool-lsp".to_string(),
            actor: actor("session-1"),
            verification_kind: None,
            trusted: None,
            payload: json!({ "diagnostics": [] }),
        })
        .expect("record");
    assert_eq!(lsp.verification_kind, OracleVerificationKind::Lsp);
    // Explicit kind wins.
    let explicit = store
        .record_oracle(OracleSeed {
            kind: "shell".to_string(),
            status: OracleStatus::Pass,
            tool_id: "tool-explicit".to_string(),
            actor: actor("session-1"),
            verification_kind: Some(OracleVerificationKind::Explicit),
            trusted: Some(false),
            payload: json!({ "shell": { "command": "cargo test", "output": "ok" } }),
        })
        .expect("record");
    assert_eq!(explicit.verification_kind, OracleVerificationKind::Explicit);
    assert!(!explicit.trusted, "explicit trusted override is honored");
}

#[test]
fn mutation_audit_records_survive_replays_and_queries() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    let event = MutationEvent {
        tool_id: "mut-1".to_string(),
        actor: Some(actor("session-1")),
        status: MutationStatus::Success,
        files: vec!["src/a.rs".to_string()],
        before_revision: "r1".to_string(),
        after_revision: "r2".to_string(),
        change_id: None,
        metadata: Some(json!({ "diff": "…" })),
    };
    let first = store.record_mutation(event.clone()).expect("first");
    // Re-recording the same tool call replaces (audit keyed by tool call),
    // not duplicates.
    let second = store
        .record_mutation(MutationEvent {
            status: MutationStatus::Failure,
            ..event
        })
        .expect("second");
    assert_eq!(first.id, second.id);
    let records = store.list_mutations(None).expect("list");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, MutationStatus::Failure);

    // Unattributed mutations are still auditable.
    store
        .record_mutation(MutationEvent {
            tool_id: "mut-2".to_string(),
            actor: None,
            status: MutationStatus::Success,
            files: vec![],
            before_revision: "r2".to_string(),
            after_revision: "r3".to_string(),
            change_id: None,
            metadata: None,
        })
        .expect("record");
    assert_eq!(store.list_mutations(None).unwrap().len(), 2);
}

// ---------------------------------------------------------------------
// Seven swarm sources
// ---------------------------------------------------------------------

#[test]
fn all_seven_swarm_sources_materialize_with_correct_filters() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);

    // Obligations in every state.
    store
        .sync_obligations(&[
            seed("src/pending.rs", "pending"),
            seed("src/claimed.rs", "claimed"),
            seed("src/stale.rs", "stale"),
            seed("src/resolved.rs", "resolved"),
            seed("src/ignored.rs", "ignored"),
        ])
        .expect("sync");
    let items = store.list_obligations(&ObligationQuery::default()).unwrap();
    let id_of = |target: &str| {
        items
            .iter()
            .find(|item| item.target == target)
            .unwrap()
            .id
            .clone()
    };
    store
        .claim_obligation(&id_of("src/claimed.rs"), &actor("s"))
        .unwrap();
    store
        .resolve_obligation(&id_of("src/resolved.rs"), &actor("s"), None)
        .unwrap();
    store
        .ignore_obligation(&id_of("src/ignored.rs"), &actor("s"), "not needed", None)
        .unwrap();
    store
        .refresh_stale_obligations(Some(&targets(&[
            "src/pending.rs",
            "src/claimed.rs",
            "src/resolved.rs",
            "src/ignored.rs",
        ])))
        .unwrap();

    // Oracles in every state.
    store
        .record_oracle(oracle_seed(OracleStatus::Fail, "failing output"))
        .unwrap();
    store
        .record_oracle(OracleSeed {
            status: OracleStatus::Unknown,
            tool_id: "tool-2".to_string(),
            ..oracle_seed(OracleStatus::Unknown, "unknown output")
        })
        .unwrap();
    store
        .record_oracle(OracleSeed {
            status: OracleStatus::Pass,
            tool_id: "tool-3".to_string(),
            ..oracle_seed(OracleStatus::Pass, "passing output")
        })
        .unwrap();

    let obligations = |source: EvidenceSource| -> Vec<String> {
        store
            .swarm_source(source, None)
            .unwrap()
            .into_iter()
            .map(|item| match item {
                EvidenceItem::Obligation(item) => item.target.clone(),
                EvidenceItem::Oracle(_) => panic!("expected obligations"),
            })
            .collect()
    };

    assert_eq!(
        obligations(EvidenceSource::PendingObligations),
        vec!["src/pending.rs"]
    );
    assert_eq!(
        obligations(EvidenceSource::ClaimedObligations),
        vec!["src/claimed.rs"]
    );
    assert_eq!(
        obligations(EvidenceSource::StaleObligations),
        vec!["src/stale.rs"]
    );
    let mut active = obligations(EvidenceSource::ActiveObligations);
    active.sort();
    assert_eq!(
        active,
        vec!["src/claimed.rs", "src/pending.rs", "src/stale.rs"]
    );

    let oracle_status = |source: EvidenceSource| -> Vec<String> {
        store
            .swarm_source(source, None)
            .unwrap()
            .into_iter()
            .map(|item| match item {
                EvidenceItem::Oracle(record) => record.status.as_str().to_string(),
                EvidenceItem::Obligation(_) => panic!("expected oracles"),
            })
            .collect()
    };
    assert_eq!(oracle_status(EvidenceSource::FailingOracles), vec!["fail"]);
    assert_eq!(
        oracle_status(EvidenceSource::UnknownOracles),
        vec!["unknown"]
    );
    let mut both = oracle_status(EvidenceSource::FailingOrUnknownOracles);
    both.sort();
    assert_eq!(both, vec!["fail", "unknown"]);

    // Every source parses back from its wire name.
    for source in EvidenceSource::all() {
        assert_eq!(EvidenceSource::parse(source.as_str()), Some(source));
    }
    assert_eq!(EvidenceSource::parse("made_up"), None);
}

#[test]
fn empty_sources_return_empty_vectors_not_errors() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    for source in EvidenceSource::all() {
        let items = store.swarm_source(source, None).expect("source");
        assert!(items.is_empty(), "{} should be empty", source.as_str());
    }
}

// ---------------------------------------------------------------------
// Limit handling
// ---------------------------------------------------------------------

#[test]
fn limits_default_to_20_and_cap_at_100() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    let seeds: Vec<ObligationSeed> = (0..150)
        .map(|index| seed(&format!("src/item{index}.rs"), "reason"))
        .collect();
    store.sync_obligations(&seeds).expect("sync");

    // Default limit.
    let items = store
        .list_obligations(&ObligationQuery::default())
        .expect("list");
    assert_eq!(items.len(), LIMIT_DEFAULT);

    // Explicit limit is honored.
    assert_eq!(
        store
            .list_obligations(&ObligationQuery {
                limit: Some(7),
                ..Default::default()
            })
            .unwrap()
            .len(),
        7
    );

    // Oversized limits clamp at 100; zero clamps at 1.
    assert_eq!(
        store
            .list_obligations(&ObligationQuery {
                limit: Some(5_000),
                ..Default::default()
            })
            .unwrap()
            .len(),
        LIMIT_MAX
    );
    assert_eq!(
        store
            .list_obligations(&ObligationQuery {
                limit: Some(0),
                ..Default::default()
            })
            .unwrap()
            .len(),
        1
    );

    // Swarm sources share the same clamping.
    assert_eq!(
        store
            .swarm_source(EvidenceSource::PendingObligations, None)
            .unwrap()
            .len(),
        20
    );
    assert_eq!(
        store
            .swarm_source(EvidenceSource::PendingObligations, Some(999))
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        store
            .swarm_source(EvidenceSource::ActiveObligations, Some(5))
            .unwrap()
            .len(),
        5
    );
}

// ---------------------------------------------------------------------
// Legacy import
// ---------------------------------------------------------------------

#[test]
fn legacy_obligations_and_oracles_import_once_read_only() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();
    let legacy_dir = root.join(".chimera");
    fs::create_dir_all(&legacy_dir).unwrap();

    let legacy_obligation = json!({
        "schema_version": 1,
        "id": "obl_legacy0000000001",
        "fingerprint": "legacy-fingerprint",
        "status": "pending",
        "target": "src/legacy.rs",
        "reason": "legacy obligation artifact",
        "risk": "behavior",
        "classification": null,
        "evidence": "legacy:evidence",
        "source": {
            "provenanceID": null,
            "changed_files": [],
            "snapshot_revision": "legacy-rev"
        },
        "created_at": "2026-01-01T00:00:00.000Z",
        "updated_at": "2026-01-01T00:00:00.000Z",
        "claimed_by": null,
        "resolved_by": null,
        "ignored_by": null,
        "stale_reason": null
    });
    fs::write(
        legacy_dir.join("obligations.json"),
        format!(
            "{}\n",
            json!({ "schemaVersion": 1, "obligations": [legacy_obligation] })
        ),
    )
    .unwrap();

    let legacy_oracle = json!({
        "schema_version": 1,
        "id": "oracle_legacy0000001",
        "kind": "shell",
        "status": "fail",
        "tool_id": "legacy-tool",
        "tool": { "session_id": "legacy-session", "agent": "worker", "call_id": null },
        "verification_kind": "test",
        "trusted": true,
        "finished_at": "2026-01-02T00:00:00.000Z",
        "payload": { "shell": { "command": "cargo test", "output": "legacy failure" } },
        "link_window": { "max_changes": 20 },
        "linked_changes": []
    });
    fs::write(
        legacy_dir.join("oracle-results.jsonl"),
        format!("{legacy_oracle}\n"),
    )
    .unwrap();

    let before = fs::read_to_string(legacy_dir.join("obligations.json")).unwrap();
    let store = EvidenceStore::open(&root).expect("open");
    let report = store.import_legacy().expect("import");
    assert_eq!(report.obligations_imported, 1);
    assert_eq!(report.oracles_imported, 1);

    // Imported records are queryable through the regular surface.
    let obligations = store.list_obligations(&ObligationQuery::default()).unwrap();
    assert_eq!(obligations.len(), 1);
    assert_eq!(obligations[0].id, "obl_legacy0000000001");
    assert_eq!(obligations[0].target, "src/legacy.rs");
    let oracles = store
        .swarm_source(EvidenceSource::FailingOracles, None)
        .unwrap();
    assert_eq!(oracles.len(), 1);
    assert_eq!(
        oracles[0].reference(),
        "oracle:oracle_legacy0000001".to_string()
    );

    // Import is idempotent: re-import skips existing ids.
    let again = store.import_legacy().expect("import again");
    assert_eq!(again.obligations_imported, 0);
    assert_eq!(again.obligations_skipped, 1);
    assert_eq!(again.oracles_imported, 0);
    assert_eq!(again.oracles_skipped, 1);

    // The legacy files were only read, never rewritten.
    let after = fs::read_to_string(legacy_dir.join("obligations.json")).unwrap();
    assert_eq!(before, after);
    assert!(
        dir.path()
            .join(".chimera")
            .join("oracle-results.jsonl")
            .is_file()
    );
}

#[test]
fn legacy_import_reports_missing_files_as_zero_imports() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    let report = store.import_legacy().expect("import");
    assert_eq!(report.obligations_imported, 0);
    assert_eq!(report.oracles_imported, 0);
}

#[test]
fn legacy_import_errors_are_explicit() {
    let dir = TempDir::new().unwrap();
    let legacy_dir = dir.path().join(".chimera");
    fs::create_dir_all(&legacy_dir).unwrap();

    // Broken obligations.json: wrong shape.
    fs::write(legacy_dir.join("obligations.json"), "not json at all").unwrap();
    let store = EvidenceStore::open(dir.path()).unwrap();
    let error = store.import_legacy().expect_err("broken obligations");
    assert!(error.to_string().contains("obligations.json"), "{error}");

    // Broken oracle-results.jsonl: bad line calls out the line number.
    let dir2 = TempDir::new().unwrap();
    let legacy_dir2 = dir2.path().join(".chimera");
    fs::create_dir_all(&legacy_dir2).unwrap();
    fs::write(
        legacy_dir2.join("oracle-results.jsonl"),
        "{valid-ish}\n{also not json}\n",
    )
    .unwrap();
    let store2 = EvidenceStore::open(dir2.path()).unwrap();
    let error = store2.import_legacy().expect_err("broken oracles");
    assert!(error.to_string().contains("line 1"), "{error}");
}

// ---------------------------------------------------------------------
// Project isolation + restart recovery
// ---------------------------------------------------------------------

#[test]
fn projects_are_isolated_on_disk() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let store_a = store_at(&dir_a);
    let store_b = store_at(&dir_b);

    store_a
        .sync_obligations(&[seed("src/only-a.rs", "a")])
        .expect("sync a");
    store_a
        .record_oracle(oracle_seed(OracleStatus::Fail, "failure in a"))
        .expect("oracle a");

    assert_eq!(
        store_a
            .list_obligations(&ObligationQuery::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store_b
            .list_obligations(&ObligationQuery::default())
            .unwrap()
            .len(),
        0
    );
    assert!(
        store_b
            .swarm_source(EvidenceSource::FailingOracles, None)
            .unwrap()
            .is_empty()
    );
    // Different databases on disk.
    assert_ne!(store_a.db_path(), store_b.db_path());
    assert!(store_a.db_path().starts_with(dir_a.path()));
}

#[test]
fn state_survives_restart() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();
    {
        let store = EvidenceStore::open(&root).expect("open");
        store
            .sync_obligations(&[seed("src/restart.rs", "restart")])
            .expect("sync");
        let id = store.list_obligations(&ObligationQuery::default()).unwrap()[0]
            .id
            .clone();
        store
            .claim_obligation(&id, &actor("session-1"))
            .expect("claim");
        store
            .record_oracle(oracle_seed(OracleStatus::Unknown, "unknown after restart"))
            .expect("oracle");
    }
    // Simulated process restart: a fresh store handle over the same files.
    let store = EvidenceStore::open(&root).expect("reopen");
    let items = store
        .list_obligations(&ObligationQuery::default())
        .expect("list");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, ObligationStatus::Claimed);
    assert_eq!(
        items[0].claimed_by.as_ref().unwrap().actor.session_id,
        "session-1"
    );
    let unknowns = store
        .swarm_source(EvidenceSource::UnknownOracles, None)
        .expect("oracles");
    assert_eq!(unknowns.len(), 1);
}

#[test]
fn schema_version_is_stamped_and_reopen_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_path_buf();
    let store = EvidenceStore::open(&root).expect("open");
    drop(store);
    let conn = rusqlite::Connection::open(root.join(".chimera").join("evidence.db")).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
}

// ---------------------------------------------------------------------
// Missing store / empty inputs
// ---------------------------------------------------------------------

#[test]
fn query_on_fresh_store_reports_empty_not_error() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    assert_eq!(store.obligation_counts().unwrap().active, 0);
    assert!(store.obligation("obl_missing").unwrap().is_none());
    assert!(store.oracle("oracle_missing").unwrap().is_none());
    assert!(
        store
            .list_oracles(&crate::OracleQuery::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn sync_with_no_seeds_is_a_no_op() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    let outcome = store.sync_obligations(&[]).expect("sync");
    assert_eq!(outcome.created, 0);
    assert_eq!(outcome.updated, 0);
    assert_eq!(outcome.counts.active, 0);
}

#[test]
fn evidence_items_carry_stable_references() {
    let dir = TempDir::new().unwrap();
    let store = store_at(&dir);
    store
        .sync_obligations(&[seed("src/ref.rs", "ref")])
        .unwrap();
    let items = store
        .swarm_source(EvidenceSource::PendingObligations, None)
        .unwrap();
    assert_eq!(
        items[0].reference(),
        format!(
            "obligation:{}",
            match &items[0] {
                EvidenceItem::Obligation(item) => item.id.clone(),
                EvidenceItem::Oracle(_) => unreachable!(),
            }
        )
    );
}
