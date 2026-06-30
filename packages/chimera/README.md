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

Build the default current-platform no-WebUI package from this package directory:

```bash
bun run build --single --skip-install
```

The default package intentionally does not embed the GPL-licensed NewWeb/OpenCodeUI-derived assets. To also build a clearly separated with-WebUI variant for release assets, run a second build and preserve the first variant's npm tarballs:

```bash
bun run build --single --skip-install --with-webui --preserve-npm-tarballs
```

The tarballs are written under:

```text
dist/npm-tarballs/
```

The no-WebUI tarballs are named like `chimera-no-webui-<version>.tgz` and `chimera-darwin-arm64-no-webui-<version>.tgz`. The with-WebUI tarballs use `with-webui` in the same position.

Install one locally built variant into a temporary npm prefix:

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" dist/npm-tarballs/chimera-darwin-arm64-no-webui-*.tgz dist/npm-tarballs/chimera-no-webui-*.tgz
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

The generated main tarball has `package.json.name === "chimera"` and exposes only the `chimera` bin. The platform tarball is named `chimera-<os>-<arch>` internally and contains the compiled `bin/chimera` binary plus graph runtime assets; the tarball filename carries the packaging variant.

## Platform verification help wanted

The current maintainer has not yet verified the full Linux and Windows build,
pack, and install matrix. Linux and Windows users are encouraged to try the
commands above on their own machines. If you hit a platform-specific problem,
please report it to the maintainer with the OS, architecture, command output,
and any relevant logs. Fixes or pull requests are especially welcome if you are
able to investigate and patch the issue locally.
