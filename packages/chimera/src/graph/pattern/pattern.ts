// Ported from ast-grep (MIT) crates/core/src/matcher/pattern.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Chimera adaptation decisions (the two big impedance collapses):
// 1. Doc/Node collapse: ast-grep layers `Doc`/`SgNode`/`Source` traits over the
//    native tree-sitter bindings. Here everything operates directly on
//    web-tree-sitter `Node` (see ../web-tree-sitter-types.ts) plus the original
//    JS source string. Pattern trees are materialized into a plain
//    `PatternNode` data structure at compile time, so a compiled `Pattern`
//    holds no wasm memory; `findMatches` materializes capture text eagerly and
//    deletes the candidate tree before returning.
// 2. Offset mapping: web-tree-sitter `startIndex`/`endIndex` are UTF-16
//    code-unit offsets into the JS string (NOT UTF-8 bytes — this follows the
//    existing extraction convention in
//    src/graph/extraction/tree-sitter-helpers.ts `getNodeText`, which does
//    `source.substring(node.startIndex, node.endIndex)`). Every range in this
//    module uses the same convention, so ranges splice JS strings directly.
// 3. Kind constraints: ast-grep's KindMatcher/potential_kinds are not exposed
//    in v1 (no `kind:` filters). Node kind identity uses the `type` string and
//    the ERROR-kind wildcard from strictness.ts.
// 4. Strictness: ast-grep's default Pattern strictness is `Smart`; this port
//    fixes Smart as the default (overridable internally for conformance tests).
//    Contextual patterns (selector) are not ported.
// 5. Error patterns: instead of ast-grep's `Pattern::has_error()` + caller
//    check, a pattern whose tree contains a tree-sitter ERROR node is rejected
//    at compile time with a clean 'parse-failed' error.

import type { Node, Tree } from '../web-tree-sitter-types'
import { getParser, initGrammars, loadGrammarsForLanguages } from '../extraction/grammars'
import type { Language } from '../types'
import type { MetaVariable } from './meta-var'
import { expandoChar, extractMetaVar, MetaVarEnv, metaVarChar, preprocessPattern } from './meta-var'
import { createEnv, matchEndNonRecursive, matchNodeNonRecursive } from './match-tree'
import { getIndentAtOffset } from './indent'
import type { MatchStrictness } from './strictness'

export type { MatchStrictness, MatchOneNode } from './strictness'
export type { MetaVariable } from './meta-var'

/**
 * A compiled pattern node tree. Mirrors ast-grep's `PatternNode`, with kind ids
 * replaced by node type strings.
 */
export type PatternNode =
  | { kind: 'metavar'; metaVar: MetaVariable; isTrivial: false }
  // Node without children.
  | {
      kind: 'terminal'
      text: string
      isNamed: boolean
      nodeType: string
      isErrorKind: boolean
      isTrivial: boolean
    }
  // Non-terminal syntax nodes are called "internal" in ast-grep.
  | {
      kind: 'internal'
      nodeType: string
      isErrorKind: boolean
      children: PatternNode[]
      isTrivial: false
    }

export interface Pattern {
  readonly node: PatternNode
  /** pre-processed pattern source (what was actually parsed) */
  readonly src: string
  readonly rawSrc: string
  readonly lang: Language
  readonly strictness: MatchStrictness
  readonly expando: string
  /** node type of the pattern root, or undefined for a bare-metavar root */
  readonly rootKindType: string | undefined
}

export type PatternErrorKind =
  | 'parse-failed'
  | 'no-content'
  | 'multiple-node'
  | 'root-multi-metavar'
  | 'grammar-not-loaded'

export interface PatternError {
  readonly kind: PatternErrorKind
  readonly message: string
}

export type CompileResult = { ok: true; pattern: Pattern } | { ok: false; error: PatternError }

/** UTF-16 code-unit range into the source string. */
export interface PatternRange {
  start: number
  end: number
}

export interface CapturedNode extends PatternRange {
  text: string
}

/**
 * A metavariable binding materialized from the candidate source. `text` is the
 * span covering all bound nodes (first.start..last.end), matching ast-grep's
 * `get_var_bytes`.
 */
export interface PatternCapture {
  nodes: CapturedNode[]
  /** true when bound via `$$$NAME` (multi capture), false for `$NAME`. */
  multi: boolean
  /**
   * Span covering all bound nodes (first.start..last.end), matching ast-grep's
   * `get_var_bytes`. For single captures this is the node text itself.
   */
  text: string
  /**
   * Source indentation (spaces) of the line the capture starts on, computed
   * from the capture's own document at match time. Used by the template
   * replacer to de-indent multi-line captures (ast-grep
   * `extract_with_deindent` step 1-2).
   */
  sourceIndent: number
}

