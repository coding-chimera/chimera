//! Dart extraction — a faithful Rust port of the FORK's dart paths
//! (packages/chimera/src/graph/extraction/tree-sitter.ts machinery +
//! languages/dart.ts). The fork's wasm oracle predates upstream #708
//! (returnType + type-annotation refs), #750/#762 (chained static-factory
//! re-encode, ctor naming/skip via dartCtorInfo) and #897 (value-reference
//! edges, the static_final_declaration constants hook), so NONE of those
//! behaviors belong here — the byte-parity gate is the fork's wasm arm
//! (script/kernel-parity.ts --lang dart). fn-ref (wire code 200) rows are
//! still emitted but the fork's decode boundary DROPS them (decode.ts).
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! The center of gravity is THE SIBLING-BODY DOUBLE-WALK: dart attaches every
//! function/method body as a NEXT SIBLING of its signature node, and the TS
//! walkers consume the body TWICE — once via resolveBody (attributed to the
//! function/method) and once via the enclosing generic walk (attributed to
//! the file/class). The deterministic result — duplicate local-function
//! nodes with the SAME id under different parents, duplicated
//! calls/instantiates refs — must be reproduced byte-for-byte in the
//! observed interleave; a "helpful" dedupe breaks parity. Other
//! load-bearing oddities preserved on purpose: callTypes is EMPTY (all
//! call refs ride extractBareCall's selector walking in the body walker —
//! cascades are invisible, `?.` encodes like `.`, and a chained
//! `Foo.create().run()` yields the BARE `run` because the accessor's
//! previous sibling is a selector, not an identifier); operator methods
//! mint `method "<anonymous>"`; constructors are named by the generic
//! extractName unwrap (method_signature → the inner ctor signature's FIRST
//! identifier = the CLASS name), while bodiless ctors sit in `declaration`
//! wrappers (constructor_signature is NOT a methodType) and stay invisible;
//! instance fields and top-level finals mint NO nodes (the fork config has
//! no fieldTypes/variableTypes/visitNode hook); NO returnType field ever
//! (returnField 'type' never resolves on this grammar) and ZERO
//! type-annotation refs (the machinery's field lookups all miss);
//! superclass emits ONE extends ref for its FIRST named child — raw text,
//! so a mixins-only header yields `extends "with MixA"` and mixins never
//! yield implements; enum `with` mixins emit nothing while enum
//! `implements` works; deferred imports are invisible; `async*`/`sync*`
//! are NOT async; docstrings use the fork's simpler cleaner (a `///` line
//! keeps its third slash: "/ text"). Positions in UTF-16 code units.
//! Files with parse errors defer to wasm.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE,
    NONE, NONE_STR,
};
use crate::docstring::preceding_docstring_tsjs;
use crate::ids;
use crate::textutil as util;
use std::collections::HashSet;
use tree_sitter::{Node, Parser};


/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}



struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    /// 0 = absent; 1 public, 2 private.
    visibility: u8,
    is_async: Option<bool>,
    is_static: Option<bool>,
    /// resolveBody-driven endLine extension (LIVE for dart sibling bodies).
    end_line_override: Option<u32>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("dart").ok_or("no dart grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(dart) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    if tree.root_node().has_error() {
        return Err("defer: parse tree contains errors — wasm recovery is canonical".to_string());
    }

    let mut w = Walker {
        src: source,
        file_path,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
    };

    // File node (tree-sitter.ts:508-521).
    let line_count = source.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let base_name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    let mut flags = BoolFlags::default();
    flags.set(FLAG_IS_EXPORTED, false);
    let file_id = w.arena.put(&ids::file_node_id(file_path));
    let name_ref = w.arena.put(base_name);
    let qn_ref = w.arena.put(file_path);
    w.tables.push_node(&NodeRow {
        kind: node_kind_index("file").unwrap(),
        visibility: 0,
        flags,
        start_line: 1,
        end_line: line_count,
        start_column: 0,
        end_column: 0,
        name: name_ref,
        qualified_name: qn_ref,
        id: file_id,
        docstring: NONE_STR,
        signature: NONE_STR,
        decorators: NONE_STR,
        type_parameters: NONE_STR,
        return_type: NONE_STR,
        extra_json: NONE_STR,
    });
    w.node_ids.push(ids::file_node_id(file_path));
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    w.visit(tree.root_node());
    w.flush_fn_ref_candidates();
    w.stack.pop();

    let duration_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let meta = build_meta(&w.tables, w.arena.len(), NONE_STR, duration_ms);
    Ok(EmitOut {
        meta,
        nodes: w.tables.nodes,
        edges: w.tables.edges,
        refs: w.tables.refs,
        arena: w.arena.into_vec(),
    })
}

