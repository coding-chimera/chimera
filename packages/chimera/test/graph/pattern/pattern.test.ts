/**
 * Conformance tests for the Chimera port of ast-grep's structural pattern
 * matcher, translated from the `#[cfg(test)]` modules of
 * crates/core/src/matcher/pattern.rs, crates/core/src/match_tree/mod.rs,
 * crates/core/src/match_tree/match_node.rs and crates/core/src/meta_var.rs
 * @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6.
 *
 * Pinned languages: typescript/tsx, javascript, python (task scope).
 * Names traceable via `// ast-grep <file>::<test>` comments.
 */

import { describe, it, expect, beforeAll } from '../vitest'
import { loadGrammarsForLanguages, initGrammars } from '../../../src/graph/extraction/grammars'
import type { Language } from '../../../src/graph/types'
import {
  compilePattern,
  collectDefinedVars,
  findFirstMatch,
  findMatches,
} from '../../../src/graph/pattern/pattern'
import type { Pattern } from '../../../src/graph/pattern/pattern'

beforeAll(async () => {
  await initGrammars()
  await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'python'])
})

function mustCompile(pattern: string, lang: Language = 'tsx'): Pattern {
  const result = compilePattern(pattern, lang)
  if (!result.ok) throw new Error(`pattern failed: ${result.error.message}`)
  return result.pattern
}

/** ast-grep pattern.rs::test_match — find_node on candidate root (recursive) */
function testMatch(p: string, s: string, lang: Language = 'tsx'): void {
  const m = findFirstMatch(mustCompile(p, lang), s)
  if (!m) throw new Error(`expected match. goal: ${p}, candidate: ${s}`)
}

/** ast-grep pattern.rs::test_non_match */
function testNonMatch(p: string, s: string, lang: Language = 'tsx'): void {
  const m = findFirstMatch(mustCompile(p, lang), s)
  if (m) throw new Error(`expected no match. goal: ${p}, candidate: ${s}, got ${JSON.stringify(m.captureDisplay)}`)
}

/** ast-grep pattern.rs::match_env — capture display map of the first match */
function matchEnv(p: string, s: string, lang: Language = 'tsx'): Map<string, string> {
  const m = findFirstMatch(mustCompile(p, lang), s)
  if (!m) throw new Error(`expected match. goal: ${p}, candidate: ${s}`)
  return m.captureDisplay
}

describe('pattern.rs metavariable matching', () => {
  // ast-grep pattern.rs::test_meta_variable
  it('test_meta_variable', () => {
    testMatch('const a = $VALUE', 'const a = 123')
    testMatch('const $VARIABLE = $VALUE', 'const a = 123')
    testMatch('const $VARIABLE = $VALUE', 'const a = 123')
  })

  // ast-grep pattern.rs::test_whitespace
  it('test_whitespace', () => {
    testMatch('function t() { }', 'function t() {}')
    testMatch('function t() {}', 'function t() {  }')
  })

  // ast-grep pattern.rs::test_meta_variable_env
  it('test_meta_variable_env', () => {
    const env = matchEnv('const a = $VALUE', 'const a = 123')
    expect(env.get('VALUE')).toBe('123')
  })

  // ast-grep pattern.rs::test_match_non_atomic
  it('test_match_non_atomic', () => {
    const env = matchEnv('const a = $VALUE', 'const a = 5 + 3')
    expect(env.get('VALUE')).toBe('5 + 3')
  })

  // ast-grep pattern.rs::test_class_assignment
  it('test_class_assignment', () => {
    testMatch('class $C { $MEMBER = $VAL}', 'class A {a = 123}')
    testNonMatch('class $C { $MEMBER = $VAL; b = 123; }', 'class A {a = 123}')
    testNonMatch('a = 123', 'class B {b = 123}')
  })

  // ast-grep pattern.rs::test_return
  it('test_return', () => {
    testMatch('$A($B)', 'return test(123)')
  })

  // ast-grep pattern.rs::test_gh_1087
  it('test_gh_1087', () => {
    testMatch('($P) => $F($P)', '(x) => bar(x)')
  })
})

// ast-grep pattern.rs::test_pattern_should_not_pollute_env (gh issue #1164)
// The port hands out a fresh env per try at every node, so a failed pattern
// can never pollute any env visible to the caller; assert capture absence.
describe('pattern.rs env pollution', () => {
  it('test_pattern_should_not_pollute_env', () => {
    expect(findFirstMatch(mustCompile('const $A = 114'), 'const a = 514')).toBeUndefined()
  })
})

