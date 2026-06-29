export * as ConfigModelSelection from "./model-selection"

import path from "path"
import { Schema, Types } from "effect"
import { Global } from "@opencode-ai/core/global"
import { BusEvent } from "@/bus/bus-event"
import { Filesystem } from "@/util/filesystem"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const ModelKey = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
})
  .annotate({ identifier: "ModelSelectionKey" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ModelKey = Types.DeepMutable<Schema.Schema.Type<typeof ModelKey>>

export const Info = Schema.Struct({
  model: Schema.Record(Schema.String, ModelKey),
  recent: Schema.Array(ModelKey),
  favorite: Schema.Array(ModelKey),
  variant: Schema.Record(Schema.String, Schema.String),
})
  .annotate({ identifier: "ModelSelection" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Patch = Schema.Struct({
  model: Schema.optional(Schema.Record(Schema.String, ModelKey)),
  recent: Schema.optional(Schema.Array(ModelKey)),
  favorite: Schema.optional(Schema.Array(ModelKey)),
  variant: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
})
  .annotate({ identifier: "ModelSelectionPatch" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Patch = Types.DeepMutable<Schema.Schema.Type<typeof Patch>>
type PatchInput = Schema.Schema.Type<typeof Patch>

export const Updated = BusEvent.define("config.model_selection.updated", Info)

export const empty: Info = {
  model: {},
  recent: [],
  favorite: [],
  variant: {},
}

function filePath() {
  return path.join(Global.Path.state, "model.json")
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function modelKey(value: unknown): ModelKey | undefined {
  const item = record(value)
  if (!item) return undefined
  if (typeof item.providerID !== "string") return undefined
  if (typeof item.modelID !== "string") return undefined
  return { providerID: item.providerID, modelID: item.modelID }
}

function modelRecord(value: unknown) {
  return Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([key, item]) => {
      const model = modelKey(item)
      return model ? [[key, model]] : []
    }),
  )
}

function modelList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const model = modelKey(item)
    return model ? [model] : []
  })
}

function variantRecord(value: unknown) {
  return Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([key, item]) => {
      if (typeof item !== "string") return []
      return [[key, item]]
    }),
  )
}

export function normalize(value: unknown): Info {
  const data = record(value)
  if (!data) return empty
  return {
    model: modelRecord(data.model),
    recent: modelList(data.recent),
    favorite: modelList(data.favorite),
    variant: variantRecord(data.variant),
  }
}

export async function read() {
  return Filesystem.readJson(filePath()).then(normalize).catch(() => empty)
}

export async function write(value: Info) {
  const next = normalize(value)
  await Filesystem.writeJson(filePath(), next)
  return next
}

export async function update(patch: PatchInput) {
  const current = await read()
  const variant = { ...current.variant }
  for (const [key, value] of Object.entries(patch.variant ?? {})) {
    if (value === null) {
      delete variant[key]
    } else {
      variant[key] = value
    }
  }
  return write({
    model: patch.model ? { ...current.model, ...modelRecord(patch.model) } : current.model,
    recent: patch.recent ? modelList(patch.recent) : current.recent,
    favorite: patch.favorite ? modelList(patch.favorite) : current.favorite,
    variant,
  })
}
