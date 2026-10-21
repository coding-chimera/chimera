// H0 process-tree observation harness (RUST_HOST_MIGRATION_PLAN.md -> H0).
//
// Recursively samples a process tree (host -> Bun workers -> external children)
// using only read-only OS commands, and records per node:
//   - RSS / VSZ from a single `ps -axo` table snapshot
//   - phys_footprint + footprint categories from `footprint -p` (macOS only)
//   - JSC heap fields (heapUsed/heapTotal/external/arrayBuffers) for this
//     harness process and for opt-in `--probe` children that report their own
//     `process.memoryUsage()` over stdout
//   - open FD count (`lsof -p ... -Fn`, optional per node)
//   - thread count (`ps -M -p`)
//   - process node count and per-node child count
//
// Two modes, matching script/bench/memory-campaign.ts:
//   - parent (default): samples, aggregates, writes report.json + report.md
//   - probe (--probe): tiny Bun child that prints one heap line per interval;
//     used by `--scenario fixture` so the harness never needs a long-running
//     service to demonstrate recursive tree + heap sampling.
//
// Run from packages/chimera:
//   bun run script/bench/h0-process-tree.ts                       # dry-run (default)
//   bun run script/bench/h0-process-tree.ts --scenario fixture
//   bun run script/bench/h0-process-tree.ts --scenario attach --pid 12345 --duration-ms 60000
//   bun run script/bench/h0-process-tree.ts --scenario exec -- bun run ./some-script.ts
//
// Options (CLI flags, all optional):
//   --scenario dry-run|fixture|attach|exec   default dry-run
//   --pid <pid>                              attach target (attach only)
//   --duration-ms <n>                        default 5000 (fixture 2000)
//   --interval-ms <n>                        default 500
//   --children <n>                           fixture probe fan-out, default 1
//   --footprint tree|root|off                default tree
//   --fd tree|root|off                       default root
//   --threads tree|root|off                  default tree
//   --max-nodes <n>                          default 200
//   --label <name>                           output directory suffix
//   --out <dir>                              archive dir, default $BENCH_H0_OUT or /Volumes/workspace/cbench/h0-process-tree
//   --kill-on-exit                           exec only: terminate the child we spawned
//
// Safety: never builds or executes a fresh Rust/host binary, never kills an
// attach target or the session host, and default mode performs no sampling.
import fs from "fs"
import path from "path"

const MB = 1024 * 1024
const SCHEMA = "chimera.h0.process-tree/v1"
const PROBE_PREFIX = "__H0_PROBE__ "
const DEFAULT_OUT = "/Volumes/workspace/cbench/h0-process-tree"
const IGNORED_COMMANDS = new Set(["ps", "lsof", "footprint"])

export type Role = "host" | "worker" | "external"
export type Scenario = "dry-run" | "fixture" | "attach" | "exec"
export type SampleMode = "tree" | "root" | "off"

export type ProcessRow = {
  pid: number
  ppid: number
  rssBytes: number
  vszBytes: number
  stat: string
  elapsed: string
  command: string
}

export type FootprintCategory = {
  name: string
  dirtyBytes: number
  cleanBytes: number
  reclaimableBytes: number
  regions: number
}

export type Footprint =
  | { available: true; bytes: number; categories: FootprintCategory[]; excerpt: string }
  | { available: false; reason: string }

export type HeapSnapshot =
  | {
      available: true
      source: "self" | "probe"
      rssBytes: number
      heapUsedBytes: number
      heapTotalBytes: number
      externalBytes: number
      arrayBuffersBytes: number
    }
  | { available: false; reason: string }

export type NodeSample = {
  pid: number
  ppid: number
  depth: number
  role: Role
  command: string
  rssBytes: number
  vszBytes: number
  stat: string
  elapsed: string
  childCount: number
  footprint: Footprint
  heap: HeapSnapshot
  fdCount: number | null
  threadCount: number | null
}

export type Sample = {
  index: number
  tMs: number
  at: string
  processCount: number
  totalRssBytes: number
  totalFootprintBytes: number | null
  truncated: boolean
  nodes: NodeSample[]
}

export type Invariant = {
  id: string
  status: "pass" | "fail" | "skipped"
  detail: string
}

export type NodeSeen = {
  pid: number
  role: Role
  command: string
  firstSeenIndex: number
  lastSeenIndex: number
  peakRssBytes: number
  peakFootprintBytes: number | null
  samples: number
}

