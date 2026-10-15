import { join } from "path"

// Static gate for the construction-time serviceOption trap (see AGENTS.md ->
// "Construction-time serviceOption vs. test-harness wiring").
//
// Invariant: when `Effect.serviceOption(X.Service)` appears at the TOP LEVEL of a
// `Layer.effect` / `Layer.suspend` constructor body, it resolves at layer-construction
// time against that layer's own provide chain only — mergeAll siblings and app-level
// composition are invisible (empirically verified against effect 4.0.0-beta.83; a
// root-level `provideMerge` IS visible to member construction, but relying on it is
// fragile across compositions). Such a capture must either be backed by
// `Layer.provide(X.defaultLayer)` / `Layer.provide(X.layer)` somewhere in the same
// file's provide chain, or carry an explicit waiver pragma:
//
//   // service-wiring: optional <reason>
//
// on the serviceOption line or the line directly above it. Waivers are recorded in
// the report output so they stay visible.
//
// serviceOption inside nested closures (service methods, Effect.fn bodies, tool
// execute bodies) resolves at runtime against the caller's context and is safe —
// the scanner skips anything below the constructor body's top brace depth.
//
// Tokenizer-level scan: strings, template literals, comments, and regex literals are
// masked to spaces (newlines preserved so line numbers stay exact), then brace/paren
// depth is tracked inside each Layer constructor call region. No new dependencies.

function argText(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(hit.indexOf("=") + 1) : undefined
}

const ROOT = argText("root") ?? join(import.meta.dir, "..", "src")

const REGEX_ALLOWED_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">", ""])
const REGEX_ALLOWED_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"])

function regexAllowedBefore(masked: string[], i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(masked[j]!)) j--
  if (j < 0) return true
  const c = masked[j]!
  if (REGEX_ALLOWED_BEFORE.has(c)) return true
  if (!/[\w$]/.test(c)) return false
  let k = j
  while (k >= 0 && /[\w$]/.test(masked[k]!)) k--
  return REGEX_ALLOWED_KEYWORDS.has(masked.slice(k + 1, j + 1).join(""))
}

// Mask strings, template literals, comments, and regex literals to spaces, preserving
// length and newline positions so offsets map 1:1 back to the raw source lines.
function maskSource(src: string): string {
  const out: string[] = []
  const n = src.length
  let i = 0
  const blank = (len: number) => {
    for (let k = 0; k < len; k++) out.push(" ")
  }
  while (i < n) {
    const c = src[i]!
    if (c === "\n") {
      out.push("\n")
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ")
        i++
      }
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      blank(2)
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ")
        i++
      }
      if (i < n) {
        blank(2)
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out.push(" ")
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out.push(" ")
          out.push(src[i + 1] === "\n" ? "\n" : " ")
          i += 2
          continue
        }
        out.push(src[i] === "\n" ? "\n" : " ")
        i++
      }
      if (i < n) {
        out.push(" ")
        i++
      }
      continue
    }
    if (c === "/" && regexAllowedBefore(out, out.length)) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const rc = src[j]!
        if (rc === "\\") {
          j += 2
          continue
        }
        if (rc === "\n") break
        if (rc === "[") inClass = true
        else if (rc === "]") inClass = false
        else if (rc === "/" && !inClass) break
        j++
      }
      if (j < n && src[j] === "/") {
        blank(j + 1 - i)
        i = j + 1
        while (i < n && /[a-z]/.test(src[i]!)) i++
        continue
      }
    }
    out.push(c)
    i++
  }
  return out.join("")
}

type Capture = { file: string; line: number; arg: string; ns: string | null }

