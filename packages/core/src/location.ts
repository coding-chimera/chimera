// (L5.1) Minimal-seam shim of upstream core's location.ts — NOT a byte vendor.
// Upstream resolves Project/VCS through the project tree (~2k line closure);
// the vendored EventV2 trunk only needs the `Location.Ref` type and an optional
// `Location.Service` for publish-time enrichment (`Effect.serviceOption` ->
// undefined when unbound). The upstream service tag and schema re-exports are
// preserved so a full vendor of location.ts is a drop-in replacement in L5.2+.
// See UPSTREAM_V2_MIGRATION_PLAN.md "L5 细分计划" decision ①.
import { Context } from "effect"
import { Info, Ref, response } from "@opencode-ai/schema/location"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}
