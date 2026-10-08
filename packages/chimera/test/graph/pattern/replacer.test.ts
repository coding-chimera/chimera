/**
 * Conformance tests ported from the `#[cfg(test)]` modules of ast-grep
 * crates/core/src/replacer/indent.rs, crates/core/src/replacer/template.rs and
 * crates/core/src/replacer/structural.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6,
 * plus tests for the codemod-facing `applyReplacements` splicing.
 */

import { describe, it, expect, beforeAll } from '../vitest'
import { loadGrammarsForLanguages, initGrammars } from '../../../src/graph/extraction/grammars'
import type { Language } from '../../../src/graph/types'
import type { DeindentedExtract } from '../../../src/graph/pattern/indent'
import {
  extractWithDeindent,
  getIndentAtOffset,
  indentLines,
  MAX_LOOK_AHEAD,
} from '../../../src/graph/pattern/indent'
import type { PatternCapture, PatternMatch } from '../../../src/graph/pattern/pattern'
import { compilePattern, findFirstMatch, findMatches, parseSource } from '../../../src/graph/pattern/pattern'
import {
  applyReplacements,
  editForMatch,
  renderStructuralReplacement,
  renderTemplateReplacement,
  templateUsedVars,
} from '../../../src/graph/pattern/replacer'

beforeAll(async () => {
  await initGrammars()
  await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'python'])
})

// ---------------------------------------------------------------------------
// indent.rs
// ---------------------------------------------------------------------------

/** Port of indent.rs test `test_deindent` helper. */
function testDeindent(source: string, expected: string, offset: number): void {
  const exp = expected.trim()
  const leadingWhite = /^[ \t\n\r]*/.exec(source.slice(offset))![0].length
  const start = offset + leadingWhite
  const trailingWhite = /[ \t\n\r]*$/.exec(source)![0].length
  const end = source.length - trailingWhite
  const extracted = extractWithDeindent(source, start, end)
  expect(indentLines(0, extracted)).toBe(exp)
}

describe('indent.rs deindent', () => {
  // ast-grep indent.rs::test_simple_deindent
  it('test_simple_deindent', () => {
    testDeindent('\n  def test():\n    pass', '\ndef test():\n  pass', 0)
  })

  // ast-grep indent.rs::test_first_line_indent_deindent
  it('test_first_line_indent_deindent', () => {
    // note this indentation has no newline
    testDeindent('  def test():\n    pass', '\ndef test():\n  pass', 0)
  })

  // ast-grep indent.rs::test_space_in_middle_deindent
  it('test_space_in_middle_deindent', () => {
    testDeindent('\na = lambda:\n  pass', '\nlambda:\n  pass', 4)
  })

  // ast-grep indent.rs::test_middle_deindent
  it('test_middle_deindent', () => {
    testDeindent('\n  a = lambda:\n    pass', '\nlambda:\n  pass', 6)
  })

  // ast-grep indent.rs::test_nested_deindent
  it('test_nested_deindent', () => {
    testDeindent('\ndef outer():\n  def test():\n    pass', '\ndef test():\n  pass', 13)
  })

  // ast-grep indent.rs::test_no_deindent
  it('test_no_deindent', () => {
    const src = '\ndef test():\n  pass\n'
    testDeindent(src, src, 0)
  })

  // ast-grep indent.rs::test_malformed_deindent
  it('test_malformed_deindent', () => {
    testDeindent('\n  def test():\npass\n', '\ndef test():\npass\n', 0)
  })

  // ast-grep indent.rs::test_long_line_no_deindent
  it('test_long_line_no_deindent', () => {
    const src = ' '.repeat(MAX_LOOK_AHEAD + 1) + 'abc\n  def'
    testDeindent(src, src, 0)
  })
})

/** Port of indent.rs test `test_replace_with_indent` helper. */
function testReplaceWithIndent(target: string, start: number, inserted: string): string {
  const replaceLines: DeindentedExtract = { single: false, text: inserted, indent: 0 }
  const indent = getIndentAtOffset(target.slice(0, start))
  return indentLines(indent, replaceLines)
}

