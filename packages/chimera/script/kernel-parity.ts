#!/usr/bin/env bun
/**
 * Kernel↔wasm extraction parity harness — wave2 adoption guardrail
 * (UPSTREAM_RUST_KERNEL_PLAN.md §3 P0.3), ported from upstream codegraph
 * `scripts/kernel-parity.mjs` with fork-specific differences:
 *
 * - ORDER-SENSITIVE node table. Upstream diffs the tables as multisets with
 *   order only as a secondary check; the fork's flush-order semantics are
 *   load-bearing (interface/contract members are emitted AFTER same-file
 *   implementations and first-match-by-name consumers depend on that), so a
 *   node array that is multiset-equal but positionally divergent is a real
 *   behavioral diff here — it surfaces as `node:order-mismatch`.
 * - FULL-FIELD canonical rows: id/kind/name/qualifiedName/range/signature/
 *   docstring/returnType/params/visibility/flags (+ optional members), with
 *   unexpected extraJson-injected keys surfaced under an `x:` prefix. Timing
 *   fields are exempt: top-level durationMs and per-node updatedAt (both
 *   arms stamp `Date.now()`).
 * - Diff classification aggregated per language × pattern (missing/extra
 *   node, field drift, qn shape, edge metadata shape incl. valueRef, ref
 *   drift, order), TOP counts + N samples (file + expected=wasm / actual=kernel).
 * - The kernel arm goes through `tryKernelExtract` (routing forced on via
 *   CODEGRAPH_KERNEL_LANGS=all; rows decode through the kernel's own wire
 *   tables, kernelWireTables — exactly the production seam). The wasm arm
 *   is `extractFromSource` with CODEGRAPH_KERNEL=0. `defer:` files (parse
 *   errors / stack guard → legal wasm fallback) are counted separately and
 *   budget-guarded via --max-deferral (upstream posture: a broken kernel
 *   hiding behind its fallback must fail loudly).
 *
 * Known expected diffs for the P1 reconciliation checklist (reported, NOT
 * fixed — this harness is a pure consumer; see the report's knownExpectations):
 *   - tsjs `returnType` not emitted kernel-side (P0-2a smoke, confirmed)
 *   - `params` currently absent on BOTH arms (no kernel extraJson patch yet)
 *   - interface-member flush ORDER (kernel emits in source order)
 *   - value-reference exclusion-set details (ref missing/extra pairs)
 *   - `statement` nodes: kernel never emits them, fork wasm does — the
 *     largest expected item in the tsjs languages; per-language magnitude
 *     is single-column counted (statementNodesWasm).
 *
 * Usage:
 *   bun script/kernel-parity.ts [--lang <l[,l...]|all>] [--limit N]
 *       [--max-deferral <rate>] [--max-samples N] [--out <report.json>]
 *       [--list-files] [path...]
 *
 *   --limit: per-language file cap (default 200; 0 = unbounded).
 *   --max-deferral: deferral-rate budget across collected files (default
 *     0.1 — upstream posture). For macro-heavy C/C++ pass 0.5: erroring
 *     files defer BY POLICY at 10–40% real-world rates.
 *   Positional paths replace the built-in default corpus.
 *
 * Exit codes: 0 = byte-parity on everything attempted, 1 = diffs found,
 * 2 = deferral budget exceeded (kernel likely broken), 3 = setup error.
 *
 * Requires: a staged contract-verified kernel prebuild (the loader search
 * order finds <repo>/codegraph-kernel/prebuilds/<platform>-<arch>/). Run
 * from packages/chimera. Reads the repo only — never writes graph data.
 */

import * as fs from 'fs'
import * as path from 'path'
import { extractFromSource } from '../src/graph/extraction/tree-sitter'
import { detectLanguage, EXTENSION_MAP, initGrammars, loadGrammarsForLanguages } from '../src/graph/extraction/grammars'
import { getKernel, resetKernelRoutingForTests, tryKernelExtract, type KernelModule } from '../src/graph/extraction/kernel'
import type { Edge, ExtractionResult, Language, Node, UnresolvedReference } from '../src/graph/types'

const pkgRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')
const MIN_FILES_PER_LANGUAGE = 20
const MAX_FILE_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  langFilter: Set<Language> | null
  limit: number
  maxDeferral: number
  maxSamples: number
  out: string | null
  listFiles: boolean
  paths: string[]
}

