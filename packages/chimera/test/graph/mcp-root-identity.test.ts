/**
 * Equivalent project paths share one connection (upstream #1057 / #2020).
 *
 * A symlinked checkout — or a case-variant of a root on a case-insensitive
 * mount (macOS, NTFS, WSL DrvFs) — resolves to two path strings and used to
 * open TWO connections to the same codegraph.db. The MCP project cache now
 * compares live data-root identities (dev:ino as bigints; native realpath on
 * Windows) on every miss, pins the cache owner key to the symlink target,
 * and closeAll closes each instance once.
 */

import { describe, it, expect, afterEach } from './vitest';
const { isSameIndexRoot, statInode } = await import('../../src/graph/directory');
const { default: CodeGraph } = await import('../../src/graph/index');
const { ToolHandler } = await import('../../src/graph/mcp/tools');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const posixOnly = it.skipIf(process.platform === 'win32');

const tmpDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('root identity (upstream #1057/#2020)', () => {
  posixOnly('statInode reads dev:ino and rejects a missing path', () => {
    const dir = makeDir('cg-root-identity-');
    const inode = statInode(dir);
    expect(inode).toMatch(/^\d+:\d+$/);
    expect(statInode(path.join(dir, 'nope'))).toBeNull();
  });

  posixOnly('isSameIndexRoot matches a symlink spelling and rejects a different root', () => {
    const real = makeDir('cg-root-real-');
    fs.writeFileSync(path.join(real, 'index.ts'), 'export const x = 1;');
    const cg = CodeGraph.initSync(real);
    cg.destroy();

    const links = makeDir('cg-root-links-');
    const link = path.join(links, 'alias');
    fs.symlinkSync(real, link, 'dir');
    const other = makeDir('cg-root-other-');

    expect(isSameIndexRoot(real, real)).toBe(true);
    expect(isSameIndexRoot(real, link)).toBe(true);
    expect(isSameIndexRoot(real, other)).toBe(false);
    // A deleted root never matches, even if a new directory reuses the inode.
    fs.rmSync(path.join(real, '.chimera'), { recursive: true, force: true });
    expect(isSameIndexRoot(real, link)).toBe(false);
  });

  posixOnly('ToolHandler shares one connection across two spellings of one root', async () => {
    const real = makeDir('cg-handler-real-');
    fs.writeFileSync(path.join(real, 'index.ts'), 'export function sharedSymbol() { return 1; }');
    const init = await CodeGraph.init(real, { index: true });
    await init.close();

    const links = makeDir('cg-handler-links-');
    const link = path.join(links, 'alias');
    fs.symlinkSync(real, link, 'dir');

    const handler = new ToolHandler(null);
    try {
      const getCodeGraph = (handler as unknown as { getCodeGraph(p?: string): unknown }).getCodeGraph.bind(handler);
      const viaReal = getCodeGraph(real);
      const viaLink = getCodeGraph(link);
      expect(viaLink).toBe(viaReal); // one instance, not two connections
    } finally {
      handler.closeAll();
    }
  }, 60_000);
});
