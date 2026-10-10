import { join, relative } from "path"

const ROOT = join(import.meta.dir, "..", "src")

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(hit.indexOf("=") + 1)) : fallback
}

const maxFileScc = arg("max-file-scc", 246)
const maxModuleScc = arg("max-module-scc", 36)

const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: ROOT, onlyFiles: true })].map((p) => join(ROOT, p))
const fileSet = new Set(files)

function resolve(spec: string, fromAbs: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : join(fromAbs, "..", spec)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((c) => fileSet.has(c)) ?? null
}

function moduleOf(abs: string): string {
  const parts = relative(ROOT, abs).split("/")
  return parts.length === 1 ? "<root>" : parts[0]
}

function tarjan(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const sccs: string[][] = []
  const visit = (v: string) => {
    indices.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, indices.get(w)!))
    }
    if (low.get(v) !== indices.get(v)) return
    const comp: string[] = []
    let w: string
    do {
      w = stack.pop()!
      onStack.delete(w)
      comp.push(w)
    } while (w !== v)
    sccs.push(comp)
  }
  for (const n of nodes) if (!indices.has(n)) visit(n)
  return sccs.sort((a, b) => b.length - a.length)
}

// Static import/export-from and side-effect imports, plus dynamic import() and require, are all
// counted as ring edges. Excluding dynamic/require would let a static edge be "fake-unlinked" by
// rewriting it as a dynamic import, which is exactly the cheat the layering gate must catch.
const STATIC = [/(?:^|[^\w$])from\s+["']([^"']+)["']/g, /(?:^|\n)\s*import\s+["']([^"']+)["']/g] as const
const DYNAMIC = [/import\s*\(\s*["']([^"']+)["']\s*\)/g, /require\s*\(\s*["']([^"']+)["']\s*\)/g] as const

const fileAdj = new Map<string, Set<string>>()
const staticAdj = new Map<string, Set<string>>()
for (const f of files) {
  fileAdj.set(f, new Set())
  staticAdj.set(f, new Set())
}
const moduleAdj = new Map<string, Set<string>>()
const moduleEdgeCount = new Map<string, number>()
const moduleNodes = new Set<string>()
for (const f of files) moduleNodes.add(moduleOf(f))
let dynamicEdges = 0
let requireEdges = 0

for (const f of files) {
  const src = await Bun.file(f).text()
  const fromModule = moduleOf(f)
  const record = (spec: string, kind: "static" | "dynamic" | "require") => {
    const target = resolve(spec, f)
    if (!target || target === f) return
    if (kind === "dynamic") dynamicEdges++
    else if (kind === "require") requireEdges++
    fileAdj.get(f)!.add(target)
    if (kind === "static") staticAdj.get(f)!.add(target)
    const toModule = moduleOf(target)
    if (toModule === fromModule) return
    if (!moduleAdj.has(fromModule)) moduleAdj.set(fromModule, new Set())
    moduleAdj.get(fromModule)!.add(toModule)
    moduleNodes.add(toModule)
    const key = `${fromModule}->${toModule}`
    moduleEdgeCount.set(key, (moduleEdgeCount.get(key) ?? 0) + 1)
  }
  for (const re of STATIC) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) record(m[1], "static")
  }
  for (const re of DYNAMIC) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) record(m[1], re.source.startsWith("require") ? "require" : "dynamic")
  }
}

const fileSccs = tarjan(files, fileAdj)
const staticFileSccs = tarjan(files, staticAdj)
const moduleSccs = tarjan([...moduleNodes], moduleAdj)

const biggest = fileSccs[0] ?? []
const byModule = new Map<string, number>()
for (const f of biggest) byModule.set(moduleOf(f), (byModule.get(moduleOf(f)) ?? 0) + 1)
const distribution = [...byModule]
  .sort((a, b) => b[1] - a[1])
  .map(([m, n]) => `${m}:${n}`)
  .join(" ")

const moduleSccOf = new Map<string, number>()
moduleSccs.forEach((c, i) => c.forEach((n) => moduleSccOf.set(n, i)))
const ringEdges = [...moduleEdgeCount]
  .filter(([key]) => {
    const [a, b] = key.split("->")
    return moduleSccOf.get(a) === moduleSccOf.get(b)
  })
  .sort((a, b) => b[1] - a[1])

console.log(`file-level: max SCC = ${biggest.length} files (static-only ${staticFileSccs[0]?.length ?? 0}), SCCs>1 = ${fileSccs.filter((c) => c.length > 1).length}`)
console.log(`  by module: ${distribution}`)
console.log(`module-level: max SCC = ${moduleSccs[0]?.length ?? 0} modules, SCCs>1 = ${moduleSccs.filter((c) => c.length > 1).length}, cycle edges = ${ringEdges.length}`)
for (const c of moduleSccs.filter((c) => c.length > 1)) console.log(`  [${c.length}] ${JSON.stringify([...c].sort())}`)
for (const [key, n] of ringEdges.slice(0, 20)) console.log(`  edge ${key} [${n}]`)
console.log(`dynamic import edges: ${dynamicEdges}, require edges: ${requireEdges} (counted as ring edges; static-only SCC shown for reference)`)
console.log(`scanned ${files.length} files, ${moduleNodes.size} modules`)

const violations: string[] = []
if (biggest.length > maxFileScc) violations.push(`file-level max SCC ${biggest.length} > ${maxFileScc}`)
if ((moduleSccs[0]?.length ?? 0) > maxModuleScc) violations.push(`module-level max SCC ${moduleSccs[0]?.length ?? 0} > ${maxModuleScc}`)
if (violations.length) {
  console.error(`\nlayering gate FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}`)
  process.exit(1)
}
console.log(`\nlayering gate PASS (file <= ${maxFileScc}, module <= ${maxModuleScc})`)