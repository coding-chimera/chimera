use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const CLEARED_TOOL_OUTPUT: &str = "[Old tool result content cleared]";

#[napi(object)]
#[derive(Clone, Debug)]
pub struct HistoryMessageInput {
    pub id: String,
    pub time_created: i64,
    pub time_updated: i64,
    pub data: String,
    pub event_id: Option<String>,
    pub event_data: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct HistoryPartInput {
    pub id: String,
    pub message_id: String,
    pub time_created: i64,
    pub time_updated: i64,
    pub data: String,
    pub event_id: Option<String>,
    pub event_data: Option<String>,
}

#[napi(object)]
pub struct HistoryCounts {
    pub messages: u32,
    pub parts: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct HistoryView {
    pub history_hash: String,
    pub json: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct CompactionView {
    pub history_hash: String,
    pub json: String,
    pub has_remote_compaction: bool,
}

#[derive(Clone, Debug)]
struct MessageEntry {
    time_updated: i64,
    data_hash: String,
    data: String,
}

#[derive(Clone, Debug)]
struct PartEntry {
    message_id: String,
    time_updated: i64,
    data_hash: String,
    data: String,
}

#[derive(Debug)]
pub struct HistoryReplica {
    session_id: String,
    messages: BTreeMap<(i64, String), MessageEntry>,
    parts: BTreeMap<(i64, String), PartEntry>,
}

impl HistoryReplica {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            messages: BTreeMap::new(),
            parts: BTreeMap::new(),
        }
    }

    pub fn counts(&self) -> HistoryCounts {
        HistoryCounts {
            messages: self.messages.len() as u32,
            parts: self.parts.len() as u32,
        }
    }

    pub fn upsert_message(&mut self, input: HistoryMessageInput) -> Result<bool, String> {
        let data = canonical_data(&input.data)?;
        let data_hash = data_hash(&data);
        let key = (input.time_created, input.id.clone());
        let changed = self
            .messages
            .get(&key)
            .map(|old| old.time_updated != input.time_updated || old.data_hash != data_hash)
            .unwrap_or(true);
        self.messages.retain(|(_, id), _| id != &input.id);
        self.messages.insert(
            key,
            MessageEntry {
                time_updated: input.time_updated,
                data_hash,
                data,
            },
        );
        Ok(changed)
    }

    pub fn upsert_part(&mut self, input: HistoryPartInput) -> Result<bool, String> {
        let data = canonical_data(&input.data)?;
        let data_hash = data_hash(&data);
        let key = (input.time_updated, input.id.clone());
        let changed = self
            .parts
            .get(&key)
            .map(|old| old.time_updated != input.time_updated || old.data_hash != data_hash)
            .unwrap_or(true);
        self.parts.retain(|(_, id), _| id != &input.id);
        self.parts.insert(
            key,
            PartEntry {
                message_id: input.message_id,
                time_updated: input.time_updated,
                data_hash,
                data,
            },
        );
        Ok(changed)
    }

    pub fn remove_message(&mut self, id: &str) -> bool {
        let messages = self.messages.len();
        let parts = self.parts.len();
        self.messages.retain(|(_, message_id), _| message_id != id);
        self.parts.retain(|(_, _), part| part.message_id != id);
        messages != self.messages.len() || parts != self.parts.len()
    }

    pub fn remove_part(&mut self, id: &str) -> bool {
        let parts = self.parts.len();
        self.parts.retain(|(_, part_id), _| part_id != id);
        parts != self.parts.len()
    }

    /// Drop every cached message/part row, e.g. after the owning session row is
    /// deleted and SQLite cascades the history away.
    pub fn clear(&mut self) {
        self.messages.clear();
        self.parts.clear();
    }

