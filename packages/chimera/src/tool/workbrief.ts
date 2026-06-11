import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./workbrief.txt"
import { WorkBrief } from "../session/work-brief"

const ItemList = Schema.mutable(Schema.Array(Schema.String))

export const Parameters = Schema.Struct({
  clear: Schema.optional(Schema.Boolean).annotate({
    description: "Reset the current brief before applying supplied fields. Defaults to false.",
  }),
  intent: Schema.optional(Schema.String).annotate({
    description: "Compact statement of what the session is currently trying to accomplish.",
  }),
  confirmedDecisions: Schema.optional(ItemList).annotate({
    description: "Confirmed decisions that should guide future work.",
  }),
  constraints: Schema.optional(ItemList).annotate({
    description: "Constraints and requirements that must be preserved.",
  }),
  acceptanceCriteria: Schema.optional(ItemList).annotate({
    description: "Observable criteria for considering this work complete.",
  }),
  openQuestions: Schema.optional(ItemList).annotate({
    description: "Open questions that still need user or evidence-based resolution.",
  }),
  relevantEvidence: Schema.optional(ItemList).annotate({
    description: "Short evidence references, such as tool findings or file references. Do not include large outputs.",
  }),
  closeout: Schema.optional(ItemList).annotate({
    description: "Closeout checks that should happen before claiming completion.",
  }),
})

type Metadata = {
  brief: WorkBrief.Info
}

export const WorkBriefTool = Tool.define<typeof Parameters, Metadata, WorkBrief.Service>(
  "workbrief",
  Effect.gen(function* () {
    const workBrief = yield* WorkBrief.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "workbrief",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const current = params.clear ? WorkBrief.normalize(undefined) : yield* workBrief.get(ctx.sessionID)
          const brief = WorkBrief.normalize({
            ...current,
            ...(params.intent !== undefined ? { intent: params.intent } : {}),
            ...(params.confirmedDecisions !== undefined ? { confirmedDecisions: params.confirmedDecisions } : {}),
            ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
            ...(params.acceptanceCriteria !== undefined ? { acceptanceCriteria: params.acceptanceCriteria } : {}),
            ...(params.openQuestions !== undefined ? { openQuestions: params.openQuestions } : {}),
            ...(params.relevantEvidence !== undefined ? { relevantEvidence: params.relevantEvidence } : {}),
            ...(params.closeout !== undefined ? { closeout: params.closeout } : {}),
          })
          yield* workBrief.update({ sessionID: ctx.sessionID, brief })

          return {
            title: "Current Work Brief",
            output: WorkBrief.format(brief) ?? "Current Work Brief cleared.",
            metadata: { brief },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
