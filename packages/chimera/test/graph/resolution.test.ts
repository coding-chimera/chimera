/**
 * Resolution Module Tests
 *
 * Tests for Phase 3: Reference Resolution
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../../src/graph';
import { Node, UnresolvedReference } from '../../src/graph/types';
import { ReferenceResolver, createResolver, ResolutionContext } from '../../src/graph/resolution';
import { matchReference, matchMethodCall, matchByExactName, matchFuzzy } from '../../src/graph/resolution/name-matcher';
import { resolveImportPath, extractImportMappings, resolveJvmImport, loadCppIncludeDirs, clearCppIncludeDirCache } from '../../src/graph/resolution/import-resolver';
import type { UnresolvedRef, ImportMapping, FrameworkResolver } from '../../src/graph/resolution/types';
import { detectFrameworks, getAllFrameworkResolvers } from '../../src/graph/resolution/frameworks';
import { QueryBuilder } from '../../src/graph/db/queries';
import { DatabaseConnection, getDatabasePath } from '../../src/graph/db';

const baseContext: ResolutionContext = {
  getNodesInFile: () => [],
  getNodesByName: () => [],
  getNodesByQualifiedName: () => [],
  getNodesByKind: () => [],
  fileExists: () => false,
  readFile: () => null,
  getProjectRoot: () => '',
  getAllFiles: () => [],
  getNodesByLowerName: () => [],
  getImportMappings: () => [],
};

describe('Resolution Module', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-test-'));
  });

  afterEach(() => {
    // Clean up
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Name Matcher', () => {
    it('should match exact name references', () => {
      // Create a mock context
      const mockNodes: Node[] = [
        {
          id: 'func:test.ts:myFunction:10',
          kind: 'function',
          name: 'myFunction',
          qualifiedName: 'test.ts::myFunction',
          filePath: 'test.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => mockNodes,
        getNodesByName: (name) => mockNodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['test.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'myFunction',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:test.ts:myFunction:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    // Import-aware veto: a bare name the caller file does not import is a local
    // binding (e.g. function-scoped closure const), not a cross-file call. Bench
    // evidence: layout.tsx's local `const openSession` bound to an unrelated
    // fixture's openSession, faking five cross-package edges.
    const makeVetoNode = (filePath: string, name: string): Node => ({
      id: `func:${filePath}:${name}:1`,
      kind: 'function',
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    const vetoRef = (filePath: string, referenceName: string): UnresolvedRef => ({
      fromNodeId: `caller:${filePath}:fn:5`,
      referenceName,
      referenceKind: 'calls' as const,
      line: 5,
      column: 10,
      filePath,
      language: 'typescript' as const,
    });

    it('vetoes cross-file exact matches when the caller file does not import the name', () => {
      const foreign = makeVetoNode('transport/wire-session.ts', 'openSession');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'openSession' ? [foreign] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      const ref = vetoRef('pages/layout.tsx', 'openSession');
      expect(matchByExactName(ref, context)).toBeNull();
      expect(matchReference(ref, context)).toBeNull();
    });

    it('vetoes cross-file fuzzy matches when the caller file does not import the name', () => {
      const foreign = makeVetoNode('transport/wire-session.ts', 'openSession');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByLowerName: (name) => (name === 'opensession' ? [foreign] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      expect(matchFuzzy(vetoRef('pages/layout.tsx', 'openSession'), context)).toBeNull();
    });

    it('allows cross-file exact matches when the name is imported', () => {
      const foreign = makeVetoNode('transport/wire-session.ts', 'openSession');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'openSession' ? [foreign] : []),
        getImportMappings: () => [
          { localName: 'openSession', exportedName: 'openSession', source: './wire-session', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchByExactName(vetoRef('transport/wire-legacy.ts', 'openSession'), context);
      expect(result?.targetNodeId).toBe('func:transport/wire-session.ts:openSession:1');
    });

    it('keeps permissive name matching for files without import mappings', () => {
      // C headers, scripts, and languages whose includes are not extracted as
      // imports have no mappings; vetoing there would tank legitimate recall.
      const foreign = makeVetoNode('lib/helper.ts', 'helperCall');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'helperCall' ? [foreign] : []),
        getImportMappings: () => [],
      };
      const result = matchByExactName(vetoRef('main.c', 'helperCall'), context);
      expect(result?.targetNodeId).toBe('func:lib/helper.ts:helperCall:1');
    });

    it('still matches same-file candidates when the name is not imported', () => {
      const local = makeVetoNode('pages/layout.tsx', 'openSession');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'openSession' ? [local] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchByExactName(vetoRef('pages/layout.tsx', 'openSession'), context);
      expect(result?.targetNodeId).toBe('func:pages/layout.tsx:openSession:1');
    });

    it('allows cross-file candidates in files reachable through an import (destructured store actions)', () => {
      // zustand pattern: caller.ts imports useStore from './store', destructures
      // `const { fetchUser } = useStore.getState()`, then calls fetchUser() bare.
      // The action lives in store.ts, which IS import-reachable from caller.ts.
      const action = makeVetoNode('store.ts', 'fetchUser');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'fetchUser' ? [action] : []),
        getImportMappings: () => [
          { localName: 'useStore', exportedName: 'useStore', source: './store', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchByExactName(vetoRef('caller.ts', 'fetchUser'), context);
      expect(result?.targetNodeId).toBe('func:store.ts:fetchUser:1');
    });

    it('stays permissive when the context does not provide import mappings', () => {
      // Smoke-test harnesses pass partial mock contexts without getImportMappings;
      // the veto must degrade to the previous permissive behavior, not crash.
      const foreign = makeVetoNode('other.ts', 'dup');
      const partial = { getNodesByName: (name: string) => (name === 'dup' ? [foreign] : []) } as unknown as ResolutionContext;
      const result = matchByExactName(vetoRef('main.ts', 'dup'), partial);
      expect(result?.targetNodeId).toBe('func:other.ts:dup:1');
    });

    // Method-call unique-candidate veto: same shape as the exact/fuzzy veto
    // above. A single repository-wide method candidate leaves no receiver-word
    // evidence, so a cross-file bind requires import evidence.
    const makeMethodNode = (filePath: string, name: string, qualifiedName?: string): Node => ({
      id: `method:${filePath}:${name}:1`,
      kind: 'method',
      name,
      qualifiedName: qualifiedName ?? `${filePath}::${name}`,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });

    const methodCallRef = (filePath: string, referenceName: string): UnresolvedRef => ({
      fromNodeId: `caller:${filePath}:fn:5`,
      referenceName,
      referenceKind: 'calls' as const,
      line: 5,
      column: 10,
      filePath,
      language: 'typescript' as const,
    });

    it('vetoes a unique cross-file method candidate the caller file does not import (arr.push)', () => {
      const push = makeMethodNode('collections/Queue.ts', 'push', 'Queue.push');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'push' ? [push] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      expect(matchMethodCall(methodCallRef('app.ts', 'arr.push'), context)).toBeNull();
    });

    it('vetoes a unique cross-file method candidate the caller file does not import (x.t)', () => {
      const t = makeMethodNode('utils/Transform.ts', 't', 'Transform.t');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 't' ? [t] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      expect(matchMethodCall(methodCallRef('app.ts', 'x.t'), context)).toBeNull();
    });

    it('binds a unique method when the receiver is imported (queue.push with import { queue })', () => {
      const push = makeMethodNode('queue.ts', 'push', 'Queue.push');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'push' ? [push] : []),
        getImportMappings: () => [
          { localName: 'queue', exportedName: 'queue', source: './queue', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchMethodCall(methodCallRef('app.ts', 'queue.push'), context);
      expect(result?.targetNodeId).toBe('method:queue.ts:push:1');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a unique method when the candidate file is reachable through an import (store.fetchUser)', () => {
      const fetchUser = makeMethodNode('store.ts', 'fetchUser', 'Store.fetchUser');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'fetchUser' ? [fetchUser] : []),
        getImportMappings: () => [
          { localName: 'useStore', exportedName: 'useStore', source: './store', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchMethodCall(methodCallRef('app.ts', 'store.fetchUser'), context);
      expect(result?.targetNodeId).toBe('method:store.ts:fetchUser:1');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a unique same-file method candidate (obj.method)', () => {
      const format = makeMethodNode('app.ts', 'format', 'Helper.format');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'format' ? [format] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchMethodCall(methodCallRef('app.ts', 'obj.format'), context);
      expect(result?.targetNodeId).toBe('method:app.ts:format:1');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('still binds unimported targets in the multi-candidate overlap branch (permissionEngine.checkRule)', () => {
      const ruleEngine = makeMethodNode('permission/PermissionRuleEngine.ts', 'checkRule', 'PermissionRuleEngine.checkRule');
      const legacyRule = makeMethodNode('legacy/RuleChecker.ts', 'checkRule', 'RuleChecker.checkRule');
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: (name) => (name === 'checkRule' ? [ruleEngine, legacyRule] : []),
        getImportMappings: () => [
          { localName: 'useState', exportedName: 'useState', source: 'react', isDefault: false, isNamespace: false },
        ],
      };
      const result = matchMethodCall(methodCallRef('app.ts', 'permissionEngine.checkRule'), context);
      expect(result?.targetNodeId).toBe('method:permission/PermissionRuleEngine.ts:checkRule:1');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Strategy 0.5 fixtures: `receiver = new ClassName` declaration evidence
    // read from statement/variable/constant node signatures.
    const declNode = (
      id: string,
      kind: Node['kind'],
      name: string,
      filePath: string,
      startLine: number,
      extra: Partial<Pick<Node, 'qualifiedName' | 'signature' | 'language' | 'returnType'>> = {},
    ): Node => ({
      id,
      kind,
      name,
      qualifiedName: extra.qualifiedName ?? name,
      filePath,
      language: extra.language ?? 'typescript',
      startLine,
      endLine: startLine + 2,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
      ...(extra.signature ? { signature: extra.signature } : {}),
      ...(extra.returnType ? { returnType: extra.returnType } : {}),
    });

    const reactImport: ImportMapping = {
      localName: 'useState',
      exportedName: 'useState',
      source: 'react',
      isDefault: false,
      isNamespace: false,
    };

    const declContext = (nodesByFile: Record<string, Node[]>, imports: ImportMapping[] = []): ResolutionContext => {
      const all = Object.values(nodesByFile).flat();
      return {
        ...baseContext,
        getNodesInFile: (filePath) => nodesByFile[filePath] ?? [],
        getNodesByName: (name) => all.filter((n) => n.name === name),
        getImportMappings: () => imports,
      };
    };

    const declRef = (
      filePath: string,
      referenceName: string,
      line: number,
      language: Node['language'] = 'typescript',
    ): UnresolvedRef => ({
      fromNodeId: `caller:${filePath}:fn:${line}`,
      referenceName,
      referenceKind: 'calls',
      line,
      column: 10,
      filePath,
      language,
    });

    it('binds a same-file receiver from declaration evidence (const conn = new DatabaseConnection())', () => {
      // Two same-named `close` methods defeat the old unique-candidate and
      // word-overlap branches (receiver "conn" overlaps neither class); only
      // the declaration evidence can bind this correctly.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn = new DatabaseConnection()' }),
          declNode('class:app.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'app.ts', 20),
          declNode('class:app.ts:Socket', 'class', 'Socket', 'app.ts', 30),
          declNode('method:app.ts:close:21', 'method', 'close', 'app.ts', 21, { qualifiedName: 'DatabaseConnection.close' }),
          declNode('method:app.ts:close:31', 'method', 'close', 'app.ts', 31, { qualifiedName: 'Socket.close' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'conn.close', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:close:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not bind a cross-file declared class the caller file does not import', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn = new DatabaseConnection()' }),
        ],
        'db/connection.ts': [
          declNode('class:db/connection.ts:1', 'class', 'DatabaseConnection', 'db/connection.ts', 1),
          declNode('method:db/connection.ts:close:10', 'method', 'close', 'db/connection.ts', 10, { qualifiedName: 'DatabaseConnection.close' }),
        ],
      }, [reactImport]);
      expect(matchMethodCall(declRef('app.ts', 'conn.close', 5), context)).toBeNull();
    });

    it('binds a cross-file declared class through import evidence', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn = new DatabaseConnection()' }),
        ],
        'db/connection.ts': [
          declNode('class:db/connection.ts:1', 'class', 'DatabaseConnection', 'db/connection.ts', 1),
          declNode('method:db/connection.ts:close:10', 'method', 'close', 'db/connection.ts', 10, { qualifiedName: 'DatabaseConnection.close' }),
        ],
      }, [
        { localName: 'DatabaseConnection', exportedName: 'DatabaseConnection', source: './connection', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'conn.close', 5), context);
      expect(result?.targetNodeId).toBe('method:db/connection.ts:close:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('falls through for builtins with no class node (const m = new Map())', () => {
      // Map has no graph class node, so the declaration evidence comes up
      // empty and the original strategies run unchanged — here they find no
      // `get` method candidate, so no instance-method edge may appear.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const m = new Map()' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'm.get', 5), context)).toBeNull();
    });

    it('vetoes word-overlap guessing when the declared class lacks the method', () => {
      // reportBuilder is declared as new LocalReport(); ReportBuilderEngine
      // shares ≥2 receiver words with the receiver and declares the same-named
      // method, which the old overlap branch would have bound. Declaration
      // evidence says the receiver cannot be a ReportBuilderEngine, so the
      // whole match is vetoed.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const reportBuilder = new LocalReport()' }),
          declNode('class:app.ts:LocalReport', 'class', 'LocalReport', 'app.ts', 20),
        ],
        'engine/ReportBuilderEngine.ts': [
          declNode('class:engine/ReportBuilderEngine.ts:1', 'class', 'ReportBuilderEngine', 'engine/ReportBuilderEngine.ts', 1),
          declNode('method:engine/ReportBuilderEngine.ts:generate:10', 'method', 'generate', 'engine/ReportBuilderEngine.ts', 10, { qualifiedName: 'ReportBuilderEngine.generate' }),
        ],
        'misc/Widget.ts': [
          declNode('method:misc/Widget.ts:generate:5', 'method', 'generate', 'misc/Widget.ts', 5, { qualifiedName: 'Widget.generate' }),
        ],
      }, [reactImport]);
      expect(matchMethodCall(declRef('app.ts', 'reportBuilder.generate', 5), context)).toBeNull();
    });

    it('binds from a bare reassignment statement (let q; q = new Queue())', () => {
      const context = declContext({
        'app.ts': [
          declNode('var:app.ts:3', 'variable', 'q', 'app.ts', 3),
          declNode('stmt:app.ts:4', 'statement', 'stmt@4:10', 'app.ts', 4, { signature: 'q = new Queue()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:push:21', 'method', 'push', 'app.ts', 21, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 6), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('uses the nearest declaration before the call line (reassignment retypes)', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const svc = new Alpha()' }),
          declNode('stmt:app.ts:7', 'statement', 'stmt@7:10', 'app.ts', 7, { signature: 'svc = new Beta()' }),
          declNode('class:app.ts:Alpha', 'class', 'Alpha', 'app.ts', 20),
          declNode('class:app.ts:Beta', 'class', 'Beta', 'app.ts', 30),
          declNode('method:app.ts:doWork:31', 'method', 'doWork', 'app.ts', 31, { qualifiedName: 'Beta.doWork' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'svc.doWork', 9), context);
      expect(result?.targetNodeId).toBe('method:app.ts:doWork:31');
      expect(result?.resolvedBy).toBe('instance-method');
      // Control: a call between the two declarations sees Alpha, which
      // declares no doWork — the veto must beat the word-overlap guess.
      expect(matchMethodCall(declRef('app.ts', 'svc.doWork', 4), context)).toBeNull();
    });

    it('skips declaration evidence for java refs (existing field-type path unchanged)', () => {
      // The constant node would be read as `helper = new OrderHelper()` if
      // Strategy 0.5 ran for java, and OrderHelper declares no fetch — a veto.
      // Pre-change behavior must survive: Strategy 1 binds the same-named
      // `helper` class via the qualified-name path.
      const context = declContext({
        'Order.java': [
          declNode('const:Order.java:helper', 'constant', 'helper', 'Order.java', 3, { signature: '= new OrderHelper()', language: 'java' }),
          declNode('class:Order.java:OrderHelper', 'class', 'OrderHelper', 'Order.java', 10, { language: 'java' }),
          declNode('class:Order.java:helper', 'class', 'helper', 'Order.java', 30, { language: 'java' }),
          declNode('method:Order.java:fetch:31', 'method', 'fetch', 'Order.java', 31, { qualifiedName: 'helper.fetch', language: 'java' }),
        ],
      });
      const result = matchMethodCall(declRef('Order.java', 'helper.fetch', 12, 'java'), context);
      expect(result?.targetNodeId).toBe('method:Order.java:fetch:31');
      expect(result?.resolvedBy).toBe('qualified-name');
    });

    // Strategy 0.5 extension: factory-return and type-annotation evidence.
    // `createQueue(): Queue` names the receiver's class one inference hop away;
    // `const q: Queue` names it directly without construction.
    it('binds a receiver from a factory return type (const q = createQueue(); q.push())', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = createQueue()' }),
          declNode('fn:app.ts:createQueue', 'function', 'createQueue', 'app.ts', 20, { returnType: 'Queue' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a factory imported from another file', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = createQueue()' }),
        ],
        'queue.ts': [
          declNode('fn:queue.ts:createQueue', 'function', 'createQueue', 'queue.ts', 20, { returnType: 'Queue' }),
          declNode('class:queue.ts:Queue', 'class', 'Queue', 'queue.ts', 30),
          declNode('method:queue.ts:push:31', 'method', 'push', 'queue.ts', 31, { qualifiedName: 'Queue.push' }),
        ],
      }, [
        { localName: 'createQueue', exportedName: 'createQueue', source: './queue', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:queue.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not bind a factory whose file the caller does not import', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = createQueue()' }),
        ],
        'queue.ts': [
          declNode('fn:queue.ts:createQueue', 'function', 'createQueue', 'queue.ts', 20, { returnType: 'Queue' }),
          declNode('class:queue.ts:Queue', 'class', 'Queue', 'queue.ts', 30),
          declNode('method:queue.ts:push:31', 'method', 'push', 'queue.ts', 31, { qualifiedName: 'Queue.push' }),
        ],
      }, [reactImport]);
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('binds from a variable type annotation (const q: Queue = make())', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: Queue = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a top-level annotation read from source when the variable signature is init-only', () => {
      const context: ResolutionContext = {
        ...declContext({
          'app.ts': [
            declNode('var:app.ts:3', 'variable', 'q', 'app.ts', 3, { signature: '= make()' }),
            declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
            declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
            declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
            declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
          ],
        }),
        readFile: (filePath) => (filePath === 'app.ts' ? 'const q: Queue = make()\n' : null),
      };
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not bind a non-awaited factory returning a generic type (Promise<Queue>)', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = createQueue()' }),
          declNode('fn:app.ts:createQueue', 'function', 'createQueue', 'app.ts', 20, { returnType: 'Promise<Queue>' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('binds an awaited factory through Promise unwrapping (const cg = await open())', () => {
      // `open(): Promise<Graph>` plus the awaited initializer means cg really
      // holds a Graph. The decoy Ledger.getNode keeps the unique-candidate
      // and word-overlap branches out — only the declaration layer binds.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = await open()' }),
          declNode('fn:app.ts:open', 'function', 'open', 'app.ts', 20, { returnType: 'Promise<Graph>' }),
          declNode('class:app.ts:Graph', 'class', 'Graph', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'Graph.getNode' }),
          declNode('class:app.ts:Ledger', 'class', 'Ledger', 'app.ts', 40),
          declNode('method:app.ts:getNode:41', 'method', 'getNode', 'app.ts', 41, { qualifiedName: 'Ledger.getNode' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:getNode:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds an awaited factory imported from another file through Promise unwrapping', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = await open()' }),
        ],
        'graph.ts': [
          declNode('fn:graph.ts:open', 'function', 'open', 'graph.ts', 20, { returnType: 'Promise<Graph>' }),
          declNode('class:graph.ts:Graph', 'class', 'Graph', 'graph.ts', 30),
          declNode('method:graph.ts:getNode:31', 'method', 'getNode', 'graph.ts', 31, { qualifiedName: 'Graph.getNode' }),
        ],
      }, [
        { localName: 'open', exportedName: 'open', source: './graph', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context);
      expect(result?.targetNodeId).toBe('method:graph.ts:getNode:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a Promise-annotated receiver when the initializer is awaited (const q: Promise<Queue> = await make())', () => {
      // The await flag rides on the annotation capture itself, so the same
      // Promise<Queue> type binds here where the bare `= make()` shape below
      // must stay silent.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: Promise<Queue> = await make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('falls through a non-awaited Promise annotation without vetoing later strategies', () => {
      // q holds the Promise, so Queue.push must not bind — and the type is
      // NOT authoritative either (fall-through, not veto): Stack.push is the
      // only method candidate and still gets its Strategy 3 chance.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: Promise<Queue> = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:41');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('strips a readonly qualifier from an annotated receiver type (const q: readonly Queue = make())', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: readonly Queue = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not peel utility generics (const q: Partial<Queue> = make() binds nothing)', () => {
      // Partial<Queue> stays opaque (fall-through, no veto) and the two
      // same-named push methods leave the word-overlap branches no bind
      // either — nothing may resolve.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: Partial<Queue> = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    // Nullable-union peel fixtures. null/undefined declare no methods, so a
    // sole non-nullish annotation member IS the receiver's class — the two
    // shapes that motivated this batch (pool evidence: 10 failed
    // `initializedDb.close` refs on `let initializedDb: DatabaseConnection |
    // undefined`, 2 failed `find.focus` refs on `FileSearchHandle | null`).
    it('binds a nullable-union annotated receiver (const d: Queue | undefined = make())', () => {
      // Decoy Stack.push keeps the unique-candidate and word-overlap
      // branches out — only the peeled annotation can bind.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const d: Queue | undefined = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'd.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a nullable-union receiver whose class sits behind a directory-barrel import', () => {
      // Mirrors the real graph/index.ts site: `./db` reaches db/index.ts
      // only through the barrel arm of the import veto.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'let initializedDb: DatabaseConnection | undefined = undefined' }),
        ],
        'db/index.ts': [
          declNode('class:db/index.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'db/index.ts', 1),
          declNode('method:db/index.ts:close:10', 'method', 'close', 'db/index.ts', 10, { qualifiedName: 'DatabaseConnection::close' }),
        ],
      }, [
        { localName: 'DatabaseConnection', exportedName: 'DatabaseConnection', source: './db', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'initializedDb.close', 5), context);
      expect(result?.targetNodeId).toBe('method:db/index.ts:close:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a type-alias receiver behind a `| null` annotation (const d: Proc | null = handler())', () => {
      // The FileSearchHandle shape: contract members (`Proc::run`) bind
      // exactly like class methods after the peel.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const d: Proc | null = handler()' }),
          declNode('alias:app.ts:Proc', 'type_alias', 'Proc', 'app.ts', 20),
          declNode('method:app.ts:run:21', 'method', 'run', 'app.ts', 21, { qualifiedName: 'Proc::run' }),
          declNode('class:app.ts:Runner', 'class', 'Runner', 'app.ts', 30),
          declNode('method:app.ts:run:31', 'method', 'run', 'app.ts', 31, { qualifiedName: 'Runner::run' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'd.run', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:run:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a union-typed parameter receiver (function drain(q: Queue | undefined))', () => {
      // Parameters hold what callers pass; `Queue | undefined` still pins
      // the value type, so Strategy 0.5b peels and binds like 0.5.
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Queue | undefined' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:push:21', 'method', 'push', 'app.ts', 21, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not peel a two-class union (const x: Queue | Stack binds nothing)', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const x: Queue | Stack = pick()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'x.push', 5), context)).toBeNull();
    });

    it('falls through an unpeelable union without vetoing later strategies', () => {
      // Red line: a multi-class union stays non-authoritative — with Queue
      // declaring no push, the single Stack.push candidate must still get
      // its Strategy 3 chance.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const x: Queue | Stack = pick()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'x.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:41');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not peel a pipe inside generic arguments (const x: Handler<Queue | Stack>)', () => {
      // The naive split yields the non-simple members `Handler<Queue` and
      // `Stack>` — two survivors bail, no class is inferred.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const x: Handler<Queue | Stack> = pick()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'x.push', 5), context)).toBeNull();
    });

    it('does not peel a structured survivor (const x: Array<Queue> | null)', () => {
      // One survivor, but `Array<Queue>` is not a simple name — the same
      // gate that keeps bare `Array<Queue>` opaque decides for the union.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const x: Array<Queue> | null = arr()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'x.push', 5), context)).toBeNull();
    });

    it('does not peel a non-awaited Promise in a union (const q: Promise<Queue> | null = make())', () => {
      // The await rule composes: q holds the Promise, so `Queue.push` must
      // not bind off this evidence; the union survivor falls back to the
      // same await-gated opacity as the bare Promise type.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q: Promise<Queue> | null = make()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('prefers direct construction over a factory return for the same receiver', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = new Queue()' }),
          declNode('stmt:app.ts:5', 'statement', 'stmt@5:10', 'app.ts', 5, { signature: 'q = createStack()' }),
          declNode('fn:app.ts:createStack', 'function', 'createStack', 'app.ts', 20, { returnType: 'Stack' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 7), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Strategy 0.5b fixtures: typed parameters on the enclosing function
    // (`function f(q: Queue) { q.push() }`), read from node.params.
    const paramFnNode = (
      id: string,
      name: string,
      filePath: string,
      startLine: number,
      endLine: number,
      params: NonNullable<Node['params']>,
    ): Node => ({
      id,
      kind: 'function',
      name,
      qualifiedName: name,
      filePath,
      language: 'typescript',
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
      params,
    });

    it('binds a receiver from a typed parameter on the enclosing function (function drain(q: Queue))', () => {
      // Two same-named `push` methods defeat the unique-candidate and
      // word-overlap branches; only the annotation names the class.
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Queue' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:push:21', 'method', 'push', 'app.ts', 21, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Stack.push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a cross-file parameter class through import evidence', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Queue' }]),
        ],
        'collections/queue.ts': [
          declNode('class:queue.ts:Queue', 'class', 'Queue', 'collections/queue.ts', 1),
          declNode('method:queue.ts:push:10', 'method', 'push', 'collections/queue.ts', 10, { qualifiedName: 'Queue.push' }),
        ],
      }, [
        { localName: 'Queue', exportedName: 'Queue', source: './queue', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'q.push', 5), context);
      expect(result?.targetNodeId).toBe('method:queue.ts:push:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not bind a cross-file parameter class the caller file does not import', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Queue' }]),
        ],
        'collections/queue.ts': [
          declNode('class:queue.ts:Queue', 'class', 'Queue', 'collections/queue.ts', 1),
          declNode('method:queue.ts:push:10', 'method', 'push', 'collections/queue.ts', 10, { qualifiedName: 'Queue.push' }),
        ],
      }, [reactImport]);
      // The annotation class fails the import veto (fall through), and the
      // unique cross-file candidate is then vetoed by Strategy 3 — no bind.
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('skips generic parameter types (q: Promise<Queue> binds nothing)', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Promise<Queue>' }]),
        ],
        'collections/queue.ts': [
          declNode('class:queue.ts:Queue', 'class', 'Queue', 'collections/queue.ts', 1),
          declNode('method:queue.ts:push:10', 'method', 'push', 'collections/queue.ts', 10, { qualifiedName: 'Queue.push' }),
        ],
      }, [reactImport]);
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('does not peel a Promise parameter type (function drain(q: Promise<Queue>))', () => {
      // Parameters can never be await-initialized — q holds the Promise.
      // With two same-named push methods and no receiver-word overlap, only
      // a parameter bind could resolve this; the opaque type must stay silent
      // without vetoing (the veto semantics are covered by the Queue test
      // below).
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Promise<Queue>' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:push:21', 'method', 'push', 'app.ts', 21, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Stack.push' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'q.push', 5), context)).toBeNull();
    });

    it('vetoes word-overlap guessing when the parameter class lacks the method', () => {
      // Widget.flush is the only `flush` candidate and shares the file with
      // the receiver, so Strategy 3 would bind it without the annotation
      // veto. The parameter type is authoritative — Queue declares no flush.
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 9, [{ name: 'q', type: 'Queue' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:flush:41', 'method', 'flush', 'app.ts', 41, { qualifiedName: 'Widget.flush' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'q.flush', 5), context)).toBeNull();
    });

    it('prefers `= new` declaration evidence over a conflicting parameter annotation', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:drain:3', 'drain', 'app.ts', 3, 12, [{ name: 'q', type: 'Queue' }]),
          declNode('stmt:app.ts:4', 'statement', 'stmt@4:10', 'app.ts', 4, { signature: 'q = new Stack()' }),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 20),
          declNode('method:app.ts:push:21', 'method', 'push', 'app.ts', 21, { qualifiedName: 'Queue.push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Stack.push' }),
        ],
      });
      // Annotation says Queue (push:21); the nearer `= new Stack()` says
      // Stack (push:31). Declaration evidence must win.
      const result = matchMethodCall(declRef('app.ts', 'q.push', 6), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Gap B': `type X = { m(): T }` contract members are first-class method
    // nodes (`X::m`, extractTsTypeAliasMembers), so a type-alias receiver type
    // must pass the same candidate-class filter a class/interface would.
    it('binds a type-alias receiver from annotation evidence (type Proc = { run(): void })', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const p: Proc = handler()' }),
          declNode('alias:app.ts:Proc', 'type_alias', 'Proc', 'app.ts', 20),
          declNode('method:app.ts:run:21', 'method', 'run', 'app.ts', 21, { qualifiedName: 'Proc::run' }),
          declNode('class:app.ts:Runner', 'class', 'Runner', 'app.ts', 30),
          declNode('method:app.ts:run:31', 'method', 'run', 'app.ts', 31, { qualifiedName: 'Runner.run' }),
        ],
      });
      // The decoy Runner.run shares the method name; only the alias qn carries
      // "Proc", so the bind must land on the type-alias contract member.
      const result = matchMethodCall(declRef('app.ts', 'p.run', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:run:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a cross-file type-alias receiver through import evidence', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const d: Proc = makeProc()' }),
        ],
        'proc.ts': [
          declNode('alias:proc.ts:Proc', 'type_alias', 'Proc', 'proc.ts', 20),
          declNode('method:proc.ts:run:21', 'method', 'run', 'proc.ts', 21, { qualifiedName: 'Proc::run' }),
        ],
      }, [
        { localName: 'Proc', exportedName: 'Proc', source: './proc', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'd.run', 5), context);
      expect(result?.targetNodeId).toBe('method:proc.ts:run:21');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Gap D: barrel/directory import specifiers. `./db` names `db/index.ts`
    // (directory module) as much as `db.ts`; the bare tail comparison vetoed
    // the former. The barrel arm is directory-consistency checked so an
    // unrelated `index.*` file under a same-named directory stays vetoed.
    it('binds a class reached through a directory-barrel import (./sub/db -> sub/db/index.ts)', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn: DatabaseConnection = openDb()' }),
        ],
        'sub/db/index.ts': [
          declNode('class:sub/db/index.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'sub/db/index.ts', 10),
          declNode('method:sub/db/index.ts:query:11', 'method', 'query', 'sub/db/index.ts', 11, { qualifiedName: 'DatabaseConnection::query' }),
        ],
        // Decoy: same class/method shape under an unrelated same-named
        // directory. The strict barrel rule must not let it through.
        'other/sub/db/index.ts': [
          declNode('class:other/sub/db/index.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'other/sub/db/index.ts', 10),
          declNode('method:other/sub/db/index.ts:query:11', 'method', 'query', 'other/sub/db/index.ts', 11, { qualifiedName: 'DatabaseConnection::query' }),
        ],
      }, [
        { localName: 'DatabaseConnection', exportedName: 'DatabaseConnection', source: './sub/db', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'conn.query', 5), context);
      expect(result?.targetNodeId).toBe('method:sub/db/index.ts:query:11');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a class reached through the same-name-file import convention (./sub/db -> sub/db.ts)', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn: DatabaseConnection = openDb()' }),
        ],
        'sub/db.ts': [
          declNode('class:sub/db.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'sub/db.ts', 10),
          declNode('method:sub/db.ts:query:11', 'method', 'query', 'sub/db.ts', 11, { qualifiedName: 'DatabaseConnection::query' }),
        ],
      }, [
        { localName: 'DatabaseConnection', exportedName: 'DatabaseConnection', source: './sub/db', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'conn.query', 5), context);
      expect(result?.targetNodeId).toBe('method:sub/db.ts:query:11');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not let a relative barrel specifier reach an unrelated same-named directory', () => {
      // Caller is in pkg/, so `./sub/db` resolves to pkg/sub/db — a barrel at
      // other/sub/db/ must stay vetoed and nothing may bind.
      const context = declContext({
        'pkg/app.ts': [
          declNode('stmt:pkg/app.ts:3', 'statement', 'stmt@3:10', 'pkg/app.ts', 3, { signature: 'const conn: DatabaseConnection = openDb()' }),
        ],
        'other/sub/db/index.ts': [
          declNode('class:other/sub/db/index.ts:DatabaseConnection', 'class', 'DatabaseConnection', 'other/sub/db/index.ts', 10),
          declNode('method:other/sub/db/index.ts:query:11', 'method', 'query', 'other/sub/db/index.ts', 11, { qualifiedName: 'DatabaseConnection::query' }),
        ],
      }, [
        { localName: 'DatabaseConnection', exportedName: 'DatabaseConnection', source: './sub/db', isDefault: false, isNamespace: false },
      ]);
      expect(matchMethodCall(declRef('pkg/app.ts', 'conn.query', 5), context)).toBeNull();
    });


    // Batch: dotted factory evidence. `const cg = await CodeGraph.open()` —
    // the class-prefixed callee names the method whose return type types the
    // receiver. Same await/Promise rules as the bare factory.
    it('binds a receiver from a dotted static factory (const cg = await CodeGraph.open())', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = await CodeGraph.open(projectPath)' }),
          declNode('method:app.ts:open:20', 'method', 'open', 'app.ts', 20, { qualifiedName: 'CodeGraph::open', returnType: 'Promise<CodeGraph>' }),
          declNode('class:app.ts:CodeGraph', 'class', 'CodeGraph', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'CodeGraph::getNode' }),
          declNode('class:app.ts:Ledger', 'class', 'Ledger', 'app.ts', 40),
          declNode('method:app.ts:getNode:41', 'method', 'getNode', 'app.ts', 41, { qualifiedName: 'Ledger::getNode' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:getNode:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds a `this.`-prefixed factory through the same-file method return type', () => {
      // `const cg = this.getCodeGraph(path)` — the enclosing class's own
      // method names the receiver's type directly (no Promise to peel).
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = this.getCodeGraph(projectPath)' }),
          declNode('method:app.ts:getCodeGraph:20', 'method', 'getCodeGraph', 'app.ts', 20, { qualifiedName: 'ToolHandler::getCodeGraph', returnType: 'CodeGraph' }),
          declNode('class:app.ts:CodeGraph', 'class', 'CodeGraph', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'CodeGraph::getNode' }),
          declNode('class:app.ts:Ledger', 'class', 'Ledger', 'app.ts', 40),
          declNode('method:app.ts:getNode:41', 'method', 'getNode', 'app.ts', 41, { qualifiedName: 'Ledger::getNode' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:getNode:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('does not bind a non-awaited dotted factory returning Promise<T> (falls through)', () => {
      // Without the await the receiver holds the Promise — same rule as the
      // bare factory. No veto either: nothing else binds, so null is the
      // unbindable-heuristics outcome, not an evidence veto.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = CodeGraph.open(projectPath)' }),
          declNode('method:app.ts:open:20', 'method', 'open', 'app.ts', 20, { qualifiedName: 'CodeGraph::open', returnType: 'Promise<CodeGraph>' }),
          declNode('class:app.ts:CodeGraph', 'class', 'CodeGraph', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'CodeGraph::getNode' }),
          declNode('class:app.ts:Ledger', 'class', 'Ledger', 'app.ts', 40),
          declNode('method:app.ts:getNode:41', 'method', 'getNode', 'app.ts', 41, { qualifiedName: 'Ledger::getNode' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context)).toBeNull();
    });

    it('does not bind factories behind deeper chains (a.b.c())', () => {
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = await lib.CodeGraph.open(projectPath)' }),
          declNode('method:app.ts:open:20', 'method', 'open', 'app.ts', 20, { qualifiedName: 'CodeGraph::open', returnType: 'Promise<CodeGraph>' }),
          declNode('class:app.ts:CodeGraph', 'class', 'CodeGraph', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'CodeGraph::getNode' }),
          declNode('class:app.ts:Ledger', 'class', 'Ledger', 'app.ts', 40),
          declNode('method:app.ts:getNode:41', 'method', 'getNode', 'app.ts', 41, { qualifiedName: 'Ledger::getNode' }),
        ],
      });
      expect(matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context)).toBeNull();
    });

    it('falls through an unresolvable dotted prefix without vetoing the unique candidate', () => {
      // `mgr.open()` names no graph member — the evidence must stay silent
      // (fall-through, not veto): the single same-file getNode candidate
      // keeps its Strategy 3 chance.
      const context = declContext({
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const cg = await mgr.open()' }),
          declNode('class:app.ts:Node', 'class', 'Node', 'app.ts', 30),
          declNode('method:app.ts:getNode:31', 'method', 'getNode', 'app.ts', 31, { qualifiedName: 'Node::getNode' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'cg.getNode', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:getNode:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Import-reachability supplements: `import type X from 'm'` and
    // `await import('m')` are import evidence the static resolver regex
    // misses; they may only ALLOW cross-file binds, never open the
    // "no imports -> permissive" default (merge requires a non-empty base).
    it('binds a declared cross-file class through a type-only default import', () => {
      const context: ResolutionContext = {
        ...declContext({
          'app.ts': [
            declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = new Queue()' }),
          ],
          'queue.ts': [
            declNode('class:queue.ts:Queue', 'class', 'Queue', 'queue.ts', 1),
            declNode('method:queue.ts:close:10', 'method', 'close', 'queue.ts', 10, { qualifiedName: 'Queue::close' }),
          ],
        }, [reactImport]),
        readFile: (filePath) =>
          filePath === 'app.ts' ? "import { useState } from 'react';\nimport type Queue from './queue';\n" : null,
      };
      const result = matchMethodCall(declRef('app.ts', 'q.close', 5), context);
      expect(result?.targetNodeId).toBe('method:queue.ts:close:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('binds through a dynamic import specifier (await import)', () => {
      const context: ResolutionContext = {
        ...declContext({
          'app.ts': [
            declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const conn = new DatabaseConnection()' }),
          ],
          'db/connection.ts': [
            declNode('class:db/connection.ts:1', 'class', 'DatabaseConnection', 'db/connection.ts', 1),
            declNode('method:db/connection.ts:close:10', 'method', 'close', 'db/connection.ts', 10, { qualifiedName: 'DatabaseConnection::close' }),
          ],
        }, [reactImport]),
        readFile: (filePath) =>
          filePath === 'app.ts' ? "import { useState } from 'react';\nconst load = async () => await import('./db/connection');\n" : null,
      };
      const result = matchMethodCall(declRef('app.ts', 'conn.close', 5), context);
      expect(result?.targetNodeId).toBe('method:db/connection.ts:close:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('import supplements do not widen reachability to unrelated candidates', () => {
      // The file imports a type-only `Queue` and nothing naming Widget —
      // the single cross-file Widget.close candidate stays vetoed.
      const context: ResolutionContext = {
        ...declContext({
          'app.ts': [
            declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const q = new Queue()' }),
          ],
          'lib/Widget.ts': [
            declNode('class:lib/Widget.ts:Widget', 'class', 'Widget', 'lib/Widget.ts', 1),
            declNode('method:lib/Widget.ts:close:10', 'method', 'close', 'lib/Widget.ts', 10, { qualifiedName: 'Widget::close' }),
          ],
        }, [reactImport]),
        readFile: (filePath) =>
          filePath === 'app.ts' ? "import { useState } from 'react';\nimport type Queue from './queue';\n" : null,
      };
      // Queue has no class node at all (fall through), and Widget.close is the
      // unique cross-file candidate the import veto still kills.
      expect(matchMethodCall(declRef('app.ts', 'q.close', 5), context)).toBeNull();
    });

    // Closure-parameter walk: a receiver typed on an ENCLOSING function's
    // parameter is visible in nested bodies; the innermost same-name
    // declaration shadows it.
    it('binds a receiver from an enclosing function parameter around a nested callback', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:create:3', 'create', 'app.ts', 3, 20, [{ name: 'q', type: 'Queue' }]),
          paramFnNode('func:app.ts:handle:8', 'handle', 'app.ts', 8, 12, [{ name: 'event', type: 'Event' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue::push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack::push' }),
        ],
      });
      // Call line 10 sits inside `handle` (which does not name q): the walk
      // must step out to `create`, whose typed `q: Queue` binds the receiver.
      const result = matchMethodCall(declRef('app.ts', 'q.push', 10), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('prefers the innermost same-name parameter (lexical shadowing)', () => {
      const context = declContext({
        'app.ts': [
          paramFnNode('func:app.ts:create:3', 'create', 'app.ts', 3, 20, [{ name: 'q', type: 'Queue' }]),
          paramFnNode('func:app.ts:handle:8', 'handle', 'app.ts', 8, 12, [{ name: 'q', type: 'Stack' }]),
          declNode('class:app.ts:Queue', 'class', 'Queue', 'app.ts', 30),
          declNode('method:app.ts:push:31', 'method', 'push', 'app.ts', 31, { qualifiedName: 'Queue::push' }),
          declNode('class:app.ts:Stack', 'class', 'Stack', 'app.ts', 40),
          declNode('method:app.ts:push:41', 'method', 'push', 'app.ts', 41, { qualifiedName: 'Stack::push' }),
        ],
      });
      const result = matchMethodCall(declRef('app.ts', 'q.push', 10), context);
      expect(result?.targetNodeId).toBe('method:app.ts:push:41');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    // Same-name container disambiguation: a layer only decides when UNIQUE,
    // ambiguity falls through to the old first-allowed behavior.
    it('disambiguates same-named classes by same-file uniqueness (declaration path)', () => {
      // The index order puts the WRONG `Prompt` first — `find()` would bind
      // other/Prompt.render; same-file uniqueness must pick app.ts.
      const context = declContext({
        'other/Prompt.ts': [
          declNode('class:other/Prompt.ts:Prompt', 'class', 'Prompt', 'other/Prompt.ts', 1),
          declNode('method:other/Prompt.ts:render:10', 'method', 'render', 'other/Prompt.ts', 10, { qualifiedName: 'Prompt::render' }),
        ],
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const p = new Prompt()' }),
          declNode('class:app.ts:Prompt', 'class', 'Prompt', 'app.ts', 30),
          declNode('method:app.ts:render:31', 'method', 'render', 'app.ts', 31, { qualifiedName: 'Prompt::render' }),
        ],
      }, [
        reactImport,
        { localName: 'usePrompt', exportedName: 'usePrompt', source: './Prompt', isDefault: false, isNamespace: false },
      ]);
      const result = matchMethodCall(declRef('app.ts', 'p.render', 5), context);
      expect(result?.targetNodeId).toBe('method:app.ts:render:31');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('disambiguates same-named cross-file classes by a uniquely pinned import (param path)', () => {
      // Both candidates are import-allowed (the './sub/Prompt' specifier tail
      // matches each same-named file); only sub/Prompt.ts is pinned by the
      // exact resolved path, so the import layer decides.
      const context = declContext({
        'other/Prompt.ts': [
          declNode('class:other/Prompt.ts:Prompt', 'class', 'Prompt', 'other/Prompt.ts', 1),
          declNode('method:other/Prompt.ts:render:10', 'method', 'render', 'other/Prompt.ts', 10, { qualifiedName: 'Prompt::render' }),
        ],
        'editor.ts': [
          paramFnNode('func:editor.ts:edit:3', 'edit', 'editor.ts', 3, 9, [{ name: 'p', type: 'Prompt' }]),
        ],
        'sub/Prompt.ts': [
          declNode('class:sub/Prompt.ts:Prompt', 'class', 'Prompt', 'sub/Prompt.ts', 1),
          declNode('method:sub/Prompt.ts:render:10', 'method', 'render', 'sub/Prompt.ts', 10, { qualifiedName: 'Prompt::render' }),
        ],
      }, [
        {
          localName: 'Prompt',
          exportedName: 'Prompt',
          source: './sub/Prompt',
          resolvedPath: 'sub/Prompt.ts',
          isDefault: false,
          isNamespace: false,
        },
        reactImport,
      ]);
      const result = matchMethodCall(declRef('editor.ts', 'p.render', 5), context);
      expect(result?.targetNodeId).toBe('method:sub/Prompt.ts:render:10');
      expect(result?.resolvedBy).toBe('instance-method');
    });

    it('keeps first-allowed behavior when every disambiguation layer is ambiguous', () => {
      // Two same-named classes, neither same-file, neither pinned (the
      // './anything/Prompt' tail match is allow-only) — the old find()
      // semantics must survive untouched: the first allowed candidate wins.
      const context = declContext({
        'other/Prompt.ts': [
          declNode('class:other/Prompt.ts:Prompt', 'class', 'Prompt', 'other/Prompt.ts', 1),
          declNode('method:other/Prompt.ts:render:10', 'method', 'render', 'other/Prompt.ts', 10, { qualifiedName: 'Prompt::render' }),
        ],
        'z/Prompt.ts': [
          declNode('class:z/Prompt.ts:Prompt', 'class', 'Prompt', 'z/Prompt.ts', 1),
          declNode('method:z/Prompt.ts:render:10', 'method', 'render', 'z/Prompt.ts', 10, { qualifiedName: 'Prompt::render' }),
        ],
        'app.ts': [
          declNode('stmt:app.ts:3', 'statement', 'stmt@3:10', 'app.ts', 3, { signature: 'const p = new Prompt()' }),
        ],
      }, [
        { localName: 'Prompt', exportedName: 'Prompt', source: './x/Prompt', isDefault: false, isNamespace: false },
        reactImport,
      ]);
      const result = matchMethodCall(declRef('app.ts', 'p.render', 5), context);
      expect(result?.targetNodeId).toBe('method:other/Prompt.ts:render:10');
    });

    it('refuses to fuzzy-guess names defined beyond the ambiguity ceiling', () => {
      // Upstream #999: K definitions x K references is O(K²) work that stalls
      // indexing on vendored/duplicated code. Beyond the ceiling the fuzzy
      // scorer is bypassed; precise strategies (qualified/import) are unaffected.
      const many = Array.from({ length: 501 }, (_, i) => ({
        id: `func:dup.ts:f:${i}`,
        kind: 'function' as const,
        name: 'overloaded',
        qualifiedName: 'dup.ts::overloaded',
        filePath: `dup${i}.ts`,
        language: 'typescript' as const,
        startLine: i + 1,
        endLine: i + 2,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      }));
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: () => many,
      };
      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'overloaded',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };
      expect(matchByExactName(ref, context)).toBeNull();
    });

    it('still scores names at or below the ambiguity ceiling', () => {
      // The guard is strict >; exactly 500 (or fewer) still runs the scorer.
      const many = Array.from({ length: 500 }, (_, i) => ({
        id: `func:dup.ts:f:${i}`,
        kind: 'function' as const,
        name: 'overloaded',
        qualifiedName: 'dup.ts::overloaded',
        filePath: `dup${i}.ts`,
        language: 'typescript' as const,
        startLine: i + 1,
        endLine: i + 2,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      }));
      const context: ResolutionContext = {
        ...baseContext,
        getNodesByName: () => many,
      };
      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'overloaded',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };
      const result = matchByExactName(ref, context);
      expect(result === null ? null : result.resolvedBy).toBe('exact-match');
    });

    it('should prefer same-module candidates over cross-module matches', () => {
      // Simulates a Python monorepo where multiple apps define navigate()
      const candidateA: Node = {
        id: 'func:apps/app_a/src/server.py:navigate:10',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_a/src/server.py::navigate',
        filePath: 'apps/app_a/src/server.py',
        language: 'python',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const candidateB: Node = {
        id: 'func:apps/app_b/src/server.py:navigate:15',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_b/src/server.py::navigate',
        filePath: 'apps/app_b/src/server.py',
        language: 'python',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? [candidateA, candidateB] : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a should resolve to app_a's navigate, not app_b's
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:apps/app_a/src/server.py:navigate:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should still resolve cross-module exact matches', () => {
      // Both candidates are in entirely different modules from the caller
      const candidates: Node[] = [
        {
          id: 'func:apps/app_b/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_b/src/server.py::navigate',
          filePath: 'apps/app_b/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
        {
          id: 'func:apps/app_c/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_c/src/server.py::navigate',
          filePath: 'apps/app_c/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? candidates : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a — neither candidate is in the same module
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      // Still resolves — the evidence category is exact-match, not a proximity score
      expect(result).not.toBeNull();
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should match qualified name references', () => {
      const mockClassNode: Node = {
        id: 'class:user.ts:User:5',
        kind: 'class',
        name: 'User',
        qualifiedName: 'user.ts::User',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 30,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const mockMethodNode: Node = {
        id: 'method:user.ts:User.save:15',
        kind: 'method',
        name: 'save',
        qualifiedName: 'user.ts::User::save',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: (fp) => fp === 'user.ts' ? [mockClassNode, mockMethodNode] : [],
        getNodesByName: (name) => {
          if (name === 'User') return [mockClassNode];
          if (name === 'save') return [mockMethodNode];
          return [];
        },
        getNodesByQualifiedName: (qn) => {
          if (qn === 'user.ts::User::save') return [mockMethodNode];
          return [];
        },
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['user.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:main:5',
        referenceName: 'User.save',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('method:user.ts:User.save:15');
    });
  });

  describe('Import Resolver', () => {
    it('should resolve relative import paths', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/components/utils.ts' || p === 'src/components/utils/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/components/utils.ts', 'src/components/utils/index.ts'],
      };

      const result = resolveImportPath(
        './utils',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/components/utils.ts');
    });

    it('should resolve parent directory imports', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/helpers.ts' || p === 'src/helpers/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/helpers.ts', 'src/helpers/index.ts'],
      };

      const result = resolveImportPath(
        '../helpers',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/helpers.ts');
    });

    it('should extract JS/TS import mappings', () => {
      const content = `
import { foo } from './foo';
import bar from '../bar';
import * as utils from './utils';
import { baz, qux } from './baz';
`;

      const mappings = extractImportMappings(
        'src/index.ts',
        content,
        'typescript'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'foo')).toBe(true);
      expect(mappings.some((m) => m.localName === 'bar')).toBe(true);
    });

    it('should extract Python import mappings', () => {
      const content = `
from utils import helper
from .models import User
import os
from ..services import auth_service
`;

      const mappings = extractImportMappings(
        'src/main.py',
        content,
        'python'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'helper')).toBe(true);
      expect(mappings.some((m) => m.localName === 'User')).toBe(true);
    });
  });

  describe('JVM FQN Import Resolution', () => {
    // Build a ResolutionContext stub whose getNodesByQualifiedName answers
    // from a fixed table — the only context method resolveJvmImport touches.
    const makeContext = (byQName: Record<string, Node[]>): ResolutionContext => ({
      ...baseContext,
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: (q) => byQName[q] ?? [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
    });
    const node = (id: string, name: string, qualifiedName: string, kind: Node['kind'] = 'class', language: Node['language'] = 'kotlin'): Node => ({
      id, kind, name, qualifiedName,
      filePath: 'Models.kt', language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      updatedAt: 0,
    });
    const importRef = (referenceName: string, language: Node['language'] = 'kotlin'): UnresolvedRef => ({
      fromNodeId: 'caller',
      referenceName,
      referenceKind: 'imports',
      line: 1, column: 0,
      filePath: 'Caller.kt',
      language,
    });

    it('resolves a Kotlin class import by FQN regardless of filename', () => {
      const target = node('n1', 'Bar', 'com.example.foo::Bar');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar'), ctx);
      expect(result?.targetNodeId).toBe('n1');
      expect(result?.resolvedBy).toBe('import');
    });

    it('resolves a Kotlin top-level function import by FQN', () => {
      const util = node('n2', 'util', 'com.example.foo::util', 'function');
      const ctx = makeContext({ 'com.example.foo::util': [util] });
      const result = resolveJvmImport(importRef('com.example.foo.util'), ctx);
      expect(result?.targetNodeId).toBe('n2');
    });

    it('resolves a Java import by FQN', () => {
      const target = node('n3', 'Bar', 'com.example.foo::Bar', 'class', 'java');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar', 'java'), ctx);
      expect(result?.targetNodeId).toBe('n3');
    });

    it('resolves cross-language: Kotlin importing a Java class', () => {
      // The Kotlin file declares `import com.example.JavaBar` — the target is
      // a Java class node. JVM interop means the resolver doesn't care about
      // the source language of the target, only that the FQN matches.
      const target = node('n4', 'JavaBar', 'com.example::JavaBar', 'class', 'java');
      const ctx = makeContext({ 'com.example::JavaBar': [target] });
      const result = resolveJvmImport(importRef('com.example.JavaBar'), ctx);
      expect(result?.targetNodeId).toBe('n4');
    });

    it('disambiguates a name collision across packages', () => {
      // Two classes named `Bar` in different packages. Each import resolves
      // to the one whose FQN matches — not to "whichever was found first".
      const barA = node('n5a', 'Bar', 'com.example.alpha::Bar');
      const barB = node('n5b', 'Bar', 'com.example.beta::Bar');
      const ctx = makeContext({
        'com.example.alpha::Bar': [barA],
        'com.example.beta::Bar': [barB],
      });
      expect(resolveJvmImport(importRef('com.example.alpha.Bar'), ctx)?.targetNodeId).toBe('n5a');
      expect(resolveJvmImport(importRef('com.example.beta.Bar'), ctx)?.targetNodeId).toBe('n5b');
    });

    it('returns null for wildcard imports', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.foo.*'), ctx)).toBeNull();
    });

    it('returns null for unqualified names', () => {
      // A single-segment name has no package; nothing to look up by FQN.
      const ctx = makeContext({ 'Bar': [node('n6', 'Bar', 'Bar')] });
      expect(resolveJvmImport(importRef('Bar'), ctx)).toBeNull();
    });

    it('returns null for non-JVM languages', () => {
      const target = node('n7', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      expect(resolveJvmImport(importRef('com.example.Bar', 'typescript'), ctx)).toBeNull();
    });

    it('returns null for non-imports reference kinds', () => {
      // The resolver intentionally only acts on `imports` refs; ordinary
      // `calls`/`extends` refs fall through to the framework + name-matcher
      // strategies.
      const target = node('n8', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'com.example.Bar',
        referenceKind: 'calls', line: 1, column: 0,
        filePath: 'Caller.kt', language: 'kotlin',
      };
      expect(resolveJvmImport(ref, ctx)).toBeNull();
    });

    it('returns null when the FQN is not in the index', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.Unknown'), ctx)).toBeNull();
    });
  });

  describe('Framework Detection', () => {
    it('should detect React framework', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { react: '^18.0.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'react')).toBe(true);
    });

    it('should detect Express framework', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { express: '^4.18.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/app.js'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'express')).toBe(true);
    });

    it('should detect Laravel framework', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'artisan',
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['artisan', 'app/Http/Kernel.php'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'laravel')).toBe(true);
    });

    it('should return all framework resolvers', () => {
      const resolvers = getAllFrameworkResolvers();
      expect(resolvers.length).toBeGreaterThan(0);
      expect(resolvers.some((r) => r.name === 'react')).toBe(true);
      expect(resolvers.some((r) => r.name === 'express')).toBe(true);
      expect(resolvers.some((r) => r.name === 'laravel')).toBe(true);
    });
  });

  describe('React Framework Resolver', () => {
    it('should resolve React component references', () => {
      const mockNodes: Node[] = [
        {
          id: 'component:src/Button.tsx:Button:5',
          kind: 'component',
          name: 'Button',
          qualifiedName: 'src/Button.tsx::Button',
          filePath: 'src/Button.tsx',
          language: 'tsx',
          startLine: 5,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: (fp) => (fp === 'src/Button.tsx' ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/Button.tsx', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');
      expect(reactResolver).toBeDefined();

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'Button',
        referenceKind: 'references' as const,
        line: 10,
        column: 5,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');
    });

    it('should resolve custom hook references', () => {
      const mockNodes: Node[] = [
        {
          id: 'hook:src/hooks/useAuth.ts:useAuth:1',
          kind: 'function',
          name: 'useAuth',
          qualifiedName: 'src/hooks/useAuth.ts::useAuth',
          filePath: 'src/hooks/useAuth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: (fp) => (fp.includes('useAuth') ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/hooks/useAuth.ts'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'useAuth',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('hook:src/hooks/useAuth.ts:useAuth:1');
    });
  });

  describe('Integration Tests', () => {
    it('should create resolver from CodeGraph instance', async () => {
      // Create a simple TypeScript project
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } })
      );

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      // Create utility file
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}`
      );

      // Create main file that uses utils
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate, parseDate } from './utils';

function processDate(input: string): string {
  const date = parseDate(input);
  return formatDate(date);
}`
      );

      // Initialize and index
      cg = await CodeGraph.init(tempDir, { index: true });

      // Check that resolver detected React framework
      const frameworks = cg.getDetectedFrameworks();
      expect(frameworks).toContain('react');

      // Get stats to verify indexing worked
      const stats = cg.getStats();
      expect(stats.fileCount).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
    });

    it('should resolve references after indexing', async () => {
      // Create a project with references
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        `export function helperFunction(): void {
  console.log('helper');
}`
      );

      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helperFunction } from './helper';

function main(): void {
  helperFunction();
}`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      // Run reference resolution
      const result = cg.resolveReferences();

      // Should have attempted resolution
      expect(result.stats.total).toBeGreaterThanOrEqual(0);
    });

    it('promotes calls→instantiates when target resolves to a class (Python)', async () => {
      // Python has no `new` keyword — `Foo()` is the standard
      // instantiation syntax. Extraction can't tell that apart from
      // a function call without symbol info, so it emits a `calls`
      // ref. Resolution promotes it to `instantiates` once the
      // target is known to be a class.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'app.py'),
        `class UserService:
    def __init__(self):
        self.db = None

def bootstrap():
    return UserService()
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const bootstrap = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'bootstrap');
      expect(bootstrap).toBeDefined();

      const outgoing = cg.getOutgoingEdges(bootstrap!.id);
      const instantiates = outgoing.find((e) => e.kind === 'instantiates');
      expect(instantiates).toBeDefined();
      // Same edge must NOT also appear as a `calls` edge — promotion
      // replaces the kind, doesn't duplicate.
      const callsToUserService = outgoing.filter(
        (e) => e.kind === 'calls' && e.target === instantiates!.target
      );
      expect(callsToUserService).toHaveLength(0);
    });

    // Union chain ported from upstream e922563/e219594 (UPSTREAM_GRAPH_TRIAGE §4.1):
    it('promotes calls→instantiates when target resolves to a C++ union', async () => {
      // `Packet()` value-initializes the union. The extractor emits a calls
      // reference for that expression, so resolution must preserve the
      // class-like promotion that unions received when they were structs.
      fs.writeFileSync(
        path.join(tempDir, 'packet.cpp'),
        `union Packet { unsigned int raw; };

void initialize() { Packet(); }
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const packet = cg.getNodesByKind('union').find((n) => n.name === 'Packet');
      const initialize = cg.getNodesByKind('function').find((n) => n.name === 'initialize');
      expect(packet).toBeDefined();
      expect(initialize).toBeDefined();

      const outgoing = cg.getOutgoingEdges(initialize!.id);
      expect(outgoing.some((e) => e.kind === 'instantiates' && e.target === packet!.id)).toBe(true);
      expect(outgoing.some((e) => e.kind === 'calls' && e.target === packet!.id)).toBe(false);
    });

    it('resolves a static call through an imported C++ union to its member', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'ops.hpp'),
        `union Ops {
  static int run() { return 1; }
};
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'main.cpp'),
        `#include "ops.hpp"

int invoke() { return Ops::run(); }
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const invoke = cg.getNodesByKind('function').find((n) => n.name === 'invoke');
      const run = cg.getNodesByKind('method').find((n) => n.name === 'run');
      expect(invoke).toBeDefined();
      expect(run).toBeDefined();

      const outgoing = cg.getOutgoingEdges(invoke!.id);
      expect(outgoing.some((e) => e.kind === 'calls' && e.target === run!.id)).toBe(true);
    });

    it('resolves Go cross-package qualified calls via go.mod module path (#388)', async () => {
      // Pre-#388, every `pkga.FuncX(...)` call in a Go monorepo was flagged
      // external (isExternalImport returned true for any non-`/internal/`
      // import without `.`-prefix) and resolution fell through to name-match
      // with path proximity — recall on cross-package callers was ~<1%.
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );

      const pkgaDir = path.join(tempDir, 'pkga');
      const pkgbDir = path.join(tempDir, 'pkgb');
      const pkgcDir = path.join(tempDir, 'pkgc');
      fs.mkdirSync(pkgaDir);
      fs.mkdirSync(pkgbDir);
      fs.mkdirSync(pkgcDir);

      // Same-name exported function in two packages — only the imported one
      // should resolve. Exercises disambiguation, not just connectivity.
      fs.writeFileSync(
        path.join(pkgaDir, 'conv.go'),
        'package pkga\nfunc Convert(x int) int { return x * 2 }\n'
      );
      fs.writeFileSync(
        path.join(pkgbDir, 'conv.go'),
        'package pkgb\nfunc Convert(x int) int { return x + 1 }\n'
      );
      fs.writeFileSync(
        path.join(pkgcDir, 'use.go'),
        `package pkgc

import "github.com/example/myproject/pkga"

func UsePkga() {
  pkga.Convert(5)
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const usePkga = cg.getNodesByKind('function').filter((n) => n.name ==='UsePkga')[0];
      expect(usePkga).toBeDefined();

      const outgoing = cg.getOutgoingEdges(usePkga!.id);
      const callEdges = outgoing.filter((e) => e.kind === 'calls');
      expect(callEdges).toHaveLength(1);

      const target = cg.getNode(callEdges[0]!.target);
      expect(target?.name).toBe('Convert');
      // Critical: the resolver must pick the imported pkga's Convert,
      // not pkgb's. With the broken (pre-fix) resolver this lands on
      // whichever Convert happens to be cheaper under path proximity.
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkga/conv.go');
    });

    it('resolves Go aliased imports across packages (#388)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.mkdirSync(path.join(tempDir, 'pkgb'));
      fs.mkdirSync(path.join(tempDir, 'pkgd'));

      fs.writeFileSync(
        path.join(tempDir, 'pkgb', 'lib.go'),
        'package pkgb\nfunc Compute(x int) int { return x }\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'pkgd', 'use.go'),
        `package pkgd

import (
  "fmt"
  alias "github.com/example/myproject/pkgb"
)

func UseAliased() {
  fmt.Println("hi")
  alias.Compute(3)
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const useAliased = cg.getNodesByKind('function').filter((n) => n.name ==='UseAliased')[0];
      expect(useAliased).toBeDefined();
      const calls = cg.getOutgoingEdges(useAliased!.id).filter((e) => e.kind === 'calls');
      // fmt.Println is stdlib — must stay external. alias.Compute must resolve.
      expect(calls).toHaveLength(1);
      const target = cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('Compute');
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkgb/lib.go');
    });

    it('TS type_alias object-shape members resolve method calls (#359)', async () => {
      // Pre-#359, `recorder.stop()` (recorder: RecorderHandle) attached
      // to `StdioMcpClient.stop` in a sibling directory via path-proximity
      // because the type_alias had no `stop` node — only the unrelated
      // class did. Now type_alias produces member nodes (property/method),
      // so the camelCase receiver↔type word overlap pulls the call to
      // `RecorderHandle::stop` instead of the look-alike class.
      fs.mkdirSync(path.join(tempDir, 'voice'));
      fs.mkdirSync(path.join(tempDir, 'codegraph'));

      fs.writeFileSync(
        path.join(tempDir, 'voice', 'recorder.ts'),
        `export type RecorderHandle = {
  wavPath: string;
  stop: () => Promise<{ ok: true }>;
};
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'voice', 'controller.ts'),
        `import type { RecorderHandle } from "./recorder";
export async function finaliseRecording(recorder: RecorderHandle) {
  return await recorder.stop();
}
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'codegraph', 'stdio-client.ts'),
        `export class StdioMcpClient {
  private stopped = false;
  async stop(): Promise<void> { this.stopped = true; }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const handleStop = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'RecorderHandle::stop');
      expect(handleStop).toBeDefined();

      const clientStop = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'StdioMcpClient::stop');
      expect(clientStop).toBeDefined();

      const handleCallers = cg.getIncomingEdges(handleStop!.id).filter((e) => e.kind === 'calls');
      const clientCallers = cg.getIncomingEdges(clientStop!.id).filter((e) => e.kind === 'calls');
      expect(handleCallers.length).toBeGreaterThanOrEqual(1);
      // The class method must have NO callers — voice/'s call must NOT
      // mis-attribute. A non-empty list would mean the false-positive
      // path is still firing.
      expect(clientCallers).toHaveLength(0);

      // Function-typed property surfaces as a `method` node, not `property`,
      // because `stop()` semantics at the call site are method semantics.
      expect(handleStop!.kind).toBe('method');
    });

    it('Java import disambiguates same-name classes across modules (#314)', async () => {
      // Pre-#314 the import resolver had no Java branch at all, so a
      // multi-module Maven repo where `dao/converter/FooConverter` and
      // `service/converter/FooConverter` both export a `convert` method
      // resolved by file-path proximity — picking whichever class was
      // closer to the caller, which is wrong any time the caller lives
      // in an equidistant cross-cutting module.
      const daoDir = path.join(tempDir, 'dao/src/main/java/com/example/dao/converter');
      const serviceDir = path.join(tempDir, 'service/src/main/java/com/example/service/converter');
      const webDir = path.join(tempDir, 'web/src/main/java/com/example/web');
      fs.mkdirSync(daoDir, { recursive: true });
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.mkdirSync(webDir, { recursive: true });

      fs.writeFileSync(
        path.join(daoDir, 'FooConverter.java'),
        `package com.example.dao.converter;
public class FooConverter { public String convert(String x) { return "dao:" + x; } }
`
      );
      fs.writeFileSync(
        path.join(serviceDir, 'FooConverter.java'),
        `package com.example.service.converter;
public class FooConverter { public String convert(String x) { return "svc:" + x; } }
`
      );
      // The caller imports the SERVICE version — even though dao is
      // alphabetically/lexically first in the candidate list, the
      // import must trump that order.
      fs.writeFileSync(
        path.join(webDir, 'Handler.java'),
        `package com.example.web;

import com.example.service.converter.FooConverter;

public class Handler {
  private FooConverter fooConverter;
  public String use() { return fooConverter.convert("input"); }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const use = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'com.example.web::Handler::use');
      expect(use).toBeDefined();
      const calls = cg.getOutgoingEdges(use!.id).filter((e) => e.kind === 'calls');
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const target = cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('convert');
      expect(target?.filePath.replace(/\\/g, '/')).toBe(
        'service/src/main/java/com/example/service/converter/FooConverter.java'
      );
    });

    it('C# extracts references from method/property/field types (#381)', async () => {
      // Pre-#381, every C# project produced ZERO `references` edges:
      // csharp.ts was missing returnField, and the type-leaf walker
      // only recognized TS/Java's `type_identifier` nodes — C# uses
      // `identifier`/`predefined_type`/`qualified_name`/`generic_name`.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'Dtos.cs'),
        `namespace MyApp;
public class SessionInfoDto { public string Id { get; set; } = ""; }
public class UserDto { public string Name { get; set; } = ""; }
`
      );
      fs.writeFileSync(
        path.join(srcDir, 'Service.cs'),
        `using System.Threading.Tasks;
namespace MyApp;
public class DataExporter
{
  public SessionInfoDto Build(UserDto user, SessionInfoDto session) { return session; }
  public Task<SessionInfoDto> BuildAsync(UserDto user) { return Task.FromResult(new SessionInfoDto()); }
  public SessionInfoDto Latest { get; set; } = new();
  private UserDto _cached;
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const sessionDto = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'SessionInfoDto');
      const userDto = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'UserDto');
      expect(sessionDto).toBeDefined();
      expect(userDto).toBeDefined();

      const sessionIncoming = cg
        .getIncomingEdges(sessionDto!.id)
        .filter((e) => e.kind === 'references');
      const userIncoming = cg
        .getIncomingEdges(userDto!.id)
        .filter((e) => e.kind === 'references');

      // SessionInfoDto: Build return, Build param, BuildAsync return (inside Task<>), Latest property.
      // UserDto: Build param, BuildAsync param, _cached field.
      expect(sessionIncoming.length).toBeGreaterThanOrEqual(4);
      expect(userIncoming.length).toBeGreaterThanOrEqual(3);
    });

    it('Go: leaves stdlib calls (fmt.Println, etc.) external', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main

import "fmt"

func main() {
  fmt.Println("hi")
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const mainFn = cg.getNodesByKind('function').filter((n) => n.name ==='main')[0];
      const calls = cg.getOutgoingEdges(mainFn!.id).filter((e) => e.kind === 'calls');
      // No spurious in-project edge — fmt.* must stay unresolved/external.
      expect(calls).toHaveLength(0);
    });
  });

  describe('Name Matcher: kind bias for new ref kinds', () => {
    const baseContext = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => true,
      readFile: () => null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });

    it('prefers a class candidate over a function for `instantiates` refs', () => {
      // A class and a function share a name across the codebase.
      // Without the kind bias, the function (which gets the +25 `calls`
      // bonus historically applied to all candidates of that kind) would
      // win. Now the instantiates branch reverses it.
      const fn: Node = {
        id: 'func:utils.ts:Logger:5', kind: 'function', name: 'Logger',
        qualifiedName: 'utils.ts::Logger', filePath: 'utils.ts', language: 'typescript',
        startLine: 5, endLine: 7, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const cls: Node = {
        id: 'class:logger.ts:Logger:10', kind: 'class', name: 'Logger',
        qualifiedName: 'logger.ts::Logger', filePath: 'logger.ts', language: 'typescript',
        startLine: 10, endLine: 30, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'func:main.ts:bootstrap:1',
        referenceName: 'Logger',
        referenceKind: 'instantiates' as const,
        line: 5, column: 0, filePath: 'main.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([fn, cls]));
      expect(result?.targetNodeId).toBe('class:logger.ts:Logger:10');
    });

    it('prefers a union candidate over a function for `instantiates` refs', () => {
      const fn: Node = {
        id: 'func:packet.cpp:Packet:5', kind: 'function', name: 'Packet',
        qualifiedName: 'packet.cpp::Packet', filePath: 'packet.cpp', language: 'cpp',
        startLine: 5, endLine: 7, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const union: Node = {
        id: 'union:packet.hpp:Packet:10', kind: 'union', name: 'Packet',
        qualifiedName: 'packet.hpp::Packet', filePath: 'packet.hpp', language: 'cpp',
        startLine: 10, endLine: 14, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const ref = {
        fromNodeId: 'func:main.cpp:initialize:1',
        referenceName: 'Packet',
        referenceKind: 'instantiates' as const,
        line: 5, column: 0, filePath: 'main.cpp', language: 'cpp' as const,
      };

      const result = matchReference(ref, baseContext([fn, union]));
      expect(result?.targetNodeId).toBe('union:packet.hpp:Packet:10');
    });

    it('prefers a function candidate over a non-function for `decorates` refs', () => {
      const variable: Node = {
        id: 'var:config.ts:Inject:5', kind: 'variable', name: 'Inject',
        qualifiedName: 'config.ts::Inject', filePath: 'config.ts', language: 'typescript',
        startLine: 5, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const decorator: Node = {
        id: 'func:di.ts:Inject:10', kind: 'function', name: 'Inject',
        qualifiedName: 'di.ts::Inject', filePath: 'di.ts', language: 'typescript',
        startLine: 10, endLine: 20, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'class:svc.ts:UserService:1',
        referenceName: 'Inject',
        referenceKind: 'decorates' as const,
        line: 5, column: 0, filePath: 'svc.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([variable, decorator]));
      expect(result?.targetNodeId).toBe('func:di.ts:Inject:10');
    });
  });

  describe('tsconfig path aliases', () => {
    it('resolves an aliased import to the alias-mapped file (not a same-named file elsewhere)', async () => {
      // Two same-named exports in different directories. Without alias
      // resolution, name-matcher would pick whichever it finds first;
      // with alias resolution, the import path uniquely picks one.
      fs.mkdirSync(path.join(tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/legacy'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/utils/format.ts'),
        `export function pickMe(): number { return 1; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/legacy/format.ts'),
        `export function pickMe(): number { return 99; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { pickMe } from '@utils/format';\nexport function go(): number { return pickMe(); }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['utils/*'] },
          },
        })
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      // The two pickMe nodes live in different files. The aliased
      // import should attach the call edge to the @utils-mapped one,
      // not the legacy duplicate.
      const all = cg.getNodesByKind('function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = cg.getCallers(utilsNode!.id);
      const legacyCallers = cg.getCallers(legacyNode!.id);
      expect(utilsCallers.length).toBeGreaterThan(0);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      // The legacy node should NOT have a caller from src/main.ts —
      // the alias correctly picked the utils version.
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('falls back gracefully when tsconfig is absent', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export function aFn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `import { aFn } from './a';\nexport function bFn(): void { aFn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      // No tsconfig present — index should still complete and the
      // relative-import-based call edge should be created.
      const aFn = cg.getNodesByKind('function').find((n) => n.name === 'aFn');
      expect(aFn).toBeDefined();
      const callers = cg.getCallers(aFn!.id);
      expect(callers.some((c) => c.node.filePath === 'src/b.ts')).toBe(true);
    });
  });

  describe('re-export chain following', () => {
    it('chases a 3-hop barrel chain (wildcard → named → declaration)', async () => {
      // main.ts → all.ts (wildcard) → index.ts (named) → auth.ts (declaration).
      // Without chain following, `signIn` resolves to nothing because
      // none of the barrel files declare it directly.
      fs.mkdirSync(path.join(tempDir, 'src/services'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/services/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/services/index.ts'),
        `export { signIn } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/all.ts'),
        `export * from './services/index';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { signIn } from './all';\nexport function go(): void { signIn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/services/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a renamed named re-export (export { foo as bar } from ...)', async () => {
      // The chase has to look up `foo` in the upstream module even
      // though the importer asked for `bar` — exercises the rename
      // branch of findExportedSymbol.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/index.ts'),
        `export { signIn as login } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { login } from './index';\nexport function go(): void { login(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });
  });

  describe('Batched Resolver Database Regressions', () => {
    let db: DatabaseConnection;
    let queries: QueryBuilder;

    const node = (id: string, name: string, filePath = 'src/test.ts'): Node => ({
      id,
      kind: 'function',
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    const ref = (fromNodeId: string, referenceName: string, line = 1): UnresolvedReference => ({
      fromNodeId,
      referenceName,
      referenceKind: 'calls',
      line,
      column: 1,
      filePath: 'src/test.ts',
      language: 'typescript',
    });

    beforeEach(() => {
      db = DatabaseConnection.initialize(path.join(tempDir, 'resolution.db'));
      queries = new QueryBuilder(db.getDb());
    });

    afterEach(() => {
      db.close();
    });

    it('parks duplicate unresolved tuples as failed and leaves the pending set empty', async () => {
      queries.insertNode(node('source:duplicate', 'caller'));
      queries.insertUnresolvedRefsBatch([
        ref('source:duplicate', 'missing'),
        ref('source:duplicate', 'missing'),
      ]);
      const markFailed = spyOn(queries, 'markReferencesFailed');

      try {
        const result = await createResolver(tempDir, queries).resolveAndPersistBatched(undefined, 1);

        // markReferencesFailed keys on the (fromNodeId, referenceName,
        // referenceKind) tuple, so the first batch's UPDATE parks BOTH
        // identical rows at once — the drain sees one pending row, but both
        // land in failed, which is the state the retry sweep needs.
        expect(result.stats).toMatchObject({ total: 1, resolved: 0, unresolved: 1 });
        expect(markFailed).toHaveBeenCalled();
        // Pending readers no longer see the parked rows…
        expect(queries.getUnresolvedReferencesCount()).toBe(0);
        // …but both stay queryable as failed, with the retry tail written.
        const rows = db.getDb()
          .prepare("SELECT status, name_tail FROM unresolved_refs ORDER BY id")
          .all() as Array<{ status: string; name_tail: string }>;
        expect(rows).toEqual([
          { status: 'failed', name_tail: 'missing' },
          { status: 'failed', name_tail: 'missing' },
        ]);
      } finally {
        markFailed.mockRestore();
      }
    });

    it('processes every unresolvable batch, parking each row as failed', async () => {
      queries.insertNode(node('source:unresolvable', 'caller'));
      queries.insertUnresolvedRefsBatch(
        Array.from({ length: 5 }, (_, index) => ref('source:unresolvable', `missing${index}`, index + 1))
      );
      const progress: Array<[number, number]> = [];

      const result = await createResolver(tempDir, queries).resolveAndPersistBatched(
        (current, total) => progress.push([current, total]),
        2
      );

      // The #1187 regression pin: an all-unresolvable first batch must not
      // stop the drain — every batch is consumed (parked failed), not deleted.
      expect(progress).toEqual([[2, 5], [4, 5], [5, 5]]);
      expect(result.stats).toMatchObject({ total: 5, resolved: 0, unresolved: 5 });
      expect(queries.getUnresolvedReferencesCount()).toBe(0);
      const parked = db.getDb()
        .prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE status = 'failed'")
        .get() as { n: number };
      expect(parked.n).toBe(5);
    });

    it('persists mixed results across resolution and persistence chunk boundaries', async () => {
      queries.insertNodes([
        node('source:mixed', 'caller'),
        node('target:alpha', 'alpha', 'src/targets.ts'),
        node('target:beta', 'beta', 'src/targets.ts'),
        node('target:gamma', 'gamma', 'src/targets.ts'),
      ]);
      queries.insertUnresolvedRefsBatch([
        ref('source:mixed', 'alpha', 1),
        ref('source:mixed', 'missingA', 2),
        ref('source:mixed', 'beta', 3),
        ref('source:mixed', 'missingB', 4),
        ref('source:mixed', 'gamma', 5),
      ]);
      const insertEdges = spyOn(queries, 'insertEdges');
      const deleteByIds = spyOn(queries, 'deleteUnresolvedReferencesByIds');
      const markFailed = spyOn(queries, 'markReferencesFailed');

      try {
        const result = await createResolver(tempDir, queries).resolveAndPersistBatched(
          undefined,
          4,
          undefined,
          2
        );

        expect(insertEdges.mock.calls.map((call) => call[0].length)).toEqual([2, 1]);
        // Resolved rows are deleted (persistence chunks of 2); the
        // unresolvable rows are parked as failed instead (#1240).
        expect(deleteByIds.mock.calls.map((call) => call[0].length)).toEqual([2, 1]);
        expect(markFailed.mock.calls.map((call) => call[0].length)).toEqual([2]);
        expect(result.stats).toMatchObject({ total: 5, resolved: 3, unresolved: 2 });
        expect(queries.getOutgoingEdges('source:mixed', ['calls']).map((edge) => edge.target).sort()).toEqual([
          'target:alpha',
          'target:beta',
          'target:gamma',
        ]);
        expect(queries.getUnresolvedReferencesCount()).toBe(0);
        const parked = db.getDb()
          .prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE status = 'failed'")
          .get() as { n: number };
        expect(parked.n).toBe(2);
      } finally {
        insertEdges.mockRestore();
        deleteByIds.mockRestore();
        markFailed.mockRestore();
      }
    });

    it('falls back to tuple deletion for ID-less unresolved references', () => {
      queries.insertNodes([
        node('source:idless', 'caller'),
        node('target:idless', 'target', 'src/target.ts'),
      ]);
      const unresolved = ref('source:idless', 'target');
      queries.insertUnresolvedRef(unresolved);
      const deleteByIds = spyOn(queries, 'deleteUnresolvedReferencesByIds');
      const deleteByTuple = spyOn(queries, 'deleteSpecificResolvedReferences');

      try {
        const result = createResolver(tempDir, queries).resolveAndPersist([unresolved]);

        expect(result.stats).toMatchObject({ total: 1, resolved: 1, unresolved: 0 });
        expect(deleteByIds).not.toHaveBeenCalled();
        expect(deleteByTuple).toHaveBeenCalledWith([
          { fromNodeId: 'source:idless', referenceName: 'target', referenceKind: 'calls' },
        ]);
        expect(queries.getUnresolvedReferences()).toEqual([]);
        expect(queries.getOutgoingEdges('source:idless', ['calls'])).toHaveLength(1);
      } finally {
        deleteByIds.mockRestore();
        deleteByTuple.mockRestore();
      }
    });

    it('rejects invalid resolution and persistence batch sizes', async () => {
      const resolver = createResolver(tempDir, queries);

      await expect(resolver.resolveAndPersistBatched(undefined, 0)).rejects.toThrow(
        'batchSize must be a positive integer'
      );
      await expect(resolver.resolveAndPersistBatched(undefined, 1.5)).rejects.toThrow(
        'batchSize must be a positive integer'
      );
      await expect(resolver.resolveAndPersistBatched(undefined, 1, undefined, 0)).rejects.toThrow(
        'persistenceChunkSize must be a positive integer'
      );
      await expect(resolver.resolveAndPersistBatched(undefined, 1, undefined, Number.NaN)).rejects.toThrow(
        'persistenceChunkSize must be a positive integer'
      );
    });
  });

  describe('C/C++ Import Resolution', () => {
    afterEach(() => {
      clearCppIncludeDirCache();
    });

    it('should resolve C include to header in same directory', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils.h', 'main.c'],
      };

      const result = resolveImportPath(
        'utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils.h');
    });

    it('should resolve C++ include with .hpp extension', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myclass.hpp',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should resolve include with subdirectory path', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils/helpers.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils/helpers.h', 'main.c'],
      };

      const result = resolveImportPath(
        'utils/helpers.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils/helpers.h');
    });

    it('should resolve include via include directories', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myheader.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myheader.h', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myheader.h',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myheader.h');
    });

    it('should resolve include trying multiple extensions', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        // myclass.h does not exist, but myclass.hpp does
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myclass',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should return null for system headers', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };

      // C standard library header
      expect(resolveImportPath('stdio.h', 'main.c', 'c', context)).toBeNull();
      // C++ standard library header
      expect(resolveImportPath('vector', 'main.cpp', 'cpp', context)).toBeNull();
      // C++ C-wrapper header
      expect(resolveImportPath('cstdio', 'main.cpp', 'cpp', context)).toBeNull();
    });

    it('should return null for single-component third-party paths that cannot be resolved', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getCppIncludeDirs: () => [],
      };

      // Third-party bare header without path — not resolvable, returns null
      const result = resolveImportPath(
        'openssl/ssl.h',
        'main.cpp',
        'cpp',
        context
      );

      expect(result).toBeNull();
    });

    it('should not filter project headers with path separators', () => {
      const context: ResolutionContext = {
        ...baseContext,
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'mylib/utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['mylib/utils.h'],
      };

      // Path with separator should NOT be filtered as external
      const result = resolveImportPath(
        'mylib/utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('mylib/utils.h');
    });

    it('should extract C/C++ import mappings from #include directives', () => {
      const code = `#include <iostream>
#include "myheader.h"
#include "utils/helpers.hpp"`;

      const mappings = extractImportMappings('main.cpp', code, 'cpp');

      expect(mappings.length).toBe(3);
      expect(mappings[0]).toEqual({
        localName: 'iostream',
        exportedName: '*',
        source: 'iostream',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[1]).toEqual({
        localName: 'myheader',
        exportedName: '*',
        source: 'myheader.h',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[2]).toEqual({
        localName: 'helpers',
        exportedName: '*',
        source: 'utils/helpers.hpp',
        isDefault: false,
        isNamespace: true,
      });
    });

    it('should discover include directories from compile_commands.json', () => {
      // Create a temp project with compile_commands.json
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        const compileDb = [
          {
            directory: tempProject,
            command: 'g++ -Iinclude -Isrc/lib -isystem /usr/include -c src/main.cpp',
            file: 'src/main.cpp',
          },
        ];
        fs.writeFileSync(
          path.join(tempProject, 'compile_commands.json'),
          JSON.stringify(compileDb)
        );
        // Create the include dirs so they exist
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src', 'lib'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Should find include and src/lib (relative to project root)
        // /usr/include is absolute and outside project, should be excluded
        expect(dirs).toContain('include');
        expect(dirs).toContain('src/lib');
        expect(dirs.some(d => d.includes('usr'))).toBe(false);
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    it('should fall back to heuristic include dirs when no compile_commands.json', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // Create include/ and src/ directories with headers
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'include', 'types.h'), '');
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'src', 'main.cpp'), '');
        // Create a directory without headers — should not be included
        fs.mkdirSync(path.join(tempProject, 'docs'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        expect(dirs).toContain('include');
        expect(dirs).toContain('src');
        expect(dirs).not.toContain('docs');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // Documents the cross-language `.h` behavior. Objective-C and C++ share
    // the `.h` extension, so in a mixed iOS-style project an Obj-C header
    // dir gets claimed as a C/C++ include dir too. That's intentional — a
    // C++ file legitimately can `#include "Foo.h"` against an Obj-C header
    // (Obj-C++ / .mm callers), and false-positive inclusion is far cheaper
    // than missing real resolutions. The test pins this so a later
    // "exclude objc dirs" refactor breaks loudly and reviewers see the
    // trade-off explicitly.
    it('heuristic claims any top-level dir containing .h files, including Obj-C', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // C++ side: an `cppmod` dir with a .hpp (C++-only extension)
        fs.mkdirSync(path.join(tempProject, 'cppmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'cppmod', 'shared.hpp'), '');
        // Obj-C side: an `iosmod` dir with .h + .m (no .cpp/.hpp).
        fs.mkdirSync(path.join(tempProject, 'iosmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.h'), '');
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.m'), '');

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Both included — Obj-C dirs are intentionally allowed.
        expect(dirs).toContain('cppmod');
        expect(dirs).toContain('iosmod');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // End-to-end: ensure `#include "X.h"` produces a file→file `imports` edge
    // in the actual indexing pipeline (not just a phantom file→import-node
    // edge). This pins the include-dir resolution path so the headline PR
    // feature can't silently regress to a no-op in the indexing flow.
    it('connects #include to the real header file via include-dir scan (end-to-end)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-e2e-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'include', 'utils.h'),
          `#ifndef UTILS_H\n#define UTILS_H\nint add(int, int);\n#endif\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'src', 'main.cpp'),
          `#include "utils.h"\n#include <vector>\nint main(){ return add(1,2); }\n`
        );

        clearCppIncludeDirCache();
        cg = await CodeGraph.init(tempProject, { index: true });

        // Sanity: file nodes exist for the header and the cpp.
        const allFiles = cg.getStats();
        expect(allFiles.fileCount).toBe(2);

        // The `#include "utils.h"` edge should target the real
        // `include/utils.h` file node — not a floating `import` node
        // living inside main.cpp.
        const db = DatabaseConnection.open(getDatabasePath(tempProject));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'src/main.cpp'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        const resolvedToHeader = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath === 'include/utils.h'
        );
        expect(resolvedToHeader, 'main.cpp → include/utils.h imports edge missing').toBeDefined();
        // `<vector>` should NOT produce a file edge — it's a stdlib header.
        const stdlibFile = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath && r.dstPath.endsWith('vector')
        );
        expect(stdlibFile).toBeUndefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });

  describe('Evidence-class arbitration', () => {
    it('prefers an import candidate over an exact-match candidate for the same name', async () => {
      // Both src/lib.ts and src/dupe.ts declare formatDate, so the name-matcher
      // produced an exact-match candidate as well — the import evidence class
      // must still win the arbitration.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'lib.ts'),
        `export function formatDate(date: Date): string { return date.toISOString(); }\n`
      );
      fs.writeFileSync(
        path.join(srcDir, 'dupe.ts'),
        `export function formatDate(): string { return 'dupe'; }\n`
      );
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate } from './lib';\nexport function test(): void { formatDate(new Date()); }\n`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();
      const mainFn = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'test' && n.filePath === 'src/main.ts');
      expect(mainFn).toBeDefined();
      const calls = cg.getOutgoingEdges(mainFn!.id).filter((e) => e.kind === 'calls');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.metadata?.resolvedBy).toBe('import');
      expect(cg.getNode(calls[0]!.target)?.filePath.replace(/\\/g, '/')).toBe('src/lib.ts');
    });

    it('breaks same-rank ties by preferring a target in the reference source file', () => {
      const db = DatabaseConnection.initialize(path.join(tempDir, 'arbitration.db'));
      try {
        const queries = new QueryBuilder(db.getDb());
        const resolver = new ReferenceResolver(tempDir, queries);
        const other = {
          id: 'func:lib/other.ts:WidgetA:1', kind: 'function' as const, name: 'WidgetA',
          qualifiedName: 'lib/other.ts::WidgetA', filePath: 'lib/other.ts', language: 'typescript' as const,
          startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
        };
        const sameFile = {
          id: 'func:app.ts:WidgetB:1', kind: 'function' as const, name: 'WidgetB',
          qualifiedName: 'app.ts::WidgetB', filePath: 'app.ts', language: 'typescript' as const,
          startLine: 1, endLine: 2, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
        };
        queries.insertNode(other);
        queries.insertNode(sameFile);

        // Two framework resolvers produce same-rank ('framework') candidates;
        // the tie-break must pick the target living in the ref's own file.
        const stub = (targetNodeId: string): FrameworkResolver => ({
          name: 'stub',
          detect: () => true,
          claimsReference: (name) => name === 'app.WidgetMethod',
          resolve: (ref) =>
            ref.referenceName === 'app.WidgetMethod'
              ? { original: ref, targetNodeId, resolvedBy: 'framework' }
              : null,
        });
        (resolver as unknown as { frameworks: FrameworkResolver[] }).frameworks = [
          stub(other.id),
          stub(sameFile.id),
        ];

        // Name path: 'app.WidgetMethod' is claimed by the stubs but has no
        // matching node or qualified name, so name-matcher stays out of the
        // race — the candidates array holds exactly the two framework hits.
        const result = resolver.resolveOne({
          fromNodeId: 'func:app.ts:caller:1',
          referenceName: 'app.WidgetMethod',
          referenceKind: 'calls',
          line: 1,
          column: 0,
          filePath: 'app.ts',
          language: 'typescript',
        });
        expect(result?.targetNodeId).toBe(sameFile.id);
      } finally {
        db.close();
      }
    });
  });

  describe('Parameter annotation extraction (params_json)', () => {
    it('stores typed parameter pairs on function nodes and skips destructuring/rest params', async () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'queue.ts'),
        `export function drain(q: Queue, done: Promise<number>, { timeout }: Options, ...rest: Item[]): number {
  return q.push() + timeout + rest.length;
}

export class Queue {
  push(): number { return 1; }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const drain = cg.getNodesByKind('function').find((n) => n.name === 'drain');
      expect(drain).toBeDefined();
      // Identifier-bound params only: destructuring and rest patterns skipped;
      // generic type text kept raw for the resolver's simple-name gate.
      expect(drain!.params).toEqual([
        { name: 'q', type: 'Queue' },
        { name: 'done', type: 'Promise<number>' },
      ]);
      // getNode round-trips through rowToNode — proves params_json persistence.
      expect(cg.getNode(drain!.id)?.params).toEqual(drain!.params);

      const db = DatabaseConnection.open(getDatabasePath(tempDir));
      try {
        const row = db
          .getDb()
          .prepare('SELECT params_json FROM nodes WHERE id = ?')
          .get(drain!.id) as { params_json: string | null };
        expect(JSON.parse(row.params_json!)).toEqual([{ n: 'q', t: 'Queue' }, { n: 'done', t: 'Promise<number>' }]);

        // End-to-end: the annotation-typed receiver binds q.push → Queue.push.
        const edgeRows = db
          .getDb()
          .prepare(
            `select src.qualified_name as srcQn from edges e
             join nodes src on e.source = src.id
             join nodes dst on e.target = dst.id
             where e.kind = 'calls' and dst.name = 'push' and src.id = ?`,
          )
          .all(drain!.id) as Array<{ srcQn: string }>;
        expect(edgeRows).toHaveLength(1);
      } finally {
        db.close();
      }
    });
  });
});
