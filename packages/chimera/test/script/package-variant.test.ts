import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  assertNoEmbeddedBuildPaths,
  createPlatformPackageManifest,
  npmPlatformTargets,
  packageLicense,
  packageLicenseFiles,
  parsePackageVariant,
  parsePackageVariantMetadata,
  platformPackageName,
  platformPackageNames,
  tarballNameForVariant,
  transformCommonJsPathGlobals,
  validatePlatformPackageSet,
  writePackageLicenseFiles,
  type PackageVariant,
  type PackageVariantMetadata,
} from "../../script/package-variant"
import pkg from "../../package.json"

const dirs: string[] = []
const projectDir = path.resolve(import.meta.dir, "../..")

const expectedPlatformPackages = [
  "@coding-chimera/chimera-linux-arm64",
  "@coding-chimera/chimera-linux-x64",
  "@coding-chimera/chimera-linux-x64-baseline",
  "@coding-chimera/chimera-linux-arm64-musl",
  "@coding-chimera/chimera-linux-x64-musl",
  "@coding-chimera/chimera-linux-x64-baseline-musl",
  "@coding-chimera/chimera-darwin-arm64",
  "@coding-chimera/chimera-darwin-x64",
  "@coding-chimera/chimera-darwin-x64-baseline",
  "@coding-chimera/chimera-windows-arm64",
  "@coding-chimera/chimera-windows-x64",
  "@coding-chimera/chimera-windows-x64-baseline",
]

function metadata(overrides: Partial<PackageVariantMetadata> = {}): PackageVariantMetadata {
  return {
    variant: "no-webui",
    version: "1.2.3",
    embedLegacyWebUi: false,
    embedNewWebUi: false,
    expectedPlatformPackages: [...expectedPlatformPackages],
    ...overrides,
  }
}

