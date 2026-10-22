//! Pascal extraction — a faithful Rust port of the pascal paths of
//! `TreeSitterExtractor` (src/graph/extraction/tree-sitter.ts, incl.
//! `visitPascalNode` and the `extractPascal*` family) plus
//! `languages/pascal.ts`.
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! Load-bearing oddities preserved on purpose:
//! - `declProc` is both the function and the method type; a class/interface
//!   context decides which, and a `kClass` child token marks a static method.
//! - Declarations (interface section / class body) mint nodes; `defProc`
//!   bodies do NOT re-mint them — they attribute their calls to the matching
//!   declared node (method index by lowercase qualified suffix) or, for a free
//!   implementation-only routine, mint a fresh `function` node.
//! - `isExported` is always false on `function` nodes (the pascal extractor's
//!   deliberate constant) and absent on `method` nodes (extractMethod never
//!   passes it), so the wire flags differ by kind.
//! - Visibility is not a field: it is the first `kPublic`/`kPublished`/
//!   `kPrivate`/`kProtected` token of the nearest `declSection` ancestor.
//! - Return type comes from the `type` field (`typeref`/`type`) raw text, which
//!   wins over the simple-name `getReturnType` hook.
//! - Paren-less statement-level `exprDot` is a call (`Obj.Method;`); a chained
//!   `TFoo.GetInstance.DoIt;` re-encodes as `TFoo.GetInstance().DoIt` AND emits
//!   the inner receiver call first (two refs, source order).
//! - Only `exprCall` refs are extracted from bodies; calls inside `declProp`/
//!   `declConst`/`declField` initializers are never visited.
//! - `declVars`/`declField` multi-name declarations (`X, Y: Integer`) mint only
//!   the first name (getChildByField returns the first).
//! Positions in UTF-16 code units. Files with parse errors defer to wasm.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, Tables, FLAG_IS_EXPORTED, FLAG_IS_STATIC, FUNCTION_REF_CODE, NONE, NONE_STR,
};
use crate::docstring::preceding_docstring;
use crate::ids;
use crate::textutil as util;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const MAX_VALUE_REF_NODES: usize = 20_000;
const RETURN_TYPE_MAX_LENGTH: usize = 200;

/// NAME_STOPLIST (function-ref.ts).
fn is_stoplisted(name: &str) -> bool {
    matches!(
        name,
        "this" | "self" | "super" | "null" | "nil" | "true" | "false" | "undefined" | "new"
            | "NULL" | "nullptr" | "None"
    )
}

/// `/^\w+$/` — the chained-call method-name gate.
fn word_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_]+$").unwrap())
}

/// getReturnType's bare-name gate `/^[A-Za-z_]\w*$/`.
fn type_ident_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap())
}

/// The Delphi type-naming convention gate `/^[TI][A-Z]/`.
fn ti_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[TI][A-Z]").unwrap())
}

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

struct NodeMeta {
    kind: &'static str,
    name: String,
    qualified: String,
}

struct Cand {
    from: u32,
    name: String,
    line: u32,
    column_byte: usize,
    row: usize,
}

struct ValueScope<'t> {
    row: u32,
    node: Node<'t>,
    name: String,
}

