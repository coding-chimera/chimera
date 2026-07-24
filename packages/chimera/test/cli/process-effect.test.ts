import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { runCaptured, runInherited } from "../../src/cli/cmd/pr"
import { runAuthCommand } from "../../src/cli/cmd/providers"
import { pageOutput } from "../../src/cli/cmd/session"

const encoder = new TextEncoder()

function mockSpawner(
  handler: (command: ChildProcess.StandardCommand) => {
    code?: number
    stdout?: string
    stderr?: string
    onExit?: () => void
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("expected standard command")
      const result = handler(command)
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.sync(() => {
            result.onExit?.()
            return ChildProcessSpawner.ExitCode(result.code ?? 0)
          }),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: {} as never,
          stdout: result.stdout ? Stream.make(encoder.encode(result.stdout)) : Stream.empty,
          stderr: result.stderr ? Stream.make(encoder.encode(result.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => ({}) as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
}

describe("effect CLI child processes", () => {
  test("PR captured commands preserve args, cwd, output, and non-zero exit", async () => {
    const seen: ChildProcess.StandardCommand[] = []
    const result = await Effect.runPromise(
      runCaptured(["gh", "pr", "checkout", "42", "--force"], "/worktree").pipe(
        Effect.provide(
          mockSpawner((command) => {
            seen.push(command)
            return { code: 7, stdout: "checkout out", stderr: "checkout err" }
          }),
        ),
      ),
    )

    expect(result).toEqual({ code: 7, stdout: "checkout out", stderr: "checkout err" })
    expect(seen[0]?.command).toBe("gh")
    expect(seen[0]?.args).toEqual(["pr", "checkout", "42", "--force"])
    expect(seen[0]?.options.cwd).toBe("/worktree")
    expect(seen[0]?.options.extendEnv).toBe(true)
    expect(seen[0]?.options.stdin).toBe("ignore")
  })

  test("PR launch inherits stdio and waits for exit", async () => {
    let exited = false
    const result = await Effect.runPromise(
      runInherited(["chimera", "-s", "session-id"], "/worktree").pipe(
        Effect.provide(
          mockSpawner((command) => {
            expect(command.command).toBe("chimera")
            expect(command.args).toEqual(["-s", "session-id"])
            expect(command.options.cwd).toBe("/worktree")
            expect(command.options.stdin).toBe("inherit")
            expect(command.options.stdout).toBe("inherit")
            expect(command.options.stderr).toBe("inherit")
            return { code: 3, onExit: () => (exited = true) }
          }),
        ),
      ),
    )

    expect(Number(result)).toBe(3)
    expect(exited).toBe(true)
  })

  test("provider auth captures token, preserves stderr, and returns exit code", async () => {
    const result = await Effect.runPromise(
      runAuthCommand(["provider-auth", "--token"]).pipe(
        Effect.provide(
          mockSpawner((command) => {
            expect(command.command).toBe("provider-auth")
            expect(command.args).toEqual(["--token"])
            expect(command.options.stdin).toBe("ignore")
            expect(command.options.stdout).toBe("pipe")
            expect(command.options.stderr).toBe("inherit")
            return { code: 9, stdout: "secret-token\n" }
          }),
        ),
      ),
    )

    expect([Number(result[0]), result[1]]).toEqual([9, "secret-token\n"])
  })

  test("session pager pipes output and waits for exit", async () => {
    let exited = false
    const result = await Effect.runPromise(
      pageOutput(["less", "-R", "-S"], "session table").pipe(
        Effect.provide(
          mockSpawner((command) => {
            expect(command.command).toBe("less")
            expect(command.args).toEqual(["-R", "-S"])
            expect(typeof command.options.stdin).toBe("object")
            expect(command.options.stdout).toBe("inherit")
            expect(command.options.stderr).toBe("inherit")
            return { onExit: () => (exited = true) }
          }),
        ),
      ),
    )

    expect(Number(result)).toBe(0)
    expect(exited).toBe(true)
  })
})
