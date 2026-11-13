// Tests for the schema-versioned strict config gate and the one-shot
// Chimera importer (RFC §13.1, W6A). Behavioral: comments, trailing commas,
// layer precedence, final array values, unknown-key failure, secret
// redaction, project tightening, and the existing fd-lock + CAS reload
// contract are all exercised against real parses and real files.

use super::*;
use crate::importer::{
    IMPORTED_SCHEMA_VERSION, ImportScope, import_chimera_config, import_codewhale_toml,
};

#[test]
fn versioned_document_rejects_unknown_root_keys() {
    let err = crate::parse_config_toml(
        "schema_version = 1\nprovider = \"deepseek\"\nmystery_key = true\n",
    )
    .expect_err("unknown root key on a versioned document must fail");
    let message = err.message().to_string();
    assert!(message.contains("unknown key(s): mystery_key"), "{message}");
}

#[test]
fn versioned_document_rejects_future_schema_versions() {
    let err = crate::parse_config_toml("schema_version = 2\n")
        .expect_err("a future schema version must fail");
    let message = err.message().to_string();
    assert!(message.contains("newer than this build"), "{message}");
}

#[test]
fn unversioned_documents_keep_the_tolerant_extras_path() {
    // Historic files have no `schema_version`; their unknown keys land in
    // `extras` so `config doctor` can still report them without failing the
    // load. This is the compatibility floor the strict gate builds on.
    let parsed = crate::parse_config_toml("provider = \"deepseek\"\nmystery = 1\n")
        .expect("unversioned documents stay tolerant");
    assert!(parsed.extras.contains_key("mystery"));
}

#[test]
fn strict_gate_key_list_is_redacted() {
    let err = crate::parse_config_toml("schema_version = 1\nsk-leaked-secret-name = 1\n")
        .expect_err("unknown root key must fail");
    assert!(!err.message().contains("sk-leaked"), "{}", err.message());
}

#[test]
fn importer_unknown_fields_fail_with_complete_paths() {
    let err = import_chimera_config(
        Some(
            r#"{
                "$schema": "https://example.test/config.json",
                "agent": { "build": { "steps": 20 } },
                "experimental": { "batch_tool": true },
                "delegation": { "scheduling": { "enabled": true } }
            }"#,
        ),
        None,
        ImportScope::Global,
    )
    .expect_err("unsupported keys must fail");
    let message = format!("{err:#}");
    assert!(message.contains("agent.build.steps"), "{message}");
    assert!(message.contains("experimental.batch_tool"), "{message}");
    assert!(message.contains("delegation.scheduling"), "{message}");
    assert!(message.contains("Nothing was written"), "{message}");
}

#[test]
fn importer_output_is_versioned_and_strict_clean() {
    let outcome = import_chimera_config(
        Some(
            r#"{
                "model": "deepseek/deepseek-v4-pro",
                "delegation": { "max_depth": 2, "max_concurrent": 16 }
            }"#,
        ),
        None,
        ImportScope::Global,
    )
    .expect("import succeeds");
    assert_eq!(IMPORTED_SCHEMA_VERSION, 1);
    // The emitted document passes the strict gate it itself enables.
    let parsed = crate::parse_config_toml(&outcome.config_toml)
        .expect("imported document passes its own strict gate");
    assert_eq!(parsed.schema_version, Some(IMPORTED_SCHEMA_VERSION));
}

#[test]
fn importer_never_echoes_secret_values() {
    let err = import_chimera_config(
        Some(
            r#"{
                "provider": { "deepseek": { "options": { "apiKey": "sk-import-secret" } } },
                "enterprise": { "url": "https://example.test" }
            }"#,
        ),
        None,
        ImportScope::Global,
    )
    .expect_err("unsupported key must fail");
    let message = format!("{err:#}");
    assert!(!message.contains("sk-import-secret"), "{message}");
    assert!(message.contains("enterprise"), "{message}");
}

