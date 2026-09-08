// Subprocess tests for `chimera run` (non-interactive mode).
//
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. Each test spawns `bun run src/index.ts run ...` with
// OPENCODE_CONFIG_CONTENT providing the test provider config inline, and
// OPENCODE_TEST_HOME + XDG_* pointing at a fresh tmpdir for isolation.
//
// Regression for upstream #43675 (fork P1 `08faeb3893`): permission.asked
// events from subagent sessions used to be dropped when their sessionID
// differed from the run session, leaving the subagent permanently stuck and
// hanging the whole run. The run loop now tracks the session tree via
// session.created parentID and answers requests from any member session.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TestLLMServer } from "../lib/llm-server"

const root = path.resolve(import.meta.dir, "../..")

function providerConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    username: "probe",
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

function run(
  llm: TestLLMServer["Service"],
  args: string[],
  opts?: { permission?: Record<string, string> },
): Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "run-test-"))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.promises.rm(home, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    const config = opts?.permission ? { ...providerConfig(llm.url), permission: opts.permission } : providerConfig(llm.url)

    const env: Record<string, string> = {
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
    }

    const child = Bun.spawn(
      ["bun", "run", path.join(root, "src/index.ts"), "run", "--dir", home, "--model", "test/test-model", ...args],
      {
        cwd: root,
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const exitCode = yield* Effect.promise(() => child.exited)
    const [stdoutText, stderrText] = yield* Effect.promise(() => Promise.all([stdout, stderr]))
    return { exitCode, stdout: stdoutText, stderr: stderrText }
  })
}

function runTest(
  name: string,
  body: (llm: TestLLMServer["Service"]) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  test(name, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.scoped(body(llm))
      }).pipe(Effect.timeout("60 seconds"), Effect.provide(TestLLMServer.layer)),
    ),
    30_000,
  )
}

describe("chimera run (non-interactive subprocess)", () => {
  runTest("answers requested permissions from subagents without hanging", (llm) =>
    Effect.gen(function* () {
      yield* llm.tool("task", {
        description: "Run a command",
        prompt: "Run the requested command",
        subagent_type: "general",
      })
      yield* llm.tool("bash", { command: "printf child", description: "Print from the child" })
      yield* llm.text("child finished")
      yield* llm.text("parent finished")

      const result = yield* run(llm, ["delegate a command"], { permission: { bash: "ask" } })

      // Run completed: the subagent's permission.asked was answered instead of
      // dropped, so the subagent finished and the run exited normally. A hang
      // (pre-fix behavior) would surface as an Effect.timeout failure here.
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain("permission requested: bash")
    }),
  )

  runTest("answers subagent permissions with --dangerously-skip-permissions", (llm) =>
    Effect.gen(function* () {
      yield* llm.tool("task", {
        description: "Run a command",
        prompt: "Run the requested command",
        subagent_type: "general",
      })
      yield* llm.tool("bash", { command: "printf child", description: "Print from the child" })
      yield* llm.text("child finished")
      yield* llm.text("parent finished")

      const result = yield* run(llm, ["--dangerously-skip-permissions", "delegate a command"], {
        permission: { bash: "ask" },
      })

      expect(result.exitCode).toBe(0)
    }),
  )
})