//! Swarm batch fan-out for the model-facing `agent` tool.
//!
//! One `agent action=swarm` call materializes a bounded list of work items and
//! launches each as a fresh child through the existing
//! [`SubAgentManager::spawn_background_with_assignment_options`] path — no
//! second scheduler, turn loop, or registry. Foreground runs join inline under
//! a semaphore at the requested concurrency; background runs return a frozen
//! start receipt and each worker completion is pushed through the existing
//! Engine completion channel exactly once (generation + durable outbox).
//!
//! Input shapes (W2 contract):
//! - `items + prompt_template`
//! - `items + preset` (one of the four Chimera presets, which supply the
//!   worker prompt shape)
//! - `from` — a read-only evidence-source port; without a materialized
//!   evidence store the call fails loud with an empty-input error, never a
//!   fake item list.
//!
//! `description` is required, `items`/`from` are mutually exclusive, and
//! `prompt_template` must contain the `{{item}}` placeholder.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::tools::spec::{ToolContext, ToolError};
use codewhale_agent_contract::role::FleetRole;

use super::{SharedSubAgentManager, SubAgentRuntime, spawn_subagent_from_input};

/// Chimera contract: single fan-out concurrency default and cap (16).
pub const DEFAULT_SWARM_CONCURRENCY: u64 = 16;
pub const MAX_SWARM_CONCURRENCY: u64 = 16;
/// `limit` default and cap for `from` materialization.
pub const DEFAULT_SWARM_LIMIT: u64 = 20;
pub const MAX_SWARM_LIMIT: u64 = 100;
/// Hard cap on items accepted in a single swarm call.
pub const MAX_SWARM_ITEMS: usize = 128;

/// The four Chimera batch presets (`batch-preset.ts` shapes).
pub const SWARM_PRESETS: &[&str] = &[
    "audit-followup",
    "audit-review",
    "oracle-followup",
    "file-review",
];

/// The `from` evidence sources (W2: read-only port; W4 writers land later).
pub const SWARM_FROM_SOURCES: &[&str] = &[
    "pending_obligations",
    "claimed_obligations",
    "stale_obligations",
    "active_obligations",
    "failing_oracles",
    "unknown_oracles",
    "failing_or_unknown_oracles",
];

/// The structured summary labels a preset asks each worker to return.
const RETURN_CONTRACT: &[&str] = &[
    "Return a concise structured report with these labels:",
    "Status: actionable | covered | irrelevant | duplicate | blocked | no-issue",
    "Changed files: <paths or none>",
    "Verification: <commands/results or not run>",
    "Remaining risk: <risk or none>",
    "Parent follow-up: <recommended parent action or none>",
];

/// Worker prompt shape for one preset. None for an unknown preset.
pub fn preset_template(preset: &str) -> Option<String> {
    let mut lines: Vec<&str> = match preset {
        "audit-followup" => vec![
            "You are a swarm audit-followup worker. Handle exactly one audit or obligation item.",
            "Presets are worker prompt shapes, not workflow engines or permission switches; use the tools available to you normally.",
            "If the item has a clear, narrow fix and you have edit tools, make scoped edits only for this item, run focused verification when you edit, and report changed files.",
            "Do not broaden into unrelated refactors, do not take over other swarm items, and surface already-covered, irrelevant, duplicate, out-of-scope, or blocked items explicitly.",
        ],
        "audit-review" => vec![
            "You are a swarm audit-review worker. Review exactly one audit or obligation item.",
            "Classify it as actionable, already covered, irrelevant, duplicate, stale, or out of scope.",
            "Do not edit unless the parent prompt explicitly tells you to. Return concise evidence and next action.",
        ],
        "oracle-followup" => vec![
            "You are a swarm oracle-followup worker. Investigate exactly one failing or unknown verification oracle.",
            "Explain the likely cause, whether it is linked to recent changes, and the next focused check or fix.",
            "Do not rerun broad checks unless clearly necessary.",
        ],
        "file-review" => vec![
            "You are a swarm file-review worker. Review exactly one file or work item.",
            "Report concrete risks, missing tests, or follow-up edits. Keep the result concise and evidence-backed.",
        ],
        _ => return None,
    };
    lines.extend(RETURN_CONTRACT);
    lines.push("");
    lines.push("Item {{index}}/{{total}}:");
    lines.push("{{item}}");
    Some(lines.join("\n"))
}