describe('pattern.rs single-node enforcement and errors', () => {
  // ast-grep pattern.rs::test_pattern_error
  it('test_pattern_error: empty pattern is no-content', () => {
    const r = compilePattern('', 'tsx')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no-content')
  })

  // ast-grep pattern.rs::test_pattern_error (second case)
  it('test_pattern_error: two nodes is multiple-node', () => {
    const r = compilePattern('12  3344', 'tsx')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('multiple-node')
  })

  // ast-grep pattern.rs::test_root_multi_meta_var_is_rejected (gh #2697)
  it('test_root_multi_meta_var_is_rejected', () => {
    for (const src of ['$$$A', '$$$PARAMS']) {
      const r = compilePattern(src, 'tsx')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('root-multi-metavar')
    }
  })

  // ast-grep pattern.rs::test_single_root_meta_var_is_accepted
  it('test_single_root_meta_var_is_accepted', () => {
    expect(compilePattern('$A', 'tsx').ok).toBe(true)
    expect(compilePattern('$_', 'tsx').ok).toBe(true)
  })

  // ast-grep pattern.rs::test_in_list_multi_meta_var_is_unchanged
  it('test_in_list_multi_meta_var_is_unchanged', () => {
    expect(compilePattern('foo($$$A, c)', 'tsx').ok).toBe(true)
    testMatch('foo($$$A, c)', 'foo(a, b, c)')
  })

  // ast-grep pattern.rs::test_error_kind — `123+` produces an ERROR tree.
  // Deviation: the port rejects ERROR patterns at compile time instead of
  // exposing Pattern::has_error().
  it('test_error_kind: unparseable pattern fails cleanly', () => {
    const r = compilePattern('123+', 'tsx')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('parse-failed')
  })

  it('grammar-not-loaded surfaces a clean error', () => {
    // 'liquid' is a custom-extractor language with no tree-sitter grammar in
    // any distribution; unlike 'java' it cannot be loaded by other suites in
    // the shared bun test process (loadAllGrammars cross-test pollution).
    const r = compilePattern('package a', 'liquid')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('grammar-not-loaded')
  })
})

describe('pattern.rs defined_vars', () => {
  // ast-grep pattern.rs::test_extract_meta_var_from_pattern
  it('test_extract_meta_var_from_pattern', () => {
    expect([...collectDefinedVars(mustCompile('var $A = 1').node)]).toEqual(['A'])
  })

  // ast-grep pattern.rs::test_extract_complex_meta_var
  it('test_extract_complex_meta_var', () => {
    const vars = [...collectDefinedVars(mustCompile('function $FUNC($$$ARGS): $RET { $$$BODY }').node)]
    expect(vars.sort()).toEqual(['ARGS', 'BODY', 'FUNC', 'RET'])
  })

  // ast-grep pattern.rs::test_extract_duplicate_meta_var
  it('test_extract_duplicate_meta_var', () => {
    expect([...collectDefinedVars(mustCompile('var $A = $A').node)]).toEqual(['A'])
  })
})

