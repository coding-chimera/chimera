/**
 * SSE chunk watchdog for the provider fetch seam — moved verbatim from
 * provider.ts so tests and other consumers can import it without loading the
 * full provider module graph. Behavior is unchanged: a per-read deadline
 * aborts the upstream reader and errors the wrapped stream; response
 * metadata is carried through the Response rebuild.
 *
 * The timeout error is deliberately named "TimeoutError": chimera runs
 * @ai-sdk/openai-compatible >= 2.0.70 (2.0.87), whose response-body wrapper
 * rethrows TimeoutError-named errors unchanged and masks other read errors —
 * that naming fix is preserved here.
 */

import { ResponseMetadata } from "./response-metadata"

export function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          // @ai-sdk/openai-compatible >= 2.0.70 flags a stream that ends with
          // no finish reason as truncated and enqueues InvalidResponseDataError
          // at flush. Its response-body wrapper also rewraps non-abort read
          // errors into APICallError("Failed to process successful response"),
          // masking the timeout identity. Naming the error TimeoutError (a real
          // timeout, not a user abort) makes the wrapper rethrow it unchanged,
          // so the consumer sees "SSE read timed out" while genuine truncation
          // still hits the SDK check.
          const err = new Error("SSE read timed out")
          err.name = "TimeoutError"
          ctl.abort(err)
          reader.cancel(err).catch(() => {})
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return ResponseMetadata.carry(res, new Response(body, { headers: new Headers(res.headers), status: res.status, statusText: res.statusText }))
}

export * as Sse from "./sse"