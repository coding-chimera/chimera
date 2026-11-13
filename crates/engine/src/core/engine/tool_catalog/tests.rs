use super::prepare_tools_for_strict_mode;
use super::{
    CODE_EXECUTION_DESCRIPTION, DEFAULT_ACTIVE_NATIVE_TOOLS, ToolMode,
    allowlist_is_native_file_and_shell_only, apply_mcp_tool_deferral, apply_native_tool_deferral,
    build_model_tool_catalog_with_surface, default_synthetic_catalog_tool_names,
    ensure_advanced_tooling, execute_tool_search_with_cache, initial_active_tools,
    is_synthetic_catalog_tool, remove_evicted_cache_activations, requested_tool_mode,
    tool_matches_any_rule,
};
use crate::core::session::ToolActivationCache;
use codewhale_config::AppMode;
use codewhale_models::Tool;
use serde_json::json;
use std::collections::{BTreeSet, HashSet};

fn tool(name: &str) -> Tool {
    Tool {
        tool_type: None,
        name: name.to_string(),
        description: format!("{name} test tool"),
        input_schema: json!({"type": "object", "properties": {}}),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    }
}

/// The shared launcher applies policy only where enforcement is available.
/// The model-facing description must not promise unconditional isolation.
#[test]
fn code_execution_description_does_not_claim_process_sandboxing() {
    assert!(CODE_EXECUTION_DESCRIPTION.contains("local Python interpreter"));
    assert!(!CODE_EXECUTION_DESCRIPTION.contains("sandbox"));
}

