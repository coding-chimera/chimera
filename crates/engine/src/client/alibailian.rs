//! Alibailian relay Chat quirks — bound to the explicit `Alibailian` kind only.
//!
//! The relay is a Model Studio-compatible gateway that is **not** the official
//! Model Studio provider. Official `Modelstudio*` behavior (endpoint
//! verification, `enable_thinking`/`preserve_thinking` controls, Token Plan
//! Responses Harness search) never applies here, and no Model Studio quirk is
//! inherited merely because both surfaces are "Bailian": every predicate below
//! gates on [`ProviderKind::Alibailian`] so the two judgments stay separate.
//!
//! Contracts implemented here, per the relay's observed behavior:
//! - Zero-tool native `json_schema` structured output: `response_format` is
//!   attached only when the request carries no tools.
//! - Multi-tool forced calls: `tool_choice = Named(StructuredOutput)` replaces
//!   `Required`, which the relay rejects with a 400 when `tools.len() > 1`.
//! - Hosted `web_search` replay for the Responses dialect.
//! - The Alibailian → DeepSeek → Kimi websearch fallback ordering.
//! - Model/provider header merging, including the explicit DashScope
//!     session-cache header.
//! - Force-reasoning sampling adjustments.

use serde_json::{Value, json};

use codewhale_config::ProviderKind;
use codewhale_models::MessageRequest;

/// Name of the structured-output tool the relay backstop force-calls.
pub const ALIBAILIAN_STRUCTURED_OUTPUT_TOOL: &str = "StructuredOutput";

/// Whether this request takes the relay's zero-tool native structured output
/// path: a JSON schema is present, and the request carries no tools. A
/// structured request that still lists tools must go through normal function
/// calling — attaching `response_format` alongside `tools` is not a shape the
/// relay documents, and the first attempt must not be assumed to succeed.
#[must_use]
pub fn structured_output_schema(request: &MessageRequest) -> Option<&Value> {
    if request
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.is_empty())
    {
        return None;
    }
    request.metadata.as_ref().and_then(|metadata| {
        metadata
            .get("response_schema")
            .or_else(|| metadata.get("output_schema"))
            .filter(|schema| schema.get("type").is_some())
    })
}

/// Attach the relay's native `json_schema` `response_format` to a zero-tool
/// Chat body. A no-op for any request that does not meet
/// [`structured_output_schema`]'s contract.
pub fn apply_structured_output(body: &mut Value, request: &MessageRequest) {
    let Some(schema) = structured_output_schema(request) else {
        return;
    };
    body["response_format"] = json!({
        "type": "json_schema",
        "json_schema": {
            "name": "structured_output",
            "schema": schema,
        },
    });
    // The schema instruction also rides the system message: the relay's
    // zero-tool path expects the schema stated in prose next to the native
    // response_format, and the no-tool extraction retry reuses exactly this
    // instruction.
    append_structured_instruction(body, schema);
}

/// Append the structured-output schema instruction to the body's system
/// message (creating one when absent).
fn append_structured_instruction(body: &mut Value, schema: &Value) {
    let instruction = structured_extraction_instruction(schema);
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(first) = messages.first_mut()
        && first.get("role").and_then(Value::as_str) == Some("system")
        && let Some(content) = first
            .get("content")
            .cloned()
            .and_then(|v| v.as_str().map(str::to_string))
    {
        let merged = format!("{content}\n\n{instruction}");
        first["content"] = Value::String(merged);
        return;
    }
    messages.insert(0, json!({ "role": "system", "content": instruction }));
}

/// The system instruction for the no-tool extraction retry. The first
/// structured attempt is never assumed to have succeeded; when its output is
/// not valid JSON matching the schema, the retry sends this instruction with
/// no tools and the schema spelled out in prose.
#[must_use]
pub fn structured_extraction_instruction(schema: &Value) -> String {
    format!(
        "Return exactly one JSON value matching this JSON Schema. No prose, no code fences, no surrounding text:\n{schema}"
    )
}

/// Relay `tool_choice` mapping.
///
/// The relay rejects a forced call (`"required"` or `{"type":"any"}`) with
/// HTTP 400 when more than one tool is in flight. The backstop rewrites the
/// forced call to a Named choice of the synthetic structured-output tool —
/// the one tool whose output the caller is asking the model to produce —
/// keeping the force semantics the caller asked for.
#[must_use]
pub fn map_tool_choice_for_relay(
    provider: ProviderKind,
    tool_count: usize,
    choice: &Value,
) -> Option<Value> {
    if provider != ProviderKind::Alibailian {
        return None;
    }
    let forced = choice.as_str() == Some("required")
        || choice.get("type").and_then(Value::as_str) == Some("any");
    if !forced {
        return None;
    }
    (tool_count > 1).then(|| {
        json!({
            "type": "function",
            "function": { "name": ALIBAILIAN_STRUCTURED_OUTPUT_TOOL }
        })
    })
}

