/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import './env';
import type {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  CodeGraphSnapshot,
  SourceRange,
  RangeQueryOptions,
  FrozenSemanticObject,
  NodeSemanticInfo,
  NodeSemanticDiff,
  NodeSemanticDiffField,
  NodeSemanticDiffKind,
  NodeSemanticDiffKey,
  LanguageAwareSignal,
  LanguageAwareSignalDiffInput,
  FileSemanticDiffInput,
  FileSemanticInfo,
  FileSemanticInputNode,
  FileSemanticSignal,
  FileSemanticSignalKind,
  FrozenRelation,
  RelationEvidence,
  RelationDeltaEvidence,
  RelationKind,
  RelationProjectionOptions,
  RelationQueryOptions,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  extractFromSource,
  initGrammars,
} from './extraction';
import type { IndexProgress, IndexResult, SyncResult } from './extraction';
import {
  ReferenceResolver,
  createResolver,
} from './resolution';
import type { ResolutionResult } from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { FileWatcher, LockUnavailableError, type WatchOptions, type PendingFile, type WatchBatch } from './sync';
import {
  diffNodeLanguageSignals as diffLanguageAwareSignals,
  projectLanguageAwareSignals,
} from './semantic/language-signals';

// Re-export types for consumers
export * from './types';
// Storage building blocks for embedded/SDK consumers that drive the graph
// directly (open a DB, run prepared queries) rather than through the CodeGraph
// facade. Exposed from the package entry so they no longer require deep imports
// into dist/ (issue #354).
export {
  getDatabasePath,
  DatabaseConnection,
  type DatabaseOpenOptions,
  type StorageExtension,
  type StorageExtensionMigration,
  type StorageExtensionMigrationRecord,
} from './db';
export { QueryBuilder } from './db/queries';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export type { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export type { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export type { Logger } from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export {
  FileWatcher,
  LockUnavailableError,
} from './sync';
export type {
  WatchOptions,
  WatchEventKind,
  WatchEventSource,
  WatchEvent,
  WatchBatch,
  WatchBatchApi,
  WatchSyncSummary,
  PendingFile,
} from './sync';
export { MCPServer } from './mcp';
export { projectLanguageAwareSignals } from './semantic/language-signals';

function loadCodeGraphVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
    ) as { version?: unknown };
    if (typeof packageJson.version === 'string') return packageJson.version;
  } catch {
    // Source checkouts and bundled builds both normally have package.json at the
    // main package root. Fall back only for unusual embedding environments.
  }
  return '0.0.0-dev';
}

export const codegraphVersion = loadCodeGraphVersion();

type NormalizedRange = Required<SourceRange>;

function normalizeSourceRange(range: SourceRange): NormalizedRange {
  const startLine = Math.max(1, Math.floor(range.startLine));
  const endLine = Math.max(startLine, Math.floor(range.endLine ?? startLine));
  return {
    startLine,
    endLine,
    startColumn: Math.max(0, Math.floor(range.startColumn ?? 0)),
    endColumn: Math.max(0, Math.floor(range.endColumn ?? Number.MAX_SAFE_INTEGER)),
  };
}

function comparePosition(
  line: number,
  column: number,
  otherLine: number,
  otherColumn: number
): number {
  if (line !== otherLine) return line - otherLine;
  return column - otherColumn;
}

function nodeIntersectsRange(node: Node, range: NormalizedRange): boolean {
  return (
    comparePosition(node.startLine, node.startColumn, range.endLine, range.endColumn) <= 0 &&
    comparePosition(node.endLine, node.endColumn, range.startLine, range.startColumn) >= 0
  );
}

function nodeSpanSize(node: Node): number {
  return (node.endLine - node.startLine) * 1_000_000 + (node.endColumn - node.startColumn);
}

const CALLABLE_NODE_KINDS = new Set<Node['kind']>(['function', 'method', 'component']);
const CONTAINER_NODE_KINDS = new Set<Node['kind']>(['file', 'module']);
const SCHEMA_NODE_KINDS = new Set<Node['kind']>(['interface', 'type_alias', 'enum', 'field', 'class', 'struct', 'property']);
const SEMANTIC_DIFF_FIELDS: NodeSemanticDiffField[] = [
  'kind',
  'name',
  'qualifiedName',
  'filePath',
  'semantic.role',
  'semantic.changeSubject',
  'signature',
  'visibility',
  'isExported',
  'isAsync',
  'isStatic',
  'isAbstract',
  'decorators',
  'typeParameters',
];
const SIGNATURE_DIFF_FIELDS = new Set<NodeSemanticDiffField>([
  'signature',
  'name',
  'qualifiedName',
  'visibility',
  'isAsync',
  'isStatic',
  'isAbstract',
  'decorators',
  'typeParameters',
]);

function fileClassifierVersion(): FileSemanticInfo['classifierVersion'] {
  return 1;
}

function isDependencyManifestName(basename: string): boolean {
  return [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'cargo.toml',
    'cargo.lock',
    'go.mod',
    'go.sum',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'pipfile',
    'pipfile.lock',
    'gemfile',
    'gemfile.lock',
    'composer.json',
    'composer.lock',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'gradle.lockfile',
  ].includes(basename);
}

function isDocExtension(extension: string): boolean {
  return ['.md', '.mdx', '.rst', '.adoc', '.txt'].includes(extension);
}

function isSourceExtension(extension: string): boolean {
  return ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.rs', '.go', '.py', '.java', '.kt', '.swift'].includes(extension);
}

