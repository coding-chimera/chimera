import fs from "fs/promises"
import path from "path"

export type PackageVariant = "no-webui" | "with-webui"

export function parsePackageVariant(value: string): PackageVariant {
  if (value === "no-webui" || value === "with-webui") return value
  throw new Error(`Invalid package variant: ${value}`)
}

export function packageLicense(variant: PackageVariant) {
  return variant === "with-webui" ? "GPL-3.0-only" : "MIT"
}

export function packageLicenseFiles(variant: PackageVariant) {
  return variant === "with-webui" ? ["LICENSE", "LICENSE-MIT", "NOTICE"] : ["LICENSE"]
}

export function platformPackageName(
  packageName: string,
  target: { os: string; arch: string; avx2?: false; abi?: string },
) {
  return [
    packageName,
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter(Boolean)
    .join("-")
}

export function tarballNameForVariant(file: string, variant: PackageVariant) {
  return file.replace(/-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz)$/, `-${variant}-$1`)
}

export async function writePackageLicenseFiles(input: {
  packageDir: string
  variant: PackageVariant
  projectDir: string
}) {
  await fs.copyFile(
    input.variant === "with-webui"
      ? path.join(input.projectDir, "..", "newweb", "LICENSE")
      : path.join(input.projectDir, "..", "..", "LICENSE"),
    path.join(input.packageDir, "LICENSE"),
  )
  if (input.variant === "no-webui") {
    await Promise.all([
      fs.rm(path.join(input.packageDir, "LICENSE-MIT"), { force: true }),
      fs.rm(path.join(input.packageDir, "NOTICE"), { force: true }),
    ])
    return
  }
  await Promise.all([
    fs.copyFile(path.join(input.projectDir, "..", "..", "LICENSE"), path.join(input.packageDir, "LICENSE-MIT")),
    fs.copyFile(path.join(input.projectDir, "NOTICE"), path.join(input.packageDir, "NOTICE")),
  ])
}
