import { describe, expect, test } from "bun:test"
import pkg from "../../package.json"
import { createNpmPackageManifest } from "../../script/npm-package"
import workspace from "../../../../package.json"
import { parsePackageVariantMetadata, platformPackageNames, validatePlatformPackageSet } from "../../script/package-variant"

const platformPackages = {
  "@coding-chimera/chimera-darwin-arm64": "1.2.3",
}

describe("script.npm-package", () => {
  test("materializes browser runtime dependencies from the workspace catalog", () => {
    const manifest = createNpmPackageManifest({ version: "1.2.3", variant: "no-webui", platformPackages })

    expect(pkg.dependencies["playwright-core"]).toBe("catalog:")
    expect(pkg.dependencies["chromium-bidi"]).toBe("catalog:")
    expect(manifest.dependencies).toEqual({
      "playwright-core": workspace.workspaces.catalog["playwright-core"],
      "chromium-bidi": workspace.workspaces.catalog["chromium-bidi"],
    })
    expect(manifest.dependencies["playwright-core"]).toBe("1.59.1")
    expect(manifest.dependencies["chromium-bidi"]).toBe("12.0.0")
    expect(manifest.license).toBe("MIT")
  })

  test("keeps platform packages optional and preserves the main package contract", () => {
    const manifest = createNpmPackageManifest({ version: "1.2.3", variant: "with-webui", platformPackages })

    expect(manifest.name).toBe("@coding-chimera/chimera")
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.type).toBe("module")
    expect(manifest.license).toBe("GPL-3.0-only")
    expect(manifest.bin).toEqual({ chimera: "./bin/chimera" })
    expect(manifest.scripts).toEqual({ postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs" })
    expect(manifest.files).toEqual(["bin", "postinstall.mjs", "README.md", "LICENSE", "LICENSE-MIT", "NOTICE"])
    expect(manifest.optionalDependencies).toEqual(platformPackages)
    expect(manifest.dependencies).not.toHaveProperty("@coding-chimera/chimera-darwin-arm64")
    expect(manifest.optionalDependencies).not.toHaveProperty("playwright-core")
    expect(manifest.optionalDependencies).not.toHaveProperty("chromium-bidi")
  })


  test("uses the validated ordered exact-12 platform map for a publish manifest", () => {
    const expectedPlatformPackages = platformPackageNames(pkg.name)
    const metadata = parsePackageVariantMetadata(
      {
        variant: "no-webui",
        version: "1.2.3",
        embedLegacyWebUi: false,
        embedNewWebUi: false,
        expectedPlatformPackages,
      },
      pkg.name,
    )
    const exactPlatforms = validatePlatformPackageSet({
      metadata,
      packages: expectedPlatformPackages.toReversed().map((name) => ({ name, version: "1.2.3" })),
      requiredPlatformPackages: expectedPlatformPackages,
      requiredVersion: "1.2.3",
    })
    const manifest = createNpmPackageManifest({
      version: "1.2.3",
      variant: "no-webui",
      platformPackages: exactPlatforms,
    })

    expect(Object.keys(manifest.optionalDependencies)).toEqual(expectedPlatformPackages)
    expect(Object.values(manifest.optionalDependencies)).toEqual(Array(12).fill("1.2.3"))
  })
})
