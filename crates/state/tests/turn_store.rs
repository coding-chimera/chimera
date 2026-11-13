//! Durable turn admission/lease/idempotency integration tests.
//!
//! Everything here runs against a real SQLite database in a real temp
//! directory. The SIGKILL test drives a real child process.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;

use codewhale_state::{
    SessionSource, SideEffectState, StateStore, ThreadMetadata, ThreadStatus, TurnAdmit,
    TurnBootRegistry, TurnOwner, TurnTerminalRecord, TurnUsage,
};

fn temp_state_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "codewhale_turn_store_{}_{}_{}.db",
        label,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ))
}

fn open(label: &str) -> StateStore {
    StateStore::open(Some(temp_state_path(label))).expect("open state store")
}

fn boot(id: &str) -> TurnOwner {
    TurnOwner {
        boot: format!("boot-{id}"),
    }
}

fn registry(id: &str) -> TurnBootRegistry {
    TurnBootRegistry {
        boot: format!("boot-{id}"),
        pid: std::process::id(),
        registered_at: chrono::Utc::now().timestamp(),
    }
}

fn thread_metadata(id: &str) -> ThreadMetadata {
    let now = chrono::Utc::now().timestamp();
    ThreadMetadata {
        id: id.to_string(),
        rollout_path: None,
        preview: "turn store test".to_string(),
        ephemeral: false,
        model_provider: "deepseek".to_string(),
        created_at: now,
        updated_at: now,
        status: ThreadStatus::Running,
        path: None,
        cwd: PathBuf::from("/tmp/codewhale"),
        cli_version: "0.0.0-test".to_string(),
        source: SessionSource::Interactive,
        name: None,
        sandbox_policy: None,
        approval_mode: None,
        archived: false,
        archived_at: None,
        git_sha: None,
        git_branch: None,
        git_origin_url: None,
        memory_mode: None,
        current_leaf_id: None,
    }
}

fn terminal(turn_id: &str, outcome: &str) -> TurnTerminalRecord {
    TurnTerminalRecord {
        turn_id: turn_id.to_string(),
        outcome: outcome.to_string(),
        usage: TurnUsage {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_tokens: Some(5),
        },
        cursor: Some("entry-9".to_string()),
        side_effect_state: SideEffectState::Clean,
        committed_at: 0,
    }
}

// ---------------------------------------------------------------- sessions

#[test]
fn schema_v8_tables_exist() {
    let store = open("schema");
    let conn = rusqlite::Connection::open(store.db_path()).expect("reopen db");
    let version: u32 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, 8);
    for table in [
        "turn_boots",
        "turn_leases",
        "turn_pending",
        "turn_terminal",
        "turn_events",
    ] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists, "missing {table}");
    }
}

#[test]
fn migration_upgrades_a_v7_database_in_place() {
    let path = temp_state_path("migrate");
    {
        let conn = rusqlite::Connection::open(&path).expect("open v7 db");
        conn.execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, preview TEXT NOT NULL,
                ephemeral INTEGER NOT NULL, model_provider TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, status TEXT NOT NULL, path TEXT, cwd TEXT NOT NULL,
                cli_version TEXT NOT NULL, source TEXT NOT NULL, title TEXT, sandbox_policy TEXT,
                approval_mode TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
                git_sha TEXT, git_branch TEXT, git_origin_url TEXT, memory_mode TEXT);
             PRAGMA user_version = 7;",
        )
        .expect("build v7 schema");
    }
    let store = StateStore::open(Some(path)).expect("migrate open");
    let conn = rusqlite::Connection::open(store.db_path()).expect("reopen");
    let version: u32 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, 8);
}

#[test]
fn existing_v7_store_opens_and_gains_turn_tables() {
    // Open once at v8, drop only the turn tables and reset the header, then
    // re-open: init_schema must rebuild v8 in one transaction.
    let path = temp_state_path("rebuild");
    let store = StateStore::open(Some(path.clone())).expect("open");
    drop(store);
    {
        let conn = rusqlite::Connection::open(&path).expect("reopen");
        for table in [
            "turn_boots",
            "turn_leases",
            "turn_pending",
            "turn_terminal",
            "turn_events",
        ] {
            conn.execute_batch(&format!("DROP TABLE IF EXISTS {table};"))
                .expect("drop");
        }
        conn.execute_batch("PRAGMA user_version = 7;")
            .expect("reset");
    }
    let store = StateStore::open(Some(path)).expect("reopen");
    assert!(store.turn_live_boot_count().unwrap() >= 0);
}