/// Preset → default Fleet role: `file-review` is a read-only review pass,
/// everything else general (write posture still comes from the explicit
/// `type`/`write_authority` fields, not the preset).
pub fn preset_role(preset: Option<&str>) -> FleetRole {
    match preset {
        Some("file-review") => FleetRole::Scout,
        _ => FleetRole::Worker,
    }
}

/// Clamp an optional numeric parameter to `[1, max]` with a fallback.
pub fn bounded_u64(value: Option<u64>, fallback: u64, max: u64) -> u64 {
    value.unwrap_or(fallback).clamp(1, max)
}

/// Render one item: a string passes through, an object renders as compact JSON.
fn render_item(item: &Value) -> String {
    match item {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

/// Substitute `{{item}}`, `{{index}}`, `{{total}}` in the template.
pub fn render_template(template: &str, item: &Value, index: u64, total: u64) -> String {
    template
        .replace("{{item}}", &render_item(item))
        .replace("{{index}}", &index.to_string())
        .replace("{{total}}", &total.to_string())
}

/// One advisory scope warning: a file named by 2+ explicit items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeWarning {
    pub file: String,
    pub item_indexes: Vec<u64>,
    pub message: String,
}

/// Extract the file/path keys an object item names.
fn item_scope_files(item: &Value) -> Vec<String> {
    let Value::Object(object) = item else {
        return Vec::new();
    };
    let mut files = Vec::new();
    let mut collect = |value: &Value| match value {
        Value::String(text) if !text.is_empty() => files.push(text.clone()),
        Value::Array(list) => {
            for entry in list {
                if let Value::String(text) = entry
                    && !text.is_empty()
                {
                    files.push(text.clone());
                }
            }
        }
        _ => {}
    };
    for key in ["files", "file", "path", "target"] {
        if let Some(value) = object.get(key) {
            collect(value);
        }
    }
    if let Some(Value::Object(scope)) = object.get("scope") {
        for key in ["files", "file", "path", "target"] {
            if let Some(value) = scope.get(key) {
                collect(value);
            }
        }
    }
    files
}

/// Advisory warnings: files mentioned by 2+ explicit items, 1-based indexes.
/// Real conflict prevention stays with the write-scope/claims authority; a
/// warning is never a lock.
pub fn collect_scope_warnings(items: &[Value]) -> Vec<ScopeWarning> {
    let mut by_file: Vec<(String, Vec<u64>)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        for file in item_scope_files(item) {
            match by_file.iter_mut().find(|(candidate, _)| *candidate == file) {
                Some(entry) => entry.1.push(index as u64 + 1),
                None => by_file.push((file, vec![index as u64 + 1])),
            }
        }
    }
    by_file
        .into_iter()
        .filter(|(_, indexes)| indexes.len() > 1)
        .map(|(file, item_indexes)| ScopeWarning {
            message: format!(
                "Possible scope conflict: {file} appears in items {}; keep edits scoped, resolve conflicts in the parent, or lower concurrency.",
                item_indexes
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            file,
            item_indexes,
        })
        .collect()
}

/// One materialized worker.
#[derive(Debug, Clone)]
pub struct SwarmWorkItem {
    /// 1-based index.
    pub index: u64,
    /// `{description} {index}/{total}`.
    pub title: String,
    /// The rendered prompt (scope-warning prefix + template).
    pub prompt: String,
}

/// The parsed swarm parameters (validated shape, before materialization).
#[derive(Debug, Clone)]
pub struct SwarmParams {
    pub prompt_template: Option<String>,
    pub items: Option<Vec<Value>>,
    pub from: Option<String>,
    pub preset: Option<String>,
    pub description: Option<String>,
    pub concurrency: Option<u64>,
    pub limit: Option<u64>,
    pub background: bool,
}

/// Parse the swarm arm of the `agent` input.
pub fn parse_swarm_params(input: &Value) -> Result<SwarmParams, ToolError> {
    let optional_string = |key: &str| -> Result<Option<String>, ToolError> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => {
                let trimmed = text.trim();
                Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
            }
            Some(other) => Err(ToolError::invalid_input(format!(
                "swarm '{key}' must be a string, got {other}"
            ))),
        }
    };
    let preset = optional_string("preset")?;
    if let Some(preset) = preset.as_deref()
        && !SWARM_PRESETS.contains(&preset)
    {
        return Err(ToolError::invalid_input(format!(
            "swarm preset must be one of {} (got '{preset}')",
            SWARM_PRESETS.join(", ")
        )));
    }
    let from = optional_string("from")?;
    if let Some(from) = from.as_deref()
        && !SWARM_FROM_SOURCES.contains(&from)
    {
        return Err(ToolError::invalid_input(format!(
            "swarm from must be one of {} (got '{from}')",
            SWARM_FROM_SOURCES.join(", ")
        )));
    }
    let items = match input.get("items") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(items.clone()),
        Some(_) => {
            return Err(ToolError::invalid_input(
                "swarm items must be an array of strings or objects",
            ));
        }
    };
    if let Some(items) = items.as_deref()
        && items
            .iter()
            .any(|item| !matches!(item, Value::String(_) | Value::Object(_)))
    {
        return Err(ToolError::invalid_input(
            "swarm items must be an array of strings or objects",
        ));
    }
    let numeric = |key: &str| -> Result<Option<u64>, ToolError> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(number)) => number.as_u64().map(Some).ok_or_else(|| {
                ToolError::invalid_input(format!("swarm '{key}' must be a positive integer"))
            }),
            Some(_) => Err(ToolError::invalid_input(format!(
                "swarm '{key}' must be a positive integer"
            ))),
        }
    };
    let background = match input.get("background") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(ToolError::invalid_input(
                "swarm 'background' must be a boolean",
            ));
        }
    };
    Ok(SwarmParams {
        prompt_template: optional_string("prompt_template")?,
        items,
        from,
        preset,
        description: optional_string("description")?,
        concurrency: numeric("concurrency")?,
        limit: numeric("limit")?,
        background,
    })
}

