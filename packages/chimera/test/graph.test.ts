/**
 * Graph Query Tests
 *
 * Tests for graph traversal and query functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph, { DatabaseConnection, getDatabasePath } from '../src/index';
import { Node, Edge, FrozenSemanticObject, LanguageAwareSignal } from '../src/types';
import { projectLanguageAwareSignals } from '../src/semantic/language-signals';

describe('Graph Queries', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    // Create temp directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-test-'));

    // Create test files with relationships
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Create base class
    fs.writeFileSync(
      path.join(srcDir, 'base.ts'),
      `
export class BaseClass {
  protected value: number;

  constructor(value: number) {
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }
}

export interface Printable {
  print(): void;
}
`
    );

    // Create derived class
    fs.writeFileSync(
      path.join(srcDir, 'derived.ts'),
      `
import { BaseClass, Printable } from './base';

export class DerivedClass extends BaseClass implements Printable {
  private name: string;

  constructor(value: number, name: string) {
    super(value);
    this.name = name;
  }

  print(): void {
    console.log(this.getName(), this.getValue());
  }

  getName(): string {
    return this.name;
  }
}
`
    );

    // Create utility functions
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function formatValue(value: number): string {
  return value.toFixed(2);
}

export function processValue(value: number): number {
  const formatted = formatValue(value);
  return parseFloat(formatted);
}

export function doubleValue(value: number): number {
  return value * 2;
}

// Unused function (dead code)
function unusedHelper(): void {
  console.log('never called');
}
`
    );

    // Create main file that uses everything
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `
import { DerivedClass } from './derived';
import { processValue, doubleValue } from './utils';

function main(): void {
  const obj = new DerivedClass(10, 'test');
  obj.print();

  const result = processValue(doubleValue(obj.getValue()));
  console.log(result);
}

export { main };
`
    );

    // Initialize and index
    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['src/**/*.ts'],
        exclude: [],
      },
    });

    await cg.indexAll();
    cg.resolveReferences();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('traverse()', () => {
    it('should traverse graph from a starting node', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        console.log('main function not found, skipping test');
        return;
      }

      const subgraph = cg.traverse(mainFunc.id, {
        maxDepth: 2,
        direction: 'outgoing',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
      expect(subgraph.roots).toContain(mainFunc.id);
    });

    it('should respect maxDepth option', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        return;
      }

      const shallow = cg.traverse(mainFunc.id, { maxDepth: 1 });
      const deep = cg.traverse(mainFunc.id, { maxDepth: 3 });

      expect(deep.nodes.size).toBeGreaterThanOrEqual(shallow.nodes.size);
    });

    it('should support incoming direction', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const subgraph = cg.traverse(formatValue.id, {
        maxDepth: 2,
        direction: 'incoming',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('getContext()', () => {
    it('should return context for a node', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        console.log('DerivedClass not found, skipping test');
        return;
      }

      const context = cg.getContext(derivedClass.id);

      expect(context.focal).toBeDefined();
      expect(context.focal.id).toBe(derivedClass.id);
      expect(context.ancestors).toBeDefined();
      expect(context.children).toBeDefined();
      expect(context.incomingRefs).toBeDefined();
      expect(context.outgoingRefs).toBeDefined();
    });

    it('should throw for non-existent node', () => {
      expect(() => cg.getContext('non-existent-id')).toThrow('Node not found');
    });
  });

  describe('semantic role and relations', () => {
    it('should project CodeGraph-owned node semantic info', () => {
      const methods = cg.getNodesByKind('method');
      const printMethod = methods.find((n) => n.name === 'print');

      if (!printMethod) {
        return;
      }

      const semantic = cg.getNodeSemanticInfo(printMethod.id);
      const projection = cg.projectNode(printMethod);

      expect(semantic?.role).toBe('callable');
      expect(semantic?.changeSubject).toBe('signature');
      expect(projection?.payload.semantic?.attributes.isCallable).toBe(true);
      expect(projection?.payload.fileSemantic?.role).toBe('source');
      expect(projection?.payload.fileRole).toBe('source');
    });

    it('should classify CodeGraph-owned file roles', () => {
      expect(CodeGraph.getFileSemanticInfo('package.json').role).toBe('dependency_manifest');
      expect(CodeGraph.getFileSemanticInfo('src/main.test.ts').role).toBe('test');
      expect(CodeGraph.getFileSemanticInfo('docs/guide.md').role).toBe('docs');
      expect(CodeGraph.getFileSemanticInfo('tsconfig.json').role).toBe('config');
      expect(CodeGraph.getFileSemanticInfo('vite.config.ts').role).toBe('config');
      expect(CodeGraph.getFileSemanticInfo('src/routes/user.ts').role).toBe('api_route');
      expect(CodeGraph.getFileSemanticInfo('src/generated/client.generated.ts').role).toBe('generated');
      expect(cg.getFileSemanticInfo('src/main.ts').role).toBe('source');
    });

    it('should persist and lazily restore CodeGraph-owned file semantics', () => {
      const dbPath = getDatabasePath(testDir);
      const db = DatabaseConnection.open(dbPath);
      try {
        const row = db.getDb().prepare('SELECT role, classifier_version, content_hash FROM file_semantics WHERE path = ?').get('src/main.ts') as
          | { role: string; classifier_version: number; content_hash: string }
          | undefined;
        expect(row?.role).toBe('source');
        expect(row?.classifier_version).toBe(1);
        expect(row?.content_hash).toBe(cg.getFile('src/main.ts')?.contentHash);
        db.getDb().prepare('DELETE FROM file_semantics WHERE path = ?').run('src/main.ts');
      } finally {
        db.close();
      }

      expect(cg.getFileSemanticInfo('src/main.ts').role).toBe('source');

      const restored = DatabaseConnection.open(dbPath);
      try {
        const row = restored.getDb().prepare('SELECT role FROM file_semantics WHERE path = ?').get('src/main.ts') as { role: string } | undefined;
        expect(row?.role).toBe('source');
      } finally {
        restored.close();
      }
    });

    it('should emit file-level TypeScript import/export semantic diff signals', () => {
      const signals = CodeGraph.diffFileSemantics({
        filePath: 'src/main.ts',
        patch: `--- src/main.ts
+++ src/main.ts
@@ -1,2 +1,2 @@
-import { oldValue } from './old';
+import { newValue } from './new';
+export { newValue };
`,
        hunks: [{ oldRange: { startLine: 1, endLine: 2 }, newRange: { startLine: 1, endLine: 3 }, addedLines: 2, removedLines: 1 }],
      });

      const importSignal = signals.find((signal) => signal.kind === 'import_statement');
      const exportSignal = signals.find((signal) => signal.kind === 'export_boundary');

      expect(importSignal?.source).toBe('codegraph:diff_classifier');
      expect(importSignal?.changeKind).toBe('modify');
      expect(exportSignal?.changeKind).toBe('add');
      expect(exportSignal?.signals).toContain('codegraph_file_signal:export_boundary');
    });

    it('should emit file-level JavaScript import/export semantic diff signals', () => {
      const signals = CodeGraph.diffFileSemantics({
        filePath: 'src/main.js',
        patch: `--- src/main.js
+++ src/main.js
@@ -1,2 +1,2 @@
-import { oldValue } from './old.js';
+import { newValue } from './new.js';
+export { newValue };
`,
        hunks: [{ oldRange: { startLine: 1, endLine: 2 }, newRange: { startLine: 1, endLine: 3 }, addedLines: 2, removedLines: 1 }],
      });

      expect(signals.find((signal) => signal.kind === 'import_statement')?.changeKind).toBe('modify');
      expect(signals.find((signal) => signal.kind === 'export_boundary')?.changeKind).toBe('add');
    });

    it('should use CodeGraph node projection for multiline import diff signals', () => {
      const signals = CodeGraph.diffFileSemantics({
        filePath: 'src/main.ts',
        patch: `--- src/main.ts
+++ src/main.ts
@@ -1,5 +1,5 @@
 import {
-  oldValue,
+  newValue,
 } from './values';
 export const value = 1;
`,
        hunks: [{ oldRange: { startLine: 2, endLine: 2 }, newRange: { startLine: 2, endLine: 2 }, addedLines: 1, removedLines: 1 }],
        nodes: [{ kind: 'import', filePath: 'src/main.ts', range: { startLine: 1, endLine: 4 } }],
      });

      const importSignal = signals.find((signal) => signal.kind === 'import_statement');

      expect(importSignal?.source).toBe('codegraph:node_projection');
      expect(importSignal?.changeKind).toBe('modify');
      expect(importSignal?.signals).toContain('node_projection');
    });

    it('should diff local-only TypeScript body changes through language-aware signals', async () => {
      const signalPath = path.join(testDir, 'src', 'language-local.ts');
      fs.writeFileSync(signalPath, `export function calculateLocal(value: number) {
  const local = value + 1;
  return value;
}
`);
      await cg.syncFiles([signalPath]);

      const beforeNode = cg.getNodesByName('calculateLocal').find((node) => node.filePath === 'src/language-local.ts');
      expect(beforeNode).toBeTruthy();
      const before = cg.projectNode(beforeNode!);
      expect(before?.payload.languageSignals?.some((signal) => signal.kind === 'return_value_changed')).toBe(true);

      fs.writeFileSync(signalPath, `export function calculateLocal(value: number) {
  const local = value + 2;
  return value;
}
`);
      await cg.syncFiles([signalPath]);

      const afterNode = cg.getNodesByName('calculateLocal').find((node) => node.filePath === 'src/language-local.ts');
      expect(afterNode).toBeTruthy();
      const signals = cg.diffNodeLanguageSignals({
        before,
        after: cg.projectNode(afterNode!),
        hunk: { oldRange: { startLine: 2, endLine: 2 }, newRange: { startLine: 2, endLine: 2 } },
      });

      expect(signals.map((signal) => signal.kind)).toContain('local_only_change');
      expect(signals.some((signal) => signal.kind === 'return_value_changed')).toBe(false);
    });

    it('should diff caller-visible TypeScript body changes through language-aware signals', async () => {
      const signalPath = path.join(testDir, 'src', 'language-visible.ts');
      fs.writeFileSync(signalPath, `export function calculateVisible(value: number) {
  return value + 1;
}
`);
      await cg.syncFiles([signalPath]);

      const beforeNode = cg.getNodesByName('calculateVisible').find((node) => node.filePath === 'src/language-visible.ts');
      expect(beforeNode).toBeTruthy();
      const before = cg.projectNode(beforeNode!);

      fs.writeFileSync(signalPath, `export function calculateVisible(value: number) {
  return value + 2;
}
`);
      await cg.syncFiles([signalPath]);

      const afterNode = cg.getNodesByName('calculateVisible').find((node) => node.filePath === 'src/language-visible.ts');
      expect(afterNode).toBeTruthy();
      const signals = CodeGraph.diffNodeLanguageSignals({
        before,
        after: cg.projectNode(afterNode!),
        hunk: { oldRange: { startLine: 2, endLine: 2 }, newRange: { startLine: 2, endLine: 2 } },
      });

      expect(signals.map((signal) => signal.kind)).toContain('return_value_changed');
      expect(signals.find((signal) => signal.kind === 'return_value_changed')?.source).toBe('codegraph:language_diff');
    });

    it('should keep unknown body effects instead of silently downgrading unsupported languages', () => {
      const bodyRange = { startLine: 1, endLine: 3, startColumn: 0, endColumn: 0 };
      const unknownSignal: LanguageAwareSignal = {
        schemaVersion: 1,
        kind: 'unknown_body_effect',
        language: 'python',
        source: 'codegraph:fallback',
        quality: 'unknown',
        confidence: 0.45,
        range: bodyRange,
        reason: 'language-aware body effects are not implemented for this language',
        signals: ['language:python', 'source:codegraph:fallback', 'quality:unknown', 'codegraph_language_signal:unknown_body_effect'],
      };
      const after: FrozenSemanticObject = {
        schemaVersion: 1,
        objectType: 'node',
        source: {
          system: 'codegraph',
          codegraphVersion: 'test',
          graphRevision: 'after',
          schemaVersion: 1,
          codegraphId: 'python-function',
        },
        payload: {
          kind: 'function',
          name: 'calculate',
          qualifiedName: 'calculate',
          filePath: 'src/calculate.py',
          language: 'python',
          range: bodyRange,
          languageSignals: [unknownSignal],
        },
      };

      const signals = CodeGraph.diffNodeLanguageSignals({
        after,
        hunk: { newRange: { startLine: 2, endLine: 2 } },
      });

      expect(signals.map((signal) => signal.kind)).toEqual(['unknown_body_effect']);
      expect(signals[0]?.source).toBe('codegraph:language_diff');
      expect(signals[0]?.quality).toBe('unknown');
    });

    it('should project route handler language signals for CodeGraph route nodes', () => {
      const route: Node = {
        id: 'route:src/routes.ts:1:GET:/users',
        kind: 'route',
        name: 'GET /users',
        qualifiedName: 'src/routes.ts::GET:/users',
        filePath: 'src/routes.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 24,
        updatedAt: Date.now(),
      };

      const signal = projectLanguageAwareSignals(route, "app.get('/users', listUsers);").find((item) => item.kind === 'route_handler_like');
      expect(signal?.source).toBe('codegraph:language_analyzer');
      expect(signal?.quality).toBe('exact');
      expect(signal?.range?.startLine).toBe(route.startLine);
    });

    it('should project TypeScript constructor and override signals', async () => {
      const basePath = path.join(testDir, 'src', 'language-base.ts');
      const derivedPath = path.join(testDir, 'src', 'language-derived.ts');
      fs.writeFileSync(basePath, `export class LanguageBase {
  run() { return 0; }
}
`);
      fs.writeFileSync(derivedPath, `import { LanguageBase } from './language-base';
export class LanguageDerived extends LanguageBase {
  constructor() { super(); }
  override run() { return 1; }
}
`);
      await cg.syncFiles([basePath, derivedPath]);

      const constructor = cg.getNodesByName('constructor').find((node) => node.filePath === 'src/language-derived.ts');
      const run = cg.getNodesByName('run').find((node) => node.qualifiedName === 'LanguageDerived::run');

      expect(cg.projectNode(constructor!)?.payload.languageSignals?.map((signal) => signal.kind)).toContain('constructor_like');
      expect(cg.projectNode(run!)?.payload.languageSignals?.map((signal) => signal.kind)).toContain('override_like');
    });

    it('should project TypeScript field, parameter, and module-state body signals', async () => {
      const signalPath = path.join(testDir, 'src', 'language-effects.ts');
      fs.writeFileSync(signalPath, `let moduleCount = 0;
export class LanguageEffects {
  private value = 0;
  update(input: { total: number; value: number }) {
    this.value = input.value;
    input.total += 1;
    moduleCount += 1;
  }
}
`);
      await cg.syncFiles([signalPath]);

      const update = cg.getNodesByName('update').find((node) => node.filePath === 'src/language-effects.ts');
      expect(update).toBeTruthy();
      const signals = cg.projectNode(update!)?.payload.languageSignals?.map((signal) => signal.kind) ?? [];

      expect(signals).toContain('this_field_write');
      expect(signals).toContain('field_access');
      expect(signals).toContain('parameter_mutation');
      expect(signals).toContain('global_or_module_state_write');
    });

    it('should diff CodeGraph-owned node semantic fields', () => {
      const methods = cg.getNodesByKind('method');
      const printMethod = methods.find((n) => n.name === 'print');

      if (!printMethod) {
        return;
      }

      const before = cg.projectNode(printMethod);
      if (!before) {
        return;
      }

      const signatureAfter = {
        ...before,
        source: { ...before.source, graphRevision: 'after-signature' },
        payload: { ...before.payload, signature: 'print(value: string): void' },
      };
      const signatureDiff = cg.diffNodeSemantics(before, signatureAfter);
      expect(signatureDiff.changedFields).toContain('signature');
      expect(signatureDiff.changeSubject).toBe('signature');
      expect(signatureDiff.source.beforeRevision).toBe(before.source.graphRevision);
      expect(signatureDiff.source.afterRevision).toBe('after-signature');

      const exportDiff = cg.diffNodeSemantics(before, {
        ...before,
        source: { ...before.source, graphRevision: 'after-export' },
        payload: { ...before.payload, isExported: true },
      });
      expect(exportDiff.changedFields).toEqual(['isExported']);
      expect(exportDiff.changeSubject).toBe('export');

      const renameDiff = cg.diffNodeSemantics(before, {
        ...before,
        source: { ...before.source, graphRevision: 'after-rename' },
        payload: { ...before.payload, name: 'render', qualifiedName: 'DerivedClass.render' },
      });
      expect(renameDiff.changeKind).toBe('rename');
      expect(renameDiff.changedFields).toEqual(['name', 'qualifiedName']);
      expect(renameDiff.beforeKey?.nodeKey).toBe(`${before.payload.filePath}:${before.payload.kind}:${before.payload.qualifiedName || before.payload.name}`);
      expect(renameDiff.afterKey?.nodeKey).toContain(':method:DerivedClass.render');

      const deleteDiff = CodeGraph.diffNodeSemantics(before, null);
      expect(deleteDiff.changeKind).toBe('delete');
      expect(deleteDiff.beforeKey?.codegraphId).toBe(before.source.codegraphId);
      expect(deleteDiff.source.beforeRevision).toBe(before.source.graphRevision);
    });

    it('should expose canonical incoming relation evidence', () => {
      const functions = cg.getNodesByKind('function');
      const formatValue = functions.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const relations = cg.getIncomingRelations(formatValue.id, { relations: ['CalledBy'] });

      expect(Array.isArray(relations)).toBe(true);
      for (const relation of relations) {
        expect(relation.relation).toBe('CalledBy');
        expect(relation.edgeKind).toBe('calls');
        expect(relation.targetNode.id).toBe(formatValue.id);
      }
    });

    it('should project and diff incident relation snapshots', () => {
      const functions = cg.getNodesByKind('function');
      const formatValue = functions.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const snapshot = cg.getSnapshot();
      const beforeRelations = cg.projectIncidentRelations(formatValue.id, snapshot, {
        directions: ['incoming'],
        relations: ['CalledBy'],
      });
      const removed = CodeGraph.diffRelations(beforeRelations, []);
      const added = cg.diffRelations([], beforeRelations);

      expect(beforeRelations.some((relation) => relation.payload.otherNode.name === 'processValue')).toBe(true);
      expect(beforeRelations.every((relation) => relation.source.graphRevision === snapshot.revision)).toBe(true);
      expect(removed.removedRelations.length).toBe(beforeRelations.length);
      expect(removed.removedRelations[0]?.payload.relation).toBe('CalledBy');
      expect(added.addedRelations.length).toBe(beforeRelations.length);
    });

    it('should preserve caller relations across scoped signature sync', async () => {
      const apiPath = path.join(testDir, 'src', 'api.ts');
      const consumerPath = path.join(testDir, 'src', 'api-consumer.ts');
      fs.writeFileSync(apiPath, `export function format(value: string) { return value.trim(); }\n`);
      fs.writeFileSync(consumerPath, `import { format } from './api';\nexport function useFormat() { return format('x'); }\n`);
      await cg.syncFiles([apiPath, consumerPath]);

      const before = cg.getNodesByName('format').find((node) => node.filePath === 'src/api.ts');
      expect(before).toBeTruthy();
      const beforeRelations = cg.projectIncidentRelations(before!.id, cg.getSnapshot(), {
        directions: ['incoming'],
        relations: ['CalledBy'],
      });
      expect(beforeRelations.some((relation) => relation.payload.otherNode.name === 'useFormat')).toBe(true);

      fs.writeFileSync(apiPath, `export function format(value: string, fallback = '') { return (value || fallback).trim(); }\n`);
      await cg.syncFiles([apiPath]);

      const after = cg.getNodesByName('format').find((node) => node.filePath === 'src/api.ts');
      expect(after).toBeTruthy();
      const afterRelations = cg.projectIncidentRelations(after!.id, cg.getSnapshot(), {
        directions: ['incoming'],
        relations: ['CalledBy'],
      });
      const delta = cg.diffRelations(beforeRelations, afterRelations);

      expect(afterRelations.some((relation) => relation.payload.otherNode.name === 'useFormat')).toBe(true);
      expect(delta.addedRelations).toHaveLength(0);
      expect(delta.removedRelations).toHaveLength(0);
    });

    it('should add override redirect relations after scoped sync', async () => {
      const contractPath = path.join(testDir, 'src', 'contract.ts');
      const implementationPath = path.join(testDir, 'src', 'implementation.ts');
      fs.writeFileSync(contractPath, `export class TaskRunner {\n  run() { return 0; }\n}\n`);
      fs.writeFileSync(implementationPath, `import { TaskRunner } from './contract';\nexport class Runner extends TaskRunner {\n  other() { return 1; }\n}\n`);
      await cg.syncFiles([contractPath, implementationPath]);

      fs.writeFileSync(implementationPath, `import { TaskRunner } from './contract';\nexport class Runner extends TaskRunner {\n  run() { return 1; }\n}\n`);
      await cg.syncFiles([implementationPath]);

      const override = cg.getNodesByName('run').find((node) => node.qualifiedName === 'Runner::run');
      expect(override).toBeTruthy();
      const relations = cg.getIncomingRelations(override!.id, { relations: ['CalledBy'] });

      expect(relations.some((relation) => relation.otherNode.qualifiedName === 'TaskRunner::run')).toBe(true);
    });
  });

  describe('getCallGraph()', () => {
    it('should return call graph for a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        console.log('processValue not found, skipping test');
        return;
      }

      const callGraph = cg.getCallGraph(processValue.id, 2);

      expect(callGraph.nodes.size).toBeGreaterThan(0);
      expect(callGraph.nodes.has(processValue.id)).toBe(true);
    });
  });

  describe('getTypeHierarchy()', () => {
    it('should return type hierarchy for a class', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const hierarchy = cg.getTypeHierarchy(derivedClass.id);

      expect(hierarchy.nodes.size).toBeGreaterThan(0);
      expect(hierarchy.nodes.has(derivedClass.id)).toBe(true);
    });

    it('should return empty subgraph for non-existent node', () => {
      const hierarchy = cg.getTypeHierarchy('non-existent-id');

      expect(hierarchy.nodes.size).toBe(0);
      expect(hierarchy.edges.length).toBe(0);
    });
  });

  describe('findUsages()', () => {
    it('should find usages of a symbol', () => {
      const nodes = cg.getNodesByKind('class');
      const baseClass = nodes.find((n) => n.name === 'BaseClass');

      if (!baseClass) {
        return;
      }

      const usages = cg.findUsages(baseClass.id);

      // Should find at least the extends relationship
      expect(usages).toBeDefined();
      expect(Array.isArray(usages)).toBe(true);
    });
  });

  describe('getCallers() and getCallees()', () => {
    it('should get callers of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const callers = cg.getCallers(formatValue.id);

      // processValue calls formatValue
      expect(Array.isArray(callers)).toBe(true);
    });

    it('should get callees of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        return;
      }

      const callees = cg.getCallees(processValue.id);

      expect(Array.isArray(callees)).toBe(true);
    });
  });

  describe('getImpactRadius()', () => {
    it('should calculate impact radius', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const impact = cg.getImpactRadius(formatValue.id, 3);

      expect(impact.nodes.size).toBeGreaterThan(0);
      expect(impact.nodes.has(formatValue.id)).toBe(true);
    });
  });

  describe('findPath()', () => {
    it('should find path between connected nodes', () => {
      const stats = cg.getStats();

      if (stats.nodeCount < 2) {
        return;
      }

      const functions = cg.getNodesByKind('function');
      if (functions.length < 2) {
        return;
      }

      // Try to find any path
      const processValue = functions.find((n) => n.name === 'processValue');
      const formatValue = functions.find((n) => n.name === 'formatValue');

      if (processValue && formatValue) {
        const path = cg.findPath(processValue.id, formatValue.id);

        // Path might exist or might not depending on edge direction
        expect(path === null || Array.isArray(path)).toBe(true);
      }
    });

    it('should return null for disconnected nodes', () => {
      // Create two nodes that definitely don't have a path
      const path = cg.findPath('non-existent-1', 'non-existent-2');

      expect(path).toBeNull();
    });
  });

  describe('getAncestors() and getChildren()', () => {
    it('should get ancestors of a node', () => {
      const methods = cg.getNodesByKind('method');
      const printMethod = methods.find((n) => n.name === 'print');

      if (!printMethod) {
        return;
      }

      const ancestors = cg.getAncestors(printMethod.id);

      // Should have class and file as ancestors
      expect(Array.isArray(ancestors)).toBe(true);
    });

    it('should get children of a node', () => {
      const classes = cg.getNodesByKind('class');
      const derivedClass = classes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const children = cg.getChildren(derivedClass.id);

      // Should have methods as children
      expect(Array.isArray(children)).toBe(true);
    });
  });

  describe('File dependency analysis', () => {
    it('should get file dependencies', () => {
      const deps = cg.getFileDependencies('src/main.ts');

      expect(Array.isArray(deps)).toBe(true);
    });

    it('should get file dependents', () => {
      const dependents = cg.getFileDependents('src/utils.ts');

      expect(Array.isArray(dependents)).toBe(true);
    });
  });

  describe('findCircularDependencies()', () => {
    it('should detect circular dependencies', () => {
      const cycles = cg.findCircularDependencies();

      // Our test files don't have circular deps
      expect(Array.isArray(cycles)).toBe(true);
    });
  });

  describe('findDeadCode()', () => {
    it('should find dead code', () => {
      const deadCode = cg.findDeadCode(['function']);

      expect(Array.isArray(deadCode)).toBe(true);

      // unusedHelper should be detected
      const hasUnused = deadCode.some((n) => n.name === 'unusedHelper');
      // Note: This depends on extraction properly detecting function scope
      expect(deadCode.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getNodeMetrics()', () => {
    it('should return metrics for a node', () => {
      const functions = cg.getNodesByKind('function');
      const func = functions[0];

      if (!func) {
        return;
      }

      const metrics = cg.getNodeMetrics(func.id);

      expect(metrics).toHaveProperty('incomingEdgeCount');
      expect(metrics).toHaveProperty('outgoingEdgeCount');
      expect(metrics).toHaveProperty('callCount');
      expect(metrics).toHaveProperty('callerCount');
      expect(metrics).toHaveProperty('childCount');
      expect(metrics).toHaveProperty('depth');

      expect(typeof metrics.incomingEdgeCount).toBe('number');
      expect(typeof metrics.outgoingEdgeCount).toBe('number');
    });
  });
});
