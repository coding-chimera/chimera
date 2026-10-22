//! Nix extraction — a faithful Rust port of `languages/nix.ts` (the whole
//! nix surface: the extractor declares no generic type/call/import arrays, so
//! `visitNode` IS the extractor).
//!
//! Same porting contract as the other walkers: behavior parity, bug-for-bug.
//! Load-bearing oddities preserved on purpose:
//! - `binding` is the only declaration form: attrpath + expression. A
//!   function-valued binding mints a `function` node and pushes its scope
//!   while walking only the curried body (params are signature text, never
//!   nodes); everything else mints a `variable` node and walks the value.
//! - `isReturnedAttrsetMember` decides `isExported` by walking the parent
//!   chain: an attrset ancestor counts, but any intermediate `binding` (other
//!   than the declaration itself), formal-parameter list, or a non-body branch
//!   of a `let` disqualifies.
//! - `inherit` / `inherit_from` mint `variable` nodes for the inherited attrs
//!   only; the remaining children (the source expression of `inherit_from`)
//!   are still visited.
//! - `apply_expression` is the only call/import surface: a direct
//!   `import`/`builtins.import` emits a file `import`; any other callee emits
//!   a `calls` ref, and `callPackage`-family callees also emit a file import
//!   from their first static-path argument. Curried chains (`f a b`) suppress
//!   the inner-callee refs by STRUCTURAL node equality, not object identity,
//!   so one chain never re-emits the same ref.
//! - `imports = [ ./a.nix ]` / `modules = [...]` bindings emit a file import
//!   per literal `path_expression` entry; dynamic entries stay silent.
//! - Only `path_expression`-shaped static project paths (`./`, `../`, no
//!   whitespace/brackets/quotes/`$`) count; everything else stays dynamic.
//! Positions in UTF-16 code units. Files with parse errors defer to wasm.

use crate::buffers::{
    build_meta, edge_kind_index, node_kind_index, Arena, BoolFlags, EdgeRow, EmitOut, NodeRow,
    RefRow, Tables, FLAG_IS_EXPORTED, NONE, NONE_STR, StrRef,
};
use crate::ids;
use crate::textutil as util;
use tree_sitter::{Node, Parser};

struct Scope {
    row: u32,
    kind: &'static str,
    name: String,
}

#[derive(Default)]
struct Extra {
    signature: Option<String>,
    is_exported: Option<bool>,
}

pub struct Walker<'t> {
    src: &'t str,
    file_path: &'t str,
    line_starts: Vec<usize>,
    arena: Arena,
    node_id_allocator: ids::NodeIdAllocator,
    tables: Tables,
    stack: Vec<Scope>,
}

