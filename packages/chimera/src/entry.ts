/**
 * Thin process entrypoint. Kept import-free apart from the router so a worker
 * start never evaluates the application runtime (whose static imports carry
 * top-level await and a large module graph).
 */
import process from "node:process"
import { routeEntry } from "./cli/entry-route"

if (routeEntry(process.argv.slice(1)) === "child") {
  await import("./orchestrate/child-main")
} else {
  await import("./index")
}
