// CLI entry for the WP-08 provider fixture suite.
//
// Usage (from packages/chimera):
//   bun run test/oracle/provider/run.ts
//
// The suite is offline: it validates the six synthetic profile fixtures,
// their canonical event ordering, and the no-secrets rules. It never calls a
// provider and never starts a transport.

import { renderSuite, runSuite } from "./validate"

const suite = await runSuite()
console.log(renderSuite(suite))

if (!suite.ok) process.exit(1)