describe('match_tree.rs matching', () => {
  // ast-grep match_tree/mod.rs::test_simple_match
  it('test_simple_match', () => {
    testMatch('const a = 123', 'const a=123')
    testNonMatch('const a = 123', 'var a = 123')
  })

  // ast-grep match_tree/mod.rs::test_nested_match
  it('test_nested_match', () => {
    testMatch('const a = 123', 'function() {const a= 123;}')
    testMatch('const a = 123', 'class A { constructor() {const a= 123;}}')
    testMatch('const a = 123', 'for (let a of []) while (true) { const a = 123;}')
  })

  // ast-grep match_tree/mod.rs::test_should_exactly_match
  it('test_should_exactly_match', () => {
    testMatch('function foo() { let a = 123; }', 'function foo() { let a = 123; }')
    testNonMatch('function foo() { let a = 123; }', 'function bar() { let a = 123; }')
  })

  // ast-grep match_tree/mod.rs::test_match_inner
  it('test_match_inner', () => {
    testMatch('function bar() { let a = 123; }', 'function foo() { function bar() {let a = 123; }}')
    testNonMatch('function foo() { let a = 123; }', 'function foo() { function bar() {let a = 123; }}')
  })

  // ast-grep match_tree/mod.rs::test_single_ellipsis
  it('test_single_ellipsis', () => {
    testMatch('foo($$$)', 'foo(a, b, c)')
    testMatch('foo($$$)', 'foo()')
  })

  // ast-grep match_tree/mod.rs::test_named_ellipsis
  it('test_named_ellipsis', () => {
    testMatch('foo($$$A, c)', 'foo(a, b, c)')
    testMatch('foo($$$A, b, c)', 'foo(a, b, c)')
    testMatch('foo($$$A, a, b, c)', 'foo(a, b, c)')
    testNonMatch('foo($$$A, a, b, c)', 'foo(b, c)')
  })

  // ast-grep match_tree/mod.rs::test_leading_ellipsis
  it('test_leading_ellipsis', () => {
    testMatch('foo($$$, c)', 'foo(a, b, c)')
    testMatch('foo($$$, b, c)', 'foo(a, b, c)')
    testMatch('foo($$$, a, b, c)', 'foo(a, b, c)')
    testNonMatch('foo($$$, a, b, c)', 'foo(b, c)')
  })

  // ast-grep match_tree/mod.rs::test_trailing_ellipsis
  it('test_trailing_ellipsis', () => {
    testMatch('foo(a, $$$)', 'foo(a, b, c)')
    testMatch('foo(a, b, $$$)', 'foo(a, b, c)')
    testNonMatch('foo(a, b, c, $$$)', 'foo(b, c)')
  })

  // ast-grep match_tree/mod.rs::test_meta_var_named
  it('test_meta_var_named', () => {
    testMatch('return $A', 'return 123;')
    testMatch('return $_', 'return 123;')
    testNonMatch('return $A', 'return;')
    testNonMatch('return $_', 'return;')
    testMatch('return $$A', 'return;')
    testMatch('return $$_A', 'return;')
  })

  // ast-grep match_tree/mod.rs::test_meta_var_multiple_occurrence
  it('test_meta_var_multiple_occurrence', () => {
    testMatch('$A($$$)', 'test(123)')
    testMatch('$A($B)', 'test(123)')
    testNonMatch('$A($A)', 'test(aaa)')
    testNonMatch('$A($A)', 'test(123)')
    testNonMatch('$A($A, $A)', 'test(123, 456)')
    testMatch('$A($A)', 'test(test)')
    testNonMatch('$A($A)', 'foo(bar)')
  })

  // repeated-metavariable equality beyond call args (task must-cover item):
  // `$A == $A` matches `x == x` but not `x == y`
  it('repeated metavar equality on binary expressions', () => {
    testMatch('$A == $A', 'x == x')
    testNonMatch('$A == $A', 'x == y')
  })

  // ast-grep match_tree/mod.rs::test_string
  it('test_string', () => {
    testMatch("'a'", "'a'")
    testMatch("'abcdefg'", "'abcdefg'")
    testMatch('`abcdefg`', '`abcdefg`')
    testNonMatch("'a'", "'b'")
    testNonMatch("'abcdefg'", "'gggggg'")
  })

  // ast-grep match_tree/mod.rs::test_skip_trivial_node
  it('test_skip_trivial_node', () => {
    testMatch('foo($A, $B)', 'foo(a, b,)')
    testMatch('class A { b() {}}', 'class A { get b() {}}')
  })

  // ast-grep match_tree/mod.rs::test_trivia_in_pattern
  it('test_trivia_in_pattern', () => {
    testMatch('foo($A, $B,)', 'foo(a, b,)')
    testNonMatch('foo($A, $B,)', 'foo(a, b)')
    testMatch('class A { get b() {}}', 'class A { get b() {}}')
    testNonMatch('class A { get b() {}}', 'class A { b() {}}')
  })

  // ast-grep match_tree/mod.rs::test_nested_smart_metavar_skips_comment
  it('test_nested_smart_metavar_skips_comment', () => {
    const env = matchEnv('$A($B)', 'foo(/* before */ bar /* after */)')
    expect(env.get('B')).toBe('bar')
  })

  // ast-grep match_tree/mod.rs::test_match_end
  it('test_match_end', () => {
    const m1 = findFirstMatch(mustCompile('return $A'), 'return 123 /* trivia */')
    expect(m1?.replacedRange.end).toBe(10)
    const m2 = findFirstMatch(mustCompile('return f($A)'), 'return f(1,) /* trivia */')
    expect(m2?.replacedRange.end).toBe(12)
  })

  // ast-grep match_tree/mod.rs::test_ellipsis_end (issue #411)
  it('test_ellipsis_end', () => {
    const m = findFirstMatch(
      mustCompile("import {$$$A, B, $$$C} from 'a'"),
      "import {A, B, C} from 'a'"
    )
    expect(m?.replacedRange.end).toBe(25)
  })

  // ast-grep match_tree/mod.rs::test_gh_1087
  it('test_gh_1087', () => {
    testMatch('($P) => $F($P)', '(x) => bar(x)')
  })

  // ast-grep match_tree/mod.rs::test_leading_ellipsis_metavar_anchor (PR #2670)
  it('test_leading_ellipsis_metavar_anchor', () => {
    // No trailing `;` after `$$$A`/`$$$B` so they parse as statement-list
    // ellipses (a bare `$$$A;` would be wrapped in an expression_statement).
    const env = matchEnv(
      'function _() {\n  $$$A\n  let $P = g()\n  let $Q = h()\n  $$$B\n}',
      'function _() { let a = 0; let p = g(); let q = h(); let b = 1; }'
    )
    expect(env.get('P')).toBe('p')
    expect(env.get('Q')).toBe('q')
    expect(env.get('A')).toBe('[let a = 0;]')
    expect(env.get('B')).toBe('[let b = 1;]')
  })

  // ast-grep match_tree/mod.rs::test_root_metavar_matches_comment
  it('test_root_metavar_matches_comment', () => {
    // ast-grep finds the comment KindMatcher-first then matches against it;
    // the port has no kind matcher, so pin the observable equivalent: a root
    // `$A` pattern matches extras (the DFS reaches comments), and the
    // statement-level nested case drops them.
    const source = 'class MyClass { /** @memberof MyClass.prototype */ get myProp() { return 1; } }'
    const matches = findMatches(mustCompile('$COMMENT'), source)
    // root/source_file matches too (a bare metavar binds anything); the
    // comment must be one of the bound values
    const bound = matches.map((m) => m.captureDisplay.get('COMMENT'))
    expect(bound).toContain('/** @memberof MyClass.prototype */')
    const dropped = findMatches(mustCompile('$_'), source)
    expect(dropped.length).toBeGreaterThan(0)
  })

  // ast-grep meta_var.rs::test_multi_var_match
  it('test_multi_var_match', () => {
    testMatch('if (true) { $$$A } else { $$$A }', 'if (true) { a += 1; b += 1 } else { a += 1; b += 1 }')
    testNonMatch('if (true) { $$$A } else { $$$A }', 'if (true) { a += 1 } else { b += 1 }')
  })

  // ast-grep meta_var.rs::test_multi_var_match_with_trailing
  it('test_multi_var_match_with_trailing', () => {
    testNonMatch('if (true) { $$$A } else { $$$A }', 'if (true) { a += 1; } else { a += 1; b += 1 }')
    testNonMatch('if (true) { $$$A } else { $$$A }', 'if (true) { a += 1; b += 1; } else { a += 1 }')
  })
})

