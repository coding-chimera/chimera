import { describe, expect, test } from "bun:test"
import childProcess from "child_process"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const sourceWrapper = path.resolve(import.meta.dir, "../../bin/chimera")
const sourcePostinstall = path.resolve(import.meta.dir, "../../script/postinstall.mjs")
const platform = process.platform === "win32" ? "windows" : process.platform
const platformBinaryName = platform === "windows" ? "chimera.exe" : "chimera"
const platformPackageName = `@coding-chimera/chimera-${platform}-${process.arch}`

function cleanEnv() {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CHIMERA_BIN_PATH
  delete env.OPENCODE_BIN_PATH
  return env
}

async function exists(target: string) {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false)
}

async function installRuntime(target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.link(process.execPath, target).catch(() => fs.copyFile(process.execPath, target))
  if (process.platform !== "win32") await fs.chmod(target, 0o755)
}

async function prepareWrapperPackage(packageDir: string) {
  const wrapper = path.join(packageDir, "bin", "chimera")
  const binary = path.join(packageDir, "node_modules", platformPackageName, "bin", platformBinaryName)
  await fs.mkdir(path.dirname(wrapper), { recursive: true })
  await Promise.all([
    fs.copyFile(sourceWrapper, wrapper),
    Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
  ])
  await installRuntime(binary)
  return { wrapper, binary }
}