/// Python output must match our UTF-8 decoder even with non-UTF-8 parent stdio.
#[tokio::test]
async fn code_execution_returns_utf8_stdout_and_stderr() {
    use crate::test_support::{EnvVarGuard, lock_test_env};
    use codewhale_dependencies::ExternalTool as _;

    let _env_lock = lock_test_env();
    if !codewhale_dependencies::Python::available() {
        return;
    }
    let _encoding = EnvVarGuard::set("PYTHONIOENCODING", "gbk");
    let tmp = tempfile::tempdir().expect("tempdir");
    let result = super::execute_code_execution_tool(
        &json!({"code": r#"import sys; print("\u4e2d\u6587"); print("\u9519\u8bef", file=sys.stderr)"#}),
        tmp.path(),
        &crate::tools::spec::ToolContext::new(tmp.path()),
    )
    .await
    .expect("code execution should run");
    let payload = result.metadata.expect("payload");
    assert_eq!(
        (
            payload["stdout"].as_str().map(str::trim_end),
            payload["stderr"].as_str().map(str::trim_end),
        ),
        (Some("中文"), Some("错误")),
    );
}

/// The published synthetic-name list and the predicate that classifies a
/// catalog entry as synthetic must agree. A name that appears in the list
/// but is not classified synthetic would let the request projection report
/// a provenance the engine itself disputes.
#[test]
fn published_synthetic_names_agree_with_the_synthetic_predicate() {
    let names = default_synthetic_catalog_tool_names();
    assert!(!names.is_empty());
    for name in &names {
        assert!(
            is_synthetic_catalog_tool(name),
            "'{name}' is published as synthetic but the predicate disagrees"
        );
    }
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(names, sorted, "the list must be sorted and deduplicated");

    // MCP names resolve through the real pool, so they are deliberately
    // absent here even though the predicate accepts them.
    assert!(!names.iter().any(|name| name.starts_with("mcp_")));

    // `multi_tool_use.parallel` is a call name, never a catalog entry, so
    // it has no catalog provenance and must not be published as synthetic.
    assert!(
        !names
            .iter()
            .any(|name| name == codewhale_tools::names::MULTI_TOOL_PARALLEL_NAME)
    );
}

#[test]
fn first_turn_surface_is_stable_across_plan_work_and_operate() {
    assert_eq!(
        DEFAULT_ACTIVE_NATIVE_TOOLS,
        &[
            "read",
            "write",
            "edit",
            "file_search",
            "grep_files",
            "bash",
            "agent",
            "todo_write",
            "create_goal",
            "get_goal",
            "update_goal",
            "task_shell_wait",
            "present",
            "load_skill"
        ]
    );
    let expected = [
        "agent",
        "bash",
        "create_goal",
        "get_goal",
        "update_goal",
        "edit",
        "file_search",
        "grep_files",
        "load_skill",
        "present",
        "read",
        "task_shell_wait",
        "todo_write",
        "tool_search",
        "write",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    let mut expected_prefix = None;
    for mode in [AppMode::Plan, AppMode::Agent] {
        let mut catalog = [
            "read",
            "write",
            "edit",
            "file_search",
            "grep_files",
            "bash",
            "agent",
            "workflow",
            "todo_write",
            "create_goal",
            "get_goal",
            "update_goal",
            "task_shell_wait",
            "present",
            "Git",
            "Run",
            "tasks",
            "load_skill",
        ]
        .into_iter()
        .map(tool)
        .collect::<Vec<_>>();
        let always_load = HashSet::new();
        apply_native_tool_deferral(&mut catalog, &always_load);
        ensure_advanced_tooling(&mut catalog, mode, &always_load, ToolMode::Direct);
        let active_names = initial_active_tools(&catalog);
        let active = active_names.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(active, expected, "{mode:?}");
        let prefix = serde_json::to_string(&super::active_tools_for_step(&catalog, &active_names))
            .expect("serialize first-turn tool prefix");
        if let Some(expected) = &expected_prefix {
            assert_eq!(&prefix, expected, "{mode:?} must preserve schema bytes");
        } else {
            expected_prefix = Some(prefix);
        }
    }
}

#[test]
fn eager_workflow_still_respects_command_allow_and_deny_gates() {
    for mode in [AppMode::Plan, AppMode::Agent] {
        for (allow, deny, expected) in [
            (None, None, true),
            (Some("read"), None, false),
            (Some("workflow"), None, true),
            (None, Some("workflow"), false),
            (Some("workflow"), Some("workflow"), false),
        ] {
            let catalog = build_model_tool_catalog_with_surface(
                ["read", "agent", "workflow"]
                    .into_iter()
                    .map(tool)
                    .collect(),
                Vec::new(),
                mode,
                &HashSet::new(),
                crate::model_profile::ToolSurfaceBudget::Standard,
            );
            let policy = super::ToolSurfacePolicy::new(
                crate::tools::ToolRegistry::new(crate::tools::ToolContext::for_empty_registry()),
                Some(catalog),
                mode,
                &HashSet::new(),
                &["workflow"], // Cached activation cannot restore a denied tool.
                false,
                allow.map(|name| vec![name.to_string()]),
                deny.map(|name| vec![name.to_string()]),
                None,
                ToolMode::Direct,
            );
            assert_eq!(policy.allows_tool("workflow"), expected);
            assert_eq!(policy.active_names.contains("workflow"), expected);
            assert_eq!(
                policy.catalog.iter().any(|tool| tool.name == "workflow"),
                expected
            );
        }
    }
}

#[test]
fn mcp_tools_are_searchable_not_eager_in_every_mode() {
    for mode in [AppMode::Plan, AppMode::Agent] {
        let mut catalog = vec![tool("read_mcp_resource"), tool("mcp_acme_lookup")];
        apply_mcp_tool_deferral(&mut catalog, mode, &HashSet::new());
        assert!(
            catalog
                .iter()
                .all(|definition| definition.defer_loading == Some(true)),
            "{mode:?}: {catalog:?}"
        );
    }
}

#[test]
fn cache_eviction_does_not_hide_a_tool_that_became_eager() {
    let mut catalog = vec![tool("promoted")];
    catalog[0].defer_loading = Some(true);
    let mut cache = ToolActivationCache::default();
    cache.activate(&catalog, &["promoted".to_string()]);

    catalog[0].defer_loading = Some(false);
    let mut active = initial_active_tools(&catalog);
    let evicted = cache.revalidate(&catalog);
    remove_evicted_cache_activations(&catalog, &mut active, evicted);

    assert!(active.contains("promoted"));
    assert_eq!(cache.names().count(), 0);
}

#[test]
fn successful_cached_execution_updates_lru_without_granting_uncached_names() {
    let catalog = (0..=8)
        .map(|index| {
            let mut definition = tool(&format!("deferred-{index}"));
            definition.defer_loading = Some(true);
            definition
        })
        .collect::<Vec<_>>();
    let mut cache = ToolActivationCache::default();
    let first = (0..8)
        .map(|index| format!("deferred-{index}"))
        .collect::<Vec<_>>();
    let mut active = HashSet::new();
    let delta = cache.activate(&catalog, &first);
    active.extend(delta.admitted);

    assert!(cache.record_use("deferred-7"));
    let delta = cache.activate(&catalog, &["deferred-8".to_string()]);
    remove_evicted_cache_activations(&catalog, &mut active, delta.evicted);
    active.extend(delta.admitted);
    // The batch is ranked best-first; using its oldest retained match
    // promotes it ahead of the next batch without granting an unseen tool.
    assert!(cache.names().any(|name| name == "deferred-7"));
    assert!(cache.names().any(|name| name == "deferred-0"));
    assert!(!cache.names().any(|name| name == "deferred-6"));

    assert!(!cache.record_use("never-activated"));
    assert!(!active.contains("never-activated"));
}

#[test]
fn searching_for_an_eager_tool_is_not_reported_as_cache_rejected() {
    let mut catalog = vec![tool("read")];
    catalog[0].defer_loading = Some(false);
    let mut active = initial_active_tools(&catalog);
    let mut cache = ToolActivationCache::default();

    let result = execute_tool_search_with_cache(
        codewhale_tools::names::TOOL_SEARCH_NAME,
        &json!({"query": "read"}),
        &catalog,
        &mut active,
        &mut cache,
    )
    .expect("tool search should succeed");

    let metadata = result.metadata.expect("search metadata");
    assert_eq!(metadata["tool_references"], json!([]));
    assert_eq!(metadata["unavailable_tool_references"], json!([]));
    assert!(active.contains("read"));
    assert_eq!(cache.names().count(), 0);
}

#[test]
fn allow_and_deny_rules_cover_visible_and_hidden_compat_aliases_symmetrically() {
    for family in [
        &["read", "read_file"][..],
        &["write", "write_file"][..],
        &["edit", "edit_file"][..],
        &["bash", "Bash", "exec_shell"][..],
    ] {
        for rule in family {
            let rules = vec![(*rule).to_string()];
            for tool_name in family {
                assert!(
                    tool_matches_any_rule(&rules, tool_name),
                    "rule {rule:?} should cover alias {tool_name:?}"
                );
            }
        }
    }

    assert!(tool_matches_any_rule(&["exec_shell*".to_string()], "bash"));
    assert!(tool_matches_any_rule(
        &["exec_shell*".to_string()],
        "exec_shell_wait"
    ));
    for primitive in ["read", "write", "edit"] {
        assert!(tool_matches_any_rule(&["File".to_string()], primitive));
    }
    assert!(!tool_matches_any_rule(&["read".to_string()], "write"));
}

#[test]
fn native_file_and_shell_allowlist_can_skip_mcp_startup() {
    let native = ["bash", "read", "write", "edit"].map(str::to_string);
    assert!(allowlist_is_native_file_and_shell_only(Some(&native)));
    assert!(!allowlist_is_native_file_and_shell_only(None));
}

#[test]
fn unknown_and_wildcard_allowlists_keep_mcp_startup() {
    for rule in ["mcp_github_list_prs", "mcp_*", "m*", "*", "other_tool"] {
        assert!(
            !allowlist_is_native_file_and_shell_only(Some(&[rule.to_string()])),
            "{rule} may admit an MCP-backed tool"
        );
    }
}

#[test]
fn compact_surface_keeps_agent_eager_defers_workflow() {
    let catalog = build_model_tool_catalog_with_surface(
        [
            "read",
            "write",
            "edit",
            "bash",
            "agent",
            "workflow",
            "todo_write",
        ]
        .into_iter()
        .map(tool)
        .collect(),
        Vec::new(),
        AppMode::Agent,
        &HashSet::new(),
        crate::model_profile::ToolSurfaceBudget::Compact,
    );

    for (name, deferred) in [("agent", false), ("workflow", true)] {
        assert_eq!(
            catalog
                .iter()
                .find(|definition| definition.name == name)
                .and_then(|definition| definition.defer_loading),
            Some(deferred),
            "{name}"
        );
    }
}

/// The per-tool Registry paragraph is gone; the catalog builder must leave the
/// shell tool's description exactly as the registry produced it, so the KV
/// prefix stays byte-stable and there is one Registry authority (the prompt).
#[test]
fn catalog_build_does_not_append_registry_guidance_to_the_shell_tool() {
    let described = tool("bash");
    let catalog = build_model_tool_catalog_with_surface(
        vec![described.clone()],
        Vec::new(),
        AppMode::Agent,
        &HashSet::new(),
        crate::model_profile::ToolSurfaceBudget::Standard,
    );

    let shell = catalog
        .iter()
        .find(|definition| definition.name == "bash")
        .expect("shell tool");
    assert_eq!(shell.description, described.description);
    assert!(!shell.description.contains("registry_sync"));
}

#[test]
fn requested_tool_mode_prefers_model_hint_then_flag_then_direct() {
    use codewhale_runtime::features::{Feature, Features};

    // #6562: code mode is the default; `[features] code_mode = false` is the
    // escape hatch back to Direct.
    let on = Features::with_defaults();
    assert_eq!(requested_tool_mode(None, &on), ToolMode::CodeMode);

    let mut off = Features::with_defaults();
    off.disable(Feature::CodeMode);
    assert_eq!(requested_tool_mode(None, &off), ToolMode::Direct);

    // Model metadata wins over config, in both directions (Codex parity).
    assert_eq!(
        requested_tool_mode(Some(ToolMode::Direct), &on),
        ToolMode::Direct
    );
    assert_eq!(
        requested_tool_mode(Some(ToolMode::CodeMode), &off),
        ToolMode::CodeMode
    );
}

#[test]
fn execute_tools_is_eager_in_code_mode_and_deferred_in_direct() {
    for (mode, expected_defer) in [(ToolMode::Direct, true), (ToolMode::CodeMode, false)] {
        let mut catalog = vec![tool("read")];
        ensure_advanced_tooling(&mut catalog, AppMode::Agent, &HashSet::new(), mode);
        let injected = catalog
            .iter()
            .find(|definition| definition.name == "execute_tools")
            .expect("execute_tools is injected outside Plan");
        assert_eq!(injected.defer_loading, Some(expected_defer), "{mode:?}");
    }

    // Plan hides the surface under every tool mode.
    let mut catalog = vec![tool("read")];
    ensure_advanced_tooling(
        &mut catalog,
        AppMode::Plan,
        &HashSet::new(),
        ToolMode::CodeMode,
    );
    assert!(
        catalog
            .iter()
            .all(|definition| definition.name != "execute_tools")
    );
}

/// A timed-out or cancelled `code_execution` kills the interpreter and what the
/// script started; a bare `output()` left both running.
#[cfg(unix)]
#[tokio::test]
async fn dropped_code_execution_kills_the_interpreter_tree() {
    if codewhale_dependencies::resolve_python_interpreter().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().expect("tempdir");
    let pid_file = tmp.path().join("grandchild.pid");
    let code = format!(
        "import subprocess\np = subprocess.Popen(['sleep', '300'])\nopen({:?}, 'w').write(str(p.pid))\np.wait()\n",
        pid_file.display().to_string()
    );
    let input = json!({ "code": code });
    let context = crate::tools::spec::ToolContext::new(tmp.path());
    let run = super::execute_code_execution_tool(&input, tmp.path(), &context);
    let grandchild = codewhale_runtime::process_tree::drop_once_pid_written(run, &pid_file).await;
    assert!(
        codewhale_runtime::process_tree::wait_for_pid_exit(
            grandchild,
            std::time::Duration::from_secs(5)
        ),
        "a process the script started outlived the dropped code_execution call"
    );
}

fn test_tool(name: &str, input_schema: serde_json::Value) -> Tool {
    Tool {
        input_schema,
        ..tool(name)
    }
}

#[test]
fn strict_mode_applies_per_tool_in_mixed_catalog() {
    let mut tools = vec![
        test_tool(
            "lookup",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
                "required": []
            }),
        ),
        test_tool(
            "either",
            json!({
                "type": "object",
                "properties": {
                    "a": {"type": "string"},
                    "b": {"type": "string"}
                },
                "anyOf": [
                    {"required": ["a"]},
                    {"required": ["b"]}
                ]
            }),
        ),
        test_tool(
            "nested",
            json!({
                "type": "object",
                "properties": {
                    "value": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "integer"}
                        ]
                    }
                }
            }),
        ),
    ];

    assert!(!prepare_tools_for_strict_mode(&mut tools));
    assert_eq!(tools[0].strict, Some(true));
    assert_eq!(tools[0].input_schema["required"], json!([]));
    assert!(tools[0].input_schema.get("additionalProperties").is_none());
    assert_eq!(tools[1].strict, None);
    assert!(tools[1].input_schema.get("anyOf").is_some());
    assert_eq!(tools[2].strict, None);
    assert!(
        tools[2].input_schema["properties"]["value"]
            .get("oneOf")
            .is_some()
    );
}

