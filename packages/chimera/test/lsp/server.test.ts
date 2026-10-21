import { describe, expect, spyOn, test } from "bun:test"
import { text } from "node:stream/consumers"
import path from "path"
import fs from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import type { InstanceContext } from "@/project/instance"
import * as LSPServer from "@/lsp/server"
import * as Launch from "@/lsp/launch"
import type { Child } from "@/lsp/launch"
import * as Which from "@/util/which"
import { spawn } from "@/lsp/launch"
import { tmpdir } from "../fixture/fixture"

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

describe("Typescript server selection", () => {
  const fakeChild = {} as unknown as Child

  function mockSpawn() {
    const calls: { cmd: string; args: string[]; cwd?: string }[] = []
    const spy = spyOn(Launch, "spawn").mockImplementation(((cmd: string, args?: string[]) => {
      calls.push({ cmd, args: args ?? [] })
      return fakeChild
    }) as unknown as typeof Launch.spawn)
    return { calls, spy }
  }

  async function writePackageFile(pkgDir: string, name: string, content: string) {
    await fs.mkdir(path.dirname(path.join(pkgDir, name)), { recursive: true })
    await Bun.write(path.join(pkgDir, name), content)
  }

  test("spawns typescript-language-server when lib/tsserver.js resolves (TS <= 6)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pkgDir = path.join(dir, "node_modules", "typescript")
        await writePackageFile(pkgDir, "package.json", JSON.stringify({ name: "typescript", version: "5.8.2" }))
        await writePackageFile(pkgDir, "lib/tsserver.js", "// tsserver")
        return pkgDir
      },
    })
    const { calls, spy } = mockSpawn()
    const npmPackages: string[] = []
    try {
      const handle = await LSPServer.Typescript.spawn(
        tmp.path,
        { directory: tmp.path } as InstanceContext,
        async () => 0,
        async (pkg) => {
          npmPackages.push(pkg)
          return "/fake/typescript-language-server"
        },
        command,
      )
      expect(npmPackages).toEqual(["typescript-language-server"])
      expect(calls.length).toBe(1)
      expect(calls[0]!.cmd).toBe("/fake/typescript-language-server")
      expect(calls[0]!.args).toEqual(["--stdio"])
      expect(handle?.process).toBe(fakeChild)
      expect(handle?.initialization).toEqual({ tsserver: { path: path.join(tmp.extra, "lib", "tsserver.js") } })
    } finally {
      spy.mockRestore()
    }
  })

  test("spawns the workspace tsc --lsp --stdio when tsserver.js is gone but TS7 is installed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pkgDir = path.join(dir, "node_modules", "typescript")
        // Mimic the real typescript@7 exports map: subpaths like lib/tsserver.js and bin/tsc
        // are NOT exported, only ./package.json and the main entry resolve.
        await writePackageFile(
          pkgDir,
          "package.json",
          JSON.stringify({
            name: "typescript",
            version: "7.0.2",
            exports: { "./package.json": "./package.json", ".": "./lib/version.cjs" },
          }),
        )
        await writePackageFile(pkgDir, "lib/version.cjs", "module.exports = { version: '7.0.2' }")
        await writePackageFile(pkgDir, "bin/tsc", '#!/usr/bin/env node\nimport "../lib/tsc.js";\n')
        return pkgDir
      },
    })
    const { calls, spy } = mockSpawn()
    let npmCalled = false
    try {
      const handle = await LSPServer.Typescript.spawn(
        tmp.path,
        { directory: tmp.path } as InstanceContext,
        async () => 0,
        async () => {
          npmCalled = true
          return "/fake/typescript-language-server"
        },
        command,
      )
      expect(npmCalled).toBe(false)
      expect(calls).toEqual([{ cmd: "node", args: [path.join(tmp.extra, "bin", "tsc"), "--lsp", "--stdio"] }])
      expect(handle?.process).toBe(fakeChild)
      expect(handle?.initialization).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  test("returns undefined without spawning when typescript is not installed", async () => {
    await using tmp = await tmpdir()
    const { calls, spy } = mockSpawn()
    let npmCalled = false
    try {
      const handle = await LSPServer.Typescript.spawn(
        tmp.path,
        { directory: tmp.path } as InstanceContext,
        async () => 0,
        async () => {
          npmCalled = true
          return "/fake/typescript-language-server"
        },
        command,
      )
      expect(handle).toBeUndefined()
      expect(npmCalled).toBe(false)
      expect(calls).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
