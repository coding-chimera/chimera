//! Focused tests for the W2 swarm batch fan-out slice: three-arm input
//! validation, template/preset materialization, concurrency bounds,
//! foreground/background receipts, scope warnings, summary extraction, the
//! evidence-source port's empty-input contract, the durable completion
//! outbox, and the depth-3 default.

use serde_json::{Value, json};
use tempfile::tempdir;

use super::evidence::{EVIDENCE_SOURCES, FileEvidenceSource, NoopEvidenceSource};
use super::{
    DEFAULT_SWARM_CONCURRENCY, DEFAULT_SWARM_LIMIT, MAX_SWARM_CONCURRENCY, MAX_SWARM_ITEMS,
    MAX_SWARM_LIMIT, SWARM_FROM_SOURCES, SWARM_PRESETS, SwarmSource, bounded_u64,
    collect_scope_warnings, extract_swarm_summary, materialize_swarm_items, parse_swarm_params,
    preset_role, preset_template, render_template, validate_swarm_source,
};
use super::super::new_shared_subagent_manager_with_state_root_and_timeout;
use codewhale_agent_contract::role::FleetRole;

fn params(input: Value) -> super::SwarmParams {
    parse_swarm_params(&input).expect("swarm params parse")
}

fn minimal_input() -> Value {
    json!({
        "action": "swarm",
        "description": "review auth files",
        "items": ["src/auth.ts", "src/api.ts"],
        "prompt_template": "Review {{item}}",
    })
}

// ---- Three-arm input validation ----

#[test]
fn items_plus_template_is_valid() {
    let parsed = params(minimal_input());
    let source = validate_swarm_source(&parsed).expect("items arm validates");
    assert_eq!(
        source,
        SwarmSource::Items {
            items: vec![json!("src/auth.ts"), json!("src/api.ts")]
        }
    );
}

#[test]
fn items_plus_preset_is_valid_without_template() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "audit followups",
        "items": ["obligation 1"],
        "preset": "audit-followup",
    }));
    assert!(validate_swarm_source(&parsed).is_ok());
}

#[test]
fn from_arm_is_valid_with_a_known_source() {
    for source in SWARM_FROM_SOURCES {
        let parsed = params(json!({
            "action": "swarm",
            "description": "pending work",
            "from": source,
            "preset": "audit-review",
        }));
        assert_eq!(
            validate_swarm_source(&parsed).expect("from arm validates"),
            SwarmSource::From {
                source: source.to_string()
            },
            "source {source}"
        );
    }
}

#[test]
fn missing_description_is_rejected_with_self_correcting_text() {
    let parsed = params(json!({
        "action": "swarm",
        "items": ["x"],
        "prompt_template": "Review {{item}}",
    }));
    let error = validate_swarm_source(&parsed).expect_err("description is required");
    let text = error.to_string();
    assert!(text.contains("description"), "{text}");
    assert!(text.contains("Example"), "{text}");
}

#[test]
fn items_and_from_are_mutually_exclusive() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": ["x"],
        "from": "pending_obligations",
        "prompt_template": "Review {{item}}",
    }));
    let error = validate_swarm_source(&parsed).expect_err("items+from rejected");
    assert!(
        error.to_string().contains("not both"),
        "{}",
        error
    );
}

#[test]
fn neither_items_nor_from_is_rejected() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "prompt_template": "Review {{item}}",
    }));
    let error = validate_swarm_source(&parsed).expect_err("empty source rejected");
    assert!(
        error.to_string().contains("swarm needs work items"),
        "{}",
        error
    );
}

#[test]
fn template_without_item_placeholder_is_rejected() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": ["x"],
        "prompt_template": "Review the file",
    }));
    let source = validate_swarm_source(&parsed).expect("arms validate");
    let error = materialize_swarm_items(&parsed, &source, None)
        .expect_err("missing {{item}} placeholder rejected");
    assert!(
        error.to_string().contains("{{item}}"),
        "{}",
        error
    );
}

