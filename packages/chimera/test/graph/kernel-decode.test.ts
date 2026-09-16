/**
 * Kernel layout/decode tests (P0-2a).
 *
 * Two layers:
 * 1. Synthetic buffers (always run) — byte-layout and decode semantics built
 *    with kernel-testutil's builder: tri-state flags, NONE sentinels, arena
 *    strings, NUL lists, extraJson passthrough, REF_FLAG_FILE_PATH,
 *    FUNCTION_REF_CODE drop (fork adaptation), errors JSON, ABI guard.
 * 2. Real vendored-kernel buffers — run only when the local prebuild exists
 *    (packages/chimera/script/build-kernel.sh staged); skipped otherwise, and
 *    a skip becomes a FAILURE when CODEGRAPH_KERNEL_EXPECT=1 (upstream
 *    posture for CI machines that must have the binary).
 */

import { describe, it, expect } from './vitest';
import { NODE_KINDS } from '../../src/graph/types';
import { decodeExtractBuffers } from '../../src/graph/extraction/kernel/decode';
import {
  EDGE_KINDS,
  KERNEL_ABI_VERSION,
  META_SIZE,
  NODE_ROW_SIZE,
  EDGE_ROW_SIZE,
  REF_ROW_SIZE,
  NONE,
  FUNCTION_REF_CODE,
  REF_FLAG_FILE_PATH,
} from '../../src/graph/extraction/kernel/layout';
import { buildKernelBuffers, hasPrebuild, requirePrebuild } from './kernel-testutil';

const expectPrebuild = process.env.CODEGRAPH_KERNEL_EXPECT === '1';

describe('kernel layout constants (ABI v2, byte-aligned with buffers.rs)', () => {
  it('matches the wire sizes', () => {
    expect(KERNEL_ABI_VERSION).toBe(2);
    expect(META_SIZE).toBe(36);
    expect(NODE_ROW_SIZE).toBe(96);
    expect(EDGE_ROW_SIZE).toBe(44);
    expect(REF_ROW_SIZE).toBe(40);
    expect(NONE).toBe(0xffffffff);
    expect(FUNCTION_REF_CODE).toBe(200);
    expect(REF_FLAG_FILE_PATH).toBe(1);
  });

  it('EDGE_KINDS wire table mirrors the fork EdgeKind union in contract order', () => {
    expect([...EDGE_KINDS]).toEqual([
      'contains',
      'calls',
      'imports',
      'exports',
      'extends',
      'implements',
      'references',
      'type_of',
      'returns',
      'instantiates',
      'overrides',
      'decorates',
    ]);
  });
});

