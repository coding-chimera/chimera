/**
 * fileHasExportedNode — the #2072/#2086 sealed-module EXISTS probe (fork port
 * of the upstream fef3776 tail the B batch deferred).
 *
 * isSealedModule's cheapest disqualifier asks "does this file export ANY
 * node?" — nearly every module does, and the answer must not cost a file read
 * or a full node decode. Upstream added it as one indexed SQL probe
 * (`SELECT 1 ... WHERE file_path = ? AND is_exported = 1 LIMIT 1`) on
 * QueryBuilder, exposed through the optional ResolutionContext member and
 * wired in the resolver's createContext with a nodeCache short-circuit.
 *
 * TS-only by design (dual-arm adjudication): upstream fef3776 touches no
 * codegraph-kernel file, and the fork's R3c Rust is_sealed_module keeps its
 * equivalent nodes_in_file().any(is_exported) form — same boolean, so
 * resolution parity is untouched (scripts/resolution-parity.ts stays green).
 */

import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { QueryBuilder } from '../../src/graph/db/queries';
import type { ResolutionContext } from '../../src/graph/resolution/types';
import { createResolver } from '../../src/graph/resolution';

describe('fileHasExportedNode EXISTS probe (#2072 sealed-module short-circuit)', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(async () => {
    for (const cg of open.splice(0)) await cg.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function queriesOf(cg: CodeGraph): QueryBuilder {
    return (cg as unknown as { queries: QueryBuilder }).queries;
  }

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sealed-probe-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // A module that exports something.
    fs.writeFileSync(
      path.join(dir, 'src', 'exporting.ts'),
      `export const helper = 1;\nconst privateThing = helper + 1;\nexport { privateThing };\n`
    );
    // A sealed module: imports, zero exports of any form.
    fs.writeFileSync(
      path.join(dir, 'src', 'sealed.ts'),
      `import { helper } from './exporting';\nconst local = helper + 1;\nconsole.log(local);\n`
    );
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('agrees with getNodesByFile(...).some(isExported) on every indexed file', async () => {
    const cg = await setup();
    const q = queriesOf(cg);

    expect(q.fileHasExportedNode('src/exporting.ts')).toBe(true);
    expect(q.fileHasExportedNode('src/sealed.ts')).toBe(false);
    // Unknown file: no rows, no crash.
    expect(q.fileHasExportedNode('src/does-not-exist.ts')).toBe(false);

    for (const filePath of q.getAllFilePaths()) {
      expect(q.fileHasExportedNode(filePath), filePath).toBe(
        q.getNodesByFile(filePath).some((n) => n.isExported)
      );
    }
  });

  it('is exposed on the resolver context and short-circuits isSealedModule source reads', async () => {
    const cg = await setup();
    const resolver = createResolver(dir, queriesOf(cg));
    const context = (resolver as unknown as { context: ResolutionContext }).context;
    expect(typeof context.fileHasExportedNode).toBe('function');

    // The probe answers without the resolver's file/node caches being warm.
    expect(context.fileHasExportedNode!('src/exporting.ts')).toBe(true);
    expect(context.fileHasExportedNode!('src/sealed.ts')).toBe(false);

    // End-to-end: the sealed file's module-local `local` is not a cross-file
    // candidate — the guard the probe feeds (upstream #1719 vitejs shape).
    const sealedNode = queriesOf(cg)
      .getNodesByFile('src/sealed.ts')
      .find((n) => n.name === 'local');
    expect(sealedNode, 'sealed.ts has a module-local const node').toBeTruthy();
  });
});
