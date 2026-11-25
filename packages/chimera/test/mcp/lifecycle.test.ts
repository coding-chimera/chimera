import { test, expect, mock, beforeEach } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listPromptsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  instructions?: string
  capabilities: { tools?: object; prompts?: object; resources?: object }
  clientOptions?: { capabilities?: { roots?: { listChanged?: boolean } } }
  closed: boolean
  requestHandlers: Map<unknown, (...args: any[]) => Promise<any>>
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listPromptsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      resourceTemplates: [],
      capabilities: { tools: {}, prompts: {}, resources: {} },
      closed: false,
      requestHandlers: new Map(),
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Options handed to the most recently constructed stdio transport.
let lastStdioOpts: any

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(opts: any) {
    lastStdioOpts = opts
  }
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Mock Client that delegates to per-name MockClientState
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_info: any, options?: MockClientState["clientOptions"]) {
      clientCreateCount++
      this._state = getOrCreateClientState(lastCreatedClientName)
      this._state.clientOptions = options
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setRequestHandler(schema: unknown, handler: (...args: any[]) => Promise<any>) {
      this._state.requestHandlers.set(schema, handler)
    }

    getServerCapabilities() {
      return this._state?.capabilities
    }

    getInstructions() {
      return this._state?.instructions
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state) this._state.listPromptsCalls++
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async listResourceTemplates() {
      return { resourceTemplates: this._state?.resourceTemplates ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { Command } = await import("../../src/command")
const { Skill } = await import("../../src/skill")
const { Config } = await import("../../src/config/config")
const { InstanceRef } = await import("../../src/effect/instance-ref")
const { provideTestInstance, tmpdir } = await import("../fixture/fixture")
const { WithInstance } = await import("../../src/project/with-instance")
const { InstanceRuntime } = await import("../../src/project/instance-runtime")

// --- Helper ---

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, never>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/chimera.json`,
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            mcp: config,
          }),
        )
      },
    })

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const ctx = Instance.current
        await Effect.runPromise(
          MCP.Service.use(fn).pipe(Effect.provide(MCP.defaultLayer), Effect.provideService(InstanceRef, ctx)),
        )
      },
    })
  }
}

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "my-server"
      const serverState = getOrCreateClientState("my-server")
      serverState.tools = [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ]

      // First: add the server successfully
      const addResult = yield* mcp.add("my-server", {
        type: "local",
        command: ["echo", "test"],
      })
      expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

      expect(serverState.listToolsCalls).toBe(1)

      const toolsA = yield* mcp.tools()
      const toolsB = yield* mcp.tools()
      expect(Object.keys(toolsA).length).toBeGreaterThan(0)
      expect(Object.keys(toolsB).length).toBeGreaterThan(0)
      expect(serverState.listToolsCalls).toBe(1)
    }),
  ),
)

// ========================================================================
// Test: tool change notifications refresh the cache
// ========================================================================

test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "status-server"
      const serverState = getOrCreateClientState("status-server")

      yield* mcp.add("status-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const before = yield* mcp.tools()
      expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
      expect(serverState.listToolsCalls).toBe(1)

      serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

      const handler = serverState.notificationHandlers.get(ToolListChangedNotificationSchema)
      expect(handler).toBeDefined()
      yield* Effect.promise(() => handler?.())

      const after = yield* mcp.tools()
      expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
      expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
      expect(serverState.listToolsCalls).toBe(2)
    }),
  ),
)

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "disc-server"
        getOrCreateClientState("disc-server")

        yield* mcp.add("disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const statusBefore = yield* mcp.status()
        expect(statusBefore["disc-server"]?.status).toBe("connected")

        yield* mcp.disconnect("disc-server")

        const statusAfter = yield* mcp.status()
        expect(statusAfter["disc-server"]?.status).toBe("disabled")

        // Tools should be empty after disconnect
        const tools = yield* mcp.tools()
        const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
        expect(serverTools.length).toBe(0)
      }),
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "reconn-server"
        const serverState = getOrCreateClientState("reconn-server")
        serverState.tools = [
          { name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("reconn-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("disabled")

        // Reconnect
        yield* mcp.connect("reconn-server")
        expect((yield* mcp.status())["reconn-server"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "replace-server"
      const firstState = getOrCreateClientState("replace-server")

      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(false)

      // Create new state for second client
      clientStates.delete("replace-server")
      const secondState = getOrCreateClientState("replace-server")

      // Re-add should close the first client
      yield* mcp.add("replace-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(firstState.closed).toBe(true)
      expect(secondState.closed).toBe(false)
    }),
  ),
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        // Set up good server
        const goodState = getOrCreateClientState("good-server")
        goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

        // Set up bad server - will fail on listTools during create()
        const badState = getOrCreateClientState("bad-server")
        badState.listToolsShouldFail = true

        // Add good server first
        lastCreatedClientName = "good-server"
        yield* mcp.add("good-server", {
          type: "local",
          command: ["echo", "good"],
        })

        // Add bad server - should fail but not affect good server
        lastCreatedClientName = "bad-server"
        yield* mcp.add("bad-server", {
          type: "local",
          command: ["echo", "bad"],
        })

        const status = yield* mcp.status()
        expect(status["good-server"]?.status).toBe("connected")
        expect(status["bad-server"]?.status).toBe("failed")

        // Good server's tools should still be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
      }),
  ),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        const countBefore = clientCreateCount

        yield* mcp.add("disabled-server", {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        } as any)

        // No client should have been created
        expect(clientCreateCount).toBe(countBefore)

        const status = yield* mcp.status()
        expect(status["disabled-server"]?.status).toBe("disabled")
      }),
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-server"
        const serverState = getOrCreateClientState("prompt-server")
        serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

        yield* mcp.add("prompt-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(1)
        const key = Object.keys(prompts)[0]
        expect(key).toContain("prompt-server")
        expect(key).toContain("my-prompt")
      }),
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "resource-server"
        const serverState = getOrCreateClientState("resource-server")
        serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

        yield* mcp.add("resource-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const resources = yield* mcp.resources()
        expect(Object.keys(resources).length).toBe(1)
        const key = Object.keys(resources)[0]
        // Resources are keyed by URI so a reader can resolve one back to its server.
        expect(key).toBe("resource-server:file:///test.txt")
      }),
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "prompt-disc-server"
        const serverState = getOrCreateClientState("prompt-disc-server")
        serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

        yield* mcp.add("prompt-disc-server", {
          type: "local",
          command: ["echo", "test"],
        })

        yield* mcp.disconnect("prompt-disc-server")

        const prompts = yield* mcp.prompts()
        expect(Object.keys(prompts).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Test: connect() on nonexistent server
// ========================================================================

test(
  "connect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      // Should not throw
      yield* mcp.connect("nonexistent")
      const status = yield* mcp.status()
      expect(status["nonexistent"]).toBeUndefined()
    }),
  ),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      yield* mcp.disconnect("nonexistent")
      // Should complete without error
    }),
  ),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools()
      expect(Object.keys(tools).length).toBe(0)
    }),
  ),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "fail-connect"
        getOrCreateClientState("fail-connect")
        connectShouldFail = true
        connectError = "Connection refused"

        yield* mcp.add("fail-connect", {
          type: "local",
          command: ["echo", "test"],
        })

        const status = yield* mcp.status()
        expect(status["fail-connect"]?.status).toBe("failed")
        if (status["fail-connect"]?.status === "failed") {
          expect(status["fail-connect"].error).toContain("Connection refused")
        }

        // No tools should be available
        const tools = yield* mcp.tools()
        expect(Object.keys(tools).length).toBe(0)
      }),
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let rejected = false
  callbackPromise.then(() => {}).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "my.special-server"
        const serverState = getOrCreateClientState("my.special-server")
        serverState.tools = [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("my.special-server", {
          type: "local",
          command: ["echo", "test"],
        })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)

        // Server name dots should be replaced with underscores
        expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
        // Tool name dots should be replaced with underscores
        expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
        expect(keys.length).toBe(2)
      }),
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-server"
      getOrCreateClientState("hanging-server")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-server", {
        type: "local",
        command: ["node", "fake.js"],
        timeout: 100,
      })

      const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      expect(serverStatus.error).toContain("timed out")
      // Transport must be closed to avoid orphaned child process
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hanging-remote"
      getOrCreateClientState("hanging-remote")
      connectShouldHang = true

      const addResult = yield* mcp.add("hanging-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 100,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Transport must be closed to avoid leaked HTTP connections
      expect(transportCloseCount).toBeGreaterThanOrEqual(1)
    }),
  ),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "fail-remote"
      getOrCreateClientState("fail-remote")
      connectShouldFail = true
      connectError = "Connection refused"

      const addResult = yield* mcp.add("fail-remote", {
        type: "remote",
        url: "http://localhost:9999/mcp",
        timeout: 5000,
        oauth: false,
      })

      const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
      expect(serverStatus.status).toBe("failed")
      // Both StreamableHTTP and SSE transports should be closed
      expect(transportCloseCount).toBeGreaterThanOrEqual(2)
    }),
  ),
)

// ========================================================================
// Test: client roots (upstream f55a931f59)
// ========================================================================

test(
  "advertises the roots capability and answers roots/list with the instance directory",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "roots"
      yield* mcp.add("roots", { type: "local", command: ["echo", "test"] })

      const state = getOrCreateClientState("roots")
      expect(state.clientOptions?.capabilities?.roots).toEqual({})
      expect(state.clientOptions?.capabilities?.roots?.listChanged).toBeUndefined()

      const handler = state.requestHandlers.get(ListRootsRequestSchema)
      expect(handler).toBeDefined()
      const result = yield* Effect.promise(() => handler?.() ?? Promise.reject(new Error("roots handler missing")))
      // The advertised root is the same workspace directory the server process was spawned in.
      expect(result).toEqual({ roots: [{ uri: pathToFileURL(lastStdioOpts.cwd).href }] })
    }),
  ),
)

// ========================================================================
// Test: server instructions (upstream e8e83afbce)
// ========================================================================

test(
  "instructions() exposes connected server instructions with their tool names",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "instructed"
      getOrCreateClientState("instructed").instructions = "  Use the widget tool carefully.  "
      yield* mcp.add("instructed", { type: "local", command: ["echo", "test"] })

      expect(yield* mcp.instructions()).toEqual([
        { name: "instructed", instructions: "Use the widget tool carefully.", tools: ["instructed_test_tool"] },
      ])
    }),
  ),
)

test(
  "instructions() omits servers that sent none",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "plain"
      yield* mcp.add("plain", { type: "local", command: ["echo", "test"] })

      expect(yield* mcp.instructions()).toEqual([])
    }),
  ),
)

// ========================================================================
// Test: resource templates (upstream c6cc13e183)
// ========================================================================

test(
  "resourceTemplates() keys templates by server and uriTemplate",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "tpl-server"
      getOrCreateClientState("tpl-server").resourceTemplates = [{ name: "files", uriTemplate: "file:///{path}" }]
      yield* mcp.add("tpl-server", { type: "local", command: ["echo", "test"] })

      const templates = yield* mcp.resourceTemplates()
      expect(Object.keys(templates)).toEqual(["tpl-server:file:///{path}"])
      expect(templates["tpl-server:file:///{path}"]?.client).toBe("tpl-server")
    }),
  ),
)

test(
  "resources() can be scoped to a single server",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "scoped"
      getOrCreateClientState("scoped").resources = [{ name: "a", uri: "test://a" }]
      yield* mcp.add("scoped", { type: "local", command: ["echo", "test"] })

      expect(Object.keys(yield* mcp.resources("scoped"))).toEqual(["scoped:test://a"])
      expect(Object.keys(yield* mcp.resources("absent"))).toEqual([])
    }),
  ),
)

// ========================================================================
// Test: server log notifications (upstream 07b983e82f)
// ========================================================================

test(
  "routes server log notifications for every spec level",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "logger"
      yield* mcp.add("logger", { type: "local", command: ["echo", "test"] })

      const handler = getOrCreateClientState("logger").notificationHandlers.get(LoggingMessageNotificationSchema)
      expect(handler).toBeDefined()
      for (const level of ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]) {
        yield* Effect.promise(() => handler?.({ params: { level, data: "hello", logger: "server" } }))
      }
    }),
  ),
)

// ========================================================================
// Test: local server cwd (upstream 7e7ad37736)
// ========================================================================

test(
  "local mcp cwd resolves relative paths against the instance directory",
  withInstance({}, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "cwd-default"
      yield* mcp.add("cwd-default", { type: "local", command: ["echo", "test"] })
      const base = lastStdioOpts.cwd

      lastCreatedClientName = "cwd-relative"
      yield* mcp.add("cwd-relative", { type: "local", command: ["echo", "test"], cwd: "nested" })
      expect(lastStdioOpts.cwd).toBe(path.join(base, "nested"))

      lastCreatedClientName = "cwd-absolute"
      yield* mcp.add("cwd-absolute", { type: "local", command: ["echo", "test"], cwd: path.sep + "tmp" })
      expect(lastStdioOpts.cwd).toBe(path.sep + "tmp")
    }),
  ),
)

// ========================================================================
// Non-blocking snapshots and background initialization
// ========================================================================

test(
  "snapshots stay fast and do not connect while a server handshake hangs",
  withInstance({ "hang-snapshot": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "hang-snapshot"
      getOrCreateClientState("hang-snapshot")
      connectShouldHang = true

      expect(yield* mcp.statusSnapshot()).toEqual({ "hang-snapshot": { status: "connecting" } })
      expect(yield* mcp.resourcesSnapshot()).toEqual({})
      expect(yield* mcp.promptsSnapshot()).toEqual({})
      // Reading snapshots must never materialize MCP state or open a transport.
      expect(clientCreateCount).toBe(0)
    }),
  ),
)

test(
  "ensure() opens a single shared connection and status stays connecting",
  withInstance({ "bg-once": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "bg-once"
      getOrCreateClientState("bg-once")
      connectShouldHang = true

      yield* mcp.ensure().pipe(Effect.forkChild({ startImmediately: true }))
      yield* mcp.ensure().pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep("30 millis")

      expect(clientCreateCount).toBe(1)
      expect((yield* mcp.statusSnapshot())["bg-once"]?.status).toBe("connecting")
    }),
  ),
)

test(
  "tools() still waits for the handshake instead of returning the snapshot",
  withInstance({ "tools-wait": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "tools-wait"
      getOrCreateClientState("tools-wait")
      connectShouldHang = true

      const outcome = yield* Effect.race(
        mcp.tools().pipe(Effect.as("tools")),
        Effect.sleep("50 millis").pipe(Effect.as("timeout")),
      )

      expect(outcome).toBe("timeout")
      expect(clientCreateCount).toBe(1)
    }),
  ),
)

test(
  "snapshots reuse settled state without opening another connection",
  withInstance({ settled: { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "settled"
      const serverState = getOrCreateClientState("settled")
      serverState.resources = [{ name: "r", uri: "test://r" }]
      serverState.prompts = [{ name: "p", description: "prompt" }]

      yield* mcp.tools()
      const creates = clientCreateCount

      expect((yield* mcp.statusSnapshot())["settled"]?.status).toBe("connected")
      expect(Object.keys(yield* mcp.resourcesSnapshot())).toEqual(["settled:test://r"])
      expect(Object.keys(yield* mcp.promptsSnapshot()).length).toBe(1)
      expect(clientCreateCount).toBe(creates)
    }),
  ),
)

test(
  "Command.list stays local while MCP hangs and does not connect",
  withInstance({ "cmd-hang": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "cmd-hang"
      getOrCreateClientState("cmd-hang")
      connectShouldHang = true

      const commandLayer = Command.layer.pipe(
        Layer.provide(Layer.succeed(MCP.Service, mcp)),
        Layer.provide(Skill.defaultLayer),
        Layer.provide(Config.defaultLayer),
      )
      const names = yield* Effect.gen(function* () {
        const command = yield* Command.Service
        return (yield* command.list()).map((item) => item.name)
      }).pipe(Effect.provide(commandLayer))

      expect(names).toContain("init")
      expect(names.some((name) => name.includes("cmd-hang"))).toBe(false)
      expect(clientCreateCount).toBe(0)
    }),
  ),
)

test(
  "instance bootstrap warms MCP in the background without any route call",
  async () => {
    lastCreatedClientName = "boot-warm"
    connectShouldHang = true
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/chimera.json`,
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            mcp: { "boot-warm": { type: "local", command: ["echo", "test"] } },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        // No MCP service call here: only the bootstrap warm-up can create the client.
        for (let i = 0; i < 100 && clientCreateCount === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
        await InstanceRuntime.disposeInstance(Instance.current)
      },
    })

    expect(clientCreateCount).toBe(1)
  },
)

