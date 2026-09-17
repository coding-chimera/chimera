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
import { verifyKernelContract } from '../../src/graph/extraction/kernel/loader';
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
      'navigates',
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
    // Synthetic diverged kernel table: 'statement' at index 18 (the pre-P1
    // vendored shape) instead of the fork's tail index 23. Wire rows carry
    // the BUILDER's (fork) indexes; production decode must re-resolve them
    // through the kernel's own table (loader.kernelWireTables), so the same
    // bytes decode to different kinds per table.
    const kernelTable = [
      ...NODE_KINDS.slice(0, 18),
      'statement',
      'import',
      'export',
      'route',
      'component',
      'union',
    ];
    const buffers = buildKernelBuffers({ nodes: [{ kind: 'statement', name: 'x', id: 'n0' }] });
    // Fork-table decode: row kind index 23 → 'statement'.
    expect(decodeExtractBuffers(buffers, 'f.ts', 'typescript').nodes[0].kind).toBe('statement');
    // Kernel-table decode of the SAME bytes: index 23 → 'union' — exactly the
    // table-selective resolution production decode uses; the P1 subset gate
    // only rejects kernel-ONLY kinds, never index shifts.
    expect(decodeExtractBuffers(buffers, 'f.ts', 'typescript', kernelTable).nodes[0].kind).toBe('union');
  });

  it('honors the edgeKinds override (kernel-own table) for edge rows and ref rows', () => {
    // Reversed kernel edge table: wire index 0 decodes reversed[0] (fork:
    // 'contains'), index 6 decodes reversed[6] (fork: 'references') — derived
    // so contract-table growth can't stale the expectations.
    const kernelTable = [...EDGE_KINDS].reverse();
    const buffers = buildKernelBuffers({
      nodes: [{ kind: 'file', name: 'g.ts', id: 'file:g.ts' }],
      edges: [{ source: 0, target: 'x:id', kind: 'contains' }],
      refs: [{ from: 0, kind: 'references', referenceName: 'r' }],
    });
    const viaFork = decodeExtractBuffers(buffers, 'g.ts', 'typescript');
    expect(viaFork.edges[0].kind).toBe('contains');
    expect(viaFork.unresolvedReferences[0].referenceKind).toBe('references');
    const viaKernel = decodeExtractBuffers(buffers, 'g.ts', 'typescript', undefined, kernelTable);
    expect(viaKernel.edges[0].kind).toBe(kernelTable[0]);
    expect(viaKernel.unresolvedReferences[0].referenceKind).toBe(kernelTable[6]);
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
    // Decode with the KERNEL's own table — what production decode does via
    // loader.kernelWireTables(). Since the P1 tsjs batch the kernel and fork
    // tables are index-by-index equal ('statement' tail-aligned on both).
    const result = decodeExtractBuffers(buffers, 'real.ts', 'typescript', info.nodeKinds);
    expect(result.errors).toEqual([]);
    const byName = new Map(result.nodes.map((n) => [n.name, n]));
    expect(byName.get('Svc')?.kind).toBe('class');
    expect(byName.get('Svc')?.isExported).toBe(true);
    // typeParameters emission shape is parity-harness territory (wave2), not P0.
    expect(byName.get('go')?.kind).toBe('method');
    expect(byName.get('go')?.isAsync).toBe(true);
    // P1 tsjs batch: returnType (raw annotation text, colon stripped) and
    // params (extraJson escape hatch, fork {name,type} shape) are emitted —
    // byte-level parity against the wasm arm is the harness's job, this is
    // the field-presence smoke (the P0-2a gap both fields had).
    expect(byName.get('go')?.returnType).toBe('Promise<string>');
    expect(byName.get('go')?.params).toEqual([{ name: 'x', type: 'number' }]);
    expect(byName.get('top')?.returnType).toBe('string');
    expect(byName.get('top')?.params).toEqual([{ name: 'a', type: 'string' }]);
    // Statement emission (fork-only CodePlan semantics): `return String(x);`
    // qualifies (call dependency, function parent); `this.n++` does not.
    const stmt = result.nodes.find((n) => n.kind === 'statement');
    expect(stmt?.name).toBe('stmt@5:51');
    expect(stmt?.signature).toBe('return String(x);');
    // `return a;` in top() has no call/new dependency — not eligible.
    expect(result.nodes.filter((n) => n.kind === 'statement').length).toBe(1);
    // K-v2 P3: N's #808 member classification returned with the re-vendor —
    // a non-callable `private n = 0` field extracts as a 'property'
    // (classify_ts_class_member → extract_property), no longer forced
    // through extractMethod by the excised-classification fork shape.
    expect(byName.get('n')?.kind).toBe('property');
    expect(byName.get('top')?.kind).toBe('function');
    expect(result.nodes.every((n) => n.id && n.kind && n.filePath === 'real.ts')).toBe(true);
    expect(result.edges.some((e) => e.kind === 'contains')).toBe(true);
    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
  });

  runIt('real kernel NODE_KINDS vs fork: tables are index-by-index equal (P1 tail alignment)', () => {
    if (!hasPrebuild()) {
      throw new Error('CODEGRAPH_KERNEL_EXPECT=1 but no prebuild staged — run packages/chimera/script/build-kernel.sh');
    }
    const info = requirePrebuild().contractInfo();
    // EDGE_KINDS: the K-v2 P3 re-vendor landed 'navigates' in the kernel
    // table (upstream N tail append) — the P1 reservation is consumed and
    // the fork's lead set is EMPTY. Every kernel kind must exist in the
    // fork table (subset gate); the lead pin stays so a future kernel-only
    // kind can never silently slip through.
    expect(info.edgeKinds.every((k) => (EDGE_KINDS as readonly string[]).includes(k))).toBe(true);
    const forkEdgeLead = (EDGE_KINDS as readonly string[]).filter((k) => !info.edgeKinds.includes(k));
    expect(forkEdgeLead).toEqual([]);
    // NODE_KINDS: the P1 tsjs batch appended 'statement' at the kernel table
    // tail and moved the fork's 'statement' from index 18 to the tail in the
    // same change — the subset gate now passes as FULL index-by-index
    // equality (the historical fork-exclusive-kind divergence is gone).
    expect(info.nodeKinds).toEqual([...NODE_KINDS]);
    expect(info.nodeKinds.includes('statement')).toBe(true);
    expect(info.nodeKinds[info.nodeKinds.length - 1]).toBe('statement');
    const kernelOnly = info.nodeKinds.filter((k) => !(NODE_KINDS as readonly string[]).includes(k));
    expect(kernelOnly).toEqual([]);
    expect(verifyKernelContract(info)).toBe(true);
  });
});