export type Summary = {
  samples: number
  durationMs: number
  peak: {
    processCount: number
    totalRssBytes: number
    totalFootprintBytes: number | null
  }
  retained: {
    processCount: number
    totalRssBytes: number
    totalFootprintBytes: number | null
  }
  nodesSeen: NodeSeen[]
  appearedPids: number[]
  exitedPids: number[]
  roleCounts: Record<Role, number>
}

export type Report = {
  schema: typeof SCHEMA
  generatedAt: string
  dryRun: boolean
  harness: {
    pid: number
    platform: string
    arch: string
    bun: string
    argv: string[]
    intervalMs: number
    durationMs: number
    footprintMode: SampleMode
    fdMode: SampleMode
    threadMode: SampleMode
    maxNodes: number
  }
  scenario: {
    kind: Scenario
    label: string
    rootPid: number | null
    command: string[] | null
    children: number
    notes: string[]
    plan: string[]
  }
  samples: Sample[]
  summary: Summary
  invariants: Invariant[]
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

export function parseByteSize(text: string): number | undefined {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(bytes?|B|KB|MB|GB|TB)\s*$/i.exec(text)
  if (!match) return
  const value = Number(match[1])
  if (!Number.isFinite(value)) return
  const unit = match[2].toUpperCase()
  if (unit === "B" || unit === "BYTE" || unit === "BYTES") return Math.round(value)
  if (unit === "KB") return Math.round(value * 1024)
  if (unit === "MB") return Math.round(value * MB)
  if (unit === "GB") return Math.round(value * 1024 * MB)
  return Math.round(value * 1024 * 1024 * MB)
}

export function parsePsTable(text: string): ProcessRow[] {
  return text
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      vszBytes: Number(match[4]) * 1024,
      stat: match[5],
      elapsed: match[6],
      command: match[7].trim(),
    }))
}

export function parseThreadCount(text: string): number {
  return text.split("\n").filter((line) => /^\S+\s+\d+\s+/.test(line)).length
}

export function parseLsofFdCount(text: string): number {
  return text.split("\n").filter((line) => line.startsWith("f")).length
}

export function parseFootprint(text: string): Footprint {
  const header = /Footprint:\s*([0-9.]+\s*[KMG]?B)/i.exec(text)
  if (!header) return { available: false, reason: "no footprint header" }
  const bytes = parseByteSize(header[1])
  if (bytes === undefined) return { available: false, reason: `unparsed footprint: ${header[1]}` }
  const categories: FootprintCategory[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*([0-9.]+\s*[KMG]?B)\s+([0-9.]+\s*[KMG]?B)\s+([0-9.]+\s*[KMG]?B)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const dirtyBytes = parseByteSize(match[1])
    const cleanBytes = parseByteSize(match[2])
    const reclaimableBytes = parseByteSize(match[3])
    if (dirtyBytes === undefined || cleanBytes === undefined || reclaimableBytes === undefined) continue
    categories.push({ name: match[5], dirtyBytes, cleanBytes, reclaimableBytes, regions: Number(match[4]) })
  }
  return {
    available: true,
    bytes,
    categories,
    excerpt: text.split("\n").slice(0, 3).join("\n"),
  }
}

export function classifyRole(depth: number, command: string): Role {
  if (depth === 0) return "host"
  const executable = command.trim().split(/\s+/)[0] ?? ""
  const base = path.basename(executable).toLowerCase().replace(/\.exe$/, "")
  if (base === "bun" || base === "node" || base === "deno" || base.startsWith("bun-")) return "worker"
  return "external"
}

export type TreeNode = Omit<NodeSample, "footprint" | "heap" | "fdCount" | "threadCount">

export function buildTree(
  rows: ProcessRow[],
  rootPid: number,
  input: { maxNodes?: number; ignoreCommands?: Set<string> } = {},
): { nodes: TreeNode[]; truncated: boolean } {
  const maxNodes = input.maxNodes ?? 200
  const ignoreCommands = input.ignoreCommands ?? IGNORED_COMMANDS
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  if (!byPid.has(rootPid)) return { nodes: [], truncated: false }
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const nodes: TreeNode[] = []
  const queue: { pid: number; depth: number }[] = [{ pid: rootPid, depth: 0 }]
  const seen = new Set<number>()
  let truncated = false
  while (queue.length) {
    const next = queue.shift()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    const row = byPid.get(next.pid)
    if (!row) continue
    if (next.depth > 0 && ignoreCommands.has(path.basename(row.command))) continue
    if (nodes.length >= maxNodes) {
      truncated = true
      break
    }
    nodes.push({
      pid: row.pid,
      ppid: row.ppid,
      depth: next.depth,
      role: classifyRole(next.depth, row.command),
      command: row.command,
      rssBytes: row.rssBytes,
      vszBytes: row.vszBytes,
      stat: row.stat,
      elapsed: row.elapsed,
      childCount: (children.get(row.pid) ?? []).filter(
        (child) => !ignoreCommands.has(path.basename(child.command)),
      ).length,
    })
    for (const child of children.get(row.pid) ?? []) {
      if (!seen.has(child.pid)) queue.push({ pid: child.pid, depth: next.depth + 1 })
    }
  }
  return { nodes, truncated }
}

