import ts from "typescript"
import { join, relative } from "path"

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(hit.indexOf("=") + 1)) : fallback
}

function argText(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(hit.indexOf("=") + 1) : undefined
}

const ROOT = argText("root") ?? join(import.meta.dir, "..", "src")
const PKG = join(ROOT, "..")

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

// Ring edges are value edges only: a type-only import/export creates no runtime dependency and
// cannot form a runtime cycle, so it must not be counted (the old regex counted `import type`).
// A statement is a value edge iff at least one imported binding has a value use (value-position
// reference, instanceof, new, namespace value access such as NS.member, or a runtime schema value
// such as Schema.Struct({ f: SessionID })). Excluded type edges are: whole `import type`, an
// all-`type` named specifier list, a `export type ... from`, and a plain import whose referenced
// bindings are only ever used in type positions. A plain import whose bindings are never
// referenced at all is kept as a ring edge (dead code, not a type-only dependency; dropping its
// uses must not "fake-unlink" a real runtime import). Judging this needs real symbol identity
// (name shadowing, namespace access, heritage clauses), which a regex cannot do — we use the
// TypeScript checker over one program for all files (measured ~7s for the full repo, well under
// the 30s budget) rather than a per-file text scan. Edges are deduplicated per (from, to) pair, so
// the type-edge statistics count distinct type edges, not import statements.
//
// Dynamic import() and require stay counted as ring edges, unconditionally. Excluding them would
// let a static edge be "fake-unlinked" by rewriting it as a dynamic import, which is exactly the
// cheat the layering gate must catch. That discipline is unchanged.
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  baseUrl: PKG,
  paths: { "@/*": [join(ROOT, "*")] },
  skipLibCheck: true,
  noEmit: true,
  types: [],
})
const checker = program.getTypeChecker()
// TypeScript does not export this predicate in its public .d.ts, but it is the precise helper for
// "is this reference a valid type-only use site" (handles heritage clauses, type arguments, etc.).
// Fall back to "always a value use" so an API change only makes the gate more conservative.
const isValidTypeOnlyAliasUseSite: (node: ts.Node) => boolean =
  (ts as unknown as { isValidTypeOnlyAliasUseSite?: (node: ts.Node) => boolean }).isValidTypeOnlyAliasUseSite ?? (() => false)

type EdgeInfo = { value: boolean; explicit: boolean; convertible: boolean; unused: boolean; kinds: Set<string> }
const graph = new Map<string, Map<string, EdgeInfo>>()
for (const f of files) graph.set(f, new Map())

function edgeInfo(from: string, to: string): EdgeInfo {
  const map = graph.get(from)!
  const existing = map.get(to)
  if (existing) return existing
  const created: EdgeInfo = { value: false, explicit: false, convertible: false, unused: false, kinds: new Set() }
  map.set(to, created)
  return created
}

let dynamicEdges = 0
let requireEdges = 0

for (const f of files) {
  const sf = program.getSourceFile(f)
  if (!sf) continue

  const idsByText = new Map<string, ts.Identifier[]>()
  const collect = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const list = idsByText.get(n.text)
      if (list) list.push(n)
      else idsByText.set(n.text, [n])
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)

  // Classify a binding by whether any same-symbol reference in this file is a value use.
  const classify = (name: ts.Identifier): "value" | "type" | "unused" => {
    const sym = checker.getSymbolAtLocation(name)
    if (!sym) return "unused"
    let saw = false
    let value = false
    for (const id of idsByText.get(name.text) ?? []) {
      if (id === name) continue
      if (checker.getSymbolAtLocation(id) !== sym) continue
      saw = true
      if (!isValidTypeOnlyAliasUseSite(id)) value = true
    }
    if (!saw) return "unused"
    return value ? "value" : "type"
  }

  const link = (spec: string, kind: "import" | "export" | "dynamic" | "require") => {
    const to = resolve(spec, f)
    if (!to || to === f) return null
    if (kind === "dynamic") dynamicEdges++
    else if (kind === "require") requireEdges++
    const e = edgeInfo(f, to)
    e.kinds.add(kind)
    return e
  }

  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const e = link(n.moduleSpecifier.text, "import")
      if (!e) return
      if (!n.importClause) {
        e.value = true // side-effect import: a runtime dependency
        return
      }
      if (n.importClause.isTypeOnly) {
        e.explicit = true
        return
      }
      const bindings: ts.Identifier[] = []
      let sawExplicitSpecType = false
      if (n.importClause.name) bindings.push(n.importClause.name)
      const nb = n.importClause.namedBindings
      if (nb) {
        if (ts.isNamespaceImport(nb)) bindings.push(nb.name)
        else
          for (const el of nb.elements) {
            if (el.isTypeOnly) {
              sawExplicitSpecType = true
              continue
            }
            bindings.push(el.name)
          }
      }
      for (const b of bindings) {
        const c = classify(b)
        if (c === "value") e.value = true
        else if (c === "type") e.convertible = true
        else e.unused = true
      }
      if (sawExplicitSpecType && !e.value) e.explicit = true
      return
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const e = link(n.moduleSpecifier.text, "export")
      if (!e) return
      if (n.isTypeOnly) {
        e.explicit = true
        return
      }
      if (n.exportClause && ts.isNamedExports(n.exportClause)) {
        if (n.exportClause.elements.length > 0 && n.exportClause.elements.every((el) => el.isTypeOnly)) e.explicit = true
        else e.value = true
        return
      }
      e.value = true // export * from: a runtime re-export
    }
  })

  const scanDynamic = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const isDynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require"
      if ((isDynamic || isRequire) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
        const e = link(n.arguments[0].text, isRequire ? "require" : "dynamic")
        if (e) e.value = true
      }
    }
    ts.forEachChild(n, scanDynamic)
  }
  scanDynamic(sf)
}

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
let explicitTypeEdges = 0
let convertibleTypeEdges = 0
let unusedRingEdges = 0

// A type edge is excluded from ring edges when it is syntactically type-only (`import type`, an
// all-`type` specifier list, `export type`) or when every referenced binding is used only in type
// positions. A plain import whose bindings are never referenced at all is NOT treated as a type
// edge: it is dead code, not a type-only dependency, and keeping it counted stops a real runtime
// import from being "fake-unlinked" just by dropping its uses.
for (const [from, map] of graph) {
  const fromModule = moduleOf(from)
  for (const [to, e] of map) {
    const typeEdge = !e.value && (e.explicit || e.convertible)
    if (typeEdge) {
      if (e.explicit) explicitTypeEdges++
      if (e.convertible) convertibleTypeEdges++
      continue
    }
    if (!e.value && e.unused) unusedRingEdges++
    fileAdj.get(from)!.add(to)
    if (e.kinds.has("import") || e.kinds.has("export")) staticAdj.get(from)!.add(to)
    const toModule = moduleOf(to)
    if (toModule !== fromModule) {
      if (!moduleAdj.has(fromModule)) moduleAdj.set(fromModule, new Set())
      moduleAdj.get(fromModule)!.add(toModule)
      moduleNodes.add(toModule)
      const key = `${fromModule}->${toModule}`
      moduleEdgeCount.set(key, (moduleEdgeCount.get(key) ?? 0) + 1)
    }
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
const typeEdges = explicitTypeEdges + convertibleTypeEdges
console.log(`type-only edges excluded from ring edges: ${typeEdges} (import/export type ${explicitTypeEdges}, type-position-only ${convertibleTypeEdges}); unused-import edges kept as ring edges: ${unusedRingEdges}`)
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