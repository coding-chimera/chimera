export * as ConfigDiagnostics from "./diagnostics"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const DEFAULT_DEDUPE = true
export const DEFAULT_CROSS_FILE = true
export const DEFAULT_LATE = true
export const DEFAULT_INLINE_BUDGET_MS = 800

export const Info = Schema.Struct({
  dedupe: Schema.optional(Schema.Boolean).annotate({
    description:
      "Deduplicate post-mutation LSP diagnostics against what was already shown to the model in this session (default true). When false, every mutation re-renders the full diagnostics for the touched files exactly as before. Display only: oracle evidence always records the full diagnostics.",
  }),
  crossFile: Schema.optional(Schema.Boolean).annotate({
    description:
      "Push fresh LSP errors from files the mutation did not touch: other-files block, inline details under propagation probe entries, with predesign-declared and probe-rendered files filtered out (default true). When false, only the touched files' own diagnostics render. Display only: oracle evidence always records the full diagnostics.",
  }),
  late: Schema.optional(Schema.Boolean).annotate({
    description:
      "Record late-arriving post-mutation LSP diagnostics as a deferred oracle when the inline wait budget expires (default true). A detached fiber keeps waiting up to ~12s total; results are dropped entirely if the file is mutated again meanwhile, and a failing late oracle surfaces next turn via Linked Verification Evidence. When false, an inline budget timeout means no diagnostics and no oracle record for that mutation.",
  }),
  inlineBudgetMs: Schema.optional(Schema.Number).annotate({
    description:
      "Inline wait budget in milliseconds for fresh post-mutation LSP diagnostics before the tool returns without a diagnostics block (default 800). Fresh results within budget render exactly as before; on timeout the late path (diagnostics.late) carries the wait.",
  }),
})
  .annotate({ identifier: "DiagnosticsConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>
