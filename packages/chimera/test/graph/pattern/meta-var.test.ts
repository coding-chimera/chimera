/**
 * Conformance tests ported from the #[cfg(test)] modules of ast-grep
 * crates/core/src/meta_var.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6.
 */

import { describe, it, expect } from '../vitest'
import {
  expandoChar,
  extractMetaVar,
  preprocessPattern,
} from '../../../src/graph/pattern/meta-var'

// ast-grep meta_var.rs::test_match_var
describe('extractMetaVar (meta_var.rs::test_match_var)', () => {
  it('matches standard metavariable forms', () => {
    expect(extractMetaVar('$$$', '$')).toEqual({ type: 'multiple' })
    expect(extractMetaVar('$ABC', '$')).toEqual({ type: 'capture', name: 'ABC', named: true })
    expect(extractMetaVar('$$ABC', '$')).toEqual({ type: 'capture', name: 'ABC', named: false })
    expect(extractMetaVar('$MATCH1', '$')).toEqual({ type: 'capture', name: 'MATCH1', named: true })
    expect(extractMetaVar('$$$ABC', '$')).toEqual({ type: 'multi-capture', name: 'ABC' })
    expect(extractMetaVar('$_', '$')).toEqual({ type: 'dropped', named: true })
    expect(extractMetaVar('$_123', '$')).toEqual({ type: 'dropped', named: true })
    expect(extractMetaVar('$$_', '$')).toEqual({ type: 'dropped', named: false })
  })
})

// ast-grep meta_var.rs::test_not_meta_var
describe('extractMetaVar (meta_var.rs::test_not_meta_var)', () => {
  it('rejects non-metavariable text', () => {
    expect(extractMetaVar('$123', '$')).toBeUndefined()
    expect(extractMetaVar('$', '$')).toBeUndefined()
    expect(extractMetaVar('$$', '$')).toBeUndefined()
    expect(extractMetaVar('abc', '$')).toBeUndefined()
    expect(extractMetaVar('$abc', '$')).toBeUndefined() // lowercase not allowed
  })
})

// ast-grep meta_var.rs::test_non_ascii_meta_var
describe('extractMetaVar (meta_var.rs::test_non_ascii_meta_var)', () => {
  it('works with a non-ASCII meta char', () => {
    const extract = (s: string) => extractMetaVar(s, 'µ')
    expect(extract('µµµ')).toEqual({ type: 'multiple' })
    expect(extract('µABC')).toEqual({ type: 'capture', name: 'ABC', named: true })
    expect(extract('µµABC')).toEqual({ type: 'capture', name: 'ABC', named: false })
    expect(extract('µµµABC')).toEqual({ type: 'multi-capture', name: 'ABC' })
    expect(extract('µ_')).toEqual({ type: 'dropped', named: true })
    expect(extract('abc')).toBeUndefined()
    expect(extract('µabc')).toBeUndefined()
  })
})

describe('expando table (crates/language/src/lib.rs impl_lang_expando)', () => {
  it('pins the python expando to µ', () => {
    expect(expandoChar('python')).toBe('µ')
  })
  it('uses plain $ for js/ts/tsx', () => {
    expect(expandoChar('typescript')).toBe('$')
    expect(expandoChar('tsx')).toBe('$')
    expect(expandoChar('javascript')).toBe('$')
  })
  it('uses 𐀀 for c/cpp and _ for nix (surrogate-pair expando sanity)', () => {
    expect(expandoChar('c')).toBe('\u{10000}')
    expect(expandoChar('cpp')).toBe('\u{10000}')
    expect(expandoChar('nix')).toBe('_')
  })
})

// port of `pre_process_pattern` behavior pinned by the language crate tests
describe('preprocessPattern (crates/language/src/lib.rs)', () => {
  it('rewrites metavariable sigils to the expando char', () => {
    expect(preprocessPattern('$A = $B', 'µ')).toBe('µA = µB')
    expect(preprocessPattern('$$$A', 'µ')).toBe('µµµA')
    expect(preprocessPattern('$$A', 'µ')).toBe('µµA')
    expect(preprocessPattern('$$$', 'µ')).toBe('µµµ')
    expect(preprocessPattern('$_', 'µ')).toBe('µ_')
  })
  it('keeps non-metavariable dollars literal', () => {
    expect(preprocessPattern('cost is $100', 'µ')).toBe('cost is $100')
    expect(preprocessPattern('$abc', 'µ')).toBe('$abc')
    expect(preprocessPattern('$$abc', 'µ')).toBe('$$abc')
    // anonymous multiple still rewrites when 3 sigils are followed by anything
    expect(preprocessPattern('$$$abc', 'µ')).toBe('µµµabc')
  })
  it('is identity for $-valid languages', () => {
    expect(preprocessPattern('const $A = $$$B', '$')).toBe('const $A = $$$B')
  })
})
