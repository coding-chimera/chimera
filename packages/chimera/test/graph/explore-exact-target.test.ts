/**
 * EXACT targets in `codegraph_explore`: a qualified name (`SQLCompiler.as_sql`)
 * or a line anchor (`compiler.py:776`, `compiler.py lines 900-1003`).
 *
 * Fork port of upstream #2063 (47840a6). The originating gap (django):
 * `SQLCompiler.as_sql pre_sql_setup get_select` returned the small named steps
 * in full and `SQLCompiler.as_sql` — the qualified name, 226 lines — as ONE
 * signature line, because the per-symbol focused view chose bodies in SOURCE
 * order within a tier and the unnamed bridges above it took the cap. Its
 * follow-ups (`compiler.py:776`, `compiler.py lines 900-1003`) pinned the file
 * but dropped the line numbers, so they returned other methods' clusters — and
 * every agent run ended in a Read of compiler.py.
 *
 * Fork adaptation notes:
 * - the fork renders `#### <file>` sections (not upstream's `**`<file>`**`);
 * - upstream's oversize-body WINDOWING (head + focus-line windows, elision
 *   notes naming the explore query that returns each hole) is NOT ported — the
 *   fork keeps its greedy body cap where the first/highest-tier body always
 *   renders whole — so the upstream planner.py windowing case has no fork
 *   analogue and is not tested here;
 * - exact targets ride the fork's existing render paths: focused-view tier 0,
 *   cluster importance 11, entry-fold for gate/scoring, blast-radius lead.
 */
import { describe, it, expect, beforeAll, afterAll } from './vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/graph/index';
import { ToolHandler } from '../../src/graph/mcp/tools';

const COMPILER = 'compiler.py';

/** Line numbers rendered for `file` in an explore response (`<n>\t` lines). */
function renderedLines(text: string, file: string): Set<number> {
  const out = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    const header = /^#### (.+?)(?: —|$)/.exec(line);
    if (header && !inFence) { current = header[1]!.trim(); continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence && current === file) {
      const m = /^(\d+)\t/.exec(line);
      if (m) out.add(Number(m[1]));
    }
  }
  return out;
}

