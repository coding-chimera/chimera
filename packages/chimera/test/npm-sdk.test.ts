/**
 * Programmatic package entry tests.
 *
 * After the single `coding-chimera` agent package migration,
 * `@opencode-ai/chimera` is the graph/runtime compatibility package. It
 * exposes its compiled library directly; it no longer uses the old
 * `scripts/npm-sdk.js` optional-dependency re-export path.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function packageJson(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
}

describe('npm package programmatic entry', () => {
  it('exports the graph library directly from dist', () => {
    const pkg = packageJson();
    expect(pkg.name).toBe('@opencode-ai/chimera');
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.exports['.'].default).toBe('./dist/index.js');
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts');
  });

  it('does not define standalone npm platform bundles', () => {
    const pkg = packageJson();
    expect(pkg.bin).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });
});