describe('decodeExtractBuffers — synthetic buffers', () => {
  it('decodes nodes with all optional fields', () => {
    const buffers = buildKernelBuffers({
      nodes: [
        {
          kind: 'file',
          name: 'a.ts',
          id: 'file:a.ts',
          startLine: 1,
          endLine: 9,
        },
        {
          kind: 'method',
          name: 'run',
          qualifiedName: 'Svc::run',
          id: 'method:abc123',
          startLine: 3,
          endLine: 5,
          startColumn: 2,
          endColumn: 3,
          visibility: 'private',
          isExported: true,
          isAsync: false,
          isStatic: true,
          docstring: 'Runs it.',
          signature: '(x: number): Promise<void>',
          decorators: ['Logged', 'Cached'],
          typeParameters: ['T'],
          returnType: 'Promise<void>',
          extraJson: { params: [{ name: 'x', type: 'number' }] },
        },
      ],
    });
    const result = decodeExtractBuffers(buffers, 'a.ts', 'typescript');
    expect(result.nodes.length).toBe(2);
    const [file, method] = result.nodes;
    expect(file.kind).toBe('file');
    expect(file.id).toBe('file:a.ts');
    expect(file.qualifiedName).toBe('a.ts');
    expect(file.filePath).toBe('a.ts');
    expect(file.language).toBe('typescript');
    expect(file.startLine).toBe(1);
    expect(file.endLine).toBe(9);
    expect(file.docstring).toBeUndefined();
    expect(file.isExported).toBeUndefined(); // tri-state: absent stays absent
    expect(typeof file.updatedAt).toBe('number');

    expect(method.kind).toBe('method');
    expect(method.qualifiedName).toBe('Svc::run');
    expect(method.visibility).toBe('private');
    expect(method.isExported).toBe(true);
    expect(method.isAsync).toBe(false); // present-and-false ≠ absent
    expect(method.isStatic).toBe(true);
    expect(method.isAbstract).toBeUndefined();
    expect(method.docstring).toBe('Runs it.');
    expect(method.signature).toBe('(x: number): Promise<void>');
    expect(method.decorators).toEqual(['Logged', 'Cached']);
    expect(method.typeParameters).toEqual(['T']);
    expect(method.returnType).toBe('Promise<void>');
    // extraJson Object.assign passthrough — the params escape hatch (plan §2.2)
    expect(method.params).toEqual([{ name: 'x', type: 'number' }]);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedReferences).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.durationMs).toBe(0);
  });

  it('decodes edges with row-index endpoints and literal-id fallbacks', () => {
    const buffers = buildKernelBuffers({
      nodes: [
        { kind: 'file', name: 'b.ts', id: 'file:b.ts' },
        { kind: 'function', name: 'f', id: 'function:f' },
      ],
      edges: [
        { source: 0, target: 1, kind: 'contains' },
        {
          source: 1,
          target: 'external:Thing',
          kind: 'calls',
          line: 7,
          column: 4,
          provenance: 'tree-sitter',
          metadata: { valueRef: true },
        },
      ],
    });
    const result = decodeExtractBuffers(buffers, 'b.ts', 'typescript');
    expect(result.edges.length).toBe(2);
    expect(result.edges[0]).toEqual({ source: 'file:b.ts', target: 'function:f', kind: 'contains' });
    expect(result.edges[1].source).toBe('function:f');
    expect(result.edges[1].target).toBe('external:Thing'); // NONE idx → idStr
    expect(result.edges[1].kind).toBe('calls');
    expect(result.edges[1].line).toBe(7);
    expect(result.edges[1].column).toBe(4);
    expect(result.edges[1].provenance).toBe('tree-sitter');
    expect(result.edges[1].metadata).toEqual({ valueRef: true });
    // absent line/column/provenance/metadata on the first edge
    expect(result.edges[0].line).toBeUndefined();
    expect(result.edges[0].provenance).toBeUndefined();
    expect(result.edges[0].metadata).toBeUndefined();
  });

  it('decodes refs: fromIdx + fromIdStr, candidates, REF_FLAG_FILE_PATH, and DROPS function_ref (fork adaptation)', () => {
    const buffers = buildKernelBuffers({
      nodes: [{ kind: 'file', name: 'c.rb', id: 'file:c.rb' }],
      refs: [
        { from: 0, kind: 'calls', referenceName: 'puts', line: 2, column: 1, candidates: ['Kernel#puts'] },
        { from: 'orphan:id', kind: 'implements', referenceName: 'Enumerable', flagFilePath: true },
        { from: 0, kind: 'function_ref', referenceName: 'callback' },
      ],
    });
    const result = decodeExtractBuffers(buffers, 'c.rb', 'ruby');
    // function_ref (wire code 200) has no fork ReferenceKind — row dropped.
    expect(result.unresolvedReferences.length).toBe(2);
    expect(result.unresolvedReferences[0]).toMatchObject({
      fromNodeId: 'file:c.rb',
      referenceName: 'puts',
      referenceKind: 'calls',
      line: 2,
      column: 1,
      candidates: ['Kernel#puts'],
    });
    expect(result.unresolvedReferences[0].filePath).toBeUndefined(); // ordinary refs stay denormalization-free
    expect(result.unresolvedReferences[1]).toMatchObject({
      fromNodeId: 'orphan:id',
      referenceName: 'Enumerable',
      referenceKind: 'implements',
    });
    expect(result.unresolvedReferences[1].filePath).toBe('c.rb'); // REF_FLAG_FILE_PATH re-attach
  });

  it('decodes the errors table when present', () => {
    const buffers = buildKernelBuffers({
      nodes: [{ kind: 'file', name: 'd.ts', id: 'file:d.ts' }],
      errors: [{ message: 'partial parse', severity: 'warning', line: 4 }],
    });
    const result = decodeExtractBuffers(buffers, 'd.ts', 'typescript');
    expect(result.errors).toEqual([{ message: 'partial parse', severity: 'warning', line: 4 }]);
  });

  it('rejects an ABI-mismatched buffer and a truncated meta', () => {
    const bad = buildKernelBuffers({ nodes: [], abiVersion: KERNEL_ABI_VERSION + 1 });
    expect(() => decodeExtractBuffers(bad, 'e.ts', 'typescript')).toThrow(/ABI/);
    const short = { ...buildKernelBuffers({ nodes: [] }), meta: Buffer.alloc(META_SIZE - 1) };
    expect(() => decodeExtractBuffers(short, 'e.ts', 'typescript')).toThrow(/meta too short/);
  });

  it('honors the nodeKinds override (kernel-own table) for diverged tables', () => {
    // The vendored kernel's table: index 18 = 'import' (fork has 'statement').
    const kernelTable = [
      ...NODE_KINDS.slice(0, 18),
      'import',
      'export',
      'route',
      'component',
      'union',
    ];
    const buffers = buildKernelBuffers({ nodes: [{ kind: 'statement', name: 'x', id: 'n0' }] });
    // Fork-table decode: row kind index 18 → 'statement'.
    expect(decodeExtractBuffers(buffers, 'f.ts', 'typescript').nodes[0].kind).toBe('statement');
    // Kernel-table decode of the SAME bytes: index 18 → 'import' (the divergence
    // the loader's contract gate exists to catch before production routing).
    expect(decodeExtractBuffers(buffers, 'f.ts', 'typescript', kernelTable).nodes[0].kind).toBe('import');
  });
});

