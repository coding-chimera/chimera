import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { listActiveProcesses } from "../../process-service"
import { InstanceHttpApi } from "../api"

export const processHandlers = HttpApiBuilder.group(InstanceHttpApi, "process", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle("list", listActiveProcesses)
  }),
)
