//! The extract_* family — continuation of the Walker impl (see mod.rs for the
//! porting contract). Each function mirrors its namesake in
//! src/extraction/tree-sitter.ts; TS-file line references are as of the R2
//! port. Bug-for-bug fidelity is deliberate — fix the TS side first.

use crate::textutil as util;
use super::{
    body_of, is_builtin_type, is_codeplan_statement_kind, is_function_type,
    is_instantiation_kind, Extra, PendingInterface, Scope, Variant, Walker,
};
use crate::buffers::edge_kind_index;
use tree_sitter::Node;

/// RETURN_TYPE_MAX_LENGTH (tree-sitter.ts) — stored return-type text cap.
const RETURN_TYPE_MAX_LENGTH: usize = 200;
/// PARAM_TYPE_MAX_CHARS / PARAMS_JSON_MAX_CHARS (tree-sitter.ts) — per-type
/// and per-collection serialization budgets for the params pairs.
const PARAM_TYPE_MAX_CHARS: usize = 200;
const PARAMS_JSON_MAX_CHARS: usize = 2000;
/// extractCodePlanStatement's `slice(0, 240)` signature cap (UTF-16 units).
const STATEMENT_SIGNATURE_MAX: usize = 240;

impl<'t> Walker<'t> {
    // --- extractFunction --------------------------------------------------------