function isConfigFileName(basename: string): boolean {
  return [
    'tsconfig.json',
    'jsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'drizzle.config.ts',
    'eslint.config.js',
    'eslint.config.mjs',
    'prettier.config.js',
    'tailwind.config.ts',
    'tailwind.config.js',
    'next.config.js',
    'next.config.mjs',
    'nuxt.config.ts',
    'svelte.config.js',
    'astro.config.mjs',
  ].includes(basename);
}

function normalizedFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function fileSemanticResult(input: Omit<FileSemanticInfo, 'schemaVersion' | 'classifierVersion'>): FileSemanticInfo {
  return {
    schemaVersion: 1,
    classifierVersion: fileClassifierVersion(),
    ...input,
  };
}

function fileHasRouteNode(filePath: string, nodes: readonly FileSemanticInputNode[]): boolean {
  const normalized = normalizedFilePath(filePath);
  return nodes.some((node) => normalizedFilePath(node.filePath) === normalized && node.kind === 'route');
}

function isGeneratedPath(lowerPath: string, basename: string): boolean {
  const segments = lowerPath.split('/');
  return segments.some((segment) => segment === 'generated' || segment === '__generated__' || segment === 'dist' || segment === 'build' || segment === 'out')
    || basename.includes('.generated.')
    || basename.includes('.gen.');
}

function isTestPath(lowerPath: string, basename: string): boolean {
  return lowerPath.includes('/test/')
    || lowerPath.includes('/tests/')
    || lowerPath.includes('/__tests__/')
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename);
}

function isDocsPath(lowerPath: string, extension: string): boolean {
  return isDocExtension(extension)
    || lowerPath.includes('/docs/')
    || lowerPath.includes('/specs/');
}

function isApiRoutePath(lowerPath: string): boolean {
  return lowerPath.includes('/route')
    || lowerPath.includes('/routes/')
    || lowerPath.includes('/api/')
    || lowerPath.includes('/httpapi/')
    || lowerPath.includes('/server/');
}

function isConfigPath(basename: string): boolean {
  return basename.startsWith('.')
    || basename.includes('config')
    || isConfigFileName(basename);
}

function fileSemanticRange(input: FileSemanticDiffInput): SourceRange | undefined {
  const first = input.hunks?.[0];
  if (!first) return undefined;
  return first.newRange ?? first.oldRange;
}

function sourceRangeIntersects(left: SourceRange | undefined, right: SourceRange | undefined): boolean {
  if (!left || !right) return false;
  const a = normalizeSourceRange(left);
  const b = normalizeSourceRange(right);
  return (
    comparePosition(a.startLine, a.startColumn, b.endLine, b.endColumn) <= 0 &&
    comparePosition(a.endLine, a.endColumn, b.startLine, b.startColumn) >= 0
  );
}

function fileSemanticNode(input: FileSemanticDiffInput, kind: FileSemanticSignalKind): FileSemanticInputNode | undefined {
  const range = fileSemanticRange(input);
  const paths = new Set([input.filePath, input.oldPath].filter((filePath): filePath is string => Boolean(filePath)).map(normalizedFilePath));
  const nodeKind = kind === 'import_statement' ? 'import' : 'export';
  return input.nodes?.find(
    (node) => node.kind === nodeKind && paths.has(normalizedFilePath(node.filePath)) && sourceRangeIntersects(node.range, range)
  );
}

function fileSemanticChangeKind(added: boolean, removed: boolean, projected: boolean): FileSemanticSignal['changeKind'] {
  if (added && removed) return 'modify';
  if (added) return 'add';
  if (removed) return 'delete';
  if (projected) return 'modify';
  return 'unknown';
}

function diffSignal(input: {
  kind: FileSemanticSignalKind;
  added: boolean;
  removed: boolean;
  projected?: boolean;
  range?: SourceRange;
}): FileSemanticSignal[] {
  if (!input.added && !input.removed && !input.projected) return [];
  const changeKind = fileSemanticChangeKind(input.added, input.removed, Boolean(input.projected));
  const source = input.projected ? 'codegraph:node_projection' : 'codegraph:diff_classifier';
  return [{
    schemaVersion: 1,
    kind: input.kind,
    changeKind,
    confidence: input.projected ? 0.85 : 0.8,
    source,
    range: input.range,
    reason: input.projected
      ? `CodeGraph node projection detected changed ${input.kind.replace('_', ' ')} ${changeKind}`
      : `CodeGraph diff classifier detected ${input.kind.replace('_', ' ')} ${changeKind}`,
    signals: [
      `codegraph_file_signal:${input.kind}`,
      `change_kind:${changeKind}`,
      `source:${source}`,
      `classifier_version:${fileClassifierVersion()}`,
      ...(input.projected ? ['node_projection'] : []),
    ],
  }];
}

function nodeSemanticInfo(node: Node): NodeSemanticInfo {
  const isCallable = CALLABLE_NODE_KINDS.has(node.kind);
  const isContainer = CONTAINER_NODE_KINDS.has(node.kind);
  const isSchema = SCHEMA_NODE_KINDS.has(node.kind);
  const role = node.kind === 'import'
    ? 'import'
    : node.kind === 'export'
      ? 'export'
      : node.kind === 'route'
        ? 'route'
        : isCallable
          ? 'callable'
          : isSchema
            ? 'schema'
            : isContainer
              ? 'container'
              : 'unknown';
  const changeSubject = node.kind === 'import'
    ? 'import'
    : node.kind === 'export'
      ? 'export'
      : node.kind === 'route'
        ? 'route'
        : node.isExported
          ? 'export'
          : isSchema
            ? 'schema'
            : isCallable
              ? 'signature'
              : 'unknown';

  return {
    role,
    changeSubject,
    attributes: {
      isCallable,
      isContainer,
      isSchema,
      isBoundary: role === 'import' || role === 'export' || role === 'route',
    },
    confidence: 'exact',
  };
}

