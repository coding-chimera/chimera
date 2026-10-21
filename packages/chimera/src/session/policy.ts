/**
 * Shared marker for a hard tool-policy violation raised inside a tool worker.
 *
 * Tool implementations (for example the shell worker) throw this instead of
 * rejecting a permission ask: a policy violation is terminal for the current
 * run, whereas a permission rejection is a soft stop whose continuation is
 * configurable via `experimental.continue_loop_on_deny`.
 *
 * The processor identifies the error by type/marker rather than by parsing the
 * error message, so wrapping (Effect causes, AI SDK tool errors) cannot change
 * the termination behavior.
 */
export class AstraToolPolicyViolation extends Error {
  readonly _tag = "AstraToolPolicyViolation"
  readonly tool: string | undefined

  constructor(input: { message: string; tool?: string; cause?: unknown }) {
    super(input.message, { cause: input.cause })
    this.name = "AstraToolPolicyViolation"
    this.tool = input.tool
  }

  static is(value: unknown): value is AstraToolPolicyViolation {
    if (value instanceof AstraToolPolicyViolation) return true
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { _tag?: unknown })._tag === "AstraToolPolicyViolation"
    )
  }
}

export * as SessionPolicy from "./policy"