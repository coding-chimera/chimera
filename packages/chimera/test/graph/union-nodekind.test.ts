/**
 * Union first-class NodeKind — fork ripple-surface guards.
 *
 * Companion to the upstream chain port (6978acc + 85e9ac6 HEAD form, resolution
 * increments 8e3cde6/e922563/e219594/5b0c4b8, tests 11acc50). Pins the
 * contract-surface consequences of appending 'union' that the per-language
 * extraction/resolution tests do not cover: table order (kernel wire contract),
 * the derived agent-tool kind filter, and struct-parity member qualified names.
 */

import { describe, it, expect, beforeAll } from './vitest';
import { NODE_KINDS, type NodeKind } from '../../src/graph/types';
import { parseQuery } from '../../src/graph/search/query-parser';
import { extractFromSource, initGrammars, loadAllGrammars } from '../../src/graph/extraction';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('union NodeKind table contract', () => {
  it("keeps the tail-appended kinds ('union', then 'statement') index-aligned with the kernel", () => {
    // The vendored kernel's NODE_KINDS ends [...,import,export,route,component,union,
    // statement]; the fork table must match index-by-index. 'union' landed at
    // the tail first (6978acc); 'statement' moved from index 18 to the tail in
    // the P1 tsjs batch that taught the kernel walker to emit statement rows.
    // Append-never-reorder discipline; kinds persist as TEXT, the index order
    // is wire-only.
    expect(NODE_KINDS[NODE_KINDS.length - 1]).toBe('statement');
    expect([...NODE_KINDS]).toEqual([
      'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
      'function', 'method', 'property', 'field', 'variable', 'constant',
      'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
      'import', 'export', 'route', 'component', 'union', 'statement',
    ]);
  });

  it("accepts kind:union in the search query parser (schema derived from NODE_KINDS)", () => {
    // chimera_search / chimera_file_symbols / chimera_impact kind enum parameters
    // and the graph route kind validation all derive from this one set.
    const parsed = parseQuery('kind:union packet');
    expect(parsed.kinds).toContain('union' as NodeKind);
    expect(parsed.text.trim()).toBe('packet');
  });
});

describe('union member qualified names (struct parity)', () => {
  it('gives a C++ union member function the same Value::as_int qn shape as a struct', () => {
    const result = extractFromSource(
      'value.cpp',
      `union Value {
  int i;
  double d;
  int as_int() const { return i; }
};
`
    );
    const value = result.nodes.find((n) => n.name === 'Value');
    expect(value?.kind).toBe('union');
    const asInt = result.nodes.find((n) => n.name === 'as_int');
    expect(asInt?.qualifiedName).toBe('Value::as_int');
  });

  it('qualifies a Rust impl-on-union method by the union, like a struct impl', () => {
    const result = extractFromSource(
      'reg.rs',
      `pub union Reg { pub raw: u32 }
pub trait Describe { fn describe(&self) -> u32; }
impl Describe for Reg { fn describe(&self) -> u32 { unsafe { self.raw } } }
`
    );
    const reg = result.nodes.find((n) => n.name === 'Reg');
    expect(reg?.kind).toBe('union');
    // N's rust config lists `function_signature_item` in methodTypes, so the
    // TRAIT's bodiless signature now mints its own method node too (the Rust
    // counterpart of #1638: contract members become visible anchors). Pick
    // the impl-side method by qualified name instead of first-match-by-name.
    const traitSig = result.nodes.find(
      (n) => n.kind === 'method' && n.qualifiedName === 'Describe::describe'
    );
    expect(traitSig?.name).toBe('describe');
    const describe = result.nodes.find(
      (n) => n.kind === 'method' && n.qualifiedName === 'Reg::describe'
    );
    expect(describe?.name).toBe('describe');
  });
});
