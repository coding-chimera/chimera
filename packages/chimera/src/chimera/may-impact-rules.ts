import type { RelationKind } from "@/graph"
import type { ImpactLabelResult } from "./impact-label"

export type MayImpactRule = {
  id: string
  relationKinds: RelationKind[]
  includeFileDependents: boolean
  includeImpactRadius: boolean
  selfReviewOnly: boolean
  reason: string
}

const CALLER_RELATIONS: RelationKind[] = ["CalledBy", "OverriddenBy", "ImportedBy", "UsedBy"]
const IMPORT_EXPORT_RELATIONS: RelationKind[] = ["ImportedBy", "UsedBy"]
const FIELD_RELATIONS: RelationKind[] = ["UsedBy", "InstantiatedBy", "BaseClassOf"]
const CLASS_RELATIONS: RelationKind[] = ["InstantiatedBy", "BaseClassOf", "ImportedBy", "UsedBy"]
const ROUTE_RELATIONS: RelationKind[] = ["CalledBy", "ImportedBy", "UsedBy", "DecoratedBy"]
const CONTRACT_RELATIONS: RelationKind[] = ["ImportedBy", "UsedBy", "CalledBy"]

function rule(input: MayImpactRule): MayImpactRule {
  return input
}

export function dispatchMayImpactRule(label: ImpactLabelResult): MayImpactRule {
  if (label.label === "method_signature") {
    return rule({ id: "method_signature.callers", relationKinds: CALLER_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "method signature can affect callers, overrides, importers, and tests" })
  }
  if (label.label === "method_body") {
    if (label.bodyEffect === "local_only") return rule({ id: "method_body.local_self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "local-only body change should be reviewed at the changed symbol only" })
    if (label.bodyEffect === "unknown_body_effect") return rule({ id: "method_body.unknown_fallback", relationKinds: ["CalledBy", "UsedBy"], includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "unknown body effect falls back conservatively" })
    return rule({ id: "method_body.caller_visible", relationKinds: ["CalledBy", "UsedBy", "OverriddenBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "caller-visible body change can affect callers and tests" })
  }
  if (label.label === "field") return rule({ id: "field.usages", relationKinds: FIELD_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "field changes can affect usages, constructors, and inheritance" })
  if (label.label === "class_declaration") return rule({ id: "class_declaration.contract", relationKinds: CLASS_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "class declarations can affect instantiations, inheritance, importers, and usages" })
  if (label.label === "constructor_signature") return rule({ id: "constructor_signature.instantiations", relationKinds: ["InstantiatedBy", "BaseClassOf", "ImportedBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "constructor signatures can affect instantiations and inheritance" })
  if (label.label === "import_statement") return rule({ id: "import_statement.dependents", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "import changes can affect importing and dependent files" })
  if (label.label === "export_boundary") return rule({ id: "export_boundary.importers", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "export boundary changes can affect importers and dependent files" })
  if (label.label === "route_contract") return rule({ id: "route_contract.clients_tests_docs", relationKinds: ROUTE_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "route contract changes can affect clients, tests, and docs" })
  if (label.label === "schema_contract") return rule({ id: "schema_contract.usages", relationKinds: CONTRACT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "schema contract changes can affect usages, imports, and callers" })
  if (label.label === "config_boundary") return rule({ id: "config_boundary.defaults_env_tests", relationKinds: ["ImportedBy", "UsedBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "config boundary changes can affect defaults, env consumers, docs, and tests" })
  if (label.label === "test_contract") return rule({ id: "test_contract.self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "test contract changes should be reviewed at the changed test boundary" })
  if (label.label === "doc_contract") return rule({ id: "doc_contract.self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "documentation contract changes should be reviewed at the changed doc boundary" })
  if (label.label === "file_boundary") return rule({ id: "file_boundary.dependents_fallback", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "file boundary changes use dependent-file projection and conservative graph fallback" })
  return rule({ id: "unknown.conservative_fallback", relationKinds: ["CalledBy", "ImportedBy", "UsedBy", "InstantiatedBy", "BaseClassOf", "OverriddenBy", "DecoratedBy"], includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "unknown impact label uses conservative fallback" })
}

export function mayImpactRuleEvidence(rule: MayImpactRule) {
  return `chimera:may_impact_rule:${rule.id}`
}

export * as MayImpactRules from "./may-impact-rules"
