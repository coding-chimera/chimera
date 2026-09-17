import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Completion markers for lazy one-off data migrations. A repair that used to run
 * on every read records its subject here once, so it runs at most once per key
 * per database instead of once per request.
 *
 * `key` is `<migration>:<subject>`, for example `message-summary-trim:ses_...`.
 */
export const StorageMaintenanceTable = sqliteTable("storage_maintenance", {
  key: text().primaryKey(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})