function parseArgs(argv: string[]): Options | null {
  const options: Options = { langFilter: null, limit: 200, maxDeferral: 0.1, maxSamples: 3, out: null, listFiles: false, paths: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lang') {
      const value = argv[++i]
      if (!value) return null
      options.langFilter = value === 'all' ? null : new Set(value.split(',').map((s) => s.trim()) as Language[])
    } else if (arg === '--limit') {
      options.limit = Number(argv[++i])
    } else if (arg === '--max-deferral') {
      options.maxDeferral = Number(argv[++i])
    } else if (arg === '--max-samples') {
      options.maxSamples = Number(argv[++i])
    } else if (arg === '--out') {
      const value = argv[++i]
      if (!value) return null
      options.out = path.resolve(value)
    } else if (arg === '--list-files') {
      options.listFiles = true
    } else if (arg.startsWith('-')) {
      return null
    } else {
      options.paths.push(path.resolve(arg))
    }
  }
  if (!Number.isFinite(options.limit) || !Number.isFinite(options.maxDeferral)) return null
  return options
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface CorpusRoot {
  dir: string
  label: string
  /** Only files under a `fixture`-named directory (corpus ②: multi-language fixture files). */
  fixturesOnly?: boolean
}

interface Candidate {
  file: string
  rel: string
  /** Extension-mapped language, or 'detect' for ambiguous `.h` (resolved per file via detectLanguage, matching indexer routing). */
  extLang: Language | 'detect'
  root: string
}

/** Resolve a package inside the bun store (node_modules/.bun/<name-with-+>@<ver>/node_modules/<name>). */
function nodeModulesPackageRoot(name: string): string | null {
  const legacy = path.join(repoRoot, 'node_modules', name)
  if (fs.existsSync(legacy)) return legacy
  const store = path.join(repoRoot, 'node_modules', '.bun')
  try {
    const prefix = `${name.replace(/\//g, '+')}@`
    const hit = fs
      .readdirSync(store)
      .filter((d) => d.startsWith(prefix))
      .sort()[0]
    if (!hit) return null
    const inner = path.join(store, hit, 'node_modules', name)
    return fs.existsSync(inner) ? inner : null
  } catch {
    return null
  }
}

/** Corpus ③: representative read-only node_modules packages shipping real python/lua/c/cpp/js/go sources. */
const REPRESENTATIVE_PACKAGES = [
  'node-gyp',
  'bottleneck',
  'web-tree-sitter',
  '@parcel/watcher',
  'sharp',
  'tree-sitter-bash',
  'tree-sitter-powershell',
  'yoga-layout',
  'flatted',
]

function defaultCorpusRoots(): CorpusRoot[] {
  const packageRoots = REPRESENTATIVE_PACKAGES.flatMap((name) => {
    const dir = nodeModulesPackageRoot(name)
    return dir ? [{ dir, label: `node_modules/${name}` }] : []
  })
  return [
    { dir: path.join(pkgRoot, 'src'), label: 'packages/chimera/src' }, // corpus ①: main TS/TSX sample
    { dir: path.join(pkgRoot, 'test'), label: 'packages/chimera/test fixtures', fixturesOnly: true }, // corpus ②
    { dir: path.join(repoRoot, 'codegraph-kernel', 'src'), label: 'codegraph-kernel/src' }, // rust
    { dir: path.join(repoRoot, 'packages', 'newweb', 'src-tauri', 'gen', 'android'), label: 'newweb android' }, // kotlin
    ...packageRoots, // corpus ③
  ]
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'out', 'build', 'coverage',
  '.turbo', '.chimera', '.codegraph', '__snapshots__', 'snapshots', 'prebuilds',
])

function walk(dir: string, out: Candidate[], rootLabel: string, fixturesOnly: boolean, accepted: (lang: Language | 'detect') => boolean): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out, rootLabel, fixturesOnly, accepted)
      continue
    }
    if (!entry.isFile()) continue
    if (fixturesOnly && !full.toLowerCase().includes('fixture')) continue
    const lowerExt = path.extname(full).toLowerCase()
    const extLang = EXTENSION_MAP[lowerExt]
    if (!extLang || extLang === 'unknown') continue
    // `.h` is C, C++ or ObjC depending on CONTENT — the real indexer resolves
    // it per file via detectLanguage; mirror that instead of pre-deciding.
    const language: Language | 'detect' = lowerExt === '.h' ? 'detect' : extLang
    if (!accepted(language)) continue
    out.push({ file: full, rel: path.relative(repoRoot, full), extLang: language, root: rootLabel })
  }
}

// ---------------------------------------------------------------------------
// Canonicalization (timing fields exempt)
// ---------------------------------------------------------------------------

