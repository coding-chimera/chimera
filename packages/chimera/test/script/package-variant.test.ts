import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  packageLicense,
  packageLicenseFiles,
  parsePackageVariant,
  platformPackageName,
  tarballNameForVariant,
  writePackageLicenseFiles,
  type PackageVariant,
} from "../../script/package-variant"
import pkg from "../../package.json"

const dirs: string[] = []
const projectDir = path.resolve(import.meta.dir, "../..")

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function packageFiles(variant: PackageVariant) {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "chimera-package-variant-"))
  dirs.push(packageDir)
  await writePackageLicenseFiles({ packageDir, variant, projectDir })
  return new Set(await fs.readdir(packageDir))
}

describe("script.package-variant", () => {
  test("uses the same public package identity for both variants", () => {
    expect(pkg.name).toBe("chimera")
    expect(pkg.bin).toEqual({ chimera: "./bin/chimera" })
    expect(platformPackageName(pkg.name, { os: "darwin", arch: "arm64" })).toBe("chimera-darwin-arm64")
    expect(platformPackageName(pkg.name, { os: "win32", arch: "x64", avx2: false })).toBe(
      "chimera-windows-x64-baseline",
    )
  })

  test("validates variant names and licenses", () => {
    expect(parsePackageVariant("no-webui")).toBe("no-webui")
    expect(parsePackageVariant("with-webui")).toBe("with-webui")
    expect(() => parsePackageVariant("webui")).toThrow("Invalid package variant: webui")
    expect(packageLicense("no-webui")).toBe("MIT")
    expect(packageLicense("with-webui")).toBe("GPL-3.0-only")
    expect(packageLicenseFiles("no-webui")).toEqual(["LICENSE"])
    expect(packageLicenseFiles("with-webui")).toEqual(["LICENSE", "LICENSE-MIT", "NOTICE"])
  })

  test("writes the root MIT license only for no-WebUI", async () => {
    const files = await packageFiles("no-webui")
    expect(files).toEqual(new Set(["LICENSE"]))
    const packageDir = dirs.at(-1)!
    expect(await Bun.file(path.join(packageDir, "LICENSE")).text()).toBe(
      await Bun.file(path.join(projectDir, "..", "..", "LICENSE")).text(),
    )
  })

  test("writes GPL-primary files, the root MIT license, and notice for with-WebUI", async () => {
    const files = await packageFiles("with-webui")
    expect(files).toEqual(new Set(["LICENSE", "LICENSE-MIT", "NOTICE"]))
    const packageDir = dirs.at(-1)!
    expect(await Bun.file(path.join(packageDir, "LICENSE")).text()).toBe(
      await Bun.file(path.join(projectDir, "..", "newweb", "LICENSE")).text(),
    )
    expect(await Bun.file(path.join(packageDir, "LICENSE-MIT")).text()).toBe(
      await Bun.file(path.join(projectDir, "..", "..", "LICENSE")).text(),
    )
    expect(await Bun.file(path.join(packageDir, "NOTICE")).text()).toBe(
      await Bun.file(path.join(projectDir, "NOTICE")).text(),
    )
  })

  test("puts variants only in tarball filenames", () => {
    expect(tarballNameForVariant("chimera-1.2.3.tgz", "no-webui")).toBe("chimera-no-webui-1.2.3.tgz")
    expect(tarballNameForVariant("chimera-darwin-arm64-1.2.3.tgz", "with-webui")).toBe(
      "chimera-darwin-arm64-with-webui-1.2.3.tgz",
    )
  })
})
