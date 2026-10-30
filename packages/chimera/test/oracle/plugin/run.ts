// WP-09 focused runner.
//
//   bun run test/oracle/plugin/run.ts
//   bun run test/oracle/plugin/run.ts --out <dir>
//   bun run test/oracle/plugin/run.ts --write-golden   # only for intentional fixture changes
//
// Exit code 0 = every check passed. No production code, no Rust build, no
// executable artifact is produced.

import { defaultOutDir, runHookTraceSuite, writeGoldens } from "./harness"

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const outDir = outIndex === -1 ? await defaultOutDir() : args[outIndex + 1]
if (!outDir) {
  console.error("--out requires a directory")
  process.exit(2)
}

if (args.includes("--write-golden")) {
  const written = await writeGoldens()
  console.log(`wrote ${written.path} (${written.eventCount} events)`)
}

const suite = await runHookTraceSuite({ outDir })

for (const check of suite.checks) {
  const status = check.status === "pass" ? "PASS" : "FAIL"
  const detail = check.detail ? ` — ${check.detail}` : ""
  console.log(`${status}  ${check.id}  [${check.kind}] ${check.code}${detail}`)
}

const passed = suite.checks.filter((check) => check.status === "pass").length
console.log(`\n${passed}/${suite.checks.length} checks passed`)
console.log(`summary: ${outDir}/summary.json`)

if (!suite.passed) process.exit(1)