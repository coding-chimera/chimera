/**
 * Extraction ordered-commit backpressure now also bounds total SOURCE BYTES.
 *
 * The pre-existing window bounded the number of dispatched-but-uncommitted
 * files only; 64 files x the 1 MiB per-file cap could still retain 64 MiB of
 * live source text. `SourceByteBudget` adds a soft byte ceiling that pauses
 * dispatch while the buffer is non-empty and at/over budget, while preserving
 * the original file-order commit and one-transaction-per-batch semantics.
 *
 * These tests pin: (1) the budget primitive, (2) that a tiny budget produces
 * the exact same graph as the default budget (no result change), and (3) that
 * a single file larger than the whole budget cannot deadlock the run.
 */

import { afterEach, beforeEach, describe, expect, it } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { SourceByteBudget } from '../../src/graph/extraction';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-extraction-budget-'));
}

/** One file per entry; `size` is the comment padding that inflates the source. */
function writeFixture(dir: string, sizes: number[]): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  sizes.forEach((size, index) => {
    const padding = 'x'.repeat(Math.max(0, size));
    fs.writeFileSync(
      path.join(dir, 'src', `file${index}.ts`),
      `// ${padding}\nexport function budgetFn${index}(): number { return ${index}; }\n`
    );
  });
}

function signature(cg: CodeGraph) {
  return {
    stats: cg.getStats().nodeCount,
    files: cg.getFiles().map((file) => file.path).sort(),
    functions: cg.getNodesByKind('function').map((node) => node.name).sort(),
  };
}

describe('SourceByteBudget', () => {
  it('is only pressured while non-empty and at/over the limit', () => {
    const budget = new SourceByteBudget(10);
    expect(budget.pressured()).toBe(false);
    budget.add(4);
    expect(budget.pressured()).toBe(false);
    budget.add(6);
    expect(budget.pressured()).toBe(true);
    budget.release(6);
    expect(budget.bytes).toBe(4);
    expect(budget.pressured()).toBe(false);
  });

  it('never goes negative and ignores negative weights', () => {
    const budget = new SourceByteBudget(10);
    budget.add(5);
    budget.release(100);
    expect(budget.bytes).toBe(0);
    budget.add(-5);
    expect(budget.bytes).toBe(0);
    expect(budget.pressured()).toBe(false);
  });

  it('reports its configured limit', () => {
    expect(new SourceByteBudget(123).max).toBe(123);
  });
});

describe('indexAll source-byte budget', () => {
  let dirs: string[] = [];
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    if (saved === undefined) delete process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES;
    else process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES = saved;
  });

  it('produces the same graph under a tiny budget as under the default budget', async () => {
    const sizes = [300, 300, 300, 300];

    const tightDir = makeTempDir();
    dirs.push(tightDir);
    writeFixture(tightDir, sizes);
    process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES = '64';
    const tight = CodeGraph.initSync(tightDir);
    const tightResult = await tight.indexAll();
    const tightSignature = signature(tight);
    tight.close();

    const defaultDir = makeTempDir();
    dirs.push(defaultDir);
    writeFixture(defaultDir, sizes);
    delete process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES;
    const relaxed = CodeGraph.initSync(defaultDir);
    const relaxedResult = await relaxed.indexAll();
    const relaxedSignature = signature(relaxed);
    relaxed.close();

    expect(tightResult.success).toBe(true);
    expect(tightResult.filesIndexed).toBe(sizes.length);
    expect(relaxedResult.success).toBe(true);
    expect(tightSignature).toEqual(relaxedSignature);
    expect(tightSignature.functions).toHaveLength(sizes.length);
  });

  it('does not deadlock when a single file exceeds the whole budget', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    writeFixture(dir, [2_000, 2_000]);
    process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES = '1';

    const cg = CodeGraph.initSync(dir);
    const result = await cg.indexAll();
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);
    expect(cg.getNodesByKind('function')).toHaveLength(2);
    cg.close();
  });

  it('commits every file when the budget is far below the per-file size', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    writeFixture(dir, [500, 500, 500, 500, 500]);
    process.env.CODEGRAPH_EXTRACTION_SOURCE_BYTES = '10';

    const cg = CodeGraph.initSync(dir);
    const result = await cg.indexAll();
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(5);
    expect(cg.getFiles()).toHaveLength(5);
    expect(cg.getNodesByKind('function').map((node) => node.name).sort()).toEqual(
      Array.from({ length: 5 }, (_, index) => `budgetFn${index}`)
    );
    cg.close();
  });
});