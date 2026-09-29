/**
 * Method values keep their receivers (#1820, upstream #2034).
 *
 * Fork port of the upstream `__tests__/function-ref.test.ts` #1820 block
 * (5eaa6fe). `pool.submit(obj.method)` / `Submit(c.store.Fetch)` used to
 * produce no caller edge because only call expressions were captured.
 * Member values are now emitted as `*.method` function-refs (extraction:
 * function-ref.ts wasm arm + go.rs/python.rs kernel arm) and resolve
 * unique-or-drop through receiver/type/import scope (matchMemberFunctionRef
 * in name-matcher.ts, mirrored natively in resolver.rs).
 *
 * Fork adaptations:
 * - The upstream explore-tool rendering assertions (ToolHandler /
 *   `codegraph_explore`) are dropped — the fork's agent surface is
 *   `chimera graph` / `chimera_*` tools, not the upstream MCP tool names.
 * - Caller/source lists exclude the fork's D2 `stmt@` statement nodes.
 * - Go expectations follow the fork's K-v2 P5-1/D9 ruling: #1276 Go 2-hop
 *   field chains (`c.store.Fetch`) and #1108 local receiver-type inference
 *   (`s.Fetch` after `s *Store` param / `s := …`) are NOT ported — those
 *   shapes decline exclusively (unresolved, never a guessed edge). A
 *   receiver that IS a type name (`Store.Fetch`) keeps the unique
 *   struct/interface lookup, so method expressions still resolve.
 */

import { describe, it, expect, beforeAll, afterEach } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import type { Edge } from '../../src/graph/types';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Incoming edges to `name`'s node that came from function-as-value capture. */
function fnRefEdgesInto(cg: CodeGraph, name: string): Edge[] {
  const targets = cg.getNodesByName(name);
  const edges: Edge[] = [];
  for (const t of targets) {
    for (const e of cg.getIncomingEdges(t.id)) {
      if (e.kind === 'references' && e.metadata?.fnRef === true) {
        edges.push(e);
      }
    }
  }
  return edges;
}

/** Names of the source nodes of the given edges, sorted (stmt@ excluded). */
function sourceNames(cg: CodeGraph, edges: Edge[]): string[] {
  const names: string[] = [];
  for (const e of edges) {
    const n = cg.getNode(e.source);
    if (n && !n.name.startsWith('stmt@')) names.push(n.name);
  }
  return names.sort();
}

function callerNames(cg: CodeGraph, id: string): string[] {
  return cg.getCallers(id)
    .map((c) => c.node.name)
    .filter((n) => !n.startsWith('stmt@'))
    .sort();
}

