/**
 * Named members are paid before incidental ones across clusters.
 *
 * Fork port of upstream #2062 (adad840). Clusters of equal max importance
 * rank by density, and density counts every member — so a named function with
 * unrelated helpers merged around it (within gapThreshold) outranked a cluster
 * holding a named function alone. Taken WHOLE, the higher cluster spent the
 * file's per-file budget on the helpers and the isolated named function
 * rendered nothing (upstream repro: lib/response.ts, sendBody 0 of 36 lines).
 *
 * Fork adaptation: the upstream fix prices member-level shrinks inside its
 * member-renderer (shrinkCluster / protectedCoreCost / owedPayableBelow over
 * rendered member windows). The fork keeps whole-cluster rendering and adds
 * the selection-level rule: a cluster's incidental members may only use what
 * is left once every lower-ranked cluster's protected members (named, entry,
 * exact — importance >= 9) are paid, and a protected cluster that cannot fit
 * whole inside the held-back budget shrinks to its protected core instead of
 * dropping (which also enforces upstream's second rule at cluster
 * granularity: incidental members are never kept past the ceiling). Upstream's
 * per-member incremental shrink inside a rendered cluster needs its
 * member-level re-render machinery and is not ported.
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { ToolHandler } from '../../src/graph/mcp/tools';

const RESPONSE = 'src/response.ts';

/** Every `<n>\t<text>` line number the response sent for `file`. */
function renderedLines(text: string, file: string): Set<number> {
  const out = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    const header = !inFence ? /^#### (.+?)(?: —|$)/.exec(line) : null;
    if (header) { current = header[1]!.trim(); continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    const m = inFence && current === file ? /^(\d+)\t/.exec(line) : null;
    if (m) out.add(Number(m[1]));
  }
  return out;
}

describe('codegraph_explore — named members paid before incidental ones', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const lineOf: Record<string, number> = {};

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-holdback-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });

    // flushHeaders: a named function with ten callers merged around it —
    // their glue lines pad its cluster exactly like upstream's helpers.
    const L: string[] = ['export interface State { headers: string[]; body: string }', ''];
    L.push('export function flushHeaders(state: State): string {');
    for (let i = 0; i < 24; i++) {
      L.push(`  const head${i} = "flush-${i}:" + state.headers.length;`);
    }
    L.push('  return head0; // HEAD_BODY_TAIL');
    L.push('}');
    for (let h = 0; h < 10; h++) {
      L.push('');
      L.push(`export function helper${h}(state: State): string {`);
      L.push(`  const base = flushHeaders(state);`);
      L.push(`  const pad${h}a = base + "${h}a" + state.headers.join("-");`);
      L.push(`  const pad${h}b = base + "${h}b" + String(state.headers.length);`);
      L.push(`  const pad${h}c = base + "${h}c" + pad${h}a.length;`);
      L.push(`  return "h${h}:" + pad${h}c.length;`);
      L.push(`} // HELPER_${h}_MARKER`);
    }
    // A >gapThreshold wall of comments so sendBody's cluster stays isolated.
    L.push('');
    for (let i = 0; i < 30; i++) L.push(`// pad ${i} — nothing extracted here`);
    L.push('');
    const sendBodyStart = L.length + 1;
    L.push('export function sendBody(payload: string): string {');
    for (let i = 0; i < 24; i++) {
      L.push(`  const chunk${i} = payload.slice(0, ${i} + 1);`);
    }
    L.push('  return chunk0; // SEND_BODY_TAIL');
    L.push('}');
    const sendBodyEnd = L.length;
    // Push the file past every whole-file ceiling so the cluster path runs.
    L.push('');
    for (let i = 0; i < 60; i++) L.push(`// tail ${i} — keeps the file above the whole-file caps`);

    const source = L.join('\n') + '\n';
    fs.writeFileSync(path.join(testDir, RESPONSE), source);
    lineOf.sendBodyStart = sendBodyStart;
    lineOf.sendBodyEnd = sendBodyEnd;

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('renders the isolated named body even though the helper-dense cluster outranks it', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'flushHeaders sendBody' });
    const text = res.content[0].text;
    expect(text).toContain('#### ' + RESPONSE);
    const lines = renderedLines(text, RESPONSE);
    // sendBody renders WHOLE — every line of the body, not zero of 26.
    for (let ln = lineOf.sendBodyStart!; ln <= lineOf.sendBodyEnd!; ln++) {
      expect(lines.has(ln), `sendBody line ${ln} rendered`).toBe(true);
    }
    expect(text).toContain('SEND_BODY_TAIL');
    // The other named function's body survives too (its cluster's protected core).
    expect(text).toContain('HEAD_BODY_TAIL');
    // The incidental helpers the dense cluster merged around flushHeaders did
    // not spend the budget the named bodies were owed.
    expect(text).not.toContain('HELPER_9_MARKER');
  });

  it('a cluster whole past the per-file budget keeps its protected core', async () => {
    // Only ONE named function and nothing protected ranked below: the dense
    // cluster still may not keep its incidental helpers past the ceiling —
    // upstream's second rule, at the fork's cluster granularity.
    const res = await handler.execute('codegraph_explore', { query: 'flushHeaders' });
    const text = res.content[0].text;
    expect(text).toContain('HEAD_BODY_TAIL');
    expect(text).not.toContain('HELPER_9_MARKER');
  });
});
