/**
 * The completeness note at the end of a codegraph_explore response claims
 * "complete" only for sections that are (fork port of upstream #2077).
 *
 * On the tiers with `includeCompletenessSignal` (>= 500 indexed files) every
 * response used to end with "Complete source for N files is included above —
 * do NOT re-read them", whatever the render had cut: a skeletonized file, a
 * dropped or core-shrunk cluster all went out under that line — upstream's
 * repro was a 62-line slice of vscode's 968-line rpcProtocol.ts presented as
 * complete. The same line also said "Reserve Read for a single specific line
 * range", and explore output must never tell the agent to Read.
 *
 * Fork adaptation: upstream measures completeness per emitted span against
 * the symbols each section set out to deliver (elidedWantedSpans /
 * exploreCompletenessNotes / fitExploreEpilogue / CG-26 note fitting) — none
 * of that machinery exists here. The fork tracks completeness per render
 * path (whole-file = complete; focused/skeleton per-symbol view = partial;
 * cluster path = partial when clusters were dropped or core-shrunk), names
 * the partial files in the note, and drops the "Reserve Read" tail. The
 * hard-ceiling truncation message no longer claims completeness either.
 */
import { describe, it, expect, beforeAll, afterAll } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { ToolHandler } from '../../src/graph/mcp/tools';

let testDir: string;
let cg: CodeGraph;
let handler: ToolHandler;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-completeness-'));
  fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });

  // Cross the >=500-file tier boundary so includeCompletenessSignal is on.
  for (let i = 0; i < 500; i++) {
    fs.writeFileSync(
      path.join(testDir, 'src', `filler${i}.ts`),
      `export const filler${i} = ${i};\n`,
    );
  }

  // small.ts — one tiny symbol; renders whole-file, so genuinely complete.
  fs.writeFileSync(
    path.join(testDir, 'src', 'small.ts'),
    'export function mqProbeComplete(): number {\n  return 42;\n}\n',
  );

  // big.ts — two far-apart named functions, each alone far past the per-file
  // budget: the first cluster renders whole (top-cluster floor), the second
  // is dropped, so the section is verbatim but NOT the whole story.
  const L: string[] = [];
  L.push('export function zzuniqAlpha(): number {');
  for (let i = 0; i < 280; i++) L.push(`  const a${i} = "alpha-${i}";`);
  L.push('  return a0.length; // ALPHA_TAIL');
  L.push('}');
  for (let i = 0; i < 40; i++) L.push(`// gap ${i} — keeps the two clusters apart`);
  L.push('export function zzuniqBeta(): number {');
  for (let i = 0; i < 280; i++) L.push(`  const b${i} = "beta-${i}";`);
  L.push('  return b0.length; // BETA_TAIL');
  L.push('}');
  fs.writeFileSync(path.join(testDir, 'src', 'big.ts'), L.join('\n') + '\n');

  cg = CodeGraph.initSync(testDir);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 300_000);

afterAll(() => {
  if (cg) cg.destroy();
  if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

describe('codegraph_explore — completeness note claims only what is complete', () => {
  it('claims complete source when every rendered section is the whole file', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'mqProbeComplete' });
    const text = res.content[0].text;
    expect(text).toContain('#### src/small.ts');
    expect(text).toContain('Complete source for');
    expect(text).not.toContain('NOT complete for size');
    expect(text).not.toContain('Reserve Read');
  });

  it('a section with dropped clusters is verbatim but NOT complete — and says which file', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'zzuniqAlpha zzuniqBeta' });
    const text = res.content[0].text;
    expect(text).toContain('#### src/big.ts');
    // The second named function's cluster did not fit the per-file budget.
    expect(text).toContain('ALPHA_TAIL');
    expect(text).not.toContain('BETA_TAIL');
    // The note must not vouch "complete" for the cut section.
    expect(text).not.toContain('Complete source for');
    expect(text).toContain('NOT complete for size: `src/big.ts`');
    expect(text).toContain('treat it as already Read');
    // Explore output must never offer Read as the way forward.
    expect(text).not.toContain('Reserve Read');
  });
});
