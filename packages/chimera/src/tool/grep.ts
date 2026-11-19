import path from "path"
import { Schema } from "effect"
import { Effect, Option, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { DiscoveryNudge } from "@/chimera/discovery-nudge"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

const MAX_LINE_LENGTH = 2000
const MAX_MATCHES = 100

interface Candidate {
  path: string
  line: number
  text: string
  mtime: number
  seq: number
}

// Orders candidates worst-first: lower mtime is worse, and for equal mtimes a
// later match (higher seq) is worse so earlier ripgrep output wins ties.
function rank(a: Candidate, b: Candidate) {
  return a.mtime === b.mtime ? b.seq - a.seq : a.mtime - b.mtime
}

function siftUp(heap: Candidate[], index: number) {
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (rank(heap[index], heap[parent]) >= 0) return
    const value = heap[index]
    heap[index] = heap[parent]
    heap[parent] = value
    index = parent
  }
}

function siftDown(heap: Candidate[], index: number) {
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let worst = index
    if (left < heap.length && rank(heap[left], heap[worst]) < 0) worst = left
    if (right < heap.length && rank(heap[right], heap[worst]) < 0) worst = right
    if (worst === index) return
    const value = heap[index]
    heap[index] = heap[worst]
    heap[worst] = value
    index = worst
  }
}

/**
 * Keeps at most `limit` candidates in a min-heap whose root is the worst kept
 * match, so memory stays bounded regardless of how many matches ripgrep emits.
 */
function offer(heap: Candidate[], candidate: Candidate, limit: number) {
  if (heap.length < limit) {
    heap.push(candidate)
    siftUp(heap, heap.length - 1)
    return
  }
  if (rank(candidate, heap[0]) <= 0) return
  heap[0] = candidate
  siftDown(heap, 0)
}

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = AppFileSystem.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]

          const limit = MAX_MATCHES
          const heap: Candidate[] = []
          const times = new Map<string, number | undefined>()
          let seq = 0
          let total = 0
          let partial = false

          const mtime = (target: string) =>
            Effect.gen(function* () {
              if (times.has(target)) return times.get(target)
              const stat = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const value =
                !stat || stat.type === "Directory"
                  ? undefined
                  : stat.mtime.pipe(
                      Option.map((time) => time.getTime()),
                      Option.getOrElse(() => 0),
                    )
              times.set(target, value)
              return value
            })

          yield* rg
            .searchEvents({
              cwd,
              pattern: params.pattern,
              glob: params.include ? [params.include] : undefined,
              file,
              signal: ctx.abort,
            })
            .pipe(
              Stream.mapEffect(
                (event) =>
                  Effect.gen(function* () {
                    if (event.type === "partial") return "partial" as const
                    const filepath = AppFileSystem.resolve(
                      path.isAbsolute(event.item.path.text)
                        ? event.item.path.text
                        : path.join(cwd, event.item.path.text),
                    )
                    const value = yield* mtime(filepath)
                    if (value === undefined) return undefined
                    return {
                      path: filepath,
                      line: event.item.line_number,
                      text: event.item.lines.text,
                      mtime: value,
                    }
                  }),
                { concurrency: 16 },
              ),
              Stream.runForEach((resolved) =>
                Effect.sync(() => {
                  if (resolved === "partial") {
                    partial = true
                    return
                  }
                  if (!resolved) return
                  total++
                  offer(heap, { ...resolved, seq: seq++ }, limit)
                }),
              ),
            )

          if (total === 0) return empty

          const final = [...heap].sort((a, b) => b.mtime - a.mtime || a.seq - b.seq)
          const truncated = total > limit
          const output = [`Found ${total} matches${truncated ? ` (showing first ${limit})` : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            const text =
              match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
            output.push(`  Line ${match.line}: ${text}`)
          }

          if (truncated) {
            output.push("")
            output.push(
              `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific path or pattern.)`,
            )
          }

          if (partial) {
            output.push("")
            output.push("(Some paths were inaccessible and skipped)")
          }

          const hint = yield* DiscoveryNudge.noteTextTool(ctx.sessionID, ins.worktree === "/" ? ins.directory : ins.worktree)
          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: hint ? `${output.join("\n")}\n\n${hint}` : output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