    pub fn history_hash(&self) -> String {
        let mut hasher = Sha256::new();
        write_field(&mut hasher, b"session-data/history-v1");
        write_field(&mut hasher, self.session_id.as_bytes());
        write_field(&mut hasher, &(self.messages.len() as u64).to_le_bytes());
        write_field(&mut hasher, &(self.parts.len() as u64).to_le_bytes());
        for ((time_created, id), message) in &self.messages {
            write_field(&mut hasher, b"message");
            write_field(&mut hasher, id.as_bytes());
            write_field(&mut hasher, &time_created.to_le_bytes());
            write_field(&mut hasher, &message.time_updated.to_le_bytes());
            write_field(&mut hasher, message.data_hash.as_bytes());
        }
        for ((time_updated, id), part) in &self.parts {
            write_field(&mut hasher, b"part");
            write_field(&mut hasher, id.as_bytes());
            write_field(&mut hasher, part.message_id.as_bytes());
            write_field(&mut hasher, &time_updated.to_le_bytes());
            write_field(&mut hasher, part.data_hash.as_bytes());
        }
        format!("hh1:{}", hex(&hasher.finalize()))
    }
    pub fn view(&self, expected_history_hash: Option<&str>) -> Result<HistoryView, String> {
        let history_hash = self.history_hash();
        if let Some(expected) = expected_history_hash {
            if expected != history_hash {
                return Err(format!(
                    "history revision conflict: expected {expected}, current {history_hash}"
                ));
            }
        }
        let messages = self.project(false)?;
        let json = serde_json::to_string(&Value::Array(messages))
            .map_err(|error| format!("failed to serialize history view: {error}"))?;
        Ok(HistoryView { history_hash, json })
    }

    pub fn compaction_view(
        &self,
        mode: &str,
        expected_history_hash: Option<&str>,
    ) -> Result<CompactionView, String> {
        if mode != "local" && mode != "text" {
            return Err(format!("invalid compaction view mode: {mode}"));
        }
        let history_hash = self.history_hash();
        if let Some(expected) = expected_history_hash {
            if expected != history_hash {
                return Err(format!(
                    "history revision conflict: expected {expected}, current {history_hash}"
                ));
            }
        }
        let messages = self.project(true)?;
        let (messages, has_remote_compaction) = scan_compacted(messages, mode);
        let json = serde_json::to_string(&Value::Array(messages))
            .map_err(|error| format!("failed to serialize history view: {error}"))?;
        Ok(CompactionView {
            history_hash,
            json,
            has_remote_compaction,
        })
    }

