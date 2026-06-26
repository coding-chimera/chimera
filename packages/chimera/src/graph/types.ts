/**
 * CodeGraph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph.
 *
 * Defined as a runtime-iterable `as const` array so the same source
 * of truth backs both the TS type and any runtime validation
 * (e.g. the search query parser).
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'statement',
  'import',
  'export',
  'route',
  'component',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains'        // Parent contains child (file→class, class→method)
  | 'calls'           // Function/method calls another
  | 'imports'         // File imports from another
  | 'exports'         // File exports a symbol
  | 'extends'         // Class/interface extends another
  | 'implements'      // Class implements interface
  | 'references'      // Generic reference to another symbol
  | 'type_of'         // Variable/parameter has type
  | 'returns'         // Function returns type
  | 'instantiates'    // Creates instance of class
  | 'overrides'       // Method overrides parent method
  | 'decorates';      // Decorator applied to symbol

export const NODE_SEMANTIC_ROLES = [
  'container',
  'callable',
  'schema',
  'import',
  'export',
  'route',
  'unknown',
] as const;

export type NodeSemanticRole = (typeof NODE_SEMANTIC_ROLES)[number];

export const CHANGE_SUBJECTS = [
  'file',
  'body',
  'signature',
  'import',
  'export',
  'route',
  'schema',
  'config',
  'test',
  'doc',
  'unknown',
] as const;

export type ChangeSubject = (typeof CHANGE_SUBJECTS)[number];

export interface NodeSemanticInfo {
  role: NodeSemanticRole;
  changeSubject: ChangeSubject;
  attributes: {
    isCallable: boolean;
    isContainer: boolean;
    isSchema: boolean;
    isBoundary: boolean;
  };
  confidence: 'exact' | 'heuristic';
}

export const LANGUAGE_AWARE_SIGNAL_KINDS = [
  'return_value_changed',
  'this_field_write',
  'parameter_mutation',
  'global_or_module_state_write',
  'local_only_change',
  'unknown_body_effect',
  'constructor_like',
  'override_like',
  'route_handler_like',
  'field_access',
] as const;

export type LanguageAwareSignalKind = (typeof LANGUAGE_AWARE_SIGNAL_KINDS)[number];
export type LanguageAwareSignalSource = 'codegraph:language_analyzer' | 'codegraph:language_diff' | 'codegraph:fallback';
export type LanguageAwareSignalQuality = 'exact' | 'heuristic' | 'fallback' | 'unknown';

export interface LanguageAwareSignal {
  schemaVersion: 1;
  kind: LanguageAwareSignalKind;
  language: Language;
  source: LanguageAwareSignalSource;
  quality: LanguageAwareSignalQuality;
  confidence: number;
  range?: SourceRange;
  reason: string;
  metadata?: Record<string, unknown>;
  signals: string[];
}

export interface LanguageAwareSignalDiffInput {
  before?: FrozenSemanticObject | null;
  after?: FrozenSemanticObject | null;
  hunk?: {
    oldRange?: SourceRange;
    newRange?: SourceRange;
  };
}

export const RELATION_KINDS = [
  'CalledBy',
  'Calls',
  'ImportedBy',
  'Imports',
  'UsedBy',
  'Uses',
  'InstantiatedBy',
  'Instantiates',
  'BaseClassOf',
  'DerivedClassOf',
  'Overrides',
  'OverriddenBy',
  'DecoratedBy',
  'Decorates',
  'Contains',
  'ContainedBy',
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export const CODEPLAN_RELATION_KINDS = [
  'ParentOf',
  'ChildOf',
  'Construct',
  'ConstructedBy',
  'Imports',
  'ImportedBy',
  'BaseClassOf',
  'DerivedClassOf',
  'Overrides',
  'OverriddenBy',
  'Calls',
  'CalledBy',
  'Instantiates',
  'InstantiatedBy',
  'Uses',
  'UsedBy',
] as const;

export type CodePlanRelationKind = (typeof CODEPLAN_RELATION_KINDS)[number];
export type RelationDirection = 'incoming' | 'outgoing';
export type RelationQuality = 'exact' | 'heuristic' | 'fallback';

export interface RelationQueryOptions {
  relations?: RelationKind[];
  edgeKinds?: EdgeKind[];
  provenance?: Edge['provenance'];
}

export interface CodePlanRelationQueryOptions extends Omit<RelationQueryOptions, 'relations'> {
  relations?: CodePlanRelationKind[];
}

export interface RelationEvidence {
  relation: RelationKind;
  direction: RelationDirection;
  edgeKind: EdgeKind;
  edge: Edge;
  otherNode: Node;
  sourceNode: Node;
  targetNode: Node;
  provenance?: Edge['provenance'];
  quality: RelationQuality;
}

export interface CodePlanRelationEvidence extends Omit<RelationEvidence, 'relation'> {
  relation: CodePlanRelationKind;
}

export interface RelationProjectionOptions extends RelationQueryOptions {
  directions?: RelationDirection[];
}

export interface FrozenRelationNode {
  codegraphId: string;
  graphRevision: string;
  nodeKey: string;
  filePath: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  range: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
}

export interface FrozenRelation {
  schemaVersion: 1;
  objectType: 'relation';
  source: {
    system: 'codegraph';
    codegraphVersion: string;
    graphRevision: string;
    schemaVersion: number;
  };
  payload: {
    relation: RelationKind;
    direction: RelationDirection;
    edgeKind: EdgeKind;
    focalNode: FrozenRelationNode;
    otherNode: FrozenRelationNode;
    sourceNode: FrozenRelationNode;
    targetNode: FrozenRelationNode;
    provenance?: Edge['provenance'];
    quality: RelationQuality;
    edgeLocation?: {
      line?: number;
      column?: number;
    };
    metadata?: Record<string, unknown>;
  };
}

export interface RelationDeltaEvidence {
  schemaVersion: 1;
  source: {
    system: 'codegraph';
    beforeRevision?: string;
    afterRevision?: string;
    beforeCodeGraphVersion?: string;
    afterCodeGraphVersion?: string;
  };
  beforeRelations: FrozenRelation[];
  afterRelations: FrozenRelation[];
  addedRelations: FrozenRelation[];
  removedRelations: FrozenRelation[];
}

export type NodeSemanticDiffKind = 'add' | 'delete' | 'modify' | 'move' | 'rename' | 'unchanged';

export type NodeSemanticDiffField =
  | 'kind'
  | 'name'
  | 'qualifiedName'
  | 'filePath'
  | 'semantic.role'
  | 'semantic.changeSubject'
  | 'signature'
  | 'visibility'
  | 'isExported'
  | 'isAsync'
  | 'isStatic'
  | 'isAbstract'
  | 'decorators'
  | 'typeParameters';

export interface NodeSemanticDiffKey {
  nodeKey: string;
  codegraphId: string;
  revision: string;
  filePath: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  range: FrozenSemanticObject['payload']['range'];
}

export interface NodeSemanticFieldChange {
  field: NodeSemanticDiffField;
  before?: unknown;
  after?: unknown;
}

export interface NodeSemanticDiff {
  schemaVersion: 1;
  source: {
    system: 'codegraph';
    beforeRevision?: string;
    afterRevision?: string;
    beforeCodeGraphVersion?: string;
    afterCodeGraphVersion?: string;
  };
  changeKind: NodeSemanticDiffKind;
  changeSubject: ChangeSubject;
  confidence: number;
  confidenceReason: string;
  changedFields: NodeSemanticDiffField[];
  fieldChanges: NodeSemanticFieldChange[];
  beforeKey?: NodeSemanticDiffKey;
  afterKey?: NodeSemanticDiffKey;
}

export const FILE_ROLES = [
  'source',
  'test',
  'docs',
  'config',
  'dependency_manifest',
  'api_route',
  'generated',
  'unknown',
] as const;

export type FileRole = (typeof FILE_ROLES)[number];
export type FileSemanticConfidence = 'exact' | 'heuristic' | 'unknown';
export type FileSemanticSource = 'codegraph:file_classifier' | 'codegraph:framework_resolver' | 'codegraph:fallback';

export interface FileSemanticInfo {
  schemaVersion: 1;
  classifierVersion: 1;
  role: FileRole;
  confidence: FileSemanticConfidence;
  source: FileSemanticSource;
  reason: string;
  signals: string[];
}

export interface FileSemanticRecord {
  path: string;
  contentHash: string;
  semantic: FileSemanticInfo;
  updatedAt: number;
}

export interface FileSemanticInputNode {
  kind: NodeKind;
  filePath: string;
  range?: SourceRange;
}

export type FileSemanticSignalKind = 'import_statement' | 'export_boundary';
export type FileSemanticSignalChangeKind = 'add' | 'delete' | 'modify' | 'unknown';
export type FileSemanticSignalSource = 'codegraph:diff_classifier' | 'codegraph:node_projection' | 'codegraph:fallback';

export interface FileSemanticDiffHunk {
  oldRange?: SourceRange;
  newRange?: SourceRange;
  addedLines?: number;
  removedLines?: number;
}

export interface FileSemanticDiffInput {
  filePath: string;
  oldPath?: string;
  patch: string;
  hunks?: FileSemanticDiffHunk[];
  nodes?: FileSemanticInputNode[];
}

export interface FileSemanticSignal {
  schemaVersion: 1;
  kind: FileSemanticSignalKind;
  changeKind: FileSemanticSignalChangeKind;
  confidence: number;
  source: FileSemanticSignalSource;
  range?: SourceRange;
  reason: string;
  signals: string[];
}

/**
 * Supported programming languages. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /** How this edge was created */
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';
}

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /**
   * Retrieval confidence for context-style queries. `'low'` means the query
   * resolved only to isolated common-word matches (no entry point corroborated
   * by 2+ distinct query terms) — callers should surface an honest handoff to
   * explore/trace rather than present the results as comprehensive. Undefined
   * for graph traversals that don't run the search-ranking path.
   */
  confidence?: 'high' | 'low';
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