#[test]
fn template_and_preset_both_missing_is_rejected() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": ["x"],
    }));
    let source = validate_swarm_source(&parsed).expect("arms validate");
    let error = materialize_swarm_items(&parsed, &source, None)
        .expect_err("missing template rejected");
    assert!(
        error.to_string().contains("prompt_template"),
        "{}",
        error
    );
}

#[test]
fn empty_items_array_is_rejected() {
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": [],
        "prompt_template": "Review {{item}}",
    }));
    let error = validate_swarm_source(&parsed).expect_err("empty items rejected");
    assert!(error.to_string().contains("swarm needs work items"), "{error}");
}

#[test]
fn unknown_preset_is_rejected_at_parse() {
    let error = parse_swarm_params(&json!({
        "action": "swarm",
        "description": "d",
        "items": ["x"],
        "preset": "nope",
    }))
    .expect_err("unknown preset rejected");
    assert!(error.to_string().contains("audit-followup"), "{error}");
}

#[test]
fn unknown_from_source_is_rejected_at_parse() {
    let error = parse_swarm_params(&json!({
        "action": "swarm",
        "description": "d",
        "from": "made_up_source",
    }))
    .expect_err("unknown from rejected");
    assert!(
        error.to_string().contains("failing_or_unknown_oracles"),
        "{error}"
    );
}

#[test]
fn non_string_non_object_items_are_rejected() {
    let error = parse_swarm_params(&json!({
        "action": "swarm",
        "description": "d",
        "items": ["ok", 42],
        "prompt_template": "Review {{item}}",
    }))
    .expect_err("numeric item rejected");
    assert!(
        error.to_string().contains("strings or objects"),
        "{error}"
    );
}

#[test]
fn items_over_the_single_run_cap_are_rejected() {
    let items: Vec<String> = (0..(MAX_SWARM_ITEMS + 1)).map(|i| format!("item-{i}")).collect();
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": items,
        "prompt_template": "Review {{item}}",
    }));
    let error = validate_swarm_source(&parsed).expect_err("over-cap items rejected");
    assert!(
        error.to_string().contains("at most"),
        "{error}"
    );
}

// ---- Presets and rendering ----

#[test]
fn all_four_presets_supply_item_templates() {
    for preset in SWARM_PRESETS {
        let template = preset_template(preset).unwrap_or_else(|| panic!("{preset} template"));
        assert!(template.contains("{{item}}"), "{preset}");
        assert!(template.contains("Item {{index}}/{{total}}:"), "{preset}");
        assert!(
            template.contains("Status: actionable | covered | irrelevant | duplicate | blocked | no-issue"),
            "{preset}"
        );
        assert!(
            template.contains("Parent follow-up: <recommended parent action or none>"),
            "{preset}"
        );
    }
    assert!(preset_template("nope").is_none());
}

#[test]
fn preset_role_maps_file_review_to_scout() {
    assert_eq!(preset_role(Some("file-review")), FleetRole::Scout);
    assert_eq!(preset_role(Some("audit-followup")), FleetRole::Worker);
    assert_eq!(preset_role(None), FleetRole::Worker);
}

#[test]
fn render_template_substitutes_all_placeholders() {
    assert_eq!(
        render_template("Item {{index}}/{{total}}: {{item}}", &json!("src/auth.ts"), 2, 5),
        "Item 2/5: src/auth.ts"
    );
}

#[test]
fn render_template_renders_object_items_as_compact_json() {
    let rendered = render_template(
        "Review {{item}}",
        &json!({"file": "src/api.ts", "scope": "route handlers"}),
        1,
        1,
    );
    assert!(rendered.contains("\"file\""), "{rendered}");
    assert!(rendered.contains("src/api.ts"), "{rendered}");
    assert!(!rendered.contains('\n'), "compact JSON: {rendered}");
}