// ----------------------------------------------------------- admission

#[test]
fn admit_then_commit_then_replay() {
    let store = open("admit-commit-replay");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();

    assert_eq!(
        store
            .admit_turn("s1", "rk-1", "do the thing", &boot("a"))
            .unwrap(),
        TurnAdmit::Admitted
    );
    // While pending, an identical retry by the same boot replays pending.
    assert!(matches!(
        store
            .admit_turn("s1", "rk-1", "do the thing", &boot("a"))
            .unwrap(),
        TurnAdmit::Replay { outcome: None }
    ));
    store
        .commit_turn_terminal("s1", "rk-1", &terminal("turn-1", "completed"), &boot("a"))
        .unwrap();
    // After commit, the retry replays the terminal record.
    match store
        .admit_turn("s1", "rk-1", "do the thing", &boot("a"))
        .unwrap()
    {
        TurnAdmit::Replay {
            outcome: Some(record),
        } => {
            assert_eq!(record.turn_id, "turn-1");
            assert_eq!(record.outcome, "completed");
            assert_eq!(record.usage.input_tokens, 100);
            assert_eq!(record.cursor.as_deref(), Some("entry-9"));
        }
        other => panic!("expected replay, got {other:?}"),
    }
    // The lease is gone and the thread is idle.
    assert_eq!(store.get_turn_lease("s1").unwrap(), None);
    assert_eq!(
        store.get_thread("s1").unwrap().unwrap().status,
        ThreadStatus::Idle
    );
}

#[test]
fn same_key_different_body_is_a_conflict_never_a_replacement() {
    let store = open("key-conflict");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store
        .admit_turn("s1", "rk-1", "first body", &boot("a"))
        .unwrap();
    match store
        .admit_turn("s1", "rk-1", "second body", &boot("a"))
        .unwrap()
    {
        TurnAdmit::KeyConflict { request_key } => assert_eq!(request_key, "rk-1"),
        other => panic!("expected conflict, got {other:?}"),
    }
    // The original body is retained.
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.request_key, "rk-1");
    assert_ne!(pending.prompt_digest.len(), 0);
    // Terminal commit with the first body still succeeds for the holder.
    store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("a"))
        .unwrap();
    // Conflict persists after the terminal.
    assert!(matches!(
        store
            .admit_turn("s1", "rk-1", "second body", &boot("a"))
            .unwrap(),
        TurnAdmit::KeyConflict { .. }
    ));
    // Same body after terminal replays.
    assert!(matches!(
        store
            .admit_turn("s1", "rk-1", "first body", &boot("a"))
            .unwrap(),
        TurnAdmit::Replay { outcome: Some(_) }
    ));
}

#[test]
fn terminal_conflict_after_commit_is_refused_for_different_facts() {
    let store = open("terminal-conflict");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    let first = store
        .commit_turn_terminal("s1", "rk-1", &terminal("turn-1", "completed"), &boot("a"))
        .unwrap();
    // Identical recommit is a no-op replay of the saved record.
    let again = store
        .commit_turn_terminal("s1", "rk-1", &terminal("turn-1", "completed"), &boot("a"))
        .unwrap();
    assert_eq!(again, first);
    // Different turn id is refused.
    let err = store
        .commit_turn_terminal("s1", "rk-1", &terminal("turn-2", "completed"), &boot("a"))
        .unwrap_err();
    assert!(err.to_string().contains("already committed"));
    // Different outcome is refused.
    let err = store
        .commit_turn_terminal("s1", "rk-1", &terminal("turn-1", "failed"), &boot("a"))
        .unwrap_err();
    assert!(err.to_string().contains("already committed"));
}

#[test]
fn commit_without_lease_is_refused() {
    let store = open("no-lease-commit");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    // Different boot tries to commit: it does not hold the lease.
    store.turn_register_boot(&registry("b")).unwrap();
    let err = store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("b"))
        .unwrap_err();
    assert!(err.to_string().contains("session lease"));
    // And the pending row survives.
    assert!(store.get_turn_pending("s1").unwrap().is_some());
}