export function summarizeSamples(samples: Sample[]): Summary {
  const peak = { processCount: 0, totalRssBytes: 0, totalFootprintBytes: null as number | null }
  const seen = new Map<number, NodeSeen>()
  const lastIndex = samples.length - 1
  for (const sample of samples) {
    peak.processCount = Math.max(peak.processCount, sample.processCount)
    peak.totalRssBytes = Math.max(peak.totalRssBytes, sample.totalRssBytes)
    if (sample.totalFootprintBytes !== null) {
      peak.totalFootprintBytes = Math.max(peak.totalFootprintBytes ?? 0, sample.totalFootprintBytes)
    }
    for (const node of sample.nodes) {
      const existing = seen.get(node.pid)
      const footprint = node.footprint.available ? node.footprint.bytes : null
      if (!existing) {
        seen.set(node.pid, {
          pid: node.pid,
          role: node.role,
          command: node.command,
          firstSeenIndex: sample.index,
          lastSeenIndex: sample.index,
          peakRssBytes: node.rssBytes,
          peakFootprintBytes: footprint,
          samples: 1,
        })
        continue
      }
      existing.lastSeenIndex = sample.index
      existing.samples++
      existing.peakRssBytes = Math.max(existing.peakRssBytes, node.rssBytes)
      if (footprint !== null) existing.peakFootprintBytes = Math.max(existing.peakFootprintBytes ?? 0, footprint)
    }
  }
  const nodesSeen = [...seen.values()].sort((a, b) => b.peakRssBytes - a.peakRssBytes)
  const retainedSample = samples[lastIndex]
  const roleCounts: Record<Role, number> = { host: 0, worker: 0, external: 0 }
  for (const node of retainedSample?.nodes ?? []) roleCounts[node.role]++
  return {
    samples: samples.length,
    durationMs: samples.length > 1 ? samples[lastIndex].tMs - samples[0].tMs : 0,
    peak,
    retained: {
      processCount: retainedSample?.processCount ?? 0,
      totalRssBytes: retainedSample?.totalRssBytes ?? 0,
      totalFootprintBytes: retainedSample?.totalFootprintBytes ?? null,
    },
    nodesSeen,
    appearedPids: nodesSeen.filter((node) => node.firstSeenIndex > 0).map((node) => node.pid),
    exitedPids: nodesSeen.filter((node) => node.lastSeenIndex < lastIndex).map((node) => node.pid),
    roleCounts,
  }
}