export function getFileSemanticInfo(filePath: string, nodes: readonly FileSemanticInputNode[] = []): FileSemanticInfo {
  const normalized = normalizedFilePath(filePath);
  const lower = normalized.toLowerCase();
  const basename = path.posix.basename(lower);
  const extension = path.posix.extname(basename);

  if (fileHasRouteNode(normalized, nodes)) {
    return fileSemanticResult({
      role: 'api_route',
      confidence: 'exact',
      source: 'codegraph:framework_resolver',
      reason: 'file contains a CodeGraph route node',
      signals: ['route_node'],
    });
  }

  if (isDependencyManifestName(basename)) {
    return fileSemanticResult({
      role: 'dependency_manifest',
      confidence: 'exact',
      source: 'codegraph:file_classifier',
      reason: 'dependency manifest or lockfile boundary',
      signals: ['dependency_manifest'],
    });
  }

  if (isGeneratedPath(lower, basename)) {
    return fileSemanticResult({
      role: 'generated',
      confidence: 'heuristic',
      source: 'codegraph:file_classifier',
      reason: 'generated output path or filename marker',
      signals: ['generated_path'],
    });
  }

  if (isTestPath(lower, basename)) {
    return fileSemanticResult({
      role: 'test',
      confidence: 'heuristic',
      source: 'codegraph:file_classifier',
      reason: 'test or spec file boundary',
      signals: ['test_path'],
    });
  }

  if (isDocsPath(lower, extension)) {
    return fileSemanticResult({
      role: 'docs',
      confidence: 'heuristic',
      source: 'codegraph:file_classifier',
      reason: 'documentation or specification boundary',
      signals: ['doc_path'],
    });
  }

  if (isApiRoutePath(lower)) {
    return fileSemanticResult({
      role: 'api_route',
      confidence: 'heuristic',
      source: 'codegraph:file_classifier',
      reason: 'route/server/API path boundary',
      signals: ['route_path'],
    });
  }

  if (isConfigPath(basename)) {
    return fileSemanticResult({
      role: 'config',
      confidence: 'heuristic',
      source: 'codegraph:file_classifier',
      reason: 'configuration boundary',
      signals: ['config_path'],
    });
  }

  if (isSourceExtension(extension)) {
    return fileSemanticResult({
      role: 'source',
      confidence: 'exact',
      source: 'codegraph:file_classifier',
      reason: 'source implementation file',
      signals: ['source_path'],
    });
  }

  return fileSemanticResult({
    role: 'unknown',
    confidence: 'unknown',
    source: 'codegraph:fallback',
    reason: 'unclassified file boundary',
    signals: ['unknown_path'],
  });
}