#[test]
fn strict_mode_rejects_nested_unsupported_composition() {
    let mut tools = vec![Tool {
        tool_type: None,
        name: "nested".to_string(),
        description: "Nested oneOf".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "value": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "integer"}
                    ]
                }
            }
        }),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    }];

    assert!(!prepare_tools_for_strict_mode(&mut tools));
    assert_eq!(tools[0].strict, None);
}

#[test]
fn strict_mode_leaves_dependent_schema_tools_non_strict() {
    let schema = json!({
        "type": "object",
        "properties": {
            "action": {"type": "string"},
            "message": {"type": "string"}
        },
        "dependentSchemas": {
            "action": {
                "properties": {"message": {}},
                "required": ["message"]
            }
        }
    });
    let mut tools = vec![test_tool("agent", schema.clone())];

    assert!(!prepare_tools_for_strict_mode(&mut tools));
    assert_eq!(tools[0].strict, None);
    assert_eq!(tools[0].input_schema, schema);
}

#[test]
fn strict_mode_marks_compatible_tools_strict() {
    let mut tools = vec![Tool {
        tool_type: None,
        name: "lookup".to_string(),
        description: "Lookup".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            },
            "required": []
        }),
        allowed_callers: None,
        defer_loading: None,
        input_examples: None,
        strict: None,
        cache_control: None,
    }];

    assert!(prepare_tools_for_strict_mode(&mut tools));
    assert_eq!(tools[0].strict, Some(true));
    assert_eq!(tools[0].input_schema["required"], json!([]));
    assert!(tools[0].input_schema.get("additionalProperties").is_none());
}

