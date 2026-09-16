/**
 * Kernel loader degradation tests (P0-2a) + P1 subset-contract tests.
 *
 * The kernel is OPTIONAL everywhere — every failure mode (no binary, ABI
 * mismatch, kind table NOT a subset of the fork's, kill switch) resolves to
 * null and the wasm extraction path is unaffected.
 *
 * P1 contract: verification is a NAME-based subset check (kernel ⊆ fork).
 * Wire indexes are decoded through the kernel's OWN tables (kernelWireTables
 * → decodeExtractBuffers), so index divergence is legal; kernel-only kinds
 * are the only table-based rejection. Since the P1 tsjs batch the REAL
 * vendored tables are index-by-index equal ('statement' tail-aligned on
 * both sides); the subset rule now only guards FUTURE divergence. The fork
 * tables serve ONLY the subset check.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import { NODE_KINDS } from '../../src/graph/types';
import {
  getKernel,
  kernelSupports,
  kernelWireTables,
  resetKernelForTests,
  setKernelForTests,
  verifyKernelContract,
  type KernelContractInfo,
  type KernelModule,
} from '../../src/graph/extraction/kernel/loader';
import { tryKernelExtract } from '../../src/graph/extraction/kernel';
import { decodeExtractBuffers } from '../../src/graph/extraction/kernel/decode';
import { EDGE_KINDS, KERNEL_ABI_VERSION } from '../../src/graph/extraction/kernel/layout';
import { buildKernelBuffers, hasPrebuild, requirePrebuild } from './kernel-testutil';

const matchingInfo = (): KernelContractInfo => ({
  abiVersion: KERNEL_ABI_VERSION,
  kernelVersion: 'test',
  nodeKinds: [...NODE_KINDS],
  edgeKinds: [...EDGE_KINDS],
  languages: ['typescript'],
});

/** Synthetic fork-subset table (the pre-P1 vendored shape: fork minus 'statement'). */
const kernelLikeNodeKinds = NODE_KINDS.filter((k) => k !== 'statement');

describe('verifyKernelContract (P1 name-based subset: kernel ⊆ fork)', () => {
  it('accepts byte-equal ABI + kind tables (the trivial subset)', () => {
    expect(verifyKernelContract(matchingInfo())).toBe(true);
  });

  it('accepts a kernel NodeKind table that is a fork subset — fork-only kinds and index shifts are legal', () => {
    // The historical P1 unlock case: the then-vendored kernel table (fork
    // minus 'statement') was the permanent P0 rejection; under the subset
    // rule any name-subset verifies. (Since the P1 tsjs batch the REAL
    // tables are index-equal — this synthetic shape guards the rule itself.)
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: kernelLikeNodeKinds })).toBe(true);
    // Order never matters — decode resolves indexes through the kernel's own
    // table — so even a full reorder of known kinds is accepted.
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: [...NODE_KINDS].reverse() })).toBe(true);
    // Strict prefix subset (kernel claims only part of the fork's space): accepted.
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: NODE_KINDS.slice(0, 5) })).toBe(true);
  });

  it('rejects kernel-only NodeKinds (direction fixed: kernel ⊆ fork)', () => {
    // A kind the fork doesn't know must never ride the wire — this is what
    // keeps a FUTURE kernel with a new kind from being silently mis-decoded.
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: [...NODE_KINDS, 'constexpr'] })).toBe(false);
    expect(
      verifyKernelContract({ ...matchingInfo(), nodeKinds: [...kernelLikeNodeKinds, 'trait_v2'] })
    ).toBe(false);
  });

  it('rejects kernel-only EdgeKinds; accepts edge subsets (same semantics as node kinds)', () => {
    expect(verifyKernelContract({ ...matchingInfo(), edgeKinds: [...EDGE_KINDS, 'depends_on'] })).toBe(false);
    expect(verifyKernelContract({ ...matchingInfo(), edgeKinds: EDGE_KINDS.slice(1) })).toBe(true);
    expect(verifyKernelContract({ ...matchingInfo(), edgeKinds: [...EDGE_KINDS].reverse() })).toBe(true);
  });

  it('rejects an ABI mismatch (unchanged by the subset relaxation)', () => {
    expect(verifyKernelContract({ ...matchingInfo(), abiVersion: KERNEL_ABI_VERSION + 1 })).toBe(false);
    expect(verifyKernelContract({ ...matchingInfo(), abiVersion: 1 })).toBe(false);
  });

  it('applies the subset rule to the real vendored kernel (P1 arm flip)', () => {
    if (!hasPrebuild()) return; // nothing staged on this machine — absence degradation covered below
    const info = requirePrebuild().contractInfo();
    expect(info.abiVersion).toBe(KERNEL_ABI_VERSION);
    // edgeKinds are byte-equal, trivially a subset.
    expect(verifyKernelContract(info)).toBe(
      info.nodeKinds.filter((k) => !(NODE_KINDS as readonly string[]).includes(k)).length === 0
    );
    // Expect-flip history: before the G4 union chain landed 'union' in the
    // fork's NODE_KINDS, the kernel-only kind 'union' alone rejected this
    // binary. Since the P1 tsjs batch the kernel also carries 'statement'
    // at its table tail and the fork's 'statement' moved to the tail too —
    // the two tables are now index-by-index EQUAL, so kernelOnly is empty
    // and the real prebuild verifies unconditionally.
    const kernelOnly = info.nodeKinds.filter((k) => !(NODE_KINDS as readonly string[]).includes(k));
    expect(kernelOnly).toEqual([]);
    expect(verifyKernelContract(info)).toBe(true);
  });
});

