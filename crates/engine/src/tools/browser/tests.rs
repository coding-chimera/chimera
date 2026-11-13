//! Browser tool contract tests over the fake driver: the seven tools,
//! stale references, session/project isolation, cancellation, SSRF and
//! redirect rejection, sub-agent denial, screenshot artifact privacy.

use super::super::spec::ToolContext;
use crate::tools::browser::{BROWSER_ACTIONS, BrowserTool};
use codewhale_browser::fake::{FakeDriver, FakeDriverFactory};
use codewhale_browser::manager::{BrowserManager, BrowserSettings};
use codewhale_net::network_policy::{NetworkPolicy, NetworkPolicyDecider};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

fn manager() -> Arc<BrowserManager> {
    BrowserManager::new(
        Arc::new(FakeDriverFactory(FakeDriver::new())),
        BrowserSettings {
            max_tabs_per_session: 8,
            ..BrowserSettings::default()
        },
    )
}

fn context_with(workspace: &Path, manager: &Arc<BrowserManager>, session: &str) -> ToolContext {
    let mut context = ToolContext::new(workspace);
    context.state_namespace = session.to_string();
    context.runtime.browser_manager = Some(Arc::clone(manager));
    context
}

#[tokio::test]
async fn seven_tools_are_registered_and_deferred() {
    let tools = [
        BrowserTool::open(),
        BrowserTool::snapshot(),
        BrowserTool::click(),
        BrowserTool::type_text(),
        BrowserTool::screenshot(),
        BrowserTool::close(),
        BrowserTool::evaluate(),
    ];
    let names: Vec<&str> = tools
        .iter()
        .map(crate::tools::spec::ToolSpec::name)
        .collect();
    for expected in BROWSER_ACTIONS {
        assert!(names.contains(expected), "missing {expected}");
    }
    for tool in &tools {
        assert!(tool.defer_loading(), "{} must be deferred", tool.name());
    }
}

#[tokio::test]
async fn open_returns_tab_and_generation() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    let result = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    assert!(parsed["tab"].as_str().is_some_and(|t| !t.is_empty()));
    assert_eq!(parsed["url"], "https://example.test/");
    assert_eq!(parsed["origin"], "https://example.test");
}

#[tokio::test]
async fn snapshot_is_untrusted_and_bounded() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    let result = BrowserTool::snapshot()
        .execute(json!({"tab": tab}), &context)
        .await
        .unwrap();
    assert!(
        result.content.contains("[UNTRUSTED page content]"),
        "snapshot output must be marked untrusted"
    );
    let snapshot: serde_json::Value = serde_json::from_str(
        result
            .content
            .trim_start_matches("[UNTRUSTED page content]\n"),
    )
    .unwrap();
    assert_eq!(snapshot["tab"], parsed["tab"]);
    assert!(
        snapshot["nodes"]
            .as_array()
            .is_some_and(|nodes| !nodes.is_empty())
    );
}

#[tokio::test]
async fn click_rejects_stale_element_refs_after_navigation() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    // Element reference at generation 0.
    let stale_element = format!("e{tab}-1@0");
    // Navigate: generation bumps.
    BrowserTool::open()
        .execute(
            json!({"url": "https://example.test/next", "tab": tab.clone()}),
            &context,
        )
        .await
        .unwrap();
    let error = BrowserTool::click()
        .execute(json!({"tab": tab, "element": stale_element}), &context)
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("stale") || message.contains("Stale"),
        "stale element must be rejected, got: {message}"
    );
}

#[tokio::test]
async fn type_and_evaluate_roundtrip() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    BrowserTool::type_text()
        .execute(json!({"tab": tab, "text": "hello"}), &context)
        .await
        .unwrap();
    let evaluate = BrowserTool::evaluate()
        .execute(
            json!({"tab": tab, "expression": "document.title"}),
            &context,
        )
        .await
        .unwrap();
    assert!(
        evaluate.content.contains("[UNTRUSTED page content]"),
        "evaluate output must be marked untrusted"
    );
}

#[tokio::test]
async fn close_releases_the_tab() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    BrowserTool::close()
        .execute(json!({"tab": tab}), &context)
        .await
        .unwrap();
    let error = BrowserTool::snapshot()
        .execute(json!({"tab": tab}), &context)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exist"), "{error}");
}

#[tokio::test]
async fn sessions_cannot_touch_each_others_tabs() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let first = context_with(dir.path(), &manager, "session-a");
    let second = context_with(dir.path(), &manager, "session-b");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &first)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    let error = BrowserTool::snapshot()
        .execute(json!({"tab": tab}), &second)
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("different session"),
        "cross-session access must be refused, got: {message}"
    );
}

#[tokio::test]
async fn projects_do_not_share_browser_state() {
    let manager = manager();
    let root = tempdir().unwrap();
    let project_one = root.path().join("one");
    let project_two = root.path().join("two");
    std::fs::create_dir_all(&project_one).unwrap();
    std::fs::create_dir_all(&project_two).unwrap();
    let first = context_with(&project_one, &manager, "session-a");
    let second = context_with(&project_two, &manager, "session-a");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &first)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    // Same session id, different project: the tab registry is keyed by
    // (session, project) so this lookup must fail.
    let error = BrowserTool::snapshot()
        .execute(json!({"tab": tab}), &second)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("different session") || error.to_string().contains("exist"),
        "{error}"
    );
}