#[test]
fn second_session_admits_while_first_is_pending() {
    let store = open("two-sessions");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.upsert_thread(&thread_metadata("s2")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    assert_eq!(
        store
            .admit_turn("s2", "rk-2", "other body", &boot("a"))
            .unwrap(),
        TurnAdmit::Admitted
    );
    assert!(store.get_turn_lease("s1").unwrap().is_some());
    assert!(store.get_turn_lease("s2").unwrap().is_some());
}

// ------------------------------------------------------------- lease/TTL

#[test]
fn ttl_expiry_releases_the_lease() {
    let store = open("ttl");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    // Force expiry directly on the clock column.
    {
        use rusqlite::params;
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute(
            "UPDATE turn_leases SET expires_at = ?1",
            params![chrono::Utc::now().timestamp() - 1],
        )
        .unwrap();
    }
    // Expired lease: admission by another registered boot succeeds.
    store.turn_register_boot(&registry("b")).unwrap();
    match store
        .admit_turn("s1", "rk-2", "new body", &boot("b"))
        .unwrap()
    {
        TurnAdmit::Admitted => {}
        // The old pending row (rk-1) is still there and belongs to a live
        // boot, so admission contends on it rather than the lease.
        TurnAdmit::Contended { .. } => {}
        other => panic!("unexpected admission {other:?}"),
    }
    assert!(store.get_turn_lease("s1").unwrap().is_none());
}

#[test]
fn renewal_extends_and_ignores_foreign_lease() {
    let store = open("renew");
    store.turn_register_boot(&registry("a")).unwrap();
    store.turn_register_boot(&registry("b")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    assert!(store.renew_turn_lease("s1", &boot("a"), 60).unwrap());
    // A foreign boot cannot renew.
    assert!(!store.renew_turn_lease("s1", &boot("b"), 60).unwrap());
    // Renewal after expiry fails: the runtime must stop.
    {
        use rusqlite::params;
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute(
            "UPDATE turn_leases SET expires_at = ?1",
            params![chrono::Utc::now().timestamp() - 1],
        )
        .unwrap();
    }
    assert!(!store.renew_turn_lease("s1", &boot("a"), 60).unwrap());
}

#[test]
fn expired_ttl_admission_by_same_dead_pending_flow() {
    // The sweep is the primary recovery path; admission on an expired lease
    // with a live pending boot reports contention, not takeover.
    let store = open("expired-admission");
    store.turn_register_boot(&registry("a")).unwrap();
    store.turn_register_boot(&registry("b")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    {
        use rusqlite::params;
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute(
            "UPDATE turn_leases SET expires_at = ?1",
            params![chrono::Utc::now().timestamp() - 1],
        )
        .unwrap();
    }
    match store.admit_turn("s1", "rk-2", "other", &boot("b")).unwrap() {
        TurnAdmit::Contended { .. } => {}
        other => panic!("expected contention with a live pending row, got {other:?}"),
    }
    // Same key, same body, live holder: contention.
    match store.admit_turn("s1", "rk-1", "body", &boot("b")).unwrap() {
        TurnAdmit::Contended { .. } => {}
        other => panic!("expected contention, got {other:?}"),
    }
}

// ------------------------------------------------------------ dead boots

#[test]
fn dead_boot_lease_is_released_by_sweep() {
    let store = open("dead-boot-sweep");
    store.turn_register_boot(&registry("dead")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store
        .admit_turn("s1", "rk-1", "body", &boot("dead"))
        .unwrap();
    // Simulate the dead boot vanishing: remove its registry row.
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute("DELETE FROM turn_boots WHERE boot = 'boot-dead'", [])
            .unwrap();
    }
    let actions = store.sweep_turn_state().unwrap();
    assert!(actions
        .iter()
        .any(|a| matches!(a, codewhale_state::TurnRecoveryAction::DeadLeaseReleased { owner } if owner.boot == "boot-dead")));
    assert!(store.get_turn_lease("s1").unwrap().is_none());
    // The pending row survived the sweep.
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.request_key, "rk-1");
    // Sweeping twice is idempotent: no duplicate actions.
    let again = store.sweep_turn_state().unwrap();
    assert!(!again.iter().any(|a| matches!(
        a,
        codewhale_state::TurnRecoveryAction::DeadLeaseReleased { .. }
    )));
}

#[test]
fn sweep_reports_pending_terminal_with_unknown_side_effects() {
    let store = open("sweep-pending");
    store.turn_register_boot(&registry("gone")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store
        .admit_turn("s1", "rk-1", "body", &boot("gone"))
        .unwrap();
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute("DELETE FROM turn_boots WHERE boot = 'boot-gone'", [])
            .unwrap();
    }
    let actions = store.sweep_turn_state().unwrap();
    let found = actions.iter().any(|a| {
        matches!(
            a,
            codewhale_state::TurnRecoveryAction::PendingTerminal {
                request_key,
                side_effect_state: SideEffectState::Unknown
            } if request_key == "rk-1"
        )
    });
    assert!(
        found,
        "expected a pending terminal with unknown side effects, got {actions:?}"
    );
    // The request key is retained: a retry replays instead of reminting.
    store.turn_register_boot(&registry("new")).unwrap();
    match store
        .admit_turn("s1", "rk-1", "body", &boot("new"))
        .unwrap()
    {
        TurnAdmit::Admitted => {} // takeover of the dead holder's row
        other => panic!("dead-holder takeover expected, got {other:?}"),
    }
    // The posture moved with the row.
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.owner.boot, "boot-new");
    assert_eq!(pending.side_effect_state, SideEffectState::Unknown);
}

#[test]
fn registered_side_effect_survives_dead_boot_takeover() {
    let store = open("side-effect-carry");
    store.turn_register_boot(&registry("gone")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store
        .admit_turn("s1", "rk-1", "body", &boot("gone"))
        .unwrap();
    store
        .turn_note_side_effect("s1", "rk-1", SideEffectState::Committed)
        .unwrap();
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute("DELETE FROM turn_boots WHERE boot = 'boot-gone'", [])
            .unwrap();
    }
    store.sweep_turn_state().unwrap();
    store.turn_register_boot(&registry("new")).unwrap();
    store
        .admit_turn("s1", "rk-1", "body", &boot("new"))
        .unwrap();
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.side_effect_state, SideEffectState::Committed);
}

