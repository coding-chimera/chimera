import { describe, expect, spyOn, test } from "bun:test"
import { text } from "node:stream/consumers"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import type { InstanceContext } from "@/project/instance"
import * as LSPServer from "@/lsp/server"
import * as Which from "@/util/which"
import { spawn } from "@/lsp/launch"

const ctx = { directory: process.cwd() } as InstanceContext

function mockWhich(found: Record<string, string>) {
  return spyOn(Which, "which").mockImplementation((cmd) => found[cmd] ?? null)
}
const npm: LSPServer.NpmCommand = async () => undefined
const command: LSPServer.CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" })

describe("LSP installer commands", () => {
  test("installs gopls with GOBIN through the injected runner", async () => {
    const which = mockWhich({ go: "/usr/bin/go" })
    const calls: { cmd: string[]; opts?: { env?: Record<string, string> } }[] = []
    try {
      const result = await LSPServer.Gopls.spawn(process.cwd(), ctx, async (cmd, opts) => {
        calls.push({ cmd, opts: opts?.env ? { env: Object.fromEntries(Object.entries(opts.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) } : undefined })
        return 1
      }, npm, command)

      expect(result).toBeUndefined()
      expect(calls).toEqual([
        {
          cmd: ["go", "install", "golang.org/x/tools/gopls@latest"],
          opts: { env: { GOBIN: Global.Path.bin } },
        },
      ])
    } finally {
      which.mockRestore()
    }
  })

  test("installs rubocop through the injected runner", async () => {
    const which = mockWhich({ ruby: "/usr/bin/ruby", gem: "/usr/bin/gem" })
    const calls: string[][] = []
    try {
      const result = await LSPServer.Rubocop.spawn(process.cwd(), ctx, async (cmd) => {
        calls.push(cmd)
        return 1
      }, npm, command)

      expect(result).toBeUndefined()
      expect(calls).toEqual([["gem", "install", "rubocop", "--bindir", Global.Path.bin]])
    } finally {
      which.mockRestore()
    }
  })

  test("deduplicates concurrent Roslyn installs through the injected runner", async () => {
    const which = mockWhich({ dotnet: "/usr/bin/dotnet" })
    const home = process.env.DOTNET_CLI_HOME
    process.env.DOTNET_CLI_HOME = process.cwd()
    const calls: string[][] = []
    try {
      const install: LSPServer.InstallerCommand = async (cmd) => {
        calls.push(cmd)
        await Promise.resolve()
        return 1
      }
      const result = await Promise.all([
        LSPServer.CSharp.spawn(process.cwd(), ctx, install, npm, command),
        LSPServer.CSharp.spawn(process.cwd(), ctx, install, npm, command),
      ])

      expect(result).toEqual([undefined, undefined])
      expect(calls).toEqual([
        ["dotnet", "tool", "install", "--global", "roslyn-language-server", "--prerelease"],
      ])
    } finally {
      if (home === undefined) delete process.env.DOTNET_CLI_HOME
      else process.env.DOTNET_CLI_HOME = home
      which.mockRestore()
    }
  })

  test("installs fsautocomplete through the injected runner", async () => {
    const which = mockWhich({ dotnet: "/usr/bin/dotnet" })
    const calls: string[][] = []
    try {
      const result = await LSPServer.FSharp.spawn(process.cwd(), ctx, async (cmd) => {
        calls.push(cmd)
        return 1
      }, npm, command)

      expect(result).toBeUndefined()
      expect(calls).toEqual([
        ["dotnet", "tool", "install", "fsautocomplete", "--tool-path", Global.Path.bin],
      ])
    } finally {
      which.mockRestore()
    }
  })

  test("does not invoke the installer runner when LSP downloads are disabled", async () => {
    const which = mockWhich({ go: "/usr/bin/go" })
    const disabled = Flag.OPENCODE_DISABLE_LSP_DOWNLOAD
    Flag.OPENCODE_DISABLE_LSP_DOWNLOAD = true
    let called = false
    try {
      const result = await LSPServer.Gopls.spawn(process.cwd(), ctx, async () => {
        called = true
        return 0
      }, npm, command)

      expect(result).toBeUndefined()
      expect(called).toBe(false)
    } finally {
      Flag.OPENCODE_DISABLE_LSP_DOWNLOAD = disabled
      which.mockRestore()
    }
  })
})


describe("LSP process launch", () => {
  test("bridges stdin, stdout, exit, and cleanup through Effect process handles", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"])
    child.stdin.end("hello")

    expect(await text(child.stdout)).toBe("hello")
    expect(await child.exited).toBe(0)
    await child.stop()
  })
})
