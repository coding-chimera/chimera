// WP-10 control-plane fixture format v1.
//
// This module is intentionally dependency-free and never imports production
// code. It defines the shape shared by the three machine-readable layers:
//
//   1. semantic-points.json  — versioned 343-point W-E -> owner -> fixture map
//   2. domains/<domain>.json — per-domain control-plane inventory
//   3. fixtures/<domain>/*.json — synthetic input + expected behavior verdict
//
// The checker (`control-check.ts`) validates shape, counts, references, and
// runs the pure reference judges in `fixtures/judges.ts`. The judges model the
// documented control-plane rules; they are not a TS-vs-Rust parity harness.

export const CONTRACT_REV = "cr-2026-10-30-r1" as const
export const CONTROL_FORMAT = "chimera.oracle.control" as const
export const DOMAIN_FORMAT = "chimera.oracle.control.domain" as const
export const FIXTURE_FORMAT = "chimera.oracle.control.fixture" as const
export const SEMANTIC_FORMAT = "chimera.oracle.control.semantic-points" as const
export const FIXTURE_VERSION = 1 as const

export const DOMAINS = [
  "config-bootstrap",
  "skills",
  "instructions",
  "workbrief",
  "goal",
  "prompt-assembly",
  "tool-search",
  "compaction",
  "mutation-chain",
  "mcp-transports",
  "job-family",
  "retention",
] as const

export type Domain = (typeof DOMAINS)[number]
export type FixtureKind = "behavior" | "negative"
// Fixture status semantics:
//   - existing-domain: the point is linked to a domain-level behavior fixture.
//     It covers the same control area but is NOT point-level parity.
//   - existing: reserved for a real point-level parity fixture (none yet).
//   - pending: planned fixture slot; ref must start with "pending:".
//   - not-applicable: no behavior semantics; a reason is required.
export type FixtureStatus = "existing-domain" | "existing" | "pending" | "not-applicable"

export type FixtureRef = {
  status: FixtureStatus
  ref: string
  reason?: string
}

export type Assertion = {
  path: string
  equals?: unknown
  includes?: unknown
  excludes?: unknown
  length?: number
  exists?: boolean
}

export type FixtureExpect = {
  verdict: "pass" | "blocked" | "error" | "noop"
  code?: string
  assertions: Assertion[]
  must_not?: string[]
}

export type ControlFixture = {
  fixture_version: number
  contract_rev: string
  format: typeof FIXTURE_FORMAT
  id: string
  domain: Domain
  kind: FixtureKind
  rule: string
  title: string
  description: string
  input: Record<string, unknown>
  expect: FixtureExpect
  provenance: {
    evidence: string[]
    derivation: string
    executed: boolean
  }
}

export type DomainPoint = {
  id: string
  title: string
  owner_role: string
  fixture: FixtureRef
  we_refs?: string[]
  evidence: string[]
  note?: string
}

export type DomainManifest = {
  format: typeof DOMAIN_FORMAT
  version: number
  contract_rev: string
  domain: Domain
  title: string
  owner_role: string
  scope: string
  fixtures: Array<{
    id: string
    path: string
    kind: FixtureKind
    covers: string[]
  }>
  semantic_points: DomainPoint[]
  new_capabilities: string[]
  known_differences: string[]
}

export type SemanticPoint = {
  id: string
  module: string
  primitive: string
  where: string
  portability: "di" | "structured-concurrency" | "coordination" | "streaming" | "hard"
  owner_role: string
  fixture: FixtureRef
  control_domains: Domain[]
  existing_suite?: string
  purpose?: string
  contract?: string
  note?: string
}

export type MechanicalBucket = {
  id: string
  module: string
  count: number
  owner_role: string
  fixture: FixtureRef
  control_domains: Domain[]
  note: string
}

