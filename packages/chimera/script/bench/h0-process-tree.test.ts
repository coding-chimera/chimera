import { describe, expect, test as bunTest } from "bun:test"
import {
  buildDryRunReport,
  buildReport,
  buildTree,
  classifyRole,
  evaluateInvariants,
  ingestProbeLine,
  parseByteSize,
  parseFootprint,
  parseLsofFdCount,
  parsePsTable,
  parseThreadCount,
  renderMarkdown,
  sampleTree,
  summarizeSamples,
  type ProbeRegistry,
  type Sample,
} from "./h0-process-tree"

// The fixture integration case spawns real short-lived `--probe` Bun children
// (no long-running service) and waits for natural exit, so allow a cold-start
// budget above Bun's 5s default.
const test = (name: string, fn: () => void | Promise<void>) => bunTest(name, fn, 30_000)

const SCRIPT = `${import.meta.dir}/h0-process-tree.ts`

const PS_FIXTURE = [
  "    1     0  14784 488724208 Ss   02-08:16:35 /sbin/launchd",
  "  400     1  32000 488910992 S    01:00:00 /usr/local/bin/bun run server.ts",
  "  401   400   8192 488833520 S    00:59:00 /usr/bin/llvm-lsp",
  "  402   400  16384 488790816 S    00:30:00 /usr/local/bin/bun worker.ts",
  "  403   402   4096 488826704 S    00:10:00 /usr/bin/pty-helper",
  "  500   400   2048 488826704 S    00:00:10 /bin/ps",
  "",
].join("\n")

describe("h0 process-tree parsers", () => {
  test("parseByteSize handles B/KB/MB/GB/bytes", () => {
    expect(parseByteSize("0 B")).toBe(0)
    expect(parseByteSize("416 KB")).toBe(416 * 1024)
    expect(parseByteSize("1.5 MB")).toBe(Math.round(1.5 * 1024 * 1024))
    expect(parseByteSize("2 GB")).toBe(2 * 1024 * 1024 * 1024)
    expect(parseByteSize("16384 bytes")).toBe(16384)
    expect(parseByteSize("nope")).toBeUndefined()
  })

  test("parsePsTable converts KB to bytes and keeps spaces in comm", () => {
    const rows = parsePsTable(PS_FIXTURE)
    expect(rows).toHaveLength(6)
    expect(rows[1]).toEqual({
      pid: 400,
      ppid: 1,
      rssBytes: 32000 * 1024,
      vszBytes: 488910992 * 1024,
      stat: "S",
      elapsed: "01:00:00",
      command: "/usr/local/bin/bun run server.ts",
    })
    expect(rows[4].command).toBe("/usr/bin/pty-helper")
  })

  test("parseThreadCount ignores the header row", () => {
    const text = [
      "USER        PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
      "u 100 ?? 1.0 S 31T 0:00.00 0:00.00 bun",
      "u 100 ?? 0.0 S 31T 0:00.00 0:00.00 bun",
      "u 100 ?? 0.0 S 31T 0:00.00 0:00.00 bun",
    ].join("\n")
    expect(parseThreadCount(text)).toBe(3)
    expect(parseThreadCount("")).toBe(0)
  })

  test("parseLsofFdCount counts file descriptors only", () => {
    const text = ["p400", "fcwd", "f0", "f1", "f2", "f3", "p401", "f0"].join("\n")
    expect(parseLsofFdCount(text)).toBe(6)
    expect(parseLsofFdCount("")).toBe(0)
  })

  test("parseFootprint extracts total and category rows", () => {
    const text = [
      "======================================================================",
      "bun [400]: 64-bit    Footprint: 1.5 MB (16384 bytes per page)",
      "======================================================================",
      "",
      "  Dirty      Clean  Reclaimable    Regions    Category",
      "    ---        ---          ---        ---    --------",
      " 416 KB        0 B          0 B          9    Malloc Metadata",
      " 400 KB        0 B          0 B          5    Malloc Small",
      " 272 KB        0 B          0 B          1    page table",
    ].join("\n")
    const footprint = parseFootprint(text)
    expect(footprint.available).toBe(true)
    if (!footprint.available) return
    expect(footprint.bytes).toBe(Math.round(1.5 * 1024 * 1024))
    expect(footprint.categories).toHaveLength(3)
    expect(footprint.categories[0]).toEqual({
      name: "Malloc Metadata",
      dirtyBytes: 416 * 1024,
      cleanBytes: 0,
      reclaimableBytes: 0,
      regions: 9,
    })
    expect(parseFootprint("no header here")).toEqual({ available: false, reason: "no footprint header" })
  })
})

