// CLI entry for the WP-03 fault matrix.
//
// Usage (from packages/chimera):
//   bun run test/oracle/compare/run.ts
//   bun run test/oracle/compare/run.ts --json
//
// Exit code 0 means every fault fixture was rejected with its exact expected
// code and every un-injected golden passed. Any mismatch exits 1.

import { runFaultMatrix } from "./suite"

const args = process.argv.slice(2)

if (args.includes("--help")) {
  console.log("usage: bun run test/oracle/compare/run.ts [--json]")
  process.exit(0)
}

const report = await runFaultMatrix()

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

const mark = (status: "pass" | "fail") => (status === "pass" ? "PASS" : "FAIL")

for (const check of report.matrix_checks) {
  console.log(`${mark(check.status)} matrix ${check.id} [${check.code}]`)
  if (check.status === "fail" && check.detail) console.log(`     ${check.detail}`)
}

for (const control of report.controls) {
  console.log(`${mark(control.status)} control ${control.base_golden} [${control.actual_code}]`)
  if (control.status === "fail" && control.detail) console.log(`     ${control.detail}`)
}

for (const check of report.results) {
  console.log(`${mark(check.status)} ${check.fault_class} ${check.id} [${check.actual_code}]`)
  if (check.status === "fail" && check.detail) console.log(`     ${check.detail}`)
}

const all = [...report.matrix_checks, ...report.controls, ...report.results]
const passed = all.filter((item) => item.status === "pass").length
console.log(`RESULT: ${report.passed ? "PASS" : "FAIL"} (${passed}/${all.length} checks)`)

if (!report.passed) process.exit(1)