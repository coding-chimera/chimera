import DESCRIPTION from "./subagent_model_suppress.txt"
import { makePreferenceMutationTool, Parameters } from "./subagent_model_prefer"

export { DESCRIPTION, Parameters }

export const SubagentModelSuppressTool = makePreferenceMutationTool(
  "subagent_model_suppress",
  DESCRIPTION,
  "suppress",
)
