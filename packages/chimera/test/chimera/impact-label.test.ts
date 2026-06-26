import { describe, expect, test } from "bun:test"
import { CODEPLAN_ATOMIC_LABELS, type CodePlanAtomicLabel } from "@/graph/types"
import { deriveCodePlanAtomicLabel, deriveImpactLabel } from "../../src/chimera/impact-label"
import type { ChangeFact, ChangeSubjectKind } from "../../src/chimera/change-classifier"
import type { CodePlanStatementEffectKind, FrozenSemanticObject, LanguageAwareSignal } from "@/graph"

function node(kind: FrozenSemanticObject["payload"]["kind"], name: string): FrozenSemanticObject {
  return {
    schemaVersion: 1,
    objectType: "node",
    source: { system: "codegraph", codegraphVersion: "test", graphRevision: "revision", schemaVersion: 1, codegraphId: `${kind}:${name}` },
    payload: {
      kind,
      name,
      qualifiedName: name,
      filePath: "sample.ts",
      language: "typescript",
      range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 },
    },
  }
}

function languageSignal(kind: LanguageAwareSignal["kind"]): LanguageAwareSignal {
  return {
    schemaVersion: 1,
    kind,
    language: "typescript",
    source: "codegraph:language_analyzer",
    quality: kind === "unknown_body_effect" ? "unknown" : "heuristic",
    confidence: kind === "unknown_body_effect" ? 0.45 : 0.75,
    range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 },
    reason: kind,
    signals: [`codegraph_language_signal:${kind}`],
  }
}

function fact(input: { subjectKind: ChangeSubjectKind; changeKind?: ChangeFact["changeKind"]; afterNode?: FrozenSemanticObject; signals?: LanguageAwareSignal[]; statementEffect?: CodePlanStatementEffectKind }): ChangeFact {
  return {
    schemaVersion: 1,
    id: `fact_${input.subjectKind}`,
    eventID: "event",
    filePath: "sample.ts",
    changeKind: input.changeKind ?? "modify",
    subjectKind: input.subjectKind,
    confidence: 0.8,
    evidence: {
      version: 1,
      source: "tool_diff",
      rule: "test",
      confidenceReason: "test",
      graph: { beforeRevision: "before", afterRevision: "after" },
      file: { path: "sample.ts" },
      afterNode: input.afterNode,
      languageSignals: input.signals,
      statementEffect: input.statementEffect ? {
        schemaVersion: 1,
        source: "codegraph:statement_effect",
        effect: input.statementEffect,
        graphBacked: true,
        confidence: 0.8,
        signalKinds: [],
        statementNodes: [],
        reason: "test statement effect",
        signals: [`codeplan_statement_effect:${input.statementEffect}`],
      } : undefined,
      signals: input.signals?.flatMap((signal) => signal.signals) ?? (input.statementEffect ? [`codeplan_statement_effect:${input.statementEffect}`] : []),
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("impact label", () => {
  test("derives contract labels from change facts", () => {
    expect(deriveImpactLabel(fact({ subjectKind: "signature", afterNode: node("function", "run") })).label).toBe("method_signature")
    expect(deriveImpactLabel(fact({ subjectKind: "signature", afterNode: node("method", "constructor") })).label).toBe("constructor_signature")
    expect(deriveImpactLabel(fact({ subjectKind: "schema", afterNode: node("field", "value") })).label).toBe("field")
    expect(deriveImpactLabel(fact({ subjectKind: "schema", afterNode: node("class", "Service") })).label).toBe("class_declaration")
    expect(deriveImpactLabel(fact({ subjectKind: "import" })).label).toBe("import_statement")
    expect(deriveImpactLabel(fact({ subjectKind: "export" })).label).toBe("export_boundary")
    expect(deriveImpactLabel(fact({ subjectKind: "route" })).label).toBe("route_contract")
    expect(deriveImpactLabel(fact({ subjectKind: "config" })).label).toBe("config_boundary")
    expect(deriveImpactLabel(fact({ subjectKind: "test" })).label).toBe("test_contract")
    expect(deriveImpactLabel(fact({ subjectKind: "doc" })).label).toBe("doc_contract")
    expect(deriveImpactLabel(fact({ subjectKind: "file" })).label).toBe("file_boundary")
    expect(deriveImpactLabel(fact({ subjectKind: "unknown" })).label).toBe("unknown")
  })

  test("derives body effect from statementEffect before language-aware signals", () => {
    expect(deriveImpactLabel(fact({ subjectKind: "body", statementEffect: "local_only", signals: [languageSignal("return_value_changed")] })).bodyEffect).toBe("local_only")
    expect(deriveImpactLabel(fact({ subjectKind: "body", statementEffect: "unknown_fallback", signals: [languageSignal("return_value_changed")] })).bodyEffect).toBe("unknown_body_effect")
    expect(deriveImpactLabel(fact({ subjectKind: "body", statementEffect: "return_value_change", signals: [languageSignal("local_only_change")] })).bodyEffect).toBe("caller_visible")
  })


  test("derives CodePlan atomic labels from change facts", () => {
    const cases: Array<[ChangeFact["changeKind"], ChangeSubjectKind, FrozenSemanticObject | undefined, LanguageAwareSignal[] | undefined, CodePlanAtomicLabel | undefined]> = [
      ["modify", "body", node("method", "run"), undefined, "MMB"],
      ["modify", "signature", node("method", "run"), undefined, "MMS"],
      ["modify", "schema", node("field", "value"), undefined, "MF"],
      ["modify", "signature", node("class", "Service"), undefined, "MC"],
      ["modify", "signature", node("method", "constructor"), undefined, "MCC"],
      ["modify", "import", undefined, undefined, "MI"],
      ["add", "signature", node("method", "run"), undefined, "AM"],
      ["add", "schema", node("field", "value"), undefined, "AF"],
      ["add", "signature", node("class", "Service"), undefined, "AC"],
      ["add", "signature", node("method", "constructor"), undefined, "ACC"],
      ["add", "import", undefined, undefined, "AI"],
      ["delete", "signature", node("method", "run"), undefined, "DM"],
      ["delete", "schema", node("field", "value"), undefined, "DF"],
      ["delete", "signature", node("class", "Service"), undefined, "DC"],
      ["delete", "signature", node("method", "constructor"), undefined, "DCC"],
      ["delete", "import", undefined, undefined, "DI"],
      ["modify", "signature", node("method", "renamedConstructor"), [languageSignal("constructor_like")], "MCC"],
      ["modify", "doc", undefined, undefined, undefined],
    ]

    expect(CODEPLAN_ATOMIC_LABELS).toHaveLength(16)
    for (const [changeKind, subjectKind, afterNode, signals, expected] of cases) {
      const changeFact = fact({ changeKind, subjectKind, afterNode, signals })
      expect(deriveCodePlanAtomicLabel(changeFact)?.label).toBe(expected)
      expect(deriveImpactLabel(changeFact).codePlanAtomicLabel).toBe(expected)
    }
  })
})
