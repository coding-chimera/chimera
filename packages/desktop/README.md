# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## TODO: Windows CLI sidecar cleanup

The desktop package still has stale Windows CLI sidecar references from the
pre-rename `opencode-cli` flow. Keep these references in place until someone can
validate the packaged Windows app on a Windows machine:

- `scripts/utils.ts` still defines `SIDECAR_BINARIES` with `opencode-*` artifact
  names and `copyBinaryToSidecarFolder()` copies to `resources/opencode-cli(.exe)`.
- `.github/workflows/publish.yml` still has an optional signature check for
  `resources/opencode-cli.exe`; it uses `-ErrorAction SilentlyContinue`, so the
  missing file is non-blocking today.
- The current desktop sidecar path appears to be the Electron
  `utilityProcess.fork(sidecar.js)` flow using `virtual:opencode-server`, not the
  external `resources/opencode-cli.exe` binary.

Follow-up for Windows validation:

1. Build/package the Windows desktop app and check whether
   `resources/opencode-cli.exe` is still produced or used.
2. If it is unused, remove the stale sidecar helper, ignore entry, and optional
   signature check.
3. If it is still used, rename the resource and related artifact/signing paths to
   the Chimera naming (`chimera.exe` or `chimera-cli.exe`) and verify app startup,
   sidecar health checks, installer behavior, and Windows signatures.
