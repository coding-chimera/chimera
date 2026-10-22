//! Objective-C extraction — a faithful Rust port of
//! `languages/objc.ts`'s config over the generic `TreeSitterExtractor`.
//!
//! Objective-C is a C superset, so the walker is the ccpp module's C
//! declaration machinery plus the ObjC semantics the extractor config layers
//! on top (Variant::Objc in `ccpp/mod.rs`):
//!  - `@interface` (`class_interface`) mints the class node and the
//!    `extends` / `implements` refs (`: Super <ProtoA, ProtoB>`);
//!    `@implementation` (`class_implementation`) REUSES the same-file class
//!    node (or mints one) and walks only its `implementation_definition`
//!    children — no extends edge, no docstring.
//!  - `@protocol` (`protocol_declaration`) is an `interface`-kind node with
//!    kind `protocol`.
//!  - method selectors join their `method` keywords: `greet`, `doThing:`,
//!    `doThing:with:`; a leading `+` marks a static (class) method; the
//!    declared return type skips nullability / ARC qualifiers.
//!  - properties resolve their name through
//!    `property_declaration → struct_declaration → struct_declarator`.
//!  - `message_expression` and `call_expression` are both call sites; a
//!    message send prefixes a non-self/super receiver and records a
//!    capitalized (class) receiver as a `references` dependency.
//!  - file-scope `declaration` variables take the TS GENERIC fallback (direct
//!    identifier children only), NOT C's init/pointer/array branch.
//!  - `@selector(...)` is a function-as-value candidate (cFamilySpec special).
//!
//! Positions are UTF-16 code units. Files with parse errors defer to wasm
//! (`defer:` — the TS side's routine "take the wasm path" signal).

use crate::buffers::EmitOut;

/// Delegate to the shared C-family walker in ObjC mode (see module docs).
pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    crate::ccpp::extract(file_path, source, "objc")
}