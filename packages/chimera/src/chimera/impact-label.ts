import type { ChangeFact } from "./change-classifier"
import type { CodePlanAtomicLabel, FrozenSemanticObject } from "@/graph"

export type ImpactLabel =
  | "method_signature"
  | "method_body"
  | "field"
  | "class_declaration"
  | "constructor_signature"
  | "import_statement"
  | "export_boundary"
  | "route_contract"
  | "schema_contract"
  | "config_boundary"
  | "test_contract"
  | "doc_contract"
  | "file_boundary"
  | "unknown"

export type BodyImpactEffect = "local_only" | "caller_visible" | "unknown_body_effect"

export type CodePlanAtomicLabelResult = {
  label: CodePlanAtomicLabel
  reason: string
}


export type ImpactLabelResult = {
  fact: ChangeFact
  label: ImpactLabel
  codePlanAtomicLabel?: CodePlanAtomicLabel
  confidence: number
  reason: string
  fallbackReason?: string
  bodyEffect?: BodyImpactEffect
  signals: string[]
}

function changedNode(fact: ChangeFact) {
  return fact.evidence.afterNode ?? fact.evidence.beforeNode ?? null
}

function nodeKind(fact: ChangeFact) {
  return changedNode(fact)?.payload.kind
}

function nodeName(fact: ChangeFact) {
  return changedNode(fact)?.payload.name
}

function signalKinds(fact: ChangeFact) {
  return new Set((fact.evidence.languageSignals ?? []).map((signal) => signal.kind))
}

function hasSignal(fact: ChangeFact, kind: string) {
  return signalKinds(fact).has(kind as never)
}

function isClassLike(node: FrozenSemanticObject | null) {
  return node?.payload.kind === "class" || node?.payload.kind === "interface" || node?.payload.kind === "struct" || node?.payload.kind === "trait" || node?.payload.kind === "protocol"
}

function isConstructorChange(fact: ChangeFact) {
  return nodeName(fact) === "constructor" || hasSignal(fact, "constructor_like")
}

function atomicMethodLabel(fact: ChangeFact): CodePlanAtomicLabel | undefined {
  if (fact.changeKind === "add") return isConstructorChange(fact) ? "ACC" : "AM"
  if (fact.changeKind === "delete") return isConstructorChange(fact) ? "DCC" : "DM"
  if (fact.subjectKind === "body") return "MMB"
  return isConstructorChange(fact) ? "MCC" : "MMS"
}

function codePlanAtomicLabelForFact(fact: ChangeFact): CodePlanAtomicLabel | undefined {
  if (fact.subjectKind === "import") {
    if (fact.changeKind === "add") return "AI"
    if (fact.changeKind === "delete") return "DI"
    return "MI"
  }

  const node = changedNode(fact)
  const kind = nodeKind(fact)

  if (fact.subjectKind === "signature" && isClassLike(node)) {
    if (fact.changeKind === "add") return "AC"
    if (fact.changeKind === "delete") return "DC"
    return "MC"
  }

  if (fact.subjectKind === "body" || fact.subjectKind === "signature") return atomicMethodLabel(fact)
  if (fact.subjectKind === "schema") {
    if (kind === "field" || kind === "property") {
      if (fact.changeKind === "add") return "AF"
      if (fact.changeKind === "delete") return "DF"
      return "MF"
    }
    if (isClassLike(node)) {
      if (fact.changeKind === "add") return "AC"
      if (fact.changeKind === "delete") return "DC"
      return "MC"
    }
  }

  return undefined
}

export function deriveCodePlanAtomicLabel(fact: ChangeFact): CodePlanAtomicLabelResult | undefined {
  const label = codePlanAtomicLabelForFact(fact)
  if (!label) return undefined
  return {
    label,
    reason: `change fact ${fact.changeKind}/${fact.subjectKind} maps to CodePlan atomic label ${label}`,
  }
}

function bodyEffect(fact: ChangeFact): BodyImpactEffect {
  if (fact.evidence.statementEffect?.effect === "local_only") return "local_only"
  if (fact.evidence.statementEffect?.effect === "unknown_fallback") return "unknown_body_effect"
  if (fact.evidence.statementEffect) return "caller_visible"
  const kinds = signalKinds(fact)
  if (kinds.has("local_only_change")) return "local_only"
  if (kinds.has("unknown_body_effect")) return "unknown_body_effect"
  return "caller_visible"
}

function bodyLabel(fact: ChangeFact): ImpactLabelResult {
  const effect = bodyEffect(fact)
  const statementEffect = fact.evidence.statementEffect?.effect
  return {
    fact,
    label: "method_body",
    confidence: fact.confidence,
    reason: statementEffect
      ? `body change has CodePlan statement effect ${statementEffect}`
      : effect === "local_only" ? "body change is local-only by language-aware signal" : effect === "unknown_body_effect" ? "body change has unknown caller-visible effect" : "body change has caller-visible language-aware signal or fallback confidence",
    bodyEffect: effect,
    fallbackReason: effect === "unknown_body_effect" ? "unknown_body_effect requires conservative fallback" : undefined,
    signals: fact.evidence.signals,
    codePlanAtomicLabel: deriveCodePlanAtomicLabel(fact)?.label,
  }
}

function signatureLabel(fact: ChangeFact): ImpactLabel {
  const node = changedNode(fact)
  if (node?.payload.name === "constructor" || hasSignal(fact, "constructor_like")) return "constructor_signature"
  if (node?.payload.kind === "class" || node?.payload.kind === "interface" || node?.payload.kind === "struct" || node?.payload.kind === "trait" || node?.payload.kind === "protocol") return "class_declaration"
  return "method_signature"
}

function schemaLabel(fact: ChangeFact): ImpactLabel {
  const kind = changedNode(fact)?.payload.kind
  if (kind === "field" || kind === "property") return "field"
  if (kind === "class" || kind === "interface" || kind === "struct" || kind === "trait" || kind === "protocol") return "class_declaration"
  return "schema_contract"
}

function labelForFact(fact: ChangeFact): ImpactLabel {
  if (fact.subjectKind === "signature") return signatureLabel(fact)
  if (fact.subjectKind === "import") return "import_statement"
  if (fact.subjectKind === "export") return "export_boundary"
  if (fact.subjectKind === "route") return "route_contract"
  if (fact.subjectKind === "schema") return schemaLabel(fact)
  if (fact.subjectKind === "config") return "config_boundary"
  if (fact.subjectKind === "test") return "test_contract"
  if (fact.subjectKind === "doc") return "doc_contract"
  if (fact.subjectKind === "file") return "file_boundary"
  return "unknown"
}

export function deriveImpactLabel(fact: ChangeFact): ImpactLabelResult {
  if (fact.subjectKind === "body") return bodyLabel(fact)
  const label = labelForFact(fact)
  return {
    fact,
    label,
    confidence: fact.confidence,
    reason: label === "unknown" ? "change fact subject could not be mapped to a precise impact label" : `change fact ${fact.subjectKind} maps to ${label}`,
    fallbackReason: label === "unknown" ? "unknown impact label requires conservative fallback" : undefined,
    signals: fact.evidence.signals,
    codePlanAtomicLabel: deriveCodePlanAtomicLabel(fact)?.label,
  }
}

export function deriveImpactLabels(facts: ChangeFact[]) {
  return facts.map(deriveImpactLabel)
}

export * as ImpactLabel from "./impact-label"
