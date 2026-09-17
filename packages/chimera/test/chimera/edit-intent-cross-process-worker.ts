/**
 * Child-process side of the edit-intent cross-process bridge integration
 * test. Spawned with bun as TS source (the allowed lane — no fresh
 * executable), sharing the project DB with the parent test process and
 * behaving like a second chimera process would: register a waiter stamped
 * with its own host identity, then poll the host-filtered take until the
 * parent process's release frees the file.
 *
 * Protocol: stdout line `REGISTERED <bootID> <pid> <sessionID>` after
 * registration, then `WOKEN <sessionID>` with exit code 0, or exit code 1
 * on timeout (2 = usage/registration failure).
 */
import { currentHostBootID, registerEditIntentWaiter, takeWokenEditIntentWaiters } from "../../src/chimera/store"

const [projectRoot, filePath, blockerSessionID] = process.argv.slice(2)
if (!projectRoot || !filePath || !blockerSessionID) {
  console.error("usage: edit-intent-cross-process-worker.ts <projectRoot> <filePath> <blockerSessionID>")
  process.exit(2)
}

const sessionID = `ses_child_${process.pid}`
const registered = await registerEditIntentWaiter(projectRoot, { sessionID, filePath, blockerSessionID, reason: "cross_process_test" })
if (!registered) {
  console.error("waiter registration failed (missing project DB?)")
  process.exit(2)
}
console.log(`REGISTERED ${currentHostBootID()} ${process.pid} ${sessionID}`)

let woken = false
for (let tick = 0; tick < 150 && !woken; tick++) {
  const taken = await takeWokenEditIntentWaiters(projectRoot, [filePath], { hostBootID: currentHostBootID() })
  woken = taken.some((waiter) => waiter.sessionID === sessionID)
  if (!woken) await Bun.sleep(200)
}
if (woken) console.log(`WOKEN ${sessionID}`)
// Natural exit (no process.exit) so stdout flushes fully through the pipe.
process.exitCode = woken ? 0 : 1
