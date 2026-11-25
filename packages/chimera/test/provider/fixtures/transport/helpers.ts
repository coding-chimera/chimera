/**
 * Shared hermetic fixtures for the native-transport https/TLS stage2 tests.
 *
 * Everything here is test-only: throwaway PEMs under this directory, local
 * 127.0.0.1 servers on ephemeral ports, and a child-process runner for the
 * env-before-start surfaces (env CA roots, system proxy) that the crate reads
 * once at module init. No external network is touched.
 */

import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import http2 from "node:http2"
import https from "node:https"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import type { StatsSnapshot } from "@/provider/sdk/native-transport/layout"

export const DIR = import.meta.dirname
export const PACKAGE_ROOT = path.resolve(DIR, "..", "..", "..", "..")
export const INDEX_PATH = path.join(PACKAGE_ROOT, "src", "provider", "sdk", "native-transport", "index.ts")
export const LOADER_PATH = path.join(PACKAGE_ROOT, "src", "provider", "sdk", "native-transport", "loader.ts")
export const CHILD_SCRIPT = path.join(DIR, "env-child-fetch.ts")

export const caPem = fs.readFileSync(path.join(DIR, "ca.pem"), "utf8")
export const serverCert = fs.readFileSync(path.join(DIR, "server.pem"), "utf8")
export const serverKey = fs.readFileSync(path.join(DIR, "server-key.pem"), "utf8")
export const clientCert = fs.readFileSync(path.join(DIR, "client.pem"), "utf8")
export const clientKey = fs.readFileSync(path.join(DIR, "client-key.pem"), "utf8")

/** The server cert's SAN is DNS:localhost,IP:127.0.0.1. */
export const SERVER_NAME = "localhost"

/** Proxy + trust env keys that change transport behavior per process. */
export const TRANSPORT_ENV_KEYS = [
  "OPENCODE_RUST_TRANSPORT",
  "OPENCODE_RUST_TRANSPORT_PATH",
  "OPENCODE_RUST_TRANSPORT_CA_FILE",
  "OPENCODE_RUST_TRANSPORT_DEBUG",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

/** Save/clear the transport env keys; returns a restore function. */
export function clearTransportEnv(): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const key of TRANSPORT_ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** True when the real addon is loadable AND advertises the TLS stage2 floor. */
export function tlsAddonAvailable(): boolean {
  NativeTransportLoader.resetTransportForTests()
  const addon = NativeTransportLoader.getTransport()
  if (addon === null) return false
  const capabilities = addon.contractInfo().capabilities
  return capabilities.includes("tls") && capabilities.includes("tls-custom-ca") && capabilities.includes("mtls")
}

/** Real addon data plane. Every test that uses this is gated on availability. */
export function nativeFetch(profileId = 0, httpVersion?: "auto" | "http1", fallback: typeof fetch = realFallback()) {
  return NativeTransport.resolveFetch({ enabled: true, fallback, tlsProfile: profileId, httpVersion })
}

/** A fallback spy: any delegation is observable and never silently succeeds. */
export function makeFallback() {
  const calls: Array<{ input: unknown; init: unknown }> = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response("FALLBACK")
  }) as unknown as typeof fetch
  return { fn, calls }
}

function realFallback() {
  return (async () => new Response("FALLBACK")) as unknown as typeof fetch
}

/** Configure a CA-trust profile from `caPem` alone.
 *
 * The crate keeps OS platform trust primary and adds the explicit CA as an
 * extra anchor with a webpki extra-roots fallback, so a CA-signed server is
 * trusted on every platform (including darwin's SecTrust leaf-validity policy)
 * without needing a `serverName` override. */
export function caProfile(extra: Record<string, unknown> = {}) {
  const result = NativeTransport.configureTls({ caPem, ...extra })
  if (result === null) throw new Error("configureTls returned null: the TLS-capable addon is not loaded")
  return result.profileId
}

/** Configure the explicit serverName-override path (preconfigured rustls
 *  profile; platform trust is not used). Kept separate from `caProfile`. */
export function serverNameProfile(extra: Record<string, unknown> = {}) {
  const result = NativeTransport.configureTls({ caPem, serverName: SERVER_NAME, ...extra })
  if (result === null) throw new Error("configureTls returned null: the TLS-capable addon is not loaded")
  return result.profileId
}

export type StatsDelta = { protocol: number; route: number; postSend: number; cancelled: number }

export function statsNow(): StatsSnapshot {
  const snapshot = NativeTransport.stats()
  if (snapshot === null) throw new Error("stats() is null: the addon is not loaded")
  return snapshot
}