pub fn extract(file_path: &str, source: &str) -> Result<EmitOut, String> {
    let grammar = crate::langs::grammar_for("nix").ok_or("no nix grammar")?;
    let t0 = std::time::Instant::now();
    let mut parser = Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|e| format!("set_language(nix) failed: {e}"))?;
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
    w.stack.push(Scope { row: 0, kind: "file", name: base_name.to_string() });

    w.visit(tree.root_node());
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
    fn named_children(&self, node: Node<'t>) -> Vec<Node<'t>> {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).collect()
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
    }

    // --- createNode (tree-sitter.ts:1685) ---------------------------------

    fn create_node(&mut self, kind: &'static str, name: &str, node: Node<'t>, extra: Extra) -> Option<u32> {
        if name.is_empty() {
            return None;
        }
        let start_line = self.line_of(node);
        let column = self.col_of(node);
        let id = self.node_id_allocator.generate(self.file_path, kind, name, start_line, column);

        // buildQualifiedName (:1824) — non-file stack NAMES joined `::`.
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
        let sig_ref = opt_str(&mut self.arena, extra.signature.as_deref());
        let mut flags = BoolFlags::default();
        if let Some(v) = extra.is_exported {
            flags.set(FLAG_IS_EXPORTED, v);
        }
        let row = self.tables.push_node(&NodeRow {
            kind: node_kind_index(kind).unwrap(),
            visibility: 0,
            flags,
            start_line,
            end_line: node.end_position().row as u32 + 1, // no resolveBody hook
            start_column: column,
            end_column: self.end_col_of(node),
            name: name_ref,
            qualified_name: qn_ref,
            id: id_ref,
            docstring: NONE_STR,
            signature: sig_ref,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: NONE_STR,
            extra_json: NONE_STR,
        });

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

    // --- nix.ts helper transcriptions -------------------------------------

    fn unwrap_variable_expression(&self, node: Node<'t>) -> Node<'t> {
        if node.kind() != "variable_expression" {
            return node;
        }
        node.named_child(0).unwrap_or(node)
    }

    fn get_callee_name(&self, node: Node<'t>) -> Option<String> {
        let mut current = node;
        while current.kind() == "apply_expression" {
            let Some(func) = current
                .child_by_field_name("function")
                .or_else(|| current.named_child(0))
            else {
                break;
            };
            current = func;
        }
        current = self.unwrap_variable_expression(current);
        if current.kind() == "identifier" || current.kind() == "select_expression" {
            return Some(self.text(current).trim().to_string());
        }
        None
    }

    fn get_direct_callee_name(&self, node: Node<'t>) -> Option<String> {
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0))?;
        let func = self.unwrap_variable_expression(func);
        Some(self.text(func).trim().to_string())
    }

    fn is_static_project_path(value: &str) -> bool {
        (value.starts_with("./") || value.starts_with("../"))
            && !value.chars().any(|c| {
                c.is_whitespace()
                    || matches!(
                        c,
                        '{' | '}' | '(' | ')' | '[' | ']' | ';' | '"' | '\'' | '<' | '>' | '$'
                    )
            })
    }

    fn get_static_import_path(&self, arg: Node<'t>) -> Option<String> {
        let mut current = arg;
        while current.kind() == "parenthesized_expression" {
            let Some(inner) = current.named_child(0) else {
                break;
            };
            current = inner;
        }

        let mut text = self.text(current).trim();
        let quoted = (text.starts_with('"') && text.ends_with('"'))
            || (text.starts_with('\'') && text.ends_with('\''));
        if quoted && util::utf16_len(text) >= 2 {
            text = &text[1..text.len() - 1];
        }

        if Self::is_static_project_path(text) {
            Some(text.to_string())
        } else {
            None
        }
    }

    fn is_returned_attrset_member(&self, node: Node<'t>) -> bool {
        let mut current = Some(node);
        let mut seen_returned_attrset = false;

        while let Some(cur) = current {
            let Some(parent) = cur.parent() else {
                break;
            };

            if parent.kind() == "let_expression" {
                let body = parent
                    .child_by_field_name("body")
                    .or_else(|| parent.child_by_field_name("expression"));
                if body != Some(cur) {
                    return false;
                }
            }

            if parent.kind() == "binding" && cur != node {
                return false;
            }
            if parent.kind() == "formal_parameters" || parent.kind() == "formals" {
                return false;
            }

            if matches!(
                parent.kind(),
                "attrset" | "rec_attrset" | "attrset_expression" | "rec_attrset_expression"
            ) {
                seen_returned_attrset = true;
            }

            current = Some(parent);
        }

        seen_returned_attrset
    }

    fn get_curried_params_and_body(&self, node: Node<'t>) -> (Vec<String>, Option<Node<'t>>) {
        let mut params: Vec<String> = Vec::new();
        let mut current = node;

        while current.kind() == "function_expression" && current.named_child_count() > 0 {
            let Some(body) = current.named_child(current.named_child_count() - 1) else {
                break;
            };

            let param_part = self.src[current.start_byte()..body.start_byte()].trim();
            let param_text = param_part.strip_suffix(':').unwrap_or(param_part).trim();
            if !param_text.is_empty() {
                params.push(param_text.to_string());
            }

            if body.kind() == "function_expression" {
                current = body;
            } else {
                return (params, Some(body));
            }
        }

        let body = if current.named_child_count() > 0 {
            current.named_child(current.named_child_count() - 1)
        } else {
            None
        };
        (params, body)
    }

    fn format_function_signature(params: &[String]) -> String {
        match params.len() {
            0 => "()".to_string(),
            1 => {
                let param = &params[0];
                if param.starts_with('(') || param.contains('{') || param.contains('@') {
                    param.clone()
                } else {
                    format!("({param})")
                }
            }
            _ => params.join(" : "),
        }
    }

    fn inherited_attrs(&self, node: Node<'t>) -> Option<Node<'t>> {
        self.named_children(node)
            .into_iter()
            .find(|c| c.kind() == "inherited_attrs")
    }

    fn is_call_package_name(name: &str) -> bool {
        name == "callPackage"
            || name == "callPackages"
            || name.ends_with(".callPackage")
            || name.ends_with(".callPackages")
    }

    /// Innermost argument of a curried apply chain: `f a b` → `a`.
    fn get_first_apply_argument(&self, node: Node<'t>) -> Option<Node<'t>> {
        let mut inner = node;
        loop {
            let Some(func) = inner
                .child_by_field_name("function")
                .or_else(|| inner.named_child(0))
            else {
                break;
            };
            if func.kind() != "apply_expression" {
                break;
            }
            inner = func;
        }
        inner
            .child_by_field_name("argument")
            .or_else(|| inner.named_child(1))
    }

    /// Import node + unresolved `imports` ref for a static project path.
    fn emit_file_import(&mut self, import_path: &str, anchor: Node<'t>) {
        let signature = util::slice_utf16(self.text(anchor).trim(), 100).0;
        let created = self.create_node(
            "import",
            import_path,
            anchor,
            Extra { signature: Some(signature), is_exported: None },
        );
        if created.is_some() && !self.stack.is_empty() {
            let from_row = self.top_row();
            self.push_ref_at(from_row, import_path, "imports", anchor);
        }
    }

    // --- visitNode (tree-sitter.ts:1273) + nix.ts visitNode ----------------

    fn visit(&mut self, node: Node<'t>) {
        stack_guard!();
        if self.nix_hook(node) {
            return;
        }
        for child in self.named_children(node) {
            self.visit(child);
        }
    }

    /// nix.ts `visitNode`. Returns true when the node was fully handled.
    fn nix_hook(&mut self, node: Node<'t>) -> bool {
        stack_guard!();
        match node.kind() {
            "binding" => self.handle_binding(node),
            "function_expression" => {
                if let Some(body) = node.named_child(node.named_child_count().saturating_sub(1)) {
                    self.visit(body);
                }
                true
            }
            "inherit" | "inherit_from" => {
                if let Some(attrs) = self.inherited_attrs(node) {
                    for child in self.named_children(attrs) {
                        let name = self.text(child).trim();
                        if !name.is_empty() {
                            let is_exported = self.is_returned_attrset_member(child);
                            self.create_node(
                                "variable",
                                name,
                                child,
                                Extra { signature: None, is_exported: Some(is_exported) },
                            );
                        }
                    }
                }

                for child in self.named_children(node) {
                    if child.kind() != "inherited_attrs" {
                        self.visit(child);
                    }
                }
                true
            }
            "apply_expression" => {
                self.handle_apply(node);
                true
            }
            _ => false,
        }
    }

    fn handle_binding(&mut self, node: Node<'t>) -> bool {
        let Some(attrpath) = node
            .child_by_field_name("attrpath")
            .or_else(|| node.named_child(0))
        else {
            return false;
        };

        let name = self.text(attrpath).trim().to_string();
        if name.is_empty() {
            return false;
        }

        let Some(value_node) = node
            .child_by_field_name("expression")
            .or_else(|| node.child_by_field_name("value"))
            .or_else(|| node.named_child(1))
        else {
            return false;
        };

        if value_node.kind() == "function_expression" {
            let (params, body_node) = self.get_curried_params_and_body(value_node);
            let is_exported = self.is_returned_attrset_member(node);
            let func_row = self.create_node(
                "function",
                &name,
                node,
                Extra {
                    signature: Some(Self::format_function_signature(&params)),
                    is_exported: Some(is_exported),
                },
            );

            if let Some(row) = func_row {
                self.stack.push(Scope { row, kind: "function", name });
                if let Some(body) = body_node {
                    self.visit(body);
                }
                self.stack.pop();
            }
            return true;
        }

        let (init_value, at_or_beyond) = util::slice_utf16(self.text(value_node), 100);
        let signature = if init_value.is_empty() {
            None
        } else {
            Some(format!("= {init_value}{}", if at_or_beyond { "..." } else { "" }))
        };
        let is_exported = self.is_returned_attrset_member(node);
        self.create_node(
            "variable",
            &name,
            node,
            Extra { signature, is_exported: Some(is_exported) },
        );

        // NixOS/home-manager module lists: `imports = [ ./hardware.nix ]`
        // (and the flake-era `modules = [...]`) reference files without an
        // `import` call. Only literal `path_expression` entries count.
        let final_segment = name.split('.').next_back();
        if (final_segment == Some("imports") || final_segment == Some("modules"))
            && value_node.kind() == "list_expression"
        {
            for child in self.named_children(value_node) {
                if child.kind() != "path_expression" {
                    continue;
                }
                let entry_path = self.text(child).trim();
                if Self::is_static_project_path(entry_path) {
                    self.emit_file_import(entry_path, child);
                }
            }
        }

        self.visit(value_node);
        true
    }

    fn handle_apply(&mut self, node: Node<'t>) {
        let direct_callee = self.get_direct_callee_name(node);
        let is_direct_import = matches!(
            direct_callee.as_deref(),
            Some("import") | Some("builtins.import")
        );

        // Wrapper objects are re-created per access, so compare structurally,
        // never by object identity — otherwise every level of a curried chain
        // (`f a b`) re-emits the same refs.
        let parent_fn = match node.parent() {
            Some(parent) if parent.kind() == "apply_expression" => parent
                .child_by_field_name("function")
                .or_else(|| parent.named_child(0)),
            _ => None,
        };
        let is_callee_of_parent = parent_fn.map(|f| f == node).unwrap_or(false);

        if !(is_callee_of_parent && !is_direct_import) {
            if is_direct_import {
                let arg = node
                    .child_by_field_name("argument")
                    .or_else(|| node.named_child(1));
                if let Some(import_path) = arg.and_then(|a| self.get_static_import_path(a)) {
                    self.emit_file_import(&import_path, node);
                }
            } else {
                let callee_name = self.get_callee_name(node);
                if let Some(name) = &callee_name {
                    if name != "import" && name != "builtins.import" && !self.stack.is_empty() {
                        let from_row = self.top_row();
                        self.push_ref_at(from_row, name, "calls", node);
                    }

                    // `callPackage ./pkg.nix { }` loads the file like `import`
                    // does; the first argument of the apply chain is the
                    // package file. Only a literal static path counts.
                    if Self::is_call_package_name(name) {
                        let import_path = self
                            .get_first_apply_argument(node)
                            .and_then(|a| self.get_static_import_path(a));
                        if let Some(import_path) = import_path {
                            self.emit_file_import(&import_path, node);
                        }
                    }
                }
            }
        }

        for child in self.named_children(node) {
            self.visit(child);
        }
    }
}

fn opt_str(arena: &mut Arena, s: Option<&str>) -> StrRef {
    match s {
        Some(s) => arena.put(s),
        None => NONE_STR,
    }
}