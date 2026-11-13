//! One-shot Chimera configuration importer (W6A, RFC §13).
//!
//! Reads a Chimera JSON/JSONC configuration (global layer plus an optional
//! project overlay) and an old Codewhale TOML document, and emits the TOML
//! bodies the existing runtime loaders already understand. This is an
//! explicit, one-time migration surface: the production loader never grows a
//! second JSONC path, and after import the runtime only ever reads TOML.
//!
//! Contract (RFC §13.1):
//! - Unknown or unsupported Chimera keys fail loud with the complete list of
//!   offending paths. Nothing is written, and no value is ever echoed — a
//!   Chimera config can carry provider API keys.
//! - Arrays and instructions compute to a final value here (the winning
//!   layer's array replaces the other's wholesale); there is no second merge
//!   language.
//! - Project imports never carry credentials; provider `apiKey` entries are
//!   user-global only.
//! - Output TOML always carries an explicit `schema_version = 1`, which opts
//!   the document into the strict unknown-root-key gate in
//!   `parse_config_toml_str`.
//! - well-known/account remote Chimera sources are never read here; only
//!   file text the caller already holds is imported.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use codewhale_execpolicy::{PermissionAction, ToolAskRule};

use crate::config_store::parse_config_toml_str;
use crate::provider_kind::ProviderKind;

/// Schema version every document this importer writes carries.
pub const IMPORTED_SCHEMA_VERSION: u64 = 1;

/// Maximum input size accepted by the importer (matches the bundle cap).
pub const MAX_IMPORT_INPUT_BYTES: usize = 5 * 1024 * 1024;

/// One import outcome: the new TOML bodies plus what was migrated.
#[derive(Debug, Clone, Default)]
pub struct ImportOutcome {
    /// The new user-global (or project) `config.toml` body.
    pub config_toml: String,
    /// Sibling `permissions.toml` body when the source carried permission
    /// rules that map to `ToolAskRule` entries.
    pub permissions_toml: Option<String>,
    /// Sibling `mcp.json` body when the source carried MCP servers. The
    /// existing MCP parser stays the only MCP reader; this is a translation,
    /// not a second parser.
    pub mcp_json: Option<String>,
}

/// Which document the imported `config.toml` targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportScope {
    /// The user-global config; may carry provider credentials.
    Global,
    /// The workspace project config; never carries credentials and may only
    /// tighten permission posture.
    Project,
}

/// Parse Chimera JSONC: `//` and `/* */` comments plus trailing commas are
/// stripped outside string literals, then the document is parsed. Errors
/// report position only, never content.
pub fn parse_chimera_jsonc(text: &str, source: &str) -> Result<serde_json::Value> {
    if text.len() > MAX_IMPORT_INPUT_BYTES {
        bail!(
            "chimera config at {source} is {} bytes; the limit is {MAX_IMPORT_INPUT_BYTES} bytes",
            text.len()
        );
    }
    let stripped = strip_jsonc(text);
    serde_json::from_str(&stripped)
        .map_err(|err| anyhow::anyhow!("chimera config at {source} is not valid JSON/JSONC: {err}"))
}