    pub(super) fn extract_function(&mut self, node: Node<'t>, name_override: Option<String>) {
        let mut name = name_override
            .clone()
            .unwrap_or_else(|| self.extract_name(node));

        // Arrow/function-expression values: resolve the name from the parent
        // variable_declarator (`export const useAuth = () => {}`).
        if name_override.is_none()
            && name == "<anonymous>"
            && matches!(node.kind(), "arrow_function" | "function_expression")
        {
            if let Some(parent) = node.parent() {
                if parent.kind() == "variable_declarator" {
                    if let Some(var_name) = parent.child_by_field_name("name") {
                        name = self.text(var_name).to_string();
                    }
                }
            }
        }
        if name == "<anonymous>" {
            // Fork parity: extractFunction RETURNS on <anonymous> without
            // walking the body (tree-sitter.ts `if (name === '<anonymous>')
            // return;`), and visitNode skips the children — so wrapper
            // bodies reached through the visitNode dispatch (UMD factories,
            // top-level IIFEs) contribute nothing on the wasm arm. The
            // upstream #528 body-walk this port originally carried made the
            // kernel discover wrapper-inner named functions/classes and
            // their statement cascades that the fork never emits
            // (node:extra-in-kernel:function/statement in the parity
            // harness). Bodies reached through visitForCallsAndStructure
            // still walk via its generic child recursion, matching the
            // fork's fall-through for anonymous functions there.
            return;
        }

        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_exported: Some(self.is_exported(node)),
            is_async: Some(self.is_async(node)),
            is_static: self.is_static(node),
            return_type: self.return_type_text_of(node),
            extra_json: self.extract_param_type_pairs_json(node),
            ..Extra::default()
        };
        let Some(row) = self.create_node("function", &name, node, extra) else {
            return;
        };

        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope { row, kind: "function", name });
        if let Some(body) = body_of(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    // --- extractClass ------------------------------------------------------------

    pub(super) fn extract_class(&mut self, node: Node<'t>) {
        let resolved_body = body_of(node); // skipBodilessClass unset for TS/JS
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            visibility: self.visibility_of(node),
            is_exported: Some(self.is_exported(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("class", &name, node, extra) else {
            return;
        };

        self.extract_inheritance(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope { row, kind: "class", name });
        let body = resolved_body.unwrap_or(node);
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                self.visit_node(c);
            }
        }
        self.stack.pop();
    }

    // --- extractMethod -------------------------------------------------------------

    pub(super) fn extract_method(&mut self, node: Node<'t>) {
        if !self.inside_class_like() {
            // Object-literal methods are ephemeral: walk the body only.
            if let Some(parent) = node.parent() {
                if matches!(parent.kind(), "object" | "object_expression") {
                    if let Some(body) = body_of(node) {
                        self.visit_function_body(body);
                    }
                    return;
                }
            }
            self.extract_function(node, None);
            return;
        }

        let name = self.extract_name(node);
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            signature: self.signature_of(node),
            visibility: self.visibility_of(node),
            is_async: Some(self.is_async(node)),
            is_static: self.is_static(node),
            return_type: self.return_type_text_of(node),
            extra_json: self.extract_param_type_pairs_json(node),
            ..Extra::default() // methods carry no isExported (mirrors extractMethod)
        };
        let Some(row) = self.create_node("method", &name, node, extra) else {
            return;
        };

        self.extract_type_annotations(node, row);
        self.extract_decorators_for(node, row);

        self.stack.push(Scope { row, kind: "method", name });
        if let Some(body) = body_of(node) {
            self.visit_function_body(body);
        }
        self.stack.pop();
    }

    // --- extractInterface / extractEnum / members -----------------------------------

    pub(super) fn extract_interface(&mut self, node: Node<'t>) {
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            is_exported: Some(self.is_exported(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("interface", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "interface", name: name.clone() });
        let body = body_of(node).unwrap_or(node);
        for i in 0..body.named_child_count() {
            let Some(c) = body.named_child(i) else { continue };
            // Contract members are created in the post-walk flush, not inline
            // — first-match-by-name consumers must keep seeing the same-file
            // executable declaration first (fork extractInterface).
            if matches!(c.kind(), "property_signature" | "method_signature") {
                continue;
            }
            self.visit_node(c);
        }
        self.pending_interface_members.push(PendingInterface { row, name, body });
        self.stack.pop();
    }

    pub(super) fn extract_enum(&mut self, node: Node<'t>) {
        let Some(body) = body_of(node) else { return };
        let name = self.extract_name(node);
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            visibility: self.visibility_of(node),
            is_exported: Some(self.is_exported(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("enum", &name, node, extra) else {
            return;
        };
        self.extract_inheritance(node, row);
        self.stack.push(Scope { row, kind: "enum", name });
        for i in 0..body.named_child_count() {
            let Some(child) = body.named_child(i) else { continue };
            if matches!(child.kind(), "property_identifier" | "enum_assignment") {
                self.extract_enum_members(child);
            } else {
                self.visit_node(child);
            }
        }
        self.stack.pop();
    }

    fn extract_enum_members(&mut self, node: Node<'t>) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.text(name_node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
            return;
        }
        let mut found = false;
        for i in 0..node.named_child_count() {
            if let Some(child) = node.named_child(i) {
                if matches!(child.kind(), "simple_identifier" | "identifier" | "property_identifier") {
                    let name = self.text(child).to_string();
                    self.create_node("enum_member", &name, child, Extra::default());
                    found = true;
                }
            }
        }
        if !found && node.named_child_count() == 0 {
            let name = self.text(node).to_string();
            self.create_node("enum_member", &name, node, Extra::default());
        }
    }

    // --- extractVariable (TS/JS branch) ------------------------------------------------

    pub(super) fn extract_variable(&mut self, node: Node<'t>) {
        let is_const = self.is_const_decl(node);
        let kind: &'static str = if is_const { "constant" } else { "variable" };
        let docstring = crate::docstring::preceding_docstring_tsjs(node, self.src);
        let is_exported = self.is_exported(node); // `?? false` — always present

        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            if child.kind() != "variable_declarator" {
                continue;
            }
            let Some(name_node) = child.child_by_field_name("name") else { continue };
            let value = child.child_by_field_name("value");

            // Destructured patterns are skipped (the fork has no RTK
            // hook-binding extraction).
            if matches!(name_node.kind(), "object_pattern" | "array_pattern") {
                continue;
            }
            let name = self.text(name_node).to_string();

            // Arrow/function values extract as functions, named by the declarator.
            if let Some(v) = value {
                if matches!(v.kind(), "arrow_function" | "function_expression") {
                    self.extract_function(v, None);
                    continue;
                }
            }

            let init_signature = value.map(|v| util::init_signature(self.text(v)));

            let var_row = self.create_node(
                kind,
                &name,
                child,
                Extra {
                    docstring: docstring.clone(),
                    signature: init_signature.clone(),
                    is_exported: Some(is_exported),
                    ..Extra::default()
                },
            );
            if let Some(row) = var_row {
                self.extract_variable_type_annotation(child, row);
            }

            // Exported const object-of-functions / store shapes. Fork gate:
            // `isExported && !!objectOfFns` — NO inline-functions test, so a
            // factory chain whose returned object holds no arrows
            // (`export const X = factory({...}).pipe(...)`) still skips the
            // body walk and extracts the returned object member-by-member.
            let object_of_fns: Option<Node> = match value {
                Some(v) if matches!(v.kind(), "object" | "object_expression") => Some(v),
                Some(v) if v.kind() == "call_expression" => self.find_initializer_returned_object(v, 0),
                _ => None,
            };
            let extract_object_methods = is_exported && object_of_fns.is_some();

            // Visit the initializer body for calls — EXCEPT object literals
            // and the store-factory call whose returned object we extract
            // method-by-method below (walking the whole call would re-visit
            // those method arrows and mis-attribute their inner calls to the
            // file/module scope). Object literals are not walked for calls
            // either, but their identifier values (shorthand members, pair
            // values) are surfaced so function-as-value dependencies stay
            // visible.
            if let Some(v) = value {
                if matches!(v.kind(), "object" | "object_expression") {
                    self.collect_object_value_references(v);
                } else if !(extract_object_methods && v.kind() == "call_expression") {
                    self.visit_function_body(v);
                }
            }

            if extract_object_methods {
                if let Some(obj) = object_of_fns {
                    self.extract_object_literal_functions(obj);
                }
            }
        }
    }

    // --- object-literal / store helpers -------------------------------------------------

    pub(super) fn extract_object_literal_functions(&mut self, obj: Node<'t>) {
        for i in 0..obj.named_child_count() {
            let Some(member) = obj.named_child(i) else { continue };
            if member.kind() == "pair" {
                let key = member.child_by_field_name("key");
                let value = member.child_by_field_name("value");
                if let (Some(k), Some(v)) = (key, value) {
                    if matches!(v.kind(), "arrow_function" | "function_expression") {
                        let name = util::object_key_name(self.text(k));
                        self.extract_function(v, Some(name));
                    } else if v.kind() == "identifier" {
                        // `{ key: fn }` — a function passed as a value, not only called.
                        self.extract_value_reference(v);
                    }
                }
            } else if member.kind() == "method_definition" {
                // Method shorthand: `{ fetchUser() {...} }`. extractMethod
                // deliberately skips object-literal methods, so route through
                // extractFunction with an explicit name.
                if let Some(k) = member.child_by_field_name("name") {
                    let name = util::object_key_name(self.text(k));
                    self.extract_function(member, Some(name));
                }
            } else if member.kind() == "shorthand_property_identifier" {
                // `{ fn }` — abbreviation of `{ fn: fn }`: a function passed
                // as a value. The `_pattern` form is a destructuring binding.
                self.extract_value_reference(member);
            }
        }
    }

    /// collectObjectValueReferences (tree-sitter.ts): top-level object
    /// literals are skipped by the call walker (their function-valued
    /// properties are extracted separately), so surface the identifier
    /// values in them — shorthand members and pair values — here.
    fn collect_object_value_references(&mut self, obj: Node<'t>) {
        stack_guard!();
        for i in 0..obj.named_child_count() {
            let Some(member) = obj.named_child(i) else { continue };
            if member.kind() == "shorthand_property_identifier" {
                self.extract_value_reference(member);
                continue;
            }
            if member.kind() != "pair" {
                continue;
            }
            if let Some(value) = member.child_by_field_name("value") {
                if value.kind() == "identifier" {
                    self.extract_value_reference(value);
                } else if matches!(value.kind(), "object" | "object_expression") {
                    self.collect_object_value_references(value);
                }
            }
        }
    }

    fn find_initializer_returned_object(&self, call: Node<'t>, depth: u32) -> Option<Node<'t>> {
        stack_guard!();
        if depth > 4 {
            return None;
        }
        let args = call.child_by_field_name("arguments")?;
        for i in 0..args.named_child_count() {
            let Some(arg) = args.named_child(i) else { continue };
            if matches!(arg.kind(), "arrow_function" | "function_expression") {
                if let Some(obj) = self.function_returned_object(arg) {
                    return Some(obj);
                }
            } else if arg.kind() == "call_expression" {
                if let Some(obj) = self.find_initializer_returned_object(arg, depth + 1) {
                    return Some(obj);
                }
            }
        }
        None
    }

    fn function_returned_object(&self, fn_node: Node<'t>) -> Option<Node<'t>> {
        fn as_object<'t>(n: Node<'t>) -> Option<Node<'t>> {
            stack_guard!();
            match n.kind() {
                "object" | "object_expression" => Some(n),
                "parenthesized_expression" => {
                    for i in 0..n.named_child_count() {
                        if let Some(inner) = n.named_child(i).and_then(as_object) {
                            return Some(inner);
                        }
                    }
                    None
                }
                _ => None,
            }
        }
        let body = fn_node.child_by_field_name("body")?;
        if let Some(direct) = as_object(body) {
            return Some(direct);
        }
        if body.kind() == "statement_block" {
            for i in 0..body.named_child_count() {
                let Some(stmt) = body.named_child(i) else { continue };
                if stmt.kind() != "return_statement" {
                    continue;
                }
                for j in 0..stmt.named_child_count() {
                    if let Some(obj) = stmt.named_child(j).and_then(as_object) {
                        return Some(obj);
                    }
                }
            }
        }
        None
    }

    // --- extractTypeAlias + members (#359, #634) -------------------------------------

    /// Returns skipChildren (always false on the TS path — the alias value is
    /// still traversed by the dispatcher).
    pub(super) fn extract_type_alias(&mut self, node: Node<'t>) -> bool {
        let name = self.extract_name(node);
        if name == "<anonymous>" {
            return false;
        }
        let extra = Extra {
            docstring: crate::docstring::preceding_docstring_tsjs(node, self.src),
            is_exported: Some(self.is_exported(node)),
            ..Extra::default()
        };
        let Some(row) = self.create_node("type_alias", &name, node, extra) else {
            return false;
        };
        if let Some(value) = node.child_by_field_name("value") {
            self.extract_type_refs_from_subtree(value, row);
            self.extract_ts_type_alias_members(value, row, &name);
            self.extract_ts_tuple_contract_names(value, row, &name);
        }
        false
    }

    /// extractTsTypeAliasMembers (tree-sitter.ts): collect the immediate
    /// object_type operands so anonymous nested object types inside generic
    /// arguments (`Promise<{ ok: true }>`) don't produce phantom members,
    /// then run the shared contract-member walk INLINE (only interface
    /// members are held for the post-walk flush).
    fn extract_ts_type_alias_members(&mut self, value: Node<'t>, alias_row: u32, alias_name: &str) {
        let mut object_types: Vec<Node> = Vec::new();
        if value.kind() == "object_type" {
            object_types.push(value);
        } else if value.kind() == "intersection_type" {
            for i in 0..value.named_child_count() {
                if let Some(op) = value.named_child(i) {
                    if op.kind() == "object_type" {
                        object_types.push(op);
                    }
                }
            }
        } else {
            return;
        }

        self.stack.push(Scope { row: alias_row, kind: "type_alias", name: alias_name.to_string() });
        self.extract_ts_contract_members(alias_name, alias_row, &object_types);
        self.stack.pop();
    }

    fn extract_ts_tuple_contract_names(&mut self, value: Node<'t>, alias_row: u32, alias_name: &str) {
        let mut tuples: Vec<Node> = Vec::new();
        fn collect<'t>(n: Node<'t>, depth: u32, out: &mut Vec<Node<'t>>) {
            stack_guard!();
            if depth > 6 {
                return;
            }
            if n.kind() == "tuple_type" {
                out.push(n);
            }
            for i in 0..n.named_child_count() {
                if let Some(c) = n.named_child(i) {
                    collect(c, depth + 1, out);
                }
            }
        }
        collect(value, 0, &mut tuples);
        if tuples.is_empty() {
            return;
        }

        self.stack.push(Scope { row: alias_row, kind: "type_alias", name: alias_name.to_string() });
        for tuple in tuples {
            for i in 0..tuple.named_child_count() {
                let Some(entry) = tuple.named_child(i) else { continue };
                if entry.kind() != "generic_type" {
                    continue;
                }
                let Some(type_args) = entry.child_by_field_name("type_arguments") else { continue };
                for j in 0..type_args.named_child_count() {
                    let Some(arg) = type_args.named_child(j) else { continue };
                    if arg.kind() != "literal_type" {
                        continue;
                    }
                    let Some(str_node) = arg.named_child(0) else { continue };
                    if str_node.kind() != "string" {
                        continue;
                    }
                    let name = util::object_key_name(self.text(str_node).trim());
                    if !util::ident_dollar().is_match(&name) {
                        continue;
                    }
                    let collapsed = collapse_ws(self.text(entry));
                    let (signature, _) = util::slice_utf16(collapsed.trim(), 120);
                    let extra = Extra {
                        signature: Some(signature),
                        qualified_name: Some(format!("{alias_name}::{name}")),
                        ..Extra::default()
                    };
                    self.create_node("method", &name, entry, extra);
                }
            }
        }
        self.stack.pop();
    }

    pub(super) fn is_ts_function_typed_property(&self, property_signature: Node) -> bool {
        let Some(type_anno) = property_signature.child_by_field_name("type") else {
            return false;
        };
        for i in 0..type_anno.named_child_count() {
            if let Some(inner) = type_anno.named_child(i) {
                if inner.kind() == "function_type" {
                    return true;
                }
            }
        }
        false
    }

    // --- extractImport ---------------------------------------------------------------

    pub(super) fn extract_import(&mut self, node: Node<'t>) {
        let import_text = self.text(node).trim().to_string();
        // typescriptExtractor.extractImport: the `source` field, quotes stripped
        // globally. A missing/empty module means the hook declined — no node.
        let Some(source_field) = node.child_by_field_name("source") else { return };
        let module_name: String = self
            .text(source_field)
            .chars()
            .filter(|c| *c != '\'' && *c != '"')
            .collect();
        if module_name.is_empty() {
            return;
        }
        self.create_node(
            "import",
            &module_name,
            node,
            Extra { signature: Some(import_text), ..Extra::default() },
        );
        // Fork shape: ONE `imports` ref carrying the module name — no
        // per-binding refs, no re-export specifier refs.
        self.push_ref(self.top_row(), &module_name, edge_kind_index("imports").unwrap(), node);
    }

    // --- extractCall (TS/JS generic tail) -------------------------------------------------

    pub(super) fn extract_call(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let func = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0));
        let mut callee_name = String::new();

        if let Some(func) = func {
            if func.kind() == "member_expression" {
                let property = func
                    .child_by_field_name("property")
                    .or_else(|| func.child_by_field_name("field"))
                    .or_else(|| func.named_child(1));
                if let Some(property) = property {
                    let method_name = self.text(property);
                    let receiver = func
                        .child_by_field_name("object")
                        .or_else(|| func.child_by_field_name("operand"))
                        .or_else(|| func.child_by_field_name("argument"))
                        .or_else(|| func.named_child(0));
                    // Fork shape: literal receivers (`[...].sort()`,
                    // `/re/.exec()`) keep the bare method-name `calls` ref —
                    // the upstream #1230 early-return is NOT fork behavior.
                    let recv_ident = receiver.filter(|r| {
                        matches!(r.kind(), "identifier" | "simple_identifier" | "field_identifier")
                    });
                    if let Some(r) = recv_ident {
                        let receiver_name = self.text(r);
                        if !matches!(receiver_name, "self" | "this" | "cls" | "super") {
                            callee_name = format!("{receiver_name}.{method_name}");
                        } else {
                            callee_name = method_name.to_string();
                        }
                    } else {
                        // (the call-receiver re-encode branches are other
                        // languages'; TS/JS keeps the bare method name)
                        callee_name = method_name.to_string();
                    }
                }
            } else {
                callee_name = self.text(func).to_string();
            }
        }

        if !callee_name.is_empty() {
            self.push_call_ref(&callee_name.clone(), node);
        }
    }

    // --- extractInstantiation -----------------------------------------------------------

    pub(super) fn extract_instantiation(&mut self, node: Node<'t>) {
        if self.stack.is_empty() {
            return;
        }
        let ctor = node
            .child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("type"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        let Some(ctor) = ctor else { return };

        let mut class_name = self.text(ctor).to_string();
        // `new Map<K, V>()` → Map.
        if let Some(lt) = class_name.find('<') {
            if lt > 0 {
                class_name.truncate(lt);
            }
        }
        // `new ns.Foo()` → Foo.
        let last_dot = class_name
            .rfind('.')
            .map(|i| i as isize)
            .unwrap_or(-1)
            .max(class_name.rfind("::").map(|i| i as isize).unwrap_or(-1));
        if last_dot >= 0 {
            class_name = class_name[(last_dot as usize + 1)..].to_string();
            // TS: .replace(/^[:.]/, '') — one leading colon-or-dot.
            if class_name.starts_with(':') || class_name.starts_with('.') {
                class_name.remove(0);
            }
        }
        let class_name = class_name.trim().to_string();
        if !class_name.is_empty() {
            let from = self.top_row();
            self.push_ref(from, &class_name, edge_kind_index("instantiates").unwrap(), node);
        }
    }

    // --- returnType / params (Node field parity, P1 tsjs batch) ------------------------

    /// returnTypeNode + returnTypeText (tree-sitter.ts). Only the TS-family
    /// configs declare `returnField: 'return_type'`; javascript/jsx declare
    /// none, so the fork resolves a null annotation node there. Raw text,
    /// leading colon stripped, truncated at RETURN_TYPE_MAX_LENGTH UTF-16
    /// units — not normalized (the resolver classifies the shape).
    fn return_type_text_of(&self, node: Node) -> Option<String> {
        if !self.variant.is_ts() {
            return None;
        }
        let rt = node.child_by_field_name("return_type")?;
        let text = self.text(rt).trim();
        let stripped = text.strip_prefix(':').map(|s| s.trim_start()).unwrap_or(text);
        if stripped.is_empty() {
            return None;
        }
        Some(util::slice_utf16(stripped, RETURN_TYPE_MAX_LENGTH).0)
    }

    /// extractParamTypePairs (tree-sitter.ts), serialized for the extraJson
    /// escape hatch — the NODE wire row has no params column, and decode.ts
    /// Object.assigns the parsed object onto the Node. Shape is the FORK
    /// Node.params form {name, type} (the DB's {n,t} serialization happens
    /// fork-side, downstream). PARAM_TYPE_LANGUAGES = typescript/tsx/
    /// javascript (jsx excluded); the JS grammar naturally yields no pairs
    /// (bare-identifier params are never required/optional_parameter).
    fn extract_param_type_pairs_json(&self, node: Node) -> Option<String> {
        if matches!(self.variant, Variant::Jsx) {
            return None;
        }
        let params = node.child_by_field_name("parameters")?;
        let mut budget = PARAMS_JSON_MAX_CHARS;
        let mut json = String::from("{\"params\":[");
        let mut count = 0usize;
        for i in 0..params.named_child_count() {
            let Some(child) = params.named_child(i) else { continue };
            if !matches!(child.kind(), "required_parameter" | "optional_parameter") {
                continue;
            }
            let Some(pattern) = child.child_by_field_name("pattern") else { continue };
            if pattern.kind() != "identifier" {
                continue;
            }
            let Some(annotation) = child.child_by_field_name("type") else { continue };
            let name = self.text(pattern);
            let raw = self.text(annotation);
            let stripped = raw.strip_prefix(':').map(|s| s.trim_start()).unwrap_or(raw);
            let ty = util::slice_utf16(stripped, PARAM_TYPE_MAX_CHARS).0;
            if name.is_empty() || ty.is_empty() {
                continue;
            }
            // JS `.length` is UTF-16 units on both sides of the budget check.
            let cost = util::utf16_len(name) + util::utf16_len(&ty);
            if cost > budget {
                break;
            }
            budget -= cost;
            if count > 0 {
                json.push(',');
            }
            json.push_str("{\"name\":");
            util::push_json_string(&mut json, name);
            json.push_str(",\"type\":");
            util::push_json_string(&mut json, &ty);
            json.push('}');
            count += 1;
        }
        if count == 0 {
            return None;
        }
        json.push_str("]}");
        Some(json)
    }

    // --- CodePlan statement nodes (fork-only semantics, P1 tsjs batch) ------------------

    /// extractCodePlanStatement (tree-sitter.ts): triple gate — syntactic
    /// statement shape (CODEPLAN_DEPENDENCY_STATEMENT_KINDS), stack-top scope
    /// is function/method/component, and the subtree holds a call or
    /// instantiation (pre-scan stops at nested function scopes). On pass:
    /// emit the stmt node (name `stmt@<1-based row>:<UTF-16 col>`,
    /// signature = whitespace-flattened source slice at 240 UTF-16 units),
    /// push it as the attribution scope, walk the subtree once for
    /// dependency refs, pop. The outer body walk keeps descending and
    /// re-emits the same calls against the host function, and nested
    /// qualifying statements each emit their own OVERLAPPING stmt node —
    /// the fork's multi-attribution semantics (graph.test.ts pins that the
    /// function AND the stmt both hold the Instantiates edge).
    pub(super) fn extract_code_plan_statement(&mut self, node: Node<'t>) {
        // CODEPLAN_STATEMENT_LANGUAGES covers all four tsjs variants, so the
        // fork's language gate is structurally satisfied by this walker.
        if !is_codeplan_statement_kind(node.kind()) {
            return;
        }
        // currentStackNode().kind gate — the stack Scope carries the kind the
        // TS side re-looks-up by id (same value: ids encode kind+name+line).
        let parent_ok = self
            .stack
            .last()
            .map(|s| matches!(s.kind, "function" | "method" | "component"))
            .unwrap_or(false);
        if !parent_ok {
            return;
        }
        if !self.has_code_plan_statement_dependency(node, true) {
            return;
        }

        let name = format!("stmt@{}:{}", node.start_position().row + 1, self.col_of(node));
        let (signature, _) = util::slice_utf16(&collapse_ws(self.text(node).trim()), STATEMENT_SIGNATURE_MAX);
        let Some(row) = self.create_node(
            "statement",
            &name,
            node,
            Extra { signature: Some(signature), ..Extra::default() },
        ) else {
            return;
        };

        self.stack.push(Scope { row, kind: "statement", name });
        self.extract_code_plan_statement_dependencies(node, true);
        self.stack.pop();
    }

    /// hasCodePlanStatementDependency: does the subtree hold a call_expression
    /// or an INSTANTIATION_KINDS node? Stops at nested function scopes; the
    /// root is exempt, mirroring the TS `current !== node` identity check
    /// (web-tree-sitter hands fresh wrappers for every navigation, so only
    /// the initial same-object call sees the root). extractBareCall is
    /// undefined for the TS/JS configs — that TS branch never fires.
    fn has_code_plan_statement_dependency(&self, node: Node, is_root: bool) -> bool {
        stack_guard!();
        if !is_root && is_function_type(node.kind()) {
            return false;
        }
        if node.kind() == "call_expression" || is_instantiation_kind(node.kind()) {
            return true;
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                if self.has_code_plan_statement_dependency(c, false) {
                    return true;
                }
            }
        }
        false
    }

    /// extractCodePlanStatementDependencies: attribute every call /
    /// instantiation in the statement subtree to the stmt scope (current
    /// stack top), recursing through children WITHOUT an early return after
    /// a hit — nested calls (`foo(bar())`) each get their own ref — and
    /// stopping at nested function scopes (their bodies attribute to their
    /// own nodes). Like the TS original this walk performs no fn-ref
    /// capture, no value-reference extraction, and no variable-annotation
    /// handling — calls and instantiations only.
    fn extract_code_plan_statement_dependencies(&mut self, node: Node<'t>, is_root: bool) {
        stack_guard!();
        if !is_root && is_function_type(node.kind()) {
            return;
        }
        if node.kind() == "call_expression" {
            self.extract_call(node);
        } else if is_instantiation_kind(node.kind()) {
            self.extract_instantiation(node);
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.extract_code_plan_statement_dependencies(c, false);
            }
        }
    }

    // --- extractDecoratorsFor --------------------------------------------------------------

    pub(super) fn extract_decorators_for(&mut self, decl: Node<'t>, decorated_row: u32) {
        // 1. Direct children (method/property style).
        for i in 0..decl.named_child_count() {
            let Some(child) = decl.named_child(i) else { continue };
            self.consider_decorator(child, decorated_row);
            if child.kind() == "modifiers" {
                for j in 0..child.named_child_count() {
                    if let Some(m) = child.named_child(j) {
                        self.consider_decorator(m, decorated_row);
                    }
                }
            }
        }
        // 2. Preceding siblings (TypeScript class style), stopping at the
        //    first non-decorator so an earlier declaration's decorators never
        //    leak in. Matching by startIndex, not object identity.
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
        if !matches!(n.kind(), "decorator" | "annotation" | "marker_annotation" | "attribute") {
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
            if matches!(
                child.kind(),
                "identifier" | "member_expression" | "scoped_identifier" | "navigation_expression"
                    | "user_type" | "type_identifier"
            ) {
                target = Some(child);
                break;
            }
        }
        let Some(target) = target else { return };
        let mut name = self.text(target).to_string();
        if let Some(lt) = name.find('<') {
            if lt > 0 {
                name.truncate(lt);
            }
        }
        let last_dot = name
            .rfind('.')
            .map(|i| i as isize)
            .unwrap_or(-1)
            .max(name.rfind("::").map(|i| i as isize).unwrap_or(-1));
        if last_dot >= 0 {
            name = name[(last_dot as usize + 1)..].to_string();
            if name.starts_with(':') || name.starts_with('.') {
                name.remove(0);
            }
        }
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.push_ref(decorated_row, &name, edge_kind_index("decorates").unwrap(), n);
    }

    // --- extractInheritance (TS/JS clauses) ---------------------------------------------------

    pub(super) fn extract_inheritance(&mut self, node: Node<'t>, class_row: u32) {
        stack_guard!();
        let extends_kind = edge_kind_index("extends").unwrap();
        let implements_kind = edge_kind_index("implements").unwrap();
        for i in 0..node.named_child_count() {
            let Some(child) = node.named_child(i) else { continue };
            match child.kind() {
                // TS `extends_clause` (the other spellings are other grammars').
                "extends_clause" | "superclass" | "base_clause" | "extends_interfaces" => {
                    if let Some(target) = child.named_child(0) {
                        let name = self.text(target).to_string();
                        self.push_ref(class_row, &name, extends_kind, target);
                    }
                }
                "implements_clause" | "class_interface_clause" | "super_interfaces" | "interfaces" => {
                    for j in 0..child.named_child_count() {
                        if let Some(iface) = child.named_child(j) {
                            let name = self.text(iface).to_string();
                            self.push_ref(class_row, &name, implements_kind, iface);
                        }
                    }
                }
                // JS `class Foo extends Bar` — class_heritage holds a bare
                // identifier without an extends_clause wrapper.
                "identifier" | "type_identifier" if node.kind() == "class_heritage" => {
                    let name = self.text(child).to_string();
                    self.push_ref(class_row, &name, extends_kind, child);
                }
                // TS class_heritage wraps extends/implements — recurse.
                "field_declaration_list" | "class_heritage" => {
                    self.extract_inheritance(child, class_row);
                }
                _ => {}
            }
        }
    }

    // --- type annotations (#381 — TS family only) ----------------------------------------------

    pub(super) fn extract_type_annotations(&mut self, node: Node<'t>, from_row: u32) {
        if !self.variant.is_ts() {
            return;
        }
        if let Some(params) = node.child_by_field_name("parameters") {
            self.extract_type_refs_from_subtree(params, from_row);
        }
        if let Some(ret) = node.child_by_field_name("return_type") {
            self.extract_type_refs_from_subtree(ret, from_row);
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    pub(super) fn extract_variable_type_annotation(&mut self, node: Node<'t>, from_row: u32) {
        if !self.variant.is_ts() {
            return;
        }
        let type_annotation = (0..node.named_child_count())
            .filter_map(|i| node.named_child(i))
            .find(|c| c.kind() == "type_annotation");
        if let Some(ta) = type_annotation {
            self.extract_type_refs_from_subtree(ta, from_row);
        }
    }

    fn extract_type_refs_from_subtree(&mut self, node: Node<'t>, from_row: u32) {
        stack_guard!();
        if node.kind() == "type_identifier" {
            let type_name = self.text(node).to_string();
            if !type_name.is_empty() && !is_builtin_type(&type_name) {
                self.push_ref(from_row, &type_name, edge_kind_index("references").unwrap(), node);
            }
            return;
        }
        for i in 0..node.named_child_count() {
            if let Some(c) = node.named_child(i) {
                self.extract_type_refs_from_subtree(c, from_row);
            }
        }
    }
}

/// `.replace(/\s+/g, ' ')` for the tuple-contract signature.
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}
