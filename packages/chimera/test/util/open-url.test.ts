import { describe, expect, test, mock, beforeEach } from "bun:test"

let openedWith: string | undefined

void mock.module("open", () => ({
  default: async (url: string) => {
    openedWith = url
    return { on() {}, once() {}, kill() {} }
  },
}))

const { openUrl, browserUrl } = await import("../../src/util/open-url")

beforeEach(() => {
  openedWith = undefined
})

describe("browserUrl", () => {
  test("accepts http and https URLs", () => {
    expect(browserUrl("https://example.com/path?q=1")?.href).toBe("https://example.com/path?q=1")
    expect(browserUrl("http://127.0.0.1:8080/authorize")?.href).toBe("http://127.0.0.1:8080/authorize")
  })

  test("rejects values that are not URLs", () => {
    expect(browserUrl("not a url")).toBeUndefined()
    expect(browserUrl("")).toBeUndefined()
  })

  test("rejects non-http schemes", () => {
    expect(browserUrl("file:///etc/hosts")).toBeUndefined()
    expect(browserUrl("javascript:alert(1)")).toBeUndefined()
    expect(browserUrl("ms-msdt:/id PCWDiagnostic")).toBeUndefined()
    expect(browserUrl("\\\\server\\share\\file.html")).toBeUndefined()
  })
})

describe("openUrl", () => {
  test("forwards http and https links to the browser opener", async () => {
    await openUrl("https://example.com/")
    expect(openedWith).toBe("https://example.com/")
  })

  test("rejects values that are not URLs", async () => {
    await expect(openUrl("not a url")).rejects.toThrow("Only http and https links")
    await expect(openUrl("")).rejects.toThrow("Only http and https links")
    expect(openedWith).toBeUndefined()
  })

  test("rejects non-http schemes without opening", async () => {
    await expect(openUrl("file:///etc/hosts")).rejects.toThrow("Only http and https links")
    await expect(openUrl("javascript:alert(1)")).rejects.toThrow("Only http and https links")
    await expect(openUrl("ms-msdt:/id PCWDiagnostic")).rejects.toThrow("Only http and https links")
    await expect(openUrl("\\\\server\\share\\file.html")).rejects.toThrow("Only http and https links")
    expect(openedWith).toBeUndefined()
  })
})