/// Strip `//` and `/* */` comments and trailing commas outside string
/// literals. A char-level state machine keeps escapes, quotes, and multibyte
/// text intact.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(escaped) = chars.next() {
                    out.push(escaped);
                }
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push('"');
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut closed = false;
                while let Some(next) = chars.next() {
                    if next == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        closed = true;
                        break;
                    }
                }
                out.push(if closed { ' ' } else { '\n' });
            }
            ',' => {
                // Trailing commas: drop the comma when the next non-space
                // character closes the enclosing object or array.
                let mut lookahead = chars.clone();
                let mut closing = None;
                for peeked in lookahead.by_ref() {
                    if peeked.is_whitespace() {
                        continue;
                    }
                    closing = Some(peeked);
                    break;
                }
                match closing {
                    Some('}') | Some(']') => {}
                    _ => out.push(','),
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Import one Chimera configuration (global) plus an optional project
/// overlay, producing the new TOML bodies. See the module docs for the
/// precedence and tightening rules.
pub fn import_chimera_config(
    global: Option<&str>,
    project: Option<&str>,
    scope: ImportScope,
) -> Result<ImportOutcome> {
    let global_value = match global {
        Some(text) => Some(parse_chimera_jsonc(text, "chimera global config")?),
        None => None,
    };
    let project_value = match project {
        Some(text) => Some(parse_chimera_jsonc(text, "chimera project config")?),
        None => None,
    };
    let object = match merge_layers(global_value, project_value)? {
        Some(serde_json::Value::Object(map)) => map,
        Some(_) => bail!("chimera config must be a JSON object"),
        None => serde_json::Map::new(),
    };
    build_outcome(object, scope)
}

/// Merge the global and project layers with final-value semantics: the
/// project layer wins per key wholesale (scalars, objects, and arrays alike).
/// The runtime has no merge language, so the importer computes the final
/// value here.
fn merge_layers(
    global: Option<serde_json::Value>,
    project: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>> {
    match (global, project) {
        (None, None) => Ok(None),
        (Some(only), None) | (None, Some(only)) => Ok(Some(only)),
        (Some(global), Some(project)) => {
            let global_map = global
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("chimera global config must be a JSON object"))?;
            let project_map = project
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("chimera project config must be a JSON object"))?;
            let mut merged = global_map.clone();
            for (key, value) in project_map {
                merged.insert(key.clone(), value.clone());
            }
            Ok(Some(serde_json::Value::Object(merged)))
        }
    }
}

/// Permission action restrictiveness order for the project "only tighten" rule.
pub fn permission_rank(action: &str) -> Option<u8> {
    match action {
        "allow" => Some(0),
        "ask" => Some(1),
        "deny" => Some(2),
        _ => None,
    }
}

/// Whether a project permission layer only tightens the global layer: the
/// project action must rank at least as restrictive as the global one.
/// `None` on an unrankable action (the caller fails loud on it).
pub fn project_permission_only_tightens(global: Option<&str>, project: &str) -> Option<bool> {
    let global_rank = global.and_then(permission_rank);
    let project_rank = permission_rank(project)?;
    Some(match global_rank {
        Some(global_rank) => project_rank >= global_rank,
        None => true,
    })
}

/// Keys the importer explicitly consumes. Everything else — known-but-
/// unsupported or entirely unknown — is collected and reported together.
const HANDLED_TOP_LEVEL_KEYS: &[&str] = &[
    "$schema",
    "model",
    "provider",
    "delegation",
    "permission",
    "tools",
    "mcp",
    "diagnostics",
    "tool_output",
    "compaction",
    "memories",
    "browser",
    "graph",
];

fn collect_unsupported_paths(prefix: &str, value: &serde_json::Value, paths: &mut Vec<String>) {
    if let Some(object) = value.as_object()
        && !object.is_empty()
    {
        for (key, child) in object {
            collect_unsupported_paths(&format!("{prefix}.{key}"), child, paths);
        }
    } else {
        paths.push(prefix.to_string());
    }
}

fn build_outcome(
    object: serde_json::Map<String, serde_json::Value>,
    scope: ImportScope,
) -> Result<ImportOutcome> {
    let mut unsupported: Vec<String> = Vec::new();
    let mut document = toml_edit::DocumentMut::new();
    document["schema_version"] = toml_edit::value(IMPORTED_SCHEMA_VERSION as i64);
    let mut permission_rules: Vec<ToolAskRule> = Vec::new();
    let mut mcp_servers: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

    for (key, value) in &object {
        if !HANDLED_TOP_LEVEL_KEYS.contains(&key.as_str()) {
            collect_unsupported_paths(key, value, &mut unsupported);
            continue;
        }
        match key.as_str() {
            "$schema" => {}
            "model" => map_model(value, &mut document, &mut unsupported)?,
            "provider" => map_providers(value, scope, &mut document, &mut unsupported)?,
            "delegation" => map_delegation(value, &mut document, &mut unsupported)?,
            "permission" => map_permission(value, &mut permission_rules, &mut unsupported)?,
            "tools" => map_tools(value, &mut permission_rules, &mut unsupported)?,
            "mcp" => map_mcp(value, &mut mcp_servers, &mut unsupported)?,
            "diagnostics" => map_diagnostics(value, &mut document, &mut unsupported)?,
            "tool_output" => map_tool_output(value, &mut document, &mut unsupported)?,
            "compaction" => map_compaction(value, &mut document, &mut unsupported)?,
            "memories" => map_memories(value, &mut document, &mut unsupported)?,
            "browser" => map_browser(value, &mut document, &mut unsupported)?,
            "graph" => map_graph(value, &mut document, &mut unsupported)?,
            _ => unreachable!("handled set is closed"),
        }
    }

    if !unsupported.is_empty() {
        unsupported.sort();
        unsupported.dedup();
        let listed = unsupported.join(", ");
        let message = format!(
            "chimera import refused: {} unknown or unsupported key(s): {listed}. \
             Remove or migrate them, then re-run the import. Nothing was written.",
            unsupported.len()
        );
        bail!("{}", codewhale_secrets::redact::redact_secrets(&message));
    }

    let mut outcome = ImportOutcome {
        config_toml: document.to_string(),
        ..Default::default()
    };
    if !permission_rules.is_empty() {
        outcome.permissions_toml = Some(render_permissions(&permission_rules));
    }
    if !mcp_servers.is_empty() {
        outcome.mcp_json = Some(render_mcp_json(&mcp_servers));
    }
    Ok(outcome)
}

/// `model = "provider/model"` → root `provider` plus the provider table's
/// `model` key, mirroring the Chimera source's selection precedence.
fn map_model(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(model) = value.as_str() else {
        unsupported.push("model".to_string());
        return Ok(());
    };
    let Some((provider_id, model_id)) = model.split_once('/') else {
        bail!("chimera import: model must be a provider/model pair; the value was omitted");
    };
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        bail!("chimera import: model must be a non-empty provider/model pair");
    }
    document["provider"] = toml_edit::value(provider_id);
    let table = provider_table_mut(document, provider_id);
    table["model"] = toml_edit::value(model_id);
    Ok(())
}

