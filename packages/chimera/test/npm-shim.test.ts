/**
 * Legacy standalone npm shim tests.
 *
 * The graph package no longer owns a public npm launcher. The complete
 * `coding-chimera` agent package owns the `chimera` bin and its platform
 * optionalDependencies, so this package must not wire `scripts/npm-shim.js`
 * into its public package metadata.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function packageJson(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
}

describe('legacy npm shim packaging', () => {
  it('does not register a public codegraph or chimera bin', () => {
    expect(packageJson().bin).toBeUndefined();
  });

  it('keeps the graph CLI importable through the explicit ./cli export', () => {
    const pkg = packageJson();
    expect(pkg.exports['./cli'].default).toBe('./dist/cli/chimera.js');
    expect(pkg.exports['./cli'].types).toBe('./dist/cli/chimera.d.ts');
  });
});
