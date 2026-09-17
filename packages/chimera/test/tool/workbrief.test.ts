import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { WorkBrief } from "@/session/work-brief"
import { Database } from "@/storage/db"
import { Truncate } from "@/tool/truncate"
import { WorkBriefTool } from "@/tool/workbrief"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(WorkBrief.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer))

// work_brief rows FK-reference session rows, which FK-reference project rows; seed the
// parent chain once per test so WorkBrief.update can persist the brief.
beforeEach(() => {
  Database.Client().$client.exec(`
    DELETE FROM work_brief;
    DELETE FROM session WHERE id = 'ses_workbrief_tool_test';
    DELETE FROM project WHERE id = 'prj_workbrief_tool_test';
    INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('prj_workbrief_tool_test', '/tmp/workbrief-tool-test', '[]', 0, 0);
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('ses_workbrief_tool_test', 'prj_workbrief_tool_test', 'workbrief-tool', '/tmp/workbrief-tool-test', 'WorkBrief Tool Test', 'test', 0, 0);
  `)
})

function toolCtx() {
  return {
    sessionID: SessionID.make("ses_workbrief_tool_test"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.workbrief", () => {
  it.instance("appends constraints and confirmedDecisions incrementally", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["Use bun"], confirmedDecisions: ["Lane A"] }),
      })

      const result = yield* def.execute({ constraints: ["Stay in lane"], confirmedDecisions: ["Lane B"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Use bun", "Stay in lane"])
      expect(brief.confirmedDecisions).toEqual(["Lane A", "Lane B"])
      expect(result.output).toContain("## Current Work Brief")
      expect(result.metadata.removals).toBeUndefined()
    }),
  )

  it.instance("dedupes exact duplicates after whitespace normalization, keeping stored position", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["Alpha", "Beta"] }),
      })

      yield* def.execute({ constraints: ["Beta ", "  Gamma", "Beta", "Alpha"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Alpha", "Beta", "Gamma"])
    }),
  )

  it.instance("removes stored constraints by substring and reports the removal", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({
          constraints: ["Publish via npm only", "Do not touch provider lane", "Keep tests focused"],
        }),
      })

      const result = yield* def.execute({ constraints_remove: ["provider lane"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Publish via npm only", "Keep tests focused"])
      expect(result.metadata.removals?.constraints.removed).toEqual(["Do not touch provider lane"])
      expect(result.metadata.removals?.constraints.unmatched).toEqual([])
      expect(result.output).toContain("## Brief removals")
      expect(result.output).toContain("Removed from constraints (1):")
      expect(result.output).toContain("- Do not touch provider lane")
    }),
  )

  it.instance("annotates no-match removal patterns and keeps stored entries", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["Alpha"] }),
      })

      const result = yield* def.execute({ constraints_remove: ["nonexistent pattern"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Alpha"])
      expect(result.metadata.removals?.constraints.removed).toEqual([])
      expect(result.metadata.removals?.constraints.unmatched).toEqual(["nonexistent pattern"])
      expect(result.output).toContain(`No match for constraints_remove (skipped): "nonexistent pattern"`)
    }),
  )

  it.instance("remove + add in one call expresses replacement", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ confirmedDecisions: ["Release target is the chimera submodule"] }),
      })

      yield* def.execute(
        {
          confirmedDecisions_remove: ["chimera submodule"],
          confirmedDecisions: ["Release target is the root/superproject repository"],
        },
        ctx,
      )

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.confirmedDecisions).toEqual(["Release target is the root/superproject repository"])
    }),
  )

  it.instance("one matcher removes every matching entry", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["old rule one", "old rule two", "keep"] }),
      })

      const result = yield* def.execute({ constraints_remove: ["old rule"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["keep"])
      expect(result.metadata.removals?.constraints.removed).toEqual(["old rule one", "old rule two"])
    }),
  )

  it.instance("removal matching is case-sensitive", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["Use Bun for tests"] }),
      })

      const result = yield* def.execute({ constraints_remove: ["use bun"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Use Bun for tests"])
      expect(result.metadata.removals?.constraints.unmatched).toEqual(["use bun"])
    }),
  )

  it.instance("blank removal matchers are ignored entirely", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({ constraints: ["Alpha"] }),
      })

      const result = yield* def.execute({ constraints_remove: ["", "   "] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["Alpha"])
      expect(result.metadata.removals).toBeUndefined()
      expect(result.output).not.toContain("## Brief removals")
    }),
  )

  it.instance("other fields keep replace semantics", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({
          intent: "old intent",
          acceptanceCriteria: ["old criteria"],
          openQuestions: ["old question"],
          relevantEvidence: ["old evidence"],
          closeout: ["old step"],
        }),
      })

      yield* def.execute({ intent: "new intent", acceptanceCriteria: ["new criteria"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.intent).toBe("new intent")
      expect(brief.acceptanceCriteria).toEqual(["new criteria"])
      expect(brief.openQuestions).toEqual(["old question"])
      expect(brief.relevantEvidence).toEqual(["old evidence"])
      expect(brief.closeout).toEqual(["old step"])
    }),
  )

  it.instance("clear resets the whole brief before applying supplied fields", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({
          intent: "old intent",
          constraints: ["old constraint"],
          confirmedDecisions: ["old decision"],
          closeout: ["old step"],
        }),
      })

      yield* def.execute({ clear: true, constraints: ["fresh"] }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.constraints).toEqual(["fresh"])
      expect(brief.confirmedDecisions).toEqual([])
      expect(brief.intent).toBeUndefined()
      expect(brief.closeout).toEqual([])
    }),
  )

  it.instance("legacy patch shape without removal fields preserves stored entries", () =>
    Effect.gen(function* () {
      const def = yield* (yield* WorkBriefTool).init()
      const workBrief = yield* WorkBrief.Service
      const ctx = toolCtx()
      yield* workBrief.update({
        sessionID: ctx.sessionID,
        brief: WorkBrief.normalize({
          intent: "goal",
          constraints: ["A", "B"],
          confirmedDecisions: ["D"],
        }),
      })

      yield* def.execute({ intent: "new goal" }, ctx)

      const brief = yield* workBrief.get(ctx.sessionID)
      expect(brief.intent).toBe("new goal")
      expect(brief.constraints).toEqual(["A", "B"])
      expect(brief.confirmedDecisions).toEqual(["D"])

      yield* def.execute({}, ctx)

      const unchanged = yield* workBrief.get(ctx.sessionID)
      expect(unchanged).toEqual(brief)
    }),
  )
})
