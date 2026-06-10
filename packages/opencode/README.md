# Chimera agent package

This package is the complete Chimera agent runtime: the opencode-derived agent plus the built-in Chimera graph and propagation-audit runtime. The npm package name is `chimera`; the only public CLI command is `chimera`.

To install from npm once published:

```bash
npm install -g chimera
chimera
```

Graph/runtime commands are available under the agent command:

```bash
chimera graph status
chimera --graph status
```

Do not publish or document `opencode` or `codegraph` as public bins for this package.

## Development

Install development dependencies from the `chimera/` workspace root:

```bash
bun install
```

Run the agent from this package directory:

```bash
bun run --conditions=browser src/index.ts
```

Typecheck from this package directory:

```bash
bun typecheck
```

## Build And Package

Build the current platform binary package from this package directory:

```bash
bun run build --single --skip-install --skip-embed-web-ui
```

Create local npm tarballs for the main `chimera` package and the current platform package:

```bash
bun run pack:local
```

The tarballs are written under:

```text
dist/npm-tarballs/
```

Install the locally built package into a temporary npm prefix:

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" dist/npm-tarballs/chimera-*.tgz
"$prefix/bin/chimera" --version
"$prefix/bin/chimera" --graph --help
```

Smoke-test the installed graph runtime from a temporary TypeScript project:

```bash
project="$(mktemp -d)"
printf 'export function add(a: number, b: number) { return a + b }\n' > "$project/add.ts"
"$prefix/bin/chimera" graph init "$project"
"$prefix/bin/chimera" graph status "$project"
"$prefix/bin/chimera" graph query add --path "$project"
```

The generated main tarball has `package.json.name === "chimera"` and exposes only the `chimera` bin. The platform tarball is named `chimera-<os>-<arch>` and contains the compiled `bin/chimera` binary plus graph runtime assets.
