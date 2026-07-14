const OPEN_TAG = "<chimera-memory-citation"
const BLOCK = /<chimera-memory-citation\b([^>]*)>([\s\S]*?)<\/chimera-memory-citation\s*>/gi
const TRAILING_BLOCK = /<chimera-memory-citation\b([^>]*)>([\s\S]*)$/i
const VERSION = /\bversion\s*=\s*(?:["']1["']|1)(?:\s|$)/i

export type Entry = {
  path: string
  lineStart: number
  lineEnd: number
  note: string
}

export type Parsed = {
  text: string
  version?: 1
  entries: Entry[]
  rolloutIDs: string[]
  sessionIDs: string[]
  noteIDs: string[]
}

function sections(body: string, names: string[]) {
  return names.flatMap((name) =>
    [...body.matchAll(new RegExp(`<${name}\\s*>([\\s\\S]*?)<\\/${name}\\s*>`, "gi"))].map((match) => match[1]),
  )
}

function version(attrs: string, body: string) {
  if (VERSION.test(attrs)) return 1 as const
  if (sections(body, ["version"]).some((value) => value.trim() === "1")) return 1 as const
  return undefined
}

function aliasPath(input: string) {
  const portable = input.trim().replaceAll("\\", "/")
  if (!portable || portable.includes("\0") || portable.startsWith("/") || portable.startsWith("//")) return undefined
  if (/^[A-Za-z]:/.test(portable) || /^[a-z][a-z0-9+.-]*:\/\//i.test(portable)) return undefined
  const components = portable.split("/")
  if (components[0] !== "global" && components[0] !== "project") return undefined
  if (components.length < 2 || /^[A-Za-z]:/.test(components.slice(1).join("/"))) return undefined
  if (components.some((component) => !component || component === "." || component === ".." || component.startsWith("."))) return undefined
  return components.join("/")
}

function entry(input: string): Entry | undefined {
  const match = input.trim().match(/^(.*):(\d+)-(\d+)\s*\|\s*note=\[([^\r\n]*)\]\s*$/)
  if (!match) return undefined
  const path = aliasPath(match[1])
  const lineStart = Number(match[2])
  const lineEnd = Number(match[3])
  if (!path || !Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) return undefined
  if (lineStart < 1 || lineEnd < lineStart) return undefined
  return { path, lineStart, lineEnd, note: match[4].trim() }
}

function ids(body: string, names: string[]) {
  return sections(body, names).flatMap((block) => block.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))
}

function unique(values: string[]) {
  return [...new Set(values)]
}

export function strip(input: string): Parsed {
  const entries: Entry[] = []
  const rolloutIDs: string[] = []
  const sessionIDs: string[] = []
  const noteIDs: string[] = []
  let parsedVersion: 1 | undefined
  let found = false

  const consume = (_block: string, attrs: string, body: string) => {
    found = true
    if (version(attrs, body) !== 1) return ""
    parsedVersion = 1
    entries.push(
      ...sections(body, ["citation_entries", "entries"])
        .flatMap((block) => block.split(/\r?\n/))
        .map(entry)
        .filter((value): value is Entry => value !== undefined),
    )
    rolloutIDs.push(...ids(body, ["rollout_ids", "rollout-ids"]))
    sessionIDs.push(...ids(body, ["session_ids", "session-ids"]))
    noteIDs.push(...ids(body, ["note_ids", "note-ids"]))
    return ""
  }
  const text = input.replace(BLOCK, consume).replace(TRAILING_BLOCK, consume)

  return {
    text: found ? text.trimEnd() : text,
    version: parsedVersion,
    entries,
    rolloutIDs: unique(rolloutIDs),
    sessionIDs: unique(sessionIDs),
    noteIDs: unique(noteIDs),
  }
}

export const parse = strip

export function visibleText(input: string) {
  const text = input.replace(BLOCK, "").replace(TRAILING_BLOCK, "")
  const lower = text.toLowerCase()
  const limit = Math.min(OPEN_TAG.length - 1, lower.length)
  const suffix = Array.from({ length: limit }, (_, index) => limit - index).find((length) =>
    OPEN_TAG.startsWith(lower.slice(-length)),
  )
  return suffix ? text.slice(0, -suffix) : text
}

type AllowedPaths = ReadonlySet<string> | ReadonlyMap<string, number>

function allowedLineCount(input: AllowedPaths, path: string) {
  if (!("get" in input) || typeof input.get !== "function") return undefined
  return input.get(path)
}

function safeID(id: string) {
  return Boolean(id) && !id.includes("\0") && !id.includes("/") && !id.includes("\\") && id !== "." && id !== ".."
}

function hasRollout(paths: string[], id: string) {
  if (!safeID(id)) return false
  return paths.some((path) => {
    const relative = path.split("/rollout_summaries/")[1]
    return relative === `${id}.md` || relative?.startsWith(`${id}-`) === true
  })
}

function hasNote(paths: string[], id: string) {
  if (!safeID(id)) return false
  return paths.some((path) => path.endsWith(`/extensions/ad_hoc/notes/${id}.md`))
}

export function validate(input: Parsed, allowedPaths: AllowedPaths) {
  if (input.version !== 1) return undefined
  const paths = [...allowedPaths.keys()]
  const entries = input.entries.filter((item) => {
    if (!allowedPaths.has(item.path)) return false
    const lineCount = allowedLineCount(allowedPaths, item.path)
    return lineCount === undefined || item.lineEnd <= lineCount
  })
  if (input.entries.length > 0 && entries.length === 0) return undefined
  return {
    version: 1 as const,
    entries,
    rolloutIDs: unique(input.rolloutIDs).filter((id) => hasRollout(paths, id)).slice(0, 100),
    sessionIDs: unique(input.sessionIDs).filter((id) => hasRollout(paths, id)).slice(0, 100),
    noteIDs: unique(input.noteIDs).filter((id) => hasNote(paths, id)).slice(0, 100),
  }
}

export * as MemoryCitation from "./citation"
