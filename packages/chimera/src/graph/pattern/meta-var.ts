// Ported from ast-grep (MIT) crates/core/src/meta_var.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// Also ports the expando/pre-process pattern from crates/language/src/lib.rs.
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou <harrison.cz@outlook.com>,
// distributed under the MIT license (https://github.com/ast-grep/ast-grep/blob/main/LICENSE).
//
// Chimera adaptation notes:
// - `Node<'tree, D>` from the Rust original collapses onto web-tree-sitter `Node`
//   (see ./pattern.ts for the full Doc/Node collapse rationale).
// - `transformed_var` (rule `transform:` rewrites) is not ported in v1: relational
//   operators and transforms are out of scope for the pattern-codemod engine.
// - All offsets are UTF-16 code-unit indices into the JS source string, the
//   web-tree-sitter convention (see ./index.ts porting notes).

import type { Node } from '../web-tree-sitter-types'
import type { Language } from '../types'

export type MetaVariableID = string

export type MetaVariable =
  // $A for captured meta var
  | { type: 'capture'; name: MetaVariableID; named: boolean }
  // $_ for non-captured meta var
  | { type: 'dropped'; named: boolean }
  // $$$ for non-captured multi var
  | { type: 'multiple' }
  // $$$A for captured ellipsis
  | { type: 'multi-capture'; name: MetaVariableID }

const isValidFirstChar = (c: string) => (c >= 'A' && c <= 'Z') || c === '_'

export const isValidMetaVarChar = (c: string) => isValidFirstChar(c) || (c >= '0' && c <= '9')

/**
 * Port of `extract_meta_var(src, meta_char)`.
 *
 * `metaChar` is the *expando* char used by the pattern's language (e.g. '$' for
 * JS/TS, 'µ' for Python after pre-processing). It may be one UTF-16 code unit
 * ('µ', 'z') or two ('𐀀'); all string bookkeeping here is in code units.
 */
export function extractMetaVar(src: string, metaChar: string): MetaVariable | undefined {
  const ellipsis = metaChar.repeat(3)
  if (src === ellipsis) return { type: 'multiple' }
  if (src.startsWith(ellipsis)) {
    const trimmed = src.slice(ellipsis.length)
    if (!isAllMetaVarChar(trimmed)) return undefined
    // $$$_ is treated as an anonymous multiple
    return trimmed.startsWith('_') ? { type: 'multiple' } : { type: 'multi-capture', name: trimmed }
  }
  if (!src.startsWith(metaChar)) return undefined
  const rest = src.slice(metaChar.length)
  // $$A / $$$_ are the "unnamed" (non-capturing identifier) forms
  const unnamed = rest.startsWith(metaChar)
  const trimmed = unnamed ? rest.slice(metaChar.length) : rest
  const named = !unnamed
  // not in form of $A or $_ (empty or started with number / invalid char)
  if (trimmed.length === 0 || !isValidFirstChar(trimmed[0])) return undefined
  if (!isAllMetaVarChar(trimmed)) return undefined
  return trimmed.startsWith('_')
    ? { type: 'dropped', named }
    : { type: 'capture', name: trimmed, named }
}

function isAllMetaVarChar(s: string): boolean {
  for (const c of s) if (!isValidMetaVarChar(c)) return false
  return true
}

/**
 * Meta-variable special character. Default '$'. Mirrors ast-grep
 * `Language::meta_var_char` (crates/core/src/language.rs).
 */
export function metaVarChar(_lang: Language): string {
  return '$'
}

/**
 * Some languages do not accept '$' as the leading char of an identifier, so the
 * pattern text uses a stand-in character the grammar accepts (PEP 3131 allows
 * 'µ' in Python etc.). Port of ast-grep `Language::expando_char` and the
 * `impl_lang_expando!` table in crates/language/src/lib.rs. Languages absent
 * from the table use '$' directly.
 */
const EXPANDO_CHARS: Partial<Record<Language, string>> = {
  // https://en.cppreference.com/w/cpp/language/identifiers
  c: '\u{10000}',
  cpp: '\u{10000}',
  // https://www.compart.com/en/unicode/category/Nl
  csharp: 'µ',
  go: 'µ',
  terraform: 'µ',
  kotlin: 'µ',
  php: 'µ',
  python: 'µ',
  ruby: 'µ',
  rust: 'µ',
  swift: 'µ',
  nix: '_',

// Languages in ast-grep's expando table that Chimera's grammar set does not
// carry (css '_', html 'z', haskell/elixir/zig µ) have no entry here; they
// fall back to '$'.
}

