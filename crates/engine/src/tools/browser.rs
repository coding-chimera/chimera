//! Engine-side browser tools: `browser_open`, `browser_snapshot`,
//! `browser_click`, `browser_type`, `browser_screenshot`, `browser_close`,
//! `browser_evaluate`.
//!
//! Security contract (W5 §12.3):
//! - Every navigation (open or in-tab) validates the destination through the
//!   shared net guard, including each redirect hop.
//! - Approvals are origin-scoped: a new origin after a redirect requires a
//!   new approval decision.
//! - `browser_evaluate` always requires per-call approval; it is never
//!   persistently granted.
//! - Snapshots and evaluate output are UNTRUSTED page content and are
//!   redacted before reaching the model or logs.
//! - Screenshots flow through the image ToolResult content-block path into
//!   the session-private artifact store.
//! - Sub-agents (child hosts) are denied: browser control is a machine
//!   control surface, per the existing child ban.
//!
//! Known limitations: no upload/download flows (matching the source tool's
//! contract); remote CDP attach requires an explicitly trusted endpoint and
//! does not share the user's authenticated profile.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use codewhale_browser::BrowserError;
use codewhale_browser::domain::ElementRef;
use codewhale_browser::manager::BrowserManager;
use codewhale_tools::{
    ApprovalRequirement, optional_str, required_action, required_str, type_mismatch,
};
use serde_json::{Value, json};

use super::spec::{RichToolResult, ToolCapability, ToolContext, ToolError, ToolResult, ToolSpec};

const BROWSER_ACTIONS: &[&str] = &[
    "open",
    "snapshot",
    "click",
    "type",
    "screenshot",
    "close",
    "evaluate",
];

/// Cap on snapshot nodes serialized into the model-visible result.
const SNAPSHOT_NODE_LIMIT: usize = 400;
/// Cap on evaluate output before truncation with a receipt.
const EVALUATE_RESULT_LIMIT: usize = 20_000;
/// Screenshot input size cap before refusing to inline.
const SCREENSHOT_MAX_BYTES: usize = 5 * 1024 * 1024;
/// Per-call timeout for evaluate.
const EVALUATE_TIMEOUT: Duration = Duration::from_secs(20);

pub struct BrowserTool {
    name: &'static str,
    forced_action: Option<&'static str>,
}

impl BrowserTool {
    #[must_use]
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            forced_action: None,
        }
    }

    #[must_use]
    pub fn open() -> Self {
        Self {
            name: "browser_open",
            forced_action: Some("open"),
        }
    }

    #[must_use]
    pub fn snapshot() -> Self {
        Self {
            name: "browser_snapshot",
            forced_action: Some("snapshot"),
        }
    }

    #[must_use]
    pub fn click() -> Self {
        Self {
            name: "browser_click",
            forced_action: Some("click"),
        }
    }

    #[must_use]
    pub fn type_text() -> Self {
        Self {
            name: "browser_type",
            forced_action: Some("type"),
        }
    }

    #[must_use]
    pub fn screenshot() -> Self {
        Self {
            name: "browser_screenshot",
            forced_action: Some("screenshot"),
        }
    }

    #[must_use]
    pub fn close() -> Self {
        Self {
            name: "browser_close",
            forced_action: Some("close"),
        }
    }

    #[must_use]
    pub fn evaluate() -> Self {
        Self {
            name: "browser_evaluate",
            forced_action: Some("evaluate"),
        }
    }

    fn resolve_action<'a>(&self, input: &'a Value) -> &'a str {
        if let Some(action) = self.forced_action {
            return action;
        }
        input
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("open")
    }
}

fn map_browser_error(error: BrowserError) -> ToolError {
    match error {
        BrowserError::MissingBrowser => ToolError::not_available(
            "no system Chromium/Chrome installation was found; install one or set browser.executable",
        ),
        BrowserError::UntrustedRemote(_) => ToolError::permission_denied(error.to_string()),
        BrowserError::StaleTabRef(_) | BrowserError::StaleElementRef(_) => {
            ToolError::invalid_input(error.to_string())
        }
        BrowserError::Quota(_) | BrowserError::TooManyRedirects => {
            ToolError::execution_failed(error.to_string())
        }
        BrowserError::Timeout => ToolError::execution_failed("browser operation timed out"),
        other => ToolError::execution_failed(other.to_string()),
    }
}