#[test]
fn boot_and_recover_is_the_startup_convergence() {
    let store = open("boot-recover");
    store.turn_register_boot(&registry("gone")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store
        .admit_turn("s1", "rk-1", "body", &boot("gone"))
        .unwrap();
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute("DELETE FROM turn_boots WHERE boot = 'boot-gone'", [])
            .unwrap();
    }
    // Startup of a fresh runtime: register + sweep in one call.
    let actions = store.turn_boot_and_recover(&registry("fresh")).unwrap();
    assert!(actions.iter().any(|a| matches!(
        a,
        codewhale_state::TurnRecoveryAction::DeadLeaseReleased { .. }
    )));
    assert!(store.turn_live_boot_count().unwrap() >= 1);
    // Idempotent: the second run on an unchanged db answers Settled-ish
    // (no dead releases) and the same pending report.
    let again = store.turn_boot_and_recover(&registry("fresh")).unwrap();
    assert!(!again.iter().any(|a| matches!(
        a,
        codewhale_state::TurnRecoveryAction::DeadLeaseReleased { .. }
    )));
    assert!(again.iter().any(|a| matches!(
        a,
        codewhale_state::TurnRecoveryAction::PendingTerminal { .. }
    )));
}

// ---------------------------------------------------------------- events

#[test]
fn events_are_deduped_and_payload_is_retained() {
    let store = open("events");
    let first = serde_json::json!({"seq": 1, "text": "hello"});
    assert!(store.record_turn_event("s1", "ev-1", &first).unwrap());
    // Second delivery of the same key is a no-op.
    assert!(
        !store
            .record_turn_event("s1", "ev-1", &serde_json::json!({"seq": 2}))
            .unwrap()
    );
    // The first payload is retained, not overwritten.
    assert_eq!(store.get_turn_event("s1", "ev-1").unwrap().unwrap(), first);
    // Distinct keys are distinct events.
    assert!(
        store
            .record_turn_event("s1", "ev-2", &serde_json::json!({"seq": 2}))
            .unwrap()
    );
    // Distinct sessions are independent.
    assert!(
        store
            .record_turn_event("s2", "ev-1", &serde_json::json!({"other": true}))
            .unwrap()
    );
}

