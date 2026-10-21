/**
 * H0 HTTP/OpenAPI operation inventory for the Rust host migration
 * (`RUST_HOST_MIGRATION_PLAN.md` -> H0, section 5).
 *
 * The plan's historical "109 paths / 127 operations" numbers are stale. This
 * script is the single reproducible source of truth: it derives every entry
 * from `Server.openapi()` (which is `OpenApi.fromApi(PublicApi)`) and never
 * touches the default runtime, the Rust host, or the SDK generation chain.
 *
 * Usage (from `packages/chimera`):
 *
 *   bun script/httpapi-inventory.ts --write   # regenerate the drift fixture
 *   bun script/httpapi-inventory.ts --check   # exit 1 when the fixture drifts
 *   bun script/httpapi-inventory.ts           # print the inventory JSON
 *
 * Classification is a deliberate H0 first-pass freeze, not an approved
 * implementation plan. Review diffs in the fixture before accepting them.
 */
import { join } from "path"
import { Server } from "../src/server/server"

export const FIXTURE_PATH = join(import.meta.dir, "..", "test", "fixtures", "httpapi-inventory.json")

const EXERCISE_PATH = join(import.meta.dir, "httpapi-exercise.ts")

const METHODS = ["get", "post", "put", "patch", "delete"] as const
type Method = (typeof METHODS)[number]
type HttpMethod = Uppercase<Method>

type MigrationClass = "host-first" | "proxy-first" | "special"
type ParityCoverage = "exercise" | "none"
type Streaming = "none" | "sse" | "websocket"
type Source = "PublicApi" | "PublicApi+raw-route"
type Auth = "basic" | "basic-or-pty-ticket"

export type OperationInventory = {
  operationId: string
  method: HttpMethod
  path: string
  group: string
  source: Source
  auth: Auth
  directoryRewrite: boolean
  workspaceRouting: boolean
  streaming: Streaming
  stateWrites: boolean
  currentOwner: "bun"
  ownerModule: string
  migrationClass: MigrationClass
  parityCoverage: ParityCoverage
}

export type Inventory = {
  version: 1
  source: "Server.openapi()"
  pathCount: number
  operationCount: number
  groupCounts: Record<string, number>
  migrationClassCounts: Record<MigrationClass, number>
  parityCoverageCounts: Record<ParityCoverage, number>
  operations: OperationInventory[]
}

// Minimal structural view of the OpenAPI document. Only the fields the
// inventory consumes are typed; everything else stays opaque.
type SpecParameter = { name?: string; in?: string }
type SpecResponse = { content?: Record<string, unknown> }
type SpecOperation = {
  operationId?: string
  tags?: string[]
  parameters?: SpecParameter[]
  responses?: Record<string, SpecResponse>
}
type SpecPathItem = Partial<Record<Method, SpecOperation>>
type Spec = { paths?: Record<string, SpecPathItem> }

const GROUP_MODULES: Record<string, string> = {
  config: "src/server/routes/instance/httpapi/groups/config.ts",
  control: "src/server/routes/instance/httpapi/groups/control.ts",
  event: "src/server/routes/instance/httpapi/event.ts",
  experimental: "src/server/routes/instance/httpapi/groups/experimental.ts",
  file: "src/server/routes/instance/httpapi/groups/file.ts",
  global: "src/server/routes/instance/httpapi/groups/global.ts",
  graph: "src/server/routes/instance/httpapi/groups/graph.ts",
  instance: "src/server/routes/instance/httpapi/groups/instance.ts",
  mcp: "src/server/routes/instance/httpapi/groups/mcp.ts",
  memory: "src/server/routes/instance/httpapi/groups/memory.ts",
  permission: "src/server/routes/instance/httpapi/groups/permission.ts",
  process: "src/server/routes/instance/httpapi/groups/process.ts",
  project: "src/server/routes/instance/httpapi/groups/project.ts",
  provider: "src/server/routes/instance/httpapi/groups/provider.ts",
  pty: "src/server/routes/instance/httpapi/groups/pty.ts",
  question: "src/server/routes/instance/httpapi/groups/question.ts",
  session: "src/server/routes/instance/httpapi/groups/session.ts",
  sync: "src/server/routes/instance/httpapi/groups/sync.ts",
  tui: "src/server/routes/instance/httpapi/groups/tui.ts",
  v2: "src/server/routes/instance/httpapi/groups/v2/session.ts",
  "v2 credentials": "src/server/routes/instance/httpapi/groups/v2/credential.ts",
  "v2 integrations": "src/server/routes/instance/httpapi/groups/v2/integration.ts",
  "v2 messages": "src/server/routes/instance/httpapi/groups/v2/message.ts",
  workspace: "src/server/routes/instance/httpapi/groups/workspace.ts",
}

// Plan section 5 group-level defaults. Session execution, provider transport,
// plugin/tool execution and approval callbacks stay on the Bun side first.
const GROUP_MIGRATION: Record<string, MigrationClass> = {
  control: "host-first",
  config: "host-first",
  event: "special",
  experimental: "host-first",
  file: "host-first",
  global: "host-first",
  graph: "host-first",
  instance: "host-first",
  mcp: "proxy-first",
  memory: "host-first",
  permission: "proxy-first",
  process: "host-first",
  project: "host-first",
  provider: "proxy-first",
  pty: "special",
  question: "proxy-first",
  session: "proxy-first",
  sync: "proxy-first",
  tui: "special",
  v2: "proxy-first",
  "v2 credentials": "proxy-first",
  "v2 integrations": "proxy-first",
  "v2 messages": "proxy-first",
  workspace: "host-first",
}

