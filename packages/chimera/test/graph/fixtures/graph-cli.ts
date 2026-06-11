#!/usr/bin/env bun
import { runChimeraCli } from "../../../src/graph/cli/chimera"

await runChimeraCli(process.argv.slice(2), { defaultToInstaller: true })