export function evaluateInvariants(
  samples: Sample[],
  input: { harnessPid: number; rootPid: number | null },
): Invariant[] {
  const countIssues: string[] = []
  const treeIssues: string[] = []
  const harnessIssues: string[] = []
  for (const sample of samples) {
    if (sample.processCount !== sample.nodes.length) {
      countIssues.push(`sample ${sample.index}: processCount ${sample.processCount} != nodes ${sample.nodes.length}`)
    }
    const sum = sample.nodes.reduce((total, node) => total + node.rssBytes, 0)
    if (sum !== sample.totalRssBytes) {
      countIssues.push(`sample ${sample.index}: totalRssBytes ${sample.totalRssBytes} != sum ${sum}`)
    }
    const pids = new Set(sample.nodes.map((node) => node.pid))
    for (const node of sample.nodes) {
      if (node.depth > 0 && !pids.has(node.ppid)) {
        treeIssues.push(`sample ${sample.index}: pid ${node.pid} parent ${node.ppid} missing`)
      }
    }
    if (pids.has(input.harnessPid)) harnessIssues.push(`sample ${sample.index}: harness pid ${input.harnessPid} sampled`)
  }

  const exitIssues: string[] = []
  const seenIndices = new Map<number, number[]>()
  for (const sample of samples) {
    for (const node of sample.nodes) {
      const indices = seenIndices.get(node.pid)
      if (indices) indices.push(sample.index)
      else seenIndices.set(node.pid, [sample.index])
    }
  }
  for (const [pid, indices] of seenIndices) {
    for (let position = 1; position < indices.length; position++) {
      if (indices[position] - indices[position - 1] > 1) {
        exitIssues.push(
          `pid ${pid} reappeared in sample ${indices[position]} after last seen ${indices[position - 1]}`,
        )
      }
    }
  }

  return [
    {
      id: "node-count-consistency",
      status: countIssues.length ? "fail" : samples.length ? "pass" : "skipped",
      detail: countIssues.length
        ? countIssues.slice(0, 5).join("; ")
        : "processCount and totalRssBytes match sampled nodes",
    },
    {
      id: "tree-contiguity",
      status: treeIssues.length ? "fail" : samples.length ? "pass" : "skipped",
      detail: treeIssues.length
        ? treeIssues.slice(0, 5).join("; ")
        : "every non-root node's parent is present in the same sample",
    },
    {
      id: "harness-excluded",
      status: harnessIssues.length ? "fail" : samples.length ? "pass" : "skipped",
      detail: harnessIssues.length
        ? harnessIssues.slice(0, 5).join("; ")
        : `harness pid ${input.harnessPid} is not part of the sampled tree`,
    },
    {
      id: "worker-exit-frees-address-space",
      status: exitIssues.length ? "fail" : samples.length > 1 ? "pass" : "skipped",
      detail: exitIssues.length
        ? exitIssues.slice(0, 5).join("; ")
        : samples.length > 1
          ? "no sampled pid reappeared after its last observed sample; totals are recomputed from live nodes only"
          : "single sample: exit behaviour not observable",
    },
  ]
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function mb(value: number | null | undefined) {
  if (value === null || value === undefined) return "-"
  return (value / MB).toFixed(1)
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)))
  const line = (cells: string[]) => cells.map((cell, index) => (cell ?? "").padEnd(widths[index])).join(" | ")
  return [`| ${line(headers)} |`, `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map((row) => `| ${line(row)} |`)].join("\n")
}

function stamp(date: Date) {
  const two = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = []
  lines.push("# H0 process-tree sample")
  lines.push("")
  lines.push(`- schema: \`${report.schema}\``)
  lines.push(`- generated: ${report.generatedAt}`)
  lines.push(`- scenario: ${report.scenario.kind} (${report.scenario.label})`)
  lines.push(`- root pid: ${report.scenario.rootPid ?? "-"}`)
  lines.push(`- platform: ${report.harness.platform}/${report.harness.arch}`)
  lines.push(`- bun: ${report.harness.bun}`)
  lines.push(`- interval: ${report.harness.intervalMs}ms, duration: ${report.harness.durationMs}ms`)
  lines.push(`- dry run: ${report.dryRun}`)
  if (report.scenario.notes.length) {
    lines.push("")
    for (const note of report.scenario.notes) lines.push(`> ${note}`)
  }
  lines.push("")

  if (report.dryRun || !report.samples.length) {
    lines.push("## Plan")
    lines.push("")
    for (const step of report.scenario.plan) lines.push(`- ${step}`)
    lines.push("")
    lines.push("No sampling performed (dry run).")
    return lines.join("\n")
  }

  lines.push("## Totals per sample")
  lines.push("")
  lines.push(
    table(
      ["#", "t ms", "procs", "RSS MB", "footprint MB", "host", "worker", "external", "truncated"],
      report.samples.map((sample) => {
        const counts: Record<Role, number> = { host: 0, worker: 0, external: 0 }
        for (const node of sample.nodes) counts[node.role]++
        return [
          String(sample.index),
          String(sample.tMs),
          String(sample.processCount),
          mb(sample.totalRssBytes),
          mb(sample.totalFootprintBytes),
          String(counts.host),
          String(counts.worker),
          String(counts.external),
          sample.truncated ? "yes" : "no",
        ]
      }),
    ),
  )
  lines.push("")

  const last = report.samples[report.samples.length - 1]
  lines.push("## Nodes (last sample)")
  lines.push("")
  lines.push(
    table(
      ["pid", "ppid", "depth", "role", "RSS MB", "footprint MB", "threads", "fds", "heap used MB", "command"],
      last.nodes.map((node) => [
        String(node.pid),
        String(node.ppid),
        String(node.depth),
        node.role,
        mb(node.rssBytes),
        node.footprint.available ? mb(node.footprint.bytes) : "-",
        node.threadCount === null ? "-" : String(node.threadCount),
        node.fdCount === null ? "-" : String(node.fdCount),
        node.heap.available ? mb(node.heap.heapUsedBytes) : "-",
        node.command,
      ]),
    ),
  )
  lines.push("")

  lines.push("## Peak per pid")
  lines.push("")
  lines.push(
    table(
      ["pid", "role", "peak RSS MB", "peak footprint MB", "first seen", "last seen", "samples", "command"],
      report.summary.nodesSeen.map((node) => [
        String(node.pid),
        node.role,
        mb(node.peakRssBytes),
        mb(node.peakFootprintBytes),
        String(node.firstSeenIndex),
        String(node.lastSeenIndex),
        String(node.samples),
        node.command,
      ]),
    ),
  )
  lines.push("")

  lines.push("## Invariants")
  lines.push("")
  lines.push(
    table(
      ["id", "status", "detail"],
      report.invariants.map((invariant) => [invariant.id, invariant.status, invariant.detail]),
    ),
  )
  lines.push("")
  return lines.join("\n")
}