#[test]
fn materialized_items_carry_titles_and_prompts() {
    let parsed = params(minimal_input());
    let source = validate_swarm_source(&parsed).expect("valid");
    let (items, warnings, concurrency) =
        materialize_swarm_items(&parsed, &source, None).expect("materializes");
    assert_eq!(items.len(), 2);
    assert!(warnings.is_empty());
    assert_eq!(concurrency, DEFAULT_SWARM_CONCURRENCY);
    assert_eq!(items[0].index, 1);
    assert_eq!(items[0].title, "review auth files 1/2");
    assert_eq!(items[0].prompt, "Review src/auth.ts");
    assert_eq!(items[1].prompt, "Review src/api.ts");
}

// ---- Concurrency and limit bounds ----

#[test]
fn concurrency_defaults_to_16_and_caps_at_16() {
    assert_eq!(bounded_u64(None, DEFAULT_SWARM_CONCURRENCY, MAX_SWARM_CONCURRENCY), 16);
    assert_eq!(bounded_u64(Some(0), 16, 16), 1);
    assert_eq!(bounded_u64(Some(4), 16, 16), 4);
    assert_eq!(bounded_u64(Some(64), 16, 16), 16);
}

#[test]
fn limit_defaults_to_20_and_caps_at_100() {
    assert_eq!(bounded_u64(None, DEFAULT_SWARM_LIMIT, MAX_SWARM_LIMIT), 20);
    assert_eq!(bounded_u64(Some(500), 20, 100), 100);
}

#[test]
fn items_slice_to_the_requested_limit() {
    let items: Vec<String> = (0..50).map(|i| format!("item-{i}")).collect();
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "items": items,
        "prompt_template": "Review {{item}}",
        "limit": 5,
    }));
    let source = validate_swarm_source(&parsed).expect("valid");
    let (work_items, _, _) =
        materialize_swarm_items(&parsed, &source, None).expect("materializes");
    assert_eq!(work_items.len(), 5);
}

#[test]
fn scope_warnings_collect_files_shared_by_multiple_items() {
    let items = vec![
        json!({"file": "src/a.ts"}),
        json!({"files": ["src/a.ts", "src/b.ts"]}),
        json!("no scope"),
    ];
    let warnings = collect_scope_warnings(&items);
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].file, "src/a.ts");
    assert_eq!(warnings[0].item_indexes, vec![1, 2]);
    assert!(
        warnings[0].message.contains("Possible scope conflict: src/a.ts"),
        "{}",
        warnings[0].message
    );
}

#[test]
fn outbox_delivered_rows_stay_delivered_across_restart() {
    let tmp = tempdir().expect("tempdir");
    let workspace = tmp.path().to_path_buf();
    let state_root = tmp.path().join("state");
    let make_manager = || {
        new_shared_subagent_manager_with_state_root_and_timeout(
            workspace.clone(),
            state_root.clone(),
            8,
            8,
            std::time::Duration::from_secs(60),
            8,
            None,
            None,
        )
    };
    {
        let manager = make_manager();
        let mut guard = manager.blocking_write();
        guard.record_completion_outbox("agent_done", "session-a");
        guard.mark_completion_outbox_delivered(&["agent_done".to_string()]);
        guard.persist_state_synchronously().expect("persist");
    }
    let reloaded = make_manager();
    let guard = reloaded.blocking_write();
    assert!(
        guard.pending_completion_outbox_for_session("session-a").is_empty(),
        "a delivered row must not resurrect on recovery"
    );
}

#[test]
fn summary_clamps_long_values() {
    let long = "x".repeat(2000);
    let summary = extract_swarm_summary(&format!("Status: {long}\n"));
    assert!(
        summary.status.as_deref().is_some_and(|value| value.len() <= 1004),
        "clamped to ~1000 chars + ellipsis"
    );
}

// ---- Evidence-source port ----