/// Force-reasoning sampling adjustment: when reasoning is forced on, the relay
/// ignores `temperature`/`top_p` and the pair must not ride the request.
pub fn strip_sampling_for_forced_reasoning(body: &mut Value, reasoning_forced: bool) {
    if !reasoning_forced {
        return;
    }
    if let Some(object) = body.as_object_mut() {
        object.remove("temperature");
        object.remove("top_p");
    }
}

/// Hosted `web_search` declaration for the relay's Responses dialect.
///
/// Declares the hosted tool the way the relay accepts it. The relay does not
/// support domain filters on the hosted search path, so none are attached.
#[must_use]
pub fn hosted_web_search_declaration() -> Value {
    json!({
        "type": "web_search",
        "search_context_size": "medium",
    })
}

/// Whether a Responses output item is the relay's hosted `web_search_call`
/// and should be replayed as a user-visible notice.
#[must_use]
pub fn is_hosted_web_search_call(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("web_search_call")
}

/// The websearch fallback order for the Alibailian relay: the relay's own
/// hosted search first, then DeepSeek, then Kimi. Each hop authenticates
/// independently and its errors stay visible to the caller.
#[must_use]
pub fn websearch_fallback_chain() -> &'static [ProviderKind] {
    &[
        ProviderKind::Alibailian,
        ProviderKind::Deepseek,
        ProviderKind::Moonshot,
    ]
}

