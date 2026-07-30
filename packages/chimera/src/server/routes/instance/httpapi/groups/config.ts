import { Config } from "@/config/config"
import { ConfigModelSelection } from "@/config/model-selection"
import { Provider } from "@/provider/provider"
import { RemoteCompaction } from "@/session/remote-compaction"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          success: described(Config.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          payload: Config.Info,
          success: described(Config.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("remoteCompactionEligibilityList", `${root}/remote-compaction/eligibility`, {
          success: described(RemoteCompaction.EligibilityList, "Redacted remote compaction eligibility"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.remoteCompaction.eligibility.list",
            summary: "List remote compaction eligibility",
            description: "List redacted provider and model eligibility for project-level remote compaction overrides.",
          }),
        ),
        HttpApiEndpoint.patch("remoteCompactionEligibilityUpdate", `${root}/remote-compaction/eligibility`, {
          payload: RemoteCompaction.EligibilityPatch,
          success: described(RemoteCompaction.Eligibility, "Persisted redacted remote compaction eligibility"),
          error: RemoteCompaction.EligibilityError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.remoteCompaction.eligibility.update",
            summary: "Update remote compaction eligibility",
            description: "Persist a narrow provider and model remote compaction override for this project.",
          }),
        ),
        HttpApiEndpoint.get("remoteCompactionStatus", `${root}/remote-compaction/status`, {
          query: RemoteCompaction.StatusQuery,
          success: described(RemoteCompaction.Resolution, "Remote compaction status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.remoteCompaction.status",
            summary: "Get remote compaction status",
            description: "Resolve remote compaction production eligibility and installed replay disposition.",
          }),
        ),
        HttpApiEndpoint.get("remoteCompactionGet", `${root}/remote-compaction`, {
          success: described(RemoteCompaction.Policy, "Effective remote compaction policy"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.remoteCompaction.get",
            summary: "Get remote compaction policy",
            description: "Get effective remote compaction policy with redacted provenance and write-target metadata.",
          }),
        ),
        HttpApiEndpoint.patch("remoteCompactionUpdate", `${root}/remote-compaction`, {
          payload: RemoteCompaction.PolicyPatch,
          success: described(RemoteCompaction.Policy, "Resulting remote compaction policy"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.remoteCompaction.update",
            summary: "Update remote compaction policy",
            description: "Update only the requested remote compaction policy and protocol.",
          }),
        ),
        HttpApiEndpoint.get("modelSelectionGet", `${root}/model-selection`, {
          success: described(ConfigModelSelection.Info, "Get model selection"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.modelSelection.get",
            summary: "Get model selection",
            description: "Retrieve shared model selection state used by the Web UI and TUI.",
          }),
        ),
        HttpApiEndpoint.patch("modelSelectionUpdate", `${root}/model-selection`, {
          payload: ConfigModelSelection.Patch,
          success: described(ConfigModelSelection.Info, "Successfully updated model selection"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.modelSelection.update",
            summary: "Update model selection",
            description: "Update shared model selection state used by the Web UI and TUI.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "chimera experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
