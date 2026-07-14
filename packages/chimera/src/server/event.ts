import { BusEvent } from "@/bus/bus-event"
import { WebUIPreferences } from "@/server/webui-preferences"
import { PositiveInt } from "@/util/schema"
import { Schema } from "effect"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Heartbeat: BusEvent.define("server.heartbeat", Schema.Struct({})),
  Gap: BusEvent.define("server.event-gap", Schema.Struct({ dropped: PositiveInt })),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
  PreferencesUpdated: BusEvent.define("global.preferences.updated", WebUIPreferences.Snapshot),
}