describe('indent.rs reindent', () => {
  // ast-grep indent.rs::test_simple_replace
  it('test_simple_replace', () => {
    expect(testReplaceWithIndent('', 0, 'def abc(): pass')).toBe('def abc(): pass')
    expect(testReplaceWithIndent('', 0, 'def abc():\n  pass')).toBe('def abc():\n  pass')
  })

  // ast-grep indent.rs::test_indent_replace
  it('test_indent_replace', () => {
    expect(testReplaceWithIndent('  ', 2, 'def abc(): pass')).toBe('def abc(): pass')
    expect(testReplaceWithIndent('  ', 2, 'def abc():\n  pass')).toBe('def abc():\n    pass')
    // 4 spaces, but insert at 2
    expect(testReplaceWithIndent('    ', 2, 'def abc():\n  pass')).toBe('def abc():\n    pass')
    // 4 spaces, insert at 4
    expect(testReplaceWithIndent('    ', 4, 'def abc():\n  pass')).toBe('def abc():\n      pass')
  })

  // ast-grep indent.rs::test_leading_text_replace
  it('test_leading_text_replace', () => {
    expect(testReplaceWithIndent('a = ', 4, 'def abc(): pass')).toBe('def abc(): pass')
    expect(testReplaceWithIndent('a = ', 4, 'def abc():\n  pass')).toBe('def abc():\n  pass')
  })

  // ast-grep indent.rs::test_leading_text_indent_replace
  it('test_leading_text_indent_replace', () => {
    expect(testReplaceWithIndent('  a = ', 6, 'def abc(): pass')).toBe('def abc(): pass')
    expect(testReplaceWithIndent('  a = ', 6, 'def abc():\n  pass')).toBe('def abc():\n    pass')
  })
})

// ---------------------------------------------------------------------------
// replacer helpers — mirrors the Rust `test_*_replace` env setup:
//   env.insert(var, Tsx.ast_grep(p).root())            → single capture
//   env.insert_multi(var, root.children())             → multi capture
// ---------------------------------------------------------------------------

function singleCapture(text: string, lang: Language): PatternCapture {
  const tree = parseSource(lang, text)
  if (!tree) throw new Error(`fixture parse failed: ${text}`)
  try {
    const root = tree.rootNode
    return {
      nodes: [{ start: root.startIndex, end: root.endIndex, text: text.slice(root.startIndex, root.endIndex) }],
      multi: false,
      text: text.slice(root.startIndex, root.endIndex),
      sourceIndent: getIndentAtOffset(''),
    }
  } finally {
    tree.delete()
  }
}

function multiCapture(text: string, lang: Language): PatternCapture {
  const tree = parseSource(lang, text)
  if (!tree) throw new Error(`fixture parse failed: ${text}`)
  try {
    const children = tree.rootNode.children.map((n) => ({
      start: n.startIndex,
      end: n.endIndex,
      text: text.slice(n.startIndex, n.endIndex),
    }))
    const first = children[0]
    const last = children[children.length - 1]
    return {
      nodes: children,
      multi: true,
      text: first && last ? text.slice(first.start, last.end) : '',
      sourceIndent: getIndentAtOffset(''),
    }
  } finally {
    tree.delete()
  }
}

/** Synthetic PatternMatch for replacer unit tests (dummy root at 0..0). */
function envMatch(
  vars: Array<[string, string]>,
  multiVars: Array<[string, string]> = [],
  lang: Language = 'tsx'
): PatternMatch {
  const captures = new Map<string, PatternCapture>()
  const display = new Map<string, string>()
  for (const [name, text] of vars) {
    captures.set(name, singleCapture(text, lang))
    display.set(name, text)
  }
  for (const [name, text] of multiVars) {
    captures.set(name, multiCapture(text, lang))
    display.set(name, text)
  }
  return {
    nodeType: 'source_file',
    range: { start: 0, end: 0 },
    replacedRange: { start: 0, end: 0 },
    captures,
    captureDisplay: display,
  }
}

// ---------------------------------------------------------------------------
// template.rs
// ---------------------------------------------------------------------------

