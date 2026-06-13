function explicitArgVersion(argv = process.argv) {
  const inline = argv.find((arg) => arg.startsWith("--version="))
  if (inline) return inline.slice("--version=".length)

  const index = argv.indexOf("--version")
  if (index >= 0) return argv[index + 1]
}

function semverParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) throw new Error(`Cannot derive next version from ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function nextPatchVersion(version: string) {
  const patchLabel = /^(.*-patch)(\d+)$/.exec(version)
  if (patchLabel) return `${patchLabel[1]}${Number(patchLabel[2]) + 1}`

  semverParts(version)
  return `${version}-patch1`
}

export function resolveVersion(input: { currentVersion: string; argv?: string[]; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env
  const explicit = explicitArgVersion(input.argv) ?? env.CHIMERA_VERSION ?? env.OPENCODE_VERSION
  if (explicit) return explicit

  const bump = (env.CHIMERA_BUMP ?? env.OPENCODE_BUMP)?.toLowerCase()
  if (!bump || bump === "patch") return nextPatchVersion(input.currentVersion)

  const parsed = semverParts(input.currentVersion)
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`
  if (bump === "major") return `${parsed.major + 1}.0.0`

  throw new Error(`Unsupported version bump: ${bump}`)
}
