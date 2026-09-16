//! TypeScript / TSX / JavaScript / JSX extraction — a faithful Rust port of
//! `TreeSitterExtractor`'s TS/JS paths (src/extraction/tree-sitter.ts) plus
//! the typescript/javascript LanguageExtractor configs.
//!
//! Porting contract (R2 of the migration plan): behavior parity with the wasm
//! path, verified by scripts/kernel-parity.mjs over real repos — including
//! bug-for-bug fidelity where the TS code has quirks. Every function notes the
//! TS function it mirrors; if you change one side, change the other or the
//! parity gate fails. Positions are emitted in UTF-16 code units (what
//! web-tree-sitter reports), see util::col16.

mod extractors;
mod fnref;
use crate::textutil as util;

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, StrRef, Tables, FLAG_IS_ASYNC, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE,
    NONE, NONE_STR,
};
use crate::ids;
use crate::langs;
use std::collections::HashSet;
use tree_sitter::{Node, Parser};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Typescript,
    Tsx,
    Javascript,
    Jsx,
}

impl Variant {
    pub fn from_language(language: &str) -> Option<Variant> {
        match language {
            "typescript" => Some(Variant::Typescript),
            "tsx" => Some(Variant::Tsx),
            "javascript" => Some(Variant::Javascript),
            "jsx" => Some(Variant::Jsx),
            _ => None,
        }
    }
    /// TS-family (typescript/tsx): type annotations, interfaces, enums,
    /// aliases, visibility, isStatic. The JS family lacks all of those hooks.
    fn is_ts(self) -> bool {
        matches!(self, Variant::Typescript | Variant::Tsx)
    }
}

/// typescriptExtractor.methodTypes / javascriptExtractor.methodTypes.
fn is_method_type(v: Variant, kind: &str) -> bool {
    kind == "method_definition"
        || (v.is_ts() && kind == "public_field_definition")
        || (!v.is_ts() && kind == "field_definition")
}

fn is_function_type(kind: &str) -> bool {
    matches!(kind, "function_declaration" | "arrow_function" | "function_expression")
}

fn is_class_type(v: Variant, kind: &str) -> bool {
    kind == "class_declaration" || (v.is_ts() && kind == "abstract_class_declaration")
}

fn is_variable_type(kind: &str) -> bool {
    matches!(kind, "lexical_declaration" | "variable_declaration")
}

/// CODEPLAN_DEPENDENCY_STATEMENT_KINDS (tree-sitter.ts) — the syntactic
/// statement shapes eligible for CodePlan statement-node emission. All four
/// tsjs languages are in CODEPLAN_STATEMENT_LANGUAGES, so no language gate
/// is needed here.
fn is_codeplan_statement_kind(kind: &str) -> bool {
    matches!(
        kind,
        "expression_statement"
            | "return_statement"
            | "lexical_declaration"
            | "variable_declaration"
            | "if_statement"
            | "for_statement"
            | "for_in_statement"
            | "for_of_statement"
            | "while_statement"
            | "do_statement"
            | "switch_statement"
            | "try_statement"
            | "throw_statement"
            | "with_statement"
            | "labeled_statement"
    )
}

/// INSTANTIATION_KINDS (tree-sitter.ts) — only new_expression occurs in the
/// TS/JS grammars; membership mirrors the TS set exactly.
fn is_instantiation_kind(kind: &str) -> bool {
    matches!(
        kind,
        "new_expression" | "object_creation_expression" | "instance_creation_expression"
    )
}

/// valueReferenceTypes (languages/typescript.ts:15, languages/javascript.ts:14)
/// — identical for all four tsjs variants (jsx maps to the javascript
/// extractor), so extractValueReference needs no variant gate.
fn is_value_reference_type(kind: &str) -> bool {
    matches!(kind, "identifier" | "shorthand_property_identifier")
}

