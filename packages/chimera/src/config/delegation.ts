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

export const Info = Schema.Struct({
  model_profiles: Schema.optional(Schema.Record(Schema.String, ModelProfile)),
  routes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
  .annotate({ identifier: "DelegationConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>