export function diffFileSemantics(input: FileSemanticDiffInput): FileSemanticSignal[] {
  const patch = input.patch;
  const importAdded = /^\+\s*(?:import(?:\s|["'{*])|from\s+.+\s+import\s)/m.test(patch);
  const importRemoved = /^-\s*(?:import(?:\s|["'{*])|from\s+.+\s+import\s)/m.test(patch);
  const exportAdded = /^\+\s*export(?:\s|\{|\*)/m.test(patch);
  const exportRemoved = /^-\s*export(?:\s|\{|\*)/m.test(patch);
  const range = fileSemanticRange(input);
  const importProjected = Boolean(fileSemanticNode(input, 'import_statement'));
  const exportProjected = Boolean(fileSemanticNode(input, 'export_boundary'));

  return [
    ...diffSignal({ kind: 'import_statement', added: importAdded, removed: importRemoved, projected: importProjected, range }),
    ...diffSignal({ kind: 'export_boundary', added: exportAdded, removed: exportRemoved, projected: exportProjected, range }),
  ];
}

function relationForEdge(edgeKind: Edge['kind'], direction: 'incoming' | 'outgoing'): RelationKind {
  if (edgeKind === 'calls') return direction === 'incoming' ? 'CalledBy' : 'Calls';
  if (edgeKind === 'imports') return direction === 'incoming' ? 'ImportedBy' : 'Imports';
  if (edgeKind === 'references' || edgeKind === 'type_of' || edgeKind === 'returns') return direction === 'incoming' ? 'UsedBy' : 'Uses';
  if (edgeKind === 'instantiates') return direction === 'incoming' ? 'InstantiatedBy' : 'Instantiates';
  if (edgeKind === 'extends' || edgeKind === 'implements') return direction === 'incoming' ? 'BaseClassOf' : 'DerivedClassOf';
  if (edgeKind === 'overrides') return direction === 'incoming' ? 'OverriddenBy' : 'Overrides';
  if (edgeKind === 'decorates') return direction === 'incoming' ? 'DecoratedBy' : 'Decorates';
  return direction === 'incoming' ? 'ContainedBy' : 'Contains';
}

function relationQuality(edge: Edge): RelationEvidence['quality'] {
  if (edge.provenance === 'heuristic') return 'heuristic';
  return 'exact';
}

function relationNodeKey(node: Node, snapshot: CodeGraphSnapshot) {
  return {
    codegraphId: node.id,
    graphRevision: snapshot.revision,
    nodeKey: `${node.filePath}:${node.kind}:${node.qualifiedName || node.name}`,
    filePath: node.filePath,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    range: {
      startLine: node.startLine,
      endLine: node.endLine,
      startColumn: node.startColumn,
      endColumn: node.endColumn,
    },
  };
}

function freezeRelationEvidence(relation: RelationEvidence, focal: Node, snapshot: CodeGraphSnapshot): FrozenRelation {
  return {
    schemaVersion: 1,
    objectType: 'relation',
    source: {
      system: 'codegraph',
      codegraphVersion: snapshot.codegraphVersion,
      graphRevision: snapshot.revision,
      schemaVersion: snapshot.schemaVersion,
    },
    payload: {
      relation: relation.relation,
      direction: relation.direction,
      edgeKind: relation.edgeKind,
      focalNode: relationNodeKey(focal, snapshot),
      otherNode: relationNodeKey(relation.otherNode, snapshot),
      sourceNode: relationNodeKey(relation.sourceNode, snapshot),
      targetNode: relationNodeKey(relation.targetNode, snapshot),
      provenance: relation.provenance,
      quality: relation.quality,
      edgeLocation: relation.edge.line || relation.edge.column ? { line: relation.edge.line, column: relation.edge.column } : undefined,
      metadata: relation.edge.metadata,
    },
  };
}

function relationDeltaKey(relation: FrozenRelation) {
  return [
    relation.payload.direction,
    relation.payload.relation,
    relation.payload.edgeKind,
    relation.payload.focalNode.nodeKey,
    relation.payload.otherNode.nodeKey,
    relation.payload.sourceNode.nodeKey,
    relation.payload.targetNode.nodeKey,
    relation.payload.provenance ?? '',
  ].join('\0');
}

function firstRelation(relation: FrozenRelation | undefined) {
  return relation?.source;
}

export function diffRelations(
  beforeRelations: readonly FrozenRelation[] = [],
  afterRelations: readonly FrozenRelation[] = []
): RelationDeltaEvidence {
  const beforeByKey = new Map(beforeRelations.map((relation) => [relationDeltaKey(relation), relation]));
  const afterByKey = new Map(afterRelations.map((relation) => [relationDeltaKey(relation), relation]));
  const beforeSource = firstRelation(beforeRelations[0]);
  const afterSource = firstRelation(afterRelations[0]);

  return {
    schemaVersion: 1,
    source: {
      system: 'codegraph',
      beforeRevision: beforeSource?.graphRevision,
      afterRevision: afterSource?.graphRevision,
      beforeCodeGraphVersion: beforeSource?.codegraphVersion,
      afterCodeGraphVersion: afterSource?.codegraphVersion,
    },
    beforeRelations: [...beforeRelations],
    afterRelations: [...afterRelations],
    addedRelations: [...afterByKey].flatMap(([key, relation]) => beforeByKey.has(key) ? [] : [relation]),
    removedRelations: [...beforeByKey].flatMap(([key, relation]) => afterByKey.has(key) ? [] : [relation]),
  };
}

function semanticObjectKey(node: FrozenSemanticObject): NodeSemanticDiffKey {
  return {
    nodeKey: `${node.payload.filePath}:${node.payload.kind}:${node.payload.qualifiedName || node.payload.name}`,
    codegraphId: node.source.codegraphId,
    revision: node.source.graphRevision,
    filePath: node.payload.filePath,
    kind: node.payload.kind,
    name: node.payload.name,
    qualifiedName: node.payload.qualifiedName,
    range: node.payload.range,
  };
}

function semanticFieldValue(node: FrozenSemanticObject, field: NodeSemanticDiffField): unknown {
  if (field === 'semantic.role') return node.payload.semantic?.role;
  if (field === 'semantic.changeSubject') return node.payload.semantic?.changeSubject;
  return node.payload[field];
}

function semanticFieldEqual(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) return false;
    return before.length === after.length && before.every((item, index) => item === after[index]);
  }
  return before === after;
}

function semanticDiffKind(fields: NodeSemanticDiffField[], before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): NodeSemanticDiffKind {
  if (!before && after) return 'add';
  if (before && !after) return 'delete';
  if (fields.length === 0) return 'unchanged';
  if (fields.includes('filePath')) return 'move';
  if (fields.includes('name') || fields.includes('qualifiedName')) return 'rename';
  return 'modify';
}

function semanticDiffSubject(fields: NodeSemanticDiffField[], before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): NodeSemanticDiff['changeSubject'] {
  const node = after ?? before;
  if (!node) return 'unknown';
  const fallbackSubject = node.payload.semantic?.changeSubject ?? 'unknown';
  if (fields.length === 0 && before && after) return 'unknown';
  if (fields.includes('isExported') && fields.every((field) => field === 'isExported')) return 'export';
  if ((node.payload.semantic?.attributes.isCallable ?? CALLABLE_NODE_KINDS.has(node.payload.kind)) && fields.some((field) => SIGNATURE_DIFF_FIELDS.has(field))) {
    return 'signature';
  }
  if (fields.includes('isExported')) return 'export';
  return fallbackSubject;
}

function semanticDiffConfidence(fields: NodeSemanticDiffField[], before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): number {
  if (fields.length === 0 && before && after) return 1;
  if (!before || !after) return 0.9;
  if (before.payload.semantic?.confidence === 'heuristic' || after.payload.semantic?.confidence === 'heuristic') return 0.75;
  return 0.95;
}

function semanticDiffConfidenceReason(diffKind: NodeSemanticDiffKind, fields: NodeSemanticDiffField[]): string {
  if (diffKind === 'add') return 'after CodeGraph projection exists without a before projection';
  if (diffKind === 'delete') return 'before CodeGraph projection exists without an after projection';
  if (diffKind === 'unchanged') return 'CodeGraph semantic projection fields are stable';
  return `CodeGraph semantic projection changed ${fields.join(', ')}`;
}

export function diffNodeSemantics(before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): NodeSemanticDiff {
  const fieldChanges = before && after
    ? SEMANTIC_DIFF_FIELDS.flatMap((field) => {
        const beforeValue = semanticFieldValue(before, field);
        const afterValue = semanticFieldValue(after, field);
        if (semanticFieldEqual(beforeValue, afterValue)) return [];
        return [{ field, before: beforeValue, after: afterValue }];
      })
    : [];
  const changedFields = fieldChanges.map((change) => change.field);
  const changeKind = semanticDiffKind(changedFields, before, after);

  return {
    schemaVersion: 1,
    source: {
      system: 'codegraph',
      beforeRevision: before?.source.graphRevision,
      afterRevision: after?.source.graphRevision,
      beforeCodeGraphVersion: before?.source.codegraphVersion,
      afterCodeGraphVersion: after?.source.codegraphVersion,
    },
    changeKind,
    changeSubject: semanticDiffSubject(changedFields, before, after),
    confidence: semanticDiffConfidence(changedFields, before, after),
    confidenceReason: semanticDiffConfidenceReason(changeKind, changedFields),
    changedFields,
    fieldChanges,
    beforeKey: before ? semanticObjectKey(before) : undefined,
    afterKey: after ? semanticObjectKey(after) : undefined,
  };
}

export function diffNodeLanguageSignals(input: LanguageAwareSignalDiffInput): LanguageAwareSignal[] {
  return diffLanguageAwareSignals(input);
}

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Chimera not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Chimera not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Diff two frozen node semantic projections without opening a graph.
   */
  static diffNodeSemantics(before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): NodeSemanticDiff {
    return diffNodeSemantics(before, after);
  }

  /**
   * Diff language-aware node signals without opening a graph.
   */
  static diffNodeLanguageSignals(input: LanguageAwareSignalDiffInput): LanguageAwareSignal[] {
    return diffNodeLanguageSignals(input);
  }

  /**
   * Classify stable file-level semantics without requiring persisted metadata.
   */
  static getFileSemanticInfo(filePath: string, nodes: readonly FileSemanticInputNode[] = []): FileSemanticInfo {
    return getFileSemanticInfo(filePath, nodes);
  }

  /**
   * Diff file-level semantic signals such as import/export statement changes.
   */
  static diffFileSemantics(input: FileSemanticDiffInput): FileSemanticSignal[] {
    return diffFileSemantics(input);
  }

  /**
   * Diff two frozen relation snapshots without opening a graph.
   */
  static diffRelations(
    beforeRelations: readonly FrozenRelation[] = [],
    afterRelations: readonly FrozenRelation[] = []
  ): RelationDeltaEvidence {
    return diffRelations(beforeRelations, afterRelations);
  }

  private readNodeSource(node: Node): string | undefined {
    try {
      return fs.readFileSync(path.join(this.projectRoot, node.filePath), 'utf-8');
    } catch {
      return undefined;
    }
  }

  private toGraphPath(filePath: string): string {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    const relative = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : normalizedFilePath(filePath);
  }

  private fileSemanticInputNodes(filePath: string): FileSemanticInputNode[] {
    return this.queries.getNodesByFile(filePath).map((node) => ({
      kind: node.kind,
      filePath: node.filePath,
      range: {
        startLine: node.startLine,
        endLine: node.endLine,
        startColumn: node.startColumn,
        endColumn: node.endColumn,
      },
    }));
  }

  private computeFileSemanticInfo(filePath: string): FileSemanticInfo {
    return getFileSemanticInfo(filePath, this.fileSemanticInputNodes(filePath));
  }

  private refreshFileSemanticInfo(filePath: string): FileSemanticInfo | null {
    const graphPath = this.toGraphPath(filePath);
    const file = this.queries.getFileByPath(graphPath);
    if (!file) return null;
    const semantic = this.computeFileSemanticInfo(graphPath);
    if (!this.db.isReadOnly()) {
      this.queries.upsertFileSemantic({
        path: file.path,
        contentHash: file.contentHash,
        semantic,
        updatedAt: Date.now(),
      });
    }
    return semantic;
  }

  private refreshFileSemantics(filePaths: readonly string[]): void {
    for (const filePath of [...new Set(filePaths)]) {
      this.refreshFileSemanticInfo(filePath);
    }
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  async close(): Promise<void> {
    try {
      await this.unwatch();
    } finally {
      // Release file lock if held
      this.fileLock.release();
      this.db.close();
    }
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const before = this.queries.getNodeAndEdgeCount();
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

        // Re-detect frameworks now that the index is populated. The resolver
        // is constructed with createResolver() before any files exist, so
        // framework resolvers whose detect() consults the indexed file list
        // (e.g. UIKit/SwiftUI scanning for imports, swift-objc-bridge looking
        // for both Swift and ObjC files) all return false on that initial pass
        // and silently drop themselves. Re-initializing here gives them a
        // chance to see the actual project before resolution runs.
        if (result.success && result.filesIndexed > 0) {
          this.resolver.initialize();
          // Cross-file finalization (e.g. NestJS RouterModule prefixes). Runs
          // before resolution so updated names show up in subsequent reads.
          this.resolver.runPostExtract();
        }

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        // Cheap and non-blocking; never load-bearing for correctness.
        if (result.success && result.filesIndexed > 0) {
          this.refreshFileSemantics(this.queries.getAllFilePaths());
          this.db.runMaintenance();
        }

        // The orchestrator only sees extraction-phase counts; resolution and
        // synthesizer edges (often >50% of the graph on JVM repos) come later.
        // Recompute against the DB so the CLI summary reports the true totals.
        if (result.success && result.filesIndexed > 0) {
          const after = this.queries.getNodeAndEdgeCount();
          result.nodesCreated = after.nodes - before.nodes;
          result.edgesCreated = after.edges - before.edges;
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.indexFiles(filePaths);
        if (result.success && result.filesIndexed > 0) this.refreshFileSemantics(filePaths);
        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // Cross-file finalization (e.g. NestJS RouterModule prefixes). Run on
        // every sync that touched files so edits to `app.module.ts` propagate
        // to controllers in unchanged files. The pass is idempotent and cheap
        // (regex over *.module.ts only).
        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolver.runPostExtract();
        }

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          this.refreshFileSemantics(result.changedFilePaths ?? []);
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync a bounded set of files with current file state.
   *
   * Unlike indexFiles(), this handles deletes and hash-based no-ops. Host
   * runtimes with precise file-change events should use this instead of forcing
   * a full repository sync after every edit.
   */
  async syncFiles(filePaths: string[], options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const normalizedFilePaths = [...new Set(filePaths.flatMap((filePath) => {
          const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
          const relative = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');
          return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? [relative] : [];
        }))];
        const changedSet = new Set(normalizedFilePaths);
        const dependentEdgeKinds: Edge['kind'][] = ['calls', 'references', 'imports', 'type_of', 'returns', 'instantiates', 'extends', 'implements', 'overrides'];
        const preservedIncomingEdges = normalizedFilePaths.flatMap((filePath) =>
          this.queries.getNodesByFile(filePath).flatMap((node) =>
            this.queries.getIncomingEdges(node.id, dependentEdgeKinds).filter((edge) => {
              const source = this.queries.getNodeById(edge.source);
              return source && source.filePath !== filePath;
            })
          )
        );
        const dependentFilePaths = [...new Set([
          ...normalizedFilePaths.flatMap((filePath) => this.graphManager.getFileDependents(filePath)),
          ...normalizedFilePaths.flatMap((filePath) =>
            this.queries.getNodesByFile(filePath).flatMap((node) =>
              this.queries.getIncomingEdges(node.id, dependentEdgeKinds).flatMap((edge) => {
                const source = this.queries.getNodeById(edge.source);
                return source && source.filePath !== filePath ? [source.filePath] : [];
              })
            )
          ),
        ])]
          .filter((filePath) => !changedSet.has(filePath));
        const result = await this.orchestrator.syncFiles(filePaths, options.onProgress);
        const changed = result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0;

        if (changed && dependentFilePaths.length > 0) {
          const dependentResult = await this.orchestrator.indexFiles(dependentFilePaths);
          result.nodesUpdated += dependentResult.nodesCreated;
        }

        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolver.runPostExtract();
        }

        const resolutionFilePaths = [...new Set([...(result.changedFilePaths ?? []), ...(changed ? dependentFilePaths : [])])];
        if (changed && resolutionFilePaths.length > 0) {
          const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(resolutionFilePaths);

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedRefs.length,
          });

          this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        if (changed && preservedIncomingEdges.length > 0) {
          this.queries.insertEdges(preservedIncomingEdges);
        }

        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          this.refreshFileSemantics([...(result.changedFilePaths ?? []), ...(changed ? dependentFilePaths : [])]);
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async (_batch: WatchBatch) => {
        const result = await this.sync();
        // sync() returns this exact zero-shape iff it failed to acquire the
        // file lock (a real empty sync always has filesChecked > 0 because
        // scanDirectory ran). Surface that to the watcher as a typed error
        // so it keeps pendingFiles + reschedules instead of clearing them
        // (#449).
        if (result.filesChecked === 0 && result.durationMs === 0) {
          throw new LockUnavailableError();
        }
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options,
      {
        snapshot: () => this.getSnapshot(),
        sync: () => this.sync(),
        syncFiles: (files) => this.syncFiles(files),
        getPendingFiles: () => this.getPendingFiles(),
      }
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  async unwatch(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.stop();
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Files seen by the file watcher since the last successful sync —
   * the per-file "stale" signal MCP tools attach to responses so an agent
   * can fall back to {@link Read} for just the affected file without
   * waiting for a debounced sync to complete (issue #403).
   *
   * Returns an empty list when the watcher isn't active, or no events have
   * arrived. Each entry includes `firstSeenMs` and `lastSeenMs` (wall-clock
   * `Date.now()` values) so callers can render "edited Nms ago", plus an
   * `indexing` flag indicating whether the in-flight sync (if any) will
   * absorb that file.
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * Resolves once the file watcher has finished its initial chokidar scan.
   * Useful for tests that need a deterministic boundary before asserting on
   * `getPendingFiles()`. Resolves immediately when no watcher is active.
   */
  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher ? this.watcher.waitUntilReady(timeoutMs) : Promise.resolve();
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Get a stable snapshot descriptor for the currently indexed graph.
   *
   * The revision is intentionally derived from durable indexed content rather
   * than Date.now()-style statistics so consumers can pair before/after semantic
   * projections around an edit.
   */
  getSnapshot(): CodeGraphSnapshot {
    const stats = this.getStats();
    const schemaVersion = this.db.getSchemaVersion()?.version ?? 0;
    const files = this.queries.getAllFiles();
    const revisionHash = crypto.createHash('sha256');

    revisionHash.update(`codegraph:${codegraphVersion}\0schema:${schemaVersion}\0`);
    revisionHash.update(`nodes:${stats.nodeCount}\0edges:${stats.edgeCount}\0files:${stats.fileCount}\0`);
    for (const file of files) {
      revisionHash.update(`${file.path}\0${file.contentHash}\0${file.language}\0${file.nodeCount}\0`);
    }

    return {
      codegraphVersion,
      schemaVersion,
      revision: revisionHash.digest('hex'),
      indexedAt: files.reduce((max, file) => Math.max(max, file.indexedAt), 0),
      fileCount: stats.fileCount,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      dbSizeBytes: stats.dbSizeBytes,
    };
  }

  /**
   * Project a graph node into the stable shape Chimera persists in its run
   * overlay. Returns null when an id is supplied but no matching node exists.
   */
  projectNode(
    nodeOrId: Node | string,
    snapshot: CodeGraphSnapshot = this.getSnapshot()
  ): FrozenSemanticObject | null {
    const node = typeof nodeOrId === 'string' ? this.getNode(nodeOrId) : nodeOrId;
    if (!node) return null;
    const file = this.getFile(node.filePath);
    const fileSemantic = this.getFileSemanticInfo(node.filePath);
    const languageSignals = projectLanguageAwareSignals(node, this.readNodeSource(node), {
      hasOverrideRelation: this.queries.getOutgoingEdges(node.id, ['overrides']).length > 0,
    });

    return {
      schemaVersion: 1,
      objectType: 'node',
      source: {
        system: 'codegraph',
        codegraphVersion: snapshot.codegraphVersion,
        graphRevision: snapshot.revision,
        schemaVersion: snapshot.schemaVersion,
        codegraphId: node.id,
      },
      payload: {
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath,
        language: node.language,
        range: {
          startLine: node.startLine,
          endLine: node.endLine,
          startColumn: node.startColumn,
          endColumn: node.endColumn,
        },
        semantic: nodeSemanticInfo(node),
        languageSignals,
        fileSemantic,
        fileRole: fileSemantic.role,
        signature: node.signature,
        visibility: node.visibility,
        isExported: node.isExported,
        isAsync: node.isAsync,
        isStatic: node.isStatic,
        isAbstract: node.isAbstract,
        decorators: node.decorators,
        typeParameters: node.typeParameters,
        fileContentHash: file?.contentHash,
      },
    };
  }

  /**
   * Return CodeGraph-owned semantic role information for a node.
   */
  getNodeSemanticInfo(nodeOrId: Node | string): NodeSemanticInfo | null {
    const node = typeof nodeOrId === 'string' ? this.getNode(nodeOrId) : nodeOrId;
    return node ? nodeSemanticInfo(node) : null;
  }

  /**
   * Return CodeGraph-owned file role information for a file.
   */
  getFileSemanticInfo(filePath: string): FileSemanticInfo {
    const graphPath = this.toGraphPath(filePath);
    const file = this.queries.getFileByPath(graphPath);
    const stored = this.queries.getFileSemanticByPath(graphPath);
    if (file && stored && stored.contentHash === file.contentHash && stored.semantic.classifierVersion === fileClassifierVersion()) {
      return stored.semantic;
    }
    return this.refreshFileSemanticInfo(graphPath) ?? this.computeFileSemanticInfo(graphPath);
  }

  /**
   * Diff two frozen node semantic projections.
   */
  diffNodeSemantics(before?: FrozenSemanticObject | null, after?: FrozenSemanticObject | null): NodeSemanticDiff {
    return diffNodeSemantics(before, after);
  }

  /**
   * Diff language-aware node signals using frozen projections and optional hunk ranges.
   */
  diffNodeLanguageSignals(input: LanguageAwareSignalDiffInput): LanguageAwareSignal[] {
    return diffNodeLanguageSignals(input);
  }

  /**
   * Diff file-level semantic signals such as import/export statement changes.
   */
  diffFileSemantics(input: FileSemanticDiffInput): FileSemanticSignal[] {
    return diffFileSemantics(input);
  }

  /**
   * Diff two frozen relation snapshots.
   */
  diffRelations(
    beforeRelations: readonly FrozenRelation[] = [],
    afterRelations: readonly FrozenRelation[] = []
  ): RelationDeltaEvidence {
    return diffRelations(beforeRelations, afterRelations);
  }

  /**
   * Active SQLite backend for this project's connection (`node-sqlite` or
   * `bun-sqlite`). Surfaced via `chimera status` and the `codegraph_status`
   * MCP tool alongside the effective journal mode.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `chimera status` and the `codegraph_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get nodes whose source span intersects the supplied file range.
   *
   * This is the public range-to-symbol ABI used by embedding runtimes to map
   * diffs, diagnostics, and editor selections onto semantic objects.
   */
  getNodesIntersectingRange(
    filePath: string,
    range: SourceRange,
    options: RangeQueryOptions = {}
  ): Node[] {
    const normalized = normalizeSourceRange(range);
    const kinds = options.kinds ? new Set(options.kinds) : null;
    let nodes = this.queries.getNodesByFile(filePath)
      .filter((node) => (!kinds || kinds.has(node.kind)) && nodeIntersectsRange(node, normalized))
      .sort((a, b) => {
        const byStart = comparePosition(a.startLine, a.startColumn, b.startLine, b.startColumn);
        if (byStart !== 0) return byStart;
        return nodeSpanSize(a) - nodeSpanSize(b);
      });

    if (options.smallestOnly && nodes.length > 0) {
      const smallest = Math.min(...nodes.map(nodeSpanSize));
      nodes = nodes.filter((node) => nodeSpanSize(node) === smallest);
    }

    return nodes;
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Get ALL nodes with an exact name (direct index lookup, not FTS-ranked/capped).
   * Used to enumerate every overload of a heavily-overloaded name so the specific
   * definition the caller wants is never dropped below a search cut.
   */
  getNodesByName(name: string): Node[] {
    return this.queries.getNodesByName(name);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Find the project's "primary route file" — the file with the densest
   * concentration of framework-emitted `route` nodes (≥3 routes, ≥30%
   * of all non-test routes). Used to inline the routing config in
   * `codegraph_explore` responses on small realworld template repos
   * (rails-realworld, laravel-realworld, drupal-admintoolbar, …) where
   * Glob+Read of `routes.rb`/`urls.py`/etc. otherwise beats codegraph.
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.queries.getTopRouteFile();
  }

  /**
   * Build a URL → handler routing manifest from the index. Each entry
   * pairs a route node (URL + method) with its handler function/method
   * via the `references` edge that framework resolvers emit. Returns
   * null when fewer than 3 valid (non-test) routes exist.
   */
  getRoutingManifest(limit?: number): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.queries.getRoutingManifest(limit);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node.
   *
   * `kinds` and `provenance` let embedded consumers ask for the precise
   * relation evidence they need instead of post-filtering broad graph output.
   */
  getOutgoingEdges(nodeId: string, kinds?: Edge['kind'][], provenance?: Edge['provenance']): Edge[] {
    return this.queries.getOutgoingEdges(nodeId, kinds, provenance);
  }

  /**
   * Get incoming edges to a node.
   */
  getIncomingEdges(nodeId: string, kinds?: Edge['kind'][], provenance?: Edge['provenance']): Edge[] {
    return this.queries.getIncomingEdges(nodeId, kinds, provenance);
  }

  /**
   * Get canonical outgoing relation evidence from a node.
   */
  getOutgoingRelations(nodeId: string, options: RelationQueryOptions = {}): RelationEvidence[] {
    const focal = this.getNode(nodeId);
    if (!focal) return [];
    return this.projectRelations(focal, 'outgoing', this.queries.getOutgoingEdges(nodeId, options.edgeKinds, options.provenance), options.relations);
  }

  /**
   * Get canonical incoming relation evidence to a node.
   */
  getIncomingRelations(nodeId: string, options: RelationQueryOptions = {}): RelationEvidence[] {
    const focal = this.getNode(nodeId);
    if (!focal) return [];
    return this.projectRelations(focal, 'incoming', this.queries.getIncomingEdges(nodeId, options.edgeKinds, options.provenance), options.relations);
  }

  /**
   * Freeze incoming/outgoing relation evidence for a node at a graph snapshot.
   * This gives consumers D/D' relation evidence without copying relation
   * taxonomy or edge-quality semantics outside CodeGraph.
   */
  projectIncidentRelations(
    nodeOrId: Node | FrozenSemanticObject | string,
    snapshot: CodeGraphSnapshot = this.getSnapshot(),
    options: RelationProjectionOptions = {}
  ): FrozenRelation[] {
    const node = typeof nodeOrId === 'string'
      ? this.getNode(nodeOrId)
      : 'objectType' in nodeOrId
        ? this.getNode(nodeOrId.source.codegraphId)
        : nodeOrId;
    if (!node) return [];

    const directions = new Set(options.directions ?? ['incoming', 'outgoing']);
    const relationOptions: RelationQueryOptions = {
      relations: options.relations,
      edgeKinds: options.edgeKinds,
      provenance: options.provenance,
    };

    return [
      ...(directions.has('incoming') ? this.getIncomingRelations(node.id, relationOptions) : []),
      ...(directions.has('outgoing') ? this.getOutgoingRelations(node.id, relationOptions) : []),
    ].map((relation) => freezeRelationEvidence(relation, node, snapshot));
  }

  private projectRelations(
    focal: Node,
    direction: 'incoming' | 'outgoing',
    edges: Edge[],
    relations?: RelationKind[]
  ): RelationEvidence[] {
    const relationFilter = relations ? new Set(relations) : null;
    const otherNodes = this.queries.getNodesByIds(edges.map((edge) => direction === 'incoming' ? edge.source : edge.target));

    return edges.flatMap((edge) => {
      const relation = relationForEdge(edge.kind, direction);
      if (relationFilter && !relationFilter.has(relation)) return [];
      const otherNode = otherNodes.get(direction === 'incoming' ? edge.source : edge.target);
      if (!otherNode) return [];
      return [{
        relation,
        direction,
        edgeKind: edge.kind,
        edge,
        otherNode,
        sourceNode: direction === 'incoming' ? otherNode : focal,
        targetNode: direction === 'incoming' ? focal : otherNode,
        provenance: edge.provenance,
        quality: relationQuality(edge),
      }];
    });
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  getDependencyFilePaths(filePath: string): string[] {
    return this.graphManager.getDependencyFilePaths(filePath);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.getDependencyFilePaths(filePath);
  }

  getDependentFilePaths(filePath: string): string[] {
    return this.graphManager.getDependentFilePaths(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.getDependentFilePaths(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): Promise<void> {
    return this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  async uninitialize(): Promise<void> {
    await this.close();
    removeDirectory(this.projectRoot);
  }
}

export { CodeGraph as ChimeraGraph };
export const chimeraVersion = codegraphVersion;

// Default export preserves the existing CodeGraph public API during the
// repository/package migration. New code can import ChimeraGraph.
export default CodeGraph;