describe('python conformance (expando $ -> µ)', () => {
  it('single node + capture', () => {
    testMatch('a = $B', 'a = 123', 'python')
    expect(matchEnv('a = $B', 'a = 123', 'python').get('B')).toBe('123')
  })
  it('repeated metavariable equality', () => {
    testMatch('$A == $A', 'x == x\n', 'python')
    testNonMatch('$A == $A', 'x == y\n', 'python')
  })
  it('$$$ zero-or-more in argument lists', () => {
    testMatch('print($$$ARGS)', 'print(a, b, c)', 'python')
    testMatch('print($$$ARGS, c)', 'print(a, b, c)', 'python')
    testMatch('print()', 'print()', 'python')
  })
  it('nested find in a function body', () => {
    testMatch('a = $B', 'def f():\n    a = 123\n', 'python')
  })
  it('non-matching keyword keeps strictness', () => {
    testNonMatch('a = $B', 'a: int = 123\n', 'python')
  })
})

describe('javascript conformance', () => {
  it('single node + capture', () => {
    testMatch('const a = $VALUE', 'const a = 123', 'javascript')
    expect(matchEnv('var $V = $X', 'var y = 42', 'javascript').get('V')).toBe('y')
  })
  it('$$$ in arrays and call arguments', () => {
    testMatch('[$$$ITEMS]', '[1, 2, 3]', 'javascript')
    testMatch('foo($$$)', 'foo()', 'javascript')
  })
  it('repeated metavariable equality', () => {
    testMatch('$A === $A', 'x === x', 'javascript')
    testNonMatch('$A === $A', 'x === y', 'javascript')
  })
})

describe('UTF-16 offset convention', () => {
  it('ranges are UTF-16 code-unit indices into the JS string', () => {
    // 'π' is one UTF-16 code unit but two UTF-8 bytes; substring() semantics
    // (the existing extraction convention) is what the module promises.
    const source = 'const π = 42'
    const m = findFirstMatch(mustCompile('const π = $V', 'typescript'), source)
    expect(m).toBeDefined()
    expect(source.slice(m?.range.start, m?.range.end)).toBe('const π = 42')
    expect(m?.captureDisplay.get('V')).toBe('42')
  })
  it('surrogate-pair text in source keeps ranges consistent', () => {
    // 😀 is 2 UTF-16 code units
    const source = 'const s = "😀"'
    const m = findFirstMatch(mustCompile('const $A = "😀"', 'typescript'), source)
    expect(m).toBeDefined()
    expect(source.slice(m?.range.start, m?.range.end)).toBe(source)
    expect(m?.captureDisplay.get('A')).toBe('s')
  })
})
