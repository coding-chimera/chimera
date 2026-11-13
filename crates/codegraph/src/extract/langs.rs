//! Grammar registry: codegraph `Language` string → native tree-sitter grammar.
//!
//! Mirrors the wasm side's `WASM_GRAMMAR_FILES` mapping (src/extraction/
//! grammars.ts): `tsx` and `jsx` reuse another language's grammar exactly the
//! way the wasm map does. The kernel-grammar-parity test asserts each entry is
//! built from the SAME grammar revision as the vendored wasm — bump the crate
//! and the wasm together.
//!
//! (R1 shipped a generic `.scm`-query emitter here; R2 replaced it with the
//! bespoke per-language walker — see tsjs/ and the migration plan §3a — because
//! extraction parity needs logic queries can't express. New languages add a
//! grammar entry + a walker module.)
//!
//! KNOWN LIMITATION: the six vendored-C grammars (kotlin, lua, scala, dart,
//! nix, objc) are NOT linked in this crate — their walkers are not ported
//! yet, so their entries are absent from `grammar_for`. Re-adding one means
//! vendoring its generated C plus the extern shim and adding the walker.

use tree_sitter::Language;

/// Languages this kernel binary can extract (reported by contractInfo;
/// TS-side routing policy decides what actually routes).
pub const LANGUAGES: [&str; 23] = [
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "java",
    "python",
    "go",
    "c",
    "cpp",
    "rust",
    "csharp",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "r",
    "lua",
    "luau",
    "scala",
    "dart",
    "pascal",
    "nix",
    "objc",
];

pub fn grammar_for(language: &str) -> Option<Language> {
    match language {
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "javascript" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        // `.metal`/`.cu`/`.cuh` map to language 'cpp' at detectLanguage, so the
        // dialects ride this grammar too (their blanking pre-passes stay
        // TS-side — the route point applies preParse before the kernel call).
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        // R7b: v0.24.2, sha-matched with the vendored wasm (grammars.ts).
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        // R7b: 0.23.5, table-identical to the vendored ABI-15 wasm (#717;
        // verified against the crates.io tarball — csharp checklist header).
        "csharp" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        // R7b: v0.23.1, sha-matched with the vendored wasm (grammars.ts).
        // Content bump only — the tag's parser.c is still ABI 14.
        "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
        // R7b: v0.24.2, the full HTML-interleaving variant — LANGUAGE_PHP,
        // NEVER LANGUAGE_PHP_ONLY (which errors on leading HTML).
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        // R7b: crate 0.7.3 — the vendored wasm is built from this crate's own
        // tarball src/ (table identity by construction; see grammars.ts).
        "swift" => Some(tree_sitter_swift::LANGUAGE.into()),
        // R7b batch 4: crate =1.2.0, sha-identical to the r-lib v1.2.0 tag
        // the vendored wasm was built from (r checklist §Grammar prep).
        "r" => Some(tree_sitter_r::LANGUAGE.into()),
        // R7b batch 4: crate =1.2.0, sha-identical to the v1.2.0 tag the
        // vendored wasm was built from (lua-luau checklist §Grammar prep).
        "luau" => Some(tree_sitter_luau::LANGUAGE.into()),
        // W1: Isopod/tree-sitter-pascal =0.10.2 crate, table-identical to the
        // vendored wasm (ABI 14, 371 kinds / 38 fields). Only parser.c.
        "pascal" => Some(tree_sitter_pascal::LANGUAGE.into()),
        _ => None,
    }
}
