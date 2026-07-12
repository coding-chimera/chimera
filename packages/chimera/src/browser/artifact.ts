export * as BrowserArtifact from "./artifact"

import { Context, Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstanceState } from "@/effect/instance-state"
import { ulid } from "ulid"

export type Kind = "screenshot" | "trace" | "har" | "console" | "snapshot" | "scenario"

export interface Artifact {
  readonly kind: Kind
  readonly path: string
  readonly filename: string
  readonly mime: string
}

export interface Attachment {
  readonly type: "file"
  readonly mime: string
  readonly filename: string
  readonly url: string
}

export interface WriteInput {
  readonly sessionID: string
  readonly kind: Kind
  readonly name?: string
  readonly extension: string
  readonly mime: string
  readonly data: Uint8Array | string
}

export class PathError extends Schema.TaggedErrorClass<PathError>()("BrowserArtifactPathError", {
  message: Schema.String,
  path: Schema.String,
}) {}

export interface Interface {
  readonly runtimeDirectory: Effect.Effect<string, PlatformError.PlatformError>
  readonly sessionDirectory: (sessionID: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly write: (input: WriteInput) => Effect.Effect<Artifact, PlatformError.PlatformError | PathError>
  readonly read: (artifact: Artifact) => Effect.Effect<Uint8Array, PlatformError.PlatformError | PathError>
  readonly attachment: (artifact: Artifact) => Effect.Effect<Attachment, PlatformError.PlatformError | PathError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserArtifact") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const global = yield* Global.Service
    const state = yield* InstanceState.make((ctx) =>
      Effect.gen(function* () {
        const projectKey = Hash.fast(`${ctx.project.id}\u0000${ctx.directory}`).slice(0, 24)
        const temporaryRoot = path.join(global.tmp, "browser", projectKey)
        yield* fs.makeDirectory(temporaryRoot, { recursive: true })
        return {
          runtimeDirectory: yield* fs.makeTempDirectoryScoped({ directory: temporaryRoot, prefix: "runtime-" }),
          persistentRoot: path.join(global.data, "browser-artifacts", projectKey),
        }
      }),
    )

    const sessionDirectory = Effect.fn("BrowserArtifact.sessionDirectory")(function* (sessionID: string) {
      return yield* InstanceState.useEffect(state, (current) =>
        Effect.gen(function* () {
          const directory = path.join(current.persistentRoot, Hash.fast(sessionID).slice(0, 24))
          yield* fs.makeDirectory(directory, { recursive: true })
          return directory
        }),
      )
    })

    const checked = Effect.fnUntraced(function* (root: string, candidate: string) {
      const resolvedRoot = path.resolve(root)
      const resolved = path.resolve(candidate)
      const relative = path.relative(resolvedRoot, resolved)
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return resolved
      return yield* new PathError({ message: "Browser artifact path escaped its managed directory", path: candidate })
    })

    return Service.of({
      runtimeDirectory: InstanceState.use(state, (current) => current.runtimeDirectory),
      sessionDirectory,
      write: Effect.fn("BrowserArtifact.write")(function* (input: WriteInput) {
        const directory = yield* sessionDirectory(input.sessionID)
        const extension = input.extension.replace(/^\.+/, "").replace(/[^a-zA-Z0-9]+/g, "") || "bin"
        const name = (input.name ?? input.kind)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^[-.]+|[-.]+$/g, "")
          .slice(0, 80)
        const filename = `${ulid()}-${name || input.kind}.${extension}`
        const destination = yield* checked(directory, path.join(directory, filename))
        if (typeof input.data === "string") yield* fs.writeFileString(destination, input.data)
        else yield* fs.writeFile(destination, input.data)
        return { kind: input.kind, path: destination, filename, mime: input.mime }
      }),
      read: Effect.fn("BrowserArtifact.read")(function* (artifact: Artifact) {
        const directory = path.dirname(artifact.path)
        yield* checked(directory, artifact.path)
        return yield* fs.readFile(artifact.path)
      }),
      attachment: Effect.fn("BrowserArtifact.attachment")(function* (artifact: Artifact) {
        const bytes = yield* fs.readFile(artifact.path)
        return {
          type: "file" as const,
          mime: artifact.mime,
          filename: artifact.filename,
          url: `data:${artifact.mime};base64,${Buffer.from(bytes).toString("base64")}`,
        }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer),
  Layer.provide(Global.defaultLayer),
)
