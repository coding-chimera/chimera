export * as ConfigBrowser from "./browser"
import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Info = Schema.Struct({
  headless: Schema.optional(Schema.Boolean).annotate({
    description:
      "Launch browser-tool browsers headless (default true). Set false to launch a headed browser the user can watch and intervene in. The browser_open tool's headless parameter overrides this, and this overrides CHIMERA_BROWSER_HEADLESS.",
  }),
})
  .annotate({ identifier: "BrowserConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>