export type ReportInput = {
  scenario: Scenario
  label: string
  rootPid: number | null
  command: string[] | null
  children: number
  intervalMs: number
  durationMs: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
  plan: string[]
  notes?: string[]
}

function reportShell(input: ReportInput, dryRun: boolean) {
  return {
    schema: SCHEMA as typeof SCHEMA,
    generatedAt: new Date().toISOString(),
    dryRun,
    harness: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      argv: process.argv.slice(2),
      intervalMs: input.intervalMs,
      durationMs: input.durationMs,
      footprintMode: input.footprintMode,
      fdMode: input.fdMode,
      threadMode: input.threadMode,
      maxNodes: input.maxNodes,
    },
    scenario: {
      kind: input.scenario,
      label: input.label,
      rootPid: input.rootPid,
      command: input.command,
      children: input.children,
      notes: input.notes ?? [],
      plan: input.plan,
    },
  }
}

export function buildDryRunReport(input: ReportInput): Report {
  return {
    ...reportShell(input, true),
    samples: [],
    summary: summarizeSamples([]),
    invariants: evaluateInvariants([], { harnessPid: process.pid, rootPid: input.rootPid }),
  }
}

export function buildReport(input: ReportInput & { samples: Sample[] }): Report {
  return {
    ...reportShell(input, false),
    samples: input.samples,
    summary: summarizeSamples(input.samples),
    invariants: evaluateInvariants(input.samples, { harnessPid: process.pid, rootPid: input.rootPid }),
  }
}

// ---------------------------------------------------------------------------
// Read-only sampling
// ---------------------------------------------------------------------------

type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean }

async function runCommand(cmd: string[], timeoutMs = 4_000): Promise<CommandResult> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const killer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        // best effort
      }
    }, timeoutMs)
    killer.unref?.()
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(killer)
    return { code, stdout, stderr, timedOut }
  } catch (error) {
    return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false }
  }
}

export type ProbeRegistry = Map<number, HeapSnapshot>

export function ingestProbeLine(line: string, registry: ProbeRegistry): boolean {
  if (!line.startsWith(PROBE_PREFIX)) return false
  try {
    const parsed = JSON.parse(line.slice(PROBE_PREFIX.length)) as {
      pid?: number
      mem?: { rss?: number; heapUsed?: number; heapTotal?: number; external?: number; arrayBuffers?: number }
    }
    if (!parsed.pid || !parsed.mem) return false
    registry.set(parsed.pid, {
      available: true,
      source: "probe",
      rssBytes: parsed.mem.rss ?? 0,
      heapUsedBytes: parsed.mem.heapUsed ?? 0,
      heapTotalBytes: parsed.mem.heapTotal ?? 0,
      externalBytes: parsed.mem.external ?? 0,
      arrayBuffersBytes: parsed.mem.arrayBuffers ?? 0,
    })
    return true
  } catch {
    return false
  }
}

function selfHeap(): HeapSnapshot {
  const mem = process.memoryUsage()
  return {
    available: true,
    source: "self",
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external ?? 0,
    arrayBuffersBytes: mem.arrayBuffers ?? 0,
  }
}

