// Ported from ast-grep (MIT) crates/core/src/match_tree/strictness.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Chimera adaptation: kind ids (u16) are replaced by web-tree-sitter node `type`
// strings plus an `isErrorKind` flag; `kind_utils::are_kinds_matching` becomes
// `areKindsMatching`. ast-grep's default Pattern strictness is Smart; that is
// the default in this port (compilePattern allows overriding for tests).

import type { Node } from '../web-tree-sitter-types'
import type { PatternNode } from './pattern'
import { nodeText } from './meta-var'

export type MatchStrictness = 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature' | 'template'

export type MatchOneNode = 'matched-both' | 'skip-both' | 'skip-goal' | 'skip-candidate' | 'no-match'

/** tree-sitter builtin ERROR symbol id (65535); a pattern ERROR kind matches any candidate. */
export function isErrorKind(nodeType: string): boolean {
  return nodeType === 'ERROR'
}

export function areKindsMatching(goalType: string, goalIsError: boolean, candidateType: string): boolean {
  return goalIsError || goalType === candidateType
}

const skipComment = (node: Node) => node.isExtra

const skipCommentOrUnnamed = (node: Node) => !node.isNamed || skipComment(node)

const shouldSkipComment = (s: MatchStrictness) => s !== 'cst' && s !== 'ast'

export function shouldSkipKind(s: MatchStrictness): boolean {
  return s === 'template'
}

export function matchTerminal(
  s: MatchStrictness,
  goal: { text: string; isNamed: boolean; nodeType: string },
  candidate: Node,
  source: string
): MatchOneNode {
  const isKindMatched = areKindsMatching(goal.nodeType, isErrorKind(goal.nodeType), candidate.type)
  // work around ast-grep/ast-grep#1419 and tree-sitter-typescript#306:
  // tree-sitter-typescript has a wrong span for unnamed nodes, so compare only
  // the kind for unnamed goal terminals.
  if (isKindMatched && (!goal.isNamed || goal.text === nodeText(candidate, source))) {
    return 'matched-both'
  }
  if (shouldSkipComment(s) && skipComment(candidate)) return 'skip-candidate'
  let skipGoal = false
  let skipCandidate = false
  switch (s) {
    case 'cst':
      break
    case 'smart':
      skipCandidate = !candidate.isNamed
      break
    case 'ast':
    case 'relaxed':
      skipGoal = !goal.isNamed
      skipCandidate = !candidate.isNamed
      break
    case 'signature':
      if (isKindMatched) return 'matched-both'
      skipGoal = !goal.isNamed
      skipCandidate = !candidate.isNamed
      break
    case 'template':
      if (goal.text === nodeText(candidate, source)) return 'matched-both'
      skipCandidate = !candidate.isNamed
      break
  }
  if (skipGoal && skipCandidate) return 'skip-both'
  if (skipGoal) return 'skip-goal'
  if (skipCandidate) return 'skip-candidate'
  return 'no-match'
}

export function shouldSkipCandForMetavar(s: MatchStrictness, candidate: Node): boolean {
  return shouldSkipComment(s) && skipComment(candidate)
}

/**
 * Workaround for trailing nodes after a pattern is matched (ast-grep
 * `should_skip_trailing`).
 */
export function shouldSkipTrailing(s: MatchStrictness, candidate: Node): boolean {
  switch (s) {
    case 'cst':
      return false
    case 'smart':
      return true
    case 'ast':
      return !candidate.isNamed
    case 'relaxed':
    case 'signature':
      return skipCommentOrUnnamed(candidate)
    case 'template':
      return skipComment(candidate)
  }
}

/**
 * Whether the remaining (trailing) goal children can be skipped when the
 * candidate runs out. Consumes every skippable goal.
 * Port of `MatchStrictness::should_skip_goal`.
 */
export function shouldSkipGoal(
  s: MatchStrictness,
  goalChildren: { items: PatternNode[]; i: number }
): boolean {
  while (goalChildren.i < goalChildren.items.length) {
    const pattern = goalChildren.items[goalChildren.i]
    let skipped = false
    switch (s) {
      case 'cst':
        skipped = false
        break
      case 'smart':
      case 'template':
        skipped =
          pattern.kind === 'metavar' &&
          (pattern.metaVar.type === 'multiple' || pattern.metaVar.type === 'multi-capture')
        break
      case 'ast':
      case 'relaxed':
      case 'signature':
        if (pattern.kind === 'metavar') {
          const mv = pattern.metaVar
          skipped =
            mv.type === 'multiple' ||
            mv.type === 'multi-capture' ||
            (mv.type === 'dropped' && !mv.named) ||
            (mv.type === 'capture' && !mv.named)
        } else {
          skipped = pattern.kind === 'terminal' && !pattern.isNamed
        }
        break
    }
    if (!skipped) return false
    goalChildren.i += 1
  }
  return true
}