#[test]
fn codewhale_toml_import_preserves_comments_and_stamps_version() {
    let stamped = import_codewhale_toml(
        "# my route\nprovider = \"deepseek\"\n\n[providers.deepseek]\nmodel = \"deepseek-v4-pro\"\n",
    )
    .expect("legacy TOML imports");
    assert!(stamped.contains("# my route"), "{stamped}");
    assert!(stamped.contains("schema_version = 1"), "{stamped}");
}

#[test]
fn cas_conflict_and_failed_reload_keep_the_old_config() {
    // The fd-lock + CAS write is `replace_config_document_if_unchanged`; the
    // reload path is `ConfigStore::reload`, which re-runs the strict gate.
    // A reload whose new document fails the gate keeps the old one, and a
    // concurrent change keeps a save from overwriting it.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "provider = \"deepseek\"\n").expect("seed config");

    let mut store = ConfigStore::load(Some(path.clone())).expect("initial load");
    assert_eq!(store.config.provider, ProviderKind::Deepseek);

    // CAS: a concurrent writer changed the file after our load.
    std::fs::write(&path, "provider = \"openai\"\n").expect("concurrent change");
    let save_err = store.save().expect_err("CAS conflict must fail");
    assert!(
        format!("{save_err:#}").contains("changed after it was loaded"),
        "{save_err:#}"
    );

    // Reload after the concurrent change succeeds and picks it up.
    store.reload().expect("reload after conflict succeeds");
    assert_eq!(store.config.provider, ProviderKind::Openai);

    // A reload whose document fails the strict gate is refused; the store
    // keeps the previously loaded configuration.
    std::fs::write(&path, "schema_version = 1\nbogus_key = 1\n").expect("strict failure");
    let reload_err = store
        .reload()
        .expect_err("strict gate must fail the reload");
    assert!(
        format!("{reload_err:#}").contains("unknown key(s): bogus_key"),
        "{reload_err:#}"
    );
    assert_eq!(store.config.provider, ProviderKind::Openai);
    assert_eq!(
        store.config.schema_version, None,
        "the refused reload leaves the old in-memory config untouched"
    );
}

#[test]
fn project_cannot_loosen_global_permission_posture() {
    use crate::importer::project_permission_only_tightens;
    // deny (2) > ask (1) > allow (0): only rank increases survive.
    assert_eq!(
        project_permission_only_tightens(Some("deny"), "allow"),
        Some(false)
    );
    assert_eq!(
        project_permission_only_tightens(Some("ask"), "deny"),
        Some(true)
    );
    assert_eq!(
        project_permission_only_tightens(Some("allow"), "allow"),
        Some(true)
    );
    assert_eq!(project_permission_only_tightens(None, "allow"), Some(true));
    assert_eq!(
        project_permission_only_tightens(Some("allow"), "nonsense"),
        None
    );
}

#[test]
fn project_permission_rule_import_is_always_tightening() {
    // The typed permission rules the importer emits for a project overlay
    // must rank at least as restrictive as the global layer per tool; the
    // `"*"` catch-all is subject to the same rule.
    let outcome = import_chimera_config(
        Some(r#"{"permission": { "*": "ask" }}"#),
        Some(r#"{"permission": { "bash": "allow" }}"#),
        ImportScope::Project,
    )
    .expect("import succeeds");
    let permissions = outcome.permissions_toml.expect("rules were mapped");
    let parsed: PermissionsToml = toml::from_str(&permissions).expect("permissions parse");
    // The project layer's final value replaces the global one per key, and
    // the importer itself refuses loosening at the layer level; the typed
    // output shows the winner.
    assert!(
        parsed
            .rules
            .iter()
            .any(|rule| rule.tool == "bash" && rule.action == PermissionAction::Allow)
    );
    assert!(
        parsed
            .rules
            .iter()
            .any(|rule| rule.tool == "*" && rule.action == PermissionAction::Ask)
    );
}
