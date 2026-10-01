/**
 * getCallers must cross the instantiation boundary — fork alignment with the
 * upstream v1.6.1 final state of GraphTraverser.getCallersRecursive (#774,
 * callers side): the incoming-edge kind set is calls/references/imports/
 * instantiates/navigates, symmetric with getCallees (ca4af1af4 aligned the
 * callees side). Constructing a class (`new Foo()`) is calling its
 * constructor, so the instantiation site is a caller of the class; with the
 * fork's old three-kind list, `callers <Class>` surfaced only the importing
 * file (via `imports`) and missed every construction site.
 */

import { describe, it, expect, beforeEach, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';

describe('getCallers instantiates edge (upstream #774 callers-side symmetry)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-callers-instantiates-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'widget.ts'),
      `export class Widget {
  spin(): number {
    return 1;
  }
}
`
    );
    fs.writeFileSync(
      path.join(srcDir, 'factory.ts'),
      `import { Widget } from './widget';

export function makeWidget(): Widget {
  return new Widget();
}
`
    );

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    cg.resolveReferences();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns the constructing function as a caller over its instantiates edge', () => {
    const makeWidget = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'makeWidget' && n.filePath.endsWith('factory.ts'));
    expect(makeWidget, 'makeWidget function node').toBeTruthy();

    const widget = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'Widget' && n.filePath.endsWith('widget.ts'));
    expect(widget, 'Widget class node').toBeTruthy();

    // The construction resolved to an `instantiates` edge (resolution's
    // calls→class promotion) — the regression: the old callers kind list
    // (calls/references/imports) never walked it, so the construction site
    // was missing from `callers <Class>`.
    const incoming = cg.getIncomingEdges(widget!.id);
    expect(
      incoming.some((e) => e.kind === 'instantiates' && e.source === makeWidget!.id),
      'instantiates edge makeWidget → Widget exists in the store'
    ).toBe(true);

    const callers = cg.getCallers(widget!.id);
    expect(
      callers.some((c) => c.node.id === makeWidget!.id && c.edge.kind === 'instantiates'),
      'getCallers crosses the instantiates edge'
    ).toBe(true);
  });

  it('stays the inverse of getCallees across the instantiation boundary', () => {
    const makeWidget = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'makeWidget' && n.filePath.endsWith('factory.ts'))!;
    const widget = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'Widget' && n.filePath.endsWith('widget.ts'))!;

    // Symmetry: Widget ∈ callees(makeWidget) iff makeWidget ∈ callers(Widget).
    const inCallees = cg.getCallees(makeWidget.id).some((c) => c.node.id === widget.id);
    const inCallers = cg.getCallers(widget.id).some((c) => c.node.id === makeWidget.id);
    expect(inCallees, 'Widget is a callee of makeWidget').toBe(true);
    expect(inCallers, 'makeWidget is a caller of Widget').toBe(inCallees);
  });
});
