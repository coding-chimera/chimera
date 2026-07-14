import type { Argv } from "yargs"
import { Effect } from "effect"
import { MemoryManagement } from "@/memory/management"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"

const scopes = ["global", "project"] as const
const statusScopes = ["global", "project", "all"] as const

function output(value: unknown, json: boolean | undefined) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => console.log(`${item.id}\t${item.scope}\t${item.text}`))
    return
  }
  console.log(JSON.stringify(value, null, 2))
}

const run = <A>(effect: Effect.Effect<A, MemoryManagement.Error>) =>
  effect.pipe(Effect.catch((error) => fail(error.data.message)))

const jsonOption = <A>(yargs: Argv<A>) =>
  yargs.option("json", {
    describe: "print machine-readable JSON",
    type: "boolean",
    default: false,
  })

export const StatusCommand = effectCmd({
  command: "status",
  describe: "show memory settings and statistics",
  builder: (yargs) =>
    jsonOption(yargs).option("scope", {
      choices: statusScopes,
      default: "all" as const,
      describe: "memory scope to inspect",
    }),
  handler: Effect.fn("Cli.memory.status")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* memory.status(args.scope), args.json)
  }),
})

export const RememberCommand = effectCmd({
  command: "remember <text>",
  aliases: "add",
  describe: "create a memory note",
  builder: (yargs) =>
    jsonOption(
      yargs
        .positional("text", { type: "string", demandOption: true, describe: "text to remember" })
        .option("scope", { choices: scopes, default: "project" as const, describe: "memory scope" }),
    ),
  handler: Effect.fn("Cli.memory.remember")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* run(memory.create(new MemoryManagement.CreateInput({ text: args.text, scope: args.scope }))), args.json)
  }),
})

export const ListCommand = effectCmd({
  command: "list",
  describe: "list active memory notes",
  builder: (yargs) =>
    jsonOption(yargs).option("scope", {
      choices: scopes,
      default: "project" as const,
      describe: "memory scope",
    }),
  handler: Effect.fn("Cli.memory.list")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* memory.list(args.scope), args.json)
  }),
})

export const UpdateCommand = effectCmd({
  command: "update <id> <text>",
  describe: "update a memory note",
  builder: (yargs) =>
    jsonOption(
      yargs
        .positional("id", { type: "string", demandOption: true, describe: "memory note ID" })
        .positional("text", { type: "string", demandOption: true, describe: "replacement text" }),
    ),
  handler: Effect.fn("Cli.memory.update")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* run(memory.update(args.id, new MemoryManagement.UpdateInput({ text: args.text }))), args.json)
  }),
})

export const ForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "forget a memory note",
  builder: (yargs) =>
    jsonOption(yargs.positional("id", { type: "string", demandOption: true, describe: "memory note ID" })),
  handler: Effect.fn("Cli.memory.forget")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* run(memory.forget(args.id)), args.json)
  }),
})

export const ResetCommand = effectCmd({
  command: "reset",
  describe: "clear one memory scope",
  builder: (yargs) =>
    jsonOption(yargs)
      .option("scope", { choices: scopes, default: "project" as const, describe: "memory scope" })
      .option("yes", { type: "boolean", default: false, describe: "confirm destructive reset" }),
  handler: Effect.fn("Cli.memory.reset")(function* (args) {
    if (!args.yes) return yield* fail("Memory reset requires --yes")
    const memory = yield* MemoryManagement.Service
    output(
      yield* run(memory.reset(new MemoryManagement.ResetInput({ scope: args.scope, confirm: true }))),
      args.json,
    )
  }),
})

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import a legacy schemaVersion 1 memory file",
  builder: (yargs) =>
    jsonOption(yargs.positional("file", { type: "string", demandOption: true, describe: "legacy JSON file" })),
  handler: Effect.fn("Cli.memory.import")(function* (args) {
    const file = Bun.file(args.file)
    if (!(yield* Effect.promise(() => file.exists()))) return yield* fail(`Memory import file not found: ${args.file}`)
    const memory = yield* MemoryManagement.Service
    output(yield* run(memory.importLegacy(yield* Effect.promise(() => file.bytes()))), args.json)
  }),
})

export const RebuildCommand = effectCmd({
  command: "rebuild",
  describe: "queue asynchronous memory consolidation",
  builder: (yargs) =>
    jsonOption(yargs).option("scope", {
      choices: scopes,
      default: "project" as const,
      describe: "memory scope",
    }),
  handler: Effect.fn("Cli.memory.rebuild")(function* (args) {
    const memory = yield* MemoryManagement.Service
    output(yield* run(memory.rebuild(new MemoryManagement.RebuildInput({ scope: args.scope }))), args.json)
  }),
})

export const MemoryCommand = cmd({
  command: "memory",
  describe: "manage cross-session memory",
  builder: (yargs: Argv) =>
    yargs
      .command(StatusCommand)
      .command(RememberCommand)
      .command(ListCommand)
      .command(UpdateCommand)
      .command(ForgetCommand)
      .command(ResetCommand)
      .command(ImportCommand)
      .command(RebuildCommand)
      .demandCommand(),
  async handler() {},
})
