import { afterEach, test, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Snapshot } from "../../src/snapshot"
import { WithInstance } from "../../src/project/with-instance"
import { Config } from "@/config/config"
import { Filesystem } from "@/util/filesystem"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// (T0-4) Spawn accounting: wrap the real spawner so every child process the
// snapshot service starts is recorded, then assert the dirty-check fast paths.
// ---------------------------------------------------------------------------

const spawnLog: string[][] = []

const countingLayer = Snapshot.layer.pipe(
  Layer.provide(
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const inner = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) =>
          Effect.suspend(() => {
            spawnLog.push(command._tag === "StandardCommand" ? [command.command, ...command.args] : [command._tag])
            return inner.spawn(command)
          }),
        )
      }),
    ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer)),
  ),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

afterEach(async () => {
  spawnLog.length = 0
  await disposeAllInstances()
})

async function bootstrap() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/a.txt`, "alpha\n")
      await Filesystem.write(`${dir}/b.txt`, "beta\n")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
    },
  })
}

function run<A>(dir: string, body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      return yield* body(snapshot)
    }).pipe(provideInstance(dir), Effect.provide(countingLayer)),
  )
}

const readText = (file: string) => Effect.promise(() => Bun.file(file).text())

const subcommand = (spawn: string[]) => {
  for (let i = 0; i < spawn.length; i++) {
    const arg = spawn[i]!
    // Skip global flags and their separate values (-c, --git-dir, --work-tree).
    if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      i++
      continue
    }
    if (arg === "git" || arg.startsWith("-") || arg.includes("=")) continue
    return arg
  }
  return undefined
}

test("track reuses the baseline hash with a single dirty-check spawn", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            const first = yield* snapshot.track()
            expect(first).toBeTruthy()

            spawnLog.length = 0
            const second = yield* snapshot.track()
            expect(second).toBe(first!)
            expect(spawnLog.length).toBe(1)
            expect(subcommand(spawnLog[0]!)).toBe("status")

            spawnLog.length = 0
            const third = yield* snapshot.track()
            expect(third).toBe(first!)
            expect(spawnLog.length).toBe(1)
          }),
      )
    },
  })
})

test("track recomputes the tree when the worktree changed", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            const first = yield* snapshot.track()
            expect(first).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/c.txt`, "gamma\n"))
            spawnLog.length = 0
            const second = yield* snapshot.track()
            expect(second).toBeTruthy()
            expect(second).not.toBe(first!)
            // Dirty check probed first, then the full add() + write-tree path ran.
            expect(subcommand(spawnLog[0]!)).toBe("status")
            expect(spawnLog.some((spawn) => spawn.includes("write-tree"))).toBe(true)
            expect(spawnLog.some((spawn) => subcommand(spawn) === "add")).toBe(true)

            // Modified tracked files recompute too.
            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/c.txt`, "gamma2\n"))
            spawnLog.length = 0
            const third = yield* snapshot.track()
            expect(third).not.toBe(second!)
            expect(spawnLog.some((spawn) => spawn.includes("write-tree"))).toBe(true)
          }),
      )
    },
  })
})

test("patch on a clean worktree costs one status plus one cached diff", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            const hash = yield* snapshot.track()
            expect(hash).toBeTruthy()

            spawnLog.length = 0
            const result = yield* snapshot.patch(hash!)
            expect(result.files).toEqual([])
            expect(spawnLog.length).toBe(2)
            expect(subcommand(spawnLog[0]!)).toBe("status")
            expect(subcommand(spawnLog[1]!)).toBe("diff")
          }),
      )
    },
  })
})

test("a full LLM step on an unchanged worktree stays within the spawn budget", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            // Prime the baseline (also absorbs the one-time init/rev-parse spawns).
            const hash = yield* snapshot.track()
            expect(hash).toBeTruthy()

            // Steady-state step: start-step track + finish-step track + patch.
            // Pre-change this cost ~10-14 git spawns; budget: 4.
            spawnLog.length = 0
            const start = yield* snapshot.track()
            const finish = yield* snapshot.track()
            const result = yield* snapshot.patch(start!)
            expect(start).toBe(hash!)
            expect(finish).toBe(hash!)
            expect(result.files).toEqual([])
            expect(spawnLog.length).toBeLessThanOrEqual(4)
          }),
      )
    },
  })
})

test("restore invalidates the cached baseline", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            const h1 = yield* snapshot.track()
            expect(h1).toBeTruthy()

            yield* Effect.promise(() => $`rm ${tmp.path}/a.txt`.quiet())
            const h2 = yield* snapshot.track()
            expect(h2).toBeTruthy()
            expect(h2).not.toBe(h1!)

            yield* snapshot.restore(h1!)
            // restore() leaves the index equal to h1 and the worktree matching it,
            // so a stale baseline would be silently reused — it must not be.
            const h3 = yield* snapshot.track()
            expect(h3).toBe(h1!)
            expect(yield* readText(`${tmp.path}/a.txt`)).toBe("alpha\n")
          }),
      )
    },
  })
})

test("revert invalidates the cached baseline", async () => {
  await using tmp = await bootstrap()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await run(
        tmp.path,
        (snapshot) =>
          Effect.gen(function* () {
            const h1 = yield* snapshot.track()
            expect(h1).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/a.txt`, "changed\n"))
            const h2 = yield* snapshot.track()
            expect(h2).not.toBe(h1!)

            // revert() checkouts h1's blob into index AND worktree: the worktree is
            // clean afterwards, so only baseline invalidation forces a recompute.
            yield* snapshot.revert([{ hash: h1!, files: [`${tmp.path}/a.txt`] }])
            const h3 = yield* snapshot.track()
            expect(h3).toBe(h1!)
            expect(yield* readText(`${tmp.path}/a.txt`)).toBe("alpha\n")
          }),
      )
    },
  })
})

