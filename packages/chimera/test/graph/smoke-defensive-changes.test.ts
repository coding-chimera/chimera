import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { DatabaseConnection } from '../../src/graph/db/index';
import { QueryBuilder } from '../../src/graph/db/queries';
import { synthesizeCallbackEdges } from '../../src/graph/resolution/callback-synthesizer';
import type { ResolutionContext } from '../../src/graph/resolution/types';

/**
 * Smoke tests for the 6 defensive graph-core changes. Coverage map:
 *
 * 1. Ambiguous-name ceiling (name-matcher.ts, default 500, env-overridable)
 *    - existing: resolution.test.ts exercises the default ceiling
 *    - here: env override + CHIMERA_ alias + invalid-value fallback via child
 *      process (the ceiling is read once at module load, so env must be set
 *      before import).
 * 2. Worktree dedup + `git ls-files -z` + .gitignore defense (extraction/index.ts)
 *    - existing: extraction.test.ts — 'Git worktrees', 'CJK file names in git
 *      projects', 'Defensive .gitignore parsing' suites.
 * 3. Language-gated synthesis passes (callback-synthesizer.ts + queries.ts)
 *    - here: differential QueryBuilder/ctx call counting on a real DB — passes
 *      whose target language is absent from the index must not run any query.
 * 4. Unsafe index root refusal (directory.ts + cli/chimera.ts)
 *    - existing: unsafe-index-root.test.ts (unit level)
 *    - here: CLI-level child-process smoke of `graph init` / `graph index`
 *      refusal and exit code (with CODEGRAPH_NO_RELAUNCH=1 to skip the WASM
 *      flags re-exec, which changes the entry point under bun).
 * 5. Catch-up gate time-box (mcp/tools.ts, default 3000ms)
 *    - existing: mcp-catchup-gate.test.ts — 'time-boxes a never-resolving gate'
 * 6. Hot/cold SQLite tuning (db/index.ts: 64MB cache / 256MB mmap / FILE temp)
 *    - existing: pr19-improvements.test.ts covers env override
 *    - here: the NEW defaults + invalid env fallback.
 */

const packageRoot = path.resolve(import.meta.dir, '..', '..');

// =============================================================================
// 1. Ambiguous-name ceiling: env override / alias / invalid fallback
// =============================================================================

const ceilingScript = `
  import "./src/graph/env";
  import { matchByExactName } from "./src/graph/resolution/name-matcher";
  const cands = (n) => Array.from({ length: n }, (_, i) => ({
    id: "func:dup.ts:f:" + i,
    kind: "function",
    name: "dup",
    qualifiedName: "dup.ts::dup",
    filePath: "dup" + i + ".ts",
    language: "typescript",
    startLine: i + 1,
    endLine: i + 2,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: 0,
  }));
  const ref = { fromNodeId: "c", referenceName: "dup", referenceKind: "calls", line: 1, column: 1, filePath: "main.ts", language: "typescript" };
  const ctx = { getNodesByName: (name) => cands(name === "dup" ? CANDIDATE_COUNT : 0) };
  const result = matchByExactName(ref, ctx);
  console.log("RESULT:" + (result ? result.resolvedBy + ":" + result.targetNodeId : "null"));
`;

function runCeilingSmoke(env: Record<string, string>): string {
  const script = ceilingScript.replace('CANDIDATE_COUNT', env.CANDIDATE_COUNT ?? '4');
  const res = spawnSync('bun', ['-e', script], {
    cwd: packageRoot,
    env: { ...process.env, CANDIDATE_COUNT: env.CANDIDATE_COUNT ?? '4', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  expect(res.error).toBeUndefined();
  expect(res.status).toBe(0);
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'));
  expect(line, `subprocess output: ${res.stdout} ${res.stderr}`).toBeTruthy();
  return line!.replace('RESULT:', '');
}

describe('ambiguous-name ceiling (env overrides)', () => {
  it('honors CODEGRAPH_AMBIGUOUS_NAME_CEILING below the default', () => {
    // ceiling=3: 4 candidates are beyond it -> refuse; 3 are at it -> score.
    expect(runCeilingSmoke({ CODEGRAPH_AMBIGUOUS_NAME_CEILING: '3', CANDIDATE_COUNT: '4' })).toBe('null');
    expect(runCeilingSmoke({ CODEGRAPH_AMBIGUOUS_NAME_CEILING: '3', CANDIDATE_COUNT: '3' })).toMatch(/^exact-match:/);
  });

  it('honors the CHIMERA_ prefix alias via src/graph/env', () => {
    // env.ts copies CHIMERA_* -> CODEGRAPH_* before name-matcher loads.
    expect(runCeilingSmoke({ CHIMERA_AMBIGUOUS_NAME_CEILING: '2', CANDIDATE_COUNT: '3' })).toBe('null');
  });

  it('falls back to the 500 default for an invalid env value', () => {
    // "abc" is not an integer -> default 500 -> 4 candidates score normally.
    expect(runCeilingSmoke({ CODEGRAPH_AMBIGUOUS_NAME_CEILING: 'abc', CANDIDATE_COUNT: '4' })).toMatch(/^exact-match:/);
  });
});

// =============================================================================
// 3. Language-gated synthesis passes
// =============================================================================

function setupLangDb(langs: readonly string[]): { db: DatabaseConnection; qb: QueryBuilder } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-langdb-'));
  const db = DatabaseConnection.initialize(path.join(dir, 'g.db'));
  const raw = db.getDb();
  raw.exec('DELETE FROM files');
  const insert = raw.prepare(
    'INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, 1, 0, 0)',
  );
  langs.forEach((lang, i) => insert.run(`f${i}.${lang === 'xml' ? 'xml' : 'ext'}`, `h${i}`, lang));
  return { db, qb: new QueryBuilder(raw) };
}

function spyQueryBuilder(qb: QueryBuilder) {
  const byKind = new Map<string, number>();
  const other = new Map<string, number>();
  const proxy = new Proxy(qb, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'getNodesByKind') {
          const kind = String(args[0]);
          byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
        } else {
          other.set(String(prop), (other.get(String(prop)) ?? 0) + 1);
        }
        return value.apply(target, args);
      };
    },
  });
  return { proxy, byKind, other };
}

