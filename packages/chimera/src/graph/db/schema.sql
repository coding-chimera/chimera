-- CodeGraph SQLite Schema
-- Version 1

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- Insert initial version
INSERT INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial schema');

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Nodes: Code symbols (functions, classes, variables, etc.)
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT, -- JSON array
    type_parameters TEXT, -- JSON array
    return_type TEXT, -- normalized return/result type name for receiver-type inference (upstream v5, chimera v7)
    search_text TEXT, -- identifier split into component words for FTS (see query-utils.buildSearchText)
    updated_at INTEGER NOT NULL
);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT, -- JSON object
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Files: Tracked source files
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT, -- JSON array
    -- Index-time verdict from extraction/generated-detection.ts: filename
    -- convention (*.pb.go, *.g.dart, ...) OR a generation banner in the file
    -- header (upstream v9, chimera v11). No backfill: migrated rows stay 0
    -- until the next full index; readers union it with the path-only check.
    generated INTEGER NOT NULL DEFAULT 0
);

-- File Semantics: CodeGraph-owned file-level semantic classification
CREATE TABLE IF NOT EXISTS file_semantics (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    classifier_version INTEGER NOT NULL,
    role TEXT NOT NULL,
    confidence TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT, -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    -- status lifecycle: inserted 'pending'; a completed resolution pass
    -- either deletes the row (resolved) or marks it 'failed' so a later sync
    -- can retry it when a changed file introduces a matching symbol
    -- (upstream v8, chimera v10, #1240). name_tail is the last segment of
    -- reference_name ('util.greet' -> 'greet'), written when marked failed.
    status TEXT NOT NULL DEFAULT 'pending',
    name_tail TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Prose-word -> symbol-name lookup (upstream v7, chimera v9). One row per
-- (segment, name): segment is a lowercased word of a symbol name
-- (OrderStateMachine -> order, state, machine). Materialized on the node
-- write path; starts empty on migrated databases and is rebuilt by full
-- indexes / healed by sync.
CREATE TABLE IF NOT EXISTS name_segment_vocab (
    segment TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (segment, name)
) WITHOUT ROWID;

-- =============================================================================
-- Indexes for Query Performance
-- =============================================================================

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));

-- Full-text search index on node names, docstrings, signatures, and the
-- pre-split identifier words (search_text) that let prefix search match
-- compound symbols by their parts (e.g. "prompt" finds "SystemPrompt").
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    search_text,
    content='nodes',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, search_text)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.search_text);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, search_text)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.search_text);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, search_text)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.search_text);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, search_text)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.search_text);
END;

-- Edge indexes.
-- idx_edges_source / idx_edges_target are intentionally omitted —
-- the (source, kind) and (target, kind) composites below cover the
-- corresponding source-only / target-only lookups via SQLite's
-- left-prefix scan, so the narrow indexes are dead weight on writes.
-- Migration v4 drops them on existing databases.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

-- Edge identity uniqueness (upstream v6, chimera v8). insertEdge uses
-- INSERT OR IGNORE, which only dedups with something UNIQUE to conflict on.
-- IFNULL folds nullable line/col so coordinate-less edges dedup too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
  ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
-- PARTIAL: the generated set is a small minority of any repo, so lookups
-- intersecting a bounded candidate list stay proportional to it.
CREATE INDEX IF NOT EXISTS idx_files_generated ON files(path) WHERE generated = 1;
CREATE INDEX IF NOT EXISTS idx_file_semantics_role ON file_semantics(role);
CREATE INDEX IF NOT EXISTS idx_file_semantics_classifier_version ON file_semantics(classifier_version);
CREATE INDEX IF NOT EXISTS idx_file_semantics_content_hash ON file_semantics(content_hash);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_refs(status);
CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail ON unresolved_refs(name_tail) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

-- Project metadata for version/provenance tracking
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
