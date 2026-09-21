import { describe, expect, test } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer, Logger, Option } from "effect"
import path from "path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ConfigParse } from "../../src/config/parse"
import { ConfigV2Compat } from "../../src/config/v2-compat"
import { Env } from "../../src/env"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Npm } from "@opencode-ai/core/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { snapshot } from "./snapshot"

const source = "test:v2-compat"
const lower = (input: unknown) => ConfigParse.effectSchema(Config.Info, ConfigV2Compat.lower(input, source).value, source)

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const noopNpm = Layer.mock(Npm.Service)({
  install: () => Effect.void,
  add: () => Effect.die("not implemented"),
  which: () => Effect.succeed(Option.none()),
})

const layer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provideMerge(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
  Layer.provide(noopNpm),
)

const it = testEffect(layer)

describe("V2 compatibility read fixtures", () => {
  const directory = path.join(import.meta.dir, "fixtures/v2-compat/read")
  const cases = Array.from(new Bun.Glob("*-input.jsonc").scanSync(directory))
    .map((file) => file.slice(0, -"-input.jsonc".length))
    .sort()
  if (!cases.length) throw new Error("No V2 compatibility read fixtures found")

  cases.forEach((name) => {
    test(name, async () => {
      const source = path.join(directory, `${name}-input.jsonc`)
      const input = ConfigParse.jsonc(await Bun.file(source).text(), source)
      const original = structuredClone(input)
      const result = ConfigV2Compat.lower(input, source)
      expect(input).toEqual(original)
      const config = ConfigParse.effectSchema(Config.Info, result.value, source)
      await snapshot(path.join(directory, `${name}-output.json`), JSON.stringify(config, null, 2) + "\n")
    })
  })
})

