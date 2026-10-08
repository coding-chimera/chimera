/**
 * Conformance tests ported from the `#[cfg(test)]` modules of ast-grep
 * crates/core/src/match_tree/match_node.rs and
 * crates/core/src/match_tree/strictness.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6.
 *
 * The Rust helpers locate the candidate subtree with a KindMatcher built from
 * `Pattern::potential_kinds`; v1 exposes no kind matcher, so the helpers here
 * find the first candidate node whose type equals the pattern's root kind.
 */

import { describe, it, expect, beforeAll } from '../vitest'
import { loadGrammarsForLanguages, initGrammars } from '../../../src/graph/extraction/grammars'
import type { Node, Tree } from '../../../src/graph/web-tree-sitter-types'
import type { MatchStrictness, Pattern } from '../../../src/graph/pattern/pattern'
import { compilePattern, parseSource } from '../../../src/graph/pattern/pattern'
import { createEnv, matchNodeNonRecursive } from '../../../src/graph/pattern/match-tree'
import { findMatches } from '../../../src/graph/pattern/pattern'

beforeAll(async () => {
  await initGrammars()
  await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'python'])
})

function mustCompile(pattern: string, strictness?: MatchStrictness): Pattern {
  const result = compilePattern(pattern, 'tsx', strictness ? { strictness } : undefined)
  if (!result.ok) throw new Error(`pattern failed: ${result.error.message}`)
  return result.pattern
}

/** Find the first node (DFS, pre-order) of the given type below the root. */
function findNodeOfType(tree: Tree, source: string, type: string): Node {
  const visit = (node: Node): Node | undefined => {
    if (node !== tree.rootNode && node.type === type) return node
    for (const child of node.children) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  const node = visit(tree.rootNode)
  if (!node) throw new Error(`no node of type ${type} in ${JSON.stringify(source)}`)
  return node
}

/** Port of match_node.rs's `match_tree` test helper. */
function matchTree(patternSrc: string, candidateSrc: string, strictness: MatchStrictness): boolean {
  const pattern = mustCompile(patternSrc)
  const kind = pattern.rootKindType
  if (!kind) throw new Error('test patterns must have a concrete root kind')
  const tree = parseSource('tsx', candidateSrc)
  if (!tree) throw new Error('parse failed')
  try {
    const node = findNodeOfType(tree, candidateSrc, kind)
    const handle = createEnv(candidateSrc)
    return (
      matchNodeNonRecursive(pattern.node, node, handle, strictness, candidateSrc) !== undefined
    )
  } finally {
    tree.delete()
  }
}

const matched = (p: string, n: string, s: MatchStrictness) => expect(matchTree(p, n, s)).toBe(true)
const unmatched = (p: string, n: string, s: MatchStrictness) => expect(matchTree(p, n, s)).toBe(false)

// ast-grep match_node.rs::test_smart_match
describe('match_node.rs::test_smart_match', () => {
  it('smart now ignores comments by default', () => {
    matched('$A($B)', 'foo(/* before */ bar /* after */)', 'smart')
  })
})

// ast-grep match_node.rs::test_ast_match
describe('match_node.rs::test_ast_match', () => {
  it('ast strictness cases', () => {
    matched("import $A from 'lib'", 'import A from "lib"', 'ast')
    unmatched('$A(bar)', 'foo(/* A*/bar)', 'ast')
    matched('$A(bar)', 'foo(bar)', 'ast')
    unmatched('$A(bar)', 'foo(bar, baz)', 'ast')
    matched('print($A,)', 'print(123)', 'ast')
    matched('print($$$A,b,$$$C)', 'print(b)', 'ast')
    matched('print($$$A,b,$$$C)', 'print(a, b)', 'ast')
    matched('print($$$A,b,$$$C)', 'print(a, b, c)', 'ast')
    matched('print($$$A,b,$$$C)', 'print(a, b, c,)', 'ast')
  })
})

// ast-grep match_node.rs::test_relaxed_match
describe('match_node.rs::test_relaxed_match', () => {
  it('relaxed strictness cases', () => {
    matched("import $A from 'lib'", 'import A from "lib"', 'relaxed')
    matched('$A(bar)', 'foo(/* A*/bar)', 'relaxed')
    // fix https://github.com/ast-grep/ast-grep/issues/1848
    matched("import { foo } from 'bar'", "import { foo, } from 'bar'", 'relaxed')
    matched('foo($A, $B)', 'foo(1/*test*/, 2/*test*/)', 'relaxed')
    unmatched("import { foo } from 'bar'", "import { foo, bar, baz } from 'bar'", 'relaxed')
    unmatched("import { foo } from 'bar'", "import { foo, bar } from 'bar'", 'relaxed')
  })
})

// ast-grep match_node.rs::test_cst_match
describe('match_node.rs::test_cst_match', () => {
  it('cst strictness cases', () => {
    unmatched("import $A from 'lib'", 'import A from "lib"', 'cst')
    unmatched('$A(bar)', 'foo(/* A*/bar)', 'cst')
    unmatched('print($A,)', 'print(123)', 'cst')
  })
})

// ast-grep match_node.rs::test_signature_match
describe('match_node.rs::test_signature_match', () => {
  it('signature strictness cases', () => {
    matched("import $A from 'lib'", 'import A from "lib"', 'signature')
    matched('$A(bar)', 'foo(/* A*/bar)', 'signature')
  })
})

// ast-grep match_node.rs::test_template_match
describe('match_node.rs::test_template_match', () => {
  it('template strictness matches', () => {
    matched('$A = $B', 'a = 123', 'template')
  })
})

// ast-grep strictness.rs::test_template_pattern
describe('strictness.rs::test_template_pattern', () => {
  it('template pattern matches any declaration kind', () => {
    const find = (source: string) => findMatches(mustCompile('$A = $B', 'template'), source).length > 0
    expect(find('a = b')).toBe(true)
    expect(find('var a = b')).toBe(true)
    expect(find('let a = b')).toBe(true)
    expect(find('const a = b')).toBe(true)
    expect(find('class A { a = b }')).toBe(true)
  })
})

// ast-grep strictness.rs::test_ignore_comment
describe('strictness.rs::test_ignore_comment', () => {
  it('relaxed pattern skips comments', () => {
    const find = (source: string) => findMatches(mustCompile('$A($B)', 'relaxed'), source).length > 0
    expect(find('foo(bar /* .. */)')).toBe(true)
    expect(find('\n    foo(\n      bar, // ..,\n    )')).toBe(true)
    expect(find('foo(/* .. */ bar)')).toBe(true)
    expect(find('\n    foo( // ..,\n      bar\n    )')).toBe(true)
  })
})

// ast-grep strictness.rs::test_ast_trailing_comma
describe('strictness.rs::test_ast_trailing_comma', () => {
  it('ast skips trailing anonymous comma', () => {
    expect(findMatches(mustCompile('foo(bar)', 'ast'), 'foo(bar,)').length).toBeGreaterThan(0)
  })
})
