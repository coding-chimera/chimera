import { SyncEvent } from "@/sync"
import { MessageID } from "@/session/schema"
import { Modelv2 } from "./model"
import { Event as SchemaEvent } from "@opencode-ai/schema/event"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { SessionMessage as SchemaSessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent as SchemaSessionEvent } from "@opencode-ai/schema/session-event"

// The session event contract (shapes, versions, durable metadata) is owned by
// @opencode-ai/schema. This bridge attaches the fork's SyncEvent publish
// definition to each canonical definition so the flag-gated EventV2 channel
// (see ./event.ts) can run and project them. Schema stays the single source
// of truth; this file only wires publishing.
function bridge<D extends SchemaEvent.Definition>(def: D) {
  const Sync = SyncEvent.define({
    type: def.type,
    version: def.durable?.version ?? 1,
    aggregate: def.durable?.aggregate ?? "sessionID",
    schema: def.data,
  })
  return Object.assign(def, { Sync }) as D & { Sync: SyncEvent.Definition<D["type"], D["data"], D["data"]> }
}

// Fork V1 identifiers share the msg_ wire prefix with schema's
// SessionMessage.ID, so values round-trip; these adapt the distinct
// TypeScript brands at the emit boundary.
export function messageID(id: MessageID): SchemaSessionMessage.ID {
  return SchemaSessionMessage.ID.make(id)
}

export function modelRef(model: Modelv2.Ref): Model.Ref {
  return {
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.providerID),
    variant: model.variant,
  }
}

export const Source = SchemaSessionEvent.Source
export type Source = typeof Source.Type

export const UnknownError = SchemaSessionEvent.UnknownError
export type UnknownError = SchemaSessionEvent.UnknownError

export const FileAttachment = SchemaSessionEvent.FileAttachment

export const AgentSwitched = bridge(SchemaSessionEvent.AgentSwitched)
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = bridge(SchemaSessionEvent.ModelSwitched)
export type ModelSwitched = typeof ModelSwitched.Type

export const Moved = bridge(SchemaSessionEvent.Moved)
export type Moved = typeof Moved.Type

export const Prompted = bridge(SchemaSessionEvent.Prompted)
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = bridge(SchemaSessionEvent.PromptAdmitted)
export type PromptAdmitted = typeof PromptAdmitted.Type

export const ContextUpdated = bridge(SchemaSessionEvent.ContextUpdated)
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = bridge(SchemaSessionEvent.Synthetic)
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = bridge(SchemaSessionEvent.Shell.Started)
  export type Started = typeof Started.Type

  export const Ended = bridge(SchemaSessionEvent.Shell.Ended)
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = bridge(SchemaSessionEvent.Step.Started)
  export type Started = typeof Started.Type

  export const Ended = bridge(SchemaSessionEvent.Step.Ended)
  export type Ended = typeof Ended.Type

  export const Failed = bridge(SchemaSessionEvent.Step.Failed)
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = bridge(SchemaSessionEvent.Text.Started)
  export type Started = typeof Started.Type

  export const Delta = bridge(SchemaSessionEvent.Text.Delta)
  export type Delta = typeof Delta.Type

  export const Ended = bridge(SchemaSessionEvent.Text.Ended)
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = bridge(SchemaSessionEvent.Reasoning.Started)
  export type Started = typeof Started.Type

  export const Delta = bridge(SchemaSessionEvent.Reasoning.Delta)
  export type Delta = typeof Delta.Type

  export const Ended = bridge(SchemaSessionEvent.Reasoning.Ended)
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  export namespace Input {
    export const Started = bridge(SchemaSessionEvent.Tool.Input.Started)
    export type Started = typeof Started.Type

    export const Delta = bridge(SchemaSessionEvent.Tool.Input.Delta)
    export type Delta = typeof Delta.Type

    export const Ended = bridge(SchemaSessionEvent.Tool.Input.Ended)
    export type Ended = typeof Ended.Type
  }

  export const Called = bridge(SchemaSessionEvent.Tool.Called)
  export type Called = typeof Called.Type

  export const Progress = bridge(SchemaSessionEvent.Tool.Progress)
  export type Progress = typeof Progress.Type

  export const Success = bridge(SchemaSessionEvent.Tool.Success)
  export type Success = typeof Success.Type

  export const Failed = bridge(SchemaSessionEvent.Tool.Failed)
  export type Failed = typeof Failed.Type
}

export const RetryError = SchemaSessionEvent.RetryError
export type RetryError = typeof RetryError.Type

export const Retried = bridge(SchemaSessionEvent.Retried)
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = bridge(SchemaSessionEvent.Compaction.Started)
  export type Started = typeof Started.Type

  export const Delta = bridge(SchemaSessionEvent.Compaction.Delta)
  export type Delta = typeof Delta.Type

  export const Ended = bridge(SchemaSessionEvent.Compaction.Ended)
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = bridge(SchemaSessionEvent.RevertEvent.Staged)
  export type Staged = typeof Staged.Type

  export const Cleared = bridge(SchemaSessionEvent.RevertEvent.Cleared)
  export type Cleared = typeof Cleared.Type

  export const Committed = bridge(SchemaSessionEvent.RevertEvent.Committed)
  export type Committed = typeof Committed.Type
}

export const Definitions = SchemaSessionEvent.Definitions
export const DurableDefinitions = SchemaSessionEvent.DurableDefinitions
export const Durable = SchemaSessionEvent.Durable
export type DurableEvent = SchemaSessionEvent.DurableEvent
export const All = SchemaSessionEvent.All
export type Event = SchemaSessionEvent.Event
export type Type = SchemaSessionEvent.Type

export * as SessionEvent from "./session-event"
