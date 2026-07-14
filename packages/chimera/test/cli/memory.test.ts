import { describe, expect, test } from "bun:test"
import {
  ForgetCommand,
  ImportCommand,
  ListCommand,
  MemoryCommand,
  RebuildCommand,
  RememberCommand,
  ResetCommand,
  StatusCommand,
  UpdateCommand,
} from "../../src/cli/cmd/memory"

describe("memory CLI", () => {
  test("registers the management command lane and remember alias", () => {
    expect(MemoryCommand.command).toBe("memory")
    expect(RememberCommand.aliases).toBe("add")
    expect(
      [StatusCommand, RememberCommand, ListCommand, UpdateCommand, ForgetCommand, ResetCommand, ImportCommand, RebuildCommand].map(
        (command) => command.command,
      ),
    ).toEqual([
      "status",
      "remember <text>",
      "list",
      "update <id> <text>",
      "forget <id>",
      "reset",
      "import <file>",
      "rebuild",
    ])
  })
})