describe('template.rs rendering', () => {
  // ast-grep template.rs::test_example
  it('test_example — indentation-aware multi-line replacement', () => {
    const src = 'if (true) {\n  a(\n    1\n      + 2\n      + 3\n  )\n}'
    const result = compilePattern('a($B)', 'tsx')
    if (!result.ok) throw new Error('pattern should compile')
    const m = findFirstMatch(result.pattern, src)
    if (!m) throw new Error('should match')
    const replacement = renderTemplateReplacement('c(\n  $B\n)', m, src)
    expect(applyReplacements(src, [editForMatch(m, replacement)])).toBe(
      'if (true) {\n  c(\n    1\n      + 2\n      + 3\n  )\n}'
    )
  })

  // ast-grep template.rs::test_no_env
  it('test_no_env', () => {
    expect(renderTemplateReplacement('let a = 123', envMatch([]), '')).toBe('let a = 123')
    expect(
      renderTemplateReplacement("console.log('hello world'); let b = 123;", envMatch([]), '')
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep template.rs::test_single_env
  it('test_single_env', () => {
    expect(renderTemplateReplacement('let a = $A', envMatch([['A', '123']]), '')).toBe('let a = 123')
    expect(
      renderTemplateReplacement('console.log($HW); let b = 123;', envMatch([['HW', "'hello world'"]]), '')
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep template.rs::test_multiple_env
  it('test_multiple_env', () => {
    expect(
      renderTemplateReplacement('let $V = $A', envMatch([['A', '123'], ['V', 'a']]), '')
    ).toBe('let a = 123')
    expect(
      renderTemplateReplacement(
        'console.log($HW); let $B = 123;',
        envMatch([['HW', "'hello world'"], ['B', 'b']]),
        ''
      )
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep template.rs::test_multiple_occurrences
  it('test_multiple_occurrences', () => {
    expect(renderTemplateReplacement('let $A = $A', envMatch([['A', 'a']]), '')).toBe('let a = a')
    expect(renderTemplateReplacement('var $A = () => $A', envMatch([['A', 'a']]), '')).toBe('var a = () => a')
    expect(
      renderTemplateReplacement(
        'const $A = () => { console.log($B); $A(); };',
        envMatch([['B', "'hello world'"], ['A', 'a']]),
        ''
      )
    ).toBe("const a = () => { console.log('hello world'); a(); };")
  })

  // ast-grep template.rs::test_ellipsis_meta_var
  it('test_ellipsis_meta_var', () => {
    expect(
      renderTemplateReplacement('let a = () => { $$$B }', envMatch([], [['B', "alert('works!')"]]), '')
    ).toBe("let a = () => { alert('works!') }")
    expect(
      renderTemplateReplacement(
        'let a = () => { $$$B }',
        envMatch([], [['B', "alert('works!');console.log(123)"]]),
        ''
      )
    ).toBe("let a = () => { alert('works!');console.log(123) }")
  })

  // ast-grep template.rs::test_multi_ellipsis
  it('test_multi_ellipsis', () => {
    expect(
      renderTemplateReplacement(
        "import {$$$A, B, $$$C} from 'a'",
        envMatch([], [['A', 'A'], ['C', 'C']]),
        ''
      )
    ).toBe("import {A, B, C} from 'a'")
  })

  // ast-grep template.rs::test_replace_in_string
  it('test_replace_in_string', () => {
    expect(renderTemplateReplacement("'$A'", envMatch([['A', '123']]), '')).toBe("'123'")
  })

  // ast-grep template.rs::test_template
  it('test_template', () => {
    expect(renderTemplateReplacement('Hello $A', envMatch([['A', 'World']]), '')).toBe('Hello World')
    expect(
      renderTemplateReplacement('$B $A', envMatch([['A', 'World'], ['B', 'Hello']]), '')
    ).toBe('Hello World')
  })

  // ast-grep template.rs::test_template_vars
  it('test_template_vars', () => {
    expect([...templateUsedVars('$A $B $C')].sort()).toEqual(['A', 'B', 'C'])
    expect([...templateUsedVars('$a$B$C')].sort()).toEqual(['B', 'C'])
  })

  // ast-grep template.rs::test_multi_row_replace (GH #641)
  it('test_multi_row_replace', () => {
    expect(
      renderTemplateReplacement('$A = $B', envMatch([['A', 'x'], ['B', '[\n  1\n]']]), '')
    ).toBe('x = [\n  1\n]')
  })
})

// ---------------------------------------------------------------------------
// structural.rs
// ---------------------------------------------------------------------------

describe('structural.rs replacement', () => {
  // ast-grep structural.rs::test_no_env
  it('test_no_env', () => {
    expect(renderStructuralReplacement('let a = 123', envMatch([]), 'tsx')).toBe('let a = 123')
    expect(
      renderStructuralReplacement("console.log('hello world'); let b = 123;", envMatch([]), 'tsx')
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep structural.rs::test_single_env
  it('test_single_env', () => {
    expect(renderStructuralReplacement('let a = $A', envMatch([['A', '123']]), 'tsx')).toBe('let a = 123')
    expect(
      renderStructuralReplacement('console.log($HW); let b = 123;', envMatch([['HW', "'hello world'"]]), 'tsx')
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep structural.rs::test_multiple_env
  it('test_multiple_env', () => {
    expect(renderStructuralReplacement('let $V = $A', envMatch([['A', '123'], ['V', 'a']]), 'tsx')).toBe('let a = 123')
    expect(
      renderStructuralReplacement(
        'console.log($HW); let $B = 123;',
        envMatch([['HW', "'hello world'"], ['B', 'b']]),
        'tsx'
      )
    ).toBe("console.log('hello world'); let b = 123;")
  })

  // ast-grep structural.rs::test_multiple_occurrences
  it('test_multiple_occurrences', () => {
    expect(renderStructuralReplacement('let $A = $A', envMatch([['A', 'a']]), 'tsx')).toBe('let a = a')
    expect(renderStructuralReplacement('var $A = () => $A', envMatch([['A', 'a']]), 'tsx')).toBe('var a = () => a')
    expect(
      renderStructuralReplacement(
        'const $A = () => { console.log($B); $A(); };',
        envMatch([['B', "'hello world'"], ['A', 'a']]),
        'tsx'
      )
    ).toBe("const a = () => { console.log('hello world'); a(); };")
  })

  // ast-grep structural.rs::test_ellipsis_meta_var
  it('test_ellipsis_meta_var', () => {
    expect(
      renderStructuralReplacement('let a = () => { $$$B }', envMatch([], [['B', "alert('works!')"]]), 'tsx')
    ).toBe("let a = () => { alert('works!') }")
    expect(
      renderStructuralReplacement(
        'let a = () => { $$$B }',
        envMatch([], [['B', "alert('works!');console.log(123)"]]),
        'tsx'
      )
    ).toBe("let a = () => { alert('works!');console.log(123) }")
  })

  // ast-grep structural.rs::test_multi_ellipsis
  it('test_multi_ellipsis', () => {
    expect(
      renderStructuralReplacement("import {$$$A, B, $$$C} from 'a'", envMatch([], [['A', 'A'], ['C', 'C']]), 'tsx')
    ).toBe("import {A, B, C} from 'a'")
  })

  // ast-grep structural.rs::test_replace_in_string
  it('test_replace_in_string', () => {
    expect(renderStructuralReplacement("'$A'", envMatch([['A', '123']]), 'tsx')).toBe("'123'")
  })
})

// ---------------------------------------------------------------------------
// applyReplacements (splicing layer)
// ---------------------------------------------------------------------------

describe('applyReplacements', () => {
  it('replaces all matches of a codemod end to end, unsorted edits splice correctly', () => {
    const src = 'console.log(1); x(); console.log(2);'
    const result = compilePattern('console.log($A)', 'typescript')
    if (!result.ok) throw new Error('pattern should compile')
    const matches = findMatches(result.pattern, src)
    expect(matches.length).toBe(2)
    const edits = matches
      .map((m) => editForMatch(m, renderTemplateReplacement('logger.info($A)', m, src)))
      .reverse() // feed out of order to prove sorting
    expect(applyReplacements(src, edits)).toBe('logger.info(1); x(); logger.info(2);')
  })

  it('detects overlapping edits', () => {
    const edits = [
      { start: 0, end: 2, replacement: 'a' },
      { start: 1, end: 3, replacement: 'b' },
    ]
    expect(() => applyReplacements('abcd', edits)).toThrow(/Overlapping replacements/)
  })

  it('adjacent (touching, non-overlapping) edits are allowed', () => {
    const out = applyReplacements('abcd', [
      { start: 0, end: 2, replacement: 'x' },
      { start: 2, end: 4, replacement: 'y' },
    ])
    expect(out).toBe('xy')
  })

  it('deletes the matched range via an empty template', () => {
    // the pattern includes the semicolon, so the whole statement disappears
    const src = 'a(); log(1);b();'
    const result = compilePattern('log($A);', 'tsx')
    if (!result.ok) throw new Error('pattern should compile')
    const m = findFirstMatch(result.pattern, src)
    if (!m) throw new Error('should match')
    expect(applyReplacements(src, [editForMatch(m, renderTemplateReplacement('', m, src))])).toBe('a(); b();')
  })

  it('keeps UTF-16 offsets when the source contains astral characters', () => {
    const src = 'const face = "😀"; console.log(face)'
    const result = compilePattern('console.log($A)', 'typescript')
    if (!result.ok) throw new Error('pattern should compile')
    const m = findFirstMatch(result.pattern, src)
    if (!m) throw new Error('should match')
    const out = applyReplacements(src, [editForMatch(m, renderTemplateReplacement('log($A)', m, src))])
    expect(out).toBe('const face = "😀"; log(face)')
  })
})

