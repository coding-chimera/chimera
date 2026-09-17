import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: chimera.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
  maxActiveInstances: Schema.optional(PositiveInt).annotate({
    description:
      "Retired safety valve: maximum simultaneously active project instances before LRU eviction. Defaults to disabled (unlimited) since instance lifecycle is driven by consumer signals (request leases, session pins, WebUI presence) plus idle TTL, with RSS-budget pressure eviction as the backstop. Set an explicit positive value to restore the legacy count cap. Can also be set via CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES, which takes precedence.",
  }),
  instanceMemoryBudgetMb: Schema.optional(PositiveInt).annotate({
    description:
      "Process RSS budget in megabytes above which memory-pressure eviction disposes consumer-free project instances, coldest first, until RSS is back at 80% of the budget (default: 1024; acceptable maximum: 2048 — values above 2048 are not recommended because the server shares the machine with agent sessions, compilers, and other workloads). Can also be set via CHIMERA_INSTANCE_MEMORY_BUDGET_MB, which takes precedence.",
  }),
})
  .annotate({ identifier: "ServerConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Server = Schema.Schema.Type<typeof Server>

export * as ConfigServer from "./server"
