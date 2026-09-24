/**
 * updateNode persistence bugfix tests (pre-existing bug, introduced in
 * cfd471130): the UPDATE nodes SET list ended with a trailing comma before
 * WHERE (and omitted updated_at entirely, though the bind object supplied
 * it), so db.prepare threw `near "WHERE": syntax error` on EVERY call.
 * runPostExtract wraps the updateNode loop in try/catch + logDebug, so the
 * failure was silently swallowed: framework postExtract node updates (the
 * NestJS RouterModule route-name prefixing pass) were NEVER persisted since
 * the bug landed.
 *
 * Coverage:
 *   a) updateNode direct unit test — every SET column round-trips, including
 *      updated_at (the column the broken statement omitted); the validation
 *      guard still skips rows with missing required fields.
 *   b) runPostExtract end-to-end — a NestJS fixture (RouterModule prefix +
 *      @Module controllers + decorated controller) indexed through the real
 *      CodeGraph pipeline persists the prefixed route names, keeps ids /
 *      qualifiedNames / route→handler edges intact, and is idempotent on a
 *      second pass (the applyModulePrefix qualifiedName-recovery contract).
 *
 * Semantic note (bump analysis in the fix commit): the persisted change is
 * confined to route-kind nodes' name/search_text/updated_at in NestJS +
 * RouterModule projects; ids are preserved so the stored EDGE population is
 * unchanged, and route names (synthetic `METHOD /path` strings) are never
 * resolution match subjects — EXTRACTION_SEMANTICS_VERSION stays 5.
 */

