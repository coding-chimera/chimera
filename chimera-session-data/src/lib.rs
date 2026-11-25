mod history;
mod spool;
mod writer;

use writer::{
    RemoveMessageInput, RemovePartInput, SessionWriter, ToolResultInput, WriterOptions,
    WriterResult,
};

use history::{
    CompactionView, HistoryCounts, HistoryMessageInput, HistoryPartInput, HistoryReplica,
    HistoryView,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use spool::{Direction, OutputSpool, SpoolFinish};
use std::collections::{HashMap, HashSet};

#[napi]
pub fn history_new(session_id: String) -> Result<u32> {
    let id = NEXT_HISTORY_ID.fetch_add(1, Ordering::Relaxed);
    histories()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history registry poisoned"))?
        .insert(id, Arc::new(Mutex::new(HistoryReplica::new(session_id))));
    Ok(id)
}

fn history(id: u32) -> Result<Arc<Mutex<HistoryReplica>>> {
    histories()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history registry poisoned"))?
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("unknown or closed history: {id}"),
            )
        })
}

#[napi]
pub async fn history_rebuild(session_id: String, db_path: String) -> Result<u32> {
    let replica = tokio::task::spawn_blocking(move || HistoryReplica::rebuild(session_id, db_path))
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("history rebuild join failed: {error}"),
            )
        })?
        .map_err(|error| Error::new(Status::GenericFailure, error))?;
    let id = NEXT_HISTORY_ID.fetch_add(1, Ordering::Relaxed);
    histories()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history registry poisoned"))?
        .insert(id, Arc::new(Mutex::new(replica)));
    Ok(id)
}

#[napi]
pub fn history_upsert_message(id: u32, input: HistoryMessageInput) -> Result<bool> {
    history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .upsert_message(input)
        .map_err(|error| Error::new(Status::GenericFailure, error))
}

#[napi]
pub fn history_upsert_part(id: u32, input: HistoryPartInput) -> Result<bool> {
    history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .upsert_part(input)
        .map_err(|error| Error::new(Status::GenericFailure, error))
}

#[napi]
pub fn history_remove_message(id: u32, message_id: String) -> Result<bool> {
    Ok(history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .remove_message(&message_id))
}

#[napi]
pub fn history_remove_part(id: u32, part_id: String) -> Result<bool> {
    Ok(history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .remove_part(&part_id))
}

#[napi]
pub fn history_hash(id: u32) -> Result<String> {
    Ok(history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .history_hash())
}

#[napi]
pub fn history_counts(id: u32) -> Result<HistoryCounts> {
    Ok(history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .counts())
}
#[napi]
pub fn history_view(id: u32, expected_history_hash: Option<String>) -> Result<HistoryView> {
    history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .view(expected_history_hash.as_deref())
        .map_err(|error| Error::new(Status::GenericFailure, error))
}
#[napi]
pub fn history_compaction_view(
    id: u32,
    mode: String,
    expected_history_hash: Option<String>,
) -> Result<CompactionView> {
    history(id)?
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history handle poisoned"))?
        .compaction_view(&mode, expected_history_hash.as_deref())
        .map_err(|error| Error::new(Status::GenericFailure, error))
}
#[napi]
pub fn history_drop(id: u32) -> Result<bool> {
    Ok(histories()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "history registry poisoned"))?
        .remove(&id)
        .is_some())
}

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static NEXT_SPOOL_ID: AtomicU32 = AtomicU32::new(1);
static SPOOLS: OnceLock<Mutex<HashMap<u32, Arc<Mutex<OutputSpool>>>>> = OnceLock::new();
static NEXT_HISTORY_ID: AtomicU32 = AtomicU32::new(1);
static HISTORIES: OnceLock<Mutex<HashMap<u32, Arc<Mutex<HistoryReplica>>>>> = OnceLock::new();
static NEXT_WRITER_ID: AtomicU32 = AtomicU32::new(1);
static WRITERS: OnceLock<Mutex<HashMap<u32, Arc<Mutex<SessionWriter>>>>> = OnceLock::new();
static ACTIVE_WRITERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_writers() -> &'static Mutex<HashSet<String>> {
    ACTIVE_WRITERS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn writers() -> &'static Mutex<HashMap<u32, Arc<Mutex<SessionWriter>>>> {
    WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn histories() -> &'static Mutex<HashMap<u32, Arc<Mutex<HistoryReplica>>>> {
    HISTORIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn spools() -> &'static Mutex<HashMap<u32, Arc<Mutex<OutputSpool>>>> {
    SPOOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi(object)]
pub struct ContractInfo {
    pub abi_major: u32,
    pub abi_minor: u32,
    pub capabilities: Vec<String>,
}

#[napi]
pub fn contract_info() -> ContractInfo {
    ContractInfo {
        abi_major: 1,
        abi_minor: 0,
        capabilities: vec![
            "tool-output.spool.v1".to_string(),
            "reader.history.v1".to_string(),
            "reader.compaction-view.v1".to_string(),
            "writer.message.v1".to_string(),
            "writer.part.v1".to_string(),
            "writer.remove.v1".to_string(),
            "writer.probe.v1".to_string(),
            "writer.tool-result.v1".to_string(),
        ],
    }
}

