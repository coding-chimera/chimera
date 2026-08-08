import { describe, expect, test } from "bun:test"
import { isExactVersion, nextPatchVersion, resolveExplicitVersion, resolveVersion } from "../../script/version"

describe("script.version", () => {
  test("increments Chimera patch labels by default", () => {
    expect(nextPatchVersion("0.0.2-patch5")).toBe("0.0.2-patch6")
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: {} })).toBe("0.0.2-patch6")
  })

  test("starts patch labels after a clean base version", () => {
    expect(nextPatchVersion("0.0.2")).toBe("0.0.2-patch1")
    expect(resolveVersion({ currentVersion: "0.0.2", env: {} })).toBe("0.0.2-patch1")
  })

  test("honors explicit versions", () => {
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", argv: ["bun", "build", "--version=1.2.3"], env: {} })).toBe(
      "1.2.3",
    )
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", argv: ["bun", "build", "--version", "1.2.4"], env: {} })).toBe(
      "1.2.4",
    )
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", argv: ["bun", "build", "--version", "1.0.0"], env: {} })).toBe(
      "1.0.0",
    )
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: { CHIMERA_VERSION: "2.0.0" } })).toBe("2.0.0")
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: { OPENCODE_VERSION: "3.0.0" } })).toBe("3.0.0")
  })


  test("requires and resolves an explicit publish target version", () => {
    expect(resolveExplicitVersion({ argv: ["bun", "publish", "--version=1.2.3"], env: {} })).toBe("1.2.3")
    expect(resolveExplicitVersion({ argv: ["bun", "publish", "--version", "1.2.4"], env: {} })).toBe("1.2.4")
    expect(resolveExplicitVersion({ argv: [], env: { CHIMERA_VERSION: "2.0.0" } })).toBe("2.0.0")
    expect(resolveExplicitVersion({ argv: [], env: { OPENCODE_VERSION: "3.0.0" } })).toBe("3.0.0")
    expect(() => resolveExplicitVersion({ argv: [], env: {} })).toThrow("An explicit target version is required")
    expect(() => resolveExplicitVersion({ argv: ["bun", "publish", "--version=latest"], env: {} })).toThrow(
      "Explicit version must be an exact npm version",
    )
  })

  test("accepts only canonical exact npm versions", () => {
    expect(isExactVersion("0.0.7-beta7")).toBe(true)
    expect(isExactVersion("1.2.3-beta.7+build.1")).toBe(true)
    for (const value of ["v1.2.3", "01.2.3", "1.2.3-01", "1.2.3-foo..bar", "latest", ""]) {
      expect(isExactVersion(value)).toBe(false)
      expect(() => resolveExplicitVersion({ argv: ["bun", "publish", `--version=${value}`], env: {} })).toThrow(
        "Explicit version must be an exact npm version",
      )
    }
  })

  test("honors explicit bump kinds", () => {
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: { CHIMERA_BUMP: "patch" } })).toBe("0.0.2-patch6")
    expect(resolveVersion({ currentVersion: "1.0.0", env: { CHIMERA_BUMP: "patch" } })).toBe("1.0.0-patch1")
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: { CHIMERA_BUMP: "minor" } })).toBe("0.1.0")
    expect(resolveVersion({ currentVersion: "0.0.2-patch5", env: { CHIMERA_BUMP: "major" } })).toBe("1.0.0")
  })
})
