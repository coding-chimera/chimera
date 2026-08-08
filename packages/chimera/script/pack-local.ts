#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { createNpmPackageManifest } from "./npm-package"
import {
  packageLicense,
  parsePackageVariantMetadata,
  tarballNameForVariant,
  validatePlatformPackageSet,
  writePackageLicenseFiles,
  type PackageVariant,
} from "./package-variant"

const dir = path.resolve(import.meta.dir, "..")

export async function packNpmTarballs(input: { variant?: PackageVariant } = {}) {
  const dist = path.join(dir, "dist")
  const tarballDir = path.join(dist, "npm-tarballs")
  const pkg: { name: string } = await Bun.file(path.join(dir, "package.json")).json()
  const metadata = parsePackageVariantMetadata(
    await Bun.file(path.join(dist, "package-variant.json"))
      .json()
      .catch(() => null),
    pkg.name,
  )
  if (input.variant && input.variant !== metadata.variant) {
    throw new Error(`Requested package variant ${input.variant} does not match build metadata ${metadata.variant}`)
  }
  const variant = metadata.variant
  process.chdir(dir)

  const discoveredPackages = await findPlatformPackages(dist, pkg.name)
  const platformPackageVersions = validatePlatformPackageSet({
    metadata,
    packages: discoveredPackages.map((item) => item.json),
  })
  const platformPackages = metadata.expectedPlatformPackages.map((name) => {
    const item = discoveredPackages.find((candidate) => candidate.json.name === name)
    if (!item) throw new Error(`Validated platform package is missing: ${name}`)
    return item
  })
  const version = metadata.version
  const mainDir = path.join(dist, pkg.name)
  await fs.rm(mainDir, { recursive: true, force: true })
  await fs.mkdir(mainDir, { recursive: true })

  await fs.cp(path.join(dir, "bin"), path.join(mainDir, "bin"), { recursive: true })
  await fs.copyFile(path.join(dir, "script", "postinstall.mjs"), path.join(mainDir, "postinstall.mjs"))
  await fs.copyFile(path.join(dir, "README.md"), path.join(mainDir, "README.md"))
  await writePackageLicenseFiles({ packageDir: mainDir, variant, projectDir: dir })

  await Bun.file(path.join(mainDir, "package.json")).write(
    JSON.stringify(
      createNpmPackageManifest({
        version,
        variant,
        platformPackages: platformPackageVersions,
      }),
      null,
      2,
    ),
  )

  await fs.rm(tarballDir, { recursive: true, force: true })
  await fs.mkdir(tarballDir, { recursive: true })

  const pack = async (packageDir: string) => {
    const before = new Set(await fs.readdir(tarballDir))
    await $`bun pm pack --destination ${tarballDir}`.cwd(packageDir)
    const packed = (await fs.readdir(tarballDir)).filter((item) => item.endsWith(".tgz") && !before.has(item))
    for (const file of packed) {
      await fs.rename(path.join(tarballDir, file), path.join(tarballDir, tarballNameForVariant(file, variant)))
    }
  }

  for (const item of platformPackages) {
    await writePackageLicenseFiles({ packageDir: item.dir, variant, projectDir: dir })
    const json = { ...item.json, license: packageLicense(variant) }
    await Bun.file(path.join(item.dir, "package.json")).write(JSON.stringify(json, null, 2))
    await pack(item.dir)
  }
  await pack(mainDir)

  const tarballs = (await fs.readdir(tarballDir)).filter((item) => item.endsWith(".tgz")).sort()
  console.log("Local npm tarballs:")
  for (const tarball of tarballs) {
    console.log(path.relative(dir, path.join(tarballDir, tarball)))
  }
}

async function findPlatformPackages(
  dist: string,
  pkgName: string,
): Promise<{ dir: string; json: Record<string, unknown> & { name: string; version: unknown } }[]> {
  const results: { dir: string; json: Record<string, unknown> & { name: string; version: unknown } }[] = []

  const packageRoot = path.resolve(dist, pkgName)
  const packageParent = path.dirname(packageRoot)
  const packagePrefix = `${path.basename(packageRoot)}-`

  async function scan(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const packageDir = path.join(currentDir, entry.name)
      const platformDir = path.resolve(currentDir) === packageParent && entry.name.startsWith(packagePrefix)
      const packageJsonPath = path.join(packageDir, "package.json")
      const hasPackageJson = await fs
        .access(packageJsonPath)
        .then(() => true)
        .catch(() => false)
      if (platformDir && !hasPackageJson) {
        throw new Error(`Platform package directory is missing package.json: ${packageDir}`)
      }
      if (hasPackageJson) {
        const json: unknown = await Bun.file(packageJsonPath).json()
        if (typeof json !== "object" || json === null || Array.isArray(json)) {
          throw new Error(`Platform package manifest must be an object: ${packageJsonPath}`)
        }
        const manifest = json as Record<string, unknown>
        const name = manifest.name
        if (typeof name === "string" && name.startsWith(`${pkgName}-`)) {
          const expectedDir = path.resolve(dist, name)
          if (path.resolve(packageDir) !== expectedDir) {
            throw new Error(`Platform package directory does not match manifest name: ${packageDir}`)
          }
          results.push({
            dir: packageDir,
            json: { ...manifest, name, version: manifest.version },
          })
          continue
        }
        if (platformDir) throw new Error(`Platform package manifest has an invalid name: ${packageJsonPath}`)
      }
      await scan(packageDir)
    }
  }

  await scan(dist)
  return results
}

if (import.meta.main) {
  await packNpmTarballs()
}
