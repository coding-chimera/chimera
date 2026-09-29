import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Permission } from "."
import { Session } from "@/session/session"

const log = Log.create({ service: "permission" })

/**
 * Single reply entry point for HTTP surfaces: delegates to Permission.reply
 * and, when the user answered "always", persists the approved rules to the
 * session permission slots so the approval survives host restarts and is
 * visible to other processes. The ask evaluation consumes the persisted
 * column via the session ruleset merged in SessionPrompt.
 *
 * Persistence failures are logged, never surfaced: the reply has already
 * resolved the pending ask in memory, and failing the request afterwards
 * would leave the client believing the answer was lost.
 */
export const replyAndPersist = Effect.fn("Permission.replyAndPersist")(function* (input: Permission.ReplyInput) {
  const permission = yield* Permission.Service
  const sessions = yield* Session.Service
  const approved = yield* permission.reply(input)
  if (!approved || approved.rules.length === 0) return
  yield* sessions.updatePermissionSlots(approved).pipe(
    Effect.catch((error) =>
      Effect.sync(() => log.warn("failed to persist always approval", { sessionID: approved.sessionID, error })),
    ),
  )
})

export * as PermissionPersist from "./persist"
