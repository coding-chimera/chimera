import { describe, expect, test } from "bun:test"
import { dispatchMayImpactRule } from "../../src/chimera/may-impact-rules"
import type { ImpactLabelResult } from "../../src/chimera/impact-label"

function label(input: Partial<ImpactLabelResult> & Pick<ImpactLabelResult, "label">): ImpactLabelResult {
  return {
    label: input.label,
    confidence: input.confidence ?? 0.8,
    reason: input.reason ?? "test",
    fallbackReason: input.fallbackReason,
    bodyEffect: input.bodyEffect,
    signals: input.signals ?? [],
    fact: input.fact ?? {
      schemaVersion: 1,
      id: `fact_${input.label}`,
      eventID: "event",
      filePath: "sample.ts",
      changeKind: "modify",
      subjectKind: "unknown",
      confidence: 0.8,
      evidence: {
        version: 1,
        source: "tool_diff",
        rule: "test",
        confidenceReason: "test",
        graph: { beforeRevision: "before", afterRevision: "after" },
        file: { path: "sample.ts" },
        signals: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }
}

describe("may impact rules", () => {
  test("dispatches all first-pass impact labels", () => {
    expect(dispatchMayImpactRule(label({ label: "method_signature" })).id).toBe("method_signature.callers")
    expect(dispatchMayImpactRule(label({ label: "method_body", bodyEffect: "local_only" })).id).toBe("method_body.local_self_review")
    expect(dispatchMayImpactRule(label({ label: "method_body", bodyEffect: "caller_visible" })).id).toBe("method_body.caller_visible")
    expect(dispatchMayImpactRule(label({ label: "method_body", bodyEffect: "unknown_body_effect" })).id).toBe("method_body.unknown_fallback")
    expect(dispatchMayImpactRule(label({ label: "field" })).id).toBe("field.usages")
    expect(dispatchMayImpactRule(label({ label: "class_declaration" })).id).toBe("class_declaration.contract")
    expect(dispatchMayImpactRule(label({ label: "constructor_signature" })).id).toBe("constructor_signature.instantiations")
    expect(dispatchMayImpactRule(label({ label: "import_statement" })).id).toBe("import_statement.dependents")
    expect(dispatchMayImpactRule(label({ label: "export_boundary" })).id).toBe("export_boundary.importers")
    expect(dispatchMayImpactRule(label({ label: "route_contract" })).id).toBe("route_contract.clients_tests_docs")
    expect(dispatchMayImpactRule(label({ label: "schema_contract" })).id).toBe("schema_contract.usages")
    expect(dispatchMayImpactRule(label({ label: "config_boundary" })).id).toBe("config_boundary.defaults_env_tests")
    expect(dispatchMayImpactRule(label({ label: "test_contract" })).id).toBe("test_contract.self_review")
    expect(dispatchMayImpactRule(label({ label: "doc_contract" })).id).toBe("doc_contract.self_review")
    expect(dispatchMayImpactRule(label({ label: "file_boundary" })).id).toBe("file_boundary.dependents_fallback")
    expect(dispatchMayImpactRule(label({ label: "unknown" })).id).toBe("unknown.conservative_fallback")
  })
})
