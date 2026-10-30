#!/usr/bin/env bun
/**
 * WP-10 control-plane fixture checker.
 *
 * Validates three machine-readable layers and executes every behavior fixture
 * against its pure reference judge:
 *
 *   1. semantic-points.json  — 343-point coverage, owner, fixture status
 *   2. domains/*.json        — per-domain inventory and fixture references
 *   3. fixtures/**\/*.json   — synthetic input + expected verdict
 *
 * Run from packages/chimera:
 *   bun test/oracle/control/control-check.ts
 *
 * No production code is imported, no DB/process/network is touched.
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  CONTRACT_REV,
  DOMAINS,
  evaluateAssertions,
  forbiddenFindings,
  isDomain,
  isRecord,
  nonEmptyString,
  validateDomain,
  validateFixture,
  validateSemanticPoints,
  type ControlFixture,
  type DomainManifest,
  type FixtureRef,
  type SemanticPointsFile,
} from "./format"
import { runJudge } from "./fixtures/judges"

const ROOT = import.meta.dirname
const PKG_ROOT = path.resolve(ROOT, "../../..")
const DOMAINS_DIR = path.join(ROOT, "domains")
const FIXTURES_DIR = path.join(ROOT, "fixtures")
const SPECS_DIR = path.join(PKG_ROOT, "specs/rust-host/control")

const errors: string[] = []

function fail(message: string): void {
  errors.push(message)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    fail(`${path.relative(ROOT, file)}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full, suffix)))
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(full)
  }
  return files
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/")
}

function fixtureIdFromPath(file: string): string {
  return relative(file).replace(/^fixtures\//, "").replace(/\.json$/, "")
}

function domainOfFixture(id: string): string {
  return id.split("/")[0] ?? ""
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

function validateRef(ref: FixtureRef, label: string, fixtureIDs: Set<string>): void {
  if (ref.status === "existing" || ref.status === "existing-domain") {
    if (!fixtureIDs.has(ref.ref)) fail(`${label}: ${ref.status} fixture '${ref.ref}' does not exist`)
    return
  }
  if (ref.status === "pending") {
    if (!ref.ref.startsWith("pending:")) fail(`${label}: pending fixture ref must start with 'pending:'`)
    return
  }
  if (ref.status === "not-applicable" && !nonEmptyString(ref.reason)) {
    fail(`${label}: not-applicable needs a reason`)
  }
}

export async function check(): Promise<{ errors: string[]; summary: string[] }> {
  errors.length = 0
  // --- 1. semantic points -------------------------------------------------
  const semanticRaw = await readJson(path.join(ROOT, "semantic-points.json"))
  errors.push(...validateSemanticPoints(semanticRaw))
  const semantic = isRecord(semanticRaw) ? (semanticRaw as unknown as SemanticPointsFile) : undefined

  // --- 2. domain manifests ------------------------------------------------
  const domainFiles = (await readdir(DOMAINS_DIR)).filter((name) => name.endsWith(".json")).sort()
  const manifestDomains = domainFiles.map((name) => name.replace(/\.json$/, ""))
  for (const domain of DOMAINS) {
    if (!manifestDomains.includes(domain)) fail(`domains: missing manifest for '${domain}'`)
  }
  for (const domain of manifestDomains) {
    if (!(DOMAINS as readonly string[]).includes(domain)) fail(`domains: unexpected manifest '${domain}'`)
  }

  const manifests = new Map<string, DomainManifest>()
  for (const name of domainFiles) {
    const file = path.join(DOMAINS_DIR, name)
    const data = await readJson(file)
    const domain = name.replace(/\.json$/, "")
    errors.push(...validateDomain(data, domain))
    if (isRecord(data)) manifests.set(domain, data as unknown as DomainManifest)
  }

  // --- 3. fixtures on disk ------------------------------------------------
  const fixtureFiles = (await listFiles(FIXTURES_DIR, ".json")).sort()
  const fixtureIDs = new Set<string>()
  const fixtures = new Map<string, ControlFixture>()
  for (const file of fixtureFiles) {
    const id = fixtureIdFromPath(file)
    if (fixtureIDs.has(id)) fail(`fixtures: duplicate id '${id}'`)
    fixtureIDs.add(id)
    const data = await readJson(file)
    errors.push(...validateFixture(data, id))
    if (!isRecord(data)) continue
    const fixture = data as unknown as ControlFixture
    fixtures.set(id, fixture)
    if (!isDomain(fixture.domain)) fail(`${id}: invalid domain`)
    else if (domainOfFixture(id) !== fixture.domain) fail(`${id}: path domain does not match fixture.domain`)
  }

  // --- 4. manifest <-> fixture references --------------------------------
  const referenced = new Set<string>()
  const domainFixtureCounts = new Map<string, { behavior: number; negative: number }>()
  for (const [domain, manifest] of manifests) {
    const counts = { behavior: 0, negative: 0 }
    const declared = new Set<string>()
    for (const entry of manifest.fixtures ?? []) {
      if (declared.has(entry.id)) fail(`${domain}: duplicate fixture declaration '${entry.id}'`)
      declared.add(entry.id)
      referenced.add(entry.id)
      if (entry.id !== `${domain}/${path.basename(entry.path).replace(/\.json$/, "")}`) {
        fail(`${domain}: fixture id '${entry.id}' does not match path '${entry.path}'`)
      }
      const fixture = fixtures.get(entry.id)
      if (!fixture) {
        fail(`${domain}: declared fixture '${entry.id}' is missing on disk`)
        continue
      }
      if (fixture.domain !== domain) fail(`${domain}: fixture '${entry.id}' belongs to '${fixture.domain}'`)
      if (fixture.kind !== entry.kind) fail(`${domain}: fixture '${entry.id}' kind mismatch`)
      if (entry.kind === "behavior") counts.behavior++
      else counts.negative++
    }
    if (counts.behavior === 0) fail(`${domain}: needs at least one behavior fixture`)
    domainFixtureCounts.set(domain, counts)

    for (const point of manifest.semantic_points ?? []) {
      if (!nonEmptyString(point.owner_role)) fail(`${domain}/${point.id}: owner_role is empty`)
      validateRef(point.fixture, `${domain}/${point.id}`, fixtureIDs)
      if ((point.fixture.status === "existing" || point.fixture.status === "existing-domain") && !fixtureIDs.has(point.fixture.ref)) {
        fail(`${domain}/${point.id}: fixture '${point.fixture.ref}' is not a declared fixture`)
      }
      for (const evidence of point.evidence ?? []) {
        if (!nonEmptyString(evidence)) fail(`${domain}/${point.id}: empty evidence entry`)
      }
    }
  }

  for (const id of fixtureIDs) {
    if (!referenced.has(id)) fail(`fixtures: '${id}' exists on disk but is not referenced by any domain manifest`)
  }

  // --- 5. semantic points: owner/fixture/domain links --------------------
  const coveredDomains = new Set<string>()
  if (semantic) {
    for (const point of semantic.points ?? []) {
      if (!nonEmptyString(point.owner_role)) fail(`semantic-points/${point.id}: owner_role is empty`)
      validateRef(point.fixture, `semantic-points/${point.id}`, fixtureIDs)
      for (const domain of point.control_domains ?? []) {
        if (!isDomain(domain)) fail(`semantic-points/${point.id}: invalid control domain '${domain}'`)
        else coveredDomains.add(domain)
      }
      if (point.existing_suite) {
        const suite = path.join(PKG_ROOT, point.existing_suite)
        if (!(await exists(suite))) fail(`semantic-points/${point.id}: existing_suite '${point.existing_suite}' is missing`)
      }
    }
    for (const bucket of semantic.mechanical_buckets ?? []) {
      if (!nonEmptyString(bucket.owner_role)) fail(`semantic-points/${bucket.id}: owner_role is empty`)
      validateRef(bucket.fixture, `semantic-points/${bucket.id}`, fixtureIDs)
      for (const domain of bucket.control_domains ?? []) {
        if (!isDomain(domain)) fail(`semantic-points/${bucket.id}: invalid control domain '${domain}'`)
        else coveredDomains.add(domain)
      }
    }
    for (const domain of DOMAINS) {
      if (!coveredDomains.has(domain)) fail(`semantic-points: domain '${domain}' has no W-E point or bucket link`)
    }
    const total =
      (semantic.points?.length ?? 0) +
      (semantic.mechanical_buckets ?? []).reduce((sum, bucket) => sum + (typeof bucket.count === "number" ? bucket.count : 0), 0)
    if (semantic.source?.total !== 343) fail(`semantic-points: source.total must be 343, got ${semantic.source?.total}`)
    if (total !== 343) fail(`semantic-points: covered total must be 343, got ${total}`)
  }

  // --- 6. execute every fixture -----------------------------------------
  let executed = 0
  for (const [id, fixture] of fixtures) {
    const observed = runJudge(fixture.rule, fixture.input)
    if (!observed) {
      fail(`${id}: no judge registered for rule '${fixture.rule}'`)
      continue
    }
    executed++
    if (observed.verdict !== fixture.expect.verdict) {
      fail(`${id}: verdict expected '${fixture.expect.verdict}', got '${observed.verdict}'`)
    }
    if (fixture.expect.code && observed.code !== fixture.expect.code) {
      fail(`${id}: code expected '${fixture.expect.code}', got '${String(observed.code)}'`)
    }
    for (const assertionError of evaluateAssertions(observed, fixture.expect.assertions)) {
      fail(`${id}: ${assertionError}`)
    }
    if (fixture.kind === "negative" && (!fixture.expect.must_not || fixture.expect.must_not.length === 0)) {
      fail(`${id}: negative fixture must document expect.must_not`)
    }
  }

  // --- 7. docs and fixtures contain no real-world endpoints/secrets ------
  for (const file of await listFiles(ROOT, ".json")) {
    const text = await readFile(file, "utf8")
    for (const finding of forbiddenFindings(text, relative(file))) fail(finding)
  }
  for (const file of await listFiles(SPECS_DIR, ".md").catch(() => [])) {
    const text = await readFile(file, "utf8")
    for (const finding of forbiddenFindings(text, path.relative(PKG_ROOT, file))) fail(finding)
  }

  const statuses = { "existing-domain": 0, existing: 0, pending: 0, "not-applicable": 0 }
  for (const point of semantic?.points ?? []) statuses[point.fixture.status]++
  for (const bucket of semantic?.mechanical_buckets ?? []) statuses[bucket.fixture.status] += bucket.count
  const totalFixtures = fixtures.size
  const behavior = [...manifests.values()].reduce((sum, manifest) => sum + (domainFixtureCounts.get(manifest.domain)?.behavior ?? 0), 0)
  const negative = totalFixtures - behavior
  const summary = [
    `PASS contract_rev ${CONTRACT_REV}`,
    `PASS semantic points: ${semantic?.points.length ?? 0} enumerated + ${semantic?.mechanical_buckets.length ?? 0} buckets = 343`,
    `PASS fixture status: existing-domain ${statuses["existing-domain"]}, existing ${statuses.existing}, pending ${statuses.pending}, not-applicable ${statuses["not-applicable"]}`,
    "NOTE fixture status: existing-domain counts domain-level fixture associations, not point-level parity; the 67 count is unchanged.",
    `PASS domains: ${manifests.size} manifests, ${totalFixtures} fixtures (${behavior} behavior, ${negative} negative)`,
    `PASS judges: ${executed}/${totalFixtures} fixtures executed`,
    "PASS owner: every semantic point, bucket, and domain point has a non-empty owner_role",
  ]
  return { errors: [...errors], summary }
}

if (import.meta.main) {
  check()
    .then(({ errors, summary }) => {
      if (errors.length > 0) {
        console.error(`FAIL: ${errors.length} issue(s)`)
        for (const error of errors) console.error(`- ${error}`)
        process.exit(1)
      }
      for (const line of summary) console.log(line)
    })
    .catch((error) => {
      console.error(`FAIL: ${error instanceof Error ? error.stack : String(error)}`)
      process.exit(1)
    })
}