/**
 * react-router: route declaration boundaries (#1348).
 *
 * Fork port of the boundary describe added by upstream 9a96b52 to
 * `__tests__/react-router.test.ts` (the fork has no vendored copy of that
 * file). The fixed forward windows borrowed paths and components from
 * neighboring or nested routes; scanRouteDeclarations now reads only each
 * opening tag's / object literal's own attributes.
 *
 * Adaptations:
 * - The fork's reactResolver declares `languages: ['javascript','typescript']`
 *   (upstream added tsx/jsx in an earlier, unported nextjs-split commit), so
 *   the full-pipeline integration cases run on .ts/.js only. JSX-bearing
 *   sources and the tsx/jsx extensions are covered at the extract() level —
 *   the structural scanner under test is content-only and extension-parameterised.
 * - Extract-level bindings compare route name -> referenceName (resolution of
 *   the reference to a node is the pipeline's job, not the scanner's).
 */

import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { reactResolver } from '../../src/graph/resolution/frameworks/react';

const JSX_SOURCE = `
      import { Routes, Route } from 'react-router-dom';
      function DashboardHome() { return null; }
      function Settings() { return null; }
      function Shell() { return null; }
      const comparison = count<limit;
      const fake = '<Route path="/fake" element={<DashboardHome/}>';
      export function App() {
        return <Routes>
          <Route path="/dashboard">
            <Route index element={<DashboardHome/>}/>
            <Route path="settings" element={<Settings/>}/>
          </Route>
          <Route path="/empty"></Route>
          <Route element={<Settings/>} path="/sibling"/>
          <Route element={<Shell title="a > b"><Settings path="/nested"/></Shell>}
            check={/}/.test('}')}
            handle={{ text: 'path="/borrowed"', nested: { element: <DashboardHome/> } }}
            title="${'x'.repeat(600)}" path="/long"/>
          <Route path="/no-element" handle={{ element: <DashboardHome/> }}/>
          <Route component={Settings} path="/legacy"/>
        </Routes>;
      }
`;

const JSX_EXPECTED = {
  paths: ['/dashboard', '/empty', '/legacy', '/long', '/no-element', '/sibling', 'settings'],
  bindings: ['/legacy->Settings', '/long->Shell', '/sibling->Settings', 'settings->Settings'],
};

const DATA_SOURCE = `
      import { createBrowserRouter } from 'react-router-dom';
      function DataIndex() { return null; }
      function DataSettings() { return null; }
      const routes = createBrowserRouter([
        { path: '/data', children: [
          { index: true, Component: DataIndex },
          { Component: DataSettings, path: 'prefs' }
        ] },
        { path: '/empty' },
        { Component: DataSettings, path: '/sibling' },
        { path: '/metadata', handle: { Component: DataIndex } },
        { Component: DataSettings, handle: { path: '/not-own' } },
        { path: '/long', handle: { text: '${'x'.repeat(600)}' }, Component: DataSettings },
        { 'Component': DataSettings, /* path: '/fake' */ 'path': '/quoted' /* trailing comment */ },
        { path: '', Component: DataSettings }
      ]);
`;

const DATA_EXPECTED = {
  paths: ['/', '/long', '/quoted', '/sibling', 'prefs'],
  bindings: ['/->DataSettings', '/long->DataSettings', '/quoted->DataSettings', '/sibling->DataSettings', 'prefs->DataSettings'],
};

const NESTED_SOURCE = `
      import { createMemoryRouter } from 'react-router-dom';
      function Shell() { return null; }
      function Child() { return null; }
      const router = createMemoryRouter([
        { element: <Shell title="a > b"><Child path="/fake"/>hello, world</Shell>,
          handle: { text: "}, path: '/fake'", callback: () => ({ path: '/also-fake' }) }, path: '/shell' },
        { path: '/none', handle: { element: <Child/> } },
        { path: '/child', element: <Child/> }
      ]);
`;

/** Scanner-level view: routes and their component references, straight from extract(). */
function scanned(source: string, extension: string) {
  const { nodes, references } = reactResolver.extract!(`App.${extension}`, source);
  const routes = nodes.filter((n) => n.kind === 'route');
  return {
    paths: routes.map((r) => r.name).sort(),
    bindings: references
      .filter((r) => r.referenceKind === 'references')
      .map((r) => `${routes.find((n) => n.id === r.fromNodeId)?.name}->${r.referenceName}`)
      .sort(),
  };
}

describe('react-router: route declaration boundaries (#1348)', () => {
  let tmpDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function index(source: string, extension: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-boundaries-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
    fs.writeFileSync(path.join(tmpDir, `App.${extension}`), source);
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    cg.resolveReferences();
    const routes = cg.getNodesByKind('route');
    return {
      paths: routes.map((route) => route.name).sort(),
      bindings: routes.flatMap((route) => cg!.getOutgoingEdges(route.id)
        .filter((edge) => edge.kind === 'references')
        .map((edge) => `${route.name}->${cg!.getNode(edge.target)?.name}`)).sort(),
    };
  }

  it.each(['tsx', 'jsx', 'js'])('keeps nested/index JSX routes and long attributes local in %s (scanner)', (extension) => {
    expect(scanned(JSX_SOURCE, extension)).toEqual(JSX_EXPECTED);
  });

  it('keeps nested/index JSX routes and long attributes local through the pipeline (js)', async () => {
    // Full indexAll on .js: the fork's reactResolver languages cover js/ts;
    // the JSX in the source only feeds the content-level framework extract
    // (tree-sitter function nodes for the bindings come from the same file).
    const result = await index(JSX_SOURCE, 'js');
    expect(result.paths).toEqual(JSX_EXPECTED.paths);
    // Binding targets need parsed function nodes; a .js file with JSX may not
    // yield them on the wasm arm, so only assert no FOREIGN bindings appear.
    for (const binding of result.bindings) {
      expect(JSX_EXPECTED.bindings).toContain(binding);
    }
  });

  it.each(['tsx', 'jsx', 'ts', 'js'])('pairs only direct data-router properties in either order in %s (scanner)', (extension) => {
    expect(scanned(DATA_SOURCE, extension)).toEqual(DATA_EXPECTED);
  });

  it.each(['ts', 'js'])('pairs only direct data-router properties through the pipeline in %s', async (extension) => {
    expect(await index(DATA_SOURCE, extension)).toEqual(DATA_EXPECTED);
  });

  it('keeps nested JSX and comma-containing expressions inside their data-router property', () => {
    expect(scanned(NESTED_SOURCE, 'tsx')).toEqual({
      paths: ['/child', '/shell'],
      bindings: ['/child->Child', '/shell->Shell'],
    });
  });
});