function platformVersions(names = expectedPlatformPackages, version = "1.2.3") {
  return names.map((name) => ({ name, version }))
}
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
    expect(pkg.name).toBe("@coding-chimera/chimera")
    expect(pkg.bin).toEqual({ chimera: "./bin/chimera" })
    expect(platformPackageName(pkg.name, { os: "darwin", arch: "arm64" })).toBe(
      "@coding-chimera/chimera-darwin-arm64",
    )
    expect(platformPackageName(pkg.name, { os: "win32", arch: "x64", avx2: false })).toBe(
      "@coding-chimera/chimera-windows-x64-baseline",
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


  test("defines the complete npm platform matrix once in release order", () => {
    expect(npmPlatformTargets).toHaveLength(12)
    expect(platformPackageNames(pkg.name)).toEqual(expectedPlatformPackages)
    expect(new Set(expectedPlatformPackages).size).toBe(12)
  })

  test("emits exact npm libc constraints only for Linux targets", () => {
    expect(
      createPlatformPackageManifest({
        name: "@coding-chimera/chimera-linux-x64",
        version: "1.2.3",
        target: { os: "linux", arch: "x64" },
        variant: "with-webui",
      }),
    ).toEqual({
      name: "@coding-chimera/chimera-linux-x64",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
      license: "GPL-3.0-only",
      files: ["bin", "LICENSE", "LICENSE-MIT", "NOTICE"],
    })
    expect(
      createPlatformPackageManifest({
        name: "@coding-chimera/chimera-linux-x64-musl",
        version: "1.2.3",
        target: { os: "linux", arch: "x64", abi: "musl" },
        variant: "no-webui",
      }).libc,
    ).toEqual(["musl"])
    expect(
      createPlatformPackageManifest({
        name: "@coding-chimera/chimera-darwin-arm64",
        version: "1.2.3",
        target: { os: "darwin", arch: "arm64" },
        variant: "no-webui",
      }),
    ).not.toHaveProperty("libc")
  })

  test("excludes stale tarballs from platform package contents", async () => {
    const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "chimera-platform-pack-"))
    dirs.push(packageDir)
    await fs.mkdir(path.join(packageDir, "bin"))
    await Promise.all([
      Bun.write(
        path.join(packageDir, "package.json"),
        JSON.stringify(
          createPlatformPackageManifest({
            name: "@coding-chimera/chimera-darwin-arm64",
            version: "1.2.3",
            target: { os: "darwin", arch: "arm64" },
            variant: "no-webui",
          }),
        ),
      ),
      Bun.write(path.join(packageDir, "bin", "chimera"), "binary"),
      Bun.write(path.join(packageDir, "LICENSE"), "license"),
      Bun.write(path.join(packageDir, "stale.tgz"), "stale"),
    ])
    const child = Bun.spawn([process.execPath, "pm", "pack", "--dry-run"], {
      cwd: packageDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain("bin/chimera")
    expect(stdout + stderr).not.toContain("stale.tgz")
    expect((await fs.readdir(packageDir)).filter((file) => file.endsWith(".tgz"))).toEqual(["stale.tgz"])
  })

  test("rewrites only free CommonJS path globals to relocatable import.meta paths", async () => {
    const transformed = await transformCommonJsPathGlobals({
      filename: "/tmp/dependency.js",
      source: [
        'const local = { __dirname: "property" }',
        'function bound(__dirname) { return __dirname }',
        'module.exports = [__dirname, __filename, local.__dirname, "__filename", bound("value")]',
      ].join("\n"),
    })
    expect(transformed.match(/import\.meta\.dirname/g)).toHaveLength(1)
    expect(transformed.match(/import\.meta\.filename/g)).toHaveLength(1)
    expect(transformed).toContain("local.__dirname")
    expect(transformed).toContain('"__filename"')
    expect(transformed).toContain("return __dirname")
  })

  test("rejects UTF-8 and UTF-16 absolute build roots in binary bytes", () => {
    const root = path.join(os.tmpdir(), "chimera-build-root")
    const clean = { artifactPath: "dist/chimera", bytes: Buffer.from("clean"), roots: [root] }
    expect(() => assertNoEmbeddedBuildPaths(clean)).not.toThrow()
    expect(() =>
      assertNoEmbeddedBuildPaths({ ...clean, bytes: Buffer.from(`prefix:${root}:suffix`) }),
    ).toThrow("contains an absolute build path")
    expect(() =>
      assertNoEmbeddedBuildPaths({ ...clean, bytes: Buffer.from(`prefix:${root}:suffix`, "utf16le") }),
    ).toThrow("utf16le")
  })

  test("parses valid fail-closed package metadata for both variants", () => {
    expect(parsePackageVariantMetadata(metadata(), pkg.name)).toEqual(metadata())
    expect(
      parsePackageVariantMetadata(
        metadata({ variant: "with-webui", embedLegacyWebUi: true, embedNewWebUi: true }),
        pkg.name,
      ),
    ).toEqual(metadata({ variant: "with-webui", embedLegacyWebUi: true, embedNewWebUi: true }))
  })

  test("rejects malformed package metadata and invalid UI claims", () => {
    expect(() => parsePackageVariantMetadata(null, pkg.name)).toThrow("must be an object")
    expect(() => parsePackageVariantMetadata({ ...metadata(), version: "latest" }, pkg.name)).toThrow(
      "version must be an exact npm version",
    )
    expect(() => parsePackageVariantMetadata({ ...metadata(), extra: true }, pkg.name)).toThrow(
      "metadata fields mismatch",
    )
    expect(() =>
      parsePackageVariantMetadata(metadata({ variant: "with-webui", embedNewWebUi: false }), pkg.name),
    ).toThrow("requires embedNewWebUi=true")
    expect(() => parsePackageVariantMetadata(metadata({ embedLegacyWebUi: true }), pkg.name)).toThrow(
      "cannot claim embedded WebUI assets",
    )
    expect(() =>
      parsePackageVariantMetadata(
        metadata({ expectedPlatformPackages: [expectedPlatformPackages[0], expectedPlatformPackages[0]] }),
        pkg.name,
      ),
    ).toThrow("duplicate platform packages")
    expect(() =>
      parsePackageVariantMetadata(
        metadata({ expectedPlatformPackages: [...expectedPlatformPackages].reverse() }),
        pkg.name,
      ),
    ).toThrow("platform order mismatch")
  })

  test("validates and orders an exact 12-platform package set", () => {
    const result = validatePlatformPackageSet({
      metadata: metadata(),
      packages: platformVersions().reverse(),
      requiredPlatformPackages: expectedPlatformPackages,
      requiredVersion: "1.2.3",
    })
    expect(Object.keys(result)).toEqual(expectedPlatformPackages)
    expect(new Set(Object.values(result))).toEqual(new Set(["1.2.3"]))
  })

  test("preserves a validated single-build subset without requiring all 12 platforms", () => {
    const expectedPlatformPackages = ["@coding-chimera/chimera-darwin-arm64"]
    expect(
      validatePlatformPackageSet({
        metadata: metadata({ expectedPlatformPackages }),
        packages: platformVersions(expectedPlatformPackages),
      }),
    ).toEqual({ "@coding-chimera/chimera-darwin-arm64": "1.2.3" })
  })

  test("rejects missing, extra, duplicate, and wrong-version platform packages", () => {
    expect(() =>
      validatePlatformPackageSet({ metadata: metadata(), packages: platformVersions().slice(1) }),
    ).toThrow("missing")
    expect(() =>
      validatePlatformPackageSet({
        metadata: metadata(),
        packages: [...platformVersions(), { name: `${pkg.name}-plan9-x64`, version: "1.2.3" }],
      }),
    ).toThrow("extra")
    expect(() =>
      validatePlatformPackageSet({
        metadata: metadata(),
        packages: [...platformVersions(), platformVersions()[0]],
      }),
    ).toThrow("duplicate")
    expect(() =>
      validatePlatformPackageSet({
        metadata: metadata(),
        packages: platformVersions().map((item, index) => (index === 0 ? { ...item, version: "1.2.4" } : item)),
      }),
    ).toThrow("must equal 1.2.3")
  })

  test("rejects a subset or metadata version when a full publish matrix is required", () => {
    const subset = [expectedPlatformPackages[0]]
    expect(() =>
      validatePlatformPackageSet({
        metadata: metadata({ expectedPlatformPackages: subset }),
        packages: platformVersions(subset),
        requiredPlatformPackages: expectedPlatformPackages,
      }),
    ).toThrow("platform matrix mismatch")
    expect(() =>
      validatePlatformPackageSet({
        metadata: metadata(),
        packages: platformVersions(),
        requiredVersion: "1.2.4",
      }),
    ).toThrow("does not match required version 1.2.4")
  })
})