describe("h0 process-tree structure", () => {
  test("classifyRole marks root host, bun descendants worker, others external", () => {
    expect(classifyRole(0, "/usr/local/bin/bun")).toBe("host")
    expect(classifyRole(1, "/usr/local/bin/bun")).toBe("worker")
    expect(classifyRole(2, "/usr/local/bin/node")).toBe("worker")
    expect(classifyRole(1, "/usr/bin/llvm-lsp")).toBe("external")
  })

  test("buildTree walks recursively and ignores sampler commands", () => {
    const { nodes, truncated } = buildTree(parsePsTable(PS_FIXTURE), 400)
    expect(truncated).toBe(false)
    expect(nodes.map((node) => node.pid)).toEqual([400, 401, 402, 403])
    const byPid = new Map(nodes.map((node) => [node.pid, node]))
    expect(byPid.get(400)?.depth).toBe(0)
    expect(byPid.get(400)?.role).toBe("host")
    expect(byPid.get(401)?.depth).toBe(1)
    expect(byPid.get(402)?.role).toBe("worker")
    expect(byPid.get(403)?.depth).toBe(2)
    expect(byPid.get(402)?.childCount).toBe(1)
    expect(byPid.get(401)?.childCount).toBe(0)
  })

  test("buildTree returns empty for a missing root and caps nodes", () => {
    expect(buildTree(parsePsTable(PS_FIXTURE), 999).nodes).toEqual([])
    const capped = buildTree(parsePsTable(PS_FIXTURE), 400, { maxNodes: 2 })
    expect(capped.nodes).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })
})

function node(pid: number, ppid: number, depth: number, rssBytes: number, extra: Partial<Sample["nodes"][number]> = {}) {
  return {
    pid,
    ppid,
    depth,
    role: depth === 0 ? ("host" as const) : ("worker" as const),
    command: depth === 0 ? "/usr/local/bin/bun" : "/usr/local/bin/bun worker",
    rssBytes,
    vszBytes: rssBytes,
    stat: "S",
    elapsed: "00:01",
    childCount: 0,
    footprint: { available: false as const, reason: "disabled" },
    heap: { available: false as const, reason: "test" },
    fdCount: null,
    threadCount: null,
    ...extra,
  }
}

function sample(index: number, nodes: Sample["nodes"]): Sample {
  return {
    index,
    tMs: index * 500,
    at: new Date(0).toISOString(),
    processCount: nodes.length,
    totalRssBytes: nodes.reduce((total, item) => total + item.rssBytes, 0),
    totalFootprintBytes: null,
    truncated: false,
    nodes,
  }
}

describe("h0 process-tree summary and invariants", () => {
  test("summarizeSamples tracks peaks, retention and exits", () => {
    const samples = [
      sample(0, [node(1, 0, 0, 100), node(2, 1, 1, 50)]),
      sample(1, [node(1, 0, 0, 120)]),
    ]
    const summary = summarizeSamples(samples)
    expect(summary.samples).toBe(2)
    expect(summary.peak.processCount).toBe(2)
    expect(summary.peak.totalRssBytes).toBe(150)
    expect(summary.retained.processCount).toBe(1)
    expect(summary.retained.totalRssBytes).toBe(120)
    expect(summary.exitedPids).toEqual([2])
    expect(summary.nodesSeen.find((item) => item.pid === 1)?.peakRssBytes).toBe(120)
    expect(summary.roleCounts).toEqual({ host: 1, worker: 0, external: 0 })
  })

  test("evaluateInvariants passes a consistent exit and fails a reappearance", () => {
    const clean = [sample(0, [node(1, 0, 0, 100), node(2, 1, 1, 50)]), sample(1, [node(1, 0, 0, 120)])]
    const cleanInvariants = evaluateInvariants(clean, { harnessPid: 900, rootPid: 1 })
    expect(cleanInvariants.every((invariant) => invariant.status !== "fail")).toBe(true)

    const reappeared = [sample(0, [node(2, 1, 1, 50)]), sample(1, []), sample(2, [node(2, 1, 1, 50)])]
    const failed = evaluateInvariants(reappeared, { harnessPid: 900, rootPid: 1 })
    expect(failed.find((invariant) => invariant.id === "worker-exit-frees-address-space")?.status).toBe("fail")

    const harnessLeak = [sample(0, [node(900, 0, 0, 10)])]
    expect(evaluateInvariants(harnessLeak, { harnessPid: 900, rootPid: 900 }).find((invariant) => invariant.id === "harness-excluded")?.status).toBe("fail")
  })

  test("evaluateInvariants reports skipped with no samples", () => {
    const invariants = evaluateInvariants([], { harnessPid: 900, rootPid: null })
    expect(invariants.every((invariant) => invariant.status === "skipped")).toBe(true)
  })
})