type CanonRow = Record<string, unknown>

/** Deterministic stringify: object keys sorted recursively, arrays stay ordered. */
function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const NODE_CORE_FIELDS = [
  'id', 'kind', 'name', 'qualifiedName', 'filePath', 'language',
  'startLine', 'endLine', 'startColumn', 'endColumn',
] as const
const NODE_OPTIONAL_FIELDS = [
  'docstring', 'signature', 'returnType', 'visibility',
  'isExported', 'isAsync', 'isStatic', 'isAbstract',
  'decorators', 'typeParameters', 'params',
] as const

function canonNode(n: Node): CanonRow {
  const src = n as unknown as Record<string, unknown>
  const out: CanonRow = {}
  for (const f of NODE_CORE_FIELDS) out[f] = src[f]
  for (const f of NODE_OPTIONAL_FIELDS) {
    const v = src[f]
    if (v !== undefined && v !== null) out[f] = v
  }
  // Unexpected keys (kernel extraJson Object.assign can inject these) — surface, don't smuggle.
  const known = new Set<string>([...NODE_CORE_FIELDS, ...NODE_OPTIONAL_FIELDS, 'updatedAt'])
  for (const key of Object.keys(src).sort()) {
    if (!known.has(key) && src[key] !== undefined && src[key] !== null) out[`x:${key}`] = src[key]
  }
  return out
}

function canonEdge(e: Edge): CanonRow {
  const src = e as unknown as Record<string, unknown>
  const out: CanonRow = { source: src.source, target: src.target, kind: src.kind }
  // FULL object on purpose: a field only one arm sets is a parity bug
  // (upstream lesson) — everything else visible rides under `x:`.
  const known = new Set<string>(['source', 'target', 'kind', 'line', 'column', 'provenance', 'metadata'])
  for (const key of Object.keys(src).sort()) {
    if (known.has(key) || src[key] === undefined) continue
    if (key === 'line' || key === 'column') {
      if (src[key] !== null) out[key] = src[key]
      continue
    }
    if (src[key] !== null) out[`x:${key}`] = src[key]
  }
  if (src.metadata !== undefined && src.metadata !== null) out.metadata = src.metadata
  return out
}