/// Chimera `provider` map → `[providers.<id>]` tables. Credentials are only
/// ever written to the user-global document; a project import names the
/// offending path and refuses.
fn map_providers(
    value: &serde_json::Value,
    scope: ImportScope,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(providers) = value.as_object() else {
        unsupported.push("provider".to_string());
        return Ok(());
    };
    for (provider_id, entry) in providers {
        let Some(entry) = entry.as_object() else {
            unsupported.push(format!("provider.{provider_id}"));
            continue;
        };
        let table = provider_table_mut(document, provider_id);
        for (field, field_value) in entry {
            match field.as_str() {
                "options" => {
                    let Some(options) = field_value.as_object() else {
                        unsupported.push(format!("provider.{provider_id}.options"));
                        continue;
                    };
                    for (option_key, option_value) in options {
                        match option_key.as_str() {
                            "baseURL" => {
                                let Some(base_url) = option_value.as_str() else {
                                    unsupported
                                        .push(format!("provider.{provider_id}.options.baseURL"));
                                    continue;
                                };
                                table["base_url"] = toml_edit::value(base_url);
                            }
                            "apiKey" => {
                                if scope == ImportScope::Project {
                                    bail!(
                                        "chimera import: provider.{provider_id}.options.apiKey \
                                         is a credential and cannot be imported into a project \
                                         config; import it into the user-global document"
                                    );
                                }
                                let Some(api_key) = option_value.as_str() else {
                                    unsupported
                                        .push(format!("provider.{provider_id}.options.apiKey"));
                                    continue;
                                };
                                table["api_key"] = toml_edit::value(api_key);
                            }
                            other => {
                                unsupported.push(format!("provider.{provider_id}.options.{other}"))
                            }
                        }
                    }
                }
                "models" => {
                    let Some(models) = field_value.as_object() else {
                        unsupported.push(format!("provider.{provider_id}.models"));
                        continue;
                    };
                    // Per-model capability declarations have no runtime
                    // consumer yet; every entry is reported, never inherited.
                    for model_id in models.keys() {
                        unsupported.push(format!("provider.{provider_id}.models.{model_id}"));
                    }
                }
                "wire_api" => {
                    let Some(wire) = field_value.as_str() else {
                        unsupported.push(format!("provider.{provider_id}.wire_api"));
                        continue;
                    };
                    match wire {
                        "chat" => {
                            table["wire"] = toml_edit::value("openai");
                        }
                        "responses" => {
                            table["wire"] = toml_edit::value("responses");
                        }
                        other => {
                            unsupported.push(format!("provider.{provider_id}.wire_api.{other}"))
                        }
                    }
                }
                other => {
                    unsupported.push(format!("provider.{provider_id}.{other}"));
                }
            }
        }
    }
    Ok(())
}

/// `delegation.*` → `[subagents]` (the RFC's swarm/subagents landing spot).
fn map_delegation(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(delegation) = value.as_object() else {
        unsupported.push("delegation".to_string());
        return Ok(());
    };
    for (key, entry) in delegation {
        match key.as_str() {
            "max_depth" => {
                let Some(depth) = positive_u64(entry) else {
                    unsupported.push("delegation.max_depth".to_string());
                    continue;
                };
                subagents_table(document)["max_depth"] = toml_edit::value(depth as i64);
            }
            "max_concurrent" => {
                let Some(max) = positive_u64(entry) else {
                    unsupported.push("delegation.max_concurrent".to_string());
                    continue;
                };
                subagents_table(document)["max_concurrent"] = toml_edit::value(max as i64);
            }
            "background_concurrent" => {
                let Some(max) = positive_u64(entry) else {
                    unsupported.push("delegation.background_concurrent".to_string());
                    continue;
                };
                subagents_table(document)["launch_concurrency"] = toml_edit::value(max as i64);
            }
            other => unsupported.push(format!("delegation.{other}")),
        }
    }
    Ok(())
}

/// Chimera `permission` (action string or per-tool map) → typed
/// `permissions.toml` rules.
fn map_permission(
    value: &serde_json::Value,
    rules: &mut Vec<ToolAskRule>,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    for (tool, action) in normalize_permission_object(value) {
        let Some(action) = action.as_str().and_then(permission_rank) else {
            unsupported.push(format!("permission.{tool}"));
            continue;
        };
        rules.push(ToolAskRule {
            tool: tool.clone(),
            command: None,
            command_exact: false,
            path: None,
            workspace: None,
            action: permission_action_for_rank(action),
        });
    }
    Ok(())
}

/// Legacy Chimera `tools` booleans: `true` → allow, `false` → deny (the
/// importer-only boolean translation the RFC prescribes).
fn map_tools(
    value: &serde_json::Value,
    rules: &mut Vec<ToolAskRule>,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(tools) = value.as_object() else {
        unsupported.push("tools".to_string());
        return Ok(());
    };
    for (tool, enabled) in tools {
        let Some(enabled) = enabled.as_bool() else {
            unsupported.push(format!("tools.{tool}"));
            continue;
        };
        rules.push(ToolAskRule {
            tool: tool.clone(),
            command: None,
            command_exact: false,
            path: None,
            workspace: None,
            action: if enabled {
                PermissionAction::Allow
            } else {
                PermissionAction::Deny
            },
        });
    }
    Ok(())
}

