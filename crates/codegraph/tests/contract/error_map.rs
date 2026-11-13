//! CoreError mapping table invariants.

use codewhale_codegraph::contract::error_map::{CORE_ERROR_MAP, adapter_message, mapping_for};
use codewhale_codegraph::wire::error::{CoreError, CoreErrorCode};

#[test]
fn every_code_is_mapped_once() {
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
        assert_eq!(mapping_for(code).code, code);
    }
}

#[test]
fn wire_and_defer_prefixes_are_documented() {
    assert!(
        mapping_for(CoreErrorCode::Wire)
            .adapter_message_rule
            .contains("<surface> wire:")
    );
    assert!(
        mapping_for(CoreErrorCode::Defer)
            .adapter_message_rule
            .contains("defer:")
    );
    assert!(
        mapping_for(CoreErrorCode::Wire)
            .ts_detection
            .contains("isStoreWireError")
    );
    assert!(
        mapping_for(CoreErrorCode::Defer)
            .ts_detection
            .contains("defer:")
    );
}

#[test]
fn adapter_message_never_prepends_the_code() {
    let store = CoreError::wire("store wire: abi 2 != 1");
    assert_eq!(adapter_message(&store), "store wire: abi 2 != 1");
    let defer = CoreError::new(CoreErrorCode::Defer, "defer: parse error");
    assert_eq!(adapter_message(&defer), "defer: parse error");
    let closed = CoreError::new(CoreErrorCode::Closed, "store handle is closed");
    assert_eq!(adapter_message(&closed), "store handle is closed");
}

#[test]
fn only_busy_is_retryable_and_matches_the_error_default() {
    for mapping in CORE_ERROR_MAP {
        assert_eq!(
            mapping.retryable,
            mapping.code.retryable_by_default(),
            "mapping and CoreError default disagree for {}",
            mapping.code
        );
    }
    assert!(CoreError::new(CoreErrorCode::Busy, "database is locked").retryable);
    assert!(!CoreError::new(CoreErrorCode::Sql, "constraint failed").retryable);
}