describe("ConfigV2Compat.lower", () => {
  test("returns structured invalid diagnostics while retaining supported siblings", () => {
    const result = ConfigV2Compat.lower({
      mcp: {
        servers: {
          broken: { type: "local", command: "not-an-array" },
          working: { type: "local", command: ["working-mcp"] },
        },
      },
      agents: { broken: { steps: "many" } },
      commands: { broken: { template: 42 } },
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invalid", path: ["mcp", "servers", "broken"] }),
        expect.objectContaining({ kind: "invalid", path: ["agents", "broken"] }),
        expect.objectContaining({ kind: "invalid", path: ["commands", "broken"] }),
      ]),
    )
    expect(ConfigParse.effectSchema(Config.Info, result.value, source).mcp).toEqual({
      working: { type: "local", command: ["working-mcp"], enabled: true },
    })
  })

  test("reports unsupported settings and lossy conversions without their values", () => {
    const secret = "do-not-log-credentials"
    const result = ConfigV2Compat.lower({
      model: { providerID: "example", model: "model", variant: "high" },
      plugins: [{ package: "native-plugin", options: { token: secret } }],
      providers: { example: { settings: { apiKey: secret } } },
      websearch: secret,
      warming: true,
      experimental: { portable_shell_scanner: true },
      agents: { reviewer: { request: { headers: { Authorization: secret } } } },
      mcp: {
        servers: {
          remote: {
            type: "remote",
            url: `https://example.com/?token=${secret}`,
            oauth: { client_secret: secret },
            codemode: false,
            timeout: { execution: 60000 },
          },
        },
      },
      lsp: { custom: { command: ["custom-lsp"] } },
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unsupported", path: ["model", "variant"] }),
        expect.objectContaining({ kind: "unsupported", path: ["plugins"] }),
        expect.objectContaining({ kind: "unsupported", path: ["providers"] }),
        expect.objectContaining({ kind: "unsupported", path: ["websearch"] }),
        expect.objectContaining({ kind: "unsupported", path: ["warming"] }),
        expect.objectContaining({ kind: "unsupported", path: ["experimental", "portable_shell_scanner"] }),
        expect.objectContaining({ kind: "unsupported", path: ["agents", "reviewer", "request", "headers"] }),
        expect.objectContaining({ kind: "unsupported", path: ["mcp", "servers", "remote", "codemode"] }),
        expect.objectContaining({ kind: "unsupported", path: ["mcp", "servers", "remote", "timeout"] }),
        expect.objectContaining({ kind: "unsupported", path: ["lsp", "custom"] }),
      ]),
    )
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("warns when experimental.policies is present but dropped", () => {
    const result = ConfigV2Compat.lower({
      experimental: { policies: { edit: "ask" }, batch_tool: true },
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unsupported", path: ["experimental", "policies"] }),
      ]),
    )
    // the lowered projection keeps the other experimental keys and drops only policies,
    // so the V1 config decode succeeds without silently swallowing the V2 setting
    expect((result.value as any).experimental).toEqual({ batch_tool: true })
    expect(lower({ experimental: { policies: { edit: "ask" }, batch_tool: true } }).experimental).toEqual({
      batch_tool: true,
    })
  })

  test("reports conflicting forms while retaining the V1 value", () => {
    const result = ConfigV2Compat.lower({
      snapshot: false,
      snapshots: true,
      command: { review: { template: "Legacy review" } },
      commands: { review: { template: "Native review" } },
      mcp: {
        shared: { type: "local", command: ["legacy"] },
        servers: { shared: { type: "local", command: ["native"] } },
      },
    })
    const config = ConfigParse.effectSchema(Config.Info, result.value, source)

    expect(config.snapshot).toBe(false)
    expect(config.command?.review.template).toBe("Legacy review")
    expect(config.mcp?.shared).toEqual({ type: "local", command: ["legacy"] })
    expect(result.diagnostics.filter((item) => item.kind === "conflict")).toHaveLength(3)
  })

  test("does not diagnose ordinary V1 configuration or reject invalid V1 roots early", () => {
    expect(ConfigV2Compat.lower({ snapshot: false, mcp: { existing: { enabled: false } } }).diagnostics).toEqual([])
    expect(ConfigV2Compat.lower({ snapshot: false, snapshots: false }).diagnostics).toEqual([])
    const result = ConfigV2Compat.lower(null)
    expect(result.value).toBeNull()
    expect(() => ConfigParse.effectSchema(Config.Info, result.value, source)).toThrow()
    expect(() => lower({ snapshot: "invalid", snapshots: true })).toThrow()
  })

  test("keeps malformed MCP servers named servers and timeout for V1 validation", () => {
    expect(() => lower({ mcp: { servers: { type: "local", command: "invalid" } } })).toThrow()
    expect(() => lower({ mcp: { timeout: { type: "remote", url: 42 } } })).toThrow()
    expect(() => lower({ mcp: { servers: { type: "bogus" } } })).toThrow()
    expect(() => lower({ mcp: { servers: { type: 42 } } })).toThrow()
    expect(() => lower({ mcp: { servers: { enabled: "false" } } })).toThrow()
  })

  test("rejects invalid V1 enablement when flat MCP entries include V2 fields", () => {
    expect(() =>
      lower({ mcp: { invalid: { type: "local", command: ["legacy"], enabled: "false", codemode: false } } }),
    ).toThrow("ConfigInvalidError")
  })

  test("does not repair malformed V1 containers or shadowed entries with V2 values", () => {
    const cases = [
      { agent: null, agents: { reviewer: { system: "Native prompt" } } },
      { command: [], commands: { review: { template: "Native command" } } },
      { attachment: false, media: { image: { auto_resize: true } } },
      { experimental: null, mcp: { timeout: { catalog: 3000, execution: 3000 } } },
      { agent: { reviewer: 42 }, agents: { reviewer: { system: "Native prompt" } } },
      { command: { review: 42 }, commands: { review: { template: "Native command" } } },
      { mcp: { shared: 42, servers: { shared: { type: "local", command: ["native"] } } } },
    ]
    cases.forEach((input) => expect(() => lower(input)).toThrow("ConfigInvalidError"))
  })

  test("keeps secrets out of invalid and conflict diagnostics", () => {
    const secret = "secret-never-in-diagnostics"
    const result = ConfigV2Compat.lower({
      commands: { malformed: { template: { token: secret } } },
      mcp: {
        shared: { type: "remote", url: "https://example.com", headers: { Authorization: secret } },
        servers: {
          shared: { type: "remote", url: "https://example.com", headers: { Authorization: `${secret}-changed` } },
          malformed: { type: "remote", url: `https://example.com?token=${secret}`, disabled: secret },
        },
      },
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "conflict", path: ["mcp", "servers", "shared"] }),
        expect.objectContaining({ kind: "invalid", path: ["commands", "malformed"] }),
        expect.objectContaining({ kind: "invalid", path: ["mcp", "servers", "malformed"] }),
      ]),
    )
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })

  test("rejects any native permission field, including empty and malformed values", () => {
    const cases = [
      [{ action: "shell", resource: "*", effect: "deny" }],
      [
        { action: "read", resource: "*", effect: "allow" },
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "public", effect: "allow" },
      ],
      [],
      null,
      "secret-permission-value",
      [{ action: "read", resource: "secret-permission-value", effect: "invalid" }],
    ]
    cases.forEach((permissions) => {
      expect(() => lower({ username: "keep-me", permissions })).toThrow("ConfigInvalidError")
      expect(() => lower({ permission: "deny", permissions })).toThrow("ConfigInvalidError")
    })
  })

  test("does not repair invalid legacy permissions with native rules", () => {
    expect(() => lower({ permission: { read: "invalid" }, permissions: [] })).toThrow("ConfigInvalidError")
  })

  test("rejects native agent permissions before decoding or applying V1 precedence", () => {
    const cases = [
      { agents: { reviewer: { system: "Review carefully", permissions: [{ action: "read" }] } } },
      { agents: { reviewer: { disabled: true, permissions: [] } } },
      { agent: { reviewer: { permission: "deny" } }, agents: { reviewer: { permissions: [] } } },
      { agents: { reviewer: { steps: "invalid", permissions: [] } } },
      { agent: { reviewer: { permissions: [] } } },
      { mode: { reviewer: { permissions: [] } } },
    ]
    cases.forEach((input) => expect(() => lower(input)).toThrow("ConfigInvalidError"))
  })

  test("continues to support V1 permission rules", () => {
    const config = lower({
      permission: { bash: "deny", "*": "ask", edit: "allow" },
      agent: { reviewer: { permission: { edit: "deny" } } },
    })
    expect(config.permission).toEqual({ bash: "deny", "*": "ask", edit: "allow" })
    expect(Object.keys(config.permission ?? {})).toEqual(["bash", "*", "edit"])
    expect(config.agent?.reviewer?.permission).toEqual({ edit: "deny" })
  })

  test("does not sanitize malformed V1 fields before schema validation", () => {
    expect(() => lower({ model: 42 })).toThrow()
    expect(() => lower({ snapshot: "enabled" })).toThrow()
    expect(() => lower({ mcp: { broken: { type: "local", command: "not-an-array" } } })).toThrow()
    expect(() => lower({ experimental: { mcp_timeout: -1 } })).toThrow()
  })

  test("does not mutate the input or nested configuration objects", () => {
    const input = {
      model: { providerID: "anthropic", model: "claude-sonnet", variant: "fast" },
      snapshots: true,
      skills: ["./skills", "https://example.com/skills"],
      mcp: {
        existing: { type: "local", command: ["existing-mcp"], enabled: false },
        servers: {
          native: {
            type: "remote",
            url: "https://example.com/mcp",
            disabled: true,
            oauth: { client_id: "client" },
            timeout: { execution: 3000 },
          },
        },
      },
      agents: { reviewer: { model: "anthropic/claude-sonnet#thinking", disabled: true } },
      experimental: { subagent_depth: 2 },
    }
    const original = structuredClone(input)

    lower(input)

    expect(input).toEqual(original)
  })
})