// Operation-level overrides. Special first, then host-first reads/durable
// writes that sit inside proxy-first groups, then explicit proxy-first
// execution paths that sit inside host-first groups.
const SPECIAL_OPERATIONS = new Set(["event.subscribe", "global.event", "pty.connect", "lsp.status"])

const HOST_FIRST_OPERATIONS = new Set([
  // Session metadata and message parts are durable state the host will own;
  // only turn execution stays proxy-first (plan 3.2 / 5.2).
  "session.list",
  "session.create",
  "session.status",
  "session.get",
  "session.update",
  "session.delete",
  "session.backgroundQuiescence",
  "session.children",
  "session.todo",
  "session.workBrief",
  "session.goal",
  "session.goalSet",
  "session.goalClear",
  "session.diff",
  "session.messages",
  "session.message",
  "session.deleteMessage",
  "part.update",
  "part.delete",
  // v2 durable reads.
  "v2.session.list",
  "v2.session.context",
  "v2.session.messages",
])

const PROXY_FIRST_OPERATIONS = new Set([
  "experimental.session.background",
  "tool.list",
  "tool.ids",
])

// Conservative method-based classification: write verbs write durable state,
// except POST endpoints that only query.
const WRITE_METHODS = new Set<Method>(["post", "put", "patch", "delete"])
const READ_ONLY_POST_OPERATIONS = new Set(["sync.history.list"])

async function exerciseKeys() {
  const text = await Bun.file(EXERCISE_PATH).text()
  const keys = new Set<string>()
  for (const match of text.matchAll(/\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g)) {
    const method = match[1]
    const path = match[2]
    if (method && path) keys.add(`${method.toUpperCase()} ${path}`)
  }
  return keys
}

function streaming(path: string, operation: SpecOperation): Streaming {
  if (path === "/pty/{ptyID}/connect") return "websocket"
  const hasEventStream = Object.values(operation.responses ?? {}).some(
    (response) => response.content !== undefined && "text/event-stream" in response.content,
  )
  return hasEventStream ? "sse" : "none"
}

function hasQueryParameter(operation: SpecOperation, name: string) {
  return operation.parameters?.some((parameter) => parameter.in === "query" && parameter.name === name) ?? false
}

function migrationClass(operationId: string, group: string): MigrationClass {
  if (SPECIAL_OPERATIONS.has(operationId)) return "special"
  if (HOST_FIRST_OPERATIONS.has(operationId)) return "host-first"
  if (PROXY_FIRST_OPERATIONS.has(operationId)) return "proxy-first"
  return GROUP_MIGRATION[group] ?? "proxy-first"
}

function sortedCounts(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export async function generateInventory(): Promise<Inventory> {
  const spec = (await Server.openapi()) as unknown as Spec
  const exercise = await exerciseKeys()
  const operations: OperationInventory[] = []

  for (const path of Object.keys(spec.paths ?? {}).sort()) {
    const item = spec.paths![path]!
    for (const method of METHODS) {
      const operation = item[method]
      const operationId = operation?.operationId
      if (!operation || !operationId) continue

      const group = operation.tags?.[0] ?? "unclassified"
      const isRawPtyConnect = path === "/pty/{ptyID}/connect"

      operations.push({
        operationId,
        method: method.toUpperCase() as HttpMethod,
        path,
        group,
        source: isRawPtyConnect ? "PublicApi+raw-route" : "PublicApi",
        auth: isRawPtyConnect ? "basic-or-pty-ticket" : "basic",
        directoryRewrite: hasQueryParameter(operation, "directory"),
        workspaceRouting: hasQueryParameter(operation, "workspace"),
        streaming: streaming(path, operation),
        stateWrites: WRITE_METHODS.has(method) && !READ_ONLY_POST_OPERATIONS.has(operationId),
        currentOwner: "bun",
        ownerModule: GROUP_MODULES[group] ?? `src/server/routes/instance/httpapi/groups/${group}.ts`,
        migrationClass: migrationClass(operationId, group),
        parityCoverage: exercise.has(`${method.toUpperCase()} ${path}`) ? "exercise" : "none",
      })
    }
  }

  return {
    version: 1,
    source: "Server.openapi()",
    pathCount: Object.keys(spec.paths ?? {}).length,
    operationCount: operations.length,
    groupCounts: sortedCounts(operations.map((operation) => operation.group)),
    migrationClassCounts: sortedCounts(operations.map((operation) => operation.migrationClass)) as Record<
      MigrationClass,
      number
    >,
    parityCoverageCounts: sortedCounts(operations.map((operation) => operation.parityCoverage)) as Record<
      ParityCoverage,
      number
    >,
    operations,
  }
}

export function renderInventory(inventory: Inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`
}

if (import.meta.main) {
  const inventory = await generateInventory()
  const rendered = renderInventory(inventory)

  if (process.argv.includes("--write")) {
    await Bun.write(FIXTURE_PATH, rendered)
    console.log(
      `httpapi-inventory: wrote ${inventory.operationCount} operations across ${inventory.pathCount} paths to ${FIXTURE_PATH}`,
    )
  } else if (process.argv.includes("--check")) {
    const current = await Bun.file(FIXTURE_PATH).text()
    if (current !== rendered) {
      console.error(`httpapi-inventory: drift detected against ${FIXTURE_PATH}; rerun with --write and review the diff`)
      process.exit(1)
    }
    console.log(`httpapi-inventory: fixture current (${inventory.operationCount} operations, ${inventory.pathCount} paths)`)
  } else {
    console.log(rendered.trimEnd())
  }
}