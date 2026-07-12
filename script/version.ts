#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]
const sha = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
const distributionNotes = [
  "## Distribution variants",
  "",
  "- `no-WebUI`: default standalone archives and `*-no-webui-*.tgz` packages; MIT-licensed and does not embed NewWeb.",
  "- `with-WebUI`: `*-with-webui` archives and tarballs; distributed as GPL-3.0-only with `LICENSE-MIT` and `NOTICE` preserving the Chimera runtime license and component boundary.",
].join("\n")
const notesFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/coding-chimera-release-notes.txt`

if (!Script.preview) {
  await $`bun script/changelog.ts --to ${sha}`.cwd(process.cwd())
  const file = `${process.cwd()}/UPCOMING_CHANGELOG.md`
  const body = await Bun.file(file)
    .text()
    .catch(() => "No notable changes")
  await Bun.write(notesFile, `${body.trim()}\n\n${distributionNotes}\n`)
  await $`gh release create v${Script.version} -d --target ${sha} --title "v${Script.version}" --notes-file ${notesFile}`
  const release = await $`gh release view v${Script.version} --json tagName,databaseId`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
} else if (Script.channel === "beta") {
  await Bun.write(notesFile, `${distributionNotes}\n`)
  await $`gh release create v${Script.version} -d --title "v${Script.version}" --notes-file ${notesFile} --repo ${process.env.GH_REPO}`
  const release =
    await $`gh release view v${Script.version} --json tagName,databaseId --repo ${process.env.GH_REPO}`.json()
  output.push(`release=${release.databaseId}`)
  output.push(`tag=${release.tagName}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
