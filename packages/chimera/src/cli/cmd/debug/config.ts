import { EOL } from "os"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { effectCmd } from "../../effect-cmd"
import { redactConfig } from "./redact"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.config")(function* () {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    process.stdout.write(JSON.stringify(redactConfig(config), null, 2) + EOL)
  }),
})