function spyContext() {
  const calls = { allFiles: 0 };
  const ctx = new Proxy({} as ResolutionContext, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'getAllFiles') {
        return () => {
          calls.allFiles++;
          return [];
        };
      }
      if (prop === 'readFile') return () => null;
      if (prop === 'fileExists') return () => false;
      if (prop === 'getProjectRoot') return () => '/tmp';
      return () => [];
    },
  });
  return { ctx, calls };
}

function runSynthesis(langs: readonly string[]) {
  const { db, qb } = setupLangDb(langs);
  try {
    const spy = spyQueryBuilder(qb);
    const ctxSpy = spyContext();
    const edges = synthesizeCallbackEdges(spy.proxy, ctxSpy.ctx);
    return { byKind: new Map(spy.byKind), other: new Map(spy.other), allFiles: ctxSpy.calls.allFiles, edges };
  } finally {
    db.close();
    fs.rmSync(path.dirname(db.getPath()), { recursive: true, force: true });
  }
}

describe('language-gated synthesis passes', () => {
  it('getDistinctFileLanguages reflects the indexed languages', () => {
    const { db, qb } = setupLangDb(['typescript', 'vue', 'go']);
    try {
      const langs = qb.getDistinctFileLanguages();
      expect([...langs].sort()).toEqual(['go', 'typescript', 'vue']);
    } finally {
      db.close();
      fs.rmSync(path.dirname(db.getPath()), { recursive: true, force: true });
    }
  });

  it('a ts-only project runs only the non-gated passes', () => {
    const r = runSynthesis(['typescript']);
    // Non-gated pass query shape on an empty nodes table:
    // fieldChannelEdges (method+function) + closureCollectionEdges (method+function)
    // + reactRenderEdges (class). interfaceOverrideEdges is NOT gated for the JS
    // family (typescript ∈ IFACE_OVERRIDE_LANGS), so it also runs here: one class
    // and one struct lookup. Gated passes (vue/dart/cpp/go/mybatis/gin) must not run.
    expect(r.byKind.get('method')).toBe(2);
    expect(r.byKind.get('function')).toBe(2);
    expect(r.byKind.get('class')).toBe(2); // reactRender + interface class loop
    expect(r.byKind.get('struct')).toBe(1); // interface struct loop
    // Only the gate's own language query runs besides the non-gated pass queries.
    expect([...r.other.keys()]).toEqual(['getDistinctFileLanguages']);
    expect(r.other.get('getDistinctFileLanguages')).toBe(1);
    expect(r.allFiles).toBeGreaterThan(0); // non-gated ctx passes still scan files
    expect(r.edges).toBe(0); // synthesized edge count on an empty graph
  });

  it('enables cpp/dart override passes when cpp/dart files exist', () => {
    const ts = runSynthesis(['typescript']);
    const cpp = runSynthesis(['typescript', 'cpp']);
    expect(cpp.byKind.get('class')).toBe((ts.byKind.get('class') ?? 0) + 1); // cppOverrideEdges
    const dart = runSynthesis(['typescript', 'dart']);
    expect(dart.byKind.get('class')).toBe((ts.byKind.get('class') ?? 0) + 1); // flutterBuildEdges
  });
  it('enables go passes only when go files exist', () => {
    const ts = runSynthesis(['typescript']);
    const go = runSynthesis(['typescript', 'go']);
    expect(go.byKind.get('struct')).toBe((ts.byKind.get('struct') ?? 0) + 1); // goGrpcStubImplEdges
    expect(go.byKind.get('method')).toBe((ts.byKind.get('method') ?? 0) + 1); // ginMiddlewareChainEdges
    expect(ts.byKind.get('struct')).toBe(1); // interface struct loop (JS-family pass, not gated)
  });

  it('enables interface + mybatis passes only when JVM/xml languages are present', () => {
    // 'go' is not in IFACE_OVERRIDE_LANGS, so the interface pass is OFF in this
    // baseline — unlike the typescript baseline above where it runs ungated.
    const goBase = runSynthesis(['go']);
    expect(goBase.byKind.get('class')).toBe(1); // reactRender only
    const goJava = runSynthesis(['go', 'java']);
    // interfaceOverrideEdges loops class + struct once each.
    expect(goJava.byKind.get('class')).toBe((goBase.byKind.get('class') ?? 0) + 1);
    expect(goJava.byKind.get('struct')).toBe((goBase.byKind.get('struct') ?? 0) + 1);
    expect(goJava.byKind.get('method')).toBe(goBase.byKind.get('method')); // mybatis still off
    const goJavaXml = runSynthesis(['go', 'java', 'xml']);
    expect(goJavaXml.byKind.get('method')).toBe((goJava.byKind.get('method') ?? 0) + 2); // mybatisJavaXmlEdges
    const goXml = runSynthesis(['go', 'xml']);
    expect(goXml.byKind.get('method')).toBe(goBase.byKind.get('method')); // xml alone opens nothing
  });

  it('enables the vue template pass only when vue files exist', () => {
    const ts = runSynthesis(['typescript']);
    const vue = runSynthesis(['typescript', 'vue']);
    // vueTemplateEdges is ctx-only; the gate must add exactly one getAllFiles scan.
    expect(vue.allFiles).toBe(ts.allFiles + 1);
  });
});

