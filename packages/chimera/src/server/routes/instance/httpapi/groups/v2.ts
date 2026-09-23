import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { CredentialGroup } from "./v2/credential"
import { IntegrationGroup } from "./v2/integration"
import { MessageGroup } from "./v2/message"
import { SessionGroup } from "./v2/session"

export const V2Api = HttpApi.make("v2")
  .add(SessionGroup)
  .add(MessageGroup)
  .add(IntegrationGroup)
  .add(CredentialGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "chimera experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
