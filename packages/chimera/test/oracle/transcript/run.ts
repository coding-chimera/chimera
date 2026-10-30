// CLI entry for the WP-02 transcript harness.
//
// Usage (from packages/chimera):
//   bun run test/oracle/transcript/run.ts
//   bun run test/oracle/transcript/run.ts --out <dir>
//   bun run test/oracle/transcript/run.ts --write-golden
//
// The default run writes arm transcripts and summary.json under an OS temp
// directory and prints its path; pass --out to keep artifacts at a known
// location. --write-golden regenerates golden/*.jsonl from the synthetic
// fixtures and is the only maintenance path for committed goldens.

import { runSuite, writeGoldens } from "./harness"

const args = process.argv.slice(2)

if (args.includes("--help")) {
  console.log("usage: bun run test/oracle/transcript/run.ts [--out <dir>] [--write-golden]")
  process.exit(0)
}

if (args.includes("--write-golden")) {
  const written = await writeGoldens()
  for (const item of written) {
    console.log(`wrote ${item.path} (${item.eventCount} events, scenario ${item.scenario})`)
  }
  process.exit(0)
}

const outIndex = args.indexOf("--out")
if (outIndex >= 0 && !args[outIndex + 1]) {
  console.error("--out requires a directory")
  process.exit(2)
}

const suite = await runSuite(outIndex >= 0 ? { outDir: args[outIndex + 1] } : {})

for (const item of suite.checks) {
  const mark = item.status === "pass" ? "PASS" : "FAIL"
  console.log(`${mark} ${item.scenario} ${item.kind} ${item.id} [${item.code}]`)
  if (item.status === "fail" && item.detail) console.log(`     ${item.detail}`)
}

const passed = suite.checks.filter((item) => item.status === "pass").length
console.log(`artifacts: ${suite.rootDir}`)
console.log(`RESULT: ${suite.passed ? "PASS" : "FAIL"} (${passed}/${suite.checks.length} checks)`)

if (!suite.passed) process.exit(1)