// --- Chimera phase-2 progressive disclosure ---------------------------------

use super::{
    TOOL_REVEAL_MAX_NAMES, ToolReveal, ToolRevealProjection, compact_signature,
    is_tool_reveal_message, promoted_reveal_names, revealed_names_from_search_result,
    revealed_tools_guidance, tool_reveal_message,
};
use codewhale_models::{ContentBlock, Message, Role, SystemPrompt};
use codewhale_core::prefix_cache::PrefixFingerprint;

fn deferred_catalog_tool(name: &str, defer: bool) -> Tool {
    Tool {
        tool_type: None,
        name: name.to_string(),
        description: format!("{name} deferred tool"),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer"}
            },
            "required": ["path"]
        }),
        allowed_callers: None,
        defer_loading: Some(defer),
        input_examples: None,
        strict: None,
        cache_control: None,
    }
}

fn user_text(text: &str) -> Message {
    Message {
        role: Role::User,
        content: vec![ContentBlock::Text {
            text: text.to_string(),
            cache_control: None,
        }],
    }
}

fn catalog_tools_fingerprint(catalog: &[Tool], active: &HashSet<String>) -> Option<String> {
    crate::core::engine::tool_catalog::active_tools_for_request(catalog, active, false).map(
        |tools: Vec<Tool>| {
            let mut cache = codewhale_core::prefix_cache::ToolCatalogCache::new();
            PrefixFingerprint::compute_with_tool_cache("", Some(&tools), &mut cache)
                .tools_sha256
        },
    )
}