/// VALUE_REF_DECLARATION_PARENTS (tree-sitter.ts) — immediate-parent types
/// whose identifier child is a declaration NAME. `variable_declarator` is
/// deliberately absent: its NAME child is guarded by the generic name-field
/// check, its VALUE child is the assignment RHS the pass exists to collect.
fn is_value_ref_declaration_parent(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "function_signature"
            | "class_declaration"
            | "abstract_class_declaration"
            | "method_definition"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "arrow_function"
            | "formal_parameters"
            | "required_parameter"
            | "optional_parameter"
            | "rest_pattern"
    )
}

/// VALUE_REF_EXCLUDED_PARENTS (tree-sitter.ts) — immediate-parent types whose
/// identifier child is not a value reference: callee/member-receiver positions
/// are covered by the `calls` reference, import/export specifiers are import
/// wiring, and JSX tag/attribute names are names, not values.
fn is_value_ref_excluded_parent(kind: &str) -> bool {
    matches!(
        kind,
        "call_expression"
            | "new_expression"
            | "member_expression"
            | "subscript_expression"
            | "import_specifier"
            | "export_specifier"
            | "namespace_import"
            | "jsx_opening_element"
            | "jsx_closing_element"
            | "jsx_self_closing_element"
            | "jsx_attribute"
    )
}

/// VALUE_REF_EXCLUDED_ANCESTORS (tree-sitter.ts) — ancestor types that
/// disqualify an identifier anywhere inside them (type positions, import
/// statements, destructuring bindings).
fn is_value_ref_excluded_ancestor(kind: &str) -> bool {
    matches!(kind, "type_annotation" | "import_statement" | "object_pattern" | "array_pattern")
}

/// BUILTIN_TYPES (tree-sitter.ts) — names that never become type references.
fn is_builtin_type(name: &str) -> bool {
    matches!(
        name,
        "string" | "number" | "boolean" | "void" | "null" | "undefined" | "never" | "any"
            | "unknown" | "object" | "symbol" | "bigint" | "true" | "false"
            | "str" | "bool" | "i8" | "i16" | "i32" | "i64" | "i128" | "isize"
            | "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "f32" | "f64" | "char"
            | "int" | "long" | "short" | "byte" | "float" | "double"
            | "int8" | "int16" | "int32" | "int64" | "uint8" | "uint16" | "uint32" | "uint64"
            | "float32" | "float64" | "complex64" | "complex128" | "rune" | "error"
            | "Int" | "Long" | "Short" | "Byte" | "Float" | "Double" | "Boolean" | "Char"
            | "Unit" | "String" | "Any" | "AnyRef" | "AnyVal" | "Nothing" | "Null"
    )
}

/// One scope-stack entry (TS keeps node IDs; rows are our equivalent).
struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

/// Extra node properties, per-extract-site (mirrors createNode's `extra`).
#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    visibility: Option<u8>,
    is_exported: Option<bool>,
    is_async: Option<bool>,
    is_static: Option<bool>,
    qualified_name: Option<String>,
    /// returnType wire field (returnTypeText, tree-sitter.ts).
    return_type: Option<String>,
    /// extraJson escape hatch — decode.ts Object.assigns the parsed object
    /// onto the Node (params ride here: the wire row has no params column).
    extra_json: Option<String>,
}

/// One queued interface-member flush job (fork pendingInterfaceMembers).
struct PendingInterface<'t> {
    row: u32,
    name: String,
    body: Node<'t>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    variant: Variant,
    line_starts: Vec<usize>,
    arena: Arena,
    tables: Tables,
    stack: Vec<Scope>,
    /// Node id string per row. Rows are unique but IDS COLLIDE for same
    /// (kind, name, line) nodes — routine in minified one-line files — and the
    /// TS extractor's fn-ref dedupe and value-ref self-checks key on the ID,
    /// so parity requires comparing ids, not rows.
    node_ids: Vec<String>,
    /// Function/method names defined in this file (fn-ref flush gate).
    defined_fn_names: HashSet<String>,
    /// Simple names from `imports` refs (fn-ref flush gate).
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<(u32, fnref::Candidate)>,
    /// extractValueReference per-file dedup: `${fromNodeId}\u{0}${name}`.
    value_ref_keys: HashSet<String>,
    /// TS interface member jobs held for the post-walk flush — contract
    /// members land AFTER same-file concrete implementations because
    /// first-match-by-name consumers depend on seeing the executable
    /// declaration first (fork flushPendingInterfaceMembers semantics).
    pending_interface_members: Vec<PendingInterface<'t>>,
}

