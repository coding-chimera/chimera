#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function candidatePackageNames(platform, arch) {
  const base = `coding-chimera-${platform}-${arch}`
  if (platform !== "linux") return arch === "x64" ? [base, `${base}-baseline`] : [base]
  if (arch !== "x64") return [base, `${base}-musl`]
  return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const binaryName = platform === "windows" ? "chimera.exe" : "chimera"
  let current = __dirname
  for (;;) {
    const modules = path.join(current, "node_modules")
    for (const packageName of candidatePackageNames(platform, arch)) {
      const nested = path.join(modules, packageName, "bin", binaryName)
      if (fs.existsSync(nested)) return { binaryPath: nested, binaryName }

      const sibling = path.join(current, packageName, "bin", binaryName)
      if (fs.existsSync(sibling)) return { binaryPath: sibling, binaryName }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Could not find Chimera platform package for ${platform}/${arch}`)
}

function syncGrammarAssets(binaryPath) {
  const source = path.join(path.dirname(binaryPath), "tree-sitter-wasms")
  const target = path.join(__dirname, "bin", "tree-sitter-wasms")
  fs.rmSync(target, { recursive: true, force: true })
  if (!fs.existsSync(source)) return
  fs.cpSync(source, target, { recursive: true })
}

async function main() {
  try {
    if (os.platform() === "win32") {
      // On Windows, the .exe is already included in the package and bin field points to it
      // No postinstall setup needed
      console.log("Windows detected: binary setup not needed (using packaged .exe)")
      return
    }

    // On non-Windows platforms, just verify the binary package exists
    // Don't replace the wrapper script - it handles binary execution
    const { binaryPath } = findBinary()
    const target = path.join(__dirname, "bin", ".chimera")
    if (fs.existsSync(target)) fs.unlinkSync(target)
    try {
      fs.linkSync(binaryPath, target)
    } catch {
      fs.copyFileSync(binaryPath, target)
    }
    fs.chmodSync(target, 0o755)
    syncGrammarAssets(binaryPath)
  } catch (error) {
    console.error("Failed to setup Chimera binary:", error.message)
    process.exit(1)
  }
}

try {
  void main()
} catch (error) {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
}
