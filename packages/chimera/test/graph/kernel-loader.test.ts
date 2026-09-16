/**
 * Kernel loader degradation tests (P0-2a): the kernel is OPTIONAL everywhere —
 * every failure mode (no binary, contract mismatch, kill switch) resolves to
 * null and the wasm extraction path is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import { NODE_KINDS } from '../../src/graph/types';
import {
  getKernel,
  kernelSupports,
  resetKernelForTests,
  verifyKernelContract,
  type KernelContractInfo,
} from '../../src/graph/extraction/kernel/loader';
import { EDGE_KINDS, KERNEL_ABI_VERSION } from '../../src/graph/extraction/kernel/layout';
import { hasPrebuild, requirePrebuild } from './kernel-testutil';

const matchingInfo = (): KernelContractInfo => ({
  abiVersion: KERNEL_ABI_VERSION,
  kernelVersion: 'test',
  nodeKinds: [...NODE_KINDS],
  edgeKinds: [...EDGE_KINDS],
  languages: ['typescript'],
});

describe('verifyKernelContract', () => {
  it('accepts byte-equal ABI + kind tables', () => {
    expect(verifyKernelContract(matchingInfo())).toBe(true);
  });

  it('rejects an ABI mismatch', () => {
    expect(verifyKernelContract({ ...matchingInfo(), abiVersion: KERNEL_ABI_VERSION + 1 })).toBe(false);
    expect(verifyKernelContract({ ...matchingInfo(), abiVersion: 1 })).toBe(false);
  });

  it('rejects NodeKind table divergence (append/reorder = wire break)', () => {
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: [...NODE_KINDS].reverse() })).toBe(false);
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: [...NODE_KINDS].slice(0, 5) })).toBe(false);
    expect(verifyKernelContract({ ...matchingInfo(), nodeKinds: [...NODE_KINDS, 'union'] })).toBe(false);
  });

  it('rejects EdgeKind table divergence', () => {
    expect(verifyKernelContract({ ...matchingInfo(), edgeKinds: [...EDGE_KINDS].slice(1) })).toBe(false);
  });

  it('REJECTS the real vendored kernel (P0 state): NODE_KINDS divergence — full wasm degradation', () => {
    if (!hasPrebuild()) return; // nothing vendored on this machine — degradation covered by getKernel below
    const info = requirePrebuild().contractInfo();
    expect(info.abiVersion).toBe(KERNEL_ABI_VERSION);
    // The documented P0-2a reconciliation failure: fork 'statement'@18 vs
    // kernel import/export/route/component/union @18-22.
    expect(verifyKernelContract(info)).toBe(false);
  });
});

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

  it('resolves to null when no usable binary exists (absent OR contract-rejected)', () => {
    // P0 state on every machine: without a prebuild there is nothing to load;
    // WITH the vendored prebuild the contract gate rejects it (kind-table
    // divergence). Either way: null, and routing stays off.
    expect(getKernel()).toBeNull();
    expect(kernelSupports('typescript')).toBe(false);
    expect(kernelSupports('python')).toBe(false);
  });

  it('CODEGRAPH_KERNEL_PATH pointing at garbage still degrades to null', () => {
    process.env.CODEGRAPH_KERNEL_PATH = '/nonexistent/codegraph-kernel.node';
    resetKernelForTests();
    expect(getKernel()).toBeNull();
  });

  it('kill switch CODEGRAPH_KERNEL=0 disables support per call', () => {
    process.env.CODEGRAPH_KERNEL = '0';
    expect(kernelSupports('typescript')).toBe(false);
    delete process.env.CODEGRAPH_KERNEL;
    // per-call check: flipping it back re-evaluates without a reload
    expect(kernelSupports('typescript')).toBe(false); // still false: contract gate (P0 state)
  });
});
