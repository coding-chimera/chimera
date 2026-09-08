import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { Plugin } from "@/plugin"
import { Bus } from "@/bus"
import { TestConfig } from "../fixture/config"
import { Npm } from "@opencode-ai/core/npm"

function layer(directory: string, plugins: string[]) {
  return Plugin.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "chimera.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ),
    Layer.provide(Npm.defaultLayer),
  )
}

describe("plugin.dispose", () => {
  test("calls the dispose hook when the plugin scope closes", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pluginDir = path.join(dir, ".chimera", "plugin")
        await fs.mkdir(pluginDir, { recursive: true })
        await Bun.write(
          path.join(pluginDir, "dispose-plugin.ts"),
          [
            "import fs from 'node:fs'",
            "import path from 'node:path'",
            "export default {",
            '  id: "demo.dispose-plugin",',
            "  server: async () => ({",
            "    dispose: async () => {",
            // import.meta.dir is the plugin directory (<project>/.chimera/plugin), so
            // one level up resolves to <project>/.chimera/.
            "      fs.writeFileSync(path.join(import.meta.dir, '..', 'disposed.txt'), '1')",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    const plugin = pathToFileURL(path.join(tmp.path, ".chimera", "plugin", "dispose-plugin.ts")).href
    // The plugin's dispose hook writes one directory above the plugin file.
    const marker = path.join(tmp.path, ".chimera", "disposed.txt")

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        return Effect.runPromise(
          Plugin.Service.use((svc) => svc.init()).pipe(Effect.provide(layer(tmp.path, [plugin]))),
        )
      },
    })

    // runPromise closes the layer scope on exit, which runs the plugin host's
    // dispose finalizer before the promise resolves.
    expect(await fs.readFile(marker, "utf8")).toBe("1")
  }, 30000)

  test("a failing dispose hook does not block other dispose hooks", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pluginDir = path.join(dir, ".chimera", "plugin")
        await fs.mkdir(pluginDir, { recursive: true })
        await Bun.write(
          path.join(pluginDir, "boom-plugin.ts"),
          [
            "export default {",
            '  id: "demo.boom-plugin",',
            "  server: async () => ({",
            "    dispose: async () => { throw new Error('boom') },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(pluginDir, "clean-plugin.ts"),
          [
            "import fs from 'node:fs'",
            "import path from 'node:path'",
            "export default {",
            '  id: "demo.clean-plugin",',
            "  server: async () => ({",
            "    dispose: async () => {",
            "      fs.writeFileSync(path.join(import.meta.dir, '..', 'clean-disposed.txt'), '1')",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    const boom = pathToFileURL(path.join(tmp.path, ".chimera", "plugin", "boom-plugin.ts")).href
    const clean = pathToFileURL(path.join(tmp.path, ".chimera", "plugin", "clean-plugin.ts")).href
    const marker = path.join(tmp.path, ".chimera", "clean-disposed.txt")

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        return Effect.runPromise(
          Plugin.Service.use((svc) => svc.init()).pipe(Effect.provide(layer(tmp.path, [boom, clean]))),
        )
      },
    })

    expect(await fs.readFile(marker, "utf8")).toBe("1")
  }, 30000)
})