export function statsDelta(before: StatsSnapshot, after: StatsSnapshot): StatsDelta {
  return {
    protocol: (after.protocolFallbacks ?? 0) - (before.protocolFallbacks ?? 0),
    route: (after.routeFallbacks ?? 0) - (before.routeFallbacks ?? 0),
    postSend: after.postSendErrors - before.postSendErrors,
    cancelled: after.cancelledHandles - before.cancelledHandles,
  }
}

export function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error) => error,
  )
}

/** Deterministic POST init for model-call-shaped requests. Bodyless GET/HEAD
 *  requests ride the addon too now (the adapter sends `body: undefined`, which
 *  the napi ABI accepts); this helper just keeps the POST cases uniform. */
export function postInit(body = "{}"): RequestInit {
  return { method: "POST", body, headers: { "content-type": "application/json" } }
}

// ---------------------------------------------------------------------------
// Hermetic servers
// ---------------------------------------------------------------------------

export type Server = {
  port: number
  url: (pathname?: string) => string
  close: () => void
}

export function startHttp1Tls(fetchHandler: (req: Request) => Response | Promise<Response>): Server {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: serverCert, key: serverKey },
    fetch: fetchHandler,
  })
  const port = server.port
  if (port === undefined) throw new Error("https server did not bind a TCP port")
  return {
    port,
    url: (pathname = "/") => `https://${SERVER_NAME}:${port}${pathname}`,
    close: () => {
      server.stop(true)
    },
  }
}

type H2StreamHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void

export type H2Server = Server & {
  /** ALPN protocol per accepted TLS session (in order). */
  alpn: string[]
  /** Number of h2 sessions (connection reuse is observable as sessions < streams). */
  sessions: () => number
}