// ========================================================================
// Command MCP prompt memoization
// ========================================================================

test(
  "Command caches MCP prompt commands once per instance and get/list agree",
  withInstance({ "cmd-settled": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "cmd-settled"
      const serverState = getOrCreateClientState("cmd-settled")
      serverState.prompts = [{ name: "my-prompt", description: "A prompt" }]

      yield* mcp.ensure()

      const commandLayer = Command.layer.pipe(
        Layer.provide(Layer.succeed(MCP.Service, mcp)),
        Layer.provide(Skill.defaultLayer),
        Layer.provide(Config.defaultLayer),
      )
      const result = yield* Effect.gen(function* () {
        const command = yield* Command.Service
        const first = yield* command.list()
        const second = yield* command.list()
        const promptName = first.find((item) => item.source === "mcp")?.name
        const got = promptName ? yield* command.get(promptName) : undefined
        return { first, second, promptName, got }
      }).pipe(Effect.provide(commandLayer))

      expect(result.promptName).toBeDefined()
      expect(result.first.find((item) => item.name === result.promptName)?.source).toBe("mcp")
      expect(result.second.find((item) => item.name === result.promptName)?.source).toBe("mcp")
      expect(result.got?.name).toBe(result.promptName)
      expect(result.got?.source).toBe("mcp")
      // Two list calls + get share one memo: exactly one wire-level listPrompts.
      expect(serverState.listPromptsCalls).toBe(1)
      expect(clientCreateCount).toBe(1)
    }),
  ),
)

