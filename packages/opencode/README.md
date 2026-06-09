# Coding Chimera agent package

This package is the complete Coding Chimera agent runtime. The public npm package name is `coding-chimera`; the only public CLI command is `chimera`.

To install from npm:

```bash
npm install -g coding-chimera
chimera
```

Graph/runtime commands are available under the agent command:

```bash
chimera graph status
chimera --graph status
```

Do not publish or document `opencode` or `codegraph` as public bins for this package.

To install development dependencies:

```bash
bun install
```

To run locally:

```bash
bun run --conditions=browser src/index.ts
```