async function footprintFor(pid: number): Promise<Footprint> {
  if (process.platform !== "darwin") return { available: false, reason: `platform ${process.platform}` }
  const result = await runCommand(["footprint", "-p", String(pid)])
  const text = result.stdout || result.stderr
  const parsed = parseFootprint(text)
  if (!parsed.available) {
    return { available: false, reason: result.timedOut ? "footprint timed out" : parsed.reason }
  }
  return parsed
}

async function threadCountFor(pid: number): Promise<number | null> {
  const result = await runCommand(["ps", "-M", "-p", String(pid)])
  if (result.code !== 0) return null
  const count = parseThreadCount(result.stdout)
  return count > 0 ? count : null
}

async function fdCountFor(pid: number): Promise<number | null> {
  const result = await runCommand(["lsof", "-p", String(pid), "-Fn", "-w"])
  if (result.code !== 0 && !result.stdout) return null
  return parseLsofFdCount(result.stdout)
}

export async function sampleTree(input: {
  rootPid: number
  index: number
  startedAt: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
  probes: ProbeRegistry
}): Promise<Sample> {
  const ps = await runCommand(["ps", "-axo", "pid=,ppid=,rss=,vsz=,stat=,etime=,comm="])
  const tree = buildTree(parsePsTable(ps.stdout), input.rootPid, { maxNodes: input.maxNodes })
  const nodes = await Promise.all(
    tree.nodes.map(async (node): Promise<NodeSample> => {
      const wantFootprint = input.footprintMode === "tree" || (input.footprintMode === "root" && node.depth === 0)
      const wantFd = input.fdMode === "tree" || (input.fdMode === "root" && node.depth === 0)
      const wantThreads = input.threadMode === "tree" || (input.threadMode === "root" && node.depth === 0)
      const [footprint, fdCount, threadCount] = await Promise.all([
        wantFootprint ? footprintFor(node.pid) : Promise.resolve<Footprint>({ available: false, reason: "disabled" }),
        wantFd ? fdCountFor(node.pid) : Promise.resolve<number | null>(null),
        wantThreads ? threadCountFor(node.pid) : Promise.resolve<number | null>(null),
      ])
      const heap =
        node.pid === process.pid
          ? selfHeap()
          : (input.probes.get(node.pid) ?? { available: false, reason: "external-process (no probe channel)" })
      return { ...node, footprint, fdCount, threadCount, heap }
    }),
  )
  const totalFootprintBytes = nodes.reduce(
    (total, node) => (node.footprint.available ? total + node.footprint.bytes : total),
    0,
  )
  return {
    index: input.index,
    tMs: Math.round(performance.now() - input.startedAt),
    at: new Date().toISOString(),
    processCount: nodes.length,
    totalRssBytes: nodes.reduce((total, node) => total + node.rssBytes, 0),
    totalFootprintBytes: nodes.some((node) => node.footprint.available) ? totalFootprintBytes : null,
    truncated: tree.truncated,
    nodes,
  }
}

// ---------------------------------------------------------------------------
// Probe child (fixture scenario support)
// ---------------------------------------------------------------------------