fn search(query: &str, catalog: &[Tool], active: &mut HashSet<String>) -> crate::tools::spec::ToolResult {
    let mut cache = ToolActivationCache::default();
    execute_tool_search_with_cache(
        codewhale_tools::names::TOOL_SEARCH_NAME,
        &json!({"query": query, "max_results": 4}),
        catalog,
        active,
        &mut cache,
    )
    .expect("tool search should succeed")
}

/// Reveal must not change the request tool array: the header hash over the
/// active tool projection is byte-identical before and after a search.
#[test]
fn reveal_keeps_header_tool_hash_stable() {
    let catalog = vec![
        deferred_catalog_tool("read", false),
        deferred_catalog_tool("bash", false),
        deferred_catalog_tool("web_fetch", true),
        deferred_catalog_tool("context_archive_search", true),
    ];
    let mut active = initial_active_tools(&catalog);
    let before = catalog_tools_fingerprint(&catalog, &active);

    let result = search("web", &catalog, &mut active);

    let after = catalog_tools_fingerprint(&catalog, &active);
    assert_eq!(before, after, "reveal must not move the pinned tool prefix");
    assert!(!active.contains("web_fetch"));
    let revealed = revealed_names_from_search_result(&result);
    assert_eq!(revealed, vec!["web_fetch".to_string()]);
}

