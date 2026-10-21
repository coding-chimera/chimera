import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Chimera } from "@/chimera"
import { ChimeraPromptContext } from "@/chimera/prompt-context"
import { SessionID } from "@/contracts/session-ids"
import { Session } from "@/session/session"
import { EditIntentClaims } from "@/chimera/edit-intent"
import { InstanceState } from "@/effect/instance-state"
import { makePromptHarness } from "../fixture/prompt-harness"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(makePromptHarness())

afterEach(async () => {
  await disposeAllInstances()
})

const NEGATIVE_LINE = "Edit coordination: no edit-intent claims"
const CLAIMS_HEADER = "Edit Intent Claims:"

const initGraph = Effect.fnUntraced(function* () {
  return yield* Chimera.initProjectGraph({ watch: false })
})

function render(sessionID: SessionID, sessions: Session.Interface) {
  return Effect.gen(function* () {
    return yield* (yield* ChimeraPromptContext.Service).render(sessionID, sessions)
  })
}

function projectRoot() {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    return instance.worktree === "/" ? instance.directory : instance.worktree
  })
}

describe("chimera prompt-context edit coordination line", () => {
  it.live("renders the negative form when no claims exist, without the claims header literal", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Solo" })
        const context = (yield* render(session.id, sessions)) ?? ""
        expect(context).toContain(NEGATIVE_LINE)
        expect(context).toContain("nothing blocks your edits")
        // The zero-claims absence assertion in prompt-context.test.ts pins this literal.
        expect(context).not.toContain(CLAIMS_HEADER)
      }),
    ),
  )

  it.live("renders the claims block (and drops the negative form) once a claim exists", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        yield* initGraph()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Claiming" })
        const root = yield* projectRoot()
        yield* EditIntentClaims.registerFromPredesign({
          projectRoot: root,
          sessionID: session.id,
          agent: "build",
          predesignID: "predesign_coord_ctx",
          intent: "hold a file",
          files: ["surface.ts"],
        })
        const context = (yield* render(session.id, sessions)) ?? ""
        expect(context).toContain(CLAIMS_HEADER)
        expect(context).toContain("held by you: surface.ts")
        expect(context).not.toContain(NEGATIVE_LINE)
      }),
    ),
  )
})
