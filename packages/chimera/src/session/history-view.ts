import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "@/storage/db"
import { SessionTable } from "@/storage/tables/session.sql"
import { eq } from "drizzle-orm"
import type { SessionID } from "@/contracts/session-ids"
import type { MessageV2 } from "./message-v2"
import { MessageV2 as Messages } from "./message-v2"
import { SessionDataPlane } from "./data-plane"
import { SessionPartReconcile } from "./part-reconcile"

export interface CompactionView {
  historyHash: string
  messages: MessageV2.WithParts[]
  hasRemoteCompaction: boolean
}

export function readCompactionView(input: {
  sessionID: SessionID
  mode?: "local" | "text"
  expectedHistoryHash?: string
}): Effect.Effect<CompactionView | undefined> {
  return Effect.gen(function* () {
    if (process.env.CHIMERA_SESSION_DATA_READER !== "1" || process.env.CHIMERA_SESSION_DATA_WRITER !== "1") return
    if (Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM || Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) return
    if (Database.Path === ":memory:" && !SessionDataPlane.isWriterDriverTestDouble()) return
    if (!SessionDataPlane.getHistoryDriver()) return

    const repaired = SessionPartReconcile.ensureOrphansReconciled(input.sessionID)
    if (repaired) SessionDataPlane.invalidateNativeHistory(Database.Path, input.sessionID)
    const view = yield* Effect.promise(() =>
      SessionDataPlane.readNativeCompaction(
        Database.Path,
        input.sessionID,
        input.mode ?? "local",
        input.expectedHistoryHash,
      ),
    )
    if (!view) return

    const parsed: unknown = JSON.parse(view.json)
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          typeof item.info !== "object" ||
          item.info === null ||
          !Array.isArray(item.parts),
      )
    ) {
      SessionDataPlane.invalidateNativeHistory(Database.Path, input.sessionID)
      return
    }
    if (parsed.length === 0) {
      const exists = Database.use((db) =>
        db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
      )
      if (!exists) return
    }
    if (typeof view.historyHash !== "string" || typeof view.hasRemoteCompaction !== "boolean") return
    return {
      historyHash: view.historyHash,
      messages: parsed as MessageV2.WithParts[],
      hasRemoteCompaction: view.hasRemoteCompaction,
    }
  }).pipe(
    Effect.catchCause(() => {
      SessionDataPlane.invalidateNativeHistory(Database.Path, input.sessionID)
      return Effect.succeed(undefined)
    }),
  )
}

export const scanCompactionView = Effect.fnUntraced(function* (
  sessionID: SessionID,
  options?: { remoteCompaction?: "text"; expectedHistoryHash?: string },
) {
  const view = yield* readCompactionView({
    sessionID,
    mode: options?.remoteCompaction ?? "local",
    expectedHistoryHash: options?.expectedHistoryHash,
  })
  if (view) return view
  const scan = yield* Messages.scanCompactedEffect(
    sessionID,
    options?.remoteCompaction ? { remoteCompaction: options.remoteCompaction } : undefined,
  )
  return {
    historyHash: undefined,
    messages: scan.messages,
    hasRemoteCompaction: scan.hasRemoteCompaction,
  }
})

export * as SessionHistoryView from "./history-view"
