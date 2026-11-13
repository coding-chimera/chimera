//! `CoreError` → adapter mapping table.
//!
//! The existing TypeScript arms match on message text, not on a structured
//! code (`isStoreWireError` in `src/graph/store/bridge.ts` checks
//! `store wire` / `store_open` / `store handle`; the extraction router checks
//! `defer:`). The adapter therefore emits [`CoreError::message`] VERBATIM and
//! never prepends the code. Constructors in each core surface own the prefix:
//!
//! - store: `store wire: …`, `store handle is closed`,
//!   `store handle is poisoned …`;
//! - ctx: `ctx wire: …`, `ctx handle is closed`, `ctx handle is poisoned …`;
//! - resolve: `resolve wire: …`, `resolve handle is closed`;
//! - extract: `extract wire: …`, `defer: …`.

use crate::wire::error::{CoreError, CoreErrorCode};

/// One row of the adapter mapping table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreErrorMapping {
    pub code: CoreErrorCode,
    /// Message contract the adapter must preserve.
    pub adapter_message_rule: &'static str,
    pub retryable: bool,
    /// Existing TS detection this code must keep working.
    pub ts_detection: &'static str,
}

/// The nine stable codes, in enum order.
pub const CORE_ERROR_MAP: [CoreErrorMapping; 9] = [
    CoreErrorMapping {
        code: CoreErrorCode::Closed,
        adapter_message_rule: "verbatim; surface constructors use \"<surface> handle is closed\"",
        retryable: false,
        ts_detection: "benign double-close branch",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Poisoned,
        adapter_message_rule: "verbatim; surface constructors use \"<surface> handle is poisoned …\"",
        retryable: false,
        ts_detection: "handle stays disabled after the first poison",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Wire,
        adapter_message_rule: "verbatim; message starts with \"<surface> wire:\"",
        retryable: false,
        ts_detection: "isStoreWireError matches \"store wire\"",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Sql,
        adapter_message_rule: "verbatim SQLite message",
        retryable: false,
        ts_detection: "generic error path; transaction rolls back",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Defer,
        adapter_message_rule: "verbatim; message starts with \"defer:\"",
        retryable: false,
        ts_detection: "extraction router matches \"defer:\" and falls back to WASM",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Unsupported,
        adapter_message_rule: "verbatim",
        retryable: false,
        ts_detection: "route refuses the call (no silent fallback)",
    },
    CoreErrorMapping {
        code: CoreErrorCode::NotFound,
        adapter_message_rule: "verbatim",
        retryable: false,
        ts_detection: "structured miss; TS returns undefined/empty",
    },
    CoreErrorMapping {
        code: CoreErrorCode::NotInitialized,
        adapter_message_rule: "verbatim",
        retryable: false,
        ts_detection: "read-only graph surfaces return initialized:false",
    },
    CoreErrorMapping {
        code: CoreErrorCode::Busy,
        adapter_message_rule: "verbatim",
        retryable: true,
        ts_detection: "caller may retry; busy_timeout already applied",
    },
];

/// Adapter-facing message: the message text, unchanged.
pub fn adapter_message(error: &CoreError) -> &str {
    &error.message
}

/// Look up the mapping row for a code.
pub fn mapping_for(code: CoreErrorCode) -> &'static CoreErrorMapping {
    CORE_ERROR_MAP
        .iter()
        .find(|mapping| mapping.code == code)
        .expect("CORE_ERROR_MAP covers every CoreErrorCode")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_exactly_one_row() {
        let codes = [
            CoreErrorCode::Closed,
            CoreErrorCode::Poisoned,
            CoreErrorCode::Wire,
            CoreErrorCode::Sql,
            CoreErrorCode::Defer,
            CoreErrorCode::Unsupported,
            CoreErrorCode::NotFound,
            CoreErrorCode::NotInitialized,
            CoreErrorCode::Busy,
        ];
        assert_eq!(CORE_ERROR_MAP.len(), codes.len());
        for code in codes {
            let matches = CORE_ERROR_MAP
                .iter()
                .filter(|mapping| mapping.code == code)
                .count();
            assert_eq!(matches, 1, "code {code} must have exactly one row");
        }
    }

    #[test]
    fn adapter_message_is_verbatim() {
        let error = CoreError::wire("store wire: abi 2 != 1");
        assert_eq!(adapter_message(&error), "store wire: abi 2 != 1");
    }

    #[test]
    fn only_busy_is_retryable() {
        let retryable: Vec<_> = CORE_ERROR_MAP
            .iter()
            .filter(|mapping| mapping.retryable)
            .collect();
        assert_eq!(retryable.len(), 1);
        assert_eq!(retryable[0].code, CoreErrorCode::Busy);
    }
}
