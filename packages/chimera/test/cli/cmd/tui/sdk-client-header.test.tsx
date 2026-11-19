/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider, useSDK, type EventSource } from "../../../../src/cli/cmd/tui/context/sdk"

const directory = "/tmp/chimera/packages/chimera"

const noopEvents: EventSource = {
  subscribe: async () => () => {},
}

function Probe(props: { onReady: (sdk: ReturnType<typeof useSDK>) => void }) {
  const sdk = useSDK()

  onMount(() => {
    props.onReady(sdk)
  })

  return <box />
}

async function mount(headers?: RequestInit["headers"]) {
  const requests: Headers[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(input instanceof Request ? input.headers : init?.headers))
    return new Response("[]", { headers: { "content-type": "application/json" } })
  }) as typeof globalThis.fetch

  let sdk!: ReturnType<typeof useSDK>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider
      url="http://test"
      directory={directory}
      fetch={fetch}
      headers={headers}
      events={noopEvents}
    >
      <Probe
        onReady={(ctx) => {
          sdk = ctx
          done()
        }}
      />
    </SDKProvider>
  ))

  await ready
  return { app, sdk, requests }
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("tui sdk client header", () => {
  test("sends the tui client header and preserves caller headers", async () => {
    const { app, sdk, requests } = await mount({ Authorization: "Basic user:secret" })

    try {
      await sdk.client.session.list().catch(() => {})
      await wait(() => requests.length > 0)

      expect(requests[0]?.get("x-chimera-client")).toBe("tui")
      expect(requests[0]?.get("Authorization")).toBe("Basic user:secret")
    } finally {
      app.renderer.destroy()
    }
  })
})