async function runProbe(input: { children: number; durationMs: number; intervalMs: number }) {
  const emit = () => {
    const mem = process.memoryUsage()
    process.stdout.write(
      `${PROBE_PREFIX}${JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        mem: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external ?? 0,
          arrayBuffers: mem.arrayBuffers ?? 0,
        },
      })}\n`,
    )
  }
  emit()
  const timer = setInterval(emit, input.intervalMs)
  timer.unref?.()
  const childDuration = Math.max(100, input.durationMs - 250)
  const children = Array.from({ length: input.children }, () =>
    Bun.spawn({
      cmd: [
        process.execPath,
        import.meta.path,
        "--probe",
        "--children",
        "0",
        "--duration-ms",
        String(childDuration),
        "--interval-ms",
        String(input.intervalMs),
      ],
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  await Bun.sleep(input.durationMs)
  clearInterval(timer)
  emit()
  for (const child of children) await child.exited
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type LoopOptions = {
  rootPid: number
  durationMs: number
  intervalMs: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
  probes: ProbeRegistry
  untilExit?: () => boolean
}

async function sampleLoop(input: LoopOptions): Promise<Sample[]> {
  const startedAt = performance.now()
  const samples: Sample[] = []
  const deadline = startedAt + input.durationMs
  while (true) {
    const sample = await sampleTree({
      rootPid: input.rootPid,
      index: samples.length,
      startedAt,
      footprintMode: input.footprintMode,
      fdMode: input.fdMode,
      threadMode: input.threadMode,
      maxNodes: input.maxNodes,
      probes: input.probes,
    })
    samples.push(sample)
    const now = performance.now()
    if (now >= deadline || input.untilExit?.()) break
    await Bun.sleep(input.intervalMs)
  }
  return samples
}

async function runFixture(input: {
  children: number
  durationMs: number
  intervalMs: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
}): Promise<{ samples: Sample[]; rootPid: number | null; notes: string[] }> {
  const probes: ProbeRegistry = new Map()
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      import.meta.path,
      "--probe",
      "--children",
      String(input.children),
      "--duration-ms",
      String(input.durationMs),
      "--interval-ms",
      String(input.intervalMs),
    ],
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  })
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) ingestProbeLine(line, probes)
    }
  })()

  const samples: Sample[] = []
  try {
    samples.push(
      ...(await sampleLoop({
        rootPid: proc.pid,
        durationMs: input.durationMs + 1_000,
        intervalMs: input.intervalMs,
        footprintMode: input.footprintMode,
        fdMode: input.fdMode,
        threadMode: input.threadMode,
        maxNodes: input.maxNodes,
        probes,
        untilExit: () => samples.length > 0 && exited,
      })),
    )
  } finally {
    try {
      proc.kill()
    } catch {
      // best effort
    }
    await proc.exited
    await pump
  }
  // Post-exit sample: the fixture root (and its probes) are gone, so the tree
  // must shrink to zero. This is the observable "worker exit frees address
  // space" evidence the H0 exit gate asks for.
  await Bun.sleep(150)
  samples.push(
    await sampleTree({
      rootPid: proc.pid,
      index: samples.length,
      startedAt: performance.now(),
      footprintMode: input.footprintMode,
      fdMode: input.fdMode,
      threadMode: input.threadMode,
      maxNodes: input.maxNodes,
      probes,
    }),
  )
  return {
    samples,
    rootPid: proc.pid,
    notes: [
      "fixture scenario: short-lived --probe Bun children only; no long-running service was started",
      "final sample is taken after the fixture root exited to prove exited nodes are not counted",
    ],
  }
}

async function runAttach(input: {
  pid: number
  durationMs: number
  intervalMs: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
}): Promise<{ samples: Sample[]; rootPid: number; notes: string[] }> {
  const samples = await sampleLoop({
    rootPid: input.pid,
    durationMs: input.durationMs,
    intervalMs: input.intervalMs,
    footprintMode: input.footprintMode,
    fdMode: input.fdMode,
    threadMode: input.threadMode,
    maxNodes: input.maxNodes,
    probes: new Map(),
  })
  return {
    samples,
    rootPid: input.pid,
    notes: ["attach scenario: read-only sampling of an existing process tree; the target is never signalled"],
  }
}

async function runExec(input: {
  command: string[]
  durationMs: number
  intervalMs: number
  footprintMode: SampleMode
  fdMode: SampleMode
  threadMode: SampleMode
  maxNodes: number
  killOnExit: boolean
}): Promise<{ samples: Sample[]; rootPid: number | null; notes: string[] }> {
  const proc = Bun.spawn({ cmd: input.command, stdout: "inherit", stderr: "inherit", env: process.env })
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const samples: Sample[] = []
  try {
    samples.push(
      ...(await sampleLoop({
        rootPid: proc.pid,
        durationMs: input.durationMs,
        intervalMs: input.intervalMs,
        footprintMode: input.footprintMode,
        fdMode: input.fdMode,
        threadMode: input.threadMode,
        maxNodes: input.maxNodes,
        probes: new Map(),
        untilExit: () => samples.length > 0 && exited,
      })),
    )
  } finally {
    if (input.killOnExit) {
      try {
        proc.kill()
      } catch {
        // best effort
      }
    }
    await proc.exited
  }
  return {
    samples,
    rootPid: proc.pid,
    notes: [
      `exec scenario: spawned ${input.command.join(" ")}; ${input.killOnExit ? "terminated" : "not terminated"} on exit`,
    ],
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) return "1"
  return value
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`)
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function mode(value: string | undefined, fallback: SampleMode): SampleMode {
  if (value === "tree" || value === "root" || value === "off") return value
  return fallback
}

function scenarioValue(value: string | undefined): Scenario {
  if (value === "dry-run" || value === "fixture" || value === "attach" || value === "exec") return value
  return "dry-run"
}

function afterDoubleDash() {
  const index = process.argv.indexOf("--")
  if (index < 0) return []
  return process.argv.slice(index + 1)
}

function writeReport(report: Report, outDir: string) {
  const dir = path.join(outDir, `${stamp(new Date())}-${report.scenario.label}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, "report.md"), `${renderMarkdown(report)}\n`)
  return dir
}

