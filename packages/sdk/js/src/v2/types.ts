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

export type AgentV2Info = Agent.Info
export type ModelV2Info = Model.Info
export type ProviderV2Info = Provider.Info
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
export type IntegrationRef = Integration.Ref

type EventPayload<Definition extends SchemaEvent.Definition> = Definition extends unknown
  ? SchemaEvent.Payload<Definition>
  : never

export type Event = EventPayload<(typeof EventManifest.Definitions)[number]>
