//! Core error type shared by every graph-core module.
//!
//! The adapter maps a [`CoreError`] onto the NAPI error surface by keeping the
//! message text intact (see [`crate::contract::error_map`]): the existing
//! TypeScript arms match on message substrings such as `store wire`,
//! `store handle`, and `defer:`, so prepending the code would break the
//! fallback/kill-switch paths.

use std::fmt;

/// Stable error codes. These strings are the adapter's mapping vocabulary and
/// must not change without a contract bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CoreErrorCode {
    /// The handle was closed deterministically.
    Closed,
    /// A previous call panicked and poisoned the handle.
    Poisoned,
    /// A wire buffer was truncated, mis-versioned, or otherwise malformed.
    Wire,
    /// The SQLite layer rejected the operation.
    Sql,
    /// Extraction deferred the file to the WASM arm (`defer:` prefix).
    Defer,
    /// The operation is not supported on this surface or platform.
    Unsupported,
    /// A requested row/node/file does not exist.
    NotFound,
    /// The database exists but the graph schema has not been initialized.
    NotInitialized,
    /// SQLite reported contention; the caller may retry.
    Busy,
}

impl CoreErrorCode {
    /// Stable lowercase code string.
    pub const fn as_str(self) -> &'static str {
        match self {
            CoreErrorCode::Closed => "closed",
            CoreErrorCode::Poisoned => "poisoned",
            CoreErrorCode::Wire => "wire",
            CoreErrorCode::Sql => "sql",
            CoreErrorCode::Defer => "defer",
            CoreErrorCode::Unsupported => "unsupported",
            CoreErrorCode::NotFound => "not_found",
            CoreErrorCode::NotInitialized => "not_initialized",
            CoreErrorCode::Busy => "busy",
        }
    }

    /// Default retryability. Only contention is retryable by default; a
    /// caller can override with [`CoreError::with_retryable`].
    pub const fn retryable_by_default(self) -> bool {
        matches!(self, CoreErrorCode::Busy)
    }
}

impl fmt::Display for CoreErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A graph-core failure. `message` is adapter-facing: it must carry the same
/// surface prefix the TypeScript arms already match (`store wire:`,
/// `ctx wire:`, `resolve wire:`, `defer:`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError {
    pub code: CoreErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl CoreError {
    /// Build an error with the code's default retryability.
    pub fn new(code: CoreErrorCode, message: impl Into<String>) -> Self {
        CoreError {
            code,
            message: message.into(),
            retryable: code.retryable_by_default(),
        }
    }

    /// Build a wire-format error. The caller supplies the surface prefix
    /// (`"store wire: ..."`); keeping it out of this constructor lets the
    /// store/ctx/resolve/extract modules stay independent.
    pub fn wire(message: impl Into<String>) -> Self {
        CoreError::new(CoreErrorCode::Wire, message)
    }

    /// Override the default retryability.
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for CoreError {}

/// Shorthand for the crate-wide result type.
pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_busy_is_retryable_by_default() {
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
        let retryable: Vec<_> = codes
            .iter()
            .filter(|code| code.retryable_by_default())
            .collect();
        assert_eq!(retryable, vec![&CoreErrorCode::Busy]);
    }

    #[test]
    fn display_keeps_code_and_message() {
        let error = CoreError::wire("store wire: abi 2 != 1");
        assert_eq!(error.to_string(), "wire: store wire: abi 2 != 1");
        assert_eq!(error.message, "store wire: abi 2 != 1");
    }
}
