/**
 * codegraph_explore query-path pinning (src/graph/search/query-paths.ts wiring).
 *
 * Fork port of upstream #1830/#1837: a query span that names a file BY PATH is
 * pinned (guaranteed admission, top rank, span stripped from the matching
 * query), and a path-shaped span the index does not hold is REPORTED instead of
 * silently shredding into FTS fragments. A dotless slashed span
 * (`scripts/deploy`) is decided by existence on disk — `and/or` has the same
 * shape and must stay untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { ToolHandler } from '../../src/graph/mcp/tools';

describe('codegraph_explore — query-path pinning and unresolved-path caveats', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qpaths-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(testDir, 'scripts'), { recursive: true });

    fs.writeFileSync(
      path.join(src, 'feature.ts'),
      `export function target() { return 1; }\n` +
      `export function caller() { return target(); }\n`,
    );
    // A real file the index does NOT hold (no recognized extension) — the
    // #1830 shape: dotless, slashed, exists on disk.
    fs.writeFileSync(path.join(testDir, 'scripts', 'deploy'), '#!/bin/sh\necho deploying\n');

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports a dotless path that exists on disk but is not indexed (empty result)', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'scripts/deploy' });
    const text = res.content[0].text;
    expect(text).toContain('No relevant code found');
    expect(text).toContain('no indexed file uniquely matches `scripts/deploy`');
  });

  it('appends the unresolved-path caveat to a non-empty result', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'target scripts/deploy' });
    const text = res.content[0].text;
    expect(text).toContain('feature.ts');
    expect(text).toContain('No indexed file uniquely matches `scripts/deploy`.');
  });

  it('leaves `and/or` prose alone — no false caveat', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'does caller block and/or timeout' });
    const text = res.content[0].text;
    expect(text).not.toContain('no indexed file uniquely matches');
    expect(text).not.toContain('No indexed file uniquely matches');
  });

  it('does not report a dotless span that is not a file on disk', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'trace the input/output buffering of caller' });
    const text = res.content[0].text;
    expect(text).not.toContain('indexed file uniquely matches');
  });

  it('pins an indexed file named by path and says so in the summary', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'src/feature.ts caller' });
    const text = res.content[0].text;
    expect(text).toContain('1 file pinned from the query.');
    expect(text).toContain('#### src/feature.ts');
  });

  it('renders a pure-path query from the pinned file alone', async () => {
    // The stripped match query is empty — findRelevantContext returns nothing,
    // so ONLY the pinned-file injection can produce a result.
    const res = await handler.execute('codegraph_explore', { query: 'src/feature.ts' });
    const text = res.content[0].text;
    expect(text).not.toContain('No relevant code found');
    expect(text).toContain('1 file pinned from the query.');
    expect(text).toContain('#### src/feature.ts');
    expect(text).toContain('export function target()');
  });

  it('reports a clearly-path-shaped span that matches nothing in the index', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'crash in src/gone/missing-page.ts on load' });
    const text = res.content[0].text;
    expect(text).toContain('no indexed file uniquely matches `src/gone/missing-page.ts`');
  });
});
