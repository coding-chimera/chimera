/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as os from 'os';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, isFileLevelOnlyLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import { loadIncludeIgnoredPatterns } from '../config';
import { ParseWorkerPool, resolveParsePoolSize, resolveParseTimeoutMs } from './parse-pool';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath } from '../utils';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

// Compiled single-binary builds inject the parse-worker entrypoint path via
// CHIMERA_PARSE_WORKER_PATH (see script/build.ts). Source runs and tests fall
// back to a sibling parse-worker.js in dist, or undefined → in-process parsing.
declare global {
  const CHIMERA_PARSE_WORKER_PATH: string
}
function resolveParseWorkerPath(): string | undefined {
  if (typeof CHIMERA_PARSE_WORKER_PATH !== "undefined") return CHIMERA_PARSE_WORKER_PATH
  const dist = path.join(__dirname, 'parse-worker.js')
  if (fs.existsSync(dist)) return dist
  return undefined
}

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
  changedFiles?: Array<{ path: string; status: 'added' | 'modified' | 'removed' }>;
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Skip files larger than this (bytes). Generated bundles, minified JS, and
 * vendored blobs blow the WASM heap and the worker-recycle budget for no useful
 * symbols. 1 MB covers essentially all hand-written source.
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks CodeGraph supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); the only opt-in is an
 * explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because CodeGraph indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  '.chimera', '.codegraph',
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  'target', '.gradle',
  // .NET
  'obj',
  // Vendored deps (Go, PHP/Composer, Ruby/Bundler)
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
];

/** True if `buf` decodes as strict UTF-8 (no invalid byte sequences). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a `.gitignore` and return patterns safe to hand to the `ignore` matcher —
 * never throwing, even when the file isn't real gitignore text. Two failure
 * modes, both seen in the wild:
 *
 *  - The file isn't valid UTF-8 — e.g. transparently encrypted in place by
 *    corporate DLP / endpoint-security software, leaving a UTF-16 header plus
 *    ciphertext. None of it is meaningful patterns, so the whole file is skipped.
 *  - The file is text but a single line can't be compiled to a regex by the
 *    `ignore` library — `\\[` and friends throw "Unterminated character class".
 *    Crucially the throw is LAZY (at match time, not `.add()`), so it would
 *    otherwise escape mid-scan. That one pattern is dropped; the rest are kept.
 *
 * Either way a warning that NAMES the file is logged and indexing continues
 * instead of aborting. Returns '' when there's nothing usable.
 */
