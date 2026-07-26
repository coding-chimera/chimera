import { Config } from "@/config/config"
import { emptyConsoleState } from "@/config/console-state"
import { Effect, Layer } from "effect"

function valueAtPath(input: unknown, path: string[]) {
  return path.reduce<unknown>(
    (value, key) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined,
    input,
  )
}

export function make(overrides: Partial<Config.Interface> = {}) {
  const get = overrides.get ?? (() => Effect.succeed({}))
  const resolve =
    overrides.resolve ??
    ((path: string[]) =>
      get().pipe(
        Effect.map((config) => {
          const value = valueAtPath(config, path)
          const explicit = value !== undefined
          return {
            value,
            inherited: undefined,
            source: explicit ? "project" : "default",
            inheritedSource: "default",
            explicitAtWriteTarget: explicit,
            writeTarget: {
              source: "project",
              format: "json",
              exists: Object.keys(config).length > 0,
            },
          } satisfies Config.ValueResolution
        }),
      ))
  return Config.Service.of({
    get,
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    resolve,
    update: () => Effect.void,
    remove: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
