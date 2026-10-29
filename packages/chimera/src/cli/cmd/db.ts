import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@/storage/db"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"
import { ToolMetadataMaintenance } from "@/session/tool-metadata-maintenance"

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new BunDatabase(Database.Path, { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => row[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      }
      db.close()
      return
    }
    const child = spawn("sqlite3", [Database.Path], {
      stdio: "inherit",
    })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.Path)
  },
})

export const SUMMARY_DIFFS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function summaryDiffsCutoff(now = Date.now()) {
  return now - SUMMARY_DIFFS_RETENTION_MS
}

// Old messages can still carry the legacy `summary.diffs` blob. The read path
// repairs oversized ones per session (message-v2.ts); this is the bulk sweep
// for rows that have aged out of the retention window.
const STALE_SUMMARY_DIFFS_WHERE = `
  time_created < ?
    AND json_valid(data)
    AND json_type(data, '$.summary.diffs') = 'array'
    AND json_array_length(data, '$.summary.diffs') > 0
`

export function countStaleSummaryDiffs(db: BunDatabase, cutoff: number) {
  const row = db
    .query(`SELECT count(*) AS count FROM message WHERE ${STALE_SUMMARY_DIFFS_WHERE}`)
    .get(cutoff) as { count: number }
  return Number(row.count)
}

export function clearStaleSummaryDiffs(db: BunDatabase, cutoff: number) {
  return db
    .run(`UPDATE message SET data = json_set(data, '$.summary.diffs', json('[]')) WHERE ${STALE_SUMMARY_DIFFS_WHERE}`, [cutoff])
    .changes
}

function pragmaNumber(db: BunDatabase, name: string) {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null
  return row ? Number(Object.values(row)[0] ?? 0) : 0
}

export function vacuumEstimate(db: BunDatabase) {
  const pageCount = pragmaNumber(db, "page_count")
  const freePages = pragmaNumber(db, "freelist_count")
  const pageSize = pragmaNumber(db, "page_size")
  return { pageCount, freePages, pageSize, reclaimableBytes: freePages * pageSize }
}

export function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

const VacuumCommand = cmd({
  command: "vacuum",
  describe: "reclaim database space: clear stale message summary diffs, checkpoint the WAL, VACUUM, and optimize",
  builder: (yargs: Argv) =>
    yargs.option("yes", {
      type: "boolean",
      default: false,
      describe: "apply the cleanup and run VACUUM (default is a dry run)",
    }),
  handler: (args: { yes: boolean }) => {
    const cutoff = summaryDiffsCutoff()
    // Bun rejects an explicit `readonly: false`, so only pass the option for dry runs.
    const db = args.yes ? new BunDatabase(Database.Path) : new BunDatabase(Database.Path, { readonly: true })
    try {
      const stale = countStaleSummaryDiffs(db, cutoff)
      const before = vacuumEstimate(db)
      console.log(`Messages older than ${new Date(cutoff).toISOString()} with summary.diffs: ${stale}`)
      console.log(
        `Database: ${before.pageCount} pages x ${before.pageSize} bytes, ${before.freePages} free pages (~${formatBytes(before.reclaimableBytes)} reclaimable)`,
      )
      console.log("Warning: VACUUM needs up to 2x the database size in free disk space and blocks writes while it runs.")
      if (!args.yes) {
        console.log("Dry run: no changes applied. Re-run with --yes to clear stale summary diffs, checkpoint the WAL, VACUUM, and optimize.")
        return
      }
      console.log(`Cleared summary.diffs on ${clearStaleSummaryDiffs(db, cutoff)} message(s)`)
      const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, number> | null
      console.log(
        checkpoint && checkpoint.log >= 0
          ? `WAL checkpoint: busy=${checkpoint.busy} log=${checkpoint.log} checkpointed=${checkpoint.checkpointed}`
          : "WAL checkpoint: skipped (database is not in WAL mode)",
      )
      console.log("Running VACUUM...")
      db.exec("VACUUM")
      db.exec("PRAGMA optimize")
      const after = vacuumEstimate(db)
      console.log(
        `VACUUM complete: ${after.pageCount} pages, ${after.freePages} free pages (~${formatBytes(after.reclaimableBytes)} reclaimable)`,
      )
    } catch (err) {
      UI.error(`Database vacuum failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      db.close()
    }
  },
})

const CompactToolMetadataCommand = cmd({
  command: "compact-tool-metadata",
  describe: "analyze recoverable Chimera tool metadata and compact it only with --apply",
  builder: (yargs: Argv) =>
    yargs
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "rewrite validated Legacy part and V2 tool-success metadata",
      })
      .option("session", {
        type: "string",
        describe: "limit analysis to one session ID",
      }),
  handler: async (args: { apply: boolean; session?: string }) => {
    try {
      console.log(
        JSON.stringify(
          await ToolMetadataMaintenance.run({
            dbPath: Database.Path,
            apply: args.apply,
            sessionID: args.session,
          }),
          null,
          2,
        ),
      )
    } catch (err) {
      UI.error(`Tool metadata maintenance failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  },
})


const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const sqlite = new BunDatabase(Database.Path)
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      sqlite.close()
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(PathCommand)
      .command(MigrateCommand)
      .command(CompactToolMetadataCommand)
      .command(VacuumCommand)
      .demandCommand()
  },
  handler: () => {},
})