// =============================================================================
// 4. Unsafe index root refusal — CLI-level smoke
// =============================================================================

function runCli(args: readonly string[]) {
  const res = spawnSync('bun', ['src/index.ts', ...args], {
    cwd: packageRoot,
    env: { ...process.env, CODEGRAPH_NO_RELAUNCH: '1' },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { status: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

describe('unsafe index root — CLI refusal', () => {
  it.runIf(process.platform !== 'win32')('`graph init $HOME` refuses with exit code 1', () => {
    const r = runCli(['graph', 'init', os.homedir()]);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('Refusing to initialize');
    expect(r.output).toContain('home directory');
  });

  it.runIf(process.platform !== 'win32')('`graph index $HOME` refuses with exit code 1', () => {
    const r = runCli(['graph', 'index', os.homedir()]);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('Refusing to index');
    expect(r.output).toContain('home directory');
  });
});

// =============================================================================
// 6. Hot/cold SQLite tuning — new defaults + invalid env fallback
// =============================================================================

const SQLITE_ENV_KEYS = ['CHIMERA_SQLITE_CACHE_MB', 'CHIMERA_SQLITE_MMAP_MB', 'CHIMERA_SQLITE_TEMP_STORE'] as const;
const savedSqliteEnv = new Map<string, string | undefined>();

describe('hot/cold SQLite tuning', () => {
  afterEach(() => {
    for (const key of SQLITE_ENV_KEYS) {
      const saved = savedSqliteEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedSqliteEnv.clear();
  });

  const openPragmas = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sqlite-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'g.db'));
    const raw = db.getDb();
    const pragmas = {
      cacheSize: raw.pragma('cache_size', { simple: true }) as number,
      mmapSize: raw.pragma('mmap_size', { simple: true }) as number,
      tempStore: raw.pragma('temp_store', { simple: true }) as number,
    };
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return pragmas;
  };

  const setEnv = (key: string, value: string | undefined) => {
    if (!savedSqliteEnv.has(key)) savedSqliteEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  it('defaults match upstream codegraph: 64MB cache, 256MB mmap, FILE temp_store', () => {
    for (const key of SQLITE_ENV_KEYS) setEnv(key, undefined);
    const p = openPragmas();
    expect(p.cacheSize).toBe(-64 * 1024);
    expect(p.mmapSize).toBe(256 * 1024 * 1024);
    expect(p.tempStore).toBe(1); // FILE
  });

  it('env overrides still apply', () => {
    setEnv('CHIMERA_SQLITE_CACHE_MB', '16');
    setEnv('CHIMERA_SQLITE_MMAP_MB', '512');
    setEnv('CHIMERA_SQLITE_TEMP_STORE', 'MEMORY');
    const p = openPragmas();
    expect(p.cacheSize).toBe(-16 * 1024);
    expect(p.mmapSize).toBe(512 * 1024 * 1024);
    expect(p.tempStore).toBe(2); // MEMORY
  });

  it('invalid env values fall back to the defaults', () => {
    setEnv('CHIMERA_SQLITE_CACHE_MB', 'abc');
    setEnv('CHIMERA_SQLITE_MMAP_MB', '-5');
    setEnv('CHIMERA_SQLITE_TEMP_STORE', 'bogus');
    const p = openPragmas();
    expect(p.cacheSize).toBe(-64 * 1024);
    expect(p.mmapSize).toBe(256 * 1024 * 1024);
    expect(p.tempStore).toBe(1); // anything != MEMORY stays FILE
  });
});
