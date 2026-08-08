#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.join(__dirname, "bin")

function main() {
  try {
    for (const name of [".chimera", ".opencode", "tree-sitter-wasms", "web-tree-sitter"]) {
      fs.rmSync(path.join(binDir, name), { recursive: true, force: true })
    }

    const env = { ...process.env }
    delete env.CHIMERA_BIN_PATH
    delete env.OPENCODE_BIN_PATH
    const result = childProcess.spawnSync(process.execPath, [path.join(binDir, "chimera"), "--version"], {
      stdio: "inherit",
      env,
    })
    if (result.error) throw result.error
    if (result.status === 0) return

    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`
    throw new Error(`Chimera wrapper verification failed (${reason})`)
  } catch (error) {
    console.error("Failed to verify Chimera installation:", error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
