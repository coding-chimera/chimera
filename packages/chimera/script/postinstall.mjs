#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.join(__dirname, "bin")

/**
 * Native graph-kernel probe (distribution wiring, plan §3 P0.5): when the
 * installed platform package ships bin/kernel/codegraph-kernel.node beside
 * the compiled binary (the loader's execPath-adjacent candidate), try to
 * load it here and sanity-check the wire contract, so a broken addon is
 * surfaced at install time instead of silently degrading later.
 *
 * WARN-ONLY by design: the kernel is an optional accelerator and every load
 * failure (wrong libc, unsupported Node/Bun NAPI, contract drift) falls back
 * to the wasm extraction arm at runtime. A failed probe must never fail the
 * install. Keep the expected ABI in sync with KERNEL_ABI_VERSION in
 * src/graph/extraction/kernel/layout.ts (this script ships as plain .mjs and
 * cannot import the TS constant).
 */
const EXPECTED_KERNEL_ABI_VERSION = 2

function findKernelAddon() {
  const pkgName = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).name
    } catch {
      return "@coding-chimera/chimera"
    }
  })()
  const platform = os.platform() === "win32" ? "windows" : os.platform()
  const bases = pkgName.includes("/") ? [pkgName, pkgName.split("/").pop()] : [pkgName]
  const names = bases.flatMap((base) =>
    ["", "-baseline", "-musl", "-baseline-musl"].map((suffix) => `${base}-${platform}-${os.arch()}${suffix}`),
  )
  // npm hoists optionalDependencies either as siblings (global installs:
  // <prefix>/lib/node_modules/@coding-chimera/chimera-<platform>) or nested
  // under the main package's own node_modules. Probe both, walking up like
  // the bin/chimera wrapper does.
  let current = __dirname
  for (;;) {
    for (const name of names) {
      for (const candidate of [
        path.join(current, "node_modules", name, "bin", "kernel", "codegraph-kernel.node"),
        path.join(current, name, "bin", "kernel", "codegraph-kernel.node"),
      ]) {
        if (fs.existsSync(candidate)) return candidate
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function probeKernel() {
  const addon = findKernelAddon()
  if (!addon) {
    console.log("Chimera graph kernel: no prebuilt addon for this platform - wasm extraction will be used")
    return
  }
  try {
    const req = createRequire(addon)
    const mod = req(addon)
    if (typeof mod.extractFile !== "function" || typeof mod.contractInfo !== "function") {
      throw new Error("addon is missing extractFile/contractInfo exports")
    }
    const info = mod.contractInfo()
    if (info.abiVersion !== EXPECTED_KERNEL_ABI_VERSION) {
      throw new Error(`addon ABI ${info.abiVersion} != expected ${EXPECTED_KERNEL_ABI_VERSION}`)
    }
    for (const table of [info.nodeKinds, info.edgeKinds, info.languages]) {
      if (!Array.isArray(table)) throw new Error("contract tables must be arrays")
    }
    console.log(
      `Chimera graph kernel: native addon verified (${info.kernelVersion || "unknown version"}, languages: ${info.languages.join(", ")})`,
    )
  } catch (error) {
    console.warn(
      `Chimera graph kernel: probe failed (${error instanceof Error ? error.message : error}) - install continues; extraction falls back to the wasm arm`,
    )
  }
}

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
    if (result.status === 0) {
      probeKernel()
      return
    }

    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`
    throw new Error(`Chimera wrapper verification failed (${reason})`)
  } catch (error) {
    console.error("Failed to verify Chimera installation:", error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