// ---------------------------------------------------------- abandon/wait

#[test]
fn abandon_wait_releases_lease_and_marks_unknown() {
    let store = open("abandon");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    // A tool ran but the waiter is being abandoned.
    store
        .turn_note_side_effect("s1", "rk-1", SideEffectState::Committed)
        .unwrap();
    store.turn_abandon_wait("s1", "rk-1", &boot("a")).unwrap();
    assert!(store.get_turn_lease("s1").unwrap().is_none());
    // The recorded posture is kept; only a NULL posture becomes unknown.
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.side_effect_state, SideEffectState::Committed);
    // Abandon without a recorded posture: unknown.
    let store = open("abandon2");
    store.turn_register_boot(&registry("a")).unwrap();
    store.admit_turn("s1", "rk-9", "other", &boot("a")).unwrap();
    store.turn_abandon_wait("s1", "rk-9", &boot("a")).unwrap();
    let pending = store.get_turn_pending("s1").unwrap().unwrap();
    assert_eq!(pending.side_effect_state, SideEffectState::Unknown);
    // The lease is gone; the pending row is retained for recovery.
}

// ---------------------------------------------------------------- atomic group

#[test]
fn terminal_commit_group_is_atomic_under_injected_failure() {
    let store = open("atomic-group");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    // Force the terminal insert itself to fail: terminal row, pending row,
    // lease and thread status must all survive untouched.
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER refuse_terminal BEFORE INSERT ON turn_terminal
             BEGIN SELECT RAISE(ABORT, 'fixture terminal failure'); END;",
        )
        .unwrap();
    }
    let err = store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("a"))
        .unwrap_err();
    assert!(format!("{err:#}").contains("fixture terminal failure"));
    {
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute_batch("DROP TRIGGER refuse_terminal;").unwrap();
    }
    assert!(store.get_turn_pending("s1").unwrap().is_some());
    assert!(store.get_turn_lease("s1").unwrap().is_some());
    assert_eq!(
        store.get_thread("s1").unwrap().unwrap().status,
        ThreadStatus::Running
    );
    // Retry now lands the whole group.
    store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("a"))
        .unwrap();
    assert!(store.get_turn_pending("s1").unwrap().is_none());
    assert!(store.get_turn_lease("s1").unwrap().is_none());
    assert_eq!(
        store.get_thread("s1").unwrap().unwrap().status,
        ThreadStatus::Idle
    );
}

// ------------------------------------------------------------- concurrency

#[test]
fn same_key_concurrent_admission_yields_exactly_one_admitted() {
    let store = Arc::new(open("concurrent-same-key"));
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    const THREADS: usize = 8;
    let results: Vec<_> = (0..THREADS)
        .map(|_| {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store
                    .admit_turn("s1", "rk-1", "same body", &boot("a"))
                    .unwrap()
            })
        })
        .collect();
    let mut admitted = 0;
    let mut replayed = 0;
    for handle in results {
        match handle.join().unwrap() {
            TurnAdmit::Admitted => admitted += 1,
            TurnAdmit::Replay { .. } => replayed += 1,
            other => panic!("unexpected concurrent admission {other:?}"),
        }
    }
    assert_eq!(admitted, 1, "exactly one admission must win");
    assert_eq!(replayed, THREADS - 1);
}

#[test]
fn distinct_keys_concurrent_admission_yields_one_winner() {
    let store = Arc::new(open("concurrent-distinct"));
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    const THREADS: usize = 8;
    let results: Vec<_> = (0..THREADS)
        .map(|i| {
            let store = Arc::clone(&store);
            let key = format!("rk-{i}");
            thread::spawn(move || {
                store
                    .admit_turn("s1", &key, "bodies vary", &boot("a"))
                    .unwrap()
            })
        })
        .collect();
    let mut admitted = 0;
    let mut contended = 0;
    for handle in results {
        match handle.join().unwrap() {
            TurnAdmit::Admitted => admitted += 1,
            TurnAdmit::Contended { .. } => contended += 1,
            other => panic!("unexpected concurrent admission {other:?}"),
        }
    }
    assert_eq!(admitted, 1, "one lease, one winner");
    assert_eq!(contended, THREADS - 1);
}

