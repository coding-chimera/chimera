export const PUBLIC_UI_PATHS = new Set<string>([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  "/manifest.json",
  "/opencode.svg",
  "/notification-sw.js",
  "/404.html",
])

const PUBLIC_UI_PREFIXES = ["/assets/", "/material-icons/"]

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  return PUBLIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