/// The three-arm validation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmSource {
    Items { items: Vec<Value> },
    From { source: String },
}

/// Validate the input arms: `description` required, `items`/`from` mutually
/// exclusive, one of them required. Error texts are written for a model to
/// self-correct.
pub fn validate_swarm_source(params: &SwarmParams) -> Result<SwarmSource, ToolError> {
    let description = params.description.as_deref();
    if description.is_none() {
        return Err(ToolError::invalid_input(
            "swarm requires a 'description' that names the batch in one line; add it so completions and receipts can be attributed. Example: { \"action\": \"swarm\", \"description\": \"review changed auth files\", \"items\": [...], \"prompt_template\": \"Review {{item}}\" }",
        ));
    }
    let has_items = params
        .items
        .as_deref()
        .is_some_and(|items| !items.is_empty());
    if has_items && params.from.is_some() {
        return Err(ToolError::invalid_input(
            "Provide either explicit items or from, not both.",
        ));
    }
    if has_items {
        let items = params.items.clone().unwrap_or_default();
        if items.len() > MAX_SWARM_ITEMS {
            return Err(ToolError::invalid_input(format!(
                "swarm accepts at most {MAX_SWARM_ITEMS} items in one run; split the batch or lower concurrency."
            )));
        }
        return Ok(SwarmSource::Items { items });
    }
    if let Some(from) = params.from.clone() {
        return Ok(SwarmSource::From { source: from });
    }
    Err(ToolError::invalid_input(
        "swarm needs work items: pass 'items' with 'prompt_template' or a 'preset', or a 'from' evidence source. Example: { \"action\": \"swarm\", \"description\": \"...\", \"prompt_template\": \"Item {{index}}/{{total}}: {{item}}\", \"items\": [\"Review src/auth.ts\"] }",
    ))
}