fn project_of(context: &ToolContext) -> String {
    context
        .workspace
        .canonicalize()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| context.workspace.display().to_string())
}

fn check_cancelled(context: &ToolContext) -> Result<(), ToolError> {
    if context
        .cancel_token
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(ToolError::cancelled("browser operation cancelled"));
    }
    Ok(())
}

fn child_host_denied(context: &ToolContext) -> Result<(), ToolError> {
    if context.child_host.is_some() {
        return Err(ToolError::permission_denied(
            "browser tools are not available to sub-agents; run them in the parent session instead",
        ));
    }
    Ok(())
}

/// Validate a navigation URL through the shared net guard, including DNS
/// resolution, and return the pin. Mirrors `validate_fetch_target` in
/// `tools/web/guard.rs`, but standalone so the browser crate keeps its own
/// transport while sharing the policy.
async fn guard_destination(url: &str, context: &ToolContext) -> Result<url::Url, ToolError> {
    let parsed = url::Url::parse(url)
        .map_err(|error| ToolError::invalid_input(format!("invalid URL {url:?}: {error}")))?;
    let host = codewhale_net::guard::fetch_target_host(&parsed)?;
    codewhale_net::guard::validate_fetch_destination(
        host,
        context.network_policy.as_ref(),
        "browser_open",
        true,
    )
    .await?;
    Ok(parsed)
}

/// Check every redirect hop the driver reports: each must pass the same
/// destination guard as the initial URL.
async fn guard_redirects(redirects: &[String], context: &ToolContext) -> Result<(), ToolError> {
    for hop in redirects {
        guard_destination(hop, context).await?;
    }
    Ok(())
}

fn untrusted_marked(value: String) -> String {
    format!("[UNTRUSTED page content]\n{value}")
}

fn redact_output(text: &str) -> String {
    codewhale_sanitize::redact::redact_model_bound_secrets(text)
}

fn session_id_of(context: &ToolContext) -> String {
    if codewhale_runtime::artifacts::is_valid_session_id(&context.state_namespace) {
        context.state_namespace.clone()
    } else {
        "browser-session".to_string()
    }
}

