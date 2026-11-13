//! ChatGPT subscription-backend Responses dialect support.
//!
//! Offline state machine for the `https://chatgpt.com/backend-api/codex/responses`
//! surface: previous-response continuation, input delta, `generate:false`
//! prewarm, `x-codex-turn-state` tool-turn continuation, and a bounded
//! per-(endpoint, account, session) cache of the last turn's wire anchors.
//!
//! Replay safety is the hard rule: once semantic events have been observed
//! on a turn, neither a WebSocket reconnect nor an HTTP fallback may re-send
//! the request, because the backend may have already applied it.

// Offline state machine for a transport that lands in a later slice: the
// public surface is complete and tested offline; nothing outside tests
// constructs it yet (same convention as `prompts` / `work_graph`).
#![allow(dead_code)]

use std::collections::HashMap;

use serde_json::{Value, json};

/// How many turns the cache retains per (endpoint, account, session) key.
/// The backend keys continuation by its own response id; the client only
/// needs the most recent turn to continue a conversation, so a small bound
/// is both sufficient and honest about memory.
const TURNS_RETAINED: usize = 8;

/// Identifies one subscription conversation anchor.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubscriptionSessionKey {
    /// Exact endpoint the route is bound to.
    pub endpoint: String,
    /// Verified account id carried by the grant.
    pub account: String,
    /// Stable per-process session id sent as `session_id`.
    pub session: String,
}

/// Anchors captured from a completed turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionTurnAnchor {
    /// `response.id` of the completed turn; replayed as
    /// `previous_response_id` on the next request.
    pub response_id: String,
    /// Opaque turn-state token returned by the backend, replayed as the
    /// `x-codex-turn-state` header on a tool turn continuation only.
    pub turn_state: Option<String>,
}

/// Bounded cache of the most recent turn anchors per conversation key.
///
/// Not a retry buffer: entries are written only after a turn has *settled*
/// (successful completion), and read only when building the next request.
pub struct SubscriptionTurnCache {
    entries: HashMap<SubscriptionSessionKey, Vec<SubscriptionTurnAnchor>>,
}

impl SubscriptionTurnCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Record the settled turn's anchors. Keeps at most [`TURNS_RETAINED`]
    /// most-recent anchors; older ones are dropped in insertion order.
    pub fn settle(&mut self, key: SubscriptionSessionKey, anchor: SubscriptionTurnAnchor) {
        let entries = self.entries.entry(key).or_default();
        entries.push(anchor);
        let excess = entries.len().saturating_sub(TURNS_RETAINED);
        entries.drain(..excess);
    }

    /// The most recent settled anchor, if any.
    pub fn latest(&self, key: &SubscriptionSessionKey) -> Option<&SubscriptionTurnAnchor> {
        self.entries.get(key).and_then(|entries| entries.last())
    }

    /// Drop a conversation's anchors (e.g. after the backend rejects a
    /// continuation, so later turns rebuild from a full prompt).
    pub fn invalidate(&mut self, key: &SubscriptionSessionKey) {
        self.entries.remove(key);
    }

    /// Number of live anchors for one key (test visibility).
    pub fn len_for(&self, key: &SubscriptionSessionKey) -> usize {
        self.entries.get(key).map_or(0, Vec::len)
    }
}

impl Default for SubscriptionTurnCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether the next request may continue from the cached anchor or must
/// rebuild the full input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuationShape {
    /// First turn: full `input`, no `previous_response_id`.
    Baseline,
    /// Continuation: `previous_response_id` set, `input` reduced to the
    /// messages that are new since the settled turn.
    Delta { previous_response_id: String },
}

/// One turn's transport decision, derived before the request is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionRequestPlan {
    pub shape: ContinuationShape,
    /// `x-codex-turn-state` header value. Only present when continuing a
    /// *tool* turn (the turn ended in a tool call and this request carries
    /// the tool results); a user turn never replays tool state.
    pub turn_state_header: Option<String>,
}

/// Decide the request shape for the next turn.
///
/// - No cached anchor → baseline.
/// - Cached anchor → delta continuation with `previous_response_id`.
/// - `tool_results` present → the request is a tool turn; it may replay
///   `x-codex-turn-state` from the anchor.
/// - `prewarm` → a `generate:false` prewarm request: baseline shape (no
///   continuation), because it creates no turn to continue from.
pub fn plan_request(
    cache: &SubscriptionTurnCache,
    key: &SubscriptionSessionKey,
    carries_tool_results: bool,
    prewarm: bool,
) -> SubscriptionRequestPlan {
    let anchor = if prewarm { None } else { cache.latest(key) };
    match anchor {
        None => SubscriptionRequestPlan {
            shape: ContinuationShape::Baseline,
            turn_state_header: None,
        },
        Some(anchor) => {
            let turn_state_header = carries_tool_results
                .then(|| anchor.turn_state.clone())
                .flatten();
            SubscriptionRequestPlan {
                shape: ContinuationShape::Delta {
                    previous_response_id: anchor.response_id.clone(),
                },
                turn_state_header,
            }
        }
    }
}

