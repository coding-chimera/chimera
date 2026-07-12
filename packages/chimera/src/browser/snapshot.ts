export * as BrowserSnapshot from "./snapshot"

export const DEFAULT_MAX_CHARS = 40_000
export const EFFICIENT_MAX_CHARS = 8_000
export const EFFICIENT_DEPTH = 6
export const UNTRUSTED_MARKER = "[UNTRUSTED BROWSER CONTENT]"
export const TRUNCATION_MARKER = "[snapshot truncated]"
export const MIN_MAX_CHARS = UNTRUSTED_MARKER.length + TRUNCATION_MARKER.length + 1
export const REDACTED = "[REDACTED]"

export type ToggleState = boolean | "mixed"

export interface Node {
  readonly id: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly description?: string
  readonly interactive: boolean
  readonly sensitive?: boolean
  readonly disabled?: boolean
  readonly checked?: ToggleState
  readonly expanded?: boolean
  readonly selected?: boolean
  readonly pressed?: ToggleState
  readonly children?: readonly Node[]
}

export interface Input {
  readonly url: string
  readonly roots: readonly Node[]
}

export interface Options {
  readonly preset?: "efficient"
  readonly interactive?: boolean
  readonly compact?: boolean
  readonly depth?: number
  readonly maxChars?: number
}

export interface ResolvedOptions {
  readonly interactive: boolean
  readonly compact: boolean
  readonly depth: number
  readonly maxChars: number
}

export interface Target {
  readonly id: string
  readonly role: string
  readonly name?: string
  readonly nth?: number
}

export interface Trust {
  readonly source: "browser"
  readonly untrusted: true
  readonly url: string
  readonly origin: string
}

export interface Result {
  readonly text: string
  readonly refs: ReadonlyMap<string, Target>
  readonly truncated: boolean
  readonly omittedLines: number
  readonly trust: Trust
}

type DuplicateInfo = {
  readonly totals: ReadonlyMap<string, number>
  readonly occurrences: ReadonlyMap<Node, number>
}

type Line = {
  readonly text: string
  readonly ref?: string
  readonly target?: Target
}

const STRUCTURAL_ROLES = new Set([
  "document",
  "generic",
  "group",
  "region",
  "section",
  "list",
  "listitem",
  "presentation",
  "none",
])

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "passcode",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "cookie",
  "set_cookie",
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "session_id",
])

export function resolveOptions(options: Options = {}): ResolvedOptions {
  const efficient = options.preset === "efficient"
  const resolved = {
    interactive: options.interactive ?? efficient,
    compact: options.compact ?? efficient,
    depth: options.depth ?? (efficient ? EFFICIENT_DEPTH : Number.POSITIVE_INFINITY),
    maxChars: options.maxChars ?? (efficient ? EFFICIENT_MAX_CHARS : DEFAULT_MAX_CHARS),
  }
  if (!Number.isInteger(resolved.depth) && resolved.depth !== Number.POSITIVE_INFINITY)
    throw new RangeError("Browser snapshot depth must be a non-negative integer")
  if (resolved.depth < 0) throw new RangeError("Browser snapshot depth must be a non-negative integer")
  if (!Number.isInteger(resolved.maxChars) || resolved.maxChars < MIN_MAX_CHARS)
    throw new RangeError(`Browser snapshot maxChars must be an integer greater than or equal to ${MIN_MAX_CHARS}`)
  return resolved
}

export function render(input: Input, options: Options = {}): Result {
  const resolved = resolveOptions(options)
  const duplicate = duplicateInfo(input.roots)
  const lines: Line[] = [{ text: UNTRUSTED_MARKER }]
  let nextRef = 1

  const visit = (node: Node, sourceDepth: number, indent: number) => {
    if (sourceDepth > resolved.depth) return
    const role = normalizeRole(node.role)
    const name = normalizeText(node.name)
    const hiddenStructure = !node.interactive && !name && STRUCTURAL_ROLES.has(role)
    const hiddenByMode = resolved.interactive && !node.interactive
    if (hiddenStructure || hiddenByMode) {
      node.children?.forEach((child) => visit(child, sourceDepth + 1, indent))
      return
    }

    const collisionKey = name ? identityKey(role, name) : undefined
    const nth = collisionKey && (duplicate.totals.get(collisionKey) ?? 0) > 1 ? duplicate.occurrences.get(node) : undefined
    const ref = node.interactive ? `e${nextRef++}` : undefined
    const target = ref
      ? {
          id: node.id,
          role,
          ...(name ? { name } : {}),
          ...(nth === undefined ? {} : { nth }),
        }
      : undefined
    lines.push({
      text: formatLine(node, role, name, indent, resolved.compact, ref, nth),
      ...(ref ? { ref } : {}),
      ...(target ? { target } : {}),
    })
    node.children?.forEach((child) => visit(child, sourceDepth + 1, indent + 1))
  }

  input.roots.forEach((node) => visit(node, 0, 0))
  return finalize(lines, resolved.maxChars, sanitizeUrl(input.url))
}