// ---------------------------------------------------------------------------
// (T0-4) Tree-hash identity: replay the pre-T0-4 staging sequence against a
// parallel gitdir with raw git commands and require the same write-tree hash.
// This intentionally restates the OLD algorithm (diff-files + ls-files --others
// enumeration, batched check-ignore --no-index, large-untracked blocklist via
// info/exclude, scoped `add --all --sparse`) so the assertion is a genuine A/B
// pin, not a restatement of the new implementation.
// ---------------------------------------------------------------------------

const quoteFlags = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
]
const cfgFlags = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const sizeLimit = 2 * 1024 * 1024

function gitSync(args: string[], opts?: { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> }) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: opts?.cwd,
    stdin: opts?.stdin ?? "ignore",
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  })
  return { code: proc.exitCode, text: new TextDecoder().decode(proc.stdout) }
}

async function baselineTreeHash(dir: string, gitdir: string) {
  const nul = (list: string[]) => new TextEncoder().encode(list.join("\0") + "\0")
  const g = (flags: string[], cmd: string[], stdin?: Uint8Array) =>
    gitSync([...flags, "--git-dir", gitdir, "--work-tree", dir, ...cmd], { cwd: dir, stdin })

  await fs.rm(gitdir, { recursive: true, force: true })
  await fs.mkdir(gitdir, { recursive: true })
  expect(gitSync(["init"], { env: { GIT_DIR: gitdir, GIT_WORK_TREE: dir } }).code).toBe(0)
  // Mirror initRepo's direct config append so blob/tree hashing settings match.
  const configPath = path.join(gitdir, "config")
  const existing = await Bun.file(configPath).text()
  await Bun.write(
    configPath,
    `${existing.trimEnd()}\n\n[core]\n\tautocrlf = false\n\tlongpaths = true\n\tsymlinks = true\n\tfsmonitor = false\n`,
  )

  // sync(): copy the source repo's info/exclude into the snapshot gitdir.
  const sourceExclude = await Bun.file(path.join(dir, ".git", "info", "exclude"))
    .text()
    .catch(() => "")
  const writeExclude = async (block: string[]) => {
    await fs.mkdir(path.join(gitdir, "info"), { recursive: true })
    const text = [sourceExclude.trimEnd(), ...block.map((item) => `/${item.replaceAll("\\", "/")}`)]
      .filter(Boolean)
      .join("\n")
    await Bun.write(path.join(gitdir, "info", "exclude"), text ? `${text}\n` : "")
  }
  await writeExclude([])

  const diff = g(quoteFlags, ["diff-files", "--name-only", "-z", "--", "."])
  const other = g(quoteFlags, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."])
  expect(diff.code).toBe(0)
  expect(other.code).toBe(0)
  const tracked = diff.text.split("\0").filter(Boolean)
  const untracked = other.text.split("\0").filter(Boolean)
  const all = Array.from(new Set([...tracked, ...untracked]))

  if (all.length) {
    const check = gitSync(
      [
        ...quoteFlags,
        "--git-dir",
        path.join(dir, ".git"),
        "--work-tree",
        dir,
        "check-ignore",
        "--no-index",
        "--stdin",
        "-z",
      ],
      { cwd: dir, stdin: nul(all) },
    )
    const ignored = new Set(check.code === 0 || check.code === 1 ? check.text.split("\0").filter(Boolean) : [])
    const allow = all.filter((item) => !ignored.has(item))
    // The parallel index starts empty, so the old drop() pass (rm --cached for
    // newly-ignored files) has nothing to remove and is skipped here; both sides
    // converge on the same invariant: index == allowed worktree state.
    if (allow.length) {
      const block: string[] = []
      for (const item of untracked) {
        if (!allow.includes(item)) continue
        const stat = await fs.stat(path.join(dir, item)).catch(() => undefined)
        if (stat?.isFile() && stat.size > sizeLimit) block.push(item)
      }
      await writeExclude(block)
      const staged = allow.filter((item) => !block.includes(item))
      expect(g(cfgFlags, ["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], nul(staged)).code).toBe(0)
    }
  }

  const tree = g([], ["write-tree"])
  expect(tree.code).toBe(0)
  return tree.text.trim()
}

test("write-tree hash is byte-identical to the pre-change staging sequence", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/a.txt`, "alpha\n")
      await Filesystem.write(`${dir}/old.txt`, "old\n")
      await Filesystem.write(`${dir}/sub/b.txt`, "beta\n")
      await Filesystem.write(`${dir}/.gitignore`, "*.ignored\nbuild/\n")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
    },
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const h1 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(h1).toBeTruthy()

      // Baseline state: nothing dirty — identity must hold on the empty diff too.
      expect(h1).toBe(await baselineTreeHash(tmp.path, `${tmp.path}-replay-clean`))

      // Mixed state exercising every staging branch: modified tracked file,
      // deleted tracked file, new files (root + subdir), gitignored additions,
      // an oversized untracked file (blocklist path), and a file that was
      // snapshotted first and only afterwards gitignored + modified (drop path).
      await Filesystem.write(`${tmp.path}/later-ignored.txt`, "li\n")
      const h2 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(h2).toBeTruthy()
      expect(h2).not.toBe(h1!)

      await Filesystem.write(`${tmp.path}/a.txt`, "alpha2\n")
      await $`rm ${tmp.path}/old.txt`.quiet()
      await Filesystem.write(`${tmp.path}/c.txt`, "gamma\n")
      await Filesystem.write(`${tmp.path}/sub/d.txt`, "delta\n")
      await Filesystem.write(`${tmp.path}/skip.ignored`, "nope\n")
      await Filesystem.write(`${tmp.path}/build/out.js`, "nope\n")
      await Filesystem.write(`${tmp.path}/huge.bin`, new Uint8Array(sizeLimit + 1))
      await Filesystem.write(`${tmp.path}/.gitignore`, "*.ignored\nbuild/\nlater-ignored.txt\n")
      await Filesystem.write(`${tmp.path}/later-ignored.txt`, "li2\n")

      const h3 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(h3).toBeTruthy()
      expect(h3).not.toBe(h2!)
      expect(h3).toBe(await baselineTreeHash(tmp.path, `${tmp.path}-replay-dirty`))

      // A repeated track on the now-clean worktree is stable (covers the
      // dirty-check reuse path returning the identical hash).
      const h4 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(h4).toBe(h3!)
    },
  })
})
