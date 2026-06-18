import type { ChangeFact } from "./change-classifier"

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

export type ImpactLabelResult = {
  fact: ChangeFact
  label: ImpactLabel
  confidence: number
  reason: string
  fallbackReason?: string
  bodyEffect?: BodyImpactEffect
  signals: string[]
}

function changedNode(fact: ChangeFact) {
  return fact.evidence.afterNode ?? fact.evidence.beforeNode ?? null
}

function signalKinds(fact: ChangeFact) {
  return new Set((fact.evidence.languageSignals ?? []).map((signal) => signal.kind))
}

function hasSignal(fact: ChangeFact, kind: string) {
  return signalKinds(fact).has(kind as never)
}

function bodyEffect(fact: ChangeFact): BodyImpactEffect {
  const kinds = signalKinds(fact)
  if (kinds.has("local_only_change")) return "local_only"
  if (kinds.has("unknown_body_effect")) return "unknown_body_effect"
  return "caller_visible"
}

function bodyLabel(fact: ChangeFact): ImpactLabelResult {
  const effect = bodyEffect(fact)
  return {
    fact,
    label: "method_body",
    confidence: fact.confidence,
    reason: effect === "local_only" ? "body change is local-only by language-aware signal" : effect === "unknown_body_effect" ? "body change has unknown caller-visible effect" : "body change has caller-visible language-aware signal or fallback confidence",
    bodyEffect: effect,
    fallbackReason: effect === "unknown_body_effect" ? "unknown_body_effect requires conservative fallback" : undefined,
    signals: fact.evidence.signals,
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
  }
}

export function deriveImpactLabels(facts: ChangeFact[]) {
  return facts.map(deriveImpactLabel)
}

export * as ImpactLabel from "./impact-label"
