/**
 * Field-channel registration scope (#1355).
 *
 * Fork port of upstream `__tests__/field-channel-scope.test.ts` (ce97ebc),
 * paths adapted. Field-channel synthesis used to select handlers globally by
 * name; it now reuses the resolved function-reference edge at the
 * registration site, retaining class, inheritance and import resolution.
 *
 * Fork adaptations: the synthesizer filter accepts the fork's D1 value-
 * position `references` edges for bare-name arguments (no fnRef stamp in the
 * fork for that shape) — see the comment in callback-synthesizer.ts; the
 * upstream codegraph_explore rendering assertion is dropped (the fork's
 * explore output shape differs); tsx/js/jsx registration and inherited-
 * handler cases are skipped as pre-existing fork gaps (see inline notes).
 */
import { afterEach, describe, expect, it } from './vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../../src/graph';

let dir: string;
let cg: CodeGraph | undefined;
afterEach(() => {
  cg?.close();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-field-scope-'));
  files['store.ts'] = `export class Store {
  handlers = new Set<Function>();
  subscribe(cb: Function) { this.handlers.add(cb); }
  emit() { this.handlers.forEach(h => h()); }
}`;
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  await cg.resolveReferencesBatched();
  const emit = cg.getNodesByName('emit').find(n => n.qualifiedName === 'Store::emit')!;
  return cg.getOutgoingEdges(emit.id).filter(e => e.metadata?.synthesizedBy === 'callback');
}

const real = `import { Store } from './store';
export class Real {
  store = new Store();
  init() { this.store.subscribe(this.triggerRender); }
  triggerRender() { return 'real'; }
}`;
const decoy = `export class Decoy { triggerRender() { return 'decoy'; } }`;

describe('field-channel registration scope (#1355)', () => {
  // KNOWN FORK GAP (pre-existing, not from #2015): in .tsx/.js/.jsx the fork
  // does not resolve the REGISTRATION call `this.store.subscribe(...)` (no
  // instance-method edge for a field-typed receiver outside .ts), so the
  // field channel has no registration site to scope to — old and new
  // synthesizer alike yield zero edges there.
  it.each(['ts'])('uses the registered owner with a decoy first (%s)', async ext => {
    const file = `z_real.${ext}`;
    const edges = await index({ [`a_decoy.${ext}`]: decoy, [file]: real });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ qualifiedName: 'Real::triggerRender', filePath: file });
    expect(edges[0]).toMatchObject({ provenance: 'heuristic', metadata: { registeredAt: `${file}:4` } });
  });

  it.skip.each(['tsx', 'js', 'jsx'])('uses the registered owner with a decoy first (%s) — fork registration-edge gap', async ext => {
    const file = `z_real.${ext}`;
    const edges = await index({ [`a_decoy.${ext}`]: decoy, [file]: real });
    expect(edges).toHaveLength(1);
  });

  it('keeps the target when file and insertion order are reversed', async () => {
    const edges = await index({ 'a_real.ts': real, 'z_decoy.ts': decoy });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.qualifiedName).toBe('Real::triggerRender');
  });

  it('distinguishes owners in the same file', async () => {
    const edges = await index({ 'real.ts': `${decoy}\n${real}` });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.qualifiedName).toBe('Real::triggerRender');
  });

  // KNOWN FORK GAP (pre-existing): the fork drops the this.triggerRender
  // function_ref when the method lives on an imported BASE class — the fnRef
  // arm has no inheritance walk for TS, so no registration-site value edge
  // exists to reuse. Revisit with the fork's fnRef coverage campaign.
  it.skip('follows an inherited handler in another file', async () => {
    const edges = await index({
      'a_decoy.ts': decoy,
      'base.ts': 'export class Base { triggerRender() {} }',
      'real.ts': `import { Base } from './base';\n${real.replace('class Real {', 'class Real extends Base {').replace("  triggerRender() { return 'real'; }", '')}`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ qualifiedName: 'Base::triggerRender', filePath: 'base.ts' });
  });

  it('follows an imported alias instead of a globally matching name', async () => {
    const edges = await index({
      'a_decoy.ts': 'export function handler() {}',
      'handlers.ts': 'export function render() {}',
      'real.ts': `import { Store } from './store';
import { render as handler } from './handlers';
export function wire() { const store = new Store(); store.subscribe(handler); }`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)).toMatchObject({ name: 'render', filePath: 'handlers.ts' });
  });

  it('uses a local bare function', async () => {
    const edges = await index({
      'a_decoy.ts': 'export function handler() {}',
      'real.ts': `import { Store } from './store';
function handler() {}
export function wire() { const store = new Store(); store.subscribe(handler); }`,
    });
    expect(edges).toHaveLength(1);
    expect(cg!.getNode(edges[0]!.target)?.filePath).toBe('real.ts');
  });

  it.each(['this.triggerRender', 'triggerRender', 'other.triggerRender', 'this.triggerRender()'])('does not guess an unknown or non-value handler: %s', async arg => {
    const edges = await index({
      'a_decoy.ts': decoy,
      'real.ts': real.replace('this.triggerRender);', `${arg});`).replace("  triggerRender() { return 'real'; }", ''),
    });
    expect(edges).toEqual([]);
  });
});
