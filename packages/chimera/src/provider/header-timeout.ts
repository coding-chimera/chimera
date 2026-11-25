/**
 * Header-deadline plumbing for the provider fetch seam (G1).
 *
 * The header budget must measure the time from REQUEST SUBMISSION to response
 * headers — not from the caller's invocation. HttpLimit.wrapFetch therefore
 * applies withHeaderTimeout INNERMOST, after a permit is granted: queue wait
 * never consumes the header budget, and the controller is cleared the moment
 * headers arrive (fetch resolves) or the attempt fails.
 *
 * HeaderTimeoutError is defined here and re-exported by provider/error.ts, so
 * the session-layer classification is unchanged. The caller/chunk/total-deadline
 * signals are composed upstream and ride in through init.signal; this module
 * only adds the header signal via AbortSignal.any.
 */
import { unrefTimer } from "./http-queue"

/** Provider response headers timed out. Defined here rather than in error.ts so
 *  the header-timeout path never pulls in error.ts's `ai` dependency; error.ts
 *  re-exports this class, keeping its public identity (name/message) unchanged. */
export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

/** Abort with HeaderTimeoutError after ms; clear() cancels the deadline.
 *  Same semantics as the former provider-local helper; the timer is unref'd
 *  so it never keeps the process alive. */
export function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new HeaderTimeoutError(ms)), ms)
  unrefTimer(id)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

type Fetch = (input: any, init?: any) => Promise<Response>

/** Wrap fetch with a header deadline that starts AT CALL TIME. Pass
 *  false/undefined (or a non-number) to get the original function back —
 *  no controller, no signal injection, byte-identical behavior. */
export function withHeaderTimeout(fetchFn: Fetch, headerTimeoutMs: number | false | undefined): Fetch {
  if (typeof headerTimeoutMs !== "number") return fetchFn
  return async (input, init) => {
    const ctl = timeoutController(headerTimeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal
    try {
      return await fetchFn(input, { ...init, signal })
    } finally {
      ctl.clear()
    }
  }
}

export * as HeaderTimeout from "./header-timeout"