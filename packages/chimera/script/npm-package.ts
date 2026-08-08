import pkg from "../package.json"
import workspace from "../../../package.json"
import { packageLicense, packageLicenseFiles, type PackageVariant } from "./package-variant"

const runtimeDependencyNames = ["playwright-core", "chromium-bidi"] as const
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function runtimeDependencies() {
  return Object.fromEntries(
    runtimeDependencyNames.map((name) => {
      if (pkg.dependencies[name] !== "catalog:") {
        throw new Error(`${name} must use catalog: in packages/chimera/package.json`)
      }
      const version = workspace.workspaces.catalog[name]
      if (!exactVersion.test(version)) {
        throw new Error(`${name} must have an exact version in the workspace catalog`)
      }
      return [name, version]
    }),
  )
}

export function createNpmPackageManifest(input: {
  version: string
  variant: PackageVariant
  platformPackages: Record<string, string>
}) {
  return {
    name: pkg.name,
    version: input.version,
    type: "module",
    license: packageLicense(input.variant),
    files: ["bin", "postinstall.mjs", "README.md", ...packageLicenseFiles(input.variant)],
    bin: pkg.bin,
    scripts: {
      postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
    },
    dependencies: runtimeDependencies(),
    optionalDependencies: input.platformPackages,
  }
}