export type SemanticPointsFile = {
  format: typeof SEMANTIC_FORMAT
  version: number
  contract_rev: string
  source: {
    plan: string
    archive: string
    archive_date: string
    total: number
    enumerated: number
    mechanical_buckets: number
    explanation: string
  }
  points: SemanticPoint[]
  mechanical_buckets: MechanicalBucket[]
}

export type JudgeResult = {
  verdict: FixtureExpect["verdict"]
  code?: string
  [key: string]: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && (DOMAINS as readonly string[]).includes(value)
}

export function isStatus(value: unknown): value is FixtureStatus {
  return value === "existing-domain" || value === "existing" || value === "pending" || value === "not-applicable"
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
}

export function getPath(value: unknown, path: string): unknown {
  const parts = path.split(".")
  let current: unknown = value
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a).sort()
    const bk = Object.keys(b).sort()
    return deepEqual(ak, bk) && ak.every((key) => deepEqual(a[key], b[key]))
  }
  return false
}

function includesValue(container: unknown, expected: unknown): boolean {
  if (Array.isArray(container)) return container.some((item) => deepEqual(item, expected))
  if (typeof container === "string" && typeof expected === "string") return container.includes(expected)
  if (isRecord(container) && typeof expected === "string") return expected in container
  return false
}

