import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { WithInstance } from "../../src/project/with-instance"
import { ResponsesTransport } from "../../src/provider/responses-transport"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

const original = {
  OPENCODE_EXPERIMENTAL_HTTPAPI: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  OPENCODE_SERVER_HONO: Flag.OPENCODE_SERVER_HONO,
}

function app(backend: "effect-httpapi" | "hono" = "effect-httpapi") {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  Flag.OPENCODE_SERVER_HONO = backend === "hono"
  return Server.Default().app
}

function providerConfig() {
  return {
    formatter: false,
    lsp: false,
    username: "preserved-user",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai",
        wire_api: "responses" as const,
        remote_compaction: {
          profile: "codex-responses" as const,
          protocols: ["v2", "legacy"] as ["v2", "legacy"],
          auth: "provider-bearer" as const,
        },
        models: {
          "logical-model": {
            id: "wire-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
            wire_api: "responses" as const,
            remote_compaction: true,
          },
          "other-model": {
            id: "other-wire-model",
            name: "Other Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
            wire_api: "responses" as const,
            remote_compaction: true,
          },
        },
        options: {
          apiKey: "secret-api-key",
          baseURL: "https://provider.invalid/v1",
          headers: { Authorization: "Bearer compatibility-secret" },
        },
      },
      aijws: {
        name: "AIJWS",
        id: "aijws",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "gpt-5.6-sol": {
            id: "gpt-5.6-sol",
            name: "GPT 5.6 Sol",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2026-07-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
          preserved: {
            id: "preserved",
            name: "Preserved Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2026-07-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: { marker: "preserved-model-option" },
          },
        },
        options: {
          apiKey: "aijws-secret-key",
          baseURL: "https://aijws.invalid/v1",
          headers: { Authorization: "Bearer aijws-compatibility-secret" },
        },
      },
      native: {
        name: "Native Anthropic",
        id: "native",
        env: [],
        npm: "@ai-sdk/anthropic",
        models: {
          claude: {
            id: "claude",
            name: "Claude",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            release_date: "2026-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "native-secret-key" },
    },
    },
  }
}