/// A revealed call executes by name: the projection reports it as revealed
/// and unpromoted, so the turn loop executes it off the array.
#[test]
fn revealed_tool_is_callable_by_name_off_array() {
    let catalog = vec![deferred_catalog_tool("web_fetch", true)];
    let mut active = initial_active_tools(&catalog);
    let result = search("web_fetch", &catalog, &mut active);
    let reveal = ToolReveal {
        name: "web_fetch".to_string(),
        revealed_at_ms: 1_000,
    };

    let mut history = vec![user_text("find docs"), tool_reveal_message(&reveal)];
    let projection = ToolRevealProjection::from_history(&history);
    assert!(projection.is_revealed("web_fetch"));
    assert_eq!(projection.unpromoted().len(), 1);
    // The search result still names the tool for the model.
    let revealed = revealed_names_from_search_result(&result);
    assert_eq!(revealed, vec!["web_fetch".to_string()]);
    // Guidance renders the signature the model calls with.
    let guidance = revealed_tools_guidance(&[reveal], &catalog).expect("guidance renders");
    assert!(guidance.contains("- `web_fetch`(path: string, offset?: integer)`"));
    history.push(user_text("next"));
    assert!(ToolRevealProjection::from_history(&history).is_revealed("web_fetch"));
}

/// Reveal does not grant permission: the guidance is informational and the
/// revealed set carries no allow/deny decision — gates re-run per call.
#[test]
fn reveal_records_carry_no_permission_widening() {
    let catalog = vec![deferred_catalog_tool("web_fetch", true)];
    let mut active = initial_active_tools(&catalog);
    let result = search("web_fetch", &catalog, &mut active);

    let payload: serde_json::Value =
        serde_json::from_str(&result.content).expect("payload is JSON");
    assert!(
        payload["authority"]
            .as_str()
            .expect("authority present")
            .contains("permission checks still apply")
    );
    // No revealed name was inserted into the active set, so no execution
    // surface was widened by the reveal itself.
    assert!(!active.contains("web_fetch"));
}

