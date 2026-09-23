import { SessionV2 } from "@/v2/session"
import { Layer } from "effect"
import { credentialHandlers } from "./v2/credential"
import { integrationHandlers } from "./v2/integration"
import { messageHandlers } from "./v2/message"
import { sessionHandlers } from "./v2/session"

export const v2Handlers = Layer.mergeAll(sessionHandlers, messageHandlers, integrationHandlers, credentialHandlers).pipe(
  Layer.provide(SessionV2.defaultLayer),
)
