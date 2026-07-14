export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import z from "zod"
import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable Chimera cross-session memory. Defaults to false.",
  }),
  use_memories: Schema.optional(Schema.Boolean).annotate({
    description: "Inject cross-session memory when memory is enabled. Defaults to true.",
  }),
  generate_memories: Schema.optional(Schema.Boolean).annotate({
    description: "Allow Chimera to generate or update cross-session memory. Defaults to true.",
  }),
  disable_on_external_context: Schema.optional(Schema.Boolean).annotate({
    description: "Skip automatic memory generation for sessions containing external context. Defaults to true.",
  }),
  dedicated_tools: Schema.optional(Schema.Boolean).annotate({
    description:
      "Expose agent-facing memory tools (memory_remember, memory_list, memory_forget, memory_read) when memory is enabled. Defaults to false."
  }),
  max_summary_chars: Schema.optional(PositiveInt).annotate({
    description: "Limit for injected memory summary characters. Defaults to 12000."
  }),
}).pipe(
  withStatics((s) => ({
    zod: (zod(s) as unknown as z.ZodObject).strict() as z.ZodType<Schema.Schema.Type<typeof s>>,
  })),
)

export type Info = Schema.Schema.Type<typeof Info>

export const Defaults = {
  enabled: false,
  use_memories: true,
  generate_memories: true,
  disable_on_external_context: true,
  dedicated_tools: false,
} satisfies Pick<
  Required<Info>,
  "enabled" | "use_memories" | "generate_memories" | "disable_on_external_context" | "dedicated_tools"
>
