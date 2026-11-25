/**
 * Response metadata carry — url/redirected/type survive Response rebuilds.
 *
 * Every layer that rebuilds a Response around a body (the native transport
 * adapter, HttpLimit's permit-holding wrapper, the provider SSE watchdog
 * wrapper) must carry the previous layer's metadata forward, or the final
 * consumer sees a blank url and a lost redirected flag. This module is the
 * single shared mechanism: standalone, importing nothing from either
 * consumer, so http-limit never depends on native-transport.
 *
 * url/redirected/type are prototype getters on a fresh Response; own
 * properties shadow them, and clone() is wrapped so clones (and their
 * clones) keep the metadata while native tee/bodyUsed semantics survive.
 */

export type Metadata = {
  url: string
  redirected: boolean
  type: Response["type"]
}

/** The effective metadata of a response (own overrides or prototype defaults). */
export function metadataOf(response: Response): Metadata {
  return { url: response.url, redirected: response.redirected, type: response.type }
}

/** Attach metadata to a response instance, clone-chain included. */
export function withMetadata(response: Response, meta: Metadata): Response {
  Object.defineProperty(response, "url", { value: meta.url, configurable: true })
  Object.defineProperty(response, "redirected", { value: meta.redirected, configurable: true })
  Object.defineProperty(response, "type", { value: meta.type, configurable: true })
  const clone = response.clone.bind(response)
  response.clone = () => withMetadata(clone(), meta)
  return response
}

/** Carry one response's metadata onto a rebuilt response. */
export function carry(source: Response, target: Response): Response {
  return withMetadata(target, metadataOf(source))
}

export * as ResponseMetadata from "./response-metadata"