/// Chimera `mcp` entries → the existing `mcp.json` shape. local → command,
/// remote → url; unmapped per-server options are reported.
fn map_mcp(
    value: &serde_json::Value,
    servers: &mut serde_json::Map<String, serde_json::Value>,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(entries) = value.as_object() else {
        unsupported.push("mcp".to_string());
        return Ok(());
    };
    for (name, entry) in entries {
        // The legacy `{ "<name>": { "enabled": false } }` disable form.
        if let Some(enabled) = entry.get("enabled")
            && entry.as_object().is_some_and(|map| map.len() == 1)
            && let Some(enabled) = enabled.as_bool()
        {
            let mut server = serde_json::Map::new();
            server.insert("enabled".into(), enabled.into());
            servers.insert(name.clone(), serde_json::Value::Object(server));
            continue;
        }
        let Some(entry) = entry.as_object() else {
            unsupported.push(format!("mcp.{name}"));
            continue;
        };
        let mut server = serde_json::Map::new();
        for (field, field_value) in entry {
            match field.as_str() {
                "type" => {}
                "command" => {
                    let Some(command) = field_value
                        .as_array()
                        .and_then(|parts| parts.first().and_then(serde_json::Value::as_str))
                    else {
                        unsupported.push(format!("mcp.{name}.command"));
                        continue;
                    };
                    server.insert("command".into(), command.into());
                    if let Some(args) = field_value.as_array() {
                        let args: Vec<&str> = args
                            .iter()
                            .skip(1)
                            .filter_map(serde_json::Value::as_str)
                            .collect();
                        server.insert("args".into(), serde_json::Value::from(args));
                    }
                }
                "url" => {
                    let Some(url) = field_value.as_str() else {
                        unsupported.push(format!("mcp.{name}.url"));
                        continue;
                    };
                    server.insert("url".into(), url.into());
                }
                "enabled" => {
                    let Some(enabled) = field_value.as_bool() else {
                        unsupported.push(format!("mcp.{name}.enabled"));
                        continue;
                    };
                    server.insert("enabled".into(), enabled.into());
                }
                "disabled" => {
                    let Some(disabled) = field_value.as_bool() else {
                        unsupported.push(format!("mcp.{name}.disabled"));
                        continue;
                    };
                    server.insert("disabled".into(), disabled.into());
                }
                "environment" => {
                    let Some(environment) = field_value.as_object() else {
                        unsupported.push(format!("mcp.{name}.environment"));
                        continue;
                    };
                    let mut env = serde_json::Map::new();
                    for (env_key, env_value) in environment {
                        if let Some(text) = env_value.as_str() {
                            env.insert(env_key.clone(), text.into());
                        } else {
                            unsupported.push(format!("mcp.{name}.environment.{env_key}"));
                        }
                    }
                    server.insert("env".into(), serde_json::Value::Object(env));
                }
                "cwd" => {
                    let Some(cwd) = field_value.as_str() else {
                        unsupported.push(format!("mcp.{name}.cwd"));
                        continue;
                    };
                    server.insert("cwd".into(), cwd.into());
                }
                "headers" => {
                    let Some(headers) = field_value.as_object() else {
                        unsupported.push(format!("mcp.{name}.headers"));
                        continue;
                    };
                    server.insert("headers".into(), serde_json::Value::Object(headers.clone()));
                }
                "timeout" => {
                    // Chimera timeouts are milliseconds (or a startup/
                    // catalog/execution struct); the existing schema takes
                    // per-server second fields, so map a plain number only.
                    if let Some(timeout) = field_value.as_u64() {
                        server.insert("execute_timeout".into(), (timeout / 1000).into());
                    } else {
                        unsupported.push(format!("mcp.{name}.timeout"));
                    }
                }
                other => unsupported.push(format!("mcp.{name}.{other}")),
            }
        }
        servers.insert(name.clone(), serde_json::Value::Object(server));
    }
    Ok(())
}

fn map_diagnostics(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(diagnostics) = value.as_object() else {
        unsupported.push("diagnostics".to_string());
        return Ok(());
    };
    for (key, entry) in diagnostics {
        match key.as_str() {
            "inlineBudgetMs" => {
                let Some(budget) = positive_u64(entry) else {
                    unsupported.push("diagnostics.inlineBudgetMs".to_string());
                    continue;
                };
                lsp_table(document)["poll_after_edit_ms"] = toml_edit::value(budget as i64);
            }
            other => unsupported.push(format!("diagnostics.{other}")),
        }
    }
    Ok(())
}

fn map_tool_output(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(tool_output) = value.as_object() else {
        unsupported.push("tool_output".to_string());
        return Ok(());
    };
    for (key, entry) in tool_output {
        match key.as_str() {
            "max_bytes" => {
                let Some(max) = positive_u64(entry) else {
                    unsupported.push("tool_output.max_bytes".to_string());
                    continue;
                };
                workshop_table(document)["tool_result_max_bytes"] = toml_edit::value(max as i64);
            }
            other => unsupported.push(format!("tool_output.{other}")),
        }
    }
    Ok(())
}

