import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import * as Log from "@opencode-ai/core/util/log"
import { LANGUAGE_EXTENSIONS } from "./language"
import { zodObject } from "@/util/effect-zod"
import { Schema } from "effect"
import type * as LSPServer from "./server"
import { NamedError } from "@opencode-ai/core/util/error"
import { withTimeout } from "../util/timeout"
import { Filesystem } from "@/util/filesystem"

const DIAGNOSTICS_DEBOUNCE_MS = 150
// Quiet period after the first fresh cross-file publish before the relaxed
// document-mode wait completes (see waitForCrossFileSettle). Kept longer than
// DIAGNOSTICS_DEBOUNCE_MS so the edited file's own versioned push still wins
// the race and the common case never snapshots the edited file too early.
const DIAGNOSTICS_CROSS_FILE_SETTLE_MS = 200
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000

const INITIALIZE_TIMEOUT_MS = 45_000

// LSP spec constants
const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

const log = Log.create({ service: "lsp.client" })

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Diagnostic = VSCodeDiagnostic

export const InitializeErrorPayloadSchema = Schema.Struct({
  serverID: Schema.String,
})
export const InitializeErrorPayload = zodObject(InitializeErrorPayloadSchema)
export const InitializeError = NamedError.create("LSPInitializeError", InitializeErrorPayload)

export const DiagnosticsEventPayloadSchema = Schema.Struct({
  serverID: Schema.String,
  path: Schema.String,
})
export const DiagnosticsEventPayload = zodObject(DiagnosticsEventPayloadSchema)

export const Event = {
  Diagnostics: BusEvent.define("lsp.client.diagnostics", DiagnosticsEventPayloadSchema),
}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

