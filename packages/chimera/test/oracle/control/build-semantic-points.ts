#!/usr/bin/env bun
/**
 * Build `semantic-points.json` from the local W-E phase-1 archive.
 *
 * The archive is a machine-local tool-output file (indexed from memory.md
 * 2026-10-28/29) and is NOT committed. Run:
 *
 *   cd packages/chimera
 *   bun test/oracle/control/build-semantic-points.ts --source <archive-path>
 *
 * The generated JSON is the versioned deliverable; this script only makes the
 * derivation reproducible when the archive is available. It never imports
 * production code and never reads credentials.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { CONTRACT_REV, DOMAINS, SEMANTIC_FORMAT, FIXTURE_VERSION, type Domain } from "./format"

type ArchivePoint = {
  module: string
  primitive: string
  where: string
  purpose: string
  contract: string
  portability: "di" | "structured-concurrency" | "coordination" | "streaming" | "hard"
}

type ArchiveModule = {
  key: string
  semanticsCount: number
  parseFailed: boolean
}

type Archive = {
  totalSemantics: number
  modules: ArchiveModule[]
  nonMechanical: ArchivePoint[]
}

const OWNER: Record<string, string> = {
  "session-prompt": "session-prompt owner",
  "session-core": "session-core owner",
  "session-stream": "session-stream owner",
  "session-infra": "session-infra owner",
  "server-httpapi": "server-httpapi owner",
  "server-core": "server-core owner",
  agent: "agent owner",
  "tool-core": "tool-core owner",
  "tool-graph": "tool-graph owner",
  provider: "provider owner",
  "config-storage": "config-storage owner",
  plugin: "plugin owner",
}

const DEFAULT_DOMAIN: Record<string, Domain> = {
  "session-prompt": "prompt-assembly",
  "session-core": "prompt-assembly",
  "session-stream": "compaction",
  "session-infra": "job-family",
  "server-httpapi": "mcp-transports",
  "server-core": "mcp-transports",
  agent: "job-family",
  "tool-core": "mutation-chain",
  "tool-graph": "mutation-chain",
  provider: "compaction",
  "config-storage": "config-bootstrap",
  plugin: "config-bootstrap",
}

const KEYWORDS: Array<{ pattern: RegExp; domain: Domain }> = [
  { pattern: /goal/i, domain: "goal" },
  { pattern: /work[ -]?brief/i, domain: "workbrief" },
  { pattern: /tool[ _-]?search|reveal/i, domain: "tool-search" },
  { pattern: /compaction|compact/i, domain: "compaction" },
  { pattern: /skill/i, domain: "skills" },
  { pattern: /instruction/i, domain: "instructions" },
  { pattern: /mcp/i, domain: "mcp-transports" },
  { pattern: /background[ -]?job|quiescen|delivery/i, domain: "job-family" },
  { pattern: /retention|prune|evidence/i, domain: "retention" },
  { pattern: /edit[ _-]?intent|claim|predesign|obligation|audit/i, domain: "mutation-chain" },
  { pattern: /config|bootstrap|plugin/i, domain: "config-bootstrap" },
  { pattern: /prompt|segment|system/i, domain: "prompt-assembly" },
]

const PRIMARY_FIXTURE: Record<Domain, string> = {
  "config-bootstrap": "config-bootstrap/merge-order",
  skills: "skills/precedence",
  instructions: "instructions/first-match",
  workbrief: "workbrief/normalize-render",
  goal: "goal/transitions",
  "prompt-assembly": "prompt-assembly/segment-order",
  "tool-search": "tool-search/score-and-reveal",
  compaction: "compaction/select-and-prune",
  "mutation-chain": "mutation-chain/auto-audit-pass",
  "mcp-transports": "mcp-transports/streamable-then-sse",
  "job-family": "job-family/cancel-cascade",
  retention: "retention/session-prune",
}

const EXISTING_SUITE: Record<string, string> = {
  "session-prompt": "test/session/prompt.test.ts",
  "session-core": "test/session/session.test.ts",
  "session-stream": "test/session/compaction.test.ts",
  "session-infra": "test/session/activity.test.ts",
  "server-httpapi": "test/server/httpapi-inventory.test.ts",
  "server-core": "test/server/httpapi-integration.test.ts",
  agent: "test/agent/background-job.test.ts",
  "tool-core": "test/tool/chimera.test.ts",
  "tool-graph": "test/tool/chimera.test.ts",
  provider: "test/provider/provider.test.ts",
  "config-storage": "test/config/config.test.ts",
  plugin: "test/oracle/plugin/trajectory.test.ts",
}

function sourceArg(): string {
  const index = Bun.argv.indexOf("--source")
  const value = index >= 0 ? Bun.argv[index + 1] : undefined
  if (!value) {
    console.error("usage: bun test/oracle/control/build-semantic-points.ts --source <archive-path>")
    process.exit(1)
  }
  return path.resolve(value)
}

function parseArchive(file: string): Archive {
  const text = readFileSync(file, "utf8")
  const marker = text.indexOf("## Result")
  if (marker < 0) throw new Error("archive has no '## Result' section")
  return JSON.parse(text.slice(marker + "## Result".length).trim()) as Archive
}

function clamp(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact
}

function domainsFor(point: ArchivePoint): Domain[] {
  const haystack = `${point.primitive} ${point.where}`
  const matched = KEYWORDS.filter((entry) => entry.pattern.test(haystack)).map((entry) => entry.domain)
  const defaults = DEFAULT_DOMAIN[point.module]
  return [...new Set([...(defaults ? [defaults] : []), ...matched])].filter((domain) => DOMAINS.includes(domain))
}

async function main() {
  const archive = parseArchive(sourceArg())
  const moduleCounts = new Map(archive.modules.map((module) => [module.key, module.semanticsCount]))
  const detailed = new Map<string, number>()
  for (const point of archive.nonMechanical) detailed.set(point.module, (detailed.get(point.module) ?? 0) + 1)

  const points = archive.nonMechanical.map((point, index) => {
    const domains = domainsFor(point)
    const explicit = KEYWORDS.some((entry) => entry.pattern.test(`${point.primitive} ${point.where}`) && domains.includes(entry.domain))
    const defaultDomain = DEFAULT_DOMAIN[point.module]
    const extra = domains.filter((domain) => domain !== defaultDomain)
    const primary = explicit ? (extra.length === 1 ? extra[0] : (defaultDomain ?? extra[0])) : undefined
    const id = `WE-${point.module}-${String(index + 1).padStart(3, "0")}`
    return {
      id,
      module: point.module,
      primitive: clamp(point.primitive, 160),
      where: point.where,
      portability: point.portability,
      owner_role: OWNER[point.module] ?? "control-plane owner",
      fixture: primary
        ? {
            // Domain-level association: the primary fixture covers the same
            // control area, not point-level parity.
            status: "existing-domain" as const,
            ref: PRIMARY_FIXTURE[primary],
          }
        : {
            status: "pending" as const,
            ref: `pending:${point.module}/${id}`,
          },
      control_domains: domains,
      existing_suite: EXISTING_SUITE[point.module],
      purpose: clamp(point.purpose, 240),
      contract: clamp(point.contract, 160),
      note: primary
        ? "domain-level behavior fixture covers the same control area; W-E point-level parity remains pending."
        : "no point-level fixture; pending id is the planned fixture slot.",
    }
  })

  const buckets = archive.modules.map((module) => {
    const detail = detailed.get(module.key) ?? 0
    const count = module.semanticsCount - detail
    return {
      id: `WE-mechanical-${module.key}`,
      module: module.key,
      count,
      owner_role: OWNER[module.key] ?? "control-plane owner",
      fixture: {
        status: "pending" as const,
        ref: `pending:${module.key}/mechanical-bucket`,
      },
      control_domains: [DEFAULT_DOMAIN[module.key]].filter((domain): domain is Domain => Boolean(domain)),
      note: `source archive enumerates only ${detail} non-mechanical point(s) for this module; the remaining ${count} mechanical point(s) have a module-level count only, so this bucket carries them without fabricating file:line entries.`,
    }
  })

  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0) + points.length
  if (total !== archive.totalSemantics) {
    throw new Error(`coverage mismatch: ${points.length} + ${total - points.length} = ${total}, archive says ${archive.totalSemantics}`)
  }
  for (const module of archive.modules) {
    if (!moduleCounts.has(module.key)) throw new Error(`missing module count for ${module.key}`)
  }

  const output = {
    format: SEMANTIC_FORMAT,
    version: FIXTURE_VERSION,
    contract_rev: CONTRACT_REV,
    source: {
      plan: "RUST_FULL_MIGRATION_PLAN.md:264,320",
      archive: "tool-output/tool_1817c7215001Jj52Lh6h4U02cg",
      archive_date: "2026-10-28",
      total: archive.totalSemantics,
      enumerated: points.length,
      mechanical_buckets: total - points.length,
      explanation:
        "343 = 12 个模块 semanticsCount 之和。归档逐点列出 223 个非 mechanical 点（file:line）；其余 120 个 mechanical 点只有模块级计数，本文件用 12 个 bucket 承载，不伪造逐点 file:line。",
    },
    points,
    mechanical_buckets: buckets,
  }

  const out = path.join(import.meta.dir, "semantic-points.json")
  await Bun.write(out, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${points.length} points + ${buckets.length} buckets = ${total}`)
}

await main()