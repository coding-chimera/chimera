import { Effect } from "effect"
import { Server } from "../../server/server"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  return Object.values(networkInterfaces())
    .flatMap((net) => net ?? [])
    .filter((netInfo) => !netInfo.internal && netInfo.family === "IPv4" && !netInfo.address.startsWith("172."))
    .map((netInfo) => netInfo.address)
}

function newwebUrl(url: URL) {
  const next = new URL(url)
  next.pathname = "/newweb/"
  return next
}

export const NewWebCommand = effectCmd({
  command: "newweb",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("open", {
      describe: "open browser after server starts",
      type: "boolean",
      default: true,
    }),
  describe: "start chimera server and open lightweight web interface",
  instance: false,
  handler: Effect.fn("Cli.newweb")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const displayUrl = newwebUrl(server.url)
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      const localhostUrl = new URL(displayUrl)
      localhostUrl.hostname = "localhost"
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl.toString())
      for (const ip of getNetworkIPs()) {
        const networkUrl = new URL(displayUrl)
        networkUrl.hostname = ip
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Network access:    ", UI.Style.TEXT_NORMAL, networkUrl.toString())
      }
      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}/newweb/`,
        )
      }
      if (args.open) open(localhostUrl.toString()).catch(() => {})
    } else {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  NewWeb interface: ", UI.Style.TEXT_NORMAL, displayUrl.toString())
      if (args.open) open(displayUrl.toString()).catch(() => {})
    }

    yield* Effect.never
  }),
})