test(
  "Command.list stays local and skips prompt listing while MCP hangs",
  withInstance({ "cmd-hang2": { type: "local", command: ["echo", "test"] } }, (mcp) =>
    Effect.gen(function* () {
      lastCreatedClientName = "cmd-hang2"
      const serverState = getOrCreateClientState("cmd-hang2")
      serverState.prompts = [{ name: "hidden-prompt", description: "hidden" }]
      connectShouldHang = true

      yield* mcp.ensure().pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep("20 millis")

      const commandLayer = Command.layer.pipe(
        Layer.provide(Layer.succeed(MCP.Service, mcp)),
        Layer.provide(Skill.defaultLayer),
        Layer.provide(Config.defaultLayer),
      )
      const names = yield* Effect.gen(function* () {
        const command = yield* Command.Service
        return (yield* command.list()).map((item) => item.name)
      }).pipe(Effect.provide(commandLayer))

      expect(names).toContain("init")
      expect(names.some((name) => name.includes("hidden-prompt"))).toBe(false)
      expect(serverState.listPromptsCalls).toBe(0)
    }),
  ),
)

test(
  "disposing the instance interrupts the MCP warm-up without late creates",
  async () => {
    lastCreatedClientName = "boot-dispose"
    connectShouldHang = true
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/chimera.json`,
          JSON.stringify({
            $schema: "https://coding-chimera.github.io/chimera/schemas/config.json",
            mcp: { "boot-dispose": { type: "local", command: ["echo", "test"] } },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        for (let i = 0; i < 100 && clientCreateCount === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(clientCreateCount).toBe(1)
        await InstanceRuntime.disposeInstance(Instance.current)
        const afterDispose = clientCreateCount
        await new Promise((resolve) => setTimeout(resolve, 80))
        // The warm-up fiber is interrupted with the instance; no late lookup connects.
        expect(clientCreateCount).toBe(afterDispose)
        expect(transportCloseCount).toBeGreaterThanOrEqual(1)
      },
    })
  },
)
