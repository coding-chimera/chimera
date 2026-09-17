//! Kotlin extraction — a faithful Rust port of the FORK's Kotlin paths
//! (packages/chimera/src/graph/extraction/tree-sitter.ts machinery +
//! languages/kotlin.ts). The fork's wasm oracle predates upstream #708
//! (returnType + the extractModifiers expect/actual decorators), #750/#752
//! (chained-call re-encode, the literal-receiver skip) and #897 (property
//! value nodes + value-reference edges), so NONE of those behaviors belong
//! here — the byte-parity gate is the fork's wasm arm
//! (script/kernel-parity.ts --lang kotlin). fn-ref (wire code 200) rows are
//! still emitted but the fork's decode boundary DROPS them (decode.ts).
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! Extension-function receivers are a kernel FIRST (getReceiverType →
//! `Type::method` qualified-name OVERRIDE with no package prefix + the
//! owner-contains fallback that excludes `interface` kinds and is
//! source-order dependent). Preserved on purpose: the FIELD_COUNT-0 dead
//! cluster (no signatures, ZERO type-annotation refs), property
//! declarations minting NOTHING (the fork's fieldTypes/variableTypes paths
//! cannot read the nested variable_declaration name — initializers stay
//! invisible), the bodiless-class header re-walk asymmetry, enum-entry
//! bodies being invisible, KDoc (`multiline_comment`) never being a
//! docstring AND chain-breaking, comment-gluing into import/package
//! extents, annotations inside `modifiers` emitting NO decorates (the fork
//! never descends into modifiers), zero instantiates refs (constructors are
//! capitalized `calls`), the qualified-receiver `com::qext` bug, the
//! paren-then-lambda `trailing()` garbage callee, RAW callee text with no
//! paren-conversion, and chained calls yielding the BARE method name per
//! call_expression (a string-literal receiver `.trimIndent()` INCLUDED —
//! the fork has no literal-receiver skip). The fun-interface
//! misparse-recovery hook branches are DEFER-SHIELDED (every such file
//! has_error → wasm) and are not ported.
//! Positions in UTF-16 code units. Expected deferral 4.7–8.5% (both-arm,
//! grammar-inherent — incl. phantom errors: trust the has_error FLAG).

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

/// Per-node metadata for the extension-fn owner-contains lookup.
struct NodeMeta {
    kind: &'static str,
    name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_static: Option<bool>,
    is_async: Option<bool>,
    /// composeReceiverQualifiedName override (extension methods) — the id
    /// still hashes the bare NAME; only the qualifiedName column changes.
    qualified_override: Option<String>,
}


struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    nodes_meta: Vec<NodeMeta>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("kotlin").ok_or("no kotlin grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(kotlin) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;
    if tree.root_node().has_error() {
        // Includes the PHANTOM errors (complete CSTs with hasError set) and
        // every fun-interface misparse — trust the flag, wasm is canonical.
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
        nodes_meta: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
    };

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
    w.nodes_meta.push(NodeMeta { kind: "file", name: base_name.to_string() });
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    // extractFilePackage: the FIRST package_header among root's direct named
    // children → namespace node (comment-glued extents included), pushed for
    // the whole walk.
    let root = tree.root_node();
    let mut pkg_pushed = false;
    for i in 0..root.named_child_count() {
        let Some(child) = root.named_child(i) else { continue };
        if child.kind() != "package_header" {
            continue;
        }
        let id_node = (0..child.named_child_count())
            .filter_map(|j| child.named_child(j))
            .find(|c| c.kind() == "identifier");
        if let Some(id_node) = id_node {
            let pkg = w.text(id_node).trim().to_string();
            if !pkg.is_empty() {
                if let Some(row) = w.create_node("namespace", &pkg, child, Extra::default()) {
                    w.stack.push(Scope { row, kind: "namespace", name: pkg });
                    pkg_pushed = true;
                }
            }
        }
        break;
    }

    w.visit_node(root);
    w.flush_fn_ref_candidates();
    if pkg_pushed {
        w.stack.pop();
    }
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

    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, line: u32, column: u32) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: kind_code,
            line,
            column,
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        if kind_code == edge_kind_index("imports").unwrap() {
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    fn push_ref_at(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        self.push_ref(from_row, name, kind_code, self.line_of(node), self.col_of(node));
    }

    /// resolveBody (kotlin.ts:219): first ERROR child whose child(0) is `{`
    /// (fun-interface parent body — unreachable post-defer, kept for
    /// contract), else first function_body | class_body | enum_class_body.
    fn resolve_body(&self, node: Node<'t>) -> Option<Node<'t>> {
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() == "ERROR" {
                if let Some(first) = child.child(0) {
                    if first.kind() == "{" {
                        return Some(child);
                    }
                }
            }
            if matches!(child.kind(), "function_body" | "class_body" | "enum_class_body") {
                return Some(child);
            }
        }
        None
    }

    // --- createNode ------------------------------------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);
        // endLine extension via resolveBody — LIVE for kotlin function/method
        // kinds (in-range for this grammar, so practically a no-op — but the
        // hook is part of the contract).
        let mut end_line = node.end_position().row as u32 + 1;
        if kind == "function" || kind == "method" {
            if let Some(body) = self.resolve_body(node) {
                let be = body.end_position().row as u32 + 1;
                if be > end_line {
                    end_line = be;
                }
            }
        }

        let qualified = match &extra.qualified_override {
            Some(qn) => qn.clone(),
            None => {
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
            }
        };

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_async {
            flags.set(FLAG_IS_ASYNC, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility.unwrap_or(0),
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
        self.node_ids.push(id);
        self.nodes_meta.push(NodeMeta { kind, name: name.to_string() });

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

        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        Some(row)
    }

    // --- hooks (languages/kotlin.ts) ----------------------------------------------

    /// extractName — the zero-field grammar means the nameField lookup always
    /// misses; names come from the shared fallback scan (first direct
    /// identifier-family child; backtick names keep their backticks).
    fn extract_name(&self, node: Node) -> String {
        if let Some(name_node) = node.child_by_field_name("simple_identifier") {
            // nameField is a TYPE name used as a FIELD name — never resolves
            // (mirrored for shape; the grammar has zero fields).
            return self.text(name_node).to_string();
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                if matches!(c.kind(), "identifier" | "type_identifier" | "simple_identifier" | "constant") {
                    return self.text(c).to_string();
                }
            }
        }
        "<anonymous>".to_string()
    }

    /// getVisibility: modifiers text includes public/private/protected/
    /// internal in that order; default PUBLIC. Text-includes semantics —
    /// annotation text inside modifiers can flip it (bug-for-bug).
    fn visibility_of(&self, node: Node) -> u8 {
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            if child.kind() == "modifiers" {
                let text = self.text(child);
                if text.contains("public") {
                    return 1;
                }
                if text.contains("private") {
                    return 2;
                }
                if text.contains("protected") {
                    return 3;
                }
                if text.contains("internal") {
                    return 4;
                }
            }
        }
        1 // Kotlin defaults to public
    }

    /// isAsync: modifiers text includes 'suspend' (text-includes false
    /// positive on `@suspendMarker` annotations — preserve).
    fn is_async(&self, node: Node) -> bool {
        (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "modifiers" && self.text(c).contains("suspend"))
    }

    /// getReceiverType — extension functions: the last user_type BEFORE a `.`
    /// child; its FIRST type_identifier's text (qualified receivers take the
    /// FIRST segment — the `com::qext` bug, preserve).
    fn receiver_type_of(&self, node: Node<'t>) -> Option<String> {
        let mut found_user_type: Option<Node> = None;
        for i in 0..node.child_count() {
            let Some(child) = node.child(i) else { continue };
            match child.kind() {
                "user_type" => found_user_type = Some(child),
                "." => {
                    if let Some(ut) = found_user_type {
                        let type_id = (0..ut.named_child_count())
                            .filter_map(|j| ut.named_child(j))
                            .find(|c| c.kind() == "type_identifier");
                        return Some(self.text(type_id.unwrap_or(ut)).to_string());
                    }
                }
                "simple_identifier" | "function_value_parameters" => break,
                _ => {}
            }
        }
        None
    }

    // --- the dispatcher (visitNode, Kotlin-relevant branches) -----------------------

    fn visit_node(&mut self, node: Node<'t>) {
        stack_guard!();
        let kind = node.kind();
        let mut skip_children = false;

        self.maybe_capture_fn_refs(node);

        if kind == "function_declaration" {
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            skip_children = true;
        } else if kind == "class_declaration" {
            // classifyClassNode: `interface`/`enum` keyword children.
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "interface" {
                        classified = "interface";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            skip_children = true;
        } else if kind == "object_declaration" {
            // extraClassNodeTypes → extractClass → kind `class`.
            self.extract_class(node);
            skip_children = true;
        } else if kind == "type_alias" {
            skip_children = self.extract_type_alias(node);
        } else if kind == "property_declaration" {
            // The fork's extractField/extractVariable paths find no matching
            // children for kotlin (the name nests one level deeper inside
            // variable_declaration) — NOTHING is minted for ANY property,
            // the RHS stays invisible, and BOTH fork dispatch branches set
            // skipChildren; candidates-only scan here.
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_header" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        }
        // companion_object, anonymous_initializer, secondary_constructor,
        // getter/setter siblings, file_annotation, object_literal, if/when at
        // top level: no branch — recursed (calls attribute to the stack top).

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- visitFunctionBody ----------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        stack_guard!();
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        stack_guard!();
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        if kind == "call_expression" {
            self.extract_call(node);
        }
        // (INSTANTIATION_KINDS has no kotlin members; extractBareCall absent.)

        if kind == "function_declaration" {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                // extractFunction diverts receiver-bearing nested fns to
                // extractMethod itself.
                self.extract_function(node);
                return;
            }
        }
        if kind == "class_declaration" {
            let mut classified = "class";
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    if c.kind() == "interface" {
                        classified = "interface";
                        break;
                    }
                    if c.kind() == "enum" {
                        classified = "enum";
                        break;
                    }
                }
            }
            match classified {
                "interface" => self.extract_interface(node),
                "enum" => self.extract_enum(node),
                _ => self.extract_class(node),
            }
            return;
        }
        // object_declaration is NOT dispatched here — a body-local object's
        // `fun`s hit the function branch above and leak out as FUNCTIONS
        // under the enclosing fn; its properties mint nothing (quirk).

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- extractors ------------------------------------------------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        stack_guard!();
        // getReceiverType short-circuit (1522) — extension fns at any scope.
        if self.receiver_type_of(node).is_some() {
            self.extract_method(node);
            return;
        }
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            if let Some(body) = self.resolve_body(node) {
                self.visit_function_body(body);
            }
            return;
        }
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            signature: None, // dead hook (zero fields)
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false), // kotlin isStatic is always false
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else { return };
        // extractTypeAnnotations: the generic path's field lookups all miss
        // (zero fields) — kotlin emits ZERO type-annotation refs.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        stack_guard!();
        let receiver = self.receiver_type_of(node);
        let name = self.extract_name(node);
        let qualified_override = receiver.as_ref().map(|r| format!("{r}::{name}"));
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            signature: None,
            visibility: Some(self.visibility_of(node)),
            is_async: Some(self.is_async(node)),
            is_static: Some(false),
            qualified_override,
        };
        let Some(row) = self.create_node("method", &name, node, extra) else { return };
        // Owner-contains fallback (1799): receiver present, not class-like →
        // the FIRST same-file node named like the receiver with kind ∈
        // {struct, class, enum, trait} (interface EXCLUDED; source-order
        // dependent — both quirks preserved). Additive to the normal edge.
        if let Some(recv) = &receiver {
            if !self.inside_class_like() {
                let owner = self
                    .nodes_meta
                    .iter()
                    .position(|m| {
                        m.name == *recv && matches!(m.kind, "struct" | "class" | "enum" | "trait")
                    })
                    .map(|i| i as u32);
                if let Some(owner_row) = owner {
                    self.tables.push_edge(&EdgeRow {
                        source_idx: owner_row,
                        target_idx: row,
                        kind: edge_kind_index("contains").unwrap(),
                        provenance: 0,
                        line: NONE,
                        column: NONE,
                        metadata_json: NONE_STR,
                        source_id_str: NONE_STR,
                        target_id_str: NONE_STR,
                    });
                }
            }
        }
        // Type annotations: dead. Decorators: live.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = self.resolve_body(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_class(&mut self, node: Node<'t>) {
        stack_guard!();
        let resolved_body = self.resolve_body(node);
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        // primaryCtor refs: csharp-gated no-op.
        self.extract_decorators_for(node, row);
        self.stack.push(Scope { row, kind: "class", name });
        // Bodied: ONLY class_body children (primary-ctor properties/defaults
        // invisible). Bodiless: the class node itself → header children
        // visited → ctor default-value + super-arg calls attribute to the
        // CLASS (the asymmetry, pinned).
        let body = resolved_body.unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_interface(&mut self, node: Node<'t>) {
        stack_guard!();
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            ..Extra::default() // NO visibility
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "interface", name });
        let body = self.resolve_body(node).unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    fn extract_enum(&mut self, node: Node<'t>) {
        stack_guard!();
        let Some(body) = self.resolve_body(node) else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            visibility: Some(self.visibility_of(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else { return };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if child.kind() == "enum_entry" {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        // name field → null (zero fields) → the identifier-children scan: one
        // enum_member per direct simple_identifier, positioned AT the
        // identifier. Entry value_arguments and entry class_bodies (override
        // methods!) are never visited — invisible (quirk).
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if matches!(child.kind(), "simple_identifier" | "identifier" | "property_identifier") {
                let name = self.text(child).to_string();
                self.create_node("enum_member", &name, child, Extra::default());
            }
        }
    }

    /// extractTypeAlias — plain node; the alias-value ref walk reads the
    /// `value` FIELD → null (zero fields) → NO refs. Returns false →
    /// children re-visited (harmless).
    fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = Extra {
            docstring: preceding_docstring_tsjs(node, self.src),
            ..Extra::default()
        };
        self.create_node("type_alias", &name, node, extra);
        false
    }

    fn extract_import(&mut self, node: Node<'t>) {
        // Comment-gluing: the header's extent (and thus the signature) can
        // include trailing comment lines — the trimmed FULL text is the
        // signature; the ref stays at the header start.
        let import_text = self.text(node).trim().to_string();
        let identifier = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "identifier");
        let Some(identifier) = identifier else { return };
        let module_name = self.text(identifier).to_string();
        if module_name.is_empty() {
            return;
        }
        self.create_node(
            "import",
            &module_name,
            node,
            Extra { signature: Some(import_text), ..Extra::default() },
        );
        let parent = self.top_row();
        self.push_ref_at(parent, &module_name.clone(), edge_kind_index("imports").unwrap(), node);
    }

    /// extractCall — the kotlin paths: the navigation member branch (BARE
    /// method names for every non-identifier receiver — the fork has no
    /// literal-receiver skip and no chain re-encode) and the raw-text else
    /// (paren-then-lambda / glued-invoke garbage preserved).
    fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let Some(func) = func else { return };
        let mut callee_name = String::new();

        if func.kind() == "navigation_expression" {
            let property = func
                .child_by_field_name("property")
                .or_else(|| func.child_by_field_name("field"))
                .or_else(|| {
                    let c1 = func.named_child(1);
                    match c1 {
                        Some(c) if c.kind() == "navigation_suffix" => (0..c.named_child_count())
                            .filter_map(|i| c.named_child(i))
                            .find(|g| g.kind() == "simple_identifier")
                            .or(Some(c)),
                        other => other,
                    }
                });
            if let Some(property) = property {
                let method_name = self.text(property);
                let receiver = func
                    .child_by_field_name("object")
                    .or_else(|| func.child_by_field_name("operand"))
                    .or_else(|| func.child_by_field_name("argument"))
                    .or_else(|| func.named_child(0));
                let recv_ident = receiver.filter(|r| {
                    matches!(r.kind(), "identifier" | "simple_identifier" | "field_identifier")
                });
                if let Some(r) = recv_ident {
                    let receiver_name = self.text(r);
                    if matches!(receiver_name, "self" | "this" | "cls" | "super") {
                        callee_name = method_name.to_string();
                    } else {
                        callee_name = format!("{receiver_name}.{method_name}");
                    }
                } else {
                    // The fork has NEITHER the literal-receiver skip (#1230)
                    // NOR the #750/#752 chain re-encode: every non-identifier
                    // receiver (call_expression chains, string literals like
                    // `"""…""".trimIndent()`, this_expression /
                    // super_expression, 2-hop nav, postfix `!!`,
                    // parenthesized) yields the BARE method name.
                    callee_name = method_name.to_string();
                }
            }
        } else {
            // Raw func text: bare `helper`, constructor `WidgetK` (NO
            // instantiates ever), backticked names verbatim, the
            // paren-then-lambda `trailing()` and glued-invoke chains
            // byte-for-byte.
            callee_name = self.text(func).to_string();
        }

        if !callee_name.is_empty() {
            // NO parenthesized-conversion — the fork machinery emits the raw
            // callee text.
            self.push_ref_at(caller, &callee_name, edge_kind_index("calls").unwrap(), node);
        }
    }

    /// extractInheritance — delegation_specifier: user_type ?? its
    /// constructor_invocation's user_type → FIRST type_identifier → ONE
    /// `extends` ref at the typeId (interfaces ride extends too; qualified
    /// supertypes take the FIRST segment — `com`; `by`-delegation emits
    /// NOTHING).
    fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        let extends_kind = edge_kind_index("extends").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "delegation_specifier" {
                continue;
            }
            let user_type = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "user_type");
            let ctor_inv = (0..child.named_child_count())
                .filter_map(|j| child.named_child(j))
                .find(|c| c.kind() == "constructor_invocation");
            let target = user_type.or(ctor_inv);
            let Some(target) = target else { continue };
            let type_id: Node = if target.kind() == "user_type" {
                (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "type_identifier")
                    .unwrap_or(target)
            } else {
                // constructor_invocation → its user_type → first type_identifier
                let ut = (0..target.named_child_count())
                    .filter_map(|j| target.named_child(j))
                    .find(|c| c.kind() == "user_type");
                match ut {
                    Some(ut) => (0..ut.named_child_count())
                        .filter_map(|j| ut.named_child(j))
                        .find(|c| c.kind() == "type_identifier")
                        .unwrap_or(ut),
                    None => target,
                }
            };
            let name = self.text(type_id).to_string();
            self.push_ref_at(class_row, &name, extends_kind, type_id);
        }
    }

    /// extractDecoratorsFor — the fork's two scans (direct children,
    /// preceding annotation siblings) with NO modifiers descent: kotlin
    /// annotations live inside `modifiers`, so kotlin emits ZERO decorates
    /// refs (@Marker and @Anno(args) alike).
    fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        for i in 0..decl.named_child_count() {
            let Some(child) = decl.named_child(i) else { continue };
            self.consider_decorator(child, decorated_row);
        }
        let Some(parent) = decl.parent() else { return };
        let decl_start = decl.start_byte();
        let mut decl_idx: isize = -1;
        for i in 0..parent.named_child_count() {
            if let Some(sib) = parent.named_child(i) {
                if sib.start_byte() == decl_start {
                    decl_idx = i as isize;
                    break;
                }
            }
        }
        if decl_idx > 0 {
            let mut j = decl_idx - 1;
            while j >= 0 {
                let Some(sib) = parent.named_child(j as usize) else {
                    j -= 1;
                    continue;
                };
                if !matches!(sib.kind(), "decorator" | "annotation" | "marker_annotation") {
                    break;
                }
                self.consider_decorator(sib, decorated_row);
                j -= 1;
            }
        }
    }

    fn consider_decorator(&mut self, n: Node<'t>, decorated_row: u32) {
        if !matches!(n.kind(), "decorator" | "annotation" | "marker_annotation") {
            return;
        }
        let mut target: Option<Node> = None;
        for i in 0..n.named_child_count() {
            let Some(child) = n.named_child(i) else { continue };
            if child.kind() == "call_expression" {
                target = child.child_by_field_name("function").or_else(|| child.named_child(0));
                if target.is_some() {
                    break;
                }
            }
            // Fork target list — NO user_type/type_identifier (kotlin
            // annotations never reach consider() anyway — they ride inside
            // `modifiers`, which the fork does not descend into).
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
        self.push_ref_at(decorated_row, &name, edge_kind_index("decorates").unwrap(), n);
    }

    // --- function-as-value refs (KOTLIN_SPEC, function-ref.ts:240) ------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        enum Mode {
            Args,
            Rhs,
        }
        let mode = match node.kind() {
            "value_arguments" => Mode::Args,
            "assignment" => Mode::Rhs, // NO field — RHS = LAST named child
            _ => return,
        };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();

        let mut values: Vec<Node> = Vec::new();
        match mode {
            Mode::Args => {
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        values.push(c);
                    }
                }
            }
            Mode::Rhs => {
                let rhs = if node.named_child_count() > 0 {
                    node.named_child(node.named_child_count() - 1)
                } else {
                    None
                };
                if let Some(rhs) = rhs {
                    let lhs = node
                        .child_by_field_name("left")
                        .or_else(|| node.child_by_field_name("lhs"))
                        .or_else(|| node.child_by_field_name("target"))
                        .or_else(|| {
                            if node.named_child_count() >= 2 { node.named_child(0) } else { None }
                        });
                    let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                    let lhs_last = util::lhs_last_name()
                        .captures(lhs_text)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str());
                    let rhs_text = self.text(rhs).trim();
                    if !(lhs_last.is_some() && lhs_last == Some(rhs_text)) {
                        values.push(rhs);
                    }
                }
            }
        }

        for v in values {
            self.normalize_fn_ref_value(v, from, 0);
        }
    }

    fn normalize_fn_ref_value(&mut self, v: Node<'t>, from: u32, depth: u32) {
        stack_guard!();
        if depth > 4 {
            return;
        }
        match v.kind() {
            // value_argument layer with NO field resolution (zero fields) —
            // the label-forward skip is DEAD for kotlin; fan out namedChildren.
            "value_argument" => {
                for i in 0..v.named_child_count() {
                    if let Some(c) = v.named_child(i) {
                        self.normalize_fn_ref_value(c, from, depth + 1);
                    }
                }
            }
            // `::topLevel` / `OtherClass::handle` — receiver = LAST
            // type_identifier child, member = LAST simple_identifier child;
            // `String::class` has no member (anon keyword) → nothing;
            // lowercase receivers dropped by the CASE regex, not node type.
            "callable_reference" => {
                let mut receiver: Option<Node> = None;
                let mut member: Option<Node> = None;
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else { continue };
                    if child.kind() == "type_identifier" {
                        receiver = Some(child);
                    }
                    if child.kind() == "simple_identifier" {
                        member = Some(child);
                    }
                }
                let Some(member) = member else { return };
                let m = self.text(member);
                match receiver {
                    None => self.push_fn_ref_cand(from, m, member),
                    Some(recv) => {
                        let recv_text = self.text(recv);
                        if recv_text.as_bytes().first().map(|b| b.is_ascii_uppercase()).unwrap_or(false) {
                            let name = format!("{recv_text}::{m}");
                            self.push_fn_ref_cand(from, &name, member);
                        }
                    }
                }
            }
            // `this::caller` → this.<member> (class-scoped, always flushes).
            "navigation_expression" => {
                if !self.text(v).starts_with("this::") {
                    return;
                }
                for i in 0..v.named_child_count() {
                    let Some(child) = v.named_child(i) else { continue };
                    if child.kind() == "navigation_suffix" && self.text(child).starts_with("::") {
                        if child.named_child_count() > 0 {
                            if let Some(id) = child.named_child(child.named_child_count() - 1) {
                                let name = format!("this.{}", self.text(id));
                                self.push_fn_ref_cand(from, &name, id);
                            }
                        }
                        return;
                    }
                }
            }
            _ => {}
        }
    }

    fn push_fn_ref_cand(&mut self, from: u32, name: &str, node: Node) {
        if name.is_empty() || is_stoplisted(name) {
            return;
        }
        let p = node.start_position();
        self.fn_ref_cands.push(Cand {
            from,
            name: name.to_string(),
            line: p.row as u32 + 1,
            column_byte: node.start_byte(),
            row: p.row,
        });
    }

    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        stack_guard!();
        if depth > 12 {
            return;
        }
        // Halts at functionTypes (function_declaration) + the fixed list —
        // lambda_literal halts (no captures inside `by lazy { }` under a
        // hook-consumed property).
        if depth > 0
            && matches!(
                node.kind(),
                "function_declaration" | "arrow_function" | "function_expression" | "lambda_literal"
                    | "lambda_expression"
            )
        {
            return;
        }
        self.maybe_capture_fn_refs(node);
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.scan_fn_ref_subtree(c, depth + 1);
            }
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
