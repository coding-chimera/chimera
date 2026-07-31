/**
 * Cooperative yielding for long synchronous resolution spans.
 *
 * Reference resolution and callback-edge synthesis run on the host runtime's
 * MAIN thread — unlike parsing, which runs off-thread. Inside the agent
 * runtime a long unyielded span freezes the event loop: CLI progress stops
 * rendering, the MCP daemon stops answering, and the agent's own tool loop
 * stalls. On a large repo, resolving refs + synthesizing edges legitimately
 * runs for minutes, so a span that never yields starves every other consumer.
 *
 * `createYielder` returns a `maybeYield()` that yields (via `setImmediate`)
 * only once more than `budgetMs` of wall-clock has elapsed since the last
 * yield, so fast repos pay essentially nothing while slow ones give the event
 * loop a regular window to breathe. Call it at natural boundaries in a long
 * loop (between references, between persistence chunks).
 *
 * This does NOT weaken correctness: a genuinely wedged loop — an infinite or
 * non-terminating span — never reaches a yield point, so it stays stuck (and
 * any outer watchdog still sees it). We only stop starving work that is
 * demonstrably making progress.
 */

/** Yield when more than `budgetMs` of wall-clock has passed since the last yield. */
export type MaybeYield = () => Promise<void>;

/** Default budget: small enough that the event loop always gets a chance to run. */
export const DEFAULT_YIELD_BUDGET_MS = 250;

export function createYielder(budgetMs: number = DEFAULT_YIELD_BUDGET_MS): MaybeYield {
  let last = Date.now();
  return async function maybeYield(): Promise<void> {
    if (Date.now() - last < budgetMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = Date.now();
  };
}