/// Materialize the worker items from the validated source.
///
/// `items` slices to `limit` (default 20, cap 100 — the same bound `from`
/// reads use); the template must come from `prompt_template` or a known
/// preset; the template must contain `{{item}}`.
pub fn materialize_swarm_items(
    params: &SwarmParams,
    source: &SwarmSource,
    materialized_from: Option<&[Value]>,
) -> Result<(Vec<SwarmWorkItem>, Vec<ScopeWarning>, u64), ToolError> {
    let (raw_items, warnings) = match source {
        SwarmSource::Items { items } => (items.as_slice(), collect_scope_warnings(items)),
        SwarmSource::From { .. } => {
            let items = materialized_from.unwrap_or_default();
            (items, Vec::new())
        }
    };
    if raw_items.is_empty() {
        return Err(ToolError::invalid_input(
            "the selected swarm source produced no work items; pass explicit items or materialize the evidence store first.",
        ));
    }
    let limit = bounded_u64(params.limit, DEFAULT_SWARM_LIMIT, MAX_SWARM_LIMIT);
    let items = &raw_items[..(limit as usize).min(raw_items.len())];
    let template = params
        .prompt_template
        .clone()
        .or_else(|| params.preset.as_deref().and_then(preset_template));
    let Some(template) = template else {
        return Err(ToolError::invalid_input(
            "swarm requires prompt_template or one of the four presets (audit-followup, audit-review, oracle-followup, file-review).",
        ));
    };
    if !template.contains("{{item}}") {
        return Err(ToolError::invalid_input(
            "prompt_template must include the {{item}} placeholder so each worker receives its own item. Example: prompt_template: \"Item {{index}}/{{total}}: {{item}}\"",
        ));
    }
    let concurrency = bounded_u64(
        params.concurrency,
        DEFAULT_SWARM_CONCURRENCY,
        MAX_SWARM_CONCURRENCY,
    );
    let total = items.len() as u64;
    let base_title = params
        .description
        .clone()
        .or_else(|| params.preset.clone())
        .unwrap_or_else(|| "swarm item".to_string());
    let work_items = items
        .iter()
        .enumerate()
        .map(|(position, item)| {
            let index = position as u64 + 1;
            let prefix = warnings
                .iter()
                .filter(|warning| warning.item_indexes.contains(&index))
                .map(|warning| format!("Scope warning: {}", warning.message))
                .collect::<Vec<_>>()
                .join("\n");
            let rendered = render_template(&template, item, index, total);
            let prompt = [prefix, rendered]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            SwarmWorkItem {
                index,
                title: format!("{base_title} {index}/{total}"),
                prompt,
            }
        })
        .collect();
    Ok((work_items, warnings, concurrency))
}

/// One child-run row in the start receipt / foreground aggregate.
#[derive(Debug, Clone)]
pub struct SwarmChildRun {
    pub index: u64,
    pub title: String,
    pub status: &'static str,
    pub agent_id: Option<String>,
    pub error: Option<String>,
}

impl SwarmChildRun {
    pub fn json(&self) -> Value {
        let mut object = json!({
            "index": self.index,
            "title": self.title,
            "status": self.status,
        });
        if let Some(agent_id) = self.agent_id.as_deref() {
            object["agent_id"] = json!(agent_id);
        }
        if let Some(error) = self.error.as_deref() {
            object["error"] = json!(error);
        }
        object
    }
}

/// The structured summary labels extracted from a worker's final text.
const SUMMARY_LABELS: &[(&str, &str)] = &[
    ("status", "Status:"),
    ("changed_files", "Changed files:"),
    ("verification", "Verification:"),
    ("remaining_risk", "Remaining risk:"),
    ("parent_follow_up", "Parent follow-up:"),
];

/// The extracted preset-summary fields from a worker result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwarmSummary {
    pub status: Option<String>,
    pub changed_files: Option<String>,
    pub verification: Option<String>,
    pub remaining_risk: Option<String>,
    pub parent_follow_up: Option<String>,
}

fn clamp_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

impl SwarmSummary {
    fn member(&self, key: &str) -> Option<&str> {
        match key {
            "status" => self.status.as_deref(),
            "changed_files" => self.changed_files.as_deref(),
            "verification" => self.verification.as_deref(),
            "remaining_risk" => self.remaining_risk.as_deref(),
            "parent_follow_up" => self.parent_follow_up.as_deref(),
            _ => None,
        }
    }

    /// Present labels joined with ` | `, else `(none)`.
    pub fn render(&self) -> String {
        let parts: Vec<String> = SUMMARY_LABELS
            .iter()
            .filter_map(|(key, label)| self.member(key).map(|value| format!("{label} {value}")))
            .collect();
        if parts.is_empty() {
            "(none)".to_string()
        } else {
            parts.join(" | ")
        }
    }
}

