import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { Ledger } from "@/lsp/ledger"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { formatWrittenBlock, splitText } from "./hashline"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { Chimera } from "@/chimera"
import { Config } from "@/config/config"
import { collectMutationDiagnostics, renderMutationTail } from "./mutation-diagnostics"

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
  replay: Schema.optional(Schema.String).annotate({
    description:
      "Replay key from a blocked call of this same tool: reuses the stashed input from that blocked attempt; other arguments are ignored. Only valid after the gate that blocked it is satisfied.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service
    const ledger = yield* Ledger.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.replay) {
            const stashed = Chimera.resolveBlockedMutation({ sessionID: ctx.sessionID, toolID: "write", key: params.replay })
            if (stashed === undefined)
              throw new Error(
                `Unknown, expired, or mismatched replay key "${params.replay}". Re-issue the full call with complete arguments.`,
              )
            params = stashed as Params
          }
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text
          let written = contentNew

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          const predesign = yield* Chimera.requirePredesignForMutation({ toolID: "write", ctx, files: [filepath], params })
          if (!predesign.allowed) return predesign.result
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* Chimera.trackToolMutation(
            {
              toolID: "write",
              ctx,
              files: [filepath],
              bus,
              metadata: {
                exists,
                filePath: filepath,
                diff,
              },
            },
            Effect.gen(function* () {
              yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filepath)) {
                written = yield* Bom.syncFile(fs, filepath, desiredBom)
              }
              yield* bus.publish(File.Event.Edited, { file: filepath })
              yield* bus.publish(FileWatcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
            }),
          )

          const lineCount = contentNew === "" ? 0 : contentNew.replace(/\n$/, "").split(/\r?\n/).length
          let output = `File written successfully. ${lineCount} lines written.`
          const writtenLines = splitText(written).lines
          if (writtenLines.length > 0) output += `\n\n${formatWrittenBlock(writtenLines)}`
          const { diagnostics } = yield* collectMutationDiagnostics({
            lsp,
            config,
            ctx,
            toolID: "write",
            files: [filepath],
          })
          output += yield* renderMutationTail({ ledger, config, sessionID: ctx.sessionID,
            files: [{ file: filepath, label: "this file" }],
            diagnostics,
          probeTargets: [{ file: filepath }], })
          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
