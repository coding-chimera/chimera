use crate::history::{canonical_json, HistoryMessageInput, HistoryPartInput, HistoryReplica};
use napi_derive::napi;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde_json::{json, Value};

#[derive(thiserror::Error, Debug)]
pub enum WriterError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<String> for WriterError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for WriterError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

#[napi(object)]
pub struct WriterOptions {
    pub db_path: String,
    pub session_id: String,
    pub expected_history_hash: Option<String>,
    pub event_v2: bool,
    pub workspaces: bool,
    pub fail_after_commit: Option<bool>,
}

#[napi(object)]
pub struct ToolResultInput {
    pub part_id: String,
    pub message_id: String,
    pub time_created: i64,
    pub time_updated: i64,
    pub part_data: String,
    pub part_event_id: Option<String>,
    pub part_event_data: Option<String>,
    pub v2_event_id: Option<String>,
    pub v2_event_data: Option<String>,
    pub success: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RemoveMessageInput {
    pub message_id: String,
    pub time_updated: i64,
    pub event_id: Option<String>,
    pub event_data: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RemovePartInput {
    pub part_id: String,
    pub message_id: String,
    pub time_updated: i64,
    pub event_id: Option<String>,
    pub event_data: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SessionMetadataInput {
    pub data: String,
    pub time_updated: i64,
    pub event_id: Option<String>,
    pub event_data: Option<String>,
}

#[napi(object)]
pub struct WriterResult {
    pub status: String,
    pub changed: bool,
    pub history_hash: Option<String>,
    pub aggregate_seq: Option<i64>,
}

pub struct SessionWriter {
    connection: Connection,
    options: WriterOptions,
    replica: HistoryReplica,
    fence: Option<String>,
    injected_failure: bool,
}

impl SessionWriter {
    pub fn new(options: WriterOptions) -> Result<Self, WriterError> {
        let connection =
            Connection::open_with_flags(&options.db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| format!("failed to open writer database: {error}"))?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
            .map_err(|error| format!("failed to configure writer database: {error}"))?;
        let replica = HistoryReplica::rebuild(options.session_id.clone(), options.db_path.clone())
            .map_err(WriterError::Message)?;
        let fence = options.expected_history_hash.clone();
        if let Some(expected) = &fence {
            if replica.history_hash() != *expected {
                return Err(WriterError::Message(format!(
                    "expected history hash mismatch for session {}",
                    options.session_id
                )));
            }
        }
        Ok(Self {
            connection,
            options,
            replica,
            fence,
            injected_failure: false,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.options.session_id
    }

    pub fn history_hash(&self) -> String {
        self.replica.history_hash()
    }

    fn already_committed(&self) -> WriterResult {
        WriterResult {
            status: "already_committed".to_string(),
            changed: false,
            history_hash: Some(self.replica.history_hash()),
            aggregate_seq: None,
        }
    }

    fn finish(
        &mut self,
        changed: bool,
        aggregate_seq: Option<i64>,
    ) -> Result<WriterResult, WriterError> {
        let hash = self.replica.history_hash();
        self.fence = Some(hash.clone());
        if changed && self.options.fail_after_commit == Some(true) && !self.injected_failure {
            self.injected_failure = true;
            return Err(WriterError::Message(
                "injected post-commit failure".to_string(),
            ));
        }
        Ok(WriterResult {
            status: "committed".to_string(),
            changed,
            history_hash: Some(hash),
            aggregate_seq,
        })
    }

    pub fn upsert_message(
        &mut self,
        input: HistoryMessageInput,
    ) -> Result<WriterResult, WriterError> {
        serde_json::from_str::<Value>(&input.data)?;
        let current = self.replica.history_hash();
        let fence_conflict = self
            .fence
            .as_ref()
            .is_some_and(|expected| expected != &current);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if fence_conflict {
            return Ok(WriterResult {
                status: "revision_conflict".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        let existing = transaction
            .query_row(
                "SELECT time_created, time_updated, data FROM message WHERE id = ?1 AND session_id = ?2",
                params![input.id, self.options.session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((_, time_updated, data)) = &existing {
            if *time_updated == input.time_updated && *data == input.data {
                return Ok(WriterResult {
                    status: "already_committed".to_string(),
                    changed: false,
                    history_hash: Some(current),
                    aggregate_seq: None,
                });
            }
        }
        let time_created = existing
            .as_ref()
            .map(|(created, _, _)| *created)
            .unwrap_or(input.time_created);
        let changed = match transaction.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated",
            params![
                input.id,
                self.options.session_id,
                time_created,
                input.time_updated,
                input.data
            ],
        ) {
            Ok(rows) => rows > 0,
            Err(error) if is_foreign_key(&error) => false,
            Err(error) => return Err(error.into()),
        };
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "message.updated.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        if changed {
            self.replica
                .upsert_message(HistoryMessageInput {
                    id: input.id,
                    time_created,
                    time_updated: input.time_updated,
                    data: input.data,
                    event_id: None,
                    event_data: None,
                })
                .map_err(WriterError::Message)?;
        }
        self.finish(changed, aggregate_seq)
    }

    pub fn upsert_part(&mut self, input: HistoryPartInput) -> Result<WriterResult, WriterError> {
        serde_json::from_str::<Value>(&input.data)?;
        let current = self.replica.history_hash();
        let fence_conflict = self
            .fence
            .as_ref()
            .is_some_and(|expected| expected != &current);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if fence_conflict {
            return Ok(WriterResult {
                status: "revision_conflict".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        let existing = transaction
            .query_row(
                "SELECT message_id, time_created, time_updated, data FROM part WHERE id = ?1 AND session_id = ?2",
                params![input.id, self.options.session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((_, _, time_updated, data)) = &existing {
            if *time_updated == input.time_updated && *data == input.data {
                return Ok(WriterResult {
                    status: "already_committed".to_string(),
                    changed: false,
                    history_hash: Some(current),
                    aggregate_seq: None,
                });
            }
        }
        let message_id = existing
            .as_ref()
            .map(|(message_id, _, _, _)| message_id.clone())
            .unwrap_or_else(|| input.message_id.clone());
        let time_created = existing
            .as_ref()
            .map(|(_, created, _, _)| *created)
            .unwrap_or(input.time_created);
        let changed = match transaction.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated",
            params![
                input.id,
                message_id,
                self.options.session_id,
                time_created,
                input.time_updated,
                input.data
            ],
        ) {
            Ok(rows) => rows > 0,
            Err(error) if is_foreign_key(&error) => false,
            Err(error) => return Err(error.into()),
        };
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "message.part.updated.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        if changed {
            self.replica
                .upsert_part(HistoryPartInput {
                    id: input.id,
                    message_id,
                    time_created,
                    time_updated: input.time_updated,
                    data: input.data,
                    event_id: None,
                    event_data: None,
                })
                .map_err(WriterError::Message)?;
        }
        self.finish(changed, aggregate_seq)
    }

    pub fn remove_message(
        &mut self,
        input: RemoveMessageInput,
    ) -> Result<WriterResult, WriterError> {
        let current = self.replica.history_hash();
        let fence_conflict = self
            .fence
            .as_ref()
            .is_some_and(|expected| expected != &current);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if fence_conflict {
            return Ok(WriterResult {
                status: "revision_conflict".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        let message_exists = transaction
            .query_row(
                "SELECT 1 FROM message WHERE id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        let parts_exist = transaction
            .query_row(
                "SELECT 1 FROM part WHERE message_id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !message_exists && !parts_exist {
            return Ok(WriterResult {
                status: "already_committed".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        if parts_exist {
            transaction.execute(
                "DELETE FROM part WHERE message_id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
            )?;
        }
        if message_exists {
            transaction.execute(
                "DELETE FROM message WHERE id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
            )?;
        }
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "message.removed.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.replica.remove_message(&input.message_id);
        self.finish(true, aggregate_seq)
    }

    pub fn remove_part(&mut self, input: RemovePartInput) -> Result<WriterResult, WriterError> {
        let current = self.replica.history_hash();
        let fence_conflict = self
            .fence
            .as_ref()
            .is_some_and(|expected| expected != &current);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if fence_conflict {
            return Ok(WriterResult {
                status: "revision_conflict".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        let exists = transaction
            .query_row(
                "SELECT 1 FROM part WHERE id = ?1 AND session_id = ?2",
                params![input.part_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Ok(WriterResult {
                status: "already_committed".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        transaction.execute(
            "DELETE FROM part WHERE id = ?1 AND session_id = ?2",
            params![input.part_id, self.options.session_id],
        )?;
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "message.part.removed.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.replica.remove_part(&input.part_id);
        self.finish(true, aggregate_seq)
    }

    pub fn create_session(&mut self, input: SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let entries = metadata_entries(&input.data)?;
        let id = entries
            .iter()
            .find(|(column, _)| column.as_str() == "id")
            .and_then(|(_, value)| value.as_str())
            .ok_or_else(|| "session metadata missing string id".to_string())?
            .to_string();
        let current = self.replica.history_hash();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match session_row_matches(&transaction, &id, &entries)? {
            Some(true) => {
                return Ok(WriterResult {
                    status: "already_committed".to_string(),
                    changed: false,
                    history_hash: Some(current),
                    aggregate_seq: None,
                })
            }
            Some(false) => {
                return Err(WriterError::Message(format!(
                    "session already exists with different data: {id}"
                )))
            }
            None => {}
        }
        let columns = entries
            .iter()
            .map(|(column, _)| column.as_str())
            .collect::<Vec<_>>();
        let placeholders = (1..=columns.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO session ({}) VALUES ({placeholders})",
            columns.join(", ")
        );
        let values = entries
            .iter()
            .map(|(_, value)| json_to_sql(value))
            .collect::<Vec<_>>();
        transaction.execute(&sql, rusqlite::params_from_iter(values))?;
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "session.created.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.finish(true, aggregate_seq)
    }

    pub fn patch_session(&mut self, input: SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let mut entries = metadata_entries(&input.data)?;
        if !entries
            .iter()
            .any(|(column, _)| column.as_str() == "time_updated")
        {
            entries.push(("time_updated".to_string(), Value::from(input.time_updated)));
        }
        let id = self.options.session_id.clone();
        let current = self.replica.history_hash();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match session_row_matches(&transaction, &id, &entries)? {
            None => return Err(WriterError::Message(format!("Session not found: {id}"))),
            Some(true) => {
                return Ok(WriterResult {
                    status: "already_committed".to_string(),
                    changed: false,
                    history_hash: Some(current),
                    aggregate_seq: None,
                })
            }
            Some(false) => {}
        }
        let assignments = entries
            .iter()
            .enumerate()
            .map(|(index, (column, _))| format!("{column} = ?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE session SET {assignments} WHERE id = ?{}",
            entries.len() + 1
        );
        let mut values = entries
            .iter()
            .map(|(_, value)| json_to_sql(value))
            .collect::<Vec<_>>();
        values.push(SqlValue::Text(id));
        transaction.execute(&sql, rusqlite::params_from_iter(values))?;
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                &self.options.session_id,
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "session.updated.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.finish(true, aggregate_seq)
    }

    pub fn delete_session(&mut self, input: SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let id = self.options.session_id.clone();
        let current = self.replica.history_hash();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists = transaction
            .query_row("SELECT 1 FROM session WHERE id = ?1", [id.as_str()], |_| {
                Ok(true)
            })
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Ok(WriterResult {
                status: "already_committed".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        transaction.execute("DELETE FROM session WHERE id = ?1", [id.as_str()])?;
        let aggregate_seq = if self.options.workspaces {
            append_workspace_event(
                &transaction,
                id.as_str(),
                input.event_id.as_deref(),
                input.event_data.as_deref(),
                "session.deleted.1",
            )?
        } else {
            None
        };
        transaction.commit()?;
        self.replica.clear();
        self.finish(true, aggregate_seq)
    }

    pub fn probe_create_session(&self, input: &SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let entries = metadata_entries(&input.data)?;
        let id = entries
            .iter()
            .find(|(column, _)| column.as_str() == "id")
            .and_then(|(_, value)| value.as_str())
            .ok_or_else(|| "session metadata missing string id".to_string())?;
        if !matches!(
            session_row_matches(&self.connection, id, &entries)?,
            Some(true)
        ) {
            return Err(WriterError::Message(
                "probe: session creation not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "session.created.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn probe_patch_session(&self, input: &SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let mut entries = metadata_entries(&input.data)?;
        if !entries
            .iter()
            .any(|(column, _)| column.as_str() == "time_updated")
        {
            entries.push(("time_updated".to_string(), Value::from(input.time_updated)));
        }
        if !matches!(
            session_row_matches(&self.connection, &self.options.session_id, &entries)?,
            Some(true)
        ) {
            return Err(WriterError::Message(
                "probe: session patch not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "session.updated.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn probe_delete_session(&self, input: &SessionMetadataInput) -> Result<WriterResult, WriterError> {
        let exists = self
            .connection
            .query_row(
                "SELECT 1 FROM session WHERE id = ?1",
                [self.options.session_id.as_str()],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            return Err(WriterError::Message(
                "probe: session deletion not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "session.deleted.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn commit_tool_result(
        &mut self,
        input: ToolResultInput,
    ) -> Result<WriterResult, WriterError> {
        serde_json::from_str::<Value>(&input.part_data)?;
        let current = self.replica.history_hash();
        let fence_conflict = self
            .fence
            .as_ref()
            .is_some_and(|expected| expected != &current);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if fence_conflict {
            return Ok(WriterResult {
                status: "revision_conflict".to_string(),
                changed: false,
                history_hash: Some(current),
                aggregate_seq: None,
            });
        }
        let existing = transaction
            .query_row(
                "SELECT message_id, time_created, time_updated, data FROM part WHERE id = ?1 AND session_id = ?2",
                params![input.part_id, self.options.session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((_, _, time_updated, data)) = &existing {
            if *time_updated == input.time_updated && *data == input.part_data {
                return Ok(WriterResult {
                    status: "already_committed".to_string(),
                    changed: false,
                    history_hash: Some(current),
                    aggregate_seq: None,
                });
            }
        }
        let message_id = existing
            .as_ref()
            .map(|(message_id, _, _, _)| message_id.clone())
            .unwrap_or_else(|| input.message_id.clone());
        let time_created = existing
            .as_ref()
            .map(|(_, created, _, _)| *created)
            .unwrap_or(input.time_created);
        let changed = match transaction.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated",
            params![
                input.part_id,
                message_id,
                self.options.session_id,
                time_created,
                input.time_updated,
                input.part_data
            ],
        ) {
            Ok(rows) => rows > 0,
            Err(error) if is_foreign_key(&error) => false,
            Err(error) => return Err(error.into()),
        };
        if self.options.event_v2 {
            if let Some(data) = &input.v2_event_data {
                let value: Value = serde_json::from_str(data)
                    .map_err(|error| format!("invalid v2 event JSON: {error}"))?;
                project_tool_result(
                    &transaction,
                    &self.options.session_id,
                    &value,
                    input.success,
                    input.time_updated,
                )?;
            }
        }
        let mut aggregate_seq = None;
        if self.options.workspaces {
            if let Some(event_id) = &input.v2_event_id {
                let data = input.v2_event_data.as_deref().unwrap_or("{}");
                let event_type = if input.success {
                    "session.next.tool.success.1"
                } else {
                    "session.next.tool.failed.1"
                };
                aggregate_seq = Some(append_event(
                    &transaction,
                    &self.options.session_id,
                    event_id,
                    event_type,
                    data,
                )?);
            }
            if let Some(event_id) = &input.part_event_id {
                let data = input.part_event_data.as_deref().unwrap_or("{}");
                aggregate_seq = Some(append_event(
                    &transaction,
                    &self.options.session_id,
                    event_id,
                    "message.part.updated.1",
                    data,
                )?);
            }
        }
        transaction.commit()?;
        if changed {
            self.replica
                .upsert_part(HistoryPartInput {
                    id: input.part_id,
                    message_id,
                    time_created,
                    time_updated: input.time_updated,
                    data: input.part_data,
                    event_id: None,
                    event_data: None,
                })
                .map_err(WriterError::Message)?;
        }
        self.finish(changed, aggregate_seq)
    }

    pub fn probe_message(&self, input: &HistoryMessageInput) -> Result<WriterResult, WriterError> {
        let existing = self
            .connection
            .query_row(
                "SELECT time_updated, data FROM message WHERE id = ?1 AND session_id = ?2",
                params![input.id, self.options.session_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let matches = existing.as_ref().is_some_and(|(time_updated, data)| {
            *time_updated == input.time_updated && *data == input.data
        });
        if !matches {
            return Err(WriterError::Message(
                "probe: message final state not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "message.updated.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn probe_part(&self, input: &HistoryPartInput) -> Result<WriterResult, WriterError> {
        let existing = self
            .connection
            .query_row(
                "SELECT message_id, time_updated, data FROM part WHERE id = ?1 AND session_id = ?2",
                params![input.id, self.options.session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let matches = existing
            .as_ref()
            .is_some_and(|(message_id, time_updated, data)| {
                *message_id == input.message_id
                    && *time_updated == input.time_updated
                    && *data == input.data
            });
        if !matches {
            return Err(WriterError::Message(
                "probe: part final state not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "message.part.updated.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn probe_remove_message(
        &self,
        input: &RemoveMessageInput,
    ) -> Result<WriterResult, WriterError> {
        let message_exists = self
            .connection
            .query_row(
                "SELECT 1 FROM message WHERE id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        let parts_exist = self
            .connection
            .query_row(
                "SELECT 1 FROM part WHERE message_id = ?1 AND session_id = ?2",
                params![input.message_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if message_exists || parts_exist {
            return Err(WriterError::Message(
                "probe: message removal not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "message.removed.1",
        )?;
        Ok(self.already_committed())
    }

    pub fn probe_remove_part(&self, input: &RemovePartInput) -> Result<WriterResult, WriterError> {
        let exists = self
            .connection
            .query_row(
                "SELECT 1 FROM part WHERE id = ?1 AND session_id = ?2",
                params![input.part_id, self.options.session_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if exists {
            return Err(WriterError::Message(
                "probe: part removal not committed".to_string(),
            ));
        }
        self.probe_event(
            input.event_id.as_deref(),
            input.event_data.as_deref(),
            "message.part.removed.1",
        )?;
        Ok(self.already_committed())
    }

    fn probe_event(
        &self,
        event_id: Option<&str>,
        event_data: Option<&str>,
        event_type: &str,
    ) -> Result<(), WriterError> {
        if !self.options.workspaces {
            return Ok(());
        }
        let Some(event_id) = event_id else {
            return Ok(());
        };
        let expected_data = event_data.unwrap_or("{}");
        let existing = self
            .connection
            .query_row(
                "SELECT type, data FROM event WHERE id = ?1",
                [event_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        match existing {
            Some((kind, data)) if kind == event_type && data == expected_data => Ok(()),
            _ => Err(WriterError::Message(format!(
                "probe: workspace event {event_id} not committed"
            ))),
        }
    }
}

const SESSION_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "workspace_id",
    "parent_id",
    "slug",
    "directory",
    "path",
    "title",
    "version",
    "share_url",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "revert",
    "permission",
    "agent",
    "client",
    "model",
    "usage",
    "time_created",
    "time_updated",
    "time_compacting",
    "time_archived",
];

fn metadata_entries(data: &str) -> Result<Vec<(String, Value)>, WriterError> {
    let value: Value = serde_json::from_str(data)?;
    let object = value
        .as_object()
        .ok_or_else(|| "session metadata data must be a JSON object".to_string())?;
    object
        .iter()
        .map(|(column, value)| {
            if !SESSION_COLUMNS
                .iter()
                .any(|known| *known == column.as_str())
            {
                return Err(WriterError::Message(format!(
                    "unknown session column: {column}"
                )));
            }
            Ok((column.clone(), value.clone()))
        })
        .collect()
}

fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(if *value { 1 } else { 0 }),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                SqlValue::Integer(integer)
            } else if let Some(integer) = value.as_u64() {
                SqlValue::Integer(integer as i64)
            } else {
                SqlValue::Real(value.as_f64().unwrap_or_default())
            }
        }
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(canonical_json(value)),
    }
}

fn value_matches(stored: ValueRef<'_>, expected: &Value) -> bool {
    match expected {
        Value::Null => matches!(stored, ValueRef::Null),
        Value::Bool(value) => {
            let expected = if *value { 1 } else { 0 };
            matches!(stored, ValueRef::Integer(actual) if actual == expected)
        }
        Value::Number(value) => match stored {
            ValueRef::Integer(actual) => value
                .as_i64()
                .map(|expected| expected == actual)
                .unwrap_or_else(|| {
                    value
                        .as_f64()
                        .is_some_and(|expected| expected == actual as f64)
                }),
            ValueRef::Real(actual) => value
                .as_f64()
                .is_some_and(|expected| expected == actual),
            _ => false,
        },
        Value::String(value) => {
            matches!(stored, ValueRef::Text(actual) if actual == value.as_bytes())
        }
        Value::Array(_) | Value::Object(_) => {
            let canonical = canonical_json(expected);
            matches!(stored, ValueRef::Text(actual) if actual == canonical.as_bytes())
        }
    }
}

fn session_row_matches(
    connection: &Connection,
    id: &str,
    entries: &[(String, Value)],
) -> Result<Option<bool>, WriterError> {
    let columns = entries
        .iter()
        .map(|(column, _)| column.as_str())
        .collect::<Vec<_>>();
    let sql = format!("SELECT {} FROM session WHERE id = ?1", columns.join(", "));
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    for (index, (_, expected)) in entries.iter().enumerate() {
        if !value_matches(row.get_ref(index)?, expected) {
            return Ok(Some(false));
        }
    }
    Ok(Some(true))
}

fn is_foreign_key(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, message)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
                && (code.extended_code == 787
                    || message
                        .as_deref()
                        .is_some_and(|text| text.contains("FOREIGN KEY constraint failed")))
    )
}

fn append_workspace_event(
    connection: &Connection,
    session_id: &str,
    event_id: Option<&str>,
    event_data: Option<&str>,
    event_type: &str,
) -> Result<Option<i64>, WriterError> {
    let Some(event_id) = event_id else {
        return Ok(None);
    };
    let data = event_data.unwrap_or("{}");
    Ok(Some(append_event(
        connection, session_id, event_id, event_type, data,
    )?))
}

fn project_tool_result(
    connection: &Connection,
    session_id: &str,
    event: &Value,
    success: bool,
    time_updated: i64,
) -> Result<(), WriterError> {
    let Some((id, data)) = connection
        .query_row(
            "SELECT id, data FROM session_message WHERE session_id = ?1 AND type = 'assistant' AND json_extract(data, '$.time.completed') IS NULL ORDER BY id DESC LIMIT 1",
            [session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(());
    };
    let call_id = event
        .get("callID")
        .and_then(Value::as_str)
        .ok_or_else(|| "v2 event missing callID".to_string())?;
    let timestamp = event.get("timestamp").cloned().unwrap_or(Value::Null);
    let structured = event
        .get("structured")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let content = event.get("content").cloned().unwrap_or_else(|| json!([]));
    let provider = event
        .get("provider")
        .cloned()
        .unwrap_or_else(|| json!({"executed":false}));
    let mut data: Value = serde_json::from_str(&data)
        .map_err(|error| format!("invalid session_message JSON: {error}"))?;
    let mut changed = false;
    if let Some(items) = data.get_mut("content").and_then(Value::as_array_mut) {
        for item in items {
            let matches = item.get("type").and_then(Value::as_str) == Some("tool")
                && item.get("id").and_then(Value::as_str) == Some(call_id)
                && item.pointer("/state/status").and_then(Value::as_str) == Some("running");
            if !matches {
                continue;
            }
            let input = item.pointer("/state/input").cloned().unwrap_or(Value::Null);
            item["provider"] = provider.clone();
            item["time"]["completed"] = timestamp.clone();
            item["state"] = if success {
                json!({"status":"completed","input":input,"structured":structured,"content":content})
            } else {
                json!({"status":"error","error":event.get("error").cloned().unwrap_or(Value::Null),"input":input,"structured":item.pointer("/state/structured").cloned().unwrap_or_else(|| json!({})),"content":item.pointer("/state/content").cloned().unwrap_or_else(|| json!([]))})
            };
            changed = true;
        }
    }
    if changed {
        connection.execute(
            "UPDATE session_message SET data = ?1, time_updated = ?2 WHERE id = ?3 AND session_id = ?4 AND type = 'assistant'",
            params![serde_json::to_string(&data).map_err(|error| error.to_string())?, time_updated, id, session_id],
        )?;
    }
    Ok(())
}

fn append_event(
    connection: &Connection,
    session_id: &str,
    event_id: &str,
    event_type: &str,
    data: &str,
) -> Result<i64, WriterError> {
    let existing = connection
        .query_row(
            "SELECT seq, type, data FROM event WHERE id = ?1",
            [event_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((seq, kind, payload)) = existing {
        if kind == event_type && payload == data {
            return Ok(seq);
        }
        return Err(WriterError::Message(format!(
            "workspace event {event_id} already exists with a different payload"
        )));
    }
    let current = connection
        .query_row(
            "SELECT seq FROM event_sequence WHERE aggregate_id = ?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let seq = current.map(|value| value + 1).unwrap_or(0);
    connection.execute(
        "INSERT INTO event_sequence (aggregate_id, seq) VALUES (?1, ?2) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq",
        params![session_id, seq],
    )?;
    connection.execute(
        "INSERT INTO event (id, seq, aggregate_id, type, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, seq, session_id, event_type, data],
    )?;
    Ok(seq)
}

trait OptionalRow<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalRow<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const SESSION: &str = "ses_test";

    fn database() -> String {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("chimera-writer-{nonce}.db"));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE session (id TEXT PRIMARY KEY);
                 CREATE TABLE message (
                     id TEXT PRIMARY KEY,
                     session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                     time_created INTEGER,
                     time_updated INTEGER,
                     data TEXT
                 );
                 CREATE TABLE part (
                     id TEXT PRIMARY KEY,
                     message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
                     session_id TEXT NOT NULL,
                     time_created INTEGER,
                     time_updated INTEGER,
                     data TEXT
                 );
                 CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER);
                 CREATE TABLE event (id TEXT PRIMARY KEY, seq INTEGER, aggregate_id TEXT, type TEXT, data TEXT);
                 INSERT INTO session (id) VALUES ('ses_test');",
            )
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    fn options(path: &str, expected: Option<String>) -> WriterOptions {
        WriterOptions {
            db_path: path.to_string(),
            session_id: SESSION.to_string(),
            expected_history_hash: expected,
            event_v2: true,
            workspaces: true,
            fail_after_commit: None,
        }
    }

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

    fn part(
        id: &str,
        message_id: &str,
        created: i64,
        updated: i64,
        data: &str,
    ) -> HistoryPartInput {
        HistoryPartInput {
            id: id.to_string(),
            message_id: message_id.to_string(),
            time_created: created,
            time_updated: updated,
            data: data.to_string(),
            event_id: None,
            event_data: None,
        }
    }

    fn event_ids(path: &str) -> Vec<(i64, String)> {
        let connection = Connection::open(path).unwrap();
        let mut statement = connection
            .prepare("SELECT seq, type FROM event ORDER BY seq")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    #[test]
    fn upsert_message_preserves_time_created_and_is_idempotent() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        let first = writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        assert_eq!(first.status, "committed");
        assert!(first.changed);

        let updated = writer
            .upsert_message(message("msg_a", 999, 5, r#"{"role":"user","x":1}"#))
            .unwrap();
        assert_eq!(updated.status, "committed");
        assert!(updated.changed);

        let connection = Connection::open(&path).unwrap();
        let (created, time_updated, data): (i64, i64, String) = connection
            .query_row(
                "SELECT time_created, time_updated, data FROM message WHERE id = 'msg_a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            created, 1,
            "conflict update must not overwrite time_created"
        );
        assert_eq!(time_updated, 5);
        assert!(data.contains("\"x\":1"));

        let replay = writer
            .upsert_message(message("msg_a", 999, 5, r#"{"role":"user","x":1}"#))
            .unwrap();
        assert_eq!(replay.status, "already_committed");
        assert!(!replay.changed);
        assert_eq!(replay.history_hash, updated.history_hash);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn upsert_part_preserves_time_created_and_message_id() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        writer
            .upsert_message(message("msg_b", 2, 2, r#"{"role":"user"}"#))
            .unwrap();
        writer
            .upsert_part(part(
                "prt_a",
                "msg_a",
                1,
                1,
                r#"{"type":"text","text":"a"}"#,
            ))
            .unwrap();
        let updated = writer
            .upsert_part(part(
                "prt_a",
                "msg_b",
                99,
                7,
                r#"{"type":"text","text":"b"}"#,
            ))
            .unwrap();
        assert_eq!(updated.status, "committed");

        let connection = Connection::open(&path).unwrap();
        let (message_id, created, time_updated): (String, i64, i64) = connection
            .query_row(
                "SELECT message_id, time_created, time_updated FROM part WHERE id = 'prt_a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(message_id, "msg_a");
        assert_eq!(created, 1);
        assert_eq!(time_updated, 7);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn workspaces_events_append_with_sequence_and_dedupe() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();

        let mut first = message("msg_a", 1, 1, r#"{"role":"user"}"#);
        first.event_id = Some("evt_msg".to_string());
        first.event_data = Some(r#"{"sessionID":"ses_test"}"#.to_string());
        let result = writer.upsert_message(first.clone()).unwrap();
        assert_eq!(result.aggregate_seq, Some(0));

        let mut part_input = part("prt_a", "msg_a", 1, 1, r#"{"type":"text","text":"hi"}"#);
        part_input.event_id = Some("evt_part".to_string());
        part_input.event_data = Some(r#"{"sessionID":"ses_test"}"#.to_string());
        let result = writer.upsert_part(part_input).unwrap();
        assert_eq!(result.aggregate_seq, Some(1));

        let replay = writer.upsert_message(first).unwrap();
        assert_eq!(replay.status, "already_committed");
        assert_eq!(replay.aggregate_seq, None);

        let events = event_ids(&path);
        assert_eq!(
            events,
            vec![
                (0, "message.updated.1".to_string()),
                (1, "message.part.updated.1".to_string())
            ]
        );
        assert!(events.iter().all(|(_, kind)| !kind.contains("delta")));

        let mut conflicting = message("msg_b", 2, 2, r#"{"role":"assistant"}"#);
        conflicting.event_id = Some("evt_msg".to_string());
        conflicting.event_data = Some(r#"{"sessionID":"ses_other"}"#.to_string());
        assert!(writer.upsert_message(conflicting).is_err());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn workspaces_off_writes_no_events() {
        let path = database();
        let mut writer = SessionWriter::new(WriterOptions {
            workspaces: false,
            ..options(&path, None)
        })
        .unwrap();
        let mut input = message("msg_a", 1, 1, r#"{"role":"user"}"#);
        input.event_id = Some("evt_msg".to_string());
        let result = writer.upsert_message(input).unwrap();
        assert_eq!(result.status, "committed");
        assert_eq!(result.aggregate_seq, None);
        assert!(event_ids(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remove_message_cascades_parts_and_is_idempotent() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        writer
            .upsert_part(part(
                "prt_a",
                "msg_a",
                1,
                1,
                r#"{"type":"text","text":"a"}"#,
            ))
            .unwrap();
        writer
            .upsert_part(part(
                "prt_b",
                "msg_a",
                1,
                1,
                r#"{"type":"text","text":"b"}"#,
            ))
            .unwrap();

        let removed = writer
            .remove_message(RemoveMessageInput {
                message_id: "msg_a".to_string(),
                time_updated: 10,
                event_id: Some("evt_remove".to_string()),
                event_data: Some(r#"{"sessionID":"ses_test"}"#.to_string()),
            })
            .unwrap();
        assert_eq!(removed.status, "committed");
        assert!(removed.changed);
        assert_eq!(removed.aggregate_seq, Some(0));

        let connection = Connection::open(&path).unwrap();
        let messages: i64 = connection
            .query_row("SELECT count(*) FROM message", [], |row| row.get(0))
            .unwrap();
        let parts: i64 = connection
            .query_row("SELECT count(*) FROM part", [], |row| row.get(0))
            .unwrap();
        assert_eq!(messages, 0);
        assert_eq!(parts, 0);

        let replay = writer
            .remove_message(RemoveMessageInput {
                message_id: "msg_a".to_string(),
                time_updated: 10,
                event_id: Some("evt_remove".to_string()),
                event_data: Some(r#"{"sessionID":"ses_test"}"#.to_string()),
            })
            .unwrap();
        assert_eq!(replay.status, "already_committed");
        assert_eq!(replay.aggregate_seq, None);
        assert_eq!(event_ids(&path).len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remove_part_is_idempotent() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        writer
            .upsert_part(part(
                "prt_a",
                "msg_a",
                1,
                1,
                r#"{"type":"text","text":"a"}"#,
            ))
            .unwrap();
        let removed = writer
            .remove_part(RemovePartInput {
                part_id: "prt_a".to_string(),
                message_id: "msg_a".to_string(),
                time_updated: 2,
                event_id: Some("evt_part_remove".to_string()),
                event_data: None,
            })
            .unwrap();
        assert_eq!(removed.status, "committed");
        assert!(removed.changed);
        let replay = writer
            .remove_part(RemovePartInput {
                part_id: "prt_a".to_string(),
                message_id: "msg_a".to_string(),
                time_updated: 2,
                event_id: Some("evt_part_remove".to_string()),
                event_data: None,
            })
            .unwrap();
        assert_eq!(replay.status, "already_committed");
        assert_eq!(event_ids(&path).len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_fence_returns_revision_conflict() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        let hash = writer.history_hash();

        let stale = SessionWriter::new(options(&path, Some("hh1:stale".to_string())));
        assert!(stale.is_err());

        // A writer pinned to the current hash passes, then updates its own fence.
        let mut fenced = SessionWriter::new(options(&path, Some(hash.clone()))).unwrap();
        let result = fenced
            .upsert_part(part("prt_a", "msg_a", 1, 2, r#"{"type":"text"}"#))
            .unwrap();
        assert_eq!(result.status, "committed");
        assert_ne!(result.history_hash, Some(hash));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_fence_after_external_change_conflicts() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();

        // Simulate a stale held fence: the in-transaction check must reject the write
        // without touching the canonical rows.
        writer.fence = Some("hh1:stale".to_string());
        let result = writer
            .upsert_part(part("prt_a", "msg_a", 1, 3, r#"{"type":"text"}"#))
            .unwrap();
        assert_eq!(result.status, "revision_conflict");
        assert!(!result.changed);
        assert_eq!(result.aggregate_seq, None);

        let connection = Connection::open(&path).unwrap();
        let parts: i64 = connection
            .query_row("SELECT count(*) FROM part", [], |row| row.get(0))
            .unwrap();
        assert_eq!(parts, 0);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fail_after_commit_is_arbitrated_by_probe() {
        let path = database();
        let mut writer = SessionWriter::new(WriterOptions {
            fail_after_commit: Some(true),
            ..options(&path, None)
        })
        .unwrap();
        let mut input = message("msg_a", 1, 1, r#"{"role":"user"}"#);
        input.event_id = Some("evt_msg".to_string());
        input.event_data = Some(r#"{"sessionID":"ses_test"}"#.to_string());
        assert!(writer.upsert_message(input.clone()).is_err());

        let committed_hash = writer.history_hash();
        let probe = writer.probe_message(&input).unwrap();
        assert_eq!(probe.status, "already_committed");
        assert_eq!(probe.history_hash, Some(committed_hash.clone()));

        let mut wrong = input.clone();
        wrong.data = r#"{"role":"assistant"}"#.to_string();
        assert!(writer.probe_message(&wrong).is_err());

        // The injected failure is one-shot; later writes succeed.
        let next = writer
            .upsert_message(message("msg_b", 2, 2, r#"{"role":"user"}"#))
            .unwrap();
        assert_eq!(next.status, "committed");

        // A fresh writer rebuilding from SQLite agrees with the in-memory replica.
        let rebuilt = SessionWriter::new(options(&path, None)).unwrap();
        assert_eq!(rebuilt.history_hash(), writer.history_hash());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn probe_remove_reports_absent_state() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"user"}"#))
            .unwrap();
        writer
            .upsert_part(part("prt_a", "msg_a", 1, 1, r#"{"type":"text"}"#))
            .unwrap();

        let remove = RemoveMessageInput {
            message_id: "msg_a".to_string(),
            time_updated: 2,
            event_id: None,
            event_data: None,
        };
        assert!(writer.probe_remove_message(&remove).is_err());

        writer.remove_message(remove.clone()).unwrap();
        let probe = writer.probe_remove_message(&remove).unwrap();
        assert_eq!(probe.status, "already_committed");

        let remove_part = RemovePartInput {
            part_id: "prt_a".to_string(),
            message_id: "msg_a".to_string(),
            time_updated: 3,
            event_id: None,
            event_data: None,
        };
        assert_eq!(
            writer.probe_remove_part(&remove_part).unwrap().status,
            "already_committed"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn late_message_foreign_key_is_ignored_but_events_commit() {
        let path = database();
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        // Force a session mismatch so the message foreign key fails.
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=ON; DELETE FROM session WHERE id = 'ses_test';")
            .unwrap();
        drop(connection);

        let mut late = message("msg_late", 1, 1, r#"{"role":"user"}"#);
        late.event_id = Some("evt_late".to_string());
        late.event_data = Some(r#"{"sessionID":"ses_test"}"#.to_string());
        let result = writer.upsert_message(late).unwrap();
        assert_eq!(result.status, "committed");
        assert!(!result.changed);
        assert_eq!(result.aggregate_seq, Some(0));

        let connection = Connection::open(&path).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM message", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(event_ids(&path).len(), 1);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tool_result_commits_part_projection_and_events() {
        let path = database();
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute(
                    "INSERT INTO session_message VALUES ('evt_assistant','ses_test','assistant',1,1,?1)",
                    [r#"{"content":[{"type":"tool","id":"call_a","name":"read","state":{"status":"running","input":"{}"},"time":{}}],"time":{}}"#],
                )
                .unwrap();
        }
        let mut writer = SessionWriter::new(options(&path, None)).unwrap();
        writer
            .upsert_message(message("msg_a", 1, 1, r#"{"role":"assistant"}"#))
            .unwrap();
        let result = writer
            .commit_tool_result(ToolResultInput {
                part_id: "prt_a".to_string(),
                message_id: "msg_a".to_string(),
                time_created: 1,
                time_updated: 2,
                part_data: r#"{"type":"tool","state":{"status":"completed","output":"ok"}}"#.to_string(),
                part_event_id: Some("evt_part".to_string()),
                part_event_data: Some(r#"{"sessionID":"ses_test","part":{}}"#.to_string()),
                v2_event_id: Some("evt_tool".to_string()),
                v2_event_data: Some(r#"{"sessionID":"ses_test","callID":"call_a","structured":{},"content":[{"type":"text","text":"ok"}],"provider":{"executed":false},"timestamp":2}"#.to_string()),
                success: true,
            })
            .unwrap();
        assert_eq!(result.status, "committed");
        assert_eq!(result.aggregate_seq, Some(1));

        let connection = Connection::open(&path).unwrap();
        let projected: String = connection
            .query_row(
                "SELECT data FROM session_message WHERE id = 'evt_assistant'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(projected.contains("completed"));
        assert!(projected.contains("ok"));
        let (created, updated): (i64, i64) = connection
            .query_row(
                "SELECT time_created, time_updated FROM part WHERE id = 'prt_a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(created, 1);
        assert_eq!(updated, 2);
        assert_eq!(event_ids(&path).len(), 2);

        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod failure_projection_tests {
    use super::*;

    #[test]
    fn tool_failure_preserves_running_progress_and_updates_projection_timestamp() {
        let path =
            std::env::temp_dir().join(format!("chimera-writer-failure-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE session (id TEXT PRIMARY KEY);
                 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
                 CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER);
                 CREATE TABLE event (id TEXT PRIMARY KEY, seq INTEGER, aggregate_id TEXT, type TEXT, data TEXT);
                 INSERT INTO session (id) VALUES ('ses_test');",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_message VALUES ('evt_assistant','ses_test','assistant',1,1,?1)",
                [r#"{"content":[{"type":"tool","id":"call_a","name":"read","state":{"status":"running","input":{},"structured":{"step":1},"content":[{"type":"text","text":"partial"}]},"time":{}}],"time":{}}"#],
            )
            .unwrap();
        drop(connection);
        let mut writer = SessionWriter::new(WriterOptions {
            db_path: path.to_string_lossy().into_owned(),
            session_id: "ses_test".to_string(),
            expected_history_hash: None,
            event_v2: true,
            workspaces: true,
            fail_after_commit: None,
        })
        .unwrap();
        writer
            .upsert_message(HistoryMessageInput {
                id: "msg_a".to_string(),
                time_created: 1,
                time_updated: 1,
                data: r#"{"role":"assistant"}"#.to_string(),
                event_id: None,
                event_data: None,
            })
            .unwrap();
        writer
            .commit_tool_result(ToolResultInput {
                part_id: "prt_a".to_string(),
                message_id: "msg_a".to_string(),
                time_created: 2,
                time_updated: 9,
                part_data: r#"{"type":"tool","state":{"status":"error","error":"boom"}}"#.to_string(),
                part_event_id: Some("evt_part".to_string()),
                part_event_data: Some(r#"{"sessionID":"ses_test","part":{}}"#.to_string()),
                v2_event_id: Some("evt_tool".to_string()),
                v2_event_data: Some(r#"{"sessionID":"ses_test","callID":"call_a","structured":{},"content":[],"error":{"type":"unknown","message":"boom"},"provider":{"executed":false},"timestamp":9}"#.to_string()),
                success: false,
            })
            .unwrap();

        let connection = Connection::open(&path).unwrap();
        let (updated, projected): (i64, String) = connection
            .query_row(
                "SELECT time_updated, data FROM session_message WHERE id = 'evt_assistant'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(updated, 9);
        let projected: Value = serde_json::from_str(&projected).unwrap();
        let tool = &projected["content"][0];
        assert_eq!(tool["state"]["status"], "error");
        assert_eq!(tool["state"]["structured"], json!({"step":1}));
        assert_eq!(
            tool["state"]["content"],
            json!([{"type":"text","text":"partial"}])
        );
        assert_eq!(tool["state"]["error"]["message"], "boom");
        assert_eq!(tool["time"]["completed"], 9);
        let _ = std::fs::remove_file(path);
    }
}