/// Extract the summary labels from a worker's final text: each label runs to
/// the next label or the end; newlines collapse; each value clamps to 1000
/// chars.
pub fn extract_swarm_summary(output: &str) -> SwarmSummary {
    let text: String = output
        .replace("<task_result>", "")
        .replace("</task_result>", "");
    let mut positions: Vec<(usize, &str, &str)> = SUMMARY_LABELS
        .iter()
        .filter_map(|(key, label)| text.find(label).map(|index| (index, *key, *label)))
        .collect();
    positions.sort_by_key(|(index, _, _)| *index);
    let mut summary = SwarmSummary::default();
    for (position, entry) in positions.iter().enumerate() {
        let (index, key, label) = *entry;
        let start = index + label.len();
        let end = positions
            .get(position + 1)
            .map(|(next, _, _)| *next)
            .unwrap_or(text.len());
        if start > end || start > text.len() {
            continue;
        }
        let end = end.min(text.len());
        let value = text[start..end].replace('\n', " ");
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let clamped = clamp_chars(value, 1000);
        match key {
            "status" => summary.status = Some(clamped),
            "changed_files" => summary.changed_files = Some(clamped),
            "verification" => summary.verification = Some(clamped),
            "remaining_risk" => summary.remaining_risk = Some(clamped),
            "parent_follow_up" => summary.parent_follow_up = Some(clamped),
            _ => {}
        }
    }
    summary
}

/// The parent closeout guidance carried by the foreground aggregate.
pub const SWARM_PARENT_CLOSEOUT: &[&str] = &[
    "Inspect each worker's Status, Changed files, Verification, Remaining risk, and Parent follow-up labels.",
    "If any worker changed files or reports actionable follow-up, resolve conflicts and run focused verification before closeout.",
];

/// The background receipt note.
pub const SWARM_BACKGROUND_NOTE: &str = "Swarm workers are running in the background. Each worker completion is pushed to this session exactly once; do not sleep, poll, or proactively check on progress. Cancel a single worker with agent action=cancel using its agent_id. This receipt is frozen at return time; derive live status from agent action=status.";

/// The foreground aggregate note.
pub const SWARM_FOREGROUND_NOTE: &str = "Worker outputs are included inline in results.";

/// One foreground worker result row (`<swarm_worker_result>` text).
pub fn swarm_worker_result_text(
    index: u64,
    title: &str,
    agent_id: Option<&str>,
    state: &str,
    summary: &SwarmSummary,
    error: Option<&str>,
) -> String {
    let mut lines = vec![
        format!(
            "agent_id: {} (swarm worker {})",
            agent_id.unwrap_or("not-started"),
            state
        ),
        "<swarm_worker_result>".to_string(),
        format!("index: {index}"),
        format!("title: {title}"),
        format!("status: {state}"),
    ];
    if state == "completed" {
        lines.push(format!("summary: {}", summary.render()));
    }
    if let Some(error) = error {
        lines.push(format!("error: {}", clamp_chars(error, 2000)));
    }
    lines.push("</swarm_worker_result>".to_string());
    lines.join("\n")
}