import { describe, it, expect, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { DatabaseConnection } from '../../src/graph/db';
import { QueryBuilder } from '../../src/graph/db/queries';
import type { Node } from '../../src/graph/types';

const dirs: string[] = [];
function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-updatenode-${tag}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function node(overrides: Partial<Node> & { id: string; name: string }): Node {
  return {
    kind: 'function',
    qualifiedName: overrides.name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as Node;
}

// ---------------------------------------------------------------------------
// a) updateNode direct
// ---------------------------------------------------------------------------

describe('updateNode — SET list round-trip (regression: trailing-comma prepare failure)', () => {
  it('persists every column, including updated_at', () => {
    const dir = tempDir('unit');
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(conn.getDb());
    try {
      queries.insertNodes([node({ id: 'function:f1', name: 'f1' })]);

      queries.updateNode(
        node({
          id: 'function:f1',
          name: 'f1Renamed',
          qualifiedName: 'mod.f1Renamed',
          kind: 'method',
          startLine: 10,
          endLine: 20,
          startColumn: 2,
          endColumn: 3,
          docstring: 'Updated docs.',
          signature: '(a: string): void',
          visibility: 'private',
          isExported: true,
          isAsync: true,
          isStatic: false,
          isAbstract: true,
          decorators: ['Injectable'],
          typeParameters: ['T'],
          returnType: 'void',
          params: [{ name: 'a', type: 'string' }],
          updatedAt: 1_700_000_999_999,
        })
      );

      const row = conn
        .getDb()
        .prepare(
          `SELECT kind, name, qualified_name, start_line, end_line, start_column, end_column,
                  docstring, signature, visibility, is_exported, is_async, is_static, is_abstract,
                  decorators, type_parameters, return_type, params_json, search_text, updated_at
           FROM nodes WHERE id = 'function:f1'`
        )
        .get() as Record<string, unknown>;
      expect(row.kind).toBe('method');
      expect(row.name).toBe('f1Renamed');
      expect(row.qualified_name).toBe('mod.f1Renamed');
      expect(row.start_line).toBe(10);
      expect(row.end_line).toBe(20);
      expect(row.start_column).toBe(2);
      expect(row.end_column).toBe(3);
      expect(row.docstring).toBe('Updated docs.');
      expect(row.signature).toBe('(a: string): void');
      expect(row.visibility).toBe('private');
      expect(row.is_exported).toBe(1);
      expect(row.is_async).toBe(1);
      expect(row.is_static).toBe(0);
      expect(row.is_abstract).toBe(1);
      expect(row.decorators).toBe(JSON.stringify(['Injectable']));
      expect(row.type_parameters).toBe(JSON.stringify(['T']));
      expect(row.return_type).toBe('void');
      expect(row.params_json).toBe(JSON.stringify([{ n: 'a', t: 'string' }]));
      // search_text recomputed from the NEW name (buildSearchText binding).
      expect(String(row.search_text)).toContain('renamed');
      // The column the broken statement omitted — now in the SET list.
      expect(row.updated_at).toBe(1_700_000_999_999);

      // The QueryBuilder node cache was invalidated (getNodeById sees new values).
      expect(queries.getNodeById('function:f1')?.name).toBe('f1Renamed');

      // Validation guard: a row missing a required field is skipped, not thrown.
      queries.updateNode(node({ id: 'function:f1', name: '' }));
      expect(queries.getNodeById('function:f1')?.name).toBe('f1Renamed');
    } finally {
      queries.dispose();
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// b) runPostExtract end-to-end persistence (NestJS RouterModule prefixing)
// ---------------------------------------------------------------------------

const NEST_FIXTURE: Array<[string, string]> = [
  ['package.json', JSON.stringify({ name: 'nest-fixture', dependencies: { '@nestjs/common': '^10.0.0', '@nestjs/core': '^10.0.0' } })],
  [
    'users.controller.ts',
    [
      "import { Controller, Get } from '@nestjs/common';",
      '',
      "@Controller('users')",
      'export class UsersController {',
      '  @Get()',
      '  findAll(): string[] {',
      '    return [];',
      '  }',
      '',
      "  @Get(':id')",
      '  findOne(): string {',
      "    return 'one';",
      '  }',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'users.module.ts',
    [
      "import { Module } from '@nestjs/common';",
      "import { UsersController } from './users.controller';",
      '',
      '@Module({',
      '  controllers: [UsersController],',
      '})',
      'export class UsersModule {}',
      '',
    ].join('\n'),
  ],
  [
    'app.module.ts',
    [
      "import { Module } from '@nestjs/common';",
      "import { RouterModule } from '@nestjs/core';",
      "import { UsersModule } from './users.module';",
      '',
      '@Module({',
      '  imports: [',
      '    UsersModule,',
      "    RouterModule.register([{ path: 'admin', module: UsersModule }]),",
      '  ],',
      '})',
      'export class AppModule {}',
      '',
    ].join('\n'),
  ],
];

describe('runPostExtract — framework node updates persist (regression: silently swallowed prepare failure)', () => {
  it(
    'NestJS RouterModule prefixes route-node names in the DB, preserving ids/qualifiedNames/edges, idempotently',
    async () => {
      const dir = tempDir('e2e');
      for (const [rel, content] of NEST_FIXTURE) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
      let cg: CodeGraph | null = null;
      try {
        // indexAll runs resolver.initialize() + runPostExtract() internally.
        cg = await CodeGraph.init(dir, { index: true });
        const db = (cg as unknown as { db: { getDb(): ReturnType<DatabaseConnection['getDb']> } }).db.getDb();

        const routes = db
          .prepare(`SELECT id, name, qualified_name FROM nodes WHERE kind = 'route' ORDER BY name`)
          .all() as Array<{ id: string; name: string; qualified_name: string }>;
        expect(routes.length).toBeGreaterThanOrEqual(2);

        // The prefix landed IN THE DATABASE (before the fix these stayed
        // 'GET /users' / 'GET /users/:id' because updateNode always threw).
        const names = routes.map((r) => r.name);
        expect(names.some((n) => n === 'GET /admin/users')).toBe(true);
        expect(names.some((n) => n === 'GET /admin/users/:id')).toBe(true);

        // id + qualifiedName deliberately preserved (edge stability +
        // idempotence contract of applyModulePrefix).
        for (const r of routes) {
          expect(r.qualified_name).toContain('users.controller.ts::GET:');
        }

        // route→handler edges survived (they reference the preserved ids).
        const routeEdgeCount = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM edges WHERE source IN (SELECT id FROM nodes WHERE kind = 'route')
               OR target IN (SELECT id FROM nodes WHERE kind = 'route')`
            )
            .get() as { c: number }
        ).c;
        expect(routeEdgeCount).toBeGreaterThan(0);

        // search_text tracks the new name (FTS-visible surface).
        const searchText = (
          db.prepare(`SELECT search_text FROM nodes WHERE name = 'GET /admin/users'`).get() as {
            search_text: string;
          }
        ).search_text;
        expect(searchText).toContain('admin');

        // Idempotence: a second runPostExtract neither double-prefixes nor
        // loses the prefix (qualifiedName recovers the original in-file path).
        const resolver = (cg as unknown as { resolver: { runPostExtract(): number } }).resolver;
        resolver.runPostExtract();
        const namesAgain = (
          db.prepare(`SELECT name FROM nodes WHERE kind = 'route' ORDER BY name`).all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(namesAgain).toEqual(names);
      } finally {
        await cg?.close();
      }
    },
    120_000
  );
});
