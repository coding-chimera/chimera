export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-chimera-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

// Single source of truth for the PTY connect route path. The route group
// registers its endpoint with this constant and the Effect authorization
// middleware compares the Effect-matched route path against it, so
// authorization and dispatch cannot disagree about which request is the
// ticketed connect route.
export const PTY_CONNECT_PATH = "/pty/:ptyID/connect"

// The legacy Hono authorization middleware cannot read the Effect-matched
// route, so it keeps a pathname check. The pattern is derived from
// PTY_CONNECT_PATH so both route trees share one source of truth.
const PTY_CONNECT_URL = new RegExp(`^${connectPathToRegExpSource(PTY_CONNECT_PATH)}$`)

function connectPathToRegExpSource(template: string) {
  return template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/")
}

// Legacy Hono auth skips Basic Auth when this matches; the PTY connect handler
// is then responsible for validating the ticket.
export function isPtyConnectPath(pathname: string) {
  return PTY_CONNECT_URL.test(pathname)
}

export function hasPtyConnectTicketURL(url: URL) {
  return isPtyConnectPath(url.pathname) && !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
}
