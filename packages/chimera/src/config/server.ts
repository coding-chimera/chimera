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
      "Maximum simultaneously active project instances kept by the server before LRU eviction (default: 4). Can also be set via CHIMERA_INSTANCE_MAX_ACTIVE_INSTANCES, which takes precedence.",
  }),
})
  .annotate({ identifier: "ServerConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Server = Schema.Schema.Type<typeof Server>

export * as ConfigServer from "./server"