export interface PatternMatch {
  /** node type of the matched candidate node */
  nodeType: string
  /** range of the matched node */
  range: PatternRange
  /**
   * Range to replace: the node range extended to the match end so trailing
   * ellipsis bindings (`$$$A` swallowing trailing siblings) are covered.
   * Port of ast-grep's `Matcher::get_match_len`/`get_replaced_range`.
   */
  replacedRange: PatternRange
  captures: Map<string, PatternCapture>
  /**
   * Capture texts formatted like ast-grep's `HashMap::from(MetaVarEnv)`:
   * single captures show their node text, multi captures "[a, b]".
   */
  captureDisplay: Map<string, string>
}

/** Port of `is_single_node`: a pattern must cover exactly one AST node. */
function isSingleNode(node: Node): boolean {
  const count = node.childCount
  if (count === 1) return true
  if (count === 2) {
    const second = node.child(1)
    if (!second) return false
    // some languages have weird empty syntax nodes at the end
    // (see ast-grep's golang `$A = 0` pattern test case)
    return second.isMissing || second.type === ''
  }
  return false
}

/** Port of `convert_node_to_pattern`. */
function convertNodeToPattern(node: Node, source: string, expando: string): PatternNode {
  const text = source.substring(node.startIndex, node.endIndex)
  const metaVar = extractMetaVar(text, expando)
  if (metaVar) return { kind: 'metavar', metaVar, isTrivial: false }
  if (node.childCount === 0) {
    return {
      kind: 'terminal',
      text,
      isNamed: node.isNamed,
      nodeType: node.type,
      isErrorKind: node.isError,
      isTrivial: !node.isNamed,
    }
  }
  // Non-Terminal Syntax Nodes are called Internal
  const children = node.children
    .filter((child) => !child.isMissing)
    .map((child) => convertNodeToPattern(child, source, expando))
  return {
    kind: 'internal',
    nodeType: node.type,
    isErrorKind: node.isError,
    children,
    isTrivial: false,
  }
}

/** Deviation from ast-grep: ERROR nodes anywhere in the pattern reject compilation. */
function containsErrorKind(node: PatternNode): boolean {
  if (node.kind === 'metavar') return false
  if (node.isErrorKind) return true
  if (node.kind === 'internal') return node.children.some(containsErrorKind)
  return false
}

/** Port of `PatternNode::is_trivial` (for skipping trivial goal nodes after an ellipsis). */
export function collectDefinedVars(node: PatternNode, into: Set<string> = new Set()): Set<string> {
  if (node.kind === 'metavar') {
    if (node.metaVar.type === 'capture' || node.metaVar.type === 'multi-capture') {
      into.add(node.metaVar.name)
    }
    return into
  }
  // collect nothing for terminal nodes!
  if (node.kind === 'internal') node.children.forEach((c) => collectDefinedVars(c, into))
  return into
}

/**
 * Ensure the WASM grammar for `language` is loaded (async — parse/compile are
 * synchronous afterwards). Port of the language init ast-grep does per binary.
 */
export async function ensureGrammarLoaded(language: Language): Promise<void> {
  await initGrammars()
  await loadGrammarsForLanguages([language])
}

function parseToTree(language: Language, source: string): Tree | undefined {
  const parser = getParser(language)
  if (!parser) return undefined
  return parser.parse(source) ?? undefined
}

/**
 * Parse a source string into a tree-sitter Tree for matching. The returned
 * tree is owned by the caller: keep it alive while raw nodes are reachable,
 * call `tree.delete()` when done. Most callers should prefer `findMatches`,
 * which parses and cleans up internally.
 */
export function parseSource(language: Language, source: string): Tree | undefined {
  return parseToTree(language, source)
}

/**
 * Port of `PatternBuilder::build` + `Pattern::try_new`.
 *
 * Parses `pattern` with the language grammar (after expando pre-processing),
 * enforces the single-node rule, rejects standalone `$$$MULTI` roots, and
 * materializes the pattern tree.
 */
export function compilePattern(pattern: string, lang: Language, opts?: { strictness?: MatchStrictness }): CompileResult {
  const src = preprocessPattern(pattern, expandoChar(lang))
  const tree = parseToTree(lang, src)
  if (!tree) {
    return {
      ok: false,
      error: {
        kind: 'grammar-not-loaded',
        message: `Grammar for language \`${lang}\` is not loaded. Await ensureGrammarLoaded('${lang}') first.`,
      },
    }
  }
  try {
    return buildPatternFromTree(tree, pattern, src, lang, opts?.strictness ?? 'smart')
  } finally {
    tree.delete()
  }
}