/// Fold a plan into a Responses request body.
///
/// Baseline bodies keep the full input. Delta bodies set
/// `previous_response_id` and *replace* the input with the delta items
/// (the caller passes only the new messages; this function does not guess
/// which messages are new). `generate:false` is set for prewarms.
pub fn apply_plan(
    body: &mut Value,
    input: Vec<Value>,
    plan: &SubscriptionRequestPlan,
    prewarm: bool,
) {
    match &plan.shape {
        ContinuationShape::Baseline => {
            body["input"] = json!(input);
            body.as_object_mut()
                .map(|map| map.remove("previous_response_id"));
        }
        ContinuationShape::Delta {
            previous_response_id,
        } => {
            body["input"] = json!(input);
            body["previous_response_id"] = json!(previous_response_id);
        }
    }
    if prewarm {
        body["generate"] = json!(false);
    } else {
        body.as_object_mut().map(|map| map.remove("generate"));
    }
}

/// Replay-safety gate for transport recovery.
///
/// `ReplaySafe::Yes` — nothing semantic has been observed yet, so a dropped
/// connection may reconnect (WS) or fall back (HTTP) and re-send the same
/// request idempotently.
/// `ReplaySafe::No` — at least one semantic event (deltas, tool calls,
/// usage) has been observed on this turn. Re-sending could double-apply the
/// turn, so WS reconnect and HTTP fallback are both forbidden; the turn
/// fails and the caller surfaces the truncation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaySafety {
    Yes,
    No,
}

/// Tracks whether a turn has produced semantic events.
#[derive(Debug, Default)]
pub struct TurnObservation {
    semantic_events: usize,
    settled: bool,
}

impl TurnObservation {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one observed event. Semantic events are anything beyond
    /// transport/keepalive noise: output text deltas, reasoning deltas,
    /// tool-call items, usage, terminal responses.
    pub fn observe(&mut self, event: &Value) {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        let semantic = matches!(
            event_type,
            "response.output_item.added"
                | "response.output_text.delta"
                | "response.output_item.done"
                | "response.reasoning_summary_text.delta"
                | "response.reasoning_text.delta"
                | "response.function_call_arguments.delta"
                | "response.completed"
                | "response.incomplete"
                | "response.failed"
                | "error"
        );
        if semantic {
            self.semantic_events += 1;
        }
    }

    /// Whether a reconnect/fallback may re-send this turn's request.
    pub fn replay_safe(&self) -> ReplaySafety {
        if self.settled || self.semantic_events > 0 {
            ReplaySafety::No
        } else {
            ReplaySafety::Yes
        }
    }

    /// Mark the turn settled: the anchor may be cached and re-sends are
    /// forbidden from this point.
    pub fn settle(&mut self) {
        self.settled = true;
    }

    pub fn is_settled(&self) -> bool {
        self.settled
    }
}