function getFilePath(uri: string) {
  if (!uri.startsWith("file://")) return
  return Filesystem.normalizePath(fileURLToPath(uri))
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

export async function create(input: { serverID: string; server: LSPServer.Handle; root: string; directory: string }) {
  const logger = log.clone().tag("serverID", input.serverID)
  logger.info("starting client")

  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout as any),
    new StreamMessageWriter(input.server.process.stdin as any),
  )
  // Server stderr can contain both real errors and routine informational logs,
  // which is normal stderr practice for some tools. Keep the raw stream at
  // debug so users can opt in with --print-logs --log-level DEBUG without
  // polluting normal logs.
  input.server.process.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim()
    if (text) logger.debug("server stderr", { text: text.slice(0, 1000) })
  })

  // --- Connection state ---

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const publishListeners = new Set<() => void>()
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  // --- LSP connection handlers ---

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const filePath = getFilePath(params.uri)
    if (!filePath) return
    logger.info("textDocument/publishDiagnostics", {
      path: filePath,
      count: params.diagnostics.length,
      version: params.version,
    })
    published.set(filePath, {
      at: Date.now(),
      version: typeof params.version === "number" ? params.version : undefined,
    })
    for (const listener of [...publishListeners]) listener()
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, params.diagnostics)
      return
    }
    updatePushDiagnostics(filePath, params.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", (params) => {
    logger.info("window/workDoneProgress/create", params)
    return null
  })
  connection.onRequest("workspace/configuration", async (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", async (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("client/unregisterCapability", async (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("workspace/workspaceFolders", async () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", async () => null)
  connection.listen()

  // --- Initialize handshake ---

  logger.info("sending initialize")
  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    logger.error("initialize error", { error: err })
    throw new InitializeError(
      { serverID: input.serverID },
      {
        cause: err,
      },
    )
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.sendNotification("initialized", {})

  if (input.server.initialization) {
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  const files: Record<string, { version: number; text: string }> = {}

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        resolve(result)
      }
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      unsub = Bus.subscribe(Event.Diagnostics, (event) => {
        if (event.properties.path !== request.path || event.properties.serverID !== input.serverID) return
        schedule()
      })
      schedule()
    })
  }

  // Resolves true when any publishDiagnostics arrived at or after `after` and
  // the publish stream then stayed quiet for DIAGNOSTICS_CROSS_FILE_SETTLE_MS;
  // each further publish resets the settle timer so related publishes land
  // together. Resolves false when nothing fresh arrived within `timeout`. The
  // settle timer is not separately budget-clamped: the timeout leg caps the
  // whole wait, so a publish in the final settle window still defers.
  function waitForCrossFileSettle(request: { after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (settleTimer) clearTimeout(settleTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        publishListeners.delete(listener)
        resolve(result)
      }
      const listener = () => {
        if (![...published.values()].some((entry) => entry.at >= request.after)) return
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => finish(true), DIAGNOSTICS_CROSS_FILE_SETTLE_MS)
      }
      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      publishListeners.add(listener)
      listener()
    })
  }

  // Returns whether fresh diagnostics arrived before the deadline. `timeoutMs`
  // overrides the built-in wait budget (B3 two-phase wait: the inline phase
  // passes a small budget; the detached late phase resumes with the rest).
  //
  // Completion criterion (relaxed for cross-file breakage): the wait ends when
  // EITHER the edited file's own diagnostics turn fresh (its versioned push or
  // a matching pull — the common case, unchanged) OR any publishDiagnostics
  // arrived after the wait started and the stream settled for
  // DIAGNOSTICS_CROSS_FILE_SETTLE_MS. The settle leg exists because servers
  // like tsserver do not re-publish an unchanged (empty) set for a clean
  // edited file, so a cross-file break — the highest-value push — would
  // otherwise always run to the budget and defer. The edited file's own fresh
  // push still wins the race in practice: its debounce (150ms) is shorter
  // than the settle window, so the common case never collects a too-early
  // snapshot of the edited file. The B3 late-phase resume (LSP.waitDiagnostics)
  // shares this criterion by construction: it calls this same function. Full
  // mode deliberately keeps the stricter edited-file-only criterion.
  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number; timeoutMs?: number }) {
    const timeout = request.timeoutMs ?? DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout,
    })
    const crossFileWait = waitForCrossFileSettle({ after: startedAt, timeout })

    while (Date.now() - startedAt < timeout) {
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return true
      const remaining = timeout - (Date.now() - startedAt)
      if (remaining <= 0) return false
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        crossFileWait.then((ready) => (ready ? "cross-file" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next === "push" || next === "cross-file") return true
      if (next !== "registration") return false
    }
    return false
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number; timeoutMs?: number }) {
    const timeout = request.timeoutMs ?? DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout,
    })

    while (Date.now() - startedAt < timeout) {
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return true
      const remaining = timeout - (Date.now() - startedAt)
      if (remaining <= 0) return false
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next === "push") return true
      if (next !== "registration") return false
    }
    return false
  }

  // --- Public API ---

  const result = {
    root: input.root,
    get serverID() {
      return input.serverID
    },
    get connection() {
      return connection
    },
    notify: {
      async open(request: { path: string }) {
        request.path = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        const text = await Filesystem.readText(request.path)
        const extension = path.extname(request.path)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        const document = files[request.path]
        if (document !== undefined) {
          // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
          // re-emit diagnostics when the content actually changes, so clearing
          // here would lose errors for no-op touchFile calls. Let the server's
          // next push/pull overwrite naturally.
          logger.info("workspace/didChangeWatchedFiles", request)
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(request.path).href,
                type: FILE_CHANGE_CHANGED,
              },
            ],
          })

          const next = document.version + 1
          files[request.path] = { version: next, text }
          logger.info("textDocument/didChange", {
            path: request.path,
            version: next,
          })
          await connection.sendNotification("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(request.path).href,
              version: next,
            },
            contentChanges:
              syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                ? [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: endPosition(document.text),
                      },
                      text,
                    },
                  ]
                : [{ text }],
          })
          return next
        }

        logger.info("workspace/didChangeWatchedFiles", request)
        await connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [
            {
              uri: pathToFileURL(request.path).href,
              type: FILE_CHANGE_CREATED,
            },
          ],
        })

        logger.info("textDocument/didOpen", request)
        pushDiagnostics.delete(request.path)
        pullDiagnostics.delete(request.path)
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(request.path).href,
            languageId,
            version: 0,
            text,
          },
        })
        files[request.path] = { version: 0, text }
        return 0
      },
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    // Version of the document this client last synced via notify.open, or
    // undefined when the file was never opened. The B3 late-diagnostics wait
    // resumes against this version without re-syncing the document.
    documentVersion(request: { path: string }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      return files[normalizedPath]?.version
    },
    async waitForDiagnostics(request: {
      path: string
      version: number
      mode?: "document" | "full"
      after?: number
      timeoutMs?: number
    }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      logger.info("waiting for diagnostics", {
        path: normalizedPath,
        mode: request.mode ?? "full",
        version: request.version,
      })
      if (request.mode === "document") {
        return await waitForDocumentDiagnostics({
          path: normalizedPath,
          version: request.version,
          after: request.after,
          timeoutMs: request.timeoutMs,
        })
      }
      return await waitForFullDiagnostics({
        path: normalizedPath,
        version: request.version,
        after: request.after,
        timeoutMs: request.timeoutMs,
      })
    },
    async shutdown() {
      logger.info("shutting down")
      connection.end()
      connection.dispose()
      await input.server.process.stop()
      logger.info("shutdown")
    },
  }

  logger.info("initialized")

  return result
}

export * as LSPClient from "./client"