describe('decodeExtractBuffers — real vendored kernel buffers', () => {
  // Upstream posture: run when the local prebuild is staged; skip when it's
  // absent; a skip becomes a FAILURE when CODEGRAPH_KERNEL_EXPECT=1 (the test
  // body throws in that case).
  const runIt = hasPrebuild() || expectPrebuild ? it : it.skip;

  runIt('decodes a real TypeScript file into sensible nodes/edges/refs', () => {
    if (!hasPrebuild()) {
      throw new Error('CODEGRAPH_KERNEL_EXPECT=1 but no prebuild staged — run packages/chimera/script/build-kernel.sh');
    }
    const kernel = requirePrebuild();
    const info = kernel.contractInfo();
    expect(info.abiVersion).toBe(KERNEL_ABI_VERSION);
    const source = [
      'import { readFile } from "fs";',
      '/** Doc. */',
      'export class Svc<T> {',
      '  private n = 0;',
      '  async go(x: number): Promise<string> { this.n++; return String(x); }',
      '}',
      'function top(a: string): string { return a; }',
      '',
    ].join('\n');
    const buffers = kernel.extractFile('real.ts', source, 'typescript');
    for (const key of ['meta', 'nodes', 'edges', 'refs', 'arena'] as const) {
      expect(Buffer.isBuffer(buffers[key])).toBe(true);
    }
    // Decode with the KERNEL's own table (the fork table diverges at index 18 —
    // that reconciliation gap is the loader gate's job, not decode's).
    const result = decodeExtractBuffers(buffers, 'real.ts', 'typescript', info.nodeKinds);
    expect(result.errors).toEqual([]);
    const byName = new Map(result.nodes.map((n) => [n.name, n]));
    expect(byName.get('Svc')?.kind).toBe('class');
    expect(byName.get('Svc')?.isExported).toBe(true);
    // typeParameters emission shape is parity-harness territory (wave2), not P0.
    expect(byName.get('go')?.kind).toBe('method');
    expect(byName.get('go')?.isAsync).toBe(true);
    // NOTE (wave2 parity input): the tsjs walker leaves returnType unset on
    // `go` (the type rides in the signature text) while the go walker fills
    // it (`Start() error` → returnType='error' — see the P0 smoke evidence).
    // Byte-level returnType parity is the harness's job, not this test's.
    expect(byName.get('n')?.kind).toBe('property');
    expect(byName.get('top')?.kind).toBe('function');
    expect(result.nodes.every((n) => n.id && n.kind && n.filePath === 'real.ts')).toBe(true);
    expect(result.edges.some((e) => e.kind === 'contains')).toBe(true);
    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
  });

  runIt('exposes the P0 contract divergence: kernel NODE_KINDS ≠ fork NODE_KINDS, EDGE_KINDS equal', () => {
    if (!hasPrebuild()) {
      throw new Error('CODEGRAPH_KERNEL_EXPECT=1 but no prebuild staged — run packages/chimera/script/build-kernel.sh');
    }
    const info = requirePrebuild().contractInfo();
    // EDGE_KINDS: byte-equal with the fork wire table.
    expect(info.edgeKinds).toEqual([...EDGE_KINDS]);
    // NODE_KINDS: KNOWN P0 divergence (report item) — fork 'statement'@18 vs
    // kernel 'import'@18 … kernel 'union'@22 which the fork lacks. This is why
    // verifyKernelContract currently rejects the vendored binary and the whole
    // system degrades to wasm.
    expect(info.nodeKinds).not.toEqual([...NODE_KINDS]);
    expect(info.nodeKinds.includes('union')).toBe(true);
    expect(info.nodeKinds.includes('statement')).toBe(false);
    expect(NODE_KINDS.includes('statement')).toBe(true);
    expect(info.nodeKinds.slice(0, 18)).toEqual([...NODE_KINDS.slice(0, 18)]);
  });
});