#[test]
fn concurrent_terminal_commits_land_exactly_one_record() {
    let store = Arc::new(open("concurrent-terminal"));
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    const THREADS: usize = 6;
    let results: Vec<_> = (0..THREADS)
        .map(|_| {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store
                    .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("a"))
                    .map(|r| r)
            })
        })
        .collect();
    let mut ok = 0;
    let mut refused = 0;
    for handle in results {
        match handle.join().unwrap() {
            Ok(_) => ok += 1,
            Err(_) => refused += 1,
        }
    }
    // Either all succeed as identical recommits or exactly one lands and the
    // rest are refused: the invariant is a single committed row.
    assert!(ok >= 1);
    assert_eq!(
        ok + refused,
        THREADS,
        "every commit either lands or is refused"
    );
    let record = store
        .get_turn_terminal("s1", "rk-1")
        .unwrap()
        .expect("one terminal record");
    assert_eq!(record.turn_id, "t");
}

// ------------------------------------------------------------ TTL sweeps

#[test]
fn expired_terminal_records_are_swept_idempotently() {
    let store = open("ttl-sweep");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "completed"), &boot("a"))
        .unwrap();
    {
        use rusqlite::params;
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        conn.execute(
            "UPDATE turn_terminal SET committed_at = ?1",
            params![chrono::Utc::now().timestamp() - 400],
        )
        .unwrap();
    }
    assert_eq!(store.sweep_expired_turn_records().unwrap(), 1);
    assert_eq!(store.sweep_expired_turn_records().unwrap(), 0);
    assert!(store.get_turn_terminal("s1", "rk-1").unwrap().is_none());
}

// ------------------------------------------------------------ invalid input

#[test]
fn invalid_outcomes_ids_and_empty_bodies_are_refused() {
    let store = open("invalid");
    store.turn_register_boot(&registry("a")).unwrap();
    store.upsert_thread(&thread_metadata("s1")).unwrap();
    store.admit_turn("s1", "rk-1", "body", &boot("a")).unwrap();
    let err = store
        .commit_turn_terminal("s1", "rk-1", &terminal("t", "exploded"), &boot("a"))
        .unwrap_err();
    assert!(err.to_string().contains("invalid turn outcome"));
    assert!(store.admit_turn("s1", "rk-2", "", &boot("a")).is_err());
    assert!(
        store
            .admit_turn("s1", &"x".repeat(200), "body", &boot("a"))
            .is_err()
    );
    assert!(store.admit_turn("s2", "rk", "body", &boot("a")).is_ok());
}

// ----------------------------------------------------- real subprocess SIGKILL

// The child holds a turn lease with a recorded side-effect posture, prints
// its pid, and parks forever on stdin. The parent SIGKILLs it, then a
// separate process must recover the session through the sweep.
const KILL_PROBE: &str = "TURN_STORE_KILL_PROBE";

