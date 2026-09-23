// (L5.4b) Fork adaptation of the upstream v2 integration group
// (upstream packages/protocol/src/groups/integration.ts, connector auth
// dac0dd5309 lineage). Deviations from the upstream wire contract, both
// forced by the fork having no v2 server/location tree:
// - no LocationQuery / location middleware: the trunk is wired globally
//   (chimera-v2.db) through src/server/v2-integration.ts
// - success payloads are the bare data schemas instead of the upstream
//   Location.response({location, data}) envelope
// Paths, methods, operation identifiers, and payload shapes mirror upstream.
import { Integration } from "@opencode-ai/schema/integration"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const Inputs = Schema.Record(Schema.String, Schema.String)

export const IntegrationPaths = {
  list: "/api/integration",
  get: "/api/integration/:integrationID",
  connectKey: "/api/integration/:integrationID/connect/key",
  connectOauth: "/api/integration/:integrationID/connect/oauth",
  attempt: "/api/integration/attempt/:attemptID",
  attemptComplete: "/api/integration/attempt/:attemptID/complete",
} as const

export const IntegrationGroup = HttpApiGroup.make("v2.integration")
  .add(
    HttpApiEndpoint.get("list", IntegrationPaths.list, {
      success: Schema.Array(Integration.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.list",
        summary: "List integrations",
        description: "Retrieve available integrations and their authentication methods.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("get", IntegrationPaths.get, {
      params: { integrationID: Integration.ID },
      success: Schema.UndefinedOr(Integration.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.get",
        summary: "Get integration",
        description: "Retrieve one integration and its authentication methods.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connectKey", IntegrationPaths.connectKey, {
      params: { integrationID: Integration.ID },
      payload: Schema.Struct({
        key: Schema.String,
        label: Schema.optional(Schema.String),
      }),
      success: HttpApiSchema.NoContent,
      error: HttpApiError.BadRequest,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.connect.key",
        summary: "Connect with key",
        description: "Run a key authentication method and store the resulting credential.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connectOauth", IntegrationPaths.connectOauth, {
      params: { integrationID: Integration.ID },
      payload: Schema.Struct({
        methodID: Integration.MethodID,
        inputs: Inputs,
        label: Schema.optional(Schema.String),
      }),
      success: Integration.Attempt,
      error: HttpApiError.BadRequest,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.connect.oauth",
        summary: "Begin OAuth connection",
        description: "Start an OAuth attempt and return the authorization details.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("attemptStatus", IntegrationPaths.attempt, {
      params: { attemptID: Integration.AttemptID },
      success: Integration.AttemptStatus,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.attempt.status",
        summary: "Get OAuth attempt status",
        description: "Poll the current status of an OAuth attempt.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("attemptComplete", IntegrationPaths.attemptComplete, {
      params: { attemptID: Integration.AttemptID },
      payload: Schema.Struct({ code: Schema.optional(Schema.String) }),
      success: HttpApiSchema.NoContent,
      error: HttpApiError.BadRequest,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.attempt.complete",
        summary: "Complete OAuth connection",
        description: "Complete a code-based OAuth attempt and store the resulting credential.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("attemptCancel", IntegrationPaths.attempt, {
      params: { attemptID: Integration.AttemptID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.integration.attempt.cancel",
        summary: "Cancel OAuth connection",
        description: "Cancel an OAuth attempt and release its resources.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "v2 integrations",
      description: "Integration discovery and authentication routes (upstream connector-auth surface).",
    }),
  )