/** The `#### <file>` section, header through the line before the next header. */
function sectionFor(text: string, file: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`#### ${file}`));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('#### ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** `n` filler statements, each a distinct line so nothing dedups or folds. */
function filler(tag: string, n: number, indent = '        '): string {
  return Array.from({ length: n }, (_, i) =>
    `${indent}${tag}_${i} = self.query.alias_refcount.get("${tag}_${i}", 0) + len(self.query.select)`,
  ).join('\n');
}

/**
 * Unrelated methods, so compiler.py is a real family file's size (django's is
 * 2,291 lines): small enough to ship WHOLE, the file would answer every
 * question by accident and hide the gap.
 */
function helpers(n: number): string {
  return Array.from({ length: n }, (_, i) => `
    def helper_${i}(self, value):
        """Unrelated helper ${i}."""
        first = self.query.alias_map.get(value)
        second = self.query.alias_refcount.get(value, 0)
        third = self.query.external_aliases.get(value, False)
        return first, second, third`).join('\n');
}

describe('codegraph_explore — exact targets (qualified names, line anchors)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const lineOf: Record<string, number> = {};

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-exact-'));

    // compiler.py — get_select and get_qualify_sql ABOVE as_sql, as in django;
    // compile_debug is a uniquely-named method OFF any call path between the
    // others, so the focused view engages (an off-spine named callable exists).
    const compiler = `
class SQLCompiler:
    def pre_sql_setup(self, with_col_aliases=False):
        # PRE_SQL_SETUP_BODY
        self.setup_query(with_col_aliases=with_col_aliases)
        order_by = self.get_order_by()
        return order_by

    def setup_query(self, with_col_aliases=False):
        self.select = self.get_select(with_col_aliases=with_col_aliases)
        return self.select

    def get_order_by(self):
        return []

    def get_select(self, with_col_aliases=False):
        # GET_SELECT_BODY
${filler('sel', 8)}
        return []

    def get_qualify_sql(self):
        # GET_QUALIFY_BODY
${filler('qual', 8)}
        inner = self.get_select()
        return inner

    def as_sql(self, with_limits=True, with_col_aliases=False):
        # AS_SQL_HEAD
        order_by = self.pre_sql_setup(with_col_aliases=with_col_aliases)
${filler('head', 15)}
        result = self.get_qualify_sql()
${filler('tail', 15)}
        return result  # AS_SQL_TAIL_MARKER

    def execute_sql(self):
        sql = self.as_sql()
        return sql

    def compile_debug(self):
        # COMPILE_DEBUG_BODY
${filler('dbg', 10)}
        return None


${helpers(40)}

def render_sql(compiler):
    return SQLCompiler.as_sql(compiler)


class SQLInsertCompiler(SQLCompiler):
    def as_sql(self):
        # INSERT_AS_SQL_BODY
        return super().as_sql()

    def execute_sql(self):
        sql = self.as_sql()
        return sql


class SQLUpdateCompiler(SQLCompiler):
    def as_sql(self):
        # UPDATE_AS_SQL_BODY
        return super().as_sql()

    def pre_sql_setup(self):
        # UPDATE_PRE_SQL_SETUP_BODY
        return super().pre_sql_setup()


class SQLDeleteCompiler(SQLCompiler):
    def as_sql(self):
        # DELETE_AS_SQL_BODY
        return super().as_sql()
`.trimStart();
    fs.writeFileSync(path.join(testDir, COMPILER), compiler);
    const compilerLines = compiler.split('\n');
    const find = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    lineOf.asSqlDef = find(compilerLines, 'def as_sql(self, with_limits');
    lineOf.asSqlTail = find(compilerLines, 'AS_SQL_TAIL_MARKER');
    lineOf.asSqlTailStart = find(compilerLines, 'result = self.get_qualify_sql()') + 1;

    // Other `as_sql`s, so the bare name is a family (as django's 110 are).
    fs.writeFileSync(path.join(testDir, 'lookups.py'), `
class Exact:
    def as_sql(self, compiler, connection):
        return "%s = %s"


class IExact:
    def as_sql(self, compiler, connection):
        return "UPPER(%s) = UPPER(%s)"
`.trimStart());

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 180_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const explore = async (query: string): Promise<string> => {
    const result = await handler.execute('codegraph_explore', { query });
    return result.content?.[0]?.text ?? '';
  };

  it('fixture sanity: the qualified name resolves to exactly one callable', () => {
    const defs = cg.getNodesByName('as_sql').filter((n) => n.kind === 'method');
    expect(defs.length).toBeGreaterThanOrEqual(6); // family: base + 3 subclasses + 2 lookups
    const sqlCompilerDef = defs.find((n) => n.qualifiedName.includes('SQLCompiler::as_sql'));
    expect(sqlCompilerDef).toBeTruthy();
    expect(lineOf.asSqlDef).toBeGreaterThan(0);
    expect(lineOf.asSqlTail).toBeGreaterThan(lineOf.asSqlDef!);
  });

  it("returns the qualified method's WHOLE body, not its signature line", async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select compile_debug');
    const section = sectionFor(text, COMPILER);
    expect(section, 'the family file renders as a per-symbol view').toContain('· focused');
    const lines = renderedLines(text, COMPILER);
    for (let ln = lineOf.asSqlDef!; ln <= lineOf.asSqlTail!; ln++) {
      expect(lines.has(ln), `as_sql line ${ln} rendered`).toBe(true);
    }
    expect(section).toContain('AS_SQL_TAIL_MARKER');
    // The other named steps still get their bodies too.
    expect(section).toContain('GET_SELECT_BODY');
    expect(section).toContain('COMPILE_DEBUG_BODY');
  });

  it('keeps the family skeleton for the subclasses: their as_sql overrides stay signatures', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select compile_debug');
    const section = sectionFor(text, COMPILER);
    expect(section).not.toContain('INSERT_AS_SQL_BODY');
    expect(section).not.toContain('UPDATE_AS_SQL_BODY');
    expect(section).not.toContain('DELETE_AS_SQL_BODY');
  });

  it('leads the blast radius with the qualified method, not a same-named override', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select compile_debug');
    const blastStart = text.indexOf('### Blast radius');
    expect(blastStart).toBeGreaterThanOrEqual(0);
    const blast = text.slice(blastStart);
    const first = blast.split('\n').find((l) => l.startsWith('- `'));
    expect(first).toContain(`\`as_sql\` (${COMPILER}:${lineOf.asSqlDef})`);
  });

  it('a `file:line` anchor returns the method enclosing that line, whole', async () => {
    // No symbol named — the line alone has to say which method.
    const text = await explore(`${COMPILER}:${lineOf.asSqlDef! + 20} full body`);
    expect(text).toContain('1 file pinned from the query.');
    const lines = renderedLines(text, COMPILER);
    for (let ln = lineOf.asSqlDef!; ln <= lineOf.asSqlTail!; ln++) {
      expect(lines.has(ln), `as_sql line ${ln} rendered`).toBe(true);
    }
  });

  it('a `lines A-B` range returns exactly that span of the pinned file', async () => {
    // The tail of `as_sql` — the span a windowed render elides and the agent
    // then asks for by number (django's `lines 900-1003 as_sql tail`).
    const a = lineOf.asSqlTailStart!;
    const b = lineOf.asSqlTail!;
    const text = await explore(`${COMPILER} lines ${a}-${b} tail`);
    const lines = renderedLines(text, COMPILER);
    for (let ln = a; ln <= b; ln++) expect(lines.has(ln), `line ${ln} rendered`).toBe(true);
  });
});
