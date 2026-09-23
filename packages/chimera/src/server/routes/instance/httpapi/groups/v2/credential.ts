// (L5.4b) Fork adaptation of the upstream v2 credential group
// (upstream packages/protocol/src/groups/credential.ts, connector auth
// dac0dd5309 lineage). Same deviations as the integration group: no
// LocationQuery, bare success payloads. Credential storage lives in the
// isolated chimera-v2.db trunk (L5.2 credential runtime).
import { Credential } from "@opencode-ai/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export const CredentialPaths = {
  update: "/api/credential/:credentialID",
  remove: "/api/credential/:credentialID",
} as const

export const CredentialGroup = HttpApiGroup.make("v2.credential")
  .add(
    HttpApiEndpoint.patch("update", CredentialPaths.update, {
      params: { credentialID: Credential.ID },
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.credential.update",
        summary: "Update credential",
        description: "Update a stored credential label.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("remove", CredentialPaths.remove, {
      params: { credentialID: Credential.ID },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.credential.remove",
        summary: "Remove credential",
        description: "Remove a stored integration credential.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "v2 credentials",
      description: "Stored integration credential management routes.",
    }),
  )