impl<'t> Walker<'t> {
    fn text(&self, node: Node) -> &'t str {
        &self.src[node.byte_range()]
    }
    fn line_of(&self, node: Node) -> u32 {
        node.start_position().row as u32 + 1
    }
    fn col_of(&self, node: Node) -> u32 {
        util::col16(self.src, &self.line_starts, node.start_position().row, node.start_byte())
    }
    fn end_col_of(&self, node: Node) -> u32 {
        util::col16(self.src, &self.line_starts, node.end_position().row, node.end_byte())
    }
    fn top_row(&self) -> u32 {
        self.stack.last().map(|s| s.row).unwrap_or(0)
    }
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind: &str, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: edge_kind_index(kind).unwrap(),
            line: self.line_of(node),
            column: self.col_of(node),
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        // Dart import names are URIs (`package:x/y.dart`) — they match neither
        // SIMPLE_NAME nor QUALIFIED_IMPORT, so importedNames stays empty in
        // practice; ported for fidelity.
        if kind == "imports" {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    // --- createNode (tree-sitter.ts:1308) ---------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);

        let qualified = {
            let mut parts: Vec<&str> = Vec::new();
            for s in &self.stack {
                if s.kind != "file" {
                    parts.push(&s.name);
                }
            }
            let mut qn = parts.join("::");
            if !qn.is_empty() {
                qn.push_str("::");
            }
            qn.push_str(name);
            qn
        };

        // endLine extension (:1322-1334) — LIVE for dart: a function/method
        // node's endLine extends to its sibling function_body's end.
        let mut end_line = node.end_position().row as u32 + 1;
        if let Some(ext) = extra.end_line_override {
            if ext > end_line {
                end_line = ext;
            }
        }

        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility,
            flags,
            start_line,
            end_line,
            start_column: self.col_of(node),
            end_column: self.end_col_of(node),
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: doc_ref,
            signature: sig_ref,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: NONE_STR,
            extra_json: NONE_STR,
        });
        self.node_ids.push(id.clone());
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }

        let parent_row = self.top_row();
        self.tables.push_edge(&EdgeRow {
            source_idx: parent_row,
            target_idx: row,
            kind: edge_kind_index("contains").unwrap(),
            provenance: 0,
            line: NONE,
            column: NONE,
            metadata_json: NONE_STR,
            source_id_str: NONE_STR,
            target_id_str: NONE_STR,
        });


        Some(row)
    }

    // --- languages/dart.ts helper transcriptions --------------------------

    /// dartInnerSignature (dart.ts:9-17).
    fn inner_signature(&self, node: Node<'t>) -> Node<'t> {
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(c.kind(), "function_signature" | "getter_signature" | "setter_signature")
            });
            if let Some(inner) = inner {
                return inner;
            }
        }
        node
    }

    /// getSignature (dart.ts:189-208).
    fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let sig = self.inner_signature(node);
        let mut c1 = sig.walk();
        let params = sig
            .named_children(&mut c1)
            .find(|c| c.kind() == "formal_parameter_list");
        let mut c2 = sig.walk();
        let ret = sig
            .named_children(&mut c2)
            .find(|c| matches!(c.kind(), "type_identifier" | "void_type"));
        if params.is_none() && ret.is_none() {
            return None;
        }
        let mut result = String::new();
        if let Some(r) = ret {
            result.push_str(self.text(r));
            result.push(' ');
        }
        if let Some(p) = params {
            result.push_str(self.text(p));
        }
        let trimmed = result.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// getVisibility (dart.ts:209-222) — `_` prefix = private; every
    /// constructor is public (the unwrap misses ctor signatures / the name
    /// FIELD is the class identifier).
    fn visibility_of(&self, node: Node<'t>) -> u8 {
        let name_node = if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(c.kind(), "function_signature" | "getter_signature" | "setter_signature")
            });
            inner.and_then(|i| {
                let mut ic = i.walk();
                let found = i.named_children(&mut ic).find(|c| c.kind() == "identifier");
                found
            })
        } else {
            node.child_by_field_name("name")
        };
        match name_node {
            Some(n) if self.text(n).starts_with('_') => 2,
            _ => 1,
        }
    }

    /// isAsync (dart.ts:223-233) — the `async` anon child of the SIBLING
    /// function_body; `async*`/`sync*` are different token types → false.
    fn is_async_of(&self, node: Node<'t>) -> bool {
        if let Some(next) = node.next_named_sibling() {
            if next.kind() == "function_body" {
                for i in 0..next.child_count() {
                    if let Some(c) = next.child(i) {
                        if c.kind() == "async" {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// isStatic (dart.ts:234-243).
    fn is_static_of(&self, node: Node<'t>) -> bool {
        if node.kind() == "method_signature" {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "static" {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// resolveBody (dart.ts:158-171).
    fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        if matches!(node.kind(), "function_signature" | "method_signature") {
            let next = node.next_named_sibling()?;
            if next.kind() == "function_body" {
                return Some(next);
            }
            return None;
        }
        if let Some(standard) = node.child_by_field_name("body") {
            return Some(standard);
        }
        let mut cursor = node.walk();
        let found = node
            .named_children(&mut cursor)
            .find(|c| matches!(c.kind(), "class_body" | "extension_body"));
        found
    }

    /// extractName (fork tree-sitter.ts:90-192) — name field → the
    /// method_signature inner unwrap (function/getter/setter/ctor/factory
    /// signatures — the FIRST identifier child wins, so constructors are
    /// named by the CLASS identifier) → identifier-ish child →
    /// `<anonymous>` (operators land here).
    fn extract_name(&self, node: Node<'t>) -> String {
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if node.kind() == "method_signature" {
            let mut cursor = node.walk();
            let inner = node.named_children(&mut cursor).find(|c| {
                matches!(
                    c.kind(),
                    "function_signature" | "getter_signature" | "setter_signature"
                        | "constructor_signature" | "factory_constructor_signature"
                )
            });
            if let Some(inner) = inner {
                let mut ic = inner.walk();
                let id = inner.named_children(&mut ic).find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return self.text(id).to_string();
                }
            }
        }
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            if matches!(c.kind(), "identifier" | "type_identifier" | "simple_identifier" | "constant") {
                return self.text(c).to_string();
            }
        }
        "<anonymous>".to_string()
    }

    // --- the main walk (visitNode, tree-sitter.ts:936-1303) ---------------

    fn visit(&mut self, node: Node<'t>) {
        stack_guard!();
        // maybeCaptureFnRefs (:990) — the double-walk fn-ref twin source.
        self.maybe_capture_fn_refs(node);

        match node.kind() {
            "function_signature" => {
                // functionTypes row — method_signature does NOT include it →
                // always extractFunction, even inside a class (abstract
                // members become kind `function` contained by the class).
                self.extract_function(node);
                return;
            }
            "class_definition" | "mixin_declaration" | "extension_declaration" => {
                self.extract_class(node);
                return;
            }
            "method_signature" => {
                self.extract_method(node);
                return;
            }
            "enum_declaration" => {
                self.extract_enum(node);
                return;
            }
            "type_alias" => {
                let skip = self.extract_type_alias(node);
                if skip {
                    return;
                }
            }
            "import_or_export" => {
                self.extract_import(node);
                return;
            }
            "new_expression" => {
                // INSTANTIATION_KINDS row — from the FILE/CLASS on the
                // sibling revisit (the double-walk's pass 2a).
                self.extract_instantiation(node);
            }
            _ => {}
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    // --- extractFunction / extractMethod (:1517 / :1737) ------------------

    fn extract_function(&mut self, node: Node<'t>) {
        stack_guard!();
        // No receiver hook; no isMisparsedFunction in the fork config —
        // bodiless ctors never reach here (declaration wrappers are not
        // methodTypes), wrapped ones are named by the class identifier.
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            // :1549 — body-only walk (nothing pushed). Dart signatures always
            // name; preserved for fidelity.
            if let Some(body) = self.resolve_body(node) {
                self.visit_body(body);
            }
            return;
        }
        let docstring = preceding_docstring_tsjs(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        let row = self.create_node(
            "function",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        // Gate (:1747): not inside class-like (no methodsAreTopLevel, no
        // receiver, parent never object/object_expression) → extractFunction.
        if !self.inside_class_like() {
            self.extract_function(node);
            return;
        }
        let name = self.extract_name(node);
        let docstring = preceding_docstring_tsjs(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_async = self.is_async_of(node);
        let is_static = self.is_static_of(node);
        let body = self.resolve_body(node);
        let end_line_override = body.map(|b| b.end_position().row as u32 + 1);
        // Operators mint method "<anonymous>" — extractMethod has NO skip.
        let row = self.create_node(
            "method",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_async: Some(is_async),
                is_static: Some(is_static),
                end_line_override,
            },
        );
        let Some(row) = row else { return };
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = body {
            self.visit_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass (:1679) — classes, mixins, extensions ---------------

    fn extract_class(&mut self, node: Node<'t>) {
        stack_guard!();
        let resolved_body = self.resolve_body(node);
        // No skipBodilessClass. Anonymous `extension on String` → the name
        // fallback finds the ON type's type_identifier — a class named after
        // the extended type (preserved).
        let name = self.extract_name(node);
        let docstring = preceding_docstring_tsjs(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "class",
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        self.extract_inheritance(node, row);
        // extractCsharpPrimaryCtorParamRefs — csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "class", name });
        let body = resolved_body.unwrap_or(node);
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
        self.stack.pop();
    }

    // --- extractEnum (:1914) ----------------------------------------------

    fn extract_enum(&mut self, node: Node<'t>) {
        stack_guard!();
        let body = match self.resolve_body(node) {
            Some(b) => b,
            None => return,
        };
        let name = self.extract_name(node);
        let docstring = preceding_docstring_tsjs(node, self.src);
        let visibility = self.visibility_of(node);
        let row = self.create_node(
            "enum",
            &name,
            node,
            Extra { docstring, visibility, ..Default::default() },
        );
        let Some(row) = row else { return };
        // Enum `with` mixins are a DIRECT child (no superclass wrapper) →
        // no clause matches; `interfaces` DOES → implements only.
        self.extract_inheritance(node, row);
        // No extractDecoratorsFor on the enum path.
        self.stack.push(Scope { row, kind: "enum", name });
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            if child.kind() == "enum_constant" {
                self.extract_enum_members(child);
            } else {
                self.visit(child);
            }
        }
        self.stack.pop();
    }

    /// extractEnumMembers (:1958) — one enum_member per constant, positioned
    /// at the enum_constant node; ctor arguments never walked.
    fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    // --- extractTypeAlias (:2890, plain path) -----------------------------

    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let docstring = preceding_docstring_tsjs(node, self.src);
        // `value` field is null (type_alias has no fields) → no refs from
        // the aliased type; returns false → children re-visited.
        self.create_node("type_alias", &name, node, Extra { docstring, ..Default::default() });
        false
    }

    // --- extractImport (:3170; hook dart.ts:261-304) ----------------------

    fn extract_import(&mut self, node: Node<'t>) {
        let find_child = |parent: Node<'t>, kind: &str| -> Option<Node<'t>> {
            let mut cursor = parent.walk();
            let found = parent.named_children(&mut cursor).find(|c| c.kind() == kind);
            found
        };
        let uri_of = |spec: Node<'t>| -> Option<Node<'t>> {
            let configurable = find_child(spec, "configurable_uri")?;
            let uri = find_child(configurable, "uri")?;
            find_child(uri, "string_literal")
        };
        let mut module: Option<String> = None;
        if let Some(li) = find_child(node, "library_import") {
            if let Some(spec) = find_child(li, "import_specification") {
                if let Some(sl) = uri_of(spec) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        if module.is_none() {
            if let Some(le) = find_child(node, "library_export") {
                if let Some(sl) = uri_of(le) {
                    module = Some(self.text(sl).replace(['\'', '"'], ""));
                }
            }
        }
        // Deferred imports (bare `uri`, no configurable_uri) → hook null →
        // nothing at all (invisible).
        let Some(module) = module.filter(|m| !m.is_empty()) else { return };
        let signature = self.text(node).trim().to_string();
        let created = self.create_node(
            "import",
            &module,
            node,
            Extra { signature: Some(signature), ..Default::default() },
        );
        if created.is_some() && !self.stack.is_empty() {
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &module, "imports", node);
        }
    }

    // --- extractInstantiation (:4610, generic tail) -----------------------

    fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let from_row = self.top_row();
        let ctor = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let Some(ctor) = ctor else { return };
        let mut class_name = self.text(ctor).to_string();
        if let Some(lt) = class_name.find('<') {
            if lt > 0 {
                class_name.truncate(lt);
            }
        }
        let last_dot = class_name.rfind('.').map(|i| i as i64).unwrap_or(-1);
        let last_colons = class_name.rfind("::").map(|i| (i + 1) as i64).unwrap_or(-1);
        let last = last_dot.max(last_colons);
        if last >= 0 {
            class_name = class_name[(last as usize + 1)..].to_string();
            class_name = class_name.trim_start_matches([':', '.']).to_string();
        }
        let class_name = class_name.trim().to_string();
        if class_name.is_empty() {
            return;
        }
        self.push_ref_at(from_row, &class_name, "instantiates", node);
    }

    // --- extractBareCall (dart.ts:305-379) --------------------------------

    fn bare_call_name(&self, node: Node<'t>) -> Option<String> {
        if node.kind() == "selector" {
            let mut cursor = node.walk();
            let has_arg_part = node.named_children(&mut cursor).any(|c| c.kind() == "argument_part");
            if !has_arg_part {
                return None;
            }
            let prev = node.prev_named_sibling()?;
            if prev.kind() == "identifier" {
                return Some(self.text(prev).to_string());
            }
            if prev.kind() == "selector" {
                let mut pc = prev.walk();
                let accessor = prev.named_children(&mut pc).find(|c| {
                    matches!(
                        c.kind(),
                        "unconditional_assignable_selector" | "conditional_assignable_selector"
                    )
                });
                if let Some(accessor) = accessor {
                    let mut ac = accessor.walk();
                    let method_id = accessor.named_children(&mut ac).find(|c| c.kind() == "identifier");
                    if let Some(method_id) = method_id {
                        let accessor_prev = prev.prev_named_sibling();
                        if let Some(ap) = accessor_prev {
                            if ap.kind() == "identifier" {
                                return Some(format!("{}.{}", self.text(ap), self.text(method_id)));
                            }
                        }
                        return Some(self.text(method_id).to_string());
                    }
                }
            }
            // super.method() / this.method(): prev is a bare accessor.
            if matches!(
                prev.kind(),
                "unconditional_assignable_selector" | "conditional_assignable_selector"
            ) {
                let mut pc = prev.walk();
                let id = prev.named_children(&mut pc).find(|c| c.kind() == "identifier");
                if let Some(id) = id {
                    return Some(self.text(id).to_string());
                }
            }
            return None;
        }

        // new_expression arm — DEAD in practice (the INSTANTIATION branch
        // fires first in the body walker); ported for fidelity.
        if node.kind() == "new_expression" {
            let mut cursor = node.walk();
            let found = node
                .named_children(&mut cursor)
                .find(|c| c.kind() == "type_identifier")
                .map(|t| self.text(t).to_string());
            return found;
        }

        // const EdgeInsets.all(8.0) — const constructor call.
        if node.kind() == "const_object_expression" {
            let mut c1 = node.walk();
            let type_id = node.named_children(&mut c1).find(|c| c.kind() == "type_identifier");
            let mut c2 = node.walk();
            let name_id = node.named_children(&mut c2).find(|c| c.kind() == "identifier");
            return match (type_id, name_id) {
                (Some(t), Some(n)) => Some(format!("{}.{}", self.text(t), self.text(n))),
                (Some(t), None) => Some(self.text(t).to_string()),
                _ => None,
            };
        }

        None
    }

    // --- extractDecoratorsFor (:4897-5024) — the sibling scan -------------

    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        // Scan 1: direct children — the fork does NOT descend into
        // `modifiers` nodes (dart has none anyway).
        let mut cursor = decl.walk();
        let kids: Vec<Node<'t>> = decl.named_children(&mut cursor).collect();
        for child in kids {
            self.consider_decorator(child, decorated_row);
        }
        // Scan 2: preceding siblings, backward, stop at the first
        // non-annotation — stacked annotations emit in REVERSE source order.
        if let Some(parent) = decl.parent() {
            let decl_start = decl.start_byte();
            let mut decl_idx: Option<usize> = None;
            for i in 0..parent.named_child_count() {
                if let Some(sib) = parent.named_child(i) {
                    if sib.start_byte() == decl_start {
                        decl_idx = Some(i);
                        break;
                    }
                }
            }
            if let Some(di) = decl_idx {
                for j in (0..di).rev() {
                    let Some(sib) = parent.named_child(j) else { continue };
                    if !matches!(sib.kind(), "decorator" | "annotation" | "marker_annotation") {
                        break;
                    }
                    self.consider_decorator(sib, decorated_row);
                }
            }
        }
    }

    fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        if !matches!(n.kind(), "decorator" | "annotation" | "marker_annotation") {
            return;
        }
        let mut target: Option<Node<'t>> = None;
        let mut cursor = n.walk();
        let kids: Vec<Node<'t>> = n.named_children(&mut cursor).collect();
        for child in kids {
            if child.kind() == "call_expression" {
                let fnn = child.child_by_field_name("function").or_else(|| child.named_child(0));
                if let Some(f) = fnn {
                    target = Some(f);
                }
                if target.is_some() {
                    break;
                }
            }
            // Fork target list — NO user_type/type_identifier.
            if matches!(
                child.kind(),
                "identifier" | "member_expression" | "scoped_identifier" | "navigation_expression"
            ) {
                target = Some(child);
                break;
            }
        }
        let Some(target) = target else { return };
        // Fork name shape: NO generic-arg truncation; after the last dot/`::`,
        // exactly ONE leading ':' or '.' char stripped, no trim.
        let mut name = self.text(target).to_string();
        let last_dot = name.rfind('.').map(|i| i as i64).unwrap_or(-1);
        let last_colons = name.rfind("::").map(|i| i as i64).unwrap_or(-1);
        let last = last_dot.max(last_colons);
        if last >= 0 {
            name = name[(last as usize + 1)..].to_string();
            if name.starts_with(':') || name.starts_with('.') {
                name.remove(0);
            }
        }
        if name.is_empty() {
            return;
        }
        self.push_ref_at(decorated_row, &name, "decorates", n);
    }

    // --- extractInheritance — the dart rows (:5368-5393, :5437-5459) ------

    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let mut cursor = node.walk();
        let kids: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in kids {
            if child.kind() == "superclass" {
                // Fork machinery: ONE extends ref — the `type_list` children
                // when present, else the FIRST named child, RAW text. Dart
                // superclasses never carry a type_list, so this is
                // namedChild(0): the extends type — or, for a mixins-only
                // header (`class X with MixA`), the `mixins` node itself,
                // yielding the `extends "with MixA"` quirk. Mixins NEVER
                // yield implements refs on this arm.
                let mut cc = child.walk();
                let type_list = child
                    .named_children(&mut cc)
                    .find(|c| c.kind() == "type_list");
                let targets: Vec<Node<'t>> = match type_list {
                    Some(tl) => {
                        let mut tc = tl.walk();
                        tl.named_children(&mut tc).collect()
                    }
                    None => child.named_child(0).into_iter().collect(),
                };
                for t in targets {
                    let name = self.text(t).to_string();
                    self.push_ref_at(class_row, &name, "extends", t);
                }
            } else if child.kind() == "interfaces" {
                // implements — one per named child, FULL child text.
                let mut cc = child.walk();
                let targets: Vec<Node<'t>> = child.named_children(&mut cc).collect();
                for iface in targets {
                    let name = self.text(iface).to_string();
                    self.push_ref_at(class_row, &name, "implements", iface);
                }
            }
        }
    }

    // --- visitFunctionBody (:5129-5286) — dart rows. NO extractTypeAnnotations
    // pass: the fork machinery's field lookups (paramsField/returnField as
    // FIELD names) all miss on this grammar, and there is no static-member-ref
    // pass either, so dart emits ZERO type/value `references` refs.

    fn visit_body(&mut self, node: Node<'t>) {
        stack_guard!();
        self.maybe_capture_fn_refs(node);

        let kind = node.kind();
        if kind == "new_expression" {
            // INSTANTIATION branch fires first — extractBareCall's
            // new_expression arm is dead. Children still recursed.
            self.extract_instantiation(node);
        } else if let Some(callee) = self.bare_call_name(node) {
            // extractBareCall (:5159-5173) — ref at the MATCHED node.
            if !self.stack.is_empty() {
                let caller_row = self.top_row();
                self.push_ref_at(caller_row, &callee, "calls", node);
            }
        }

        if kind == "function_signature" {
            // Nested named functions (:5245) — extractFunction walks the
            // nested body itself; the enclosing walker ALSO revisits the
            // sibling function_body (double-walk pass 2b) via recursion.
            self.extract_function(node);
            return;
        }

        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit_body(child);
        }
    }

    // --- function-as-value capture (#756) — DART_SPEC ---------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let (mode, field): (&str, &str) = match node.kind() {
            "arguments" => ("args", ""),
            "assignment_expression" => ("rhs", "right"),
            "pair" => ("value", "value"),
            "list_literal" => ("list", ""),
            "static_final_declaration" => ("varinit", ""),
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node<'t>> = Vec::new();
        match mode {
            "args" | "list" => {
                let mut cursor = node.walk();
                for c in node.named_children(&mut cursor) {
                    values.push(c);
                }
            }
            "rhs" => {
                if let Some(rhs) = node.child_by_field_name(field) {
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if node.named_child_count() >= 2 {
                                node.named_child(0)
                            } else {
                                None
                            }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    if !(lhs_last.is_some() && lhs_last == Some(self.text(rhs).trim())) {
                        values.push(rhs);
                    }
                }
            }
            "value" => {
                let v = node.child_by_field_name(field).or_else(|| {
                    let count = node.named_child_count();
                    if count > 0 { node.named_child(count - 1) } else { None }
                });
                if let Some(v) = v {
                    values.push(v);
                }
            }
            _ => {
                // varinit, NO field (function-ref.ts:471-487): the last named
                // child, requiring ≥2 named children; the name-field guard is
                // inert (static_final_declaration has no name/pattern field).
                let count = node.named_child_count();
                if count >= 2 {
                    if let Some(v) = node.named_child(count - 1) {
                        values.push(v);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    /// normalizeValue with DART_SPEC's one layer (`argument` → fan out).
    /// Named arguments are NOT captured (named_argument is not a layer).
    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        stack_guard!();
        if depth > 4 {
            return;
        }
        match v.kind() {
            "identifier" => {
                let name = self.text(v).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    return;
                }
                let p = v.start_position();
                self.fn_ref_cands.push(Cand {
                    from,
                    name,
                    line: p.row as u32 + 1,
                    column_byte: v.start_byte(),
                    row: p.row,
                });
            }
            "argument" => {
                let mut cursor = v.walk();
                let kids: Vec<Node<'t>> = v.named_children(&mut cursor).collect();
                for c in kids {
                    self.normalize_fn_ref_value(c, from, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn flush_fn_ref_candidates(&mut self) {
        let cands = std::mem::take(&mut self.fn_ref_cands);
        if cands.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for c in cands {
            if !c.name.starts_with("this.")
                && !c.name.contains("::")
                && !self.defined_fn_names.contains(&c.name)
                && !self.imported_names.contains(&c.name)
            {
                continue;
            }
            if !seen.insert((self.node_ids[c.from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.tables.push_ref(&RefRow {
                from_idx: c.from,
                kind: FUNCTION_REF_CODE,
                line: c.line,
                column,
                reference_name: name_ref,
                candidates: NONE_STR,
                from_id_str: NONE_STR,
            });
        }
    }
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
