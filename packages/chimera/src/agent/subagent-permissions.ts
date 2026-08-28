import type { Permission } from "../permission"
import type { Agent } from "./agent"

export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...(input.parentAgent?.permission.filter((rule) => rule.action === "deny") ?? []),
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask
      ? []
      : [
          { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
          { permission: "chimera_swarm" as const, pattern: "*" as const, action: "deny" as const },
        ]),
    { permission: "subagent_model_prefer", pattern: "*", action: "deny" },
    { permission: "subagent_model_suppress", pattern: "*", action: "deny" },
  ]
}