function duplicateInfo(roots: readonly Node[]): DuplicateInfo {
  const totals = new Map<string, number>()
  const occurrences = new Map<Node, number>()
  const visit = (node: Node) => {
    const name = normalizeText(node.name)
    if (name) {
      const key = identityKey(normalizeRole(node.role), name)
      const occurrence = (totals.get(key) ?? 0) + 1
      occurrences.set(node, occurrence)
      totals.set(key, occurrence)
    }
    node.children?.forEach(visit)
  }
  roots.forEach(visit)
  return { totals, occurrences }
}

function formatLine(
  node: Node,
  role: string,
  name: string | undefined,
  indent: number,
  compact: boolean,
  ref: string | undefined,
  nth: number | undefined,
) {
  const sensitive = isSensitive(node, role, name)
  const attributes = [
    name ? `"${escapeText(name)}"` : undefined,
    attribute("value", node.value, sensitive),
    compact ? undefined : attribute("description", node.description, sensitive),
    stateAttribute("checked", node.checked, compact),
    stateAttribute("pressed", node.pressed, compact),
    stateAttribute("expanded", node.expanded, compact),
    stateAttribute("selected", node.selected, compact),
    stateAttribute("disabled", node.disabled, compact),
    ref ? `[ref=${ref}]` : undefined,
    nth === undefined ? undefined : `[nth=${nth}]`,
  ].filter((value): value is string => value !== undefined)
  return `${"  ".repeat(indent)}${role}${attributes.length ? ` ${attributes.join(" ")}` : ""}`
}

function attribute(name: string, value: string | undefined, sensitive: boolean) {
  if (!value) return undefined
  return `${name}="${sensitive ? REDACTED : escapeText(value)}"`
}

function stateAttribute(name: string, value: ToggleState | undefined, compact: boolean) {
  if (value === undefined || (compact && value === false)) return undefined
  return `[${name}=${value}]`
}

function finalize(lines: readonly Line[], maxChars: number, trust: Trust): Result {
  const full = lines.map((line) => line.text).join("\n")
  if (full.length <= maxChars)
    return {
      text: full,
      refs: refsFrom(lines),
      truncated: false,
      omittedLines: 0,
      trust,
    }

  const visible: Line[] = []
  let used = 0
  for (const line of lines) {
    const added = line.text.length + (visible.length ? 1 : 0)
    if (used + added + TRUNCATION_MARKER.length + 1 > maxChars) break
    visible.push(line)
    used += added
  }
  return {
    text: [...visible.map((line) => line.text), TRUNCATION_MARKER].join("\n"),
    refs: refsFrom(visible),
    truncated: true,
    omittedLines: lines.length - visible.length,
    trust,
  }
}

function refsFrom(lines: readonly Line[]) {
  return new Map(
    lines.flatMap((line) => (line.ref && line.target ? ([[line.ref, line.target]] as const) : [])),
  )
}

function sanitizeUrl(value: string): Trust {
  if (!URL.canParse(value))
    return {
      source: "browser",
      untrusted: true,
      url: sanitizeInvalidUrl(value),
      origin: "",
    }
  const url = new URL(value)
  url.username = ""
  url.password = ""
  url.hash = ""
  Array.from(url.searchParams.keys()).forEach((key) => {
    if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED)
  })
  return {
    source: "browser",
    untrusted: true,
    url: url.toString(),
    origin: url.origin,
  }
}

function sanitizeInvalidUrl(value: string) {
  const withoutCredentials = value.replace(/\/\/[^/@\s]+@/, "//")
  const withoutFragment = withoutCredentials.split("#", 1)[0] ?? ""
  const queryIndex = withoutFragment.indexOf("?")
  if (queryIndex === -1) return withoutFragment
  const base = withoutFragment.slice(0, queryIndex)
  const query = withoutFragment
    .slice(queryIndex + 1)
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=")
      if (separator === -1) return part
      const key = part.slice(0, separator)
      if (!isSensitiveKey(key)) return part
      return `${key}=${REDACTED}`
    })
    .join("&")
  return `${base}?${query}`
}

function isSensitive(node: Node, role: string, name: string | undefined) {
  if (node.sensitive || role === "password") return true
  if (!node.interactive || !name) return false
  return normalizeKey(name)
    .split("_")
    .some((part, index, parts) => SENSITIVE_KEYS.has(part) || SENSITIVE_KEYS.has(parts.slice(index).join("_")))
}

function isSensitiveKey(value: string) {
  const normalized = normalizeKey(value)
  return SENSITIVE_KEYS.has(normalized) || Array.from(SENSITIVE_KEYS).some((key) => normalized.endsWith(`_${key}`))
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

function identityKey(role: string, name: string) {
  return `${role}\u0000${name}`
}

function normalizeRole(value: string) {
  return value.trim().toLowerCase() || "unknown"
}

function normalizeText(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")
}
