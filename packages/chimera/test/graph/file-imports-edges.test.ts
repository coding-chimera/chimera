/**
 * File-level imports edge materialization tests
 *
 * The resolution pipeline persists each file's import dependencies as
 * file→file kind='imports' edges (source file node → target file node),
 * distinct from the extraction-emitted file→import-statement syntax edges.
 * These edge facts feed FILE_PROJECTION walks (getFileDependents etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { Edge } from '../../src/graph/types';

describe('File-level imports edge materialization', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-file-imports-test-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  const write = (relPath: string, content: string): void => {
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };

  const fileNode = (filePath: string) =>
    cg.getNodesByKind('file').find((n) => n.filePath === filePath);

  const fileLevelImportEdges = (filePath: string) => {
    const file = fileNode(filePath)!;
    return cg
      .getOutgoingEdges(file.id, ['imports'])
      .filter((edge: Edge) => cg.getNode(edge.target)?.kind === 'file');
  };

  it('materializes an A→B file-level imports edge visible to FILE_PROJECTION', async () => {
    write('src/utils.ts', 'export function fmt(): number { return 1 }\n');
    write(
      'src/main.ts',
      'import { fmt } from "./utils";\nexport function run(): number { return fmt(); }\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const edges = fileLevelImportEdges('src/main.ts');
    expect(edges).toHaveLength(1);
    const target = cg.getNode(edges[0]!.target);
    expect(target?.filePath).toBe('src/utils.ts');
    expect(target?.kind).toBe('file');
    // Synthesized edge shape: resolvedBy set, deliberately no refName.
    expect(edges[0]!.metadata?.resolvedBy).toBe('import');
    expect(edges[0]!.metadata?.refName).toBeUndefined();

    // FILE_PROJECTION dependents must see the import-only dependency.
    expect(cg.getFileDependents('src/utils.ts')).toContain('src/main.ts');
  });

  it('skips external package specifiers', async () => {
    write(
      'src/app.ts',
      'import React from "react";\nexport const app: string = React.version;\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    expect(fileLevelImportEdges('src/app.ts')).toHaveLength(0);
  });

  it('dedupes multiple imports of the same target into one edge', async () => {
    write('src/utils.ts', 'export const a = 1;\nexport const b = 2;\n');
    write(
      'src/main.ts',
      'import { a } from "./utils";\nimport { b } from "./utils";\nexport function run(): number { return a + b; }\n'
    );

    cg = await CodeGraph.init(tempDir, { index: true });

    const edges = fileLevelImportEdges('src/main.ts');
    expect(edges).toHaveLength(1);
    expect(cg.getNode(edges[0]!.target)?.filePath).toBe('src/utils.ts');
  });

  it('drops a stale file-level edge after the import is removed (incremental)', async () => {
    write('src/utils.ts', 'export function fmt(): number { return 1 }\n');
    write('src/other.ts', 'export function other(): number { return 2 }\n');
    write(
      'src/main.ts',
      'import { fmt } from "./utils";\nimport { other } from "./other";\nexport function run(): number { return fmt() + other(); }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const before = fileLevelImportEdges('src/main.ts').map((e) => cg.getNode(e.target)?.filePath);
    expect(before).toContain('src/utils.ts');
    expect(before).toContain('src/other.ts');

    // Keep the ./other import, drop the ./utils import, re-run the sync entry.
    write(
      'src/main.ts',
      'import { other } from "./other";\nexport function run(): number { return other(); }\n'
    );
    await cg.syncFiles(['src/main.ts']);

    const after = fileLevelImportEdges('src/main.ts').map((e) => cg.getNode(e.target)?.filePath);
    expect(after).not.toContain('src/utils.ts');
    expect(after).toContain('src/other.ts');

    // The file→import-statement syntax edges (target kind='import') survive —
    // the file-level cleanup must not touch them.
    const mainFile = fileNode('src/main.ts')!;
    const syntaxEdges = cg
      .getOutgoingEdges(mainFile.id, ['imports'])
      .filter((edge: Edge) => cg.getNode(edge.target)?.kind === 'import');
    expect(syntaxEdges.length).toBeGreaterThanOrEqual(1);
  });
});