/** Evaluate declarative assertions against a judge result. Returns error strings. */
export function evaluateAssertions(observed: unknown, assertions: Assertion[]): string[] {
  const errors: string[] = []
  for (const assertion of assertions) {
    if (!nonEmptyString(assertion.path)) {
      errors.push("assertion path is empty")
      continue
    }
    const actual = getPath(observed, assertion.path)
    if ("equals" in assertion && !deepEqual(actual, assertion.equals)) {
      errors.push(`${assertion.path}: expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`)
    }
    if ("includes" in assertion && !includesValue(actual, assertion.includes)) {
      errors.push(`${assertion.path}: expected to include ${JSON.stringify(assertion.includes)}, got ${JSON.stringify(actual)}`)
    }
    if ("excludes" in assertion && includesValue(actual, assertion.excludes)) {
      errors.push(`${assertion.path}: expected to exclude ${JSON.stringify(assertion.excludes)}, got ${JSON.stringify(actual)}`)
    }
    if ("length" in assertion) {
      if (!Array.isArray(actual) || actual.length !== assertion.length) {
        errors.push(`${assertion.path}: expected length ${assertion.length}, got ${Array.isArray(actual) ? actual.length : typeof actual}`)
      }
    }
    if ("exists" in assertion) {
      const exists = actual !== undefined && actual !== null
      if (exists !== assertion.exists) errors.push(`${assertion.path}: expected exists=${assertion.exists}`)
    }
  }
  return errors
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "http(s) URL", pattern: /https?:\/\//i },
  { name: "websocket URL", pattern: /wss?:\/\//i },
  { name: "home/workspace absolute path", pattern: /\/(?:Users|home|Volumes)\// },
  { name: "IPv4 literal", pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/ },
  { name: "credential prefix", pattern: /\b(?:sk-|ghp_|github_pat_|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{8,})/ },
]

/** Scan every string in a JSON value for forbidden real-world content. */
export function forbiddenFindings(value: unknown, label: string): string[] {
  const findings: string[] = []
  const visit = (node: unknown) => {
    if (typeof node === "string") {
      for (const forbidden of FORBIDDEN) {
        if (forbidden.pattern.test(node)) findings.push(`${label}: forbidden content (${forbidden.name})`)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (isRecord(node)) {
      for (const item of Object.values(node)) visit(item)
    }
  }
  visit(value)
  return findings
}

function validateFixtureRef(value: unknown, label: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${label}: fixture ref must be an object`)
    return
  }
  if (!isStatus(value.status)) errors.push(`${label}: fixture.status must be existing-domain/existing/pending/not-applicable`)
  if (!nonEmptyString(value.ref)) errors.push(`${label}: fixture.ref must be a non-empty string`)
  if (value.status === "not-applicable" && !nonEmptyString(value.reason)) {
    errors.push(`${label}: fixture.reason is required for not-applicable`)
  }
}

export function validateFixture(value: unknown, expectedId: string): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return [`${expectedId}: fixture must be an object`]
  if (value.format !== FIXTURE_FORMAT) errors.push(`${expectedId}: format must be ${FIXTURE_FORMAT}`)
  if (value.fixture_version !== FIXTURE_VERSION) errors.push(`${expectedId}: fixture_version must be ${FIXTURE_VERSION}`)
  if (value.contract_rev !== CONTRACT_REV) errors.push(`${expectedId}: contract_rev must be ${CONTRACT_REV}`)
  if (value.id !== expectedId) errors.push(`${expectedId}: id must match its path`)
  if (!isDomain(value.domain)) errors.push(`${expectedId}: invalid domain`)
  if (value.kind !== "behavior" && value.kind !== "negative") errors.push(`${expectedId}: kind must be behavior/negative`)
  if (!nonEmptyString(value.rule)) errors.push(`${expectedId}: rule must be a non-empty string`)
  if (!nonEmptyString(value.title)) errors.push(`${expectedId}: title must be a non-empty string`)
  if (!nonEmptyString(value.description)) errors.push(`${expectedId}: description must be a non-empty string`)
  if (!isRecord(value.input)) errors.push(`${expectedId}: input must be an object`)
  if (!isRecord(value.expect)) {
    errors.push(`${expectedId}: expect must be an object`)
  } else {
    const verdict = value.expect.verdict
    if (verdict !== "pass" && verdict !== "blocked" && verdict !== "error" && verdict !== "noop") {
      errors.push(`${expectedId}: expect.verdict is invalid`)
    }
    if ("code" in value.expect && !nonEmptyString(value.expect.code)) {
      errors.push(`${expectedId}: expect.code must be a non-empty string when present`)
    }
    if (!Array.isArray(value.expect.assertions) || value.expect.assertions.length === 0) {
      errors.push(`${expectedId}: expect.assertions must be a non-empty array`)
    } else {
      value.expect.assertions.forEach((assertion, index) => {
        if (!isRecord(assertion) || !nonEmptyString(assertion.path)) {
          errors.push(`${expectedId}: expect.assertions[${index}] needs a non-empty path`)
        }
      })
    }
    if ("must_not" in value.expect && !Array.isArray(value.expect.must_not)) {
      errors.push(`${expectedId}: expect.must_not must be an array`)
    }
  }
  if (!isRecord(value.provenance)) {
    errors.push(`${expectedId}: provenance must be an object`)
  } else {
    if (!stringArray(value.provenance.evidence)) errors.push(`${expectedId}: provenance.evidence must be a non-empty string array`)
    if (!nonEmptyString(value.provenance.derivation)) errors.push(`${expectedId}: provenance.derivation is required`)
    if (typeof value.provenance.executed !== "boolean") errors.push(`${expectedId}: provenance.executed must be boolean`)
  }
  errors.push(...forbiddenFindings(value, expectedId))
  return errors
}

export function validateDomain(value: unknown, expectedDomain: string): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return [`${expectedDomain}: domain manifest must be an object`]
  if (value.format !== DOMAIN_FORMAT) errors.push(`${expectedDomain}: format must be ${DOMAIN_FORMAT}`)
  if (value.version !== FIXTURE_VERSION) errors.push(`${expectedDomain}: version must be ${FIXTURE_VERSION}`)
  if (value.contract_rev !== CONTRACT_REV) errors.push(`${expectedDomain}: contract_rev must be ${CONTRACT_REV}`)
  if (value.domain !== expectedDomain) errors.push(`${expectedDomain}: domain must match its filename`)
  if (!nonEmptyString(value.title)) errors.push(`${expectedDomain}: title is required`)
  if (!nonEmptyString(value.owner_role)) errors.push(`${expectedDomain}: owner_role is required`)
  if (!nonEmptyString(value.scope)) errors.push(`${expectedDomain}: scope is required`)
  if (!Array.isArray(value.fixtures) || value.fixtures.length === 0) {
    errors.push(`${expectedDomain}: fixtures must be a non-empty array`)
  } else {
    value.fixtures.forEach((fixture, index) => {
      if (!isRecord(fixture)) {
        errors.push(`${expectedDomain}: fixtures[${index}] must be an object`)
        return
      }
      if (!nonEmptyString(fixture.id)) errors.push(`${expectedDomain}: fixtures[${index}].id is required`)
      if (!nonEmptyString(fixture.path)) errors.push(`${expectedDomain}: fixtures[${index}].path is required`)
      if (fixture.kind !== "behavior" && fixture.kind !== "negative") {
        errors.push(`${expectedDomain}: fixtures[${index}].kind must be behavior/negative`)
      }
      if (!stringArray(fixture.covers)) errors.push(`${expectedDomain}: fixtures[${index}].covers must be a non-empty string array`)
    })
  }
  if (!Array.isArray(value.semantic_points) || value.semantic_points.length === 0) {
    errors.push(`${expectedDomain}: semantic_points must be a non-empty array`)
  } else {
    const ids = new Set<string>()
    value.semantic_points.forEach((point, index) => {
      if (!isRecord(point)) {
        errors.push(`${expectedDomain}: semantic_points[${index}] must be an object`)
        return
      }
      if (!nonEmptyString(point.id)) errors.push(`${expectedDomain}: semantic_points[${index}].id is required`)
      else if (ids.has(point.id)) errors.push(`${expectedDomain}: duplicate semantic point id ${point.id}`)
      else ids.add(point.id)
      if (!nonEmptyString(point.title)) errors.push(`${expectedDomain}: semantic_points[${index}].title is required`)
      if (!nonEmptyString(point.owner_role)) errors.push(`${expectedDomain}: semantic_points[${index}].owner_role is required`)
      validateFixtureRef(point.fixture, `${expectedDomain}: semantic_points[${index}]`, errors)
      if (!stringArray(point.evidence)) errors.push(`${expectedDomain}: semantic_points[${index}].evidence must be a non-empty string array`)
      if ("we_refs" in point && !Array.isArray(point.we_refs)) {
        errors.push(`${expectedDomain}: semantic_points[${index}].we_refs must be an array`)
      }
    })
  }
  if (!Array.isArray(value.new_capabilities)) errors.push(`${expectedDomain}: new_capabilities must be an array`)
  if (!Array.isArray(value.known_differences)) errors.push(`${expectedDomain}: known_differences must be an array`)
  errors.push(...forbiddenFindings(value, expectedDomain))
  return errors
}

export function validateSemanticPoints(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["semantic-points: must be an object"]
  if (value.format !== SEMANTIC_FORMAT) errors.push(`semantic-points: format must be ${SEMANTIC_FORMAT}`)
  if (value.version !== FIXTURE_VERSION) errors.push(`semantic-points: version must be ${FIXTURE_VERSION}`)
  if (value.contract_rev !== CONTRACT_REV) errors.push(`semantic-points: contract_rev must be ${CONTRACT_REV}`)
  if (!isRecord(value.source)) {
    errors.push("semantic-points: source must be an object")
    return errors
  }
  const source = value.source
  if (!nonEmptyString(source.plan)) errors.push("semantic-points: source.plan is required")
  if (!nonEmptyString(source.archive)) errors.push("semantic-points: source.archive is required")
  if (!nonEmptyString(source.archive_date)) errors.push("semantic-points: source.archive_date is required")
  if (typeof source.total !== "number" || !Number.isInteger(source.total)) errors.push("semantic-points: source.total must be an integer")
  if (typeof source.enumerated !== "number" || !Number.isInteger(source.enumerated)) {
    errors.push("semantic-points: source.enumerated must be an integer")
  }
  if (typeof source.mechanical_buckets !== "number" || !Number.isInteger(source.mechanical_buckets)) {
    errors.push("semantic-points: source.mechanical_buckets must be an integer")
  }
  if (!nonEmptyString(source.explanation)) errors.push("semantic-points: source.explanation is required")

  if (!Array.isArray(value.points)) errors.push("semantic-points: points must be an array")
  if (!Array.isArray(value.mechanical_buckets)) errors.push("semantic-points: mechanical_buckets must be an array")
  const ids = new Set<string>()
  const points = Array.isArray(value.points) ? value.points : []
  points.forEach((point, index) => {
    if (!isRecord(point)) {
      errors.push(`semantic-points: points[${index}] must be an object`)
      return
    }
    if (!nonEmptyString(point.id)) errors.push(`semantic-points: points[${index}].id is required`)
    else if (ids.has(point.id)) errors.push(`semantic-points: duplicate point id ${point.id}`)
    else ids.add(point.id)
    for (const key of ["module", "primitive", "where", "owner_role"]) {
      if (!nonEmptyString(point[key])) errors.push(`semantic-points: ${point.id ?? index}.${key} is required`)
    }
    if (!["di", "structured-concurrency", "coordination", "streaming", "hard"].includes(String(point.portability))) {
      errors.push(`semantic-points: ${point.id ?? index}.portability is invalid`)
    }
    validateFixtureRef(point.fixture, `semantic-points: ${point.id ?? index}`, errors)
    if (!Array.isArray(point.control_domains) || point.control_domains.some((domain) => !isDomain(domain))) {
      errors.push(`semantic-points: ${point.id ?? index}.control_domains is invalid`)
    }
  })
  const buckets = Array.isArray(value.mechanical_buckets) ? value.mechanical_buckets : []
  buckets.forEach((bucket, index) => {
    if (!isRecord(bucket)) {
      errors.push(`semantic-points: mechanical_buckets[${index}] must be an object`)
      return
    }
    if (!nonEmptyString(bucket.id)) errors.push(`semantic-points: mechanical_buckets[${index}].id is required`)
    else if (ids.has(bucket.id)) errors.push(`semantic-points: duplicate bucket id ${bucket.id}`)
    else ids.add(bucket.id)
    if (!nonEmptyString(bucket.module)) errors.push(`semantic-points: ${bucket.id ?? index}.module is required`)
    if (typeof bucket.count !== "number" || !Number.isInteger(bucket.count) || bucket.count <= 0) {
      errors.push(`semantic-points: ${bucket.id ?? index}.count must be a positive integer`)
    }
    if (!nonEmptyString(bucket.owner_role)) errors.push(`semantic-points: ${bucket.id ?? index}.owner_role is required`)
    validateFixtureRef(bucket.fixture, `semantic-points: ${bucket.id ?? index}`, errors)
    if (!Array.isArray(bucket.control_domains) || bucket.control_domains.some((domain) => !isDomain(domain))) {
      errors.push(`semantic-points: ${bucket.id ?? index}.control_domains is invalid`)
    }
    if (!nonEmptyString(bucket.note)) errors.push(`semantic-points: ${bucket.id ?? index}.note is required`)
  })
  if (typeof source.total === "number" && typeof source.enumerated === "number" && typeof source.mechanical_buckets === "number") {
    if (points.length !== source.enumerated) {
      errors.push(`semantic-points: points.length ${points.length} != source.enumerated ${source.enumerated}`)
    }
    const bucketTotal = buckets.reduce((sum, bucket) => sum + (isRecord(bucket) && typeof bucket.count === "number" ? bucket.count : 0), 0)
    if (bucketTotal !== source.mechanical_buckets) {
      errors.push(`semantic-points: bucket count ${bucketTotal} != source.mechanical_buckets ${source.mechanical_buckets}`)
    }
    if (points.length + bucketTotal !== source.total) {
      errors.push(`semantic-points: covered ${points.length + bucketTotal} != source.total ${source.total}`)
    }
  }
  errors.push(...forbiddenFindings(value, "semantic-points"))
  return errors
}