//! W1: read deny-list isolation between concurrent Engines (regression).
//!
//! The pre-W1 design installed one process-global deny-list from
//! `Engine::new`, so a later Engine silently overwrote the policy every
//! earlier Engine's in-process file tools enforced. These tests build two
//! Engines with opposite deny-lists and prove each context still enforces
//! its own.

use super::*;
use crate::tools::spec::ToolSpec;

fn isolated_engine(workspace: &Path, denied_root: &Path) -> (Engine, EngineHandle) {
    let mut config = deterministic_engine_config(workspace);
    config.features.disable(Feature::Mcp);
    config.read_denylist = codewhale_sandbox::read_guard::ReadDenylist::build(
        false,
        std::slice::from_ref(&denied_root.to_path_buf()),
        &[],
    );
    Engine::new(config, &Config::default())
}

fn secret_fixture(workspace: &Path) -> PathBuf {
    let secret_dir = workspace.join("secret_vault");
    fs::create_dir_all(&secret_dir).unwrap();
    let file = secret_dir.join("token.txt");
    fs::write(&file, "read-s1-synthetic-secret").unwrap();
    file
}

fn turn_context(engine: &Engine) -> ToolContext {
    engine.build_tool_context(AppMode::Agent, false)
}

#[test]
fn concurrent_engines_with_opposite_denylists_each_enforce_their_own() {
    let _env = lock_test_env();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let ws_a = tempdir().unwrap();
        let ws_b = tempdir().unwrap();
        let secret_a = secret_fixture(ws_a.path());
        let secret_b = secret_fixture(ws_b.path());

        // Engine A denies only A's vault; engine B (built LAST, the order
        // that used to clobber the process-global slot) denies only B's.
        let (engine_a, _ha) = isolated_engine(ws_a.path(), &ws_a.path().join("secret_vault"));
        let (engine_b, _hb) = isolated_engine(ws_b.path(), &ws_b.path().join("secret_vault"));
        let ctx_a = turn_context(&engine_a);
        let ctx_b = turn_context(&engine_b);

        let (read_a, read_b) = tokio::join!(
            crate::tools::file::ReadFileTool
                .execute(json!({"path": secret_a.to_str().unwrap()}), &ctx_a),
            crate::tools::file::ReadFileTool
                .execute(json!({"path": secret_b.to_str().unwrap()}), &ctx_b),
        );
        for (label, result) in [("A", read_a), ("B", read_b)] {
            let error = result
                .map(|outcome: ToolResult| outcome.success)
                .expect_err(
                    "own vault read must be refused even though the other engine was built later",
                );
            assert!(
                matches!(error, ToolError::PermissionDenied { .. }),
                "{label} engine refused via the read deny-list: {error:?}"
            );
        }

        // Cross-project: each context must stay OPEN where its own policy is
        // open — A's context may read B's vault and vice versa. Under the old
        // global, the last-built list would have denied A's read of B's vault
        // (or opened A's own vault): either way, cross-talk.
        assert!(
            crate::tools::file::enforce_read_denylist(&secret_b, "read_file", &ctx_a.read_denylist)
                .is_ok()
        );
        assert!(
            crate::tools::file::enforce_read_denylist(&secret_a, "read_file", &ctx_b.read_denylist)
                .is_ok()
        );

        // Each context carries exactly its engine's captured policy.
        assert!(std::sync::Arc::ptr_eq(
            &ctx_a.read_denylist,
            &engine_a.read_denylist
        ));
        assert!(std::sync::Arc::ptr_eq(
            &ctx_b.read_denylist,
            &engine_b.read_denylist
        ));
        assert!(!std::sync::Arc::ptr_eq(
            &ctx_a.read_denylist,
            &ctx_b.read_denylist
        ));
    });
}

#[test]
fn default_engine_and_bare_tool_context_stay_fail_safe() {
    let _env = lock_test_env();
    let ws = tempdir().unwrap();
    let (engine, _handle) = {
        let mut config = deterministic_engine_config(ws.path());
        config.features.disable(Feature::Mcp);
        Engine::new(config, &Config::default())
    };
    let ctx = turn_context(&engine);
    let Some(home) = dirs::home_dir() else {
        return;
    };
    for label in ["engine turn context", "bare ToolContext"] {
        let denylist = match label {
            "engine turn context" => ctx.read_denylist.clone(),
            _ => ToolContext::new(ws.path().to_path_buf())
                .read_denylist
                .clone(),
        };
        denylist
            .check(&home.join(".ssh").join("id_ed25519"))
            .expect_err(&format!("{label} must keep the built-in defaults armed"));
        denylist
            .check(&ws.path().join("main.rs"))
            .map(|()| ())
            .expect(&format!("{label} must keep ordinary source readable"));
    }
}
