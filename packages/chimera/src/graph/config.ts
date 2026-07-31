/**
 * Project-scoped configuration: a committed `codegraph.json` at the project
 * root that a team shares through version control.
 *
 * Today it carries one thing — `includeIgnored`, gitignore-style patterns
 * naming gitignored directories whose embedded git repositories should be
 * indexed anyway — the explicit opt-in to override `.gitignore` for nested
 * repo discovery (upstream #622, #699). Absent or malformed config is the
 * zero-config default — no overrides, no error. Invalid individual entries
 * are warned-and-skipped (never fatal): an unparseable project file must not
 * break indexing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from './errors';

/** Filename of the project-scoped config, resolved relative to the project root. */
export const PROJECT_CONFIG_FILENAME = 'codegraph.json';

export interface ProjectConfig {
  /**
   * Gitignore-style patterns naming gitignored directories whose embedded git
   * repositories should be indexed anyway — the explicit opt-in to override
   * `.gitignore` for nested-repo discovery (#622, #699). Absent/empty (the
   * default) means `.gitignore` is fully respected: gitignored embedded repos
   * are never discovered or indexed.
   */
  includeIgnored?: string[];
}

/** Parsed, validated view of a project's `codegraph.json`. */
interface ParsedConfig {
  includeIgnored: string[];
}

interface CacheEntry {
  mtimeMs: number;
  config: ParsedConfig;
}

/**
 * Cache keyed by project root. The loader is called once per indexing/scan/
 * sync operation (and per watch event), so the mtime guard keeps repeat calls
 * to one `stat` while a single `codegraph.json` is in force. Keying by root
 * keeps two projects in the same process isolated.
 */
const cache = new Map<string, CacheEntry>();

/** Shared frozen empty so the no-config path allocates nothing. */
const EMPTY_CONFIG: ParsedConfig = Object.freeze({
  includeIgnored: Object.freeze([]) as unknown as string[],
});

/**
 * Read + JSON-parse a `codegraph.json` once and return its validated view.
 * Every failure mode degrades to the zero-config default — a missing file,
 * bad JSON, or a typo'd value never throws.
 */
function parseConfig(file: string): ParsedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${PROJECT_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_CONFIG;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_CONFIG;

  const includeIgnored = extractIncludeIgnored(parsed, file);
  if (includeIgnored.length === 0) {
    return EMPTY_CONFIG;
  }
  return { includeIgnored };
}

/**
 * Validate the `includeIgnored` patterns: an array of non-empty gitignore-style
 * strings. A non-array value or a non-string/blank entry warns-and-skips; never
 * throws. Patterns are kept verbatim (trimmed) so they match exactly as a
 * `.gitignore` line would.
 */
function extractIncludeIgnored(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).includeIgnored;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "includeIgnored" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "includeIgnored" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Load the parsed `codegraph.json` for a project, mtime-cached. A missing or
 * malformed file yields the zero-config default. One `stat` (and at most one
 * read/parse) while a single config file is in force.
 */
function loadParsedConfig(rootDir: string): ParsedConfig {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No config file — drop any stale cache entry and return the default.
    cache.delete(rootDir);
    return EMPTY_CONFIG;
  }

  const entry = cache.get(rootDir);
  if (entry && entry.mtimeMs === mtimeMs) return entry.config;

  const config = parseConfig(file);
  cache.set(rootDir, { mtimeMs, config });
  return config;
}

/**
 * Load the validated `includeIgnored` patterns for a project, mtime-cached.
 *
 * These name gitignored directories whose embedded git repositories should be
 * indexed despite `.gitignore` (#622, #699). An empty result — the zero-config
 * default — means `.gitignore` is fully respected: gitignored embedded repos
 * are never discovered or indexed.
 */
export function loadIncludeIgnoredPatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).includeIgnored;
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting it in a test). */
export function clearProjectConfigCache(): void {
  cache.clear();
}

/**
 * Add gitignore-style patterns to a project's `codegraph.json` `includeIgnored`
 * list, creating the file if absent and preserving every other key. Used by
 * tooling to opt a "super-repo of gitignored child repos" (#1156) into the
 * index on the user's say-so. Returns the count of patterns actually ADDED
 * (ones already present are skipped, so a re-run is idempotent).
 *
 * A plain-JSON round-trip: a `codegraph.json` carrying comments (not valid
 * JSON) already fails to load with a warning, so rather than silently clobber
 * such a file this throws when an existing config won't parse. Invalidates the
 * config cache so a subsequent index in the same process sees the new patterns.
 */
export function addIncludeIgnoredPatterns(rootDir: string, patterns: string[]): number {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);
  let config: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    raw = null; // missing file — create a fresh one below
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${PROJECT_CONFIG_FILENAME} is not valid JSON — fix it by hand, then re-run.`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  }

  const existing = Array.isArray(config.includeIgnored)
    ? (config.includeIgnored as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const merged = [...existing];
  const seen = new Set(existing);
  let added = 0;
  for (const p of patterns) {
    if (seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
    added++;
  }
  config.includeIgnored = merged;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  clearProjectConfigCache();
  return added;
}
