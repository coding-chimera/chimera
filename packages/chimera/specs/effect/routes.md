# Route topology and effectification

Practical reference for route work in `packages/chimera`.

## Topology

Effect `HttpApi` is the default route topology. Hono is an explicit fallback for routes that have not completed migration; it is an intentional compatibility boundary, not the default implementation path.

- Add and migrate routes in Effect `HttpApi` by default.
- Keep fallback-only behavior isolated in the Hono tree.
- Do not describe Hono as retired until the final Hono tree is deleted and fallback routing is removed.

## Handler rules

- Compose service-heavy handlers as one Effect program rather than making repeated `runPromise(...)` calls.
- Yield services from context instead of calling Promise facades repeatedly.
- Use `Effect.all(..., { concurrency: "unbounded" })` for independent service calls.
- Preserve streaming and event-publication semantics while removing Promise bridges; migration is not complete merely because a route is reachable through `HttpApi`.

## Migration status

Completed:

- [x] Remove legacy route ambient reads of `Instance.current`, `Instance.directory`, `Instance.project`, and `Instance.worktree`.
- [x] Implement file `/find` and `/find/symbol` on the current route/service path.
- [x] Route global disposal through `InstanceStore` instead of legacy global `Instance` disposal.

Remaining:

- [ ] Migrate session streaming and `prompt_async` off the remaining `runRequest(...)` and direct `Bus.publish(...)` bridges while preserving stream and event behavior.
Instance-context boundary retirement (`WithInstance` and the remaining ALS fallback) is tracked in `loose-ends.md` and `instance-context.md`.
- [ ] Delete the final Hono route tree after every fallback route and compatibility consumer has migrated.
- [ ] Retire Hono fallback routing only after the Hono tree is gone and the compatibility boundary is no longer needed.

## Tracking note

The former per-file checklist was intentionally superseded because it described the old Hono-oriented layout and mixed completed work with stale implementation guesses. Track the topology and remaining compatibility boundaries above instead; do not convert removed stale items into completed work.
