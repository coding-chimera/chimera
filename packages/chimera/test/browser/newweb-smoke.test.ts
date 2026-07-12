import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { Effect, Layer } from "effect"
import { BrowserArtifact } from "../../src/browser/artifact"
import { BrowserRuntime } from "../../src/browser/runtime"
import { BrowserScenario } from "../../src/browser/scenario"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"
import { newWebSmoke } from "./scenarios/newweb-smoke"

const binary = process.env.CHIMERA_NEWWEB_SMOKE_BIN
const smoke = binary ? test : test.skip
const outputRoot = path.resolve(process.env.CHIMERA_NEWWEB_SMOKE_OUTPUT_DIR ?? path.join("dist", "browser-smoke", "newweb"))

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Unable to allocate a loopback port"))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

smoke(
  "runs the NewWeb settings smoke against an embedded with-WebUI binary",
  async () => {
    const executable = path.resolve(binary!)
    if (!(await Bun.file(executable).exists())) throw new Error(`NewWeb smoke binary does not exist: ${executable}`)
    await using tmp = await tmpdir()
    const outputDirectory = path.join(outputRoot, `${Date.now()}-${process.pid}`)
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const env = { ...process.env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_DISABLE_AUTOUPDATE: "true" }
    const server = Bun.spawn(
      [executable, "web", "--hostname=127.0.0.1", `--port=${port}`, "--open=false"],
      {
        cwd: tmp.path,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdoutPromise = new Response(server.stdout).text()
    const stderrPromise = new Response(server.stderr).text()
    let output: BrowserScenario.RunOutput | undefined
    let failure: unknown

    try {
      const deadline = Date.now() + 30_000
      let ready = false
      while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`Chimera Web exited before readiness with code ${server.exitCode}`)
        const response = await fetch(baseUrl).catch(() => undefined)
        if (response?.ok) {
          const html = await response.text()
          if (html.includes("Chimera NewWeb assets are not embedded in this build"))
            throw new Error("The selected Chimera binary does not contain embedded NewWeb assets")
          ready = true
          break
        }
        await Bun.sleep(100)
      }
      if (!ready) throw new Error(`Timed out waiting for Chimera Web at ${baseUrl}`)

      output = await WithInstance.provide({
        directory: tmp.path,
        fn: () =>
          BrowserScenario.run({
            scenario: newWebSmoke(baseUrl, {
              newChat: process.env.CHIMERA_NEWWEB_SMOKE_NEW_CHAT ?? "New Chat",
              settings: process.env.CHIMERA_NEWWEB_SMOKE_SETTINGS ?? "Settings",
              closeSettings: process.env.CHIMERA_NEWWEB_SMOKE_CLOSE_SETTINGS ?? "Close settings",
            }),
            sessionID: "newweb-smoke",
          }).pipe(
            Effect.provide(Layer.mergeAll(BrowserRuntime.defaultLayer, BrowserArtifact.defaultLayer)),
            Effect.scoped,
            Effect.runPromise,
          ),
      })
      if (output.result.status === "failed") throw new Error(JSON.stringify(output.result, undefined, 2))
    } catch (cause) {
      failure = cause
    } finally {
      if (server.exitCode === null) server.kill()
      await Promise.race([server.exited, Bun.sleep(5_000)])
      if (server.exitCode === null) server.kill(9)
      await server.exited
    }

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    await fs.mkdir(outputDirectory, { recursive: true })
    const stdoutPath = path.join(outputDirectory, "newweb-server.stdout.log")
    const stderrPath = path.join(outputDirectory, "newweb-server.stderr.log")
    await Promise.all([Bun.write(stdoutPath, stdout), Bun.write(stderrPath, stderr)])
    const persistedArtifacts = output
      ? await Promise.all(
          output.result.artifacts.map(async (artifact) => {
            const target = path.join(outputDirectory, artifact.filename)
            await Bun.write(target, Bun.file(artifact.path))
            return { ...artifact, path: target }
          }),
        )
      : []
    const persistedResult = output ? { ...output.result, artifacts: persistedArtifacts } : undefined
    const persistedReports =
      output && persistedResult
        ? await Promise.all(
            [
              { artifact: output.json, data: JSON.stringify(persistedResult, undefined, 2) },
              { artifact: output.junit, data: BrowserScenario.junitXML(persistedResult) },
            ].map(async (report) => {
              const target = path.join(outputDirectory, report.artifact.filename)
              await Bun.write(target, report.data)
              return { ...report.artifact, path: target }
            }),
          )
        : []
    const persisted = [...persistedReports, ...persistedArtifacts]
    if (persistedResult) {
      const json = persistedReports.find((artifact) => artifact.mime === "application/json")
      const junit = persistedReports.find((artifact) => artifact.mime === "application/xml")
      if (!json || !junit) throw new Error("NewWeb smoke did not persist both JSON and JUnit reports")
      const report = (await Bun.file(json.path).json()) as BrowserScenario.Result
      expect(report.artifacts.map((artifact) => artifact.path)).toEqual(
        persistedArtifacts.map((artifact) => artifact.path),
      )
      expect(await Promise.all(report.artifacts.map((artifact) => Bun.file(artifact.path).exists()))).not.toContain(false)
      const xml = await Bun.file(junit.path).text()
      expect(persistedArtifacts.every((artifact) => xml.includes(artifact.path))).toBe(true)
    }
    if (failure) {
      const artifactPaths = persisted.map((artifact) => artifact.path).join("\n") || "none"
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)}\nScenario artifacts:\n${artifactPaths}\nServer stdout: ${stdoutPath}\nServer stderr: ${stderrPath}`,
      )
    }

    expect(output?.result.status).toBe("passed")
    expect(persisted.some((artifact) => artifact.kind === "screenshot")).toBe(true)
    expect(persisted.some((artifact) => artifact.mime === "application/json")).toBe(true)
    expect(persisted.some((artifact) => artifact.mime === "application/xml")).toBe(true)
    expect(await Promise.all(persisted.map((artifact) => Bun.file(artifact.path).exists()))).not.toContain(false)
    console.log(`NewWeb smoke artifacts:\n${persisted.map((artifact) => artifact.path).join("\n")}`)
  },
  { timeout: 90_000 },
)
