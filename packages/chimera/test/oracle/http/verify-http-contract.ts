/**
 * WP-04 HTTP contract checker.
 *
 * Read-only. Verifies the frozen 170-op coverage fixture, the 96-op
 * host-first/session-dependent re-triage, and the SDK generated-tree baseline.
 * It never regenerates OpenAPI or the SDK.
 *
 * SDK baseline caveat: the recorded hashes were captured from this worktree,
 * which already contained an external, uncommitted 2-line delta in
 * types.gen.ts. A matching hash therefore proves only "worktree == baseline
 * capture"; it does NOT prove "regenerated output == committed HEAD" and is
 * not the G0 drift gate. At G0 compare against HEAD with
 * `git diff HEAD --exit-code -- packages/sdk/js/src/v2/gen` (see
 * specs/rust-host/http/sdk-drift.md §3.5).
 *
 * Run from `packages/chimera`:
 *
 *   bun test/oracle/http/verify-http-contract.ts
 */
import { join } from "path"

const root = join(import.meta.dir, "../../../../..")
const fixtureDir = join(root, "packages/chimera/test/oracle/http")
const sourceInventoryPath = join(root, "packages/chimera/test/fixtures/httpapi-inventory.json")
const frozenInventoryPath = join(fixtureDir, "httpapi-inventory.frozen.json")
const coveragePath = join(fixtureDir, "coverage-170.json")
const triagePath = join(fixtureDir, "triage-96.json")
const manifestPath = join(root, "packages/chimera/specs/rust-host/http/openapi-freeze.manifest.json")
const sdkBaselinePath = join(fixtureDir, "sdk-drift-baseline.json")
const sdkGenDir = join(root, "packages/sdk/js/src/v2/gen")

type Operation = {
  operationId: string
  method: string
  path: string
  group: string
  migrationClass: string
  parityCoverage: string
}

type Inventory = {
  version: number
  source: string
  pathCount: number
  operationCount: number
  migrationClassCounts: Record<string, number>
  parityCoverageCounts: Record<string, number>
  operations: Operation[]
}

type Coverage = {
  source: { inventory_sha256: string; operationCount: number; pathCount: number }
  ownership: { contract_owner: string; counts: Record<string, number> }
  columns: string[]
  rows: string[][]
}

type Triage = {
  verdictCounts: Record<string, number>
  binarySplit: Record<string, number>
  constructionLayerDeps: {
    affectedCount: number
    cleanHostFirstCount: number
    groups: Array<{ group: string; operationIds: string[] }>
    cleanGroups: string[]
  }
  columns: string[]
  rows: string[][]
}

type Manifest = {
  full_openapi_spec: { status: string; acquisition: Record<string, string> }
  frozen_artifacts: Record<string, { path: string; sha256: string }>
  stale_artifacts: Array<{ path: string; observed?: { pathCount: number; operationCount: number } }>
}

type SdkBaseline = {
  files: Array<{ path: string; sha256: string }>
  comparison_scope: { include: string[] }
  preexisting_worktree_drift: { path: string; status: string; head_sha256?: string; worktree_sha256?: string }
}

const failures: string[] = []
const checks = { inventory: 0, coverage: 0, triage: 0, manifest: 0, sdk: 0 }

function check(condition: boolean, message: string, bucket: keyof typeof checks) {
  checks[bucket] += 1
  if (!condition) failures.push(`[${bucket}] ${message}`)
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T
}

async function sha256(path: string) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
}

function key(operation: Pick<Operation, "operationId">) {
  return operation.operationId
}

function sameCounts(actual: Record<string, number>, expected: Record<string, number>) {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((name, index) => name === expectedKeys[index] && actual[name] === expected[name])
  )
}

const inventory = await readJson<Inventory>(sourceInventoryPath)
const coverage = await readJson<Coverage>(coveragePath)
const triage = await readJson<Triage>(triagePath)
const manifest = await readJson<Manifest>(manifestPath)
const sdk = await readJson<SdkBaseline>(sdkBaselinePath)
const sourceSha = await sha256(sourceInventoryPath)

