// Subprocess tests for `chimera providers logout [provider]` (upstream 3f0ef9b71c).
//
// Seeds a global auth.json in the isolated tmpdir and spawns the real CLI via
// `bun run src/index.ts providers logout ...` (with `--conditions=browser`, same
// as upstream's cli-process harness, so the TUI's react jsx runtime resolves
// via the package exports). Covers the positional provider
// success path and the unknown-provider failure path; the interactive
// autocomplete path is not exercisable from a subprocess.

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
  }
}

function tmpdir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "providers-logout-test-"))
  const dataHome = path.join(home, ".local/share/chimera")
  fs.mkdirSync(dataHome, { recursive: true })
  // Pre-create the database marker so src/index.ts skips the one-time migration.
  fs.writeFileSync(path.join(dataHome, "chimera.db"), "")
  return home
}

function seedAuth(home: string) {
  fs.writeFileSync(
    path.join(home, ".local/share/chimera", "auth.json"),
    JSON.stringify({
      openai: { type: "api", key: "sk-test-1" },
      anthropic: { type: "api", key: "sk-test-2" },
    }),
  )
}

async function logout(home: string, provider: string) {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", path.join(root, "src/index.ts"), "providers", "logout", provider], {
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

describe("chimera providers logout (subprocess)", () => {
  test("removes the credential for a positional provider", async () => {
    const home = tmpdir()
    try {
      seedAuth(home)
      const result = await logout(home, "openai")
      expect(result.exitCode, result.stderr).toBe(0)

      const auth: Record<string, unknown> = JSON.parse(
        await Bun.file(path.join(home, ".local/share/chimera", "auth.json")).text(),
      )
      expect(auth.openai).toBeUndefined()
      expect(auth.anthropic).toEqual({ type: "api", key: "sk-test-2" })
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true })
    }
  })

  test("fails with a clear message for an unknown provider", async () => {
    const home = tmpdir()
    try {
      seedAuth(home)
      const result = await logout(home, "unknown-provider")
      expect(result.exitCode).toBe(1)
      expect(result.stderr + result.stdout).toContain('Unknown configured provider "unknown-provider"')
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true })
    }
  })
})