function buildPatternFromTree(
  tree: Tree,
  rawSrc: string,
  src: string,
  lang: Language,
  strictness: MatchStrictness
): CompileResult {
  const expando = expandoChar(lang)
  const root = tree.rootNode
  if (root.childCount === 0) {
    return { ok: false, error: noContent(rawSrc) }
  }
  if (!isSingleNode(root)) {
    return { ok: false, error: multipleNode(rawSrc) }
  }
  // Port of `Pattern::single_matcher`: descend single-child wrappers.
  let inner = root
  while (isSingleNode(inner)) {
    const first = inner.child(0)
    if (!first) break
    inner = first
  }
  const node = convertNodeToPattern(inner, src, expando)
  if (containsErrorKind(node)) {
    return {
      ok: false,
      error: {
        kind: 'parse-failed',
        message: `Fails to parse the pattern query: \`${rawSrc}\``,
      },
    }
  }
  // A multi meta variable matches a list of nodes, but a pattern matches a
  // single node, so `$$$MULTI` as the root of a pattern is invalid input.
  if (node.kind === 'metavar' && (node.metaVar.type === 'multi-capture' || node.metaVar.type === 'multiple')) {
    return {
      ok: false,
      error: {
        kind: 'root-multi-metavar',
        message: `Standalone multi meta variable \`${rawSrc}\` is invalid. Use \`$VAR\` or wrap \`$$$VAR\` in a larger pattern.`,
      },
    }
  }
  return {
    ok: true,
    pattern: {
      node,
      src,
      rawSrc,
      lang,
      strictness,
      expando,
      rootKindType: node.kind === 'metavar' ? undefined : node.nodeType,
    },
  }
}

const noContent = (src: string): PatternError => ({
  kind: 'no-content',
  message: `No AST root is detected. Please check the pattern source \`${src}\`.`,
})

const multipleNode = (src: string): PatternError => ({
  kind: 'multiple-node',
  message: `Multiple AST nodes are detected. Please check the pattern source \`${src}\`.`,
})

/**
 * Materialize a successful match: snapshot the env into plain capture data so
 * the result outlives the candidate tree (and its wasm memory).
 */
function materializeMatch(
  pattern: Pattern,
  node: Node,
  env: MetaVarEnv,
  source: string
): PatternMatch {
  const end = matchEndNonRecursive(pattern.node, node, pattern.strictness, source)
  const captures = new Map<string, PatternCapture>()
  env.visitCaptures((name, nodes, multi) => {
    const materialized = nodes.map((n) => ({
      start: n.startIndex,
      end: n.endIndex,
      text: source.substring(n.startIndex, n.endIndex),
    }))
    if (nodes.length === 0) {
      // ast-grep lets an ellipsis bind zero nodes (`foo($$$A, a, b, c)` vs
      // `foo(a, b, c)` binds A to an empty list); display stays "[]"
      captures.set(name, { nodes: [], multi, text: '', sourceIndent: 0 })
      return
    }
    const first = materialized[0]
    const last = materialized[materialized.length - 1]
    captures.set(name, {
      nodes: materialized,
      multi,
      text: source.substring(first.start, last.end),
      sourceIndent: getIndentAtOffset(source.slice(0, first.start)),
    })
  })
  return {
    nodeType: node.type,
    range: { start: node.startIndex, end: node.endIndex },
    replacedRange: { start: node.startIndex, end: end ?? node.endIndex },
    captures,
    captureDisplay: env.toTextMap(),
  }
}

/**
 * Find all matches of `pattern` in `source` (DFS over every node, matching
 * ast-grep's `find_node`/`find_all` traversal which reports nested matches).
 * The candidate tree is parsed from `source` with the pattern's grammar and
 * deleted before returning; the result holds no wasm references.
 */
export function findMatches(pattern: Pattern, source: string): PatternMatch[] {
  const tree = parseToTree(pattern.lang, source)
  if (!tree) return []
  try {
    return findMatchesInTree(pattern, tree, source)
  } finally {
    tree.delete()
  }
}

/** Same as `findMatches` but reuses a caller-owned tree (kept alive). */
export function findMatchesInTree(pattern: Pattern, tree: Tree, source: string): PatternMatch[] {
  const out: PatternMatch[] = []
  const visit = (node: Node) => {
    const handle = createEnv(source)
    const matched = matchNodeNonRecursive(
      pattern.node,
      node,
      { env: handle.env, agg: handle.agg },
      pattern.strictness,
      source
    )
    if (matched) out.push(materializeMatch(pattern, node, handle.env, source))
    for (const child of node.children) visit(child)
  }
  visit(tree.rootNode)
  return out
}

/** First DFS match, or undefined. Port of `MatcherExt::find_node`. */
export function findFirstMatch(pattern: Pattern, source: string): PatternMatch | undefined {
  return findMatches(pattern, source)[0]
}

export { metaVarChar }