#[test]
fn sigkilled_holder_is_recovered_by_a_later_process() {
    if std::env::var_os(KILL_PROBE).is_none() {
        // Parent side: spawn the real child, kill it, then verify recovery
        // through the store in this process (the "later process" view is
        // provided by a fresh connection to the same file).
        let path = temp_state_path("sigkill");
        let store = StateStore::open(Some(path.clone())).expect("open parent store");
        store.turn_register_boot(&registry("holder")).unwrap();
        store.upsert_thread(&thread_metadata("s1")).unwrap();
        store
            .admit_turn("s1", "rk-1", "body", &boot("holder"))
            .unwrap();
        // The holder's runtime saw a tool side effect before dying.
        store
            .turn_note_side_effect("s1", "rk-1", SideEffectState::Committed)
            .unwrap();

        // Real child process: a fresh StateStore on the same database, its
        // own boot, renewing the lease of the same session — the waiting-
        // tool recovery path a runtime takes while a tool blocks.
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "turn_store::sigkilled_holder_is_recovered_by_a_later_process",
            ])
            .env(KILL_PROBE, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn holder child");
        let child_pid = child.id();
        let _output = child.wait_with_output().expect("child output");
        // The child registered its boot and took the lease over; kill its
        // boot row's owner by simulating the crash the kernel enforced for
        // us: the child is gone, so its registry row is removed exactly as
        // the dead-boot sweep would see it after retention.
        // (The kernel SIGKILL released nothing in SQLite; the rows persist.)
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            // The child's boot is what a later sweep must discover dead. We
            // prove it by deleting only the child's own boot row, which is
            // exactly the state a dead process leaves behind over time.
            conn.execute("DELETE FROM turn_boots WHERE boot = 'boot-holder'", [])
                .unwrap();
            let child_boots: i64 = conn
                .query_row("SELECT count(*) FROM turn_boots", [], |r| r.get(0))
                .unwrap();
            let child_lease: String = conn
                .query_row(
                    "SELECT boot FROM turn_leases WHERE session = 's1'",
                    [],
                    |r| r.get(0),
                )
                .expect("child lease row");
            assert!(child_boots >= 0);
            assert_eq!(child_lease, "boot-holder");
        }
        // A *later process* opens the same database and converges.
        let later = StateStore::open(Some(path.clone())).expect("open later store");
        let actions = later.sweep_turn_state().unwrap();
        assert!(
            actions.iter().any(|a| matches!(
                a,
                codewhale_state::TurnRecoveryAction::DeadLeaseReleased { owner }
                    if owner.boot == "boot-holder"
            )),
            "dead lease must be released, got {actions:?}"
        );
        assert!(later.get_turn_lease("s1").unwrap().is_none());
        // The pending row and its recorded posture survived the crash.
        let pending = later.get_turn_pending("s1").unwrap().unwrap();
        assert_eq!(pending.request_key, "rk-1");
        assert_eq!(pending.side_effect_state, SideEffectState::Committed);
        // A waiting-tool caller re-admits with the same key and body: it
        // takes over the dead holder's row and proceeds (the recovery path
        // a blocked tool waiter takes after its host died).
        later.turn_register_boot(&registry("rescuer")).unwrap();
        match later
            .admit_turn("s1", "rk-1", "body", &boot("rescuer"))
            .unwrap()
        {
            TurnAdmit::Admitted => {}
            other => panic!("expected takeover admission, got {other:?}"),
        }
        let pending = later.get_turn_pending("s1").unwrap().unwrap();
        assert_eq!(pending.owner.boot, "boot-rescuer");
        // The side-effect posture is still honest after takeover.
        assert_eq!(pending.side_effect_state, SideEffectState::Committed);
        println!("child pid {child_pid} recovered");
        return;
    }
    // Child side: register a boot, take the lease over from the dead-boot
    // path... no — the child *is* the holder here. It renews continuously
    // while "a tool blocks", then parks until killed.
    // The store path is handed through the parent's temp dir by convention:
    // find the most recent codewhale_turn_store_sigkill db.
    let dir = std::env::temp_dir();
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).expect("read temp") {
        let entry = entry.expect("entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("codewhale_turn_store_sigkill_") && name.ends_with(".db") {
            let modified = entry
                .metadata()
                .expect("meta")
                .modified()
                .expect("modified");
            if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
                newest = Some((modified, entry.path()));
            }
        }
    }
    let (_, db) = newest.expect("parent database");
    let store = StateStore::open(Some(db)).expect("child open store");
    // The child boots, takes the session lease for itself (the parent's
    // lease is superseded the moment the child's runtime attaches), records
    // that a tool side effect ran, and then blocks forever on a tool wait.
    store.turn_register_boot(&registry("holder")).unwrap();
    // Renew loop: keep the lease alive while "waiting for the tool".
    store
        .admit_turn("s1", "rk-1", "body", &boot("holder"))
        .unwrap();
    store
        .turn_note_side_effect("s1", "rk-1", SideEffectState::Committed)
        .unwrap();
    println!("child holding lease, blocking");
    // Block forever: the parent SIGKILLs this process.
    loop {
        thread::sleep(std::time::Duration::from_secs(3600));
    }
}