describe("V2 configuration loading", () => {
  it.instance("logs compatibility diagnostics without writing the lowered projection", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const file = path.join(instance.directory, "chimera.jsonc")
      const text =
        '{\n  // Retain this comment\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": ["native-only"]\n}\n'
      yield* fs.writeWithDirs(file, text)
      const messages: unknown[] = []
      const config = yield* Config.Service.use((svc) => svc.get()).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(options.message)
            }),
          ]),
        ),
      )

      expect(config.plugin).toEqual([])
      expect(messages).toContainEqual([
        "configuration compatibility diagnostic",
        expect.objectContaining({ source: file, kind: "unsupported", path: ["plugins"] }),
      ])
      expect(yield* fs.readFileString(file)).toBe(text)
    }),
  )

  it.instance("loads native V2 configuration through the V1 Config service", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(
        path.join(instance.directory, "chimera.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: { providerID: "anthropic", model: "claude-sonnet", variant: "fast" },
          snapshots: false,
          skills: ["./skills", "https://example.com/skills"],
          mcp: {
            timeout: { catalog: 9000, execution: 9000 },
            servers: {
              native: { type: "remote", url: "https://native.example.com/mcp", disabled: false },
            },
          },
          agents: {
            reviewer: {
              model: "anthropic/claude-sonnet#thinking",
              system: "Review carefully.",
            },
          },
          commands: {
            review: {
              template: "Review $ARGUMENTS",
              model: { providerID: "anthropic", model: "claude-sonnet", variant: "thinking" },
            },
          },
          experimental: { subagent_depth: 2 },
        }),
      )

      const config = yield* Config.Service.use((svc) => svc.get())

      expect(config.model).toBe("anthropic/claude-sonnet")
      expect(config.snapshot).toBe(false)
      expect(config.skills).toEqual({ paths: ["./skills"], urls: ["https://example.com/skills"] })
      expect(config.mcp?.native).toEqual({ type: "remote", url: "https://native.example.com/mcp", enabled: true })
      expect(config.experimental?.mcp_timeout).toBe(9000)
      expect(config.permission).toBeUndefined()
      expect(config.agent?.reviewer).toMatchObject({
        model: "anthropic/claude-sonnet",
        variant: "thinking",
        prompt: "Review carefully.",
        permission: {},
      })
      expect(config.command?.review).toMatchObject({
        template: "Review $ARGUMENTS",
        model: "anthropic/claude-sonnet",
        variant: "thinking",
      })
      expect(config.subagent_depth).toBe(2)
    }),
  )

  it.instance("loads legacy opencode.json documents through the dual-read fallback", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(
        path.join(instance.directory, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: { providerID: "openai", model: "gpt-4.1" },
          snapshots: false,
        }),
      )

      const config = yield* Config.Service.use((svc) => svc.get())

      expect(config.model).toBe("openai/gpt-4.1")
      expect(config.snapshot).toBe(false)
    }),
  )

  it.instance("keeps legacy TUI normalization when loading a mixed V1 and V2 document", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(
        path.join(instance.directory, "chimera.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: { providerID: "openai", model: "gpt-4.1" },
          theme: "legacy",
          keybinds: { leader: "ctrl+x" },
          tui: { scroll_speed: 4 },
          mcp: {
            legacy: { enabled: false },
            servers: { native: { type: "local", command: ["native-mcp"] } },
          },
        }),
      )

      const config = yield* Config.Service.use((svc) => svc.get())

      expect(config.model).toBe("openai/gpt-4.1")
      expect(config.mcp?.legacy).toEqual({ enabled: false })
      expect(config.mcp?.native).toEqual({ type: "local", command: ["native-mcp"], enabled: true })
      expect(config).not.toHaveProperty("theme")
      expect(config).not.toHaveProperty("keybinds")
      expect(config).not.toHaveProperty("tui")
    }),
  )
})