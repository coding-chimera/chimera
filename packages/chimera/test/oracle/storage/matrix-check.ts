#!/usr/bin/env bun
/**
 * WP-05 matrix coverage checker.
 *
 * Verifies that `specs/rust-host/authority/table-authority-matrix.md` covers:
 *   1. every Drizzle table declared by `src/**\/*.sql.ts` (plus the Drizzle
 *      migration ledger `__drizzle_migrations`), and
 *   2. every project-graph table: graph core + nodes_fts + storage-extension
 *      catalog + the Chimera overlay declared in `src/chimera/store.ts`.
 *
 * Also enforces one row per table with exactly 8 columns (9 pipe cells:
 * table name + owner/migrator/reader/writer/rebuildability/recovery/retention/
 * transfer protocol) and rejects duplicate rows.
 *
 * Run from packages/chimera:
 *   bun test/oracle/storage/matrix-check.ts
 */

import { readFileSync } from "node:fs"
import path from "node:path"

const here = import.meta.dirname
const pkgRoot = path.resolve(here, "../../..")
const matrixPath = path.join(pkgRoot, "specs/rust-host/authority/table-authority-matrix.md")
const srcRoot = path.join(pkgRoot, "src")

const COLUMNS = 8
const CELLS_PER_ROW = COLUMNS + 1

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch (error) {
    fail(`cannot read ${path.relative(pkgRoot, file)}: ${(error as Error).message}`)
  }
}

function section(markdown: string, name: "main-db" | "project-db"): string {
  const start = markdown.indexOf(`<!-- ${name}:start -->`)
  const end = markdown.indexOf(`<!-- ${name}:end -->`)
  if (start < 0 || end < 0 || end <= start) fail(`matrix section markers missing: ${name}`)
  return markdown.slice(start + `<!-- ${name}:start -->`.length, end)
}

function rows(block: string): Array<{ table: string; cells: string[] }> {
  return block
    .split("\n")
    .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
      return { table: cells[0].replaceAll("`", ""), cells }
    })
}

function collect(block: string, label: string): { tables: Set<string>; rows: number } {
  const parsed = rows(block)
  const tables = new Set<string>()
  for (const row of parsed) {
    if (row.cells.length !== CELLS_PER_ROW) {
      fail(`${label} row ${row.table}: expected ${CELLS_PER_ROW} cells (table + ${COLUMNS} columns), got ${row.cells.length}`)
    }
    if (tables.has(row.table)) fail(`${label} duplicate row: ${row.table}`)
    tables.add(row.table)
  }
  return { tables, rows: parsed.length }
}

function diff(label: string, expected: Set<string>, actual: Set<string>) {
  const missing = [...expected].filter((table) => !actual.has(table)).sort()
  const extra = [...actual].filter((table) => !expected.has(table)).sort()
  if (missing.length > 0) fail(`${label} missing rows: ${missing.join(", ")}`)
  if (extra.length > 0) fail(`${label} unexpected rows: ${extra.join(", ")}`)
}

const markdown = read(matrixPath)
const main = collect(section(markdown, "main-db"), "main-db")
const project = collect(section(markdown, "project-db"), "project-db")

const drizzleTables = new Set<string>()
for (const file of new Bun.Glob("**/*.sql.ts").scanSync({ cwd: srcRoot })) {
  const text = read(path.join(srcRoot, file))
  for (const match of text.matchAll(/sqliteTable\(\s*"([^"]+)"/g)) drizzleTables.add(match[1])
}
drizzleTables.add("__drizzle_migrations")

const graphSchema = read(path.join(srcRoot, "graph/db/schema.sql"))
const graphTables = new Set<string>()
for (const match of graphSchema.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/g)) {
  graphTables.add(match[1])
}

const store = read(path.join(srcRoot, "chimera/store.ts"))
const overlayTables = new Set<string>()
for (const match of store.matchAll(/CREATE TABLE IF NOT EXISTS (chimera_[a-z_]+)/g)) {
  overlayTables.add(match[1])
}

const projectTables = new Set<string>([
  ...graphTables,
  ...overlayTables,
  "codegraph_storage_extension",
  "codegraph_storage_extension_migration",
])

diff("main-db", drizzleTables, main.tables)
diff("project-db", projectTables, project.tables)

if (main.rows !== drizzleTables.size) fail(`main-db row count ${main.rows} != expected ${drizzleTables.size}`)
if (project.rows !== projectTables.size) fail(`project-db row count ${project.rows} != expected ${projectTables.size}`)

console.log(`PASS main-db: ${main.rows} rows (${drizzleTables.size} expected)`)
console.log(`PASS project-db: ${project.rows} rows (${projectTables.size} expected)`)
console.log(`PASS columns: ${COLUMNS} per row (${CELLS_PER_ROW} cells incl. table name)`)
console.log(`PASS total: ${main.rows + project.rows} rows, no duplicates`)