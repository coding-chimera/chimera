/**
 * Shape/coverage validator for the WP-06 graph parity fixtures.
 *
 * This is NOT a parity harness: it never imports the graph engine and never
 * executes a fixture. It only checks that the static files are well-formed,
 * indexed, cover every face with at least one golden + one negative, and do
 * not contain forbidden content (real URLs, home/workspace paths, IPs,
 * credential prefixes).
 *
 * Run from packages/chimera:
 *   bun run test/oracle/graph/validate-fixtures.ts
 */

import { readdir } from "node:fs/promises"
import { join, relative, sep } from "node:path"

const ROOT = import.meta.dir
const CONTRACT_REV = "cr-2026-10-30-r1"
const FACES = ["extraction", "store", "resolution", "query", "traversal", "pattern"] as const
const KINDS = ["golden", "negative"] as const
const STATUSES = new Set(["ok", "defer", "error", "empty"])
const REQUIRED_KEYS = new Set([
  "fixture_version",
  "contract_rev",
  "id",
  "face",
  "kind",
  "title",
  "description",
  "input",
  "expect",
  "provenance",
])
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "http(s) URL", pattern: /https?:\/\//i },
  { name: "home/workspace absolute path", pattern: /\/(?:Users|home|Volumes)\// },
  { name: "IPv4 literal", pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/ },
  { name: "credential prefix", pattern: /\b(?:sk-|ghp_|github_pat_|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{8,})/ },
]

type JsonRecord = Record<string, unknown>

const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  const text = await Bun.file(path).text()
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}

async function listJsonFixtures(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listJsonFixtures(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(full)
  }
  return files
}

function fixtureIdFromPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/").replace(/\.json$/, "")
}

function validateFixture(file: string, data: unknown): JsonRecord | null {
  const id = fixtureIdFromPath(file)
  if (!isRecord(data)) {
    fail(`${id}: fixture must be a JSON object`)
    return null
  }

  for (const key of Object.keys(data)) {
    if (!REQUIRED_KEYS.has(key)) fail(`${id}: unknown top-level key '${key}'`)
  }
  for (const key of REQUIRED_KEYS) {
    if (key === "description") continue
    if (!(key in data)) fail(`${id}: missing required key '${key}'`)
  }

  if (data.fixture_version !== 1) fail(`${id}: fixture_version must be 1`)
  if (data.contract_rev !== CONTRACT_REV) fail(`${id}: contract_rev must be ${CONTRACT_REV}`)
  if (data.id !== id) fail(`${id}: id '${String(data.id)}' does not match path`)
  if (!FACES.includes(data.face as (typeof FACES)[number])) fail(`${id}: invalid face '${String(data.face)}'`)
  if (!KINDS.includes(data.kind as (typeof KINDS)[number])) fail(`${id}: invalid kind '${String(data.kind)}'`)
  if (typeof data.title !== "string" || data.title.length === 0) fail(`${id}: title must be a non-empty string`)
  if ("description" in data && typeof data.description !== "string") fail(`${id}: description must be a string`)

  if (!isRecord(data.input)) fail(`${id}: input must be an object`)
  if (!isRecord(data.expect)) {
    fail(`${id}: expect must be an object`)
  } else {
    if (!STATUSES.has(String(data.expect.status))) {
      fail(`${id}: expect.status must be one of ${[...STATUSES].join(", ")}`)
    }
    if ("must_not" in data.expect) {
      const mustNot = data.expect.must_not
      if (!Array.isArray(mustNot) || mustNot.some((item) => typeof item !== "string")) {
        fail(`${id}: expect.must_not must be an array of strings`)
      }
    }
  }

  if (!isRecord(data.provenance)) {
    fail(`${id}: provenance must be an object`)
  } else {
    const evidence = data.provenance.evidence
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== "string")) {
      fail(`${id}: provenance.evidence must be a non-empty string array`)
    }
    if (typeof data.provenance.derivation !== "string" || data.provenance.derivation.length === 0) {
      fail(`${id}: provenance.derivation must be a non-empty string`)
    }
    if (typeof data.provenance.executed !== "boolean") {
      fail(`${id}: provenance.executed must be a boolean`)
    }
  }

  const serialized = JSON.stringify(data)
  for (const forbidden of FORBIDDEN) {
    if (forbidden.pattern.test(serialized)) fail(`${id}: forbidden content (${forbidden.name})`)
  }

  return data
}

async function main(): Promise<void> {
  const indexRaw = await readJson(join(ROOT, "index.json"))
  if (!isRecord(indexRaw)) {
    fail("index.json: must be a JSON object")
    return
  }
  if (indexRaw.contract_rev !== CONTRACT_REV) fail(`index.json: contract_rev must be ${CONTRACT_REV}`)
  if (!Array.isArray(indexRaw.fixtures)) {
    fail("index.json: fixtures must be an array")
    return
  }

  const indexed = new Map<string, JsonRecord>()
  for (const entry of indexRaw.fixtures) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.path !== "string") {
      fail("index.json: every fixture entry needs string id/path")
      continue
    }
    if (indexed.has(entry.id)) fail(`index.json: duplicate fixture id '${entry.id}'`)
    indexed.set(entry.id, entry)
  }

  const diskFiles = (await listJsonFixtures(ROOT)).filter(
    (file) => !file.endsWith("/index.json") && !file.endsWith("/schema.json"),
  )
  const diskIds = new Set<string>()
  const fixtures: JsonRecord[] = []

  for (const file of diskFiles) {
    const id = fixtureIdFromPath(file)
    diskIds.add(id)
    if (!indexed.has(id)) fail(`${id}: file exists on disk but is missing from index.json`)
    const data = validateFixture(file, await readJson(file))
    if (data) fixtures.push(data)
  }

  for (const id of indexed.keys()) {
    if (!diskIds.has(id)) fail(`${id}: indexed but missing on disk`)
  }

  const coverage = new Map<string, { golden: number; negative: number }>()
  for (const face of FACES) coverage.set(face, { golden: 0, negative: 0 })
  for (const fixture of fixtures) {
    const face = String(fixture.face)
    const kind = String(fixture.kind) as (typeof KINDS)[number]
    const bucket = coverage.get(face)
    if (bucket) bucket[kind] += 1
  }
  for (const face of FACES) {
    const bucket = coverage.get(face)
    if (!bucket || bucket.golden < 1) fail(`coverage: ${face} needs at least one golden fixture`)
    if (!bucket || bucket.negative < 1) fail(`coverage: ${face} needs at least one negative fixture`)
  }

  if (isRecord(indexRaw.coverage)) {
    for (const face of FACES) {
      const declared = indexRaw.coverage[face]
      const actual = coverage.get(face)
      if (!isRecord(declared) || !actual) continue
      if (declared.golden !== actual.golden || declared.negative !== actual.negative) {
        fail(
          `coverage: ${face} declared g${String(declared.golden)}/n${String(declared.negative)} but disk has g${actual.golden}/n${actual.negative}`,
        )
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`validate-fixtures: ${errors.length} error(s)\n`)
    for (const error of errors) process.stderr.write(`  - ${error}\n`)
    process.exit(1)
  }

  const summary = FACES.map((face) => {
    const bucket = coverage.get(face)!
    return `${face} g${bucket.golden}/n${bucket.negative}`
  }).join(", ")
  process.stdout.write(`validate-fixtures: ${fixtures.length} fixtures OK (${summary})\n`)
}

await main()