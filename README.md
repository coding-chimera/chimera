# Chimera

[English](README.md) | [简体中文](README.zh.md)

Chimera is an AI coding agent distribution: an opencode-derived interactive CLI plus the built-in Chimera/CodeGraph graph and propagation-audit runtime.

The public package and command name is `chimera`. Graph/runtime commands are part of the same CLI; there are no public `opencode` or `codegraph` bins for this distribution.

## Package identity

- Complete agent package source: [`packages/chimera`](packages/chimera)
- npm package name: `chimera`
- public CLI command: `chimera`
- graph command entry points: `chimera graph ...` and `chimera --graph ...`

When this repository refers to the original project, it uses **upstream opencode** or **original opencode** explicitly.

## Install and run

Install the published package when available:

```bash
npm install -g chimera
chimera
```

Inside the CLI, use `/help` for interactive help.

For local development builds, see [Build and package](#build-and-package).

## Graph runtime

Chimera includes project graph indexing, symbol search, impact discovery, and propagation-audit workflows.

Common commands:

```bash
chimera graph status
chimera graph init <project>
chimera graph query <symbol> --path <project>
chimera --graph status
```

Project-local graph data belongs under `.chimera/`. Legacy `.codegraph/` data is compatibility-only; migrate it explicitly with Chimera graph migration commands instead of moving or deleting it manually.

Read-only graph surfaces such as status and query should report the current data-root state without creating graph data.

## Development

This repository uses Bun. Install dependencies from the `chimera/` workspace root:

```bash
bun install
```

Run the agent from the package directory:

```bash
cd packages/chimera
bun run --conditions=browser src/index.ts
```

Typecheck and test from package directories, not from the repository root:

```bash
cd packages/chimera
bun typecheck
bun test --timeout 30000
```

The root `test` script intentionally blocks root-level test runs.

## Build and package

Build the current-platform package from `packages/chimera`:

```bash
bun run build --single --skip-install --skip-embed-web-ui
```

Create local npm tarballs for the main package and current platform package:

```bash
bun run pack:local
```

Tarballs are written to:

```text
dist/npm-tarballs/
```

A locally packed install can be smoke-tested with a temporary npm prefix:

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" dist/npm-tarballs/chimera-*.tgz
"$prefix/bin/chimera" --version
"$prefix/bin/chimera" --graph --help
```

## Repository layout

- `packages/chimera` - complete Chimera agent package and CLI runtime
- `packages/app` - web application
- `packages/console/app` - console UI assets and app
- `packages/desktop` - desktop application
- `packages/sdk/js` - JavaScript SDK package
- `packages/docs` - documentation package

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.

When changing agent-facing tools, prompts, graph commands, installer behavior, or package identity, update the corresponding user-facing and agent-facing guidance in the same change.

## License

MIT