#[napi(object)]
pub struct SpoolOptions {
    pub file_path: String,
    pub max_lines: u32,
    pub max_bytes: u32,
    pub direction: String,
}

#[napi]
pub fn spool_start(options: SpoolOptions) -> Result<u32> {
    let direction = match options.direction.as_str() {
        "head" => Direction::Head,
        "tail" => Direction::Tail,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("unknown direction: {other}"),
            ))
        }
    };
    let spool = OutputSpool::new(
        options.file_path,
        options.max_lines,
        options.max_bytes,
        direction,
    )
    .map_err(|error| Error::new(Status::GenericFailure, error))?;
    let id = NEXT_SPOOL_ID.fetch_add(1, Ordering::Relaxed);
    spools()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "spool registry poisoned"))?
        .insert(id, Arc::new(Mutex::new(spool)));
    Ok(id)
}

fn spool(id: u32) -> Result<Arc<Mutex<OutputSpool>>> {
    spools()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "spool registry poisoned"))?
        .get(&id)
        .cloned()
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("unknown or closed spool: {id}")))
}

#[napi]
pub async fn spool_append(id: u32, chunk: Uint8Array) -> Result<()> {
    let spool = spool(id)?;
    tokio::task::spawn_blocking(move || {
        spool
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "spool handle poisoned"))?
            .append(&chunk)
            .map_err(|error| Error::new(Status::GenericFailure, error))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("spool append join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn spool_finish(id: u32) -> Result<SpoolFinish> {
    let spool = spools()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "spool registry poisoned"))?
        .remove(&id)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("unknown or closed spool: {id}")))?;
    let mut spool = Arc::try_unwrap(spool)
        .map_err(|_| Error::new(Status::GenericFailure, "spool still has active writers"))?;
    tokio::task::spawn_blocking(move || {
        spool
            .get_mut()
            .map_err(|_| Error::new(Status::GenericFailure, "spool handle poisoned"))?
            .finish()
            .map_err(|error| Error::new(Status::GenericFailure, error))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("spool finish join failed: {error}"),
        )
    })?
}

#[napi]
pub fn spool_abort(id: u32) -> Result<()> {
    let spool = spools()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "spool registry poisoned"))?
        .remove(&id);
    if let Some(spool) = spool {
        spool
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "spool handle poisoned"))?
            .abort()
            .map_err(|error| Error::new(Status::GenericFailure, error))?;
    }
    Ok(())
}

#[napi]
pub fn writer_new(options: WriterOptions) -> Result<u32> {
    let session_id = options.session_id.clone();
    let writer = SessionWriter::new(options)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    {
        let mut active = active_writers()
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer registry poisoned"))?;
        if !active.insert(session_id.clone()) {
            return Err(Error::new(
                Status::GenericFailure,
                format!("writer already active for session: {session_id}"),
            ));
        }
    }
    let id = NEXT_WRITER_ID.fetch_add(1, Ordering::Relaxed);
    writers()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "writer registry poisoned"))?
        .insert(id, Arc::new(Mutex::new(writer)));
    Ok(id)
}

fn writer(id: u32) -> Result<Arc<Mutex<SessionWriter>>> {
    writers()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "writer registry poisoned"))?
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("unknown or closed writer: {id}"),
            )
        })
}

#[napi]
pub async fn writer_history_hash(id: u32) -> Result<String> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))
            .map(|writer| writer.history_hash())
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer history join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_upsert_message(id: u32, input: HistoryMessageInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .upsert_message(input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer message join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_upsert_part(id: u32, input: HistoryPartInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .upsert_part(input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer part join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_commit_tool_result(id: u32, input: ToolResultInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .commit_tool_result(input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer tool result join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_remove_message(id: u32, input: RemoveMessageInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .remove_message(input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer remove message join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_remove_part(id: u32, input: RemovePartInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .remove_part(input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer remove part join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_probe_message(id: u32, input: HistoryMessageInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .probe_message(&input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer probe message join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_probe_part(id: u32, input: HistoryPartInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .probe_part(&input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer probe part join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_probe_remove_message(
    id: u32,
    input: RemoveMessageInput,
) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .probe_remove_message(&input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer probe remove message join failed: {error}"),
        )
    })?
}

#[napi]
pub async fn writer_probe_remove_part(id: u32, input: RemovePartInput) -> Result<WriterResult> {
    let writer = writer(id)?;
    tokio::task::spawn_blocking(move || {
        writer
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
            .probe_remove_part(&input)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    })
    .await
    .map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("writer probe remove part join failed: {error}"),
        )
    })?
}

#[napi]
pub fn writer_drop(id: u32) -> Result<bool> {
    let removed = writers()
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "writer registry poisoned"))?
        .remove(&id);
    let Some(writer) = removed else {
        return Ok(false);
    };
    let session_id = writer
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "writer handle poisoned"))?
        .session_id()
        .to_string();
    if let Ok(mut active) = active_writers().lock() {
        active.remove(&session_id);
    }
    Ok(true)
}
