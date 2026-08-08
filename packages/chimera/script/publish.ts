#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import path from "path"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import { createNpmPackageManifest } from "./npm-package"
import {
  parsePackageVariantMetadata,
  platformPackageNames,
  validatePlatformPackageSet,
  writePackageLicenseFiles,
} from "./package-variant"
import { resolveExplicitVersion } from "./version"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const dryRun = process.argv.includes("--dry-run")
const npmOnly = process.argv.includes("--npm-only")

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (!dryRun && (await published(name, version))) {
    console.log(`already published ${name}@${version}`)
    return
  }
  for (const file of fs.readdirSync(dir).filter((item) => item.endsWith(".tgz"))) {
    fs.rmSync(path.join(dir, file), { force: true })
  }
  await $`bun pm pack`.cwd(dir)
  const tarballs = fs.readdirSync(dir).filter((item) => item.endsWith(".tgz"))
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one packed tarball for ${name}@${version}, received: ${tarballs.join(", ")}`)
  }
  if (dryRun) {
    console.log(`dry run packed ${name}@${version}`)
    return
  }
  await $`npm publish ${tarballs[0]} --access public --tag ${Script.channel}`.cwd(dir)
}
const version = resolveExplicitVersion()
const requiredPlatformPackages = platformPackageNames(pkg.name)
const packageVariantMetadata = parsePackageVariantMetadata(
  await Bun.file("./dist/package-variant.json")
    .json()
    .catch(() => null),
  pkg.name,
)

const discoveredPackages = [...findPlatformPackages("./dist", pkg.name)]
const binaries = validatePlatformPackageSet({
  metadata: packageVariantMetadata,
  packages: discoveredPackages.map((item) => item.json),
  requiredPlatformPackages,
  requiredVersion: version,
})
const platformPackages = requiredPlatformPackages.map((name) => {
  const item = discoveredPackages.find((candidate) => candidate.json.name === name)
  if (!item) throw new Error(`Validated platform package is missing: ${name}`)
  return item
})
const packageVariant = packageVariantMetadata.variant
console.log(`Publishing ${packageVariant} variant at ${version}`)
console.log("binaries", binaries)

await $`rm -rf ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await $`cp ./README.md ./dist/${pkg.name}/README.md`
await writePackageLicenseFiles({
  packageDir: path.join(dir, "dist", pkg.name),
  variant: packageVariant,
  projectDir: dir,
})

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    createNpmPackageManifest({
      version,
      variant: packageVariant,
      platformPackages: binaries,
    }),
    null,
    2,
  ),
)

// Publish sequentially in the shared platform order: concurrent pack+publish
// of a dozen multi-hundred-MB platform packages can exhaust memory.
for (const item of platformPackages) {
  await publish(item.dir, item.json.name, version)
}
await publish(`./dist/${pkg.name}`, pkg.name, version)

const releaseName = pkg.name
const repo = process.env.GH_REPO
if (!npmOnly && !repo) throw new Error("GH_REPO is required")
const image = `ghcr.io/${repo}`
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
if (!npmOnly && !Script.preview && !dryRun) {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/${releaseName}-linux-arm64.tar.gz | cut -d' ' -f1`
    .text()
    .then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/${releaseName}-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/${releaseName}-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/${releaseName}-darwin-arm64.zip | cut -d' ' -f1`
    .text()
    .then((x) => x.trim())

  const [pkgver, _subver = ""] = version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    `pkgname='${releaseName}-bin'`,
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The Coding Chimera agent built for the terminal.'",
    `url='https://github.com/${repo}'`,
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    `provides=('${releaseName}')`,
    `conflicts=('${releaseName}')`,
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/${repo}/releases/download/v\${pkgver}\${_subver}/${releaseName}-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/${repo}/releases/download/v\${pkgver}\${_subver}/${releaseName}-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./chimera "${pkgdir}/usr/bin/chimera"',
    "}",
    "",
  ].join("\n")

  for (const [pkg, pkgbuild] of [[`${releaseName}-bin`, binaryPkgbuild]]) {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-${pkg}`
        await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
        await $`cd ./dist/aur-${pkg} && git checkout master`
        await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
        await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
        await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${version}"`
        await $`cd ./dist/aur-${pkg} && git push`
        break
      } catch {
        continue
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Chimera < Formula",
    `  desc "The Coding Chimera agent built for the terminal."`,
    `  homepage "https://github.com/${repo}"`,
    `  version "${version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/${repo}/releases/download/v${version}/${releaseName}-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "chimera"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/${repo}/releases/download/v${version}/${releaseName}-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "chimera"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/${repo}/releases/download/v${version}/${releaseName}-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "chimera"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/${repo}/releases/download/v${version}/${releaseName}-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "chimera"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const tapRepo = process.env.HOMEBREW_TAP_REPO
  if (!tapRepo) console.log("HOMEBREW_TAP_REPO is not set; skipping homebrew tap update")
  if (tapRepo) {
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      console.error("GITHUB_TOKEN is required to update homebrew tap")
      process.exit(1)
    }
    const tap = `https://x-access-token:${token}@github.com/${tapRepo}.git`
    await $`rm -rf ./dist/homebrew-tap`
    await $`git clone ${tap} ./dist/homebrew-tap`
    await Bun.file(`./dist/homebrew-tap/${releaseName}.rb`).write(homebrewFormula)
    await $`git add ${releaseName}.rb`.cwd("./dist/homebrew-tap")
    if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
      await $`cd ./dist/homebrew-tap && git commit -m "Update ${releaseName} to v${version}"`
      await $`cd ./dist/homebrew-tap && git push`
    }
  }
}

function* findPlatformPackages(
  dist: string,
  pkgName: string,
  root = dist,
): Generator<{ dir: string; json: Record<string, unknown> & { name: string; version: unknown } }> {
  const packageRoot = path.resolve(root, pkgName)
  const packageParent = path.dirname(packageRoot)
  const packagePrefix = `${path.basename(packageRoot)}-`
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const packageDir = path.join(dist, entry.name)
    const platformDir = path.resolve(dist) === packageParent && entry.name.startsWith(packagePrefix)
    const packageJsonPath = path.join(packageDir, "package.json")
    if (platformDir && !fs.existsSync(packageJsonPath)) {
      throw new Error(`Platform package directory is missing package.json: ${packageDir}`)
    }
    if (fs.existsSync(packageJsonPath)) {
      const json: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Error(`Platform package manifest must be an object: ${packageJsonPath}`)
      }
      const manifest = json as Record<string, unknown>
      const name = manifest.name
      if (typeof name === "string" && name.startsWith(`${pkgName}-`)) {
        if (path.resolve(packageDir) !== path.resolve(root, name)) {
          throw new Error(`Platform package directory does not match manifest name: ${packageDir}`)
        }
        yield {
          dir: packageDir,
          json: { ...manifest, name, version: manifest.version },
        }
        continue
      }
      if (platformDir) throw new Error(`Platform package manifest has an invalid name: ${packageJsonPath}`)
    }

    yield* findPlatformPackages(packageDir, pkgName, root)
  }
}