/// Execute the swarm arm of `agent`: validate, materialize, spawn each item
/// through the existing single-child path, and aggregate.
///
/// The route is resolved once, up front: the first spawn binds the model
/// route, and the resolved model is pinned into every subsequent item's
/// spawn input so all workers in the run share one frozen route (the Runtime
/// never re-resolves mid-run). Permission posture is likewise inherited from
/// the caller's runtime — a swarm cannot widen it.
#[allow(clippy::too_many_arguments)]
pub async fn execute_swarm(
    input: &Value,
    manager: SharedSubAgentManager,
    runtime: SubAgentRuntime,
    context: &ToolContext,
    evidence: &dyn super::evidence::SwarmEvidenceSource,
) -> Result<serde_json::Value, ToolError> {
    let params = parse_swarm_params(input)?;
    let source = validate_swarm_source(&params)?;
    let materialized_from = match &source {
        SwarmSource::Items { .. } => None,
        SwarmSource::From { source } => {
            let limit = bounded_u64(params.limit, DEFAULT_SWARM_LIMIT, MAX_SWARM_LIMIT);
            Some(evidence.materialize(source, limit)?)
        }
    };
    let (items, warnings, concurrency) =
        materialize_swarm_items(&params, &source, materialized_from.as_deref())?;

    let preset_role = preset_role(params.preset.as_deref());
    let explicit_role = input
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| input.get("agent_type").and_then(Value::as_str))
        .or_else(|| input.get("role").and_then(Value::as_str))
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .and_then(FleetRole::parse)
        .unwrap_or(preset_role);

    // The base spawn input every item inherits. Only `prompt` differs per
    // item; `name` is omitted so each child gets its own unique id.
    let mut base_input = json!({
        "action": "start",
        "prompt": "",
    });
    for key in [
        "type",
        "agent_type",
        "profile",
        "model",
        "model_strength",
        "thinking",
        "allowed_tools",
        "write_authority",
        "write_roots",
        "exact_files",
        "coordination_contracts",
        "worktree",
        "cwd",
        "deliverables",
        "expected_artifact",
        "disallowed_tools",
    ] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            base_input[key] = value.clone();
        }
    }
    if !base_input.get("type").and_then(Value::as_str).is_some() {
        base_input["type"] = json!(explicit_role.as_str());
    }

    let semaphore = Arc::new(Semaphore::new(
        usize::try_from(concurrency).unwrap_or(MAX_SWARM_CONCURRENCY as usize),
    ));
    let mut child_runs: Vec<SwarmChildRun> = Vec::with_capacity(items.len());
    let mut spawned_agent_ids: Vec<String> = Vec::new();
    let mut spawn_errors: Vec<SwarmChildRun> = Vec::new();

    for item in &items {
        // Foreground and background both spawn every item now; the semaphore
        // bounds *executing* children per-run (queued items wait for permits
        // under the manager's existing launch gate, which remains the
        // authority for global pool admission).
        let _permit =
            semaphore.clone().acquire_owned().await.map_err(|_| {
                ToolError::execution_failed("the swarm concurrency limiter is closed")
            })?;
        let mut spawn_input = base_input.clone();
        spawn_input["prompt"] = json!(item.prompt);
        if let Some(description) = params.description.as_deref() {
            spawn_input["expected_artifact"] = json!(format!(
                "{description} — item {}/{}",
                item.index,
                items.len()
            ));
        }
        if params.background {
            spawn_input["detached"] = json!(true);
        }
        let mut spawn_runtime = runtime.clone();
        spawn_runtime.context.execution.child_activation =
            context.execution.child_activation.clone();
        match spawn_subagent_from_input(
            spawn_input,
            Arc::clone(&manager),
            spawn_runtime,
            false,
            None,
            None,
            None,
        )
        .await
        {
            Ok((snapshot, _metadata)) => {
                spawned_agent_ids.push(snapshot.agent_id.clone());
                child_runs.push(SwarmChildRun {
                    index: item.index,
                    title: item.title.clone(),
                    status: if params.background {
                        "queued"
                    } else {
                        "running"
                    },
                    agent_id: Some(snapshot.agent_id),
                    error: None,
                });
            }
            Err(error) => {
                spawn_errors.push(SwarmChildRun {
                    index: item.index,
                    title: item.title.clone(),
                    status: "error",
                    agent_id: None,
                    error: Some(error.to_string()),
                });
            }
        }
    }
    child_runs.extend(spawn_errors);
    child_runs.sort_by_key(|run| run.index);

    let warning_rows: Vec<Value> = warnings
        .iter()
        .map(|warning| {
            json!({
                "file": warning.file,
                "item_indexes": warning.item_indexes,
                "message": warning.message,
            })
        })
        .collect();

    if params.background {
        return Ok(json!({
            "action": "swarm",
            "background": true,
            "swarm_concurrency": concurrency,
            "child_runs": child_runs.iter().map(SwarmChildRun::json).collect::<Vec<_>>(),
            "child_agent_ids": spawned_agent_ids,
            "scope_warnings": warning_rows,
            "note": SWARM_BACKGROUND_NOTE,
            "next": "Completions arrive automatically; continue other work or end your turn.",
        }));
    }

    // Foreground: wait for every spawned child to settle, then aggregate.
    let settled =
        wait_for_swarm_children(&manager, &context.state_namespace, &spawned_agent_ids).await;
    let mut results = Vec::with_capacity(child_runs.len());
    let mut successes = 0_u64;
    let mut failures = 0_u64;
    for run in &child_runs {
        let Some(agent_id) = run.agent_id.as_deref() else {
            failures += 1;
            let notification = swarm_worker_result_text(
                run.index,
                &run.title,
                None,
                "error",
                &SwarmSummary::default(),
                run.error.as_deref(),
            );
            results.push(json!({
                "index": run.index,
                "title": run.title,
                "status": "failure",
                "output": notification,
                "error": run.error.as_deref().map(|error| clamp_chars(error, 500)),
            }));
            continue;
        };
        let snapshot = settled
            .iter()
            .find(|snapshot: &&super::SubAgentResult| snapshot.agent_id == agent_id);
        let Some(snapshot) = snapshot else {
            failures += 1;
            results.push(json!({
                "index": run.index,
                "title": run.title,
                "status": "failure",
                "output": swarm_worker_result_text(
                    run.index, &run.title, Some(agent_id), "error",
                    &SwarmSummary::default(),
                    Some("worker left the ledger before settling"),
                ),
            }));
            continue;
        };
        let completed = matches!(snapshot.status, super::SubAgentStatus::Completed);
        if completed {
            successes += 1;
        } else {
            failures += 1;
        }
        let summary = snapshot
            .result
            .as_deref()
            .map(extract_swarm_summary)
            .unwrap_or_default();
        let state = if completed { "completed" } else { "error" };
        let error = if completed {
            None
        } else {
            Some(
                snapshot
                    .result
                    .clone()
                    .unwrap_or_else(|| format!("{:?}", snapshot.status)),
            )
        };
        results.push(json!({
            "index": run.index,
            "title": run.title,
            "status": if completed { "success" } else { "failure" },
            "agent_id": agent_id,
            "output": swarm_worker_result_text(
                run.index, &run.title, Some(agent_id), state, &summary, error.as_deref(),
            ),
        }));
    }

    Ok(json!({
        "action": "swarm",
        "background": false,
        "swarm_concurrency": concurrency,
        "success": successes,
        "failure": failures,
        "child_runs": child_runs.iter().map(SwarmChildRun::json).collect::<Vec<_>>(),
        "child_agent_ids": spawned_agent_ids,
        "scope_warnings": warning_rows,
        "parent_closeout": SWARM_PARENT_CLOSEOUT,
        "results": results,
        "note": SWARM_FOREGROUND_NOTE,
    }))
}

