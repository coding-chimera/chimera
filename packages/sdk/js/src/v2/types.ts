// V2 data-contract types for `@opencode-ai/sdk/v2/types`.
//
// Upstream opencode generates this surface from its v2 server OpenAPI
// (`src/v2/gen/types.gen.ts`). This fork's server is still v1, so the
// equivalent contracts are sourced from `@opencode-ai/schema` (the v2 data
// contract package) under their schema names:
//
//   AgentV2Info            <- Agent.Info
//   ModelV2Info            <- Model.Info
//   ProviderV2Info         <- Provider.Info
//   CommandV2Info          <- Command.Info
//   FileSystemEntry        <- FileSystem.Entry
//   SkillV2Source          <- Skill.Source
//   ReferenceGitSource     <- Reference.GitSource
//   ReferenceLocalSource   <- Reference.LocalSource
//   CredentialOAuth        <- Credential.OAuth
//   CredentialValue        <- Credential.Value
//   ConnectionInfo         <- Connection.Info
//   IntegrationEnvMethod   <- Integration.EnvMethod
//   IntegrationInputs      <- Integration.Inputs
//   IntegrationKeyMethod   <- Integration.KeyMethod
//   IntegrationMethod      <- Integration.Method
//   IntegrationOAuthMethod <- Integration.OAuthMethod
//   IntegrationRef         <- Integration.Ref
//   Event                  <- distributive Event.Payload union over EventManifest.Definitions

import type {
  Agent,
  Command,
  Connection,
  Credential,
  Event as SchemaEvent,
  FileSystem,
  Integration,
  Model,
  Provider,
  Reference,
  Skill,
} from "@opencode-ai/schema"
import type { EventManifest } from "@opencode-ai/schema/event-manifest"

// Upstream's generated v2 types are plain mutable JSON shapes (OpenAPI codegen:
// unbranded strings, `{[key: string]: unknown}` bodies), and the byte-identical
// upstream plugin surface mutates draft values through them (catalog
// provider/model drafts, integration drafts). The schema-sourced aliases below
// are readonly, branded effect Schema types, so draft-facing aliases are
// normalized with `Plain` to restore the upstream generated-type contract:
// readonly stripped, brands erased to their primitive base, and exact
// `Schema.Json` values loosened to `unknown` (a `Record<string, Json>` becomes
// `Record<string, unknown>`, matching codegen). Value-returning aliases
// (credentials, connections, events) stay readonly: hosts cast at the
// boundary, exactly like upstream's PluginHost `mutable()` adapter.
type JsonShape = null | number | boolean | string | readonly JsonShape[] | { readonly [key: string]: JsonShape }
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false

export type Plain<T> = Exact<T, JsonShape> extends true ? unknown : PlainInner<T>

type PlainInner<T> =
  T extends string
    ? // Branded strings (`string & Brand<...>`) intersect with object; literals do not.
      T extends object
      ? string
      : T
    : T extends number
      ? T extends object
        ? number
        : T
        : T extends boolean | bigint | symbol | Function
          ? T
          : T extends null | undefined
            ? T
            : T extends readonly [unknown, ...unknown[]]
              ? { -readonly [K in keyof T]: Plain<T[K]> }
              : T extends readonly (infer U)[]
                ? Plain<U>[]
                : T extends object
                  ? { -readonly [K in keyof T]: Plain<T[K]> }
                  : T

export type AgentV2Info = Agent.Info
export type ModelV2Info = Plain<Model.Info>
export type ProviderV2Info = Plain<Provider.Info>
export type CommandV2Info = Command.Info
export type FileSystemEntry = FileSystem.Entry

export type SkillV2Source = Skill.Source
export type ReferenceGitSource = Reference.GitSource
export type ReferenceLocalSource = Reference.LocalSource

export type CredentialOAuth = Credential.OAuth
export type CredentialValue = Credential.Value
export type ConnectionInfo = Connection.Info

export type IntegrationEnvMethod = Integration.EnvMethod
export type IntegrationInputs = Integration.Inputs
export type IntegrationKeyMethod = Integration.KeyMethod
export type IntegrationMethod = Integration.Method
export type IntegrationOAuthMethod = Integration.OAuthMethod
export type IntegrationRef = Plain<Integration.Ref>

type EventPayload<Definition extends SchemaEvent.Definition> = Definition extends unknown
  ? SchemaEvent.Payload<Definition>
  : never

export type Event = EventPayload<(typeof EventManifest.Definitions)[number]>