const SERVICE_OPTION = "serviceOption"
const LAYER_CALL = /Layer\.(effect|suspend)\(/g

function lineIndexOf(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// Collect construction-time (top-brace-depth) serviceOption captures inside one
// Layer.effect/Layer.suspend call region.
function scanRegion(masked: string, start: number, lineStarts: number[], file: string, sink: Capture[]) {
  const n = masked.length
  let paren = 1
  let brace = 0
  let bodyDepth = -1
  let i = start
  while (i < n && paren > 0) {
    const c = masked[i]!
    if (c === "(") paren++
    else if (c === ")") paren--
    else if (c === "{") {
      brace++
      if (bodyDepth < 0) bodyDepth = brace
    } else if (c === "}") brace--
    const topLevel = bodyDepth < 0 ? brace === 0 : brace === bodyDepth
    if (topLevel && c === "s" && masked.startsWith(SERVICE_OPTION, i)) {
      const before = i > 0 ? masked[i - 1]! : ""
      const after = masked[i + SERVICE_OPTION.length]
      if (!/[\w$]/.test(before) && after === "(") {
        let depth = 1
        let j = i + SERVICE_OPTION.length + 1
        const argStart = j
        while (j < n && depth > 0) {
          const ac = masked[j]!
          if (ac === "(") depth++
          else if (ac === ")") depth--
          j++
        }
        const arg = masked.slice(argStart, j - 1).trim()
        const m = /^([A-Za-z_$][\w$]*)\.Service$/.exec(arg)
        sink.push({ file, line: lineIndexOf(lineStarts, i), arg, ns: m ? m[1]! : arg === "Service" ? "" : null })
        i = j
        continue
      }
    }
    i++
  }
}

// A namespace counts as provided when the file mentions `X.defaultLayer` / `X.layer`
// (or bare `layer` / `defaultLayer` for a same-file Service) inside a provide/mergeAll
// statement: walk back from the token to the previous `;` and look for the combinator.
function providedInFile(masked: string, ns: string): boolean {
  const tokens = ns === "" ? ["layer", "defaultLayer"] : [`${ns}.defaultLayer`, `${ns}.layer`]
  return tokens.some((token) => {
    const re = new RegExp(`(^|[^\\w$.])${token.replace(".", "\\.")}(?![\\w$])`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const at = m.index + m[1]!.length
      const stmtStart = masked.lastIndexOf(";", at) + 1
      if (/(provideMerge|provide|mergeAll)\s*\(/.test(masked.slice(stmtStart, at))) return true
    }
    return false
  })
}

const PRAGMA = /\/\/\s*service-wiring:\s*optional\b[ \t]*(.*)$/

function pragmaReason(rawLines: string[], line: number): string | undefined {
  for (const candidate of [line - 1, line - 2]) {
    const text = candidate >= 0 ? rawLines[candidate] : undefined
    if (text === undefined) continue
    const m = PRAGMA.exec(text)
    if (m) return (m[1] ?? "").trim() || "(no reason given)"
  }
  return undefined
}

const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: ROOT, onlyFiles: true })].map((p) => join(ROOT, p))

const captures: Capture[] = []
// Per-file scan artifacts reused by the classification pass (masked text for the
// provide-chain search, raw lines for pragma lookup) so files are read exactly once.
const scanned = new Map<string, { masked: string; rawLines: string[] }>()
let regions = 0
for (const f of files) {
  const raw = await Bun.file(f).text()
  if (!raw.includes(SERVICE_OPTION) || !raw.includes("Layer.")) continue
  const masked = maskSource(raw)
  if (!masked.includes(SERVICE_OPTION)) continue
  const lineStarts = [0]
  for (let i = 0; i < masked.length; i++) if (masked[i] === "\n") lineStarts.push(i + 1)
  LAYER_CALL.lastIndex = 0
  let m: RegExpExecArray | null
  let found = false
  while ((m = LAYER_CALL.exec(masked)) !== null) {
    regions++
    const before = captures.length
    scanRegion(masked, m.index + m[0].length, lineStarts, f, captures)
    if (captures.length > before) found = true
  }
  if (found) scanned.set(f, { masked, rawLines: raw.split("\n") })
}

const rel = (f: string) => f.replace(`${ROOT}/`, "").replace(/\\/g, "/")
const violations: string[] = []
const waived: string[] = []
const provided: string[] = []
for (const cap of captures) {
  const entry = scanned.get(cap.file)!
  const reason = pragmaReason(entry.rawLines, cap.line)
  const label = `${rel(cap.file)}:${cap.line} serviceOption(${cap.arg})`
  if (reason !== undefined) {
    waived.push(`${label} — pragma: ${reason}`)
    continue
  }
  if (cap.ns !== null && providedInFile(entry.masked, cap.ns)) {
    provided.push(label)
    continue
  }
  violations.push(
    `${label}\n    captured at Layer constructor top level; it resolves at layer-construction time against\n    this layer's own provide chain only (mergeAll siblings are invisible). Either back it with\n    Layer.provide(${cap.ns ?? "<X>"}.defaultLayer) inside this file's own layer chain, or waive it with\n    // service-wiring: optional <reason> on the same or the previous line.`,
  )
}


console.log(`service-wiring: scanned ${files.length} files, ${regions} Layer.effect/Layer.suspend constructor region(s)`)
console.log(`construction-time serviceOption captures: ${captures.length} (provided ${provided.length}, waived ${waived.length}, violations ${violations.length})`)
for (const w of waived) console.log(`  waived: ${w}`)
for (const p of provided) console.log(`  provided: ${p}`)
if (violations.length > 0) {
  console.error(`\nservice-wiring gate FAILED:\n${violations.map((v) => `  - ${v}`).join("\n")}`)
  process.exit(1)
}
console.log(`\nservice-wiring gate PASS (${captures.length} construction-time capture(s) accounted for)`)