/// Session isolation: two sessions with different histories project
/// independent reveal sets.
#[test]
fn reveal_projection_is_session_scoped() {
    let left = vec![
        user_text("a"),
        tool_reveal_message(&ToolReveal {
            name: "web_fetch".to_string(),
            revealed_at_ms: 1,
        }),
    ];
    let right = vec![
        user_text("b"),
        tool_reveal_message(&ToolReveal {
            name: "context_archive_search".to_string(),
            revealed_at_ms: 2,
        }),
    ];
    let left_projection = ToolRevealProjection::from_history(&left);
    let right_projection = ToolRevealProjection::from_history(&right);
    assert!(left_projection.is_revealed("web_fetch"));
    assert!(!left_projection.is_revealed("context_archive_search"));
    assert!(right_projection.is_revealed("context_archive_search"));
    assert!(!right_projection.is_revealed("web_fetch"));
}

/// The reveal record is rebuildable from session history: a resume that
/// replays the messages restores the identical revealed set.
#[test]
fn reveal_history_rebuilds_after_restore() {
    let reveal = ToolReveal {
        name: "web_fetch".to_string(),
        revealed_at_ms: 5_000,
    };
    let history = vec![
        user_text("start"),
        tool_reveal_message(&reveal),
        user_text("call it"),
    ];
    let first = ToolRevealProjection::from_history(&history);
    // Simulate a save/restore round trip: the same messages project the
    // same set without extra persisted state.
    let restored = ToolRevealProjection::from_history(&history);
    assert_eq!(first.unpromoted(), restored.unpromoted());

    let message = tool_reveal_message(&reveal);
    assert!(is_tool_reveal_message(&message));
    // A user message that merely quotes the payload is not a reveal.
    let mut quoted = user_text("the engine wrote {\"type\":\"tool_reveal\"}");
    quoted.role = Role::User;
    assert!(!is_tool_reveal_message(&quoted));
}

/// Compaction promotion: reveals at or before the newest compaction
/// checkpoint are promoted; reveals after it stay off the array.
#[test]
fn compaction_promotes_reveals_at_or_before_the_boundary() {
    let catalog = vec![
        deferred_catalog_tool("web_fetch", true),
        deferred_catalog_tool("context_archive_search", true),
        deferred_catalog_tool("read", false),
    ];
    let checkpoint = crate::compaction::compaction_checkpoint_message(&SystemPrompt::Text(
        "Codewhale handoff note. Earlier turns of this session were summarized.\n\nsummary"
            .to_string(),
    ));
    let history = vec![
        user_text("turn 1"),
        tool_reveal_message(&ToolReveal {
            name: "web_fetch".to_string(),
            revealed_at_ms: 1_000,
        }),
        checkpoint,
        tool_reveal_message(&ToolReveal {
            name: "context_archive_search".to_string(),
            revealed_at_ms: 2_000,
        }),
    ];
    let promoted = promoted_reveal_names(&history, &catalog);
    assert!(promoted.contains("web_fetch"), "reveal before compaction promotes");
    assert!(
        !promoted.contains("context_archive_search"),
        "reveal after compaction stays off-array"
    );
    let projection = ToolRevealProjection::from_history(&history);
    assert!(!projection.is_revealed("web_fetch"), "promoted tool left the off-array set");
    assert!(projection.is_revealed("context_archive_search"));
}

/// Promotion requires the tool to still exist as deferred in the live
/// catalog: a disconnected MCP tool must not be resurrected by an old reveal.
#[test]
fn promotion_drops_names_missing_from_the_live_catalog() {
    let checkpoint = crate::compaction::compaction_checkpoint_message(&SystemPrompt::Text(
        "Codewhale handoff note. Earlier turns of this session were summarized.\n\nsummary"
            .to_string(),
    ));
    let history = vec![
        tool_reveal_message(&ToolReveal {
            name: "mcp_gone_tool".to_string(),
            revealed_at_ms: 1,
        }),
        checkpoint,
    ];
    let catalog = vec![deferred_catalog_tool("web_fetch", true)];
    assert!(promoted_reveal_names(&history, &catalog).is_empty());
}

