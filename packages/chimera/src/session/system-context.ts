import { Effect, Option, Schema } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import * as Log from "@opencode-ai/core/util/log"
import { ContextEpoch } from "./context-epoch"
import { SessionID } from "./schema"
import { SystemPrompt } from "./system"

const log = Log.create({ service: "system-context" })

// All keyed prompt segments ride on one carrier source. SystemContext.initialize
// joins distinct source baselines with "\n\n", so per-segment sources could not
// reproduce the default path's join("\n") byte-for-byte; a single source carrying
// the keyed segment list keeps the stored baseline byte-identical to the default
// assembly while the snapshot keeps per-segment attribution and diffing.
const SegmentValue = Schema.Struct({
  key: Schema.String,
  content: Schema.String,
})

export function context(segments: ReadonlyArray<SystemPrompt.Segment>) {
  return SystemContext.make({
    key: SystemContext.Key.make("prompt/system"),
    codec: Schema.Array(SegmentValue),
    load: Effect.succeed(segments),
    baseline: (current) => current.map((segment) => segment.content).join("\n"),
    update: (previous, current) =>
      current
        .filter((segment, index) => {
          const prior = previous[index]
          return !prior || prior.key !== segment.key || prior.content !== segment.content
        })
        .map((segment) => segment.content)
        .join("\n"),
  })
}

// Prepares this session's system prompt generation. Epoch failures degrade to
// None so the caller falls back to the default assembly; this never fails the
// session.
export const prepare = Effect.fn("SessionSystemContext.prepare")(function* (
  epoch: ContextEpoch.Interface,
  sessionID: SessionID,
  segments: ReadonlyArray<SystemPrompt.Segment>,
) {
  return yield* epoch.prepare({ sessionID, context: Effect.succeed(context(segments)) }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.error("system context epoch failed, falling back to default system assembly", { sessionID, error }),
      ),
    ),
    Effect.option,
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        log.error("system context epoch defect, falling back to default system assembly", {
          sessionID,
          error: String(defect),
        })
        return Option.none<ContextEpoch.Prepared>()
      }),
    ),
  )
})

export * as SessionSystemContext from "./system-context"