describe("chimera wrapper", () => {
  test("passes a package-anchored playwright entry without NODE_PATH and tolerates a missing package", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const wrapper = path.join(packageDir, "bin", "chimera")
    const fakePackage = path.join(packageDir, "node_modules", "playwright-core")
    const cwd = path.join(tmp.path, "unrelated-cwd")
    const importProbe = path.join(tmp.path, "import-probe.mjs")
    const startupProbe = path.join(tmp.path, "startup-probe.mjs")

    await Promise.all([fs.mkdir(path.dirname(wrapper), { recursive: true }), fs.mkdir(fakePackage, { recursive: true }), fs.mkdir(cwd)])
    await Promise.all([
      fs.copyFile(sourceWrapper, wrapper),
      Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
      Bun.write(
        path.join(fakePackage, "package.json"),
        JSON.stringify({ name: "playwright-core", version: "0.0.0", type: "module", exports: "./index.js" }),
      ),
      Bun.write(path.join(fakePackage, "index.js"), 'export const chromium = { marker: "fake-playwright-core" }\n'),
      Bun.write(
        importProbe,
        `import { pathToFileURL } from "url"
const entry = process.env.CHIMERA_PLAYWRIGHT_CORE_ENTRY
if (!entry) throw new Error("missing CHIMERA_PLAYWRIGHT_CORE_ENTRY")
const playwright = await import(pathToFileURL(entry).href)
process.stdout.write(JSON.stringify({ entry, marker: playwright.chromium.marker, nodePath: process.env.NODE_PATH ?? null }))
`,
      ),
      Bun.write(
        startupProbe,
        `process.stdout.write(JSON.stringify({ started: true, entry: process.env.CHIMERA_PLAYWRIGHT_CORE_ENTRY ?? null, nodePath: process.env.NODE_PATH ?? null }))
`,
      ),
    ])

    const env: Record<string, string | undefined> = { ...process.env, CHIMERA_BIN_PATH: process.execPath }
    delete env.NODE_PATH
    delete env.OPENCODE_BIN_PATH
    delete env.CHIMERA_PLAYWRIGHT_CORE_ENTRY
    const run = (probe: string) =>
      childProcess.spawnSync(process.execPath, [wrapper, probe], {
        cwd,
        env,
        encoding: "utf8",
      })

    const imported = run(importProbe)
    expect(imported.status, imported.stderr).toBe(0)
    expect(JSON.parse(imported.stdout)).toEqual({
      entry: path.join(fakePackage, "index.js"),
      marker: "fake-playwright-core",
      nodePath: null,
    })
    await fs.rm(fakePackage, { recursive: true })
    const started = run(startupProbe)
    expect(started.status, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toEqual({ started: true, entry: null, nodePath: null })
  })

  test("overrides a stale user CHIMERA_PLAYWRIGHT_CORE_ENTRY with the resolved entry and strips it when unresolvable", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const wrapper = path.join(packageDir, "bin", "chimera")
    const fakePackage = path.join(packageDir, "node_modules", "playwright-core")
    const cwd = path.join(tmp.path, "unrelated-cwd")
    const importProbe = path.join(tmp.path, "import-probe.mjs")
    const startupProbe = path.join(tmp.path, "startup-probe.mjs")

    await Promise.all([fs.mkdir(path.dirname(wrapper), { recursive: true }), fs.mkdir(fakePackage, { recursive: true }), fs.mkdir(cwd)])
    await Promise.all([
      fs.copyFile(sourceWrapper, wrapper),
      Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
      Bun.write(
        path.join(fakePackage, "package.json"),
        JSON.stringify({ name: "playwright-core", version: "0.0.0", type: "module", exports: "./index.js" }),
      ),
      Bun.write(path.join(fakePackage, "index.js"), 'export const chromium = { marker: "fake-playwright-core" }\n'),
      Bun.write(
        importProbe,
        `import { pathToFileURL } from "url"\nconst entry = process.env.CHIMERA_PLAYWRIGHT_CORE_ENTRY\nif (!entry) throw new Error("missing CHIMERA_PLAYWRIGHT_CORE_ENTRY")\nconst playwright = await import(pathToFileURL(entry).href)\nprocess.stdout.write(JSON.stringify({ entry, marker: playwright.chromium.marker, nodePath: process.env.NODE_PATH ?? null }))\n`,
      ),
      Bun.write(
        startupProbe,
        `process.stdout.write(JSON.stringify({ started: true, entry: process.env.CHIMERA_PLAYWRIGHT_CORE_ENTRY ?? null, nodePath: process.env.NODE_PATH ?? null }))\n`,
      ),
    ])

    const env: Record<string, string | undefined> = { ...process.env, CHIMERA_BIN_PATH: process.execPath }
    env.CHIMERA_PLAYWRIGHT_CORE_ENTRY = path.join(tmp.path, "stale-entry.mjs")
    delete env.NODE_PATH
    delete env.OPENCODE_BIN_PATH
    const run = (probe: string) =>
      childProcess.spawnSync(process.execPath, [wrapper, probe], {
        cwd,
        env,
        encoding: "utf8",
      })

    const overridden = run(importProbe)
    expect(overridden.status, overridden.stderr).toBe(0)
    expect(JSON.parse(overridden.stdout).entry).toBe(path.join(fakePackage, "index.js"))

    await fs.rm(fakePackage, { recursive: true })
    const started = run(startupProbe)
    expect(started.status, started.stderr).toBe(0)
    expect(JSON.parse(started.stdout)).toEqual({ started: true, entry: null, nodePath: null })
  })

  test("resolves a hoisted playwright-core from an ancestor node_modules", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const wrapper = path.join(packageDir, "bin", "chimera")
    const fakePackage = path.join(tmp.path, "node_modules", "playwright-core")
    const cwd = path.join(tmp.path, "unrelated-cwd")
    const importProbe = path.join(tmp.path, "import-probe.mjs")

    await Promise.all([fs.mkdir(path.dirname(wrapper), { recursive: true }), fs.mkdir(fakePackage, { recursive: true }), fs.mkdir(cwd)])
    await Promise.all([
      fs.copyFile(sourceWrapper, wrapper),
      Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
      Bun.write(
        path.join(fakePackage, "package.json"),
        JSON.stringify({ name: "playwright-core", version: "0.0.0", type: "module", exports: "./index.js" }),
      ),
      Bun.write(path.join(fakePackage, "index.js"), 'export const chromium = { marker: "fake-playwright-core" }\n'),
      Bun.write(
        importProbe,
        `import { pathToFileURL } from "url"\nconst entry = process.env.CHIMERA_PLAYWRIGHT_CORE_ENTRY\nif (!entry) throw new Error("missing CHIMERA_PLAYWRIGHT_CORE_ENTRY")\nconst playwright = await import(pathToFileURL(entry).href)\nprocess.stdout.write(JSON.stringify({ entry, marker: playwright.chromium.marker, nodePath: process.env.NODE_PATH ?? null }))\n`,
      ),
    ])

    const env: Record<string, string | undefined> = { ...process.env, CHIMERA_BIN_PATH: process.execPath }
    delete env.NODE_PATH
    delete env.OPENCODE_BIN_PATH
    delete env.CHIMERA_PLAYWRIGHT_CORE_ENTRY
    const imported = childProcess.spawnSync(process.execPath, [wrapper, importProbe], {
      cwd,
      env,
      encoding: "utf8",
    })
    expect(imported.status, imported.stderr).toBe(0)
    expect(JSON.parse(imported.stdout)).toEqual({
      entry: path.join(fakePackage, "index.js"),
      marker: "fake-playwright-core",
      nodePath: null,
    })
  })

  test.skipIf(process.platform === "win32")(
    "ignores executable .chimera and .opencode caches and runs the current platform package",
    async () => {
      await using tmp = await tmpdir()
      const packageDir = path.join(tmp.path, "package")
      const prepared = await prepareWrapperPackage(packageDir)
      const probe = path.join(tmp.path, "platform-probe.mjs")
      const cached = path.join(packageDir, "bin", ".chimera")
      const legacyCached = path.join(packageDir, "bin", ".opencode")
      await Promise.all([
        Bun.write(probe, 'process.stdout.write("platform-package")\n'),
        Bun.write(cached, '#!/usr/bin/env node\nprocess.stdout.write("stale-chimera-cache")\n'),
        Bun.write(legacyCached, '#!/usr/bin/env node\nprocess.stdout.write("stale-opencode-cache")\n'),
      ])
      await Promise.all([fs.chmod(cached, 0o755), fs.chmod(legacyCached, 0o755)])

      const run = () =>
        childProcess.spawnSync(process.execPath, [prepared.wrapper, probe], {
          env: cleanEnv(),
          encoding: "utf8",
        })

      const withBothCaches = run()
      expect(withBothCaches.status, withBothCaches.stderr).toBe(0)
      expect(withBothCaches.stdout).toBe("platform-package")

      await fs.rm(cached)
      const withLegacyCache = run()
      expect(withLegacyCache.status, withLegacyCache.stderr).toBe(0)
      expect(withLegacyCache.stdout).toBe("platform-package")
    },
  )

  test.skipIf(process.platform === "win32")("returns failure when the selected binary is terminated by a signal", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const wrapper = path.join(packageDir, "bin", "chimera")
    const probe = path.join(tmp.path, "signal-probe.mjs")
    await fs.mkdir(path.dirname(wrapper), { recursive: true })
    await Promise.all([
      fs.copyFile(sourceWrapper, wrapper),
      Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
      Bun.write(probe, 'process.kill(process.pid, "SIGTERM")\n'),
    ])

    const env = cleanEnv()
    env.CHIMERA_BIN_PATH = process.execPath
    const result = childProcess.spawnSync(process.execPath, [wrapper, probe], {
      env,
      encoding: "utf8",
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Chimera binary terminated by SIGTERM")
  })

  test("postinstall removes legacy main-package caches and verifies through the wrapper", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const prepared = await prepareWrapperPackage(packageDir)
    const postinstall = path.join(packageDir, "postinstall.mjs")
    const stale = [
      path.join(packageDir, "bin", ".chimera"),
      path.join(packageDir, "bin", ".opencode"),
      path.join(packageDir, "bin", "tree-sitter-wasms"),
      path.join(packageDir, "bin", "web-tree-sitter"),
    ]
    const platformAssets = [
      path.join(path.dirname(prepared.binary), "tree-sitter-wasms"),
      path.join(path.dirname(prepared.binary), "web-tree-sitter"),
    ]
    await Promise.all([
      fs.copyFile(sourcePostinstall, postinstall),
      ...stale.slice(2).map((target) => fs.mkdir(target, { recursive: true })),
      ...platformAssets.map((target) => fs.mkdir(target, { recursive: true })),
    ])
    await Promise.all([
      Bun.write(stale[0], "stale chimera cache\n"),
      Bun.write(stale[1], "stale opencode cache\n"),
      Bun.write(path.join(stale[2], "old.wasm"), "old asset\n"),
      Bun.write(path.join(stale[3], "old.wasm"), "old asset\n"),
      Bun.write(path.join(platformAssets[0], "current.wasm"), "current asset\n"),
      Bun.write(path.join(platformAssets[1], "current.wasm"), "current asset\n"),
    ])

    const env = cleanEnv()
    env.CHIMERA_BIN_PATH = path.join(tmp.path, "invalid-override")
    env.OPENCODE_BIN_PATH = path.join(tmp.path, "legacy-invalid-override")
    const result = childProcess.spawnSync(process.execPath, [postinstall], {
      env,
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(await Promise.all(stale.map(exists))).toEqual([false, false, false, false])
    expect(await Promise.all(platformAssets.map(exists))).toEqual([true, true])
  })

  test("postinstall fails loudly when the wrapper cannot resolve a platform package", async () => {
    await using tmp = await tmpdir()
    const packageDir = path.join(tmp.path, "package")
    const wrapper = path.join(packageDir, "bin", "chimera")
    const postinstall = path.join(packageDir, "postinstall.mjs")
    await fs.mkdir(path.dirname(wrapper), { recursive: true })
    await Promise.all([
      fs.copyFile(sourceWrapper, wrapper),
      fs.copyFile(sourcePostinstall, postinstall),
      Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: "@coding-chimera/chimera", type: "module" })),
    ])

    const result = childProcess.spawnSync(process.execPath, [postinstall], {
      env: cleanEnv(),
      encoding: "utf8",
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Failed to verify Chimera installation")
  })
})
