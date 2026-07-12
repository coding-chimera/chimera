export * as BrowserDiscovery from "./discovery"

import path from "node:path"
import os from "node:os"
import { Effect, FileSystem, Schema } from "effect"

export type BrowserKind = "chrome" | "chromium" | "edge" | "brave"
export type CandidateSource = "explicit" | "path" | "standard"

export interface Candidate {
  readonly kind: BrowserKind
  readonly path: string
  readonly source: CandidateSource
}

export interface DiscoveryInput {
  readonly executablePath?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
}

export interface DiscoveryResult extends Candidate {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("BrowserNotFoundError", {
  message: Schema.String,
  searched: Schema.Array(Schema.String),
}) {}

export class InvalidExecutableError extends Schema.TaggedErrorClass<InvalidExecutableError>()(
  "BrowserInvalidExecutableError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

const POSIX_NAMES: readonly [BrowserKind, string][] = [
  ["chrome", "google-chrome-stable"],
  ["chrome", "google-chrome"],
  ["chromium", "chromium"],
  ["chromium", "chromium-browser"],
  ["edge", "microsoft-edge-stable"],
  ["edge", "microsoft-edge"],
  ["brave", "brave-browser"],
  ["brave", "brave-browser-stable"],
]

const WINDOWS_NAMES: readonly [BrowserKind, string][] = [
  ["chrome", "chrome.exe"],
  ["chromium", "chromium.exe"],
  ["edge", "msedge.exe"],
  ["brave", "brave.exe"],
]

export function candidates(input: Omit<DiscoveryInput, "executablePath"> = {}): readonly Candidate[] {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? env.OPENCODE_TEST_HOME ?? os.homedir()
  const paths = platform === "win32" ? path.win32 : path.posix
  const names = platform === "win32" ? WINDOWS_NAMES : POSIX_NAMES
  const delimiter = platform === "win32" ? ";" : ":"
  const fromPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map(([kind, name]) => ({ kind, path: paths.join(directory, name), source: "path" as const })))
  const standard = standardCandidates(platform, env, home)
  const seen = new Set<string>()
  return [...fromPath, ...standard].filter((candidate) => {
    const key = platform === "win32" ? candidate.path.toLowerCase() : candidate.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const discover = Effect.fn("BrowserDiscovery.discover")(function* (input: DiscoveryInput = {}) {
  const fs = yield* FileSystem.FileSystem
  const platform = input.platform ?? process.platform
  if (input.executablePath) {
    const valid = yield* executable(fs, input.executablePath, platform)
    if (!valid)
      return yield* new InvalidExecutableError({
        message: `Configured browser executable is not an executable file: ${input.executablePath}`,
        path: input.executablePath,
      })
    return {
      executablePath: input.executablePath,
      path: input.executablePath,
      kind: kindFromPath(input.executablePath),
      source: "explicit" as const,
    }
  }

  const list = candidates(input)
  for (const candidate of list) {
    if (yield* executable(fs, candidate.path, platform))
      return {
        executablePath: candidate.path,
        ...candidate,
      }
  }
  return yield* new NotFoundError({
    message:
      "No supported system Chrome/Chromium browser was found. Set CHIMERA_BROWSER_EXECUTABLE_PATH or CHIMERA_BROWSER_CDP_URL.",
    searched: list.map((candidate) => candidate.path),
  })
})

function standardCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): readonly Candidate[] {
  if (platform === "darwin")
    return [
      ["chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["chrome", path.posix.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")],
      ["chromium", path.posix.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium")],
      ["edge", path.posix.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")],
      ["brave", path.posix.join(home, "Applications/Brave Browser.app/Contents/MacOS/Brave Browser")],
    ].map(([kind, executable]) => ({ kind: kind as BrowserKind, path: executable, source: "standard" as const }))

  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
      (value): value is string => Boolean(value),
    )
    const suffixes: readonly [BrowserKind, string][] = [
      ["chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["edge", "Microsoft\\Edge\\Application\\msedge.exe"],
      ["brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      ["chromium", "Chromium\\Application\\chrome.exe"],
    ]
    return roots.flatMap((root) =>
      suffixes.map(([kind, suffix]) => ({ kind, path: path.win32.join(root, suffix), source: "standard" as const })),
    )
  }

  return ["/usr/bin", "/usr/local/bin"].flatMap((directory) =>
    POSIX_NAMES.map(([kind, name]) => ({ kind, path: path.posix.join(directory, name), source: "standard" as const })),
  )
}

function executable(fs: FileSystem.FileSystem, executablePath: string, platform: NodeJS.Platform) {
  return fs.stat(executablePath).pipe(
    Effect.map((info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0)),
    Effect.catch(() => Effect.succeed(false)),
  )
}

function kindFromPath(executablePath: string): BrowserKind {
  const name = executablePath.toLowerCase()
  if (name.includes("brave")) return "brave"
  if (name.includes("edge") || name.includes("msedge")) return "edge"
  if (name.includes("chromium")) return "chromium"
  return "chrome"
}
