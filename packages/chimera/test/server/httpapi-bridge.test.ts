import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Instance } from "../../src/project/instance"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { ExperimentalHttpApiServer } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = {
  OPENCODE_EXPERIMENTAL_HTTPAPI: Flag.OPENCODE_EXPERIMENTAL_HTTPAPI,
  OPENCODE_SERVER_HONO: Flag.OPENCODE_SERVER_HONO,
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

const methods = ["get", "post", "put", "delete", "patch"] as const
let effectSpec: ReturnType<typeof OpenApi.fromApi> | undefined

function effectOpenApi() {
  return (effectSpec ??= OpenApi.fromApi(PublicApi))
}

function app(input?: { password?: string; username?: string }) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  Flag.OPENCODE_SERVER_PASSWORD = input?.password
  Flag.OPENCODE_SERVER_USERNAME = input?.username

  const handler = HttpRouter.toWebHandler(
    ExperimentalHttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    fetch: (request: Request) => handler(request, ExperimentalHttpApiServer.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function openApiRouteKeys(spec: { paths: Record<string, Partial<Record<(typeof methods)[number], unknown>>> }) {
  return Object.entries(spec.paths)
    .flatMap(([path, item]) =>
      methods.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort()
}

function openApiParameters(spec: { paths: Record<string, Partial<Record<(typeof methods)[number], Operation>>> }) {
  return Object.fromEntries(
    Object.entries(spec.paths).flatMap(([path, item]) =>
      methods
        .filter((method) => item[method])
        .map((method) => [
          `${method.toUpperCase()} ${path}`,
          (item[method]?.parameters ?? [])
            .map(parameterKey)
            .filter((param) => param !== undefined)
            .sort(),
        ]),
    ),
  )
}

function openApiRequestBodies(spec: OpenApiSpec) {
  return Object.fromEntries(
    Object.entries(spec.paths).flatMap(([path, item]) =>
      methods
        .filter((method) => item[method])
        .map((method) => [`${method.toUpperCase()} ${path}`, requestBodyKey(spec, item[method]?.requestBody)]),
    ),
  )
}

type OpenApiSpec = {
  components?: {
    schemas?: Record<string, OpenApiSchema>
  }
  paths: Record<string, Partial<Record<(typeof methods)[number], Operation>>>
}

type OpenApiSchema = {
  $ref?: string
  additionalProperties?: boolean | OpenApiSchema
  allOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  description?: string
  enum?: unknown[]
  maximum?: number
  oneOf?: OpenApiSchema[]
  pattern?: string
  properties?: Record<string, OpenApiSchema>
  propertyNames?: OpenApiSchema
  required?: string[]
  type?: string | string[]
}

type Operation = {
  parameters?: unknown[]
  responses?: unknown
  requestBody?: unknown
}

type RequestBody = {
  content?: Record<string, { schema?: OpenApiSchema }>
  required?: boolean
}

function parameterKey(param: unknown): string | undefined {
  if (!param || typeof param !== "object" || !("in" in param) || !("name" in param)) return undefined
  if (typeof param.in !== "string" || typeof param.name !== "string") return undefined
  return `${param.in}:${param.name}:${"required" in param && param.required === true}:${stableSchema(
    "schema" in param ? param.schema : undefined,
  )}`
}

function stableSchema(input: unknown): string {
  return JSON.stringify(sortSchema(input))
}

function sortSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortSchema)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sortSchema(value)]),
  )
}

function sdkComponentSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sdkComponentSchema)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) =>
          key !== "description" &&
          key !== "propertyNames" &&
          !(key === "additionalProperties" && value === false) &&
          !(key === "maximum" && value === Number.MAX_SAFE_INTEGER),
      )
      .map(([key, value]) => [
        key === "const" ? "enum" : key,
        key === "const"
          ? [value]
          : (key === "enum" || key === "required") && Array.isArray(value)
            ? [...value].sort()
            : sdkComponentSchema(value),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function componentSchema(spec: OpenApiSpec, name: string) {
  return spec.components?.schemas?.[name]
}

function requestBodySchema(input: {
  spec: OpenApiSpec
  path: string
  method: (typeof methods)[number]
}) {
  const body = input.spec.paths[input.path]?.[input.method]?.requestBody
  if (!body || typeof body !== "object" || !("content" in body)) return
  return (body as RequestBody).content?.["application/json"]?.schema
}

function parameterSchema(input: {
  spec: { paths: Record<string, Partial<Record<(typeof methods)[number], Operation>>> }
  path: string
  method: (typeof methods)[number]
  name: string
}): unknown {
  const param = input.spec.paths[input.path]?.[input.method]?.parameters?.find(
    (param) => !!param && typeof param === "object" && "name" in param && param.name === input.name,
  )
  if (!param || typeof param !== "object" || !("schema" in param)) return undefined
  return param.schema
}

function requestBodyKey(spec: OpenApiSpec, body: unknown) {
  if (!body || typeof body !== "object" || !("content" in body)) return ""
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Guarded above; test helper only needs this OpenAPI subset.
  const requestBody = body as RequestBody
  return JSON.stringify({
    required: requestBody.required === true,
    content: Object.entries(requestBody.content ?? {})
      .map(([type, value]) => [type, requestBodySchemaKind(spec, value.schema)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  })
}

function requestBodySchemaKind(spec: OpenApiSpec, schema: OpenApiSchema | undefined) {
  if (!schema) return ""
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `$ref` lookup is constrained to OpenAPI schema components in this test helper.
  const resolved = (
    schema.$ref ? spec.components?.schemas?.[schema.$ref.replace("#/components/schemas/", "")] : schema
  ) as OpenApiSchema | undefined
  if (resolved?.properties) return "object"
  if (resolved?.anyOf ?? resolved?.oneOf ?? resolved?.allOf) return "object"
  return resolved?.type ?? schema.type ?? "inline"
}

function responseContentTypes(input: {
  spec: { paths: Record<string, Partial<Record<(typeof methods)[number], Operation>>> }
  path: string
  method: (typeof methods)[number]
  status: string
}) {
  const responses = input.spec.paths[input.path]?.[input.method]?.responses
  if (!responses || typeof responses !== "object" || !(input.status in responses)) return []
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Guarded dynamic OpenAPI response lookup.
  const response = (responses as Record<string, unknown>)[input.status]
  if (!response || typeof response !== "object" || !("content" in response)) return []
  const content = (response as { content?: unknown }).content
  if (!content || typeof content !== "object") {
    return []
  }
  return Object.keys(content).sort()
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function fileUrl(input?: { directory?: string; token?: string }) {
  const url = new URL(`http://localhost${FilePaths.content}`)
  url.searchParams.set("path", "hello.txt")
  if (input?.directory) url.searchParams.set("directory", input.directory)
  if (input?.token) url.searchParams.set("auth_token", input.token)
  return url
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original.OPENCODE_EXPERIMENTAL_HTTPAPI
  Flag.OPENCODE_SERVER_HONO = original.OPENCODE_SERVER_HONO
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi server", () => {
  test("defaults to Effect HttpApi and keeps an explicit Hono fallback", () => {
    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = false
    Flag.OPENCODE_SERVER_HONO = false
    expect(Server.backend()).toEqual({ backend: "effect-httpapi", reason: "stable" })

    Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
    expect(Server.backend()).toEqual({ backend: "effect-httpapi", reason: "env" })

    Flag.OPENCODE_SERVER_HONO = true
    expect(Server.backend()).toEqual({ backend: "hono", reason: "env" })
  })

  test("covers every generated OpenAPI route with Effect HttpApi contracts", async () => {
    const honoRoutes = openApiRouteKeys(await Server.openapiHono())
    const effectRoutes = openApiRouteKeys(effectOpenApi())

    expect(honoRoutes.filter((route) => !effectRoutes.includes(route))).toEqual([])
    expect(effectRoutes.filter((route) => !honoRoutes.includes(route))).toEqual([
      "GET /api/session",
      "GET /api/session/{sessionID}/context",
      "GET /api/session/{sessionID}/message",
      "POST /api/session/{sessionID}/compact",
      "POST /api/session/{sessionID}/prompt",
      "POST /api/session/{sessionID}/wait",
    ])
  })

  test("matches generated OpenAPI route parameters", async () => {
    const hono = openApiParameters(await Server.openapiHono())
    const effect = openApiParameters(effectOpenApi())

    expect(
      Object.keys(hono)
        .filter((route) => JSON.stringify(hono[route]) !== JSON.stringify(effect[route]))
        .map((route) => ({ route, hono: hono[route], effect: effect[route] })),
    ).toEqual([])
  })

  test("matches generated OpenAPI request body shape", async () => {
    const hono = openApiRequestBodies(await Server.openapiHono())
    const effect = openApiRequestBodies(effectOpenApi())

    expect(
      Object.keys(hono)
        .filter((route) => hono[route] !== effect[route])
        .map((route) => ({ route, hono: hono[route], effect: effect[route] })),
    ).toEqual([])
  })

  test("matches SDK-affecting query parameter schemas", () => {
    const effect = effectOpenApi()

    expect(parameterSchema({ spec: effect, path: "/session", method: "get", name: "roots" })).toEqual({
      anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
    })
    expect(parameterSchema({ spec: effect, path: "/session", method: "get", name: "archived" })).toEqual({
      anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
    })
    expect(parameterSchema({ spec: effect, path: "/session", method: "get", name: "start" })).toEqual({
      type: "number",
    })
    expect(parameterSchema({ spec: effect, path: "/find/file", method: "get", name: "limit" })).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 200,
    })
    expect(
      parameterSchema({ spec: effect, path: "/session/{sessionID}/message", method: "get", name: "limit" }),
    ).toEqual({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    })
    expect(
      parameterSchema({ spec: effect, path: "/graph/file/symbols", method: "get", name: "startLine" }),
    ).toEqual({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
    expect(
      parameterSchema({ spec: effect, path: "/graph/file/symbols", method: "get", name: "endLine" }),
    ).toEqual({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
    expect(parameterSchema({ spec: effect, path: "/graph/file/symbols", method: "get", name: "limit" })).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
    })
    expect(parameterSchema({ spec: effect, path: "/graph/impact", method: "get", name: "depth" })).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 5,
    })
    expect(parameterSchema({ spec: effect, path: "/experimental/session", method: "get", name: "cursor" })).toEqual({
      type: "number",
    })
    expect(
      parameterSchema({ spec: effect, path: "/pty/{ptyID}/connect", method: "get", name: "cursor" }),
    ).toEqual({ type: "string" })
  })

  test("keeps SDK component names normalized and separates TUI event payloads", () => {
    const spec = effectOpenApi()
    const schemas = spec.components?.schemas ?? {}
    const names = Object.keys(schemas)

    expect(names.filter((name) => name.includes("."))).toEqual([])
    expect(
      names.filter((name) => {
        const base = name.replace(/\d+$/, "")
        return (
          base !== name &&
          schemas[base] &&
          stableSchema(sdkComponentSchema(schemas[name])) === stableSchema(sdkComponentSchema(schemas[base]))
        )
      }),
    ).toEqual([])

    const eventNames = [
      "EventTuiPromptAppend",
      "EventTuiCommandExecute",
      "EventTuiToastShow",
      "EventTuiSessionSelect",
    ]
    for (const name of eventNames) {
      expect(componentSchema(spec, name)?.required).toContain("id")
      expect(componentSchema(spec, name)?.properties?.id).toEqual({ type: "string" })
      expect(componentSchema(spec, `${name}2`)?.required ?? []).not.toContain("id")
      expect(componentSchema(spec, `${name}2`)?.properties?.id).toBeUndefined()
    }

    expect(componentSchema(spec, "Event")?.anyOf?.map((schema) => schema.$ref)).toEqual(
      expect.arrayContaining(eventNames.map((name) => `#/components/schemas/${name}`)),
    )
    expect(
      requestBodySchema({ spec, path: "/tui/publish", method: "post" })?.anyOf?.map((schema) => schema.$ref),
    ).toEqual(eventNames.map((name) => `#/components/schemas/${name}2`))
  })

  test("preserves representative SDK-relevant component contracts", async () => {
    const hono = (await Server.openapiHono()) as OpenApiSpec
    const effect = effectOpenApi() as OpenApiSpec

    for (const name of ["LogLevel", "ServerConfig", "LayoutConfig", "Project", "ApiError"]) {
      expect({ name, schema: sdkComponentSchema(componentSchema(effect, name)) }).toEqual({
        name,
        schema: sdkComponentSchema(componentSchema(hono, name)),
      })
    }

    expect(componentSchema(effect, "LogLevel")?.description).toBe("Log level")
    expect(componentSchema(effect, "ServerConfig")?.description).toBe(
      "Server configuration for chimera serve and web commands",
    )
    expect(componentSchema(effect, "LayoutConfig")?.description).toBe("@deprecated Always uses stretch layout.")
  })

  test("preserves representative branded ID patterns and property descriptions", () => {
    const effect = effectOpenApi() as OpenApiSpec

    expect(
      parameterSchema({ spec: effect, path: "/session/{sessionID}", method: "get", name: "sessionID" }),
    ).toEqual({
      type: "string",
      pattern: "^ses.*",
    })
    expect(
      parameterSchema({
        spec: effect,
        path: "/session/{sessionID}/message/{messageID}",
        method: "get",
        name: "messageID",
      }),
    ).toEqual({ type: "string", pattern: "^msg.*" })
    expect(
      componentSchema(effect, "EventTuiSessionSelect")?.properties?.properties?.properties?.sessionID,
    ).toMatchObject({
      description: "Session ID to navigate to",
    })
  })
  test("matches SDK-affecting request schema details", () => {
    const effect = effectOpenApi()
    const sessionUpdate = effect.paths["/session/{sessionID}"]?.patch?.requestBody
    const sessionUpdateSchema =
      typeof sessionUpdate === "object" && sessionUpdate && "content" in sessionUpdate
        ? sessionUpdate.content?.["application/json"]?.schema
        : undefined
    const sessionUpdateProperties = sessionUpdateSchema?.properties as Record<string, OpenApiSchema> | undefined
    const time = sessionUpdateProperties?.time
    expect(time?.properties?.archived).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] })
  })

  test("documents event routes as server-sent events", () => {
    const effect = effectOpenApi()

    expect(responseContentTypes({ spec: effect, path: "/event", method: "get", status: "200" })).toEqual([
      "text/event-stream",
    ])
    expect(responseContentTypes({ spec: effect, path: "/global/event", method: "get", status: "200" })).toEqual([
      "text/event-stream",
    ])
  })

  test("allows requests when auth is disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/hello.txt`, "hello")

    const response = await app().request(fileUrl(), {
      headers: {
        "x-chimera-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ content: "hello" })
  })

  test("provides instance context to bridged handlers", async () => {
    await using tmp = await tmpdir({ git: true })

    const response = await app().request("/project/current", {
      headers: {
        "x-chimera-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ worktree: tmp.path })
  })

  test("requires credentials when auth is enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/hello.txt`, "hello")

    const [missing, bad, good] = await Promise.all([
      app({ password: "secret" }).request(fileUrl(), {
        headers: { "x-chimera-directory": tmp.path },
      }),
      app({ password: "secret" }).request(fileUrl(), {
        headers: {
          authorization: authorization("chimera", "wrong"),
          "x-chimera-directory": tmp.path,
        },
      }),
      app({ password: "secret" }).request(fileUrl(), {
        headers: {
          authorization: authorization("chimera", "secret"),
          "x-chimera-directory": tmp.path,
        },
      }),
    ])

    expect(missing.status).toBe(401)
    expect(bad.status).toBe(401)
    expect(good.status).toBe(200)
  })

  test("accepts auth_token query credentials", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/hello.txt`, "hello")

    const response = await app({ password: "secret" }).request(
      fileUrl({ token: Buffer.from("chimera:secret").toString("base64") }),
      {
        headers: {
          "x-chimera-directory": tmp.path,
        },
      },
    )

    expect(response.status).toBe(200)
  })

  test("selects instance from query before directory header", async () => {
    await using header = await tmpdir({ git: true })
    await using query = await tmpdir({ git: true })
    await Bun.write(`${header.path}/hello.txt`, "header")
    await Bun.write(`${query.path}/hello.txt`, "query")

    const response = await app().request(fileUrl({ directory: query.path }), {
      headers: {
        "x-chimera-directory": header.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ content: "query" })
  })

  test("serves global health from Effect HttpApi", async () => {
    const response = await app().request(`${GlobalPaths.health}?directory=/does/not/exist/opencode-test`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true })
  })

  test("serves global event stream from Effect HttpApi", async () => {
    const response = await app().request(GlobalPaths.event)
    if (!response.body) throw new Error("missing event stream body")
    const reader = response.body.getReader()
    const chunk = await reader.read()
    await reader.cancel()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(new TextDecoder().decode(chunk.value)).toContain('"directory":"global"')
    expect(new TextDecoder().decode(chunk.value)).toContain("server.connected")
  })

  test("serves control log from Effect HttpApi", async () => {
    const response = await app().request(ControlPaths.log, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "httpapi-test", level: "info", message: "hello" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
  })

  test("validates control auth without falling through to 404", async () => {
    const response = await app().request(ControlPaths.auth.replace(":providerID", "test"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api" }),
    })

    expect(response.status).toBe(400)
  })

  test("validates global upgrade without invoking installers", async () => {
    const response = await app().request(GlobalPaths.upgrade, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false })
  })
})
