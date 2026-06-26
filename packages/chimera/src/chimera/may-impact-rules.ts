import type { CodePlanAtomicLabel, CodePlanRelationGraphLabel, CodePlanRelationKind, RelationKind } from "@/graph"
import type { ImpactLabelResult } from "./impact-label"

export type MayImpactRelationClause = {
  graph: CodePlanRelationGraphLabel
  relation: CodePlanRelationKind
}

export type MayImpactRule = {
  id: string
  relationKinds: RelationKind[]
  relationClauses: MayImpactRelationClause[]
  codePlanAtomicLabels?: CodePlanAtomicLabel[]
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

function clause(graph: CodePlanRelationGraphLabel, relation: CodePlanRelationKind): MayImpactRelationClause {
  return { graph, relation }
}

function legacyRule(input: Omit<MayImpactRule, "relationClauses">): MayImpactRule {
  return { ...input, relationClauses: [] }
}

function codePlanRule(input: Omit<MayImpactRule, "relationKinds">): MayImpactRule {
  return { ...input, relationKinds: [] }
}

function modifiedMethodBodyRule(label: ImpactLabelResult): MayImpactRule {
  if (label.bodyEffect === "local_only") return codePlanRule({ id: "codeplan.MMB.self_review", relationClauses: [], codePlanAtomicLabels: ["MMB"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "MMB local-only method body changes have Nil relation-clause propagation" })
  if (label.bodyEffect === "unknown_body_effect") return codePlanRule({ id: "codeplan.MMB.fallback", relationClauses: [clause("D", "CalledBy"), clause("D", "UsedBy")], codePlanAtomicLabels: ["MMB"], includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "MMB method body effect is inconclusive; use conservative relation clauses plus Chimera fallback candidates" })
  return codePlanRule({ id: "codeplan.MMB.relation_clause", relationClauses: [clause("D", "CalledBy")], codePlanAtomicLabels: ["MMB"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MMB caller-visible method body changes propagate through Rel(D, M, CalledBy)" })
}

function codePlanAtomicRule(label: ImpactLabelResult): MayImpactRule | undefined {
  if (label.codePlanAtomicLabel === "MMB") return modifiedMethodBodyRule(label)
  if (label.codePlanAtomicLabel === "MMS") return codePlanRule({ id: "codeplan.MMS.relation_clauses", relationClauses: [clause("D", "CalledBy"), clause("D", "Overrides"), clause("D", "OverriddenBy"), clause("D'", "Overrides"), clause("D'", "OverriddenBy")], codePlanAtomicLabels: ["MMS"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MMS modified method signatures propagate through caller and override relation clauses" })
  if (label.codePlanAtomicLabel === "MF") return codePlanRule({ id: "codeplan.MF.relation_clauses", relationClauses: [clause("D", "UsedBy"), clause("D", "ConstructedBy"), clause("D", "BaseClassOf"), clause("D", "DerivedClassOf")], codePlanAtomicLabels: ["MF"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MF modified fields propagate through usage, construction, and inheritance relation clauses" })
  if (label.codePlanAtomicLabel === "MC") return codePlanRule({ id: "codeplan.MC.relation_clauses", relationClauses: [clause("D", "ConstructedBy"), clause("D", "BaseClassOf"), clause("D", "DerivedClassOf"), clause("D", "UsedBy")], codePlanAtomicLabels: ["MC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MC modified class declarations propagate through construction, inheritance, and usage relation clauses" })
  if (label.codePlanAtomicLabel === "MCC") return codePlanRule({ id: "codeplan.MCC.relation_clauses", relationClauses: [clause("D", "ConstructedBy"), clause("D", "BaseClassOf"), clause("D", "DerivedClassOf")], codePlanAtomicLabels: ["MCC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MCC modified constructor signatures propagate through construction and inheritance relation clauses" })
  if (label.codePlanAtomicLabel === "MI") return codePlanRule({ id: "codeplan.MI.relation_clauses", relationClauses: [clause("D", "ImportedBy"), clause("D", "UsedBy")], codePlanAtomicLabels: ["MI"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "MI modified import statements propagate through import and usage relation clauses" })
  if (label.codePlanAtomicLabel === "AM") return codePlanRule({ id: "codeplan.AM.relation_clauses", relationClauses: [clause("D'", "CalledBy"), clause("D'", "UsedBy")], codePlanAtomicLabels: ["AM"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "AM added methods propagate through after-graph caller and usage relation clauses" })
  if (label.codePlanAtomicLabel === "AF") return codePlanRule({ id: "codeplan.AF.relation_clauses", relationClauses: [clause("D'", "UsedBy"), clause("D'", "ConstructedBy")], codePlanAtomicLabels: ["AF"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "AF added fields propagate through after-graph usage and construction relation clauses" })
  if (label.codePlanAtomicLabel === "AC") return codePlanRule({ id: "codeplan.AC.relation_clauses", relationClauses: [clause("D'", "ConstructedBy"), clause("D'", "BaseClassOf"), clause("D'", "DerivedClassOf"), clause("D'", "UsedBy")], codePlanAtomicLabels: ["AC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "AC added classes propagate through after-graph construction, inheritance, and usage relation clauses" })
  if (label.codePlanAtomicLabel === "ACC") return codePlanRule({ id: "codeplan.ACC.relation_clauses", relationClauses: [clause("D'", "ConstructedBy"), clause("D'", "BaseClassOf"), clause("D'", "DerivedClassOf")], codePlanAtomicLabels: ["ACC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "ACC added constructors propagate through after-graph construction and inheritance relation clauses" })
  if (label.codePlanAtomicLabel === "AI") return codePlanRule({ id: "codeplan.AI.relation_clauses", relationClauses: [clause("D'", "ImportedBy"), clause("D'", "UsedBy")], codePlanAtomicLabels: ["AI"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "AI added imports propagate through after-graph import and usage relation clauses" })
  if (label.codePlanAtomicLabel === "DM") return codePlanRule({ id: "codeplan.DM.relation_clauses", relationClauses: [clause("D", "CalledBy"), clause("D", "UsedBy")], codePlanAtomicLabels: ["DM"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "DM deleted methods propagate through before-graph caller and usage relation clauses" })
  if (label.codePlanAtomicLabel === "DF") return codePlanRule({ id: "codeplan.DF.relation_clauses", relationClauses: [clause("D", "UsedBy"), clause("D", "ConstructedBy")], codePlanAtomicLabels: ["DF"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "DF deleted fields propagate through before-graph usage and construction relation clauses" })
  if (label.codePlanAtomicLabel === "DC") return codePlanRule({ id: "codeplan.DC.relation_clauses", relationClauses: [clause("D", "ConstructedBy"), clause("D", "BaseClassOf"), clause("D", "DerivedClassOf"), clause("D", "UsedBy")], codePlanAtomicLabels: ["DC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "DC deleted classes propagate through before-graph construction, inheritance, and usage relation clauses" })
  if (label.codePlanAtomicLabel === "DCC") return codePlanRule({ id: "codeplan.DCC.relation_clauses", relationClauses: [clause("D", "ConstructedBy"), clause("D", "BaseClassOf"), clause("D", "DerivedClassOf")], codePlanAtomicLabels: ["DCC"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "DCC deleted constructors propagate through before-graph construction and inheritance relation clauses" })
  if (label.codePlanAtomicLabel === "DI") return codePlanRule({ id: "codeplan.DI.relation_clauses", relationClauses: [clause("D", "ImportedBy"), clause("D", "UsedBy")], codePlanAtomicLabels: ["DI"], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: false, reason: "DI deleted imports propagate through before-graph import and usage relation clauses" })
  return undefined
}

export function dispatchMayImpactRule(label: ImpactLabelResult): MayImpactRule {
  const codePlan = codePlanAtomicRule(label)
  if (codePlan) return codePlan
  if (label.label === "method_signature") {
    return legacyRule({ id: "method_signature.callers", relationKinds: CALLER_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "method signature can affect callers, overrides, importers, and tests" })
  }
  if (label.label === "method_body") {
    if (label.bodyEffect === "local_only") return legacyRule({ id: "method_body.self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "method body change stays on the changed symbol" })
    if (label.bodyEffect === "unknown_body_effect") return legacyRule({ id: "method_body.fallback", relationKinds: ["CalledBy", "UsedBy"], includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "method body analysis is inconclusive; use conservative relations" })
    return legacyRule({ id: "method_body.relations", relationKinds: ["CalledBy", "UsedBy", "OverriddenBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "method body change uses relation propagation" })
  }
  if (label.label === "field") return legacyRule({ id: "field.usages", relationKinds: FIELD_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "field changes can affect usages, constructors, and inheritance" })
  if (label.label === "class_declaration") return legacyRule({ id: "class_declaration.contract", relationKinds: CLASS_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "class declarations can affect instantiations, inheritance, importers, and usages" })
  if (label.label === "constructor_signature") return legacyRule({ id: "constructor_signature.instantiations", relationKinds: ["InstantiatedBy", "BaseClassOf", "ImportedBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "constructor signatures can affect instantiations and inheritance" })
  if (label.label === "import_statement") return legacyRule({ id: "import_statement.dependents", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "import changes can affect importing and dependent files" })
  if (label.label === "export_boundary") return legacyRule({ id: "export_boundary.importers", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "export boundary changes can affect importers and dependent files" })
  if (label.label === "route_contract") return legacyRule({ id: "route_contract.clients_tests_docs", relationKinds: ROUTE_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "route contract changes can affect clients, tests, and docs" })
  if (label.label === "schema_contract") return legacyRule({ id: "schema_contract.usages", relationKinds: CONTRACT_RELATIONS, includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "schema contract changes can affect usages, imports, and callers" })
  if (label.label === "config_boundary") return legacyRule({ id: "config_boundary.defaults_env_tests", relationKinds: ["ImportedBy", "UsedBy"], includeFileDependents: true, includeImpactRadius: false, selfReviewOnly: false, reason: "config boundary changes can affect defaults, env consumers, docs, and tests" })
  if (label.label === "test_contract") return legacyRule({ id: "test_contract.self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "test contract changes should be reviewed at the changed test boundary" })
  if (label.label === "doc_contract") return legacyRule({ id: "doc_contract.self_review", relationKinds: [], includeFileDependents: false, includeImpactRadius: false, selfReviewOnly: true, reason: "documentation contract changes should be reviewed at the changed doc boundary" })
  if (label.label === "file_boundary") return legacyRule({ id: "file_boundary.dependents_fallback", relationKinds: IMPORT_EXPORT_RELATIONS, includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "file boundary changes use dependent-file projection and conservative graph fallback" })
  return legacyRule({ id: "unknown.conservative_fallback", relationKinds: ["CalledBy", "ImportedBy", "UsedBy", "InstantiatedBy", "BaseClassOf", "OverriddenBy", "DecoratedBy"], includeFileDependents: true, includeImpactRadius: true, selfReviewOnly: false, reason: "unknown impact label uses conservative fallback" })
}

export function mayImpactRuleEvidence(rule: MayImpactRule) {
  return `chimera:may_impact_rule:${rule.id}`
}

export * as MayImpactRules from "./may-impact-rules"