describe('Method values keep their receivers (#1820)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('#1820 PYTHON: obj.method passed as a callback is a caller; a unique method resolves', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      [
        'class Base:',
        '    pass',
        '',
        'class Store(Base):',
        '    def fetch(self, ids):',
        '        return ids',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'from concurrent.futures import ThreadPoolExecutor',
        'from store import Base',
        '',
        'class Consumer:',
        '    def __init__(self, store: Base):',
        '        self.store = store',
        '',
        '    def direct(self, ids):',
        '        return self.store.fetch(ids)',
        '',
        '    def via_callback(self, ids, pool: ThreadPoolExecutor):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      const fetch = cg.getNodesByName('fetch').find((n) => n.kind === 'method')!;
      const callers = callerNames(cg, fetch.id);
      expect(callers).toContain('via_callback');
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'fetch'))).toEqual(['via_callback']);
      expect([...cg.getImpactRadius(fetch.id).nodes.values()].map((n) => n.name)).toContain('via_callback');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820 PYTHON: a test-file method still makes an unknown receiver ambiguous', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-mock-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      'class Store:\n    def fetch(self, ids):\n        return ids\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'tests'));
    fs.writeFileSync(
      path.join(tmpDir, 'tests', 'test_store.py'),
      'class FakeStore:\n    def fetch(self, ids):\n        return ids\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      // `self.store` has no annotation and an unknown-typed constructor param:
      // two same-named methods remain, so unique-or-drop yields no edge.
      expect(fnRefEdgesInto(cg, 'fetch')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820 PYTHON: a NotImplementedError base still makes an unknown receiver ambiguous', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-base-'));
    fs.writeFileSync(
      path.join(tmpDir, 'base.py'),
      [
        'class Base:',
        '    def fetch(self, ids):',
        '        raise NotImplementedError("subclass")',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      [
        'from base import Base',
        'class Store(Base):',
        '    def fetch(self, ids):',
        '        return ids',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      expect(fnRefEdgesInto(cg, 'fetch')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820 PYTHON: two methods of the same name produce no callback edge', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-decoy-'));
    fs.writeFileSync(path.join(tmpDir, 'a.py'), 'class A:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(path.join(tmpDir, 'b.py'), 'class B:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      expect(fnRefEdgesInto(cg, 'fetch')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820 GO: method value Submit(c.store.Fetch) declines in the fork (D9); type-name receivers resolve', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-go-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.go'),
      [
        'package demo',
        '',
        'type Store struct{}',
        '',
        'func (s *Store) Fetch(ids []string) []string { return ids }',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.go'),
      [
        'package demo',
        '',
        'func Submit(fn func([]string) []string, ids []string) []string { return fn(ids) }',
        '',
        'type Consumer struct{ store *Store }',
        '',
        'func (c *Consumer) ViaSubmit(ids []string) []string { return Submit(c.store.Fetch, ids) }',
        '',
        'func MethodExpression(ids []string) []string { return Submit(Store.Fetch, ids) }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      // Fork D9: the dotted field-chain receiver `c.store.Fetch` declines
      // exclusively (upstream resolves it through #1276 field chains). The
      // type-name receiver `Store.Fetch` resolves through the unique
      // struct/interface lookup.
      const sources = sourceNames(cg, fnRefEdgesInto(cg, 'Fetch'));
      expect(sources).not.toContain('ViaSubmit');
      expect(sources).toContain('MethodExpression');
      const fetch = cg.getNodesByName('Fetch').find((n) => n.kind === 'method')!;
      const edge = fnRefEdgesInto(cg, 'Fetch').find((e) => !cg.getNode(e.source)?.name.startsWith('stmt@'));
      expect(cg.getNode(edge!.target)?.id).toBe(fetch.id);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820: receiver identity beats same-file and imported-name decoys', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-receivers-'));
    fs.writeFileSync(path.join(tmpDir, 'store.py'), `class Store:
    def fetch(self, ids):
        return ids
`);
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `from store import Store as Actual
class Store:
    def fetch(self, ids):
        return ids
class Consumer:
    def __init__(self, store: Actual):
        self.store = store
    def callback(self, pool, ids):
        return pool.submit(self.store.fetch, ids)
    def assigned(self):
        cb = self.store.fetch
    def collected(self):
        return [self.store.fetch]
def typed(obj: Actual, pool):
    pool.submit(obj.fetch)
def static(pool):
    pool.submit(Actual.fetch)
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(sourceNames(cg, edges)).toEqual(['assigned', 'callback', 'collected', 'static', 'typed']);
      expect(edges.every((e) => cg.getNode(e.target)?.filePath === 'store.py')).toBe(true);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820: same-file ambiguity and noncallable receivers stay unlinked', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-ambiguity-'));
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `class A:
    def fetch(self):
        return 1
class B:
    def fetch(self):
        return 2
class Data:
    fetch = 42
class Property:
    @property
    def fetch(self):
        return 42
def unknown(obj, pool):
    pool.submit(obj.fetch)
def data(obj: Data, pool):
    pool.submit(obj.fetch)
def prop(obj: Property, pool):
    pool.submit(obj.fetch)
def bare(fetch, pool):
    pool.submit(fetch)
class Own:
    def fetch(self):
        return 3
    def bound(self, pool):
        pool.submit(self.fetch)
    @classmethod
    def class_bound(cls, pool):
        pool.submit(cls.fetch)
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(sourceNames(cg, edges)).toEqual(['bound', 'class_bound']);
      expect(edges.every((e) => cg.getNode(e.target)?.qualifiedName === 'Own::fetch')).toBe(true);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820: typed, constructed and inherited Python receivers exclude noncallable values', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-known-'));
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `class Store:
    def fetch(self):
        return 1
class Child(Store):
    def inherited(self, pool):
        pool.submit(self.fetch)
class Data:
    def __init__(self):
        self.fetch = 42
class Override(Store):
    def __init__(self):
        self.fetch = 42
class Consumer:
    def __init__(self):
        self.store = Store()
    def keyword(self, pool):
        pool.submit(callback=self.store.fetch)
def constructor(pool):
    obj = Store()
    pool.submit(obj.fetch)
def partial_ref(obj: Store):
    return partial(obj.fetch, 1)
def mapped(obj: Store, xs):
    return map(obj.fetch, xs)
def data(obj: Data, pool):
    pool.submit(obj.fetch)
def override(obj: Override, pool):
    pool.submit(obj.fetch)
def primitive(obj: int, pool):
    pool.submit(obj.fetch)
def literal(pool):
    obj = 42
    pool.submit(obj.fetch)
def reassigned(obj: Store, pool):
    obj = 42
    pool.submit(obj.fetch)
def direct(obj: Store):
    obj.fetch()
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'fetch'))).toEqual([
        'constructor', 'inherited', 'keyword', 'mapped', 'partial_ref',
      ]);
      const fetch = cg.getNodesByName('fetch').find((n) => n.kind === 'method')!;
      expect(sourceNames(cg, cg.getIncomingEdges(fetch.id).filter((e) => e.kind === 'calls'))).toContain('direct');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820: Go receiver types disambiguate method values and reject external fields', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-go-scope-'));
    fs.writeFileSync(path.join(tmpDir, 'main.go'), `package demo
import "database/sql"
type Store struct{}
func (s *Store) Fetch() {}
type Decoy struct{}
func (d *Decoy) Fetch() {}
type Consumer struct { store *Store; external *sql.DB }
func (c *Consumer) Callback() { Submit(c.store.Fetch) }
func Typed(s *Store) { Submit(s.Fetch) }
func Assigned(s *Store) { cb := s.Fetch }
func Collected(s *Store) { table := []func(){s.Fetch} }
func MethodExpression() { Submit(Store.Fetch) }
func (c *Consumer) External() { Submit(c.external.Fetch) }
func Unknown(obj interface{}) { Submit(obj.Fetch) }
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      cg.resolveReferences();
      // Fork D9 adaptation: upstream resolves Typed/Assigned/Collected through
      // #1108 local receiver-type inference and Callback through #1276 field
      // chains — neither is ported, so those shapes decline exclusively.
      // MethodExpression (a receiver that IS a type name) resolves through the
      // unique struct lookup; External/Unknown stay unlinked as upstream.
      const sources = sourceNames(cg, fnRefEdgesInto(cg, 'Fetch'));
      expect(sources).toContain('MethodExpression');
      expect(sources).not.toContain('Callback');
      expect(sources).not.toContain('External');
      expect(sources).not.toContain('Unknown');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });
});
