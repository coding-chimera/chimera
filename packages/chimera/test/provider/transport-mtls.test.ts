/**
 * Native-transport mTLS (stage2): client certificates, rejection without one,
 * and configureTls identity-pairing validation.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { NativeTransport } from "@/provider/sdk/native-transport"
import { NativeTransportLoader } from "@/provider/sdk/native-transport/loader"
import {
  caProfile,
  clearTransportEnv,
  clientCert,
  clientKey,
  makeFallback,
  nativeFetch,
  postInit,
  startMtls,
  tlsAddonAvailable,
} from "./fixtures/transport/helpers"

const AVAILABLE = tlsAddonAvailable()
const it = AVAILABLE ? test : test.skip

let restoreEnv: () => void = () => {}

beforeEach(() => {
  restoreEnv = clearTransportEnv()
  NativeTransportLoader.resetTransportForTests()
})

afterEach(() => {
  NativeTransportLoader.resetTransportForTests()
  restoreEnv()
})

it("a client certificate completes the mTLS handshake", async () => {
  const server = await startMtls()
  try {
    const profileId = caProfile({ certPem: clientCert, keyPem: clientKey })
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const response = await fetchFn(server.url("/x"), postInit())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("mtls-ok")
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("without a client certificate the mTLS server rejects the handshake", async () => {
  const server = await startMtls()
  try {
    const profileId = caProfile()
    const fallback = makeFallback()
    const fetchFn = nativeFetch(profileId, undefined, fallback.fn)
    const error = await fetchFn(server.url("/x"), postInit()).then(
      () => undefined,
      (failure) => failure,
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
    expect(fallback.calls.length).toBe(0)
  } finally {
    server.close()
  }
})

it("configureTls rejects a certificate without a key and a key without a certificate", () => {
  expect(() => NativeTransport.configureTls({ certPem: clientCert })).toThrow(/requires a private key/)
  expect(() => NativeTransport.configureTls({ keyPem: clientKey })).toThrow(/requires a client certificate/)
})