// --- inventory -------------------------------------------------------------
check(inventory.version === 1, `inventory version ${inventory.version}`, "inventory")
check(inventory.source === "Server.openapi()", `inventory source ${inventory.source}`, "inventory")
check(inventory.operationCount === 170, `inventory operationCount ${inventory.operationCount}`, "inventory")
check(inventory.pathCount === 142, `inventory pathCount ${inventory.pathCount}`, "inventory")
check(inventory.operations.length === inventory.operationCount, "operations length != operationCount", "inventory")
check(
  sameCounts(inventory.migrationClassCounts, { "host-first": 96, "proxy-first": 50, special: 24 }),
  `migrationClassCounts ${JSON.stringify(inventory.migrationClassCounts)}`,
  "inventory",
)
check(
  sameCounts(inventory.parityCoverageCounts, { exercise: 116, none: 54 }),
  `parityCoverageCounts ${JSON.stringify(inventory.parityCoverageCounts)}`,
  "inventory",
)
const inventoryByID = new Map(inventory.operations.map((operation) => [key(operation), operation]))
check(inventoryByID.size === 170, `duplicate operationId in inventory (${inventoryByID.size} unique)`, "inventory")
const frozenInventory = await readJson<Inventory>(frozenInventoryPath)
const frozenSha = await sha256(frozenInventoryPath)
check(frozenSha === sourceSha, `frozen inventory sha256 ${frozenSha} != ${sourceSha}`, "inventory")
check(
  frozenInventory.operations.length === inventory.operations.length &&
    frozenInventory.operations.every((operation) => inventoryByID.has(key(operation))),
  "frozen inventory operation set differs from live fixture",
  "inventory",
)

// --- coverage 170 ----------------------------------------------------------
const coverageColumns = [
  "operationId",
  "method",
  "path",
  "group",
  "migrationClass",
  "parityCoverage",
  "semanticOwner",
  "gapAction",
  "gapDetail",
]
check(
  coverage.columns.length === coverageColumns.length && coverage.columns.every((column, index) => column === coverageColumns[index]),
  `coverage columns ${coverage.columns.join(",")}`,
  "coverage",
)
check(coverage.rows.length === 170, `coverage rows ${coverage.rows.length}`, "coverage")
check(coverage.source.inventory_sha256 === sourceSha, "coverage source sha256 mismatch", "coverage")
check(coverage.ownership.contract_owner === "WP-04", `coverage contract owner ${coverage.ownership.contract_owner}`, "coverage")
const coverageByID = new Map<string, string[]>()
for (const row of coverage.rows) {
  const operation = Object.fromEntries(coverage.columns.map((column, index) => [column, row[index] ?? ""])) as Record<string, string>
  const id = operation.operationId ?? ""
  check(id.length > 0, "coverage row without operationId", "coverage")
  check(!coverageByID.has(id), `duplicate coverage row ${id}`, "coverage")
  coverageByID.set(id, row)
  const inventoryOperation = inventoryByID.get(id)
  check(inventoryOperation !== undefined, `coverage row not in inventory: ${id}`, "coverage")
  if (!inventoryOperation) continue
  check(operation.method === inventoryOperation.method, `${id} method mismatch`, "coverage")
  check(operation.path === inventoryOperation.path, `${id} path mismatch`, "coverage")
  check(operation.group === inventoryOperation.group, `${id} group mismatch`, "coverage")
  check(operation.migrationClass === inventoryOperation.migrationClass, `${id} migrationClass mismatch`, "coverage")
  check(operation.parityCoverage === inventoryOperation.parityCoverage, `${id} parityCoverage mismatch`, "coverage")
  check(/^WP-\d{2}$/.test(operation.semanticOwner ?? ""), `${id} invalid semanticOwner ${operation.semanticOwner}`, "coverage")
  check((operation.gapDetail ?? "").length > 0, `${id} empty gapDetail`, "coverage")
  check(
    operation.parityCoverage === "none" ? operation.gapAction !== "extend-exercise" : operation.gapAction === "extend-exercise",
    `${id} gapAction ${operation.gapAction} inconsistent with parityCoverage ${operation.parityCoverage}`,
    "coverage",
  )
}
check(coverageByID.size === 170, `coverage unique rows ${coverageByID.size}`, "coverage")
const coverageCounts = { exercise: 0, none: 0 }
const ownerCounts = new Map<string, number>()
for (const row of coverage.rows) {
  const operation = Object.fromEntries(coverage.columns.map((column, index) => [column, row[index] ?? ""])) as Record<string, string>
  coverageCounts[operation.parityCoverage as "exercise" | "none"] += 1
  ownerCounts.set(operation.semanticOwner ?? "", (ownerCounts.get(operation.semanticOwner ?? "") ?? 0) + 1)
}
check(coverageCounts.exercise === 116 && coverageCounts.none === 54, `coverage counts ${JSON.stringify(coverageCounts)}`, "coverage")
check(
  sameCounts(coverage.ownership.counts, Object.fromEntries([...ownerCounts.entries()].sort())),
  `coverage owner counts ${JSON.stringify(coverage.ownership.counts)} != ${JSON.stringify(Object.fromEntries(ownerCounts))}`,
  "coverage",
)
check(
  [...ownerCounts.values()].reduce((sum, count) => sum + count, 0) === 170,
  "coverage owner counts do not sum to 170",
  "coverage",
)

