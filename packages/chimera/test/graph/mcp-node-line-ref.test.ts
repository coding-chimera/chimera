/**
 * Line-numbered file references in codegraph_node (upstream #1831/#1836).
 *
 * Agents and humans paste `src/app.ts:42`, `a.ts:12-40`, `a.ts#L88` shapes
 * constantly. The fork's node tool is symbol-based (no separate file-view
 * branch), so the ported semantic is: the literal spelling resolves FIRST
 * (a symbol genuinely named `foo:12` still wins), and only a failed literal
 * match strips the suffix — the path becomes a file hint and the start line
 * a line hint, feeding the existing overload narrowing.
 *
 * Real CodeGraph + real ToolHandler.execute(); no watcher involved.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import type CodeGraphType from '../../src/graph/index';
import type { ToolHandler as ToolHandlerType } from '../../src/graph/mcp/tools';
const { default: CodeGraph } = await import('../../src/graph/index');
const { ToolHandler } = await import('../../src/graph/mcp/tools');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('codegraph_node line-numbered references (upstream #1836)', () => {
  let testDir: string;
  let cg: CodeGraphType;
  let handler: ToolHandlerType;

  beforeEach(async () => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-line-ref-')));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'app.ts'),
      'export function first() { return 1; }\nexport function second() { return first(); }\nexport function third() { return second(); }\n',
    );
    cg = await CodeGraph.init(testDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(async () => {
    handler.closeAll?.();
    if (cg) await cg.close();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((c) => c.text ?? '').join('\n');

  it('resolves a :<line> reference to the definition containing that line', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'src/app.ts:3' });
    const out = text(result);
    // Line 3 is `third` — not the "not found" miss wording.
    expect(out).not.toContain('not found');
    expect(out).toContain('third');
  });

  it('resolves a :<a>-<b> range reference', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'src/app.ts:2-3' });
    const out = text(result);
    expect(out).not.toContain('not found');
    // The start line (2) pins `second`.
    expect(out).toContain('second');
  });

  it('resolves the #L<n> shape', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'src/app.ts#L1' });
    const out = text(result);
    expect(out).not.toContain('not found');
    expect(out).toContain('first');
  });

  it('still reports a genuine miss', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'src/nope.ts:12' });
    expect(text(result)).toContain('not found');
  });

  it('a plain symbol name keeps resolving without any suffix logic', async () => {
    const result = await handler.execute('codegraph_node', { symbol: 'second' });
    expect(text(result)).toContain('second');
  });
});
