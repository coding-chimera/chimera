export * as ConfigDelegation from "./delegation"
import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { ConfigModelID } from "./model-id"

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
  weights: Schema.optional(
    Schema.Struct({
      quality: Schema.Number,
      speed: Schema.Number,
      cost: Schema.Number,
    }),
  ),
  budgetUsdPerWorker: Schema.optional(Schema.Number),
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
})
  .annotate({ identifier: "DelegationScheduling" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Scheduling = Schema.Schema.Type<typeof Scheduling>

export const Info = Schema.Struct({
  model_profiles: Schema.optional(Schema.Record(Schema.String, ModelProfile)),
  routes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  scheduling: Schema.optional(Scheduling),
})
  .annotate({ identifier: "DelegationConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>
