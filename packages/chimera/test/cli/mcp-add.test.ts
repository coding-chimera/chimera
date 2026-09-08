// Subprocess tests for `chimera mcp add` non-interactive mode (upstream ba57718b05).
//
// Spawns the real CLI binary via `bun run src/index.ts mcp add ...` against an
// isolated HOME/XDG_* tmpdir, then asserts the MCP server entry landed in the
// global config file (fork default: ~/.config/chimera/chimera.json — the first
// candidate returned by resolveConfigPath when no chimera.json(c) exists yet).
// The CLI is spawned with `--conditions=browser` and cwd at the package root
// (same pattern as test/cli/run-process.test.ts) so the TUI's Solid JSX runtime
// resolves via the repo tsconfig (jsxImportSource: @opentui/solid).
//
// The two cases mirror upstream packages/opencode/test/cli/mcp-add.test.ts,
// adapted to the fork's config file name and subprocess spawn pattern
// (see test/cli/run-process.test.ts).

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

function isolatedEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ username: "probe", lsp: false, formatter: false }),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  }
}

function tmpdir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-add-test-"))
  const dataHome = path.join(home, ".local/share/chimera")
  fs.mkdirSync(dataHome, { recursive: true })
  // Pre-create the database marker so src/index.ts skips the one-time migration.
  fs.writeFileSync(path.join(dataHome, "chimera.db"), "")
  return home
}

async function runMcpAdd(home: string, args: string[]) {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", path.join(root, "src/index.ts"), "mcp", "add", ...args], {
    cwd: root,
    env: { ...process.env, ...isolatedEnv(home) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const exitCode = await child.exited
  return { exitCode, stdout: await stdout, stderr: await stderr }
}

describe("chimera mcp add (non-interactive subprocess)", () => {
  test("adds a remote server with HTTP headers", async () => {
    const home = tmpdir()
    try {
      const result = await runMcpAdd(home, [
        "github",
        "--url",
        "https://example.com/mcp",
        "--header",
        "Authorization=Bearer {env:GITHUB_TOKEN}",
        "--header",
        "X-Option=one=two",
      ])
      expect(result.exitCode, result.stderr).toBe(0)

      const config = await Bun.file(path.join(home, ".config", "chimera", "chimera.json")).json()
      expect(config.mcp.github).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer {env:GITHUB_TOKEN}",
          "X-Option": "one=two",
        },
      })
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true })
    }
  })

  test("adds a local server while preserving argv and environment values", async () => {
    const home = tmpdir()
    try {
      const result = await runMcpAdd(home, [
        "local",
        "--env",
        "API_KEY=secret",
        "--env",
        "VALUE=one=two",
        "--",
        "npx",
        "-y",
        "@example/server",
        "--label",
        "two words",
      ])
      expect(result.exitCode, result.stderr).toBe(0)

      const config = await Bun.file(path.join(home, ".config", "chimera", "chimera.json")).json()
      expect(config.mcp.local).toEqual({
        type: "local",
        command: ["npx", "-y", "@example/server", "--label", "two words"],
        environment: {
          API_KEY: "secret",
          VALUE: "one=two",
        },
      })
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true })
    }
  })
})