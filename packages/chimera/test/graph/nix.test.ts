/**
 * Nix grammar enablement smoke test (K-v2 ruling ⑤ partial reversal, 2026-09-22).
 *
 * The vendored blob (wasm/tree-sitter-nix.wasm, see MANIFEST.md) makes nix
 * extraction live on the wasm arm — the kernel has no nix arm, so this suite
 * pins CODEGRAPH_KERNEL=0 like the other wasm-arm suites.
 */

import { describe, it, expect, beforeAll, afterAll } from './vitest';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars, isGrammarLoaded, isLanguageSupported } from '../../src/graph/extraction/grammars';

let savedKernelEnv: string | undefined;

beforeAll(async () => {
  savedKernelEnv = process.env.CODEGRAPH_KERNEL;
  process.env.CODEGRAPH_KERNEL = '0';
  await initGrammars();
  await loadAllGrammars();
});

afterAll(() => {
  if (savedKernelEnv === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = savedKernelEnv;
});

describe('nix grammar (vendored blob)', () => {
  it('loads the nix grammar from the vendored wasm', () => {
    expect(isLanguageSupported('nix')).toBe(true);
    expect(isGrammarLoaded('nix')).toBe(true);
  });

  it('extracts bindings from a nix module', () => {
    const code = `{ pkgs, ... }:
let
  version = "1.0";
in {
  packages.default = pkgs.stdenv.mkDerivation { pname = "demo"; inherit version; };
  lib.helper = x: x;
}
`;
    const result = extractFromSource('default.nix', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('default.nix');

    const names = result.nodes.map((n) => `${n.kind}:${n.name}`);
    expect(names).toContain('variable:version');
    expect(names).toContain('variable:packages.default');
    expect(names).toContain('function:lib.helper');
    expect(result.edges.length).toBeGreaterThan(0);
  });
});