/// Extract the anchors of a settled turn from a `response.completed` event.
///
/// Returns `None` unless the event carries a successful `response` with an
/// id. `turn_state` is read from the response's `turn_state` field when the
/// backend provides one.
pub fn anchor_from_completion(event: &Value) -> Option<SubscriptionTurnAnchor> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    if event_type != "response.completed" {
        return None;
    }
    let response = event.get("response")?;
    if response.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    let response_id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())?
        .to_string();
    let turn_state = response
        .get("turn_state")
        .and_then(Value::as_str)
        .filter(|state| !state.trim().is_empty())
        .map(str::to_string);
    Some(SubscriptionTurnAnchor {
        response_id,
        turn_state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SubscriptionSessionKey {
        SubscriptionSessionKey {
            endpoint: "https://chatgpt.com/backend-api/codex".to_string(),
            account: "acct-1".to_string(),
            session: "sess-1".to_string(),
        }
    }

    fn completion(id: &str, turn_state: Option<&str>) -> Value {
        let mut response = json!({"status":"completed","id":id});
        if let Some(state) = turn_state {
            response["turn_state"] = json!(state);
        }
        json!({"type":"response.completed","response":response})
    }

    #[test]
    fn first_turn_is_baseline_without_previous_response_id() {
        let cache = SubscriptionTurnCache::new();
        let plan = plan_request(&cache, &key(), false, false);
        assert_eq!(plan.shape, ContinuationShape::Baseline);
        assert_eq!(plan.turn_state_header, None);
        let mut body = json!({"model":"gpt-5.5"});
        apply_plan(
            &mut body,
            vec![json!({"type":"message","role":"user","content":[]})],
            &plan,
            false,
        );
        assert!(body.get("previous_response_id").is_none());
        assert!(
            body["input"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );
    }

    #[test]
    fn settled_turn_continues_with_previous_response_id_and_input_delta() {
        let mut cache = SubscriptionTurnCache::new();
        cache.settle(
            key(),
            anchor_from_completion(&completion("resp_1", None)).unwrap(),
        );
        let plan = plan_request(&cache, &key(), false, false);
        assert_eq!(
            plan.shape,
            ContinuationShape::Delta {
                previous_response_id: "resp_1".to_string()
            }
        );
        assert_eq!(plan.turn_state_header, None);
        let mut body = json!({"model":"gpt-5.5"});
        apply_plan(
            &mut body,
            vec![json!({"type":"message","role":"user","content":[]})],
            &plan,
            false,
        );
        assert_eq!(body["previous_response_id"], json!("resp_1"));
        // Delta input carries only the new message, not the whole history.
        assert_eq!(body["input"].as_array().map(Vec::len), Some(1));
        assert!(body.get("generate").is_none());
    }

    #[test]
    fn turn_state_header_replays_only_for_tool_turns() {
        let mut cache = SubscriptionTurnCache::new();
        cache.settle(
            key(),
            anchor_from_completion(&completion("resp_9", Some("ts_9"))).unwrap(),
        );
        // A tool turn (carries tool results) replays the header.
        let tool_turn = plan_request(&cache, &key(), true, false);
        assert_eq!(tool_turn.turn_state_header.as_deref(), Some("ts_9"));
        // A user turn never does.
        let user_turn = plan_request(&cache, &key(), false, false);
        assert_eq!(user_turn.turn_state_header, None);
        // A tool turn without a stored turn state has nothing to replay.
        cache.settle(
            key(),
            anchor_from_completion(&completion("resp_10", None)).unwrap(),
        );
        let no_state = plan_request(&cache, &key(), true, false);
        assert_eq!(no_state.turn_state_header, None);
    }

    #[test]
    fn prewarm_is_generate_false_baseline_without_continuation() {
        let mut cache = SubscriptionTurnCache::new();
        cache.settle(
            key(),
            anchor_from_completion(&completion("resp_2", None)).unwrap(),
        );
        let plan = plan_request(&cache, &key(), false, true);
        assert_eq!(plan.shape, ContinuationShape::Baseline);
        let mut body = json!({"model":"gpt-5.5"});
        apply_plan(&mut body, vec![], &plan, true);
        assert_eq!(body["generate"], json!(false));
        assert!(body.get("previous_response_id").is_none());
    }

    #[test]
    fn cache_is_bounded_per_conversation() {
        let mut cache = SubscriptionTurnCache::new();
        for turn in 0..(TURNS_RETAINED + 4) {
            cache.settle(
                key(),
                anchor_from_completion(&completion(&format!("resp_{turn}"), None)).unwrap(),
            );
        }
        assert_eq!(cache.len_for(&key()), TURNS_RETAINED);
        // The most recent anchor wins.
        assert_eq!(
            cache
                .latest(&key())
                .map(|anchor| anchor.response_id.as_str()),
            Some(format!("resp_{}", TURNS_RETAINED + 3).as_str())
        );
        // A different conversation has its own bounded list.
        let other = SubscriptionSessionKey {
            endpoint: key().endpoint,
            account: "acct-2".to_string(),
            session: key().session,
        };
        assert_eq!(cache.len_for(&other), 0);
        // Invalidation drops the conversation entirely.
        cache.invalidate(&key());
        assert_eq!(cache.len_for(&key()), 0);
        let plan = plan_request(&cache, &key(), false, false);
        assert_eq!(plan.shape, ContinuationShape::Baseline);
    }

    #[test]
    fn semantic_events_forbid_reconnect_and_fallback() {
        let mut observation = TurnObservation::new();
        assert_eq!(observation.replay_safe(), ReplaySafety::Yes);
        // Transport noise does not change safety.
        observation.observe(&json!({"type":"ping"}));
        assert_eq!(observation.replay_safe(), ReplaySafety::Yes);
        // The first semantic delta forbids every re-send path.
        observation.observe(&json!({"type":"response.output_text.delta","delta":"h"}));
        assert_eq!(observation.replay_safe(), ReplaySafety::No);
        // Settled turns stay non-replayable.
        observation.settle();
        assert_eq!(observation.replay_safe(), ReplaySafety::No);
        assert!(observation.is_settled());
    }

    #[test]
    fn anchor_extraction_requires_successful_completion() {
        assert!(anchor_from_completion(&json!({"type":"response.completed"})).is_none());
        assert!(
            anchor_from_completion(&json!({
                "type":"response.completed","response":{"status":"failed","id":"r"}
            }))
            .is_none()
        );
        assert!(
            anchor_from_completion(&json!({
                "type":"response.completed","response":{"status":"completed"}
            }))
            .is_none()
        );
        assert!(
            anchor_from_completion(&json!({
                "type":"response.incomplete","response":{"status":"incomplete","id":"r"}
            }))
            .is_none()
        );
        let anchor = anchor_from_completion(&completion("resp_ok", None)).unwrap();
        assert_eq!(anchor.response_id, "resp_ok");
        assert_eq!(anchor.turn_state, None);
    }
}
