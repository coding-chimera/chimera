import { Effect, Stream } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { errorMessage } from "@/util/error"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

export const runCaptured = Effect.fnUntraced(function* (cmd: string[], cwd?: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd[0], cmd.slice(1), { cwd, extendEnv: true, stdin: "ignore" }),
    )
    const [code, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: 3 },
    )
    return { code, stdout, stderr }
  }).pipe(
    Effect.scoped,
    Effect.catch((error) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(error) })),
  )
})

export const runInherited = Effect.fnUntraced(
  function* (cmd: string[], cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd[0], cmd.slice(1), {
        cwd,
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "5 seconds",
      }),
    )
    return yield* handle.exitCode
  },
  Effect.scoped,
)

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run Chimera",
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: "PR number to checkout",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.pr")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }

    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = `pr/${prNumber}`
    UI.println(`Fetching and checking out PR #${prNumber}...`)

    const checkout = yield* runCaptured(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"]).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
    if (checkout.code !== 0) {
      return yield* fail(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
    }

    const prInfoResult = yield* runCaptured([
      "gh",
      "pr",
      "view",
      `${prNumber}`,
      "--json",
      "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
    ]).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))

    let sessionId: string | undefined

    if (prInfoResult.code === 0 && prInfoResult.stdout.trim()) {
      const prInfo = JSON.parse(prInfoResult.stdout)

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner

        const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
        if (!remotes.split("\n").includes(remoteName)) {
          yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          UI.println(`Added fork remote: ${remoteName}`)
        }

        yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
          cwd: worktree,
        })
      }

      if (prInfo?.body) {
        const sessionMatch = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
        if (sessionMatch) {
          const sessionUrl = sessionMatch[0]
          UI.println(`Found chimera session: ${sessionUrl}`)
          UI.println(`Importing session...`)

          const importResult = yield* runCaptured(["chimera", "import", sessionUrl]).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
          if (importResult.code === 0) {
            const sessionIdMatch = importResult.stdout.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
            if (sessionIdMatch) {
              sessionId = sessionIdMatch[1]
              UI.println(`Session imported: ${sessionId}`)
            }
          }
        }
      }
    }

    UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
    UI.println()
    UI.println("Starting chimera...")
    UI.println()

    const chimeraArgs = sessionId ? ["-s", sessionId] : []
    const code = yield* runInherited(["chimera", ...chimeraArgs], process.cwd()).pipe(
      Effect.provide(CrossSpawnSpawner.defaultLayer),
      Effect.orDie,
    )
    // Match legacy throw semantics — propagate as a defect so the top-level
    // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
    if (code !== 0) return yield* Effect.die(new Error(`chimera exited with code ${code}`))
  }),
})