async function waitDisposed(directory: string) {
  await waitGlobalBusEventPromise({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

async function remoteCompactionProject() {
  return tmpdir({ config: providerConfig() })
}

async function persistGenericRemoteCompactionLock(directory: string, compatibilityKey: string) {
  return WithInstance.provide({
    directory,
    fn: () =>
      Effect.runPromise(
        Session.Service.use((sessions) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({})
            const message = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("logical-model") },
              tools: {},
            } satisfies MessageV2.User)
            const part = MessageV2.CompactionPart.zod.parse({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: message.id,
              type: "compaction",
              auto: true,
              remote: {
                providerID: "test",
                endpoint: "provider",
                driver: "codex-responses",
                profile: "codex-responses",
                implementation: "responses_compaction_v2",
                modelID: "logical-model",
                wireModelID: "wire-model",
                replay: {
                  format: "responses_compaction_v1",
                  wire_api: "responses",
                  compatibility_key: compatibilityKey,
                },
                output: [{ type: "compaction", encrypted_content: "encrypted-lock-content" }],
              },
            })
            yield* sessions.updatePart(part as MessageV2.CompactionPart)
            return { session, part }
          }),
        ).pipe(Effect.provide(Session.defaultLayer)),
      ),
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.OPENCODE_EXPERIMENTAL_HTTPAPI
  Flag.OPENCODE_SERVER_HONO = original.OPENCODE_SERVER_HONO
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  test("serves config update through Hono bridge", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const disposed = waitDisposed(tmp.path)

    const response = await app().request("/config", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-chimera-directory": tmp.path,
      },
      body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ username: "patched-user", formatter: false, lsp: false })
    await disposed
    expect(await Bun.file(path.join(tmp.path, "chimera.json")).json()).toMatchObject({
      username: "patched-user",
      formatter: false,
      lsp: false,
    })
    const reloaded = await app().request("/config", { headers: { "x-chimera-directory": tmp.path } })
    expect(reloaded.status).toBe(200)
    expect(await reloaded.json()).toMatchObject({ username: "patched-user", formatter: false, lsp: false })
  })

  for (const backend of ["effect-httpapi", "hono"] as const) {
    test(`${backend} maps unknown remote compaction models to the same 400 error`, async () => {
      await using tmp = await remoteCompactionProject()
      const request = (providerID: string, modelID: string) =>
        app(backend).request(
          `/config/remote-compaction/status?providerID=${providerID}&modelID=${modelID}`,
          { headers: { "x-chimera-directory": tmp.path } },
        )

      for (const [providerID, modelID] of [["missing-provider", "missing-model"], ["test", "missing-model"]]) {
        const response = await request(providerID, modelID)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          name: "ProviderModelNotFoundError",
          data: { providerID, modelID },
        })
      }
    })

    test(`${backend} resolves persisted remote compaction replay without exposing secrets`, async () => {
      await using tmp = await remoteCompactionProject()
      const identity = ResponsesTransport.make({
        providerID: "test",
        modelID: "logical-model",
        wireModelID: "wire-model",
        baseURL: "https://provider.invalid/v1",
        apiKey: "secret-api-key",
        headers: { Authorization: "Bearer compatibility-secret" },
        fetch: undefined,
        timeout: undefined,
        chunkTimeout: undefined,
      }).identity
      const seeded = await persistGenericRemoteCompactionLock(tmp.path, identity.compatibilityKey)
      const request = (modelID: string) =>
        app(backend).request(
          `/config/remote-compaction/status?providerID=test&modelID=${modelID}&sessionID=${seeded.session.id}`,
          { headers: { "x-chimera-directory": tmp.path } },
        )

      const exact = await request("logical-model")
      expect(exact.status).toBe(200)
      const exactBody = await exact.json()
      expect(exactBody).toMatchObject({
        requested: { providerID: "test", modelID: "logical-model" },
        effective: { providerID: "test", modelID: "logical-model", wireModelID: "wire-model" },
        mode: "remote",
        target: "provider",
        reason: "ready",
        lock: { status: "exact", endpoint: "provider", providerID: "test", modelID: "logical-model" },
        replay: { mode: "encoded", reason: "exact_binding" },
      })

      await persistGenericRemoteCompactionLock(tmp.path, "stale-compatibility-key").then(async (replacement) => {
        const mismatch = await app(backend).request(
          `/config/remote-compaction/status?providerID=test&modelID=logical-model&sessionID=${replacement.session.id}`,
          { headers: { "x-chimera-directory": tmp.path } },
        )
        expect(mismatch.status).toBe(200)
        expect(await mismatch.json()).toMatchObject({
          lock: { status: "route_mismatch", endpoint: "provider" },
          replay: { mode: "full_history", reason: "binding_mismatch" },
        })
      })

      const modelMismatch = await request("other-model")
      expect(modelMismatch.status).toBe(200)
      expect(await modelMismatch.json()).toMatchObject({
        lock: { status: "model_mismatch", endpoint: "provider" },
        replay: { mode: "blocked", reason: "model_mismatch" },
      })

      const serialized = JSON.stringify(exactBody)
      for (const secret of [
        "encrypted-lock-content",
        "stale-compatibility-key",
        "compatibility-secret",
        "Authorization",
        "secret-api-key",
        "headers",
      ])
        expect(serialized).not.toContain(secret)
    })

    test(`${backend} narrowly patches remote compaction and preserves unrelated config`, async () => {
      await using tmp = await remoteCompactionProject()
      const disposed = waitDisposed(tmp.path)
      const response = await app(backend).request("/config/remote-compaction", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-chimera-directory": tmp.path },
        body: JSON.stringify({ remote: "on" }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ remote: "on", remote_protocol: "auto" })
      await disposed
      expect(await Bun.file(path.join(tmp.path, "chimera.json")).json()).toMatchObject({
        username: "preserved-user",
        formatter: false,
        lsp: false,
        compaction: { remote: "on" },
        provider: { test: { options: { apiKey: "secret-api-key" } } },
      })
      const reloaded = await app(backend).request(
        "/config/remote-compaction/status?providerID=test&modelID=logical-model",
        { headers: { "x-chimera-directory": tmp.path } },
      )
      expect(reloaded.status).toBe(200)
      expect(await reloaded.json()).toMatchObject({ configured: { mode: "on", protocol: "auto" }, reason: "ready" })
    })

    test(`${backend} lists redacted eligibility and enables then disables aijws remote compaction`, async () => {
      await using tmp = await remoteCompactionProject()
      const headers = { "content-type": "application/json", "x-chimera-directory": tmp.path }

      const before = await app(backend).request("/config/remote-compaction/status?providerID=aijws&modelID=gpt-5.6-sol", { headers })
      expect(before.status).toBe(200)
      expect(await before.json()).toMatchObject({ mode: "local", target: "local", reason: "provider_capability_missing" })

      const listed = await app(backend).request("/config/remote-compaction/eligibility", { headers })
      expect(listed.status).toBe(200)
      const listBody = await listed.json()
      expect(listBody.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerID: "aijws",
            providerName: "AIJWS",
            modelID: "gpt-5.6-sol",
            modelName: "GPT 5.6 Sol",
            apiNpm: "@ai-sdk/openai-compatible",
            wire_api: "chat",
            providerCapability: { present: false, protocols: [] },
            modelRemoteCompaction: "unset",
            configurable: true,
          }),
          expect.objectContaining({ providerID: "native", modelID: "claude", configurable: false }),
        ]),
      )
      const serializedList = JSON.stringify(listBody)
      for (const secret of [
        "aijws-secret-key",
        "aijws.invalid",
        "Authorization",
        "aijws-compatibility-secret",
        "native-secret-key",
        "options",
        "headers",
      ])
        expect(serializedList).not.toContain(secret)

      const enabled = await app(backend).request("/config/remote-compaction/eligibility", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ providerID: "aijws", modelID: "gpt-5.6-sol", enabled: true }),
      })
      expect(enabled.status).toBe(200)
      expect(await enabled.json()).toEqual({
        providerID: "aijws",
        providerName: "AIJWS",
        modelID: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
        apiNpm: "@ai-sdk/openai",
        wire_api: "responses",
        providerCapability: { present: true, protocols: ["v2", "legacy"] },
        modelRemoteCompaction: "enabled",
        configurable: true,
      })

      const ready = await app(backend).request("/config/remote-compaction/status?providerID=aijws&modelID=gpt-5.6-sol", { headers })
      expect(ready.status).toBe(200)
      expect(await ready.json()).toMatchObject({
        mode: "remote",
        target: "provider",
        reason: "ready",
        protocols: ["v2", "legacy"],
        credential: "configured",
      })

      const immediateEligibility = await app(backend).request("/config/remote-compaction/eligibility", { headers })
      expect(immediateEligibility.status).toBe(200)
      expect(await immediateEligibility.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            providerID: "aijws",
            modelID: "gpt-5.6-sol",
            wire_api: "responses",
            providerCapability: { present: true, protocols: ["v2", "legacy"] },
            modelRemoteCompaction: "enabled",
          }),
          expect.objectContaining({ providerID: "aijws", modelID: "preserved", wire_api: "chat" }),
        ]),
      })
      await WithInstance.provide({
        directory: tmp.path,
        fn: async () => {
          const language = await AppRuntime.runPromise(
            Provider.Service.use((provider) =>
              provider
                .getModel(ProviderID.make("aijws"), ModelID.make("gpt-5.6-sol"))
                .pipe(Effect.flatMap((model) => provider.getLanguage(model))),
            ),
          )
          expect(language.provider).toBe("aijws.responses")
        },
      })

      const enabledConfig = await Bun.file(path.join(tmp.path, "chimera.json")).json()
      expect(enabledConfig).toMatchObject({
        username: "preserved-user",
        provider: {
          aijws: {
            remote_compaction: {
              profile: "codex-responses",
              protocols: ["v2", "legacy"],
              auth: "provider-bearer",
            },
            options: {
              apiKey: "aijws-secret-key",
              baseURL: "https://aijws.invalid/v1",
              headers: { Authorization: "Bearer aijws-compatibility-secret" },
            },
            models: {
              "gpt-5.6-sol": {
                provider: { npm: "@ai-sdk/openai" },
                wire_api: "responses",
                remote_compaction: true,
              },
              preserved: { options: { marker: "preserved-model-option" } },
            },
          },
          test: { models: { "logical-model": { remote_compaction: true } } },
        },
      })

      const disabled = await app(backend).request("/config/remote-compaction/eligibility", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ providerID: "aijws", modelID: "gpt-5.6-sol", enabled: false }),
      })
      expect(disabled.status).toBe(200)
      expect(await disabled.json()).toMatchObject({
        providerID: "aijws",
        modelID: "gpt-5.6-sol",
        apiNpm: "@ai-sdk/openai",
        wire_api: "responses",
        providerCapability: { present: true, protocols: ["v2", "legacy"] },
        modelRemoteCompaction: "disabled",
      })
      const disabledStatus = await app(backend).request(
        "/config/remote-compaction/status?providerID=aijws&modelID=gpt-5.6-sol",
        { headers },
      )
      expect(disabledStatus.status).toBe(200)
      expect(await disabledStatus.json()).toMatchObject({ mode: "local", reason: "model_disabled" })
      expect(await Bun.file(path.join(tmp.path, "chimera.json")).json()).toMatchObject({
        provider: {
          aijws: {
            remote_compaction: { protocols: ["v2", "legacy"] },
            options: { apiKey: "aijws-secret-key" },
            models: {
              "gpt-5.6-sol": {
                provider: { npm: "@ai-sdk/openai" },
                wire_api: "responses",
                remote_compaction: false,
              },
              preserved: { options: { marker: "preserved-model-option" } },
            },
          },
        },
      })
    })

    test(`${backend} rejects unsafe eligibility targets and unknown fields`, async () => {
      await using tmp = await remoteCompactionProject()
      const configPath = path.join(tmp.path, "chimera.json")
      const before = await Bun.file(configPath).text()
      const headers = { "content-type": "application/json", "x-chimera-directory": tmp.path }
      const cases = [
        [{ providerID: "missing", modelID: "missing", enabled: true }, "unknown_provider"],
        [{ providerID: "aijws", modelID: "missing", enabled: true }, "unknown_model"],
        [{ providerID: "native", modelID: "claude", enabled: true }, "not_configurable"],
        [{ providerID: "aijws", modelID: "gpt-5.6-sol", enabled: true, forbidden: true }, "unknown_field"],
      ] as const
      for (const [payload, reason] of cases) {
        const response = await app(backend).request("/config/remote-compaction/eligibility", {
          method: "PATCH",
          headers,
          body: JSON.stringify(payload),
        })
        expect(response.status, JSON.stringify(payload)).toBe(400)
        expect(await response.json()).toEqual({
          name: "RemoteCompactionEligibilityError",
          data: { providerID: payload.providerID, modelID: payload.modelID, reason },
        })
      }
      for (const protocols of [[], ["legacy", "legacy"]]) {
        const response = await app(backend).request("/config/remote-compaction/eligibility", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ providerID: "aijws", modelID: "gpt-5.6-sol", enabled: true, protocols }),
        })
        expect(response.status, JSON.stringify(protocols)).toBe(400)
      }
      expect(await Bun.file(configPath).text()).toBe(before)
    })

    test(`${backend} rejects invalid and unknown remote compaction fields`, async () => {
      await using tmp = await remoteCompactionProject()
      const configPath = path.join(tmp.path, "chimera.json")
      const before = await Bun.file(configPath).text()
      const headers = { "content-type": "application/json", "x-chimera-directory": tmp.path }
      const [invalid, unknown] = await Promise.all([
        app(backend).request("/config/remote-compaction", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ remote: "sometimes" }),
        }),
        app(backend).request("/config/remote-compaction", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ remote: "auto", username: "forbidden" }),
        }),
      ])

      expect(invalid.status).toBe(400)
      expect(unknown.status).toBe(400)
      expect(await Bun.file(configPath).text()).toBe(before)
    })
  }
})
