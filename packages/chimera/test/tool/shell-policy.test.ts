import { describe, expect, test } from "bun:test"
import { Language, Parser, type Node } from "web-tree-sitter"
import { fileURLToPath } from "url"

import { ShellPolicy } from "../../src/tool/shell/policy"
import { AstraToolPolicyViolation } from "../../src/session/policy"
import type { InstanceContext } from "../../src/project/instance-context"

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const parsers = (async () => {
  const treeWasm = (await import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })).default
  await Parser.init({
    locateFile() {
      return resolveWasm(treeWasm)
    },
  })
  const bashWasm = (await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, { with: { type: "wasm" } }))
    .default
  const bash = new Parser()
  bash.setLanguage(await Language.load(resolveWasm(bashWasm)))
  return bash
})()

const instance: InstanceContext = {
  directory: "/repo",
  worktree: "/repo",
  project: {} as InstanceContext["project"],
}

async function parse(command: string) {
  const parser = await parsers
  const tree = parser.parse(command)
  if (!tree) throw new Error("failed to parse")
  return tree.rootNode
}

async function classify(command: string) {
  return ShellPolicy.classify({ root: await parse(command), cwd: "/repo", instance })
}

const blocked: Array<[string, ShellPolicy.Category]> = [
  ["cat src/index.ts", "read"],
  ["head -n 20 src/index.ts", "read"],
  ["tail -f src/index.ts", "read"],
  ["less src/index.ts", "read"],
  ["more src/index.ts", "read"],
  ["grep -n foo src/index.ts", "read"],
  ["rg foo src", "read"],
  ["sed -n '1,20p' src/index.ts", "read"],
  ["awk '{print $1}' src/index.ts", "read"],
  ["cat $FILE", "read"],
  ["sed -i 's/a/b/' src/index.ts", "mutate"],
  ["perl -pi -e 's/a/b/' src/index.ts", "mutate"],
  ["tee src/index.ts", "mutate"],
  ["echo hi > src/index.ts", "mutate"],
  ["echo hi >> $OUT", "mutate"],
  ["dd if=src/index.ts of=/tmp/out", "mutate"],
  ["truncate -s 0 src/index.ts", "mutate"],
  ["cp src/a.ts src/b.ts", "mutate"],
  ["mv src/a.ts src/b.ts", "mutate"],
  ["rm -rf src/index.ts", "mutate"],
  ["touch src/index.ts", "mutate"],
  ["chmod +x src/index.ts", "mutate"],
  ["patch -p1 < changes.diff", "mutate"],
  ["rm $FILE", "mutate"],
  ["python3 -c 'print(1)'", "eval"],
  ["python3 - <<'PY'\nprint(1)\nPY", "eval"],
  ["python3 -", "eval"],
  ["node -e 'process.stdout.write(1)'", "eval"],
  ["bun -e 'console.log(1)'", "eval"],
  ["bash -c 'rm src/a.ts'", "eval"],
  ["sh -lc 'cat src/a.ts'", "eval"],
  ["perl -e 'print 1'", "eval"],
  ["ruby -e 'puts 1'", "eval"],
  ["php -r 'echo 1;'", "eval"],
  ["eval \"$CMD\"", "eval"],
  ["source ./script.sh", "eval"],
  ["find . -name '*.ts' -exec cat {} \\;", "eval"],
  ["git checkout -- src/index.ts", "mutate"],
  ["git apply changes.patch", "mutate"],
  ["$(echo cat) src/index.ts", "eval"],
]

const allowed = [
  "git status",
  "git diff --stat",
  "git checkout main",
  "git log --oneline -5",
  "bun test",
  "npm test",
  "cargo test",
  "pytest -q",
  "python -m pytest tests",
  "ls -la",
  "find . -name '*.ts'",
  "echo hello",
  "cat /tmp/outside.txt",
  "sed -n '1,2p' /tmp/outside.txt",
  "head -n 20 /tmp/outside.txt",
  "tail -n 5 /tmp/outside.txt",
  "git diff --no-index /tmp/a /tmp/b",
  "grep foo",
]

describe("tool.shell policy", () => {
  for (const [command, category] of blocked) {
    test(`blocks ${command}`, async () => {
      const violation = await classify(command)
      expect(AstraToolPolicyViolation.is(violation)).toBe(true)
      expect(violation?.message).toContain(category)
      expect(violation?.message).not.toContain(command)
    })
  }

  for (const command of allowed) {
    test(`allows ${command}`, async () => {
      expect(await classify(command)).toBeUndefined()
    })
  }

  test("detects the Astra model family", () => {
    expect(ShellPolicy.isAstraModel({ api: { id: "gpt-6-astra" } })).toBe(true)
    expect(ShellPolicy.isAstraModel({ api: { id: "gpt-6.0-astra" } })).toBe(true)
    expect(ShellPolicy.isAstraModel({ api: { id: "gpt-5.5" } })).toBe(false)
    expect(ShellPolicy.isAstraModel(undefined)).toBe(false)
  })
})