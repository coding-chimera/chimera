#!/usr/bin/env bun

/**
 * Real-model read continuation bench.
 *
 * Usage:
 *   bun --cwd packages/chimera script/read-next-bench.ts \
 *     --model <provider/model> --variant low --timeout 180000
 *
 * The child CLI resolves provider/auth configuration itself. This script only
 * adds OPENCODE_DB to the inherited environment and never removes evidence.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const MARKER = "BENCH_MARKER_95"
const TEMP_ROOT = process.env.CHIMERA_BENCH_TEMP_ROOT ?? path.join(tmpdir(), "chimera")
const USAGE =
  "Usage: bun --cwd packages/chimera script/read-next-bench.ts --model <provider/model> [--variant <variant>] [--timeout <ms>]"

type Options = {
  model: string
  variant: string
  timeoutMs: number
}

type ReadRecord = {
  eventLine: number
  filePath: unknown
  offset: unknown
  limit: unknown
  status: "completed" | "error"
  input: unknown
}

type ProcessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  processError: string | null
}

type Check = {
  name: string
  pass: boolean
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function display(value: unknown) {
  if (value === undefined) return "undefined"
  return JSON.stringify(value) ?? String(value)
}

function reportValue(value: unknown) {
  return value === undefined ? null : value
}

function parseOptions(args: string[]): Options {
  const options: Options = {
      model: "",
      variant: "low",
      timeoutMs: 180_000,
    }

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const equals = argument.indexOf("=")
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (!["--model", "--variant", "--timeout", "--timeout-ms"].includes(flag)) {
      throw new Error(`Unknown argument: ${argument}\n${USAGE}`)
    }

    const inline = equals === -1 ? undefined : argument.slice(equals + 1)
    const value = inline ?? args[index + 1]
    if (inline === undefined) index++
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}\n${USAGE}`)
    }

    if (flag === "--model") {
      options.model = value
      continue
    }
    if (flag === "--variant") {
      options.variant = value
      continue
    }

    const timeoutMs = Number(value)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Timeout must be a positive integer in milliseconds; received ${display(value)}`)
    }
    options.timeoutMs = timeoutMs
  }

  if (!options.model) throw new Error(`--model is required\n${USAGE}`)
  return options
}

function appendError(current: string | null, next: string) {
  return current ? `${current}; ${next}` : next
}

async function runChild(options: Options, fixtureDirectory: string, fixturePath: string, databasePath: string) {
  const title = `read-next-bench-${path.basename(fixtureDirectory)}`
  const firstInput = JSON.stringify({ filePath: fixturePath, limit: 40 })
  const prompt = [
    "Use only the read tool. Do not use grep, bash, glob, or any other tool.",
    `Find the unique marker ${MARKER} in ${fixturePath}.`,
    `Your first actual read tool call must use exactly this JSON input: ${firstInput}`,
    "If the marker is not in the returned lines, follow the tool result's continuation guidance. If it includes Next Read, copy those parameters verbatim into the actual next read tool-call JSON, including the top-level offset; otherwise use the offset shown in the continuation message. Continue paging until you find the marker.",
    `As soon as you find the marker, stop using tools and answer exactly ${MARKER} with no other text.`,
  ].join("\n")
  const child = Bun.spawn(
    [
      "bun",
      "src/index.ts",
      "run",
      "--format",
      "json",
      "--pure",
      "--dangerously-skip-permissions",
      "--model",
      options.model,
      "--variant",
      options.variant,
      "--title",
      title,
      "--dir",
      fixtureDirectory,
      prompt,
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, OPENCODE_DB: databasePath },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timedOut = false
  let processError: string | null = null
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch (error) {
      processError = appendError(processError, `timeout kill failed: ${errorMessage(error)}`)
    }
  }, options.timeoutMs)

  try {
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    return { title, result: { stdout, stderr, exitCode, timedOut, processError } satisfies ProcessResult }
  } catch (error) {
    processError = appendError(processError, `child process failed: ${errorMessage(error)}`)
    try {
      child.kill()
    } catch (killError) {
      processError = appendError(processError, `cleanup kill failed: ${errorMessage(killError)}`)
    }
    const stdout = await stdoutPromise.catch((streamError: unknown) => {
      processError = appendError(processError, `stdout capture failed: ${errorMessage(streamError)}`)
      return ""
    })
    const stderr = await stderrPromise.catch((streamError: unknown) => {
      processError = appendError(processError, `stderr capture failed: ${errorMessage(streamError)}`)
      return ""
    })
    return {
      title,
      result: { stdout, stderr, exitCode: child.exitCode, timedOut, processError } satisfies ProcessResult,
    }
  } finally {
    clearTimeout(timer)
  }
}

function parseEvents(stdout: string) {
  const reads: ReadRecord[] = []
  const textParts: string[] = []
  const diagnostics: Array<{ line: number; error: string; raw: string }> = []
  const lines = stdout.split("\n")
  if (lines.at(-1) === "") lines.pop()
  let sessionID: string | null = null

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      diagnostics.push({ line: index + 1, error: errorMessage(error), raw: line.slice(0, 500) })
      continue
    }
    if (!isRecord(parsed)) {
      diagnostics.push({ line: index + 1, error: "JSON event is not an object", raw: line.slice(0, 500) })
      continue
    }
    if (sessionID === null && typeof parsed.sessionID === "string") sessionID = parsed.sessionID

    const part = isRecord(parsed.part) ? parsed.part : undefined
    if (parsed.type === "text" && part?.type === "text" && typeof part.text === "string") {
      textParts.push(part.text)
    }
    if (parsed.type !== "tool_use" || part?.tool !== "read" || !isRecord(part.state)) continue

    const state = part.state
    if (state.status !== "completed" && state.status !== "error") continue
    const input = state.input
    const fields = isRecord(input) ? input : undefined
    reads.push({
      eventLine: index + 1,
      filePath: fields?.filePath,
      offset: fields?.offset,
      limit: fields?.limit,
      status: state.status,
      input,
    })
  }

  return { reads, sessionID, text: textParts.join("\n"), textEventCount: textParts.length, diagnostics }
}

function evaluateChecks(
  reads: ReadRecord[],
  text: string,
  processResult: ProcessResult,
  timeoutMs: number,
): Check[] {
  const minimumReads = reads.length >= 2

  let increasingOffsets = reads.length >= 2
  let increasingReason = increasingOffsets
    ? `read offsets: ${reads.map((read, index) => `${index + 1}:${display(read.offset)}`).join(", ")}`
    : `need at least 2 reads to check continuation offsets; observed ${reads.length}`
  for (let index = 1; index < reads.length; index++) {
    const current = reads[index].offset
    const previous = index === 1 && reads[0].offset === undefined ? 1 : reads[index - 1].offset
    if (typeof current !== "number" || !Number.isFinite(current)) {
      increasingOffsets = false
      increasingReason = `read ${index + 1} offset must be a number; received ${display(current)}`
      break
    }
    if (typeof previous !== "number" || !Number.isFinite(previous)) {
      increasingOffsets = false
      increasingReason = `read ${index} has no numeric offset for comparison; received ${display(previous)}`
      break
    }
    if (current <= previous) {
      increasingOffsets = false
      increasingReason = `read ${index + 1} offset ${current} is not greater than read ${index} offset ${previous}`
      break
    }
  }

  let noAdjacentDuplicates = true
  let duplicateReason = `checked ${Math.max(0, reads.length - 1)} adjacent read pair(s)`
  for (let index = 1; index < reads.length; index++) {
    const previous = reads[index - 1]
    const current = reads[index]
    if (
      current.filePath === previous.filePath &&
      current.offset === previous.offset &&
      current.limit === previous.limit
    ) {
      noAdjacentDuplicates = false
      duplicateReason = `reads ${index} and ${index + 1} repeat filePath+offset+limit ${display([
        current.filePath,
        current.offset,
        current.limit,
      ])}`
      break
    }
  }

  const reachedMarkerWindow = reads.some((read) => typeof read.offset === "number" && read.offset >= 81)
  const markerInText = text.includes(MARKER)
  const cleanExit = processResult.exitCode === 0 && !processResult.timedOut && processResult.processError === null
  const exitReason = processResult.timedOut
    ? `child exceeded ${timeoutMs}ms and was killed; exitCode=${display(processResult.exitCode)}`
    : processResult.processError
      ? processResult.processError
      : `child exitCode=${display(processResult.exitCode)}`

  return [
    {
      name: "at_least_two_reads",
      pass: minimumReads,
      reason: `observed ${reads.length} completed/error read tool_use event(s)`,
    },
    { name: "strictly_increasing_numeric_offsets", pass: increasingOffsets, reason: increasingReason },
    { name: "no_adjacent_duplicate_reads", pass: noAdjacentDuplicates, reason: duplicateReason },
    {
      name: "reached_offset_81",
      pass: reachedMarkerWindow,
      reason: reachedMarkerWindow ? "at least one read offset is >=81" : "no read has a numeric offset >=81",
    },
    {
      name: "assistant_text_contains_marker",
      pass: markerInText,
      reason: markerInText ? `aggregated text events contain ${MARKER}` : `aggregated text events lack ${MARKER}`,
    },
    { name: "cli_exit_zero", pass: cleanExit, reason: exitReason },
  ]
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  await mkdir(TEMP_ROOT, { recursive: true })
  const fixtureDirectory = await mkdtemp(path.join(TEMP_ROOT, "read-next-bench-"))
  const fixturePath = path.join(fixtureDirectory, "fixture.txt")
  const databasePath = path.join(fixtureDirectory, "bench.db")
  const rawEventsPath = path.join(fixtureDirectory, "raw-events.jsonl")
  const reportPath = path.join(fixtureDirectory, "report.json")
  const fixture = Array.from({ length: 120 }, (_, index) =>
    index === 94 ? `line ${index + 1}: ${MARKER}` : `line ${index + 1}: read continuation fixture`,
  ).join("\n")
  await writeFile(fixturePath, `${fixture}\n`, "utf8")

  let title = `read-next-bench-${path.basename(fixtureDirectory)}`
  let processResult: ProcessResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    processError: null,
  }
  try {
    const executed = await runChild(options, fixtureDirectory, fixturePath, databasePath)
    title = executed.title
    processResult = executed.result
  } catch (error) {
    processResult.processError = `spawn failed: ${errorMessage(error)}`
  }

  await writeFile(rawEventsPath, processResult.stdout, "utf8")
  const events = parseEvents(processResult.stdout)
  const checks = evaluateChecks(events.reads, events.text, processResult, options.timeoutMs)
  const report = {
    pass: checks.every((check) => check.pass),
    model: options.model,
    variant: options.variant,
    timeoutMs: options.timeoutMs,
    title,
    sessionID: events.sessionID,
    fixturePath,
    databasePath,
    rawEventsPath,
    reportPath,
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    processError: processResult.processError,
    stderr: processResult.stderr,
    reads: events.reads.map((read) => ({
      eventLine: read.eventLine,
      filePath: reportValue(read.filePath),
      offset: reportValue(read.offset),
      limit: reportValue(read.limit),
      status: read.status,
      input: reportValue(read.input),
    })),
    textEventCount: events.textEventCount,
    parseDiagnostics: events.diagnostics,
    checks,
  }
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8")
  console.log(JSON.stringify(report))
  process.exitCode = report.pass ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ pass: false, error: errorMessage(error), usage: USAGE }))
  process.exitCode = 1
})
