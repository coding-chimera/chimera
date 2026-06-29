# WebUI Chimera Adaptation Plan

## Goal

Bring the Chimera WebUI in line with the Chimera runtime identity and expose in-process CodeGraph capabilities to the WebUI without shelling out to `chimera graph`.

## Scope

1. Stop production WebUI from silently falling back to upstream opencode assets.
2. Replace user-visible upstream opencode branding, links, config-file guidance, and storage keys where they affect Chimera users.
3. Add Chimera-named SDK aliases and request headers while preserving legacy compatibility.
4. Expose read-only CodeGraph status/search/file-symbol/file-list/impact endpoints through the Chimera server process.
5. Wire basic WebUI data access to the new graph endpoints so future UI surfaces can reuse the same client path.
6. Validate with focused tests/typechecks from package directories.

## Non-goals

- Rename all internal `@opencode-ai/*` workspace packages in this pass.
- Remove every legacy `OPENCODE_*` environment variable in this pass.
- Remove legacy `x-opencode-*` headers immediately.
- Add a full graph explorer UI beyond basic client/query integration.

## Phases

### Phase 1: Embedded WebUI and upstream boundary

- Make the embedded WebUI generated entrypoint and runtime import agree on `chimera-web-ui.gen.ts`.
- Replace or disable upstream `https://app.opencode.ai` fallback for Chimera builds.
- Revisit CORS defaults so upstream opencode origins are not implicitly trusted unless explicitly configured.

### Phase 2: User-visible WebUI identity

- Update browser/PWA metadata from OpenCode to Chimera.
- Replace generic OpenCode product copy in WebUI i18n with Chimera.
- Update config guidance from `opencode.json` to `chimera.json` / `chimera.jsonc`.
- Replace upstream help/changelog URLs with a local/disabled Chimera-safe behavior if no Chimera-hosted endpoint is available.

### Phase 3: Client compatibility shims

- Add `createChimeraClient`, `ChimeraClient`, and `ChimeraClientConfig` SDK aliases.
- Prefer `x-chimera-directory` and `x-chimera-workspace` headers from the WebUI SDK path.
- Continue accepting legacy `x-opencode-*` headers on the server.
- Add `chimera.*` browser storage/theme keys with migration from existing `opencode.*` keys.

### Phase 4: In-process Graph HTTP API

- Add an Effect HttpApi `graph` group and handlers.
- Keep legacy Hono route parity where applicable.
- Implement read-only endpoints that do not initialize, migrate, or create graph data:
  - `GET /graph/status`
  - `GET /graph/search`
  - `GET /graph/file/symbols`
  - `GET /graph/files`
  - `GET /graph/impact`
- Use `Chimera.openProjectGraph` / `CodeGraphAdapter` directly in-process.
- Surface uninitialized/data-root/job status as structured JSON.
- Do not spawn `chimera graph` CLI from HTTP handlers.

### Phase 5: WebUI graph data access

- Regenerate the JS SDK after route additions.
- Add graph query helpers to the WebUI global sync/client layer.
- Keep graph state per directory using existing SDK directory routing.
- Consume existing graph SSE events for invalidation/toast behavior.

### Phase 6: Verification

- Run focused unit tests for touched SDK/server/app areas where available.
- Run `bun typecheck` from relevant package directories.
- Run Chimera propagation audit after mutations.
- Document any skipped or blocked checks.

## Completion checklist

- [x] Plan document committed to working tree.
- [x] Embedded UI import/build mismatch fixed.
- [x] Upstream fallback/CORS behavior made Chimera-safe.
- [x] Visible WebUI branding/config/link issues fixed.
- [x] SDK/header aliases added with legacy compatibility.
- [x] Storage/theme key migration added.
- [x] Graph HttpApi and legacy route parity added.
- [x] SDK regenerated.
- [x] WebUI graph query helpers added.
- [x] Focused tests/typechecks run from package directories.

## Verification performed

- `packages/chimera`: `bun typecheck`
- `packages/chimera`: `bun test --timeout 30000 test/server/httpapi-ui.test.ts`
- `packages/app`: `bun typecheck`
- `packages/app`: `bun test --timeout 30000 src/utils/persist.test.ts src/theme-preload.test.ts`
- `packages/sdk/js`: `bun typecheck`
- `packages/ui`: `bun typecheck`
- `chimera/`: `./packages/sdk/js/script/build.ts`