#[async_trait]
impl ToolSpec for BrowserTool {
    fn name(&self) -> &'static str {
        self.name
    }

    fn description(&self) -> &'static str {
        match self.forced_action {
            Some("open") => {
                "Open a URL in the session browser tab and return the page title, final URL, and redirect chain. Each navigation is network-policy and SSRF guarded, including redirect hops."
            }
            Some("snapshot") => {
                "Capture the accessibility-style snapshot of an open browser tab: nodes with roles, names and values. Output is untrusted page content and is bounded."
            }
            Some("click") => {
                "Click an element referenced from a browser snapshot. Stale references (after navigation) are rejected; take a new snapshot first."
            }
            Some("type") => {
                "Type text into a browser tab, optionally targeting an element from a snapshot. Stale element references are rejected."
            }
            Some("screenshot") => {
                "Capture a PNG screenshot of an open browser tab. The image enters the conversation through the validated image ToolResult path and is stored as a session-private artifact."
            }
            Some("close") => "Close an open browser tab and release its resources.",
            Some("evaluate") => {
                "Evaluate a JavaScript expression in a browser tab and return the serialized result. Requires per-call approval; the input expression is not written to approval logs."
            }
            _ => {
                "Drive a Chromium browser tab: open, snapshot, click, type, screenshot, close, evaluate."
            }
        }
    }

    fn input_schema(&self) -> Value {
        match self.forced_action {
            Some("open") => json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The http(s) URL to open."},
                    "tab": {"type": "string", "description": "Existing tab id to navigate; omit to open a new tab."}
                },
                "required": ["url"]
            }),
            Some("snapshot") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id from browser_open."},
                    "max_nodes": {"type": "integer", "description": "Node limit for the returned tree (default 400)."}
                },
                "required": ["tab"]
            }),
            Some("click") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id."},
                    "element": {"type": "string", "description": "Element reference from the snapshot, e.g. e2-7@3."}
                },
                "required": ["tab", "element"]
            }),
            Some("type") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id."},
                    "text": {"type": "string", "description": "Text to type."},
                    "element": {"type": "string", "description": "Optional element reference to focus first."}
                },
                "required": ["tab", "text"]
            }),
            Some("screenshot") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id."}
                },
                "required": ["tab"]
            }),
            Some("close") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id to close."}
                },
                "required": ["tab"]
            }),
            Some("evaluate") => json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "Tab id."},
                    "expression": {"type": "string", "description": "JavaScript expression; result is serialized and bounded."}
                },
                "required": ["tab", "expression"]
            }),
            _ => json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": BROWSER_ACTIONS},
                    "url": {"type": "string"},
                    "tab": {"type": "string"},
                    "element": {"type": "string"},
                    "text": {"type": "string"},
                    "expression": {"type": "string"}
                },
                "required": ["action"]
            }),
        }
    }

    fn capabilities(&self) -> Vec<ToolCapability> {
        match self.forced_action {
            Some("snapshot") => vec![ToolCapability::ReadOnly, ToolCapability::Network],
            _ => vec![ToolCapability::Network, ToolCapability::RequiresApproval],
        }
    }

    fn approval_requirement_for(&self, input: &Value) -> ApprovalRequirement {
        match self.resolve_action(input) {
            "snapshot" => ApprovalRequirement::Auto,
            // Evaluate is per-call approval: it executes arbitrary JS in a
            // page. The approval cache scope for browser tools is per-origin
            // (approval_scope below), so persistent always-grants never cover it.
            "evaluate" => ApprovalRequirement::Required,
            _ => ApprovalRequirement::Required,
        }
    }

    fn is_read_only_for(&self, input: &Value) -> bool {
        self.resolve_action(input) == "snapshot"
    }

    fn supports_parallel_for(&self, input: &Value) -> bool {
        self.resolve_action(input) == "snapshot"
    }

    fn defer_loading(&self) -> bool {
        true
    }

    fn approval_scope(&self) -> Option<String> {
        // Origin-scoped grants: the engine keys browser approvals under this
        // scope family with the concrete origin the call acts on, so a
        // redirect to a new origin is a new approval decision.
        Some("browser".to_string())
    }

    async fn execute(&self, input: Value, context: &ToolContext) -> Result<ToolResult, ToolError> {
        let rich = self.execute_rich(input, context).await?;
        Ok(rich.into_result())
    }

    async fn execute_rich(
        &self,
        input: Value,
        context: &ToolContext,
    ) -> Result<RichToolResult, ToolError> {
        check_cancelled(context)?;
        child_host_denied(context)?;
        let action = if let Some(forced) = self.forced_action {
            forced.to_string()
        } else {
            required_action(&input, "browser", BROWSER_ACTIONS)?
        };
        let manager = browser_manager(context).ok_or_else(|| {
            ToolError::not_available(
                "the browser tool host is not attached in this session; browser tools are unavailable",
            )
        })?;
        let session = session_id_of(context);
        let project = project_of(context);

        match action.as_str() {
            "open" => {
                let url = required_str(&input, "url")?;
                guard_destination(url, context).await?;
                let tab = optional_str(&input, "tab")?;
                let outcome = if let Some(raw) = tab {
                    let tab = manager
                        .tab(&session, &project, raw)
                        .await
                        .map_err(map_browser_error)?;
                    let mut tab = tab.lock().await;
                    let outcome = tab.navigate(url).await.map_err(map_browser_error)?;
                    guard_redirects(&outcome.redirects, context).await?;
                    outcome
                } else {
                    let outcome = manager
                        .open_tab(&session, &project, url)
                        .await
                        .map_err(map_browser_error)?;
                    guard_redirects(&outcome.redirects, context).await?;
                    outcome
                };
                check_cancelled(context)?;
                let content = json!({
                    "tab": outcome.tab.tab_id.raw,
                    "generation": outcome.tab.tab_id.generation,
                    "url": redact_url(&outcome.final_url),
                    "origin": outcome.origin.display(),
                    "title": outcome.title,
                    "redirects": outcome.redirects.iter().map(|r| redact_url(r)).collect::<Vec<_>>(),
                });
                Ok(RichToolResult::plain(ToolResult::success(
                    serde_json::to_string_pretty(&content).unwrap_or_default(),
                )))
            }
            "snapshot" => {
                let raw = required_str(&input, "tab")?;
                let tab = manager
                    .tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                let tab = tab.lock().await;
                let snapshot = tab.snapshot().await.map_err(map_browser_error)?;
                let max_nodes = input
                    .get("max_nodes")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(SNAPSHOT_NODE_LIMIT as u64) as usize)
                    .unwrap_or(SNAPSHOT_NODE_LIMIT);
                let bounded: Vec<Value> = snapshot
                    .bounded_nodes(max_nodes)
                    .into_iter()
                    .map(|node| {
                        json!({
                            "ref": node.reference,
                            "role": node.role,
                            "name": node.name,
                            "value": node.value,
                        })
                    })
                    .collect();
                let content = json!({
                    "tab": snapshot.tab,
                    "generation": snapshot.generation,
                    "url": redact_url(&snapshot.url),
                    "title": snapshot.title,
                    "node_count": snapshot.node_count,
                    "nodes": bounded,
                    "truncated": snapshot.node_count > max_nodes,
                });
                let text = untrusted_marked(redact_output(
                    &serde_json::to_string_pretty(&content).unwrap_or_default(),
                ));
                Ok(RichToolResult::plain(ToolResult::success(text)))
            }
            "click" => {
                let raw = required_str(&input, "tab")?;
                let element = required_str(&input, "element")?;
                let element = parse_element_ref(raw, element)?;
                let tab = manager
                    .tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                let mut tab = tab.lock().await;
                tab.click(&element).await.map_err(map_browser_error)?;
                Ok(RichToolResult::plain(ToolResult::success(
                    json!({
                        "tab": raw,
                        "clicked": element.ordinal,
                    })
                    .to_string(),
                )))
            }
            "type" => {
                let raw = required_str(&input, "tab")?;
                let text = required_str(&input, "text")?;
                let element = optional_str(&input, "element")?
                    .map(|element| parse_element_ref(raw, element))
                    .transpose()?;
                let tab = manager
                    .tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                let mut tab = tab.lock().await;
                tab.type_text(element.as_ref(), text)
                    .await
                    .map_err(map_browser_error)?;
                Ok(RichToolResult::plain(ToolResult::success(
                    json!({
                        "tab": raw,
                        "typed_chars": text.chars().count(),
                    })
                    .to_string(),
                )))
            }
            "screenshot" => {
                let raw = required_str(&input, "tab")?;
                let tab = manager
                    .tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                let mut tab = tab.lock().await;
                let bytes = tab.screenshot().await.map_err(map_browser_error)?;
                if bytes.len() > SCREENSHOT_MAX_BYTES {
                    return Err(ToolError::execution_failed(
                        "screenshot exceeds the inline image size limit",
                    ));
                }
                let mime = crate::image_attach::sniff_media_type(&bytes)
                    .ok_or_else(|| {
                        ToolError::execution_failed(
                            "screenshot bytes are not a recognized image format",
                        )
                    })?
                    .to_string();
                let session_for_artifact = session.clone();
                let bytes_for_store = bytes.clone();
                let artifact_store = tokio::task::spawn_blocking(move || {
                    store_screenshot_artifact(&session_for_artifact, &bytes_for_store)
                })
                .await
                .map_err(|error| {
                    ToolError::execution_failed(format!("screenshot store failed: {error}"))
                })??;
                let prepared = crate::image_attach::prepare_tool_image_bytes(&bytes, &mime);
                let note = format!(
                    "{prepared_note}\n[Stored as session artifact {artifact_path}]",
                    prepared_note = prepared.note,
                    artifact_path = artifact_store,
                );
                let result = ToolResult::success(note).with_metadata(json!({
                    "browser_screenshot": {
                        "tab": raw,
                        "byte_size": bytes.len(),
                        "mime_type": mime,
                        "artifact_relative_path": artifact_store,
                    },
                }));
                Ok(RichToolResult::with_content_blocks(
                    result,
                    prepared.block.into_iter().collect(),
                ))
            }
            "close" => {
                let raw = required_str(&input, "tab")?;
                manager
                    .close_tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                Ok(RichToolResult::plain(ToolResult::success(
                    json!({
                        "tab": raw,
                        "closed": true,
                    })
                    .to_string(),
                )))
            }
            "evaluate" => {
                let raw = required_str(&input, "tab")?;
                let expression = required_str(&input, "expression")?;
                let tab = manager
                    .tab(&session, &project, raw)
                    .await
                    .map_err(map_browser_error)?;
                let mut tab = tab.lock().await;
                let deadline = context
                    .turn_deadline
                    .unwrap_or_else(|| tokio::time::Instant::now() + EVALUATE_TIMEOUT)
                    .min(tokio::time::Instant::now() + EVALUATE_TIMEOUT);
                let outcome = tokio::time::timeout_at(deadline, tab.evaluate(expression))
                    .await
                    .map_err(|_| ToolError::execution_failed("browser evaluate timed out"))?
                    .map_err(map_browser_error)?;
                let value = redact_output(&outcome.value);
                let (bounded, truncated) = bound_evaluate(&value);
                let content = untrusted_marked(bounded);
                Ok(RichToolResult::plain(
                    ToolResult::success(content).with_metadata(json!({
                        "tab": raw,
                        "truncated": truncated,
                    })),
                ))
            }
            other => Err(ToolError::invalid_input(format!(
                "unknown browser action {other:?}; pass one of: {}",
                BROWSER_ACTIONS.join(", ")
            ))),
        }
    }
}