describe('verified wire tables drive production decode (fake subset kernel)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetKernelForTests();
  });

  afterEach(() => {
    setKernelForTests(null);
    resetKernelForTests();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('kernelWireTables() falls back to fork tables, follows the installed kernel, clears again', () => {
    expect(kernelWireTables().nodeKinds).toEqual([...NODE_KINDS]);
    expect(kernelWireTables().edgeKinds).toEqual([...EDGE_KINDS]);
    const fake = makeFakeSubsetKernel();
    setKernelForTests(fake.mod);
    expect(kernelWireTables().nodeKinds).toEqual([...NODE_KINDS].reverse());
  });

  it('tryKernelExtract decodes rows through the kernel tables, not fork indexes', () => {
    // Raw bytes are mis-aligned ON PURPOSE: the synthetic builder resolves kind
    // names through the FORK tables, so the node row carries fork index 23
    // ('statement', the tail) and the edge/ref rows fork indexes 0 ('contains')
    // / 6 ('references'). A production decode must re-resolve those through
    // the kernel's own tables: the fake's REVERSED node table maps 23 →
    // 'file', and the reversed edge table maps 0 → 'decorates', 6 →
    // 'implements'.
    const fake = makeFakeSubsetKernel();
    expect(verifyKernelContract(fake.mod.contractInfo())).toBe(true); // the P1 pass case
    setKernelForTests(fake.mod);
    process.env.CODEGRAPH_KERNEL_LANGS = 'typescript';
    const result = tryKernelExtract('x.ts', 'source', 'typescript');
    expect(result).not.toBeNull();
    expect(result!.nodes[0].kind).toBe('file');
    expect(result!.edges[0].kind).toBe('decorates');
    expect(result!.unresolvedReferences[0].referenceKind).toBe('implements');
    // Same bytes decoded with the fork defaults map differently — proves the
    // kernel tables actually rode through the production call site.
    expect(decodeExtractBuffers(fake.buffers, 'x.ts', 'typescript').nodes[0].kind).toBe('statement');
  });
});

/**
 * Fake kernel whose contract is a name-subset of the fork with a FULLY
 * REVERSED kind order on both tables — decode must follow the fake's own
 * tables, not fork indexes. extractFile returns synthetic buffers built
 * with FORK indexes so the decode path can be caught mis-resolving.
 */
function makeFakeSubsetKernel(): { mod: KernelModule; buffers: ReturnType<typeof buildKernelBuffers> } {
  const buffers = buildKernelBuffers({
    nodes: [{ kind: 'statement', name: 'imp', id: 'n0' }],
    edges: [{ source: 0, target: 'x:id', kind: 'contains' }],
    refs: [{ from: 0, kind: 'references', referenceName: 'r' }],
  });
  const mod: KernelModule = {
    extractFile: () => buffers,
    contractInfo: () => ({
      abiVersion: KERNEL_ABI_VERSION,
      kernelVersion: 'fake-subset-kernel',
      nodeKinds: [...NODE_KINDS].reverse(),
      edgeKinds: [...EDGE_KINDS].reverse(),
      languages: ['typescript'],
    }),
    grammarInfo: () => null,
  };
  return { mod, buffers };
}

describe('getKernel degradation', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_PATH', 'CODEGRAPH_KERNEL_LANGS']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetKernelForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetKernelForTests();
  });

  it('resolves through the subset gate: null when absent OR rejected, loaded when the kernel table is a fork subset', () => {
    // No prebuild: nothing to load ⇒ null + support off.
    // With the vendored prebuild: the P1 gate accepts it once every kernel
    // kind exists in the fork table (this checkout: yes — the rejection path
    // is exercised by the synthetic kernel-only-kind cases above), so the
    // load follows the contract verdict either way.
    if (!hasPrebuild()) {
      expect(getKernel()).toBeNull();
      expect(kernelSupports('typescript')).toBe(false);
      expect(kernelSupports('python')).toBe(false);
      return;
    }
    const info = requirePrebuild().contractInfo();
    const accepted = verifyKernelContract(info);
    expect(getKernel() !== null).toBe(accepted);
    expect(kernelSupports('typescript')).toBe(accepted && info.languages.includes('typescript'));
  });

  it('CODEGRAPH_KERNEL_PATH pointing at garbage never loads it (search falls through)', () => {
    process.env.CODEGRAPH_KERNEL_PATH = '/nonexistent/codegraph-kernel.node';
    resetKernelForTests();
    // The bad explicit path must not crash and must never be trusted; search
    // falls through to the execPath/repo candidates. P1: with the staged
    // prebuild contract-accepted the load result is that module — still never
    // the garbage path — so the assertion follows the subset gate, mirroring
    // the degradation test above.
    const info = hasPrebuild() ? requirePrebuild().contractInfo() : null;
    const expectedLoaded = info !== null && verifyKernelContract(info);
    expect(getKernel() !== null).toBe(expectedLoaded);
  });

  it('kill switch CODEGRAPH_KERNEL=0 disables support per call', () => {
    process.env.CODEGRAPH_KERNEL = '0';
    expect(kernelSupports('typescript')).toBe(false);
    delete process.env.CODEGRAPH_KERNEL;
    // per-call check: flipping it back re-evaluates without a reload. Under
    // the P1 subset gate the answer hinges on the staged prebuild's contract.
    const accepted = hasPrebuild() && verifyKernelContract(requirePrebuild().contractInfo());
    expect(kernelSupports('typescript')).toBe(accepted);
  });
});
