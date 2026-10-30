// Shared WP-03 oracle types.
//
// A run artifact pairs the WP-02 transcript bytes with a small deterministic
// run envelope. The envelope is what distinguishes a crash/interruption from a
// timeout or an explicit cancellation without inventing new transcript events.

export const RUN_STATUSES = ["complete", "interrupted", "timed_out", "cancelled"] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

export type RunEnvelope = {
  scenario: string
  status: RunStatus
}

export type RunArtifact = {
  envelope: RunEnvelope
  transcript: string
}

// The eight fault classes named by the WP-03 DoD. Order is the matrix order.
export const FAULT_CLASSES = [
  "loss",
  "reorder",
  "duplicate",
  "interruption",
  "partial_write",
  "timeout",
  "cancel",
  "replay",
] as const

export type FaultClass = (typeof FAULT_CLASSES)[number]

export const FAULT_LABELS_ZH: Record<FaultClass, string> = {
  loss: "丢失",
  reorder: "乱序",
  duplicate: "重复",
  interruption: "中断",
  partial_write: "部分写",
  timeout: "超时",
  cancel: "取消",
  replay: "重放",
}

// Stable rejection codes. The eight class codes are the matrix verdicts;
// integrity/causality are secondary comparator rejections that must not be
// confused with a fault-class verdict.
export const FAULT_CODES = {
  loss: "FAULT_LOSS",
  reorder: "FAULT_REORDER",
  duplicate: "FAULT_DUPLICATE",
  interruption: "FAULT_INTERRUPTION",
  partial_write: "FAULT_PARTIAL_WRITE",
  timeout: "FAULT_TIMEOUT",
  cancel: "FAULT_CANCEL",
  replay: "FAULT_REPLAY",
  integrity: "FAULT_INTEGRITY",
  causality: "FAULT_CAUSALITY",
} as const

export type CompareCheck = {
  id: string
  status: "pass" | "fail"
  code: string
}

export type ComparePass = {
  status: "pass"
  checks: CompareCheck[]
}