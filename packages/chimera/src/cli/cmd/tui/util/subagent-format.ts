/**
 * Subagent row title/detail formatting shared by the session route and the
 * session-v2 plugin renderer (upstream 6072a68d6b / 9814dc6526 / cf2d1dd3e9:
 * the "(background)" marker stays attached to the subagent identity, not the
 * description, so promotion does not visually detach it from the task label).
 */

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}