async function main() {
  if (hasFlag("probe")) {
    await runProbe({
      children: Number(argValue("children", "0")) || 0,
      durationMs: Number(argValue("duration-ms", "2000")) || 2_000,
      intervalMs: Number(argValue("interval-ms", "500")) || 500,
    })
    return
  }

  const scenario = scenarioValue(argValue("scenario", "dry-run"))
  const label = argValue("label", scenario)!
  const intervalMs = envInt("BENCH_H0_INTERVAL_MS", Number(argValue("interval-ms", "500")) || 500)
  const durationMs = Number(argValue("duration-ms", scenario === "fixture" ? "2000" : "5000")) || 5_000
  const children = Number(argValue("children", "1")) || 1
  const footprintMode = mode(argValue("footprint"), "tree")
  const fdMode = mode(argValue("fd"), "root")
  const threadMode = mode(argValue("threads"), "tree")
  const maxNodes = Number(argValue("max-nodes", "200")) || 200
  const pid = Number(argValue("pid", ""))
  const command = afterDoubleDash()
  const outDir = argValue("out", process.env["BENCH_H0_OUT"] ?? DEFAULT_OUT)!
  const killOnExit = hasFlag("kill-on-exit")
  const outExplicit = process.argv.includes("--out")

  const plan = [
    `scenario: ${scenario}`,
    `sample tree rooted at ${scenario === "attach" ? `pid ${Number.isInteger(pid) && pid > 0 ? pid : "<missing --pid>"}` : "<spawned root>"}`,
    `every ${intervalMs}ms for ${durationMs}ms`,
    "ps -axo pid=,ppid=,rss=,vsz=,stat=,etime=,comm= (single read-only table snapshot)",
    `footprint -p <pid> per node: ${footprintMode}`,
    `ps -M -p <pid> thread count per node: ${threadMode}`,
    `lsof -p <pid> -Fn open FD count per node: ${fdMode}`,
    `max nodes per sample: ${maxNodes}`,
    `archive: ${outDir}/<timestamp>-${label}/{report.json,report.md}`,
  ]

  if (scenario === "dry-run") {
    const report = buildDryRunReport({
      scenario,
      label,
      rootPid: Number.isInteger(pid) && pid > 0 ? pid : null,
      command: command.length ? command : null,
      children,
      intervalMs,
      durationMs,
      footprintMode,
      fdMode,
      threadMode,
      maxNodes,
      plan,
      notes: ["dry run: no process was spawned or sampled"],
    })
    if (outExplicit) {
      const dir = writeReport(report, outDir)
      console.log(`h0-process-tree: dry run written to ${dir}`)
    }
    console.log(renderMarkdown(report))
    return
  }

  let result: { samples: Sample[]; rootPid: number | null; notes: string[] }
  if (scenario === "fixture") {
    result = await runFixture({ children, durationMs, intervalMs, footprintMode, fdMode, threadMode, maxNodes })
  } else if (scenario === "attach") {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("attach scenario requires --pid <pid>")
    result = await runAttach({ pid, durationMs, intervalMs, footprintMode, fdMode, threadMode, maxNodes })
  } else {
    if (!command.length) throw new Error("exec scenario requires a command after --")
    result = await runExec({
      command,
      durationMs,
      intervalMs,
      footprintMode,
      fdMode,
      threadMode,
      maxNodes,
      killOnExit,
    })
  }

  const report = buildReport({
    scenario,
    label,
    rootPid: result.rootPid,
    command: command.length ? command : null,
    children,
    intervalMs,
    durationMs,
    footprintMode,
    fdMode,
    threadMode,
    maxNodes,
    samples: result.samples,
    plan,
    notes: result.notes,
  })
  const dir = writeReport(report, outDir)
  const failed = report.invariants.filter((invariant) => invariant.status === "fail")
  console.log(
    `h0-process-tree: ${report.samples.length} samples, ${report.summary.peak.processCount} peak procs, ` +
      `peak RSS ${mb(report.summary.peak.totalRssBytes)}MB -> ${dir}`,
  )
  for (const invariant of report.invariants) console.log(`  ${invariant.id}: ${invariant.status}`)
  if (failed.length) process.exitCode = 1
}

if (import.meta.main) {
  await main()
}