fn map_compaction(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(compaction) = value.as_object() else {
        unsupported.push("compaction".to_string());
        return Ok(());
    };
    for (key, entry) in compaction {
        match key.as_str() {
            "preserve_recent_tokens" => {
                let Some(tokens) = entry.as_u64() else {
                    unsupported.push("compaction.preserve_recent_tokens".to_string());
                    continue;
                };
                compaction_table(document)["retained_user_message_tokens"] =
                    toml_edit::value(tokens as i64);
            }
            other => unsupported.push(format!("compaction.{other}")),
        }
    }
    Ok(())
}

fn map_memories(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(memories) = value.as_object() else {
        unsupported.push("memories".to_string());
        return Ok(());
    };
    for (key, entry) in memories {
        match key.as_str() {
            "enabled" => {
                let Some(enabled) = entry.as_bool() else {
                    unsupported.push("memories.enabled".to_string());
                    continue;
                };
                memory_table(document)["enabled"] = toml_edit::value(enabled);
            }
            other => unsupported.push(format!("memories.{other}")),
        }
    }
    Ok(())
}

/// Chimera `browser.headless` → `[browser]` — the W5 landing table.
fn map_browser(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(browser) = value.as_object() else {
        unsupported.push("browser".to_string());
        return Ok(());
    };
    for (key, entry) in browser {
        match key.as_str() {
            "headless" => {
                let Some(headless) = entry.as_bool() else {
                    unsupported.push("browser.headless".to_string());
                    continue;
                };
                browser_table(document)["headless"] = toml_edit::value(headless);
            }
            other => unsupported.push(format!("browser.{other}")),
        }
    }
    Ok(())
}

/// `codegraph.json`-shaped `includeIgnored` → `[graph] include_ignored`
/// (the W4 landing table; patterns copy verbatim).
fn map_graph(
    value: &serde_json::Value,
    document: &mut toml_edit::DocumentMut,
    unsupported: &mut Vec<String>,
) -> Result<()> {
    let Some(graph) = value.as_object() else {
        unsupported.push("graph".to_string());
        return Ok(());
    };
    for (key, entry) in graph {
        match key.as_str() {
            "includeIgnored" => {
                let Some(patterns) = entry.as_array() else {
                    unsupported.push("graph.includeIgnored".to_string());
                    continue;
                };
                let mut items = toml_edit::Array::new();
                for pattern in patterns {
                    let Some(pattern) = pattern.as_str() else {
                        unsupported.push("graph.includeIgnored[]".to_string());
                        continue;
                    };
                    items.push(pattern);
                }
                graph_table(document)["include_ignored"] = toml_edit::Value::Array(items).into();
            }
            other => unsupported.push(format!("graph.{other}")),
        }
    }
    Ok(())
}

/// Import an old Codewhale TOML document: validate it through the existing
/// parser, then stamp the explicit `schema_version = 1`. The body is returned
/// verbatim otherwise — this is a one-time stamp, not a rewrite.
pub fn import_codewhale_toml(contents: &str) -> Result<String> {
    // Validate first: a body the current loader cannot read must not gain a
    // version stamp that claims it is the new schema.
    parse_config_toml_str(contents).map_err(|err| {
        anyhow::anyhow!(
            "codewhale config cannot be imported: invalid TOML at {}; \
             file contents were omitted",
            crate::config_store::config_toml_error_location(contents, &err)
        )
    })?;
    let mut document: toml_edit::DocumentMut = contents
        .parse()
        .map_err(|_| anyhow::anyhow!("codewhale config cannot be imported: unparseable TOML"))?;
    document["schema_version"] = toml_edit::value(IMPORTED_SCHEMA_VERSION as i64);
    Ok(document.to_string())
}

// ── helpers ────────────────────────────────────────────────────────────────

fn provider_table_mut<'a>(
    document: &'a mut toml_edit::DocumentMut,
    provider_id: &str,
) -> &'a mut toml_edit::Table {
    let provider_id = ProviderKind::parse_config_identity(provider_id)
        .map(|kind| kind.as_str().to_string())
        .unwrap_or_else(|| provider_id.to_string());
    named_table(document, "providers")
        .entry(&provider_id)
        .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .expect("provider entry was inserted as a table")
}

fn subagents_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "subagents")
}

fn lsp_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "lsp")
}

fn workshop_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "workshop")
}

fn compaction_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "compaction")
}

fn memory_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "memory")
}

fn browser_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "browser")
}

fn graph_table(document: &mut toml_edit::DocumentMut) -> &mut toml_edit::Table {
    named_table(document, "graph")
}

fn named_table<'a>(
    document: &'a mut toml_edit::DocumentMut,
    name: &str,
) -> &'a mut toml_edit::Table {
    document
        .entry(name)
        .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()))
        .as_table_mut()
        .expect("table entry was inserted as a table")
}

fn positive_u64(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().filter(|number| *number > 0)
}