// --- triage 96 -------------------------------------------------------------
const triageColumns = [
  "operationId",
  "method",
  "path",
  "group",
  "verdict",
  "binary",
  "cutoverOwner",
  "touchPoint",
  "evidence",
]
check(
  triage.columns.length === triageColumns.length && triage.columns.every((column, index) => column === triageColumns[index]),
  `triage columns ${triage.columns.join(",")}`,
  "triage",
)
check(triage.rows.length === 96, `triage rows ${triage.rows.length}`, "triage")
const hostFirstIDs = new Set(inventory.operations.filter((operation) => operation.migrationClass === "host-first").map(key))
const triageByID = new Map<string, Record<string, string>>()
const verdictCounts = { "host-first": 0, "session-storage": 0, "session-execution": 0 }
for (const row of triage.rows) {
  const operation = Object.fromEntries(triage.columns.map((column, index) => [column, row[index] ?? ""])) as Record<string, string>
  const id = operation.operationId ?? ""
  check(!triageByID.has(id), `duplicate triage row ${id}`, "triage")
  triageByID.set(id, operation)
  check(hostFirstIDs.has(id), `triage row is not host-first in inventory: ${id}`, "triage")
  const inventoryOperation = inventoryByID.get(id)
  if (inventoryOperation) {
    check(operation.method === inventoryOperation.method, `${id} triage method mismatch`, "triage")
    check(operation.path === inventoryOperation.path, `${id} triage path mismatch`, "triage")
    check(operation.group === inventoryOperation.group, `${id} triage group mismatch`, "triage")
  }
  check(
    operation.verdict === "host-first" || operation.verdict === "session-storage" || operation.verdict === "session-execution",
    `${id} invalid verdict ${operation.verdict}`,
    "triage",
  )
  verdictCounts[operation.verdict as keyof typeof verdictCounts] += 1
  check(
    operation.binary === (operation.verdict === "host-first" ? "host-first" : "session-dependent"),
    `${id} binary ${operation.binary} inconsistent with verdict ${operation.verdict}`,
    "triage",
  )
  check((operation.cutoverOwner ?? "").length > 0, `${id} empty cutoverOwner`, "triage")
  check((operation.touchPoint ?? "").length > 0, `${id} empty touchPoint`, "triage")
  check((operation.evidence ?? "").length > 0, `${id} empty evidence`, "triage")
  for (const segment of (operation.evidence ?? "").split(";")) {
    const match = segment.trim().match(/^(.+?):(\d[\d,-]*)$/)
    check(match !== null, `${id} malformed evidence segment ${segment}`, "triage")
    if (!match) continue
    const file = join(root, match[1]!)
    check(await Bun.file(file).exists(), `${id} evidence file missing ${match[1]}`, "triage")
    if (!(await Bun.file(file).exists())) continue
    const lineCount = (await Bun.file(file).text()).split("\n").length
    const maxLine = Math.max(
      ...match[2]!
        .split(",")
        .flatMap((part) => part.split("-").map((value) => Number(value)))
        .filter((value) => Number.isFinite(value)),
    )
    check(maxLine <= lineCount, `${id} evidence line ${maxLine} exceeds ${match[1]} (${lineCount} lines)`, "triage")
  }
}
check(triageByID.size === 96, `triage unique rows ${triageByID.size}`, "triage")
check(
  [...hostFirstIDs].every((id) => triageByID.has(id)),
  "triage does not cover every inventory host-first operation",
  "triage",
)
check(
  verdictCounts["host-first"] === 69 && verdictCounts["session-storage"] === 19 && verdictCounts["session-execution"] === 8,
  `triage verdict counts ${JSON.stringify(verdictCounts)}`,
  "triage",
)
check(
  triage.verdictCounts["host-first"] === 69 &&
    triage.verdictCounts["session-storage"] === 19 &&
    triage.verdictCounts["session-execution"] === 8,
  `triage declared verdict counts ${JSON.stringify(triage.verdictCounts)}`,
  "triage",
)
const construction = triage.constructionLayerDeps
const affectedIDs = new Set(construction.groups.flatMap((group) => group.operationIds))
const constructionListed = construction.groups.reduce((sum, group) => sum + group.operationIds.length, 0)
check(construction.affectedCount === affectedIDs.size, `construction affectedCount ${construction.affectedCount} != unique ids ${affectedIDs.size}`, "triage")
check(constructionListed === 30, `construction layer-blocked entries ${constructionListed}`, "triage")
check(construction.cleanHostFirstCount === 39, `construction cleanHostFirstCount ${construction.cleanHostFirstCount}`, "triage")
check(construction.cleanHostFirstCount + constructionListed === verdictCounts["host-first"], "construction clean + layer-blocked does not equal host-first count", "triage")
check(
  sameCounts(
    Object.fromEntries(construction.groups.map((group) => [group.group, group.operationIds.length])),
    { config: 9, experimental: 9, workspace: 4, memory: 8 },
  ),
  `construction group counts ${JSON.stringify(Object.fromEntries(construction.groups.map((group) => [group.group, group.operationIds.length])))}`,
  "triage",
)
for (const group of construction.groups) {
  for (const id of group.operationIds) {
    const row = triageByID.get(id)
    check(row?.verdict === "host-first", `${id} construction dependency is not host-first`, "triage")
    check(row?.group === group.group, `${id} construction dependency group mismatch`, "triage")
  }
}
const cleanGroupSet = new Set(construction.cleanGroups)
for (const [id, row] of triageByID) {
  if (row.verdict !== "host-first") continue
  if (cleanGroupSet.has(row.group)) check(!affectedIDs.has(id), `${id} is in clean group ${row.group} but listed as layer-blocked`, "triage")
  else check(affectedIDs.has(id), `${id} host-first group ${row.group} missing from constructionLayerDeps`, "triage")
}
check(
  triage.binarySplit["host-first"] === 69 && triage.binarySplit["session-dependent"] === 27,
  `triage binary split ${JSON.stringify(triage.binarySplit)}`,
  "triage",
)