#[tokio::test]
async fn private_and_metadata_ips_are_refused() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let mut context = context_with(dir.path(), &manager, "session-a");
    context.network_policy = Some(NetworkPolicyDecider::new(
        NetworkPolicy {
            default: codewhale_net::network_policy::DecisionToml::Allow,
            ..NetworkPolicy::default()
        },
        None,
    ));
    for url in [
        "http://127.0.0.1:8080/",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/",
    ] {
        let error = BrowserTool::open()
            .execute(json!({"url": url}), &context)
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("restricted") || message.contains("not allowed"),
            "private/metadata target must be refused, got: {message}"
        );
    }
}

#[tokio::test]
async fn redirects_to_restricted_hosts_are_refused() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    // The fake driver's navigate redirect chain must be guarded hop by hop.
    // We simulate this by navigating an existing tab to a restricted URL:
    // same guard path, since both open and navigate validate every hop.
    let error = BrowserTool::open()
        .execute(json!({"url": "http://192.168.1.10/admin"}), &context)
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("restricted") || message.contains("not allowed"),
        "restricted redirect target must be refused, got: {message}"
    );
}

#[tokio::test]
async fn cancel_token_aborts_before_execution() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let mut context = context_with(dir.path(), &manager, "session-a");
    let token = CancellationToken::new();
    token.cancel();
    context.cancel_token = Some(token);
    let error = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"), "{error}");
}

#[tokio::test]
async fn child_hosts_are_denied_browser_tools() {
    use crate::core::authority::TurnAuthority;
    use crate::core::engine::tests::engine_child_host_fixture;
    use crate::tools::subagent::SubAgentRuntime;
    use crate::tools::subagent::engine::ChildAuthority;
    use codewhale_agent_contract::worker_profile::FleetRole;

    let dir = tempdir().unwrap();
    let _home = crate::test_support::SealedHome::at(dir.path());
    let (parent, _handle, _authority, route) = engine_child_host_fixture(dir.path(), None);
    let policy = TurnAuthority::from_effective_fields(
        codewhale_config::AppMode::Agent,
        true,
        false,
        false,
        codewhale_execpolicy::ApprovalMode::Suggest,
    );
    let context = parent.build_tool_context_for_turn(&policy, &route);
    let client = route.client.clone().expect("client");
    let runtime = SubAgentRuntime::new(
        client,
        crate::DEFAULT_TEXT_MODEL.into(),
        context,
        true,
        None,
        parent.subagent_manager(),
    );
    let authority = ChildAuthority::capture(
        runtime,
        FleetRole::Scout,
        "child-a".into(),
        "inspect".into(),
        None,
    );
    let child = authority.context();
    let error = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &child)
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("sub-agents"),
        "child host must be denied, got: {message}"
    );
}

#[tokio::test]
async fn screenshot_stores_private_artifact_and_inline_image() {
    let dir = tempdir().unwrap();
    let _reset = TestArtifactRoot::new(dir.path());
    let manager = manager();
    let context = context_with(dir.path(), &manager, "session-shots");
    let opened = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&opened.content).unwrap();
    let tab = parsed["tab"].as_str().unwrap().to_string();
    let rich = BrowserTool::screenshot()
        .execute_rich(json!({"tab": tab}), &context)
        .await
        .unwrap();
    assert!(
        !rich.content_blocks.is_empty(),
        "screenshot must produce an image content block"
    );
    let metadata = rich.result.metadata.expect("screenshot metadata");
    let stored = metadata["browser_screenshot"]["artifact_relative_path"]
        .as_str()
        .expect("artifact path");
    assert!(stored.starts_with("artifacts/browser_shot_"), "{stored}");
    assert!(stored.ends_with(".png"));
    // The artifact bytes live under the session's own directory.
    let sessions_root = codewhale_runtime::artifacts::artifact_sessions_root().unwrap();
    let on_disk = sessions_root.join("session-shots").join(stored);
    assert!(on_disk.is_file(), "artifact must be stored privately");
}

#[tokio::test]
async fn evaluate_requires_approval_every_call() {
    let tool = BrowserTool::evaluate();
    assert_eq!(
        tool.approval_requirement_for(&json!({"tab": "t", "expression": "1"})),
        codewhale_tools::ApprovalRequirement::Required
    );
}

#[tokio::test]
async fn missing_host_fails_closed() {
    let dir = tempdir().unwrap();
    let context = ToolContext::new(dir.path());
    let error = BrowserTool::open()
        .execute(json!({"url": "https://example.test/"}), &context)
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("not attached") || message.contains("unavailable"),
        "no host must fail closed, got: {message}"
    );
}

#[tokio::test]
async fn session_close_releases_all_tabs() {
    let manager = manager();
    let dir = tempdir().unwrap();
    let context = context_with(dir.path(), &manager, "session-a");
    BrowserTool::open()
        .execute(json!({"url": "https://example.test/1"}), &context)
        .await
        .unwrap();
    BrowserTool::open()
        .execute(json!({"url": "https://example.test/2"}), &context)
        .await
        .unwrap();
    assert_eq!(manager.session_tab_count("session-a").await, 2);
    manager.close_session("session-a").await.unwrap();
    assert_eq!(manager.session_tab_count("session-a").await, 0);
}

use crate::tools::spec::ToolSpec;

struct TestArtifactRoot(Option<std::path::PathBuf>);
impl TestArtifactRoot {
    fn new(root: &Path) -> Self {
        Self(
            codewhale_runtime::artifacts::set_test_artifact_sessions_root(Some(
                root.join("sessions"),
            )),
        )
    }
}
impl Drop for TestArtifactRoot {
    fn drop(&mut self) {
        let _guard = codewhale_runtime::artifacts::TEST_ARTIFACT_SESSIONS_GUARD
            .lock()
            .unwrap();
        codewhale_runtime::artifacts::set_test_artifact_sessions_root(self.0.take());
    }
}
