/**
 * Python body docstrings (#1905)
 *
 * `getPrecedingDocstring` only walks preceding comment siblings, so a Python
 * docstring — a bare string literal first in the body — never reached the
 * `docstring` column, never entered `nodes_fts`, and was never shown. The
 * identical sentence written as a leading `#` comment was both.
 *
 * Fork port of upstream `__tests__/python-body-docstrings.test.ts` (bd993b1).
 * Adaptations: env stubbing via save/restore (the fork's vi shim has no
 * stubEnv); the MCP-rendering and dist/bin CLI assertions are dropped (the
 * fork's agent surface is `chimera graph` / chimera_* tools, not the upstream
 * codegraph CLI) — persistence + FTS + exact-name ranking are kept.
 * Dual-arm: wasm side in languages/python.ts + tree-sitter.ts docstringFor,
 * native side in codegraph-kernel/src/python.rs (body_docstring/docstring_for).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { getKernel, resetKernelForTests } from '../../src/graph/extraction/kernel';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import { hasPrebuild } from './kernel-testutil';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function docstrings(code: string): Map<string, string | undefined> {
  return new Map(extractFromSource('ledger.py', code).nodes.map((n) => [n.name, n.docstring]));
}

const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/kernel-parity/docstrings.py'), 'utf8');
const kernelBuilt = hasPrebuild();

describe.each(['native', 'wasm'].filter((backend) => backend === 'wasm' || kernelBuilt))(
  'Python body docstrings (%s)', (backend) => {
  let dir: string | undefined;
  let cg: CodeGraph | undefined;
  let savedKernel: string | undefined;
  let savedLangs: string | undefined;

  beforeEach(() => {
    savedKernel = process.env.CODEGRAPH_KERNEL;
    savedLangs = process.env.CODEGRAPH_KERNEL_LANGS;
    process.env.CODEGRAPH_KERNEL = backend === 'wasm' ? '0' : '1';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    resetKernelForTests();
    if (backend === 'native') expect(getKernel()).not.toBeNull();
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = savedKernel;
    if (savedLangs === undefined) delete process.env.CODEGRAPH_KERNEL_LANGS;
    else process.env.CODEGRAPH_KERNEL_LANGS = savedLangs;
    resetKernelForTests();
  });

  it.each(['LF', 'CRLF'])('handles module, decorated/async definitions and literal forms (%s)', (ending) => {
    const byName = docstrings(ending === 'CRLF' ? fixture.replace(/\n/g, '\r\n') : fixture);
    expect(byName.get('ledger.py')).toBe('Ledger module documentation.');
    expect(byName.get('reconcile_ledger')).toBe('Legacy reconciliation path.\n\nSettle the nightly discrepancy with the bank.');
    expect(byName.get('Ledger')).toBe('Ledger class comment.\n\nPost entries.\n\nPreserve relative indentation:\n    details here.');
    expect(byName.get('settle')).toBe('Method comment.\n\nSettle the ledger.');
    expect(byName.get('raw_doc')).toBe('Raw \\d+ expression.');
    expect(byName.get('empty_concat')).toBe('Kept prose.');
    expect(byName.get('blank_comment')).toBe('Kept despite blank comment.');
    for (const name of ['empty_doc', 'bytes_doc', 'raw_bytes_doc', 'formatted_doc',
      'interpolated_doc', 'concatenated_bytes', 'concatenated_format', 'late_string',
      'computed_string', 'tuple_string', 'bare_tuple', 'singleton_tuple', 'nested_string']) {
      expect(byName.has(name)).toBe(true);
      expect(byName.get(name), name).toBeUndefined();
    }
  });

  it('expands tabs and preserves relative indentation', () => {
    expect(docstrings('def tabbed():\n    """Summary.\n\n\tDetails.\n\t    Nested.\n    """\n').get('tabbed'))
      .toBe('Summary.\n\nDetails.\n    Nested.');
  });

  it.each(['b"bytes"', 'f"formatted"', 'pass\n"late"', '"one" + "two"'])(
    'rejects a non-docstring module first statement: %s', (source) => {
      expect(docstrings(source).get('ledger.py')).toBeUndefined();
    },
  );

  it('persists prose for FTS and keeps exact names first', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1905-'));
    fs.writeFileSync(path.join(dir, 'ledger.py'), fixture);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
    cg = CodeGraph.openSync(dir);
    expect(cg.getNodesByName('reconcile_ledger')[0].docstring)
      .toBe('Legacy reconciliation path.\n\nSettle the nightly discrepancy with the bank.');
    expect(cg.searchNodes('discrepancy bank').map(({ node }) => node.name))
      .toEqual(expect.arrayContaining(['reconcile_ledger', 'audit_ledger']));
    expect(cg.searchNodes('reconcile_ledger')[0].node.name).toBe('reconcile_ledger');
    expect(cg.searchNodes('documentation').some(({ node }) => node.kind === 'file' && node.name === 'ledger.py')).toBe(true);
  });

  it('extracts the same sentence from a docstring as from a leading comment (#1905)', () => {
    // The issue's repro: one sentence, two positions. Before this change only
    // `audit_ledger` carried it.
    const byName = docstrings(`
def reconcile_ledger():
    """Settle the nightly discrepancy with the bank."""
    return LEDGER

# Settle the nightly discrepancy with the bank.
def audit_ledger():
    return LEDGER
`);
    expect(byName.get('reconcile_ledger')).toBe('Settle the nightly discrepancy with the bank.');
    expect(byName.get('audit_ledger')).toBe('Settle the nightly discrepancy with the bank.');
  });

  it('dedents a multi-line docstring to its own left margin', () => {
    const byName = docstrings(`
class Ledger:
    """Post entries to the general ledger.

    Nightly reconciliation runs against the bank feed.
    """
    pass
`);
    expect(byName.get('Ledger')).toBe(
      'Post entries to the general ledger.\n\nNightly reconciliation runs against the bank feed.',
    );
  });

  it("keeps both when a definition carries a comment AND a docstring", () => {
    // Two things the author wrote about the same symbol; the column is free
    // text, so neither is dropped.
    const byName = docstrings(`
# Legacy path, kept for the 2019 import.
def reconcile_ledger():
    """Settle the nightly discrepancy with the bank."""
    return LEDGER
`);
    expect(byName.get('reconcile_ledger')).toBe(
      'Legacy path, kept for the 2019 import.\n\nSettle the nightly discrepancy with the bank.',
    );
  });

  it('handles the single-quote and prefixed forms', () => {
    const byName = docstrings(`
def with_single():
    '''Single-quoted docstring.'''
    return 1

def with_raw_prefix():
    r"""Raw \\d+ docstring."""
    return 2
`);
    expect(byName.get('with_single')).toBe('Single-quoted docstring.');
    expect(byName.get('with_raw_prefix')).toBe('Raw \\d+ docstring.');
  });

  it('skips an f-string first statement — that is code, not prose', () => {
    const byName = docstrings(`
def interpolated(name):
    f"""Hello {name}."""
    return name
`);
    expect(byName.get('interpolated') ?? null).toBeNull();
  });

  it('does not treat a non-string first statement as prose', () => {
    const byName = docstrings(`
def no_docstring():
    total = 0
    return total
`);
    expect(byName.get('no_docstring') ?? null).toBeNull();
  });
});