// --- manifest --------------------------------------------------------------
check(manifest.full_openapi_spec.status === "G0-environment-item", `full spec status ${manifest.full_openapi_spec.status}`, "manifest")
check(
  Object.values(manifest.full_openapi_spec.acquisition).every((command) => command.length > 0),
  "full spec acquisition command missing",
  "manifest",
)
const manifestInventory = manifest.frozen_artifacts.inventory_fixture
const manifestFrozen = manifest.frozen_artifacts.inventory_frozen
const manifestCoverage = manifest.frozen_artifacts.coverage_170
const manifestTriage = manifest.frozen_artifacts.triage_96
check(manifestInventory?.sha256 === sourceSha, "manifest inventory sha256 mismatch", "manifest")
check(manifestFrozen?.sha256 === frozenSha, "manifest frozen inventory sha256 mismatch", "manifest")
check(manifestCoverage?.sha256 === (await sha256(coveragePath)), "manifest coverage sha256 mismatch", "manifest")
check(manifestTriage?.sha256 === (await sha256(triagePath)), "manifest triage sha256 mismatch", "manifest")
check(manifestCoverage?.sha256 === (await sha256(coveragePath)), "manifest coverage sha256 mismatch", "manifest")
check(manifestTriage?.sha256 === (await sha256(triagePath)), "manifest triage sha256 mismatch", "manifest")
const staleSdk = manifest.stale_artifacts.find((item) => item.path === "packages/sdk/openapi.json")
check(staleSdk?.observed?.pathCount === 109, "stale sdk openapi pathCount not recorded", "manifest")
check(staleSdk?.observed?.operationCount === 127, "stale sdk openapi operationCount not recorded", "manifest")