fn bound_evaluate(value: &str) -> (String, bool) {
    if value.chars().count() <= EVALUATE_RESULT_LIMIT {
        return (value.to_string(), false);
    }
    (
        format!(
            "{}\n[evaluate output truncated at {EVALUATE_RESULT_LIMIT} characters]",
            value
                .chars()
                .take(EVALUATE_RESULT_LIMIT)
                .collect::<String>()
        ),
        true,
    )
}

fn parse_element_ref(tab: &str, raw: &str) -> Result<ElementRef, ToolError> {
    // Format: e<tab>-<ordinal>@<generation> or just the ordinal.
    let (reference, generation) = match raw.split_once('@') {
        Some((reference, generation)) => (
            reference,
            generation.parse::<u64>().map_err(|_| {
                type_mismatch(
                    "element",
                    &Value::String(raw.to_string()),
                    "e<tab>-<n>@<generation>",
                )
            })?,
        ),
        None => (raw, 0),
    };
    let tail = reference.rsplit('-').next().unwrap_or(reference);
    let digits = tail.strip_prefix('e').unwrap_or(tail);
    let ordinal = digits
        .parse::<u32>()
        .map_err(|_| type_mismatch("element", &Value::String(raw.to_string()), "e<tab>-<n>"))?;
    Ok(ElementRef::new(tab.to_string(), generation, ordinal))
}

