type DisplayInput = {
  input?: unknown
  metadata?: unknown
  output?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function parseOutput(output: unknown) {
  if (typeof output !== "string") return
  try {
    return record(JSON.parse(output))
  } catch {
    return
  }
}

export function isHostedWebSearchTool(tool: string) {
  return tool === "web_search" || tool === "web_search_preview"
}

export function formatHostedWebSearch(input: DisplayInput) {
  const payload = record(record(input.metadata)?.providerOutput) ?? parseOutput(input.output)
  const action = record(payload?.action)
  const query = stringValue(record(input.input)?.query) ?? stringValue(action?.query)
  const sourceCount = Array.isArray(payload?.sources) ? payload.sources.length : undefined
  const type = stringValue(action?.type)
  const url = stringValue(action?.url)
  const pattern = stringValue(action?.pattern)
  const title = query
    ? `Web Search "${query}"`
    : type === "openPage" && url
      ? "Web Search open page"
      : type === "findInPage" && pattern
        ? `Web Search find "${pattern}"`
        : "Web Search"
  const description = [type && type !== "search" && url ? url : undefined, sourceCount ? `${sourceCount} sources` : undefined]
    .filter((item): item is string => Boolean(item))
    .join(" · ")

  return {
    title,
    description: description || undefined,
  }
}