// --- sdk baseline ----------------------------------------------------------
check(sdk.files.length === 15, `sdk baseline files ${sdk.files.length}`, "sdk")
check(sdk.comparison_scope.include.includes("packages/sdk/js/src/v2/gen/**"), "sdk include scope missing", "sdk")
check((sdk.preexisting_worktree_drift.status ?? "").length > 0, "sdk preexisting drift not recorded", "sdk")
const typesGen = sdk.files.find((file) => file.path === sdk.preexisting_worktree_drift.path)
check((sdk.preexisting_worktree_drift.head_sha256 ?? "").length === 64, "sdk baseline missing HEAD sha256 for preexisting drift", "sdk")
check(
  typesGen?.sha256 === sdk.preexisting_worktree_drift.worktree_sha256,
  "sdk baseline worktree sha256 does not match recorded file hash",
  "sdk",
)
if (sdk.preexisting_worktree_drift.status === "modified-vs-HEAD")
  check(
    sdk.preexisting_worktree_drift.head_sha256 !== sdk.preexisting_worktree_drift.worktree_sha256,
    "sdk baseline records identical HEAD and worktree hashes for a modified-vs-HEAD file",
    "sdk",
  )
const baselineFiles = new Set(sdk.files.map((file) => file.path))
const actualFiles = new Set<string>()
for await (const file of new Bun.Glob("**/*").scan({ cwd: sdkGenDir, onlyFiles: true })) {
  actualFiles.add(`packages/sdk/js/src/v2/gen/${file}`)
}
check(
  actualFiles.size === baselineFiles.size && [...actualFiles].every((file) => baselineFiles.has(file)),
  `sdk generated file set changed: ${JSON.stringify({ missing: [...baselineFiles].filter((file) => !actualFiles.has(file)), extra: [...actualFiles].filter((file) => !baselineFiles.has(file)) })}`,
  "sdk",
)
for (const file of sdk.files) {
  const path = join(root, file.path)
  check(await Bun.file(path).exists(), `sdk baseline file missing ${file.path}`, "sdk")
  if (!(await Bun.file(path).exists())) continue
  check((await sha256(path)) === file.sha256, `sdk drift: ${file.path}`, "sdk")
}

// --- report ----------------------------------------------------------------
console.log("WP-04 HTTP contract check")
console.log(`- inventory: ${inventory.operationCount} ops / ${inventory.pathCount} paths (sha256 ${sourceSha.slice(0, 12)}...)`)
console.log(
  `- coverage: ${coverage.rows.length} rows; exercise ${coverageCounts.exercise} / none ${coverageCounts.none}; owners ${JSON.stringify(Object.fromEntries([...ownerCounts.entries()].sort()))}`,
)
console.log(
  `- triage: ${triage.rows.length} rows; host-first ${verdictCounts["host-first"]} / session-dependent ${verdictCounts["session-storage"] + verdictCounts["session-execution"]} (storage ${verdictCounts["session-storage"]}, execution ${verdictCounts["session-execution"]})`,
)
console.log(`- sdk baseline: ${sdk.files.length} files; worktree-captured hashes match (not a HEAD/generator proof; see sdk-drift.md §3.5)`)
console.log(`- full OpenAPI spec: ${manifest.full_openapi_spec.status} (expected 142 paths / 170 ops)`)
console.log(`- checks: ${Object.values(checks).reduce((sum, count) => sum + count, 0)}`)

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log("\nPASS")
}