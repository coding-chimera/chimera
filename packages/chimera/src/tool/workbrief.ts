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
    description:
      "Confirmed decisions that should guide future work. Merged incrementally: supplied entries are appended to the stored list and exact duplicates are ignored. Send only new entries; use confirmedDecisions_remove to delete stored ones.",
  }),
  confirmedDecisions_remove: Schema.optional(ItemList).annotate({
    description:
      "Substring matchers for deleting stored confirmed decisions. Every stored entry containing a case-sensitive matcher is removed before new entries are appended. Removed entries and no-match matchers are reported in the tool result.",
  }),
  constraints: Schema.optional(ItemList).annotate({
    description:
      "Constraints and requirements that must be preserved. Merged incrementally: supplied entries are appended to the stored list and exact duplicates are ignored. Send only new entries; use constraints_remove to delete stored ones.",
  }),
  constraints_remove: Schema.optional(ItemList).annotate({
    description:
      "Substring matchers for deleting stored constraints. Every stored entry containing a case-sensitive matcher is removed before new constraints are appended. Removed entries and no-match matchers are reported in the tool result.",
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

type Removals = { removed: string[]; unmatched: string[] }

type Metadata = {
  brief: WorkBrief.Info
  removals?: {
    constraints: Removals
    confirmedDecisions: Removals
  }
}

// Incremental merge for constraints/confirmedDecisions: substring removals run first
// (case-sensitive after whitespace normalization, blank matchers ignored), then supplied
// entries are appended. Exact-duplicate dedup happens in WorkBrief.normalize, which keeps
// the first occurrence, so stored entries retain their position.
const mergeItems = (
  existing: ReadonlyArray<string>,
  additions: ReadonlyArray<string> | undefined,
  removals: ReadonlyArray<string> | undefined,
) => {
  const state = (removals ?? [])
    .map((matcher) => matcher.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .reduce(
      (acc, matcher) => {
        const hits = acc.kept.filter((item) => item.includes(matcher))
        if (hits.length === 0) return { ...acc, unmatched: [...acc.unmatched, matcher] }
        return {
          kept: acc.kept.filter((item) => !item.includes(matcher)),
          removed: [...acc.removed, ...hits],
          unmatched: acc.unmatched,
        }
      },
      { kept: [...existing], removed: [] as string[], unmatched: [] as string[] },
    )
  return { ...state, items: additions ? [...state.kept, ...additions] : state.kept }
}

const removalLines = (field: string, result: Removals) => [
  ...(result.removed.length
    ? [`Removed from ${field} (${result.removed.length}):`, ...result.removed.map((item) => `- ${item}`)]
    : []),
  ...(result.unmatched.length
    ? [`No match for ${field}_remove (skipped): ${result.unmatched.map((matcher) => `"${matcher}"`).join(", ")}`]
    : []),
]

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
          const constraints = mergeItems(current.constraints, params.constraints, params.constraints_remove)
          const confirmedDecisions = mergeItems(
            current.confirmedDecisions,
            params.confirmedDecisions,
            params.confirmedDecisions_remove,
          )
          const brief = WorkBrief.normalize({
            ...current,
            ...(params.intent !== undefined ? { intent: params.intent } : {}),
            confirmedDecisions: confirmedDecisions.items,
            constraints: constraints.items,
            ...(params.acceptanceCriteria !== undefined ? { acceptanceCriteria: params.acceptanceCriteria } : {}),
            ...(params.openQuestions !== undefined ? { openQuestions: params.openQuestions } : {}),
            ...(params.relevantEvidence !== undefined ? { relevantEvidence: params.relevantEvidence } : {}),
            ...(params.closeout !== undefined ? { closeout: params.closeout } : {}),
          })
          yield* workBrief.update({ sessionID: ctx.sessionID, brief })

          const notes = [
            ...removalLines("constraints", constraints),
            ...removalLines("confirmedDecisions", confirmedDecisions),
          ]
          return {
            title: "Current Work Brief",
            output: [
              WorkBrief.format(brief) ?? "Current Work Brief cleared.",
              ...(notes.length ? [["## Brief removals", ...notes].join("\n")] : []),
            ].join("\n\n"),
            metadata: notes.length
              ? {
                  brief,
                  removals: {
                    constraints: { removed: constraints.removed, unmatched: constraints.unmatched },
                    confirmedDecisions: { removed: confirmedDecisions.removed, unmatched: confirmedDecisions.unmatched },
                  },
                }
              : { brief },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
