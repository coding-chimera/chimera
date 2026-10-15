import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import "@/server/event"
import { WebUIPreferences } from "@/server/webui-preferences"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([...BusEvent.effectPayloads(), ...SyncEvent.effectPayloads()]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

export const GlobalPresenceInput = Schema.Struct({
  directories: Schema.Array(Schema.String),
})

const GlobalPresenceResult = Schema.Struct({
  ok: Schema.Literal(true),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  preferences: "/global/preferences",
  config: "/global/config",
  dispose: "/global/dispose",
  presence: "/global/presence",
  upgrade: "/global/upgrade",
  browserArtifact: "/global/browser-artifact/:projectHash/:sessionHash/:filename",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("preferencesGet", GlobalPaths.preferences, {
        success: described(WebUIPreferences.Snapshot, "WebUI preferences snapshot"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preferences.get",
          summary: "Get WebUI preferences",
          description: "Retrieve the server-global shared WebUI preferences snapshot.",
        }),
      ),
      HttpApiEndpoint.put("preferencesUpdate", GlobalPaths.preferences, {
        payload: WebUIPreferences.Update,
        success: described(WebUIPreferences.Snapshot, "Updated WebUI preferences snapshot"),
        error: [HttpApiError.BadRequest, WebUIPreferences.RevisionConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.preferences.update",
          summary: "Update WebUI preferences",
          description: "Replace the server-global shared WebUI preferences using revision compare-and-swap.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(Config.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: Config.Info,
        success: described(Config.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("presence", GlobalPaths.presence, {
        payload: GlobalPresenceInput,
        success: described(GlobalPresenceResult, "Presence recorded"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.presence",
          summary: "Report WebUI presence",
          description:
            "Presence heartbeat for the WebUI: refreshes the instance presence pin (TTL 90s by default) for every reported directory that currently has a loaded instance, protecting it from idle-TTL and memory-pressure eviction while the UI is open. Directories without a loaded instance are ignored; presence never boots an instance. The WebUI reports its active directories every 30s. Payloads above 512 directories are truncated.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.get("browserArtifact", GlobalPaths.browserArtifact, {
        params: {
          projectHash: Schema.String,
          sessionHash: Schema.String,
          filename: Schema.String,
        },
        success: described(Schema.Uint8Array, "Artifact image bytes"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.browserArtifact",
          summary: "Get browser artifact image",
          description:
            "Serve one image artifact written by the browser tools from the managed browser-artifact directory. Path parameters are the project/session hashes embedded in the artifact URLs returned by browser_screenshot; traversal outside the artifact root, unknown content types, and missing files all answer 404. Served without instance middleware so HTML <img> tags can load it directly.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