/**
 * Stable snapshot metadata for the current semantic graph.
 *
 * `revision` is a content-addressed fingerprint of the indexed project state.
 * It is intended for consumers that need to pair before/after projections
 * around an edit without treating mutable DB row contents as their durable
 * contract.
 */
export interface CodeGraphSnapshot {
  /** CodeGraph package/API version serving this snapshot */
  codegraphVersion: string;

  /** SQLite schema version currently applied */
  schemaVersion: number;

  /** Stable content fingerprint for the indexed graph */
  revision: string;

  /** Latest file-index timestamp represented in the graph */
  indexedAt: number;

  /** Number of indexed files */
  fileCount: number;

  /** Number of graph nodes */
  nodeCount: number;

  /** Number of graph edges */
  edgeCount: number;

  /** Database size in bytes */
  dbSizeBytes: number;
}

/**
 * Source range for mapping edits and diagnostics back onto graph nodes.
 *
 * Lines are 1-indexed. Columns are 0-indexed and optional; omitted columns
 * mean the full line span.
 */
export interface SourceRange {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

/**
 * Options for querying nodes whose source span intersects a range.
 */
export interface RangeQueryOptions {
  /** Restrict results to specific node kinds */
  kinds?: NodeKind[];

  /** Return only the narrowest intersecting nodes */
  smallestOnly?: boolean;
}

/**
 * A frozen, Chimera-friendly projection of a CodeGraph node.
 *
 * This intentionally does not expose the raw DB row schema as a durable
 * consumer contract. Consumers can always use `source.codegraphId` plus the
 * graph revision to inspect the originating CodeGraph row when needed.
 */
export interface FrozenSemanticObject {
  schemaVersion: 1;
  objectType: 'node';
  source: {
    system: 'codegraph';
    codegraphVersion: string;
    graphRevision: string;
    schemaVersion: number;
    codegraphId: string;
  };
  payload: {
    kind: NodeKind;
    name: string;
    qualifiedName: string;
    filePath: string;
    language: Language;
    range: {
      startLine: number;
      endLine: number;
      startColumn: number;
      endColumn: number;
    };
    semantic?: NodeSemanticInfo;
    languageSignals?: LanguageAwareSignal[];
    fileSemantic?: FileSemanticInfo;
    fileRole?: FileRole;
    signature?: string;
    visibility?: Node['visibility'];
    isExported?: boolean;
    isAsync?: boolean;
    isStatic?: boolean;
    isAbstract?: boolean;
    decorators?: string[];
    typeParameters?: string[];
    fileContentHash?: string;
  };
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: 'markdown' | 'json';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];
}
