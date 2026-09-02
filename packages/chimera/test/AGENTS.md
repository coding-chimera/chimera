# Test Fixtures Guide

## Temporary Directory Fixture

The `tmpdir` function in `fixture/fixture.ts` creates temporary directories for tests with automatic cleanup.

### Basic Usage

```typescript
import { tmpdir } from "./fixture/fixture"

test("example", async () => {
  await using tmp = await tmpdir()
  // tmp.path is the temp directory path
  // automatically cleaned up when test ends
})
```

### Options

- `git?: boolean` - Initialize a git repo with a root commit
- `config?: Partial<Config.Info>` - Write an `chimera.json` config file
- `init?: (dir: string) => Promise<T>` - Custom setup function, returns value accessible as `tmp.extra`
- `dispose?: (dir: string) => Promise<T>` - Custom cleanup function

### Examples

**Git repository:**

```typescript
await using tmp = await tmpdir({ git: true })
```

**With config file:**

```typescript
await using tmp = await tmpdir({
  config: { model: "test/model", username: "testuser" },
})
```

**Custom initialization (returns extra data):**

```typescript
await using tmp = await tmpdir<string>({
  init: async (dir) => {
    await Bun.write(path.join(dir, "file.txt"), "content")
    return "extra data"
  },
})
// Access extra data via tmp.extra
console.log(tmp.extra) // "extra data"
```

**With cleanup:**

```typescript
await using tmp = await tmpdir({
  init: async (dir) => {
    const specialDir = path.join(dir, "special")
    await fs.mkdir(specialDir)
    return specialDir
  },
  dispose: async (dir) => {
    // Custom cleanup logic
    await fs.rm(path.join(dir, "special"), { recursive: true })
  },
})
```

### Returned Object

- `path: string` - Absolute path to the temp directory (realpath resolved)
- `extra: T` - Value returned by the `init` function
- `[Symbol.asyncDispose]` - Enables automatic cleanup via `await using`

### Notes

- Directories are created in the system temp folder with prefix `opencode-test-`
- Use `await using` for automatic cleanup when the variable goes out of scope
- Paths are sanitized to strip null bytes (defensive fix for CI environments)

## Testing With Effects

Use `testEffect(...)` from `test/lib/effect.ts` for tests that exercise Effect services or Effect-based workflows.

### Core Pattern

```typescript
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MyService.defaultLayer))

describe("my service", () => {
  it.instance("does the thing", () =>
    Effect.gen(function* () {
      const svc = yield* MyService.Service
      const out = yield* svc.run()
      expect(out).toEqual("ok")
    }),
  )
})
```

### `it.effect` vs `it.live`

- Use `it.effect(...)` when the test should run with `TestClock` and `TestConsole`.
- Use `it.live(...)` when the test depends on real time, filesystem mtimes, child processes, git, locks, or other live OS behavior.
- Use `it.instance(...)` for live Effect tests that need a scoped temporary directory and instance context.
- Most integration-style tests in this package use `it.live(...)`.

### Effect Fixtures

Prefer the Effect-aware helpers from `fixture/fixture.ts` instead of building a manual runtime in each test.

- `tmpdirScoped(options?)` creates a scoped temp directory and cleans it up when the Effect scope closes.
- `provideInstance(dir)(effect)` is the low-level helper. It does not create a directory; it just runs an Effect with `Instance.current` bound to `dir`.
- `provideTmpdirInstance((dir) => effect, options?)` is the convenience helper. It creates a temp directory, binds it as the active instance, and disposes the instance on cleanup.
- `provideTmpdirServer((input) => effect, options?)` does the same, but also provides the test LLM server.

Use `it.instance(...)` by default when a test only needs one temp instance. Yield `TestInstance` from `fixture/fixture.ts` when the test needs the temp directory path:

```typescript
import { TestInstance } from "../fixture/fixture"

it.instance("uses the temp directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    expect(test.directory).toContain("opencode-test-")
  }),
)
```

Use `provideTmpdirInstance(...)` or `tmpdirScoped()` plus `provideInstance(...)` when a test needs multiple directories, custom setup before binding, needs to switch instance context within one test, or explicitly tests instance disposal/reload lifetime.

### Style

- Define `const it = testEffect(...)` near the top of the file.
- Keep the test body inside `Effect.gen(function* () { ... })`.
- Yield services directly with `yield* MyService.Service` or `yield* MyTool`.
- Avoid custom `ManagedRuntime`, `attach(...)`, or ad hoc `run(...)` wrappers when `testEffect(...)` already provides the runtime.
- When a test needs instance-local state, prefer `it.instance(...)` over manual `Instance.provide(...)` inside Promise-style tests.

## Cross-Test Pollution (shared single process)

`bun test` runs every test file in ONE process. The preload (`test/preload.ts`) isolates XDG dirs and scrubs provider API keys once at startup, but anything written later persists for the rest of the run:

- **`process.env` writes leak across files.** Some production code writes env vars as a side effect — e.g. the amazon-bedrock loader bridges api-key auth into `process.env.AWS_BEARER_TOKEN_BEDROCK` during `provider.list()` and never removes it, so every later test file autoloads bedrock with its full models.dev model list (this once broke subagent-catalog assertions in `test/session/prompt.test.ts`). Tests that exercise such paths must save/restore the variable in `finally` (see `test/provider/amazon-bedrock.test.ts`).
- **`Env.set()` is not `process.env`.** It mutates an `InstanceState`-scoped copy per directory; it neither pollutes other directories nor protects code that reads `process.env` directly.
- **Config providers merge with the catalog.** Enabling a provider id that exists in the models fixture (e.g. `openai` in `test/session/prompt.test.ts`'s `providerCfg`) pulls in the fixture's full model list for that provider, so assertions on rendered model catalogs break when the fixture grows (the subagent disclosure has a 4000-character budget). Prefer provider ids absent from the fixture, or assert on content that survives truncation.
- **The auth store file is shared** (`Global.Path.data/auth.json` under the preload XDG dir). Tests writing entries must remove them in `finally`; a mid-test failure skips non-`finally` cleanup.

### Debugging suite-only failures

A test that passes standalone but fails in the full suite is almost always cross-test pollution. To find the polluter:

1. Run directory groups plus the victim file (`bun test test/config test/provider test/session/prompt.test.ts`) and halve the set until a single file reproduces it.
2. `-t` filtering still loads every module but skips non-matching test bodies — it detects import-time pollution only. Runtime pollution needs full-body runs.
3. Piped `bun test` output is heavily buffered; for per-file timing use `--reporter=junit --reporter-outfile=...` and analyze the XML afterwards.
4. Tests that apply DB migrations directly must use `Database.applyMigrations` (not drizzle's `migrate`) so lineage-aware repair logic applies — see `test/storage/json-migration.test.ts`.
