/**
 * Child-process side of the turn-lease cross-process integration test.
 * Spawned with bun as TS source (the allowed lane — no fresh executables),
 * sharing one file-backed chimera.db with its sibling via OPENCODE_DB, and
 * behaving like a second chimera process would: acquire the session's turn
 * lease with its own host identity, hold or release it, and report the
 * holder it was blocked by when the session is taken.
 *
 * Protocol (stdout):
 *   hold <sessionID> [holdMs]: `ACQUIRED <bootID> <pid>`, holds until the
 *     timeout elapses (then `RELEASED`, exit 0) or the process is killed
 *     (crash simulation — the lease row survives on purpose).
 *   take <sessionID>: `ACQUIRED <bootID> <pid>` + `RELEASED` + exit 0, or
 *     `BUSY <holderBootID> <holderPID>` + exit 1 when a live process holds it.
 * Exit 2 = usage failure.
 */
import { SessionTurnLease } from "../../src/session/turn-lease"
import type { SessionID } from "../../src/session/schema"

const [mode, sessionArg, holdArg] = process.argv.slice(2)
if (!mode || !sessionArg || (mode !== "hold" && mode !== "take")) {
  console.error("usage: turn-lease-worker.ts <hold|take> <sessionID> [holdMs]")
  process.exit(2)
}
const sessionID = sessionArg as SessionID

const result = SessionTurnLease.acquire(sessionID)
if (!result.acquired) {
  console.log(`BUSY ${result.holder.ownerBootID} ${result.holder.ownerPID}`)
  process.exitCode = 1
} else if (mode === "take") {
  console.log(`ACQUIRED ${SessionTurnLease.currentBootID()} ${process.pid}`)
  SessionTurnLease.release(sessionID)
  console.log("RELEASED")
} else {
  console.log(`ACQUIRED ${SessionTurnLease.currentBootID()} ${process.pid}`)
  await Bun.sleep(Number(holdArg ?? 30_000))
  SessionTurnLease.release(sessionID)
  console.log("RELEASED")
}
// Natural exit (no process.exit) so stdout flushes fully through the pipe.