/// Off-array eviction is bounded: only the newest TOOL_REVEAL_MAX_NAMES
/// reveals stay in the off-array set, oldest first evicted.
#[test]
fn off_array_reveal_set_is_bounded() {
    let mut history = Vec::new();
    for index in 0..(TOOL_REVEAL_MAX_NAMES + 4) {
        history.push(tool_reveal_message(&ToolReveal {
            name: format!("tool_{index}"),
            revealed_at_ms: index as u64,
        }));
    }
    let projection = ToolRevealProjection::from_history(&history);
    assert_eq!(projection.unpromoted().len(), TOOL_REVEAL_MAX_NAMES);
    // The oldest four were evicted.
    for index in 0..4 {
        assert!(!projection.is_revealed(&format!("tool_{index}")));
    }
    // The newest TOOL_REVEAL_MAX_NAMES remain.
    for index in 4..(TOOL_REVEAL_MAX_NAMES + 4) {
        assert!(projection.is_revealed(&format!("tool_{index}")));
    }
}

/// A re-reveal supersedes the older record: the newest position decides.
#[test]
fn re_reveal_after_checkpoint_unpromotes_the_tool() {
    let catalog = vec![deferred_catalog_tool("web_fetch", true)];
    let checkpoint = crate::compaction::compaction_checkpoint_message(&SystemPrompt::Text(
        "Codewhale handoff note. Earlier turns of this session were summarized.\n\nsummary"
            .to_string(),
    ));
    let history = vec![
        tool_reveal_message(&ToolReveal {
            name: "web_fetch".to_string(),
            revealed_at_ms: 1,
        }),
        checkpoint,
        tool_reveal_message(&ToolReveal {
            name: "web_fetch".to_string(),
            revealed_at_ms: 9,
        }),
    ];
    assert!(promoted_reveal_names(&history, &catalog).is_empty());
    assert!(ToolRevealProjection::from_history(&history).is_revealed("web_fetch"));
}

/// compact_signature renders required/optional params with coarse types and
/// caps long parameter lists.
#[test]
fn compact_signature_renders_optional_and_capped() {
    let schema = json!({
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "offset": {"type": "integer"},
            "limit": {"type": "integer"}
        },
        "required": ["path"]
    });
    assert_eq!(
        compact_signature(&schema),
        "(path: string, offset?: integer, limit?: integer)"
    );
    let mut properties = serde_json::Map::new();
    for index in 0..12 {
        properties.insert(format!("field_{index}"), json!({"type": "string"}));
    }
    let long = json!({"type": "object", "properties": properties});
    let signature = compact_signature(&long);
    assert!(signature.ends_with(", …)"));
    assert_eq!(signature.matches("field_").count(), 8);
    assert_eq!(compact_signature(&json!({"type": "object"})), "");
}

/// The plan-phase filter contract: a revealed name is excluded from the
/// admission list, so the deferred activation path never puts its schema on
/// the wire; the call itself executes by name through the existing gate
/// stack.
#[test]
fn revealed_names_are_excluded_from_activation_admission() {
    let catalog = vec![
        deferred_catalog_tool("read", false),
        deferred_catalog_tool("web_fetch", true),
        deferred_catalog_tool("workflow", true),
    ];
    let mut active = initial_active_tools(&catalog);
    // The model searched and web_fetch was revealed.
    let history = vec![
        user_text("start"),
        tool_reveal_message(&ToolReveal {
            name: "web_fetch".to_string(),
            revealed_at_ms: 1_000,
        }),
    ];
    let projection = ToolRevealProjection::from_history(&history);
    let deferred_tools_hydrated_in_order = vec![
        "web_fetch".to_string(),
        "workflow".to_string(),
    ];
    let admitting: Vec<String> = deferred_tools_hydrated_in_order
        .iter()
        .filter(|name| !projection.is_revealed(name))
        .cloned()
        .collect();
    assert_eq!(admitting, vec!["workflow".to_string()]);
    // The revealed tool stays off the request tool array even after the
    // unrevealed sibling is admitted.
    active.extend(admitting);
    assert!(active.contains("workflow"));
    assert!(!active.contains("web_fetch"));
}
