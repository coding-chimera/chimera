//! Extraction kernel: tree-sitter parse + extract walkers producing the
//! flat five-table wire (meta/nodes/edges/refs/arena) per file.
//!
//! The ported kernel lives in these modules verbatim; `extract_file` is the
//! plain-Rust entry (no NAPI). Unsupported languages route to the tsjs
//! walker exactly as the kernel's routing did.

/// First statement of every recursive walker function (see stack.rs, #1581):
/// once the stack pointer is inside the red zone, stop descending — the
/// latched flag makes [`stack::run_guarded`] discard the walk and defer the
/// file. `Default::default()` covers every walker return type in use
/// (`()`, `bool`, `Option<_>`, `String`); a hook returning `false` just sends
/// its caller down the generic child walk, whose own guard returns at once.
macro_rules! stack_guard {
    () => {
        if $crate::extract::stack::exhausted() {
            return ::core::default::Default::default();
        }
    };
}

pub mod buffers;
pub mod ccpp;
pub mod cfnptr;
pub mod docstring;
pub mod ids;
pub mod langs;
pub mod python;
pub mod rustlang;
pub mod stack;
pub mod textutil;
pub mod tsjs;

pub use buffers::EmitOut;

/// Extract one file. The whole walk runs under the stack guard
/// ([`stack::run_guarded`]): a file nested deeply enough to overflow this
/// thread's stack comes back as a `defer:` error — the caller's routine
/// "take the fallback path" signal — instead of a SIGSEGV.
pub fn extract_file(file_path: &str, content: &str, language: &str) -> Result<EmitOut, String> {
    stack::run_guarded(|| match language {
        "java" => unimplemented_walker(file_path, content, language),
        "python" => python::extract(file_path, content),
        "go" => unimplemented_walker(file_path, content, language),
        "c" | "cpp" => ccpp::extract(file_path, content, language),
        "rust" => rustlang::extract(file_path, content),
        "csharp" => unimplemented_walker(file_path, content, language),
        "ruby" => unimplemented_walker(file_path, content, language),
        "php" => unimplemented_walker(file_path, content, language),
        "swift" => unimplemented_walker(file_path, content, language),
        "kotlin" => unimplemented_walker(file_path, content, language),
        "r" => unimplemented_walker(file_path, content, language),
        "lua" | "luau" => unimplemented_walker(file_path, content, language),
        "scala" => unimplemented_walker(file_path, content, language),
        "dart" => unimplemented_walker(file_path, content, language),
        "pascal" => unimplemented_walker(file_path, content, language),
        "nix" => unimplemented_walker(file_path, content, language),
        "objc" => unimplemented_walker(file_path, content, language),
        "typescript" | "tsx" | "javascript" | "jsx" => tsjs::extract(file_path, content, language),
        _ => Err(format!(
            "walker for {language} is not ported yet: {file_path}"
        )),
    })
}

fn unimplemented_walker(
    file_path: &str,
    _content: &str,
    language: &str,
) -> Result<EmitOut, String> {
    Err(format!(
        "walker for {language} is not ported yet: {file_path}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_language_is_rejected_instead_of_using_tsjs() {
        let error = match extract_file("sample.unknown", "const answer = 42", "unknown-language") {
            Err(error) => error,
            Ok(_) => panic!("unknown languages must fail closed"),
        };
        assert!(error.contains("unknown-language"), "{error}");
        assert!(error.contains("sample.unknown"), "{error}");
    }
}
