export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable Chimera cross-session memory. Defaults to false.",
  }),
  use_memories: Schema.optional(Schema.Boolean).annotate({
    description: "Inject cross-session memory summaries into new turns when memory is enabled. Defaults to true.",
  }),
  generate_memories: Schema.optional(Schema.Boolean).annotate({
    description: "Allow Chimera to generate or update memory files from safe, explicit memory directives. Defaults to true.",
  }),
  dedicated_tools: Schema.optional(Schema.Boolean).annotate({
    description: "Expose dedicated memory tools when implemented. Defaults to false.",
  }),
  disable_on_external_context: Schema.optional(Schema.Boolean).annotate({
    description: "Skip memory generation for sessions that used external context sources. Defaults to true.",
  }),
  max_summary_chars: Schema.optional(PositiveInt).annotate({
    description: "Maximum characters of memory_summary.md to inject into a prompt. Defaults to 12000.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
