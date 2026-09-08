export * as ConfigDelegation from "./delegation"
import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { ConfigModelID } from "./model-id"
import { PositiveInt, withStatics } from "@/util/schema"

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_MAX_CONCURRENT = 128
export const DEFAULT_BACKGROUND_SUBAGENTS = true
export const DEFAULT_BACKGROUND_CONCURRENT = 16

export const ModelProfile = Schema.Struct({
  model: ConfigModelID.annotate({
    description: "Model to use for this delegation profile in the format of provider/model, eg anthropic/claude-2",
  }),
  variant: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})
  .annotate({ identifier: "DelegationModelProfile" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ModelProfile = Schema.Schema.Type<typeof ModelProfile>

export const SchedulingArchetype = Schema.Struct({
  description: Schema.optional(Schema.String),
  minQuality: Schema.optional(Schema.Number),
  effortCap: Schema.optional(Schema.String),
  maxSizeClass: Schema.optional(Schema.Literals(["S", "M", "L", "XL"])),
  minSizeClass: Schema.optional(Schema.Literals(["S", "M", "L", "XL"])),
  weights: Schema.optional(
    Schema.Struct({
      quality: Schema.Number,
      speed: Schema.Number,
      cost: Schema.Number,
      size: Schema.optional(Schema.Number),
    }),
  ),
  budgetUsdPerWorker: Schema.optional(Schema.Number),
  excludeModels: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Exact model routes (provider/modelID), model identities, or provider IDs excluded from this workload archetype. Excluded routes never become scheduler candidates for this workload, and a dispatch declaring this workload with an excluded model fails unless it resumes an existing session. Other workloads are unaffected.",
  }),
})
export type SchedulingArchetype = Schema.Schema.Type<typeof SchedulingArchetype>

export const Scheduling = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  spend: Schema.optional(Schema.Literals(["subscription-first", "metered-first"])),
  quotaFloorPercent: Schema.optional(Schema.Number),
  quotaStrainPercent: Schema.optional(Schema.Number),
  rlStrainThreshold: Schema.optional(Schema.Number),
  archetypes: Schema.optional(Schema.Record(Schema.String, SchedulingArchetype)),
  overrides: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        billing: Schema.optional(Schema.Literals(["metered", "subscription", "free", "unknown"])),
      }),
    ),
  ),
  topTierDisabledMinSizeClass: Schema.optional(Schema.Literals(["S", "M", "L", "XL"])),
  capability_anchors: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        score: Schema.Number,
        tier: Schema.optional(Schema.String),
        uncertainty: Schema.optional(Schema.Number),
      }),
    ),
  ).annotate({
    description:
      "User-supplied capability anchors for the subagent scheduler, keyed by model identity. Each entry sets the model's quality score (0..1) at the given reasoning tier (default \"max\"); identities match exactly or as a dash prefix for versioned model ids, and entries take precedence over the built-in anchors so newly released models can be scheduled without a code update.",
  }),
})
  .annotate({ identifier: "DelegationScheduling" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Scheduling = Schema.Schema.Type<typeof Scheduling>

export const Info = Schema.Struct({
  model_profiles: Schema.optional(Schema.Record(Schema.String, ModelProfile)),
  routes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  scheduling: Schema.optional(Scheduling),
  max_depth: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum delegation chain depth including the root session (default 3 = root -> subagent -> subagent). Sessions at the depth cap cannot dispatch further subagents.",
  }),
  max_concurrent: Schema.optional(PositiveInt).annotate({
    description:
      "Runtime-wide budget of concurrently running subagents (default 128). New dispatches queue when the budget is exhausted; subagents waiting on their own children do not consume budget.",
  }),
  background_subagents: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable background subagents (default true). Turning this off is a kill-switch: background dispatch falls back to synchronous delegation behavior.",
  }),
  background_concurrent: Schema.optional(PositiveInt).annotate({
    description:
      "Independent cap on concurrently running background jobs (default 16). Jobs at the cap are rejected with an error rather than queued, so background work cannot crowd out the delegation.max_concurrent budget.",
  }),
})
  .annotate({ identifier: "DelegationConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>