#[derive(Default)]
struct Extra {
    docstring: Option<String>,
    signature: Option<String>,
    /// 0 = absent; 1 public, 2 private, 3 protected.
    visibility: u8,
    is_static: Option<bool>,
    is_exported: Option<bool>,
    return_type: Option<String>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    node_id_allocator: ids::NodeIdAllocator,
    tables: Tables,
    stack: Vec<Scope>,
    node_ids: Vec<String>,
    node_meta: Vec<NodeMeta>,
    defined_fn_names: HashSet<String>,
    imported_names: HashSet<String>,
    fn_ref_cands: Vec<Cand>,
    fs_values: HashMap<String, u32>,
    fs_value_counts: HashMap<String, u32>,
    value_scopes: Vec<ValueScope<'t>>,
    method_index: Option<HashMap<String, u32>>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("pascal").ok_or("no pascal grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(pascal) failed: {e}"))?;
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
        node_id_allocator: ids::NodeIdAllocator::default(),
        tables: Tables::default(),
        stack: Vec::new(),
        node_ids: Vec::new(),
        node_meta: Vec::new(),
        defined_fn_names: HashSet::new(),
        imported_names: HashSet::new(),
        fn_ref_cands: Vec::new(),
        fs_values: HashMap::new(),
        fs_value_counts: HashMap::new(),
        value_scopes: Vec::new(),
        method_index: None,
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
    w.node_meta.push(NodeMeta {
        kind: "file",
        name: base_name.to_string(),
        qualified: file_path.to_string(),
    });
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    w.visit(tree.root_node());
    w.flush_fn_ref_candidates();
    w.flush_value_refs(tree.root_node());
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
        let column = self.col_of(node);
        let id = self.node_id_allocator.generate(self.file_path, kind, name, start_line, column);

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

        let name_ref = self.arena.put(name);
        let qn_ref = self.arena.put(&qualified);
        let id_ref = self.arena.put(&id);
        let doc_ref = opt_str(&mut self.arena, extra.docstring.as_deref());
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let ret_ref = opt_str(&mut self.arena, extra.return_type.as_deref());
        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_exported {
            flags.set(FLAG_IS_EXPORTED, v);
        }
        if let Some(v) = extra.is_static {
            flags.set(FLAG_IS_STATIC, v);
        }
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: extra.visibility,
            flags,
            start_line,
            end_line: node.end_position().row as u32 + 1,
            start_column: column,
            end_column: self.end_col_of(node),
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: doc_ref,
            signature: sig_ref,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: ret_ref,
            extra_json: NONE_STR,
        });
        self.node_ids.push(id);
        self.node_meta.push(NodeMeta { kind, name: name.to_string(), qualified });
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

        self.capture_value_ref_scope(kind, name, row, node);

        Some(row)
    }

    /// captureValueRefScope (tree-sitter.ts:1072) — pascal mints only
    /// `constant` targets (params/fields as `variable` would be noisy).
    fn capture_value_ref_scope(&mut self, kind: &'static str, name: &str, row: u32, node: Node<'t>) {
        if kind == "constant"
            && util::utf16_len(name) >= 3
            && util::has_upper_or_underscore().is_match(name)
        {
            let parent_ok = self
                .stack
                .last()
                .map(|s| matches!(s.kind, "file" | "class" | "module" | "struct" | "enum"))
                .unwrap_or(false);
            if parent_ok {
                self.fs_values.insert(name.to_string(), row);
                *self.fs_value_counts.entry(name.to_string()).or_insert(0) += 1;
            }
        }
        if matches!(kind, "function" | "method" | "constant" | "variable") {
            self.value_scopes.push(ValueScope { row, node, name: name.to_string() });
        }
    }

    // --- visitNode (tree-sitter.ts:1273) + visitPascalNode (:7434) --------

    fn visit(&mut self, node: Node<'t>) {
        stack_guard!();
        if self.pascal_hook(node) {
            return;
        }
        self.maybe_capture_fn_refs(node);
        if node.kind() == "declProc" {
            if self.inside_class_like() {
                self.extract_method(node);
            } else {
                self.extract_function(node);
            }
            return;
        }
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.visit(child);
        }
    }

    /// visitPascalNode (:7434). Returns true when the node was fully handled.
    fn pascal_hook(&mut self, node: Node<'t>) -> bool {
        stack_guard!();
        match node.kind() {
            "unit" | "program" | "library" => {
                let module_name = node
                    .named_children(&mut node.walk())
                    .find(|c| c.kind() == "moduleName")
                    .map(|c| self.text(c).to_string());
                let name = match module_name {
                    Some(n) if !n.is_empty() => n,
                    _ => {
                        let base = self.file_path.rsplit(['/', '\\']).next().unwrap_or(self.file_path);
                        match base.rfind('.') {
                            Some(i) => base[..i].to_string(),
                            None => base.to_string(),
                        }
                    }
                };
                self.create_node("module", &name, node, Extra::default());
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.visit(child);
                }
                true
            }
            "declType" => {
                self.extract_decl_type(node);
                true
            }
            "declUses" => {
                self.extract_uses(node);
                true
            }
            "declConsts" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    if child.kind() == "declConst" {
                        self.extract_const(child);
                    }
                }
                true
            }
            "declConst" => {
                self.extract_const(node);
                true
            }
            "declTypes" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.visit(child);
                }
                true
            }
            "declVars" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    if child.kind() != "declVar" {
                        continue;
                    }
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = self.text(name_node).to_string();
                        self.create_node("variable", &name, child, Extra::default());
                    }
                }
                true
            }
            "defProc" => {
                self.extract_def_proc(node);
                true
            }
            "declProp" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = self.text(name_node).to_string();
                    let visibility = self.visibility_of(node);
                    self.create_node(
                        "property",
                        &name,
                        node,
                        Extra { visibility, ..Extra::default() },
                    );
                }
                true
            }
            "declField" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = self.text(name_node).to_string();
                    let visibility = self.visibility_of(node);
                    self.create_node(
                        "field",
                        &name,
                        node,
                        Extra { visibility, ..Extra::default() },
                    );
                }
                true
            }
            "declSection" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.visit(child);
                }
                true
            }
            "exprCall" => {
                self.extract_pascal_call(node);
                true
            }
            "interface" | "implementation" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.visit(child);
                }
                true
            }
            "block" => {
                self.visit_pascal_block(node);
                true
            }
            _ => false,
        }
    }

    /// extractPascalDeclType (:7572).
    fn extract_decl_type(&mut self, node: Node<'t>) {
        let name = match node.child_by_field_name("name") {
            Some(n) => self.text(n).to_string(),
            None => return,
        };
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        let decl_class = children.iter().copied().find(|c| c.kind() == "declClass");
        let decl_intf = children.iter().copied().find(|c| c.kind() == "declIntf");
        let type_child = children.iter().copied().find(|c| c.kind() == "type");

        if let Some(decl_class) = decl_class {
            if let Some(row) = self.create_node("class", &name, node, Extra::default()) {
                self.extract_pascal_inheritance(decl_class, row);
                self.stack.push(Scope { row, kind: "class", name: name.clone() });
                let mut c = decl_class.walk();
                let members: Vec<Node<'t>> = decl_class.named_children(&mut c).collect();
                for child in members {
                    self.visit(child);
                }
                self.stack.pop();
            }
            return;
        }
        if let Some(decl_intf) = decl_intf {
            if let Some(row) = self.create_node("interface", &name, node, Extra::default()) {
                self.stack.push(Scope { row, kind: "interface", name: name.clone() });
                let mut c = decl_intf.walk();
                let members: Vec<Node<'t>> = decl_intf.named_children(&mut c).collect();
                for child in members {
                    self.visit(child);
                }
                self.stack.pop();
            }
            return;
        }
        if let Some(type_child) = type_child {
            let mut c = type_child.walk();
            let decl_enum = type_child.named_children(&mut c).find(|n| n.kind() == "declEnum");
            if let Some(decl_enum) = decl_enum {
                if let Some(row) = self.create_node("enum", &name, node, Extra::default()) {
                    self.stack.push(Scope { row, kind: "enum", name: name.clone() });
                    let mut c = decl_enum.walk();
                    let members: Vec<Node<'t>> = decl_enum.named_children(&mut c).collect();
                    for child in members {
                        if child.kind() != "declEnumValue" {
                            continue;
                        }
                        if let Some(member) = child.child_by_field_name("name") {
                            let member_name = self.text(member).to_string();
                            self.create_node("enum_member", &member_name, child, Extra::default());
                        }
                    }
                    self.stack.pop();
                }
            } else {
                self.create_node("type_alias", &name, node, Extra::default());
            }
            return;
        }
        self.create_node("type_alias", &name, node, Extra::default());
    }

    /// extractPascalUses (:7646).
    fn extract_uses(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            if child.kind() != "moduleName" {
                continue;
            }
            let unit_name = self.text(child).to_string();
            self.create_node(
                "import",
                &unit_name,
                child,
                Extra { signature: Some(import_text.clone()), ..Extra::default() },
            );
            let parent_row = self.top_row();
            self.push_ref_at(parent_row, &unit_name, "imports", child);
        }
    }

    /// extractPascalConst (:7675).
    fn extract_const(&mut self, node: Node<'t>) {
        let name = match node.child_by_field_name("name") {
            Some(n) => self.text(n).to_string(),
            None => return,
        };
        let mut cursor = node.walk();
        let sig = node
            .named_children(&mut cursor)
            .find(|c| c.kind() == "defaultValue")
            .map(|c| self.text(c).to_string());
        self.create_node("constant", &name, node, Extra { signature: sig, ..Extra::default() });
    }

    /// extractPascalInheritance (:7689).
    fn extract_pascal_inheritance(&mut self, decl_class: Node<'t>, class_row: u32) {
        let mut cursor = decl_class.walk();
        let typerefs: Vec<Node<'t>> =
            decl_class.named_children(&mut cursor).filter(|c| c.kind() == "typeref").collect();
        for (i, reference) in typerefs.iter().enumerate() {
            let name = self.text(*reference).to_string();
            let kind = if i == 0 { "extends" } else { "implements" };
            self.push_ref_at(class_row, &name, kind, *reference);
        }
    }

    /// extractPascalDefProc (:7710) — implementation bodies attribute to the
    /// declared node, never re-mint it (except free implementation-only procs).
    fn extract_def_proc(&mut self, node: Node<'t>) {
        let mut cursor = node.walk();
        let decl_proc = node.named_children(&mut cursor).find(|c| c.kind() == "declProc");
        let decl_proc = match decl_proc {
            Some(n) => n,
            None => return,
        };
        let name_node = match decl_proc.child_by_field_name("name") {
            Some(n) => n,
            None => return,
        };
        let full_name = self.text(name_node).trim().to_string();
        let short_name = full_name.rsplit('.').next().unwrap_or(&full_name).to_string();
        let full_key = full_name.to_lowercase();
        let short_key = short_name.to_lowercase();

        if self.method_index.is_none() {
            let mut index: HashMap<String, u32> = HashMap::new();
            for (row, meta) in self.node_meta.iter().enumerate() {
                if meta.kind != "method" && meta.kind != "function" {
                    continue;
                }
                index.entry(meta.name.to_lowercase()).or_insert(row as u32);
                if meta.kind == "method" {
                    let parts: Vec<&str> = meta.qualified.split("::").collect();
                    if parts.len() >= 2 {
                        for i in 0..parts.len() - 1 {
                            let scoped = parts[i..].join(".").to_lowercase();
                            index.insert(scoped, row as u32);
                        }
                    }
                }
            }
            self.method_index = Some(index);
        }

        let mut parent = self
            .method_index
            .as_ref()
            .and_then(|m| m.get(&full_key).or_else(|| m.get(&short_key)).copied());

        if parent.is_none() && !full_name.contains('.') {
            let signature = self.signature_of(decl_proc);
            let visibility = self.visibility_of(decl_proc);
            if let Some(row) = self.create_node(
                "function",
                &full_name,
                decl_proc,
                Extra { signature, visibility, ..Extra::default() },
            ) {
                parent = Some(row);
                if let Some(index) = self.method_index.as_mut() {
                    index.insert(full_key.clone(), row);
                    index.entry(short_key.clone()).or_insert(row);
                }
            }
        }

        let parent = parent.unwrap_or_else(|| self.top_row());

        let mut cursor = node.walk();
        let block = node.named_children(&mut cursor).find(|c| c.kind() == "block");
        if let Some(block) = block {
            self.stack.push(Scope { row: parent, kind: "method", name: short_name });
            self.visit_pascal_block(block);
            self.stack.pop();
        }
    }

    /// extractPascalCall (:7791).
    fn extract_pascal_call(&mut self, node: Node<'t>) {
        stack_guard!();
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let first = match node.named_child(0) {
            Some(n) => n,
            None => return,
        };

        let callee = if first.kind() == "exprDot" {
            let mut cursor = first.walk();
            let inner_call = first.named_children(&mut cursor).find(|c| c.kind() == "exprCall");
            let mut cursor = first.walk();
            let outer_id = first.named_children(&mut cursor).filter(|c| c.kind() == "identifier").last();
            let method = outer_id.map(|n| self.text(n)).unwrap_or("");
            if let (Some(inner_call), true) = (inner_call, !method.is_empty() && word_re().is_match(method)) {
                let inner_first = inner_call.named_child(0);
                let inner_callee = match inner_first {
                    Some(n) if n.kind() == "exprDot" => {
                        let mut cursor = n.walk();
                        n.named_children(&mut cursor)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| self.text(c))
                            .collect::<Vec<_>>()
                            .join(".")
                    }
                    Some(n) if n.kind() == "identifier" => self.text(n).to_string(),
                    _ => String::new(),
                };
                if !inner_callee.is_empty() && ti_prefix_re().is_match(&inner_callee) {
                    format!("{inner_callee}().{method}")
                } else {
                    method.to_string()
                }
            } else {
                let mut cursor = first.walk();
                first
                    .named_children(&mut cursor)
                    .filter(|c| c.kind() == "identifier")
                    .map(|c| self.text(c))
                    .collect::<Vec<_>>()
                    .join(".")
            }
        } else if first.kind() == "identifier" {
            self.text(first).to_string()
        } else {
            String::new()
        };

        if !callee.is_empty() {
            self.push_ref_at(caller, &callee, "calls", node);
        }

        let mut cursor = node.walk();
        let args = node.named_children(&mut cursor).find(|c| c.kind() == "exprArgs");
        if let Some(args) = args {
            self.visit_pascal_block(args);
        }
    }

    /// extractPascalParenlessCall (:7871) — statement-level bare `exprDot`.
    fn extract_pascal_parenless_call(&mut self, node: Node<'t>) {
        stack_guard!();
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let receiver = node.named_child(0);
        let outer_id = {
            let mut cursor = node.walk();
            node.named_children(&mut cursor).filter(|c| c.kind() == "identifier").last()
        };
        let method = match outer_id {
            Some(n) => self.text(n).to_string(),
            None => return,
        };

        let callee = match receiver {
            Some(receiver)
                if (receiver.kind() == "exprDot" || receiver.kind() == "exprCall")
                    && word_re().is_match(&method) =>
            {
                let inner_node = if receiver.kind() == "exprCall" { receiver.named_child(0) } else { Some(receiver) };
                let inner_callee = match inner_node {
                    None => String::new(),
                    Some(n) if n.kind() == "identifier" => self.text(n).to_string(),
                    Some(n) => {
                        let mut cursor = n.walk();
                        n.named_children(&mut cursor)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| self.text(c))
                            .collect::<Vec<_>>()
                            .join(".")
                    }
                };
                if !inner_callee.is_empty() && ti_prefix_re().is_match(&inner_callee) {
                    if receiver.kind() == "exprCall" {
                        self.extract_pascal_call(receiver);
                    } else {
                        self.extract_pascal_parenless_call(receiver);
                    }
                    format!("{inner_callee}().{method}")
                } else {
                    method.clone()
                }
            }
            _ => {
                let mut cursor = node.walk();
                node.named_children(&mut cursor)
                    .filter(|c| c.kind() == "identifier")
                    .map(|c| self.text(c))
                    .collect::<Vec<_>>()
                    .join(".")
            }
        };

        if !callee.is_empty() {
            self.push_ref_at(caller, &callee, "calls", node);
        }
    }

    /// visitPascalBlock (:7927).
    fn visit_pascal_block(&mut self, node: Node<'t>) {
        stack_guard!();
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.maybe_capture_fn_refs(child);
            if child.kind() == "exprCall" {
                self.extract_pascal_call(child);
                let mut c = child.walk();
                let args = child.named_children(&mut c).find(|n| n.kind() == "exprArgs");
                if let Some(args) = args {
                    self.maybe_capture_fn_refs(args);
                }
            } else if child.kind() == "exprDot" {
                if node.kind() == "statement" {
                    self.extract_pascal_parenless_call(child);
                } else {
                    let mut c = child.walk();
                    let grandchildren: Vec<Node<'t>> = child.named_children(&mut c).collect();
                    for grandchild in grandchildren {
                        if grandchild.kind() == "exprCall" {
                            self.extract_pascal_call(grandchild);
                        }
                    }
                }
            } else {
                self.visit_pascal_block(child);
            }
        }
    }

    // --- generic extractFunction / extractMethod --------------------------

    fn extract_function(&mut self, node: Node<'t>) {
        stack_guard!();
        let name = match node.child_by_field_name("name") {
            Some(n) => self.text(n).to_string(),
            None => return,
        };
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_static = self.is_static(node);
        let return_type = self.return_type_of(node);
        let row = self.create_node(
            "function",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_static: Some(is_static),
                is_exported: Some(false),
                return_type,
            },
        );
        let row = match row {
            Some(r) => r,
            None => return,
        };
        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    fn extract_method(&mut self, node: Node<'t>) {
        stack_guard!();
        if !self.inside_class_like() {
            self.extract_function(node);
            return;
        }
        let name = match node.child_by_field_name("name") {
            Some(n) => self.text(n).to_string(),
            None => return,
        };
        let docstring = preceding_docstring(node, self.src);
        let signature = self.signature_of(node);
        let visibility = self.visibility_of(node);
        let is_static = self.is_static(node);
        let return_type = self.return_type_of(node);
        let row = self.create_node(
            "method",
            &name,
            node,
            Extra {
                docstring,
                signature,
                visibility,
                is_static: Some(is_static),
                is_exported: None,
                return_type,
            },
        );
        let row = match row {
            Some(r) => r,
            None => return,
        };
        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    /// visitFunctionBody (:6383) — DEAD for pascal's grammar (declProc has no
    /// body field; bodies live on `defProc` and walk through visitPascalBlock),
    /// but ported for structural fidelity.
    fn visit_function_body(&mut self, body: Node<'t>) {
        stack_guard!();
        self.maybe_capture_fn_refs(body);
        if body.kind() == "exprCall" {
            self.extract_generic_call(body);
        } else if body.kind() == "declProc" {
            let name = body.child_by_field_name("name").map(|n| self.text(n).to_string());
            if let Some(name) = name {
                if !name.is_empty() {
                    self.extract_function(body);
                    return;
                }
            }
        }
        let mut cursor = body.walk();
        let children: Vec<Node<'t>> = body.named_children(&mut cursor).collect();
        for child in children {
            self.visit_function_body(child);
        }
    }

    /// extractCall's generic tail (:4766-4771, :5295-5310) for `exprCall`
    /// (field `entity` is not `function`, so namedChild(0) is the callee).
    fn extract_generic_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let caller = self.top_row();
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let func = match func {
            Some(f) => f,
            None => return,
        };
        let mut callee = self.text(func).to_string();
        if let Some(caps) = util::paren_conversion().captures(&callee) {
            if let Some(inner) = caps.get(1) {
                callee = inner.as_str().to_string();
            }
        }
        if callee.is_empty() {
            return;
        }
        self.push_ref_at(caller, &callee, "calls", node);
    }

    // --- pascal.ts helper transcriptions ----------------------------------

    /// getSignature (pascal.ts:30): args text + ': ' + typeref text.
    fn signature_of(&self, node: Node<'t>) -> Option<String> {
        let args = node.child_by_field_name("args");
        let mut cursor = node.walk();
        let return_type = node.named_children(&mut cursor).find(|c| c.kind() == "typeref");
        if args.is_none() && return_type.is_none() {
            return None;
        }
        let mut sig = String::new();
        if let Some(args) = args {
            sig.push_str(self.text(args));
        }
        if let Some(return_type) = return_type {
            sig.push_str(": ");
            sig.push_str(self.text(return_type));
        }
        if sig.is_empty() {
            None
        } else {
            Some(sig)
        }
    }

    /// getVisibility (pascal.ts:43): first visibility token of the nearest
    /// declSection ancestor (all children, tokens included).
    fn visibility_of(&self, node: Node<'t>) -> u8 {
        let mut current = node.parent();
        while let Some(parent) = current {
            if parent.kind() == "declSection" {
                for i in 0..parent.child_count() {
                    let Some(child) = parent.child(i) else { continue };
                    match child.kind() {
                        "kPublic" | "kPublished" => return 1,
                        "kPrivate" => return 2,
                        "kProtected" => return 3,
                        _ => {}
                    }
                }
            }
            current = parent.parent();
        }
        0
    }

    /// isStatic (pascal.ts:63): a `kClass` child token.
    fn is_static(&self, node: Node<'t>) -> bool {
        for i in 0..node.child_count() {
            if node.child(i).map(|c| c.kind() == "kClass").unwrap_or(false) {
                return true;
            }
        }
        false
    }

    /// returnTypeText (tree-sitter.ts:6320) over returnField `type`, falling
    /// back to getReturnType (pascal.ts:23).
    fn return_type_of(&self, node: Node<'t>) -> Option<String> {
        if let Some(annotation) = node.child_by_field_name("type") {
            let text = self.text(annotation).trim();
            let text = text.strip_prefix(':').map(|s| s.trim_start()).unwrap_or(text);
            if !text.is_empty() {
                return Some(util::slice_utf16(text, RETURN_TYPE_MAX_LENGTH).0);
            }
        }
        let mut cursor = node.walk();
        let typeref = node.named_children(&mut cursor).find(|c| c.kind() == "typeref")?;
        let mut c = typeref.walk();
        let id = typeref.named_children(&mut c).find(|n| n.kind() == "identifier").unwrap_or(typeref);
        let name = self.text(id).trim();
        if type_ident_re().is_match(name) {
            Some(name.to_string())
        } else {
            None
        }
    }

    // --- function-as-value capture (#756) — PASCAL_SPEC -------------------

    fn maybe_capture_fn_refs(&mut self, node: Node<'t>) {
        let from = self.top_row();
        let mut values: Vec<Node<'t>> = Vec::new();
        match node.kind() {
            "exprArgs" => {
                let mut cursor = node.walk();
                values.extend(node.named_children(&mut cursor));
            }
            "assignment" => {
                let rhs = match node.child_by_field_name("rhs") {
                    Some(r) => r,
                    None => return,
                };
                let lhs = node
                    .child_by_field_name("lhs")
                    .or_else(|| node.child_by_field_name("left"))
                    .or_else(|| node.child_by_field_name("target"))
                    .or_else(|| if node.named_child_count() >= 2 { node.named_child(0) } else { None });
                let lhs_text = lhs.map(|l| self.text(l)).unwrap_or("");
                let lhs_last = util::lhs_last_name().captures(lhs_text).and_then(|c| c.get(1)).map(|m| m.as_str());
                let rhs_text = self.text(rhs).trim();
                if !(lhs_last.is_some() && lhs_last == Some(rhs_text)) {
                    values.push(rhs);
                }
            }
            _ => return,
        }
        for value in values {
            self.normalize_fn_ref_value(value, from, 0);
        }
    }

    fn normalize_fn_ref_value(&mut self, value: Node<'t>, from: u32, depth: u32) {
        stack_guard!();
        if depth > 4 {
            return;
        }
        match value.kind() {
            "identifier" => {
                let name = self.text(value).to_string();
                if name.is_empty() || is_stoplisted(&name) {
                    return;
                }
                let p = value.start_position();
                self.fn_ref_cands.push(Cand {
                    from,
                    name,
                    line: p.row as u32 + 1,
                    column_byte: value.start_byte(),
                    row: p.row,
                });
            }
            // PASCAL_SPEC unwrap: exprUnary → operand field (`@Handler`).
            "exprUnary" => {
                let inner = value
                    .child_by_field_name("operand")
                    .or_else(|| value.named_child(0));
                if let Some(inner) = inner {
                    self.normalize_fn_ref_value(inner, from, depth + 1);
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

    // --- value-reference edges (:1072-1268) -------------------------------

    fn flush_value_refs(&mut self, root: Node<'t>) {
        let scopes = std::mem::take(&mut self.value_scopes);
        let mut targets = std::mem::take(&mut self.fs_values);
        let counts = std::mem::take(&mut self.fs_value_counts);
        if std::env::var("CODEGRAPH_VALUE_REFS").as_deref() == Ok("0") {
            return;
        }
        if targets.is_empty() || scopes.is_empty() || util::is_generated_file(self.file_path) {
            return;
        }

        // Shadow prune — pascal declarator shapes (:1188-1192): declConst and
        // declVar bump their `name` field.
        let mut decl_counts: HashMap<String, u32> = HashMap::new();
        let mut dstack: Vec<Node<'t>> = vec![root];
        let mut dvisited = 0usize;
        while let Some(n) = dstack.pop() {
            if dvisited >= MAX_VALUE_REF_NODES {
                break;
            }
            dvisited += 1;
            if matches!(n.kind(), "declConst" | "declVar") {
                if let Some(name) = n.child_by_field_name("name") {
                    if matches!(name.kind(), "identifier" | "simple_identifier") {
                        let nm = self.text(name);
                        if targets.contains_key(nm) {
                            *decl_counts.entry(nm.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
            for i in 0..n.named_child_count() {
                if let Some(c) = n.named_child(i) {
                    dstack.push(c);
                }
            }
        }
        let shadowed: Vec<String> = decl_counts
            .iter()
            .filter(|(nm, c)| **c > counts.get(*nm).copied().unwrap_or(1))
            .map(|(nm, _)| nm.clone())
            .collect();
        for nm in shadowed {
            targets.remove(&nm);
        }
        if targets.is_empty() {
            return;
        }

        let refs_kind = edge_kind_index("references").unwrap();
        let meta = self.arena.put(r#"{"valueRef":true}"#);
        for scope in &scopes {
            let mut seen: HashSet<u32> = HashSet::new();
            let mut stack: Vec<Node<'t>> = vec![scope.node];
            // Pascal attaches a function body as the NEXT SIBLING of the
            // signature node (`defProc` header declProc ← block).
            if let Some(sib) = scope.node.next_named_sibling() {
                if matches!(sib.kind(), "function_body" | "block") {
                    stack.push(sib);
                }
            }
            let mut visited = 0usize;
            while let Some(n) = stack.pop() {
                if visited >= MAX_VALUE_REF_NODES {
                    break;
                }
                visited += 1;
                if matches!(n.kind(), "identifier" | "constant" | "name" | "simple_identifier") {
                    let ref_name = self.text(n);
                    if let Some(&target_row) = targets.get(ref_name) {
                        if target_row != scope.row && ref_name != scope.name && !seen.contains(&target_row) {
                            seen.insert(target_row);
                            self.tables.push_edge(&EdgeRow {
                                source_idx: scope.row,
                                target_idx: target_row,
                                kind: refs_kind,
                                provenance: 0,
                                line: NONE,
                                column: NONE,
                                metadata_json: meta,
                                source_id_str: NONE_STR,
                                target_id_str: NONE_STR,
                            });
                        }
                    }
                }
                for i in 0..n.named_child_count() {
                    if let Some(c) = n.named_child(i) {
                        stack.push(c);
                    }
                }
            }
        }
    }
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> crate::buffers::StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffers::{EDGE_KINDS, EDGE_ROW_SIZE, NODE_KINDS, NODE_ROW_SIZE, REF_ROW_SIZE};

    struct V {
        kind: String,
        name: String,
        signature: Option<String>,
        return_type: Option<String>,
        visibility: u8,
        is_exported: Option<bool>,
        is_static: Option<bool>,
    }

    fn read_u32(buf: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
    }

    fn read_str(buf: &[u8], arena: &[u8], at: usize) -> Option<String> {
        let off = read_u32(buf, at);
        let len = read_u32(buf, at + 4);
        if off == NONE {
            return None;
        }
        Some(String::from_utf8_lossy(&arena[off as usize..(off + len) as usize]).into_owned())
    }

    fn decode_nodes(buf: &[u8], arena: &[u8]) -> Vec<V> {
        let mut out = Vec::new();
        for at in (0..buf.len()).step_by(NODE_ROW_SIZE) {
            let flags = u16::from_le_bytes([buf[at + 2], buf[at + 3]]);
            let flag = |pair: u16| -> Option<bool> {
                if flags & (1 << (pair * 2)) == 0 {
                    None
                } else {
                    Some(flags & (1 << (pair * 2 + 1)) != 0)
                }
            };
            out.push(V {
                kind: NODE_KINDS[buf[at] as usize].to_string(),
                name: read_str(buf, arena, at + 20).unwrap_or_default(),
                signature: read_str(buf, arena, at + 52),
                return_type: read_str(buf, arena, at + 76),
                visibility: buf[at + 1],
                is_exported: flag(0),
                is_static: flag(2),
            });
        }
        out
    }

    fn decode_edges(buf: &[u8]) -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        for at in (0..buf.len()).step_by(EDGE_ROW_SIZE) {
            out.push((
                read_u32(buf, at),
                read_u32(buf, at + 4),
                EDGE_KINDS[buf[at + 8] as usize].to_string(),
            ));
        }
        out
    }

    fn decode_refs(buf: &[u8], arena: &[u8]) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for at in (0..buf.len()).step_by(REF_ROW_SIZE) {
            let kind = buf[at + 4];
            let name = read_str(buf, arena, at + 16).unwrap_or_default();
            let kind = if kind == FUNCTION_REF_CODE {
                "function_ref".to_string()
            } else {
                EDGE_KINDS[kind as usize].to_string()
            };
            out.push((name, kind));
        }
        out
    }

    fn walk(src: &str) -> (Vec<V>, Vec<(u32, u32, String)>, Vec<(String, String)>) {
        let out = match extract("Sample.pas", src) {
            Ok(out) => out,
            Err(err) => panic!("pascal extract failed: {err}"),
        };
        assert_eq!(out.nodes.len() % NODE_ROW_SIZE, 0);
        assert_eq!(out.refs.len() % REF_ROW_SIZE, 0);
        let nodes = decode_nodes(&out.nodes, &out.arena);
        let edges = decode_edges(&out.edges);
        let refs = decode_refs(&out.refs, &out.arena);
        (nodes, edges, refs)
    }

    // The wasm-arm golden for this exact source (extractFromSource with
    // CODEGRAPH_KERNEL=0) is the oracle for the node/edge/ref sequence below.
    const SAMPLE: &str = r#"unit Sample;

interface

uses
  SysUtils, Classes;

const
  MaxItems = 10;

type
  TColor = (Red, Green, Blue);

  TPoint = record
    X, Y: Integer;
  end;

  TAlias = Integer;

  IWidget = interface
    procedure Draw;
    function Name: string;
  end;

  TBase = class
  public
    procedure Hello;
  end;

  TWidget = class(TBase, IWidget)
  private
    FName: string;
  public
    class function GetInstance: TWidget;
    procedure Hello; override;
    property Title: string read FName;
  end;

implementation

class function TWidget.GetInstance: TWidget;
begin
  Result := TWidget.Create;
end;

procedure TWidget.Hello;
var
  x: Integer;
begin
  x := MaxItems;
  WriteLn(x);
  TWidget.GetInstance().Hello;
  TWidget.GetInstance.Hello;
  if x > 0 then WriteLn('pos');
end;

procedure FreeHelper(a: Integer);
begin
  WriteLn(a);
end;

initialization
  FreeHelper(1);

end.
"#;

    #[test]
    fn nodes_match_wasm_golden() {
        let (nodes, _, _) = walk(SAMPLE);
        let names: Vec<(String, String)> = nodes.iter().map(|n| (n.kind.clone(), n.name.clone())).collect();
        assert_eq!(
            names,
            vec![
                ("file".to_string(), "Sample.pas".to_string()),
                ("module".to_string(), "Sample".to_string()),
                ("import".to_string(), "SysUtils".to_string()),
                ("import".to_string(), "Classes".to_string()),
                ("constant".to_string(), "MaxItems".to_string()),
                ("enum".to_string(), "TColor".to_string()),
                ("enum_member".to_string(), "Red".to_string()),
                ("enum_member".to_string(), "Green".to_string()),
                ("enum_member".to_string(), "Blue".to_string()),
                ("class".to_string(), "TPoint".to_string()),
                ("field".to_string(), "X".to_string()),
                ("type_alias".to_string(), "TAlias".to_string()),
                ("interface".to_string(), "IWidget".to_string()),
                ("method".to_string(), "Draw".to_string()),
                ("method".to_string(), "Name".to_string()),
                ("class".to_string(), "TBase".to_string()),
                ("method".to_string(), "Hello".to_string()),
                ("class".to_string(), "TWidget".to_string()),
                ("field".to_string(), "FName".to_string()),
                ("method".to_string(), "GetInstance".to_string()),
                ("method".to_string(), "Hello".to_string()),
                ("property".to_string(), "Title".to_string()),
                ("function".to_string(), "FreeHelper".to_string()),
            ]
        );
    }

    #[test]
    fn field_values_match_wasm_golden() {
        let (nodes, _, _) = walk(SAMPLE);
        let get = |name: &str, kind: &str| nodes.iter().find(|n| n.name == name && n.kind == kind).unwrap();

        // methods never carry isExported (extractMethod omits it); isStatic is
        // always present (false for ordinary methods).
        let draw = get("Draw", "method");
        assert_eq!(draw.is_exported, None);
        assert_eq!(draw.is_static, Some(false));
        let name_m = get("Name", "method");
        assert_eq!(name_m.signature.as_deref(), Some(": string"));
        assert_eq!(name_m.return_type.as_deref(), Some("string"));
        let gi = get("GetInstance", "method");
        assert_eq!(gi.is_static, Some(true));
        assert_eq!(gi.return_type.as_deref(), Some("TWidget"));
        let hello = get("Hello", "method");
        assert_eq!(hello.visibility, 1);
        // Free implementation-only proc: minted by extractPascalDefProc's
        // direct createNode, which passes only signature/visibility — so no
        // isExported flag and no isStatic flag (unlike extractFunction).
        let free = get("FreeHelper", "function");
        assert_eq!(free.signature.as_deref(), Some("(a: Integer)"));
        assert_eq!(free.is_exported, None);
        assert_eq!(free.is_static, None);
        assert_eq!(get("FName", "field").visibility, 2);
        assert_eq!(get("MaxItems", "constant").signature.as_deref(), Some("= 10"));
    }

    #[test]
    fn edges_are_containment_only_for_this_sample() {
        let (nodes, edges, _) = walk(SAMPLE);
        assert_eq!(edges.len(), nodes.len() - 1);
        assert!(edges.iter().all(|e| e.2 == "contains"));
    }

    #[test]
    fn refs_match_wasm_golden() {
        let (_, _, refs) = walk(SAMPLE);
        assert_eq!(
            refs,
            vec![
                ("SysUtils".to_string(), "imports".to_string()),
                ("Classes".to_string(), "imports".to_string()),
                ("TBase".to_string(), "extends".to_string()),
                ("IWidget".to_string(), "implements".to_string()),
                ("WriteLn".to_string(), "calls".to_string()),
                // Line 81/82 are PAREN-LESS outer calls on a call result:
                // extractPascalParenlessCall re-encodes the chain AND emits the
                // inner receiver call first (two refs per line, source order).
                ("TWidget.GetInstance".to_string(), "calls".to_string()),
                ("TWidget.GetInstance().Hello".to_string(), "calls".to_string()),
                ("TWidget.GetInstance".to_string(), "calls".to_string()),
                ("TWidget.GetInstance().Hello".to_string(), "calls".to_string()),
                ("WriteLn".to_string(), "calls".to_string()),
                ("WriteLn".to_string(), "calls".to_string()),
                ("FreeHelper".to_string(), "calls".to_string()),
            ]
        );
    }

    #[test]
    fn value_refs_fire_for_implementation_only_function_bodies() {
        // A free implementation-only proc's declProc has the body as its next
        // sibling, so the value-ref reader scope pulls it in (the pascal
        // sibling-body rule) and links the file-scope const read.
        let src = "unit U;\ninterface\nconst\n  MaxItems = 10;\nimplementation\nprocedure UseIt;\nbegin\n  WriteLn(MaxItems);\nend;\nend.\n";
        let (nodes, edges, _refs) = walk(src);
        let const_row = nodes.iter().position(|n| n.name == "MaxItems").unwrap() as u32;
        let fn_row = nodes.iter().position(|n| n.name == "UseIt").unwrap() as u32;
        assert!(edges.iter().any(|e| e.0 == fn_row && e.1 == const_row && e.2 == "references"));
    }

    #[test]
    fn parse_error_defers() {
        let err = extract("bad.pas", "unit ;;; ((( ").err().expect("parse error");
        assert!(err.starts_with("defer:"));
    }
}