function canonRef(r: UnresolvedReference): CanonRow {
  const src = r as unknown as Record<string, unknown>
  const out: CanonRow = {
    fromNodeId: src.fromNodeId,
    referenceName: src.referenceName,
    referenceKind: src.referenceKind,
    line: src.line,
    column: src.column,
  }
  if (src.filePath !== undefined) out.filePath = src.filePath
  if (src.language !== undefined) out.language = src.language
  if (src.candidates !== undefined) out.candidates = src.candidates
  const known = new Set<string>([...Object.keys(out), 'id'])
  for (const key of Object.keys(src).sort()) {
    if (!known.has(key) && src[key] !== undefined) out[`x:${key}`] = src[key]
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-table diff classification
// ---------------------------------------------------------------------------

interface DiffSample {
  file: string
  /** wasm arm row (the reference behavior); absent for extra-in-kernel. */
  expected?: string
  /** kernel arm row; absent for missing-in-kernel. */
  actual?: string
}

type Reporter = (pattern: string, sample: DiffSample) => void

interface Row {
  obj: CanonRow
  canon: string
  /** Position in the arm's emitted array — order-sensitive pairing needs it. */
  index: number
}

function toRows<T>(items: T[], canon: (item: T) => CanonRow): Row[] {
  return items.map((item, index) => {
    const obj = canon(item)
    return { obj, canon: stableStringify(obj), index }
  })
}

function identityOf(row: Row, fields: string[]): string {
  return fields.map((f) => String(row.obj[f])).join('\u0000')
}

function diffFields(w: CanonRow, k: CanonRow): string[] {
  const keys = [...new Set([...Object.keys(w), ...Object.keys(k)])].sort()
  return keys.filter((key) => stableStringify(w[key]) !== stableStringify(k[key]))
}

interface TableDiffConfig {
  table: 'node' | 'edge' | 'ref'
  identityFields: string[]
  kindField: string
  file: string
  report: Reporter
  /** Per-drift-field pattern naming for a paired-but-different row. */
  driftPattern: (w: CanonRow, k: CanonRow, fields: string[]) => string[]
}

/** Returns the number of classified diff instances for this table. */
function diffTable(cfg: TableDiffConfig, wasm: Row[], kernel: Row[]): number {
  let orderedEqual = wasm.length === kernel.length
  if (orderedEqual) {
    for (let i = 0; i < wasm.length; i++) {
      if (wasm[i].canon !== kernel[i].canon) {
        orderedEqual = false
        break
      }
    }
  }
  if (orderedEqual) return 0

  const bucketize = (rows: Row[]) => {
    const buckets = new Map<string, Row[]>()
    for (const r of rows) {
      const key = identityOf(r, cfg.identityFields)
      const list = buckets.get(key)
      if (list) list.push(r)
      else buckets.set(key, [r])
    }
    return buckets
  }
  const wBuckets = bucketize(wasm)
  const kBuckets = bucketize(kernel)

  let instances = 0
  // Every identity-paired row records its ([wasmArrayIndex, kernelArrayIndex])
  // — including content-drifted pairs, so a flush-order divergence on rows
  // that ALSO drift (tsjs members carrying returnType/params drift) is still
  // visible; an identical-rows-only check would never pair them.
  const pairs: [number, number][] = []
  const pairedKeys = new Set<string>()
  for (const [key, wRows] of wBuckets) {
    const kRows = kBuckets.get(key)
    if (!kRows) {
      for (const w of wRows) {
        cfg.report(`${cfg.table}:missing-in-kernel:${String(w.obj[cfg.kindField])}`, { file: cfg.file, expected: w.canon })
        instances++
      }
      continue
    }
    pairedKeys.add(key)
    const paired = Math.min(wRows.length, kRows.length)
    for (let i = 0; i < paired; i++) {
      const w = wRows[i]
      const k = kRows[i]
      pairs.push([w.index, k.index])
      if (w.canon === k.canon) continue
      const fields = diffFields(w.obj, k.obj)
      const patterns = fields.length === 0 ? [`${cfg.table}:canon-mismatch-unattributed`] : cfg.driftPattern(w.obj, k.obj, fields)
      for (const pattern of patterns) {
        cfg.report(pattern, { file: cfg.file, expected: w.canon, actual: k.canon })
        instances++
      }
    }
    for (let i = paired; i < wRows.length; i++) {
      cfg.report(`${cfg.table}:missing-in-kernel:${String(wRows[i].obj[cfg.kindField])}`, { file: cfg.file, expected: wRows[i].canon })
      instances++
    }
    for (let i = paired; i < kRows.length; i++) {
      cfg.report(`${cfg.table}:extra-in-kernel:${String(kRows[i].obj[cfg.kindField])}`, { file: cfg.file, actual: kRows[i].canon })
      instances++
    }
  }
  for (const [key, kRows] of kBuckets) {
    if (pairedKeys.has(key)) continue
    for (const k of kRows) {
      cfg.report(`${cfg.table}:extra-in-kernel:${String(k.obj[cfg.kindField])}`, { file: cfg.file, actual: k.canon })
      instances++
    }
  }

  // Order check, independent of the content classification above: sort the
  // paired rows by their wasm position — the kernel positions must be
  // strictly increasing, or emission ORDER diverged (fork's flush-order
  // semantics: interface/contract members land after same-file
  // implementations and first-match-by-name consumers depend on it).
  pairs.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1]
    const cur = pairs[i]
    if (cur[1] < prev[1]) {
      const wLate = wasm[cur[0]]
      const kLate = kernel[cur[1]]
      cfg.report(`${cfg.table}:order-mismatch`, {
        file: cfg.file,
        expected: `#${prev[0]}/${cur[0]}: ${String(wLate.obj['name'] ?? wLate.obj['kind'] ?? '')} (${wLate.canon.slice(0, 160)})`,
        actual: `#${prev[1]}/${cur[1]}: ${String(kLate.obj['name'] ?? kLate.obj['kind'] ?? '')} (${kLate.canon.slice(0, 160)})`,
      })
      instances++
      break
    }
  }
  return instances
}

// Drift pattern namers ------------------------------------------------------------------

function nodeDriftPatterns(w: CanonRow, _k: CanonRow, fields: string[]): string[] {
  const kind = String(w.kind)
  const hasQn = fields.includes('qualifiedName')
  const patterns: string[] = []
  if (hasQn) patterns.push(`node:qn-shape:${kind}`)
  if (!hasQn && fields.includes('id')) patterns.push(`node:id-shape:${kind}`)
  for (const f of fields) {
    if (f === 'qualifiedName' || f === 'id') continue
    patterns.push(`node:field-drift:${kind}:${f}`)
  }
  return patterns
}