export function expandoChar(lang: Language): string {
  return EXPANDO_CHARS[lang] ?? '$'
}

/**
 * Normalize pattern code before parsing: rewrite `$`/`$$`/`$$$` sigils that
 * introduce a metavariable (uppercase/underscore name, or a bare `$$$`) into
 * the language's expando char so the grammar can parse the pattern.
 * Port of `pre_process_pattern` in crates/language/src/lib.rs. A no-op when
 * the expando is '$'.
 */
export function preprocessPattern(query: string, expando: string): string {
  if (expando === '$') return query
  let ret = ''
  let dollarCount = 0
  for (const c of query) {
    if (c === '$') {
      dollarCount += 1
      continue
    }
    // $A or $$A or $$$A, and anonymous multiple ($$$ followed by anything)
    const needReplace = (c >= 'A' && c <= 'Z') || c === '_' || dollarCount === 3
    ret += (needReplace ? expando : '$').repeat(dollarCount)
    dollarCount = 0
    ret += c
  }
  // trailing anonymous multiple
  ret += (dollarCount === 3 ? expando : '$').repeat(dollarCount)
  return ret
}

/** A dictionary that stores metavariable instantiation. */
export class MetaVarEnv {
  private singleMatched = new Map<MetaVariableID, Node>()
  private multiMatched = new Map<MetaVariableID, Node[]>()

  constructor(
    private readonly source: string,
    private readonly matchesExactly: (goal: Node, candidate: Node) => boolean
  ) {}

  clone(): MetaVarEnv {
    const copy = new MetaVarEnv(this.source, this.matchesExactly)
    this.singleMatched.forEach((v, k) => copy.singleMatched.set(k, v))
    this.multiMatched.forEach((v, k) => copy.multiMatched.set(k, v))
    return copy
  }

  /**
   * Insert a single capture, enforcing repeated-metavariable equality
   * ($A == $A matches `x == x` but not `x == y`). Returns false on conflict.
   */
  insert(id: string, node: Node): boolean {
    const existing = this.singleMatched.get(id)
    if (existing !== undefined && !this.matchesExactly(existing, node)) return false
    this.singleMatched.set(id, node)
    return true
  }

  /** Insert a multi capture ($$$A), enforcing per-node equality on named nodes. */
  insertMulti(id: string, nodes: Node[]): boolean {
    const existing = this.multiMatched.get(id)
    if (existing !== undefined && !matchMultiVar(existing, nodes, this.matchesExactly)) return false
    this.multiMatched.set(id, nodes)
    return true
  }

  getMatch(id: string): Node | undefined {
    return this.singleMatched.get(id)
  }

  getMultipleMatches(id: string): Node[] {
    return this.multiMatched.get(id) ?? []
  }

  /** Iterate all bindings: [name, nodes, multi]. Singles are 1-element lists. */
  visitCaptures(cb: (name: string, nodes: Node[], multi: boolean) => void): void {
    this.singleMatched.forEach((node, name) => cb(name, [node], false))
    this.multiMatched.forEach((nodes, name) => cb(name, nodes, true))
  }

  /** Port of `impl From<MetaVarEnv> for HashMap<String, String>`. */
  toTextMap(): Map<string, string> {
    const ret = new Map<string, string>()
    this.singleMatched.forEach((node, id) => {
      ret.set(id, nodeText(node, this.source))
    })
    this.multiMatched.forEach((nodes, id) => {
      const texts = nodes.map((n) => nodeText(n, this.source)).join(', ')
      ret.set(id, `[${texts}]`)
    })
    return ret
  }
}

export function nodeText(node: Node, source: string): string {
  return source.substring(node.startIndex, node.endIndex)
}

/**
 * Port of `MetaVarEnv::match_multi_var`: compare named nodes pairwise, both
 * sides must run out simultaneously.
 */
function matchMultiVar(
  nodes: Node[],
  candidates: Node[],
  matchesExactly: (goal: Node, candidate: Node) => boolean
): boolean {
  const namedNodes = nodes.filter((n) => n.isNamed)
  const namedCands = candidates.filter((n) => n.isNamed)
  for (let i = 0; i < namedNodes.length; i++) {
    const cand = namedCands[i]
    // cand is done but node is not
    if (cand === undefined) return false
    if (!matchesExactly(namedNodes[i], cand)) return false
  }
  // node is done but cand is not
  return namedNodes.length === namedCands.length
}
