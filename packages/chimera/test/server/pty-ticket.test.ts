import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AuthMiddleware } from "../../src/server/middleware"
import {
  PTY_CONNECT_PATH,
  PTY_CONNECT_TICKET_QUERY,
  hasPtyConnectTicketURL,
  isPtyConnectPath,
} from "../../src/server/shared/pty-ticket"

describe("pty connect path checks", () => {
  test("matches the registered connect route", () => {
    expect(PTY_CONNECT_PATH).toBe("/pty/:ptyID/connect")
    expect(isPtyConnectPath("/pty/abc/connect")).toBe(true)
    expect(isPtyConnectPath("/pty/" + "x".repeat(64) + "/connect")).toBe(true)
  })

  test("requires a ticket query for the URL helper", () => {
    expect(hasPtyConnectTicketURL(new URL("http://localhost/pty/abc/connect?ticket=t"))).toBe(true)
    expect(hasPtyConnectTicketURL(new URL("http://localhost/pty/abc/connect"))).toBe(false)
    expect(hasPtyConnectTicketURL(new URL("http://localhost/pty/abc/connect?other=1"))).toBe(false)
  })

  test("rejects suffix, case, boundary and unrelated paths", () => {
    for (const path of [
      "/pty/abc/connect/",
      "/pty/abc/connect/extra",
      "/pty/abc/connect%2Fextra",
      "/PTY/abc/connect",
      "/pty/abc/CONNECT",
      "/pty/abc/connect-token",
      "/pty//connect",
      "/pty/a/b/connect",
      "/pty/abc",
      "/pty%2Fabc/connect",
      "/api/pty/abc/connect",
    ])
      expect(isPtyConnectPath(path), path).toBe(false)
  })
})

const original = {
  password: Flag.OPENCODE_SERVER_PASSWORD,
  username: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  Flag.OPENCODE_SERVER_USERNAME = original.username
})

describe("Hono AuthMiddleware PTY connect skip", () => {
  test("skips credentials for a ticketed connect path and enforces otherwise", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "chimera"
    const app = new Hono()
      .use(AuthMiddleware)
      .get(PTY_CONNECT_PATH, (c) => c.text("connect"))
      .get("/probe", (c) => c.text("probe"))

    const ticketed = await app.request(`/pty/abc/connect?${PTY_CONNECT_TICKET_QUERY}=opaque`)
    expect(ticketed.status).toBe(200)
    expect(await ticketed.text()).toBe("connect")

    const unticketed = await app.request("/pty/abc/connect")
    expect(unticketed.status).toBe(401)

    const otherRoute = await app.request(`/probe?${PTY_CONNECT_TICKET_QUERY}=opaque`)
    expect(otherRoute.status).toBe(401)

    const authorized = await app.request("/pty/abc/connect", {
      headers: { authorization: `Basic ${Buffer.from("chimera:secret").toString("base64")}` },
    })
    expect(authorized.status).toBe(200)
  })
})
