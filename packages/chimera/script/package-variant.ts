import { transformAsync, types, type PluginObj } from "@babel/core"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { isExactVersion } from "./version"

export type PackageVariant = "no-webui" | "with-webui"

export type NpmPlatformTarget = {
  os: "linux" | "darwin" | "win32"
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export const npmPlatformTargets: readonly NpmPlatformTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export type PackageVariantMetadata = {
  variant: PackageVariant
  version: string
  embedLegacyWebUi: boolean
  embedNewWebUi: boolean
  expectedPlatformPackages: string[]
}

export type PlatformPackageVersion = {
  name: unknown
  version: unknown
}

const metadataKeys = [
  "variant",
  "version",
  "embedLegacyWebUi",
  "embedNewWebUi",
  "expectedPlatformPackages",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function duplicateNames(names: readonly string[]) {
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
}

function setDifferences(expected: readonly string[], actual: readonly string[]) {
  return {
    missing: expected.filter((name) => !actual.includes(name)),
    extra: actual.filter((name) => !expected.includes(name)),
  }
}

function assertExactSet(label: string, expected: readonly string[], actual: readonly string[]) {
  const differences = setDifferences(expected, actual)
  if (differences.missing.length === 0 && differences.extra.length === 0) return
  const details = [
    differences.missing.length > 0 ? `missing: ${differences.missing.join(", ")}` : undefined,
    differences.extra.length > 0 ? `extra: ${differences.extra.join(", ")}` : undefined,
  ].filter((detail): detail is string => detail !== undefined)
  throw new Error(`${label} mismatch (${details.join("; ")})`)
}

function assertExactNames(label: string, expected: readonly string[], actual: readonly string[]) {
  assertExactSet(label, expected, actual)
  if (expected.every((name, index) => actual[index] === name)) return
  throw new Error(`${label} mismatch (order does not match the canonical platform order)`)
}

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

export function platformPackageName(packageName: string, target: NpmPlatformTarget) {
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

export function platformPackageNames(
  packageName: string,
  targets: readonly NpmPlatformTarget[] = npmPlatformTargets,
) {
  return targets.map((target) => platformPackageName(packageName, target))
}

export function createPlatformPackageManifest(input: {
  name: string
  version: string
  target: NpmPlatformTarget
  variant: PackageVariant
}) {
  return {
    name: input.name,
    version: input.version,
    os: [input.target.os],
    cpu: [input.target.arch],
    ...(input.target.os === "linux" ? { libc: [input.target.abi ?? "glibc"] } : {}),
    license: packageLicense(input.variant),
    files: ["bin", ...packageLicenseFiles(input.variant)],
  }
}

function relocatableCommonJsGlobalsPlugin(): PluginObj {
  return {
    name: "chimera-relocatable-commonjs-globals",
    visitor: {
      ReferencedIdentifier(reference) {
        const name = reference.node.name
        if ((name !== "__dirname" && name !== "__filename") || reference.scope.hasBinding(name)) return
        reference.replaceWith(
          types.memberExpression(
            types.metaProperty(types.identifier("import"), types.identifier("meta")),
            types.identifier(name === "__dirname" ? "dirname" : "filename"),
          ),
        )
      },
    },
  }
}

export async function transformCommonJsPathGlobals(input: { source: string; filename: string }) {
  if (!input.source.includes("__dirname") && !input.source.includes("__filename")) return input.source
  const transformed = await transformAsync(input.source, {
    babelrc: false,
    configFile: false,
    filename: input.filename,
    sourceType: "unambiguous",
    sourceMaps: false,
    plugins: [relocatableCommonJsGlobalsPlugin],
  })
  if (!transformed?.code) throw new Error(`Failed to transform CommonJS path globals in ${input.filename}`)
  return transformed.code
}

function minimalBuildRoots(roots: readonly string[]) {
  const resolved = [...new Set(roots.filter((root) => root.length > 0).map((root) => path.resolve(root)))]
    .filter((root) => root !== path.parse(root).root)
    .sort((a, b) => a.length - b.length)
  return resolved.filter(
    (root, index) => !resolved.some((parent, parentIndex) => parentIndex < index && root.startsWith(parent + path.sep)),
  )
}

export function assertNoEmbeddedBuildPaths(input: {
  artifactPath: string
  bytes: Uint8Array
  roots: readonly string[]
}) {
  const bytes = Buffer.from(input.bytes)
  for (const root of minimalBuildRoots(input.roots)) {
    const forms = [
      root,
      root.replaceAll("\\", "/"),
      root.replaceAll("/", "\\"),
      pathToFileURL(root).href,
    ]
    for (const value of new Set(forms)) {
      for (const encoding of ["utf8", "utf16le"] as const) {
        const offset = bytes.indexOf(Buffer.from(value, encoding))
        if (offset === -1) continue
        throw new Error(
          `${input.artifactPath} contains an absolute build path at byte ${offset} (${encoding}): ${value}`,
        )
      }
    }
  }
}

export function parsePackageVariantMetadata(value: unknown, packageName: string): PackageVariantMetadata {
  if (!isRecord(value)) throw new Error("Package variant metadata must be an object")
  assertExactNames("Package variant metadata fields", [...metadataKeys].sort(), Object.keys(value).sort())
  if (typeof value.variant !== "string") throw new Error("Package variant metadata variant must be a string")
  if (typeof value.version !== "string" || !isExactVersion(value.version)) {
    throw new Error("Package variant metadata version must be an exact npm version")
  }
  if (typeof value.embedLegacyWebUi !== "boolean" || typeof value.embedNewWebUi !== "boolean") {
    throw new Error("Package variant metadata embed flags must be booleans")
  }
  if (!Array.isArray(value.expectedPlatformPackages) || value.expectedPlatformPackages.length === 0) {
    throw new Error("Package variant metadata expectedPlatformPackages must be a non-empty array")
  }
  if (value.expectedPlatformPackages.some((name) => typeof name !== "string")) {
    throw new Error("Package variant metadata expectedPlatformPackages must contain only strings")
  }

  const variant = parsePackageVariant(value.variant)
  const expectedPlatformPackages = value.expectedPlatformPackages as string[]
  const duplicates = duplicateNames(expectedPlatformPackages)
  if (duplicates.length > 0) {
    throw new Error(`Package variant metadata contains duplicate platform packages: ${duplicates.join(", ")}`)
  }
  const supported = platformPackageNames(packageName)
  const unsupported = expectedPlatformPackages.filter((name) => !supported.includes(name))
  if (unsupported.length > 0) {
    throw new Error(`Package variant metadata contains unsupported platform packages: ${unsupported.join(", ")}`)
  }
  assertExactNames(
    "Package variant metadata platform order",
    supported.filter((name) => expectedPlatformPackages.includes(name)),
    expectedPlatformPackages,
  )
  if (variant === "with-webui" && !value.embedNewWebUi) {
    throw new Error("with-webui package metadata requires embedNewWebUi=true")
  }
  if (variant === "no-webui" && (value.embedLegacyWebUi || value.embedNewWebUi)) {
    throw new Error("no-webui package metadata cannot claim embedded WebUI assets")
  }

  return {
    variant,
    version: value.version,
    embedLegacyWebUi: value.embedLegacyWebUi,
    embedNewWebUi: value.embedNewWebUi,
    expectedPlatformPackages: [...expectedPlatformPackages],
  }
}

export function validatePlatformPackageSet(input: {
  metadata: PackageVariantMetadata
  packages: readonly PlatformPackageVersion[]
  requiredPlatformPackages?: readonly string[]
  requiredVersion?: string
}) {
  if (input.requiredVersion && input.metadata.version !== input.requiredVersion) {
    throw new Error(
      `Build metadata version ${input.metadata.version} does not match required version ${input.requiredVersion}`,
    )
  }
  if (input.requiredPlatformPackages) {
    const duplicates = duplicateNames(input.requiredPlatformPackages)
    if (duplicates.length > 0) throw new Error(`Required platform matrix contains duplicates: ${duplicates.join(", ")}`)
    assertExactNames(
      "Package variant metadata platform matrix",
      input.requiredPlatformPackages,
      input.metadata.expectedPlatformPackages,
    )
  }

  const packages = input.packages.map((item, index) => {
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new Error(`Discovered platform package ${index + 1} has an invalid name`)
    }
    if (typeof item.version !== "string" || item.version.length === 0) {
      throw new Error(`Discovered platform package ${item.name} has an invalid version`)
    }
    return { name: item.name, version: item.version }
  })
  const duplicates = duplicateNames(packages.map((item) => item.name))
  if (duplicates.length > 0) throw new Error(`Discovered duplicate platform packages: ${duplicates.join(", ")}`)
  assertExactSet(
    "Discovered platform package set",
    input.metadata.expectedPlatformPackages,
    packages.map((item) => item.name),
  )

  const wrongVersions = packages.filter((item) => item.version !== input.metadata.version)
  if (wrongVersions.length > 0) {
    throw new Error(
      `Discovered platform package versions must equal ${input.metadata.version}: ${wrongVersions
        .map((item) => `${item.name}@${item.version}`)
        .join(", ")}`,
    )
  }
  return Object.fromEntries(input.metadata.expectedPlatformPackages.map((name) => [name, input.metadata.version]))
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
