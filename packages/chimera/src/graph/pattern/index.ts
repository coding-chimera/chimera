// Chimera structural pattern matching — port of ast-grep's core matcher.
//
// Ported from ast-grep (MIT) crates/core/src @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6:
//   matcher/pattern.rs, matcher/text.rs, match_tree/mod.rs, match_tree/match_node.rs,
//   match_tree/strictness.rs, meta_var.rs, replacer.rs (split_first_meta_var),
//   replacer/structural.rs, replacer/template.rs, replacer/indent.rs,
//   plus the expando table from crates/language/src/lib.rs.
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, distributed under
// the MIT license: https://github.com/ast-grep/ast-grep/blob/main/LICENSE
//
// ============================================================================
// Porting notes (the module entry; no README by design)
// ============================================================================
//
// Purpose: engine for the pattern-codemod mode (`rewrites`) of the `ast_edit`
// tool — wired in src/tool/ast_edit.ts (`runPatternMode`).
// Pure functions over web-tree-sitter (WASM) trees; no Effect, no opencode
// core imports, no top-level await (single-binary constraint for src/graph/).
//
// Adaptation decisions:
// 1. Doc/Node collapse. ast-grep abstracts the tree behind the `Doc`/`Node`/
//    `Source` traits (crates/core/src/{node,source,pinned}.rs) and a native
//    tree-sitter binding. Here everything operates directly on web-tree-sitter
//    `Node` (types in ../web-tree-sitter-types.ts) plus the original JS source
//    string; kind ids (u16) become node `type` strings. A compiled `Pattern`
//    is a plain data structure (no wasm memory) and `findMatches` snapshots
//    every capture into strings before deleting the candidate tree, so match
//    results are serializable and outlive the wasm tree.
// 2. Offset mapping. web-tree-sitter startIndex/endIndex are UTF-16 code-unit
//    offsets into the JS string (NOT UTF-8 bytes). This port follows the
//    existing extraction convention (`getNodeText` in
//    ../extraction/tree-sitter-helpers.ts does
//    `source.substring(node.startIndex, node.endIndex)`): every range exposed
//    here (PatternRange, PatternEdit) is a UTF-16 index pair, so ranges and
//    splices work on JS strings without conversion. (The ast-grep Rust code
//    uses byte offsets internally; the expando/pre-process string walks use
//    code units consistently instead.)
// 3. Strictness: fixed default = `Smart` (ast-grep's Pattern default;
//    comments/extras inside a structured pattern are skipped, anonymous
//    candidate punctuation skipped). Other strictness levels are ported and
//    reachable via compilePattern's internal `strictness` option for
//    conformance tests.
// 4. Not ported (v1 scope cuts): relational operators (ops.rs inside/has/
//    precedes/follows), KindMatcher + contextual patterns + potential_kinds
//    (no kind filters exposed), the `transform:` metavariable pipeline
//    (MetaVarEnv::transformed_var / MetaVarExtract::Transformed /
//    insert_transformation), and ast-grep's streaming fixer loop. Parse-error
//    patterns are rejected at compile time (ast-grep defers via has_error()).
// 5. Language subset: typescript/tsx, javascript, python are conformant-tested.
//    Other languages work if a Chimera WASM grammar exists and they are in the
//    expando table (../extraction/grammars.ts + ./meta-var.ts).
//
// Typical codemod flow (as wired into the ast_edit tool):
//   await ensureGrammarLoaded(lang)
//   const compiled = compilePattern(pattern, lang)
//   if (!compiled.ok) report compiled.error
//   for (const match of findMatches(compiled.pattern, source)) {
//     const replacement = renderTemplateReplacement(template, match, source)
//     edits.push(editForMatch(match, replacement))
//   }
//   const output = applyReplacements(source, edits)

export type {
  CompileResult,
  CapturedNode,
  Pattern,
  PatternCapture,
  PatternError,
  PatternErrorKind,
  PatternMatch,
  PatternNode,
  PatternRange,
} from './pattern'
export {
  compilePattern,
  collectDefinedVars,
  ensureGrammarLoaded,
  findFirstMatch,
  findMatches,
  findMatchesInTree,
  parseSource,
} from './pattern'
export type { MatchOneNode, MatchStrictness } from './strictness'
export type { MetaVariable, MetaVariableID } from './meta-var'
export { expandoChar, extractMetaVar, metaVarChar, preprocessPattern } from './meta-var'
export type { DeindentedExtract } from './indent'
export { extractWithDeindent, formattedSlice, getIndentAtOffset, indentLines } from './indent'
export type { PatternEdit } from './replacer'
export {
  applyReplacements,
  editForMatch,
  renderStructuralReplacement,
  renderTemplateReplacement,
  templateUsedVars,
} from './replacer'
export { RegexMatcher } from './text'