#[test]
fn all_seven_sources_are_served() {
    assert_eq!(EVIDENCE_SOURCES.len(), 7);
    assert_eq!(SWARM_FROM_SOURCES, EVIDENCE_SOURCES);
}

#[test]
fn evidence_missing_store_is_an_explicit_empty_input_error() {
    let tmp = tempdir().expect("tempdir");
    let source = FileEvidenceSource::new(tmp.path());
    for name in EVIDENCE_SOURCES {
        let error = source
            .materialize(name, 20)
            .expect_err("missing store must fail loud");
        let text = error.to_string();
        assert!(
            text.contains("empty work input cannot become a fan-out"),
            "{name}: {text}"
        );
    }
}

#[test]
fn noop_source_fails_loud_for_every_source() {
    let source = NoopEvidenceSource::new();
    for name in EVIDENCE_SOURCES {
        assert!(
            source.materialize(name, 20).is_err(),
            "{name} must fail loud"
        );
    }
}

#[test]
fn obligations_read_filters_by_status() {
    let tmp = tempdir().expect("tempdir");
    let dir = tmp.path().join(".codewhale").join("chimera");
    std::fs::create_dir_all(&dir).expect("evidence dir");
    std::fs::write(
        dir.join("obligations.json"),
        json!({
            "schemaVersion": 1,
            "obligations": [
                {"id": "o1", "status": "pending", "target": "src/a.rs"},
                {"id": "o2", "status": "claimed", "target": "src/b.rs"},
                {"id": "o3", "status": "resolved", "target": "src/c.rs"},
                {"id": "o4", "status": "ignored", "target": "src/d.rs"},
                {"id": "o5", "status": "stale", "target": "src/e.rs"},
                {"id": "o6", "status": "pending", "target": "src/f.rs"},
            ]
        })
        .to_string(),
    )
    .expect("obligations store");

    let source = FileEvidenceSource::new(tmp.path());
    let pending = source
        .materialize("pending_obligations", 20)
        .expect("pending reads");
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|item| item["id"] != "o3"));

    let claimed = source
        .materialize("claimed_obligations", 20)
        .expect("claimed reads");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0]["id"], json!("o2"));

    let stale = source
        .materialize("stale_obligations", 20)
        .expect("stale reads");
    assert_eq!(stale.len(), 1);

    let active = source
        .materialize("active_obligations", 20)
        .expect("active reads");
    assert_eq!(active.len(), 4);
}

#[test]
fn oracles_read_filters_by_status_and_limit() {
    let tmp = tempdir().expect("tempdir");
    let dir = tmp.path().join(".codewhale").join("chimera");
    std::fs::create_dir_all(&dir).expect("evidence dir");
    let mut lines = String::new();
    for i in 0..5 {
        lines.push_str(
            &json!({"id": format!("oracle-{i}"), "status": "fail"}).to_string(),
        );
        lines.push('\n');
    }
    lines.push_str(&json!({"id": "oracle-pass", "status": "pass"}).to_string());
    lines.push('\n');
    lines.push_str(&json!({"id": "oracle-unknown", "status": "unknown"}).to_string());
    lines.push('\n');
    std::fs::write(dir.join("oracle-results.jsonl"), lines).expect("oracle records");

    let source = FileEvidenceSource::new(tmp.path());
    let failing = source
        .materialize("failing_oracles", 20)
        .expect("failing reads");
    assert_eq!(failing.len(), 5);

    let unknown = source
        .materialize("unknown_oracles", 20)
        .expect("unknown reads");
    assert_eq!(unknown.len(), 1);

    let combined = source
        .materialize("failing_or_unknown_oracles", 2)
        .expect("combined reads honor the limit");
    assert_eq!(combined.len(), 2);
}