pub fn extract(file_path: &str, source: &str, language: &str) -> Result<EmitOut, String> {
    let variant = Variant::from_language(language)
        .ok_or_else(|| format!("tsjs walker does not handle language: {language}"))?;
    let grammar = langs::grammar_for(language)
        .ok_or_else(|| format!("no grammar for language: {language}"))?;

    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language({language}) failed: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parser returned null tree".to_string())?;

    // Files with parse ERRORS defer to the wasm extractor (the `defer:` prefix
    // tells the TS side this is expected routing, not a malfunction). Reason:
    // tree-sitter's error RECOVERY — same grammar, same core version — resolves
    // differently under UTF-8 (native) vs UTF-16 (web-tree-sitter) parsing, so
    // an erroring file's tree can differ between the paths (proven on vscode:
    // `readonly import('x').T[]` recovered with the ERROR inside vs outside the
    // type annotation). Erroring files are rare (0-0.42% across express/
    // excalidraw/vscode) and per-file wasm fallback keeps routing graph-neutral
    // by construction; clean files — 99.6%+ — stay on the fast path.
    if tree.root_node().has_error() {
        return Err("defer: parse tree contains errors — wasm recovery is canonical".to_string());
    }

    let mut w = Walker {
        src: source,
        file_path,
        variant,
        line_starts: util::line_starts(source),
        arena: Arena::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        value_ref_keys: HashSet::new(),
        pending_interface_members: Vec::new(),
    };

    // File node (TreeSitterExtractor.extract): id `file:<path>`, endLine =
    // newline count + 1, isExported explicitly false.
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

    w.visit_node(tree.root_node());

    // End-of-file passes, in the fork extract() order: the contract-member
    // flush runs after the whole walk (see PendingInterface), then the #756
    // fn-ref flush (FUNCTION_REF rows are dropped fork-side at decode).
    w.flush_pending_interface_members();
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
    // --- small helpers --------------------------------------------------------

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

    /// isInsideClassLikeNode.
    fn inside_class_like(&self) -> bool {
        self.stack
            .last()
            .map(|s| matches!(s.kind, "class" | "struct" | "interface" | "trait" | "enum" | "module"))
            .unwrap_or(false)
    }

    fn push_ref(&mut self, from_row: u32, name: &str, kind_code: u8, node: Node) {
        let name_ref = self.arena.put(name);
        self.tables.push_ref(&RefRow {
            from_idx: from_row,
            kind: kind_code,
            line: self.line_of(node),
            column: self.col_of(node),
            reference_name: name_ref,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        if kind_code == edge_kind_index("imports").unwrap() {
            // Feed the fn-ref flush gate the same way flushFnRefCandidates
            // derives importedNames from `imports` refs.
            if util::simple_name().is_match(name) {
                self.imported_names.insert(name.to_string());
            } else if let Some(c) = util::qualified_import().captures(name) {
                self.imported_names.insert(c[1].to_string());
            }
        }
    }

    fn push_call_ref(&mut self, name: &str, node: Node) {
        self.push_ref(self.top_row(), name, edge_kind_index("calls").unwrap(), node);
    }

    // --- createNode -----------------------------------------------------------

    /// createNode (tree-sitter.ts): id, qualified name from the scope stack,
    /// contains edge from the parent scope, value-ref bookkeeping.
    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let id = ids::node_id(self.file_path, kind, name, start_line);

        // endLine body extension: resolveBody only (TS/JS: function-valued
        // class fields whose body nests in the arrow / HOF-wrapped arrow).
        let mut end_line = node.end_position().row as u32 + 1;
        if (kind == "function" || kind == "method") && matches!(node.kind(), "public_field_definition" | "field_definition")
        {
            if let Some(body) = resolve_field_body(node) {
                let be = body.end_position().row as u32 + 1;
                if be > end_line {
                    end_line = be;
                }
            }
        }

        let qualified = extra.qualified_name.unwrap_or_else(|| {
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
        });

        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_exported {
            flags.set(FLAG_IS_EXPORTED, v);
        }
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
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let extra_json_ref = opt_str(&mut self.arena, extra.extra_json.as_deref());
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
            return_type: ret_ref,
            extra_json: extra_json_ref,
        });

        // Containment edge from the current scope.
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

        self.node_ids.push(id);
        if kind == "function" || kind == "method" {
            self.defined_fn_names.insert(name.to_string());
        }
        Some(row)
    }

    // --- value references (extractValueReference, fork unresolved-ref mechanism) ---

    /// extractValueReference (tree-sitter.ts): a value-position identifier —
    /// object shorthand (`{ fn }`), a bare call argument (`register(fn)`), a
    /// JSX expression body (`onClick={fn}`), an assignment right-hand side —
    /// becomes an unresolved `references` ref against the current scope.
    /// Without it, a function passed as a value is invisible to cross-file
    /// dependency walks. Names of two UTF-16 units or fewer are skipped; the
    /// (from-node-id, name) pair is deduped per file because the resolver
    /// would collapse the duplicate edges anyway.
    fn extract_value_reference(&mut self, node: Node<'t>) {
        if !is_value_reference_type(node.kind()) {
            return;
        }
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        if self.is_non_reference_value_position(node) {
            return;
        }
        let name = self.text(node);
        if util::utf16_len(name) <= 2 {
            return;
        }
        // Keyed on the node ID STRING, not the row — ids collide for
        // same-(kind, name, line) nodes, and the TS side keys its dedupe on
        // `${fromNodeId}\u0000${name}`.
        let key = format!("{}\u{0}{}", self.node_ids[from as usize], name);
        if !self.value_ref_keys.insert(key) {
            return;
        }
        self.push_ref(from, name, edge_kind_index("references").unwrap(), node);
    }

    /// isNonReferenceValuePosition (tree-sitter.ts): guard an identifier out
    /// of value-reference collection when its position is a declaration name,
    /// a call callee/member receiver (already covered by the `calls`
    /// reference), an import/export specifier, a type position, a JSX
    /// tag/attribute name, or a destructuring binding.
    fn is_non_reference_value_position(&self, node: Node) -> bool {
        let Some(parent) = node.parent() else { return false };
        if is_value_ref_excluded_parent(parent.kind()) {
            return true;
        }
        if is_value_ref_declaration_parent(parent.kind()) {
            return true;
        }
        // Object-literal keys are names; pair values are not keys and stay values.
        if parent.kind() == "pair" {
            return parent
                .child_by_field_name("key")
                .is_some_and(|k| k.id() == node.id());
        }
        // Generic declaration-name position (`function foo`, `const foo`, …).
        if parent
            .child_by_field_name("name")
            .is_some_and(|n| n.id() == node.id())
        {
            return true;
        }
        // hasAncestorType(VALUE_REF_EXCLUDED_ANCESTORS) — starts at the parent.
        let mut cur = Some(parent);
        while let Some(c) = cur {
            if is_value_ref_excluded_ancestor(c.kind()) {
                return true;
            }
            cur = c.parent();
        }
        false
    }

    // --- TS contract members (flushPendingInterfaceMembers) -----------------------

    /// Materialize interface member nodes queued during the walk (fork
    /// flushPendingInterfaceMembers, called from extract() AFTER the whole
    /// walk): a contract member name (`interface Store { reset() }`)
    /// routinely matches the concrete implementation later in the same file
    /// (`reset: () => ...`), and first-match-by-name consumers must keep
    /// seeing the executable declaration first.
    fn flush_pending_interface_members(&mut self) {
        let pending = std::mem::take(&mut self.pending_interface_members);
        for job in pending {
            self.stack.push(Scope { row: job.row, kind: "interface", name: job.name.clone() });
            self.extract_ts_contract_members(&job.name, job.row, &[job.body]);
            self.stack.pop();
        }
    }

    /// extractTsContractMembers (tree-sitter.ts): shared contract-member walk
    /// for TS object shapes — the `object_type` bodies of a `type X = { ... }`
    /// alias and the `interface_body` of an `interface Y { ... }`. Members
    /// become first-class property/method nodes (`qn = Container::member`)
    /// because the resolver's class-candidate strategies bind member
    /// references to `kind === 'method'` nodes under the container.
    fn extract_ts_contract_members(&mut self, container_name: &str, container_row: u32, bodies: &[Node<'t>]) {
        for obj_type in bodies {
            for i in 0..obj_type.named_child_count() {
                let Some(child) = obj_type.named_child(i) else { continue };
                if !matches!(child.kind(), "property_signature" | "method_signature") {
                    continue;
                }
                let Some(name_node) = child.child_by_field_name("name") else { continue };
                let member_name = self.text(name_node);
                if member_name.is_empty() {
                    continue;
                }
                // `foo: () => T` and `foo(): T` are functionally a method on
                // the type contract — treat the function-typed property
                // signature as a method too so call sites can resolve to it.
                let member_kind: &'static str = if child.kind() == "method_signature"
                    || self.is_ts_function_typed_property(child)
                {
                    "method"
                } else {
                    "property"
                };
                let extra = Extra {
                    docstring: crate::docstring::preceding_docstring_tsjs(child, self.src),
                    signature: Some(self.text(child).to_string()),
                    qualified_name: Some(format!("{container_name}::{member_name}")),
                    ..Extra::default()
                };
                self.create_node(member_kind, member_name, child, extra);
                // `references` refs from the CONTAINER to types named in the
                // member's signature (#432) — consistent for aliases and
                // interfaces.
                self.extract_type_annotations(child, container_row);
            }
        }
    }

    // --- function-as-value refs (#756) -----------------------------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let Some(mode) = fnref::dispatch(node.kind()) else { return };
        if self.stack.is_empty() {
            return;
        }
        let from = self.top_row();
        for (cand, _mode) in fnref::capture(node, mode, self.src) {
            self.fn_ref_cands.push((from, cand));
        }
    }

    /// scanFnRefSubtree: capture-only walk of subtrees the main walkers skip.
    fn scan_fn_ref_subtree(&mut self, node: Node<'t>, depth: u32) {
        stack_guard!();
        if depth > 12 {
            return;
        }
        let kind = node.kind();
        if depth > 0
            && (is_function_type(kind) || matches!(kind, "lambda_literal" | "lambda_expression"))
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
        for (from, c) in cands {
            // Gate: `this.<member>` always flushes; everything else must match
            // a same-file function/method or an imported name. (The `::` and
            // ungated-mode policies belong to other languages' specs.)
            if !c.name.starts_with("this.")
                && !c.name.contains("::")
                && !self.defined_fn_names.contains(&c.name)
                && !self.imported_names.contains(&c.name)
            {
                continue;
            }
            // Dedupe on the node ID STRING, not the row — ids collide for
            // same-(kind, name, line) nodes (minified one-liners) and the TS
            // side keys its dedupe on `${fromNodeId}|${name}`.
            if !seen.insert((self.node_ids[from as usize].clone(), c.name.clone())) {
                continue;
            }
            let column = util::col16(self.src, &self.line_starts, c.row, c.column_byte);
            let name_ref = self.arena.put(&c.name);
            self.tables.push_ref(&RefRow {
                from_idx: from,
                kind: FUNCTION_REF_CODE,
                line: c.line,
                column,
                reference_name: name_ref,
                candidates: NONE_STR,
                from_id_str: NONE_STR,
            });
        }
    }

    // --- the dispatcher (visitNode) --------------------------------------------

    fn visit_node(&mut self, node: Node<'t>) {
        stack_guard!();
        let kind = node.kind();
        let mut skip_children = false;

        // Function-as-value capture — independent of the dispatch ladder.
        self.maybe_capture_fn_refs(node);
        // Value-position identifiers (fork visitNode): the generalized
        // module-level walk collects them here; declaration handlers below
        // walk their own bodies. Kept independent of skip_children so
        // declarations still short-circuit.
        self.extract_value_reference(node);

        if is_function_type(kind) {
            // (the isInsideClassLike + methodTypes overlap is Python/Ruby-only)
            self.extract_function(node, None);
            skip_children = true;
        } else if is_class_type(self.variant, kind) {
            self.extract_class(node);
            skip_children = true;
        } else if is_method_type(self.variant, kind) {
            self.extract_method(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            skip_children = true;
        } else if self.variant.is_ts() && kind == "type_alias_declaration" {
            skip_children = self.extract_type_alias(node);
        } else if is_variable_type(kind) && !self.inside_class_like() {
            self.extract_variable(node);
            self.scan_fn_ref_subtree(node, 0);
            skip_children = true;
        } else if kind == "import_statement" {
            self.extract_import(node);
        } else if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        } else if self.variant.is_ts()
            && matches!(kind, "property_signature" | "method_signature")
            && self.inside_class_like()
        {
            let parent = self.top_row();
            self.extract_type_annotations(node, parent);
        }

        if !skip_children {
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    self.visit_node(c);
                }
            }
        }
    }

    // --- visitFunctionBody ------------------------------------------------------

    fn visit_function_body(&mut self, body: Node<'t>) {
        self.visit_for_calls_and_structure(body);
    }

    fn visit_for_calls_and_structure(&mut self, node: Node<'t>) {
        stack_guard!();
        let kind = node.kind();
        self.maybe_capture_fn_refs(node);

        // CodePlan statement emission (fork-only semantics) runs FIRST for
        // every visited node, exactly like visitForCallsAndStructure's
        // leading extractCodePlanStatement call: the stmt node and its
        // multi-attributed dependency refs land in the arrays before the
        // normal walk re-emits the same calls against the enclosing
        // function. Nested qualifying statements emit their own overlapping
        // stmt nodes when the recursion below reaches them.
        self.extract_code_plan_statement(node);

        if kind == "call_expression" {
            self.extract_call(node);
        } else if kind == "new_expression" {
            self.extract_instantiation(node);
        } else if is_value_reference_type(kind) {
            // Value-position identifier inside a function body (bare argument,
            // JSX expression, object shorthand, assignment RHS).
            self.extract_value_reference(node);
        }

        // Nested NAMED functions become their own nodes.
        if is_function_type(kind) {
            let name = self.extract_name(node);
            if name != "<anonymous>" {
                self.extract_function(node, None);
                return;
            }
        }

        if is_class_type(self.variant, kind) {
            self.extract_class(node);
            return;
        }
        if self.variant.is_ts() && kind == "enum_declaration" {
            self.extract_enum(node);
            return;
        }
        if self.variant.is_ts() && kind == "interface_declaration" {
            self.extract_interface(node);
            return;
        }

        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.visit_for_calls_and_structure(c);
            }
        }
    }

    // --- name / signature / modifier helpers ------------------------------------

    /// extractName / extractNameRaw for the TS/JS configs.
    fn extract_name(&self, node: Node) -> String {
        // (the fork's javascript/typescript configs declare NO resolveName
        // hook — a JS `field_definition` has no `name` field and its
        // property_identifier key is not in the fallback scan set, so class
        // fields extract as `<anonymous>` methods; upstream's resolveName
        // property-field branch is NOT fork behavior.)
        if let Some(name_node) = node.child_by_field_name("name") {
            return self.text(name_node).to_string();
        }
        if matches!(node.kind(), "arrow_function" | "function_expression") {
            return "<anonymous>".to_string();
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

    /// typescriptExtractor.getSignature / javascriptExtractor.getSignature.
    fn signature_of(&self, node: Node) -> Option<String> {
        let params = node.child_by_field_name("parameters")?;
        let mut sig = self.text(params).to_string();
        if self.variant.is_ts() {
            if let Some(ret) = node.child_by_field_name("return_type") {
                let ret_text = self.text(ret);
                let stripped = ret_text.strip_prefix(':').unwrap_or(ret_text).trim_start();
                sig.push_str(": ");
                sig.push_str(stripped);
            }
        }
        Some(sig)
    }

    /// typescriptExtractor.getVisibility (TS only — JS has no hook).
    fn visibility_of(&self, node: Node) -> Option<u8> {
        if !self.variant.is_ts() {
            return None;
        }
        for i in 0..node.child_count() {
            let child = node.child(i)?;
            if child.kind() == "accessibility_modifier" {
                return match self.text(child) {
                    "public" => Some(1),
                    "private" => Some(2),
                    "protected" => Some(3),
                    _ => None,
                };
            }
        }
        None
    }

    /// isExported: walk the parent chain for an export_statement.
    fn is_exported(&self, node: Node) -> bool {
        let mut cur = node.parent();
        while let Some(p) = cur {
            if p.kind() == "export_statement" {
                return true;
            }
            cur = p.parent();
        }
        false
    }

    fn has_keyword_child(&self, node: Node, kw: &str) -> bool {
        for i in 0..node.child_count() {
            if let Some(c) = node.child(i) {
                if c.kind() == kw {
                    return true;
                }
            }
        }
        false
    }

    fn is_async(&self, node: Node) -> bool {
        self.has_keyword_child(node, "async")
    }

    /// TS has an isStatic hook; JS does not (None = field absent).
    fn is_static(&self, node: Node) -> Option<bool> {
        if self.variant.is_ts() {
            Some(self.has_keyword_child(node, "static"))
        } else {
            None
        }
    }

    fn is_const_decl(&self, node: Node) -> bool {
        node.kind() == "lexical_declaration" && self.has_keyword_child(node, "const")
    }

    // (extract_* functions continue in impl blocks below)
}

/// typescriptExtractor.resolveBody / javascriptExtractor.resolveBody: the body
/// of a function-valued class field, nested in the arrow / HOF-wrapped arrow.
fn resolve_field_body(node: Node) -> Option<Node> {
    if !matches!(node.kind(), "public_field_definition" | "field_definition") {
        return None;
    }
    for i in 0..node.named_child_count() {
        let child = node.named_child(i)?;
        if matches!(child.kind(), "arrow_function" | "function_expression") {
            return child.child_by_field_name("body");
        }
        if child.kind() == "call_expression" {
            if let Some(args) = child.child_by_field_name("arguments") {
                for j in 0..args.named_child_count() {
                    if let Some(arg) = args.named_child(j) {
                        if matches!(arg.kind(), "arrow_function" | "function_expression") {
                            return arg.child_by_field_name("body");
                        }
                    }
                }
            }
        }
    }
    None
}

/// resolveBody ?? getChildByField(node, 'body') — the body-walk resolution.
fn body_of(node: Node) -> Option<Node> {
    resolve_field_body(node).or_else(|| node.child_by_field_name("body"))
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}