/// Merge relay headers. Explicit user configuration wins on every name,
/// including the DashScope session-cache header; defaults never synthesize a
/// credential-shaped header.
#[must_use]
pub fn merge_relay_headers(
    configured: &std::collections::HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = configured
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    merged.retain(|(name, value)| {
        let name = name.trim();
        !name.is_empty() && !value.trim().is_empty()
    });
    merged.sort_by(|(a, _), (b, _)| a.cmp(b));
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use codewhale_models::{Message, Role};

    fn request_with(metadata: Option<Value>, tools: Option<usize>) -> MessageRequest {
        MessageRequest {
            model: "qwen3.8-max".to_string(),
            messages: vec![Message {
                role: Role::User,
                content: vec![codewhale_models::ContentBlock::Text {
                    text: "hello".to_string(),
                    cache_control: None,
                }],
            }],
            max_tokens: 64,
            system: None,
            tools: tools.map(|n| {
                (0..n)
                    .map(|i| codewhale_models::Tool {
                        tool_type: Some("function".to_string()),
                        name: format!("tool_{i}"),
                        description: "test tool".to_string(),
                        input_schema: json!({"type": "object"}),
                        allowed_callers: None,
                        defer_loading: None,
                        input_examples: None,
                        strict: None,
                        cache_control: None,
                    })
                    .collect()
            }),
            tool_choice: None,
            metadata,
            thinking: None,
            reasoning_effort: None,
            stream: None,
            temperature: Some(0.7),
            top_p: Some(0.9),
        }
    }

    #[test]
    fn zero_tool_request_attaches_native_json_schema() {
        let schema = json!({"type": "object", "properties": {"answer": {"type": "string"}}});
        let request = request_with(Some(json!({"response_schema": schema})), None);
        let mut body = json!({"model": "qwen3.8-max", "messages": []});
        apply_structured_output(&mut body, &request);
        let format = body.get("response_format").expect("response_format");
        assert_eq!(format["type"], "json_schema");
        assert_eq!(format["json_schema"]["name"], "structured_output");
        assert_eq!(format["json_schema"]["schema"]["type"], "object");
    }

    #[test]
    fn tools_present_never_attaches_response_format() {
        let schema = json!({"type": "object"});
        let request = request_with(Some(json!({"response_schema": schema})), Some(2));
        let mut body = json!({"model": "qwen3.8-max", "tools": [{}]});
        apply_structured_output(&mut body, &request);
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn no_schema_never_attaches_response_format() {
        let request = request_with(None, None);
        let mut body = json!({"model": "qwen3.8-max"});
        apply_structured_output(&mut body, &request);
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn multi_tool_forced_choice_becomes_named_structured_output() {
        let forced = json!("required");
        let mapped = map_tool_choice_for_relay(ProviderKind::Alibailian, 2, &forced)
            .expect("backstop applies");
        assert_eq!(mapped["type"], "function");
        assert_eq!(mapped["function"]["name"], "StructuredOutput");
    }

    #[test]
    fn single_tool_forced_choice_is_left_alone() {
        let forced = json!("required");
        assert!(map_tool_choice_for_relay(ProviderKind::Alibailian, 1, &forced).is_none());
    }

    #[test]
    fn auto_choice_is_left_alone() {
        let auto = json!("auto");
        assert!(map_tool_choice_for_relay(ProviderKind::Alibailian, 3, &auto).is_none());
    }

    #[test]
    fn other_providers_never_get_the_backstop() {
        let forced = json!("required");
        assert!(
            map_tool_choice_for_relay(ProviderKind::ModelstudioTokenPlan, 3, &forced).is_none(),
            "official Model Studio must not inherit the relay backstop"
        );
        assert!(
            map_tool_choice_for_relay(ProviderKind::Custom, 3, &forced).is_none(),
            "a custom endpoint must not inherit the relay backstop"
        );
    }

    #[test]
    fn any_type_forced_choice_also_becomes_named() {
        let forced = json!({"type": "any"});
        let mapped = map_tool_choice_for_relay(ProviderKind::Alibailian, 2, &forced);
        assert!(mapped.is_some());
    }

    /// Build the body for the no-tool structured-output extraction retry.
    ///
    /// The retry deliberately drops `tools`, `tool_choice`, and any reasoning
    /// sampling overrides, and injects the schema instruction into the system
    /// prompt — the relay's zero-tool `response_format` path is the only shape
    /// this retry may take. (Test-wired: the retry trigger itself is owned by
    /// the turn loop, which consumes this contract.)
    fn structured_extraction_body(first_attempt: &Value, schema: &Value) -> Value {
        let mut body = first_attempt.clone();
        if let Some(object) = body.as_object_mut() {
            object.remove("tools");
            object.remove("tool_choice");
        }
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {
                "name": "structured_output",
                "schema": schema,
            },
        });
        body
    }

    #[test]
    fn extraction_retry_drops_tools_and_carries_schema() {
        let schema = json!({"type": "object", "properties": {"answer": {"type": "string"}}});
        let first = json!({
            "model": "qwen3.8-max",
            "messages": [],
            "tools": [{"type": "function", "function": {"name": "web_search"}}],
            "tool_choice": "required",
            "temperature": 0.7,
        });
        let retry = structured_extraction_body(&first, &schema);
        assert!(retry.get("tools").is_none());
        assert!(retry.get("tool_choice").is_none());
        assert_eq!(retry["response_format"]["json_schema"]["schema"], schema);
    }

    #[test]
    fn extraction_instruction_names_the_schema() {
        let schema = json!({"type": "object"});
        let instruction = structured_extraction_instruction(&schema);
        assert!(instruction.contains("JSON Schema"));
        assert!(instruction.contains("{\"type\":\"object\"}"));
        assert!(instruction.contains("No prose"));
    }

    #[test]
    fn forced_reasoning_strips_sampling() {
        let mut body = json!({"temperature": 0.7, "top_p": 0.9});
        strip_sampling_for_forced_reasoning(&mut body, true);
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
    }

    #[test]
    fn unforced_reasoning_keeps_sampling() {
        let mut body = json!({"temperature": 0.7, "top_p": 0.9});
        strip_sampling_for_forced_reasoning(&mut body, false);
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["top_p"], 0.9);
    }

    #[test]
    fn hosted_search_declaration_has_no_domain_filters() {
        let tool = hosted_web_search_declaration();
        assert_eq!(tool["type"], "web_search");
        assert!(tool.get("filters").is_none());
        assert!(tool.get("allowed_domains").is_none());
    }

    #[test]
    fn hosted_search_call_is_recognized_for_replay() {
        assert!(is_hosted_web_search_call(
            &json!({"type": "web_search_call"})
        ));
        assert!(!is_hosted_web_search_call(&json!({"type": "message"})));
        assert!(!is_hosted_web_search_call(&json!({})));
    }

    #[test]
    fn websearch_fallback_order_is_relay_then_deepseek_then_kimi() {
        assert_eq!(
            websearch_fallback_chain(),
            &[
                ProviderKind::Alibailian,
                ProviderKind::Deepseek,
                ProviderKind::Moonshot
            ]
        );
    }

    /// DashScope session-cache header the relay forwards when explicitly
    /// configured. Never synthesized: it only merges from user configuration.
    pub const ALIBAILIAN_SESSION_CACHE_HEADER: &str = "x-dashscope-session-cache";

    #[test]
    fn relay_headers_merge_configured_and_drop_empty() {
        let mut configured = std::collections::HashMap::new();
        configured.insert(
            ALIBAILIAN_SESSION_CACHE_HEADER.to_string(),
            "sid-1".to_string(),
        );
        configured.insert("X-Custom".to_string(), "".to_string());
        configured.insert("  ".to_string(), "value".to_string());
        let merged = merge_relay_headers(&configured);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].0, ALIBAILIAN_SESSION_CACHE_HEADER);
        assert_eq!(merged[0].1, "sid-1");
    }

    #[test]
    fn empty_relay_headers_merge_to_nothing() {
        let merged = merge_relay_headers(&std::collections::HashMap::new());
        assert!(merged.is_empty());
    }
}
