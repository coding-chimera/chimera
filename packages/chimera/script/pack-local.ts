#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import {
  packageLicense,
  parsePackageVariant,
  tarballNameForVariant,
  writePackageLicenseFiles,
  type PackageVariant,
} from "./package-variant"

const dir = path.resolve(import.meta.dir, "..")

export async function packNpmTarballs(input: { variant?: PackageVariant } = {}) {
  const dist = path.join(dir, "dist")
  const tarballDir = path.join(dist, "npm-tarballs")
  const pkg = await Bun.file(path.join(dir, "package.json")).json()
  const metadata = await Bun.file(path.join(dist, "package-variant.json"))
    .json()
    .catch(() => null)
  const variant = parsePackageVariant(input.variant ?? metadata?.variant ?? "no-webui")
  process.chdir(dir)

  const platformPackages = await findPlatformPackages(dist, pkg.name)
  if (platformPackages.length === 0) {
    throw new Error("No platform packages found in dist. Run the build before packing.")
  }

  const versions = new Set(platformPackages.map((item) => item.json.version))
  if (versions.size !== 1) {
    throw new Error(`Platform package versions do not match: ${[...versions].join(", ")}`)
  }
  const version = platformPackages[0].json.version
  const mainDir = path.join(dist, pkg.name)
  await fs.rm(mainDir, { recursive: true, force: true })
  await fs.mkdir(mainDir, { recursive: true })

  await fs.cp(path.join(dir, "bin"), path.join(mainDir, "bin"), { recursive: true })
  await fs.copyFile(path.join(dir, "script", "postinstall.mjs"), path.join(mainDir, "postinstall.mjs"))
  await fs.copyFile(path.join(dir, "README.md"), path.join(mainDir, "README.md"))
  await writePackageLicenseFiles({ packageDir: mainDir, variant, projectDir: dir })

  await Bun.file(path.join(mainDir, "package.json")).write(
    JSON.stringify(
      {
        name: pkg.name,
        version,
        type: "module",
        license: packageLicense(variant),
        bin: {
          chimera: "./bin/chimera",
        },
        scripts: {
          postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        },
        optionalDependencies: Object.fromEntries(platformPackages.map((item) => [item.json.name, item.json.version])),
      },
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

async function findPlatformPackages(dist: string, pkgName: string): Promise<{ dir: string; json: any }[]> {
  const results: { dir: string; json: any }[] = []

  async function scan(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const packageDir = path.join(currentDir, entry.name)
      const packageJsonPath = path.join(packageDir, "package.json")
      const hasPackageJson = await fs
        .access(packageJsonPath)
        .then(() => true)
        .catch(() => false)
      if (hasPackageJson) {
        const json = await Bun.file(packageJsonPath).json()
        if (json.name && String(json.name).startsWith(`${pkgName}-`)) {
          results.push({ dir: packageDir, json })
          continue
        }
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
