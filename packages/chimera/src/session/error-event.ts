import z from "zod"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/contracts/session-ids"
import { namedSchemaError } from "@/util/named-schema-error"
import { NonNegativeInt } from "@/util/schema"

// Neutral leaf for the assistant error schema and the `session.error` bus event.
//
// The config loaders (`config/agent.ts`, `config/command.ts`) only need
// `Session.Event.Error` to report a frontmatter parse failure. Importing the
// event through `session/session.ts` drags the whole session/message-v2/snapshot
// /lsp cluster into the config module and forms the largest file-level cycle in
// the layering gate. Keeping the error schema and the event definition here — a
// module that depends only on leaves — lets config publish the event without
// reaching into the session cluster.
//
// `message-v2.ts` re-exports the error schema classes so the `MessageV2.*`
// surface stays unchanged, and `session/session.ts` registers the canonical
// `Event.Error` definition through `BusEvent.define` at its historical position
// for API and registry-order compatibility.

export const OutputLengthError = namedSchemaError("MessageOutputLengthError", {})
export const AbortedError = namedSchemaError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedSchemaError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const AuthError = namedSchemaError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})
export const APIError = namedSchemaError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = namedSchemaError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

// Zod discriminated union kept for the legacy Hono OpenAPI path.
const AssistantErrorZod = z.discriminatedUnion("name", [
  AuthError.Schema,
  NamedError.Unknown.Schema,
  OutputLengthError.Schema,
  AbortedError.Schema,
  StructuredOutputError.Schema,
  ContextOverflowError.Schema,
  APIError.Schema,
])
export type AssistantError = z.infer<typeof AssistantErrorZod>

// Effect Schema for the same union — used by HttpApi OpenAPI generation.
export const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  Schema.Struct({ name: Schema.Literal("UnknownError"), data: Schema.Struct({ message: Schema.String }) }).annotate({
    identifier: "UnknownError",
  }),
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })

// Event schema for `session.error`. The bus-event registry is populated by
// `BusEvent.define` in registration order, and the generated OpenAPI event union
// follows that order. `session/session.ts` keeps the canonical `BusEvent.define`
// call at its historical position so the registry order is unchanged; this leaf
// exports the schema plus an unregistered definition for out-of-cluster
// publishers (the config loaders) that must not import `session/session.ts`.
export const ErrorSchema = Schema.Struct({
  sessionID: Schema.optional(SessionID),
  // Reuses the assistant error union (already Schema.optional) so
  // the derived zod keeps the same discriminated-union shape on the bus.
  error: Schema.optional(AssistantErrorSchema),
})

export const Error: BusEvent.Definition<"session.error", typeof ErrorSchema> = {
  type: "session.error",
  properties: ErrorSchema,
}

export * as SessionErrorEvent from "./error-event"