fn redact_url(url: &str) -> String {
    codewhale_sanitize::sanitize::redact_url_for_display(url)
}

fn store_screenshot_artifact(session: &str, bytes: &[u8]) -> Result<String, ToolError> {
    let digest = codewhale_runtime::hashing::sha256_hex(bytes);
    let artifact_id = format!("browser_shot_{}", &digest[..16]);
    let (_absolute, relative) = codewhale_runtime::artifacts::write_session_artifact_bytes(
        session,
        &artifact_id,
        "png",
        bytes,
    )
    .map_err(|error| {
        ToolError::execution_failed(format!("failed to preserve screenshot artifact: {error}"))
    })?;
    Ok(codewhale_runtime::artifacts::format_artifact_relative_path(
        &relative,
    ))
}

/// The process-scoped browser manager, shared by every browser tool call.
/// Attached to the engine at tool setup; `None` in bare test contexts.
static BROWSER_MANAGER: std::sync::OnceLock<Arc<BrowserManager>> = std::sync::OnceLock::new();

#[must_use]
pub fn install_browser_manager(manager: Arc<BrowserManager>) {
    let _ = BROWSER_MANAGER.set(manager);
}

#[must_use]
pub fn browser_manager(context: &ToolContext) -> Option<Arc<BrowserManager>> {
    let installed = BROWSER_MANAGER.get().cloned();
    installed.or_else(|| context.runtime.browser_manager.clone())
}

#[cfg(test)]
mod tests;