#[test]
fn empty_match_set_is_an_error_not_an_empty_fanout() {
    let tmp = tempdir().expect("tempdir");
    let dir = tmp.path().join(".codewhale").join("chimera");
    std::fs::create_dir_all(&dir).expect("evidence dir");
    std::fs::write(
        dir.join("obligations.json"),
        json!({"obligations": [{"id": "o1", "status": "resolved"}]}).to_string(),
    )
    .expect("obligations store");
    let source = FileEvidenceSource::new(tmp.path());
    let error = source
        .materialize("pending_obligations", 20)
        .expect_err("no pending items is an error");
    assert!(
        error.to_string().contains("matched no evidence records"),
        "{error}"
    );
}

#[test]
fn materialize_with_empty_from_result_reports_empty_input() {
    // The materialize→swarm path surfaces the evidence error verbatim rather
    // than fabricating items.
    let parsed = params(json!({
        "action": "swarm",
        "description": "d",
        "from": "pending_obligations",
        "preset": "audit-followup",
    }));
    let source = validate_swarm_source(&parsed).expect("from arm valid");
    let error = materialize_swarm_items(&parsed, &source, None)
        .expect_err("no materialized items is an error");
    assert!(
        error.to_string().contains("no work items"),
        "{error}"
    );
}

// ---- Durable completion outbox ----

fn manager_with_state() -> super::super::SharedSubAgentManager {
    let tmp = tempdir().expect("tempdir");
    new_shared_subagent_manager_with_state_root_and_timeout(
        tmp.path().to_path_buf(),
        tmp.path().join("state"),
        8,
        8,
        std::time::Duration::from_secs(60),
        8,
        None,
        None,
    )
}

#[test]
fn outbox_records_and_marks_delivered_rows() {
    let manager = manager_with_state();
    let mut guard = manager.blocking_write();
    guard.record_completion_outbox("agent_1", "session-a");
    guard.record_completion_outbox("agent_2", "session-a");
    let pending = guard.pending_completion_outbox_for_session("session-a");
    assert_eq!(pending.len(), 2);
    assert!(!pending[0].delivered);

    guard.mark_completion_outbox_delivered(&["agent_1".to_string()]);
    let pending = guard.pending_completion_outbox_for_session("session-a");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].agent_id, "agent_2");

    // Unknown ids are ignored.
    guard.mark_completion_outbox_delivered(&["agent_nope".to_string()]);
    assert_eq!(guard.pending_completion_outbox_for_session("session-a").len(), 1);
}

#[test]
fn outbox_is_scoped_to_the_owner_session() {
    let manager = manager_with_state();
    let mut guard = manager.blocking_write();
    guard.record_completion_outbox("agent_1", "session-a");
    assert!(guard.pending_completion_outbox_for_session("session-b").is_empty());
}

#[test]
fn outbox_row_is_idempotent_per_agent() {
    let manager = manager_with_state();
    let mut guard = manager.blocking_write();
    guard.record_completion_outbox("agent_1", "session-a");
    guard.record_completion_outbox("agent_1", "session-a");
    assert_eq!(guard.pending_completion_outbox_for_session("session-a").len(), 1);
}

#[test]
fn outbox_prune_drops_delivered_and_orphaned_rows() {
    let manager = manager_with_state();
    let mut guard = manager.blocking_write();
    guard.record_completion_outbox("agent_delivered", "s");
    guard.mark_completion_outbox_delivered(&["agent_delivered".to_string()]);
    guard.record_completion_outbox("agent_orphan", "s");
    guard.prune_completion_outbox();
    // The delivered row is gone; the orphaned undelivered row is also gone
    // (its agent and worker records no longer exist).
    assert!(guard.pending_completion_outbox_for_session("s").is_empty());
}

// ---- Depth default ----

#[test]
fn default_spawn_depth_is_three_inclusive_of_root() {
    assert_eq!(codewhale_protocol::fleet::DEFAULT_SPAWN_DEPTH, 3);
    assert_eq!(
        crate::tools::subagent::DEFAULT_MAX_SPAWN_DEPTH,
        codewhale_protocol::fleet::DEFAULT_SPAWN_DEPTH
    );
}
