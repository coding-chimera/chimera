#!/usr/bin/env bun

import { $ } from "bun"

// Args pass through to prettier (e.g. `bun script/format.ts --check src/foo.ts`
// checks instead of writing, and scopes to the given paths). No args keeps the
// historical full-repo write behavior (`script/generate.ts` relies on this).
const args = process.argv.slice(2)
if (args.length === 0) {
  await $`bun run prettier --ignore-unknown --write .`
} else {
  await $`bun run prettier --ignore-unknown ${args}`
}
