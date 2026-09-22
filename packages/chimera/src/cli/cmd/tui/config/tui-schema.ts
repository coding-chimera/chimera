import { Schema } from "effect"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigKeybinds } from "@/config/keybinds"
import { zodObject } from "@/util/effect-zod"

const OptionalString = Schema.optional(Schema.String)
const KeybindOverride = Schema.Struct(
  Object.fromEntries(Object.keys(ConfigKeybinds.Keybinds.shape).map((key) => [key, OptionalString])) as Record<
    keyof ConfigKeybinds.Keybinds,
    typeof OptionalString
  >,
)

const PromptSize = Schema.Int.check(Schema.isGreaterThan(0))

export const Prompt = Schema.Struct({
  max_height: Schema.optional(PromptSize).annotate({ description: "Prompt textarea max height" }),
  max_width: Schema.optional(Schema.Union([PromptSize, Schema.Literal("auto")])).annotate({
    description: "Home prompt max width: a positive integer for a fixed cap, or 'auto' to scale with terminal width",
  }),
}).annotate({ description: "Prompt size settings" })

export const TuiOptionsSchema = Schema.Struct({
  scroll_speed: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0)).annotate({ description: "TUI scroll speed" }),
  ),
  scroll_acceleration: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({ description: "Enable scroll acceleration" }),
    }).annotate({ description: "Scroll acceleration settings" }),
  ),
  diff_style: Schema.optional(
    Schema.Literals(["auto", "stacked"]).annotate({
      description: "Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column",
    }),
  ),
  mouse: Schema.optional(Schema.Boolean.annotate({ description: "Enable or disable mouse capture (default: true)" })),
  prompt: Schema.optional(Prompt),
})

export const TuiInfoSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String),
  keybinds: Schema.optional(KeybindOverride),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPlugin.Spec))),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  ...TuiOptionsSchema.fields,
})

export const TuiOptions = zodObject(TuiOptionsSchema)
export const TuiInfo = zodObject(TuiInfoSchema).strict()
