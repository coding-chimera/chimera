#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

const dir = path.resolve(import.meta.dir, "..")

export async function packNpmTarballs() {
  const dist = path.join(dir, "dist")
  const tarballDir = path.join(dist, "npm-tarballs")
  const pkg = await Bun.file(path.join(dir, "package.json")).json()

  process.chdir(dir)

  const entries = await fs.readdir(dist, { withFileTypes: true }).catch(() => {
    throw new Error("dist directory not found. Run `bun run build --single --skip-install --skip-embed-web-ui` first.")
  })

  const platformPackages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${pkg.name}-`))
      .map(async (entry) => {
        const packageDir = path.join(dist, entry.name)
        const packageJson = await Bun.file(path.join(packageDir, "package.json")).json()
        return { dir: packageDir, json: packageJson }
      }),
  )

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
  await fs.copyFile(path.join(dir, "..", "..", "LICENSE"), path.join(mainDir, "LICENSE"))

  await Bun.file(path.join(mainDir, "package.json")).write(
    JSON.stringify(
      {
        name: pkg.name,
        version,
        type: "module",
        license: pkg.license,
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

  for (const item of platformPackages) {
    await $`bun pm pack --destination ${tarballDir}`.cwd(item.dir)
  }
  await $`bun pm pack --destination ${tarballDir}`.cwd(mainDir)

  const tarballs = (await fs.readdir(tarballDir)).filter((item) => item.endsWith(".tgz")).sort()
  console.log("Local npm tarballs:")
  for (const tarball of tarballs) {
    console.log(path.relative(dir, path.join(tarballDir, tarball)))
  }
}

if (import.meta.main) {
  await packNpmTarballs()
}