function metadataDiffKeys(w: CanonRow, k: CanonRow): string[] {
  const wm = (w.metadata ?? {}) as Record<string, unknown>
  const km = (k.metadata ?? {}) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(wm), ...Object.keys(km)])].sort()
  return keys.filter((key) => stableStringify(wm[key]) !== stableStringify(km[key]))
}

function edgeDriftPatterns(w: CanonRow, k: CanonRow, fields: string[]): string[] {
  const kind = String(w.kind)
  const patterns: string[] = []
  for (const f of fields) {
    if (f === 'metadata') {
      const keys = metadataDiffKeys(w, k)
      patterns.push(`edge:metadata-shape:${kind}:${keys.join('+') || 'presence'}`)
    } else if (f === 'line' || f === 'column') {
      if (!patterns.includes(`edge:position-drift:${kind}`)) patterns.push(`edge:position-drift:${kind}`)
    } else if (f === 'provenance') {
      patterns.push(`edge:provenance-drift:${kind}`)
    } else {
      patterns.push(`edge:field-drift:${kind}:${f}`)
    }
  }
  return patterns
}

function refDriftPatterns(w: CanonRow, _k: CanonRow, fields: string[]): string[] {
  const refKind = String(w.referenceKind)
  const patterns: string[] = []
  for (const f of fields) {
    if (f === 'fromNodeId') patterns.push(`ref:from-drift:${refKind}`)
    else patterns.push(`ref:field-drift:${refKind}:${f}`)
  }
  return patterns
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

interface PatternAggregate {
  count: number
  files: Set<string>
  samples: DiffSample[]
}

interface LangSummary {
  lang: Language
  files: number
  identical: number
  deferred: number
  kernelErrors: number
  diffFiles: number
  totals: { nodes: number; edges: number; refs: number }
  /** Magnitude of the expected statement-node gap: wasm-side statement nodes across non-deferred files. */
  statementNodesWasm: number
  sources: Record<string, number>
  patterns: { pattern: string; count: number; files: number; samples: DiffSample[] }[]
}

interface LangState {
  summary: LangSummary
  aggregates: Map<string, PatternAggregate>
}

function makeLangState(lang: Language): LangState {
  return {
    summary: {
      lang,
      files: 0,
      identical: 0,
      deferred: 0,
      kernelErrors: 0,
      diffFiles: 0,
      totals: { nodes: 0, edges: 0, refs: 0 },
      statementNodesWasm: 0,
      sources: {},
      patterns: [],
    },
    aggregates: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Null classification
// ---------------------------------------------------------------------------

/**
 * `tryKernelExtract` nulls are either the legal `defer:` routing (parse-tree
 * ERROR / stack guard → wasm is the canonical recovery path) or a kernel
 * error (warned-once, silently nulled). Classify by re-asking the binary —
 * `extractFile` throws the same signal and never touches the defer memo,
 * and this re-parse runs only for the null subset.
 */
function classifyKernelNull(kernel: KernelModule, file: string, source: string, lang: Language): 'defer' | 'error' | 'unexpected-null' {
  try {
    kernel.extractFile(file, source, lang)
    return 'unexpected-null' // parsed fine yet the routed seam said null — flag loudly
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return message.includes('defer:') ? 'defer' : 'error'
  }
}

function diffErrorArrays(wasm: ExtractionResult, kernel: ExtractionResult): { wasm: number; kernel: number } | null {
  return wasm.errors.length === kernel.errors.length ? null : { wasm: wasm.errors.length, kernel: kernel.errors.length }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run(options: Options, kernel: KernelModule): void {
  const kernelLanguages = new Set(kernel.contractInfo().languages as Language[])

  // Both arms in one process: the kernel arm needs routing forced on (the
  // wasm arm flips the per-call kill switch around its extractFromSource).
  process.env.CODEGRAPH_KERNEL_LANGS = 'all'
  resetKernelRoutingForTests()

  const accepted = (lang: Language | 'detect'): boolean => {
    if (lang === 'detect') return kernelLanguages.has('c') || kernelLanguages.has('cpp')
    if (!kernelLanguages.has(lang)) return false
    return options.langFilter === null || options.langFilter.has(lang)
  }

  // --- collect (deterministic: roots fixed-order, dirs name-sorted) ---
  const roots: CorpusRoot[] =
    options.paths.length > 0
      ? options.paths.map((p) => ({ dir: p, label: path.relative(repoRoot, p) || '.' }))
      : defaultCorpusRoots()
  const collected: Candidate[] = []
  const candidateFromFile = (file: string, rootLabel: string): Candidate | null => {
    const lowerExt = path.extname(file).toLowerCase()
    const extLang = EXTENSION_MAP[lowerExt]
    if (!extLang || extLang === 'unknown') return null
    const language: Language | 'detect' = lowerExt === '.h' ? 'detect' : extLang
    if (!accepted(language)) return null
    return { file, rel: path.relative(repoRoot, file), extLang: language, root: rootLabel }
  }
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue
    if (fs.statSync(root.dir).isFile()) {
      const single = candidateFromFile(root.dir, root.label)
      if (single) collected.push(single)
      continue
    }
    walk(root.dir, collected, root.label, root.fixturesOnly === true, accepted)
  }
  const perLangCount = new Map<Language | 'detect', number>()
  const candidates: Candidate[] = []
  for (const candidate of collected) {
    const bucket = candidate.extLang
    const count = perLangCount.get(bucket) ?? 0
    if (options.limit > 0 && bucket !== 'detect' && count >= options.limit) continue
    perLangCount.set(bucket, count + 1)
    candidates.push(candidate)
  }

  // --- dual-arm pass ---
  const states = new Map<Language, LangState>()
  for (const lang of kernelLanguages) states.set(lang, makeLangState(lang))

  for (const candidate of candidates) {
    let source: string
    try {
      const stat = fs.statSync(candidate.file)
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
      source = fs.readFileSync(candidate.file, 'utf8')
    } catch {
      continue // dangling symlink / unreadable — skip
    }
    if (source.includes('\u0000')) continue // binary guard

    const lang = candidate.extLang === 'detect' ? detectLanguage(candidate.rel, source) : candidate.extLang
    if (options.langFilter && !options.langFilter.has(lang)) continue // .h resolved to c/cpp/objc after content sniff
    const state = states.get(lang)
    if (!state) continue // objc/pascal/... not kernel-capable after content detection
    if (options.limit > 0 && state.summary.files >= options.limit) continue
    const { summary, aggregates } = state
    summary.files++
    summary.sources[candidate.root] = (summary.sources[candidate.root] ?? 0) + 1

    const report: Reporter = (pattern, sample) => {
      let agg = aggregates.get(pattern)
      if (!agg) aggregates.set(pattern, (agg = { count: 0, files: new Set(), samples: [] }))
      agg.count++
      agg.files.add(sample.file)
      if (agg.samples.length < options.maxSamples) agg.samples.push(sample)
    }

    const kernelResult = tryKernelExtract(candidate.rel, source, lang)
    if (!kernelResult) {
      const cls = classifyKernelNull(kernel, candidate.rel, source, lang)
      if (cls === 'defer') summary.deferred++
      else {
        summary.kernelErrors++
        report(cls === 'error' ? 'kernel:error-fallback' : 'kernel:unexpected-null', { file: candidate.rel })
      }
      continue // deferred files are excluded from the diff by design (upstream posture)
    }

    process.env.CODEGRAPH_KERNEL = '0' // wasm arm — the kill switch makes extractFromSource's internal selector fall through
    const wasmResult = extractFromSource(candidate.rel, source, lang)
    delete process.env.CODEGRAPH_KERNEL

    summary.totals.nodes += wasmResult.nodes.length
    summary.totals.edges += wasmResult.edges.length
    summary.totals.refs += wasmResult.unresolvedReferences.length
    summary.statementNodesWasm += wasmResult.nodes.reduce((acc, n) => (n.kind === 'statement' ? acc + 1 : acc), 0)

    let instances = 0
    instances += diffTable(
      { table: 'node', identityFields: ['kind', 'name', 'startLine', 'startColumn'], kindField: 'kind', file: candidate.rel, report, driftPattern: nodeDriftPatterns },
      toRows(wasmResult.nodes, canonNode),
      toRows(kernelResult.nodes, canonNode)
    )
    instances += diffTable(
      { table: 'edge', identityFields: ['kind', 'source', 'target'], kindField: 'kind', file: candidate.rel, report, driftPattern: edgeDriftPatterns },
      toRows(wasmResult.edges, canonEdge),
      toRows(kernelResult.edges, canonEdge)
    )
    instances += diffTable(
      { table: 'ref', identityFields: ['referenceKind', 'referenceName', 'line', 'column'], kindField: 'referenceKind', file: candidate.rel, report, driftPattern: refDriftPatterns },
      toRows(wasmResult.unresolvedReferences, canonRef),
      toRows(kernelResult.unresolvedReferences, canonRef)
    )
    const errorDrift = diffErrorArrays(wasmResult, kernelResult)
    if (errorDrift) {
      report('errors:count-shape-drift', { file: candidate.rel, expected: `errors=${errorDrift.wasm}`, actual: `errors=${errorDrift.kernel}` })
      instances++
    }

    if (instances > 0) {
      summary.diffFiles++
      if (options.listFiles) console.log(`DIFF ${candidate.rel}`)
    } else {
      summary.identical++
    }
  }

  for (const state of states.values()) {
    state.summary.patterns = [...state.aggregates.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([pattern, agg]) => ({ pattern, count: agg.count, files: agg.files.size, samples: agg.samples }))
  }

  printAndFinish(options, kernel, states, candidates.length)
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface CorpusEntry {
  files: number
  minimum: number
  short: boolean
  sources: Record<string, number>
}

interface ReportJson {
  schemaVersion: 1
  generatedAt: string
  kernelVersion: string
  kernelLanguages: string[]
  options: { limit: number; maxDeferral: number; maxSamples: number; langFilter: string[] | null }
  corpus: Record<string, CorpusEntry>
  languages: LangSummary[]
  totals: { files: number; identical: number; deferred: number; kernelErrors: number; diffFiles: number }
  knownExpectations: Record<string, number | string>
  exit: { code: number; reasons: string[] }
}

function truncate(s: string | undefined, n = 300): string {
  if (s === undefined) return '<absent>'
  return s.length > n ? `${s.slice(0, n)}...` : s
}

function printAndFinish(options: Options, kernel: KernelModule, states: Map<Language, LangState>, collectedCount: number): void {
  const langs = [...states.values()]
    .map((s) => s.summary)
    .filter((l) => options.langFilter === null || options.langFilter.has(l.lang))
    .sort((a, b) => (a.lang < b.lang ? -1 : 1))
  const totals = langs.reduce(
    (acc, l) => {
      acc.files += l.files
      acc.identical += l.identical
      acc.deferred += l.deferred
      acc.kernelErrors += l.kernelErrors
      acc.diffFiles += l.diffFiles
      return acc
    },
    { files: 0, identical: 0, deferred: 0, kernelErrors: 0, diffFiles: 0 }
  )

  const corpus: Record<string, CorpusEntry> = {}
  const shortLanguages: string[] = []
  for (const l of langs) {
    const entry: CorpusEntry = { files: l.files, minimum: MIN_FILES_PER_LANGUAGE, short: l.files < MIN_FILES_PER_LANGUAGE, sources: l.sources }
    corpus[l.lang] = entry
    if (entry.short) shortLanguages.push(`${l.lang}(${l.files})`)
  }

  // Known expected diffs (plan §3 P0.3 inputs) — machine-checkable cross-summary.
  const sumWhere = (pred: (p: { pattern: string; count: number }) => boolean): number =>
    langs.reduce((acc, l) => acc + l.patterns.filter(pred).reduce((a, p) => a + p.count, 0), 0)
  const tsjsLangs = new Set<Language>(['typescript', 'tsx', 'javascript', 'jsx'])
  const knownExpectations: ReportJson['knownExpectations'] = {
    returnTypeFieldDrift_total: sumWhere((p) => p.pattern.endsWith(':returnType')),
    returnTypeFieldDrift_tsjs: langs
      .filter((l) => tsjsLangs.has(l.lang))
      .reduce((acc, l) => acc + l.patterns.filter((p) => p.pattern.endsWith(':returnType')).reduce((a, p) => a + p.count, 0), 0),
    paramsFieldDrift_total_expect0: sumWhere((p) => p.pattern.endsWith(':params')),
    qnShape_total: sumWhere((p) => p.pattern.startsWith('node:qn-shape')),
    idShape_total: sumWhere((p) => p.pattern.startsWith('node:id-shape')),
    nodeOrderMismatch_total: sumWhere((p) => p.pattern === 'node:order-mismatch'),
    statementNodesWasm_total: langs.reduce((acc, l) => acc + l.statementNodesWasm, 0),
    statementMissingInKernel_total: sumWhere((p) => p.pattern === 'node:missing-in-kernel:statement'),
    refMissing_total: sumWhere((p) => p.pattern.startsWith('ref:missing-in-kernel')),
    refExtra_total: sumWhere((p) => p.pattern.startsWith('ref:extra-in-kernel')),
    edgeMetadataShape_total: sumWhere((p) => p.pattern.startsWith('edge:metadata-shape')),
  }

  const attempted = totals.files - totals.deferred - totals.kernelErrors
  const deferralRate = totals.deferred / Math.max(totals.files, 1)
  const reasons: string[] = []
  let code = 0
  if (deferralRate > options.maxDeferral && totals.files > 0) {
    code = 2
    reasons.push(`deferral rate ${(deferralRate * 100).toFixed(1)}% exceeds budget ${(options.maxDeferral * 100).toFixed(0)}% — kernel likely broken`)
  }
  if (totals.diffFiles > 0) {
    if (code !== 2) code = 1
    reasons.push(`${totals.diffFiles} file(s) with extraction diffs`)
  }
  if (shortLanguages.length > 0) reasons.push(`corpus short (<${MIN_FILES_PER_LANGUAGE} files): ${shortLanguages.join(' ')}`)

  const report: ReportJson = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kernelVersion: kernel.contractInfo().kernelVersion,
    kernelLanguages: kernel.contractInfo().languages,
    options: {
      limit: options.limit,
      maxDeferral: options.maxDeferral,
      maxSamples: options.maxSamples,
      langFilter: options.langFilter ? [...options.langFilter] : null,
    },
    corpus,
    languages: langs,
    totals,
    knownExpectations,
    exit: { code, reasons },
  }

  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true })
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report JSON: ${options.out}`)
  }

  console.log(
    `\n=== kernel parity: ${totals.identical}/${totals.files} files byte-parity (${totals.diffFiles} with diffs, ${totals.deferred} deferred-to-wasm, ${totals.kernelErrors} kernel errors; ${attempted} diffed) | kernel ${report.kernelVersion} | ${collectedCount} corpus candidates ===\n`
  )
  console.log('lang           files   same   diff  defer    err   stmt(wasm)   n/e/r        TOP patterns')
  for (const l of langs) {
    const mark = corpus[l.lang].short ? '*' : ' '
    const top = l.patterns
      .slice(0, 5)
      .map((p) => `${p.pattern}(${p.count}/${p.files}f)`)
      .join(', ')
    console.log(
      `${(l.lang + mark).padEnd(15)} ${String(l.files).padStart(5)}  ${String(l.identical).padStart(5)}  ${String(l.diffFiles).padStart(5)}  ${String(l.deferred).padStart(5)}  ${String(l.kernelErrors).padStart(5)}  ${String(l.statementNodesWasm).padStart(9)}  ${(l.totals.nodes + '/' + l.totals.edges + '/' + l.totals.refs).padStart(12)}  ${top || '—'}`
    )
  }
  if (shortLanguages.length > 0) console.log(`\n* corpus short (<${MIN_FILES_PER_LANGUAGE} files usable in-repo): ${shortLanguages.join(' ')}`)

  console.log('\n--- sample detail (top 5 patterns per language) ---')
  for (const l of langs) {
    if (l.patterns.length === 0) continue
    console.log(`\n[${l.lang}]`)
    for (const p of l.patterns.slice(0, 5)) {
      console.log(`  ${p.pattern}: ${p.count} across ${p.files} file(s)`)
      for (const s of p.samples.slice(0, options.maxSamples)) {
        console.log(`      ${s.file}`)
        if (s.expected !== undefined) console.log(`        expected(wasm): ${truncate(s.expected)}`)
        if (s.actual !== undefined) console.log(`        actual(kernel):  ${truncate(s.actual)}`)
      }
    }
  }
  console.log(`\nknown-expectations cross-check: ${JSON.stringify(knownExpectations, null, 0)}`)
  console.log(`deferral rate: ${(deferralRate * 100).toFixed(1)}% (budget ${(options.maxDeferral * 100).toFixed(0)}%)`)
  if (collectedCount === 0) console.error('no matching files in corpus')
  console.log(reasons.length > 0 ? `exit ${code}: ${reasons.join('; ')}` : `exit ${code}: clean`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Bootstrap: web-tree-sitter init is async (top-level await — bun/node TLA).
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2))
if (!options) {
  console.error('usage: bun script/kernel-parity.ts [--lang l[,...]|all] [--limit N] [--max-deferral R] [--max-samples N] [--out file.json] [--list-files] [path...]')
  process.exit(3)
}
const bootKernel = getKernel()
if (!bootKernel) {
  console.error('kernel .node not found or contract-unverified — stage it via packages/chimera/script/build-kernel.sh (CODEGRAPH_KERNEL_DEBUG=1 shows why the loader refused)')
  process.exit(3)
}
await initGrammars()
await loadGrammarsForLanguages([...(bootKernel.contractInfo().languages as Language[])])
run(options, bootKernel)