/// Bounded wait: children were spawned detached from this tool call, so the
/// manager ledger is the join authority. The foreground swarm uses the same
/// settle predicate `agents/wait until=all` uses — `SubAgentStatus::Running`
/// is the only unsettled state; a vanished child counts as settled with no
/// snapshot and the aggregate reports the gap.
async fn wait_for_swarm_children(
    manager: &SharedSubAgentManager,
    _session: &str,
    agent_ids: &[String],
) -> Vec<super::SubAgentResult> {
    const SWARM_WAIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    const SWARM_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
    let deadline = std::time::Instant::now() + SWARM_WAIT_TIMEOUT;
    let mut settled: Vec<super::SubAgentResult> = Vec::new();
    let mut pending: Vec<String> = agent_ids.to_vec();
    while !pending.is_empty() {
        let mut still_pending: Vec<String> = Vec::new();
        {
            let guard = manager.read().await;
            for agent_id in pending.drain(..) {
                match guard.get_result(&agent_id) {
                    Ok(snapshot) if !matches!(snapshot.status, super::SubAgentStatus::Running) => {
                        settled.push(snapshot);
                    }
                    Ok(_) => still_pending.push(agent_id),
                    // A child that vanished (retention sweep) counts as
                    // settled with no snapshot; the aggregate reports the gap.
                    Err(_) => {}
                }
            }
        }
        pending = still_pending;
        if pending.is_empty() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(SWARM_WAIT_INTERVAL).await;
    }
    settled
}