fn permission_action_for_rank(rank: u8) -> PermissionAction {
    match rank {
        2 => PermissionAction::Deny,
        1 => PermissionAction::Ask,
        _ => PermissionAction::Allow,
    }
}

fn normalize_permission_object(value: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
    match value {
        // The Chimera action shorthand is `"*": action`.
        serde_json::Value::String(action) => {
            let mut map = BTreeMap::new();
            map.insert("*".to_string(), serde_json::Value::String(action.clone()));
            map
        }
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// Render typed `permissions.toml` from the mapped rules.
/// Render typed `permissions.toml` from the mapped rules, reusing the
/// project's own rule renderer so importer output and the approval card's
/// writes stay byte-identical.
fn render_permissions(rules: &[ToolAskRule]) -> String {
    let mut document = toml_edit::DocumentMut::new();
    let mut array = toml_edit::ArrayOfTables::new();
    for rule in rules {
        array.push(crate::permissions::permission_rule_table(rule));
    }
    document.insert("rules", toml_edit::Item::ArrayOfTables(array));
    document.to_string()
}

fn render_mcp_json(servers: &serde_json::Map<String, serde_json::Value>) -> String {
    let mut root = serde_json::Map::new();
    root.insert(
        "servers".to_string(),
        serde_json::Value::Object(servers.clone()),
    );
    serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .expect("MCP server map is serializable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome_for(text: &str) -> ImportOutcome {
        import_chimera_config(Some(text), None, ImportScope::Global).expect("import succeeds")
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_parse() {
        let text = r#"{
            // provider selection
            "model": "deepseek/deepseek-v4-pro", /* inline note */
            "delegation": {
                "max_depth": 2,
                "max_concurrent": 8,
            },
        }"#;
        let value = parse_chimera_jsonc(text, "test.jsonc").expect("JSONC parses");
        assert_eq!(value["model"], "deepseek/deepseek-v4-pro");
        assert_eq!(value["delegation"]["max_depth"], 2);
    }

    #[test]
    fn jsonc_keeps_multibyte_text_intact() {
        let text = r#"{
            // 注释
            "memories": { "enabled": true },
            "username": "用户",
        }"#;
        let value = parse_chimera_jsonc(text, "test.jsonc").expect("JSONC parses");
        assert_eq!(value["username"], "用户");
        let outcome = outcome_for(r#"{"memories": { "enabled": true }}"#);
        assert!(outcome.config_toml.contains("schema_version = 1"));
        assert!(outcome.config_toml.contains("[memory]"));
        assert!(outcome.config_toml.contains("enabled = true"));
    }

    #[test]
    fn unknown_keys_fail_loud_with_full_paths() {
        let text = r#"{
            "agent": { "build": { "temperature": 0.2 } },
            "share": "auto",
            "provider": { "deepseek": { "backend_semantics": "codex" } },
        }"#;
        let err = import_chimera_config(Some(text), None, ImportScope::Global)
            .expect_err("unknown keys must fail");
        let message = format!("{err:#}");
        assert!(message.contains("agent.build.temperature"), "{message}");
        assert!(message.contains("share"), "{message}");
        assert!(
            message.contains("provider.deepseek.backend_semantics"),
            "{message}"
        );
        assert!(
            message.contains("3 unknown or unsupported key(s)"),
            "{message}"
        );
        assert!(message.contains("Nothing was written"), "{message}");
    }

    #[test]
    fn secret_values_are_never_echoed_in_errors() {
        let text = r#"{
            "provider": { "deepseek": { "options": { "apiKey": "sk-super-secret-value" } } },
            "mystery_key": "sk-another-secret",
        }"#;
        let err = import_chimera_config(Some(text), None, ImportScope::Global)
            .expect_err("unknown key must fail");
        let message = format!("{err:#}");
        assert!(!message.contains("sk-super-secret-value"), "{message}");
        assert!(!message.contains("sk-another-secret"), "{message}");
        assert!(message.contains("mystery_key"), "{message}");
    }

    #[test]
    fn delegation_maps_to_subagents() {
        let outcome = outcome_for(
            r#"{
                "delegation": {
                    "max_depth": 4,
                    "max_concurrent": 32,
                    "background_concurrent": 8
                }
            }"#,
        );
        assert!(outcome.config_toml.contains("[subagents]"));
        assert!(outcome.config_toml.contains("max_depth = 4"));
        assert!(outcome.config_toml.contains("max_concurrent = 32"));
        assert!(outcome.config_toml.contains("launch_concurrency = 8"));
    }

    #[test]
    fn model_selection_maps_to_provider_and_model() {
        let outcome = outcome_for(r#"{"model": "openai/gpt-4.1"}"#);
        assert!(outcome.config_toml.contains("provider = \"openai\""));
        assert!(outcome.config_toml.contains("model = \"gpt-4.1\""));
    }

    #[test]
    fn provider_options_map_and_wire_translates() {
        let outcome = outcome_for(
            r#"{
                "model": "deepseek/deepseek-v4-pro",
                "provider": { "deepseek": { "wire_api": "responses" } }
            }"#,
        );
        assert!(outcome.config_toml.contains("[providers.deepseek]"));
        assert!(outcome.config_toml.contains("wire = \"responses\""));
    }

    #[test]
    fn model_without_provider_component_is_refused_without_echoing_it() {
        let err = import_chimera_config(
            Some(r#"{"model": "sk-not-a-route"}"#),
            None,
            ImportScope::Global,
        )
        .expect_err("model must be provider/model");
        let message = format!("{err:#}");
        assert!(message.contains("provider/model"), "{message}");
        assert!(!message.contains("sk-not-a-route"), "{message}");
    }

    #[test]
    fn project_import_refuses_credentials() {
        let err = import_chimera_config(
            Some(r#"{"provider": { "deepseek": { "options": { "apiKey": "sk-x" } } }}"#),
            None,
            ImportScope::Project,
        )
        .expect_err("credentials cannot land in a project config");
        assert!(
            format!("{err:#}").contains("cannot be imported into a project config"),
            "{err:#}"
        );
    }

    #[test]
    fn tools_and_permission_map_to_typed_rules() {
        let outcome = outcome_for(
            r#"{
                "tools": { "write": false, "read": true },
                "permission": { "bash": "ask", "websearch": "deny" }
            }"#,
        );
        let permissions = outcome.permissions_toml.expect("rules were mapped");
        let parsed: crate::PermissionsToml =
            toml::from_str(&permissions).expect("permissions parse");
        let by_tool: BTreeMap<&str, &PermissionAction> = parsed
            .rules
            .iter()
            .map(|rule| (rule.tool.as_str(), &rule.action))
            .collect();
        assert_eq!(by_tool["write"], &PermissionAction::Deny);
        assert_eq!(by_tool["read"], &PermissionAction::Allow);
        assert_eq!(by_tool["bash"], &PermissionAction::Ask);
        assert_eq!(by_tool["websearch"], &PermissionAction::Deny);
    }

    #[test]
    fn project_permission_cannot_loosen_global() {
        assert_eq!(
            project_permission_only_tightens(Some("deny"), "allow"),
            Some(false)
        );
        assert_eq!(
            project_permission_only_tightens(Some("allow"), "deny"),
            Some(true)
        );
        assert_eq!(
            project_permission_only_tightens(Some("deny"), "ask"),
            Some(false)
        );
        assert_eq!(project_permission_only_tightens(None, "allow"), Some(true));
        assert_eq!(
            project_permission_only_tightens(Some("allow"), "bogus"),
            None
        );
    }

    #[test]
    fn project_layer_wins_and_arrays_are_final_values() {
        // Arrays compute to the winning layer's value: the project array
        // replaces the global array wholesale; with no project entry the
        // global value stands.
        let outcome = import_chimera_config(
            Some(r#"{"graph": { "includeIgnored": ["vendor/", "target/"] }}"#),
            Some(r#"{"graph": { "includeIgnored": ["dist/"] }}"#),
            ImportScope::Project,
        )
        .expect("import succeeds");
        assert!(outcome.config_toml.contains("dist/"));
        assert!(!outcome.config_toml.contains("vendor/"));
        assert!(!outcome.config_toml.contains("target/"));

        let global_only = import_chimera_config(
            Some(r#"{"graph": { "includeIgnored": ["vendor/"] }}"#),
            None,
            ImportScope::Project,
        )
        .expect("import succeeds");
        assert!(global_only.config_toml.contains("vendor/"));
    }

    #[test]
    fn mcp_maps_to_the_existing_mcp_json_shape() {
        let outcome = outcome_for(
            r#"{
                "mcp": {
                    "context7": {
                        "type": "local",
                        "command": ["npx", "-y", "@context7/mcp"],
                        "environment": { "API_TOKEN": "x" }
                    },
                    "remote-one": {
                        "type": "remote",
                        "url": "https://example.test/mcp"
                    },
                    "off": { "enabled": false }
                }
            }"#,
        );
        let mcp = outcome.mcp_json.expect("mcp was mapped");
        let value: serde_json::Value = serde_json::from_str(&mcp).expect("mcp.json parses");
        assert_eq!(value["servers"]["context7"]["command"], "npx");
        assert_eq!(value["servers"]["context7"]["args"][0], "-y");
        assert_eq!(value["servers"]["context7"]["args"][1], "@context7/mcp");
        assert_eq!(value["servers"]["context7"]["env"]["API_TOKEN"], "x");
        assert_eq!(
            value["servers"]["remote-one"]["url"],
            "https://example.test/mcp"
        );
        assert_eq!(value["servers"]["off"]["enabled"], false);
    }

    #[test]
    fn diagnostics_tool_output_compaction_memory_map_to_existing_tables() {
        let outcome = outcome_for(
            r#"{
                "diagnostics": { "inlineBudgetMs": 900 },
                "tool_output": { "max_bytes": 65536 },
                "compaction": { "preserve_recent_tokens": 4096 },
                "memories": { "enabled": true }
            }"#,
        );
        assert!(outcome.config_toml.contains("[lsp]"));
        assert!(outcome.config_toml.contains("poll_after_edit_ms = 900"));
        assert!(outcome.config_toml.contains("[workshop]"));
        assert!(
            outcome
                .config_toml
                .contains("tool_result_max_bytes = 65536")
        );
        assert!(outcome.config_toml.contains("[compaction]"));
        assert!(
            outcome
                .config_toml
                .contains("retained_user_message_tokens = 4096")
        );
        assert!(outcome.config_toml.contains("[memory]"));
        assert!(outcome.config_toml.contains("enabled = true"));
    }

    #[test]
    fn browser_and_graph_map_to_forward_tables() {
        let outcome = outcome_for(
            r#"{
                "browser": { "headless": false },
                "graph": { "includeIgnored": ["vendored/"] }
            }"#,
        );
        assert!(outcome.config_toml.contains("[browser]"));
        assert!(outcome.config_toml.contains("headless = false"));
        assert!(outcome.config_toml.contains("[graph]"));
        assert!(outcome.config_toml.contains("include_ignored"));
        assert!(outcome.config_toml.contains("\"vendored/\""));
    }

    #[test]
    fn imported_toml_parses_through_the_existing_loader() {
        let outcome = outcome_for(
            r#"{
                "model": "deepseek/deepseek-v4-pro",
                "delegation": { "max_depth": 2 },
                "memories": { "enabled": true }
            }"#,
        );
        let parsed = crate::parse_config_toml(&outcome.config_toml)
            .expect("imported TOML parses through the existing parser");
        assert_eq!(parsed.provider, ProviderKind::Deepseek);
        assert_eq!(
            parsed.providers.deepseek.model.as_deref(),
            Some("deepseek-v4-pro")
        );
        assert_eq!(parsed.schema_version, Some(IMPORTED_SCHEMA_VERSION));
    }

    #[test]
    fn codewhale_toml_import_stamps_schema_version_and_keeps_comments() {
        let stamped = import_codewhale_toml(
            "# my route\nprovider = \"deepseek\"\n\n[providers.deepseek]\nmodel = \"deepseek-v4-pro\"\n",
        )
        .expect("legacy TOML imports");
        assert!(stamped.contains("# my route"), "{stamped}");
        assert!(stamped.contains("schema_version = 1"), "{stamped}");
        let parsed = crate::parse_config_toml(&stamped).expect("stamped TOML still parses");
        assert_eq!(parsed.provider, ProviderKind::Deepseek);
    }

    #[test]
    fn codewhale_toml_import_refuses_unparseable_input() {
        let err = import_codewhale_toml("provider = ").expect_err("bad TOML refused");
        assert!(format!("{err:#}").contains("cannot be imported"), "{err:#}");
    }

    #[test]
    fn oversized_input_is_refused() {
        let big = format!("{{\"x\": \"{}\"}}", "a".repeat(MAX_IMPORT_INPUT_BYTES));
        let err = parse_chimera_jsonc(&big, "big.json").expect_err("size cap");
        assert!(
            format!("{err:#}").contains("bytes; the limit is"),
            "{err:#}"
        );
    }

    // ── strict-gate and reload/CAS behavior (RFC §13.1, §13.3) ───────────

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
        let err =
            crate::parse_config_toml("schema_version = 2\n").expect_err("future version fails");
        let message = err.message().to_string();
        assert!(message.contains("newer than this build"), "{message}");
    }

    #[test]
    fn unversioned_documents_keep_the_tolerant_extras_path() {
        // Historic files have no `schema_version`; their unknown keys land in
        // `extras` so `config doctor` can still report them without failing
        // the load. This is the compatibility floor the strict gate adds on.
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
    fn cas_conflict_and_failed_reload_keep_the_old_config() {
        // The fd-lock + CAS write is `replace_config_document_if_unchanged`;
        // reload is `ConfigStore::reload`, which re-runs the strict gate. A
        // reload whose new document fails the gate keeps the old one, and a
        // concurrent change keeps a save from overwriting it.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "provider = \"deepseek\"\n").expect("seed config");

        let mut store = crate::ConfigStore::load(Some(path.clone())).expect("initial load");
        assert_eq!(store.config.provider, ProviderKind::Deepseek);

        // CAS: a concurrent writer changed the file after our load.
        std::fs::write(&path, "provider = \"moonshot\"\n").expect("concurrent change");
        let save_err = store.save().expect_err("CAS conflict must fail");
        assert!(
            format!("{save_err:#}").contains("changed after it was loaded"),
            "{save_err:#}"
        );

        // Reload after the concurrent change succeeds and picks it up.
        store.reload().expect("reload after conflict succeeds");
        assert_eq!(store.config.provider, ProviderKind::Moonshot);

        // A reload whose document fails the strict gate is refused; the
        // store keeps the previously loaded configuration.
        std::fs::write(&path, "schema_version = 1\nbogus_key = 1\n").expect("strict failure");
        let reload_err = store
            .reload()
            .expect_err("strict gate must fail the reload");
        assert!(
            format!("{reload_err:#}").contains("failed to parse config"),
            "{reload_err:#}"
        );
        assert_eq!(store.config.provider, ProviderKind::Moonshot);
        assert_eq!(
            store.config.schema_version, None,
            "the refused reload leaves the old in-memory config untouched"
        );
    }
}