    fn project(&self, prune_compacted: bool) -> Result<Vec<Value>, String> {
        let mut parts_by_message: BTreeMap<&str, Vec<(&String, &PartEntry)>> = BTreeMap::new();
        for ((_, part_id), part) in &self.parts {
            parts_by_message
                .entry(part.message_id.as_str())
                .or_default()
                .push((part_id, part));
        }
        let mut messages = Vec::with_capacity(self.messages.len());
        for ((_, message_id), message) in &self.messages {
            let info = row_object(
                &message.data,
                &[
                    ("id", message_id.as_str()),
                    ("sessionID", self.session_id.as_str()),
                ],
            )?;
            let mut parts = Vec::new();
            if let Some(entries) = parts_by_message.get(message_id.as_str()) {
                let mut entries = entries.clone();
                entries.sort_by(|(left, _), (right, _)| left.cmp(right));
                for (part_id, part) in entries {
                    let mut value = row_object(
                        &part.data,
                        &[
                            ("id", part_id.as_str()),
                            ("sessionID", self.session_id.as_str()),
                            ("messageID", part.message_id.as_str()),
                        ],
                    )?;
                    if prune_compacted {
                        prune_compacted_part(&mut value);
                    }
                    parts.push(value);
                }
            }
            messages.push(serde_json::json!({ "info": info, "parts": parts }));
        }
        Ok(messages)
    }
    pub fn rebuild(session_id: String, db_path: String) -> Result<Self, String> {
        let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("failed to open history database: {error}"))?;
        let mut replica = Self::new(session_id.clone());
        let mut messages = connection
            .prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ?1 ORDER BY time_created, id")
            .map_err(|error| error.to_string())?;
        let rows = messages
            .query_map([&session_id], |row| {
                Ok(HistoryMessageInput {
                    id: row.get(0)?,
                    time_created: row.get(1)?,
                    time_updated: row.get(2)?,
                    data: row.get(3)?,
                    event_id: None,
                    event_data: None,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            replica.upsert_message(row.map_err(|error| error.to_string())?)?;
        }
        let mut parts = connection
            .prepare("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ?1 ORDER BY message_id, id")
            .map_err(|error| error.to_string())?;
        let rows = parts
            .query_map([&session_id], |row| {
                Ok(HistoryPartInput {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    time_created: row.get(2)?,
                    time_updated: row.get(3)?,
                    data: row.get(4)?,
                    event_id: None,
                    event_data: None,
                })
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            replica.upsert_part(row.map_err(|error| error.to_string())?)?;
        }
        Ok(replica)
    }
}

fn canonical_data(data: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("invalid history JSON: {error}"))?;
    Ok(canonical_json(&value))
}

fn data_hash(canonical: &str) -> String {
    format!("sha256:{}", hex(&Sha256::digest(canonical.as_bytes())))
}

fn row_object(data: &str, ids: &[(&str, &str)]) -> Result<Value, String> {
    let mut value: Value =
        serde_json::from_str(data).map_err(|error| format!("invalid history JSON: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "history row data must be a JSON object".to_string())?;
    for (key, id) in ids {
        object.insert((*key).to_string(), Value::String((*id).to_string()));
    }
    Ok(value)
}

fn prune_compacted_part(part: &mut Value) {
    if part.get("type").and_then(Value::as_str) != Some("tool") {
        return;
    }
    let Some(state) = part.get_mut("state").and_then(Value::as_object_mut) else {
        return;
    };
    let compacted = state.get("time").and_then(|time| time.get("compacted"));
    if !matches!(compacted, Some(value) if !value.is_null()) {
        return;
    }
    state.insert(
        "output".to_string(),
        Value::String(CLEARED_TOOL_OUTPUT.to_string()),
    );
    state.remove("attachments");
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn message_id(message: &Value) -> Option<&str> {
    message.get("info")?.get("id")?.as_str()
}

fn message_role(message: &Value) -> Option<&str> {
    message.get("info")?.get("role")?.as_str()
}

fn message_parts(message: &Value) -> &[Value] {
    message
        .get("parts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn is_compaction_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("compaction")
}

fn first_compaction_part(message: &Value) -> Option<&Value> {
    message_parts(message)
        .iter()
        .find(|part| is_compaction_part(part))
}

fn message_has_remote_compaction(message: &Value) -> bool {
    message_parts(message)
        .iter()
        .any(|part| is_compaction_part(part) && part.get("remote").is_some())
}

fn message_has_tail_compaction(message: &Value) -> bool {
    message_parts(message)
        .iter()
        .any(|part| is_compaction_part(part) && part.get("tail_start_id").is_some())
}

fn first_tail_compaction_part(message: &Value) -> Option<&Value> {
    message_parts(message)
        .iter()
        .find(|part| is_compaction_part(part) && part.get("tail_start_id").is_some())
}

/// Port of `scanCompacted` from `packages/chimera/src/session/message-v2.ts`.
///
/// `messages` is the chronological (ascending) projection; the boundary walk
/// consumes it newest-first and returns the chronological view plus whether a
/// remote compaction part appeared inside the consumed prefix.
fn scan_compacted(messages: Vec<Value>, mode: &str) -> (Vec<Value>, bool) {
    let mut result: Vec<Value> = Vec::new();
    let mut completed: BTreeMap<String, String> = BTreeMap::new();
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    let mut has_remote_compaction = false;
    let mut retain: Option<String> = None;
    for message in messages.iter().rev() {
        if !has_remote_compaction && message_has_remote_compaction(message) {
            has_remote_compaction = true;
        }
        result.push(message.clone());
        if let Some(retain_id) = &retain {
            if message_id(message) == Some(retain_id.as_str()) {
                break;
            }
            continue;
        }
        let Some(id) = message_id(message).map(str::to_string) else {
            continue;
        };
        let completed_summary = completed.get(&id).cloned();
        if message_role(message) == Some("user") {
            if let Some(completed_summary) = completed_summary {
                let Some(part) = first_compaction_part(message) else {
                    continue;
                };
                if mode == "text" && part.get("remote").map(truthy).unwrap_or(false) {
                    skipped.insert(id.clone());
                    skipped.insert(completed_summary);
                    continue;
                }
                let tail = part.get("tail_start_id").cloned().unwrap_or(Value::Null);
                if !truthy(&tail) {
                    break;
                }
                let tail_id = tail.as_str().unwrap_or_default().to_string();
                retain = Some(tail_id.clone());
                if id == tail_id {
                    break;
                }
                continue;
            }
        }
        if message_role(message) == Some("assistant") {
            let info = &message["info"];
            if truthy(&info["summary"]) && truthy(&info["finish"]) && !truthy(&info["error"]) {
                if let (Some(parent), Some(assistant_id)) =
                    (info["parentID"].as_str(), info["id"].as_str())
                {
                    completed.insert(parent.to_string(), assistant_id.to_string());
                }
            }
        }
    }
    result.reverse();
    let filtered = if skipped.is_empty() {
        result
    } else {
        result
            .into_iter()
            .filter(|message| {
                message_id(message)
                    .map(|id| !skipped.contains(id))
                    .unwrap_or(true)
            })
            .collect()
    };
    let compaction_index = filtered.iter().rposition(|message| {
        message_role(message) == Some("user") && message_has_tail_compaction(message)
    });
    let mut messages = filtered;
    if let Some(compaction_index) = compaction_index {
        let summary_index = messages
            .iter()
            .enumerate()
            .find(|(index, message)| {
                *index > compaction_index
                    && message_role(message) == Some("assistant")
                    && truthy(&message["info"]["summary"])
                    && message["info"]["parentID"] == messages[compaction_index]["info"]["id"]
            })
            .map(|(index, _)| index);
        let tail_id = first_tail_compaction_part(&messages[compaction_index])
            .and_then(|part| part.get("tail_start_id"))
            .filter(|tail| truthy(tail))
            .and_then(Value::as_str)
            .map(str::to_string);
        let tail_index = tail_id.and_then(|tail_id| {
            messages
                .iter()
                .position(|message| message_id(message) == Some(tail_id.as_str()))
        });
        if let (Some(summary_index), Some(tail_index)) = (summary_index, tail_index) {
            if tail_index < compaction_index && summary_index > compaction_index {
                let mut reordered = Vec::with_capacity(messages.len());
                reordered.extend_from_slice(&messages[compaction_index..=summary_index]);
                reordered.extend_from_slice(&messages[tail_index..compaction_index]);
                reordered.extend_from_slice(&messages[summary_index + 1..]);
                messages = reordered;
            }
        }
    }
    (messages, has_remote_compaction)
}

pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn write_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn message(id: &str, created: i64, updated: i64, data: &str) -> HistoryMessageInput {
        HistoryMessageInput {
            id: id.to_string(),
            time_created: created,
            time_updated: updated,
            data: data.to_string(),
            event_id: None,
            event_data: None,
        }
    }

    fn part(id: &str, message_id: &str, updated: i64, data: &str) -> HistoryPartInput {
        HistoryPartInput {
            id: id.to_string(),
            message_id: message_id.to_string(),
            time_created: updated,
            time_updated: updated,
            data: data.to_string(),
            event_id: None,
            event_data: None,
        }
    }

    #[test]
    fn history_hash_is_stable_for_json_key_order_and_incremental_updates() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user","z":1,"a":2}"#))
            .unwrap();
        let first = history.history_hash();
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"a":2,"role":"user","z":1}"#))
            .unwrap();
        assert_eq!(history.history_hash(), first);
        history
            .upsert_part(part(
                "prt_a",
                "msg_a",
                2,
                r#"{"type":"text","text":"你好"}"#,
            ))
            .unwrap();
        assert_ne!(history.history_hash(), first);
        let second = history.history_hash();
        history
            .upsert_part(part(
                "prt_a",
                "msg_a",
                2,
                r#"{"text":"你好","type":"text"}"#,
            ))
            .unwrap();
        assert_eq!(history.history_hash(), second);
        assert!(history.remove_part("prt_a"));
        assert_eq!(history.history_hash(), first);
        assert!(history.remove_message("msg_a"));
        assert_eq!(history.counts().messages, 0);
        assert_eq!(history.counts().parts, 0);
    }

    #[test]
    fn rebuild_reads_existing_sqlite_rows_without_writing() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("chimera-history-{nonce}.db"));
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
"CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
                     CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO message VALUES ('msg_a','ses_test',1,2,?1)",
                    [r#"{"role":"user"}"#],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO part VALUES ('prt_a','ses_test','msg_a',2,2,?1)",
                    [r#"{"type":"text"}"#],
                )
                .unwrap();
        }
        let history =
            HistoryReplica::rebuild("ses_test".to_string(), path.to_string_lossy().into_owned())
                .unwrap();
        assert_eq!(history.counts().messages, 1);
        assert_eq!(history.counts().parts, 1);
        assert!(history.history_hash().starts_with("hh1:"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn canonical_json_sorts_objects_recursively() {
        let value = json!({"z":1,"a":{"z":2,"b":3}});
        assert_eq!(canonical_json(&value), r#"{"a":{"b":3,"z":2},"z":1}"#);
    }
    fn message_with_events(
        id: &str,
        created: i64,
        data: &str,
        event_id: &str,
        event_data: &str,
    ) -> HistoryMessageInput {
        HistoryMessageInput {
            id: id.to_string(),
            time_created: created,
            time_updated: created,
            data: data.to_string(),
            event_id: Some(event_id.to_string()),
            event_data: Some(event_data.to_string()),
        }
    }

    #[test]
    fn view_projects_ordered_rows_and_canonical_ids() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_b", 2, 2, r#"{"role":"assistant"}"#))
            .unwrap();
        history
            .upsert_message(message(
                "msg_a",
                1,
                1,
                r#"{"role":"user","id":"bogus","sessionID":"bogus"}"#,
            ))
            .unwrap();
        history
            .upsert_part(part("prt_z", "msg_a", 3, r#"{"type":"text","text":"z"}"#))
            .unwrap();
        history
            .upsert_part(part(
                "prt_a",
                "msg_a",
                9,
                r#"{"type":"text","text":"你好","messageID":"bogus"}"#,
            ))
            .unwrap();
        history
            .upsert_part(part("prt_m", "msg_b", 1, r#"{"type":"text","text":"m"}"#))
            .unwrap();

        let hash = history.history_hash();
        let view = history.view(Some(&hash)).unwrap();
        assert_eq!(view.history_hash, hash);
        let value: Value = serde_json::from_str(&view.json).unwrap();
        let rows = value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["info"]["id"], "msg_a");
        assert_eq!(rows[0]["info"]["sessionID"], "ses_test");
        assert_eq!(rows[0]["info"]["role"], "user");
        assert_eq!(rows[1]["info"]["id"], "msg_b");
        assert_eq!(rows[1]["info"]["sessionID"], "ses_test");

        let part_ids = rows[0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(part_ids, vec!["prt_a", "prt_z"]);
        assert_eq!(rows[0]["parts"][0]["messageID"], "msg_a");
        assert_eq!(rows[0]["parts"][0]["sessionID"], "ses_test");
        assert_eq!(rows[0]["parts"][0]["text"], "你好");
        assert_eq!(rows[1]["parts"][0]["id"], "prt_m");
        assert_eq!(rows[1]["parts"][0]["messageID"], "msg_b");
    }

    #[test]
    fn view_rejects_stale_expected_hash() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        let hash = history.history_hash();
        assert!(history.view(Some(&hash)).is_ok());
        history
            .upsert_part(part("prt_a", "msg_a", 2, r#"{"type":"text","text":"hi"}"#))
            .unwrap();
        let error = history.view(Some(&hash)).unwrap_err();
        assert!(error.contains("revision conflict"));
        assert!(history.view(None).is_ok());
    }

    #[test]
    fn view_reflects_removals() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_part(part("prt_a", "msg_a", 2, r#"{"type":"text","text":"hi"}"#))
            .unwrap();
        history
            .upsert_part(part("prt_b", "msg_a", 3, r#"{"type":"text","text":"yo"}"#))
            .unwrap();
        assert!(history.remove_part("prt_a"));
        let value: Value = serde_json::from_str(&history.view(None).unwrap().json).unwrap();
        let parts = value[0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["id"], "prt_b");
        assert!(history.remove_message("msg_a"));
        let empty = history.view(None).unwrap();
        assert_eq!(empty.json, "[]");
        assert_eq!(empty.history_hash, history.history_hash());
    }

    #[test]
    fn view_does_not_leak_event_fields() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message_with_events(
                "msg_a",
                1,
                r#"{"role":"user"}"#,
                "evt_msg_secret",
                r#"{"secret":"msg-event"}"#,
            ))
            .unwrap();
        let mut part_input = part("prt_a", "msg_a", 2, r#"{"type":"text","text":"hi"}"#);
        part_input.event_id = Some("evt_part_secret".to_string());
        part_input.event_data = Some(r#"{"secret":"part-event"}"#.to_string());
        history.upsert_part(part_input).unwrap();

        let mut plain = HistoryReplica::new("ses_test".to_string());
        plain
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        plain
            .upsert_part(part("prt_a", "msg_a", 2, r#"{"type":"text","text":"hi"}"#))
            .unwrap();
        assert_eq!(history.history_hash(), plain.history_hash());

        let view = history.view(None).unwrap();
        assert_eq!(view.history_hash, plain.history_hash());
        for needle in [
            "evt_msg_secret",
            "msg-event",
            "evt_part_secret",
            "part-event",
        ] {
            assert!(!view.json.contains(needle), "view leaked {needle}");
        }
    }
    fn ids(json: &str) -> Vec<String> {
        serde_json::from_str::<Value>(json)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["info"]["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn compaction_view_reorders_bounded_reads_prefix() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_u1", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_a1", 2, 2, r#"{"role":"assistant"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_ut", 3, 3, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_at", 4, 4, r#"{"role":"assistant"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_uc", 5, 5, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message(
                "msg_s",
                6,
                6,
                r#"{"role":"assistant","summary":"done","finish":"stop","parentID":"msg_uc"}"#,
            ))
            .unwrap();
        history
            .upsert_part(part(
                "prt_c",
                "msg_uc",
                5,
                r#"{"type":"compaction","auto":false,"tail_start_id":"msg_ut"}"#,
            ))
            .unwrap();

        let view = history.compaction_view("local", None).unwrap();
        assert!(!view.has_remote_compaction);
        assert_eq!(ids(&view.json), vec!["msg_uc", "msg_s", "msg_ut", "msg_at"]);
    }

    #[test]
    fn compaction_view_text_mode_skips_remote_pair_and_reads_pre_history() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_u1", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_a1", 2, 2, r#"{"role":"assistant"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_ur", 3, 3, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message(
                "msg_sr",
                4,
                4,
                r#"{"role":"assistant","summary":"remote","finish":"stop","parentID":"msg_ur"}"#,
            ))
            .unwrap();
        history
            .upsert_message(message("msg_u2", 5, 5, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_a2", 6, 6, r#"{"role":"assistant"}"#))
            .unwrap();
        history
            .upsert_part(part(
                "prt_r",
                "msg_ur",
                3,
                r#"{"type":"compaction","auto":false,"remote":{"modelID":"m"}}"#,
            ))
            .unwrap();

        let view = history.compaction_view("text", None).unwrap();
        assert!(view.has_remote_compaction);
        assert_eq!(
            ids(&view.json),
            vec!["msg_u1", "msg_a1", "msg_u2", "msg_a2"]
        );
    }

    #[test]
    fn compaction_view_prunes_compacted_tool_parts_only() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_u", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_part(part(
                "prt_a",
                "msg_u",
                2,
                r#"{"type":"tool","tool":"bash","state":{"status":"completed","input":{},"output":"SECRET","title":"t","metadata":{},"time":{"start":1,"end":2,"compacted":5},"attachments":[{"id":"file_1","type":"file"}]}}"#,
            ))
            .unwrap();
        history
            .upsert_part(part(
                "prt_b",
                "msg_u",
                3,
                r#"{"type":"tool","tool":"bash","state":{"status":"completed","input":{},"output":"FRESH","title":"t","metadata":{},"time":{"start":1,"end":2},"attachments":[{"id":"file_2","type":"file"}]}}"#,
            ))
            .unwrap();

        let view = history.compaction_view("local", None).unwrap();
        let value: Value = serde_json::from_str(&view.json).unwrap();
        let parts = value[0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["id"], "prt_a");
        assert_eq!(parts[0]["state"]["output"], CLEARED_TOOL_OUTPUT);
        assert!(parts[0]["state"].get("attachments").is_none());
        assert_eq!(parts[1]["id"], "prt_b");
        assert_eq!(parts[1]["state"]["output"], "FRESH");
        assert!(parts[1]["state"].get("attachments").is_some());

        let plain: Value = serde_json::from_str(&history.view(None).unwrap().json).unwrap();
        assert_eq!(plain[0]["parts"][0]["state"]["output"], "SECRET");
        assert!(plain[0]["parts"][0]["state"].get("attachments").is_some());
    }

    #[test]
    fn compaction_view_rejects_stale_hash_and_invalid_mode() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        let hash = history.history_hash();
        assert!(history.compaction_view("local", Some(&hash)).is_ok());
        history
            .upsert_part(part("prt_a", "msg_a", 2, r#"{"type":"text","text":"hi"}"#))
            .unwrap();
        let error = history.compaction_view("local", Some(&hash)).unwrap_err();
        assert!(error.contains("revision conflict"));
        let error = history.compaction_view("bogus", None).unwrap_err();
        assert!(error.contains("invalid compaction view mode"));
    }

    #[test]
    fn compaction_view_without_compaction_keeps_chronological_order() {
        let mut history = HistoryReplica::new("ses_test".to_string());
        history
            .upsert_message(message("msg_c", 3, 3, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        history
            .upsert_message(message("msg_b", 2, 2, r#"{"role":"user"}"#))
            .unwrap();

        let view = history.compaction_view("local", None).unwrap();
        assert!(!view.has_remote_compaction);
        assert_eq!(ids(&view.json), vec!["msg_a", "msg_b", "msg_c"]);
    }
}
