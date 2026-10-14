import open from "open"

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

/**
 * Parse a URL that is safe to hand to the OS browser opener.
 * Returns undefined for unparseable input or any scheme other than http/https.
 */
export function browserUrl(input: string): URL | undefined {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || !ALLOWED_PROTOCOLS.has(url.protocol)) return undefined
  return url
}

export function openUrl(input: string) {
  const url = browserUrl(input)
  if (!url) return Promise.reject(new Error(`Only http and https links can be opened in the browser: ${input}`))
  return open(url.href)
}