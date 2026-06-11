export function graphCliArgs(args: readonly string[], fallbackArgs: readonly string[] = []) {
  return graphCliArgsDirect(args) ?? graphCliArgsFallback(fallbackArgs)
}

function graphCliArgsDirect(args: readonly string[]) {
  if (args[0] === "graph") return normalize(args.slice(1))
  const separator = args.indexOf("--")
  if (separator !== -1 && args[separator + 1] === "graph") {
    return normalize(args.slice(separator + 2))
  }
  const index = args.indexOf("--graph")
  if (index === -1) return undefined
  return normalize(args.slice(index + 1))
}

function graphCliArgsFallback(args: readonly string[]) {
  const direct = graphCliArgsDirect(args)
  if (direct) return direct
  if (isEntrypoint(args[0]) && args[1] === "graph") {
    return normalize(args.slice(2))
  }
  return undefined
}

function isEntrypoint(arg: string | undefined) {
  if (!arg) return false
  return arg.includes("/") || arg.includes("\\") || arg.endsWith(".js") || arg.endsWith(".ts")
}

function normalize(args: readonly string[]) {
  const forwarded = args[0] === "--" ? args.slice(1) : args
  if (forwarded.length === 0) return ["--help"]
  return [...forwarded]
}

export * as GraphRoute from "./graph-route"