function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // unreadable (permissions / race) — treat as absent
  }
  // A NUL byte never appears in real gitignore text, and a fatal UTF-8 decode
  // catches the rest. Such a file isn't ignore patterns at all.
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
        'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // Fast path: one `.ignores()` call forces the library to compile EVERY rule,
  // so if it doesn't throw, the whole file is safe to use verbatim.
  try {
    ignore().add(content).ignores('.chimera-probe');
    return content;
  } catch {
    // Fall through: a line is uncompilable — keep the good ones, drop the bad.
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    try {
      ignore().add(line).ignores('.chimera-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default. Shared
 * by both enumeration paths so behavior is identical with or without git — and so
 * the defaults apply to tracked files too (committing a dependency dir doesn't make
 * it project code; the explicit `.gitignore` negation is the only opt-in).
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}

/**
 * Classify a directory's `.git` entry for embedded-repo discovery.
 *
 * - A `.git` **directory** is an embedded clone — distinct first-party code a
 *   super-repo merely hides from git; index it.
 * - A `.git` **file** is a pointer (`gitdir: …`). A git **worktree** points into
 *   the host repo's own `.git/worktrees/<name>`, so it is a second working view
 *   of a repo already indexed through its main checkout — indexing it just
 *   duplicates the whole graph N times; skip it. A **submodule worktree** points
 *   into `.git/modules/<module>/worktrees/<name>` — same duplication, skip it
 *   too. A **submodule** checkout points into `.git/modules/<module>` (no
 *   `worktrees/` segment) and is distinct code, so index it as before.
 *
 * Returns `'none'` when there is no `.git` entry here.
 */
function classifyGitDir(absDir: string): 'embedded' | 'worktree' | 'none' {
  let st: fs.Stats;
  try {
    st = fs.statSync(path.join(absDir, '.git'));
  } catch {
    return 'none';
  }
  if (st.isDirectory()) return 'embedded';
  if (!st.isFile()) return 'none';
  try {
    const gitdir = fs.readFileSync(path.join(absDir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    // A worktree's gitdir lives under some repo's `.git/worktrees/<name>` —
    // either the top-level repo's (`.git/worktrees/`) or, for a worktree of a
    // submodule, that submodule's gitdir (`.git/modules/<module>/worktrees/`).
    // The optional `modules/<module>` segment covers the submodule case.
    // Match both separators so a Windows-style pointer is recognized too.
    if (gitdir && /(^|[\\/])\.git[\\/](modules[\\/][^\\/]+[\\/])?worktrees[\\/]/.test(gitdir)) return 'worktree';
  } catch {
    // Unreadable `.git` pointer — fall back to the prior "index it" behavior.
  }
  return 'embedded';
}

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.)
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, includeIgnored: Ignore | null = null): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  // -z gives NUL-separated, unquoted output so non-ASCII (e.g. CJK) paths
  // survive verbatim. Without it git octal-escapes and double-quotes such paths
  // (the core.quotepath default), and the quoted form never matches a real file
  // on disk → those files are silently dropped from the index.
  const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
  for (const entry of tracked.split('\0')) {
    if (entry) {
      files.add(normalizePath(prefix + entry));
    }
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git classification anyway, and skip anything else exactly
      // as git itself skips it (we never descend into a non-repo opaque dir).
      // A worktree's `.git` is a FILE pointer into the host repo's
      // `.git/worktrees/<name>` — a duplicate working view of a repo already
      // indexed through its main checkout — so it is skipped here too.
      const childDir = path.join(repoDir, rel);
      if (classifyGitDir(childDir) === 'embedded') {
        collectGitFiles(childDir, prefix + rel, files, includeIgnored);
      }
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // Gitignored directories the project opted into via codegraph.json
  // `includeIgnored` (#622, #699): `ls-files -o -i` lists ignored untracked
  // entries; those matching an opted-in pattern and containing an embedded
  // repo are recursed so their source gets indexed despite .gitignore.
  if (includeIgnored) {
    try {
      const ignored = execFileSync('git', ['ls-files', '-z', '-o', '-i', '--exclude-standard'], gitOpts);
      for (const rel of ignored.split('\0')) {
        if (!rel || !rel.endsWith('/')) continue;
        if (!includeIgnored.ignores(normalizePath(rel))) continue;
        const childDir = path.join(repoDir, rel);
        if (classifyGitDir(childDir) === 'embedded') {
          collectGitFiles(childDir, prefix + rel, files, includeIgnored);
        }
      }
    } catch {
      // ls-files -i unavailable — fall back to .gitignore-respecting behaviour
    }
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    // codegraph.json `includeIgnored` opt-in: gitignored embedded repos are
    // discovered despite .gitignore; no patterns means .gitignore is fully
    // respected (null matcher, zero overhead).
    const includeIgnoredPatterns = loadIncludeIgnoredPatterns(rootDir);
    const includeIgnored = includeIgnoredPatterns.length > 0 ? ignore().add(includeIgnoredPatterns) : null;
    collectGitFiles(rootDir, '', files, includeIgnored);
    // Apply built-in default ignores uniformly — to tracked files too, since
    // committing a dependency/build dir doesn't make it project code. A
    // `.gitignore` negation (e.g. `!vendor/`) is the explicit opt-in. (issue #407)
    const ig = buildDefaultIgnore(rootDir);
    // includeIgnored-resurrected files (gitignored embedded repos opted in via
    // codegraph.json) are exempt from the default-ignore filter — the opt-in
    // would otherwise be undone by the root .gitignore the matcher includes.
    return new Set([...files].filter((f) => !ig.ignores(f) || (includeIgnored !== null && includeIgnored.ignores(f))));
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--no-renames'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const line of output.split('\n')) {
      if (line.length < 4) continue; // Minimum: "XY file"

      const statusCode = line.substring(0, 2);
      const filePath = normalizePath(line.substring(3));

      // Skip non-source files (git status already omits .gitignored paths).
      if (!isSourceFile(filePath)) continue;

      if (statusCode === '??') {
        added.push(filePath);
      } else if (statusCode.includes('D')) {
        deleted.push(filePath);
      } else {
        // M, MM, AM, A (staged), etc. — treat as modified
        modified.push(filePath);
      }
    }

    return { modified, added, deleted };
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();

  // A .gitignore matcher scoped to the directory that declared it. Patterns in
  // a nested .gitignore are relative to that directory, so we keep the dir
  // alongside the matcher and test paths relative to it — mirroring how git
  // applies .gitignore files at every level.
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;
    return { dir, ig: ignore().add(readGitignorePatterns(giPath)) };
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
      if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    // The root's .gitignore is already merged into the seeded base matcher (so a
    // negation there can override a built-in default), so skip it here.
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or Chimera graph data directories.
      if (entry.name === '.git' || entry.name === '.chimera' || entry.name === '.codegraph') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  // Seed a base matcher with the built-in default ignores (merged with the root
  // .gitignore so a negation can override). Nested .gitignores still layer per-dir.
  walk(rootDir, [{ dir: rootDir, ig: buildDefaultIgnore(rootDir) }]);
  return files;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  private detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.queries = queries;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
      // Monorepo support — needed by framework detect()s that probe
      // subpackage manifests (e.g. fabric-view looking at
      // packages/<sub>/package.json when the root manifest is just a
      // workspace declaration). Matches the resolver-context shape.
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? rootDir
            : path.join(rootDir, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir);
    const context = this.buildDetectionContext(fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
    const total = files.length;
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Try to use a pool of worker threads for parsing (keeps main thread
    // unblocked and uses every core). Falls back to in-process parsing when
    // the compiled worker is unavailable (e.g. running from source in tests).
    const parseWorkerPath = resolveParseWorkerPath()
    const useWorker = parseWorkerPath !== undefined

    let pool: ParseWorkerPool | null = null;
    if (useWorker) {
      // CODEGRAPH_PARSE_WORKERS: explicit worker count; 1 = the old
      // single-worker behaviour (the conservative rollback). Unset →
      // clamp(cores-1, 1, 8).
      const poolSize = resolveParsePoolSize(process.env.CODEGRAPH_PARSE_WORKERS, os.cpus().length);
      pool = new ParseWorkerPool({
        languages: neededLanguages,
        size: poolSize,
        workerScriptPath: parseWorkerPath,
        recycleInterval: WORKER_RECYCLE_INTERVAL,
        parseTimeoutMs: PARSE_TIMEOUT_MS,
        log,
      });
      log(`Parse worker pool: ${poolSize} worker(s)`);
    } else {
      // In-process fallback: load grammars locally and parse on the main thread.
      await loadGrammarsForLanguages(neededLanguages);
    }

    /**
     * Parse one file: on the pool when available (the promise REJECTS on a
     * worker crash/timeout — the caller records it and the retry pass
     * re-attempts), or in-process synchronously as the no-worker fallback.
     */
    const parseFile = (filePath: string, content: string): Promise<ExtractionResult> => {
      if (!pool) return Promise.resolve(extractFromSource(filePath, content, detectLanguage(filePath, content), frameworkNames));
      return pool.requestParse({ filePath, content, frameworkNames });
    };

    // --- Bounded rolling-window dispatch, ordered commit ---
    // Reads stay batched/parallel; parses run concurrently across the pool;
    // the SQLite store stays on the main thread (it isn't thread-safe).
    // Crucially we COMMIT results in original file order, not parse-completion
    // order: the resolution phase (run after indexing) resolves an ambiguous
    // reference to one of several same-named candidates by the nodes' DB
    // insertion order, so a stable commit order keeps the resulting graph
    // deterministic — byte-identical to the single-worker path — instead of
    // drifting with parse timing. The `completed` buffer holds at most ~window
    // size out-of-order results, so memory stays bounded.
    const windowSize = pool ? Math.max(4, pool.size * 2) : 1;
    const inFlight = new Set<Promise<void>>();
    const completed = new Map<number,
      | { ok: true; filePath: string; content: string; stats: fs.Stats; result: ExtractionResult }
      | { ok: false; filePath: string; err: unknown }>();
    let nextSeq = 0;       // file-order sequence assigned at dispatch
    let nextToStore = 0;   // cursor: next sequence to commit
    let aborted = false;

    const storeResult = async (filePath: string, content: string, stats: fs.Stats, result: ExtractionResult): Promise<void> => {
      processed++;

      // Store in database on main thread (SQLite is not thread-safe)
      if (result.nodes.length > 0 || result.errors.length === 0) {
        const language = detectLanguage(filePath, content);
        this.storeExtractionResult(filePath, content, language, stats, result);
      }

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          if (!err.filePath) err.filePath = filePath;
        }
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        // Files with no symbols but no errors (yaml, twig, properties) are
        // tracked at the file level — count them as indexed so the CLI doesn't
        // misleadingly report "No files found to index".
        const lang = detectLanguage(filePath, content);
        if (isFileLevelOnlyLanguage(lang)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }

      onProgress?.({ phase: 'parsing', current: processed, total, currentFile: filePath });
    };

    const recordParseFailure = (filePath: string, err: unknown): void => {
      processed++;
      filesErrored++;
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        filePath,
        severity: 'error',
        code: 'parse_error',
      });
      onProgress?.({ phase: 'parsing', current: processed, total });
    };

    // Commit buffered parses to the DB in file order, advancing the cursor
    // over contiguous completed results. Runs after each parse settles (and
    // once more after the drain). storeResult is async, so commits are
    // SERIALIZED on a promise chain — concurrent parse completions append to
    // the chain instead of interleaving mid-store, preserving both the
    // file-order commit invariant and the single-writer discipline for SQLite.
    let flushChain: Promise<void> = Promise.resolve();
    let flushError: unknown = null;
    const flushOrdered = (): Promise<void> => {
      flushChain = flushChain.then(async () => {
        if (aborted || flushError) return;
        try {
          while (completed.has(nextToStore)) {
            const item = completed.get(nextToStore)!;
            completed.delete(nextToStore);
            nextToStore++;
            if (item.ok) await storeResult(item.filePath, item.content, item.stats, item.result);
            else recordParseFailure(item.filePath, item.err);
          }
        } catch (err) {
          flushError = err;
        }
      });
      return flushChain;
    };

    // Dispatch one file's parse (parses run concurrently across the pool),
    // tagged with its file-order sequence so flushOrdered commits results in
    // order. The backpressure below bounds how far parsing runs ahead of the
    // in-order commit.
    const feed = async (filePath: string, content: string, stats: fs.Stats): Promise<void> => {
      const seq = nextSeq++;
      const p = (async () => {
        try {
          const result = await parseFile(filePath, content);
          completed.set(seq, { ok: true, filePath, content, stats, result });
        } catch (parseErr) {
          completed.set(seq, { ok: false, filePath, err: parseErr });
        }
        flushOrdered();
      })();
      const tracked = p.finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
      // Backpressure on the dispatched-but-not-yet-committed count (in-flight
      // + buffered), not just in-flight: a slow file sitting at the commit
      // cursor lets later parses finish and buffer, which would otherwise grow
      // without bound. Wait for parses to settle (each may advance the cursor)
      // until the window has room.
      while (nextSeq - nextToStore >= windowSize) {
        if (inFlight.size > 0) await Promise.race(inFlight);
        else await flushOrdered();
      }
    };

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const stats = await fsp.stat(fullPath);
            if (stats.size > MAX_FILE_SIZE) {
              return { filePath: fp, content: '', stats, error: null as Error | null };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // Dispatch each readable file into the bounded parse window; the window
      // stores results on the main thread as they arrive.
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        // Report progress before parsing (show current file being worked on)
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        // Honour MAX_FILE_SIZE. Without this check, vendored generated
        // headers, minified bundles, and other multi-MB files get indexed,
        // wasting WASM heap and the worker recycle budget on inputs with no
        // useful symbols. The single-file extractFile path already enforces
        // this; the bulk path used to silently skip the check.
        if (stats.size > MAX_FILE_SIZE) {
          processed++;
          filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // Parse on the pool (main thread stays unblocked); results commit in
        // file order via flushOrdered.
        await feed(filePath, content, stats);
      }
    }

    // Drain: wait for every dispatched parse to settle and commit.
    while (inFlight.size > 0) await Promise.race(inFlight);
    await flushOrdered();
    if (flushError) {
      throw flushError instanceof Error ? flushError : new Error(String(flushError));
    }

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry pass: files that failed due to WASM memory corruption may succeed
    // on a fresh worker with a clean heap. Recycle before each attempt so
    // every file gets the absolute cleanest WASM state possible.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && pool) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Fresh workers for every retry — maximum WASM headroom
        pool.recycleAll();

        let content: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await parseFile(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce WASM memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          pool.recycleAll();

          let fullContent: string;
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) continue;
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await parseFile(filePath, stripped);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, fullContent);
            const stats = await fsp.stat(path.join(this.rootDir, filePath));
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // Shut down the parse pool and clear any pending timers
    if (pool) await pool.destroy();

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked && isFileLevelOnlyLanguage(tracked.language)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Sync a bounded set of files with the current file state.
   *
   * This is the scoped counterpart to sync(): it reconciles only the provided
   * paths, including deletes. It is intended for host runtimes that already have
   * precise file-change events and do not want to scan the whole repository after
   * every edit.
   */
  async syncFiles(
    filePaths: string[],
    onProgress?: (progress: IndexProgress) => void
  ): Promise<SyncResult> {
    await initGrammars();
    const startTime = Date.now();
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];
    const changedFiles: Array<{ path: string; status: 'added' | 'modified' | 'removed' }> = [];

    const normalized = Array.from(new Set(filePaths.map((filePath) => {
      const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.rootDir, filePath);
      const relative = normalizePath(path.relative(this.rootDir, fullPath));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
      }
      return relative;
    }).filter((filePath): filePath is string => !!filePath)));

    onProgress?.({
      phase: 'scanning',
      current: normalized.length,
      total: normalized.length,
    });

    const filesToIndex: string[] = [];
    for (const filePath of normalized) {
      const fullPath = path.join(this.rootDir, filePath);
      const tracked = this.queries.getFileByPath(filePath);

      if (!fs.existsSync(fullPath)) {
        if (tracked) {
          this.queries.deleteFile(filePath);
          changedFilePaths.push(filePath);
          changedFiles.push({ path: filePath, status: 'removed' });
          filesRemoved++;
        }
        continue;
      }

      if (!isSourceFile(filePath)) {
        if (tracked) {
          this.queries.deleteFile(filePath);
          changedFilePaths.push(filePath);
          changedFiles.push({ path: filePath, status: 'removed' });
          filesRemoved++;
        }
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during scoped sync', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      if (!tracked) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        changedFiles.push({ path: filePath, status: 'added' });
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        changedFiles.push({ path: filePath, status: 'modified' });
        filesModified++;
      }
    }

    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked: normalized.length,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // Prevent path traversal
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > MAX_FILE_SIZE) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.ensureDetectedFrameworks();
    const result = extractFromSource(relativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // No changes
    }

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Sync the index with the current file state.
   *
   * Change detection is filesystem-based, never git: a (size, mtime) stat
   * pre-filter skips unchanged files, then a content-hash compare confirms real
   * changes. This works in non-git projects and catches committed changes from
   * `git pull`/`checkout`/`merge`/`rebase` that `git status` cannot see.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];
    const changedFiles: Array<{ path: string; status: 'added' | 'modified' | 'removed' }> = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    // === Filesystem reconcile (git-independent) ===
    // The source of truth for "what changed" is the filesystem vs the indexed
    // state — never git. We enumerate the current source files and reconcile
    // each against the DB. A cheap (size, mtime) stat pre-filter skips unchanged
    // files without reading or hashing them, so the expensive read+hash+parse
    // only runs for files that actually changed. This catches edits/adds/deletes
    // whether or not the project uses git, and crucially also catches committed
    // changes from `git pull`/`checkout`/`merge`/`rebase` — which `git status`
    // cannot see, because the working tree is clean afterward.
    const currentFiles = scanDirectory(this.rootDir);
    filesChecked = currentFiles.length;
    const currentSet = new Set(currentFiles);

    const trackedFiles = this.queries.getAllFiles();
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    // Removals: tracked in the DB but no longer a present source file. Check the
    // filesystem directly — `scanDirectory` (via `git ls-files`) still lists a
    // file deleted from disk but not yet staged, so set membership alone misses it.
    for (const tracked of trackedFiles) {
      if (!currentSet.has(tracked.path) || !fs.existsSync(path.join(this.rootDir, tracked.path))) {
        this.queries.deleteFile(tracked.path);
        changedFilePaths.push(tracked.path);
        changedFiles.push({ path: tracked.path, status: 'removed' });
        filesRemoved++;
      }
    }

    // Adds / modifications.
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      const tracked = trackedMap.get(filePath);

      // Cheap pre-filter: an already-indexed file whose size AND mtime both match
      // the DB is unchanged — skip it without reading or hashing. (A content
      // change that preserves both exactly is the blind spot every mtime-based
      // incremental tool accepts; `index --force` is the escape hatch. Git bumps
      // mtime on every file it writes during checkout/merge, so pulls are caught.)
      if (tracked) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue;
          }
        } catch (error) {
          logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
          continue;
        }
      }

      // New, or size/mtime changed — read + hash to confirm a real content change.
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }
      const contentHash = hashContent(content);

      if (!tracked) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        changedFiles.push({ path: filePath, status: 'added' });
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        changedFiles.push({ path: filePath, status: 'modified' });
        filesModified++;
      }
    }

    // Load only grammars needed for changed files
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = getGitChangedFiles(this.rootDir);

    if (gitChanges) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Deleted files — only report if tracked in DB
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // Modified + added files — read + hash, compare with DB. Untracked (`??`)
      // files stay untracked in git even after indexing, so they must be
      // hash-compared like modified files instead of always counting as added —
      // otherwise status reports them as pending forever. (See issue #206.)
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const currentFiles = new Set(scanDirectory(this.rootDir));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