export async function startH2(options: { handler?: H2StreamHandler; onSession?: (session: http2.ServerHttp2Session) => void } = {}): Promise<H2Server> {
  const server = http2.createSecureServer({ cert: serverCert, key: serverKey, allowHTTP1: false })
  const alpn: string[] = []
  let sessions = 0
  server.on("session", (session) => {
    sessions += 1
    alpn.push(String(session.alpnProtocol))
    options.onSession?.(session)
  })
  server.on("stream", (stream, headers) => {
    if (options.handler) return options.handler(stream, headers)
    stream.respond({ ":status": 200, "content-type": "text/plain" })
    stream.end("h2-ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("h2 server did not bind a TCP port")
  return {
    port: address.port,
    url: (pathname = "/") => `https://${SERVER_NAME}:${address.port}${pathname}`,
    alpn,
    sessions: () => sessions,
    close: () => {
      server.close()
    },
  }
}

export type BrokenServer = Server & { received: () => number }

/** Accepts the request, sends headers + a partial body, then destroys the socket. */
export async function startBrokenMidStream(delayMs = 25): Promise<BrokenServer> {
  let received = 0
  const server = https.createServer({ cert: serverCert, key: serverKey }, (req, res) => {
    received += 1
    req.on("data", () => {})
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("PARTIAL")
      setTimeout(() => {
        res.socket?.destroy()
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("https server did not bind a TCP port")
  return {
    port: address.port,
    url: (pathname = "/") => `https://${SERVER_NAME}:${address.port}${pathname}`,
    received: () => received,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

/** HTTPS server that requires a client certificate signed by the test CA. */
export async function startMtls(): Promise<Server> {
  const server = https.createServer(
    { cert: serverCert, key: serverKey, requestCert: true, rejectUnauthorized: true, ca: [caPem] },
    (req, res) => {
      req.on("data", () => {})
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("mtls-ok")
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("mtls server did not bind a TCP port")
  return {
    port: address.port,
    url: (pathname = "/") => `https://${SERVER_NAME}:${address.port}${pathname}`,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

export type ConnectProxy = { port: number; url: string; connects: () => number; close: () => void }

/** Minimal HTTP CONNECT tunnel proxy; counts the tunnels it establishes. */
export async function startConnectProxy(): Promise<ConnectProxy> {
  let connects = 0
  const server = net.createServer((client) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n\r\n")
      if (end === -1) return
      const requestLine = buffered.subarray(0, end).toString().split("\r\n")[0] ?? ""
      const target = requestLine.split(" ")[1] ?? ""
      const separator = target.lastIndexOf(":")
      if (separator === -1) {
        client.destroy()
        return
      }
      connects += 1
      const host = target.slice(0, separator)
      const port = Number(target.slice(separator + 1))
      const upstream = net.connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        const rest = buffered.subarray(end + 4)
        if (rest.length > 0) upstream.write(rest)
        client.removeListener("data", onData)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    }
    client.on("data", onData)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("proxy did not bind a TCP port")
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    connects: () => connects,
    close: () => {
      server.close()
    },
  }
}

/** Parse the ALPN protocol list from a (possibly incomplete) TLS ClientHello.
 *  Returns null while more bytes are needed, [] when there is no ALPN list. */
function clientHelloAlpn(buffer: Buffer): string[] | null {
  if (buffer.length < 5) return null
  if (buffer[0] !== 22) return []
  const recordLength = buffer.readUInt16BE(3)
  if (buffer.length < 5 + recordLength) return null
  const handshake = buffer.subarray(5, 5 + recordLength)
  if (handshake.length < 4 || handshake[0] !== 1) return []
  const handshakeLength = (handshake[1]! << 16) | (handshake[2]! << 8) | handshake[3]!
  if (handshake.length < 4 + handshakeLength) return null
  let offset = 4 + 2 + 32
  offset += 1 + (handshake[offset] ?? 0) // session id
  const cipherLength = handshake.readUInt16BE(offset)
  offset += 2 + cipherLength
  offset += 1 + (handshake[offset] ?? 0) // compression methods
  if (offset + 2 > handshake.length) return []
  const extensionsLength = handshake.readUInt16BE(offset)
  offset += 2
  const end = Math.min(offset + extensionsLength, handshake.length)
  while (offset + 4 <= end) {
    const type = handshake.readUInt16BE(offset)
    const length = handshake.readUInt16BE(offset + 2)
    offset += 4
    if (offset + length > end) break
    if (type === 16) {
      const protocols: string[] = []
      let cursor = offset + 2
      const listEnd = Math.min(cursor + handshake.readUInt16BE(offset), offset + length)
      while (cursor < listEnd) {
        const size = handshake[cursor] ?? 0
        cursor += 1
        protocols.push(handshake.subarray(cursor, cursor + size).toString())
        cursor += size
      }
      return protocols
    }
    offset += length
  }
  return []
}

export type AlpnRstProxy = { port: number; url: (pathname?: string) => string; rsts: () => number; close: () => void }

/** TCP-level ALPN-aware front: destroys any ClientHello that offers h2 and
 *  tunnels everything else to the real http1 TLS server. This is the only
 *  hermetic way to produce a genuine pre-send h2 connect failure that the
 *  http1 retry can then succeed against. */
export async function startAlpnRstProxy(targetPort: number): Promise<AlpnRstProxy> {
  let rsts = 0
  const server = net.createServer((client) => {
    let buffered = Buffer.alloc(0)
    let decided = false
    const onData = (chunk: Buffer) => {
      if (decided) return
      buffered = Buffer.concat([buffered, chunk])
      const protocols = clientHelloAlpn(buffered)
      if (protocols === null) return
      decided = true
      client.removeListener("data", onData)
      if (protocols.includes("h2")) {
        rsts += 1
        client.destroy()
        return
      }
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        upstream.write(buffered)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    }
    client.on("data", onData)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("alpn proxy did not bind a TCP port")
  return {
    port: address.port,
    url: (pathname = "/") => `https://${SERVER_NAME}:${address.port}${pathname}`,
    rsts: () => rsts,
    close: () => {
      server.close()
    },
  }
}

/** A port that is guaranteed closed (bind, read, release). */
export async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("probe server did not bind a TCP port")
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

// ---------------------------------------------------------------------------
// Child-process runner for env-before-start surfaces
// ---------------------------------------------------------------------------

export type ChildResult = {
  ok: boolean
  status?: number
  text?: string
  error?: string
  cause?: string
  delta?: StatsDelta
  stdout: string
  stderr: string
  code: number
}

/** Run the env-fetch child with an explicit env; env must be set before spawn
 *  because the crate harvests trust/proxy state once at module init.
 *  `profile: "env"` uses profile 0 so only env CA roots can trust the peer;
 *  `profile: "ca"` (default) registers an explicit caPem profile. */
export async function runEnvChild(
  url: string,
  env: Record<string, string>,
  profile: "ca" | "env" = "ca",
): Promise<ChildResult> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(TRANSPORT_ENV_KEYS as readonly string[]).includes(key)) base[key] = value
  }
  const proc = Bun.spawn([process.execPath, CHILD_SCRIPT], {
    cwd: PACKAGE_ROOT,
    env: {
      ...base,
      CHILD_INDEX: INDEX_PATH,
      CHILD_LOADER: LOADER_PATH,
      CHILD_CA: path.join(DIR, "ca.pem"),
      CHILD_SERVER_NAME: SERVER_NAME,
      CHILD_PROFILE: profile,
      CHILD_URL: url,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("CHILD_JSON:"))
  if (!line) return { ok: false, error: "child produced no result", stdout, stderr, code }
  const parsed = JSON.parse(line.slice("CHILD_JSON:".length)) as Omit<ChildResult, "stdout" | "stderr" | "code">
  return { ...parsed, stdout, stderr, code }
}