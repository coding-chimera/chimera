export const PUBLIC_UI_PATHS = new Set<string>([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  return pathname.startsWith("/assets/")
}