describe("h0 process-tree report", () => {
  const input = {
    scenario: "dry-run" as const,
    label: "unit",
    rootPid: 123,
    command: null,
    children: 1,
    intervalMs: 500,
    durationMs: 5000,
    footprintMode: "tree" as const,
    fdMode: "root" as const,
    threadMode: "tree" as const,
    maxNodes: 200,
    plan: ["sample the tree"],
  }

  test("dry run report carries the schema, plan and no samples", () => {
    const report = buildDryRunReport(input)
    expect(report.schema).toBe("chimera.h0.process-tree/v1")
    expect(report.dryRun).toBe(true)
    expect(report.samples).toEqual([])
    expect(report.summary.samples).toBe(0)
    expect(report.scenario.plan).toEqual(["sample the tree"])
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("No sampling performed (dry run).")
    expect(markdown).toContain("sample the tree")
  })

  test("buildReport renders totals, nodes and invariants", () => {
    const samples = [sample(0, [node(1, 0, 0, 100)]), sample(1, [node(1, 0, 0, 120)])]
    const report = buildReport({ ...input, samples })
    expect(report.dryRun).toBe(false)
    expect(report.summary.peak.totalRssBytes).toBe(120)
    const markdown = renderMarkdown(report)
    expect(markdown).toContain("## Totals per sample")
    expect(markdown).toContain("## Nodes (last sample)")
    expect(markdown).toContain("## Invariants")
    expect(markdown).toContain("worker-exit-frees-address-space")
  })

  test("ingestProbeLine accepts probe lines and ignores others", () => {
    const registry: ProbeRegistry = new Map()
    expect(ingestProbeLine("plain log line", registry)).toBe(false)
    const line = `__H0_PROBE__ ${JSON.stringify({
      pid: 42,
      mem: { rss: 10, heapUsed: 4, heapTotal: 6, external: 2, arrayBuffers: 1 },
    })}`
    expect(ingestProbeLine(line, registry)).toBe(true)
    const heap = registry.get(42)
    expect(heap?.available).toBe(true)
    if (!heap?.available) return
    expect(heap.source).toBe("probe")
    expect(heap.heapUsedBytes).toBe(4)
    expect(heap.arrayBuffersBytes).toBe(1)
  })
})

describe("h0 process-tree fixture integration", () => {
  test("recursively samples probe children, then drops the exited tree", async () => {
    const probes: ProbeRegistry = new Map()
    const proc = Bun.spawn({
      cmd: [process.execPath, SCRIPT, "--probe", "--children", "1", "--duration-ms", "3000", "--interval-ms", "200"],
      stdout: "pipe",
      stderr: "pipe",
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

    const mode = { footprintMode: "off" as const, fdMode: "off" as const, threadMode: "off" as const }
    // Cold-starting the probe child can take a few hundred ms; poll instead of
    // assuming a fixed delay is enough for the recursive tree to exist.
    let live = await sampleTree({ rootPid: proc.pid, index: 0, startedAt: performance.now(), maxNodes: 50, probes, ...mode })
    for (let attempt = 0; attempt < 20 && (live.processCount < 2 || probes.size < 2); attempt++) {
      await Bun.sleep(150)
      live = await sampleTree({ rootPid: proc.pid, index: 0, startedAt: performance.now(), maxNodes: 50, probes, ...mode })
    }
    expect(live.processCount).toBeGreaterThanOrEqual(2)
    expect(live.nodes[0].role).toBe("host")
    expect(live.nodes.filter((item) => item.depth > 0).every((item) => item.role === "worker")).toBe(true)
    const heapNodes = live.nodes.filter((item) => item.heap.available)
    expect(heapNodes.length).toBeGreaterThanOrEqual(2)
    expect(heapNodes.every((item) => item.heap.available && item.heap.source === "probe")).toBe(true)

    await proc.exited
    await pump
    await Bun.sleep(150)
    const after = await sampleTree({ rootPid: proc.pid, index: 1, startedAt: performance.now(), maxNodes: 50, probes, ...mode })
    expect(after.processCount).toBe(0)
    expect(after.totalRssBytes).toBe(0)

    const report = buildReport({
      scenario: "fixture",
      label: "integration",
      rootPid: proc.pid,
      command: null,
      children: 1,
      intervalMs: 200,
      durationMs: 1500,
      footprintMode: "off",
      fdMode: "off",
      threadMode: "off",
      maxNodes: 50,
      samples: [live, after],
      plan: [],
    })
    expect(report.summary.exitedPids.length).toBeGreaterThanOrEqual(2)
    expect(report.invariants.every((invariant) => invariant.status !== "fail")).toBe(true)
  })
})