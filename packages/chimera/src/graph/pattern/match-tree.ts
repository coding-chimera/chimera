// Ported from ast-grep (MIT) crates/core/src/match_tree/mod.rs and
// crates/core/src/match_tree/match_node.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Chimera adaptation: the Rust `Aggregator` trait (env bind vs. end computation)
// becomes two small TS classes; `Cow<MetaVarEnv>` becomes an explicit clone
// before every bind attempt (ast-grep ast-grep#2670: the ellipsis-end lookahead
// probe must not leak partial metavar bindings).

import type { Node } from '../web-tree-sitter-types'
import type { MetaVariable } from './meta-var'
import { MetaVarEnv, nodeText } from './meta-var'
import type { PatternNode } from './pattern'
import type { MatchOneNode, MatchStrictness } from './strictness'
import {
  areKindsMatching,
  matchTerminal,
  shouldSkipCandForMetavar,
  shouldSkipGoal,
  shouldSkipKind,
  shouldSkipTrailing,
} from './strictness'

/**
 * Cursor over a fixed array, mirroring Rust's `Peekable<slice::Iter>`.
 */
interface Cursor<T> {
  items: T[]
  i: number
}

const peek = <T>(c: Cursor<T>): T | undefined => (c.i < c.items.length ? c.items[c.i] : undefined)
const next = <T>(c: Cursor<T>): T | undefined => (c.i < c.items.length ? c.items[c.i++] : undefined)
/** Drain the rest of the cursor into an array. */
const drain = <T>(c: Cursor<T>): T[] => {
  const rest = c.items.slice(c.i)
  c.i = c.items.length
  return rest
}

type ControlFlow = 'return' | 'continue' | 'fallthrough' | 'fail'

/** Port of the `Aggregator` trait. */
interface Aggregator {
  clone(): Aggregator
  matchTerminal(node: Node): boolean
  matchMetaVar(metaVar: MetaVariable, node: Node): boolean
  matchEllipsis(name: string | null, nodes: Node[], skippedAnonymous: number): boolean
}

/** Aggregator that binds metavariables into a MetaVarEnv (Cow<MetaVarEnv> in Rust). */
class EnvAggregator implements Aggregator {
  constructor(
    readonly env: MetaVarEnv,
    private readonly source: string
  ) {}

  clone(): EnvAggregator {
    return new EnvAggregator(this.env.clone(), this.source)
  }

  matchTerminal(_node: Node): boolean {
    return true
  }

  matchMetaVar(metaVar: MetaVariable, node: Node): boolean {
    return matchLeafMetaVar(metaVar, node, this.env, this.source)
  }

  matchEllipsis(name: string | null, nodes: Node[], skippedAnonymous: number): boolean {
    if (name === null) return true
    const matched = nodes.slice(0, Math.max(0, nodes.length - skippedAnonymous))
    return this.env.insertMulti(name, matched)
  }
}

/** Aggregator that computes the match end offset (ComputeEnd in Rust). */
class EndAggregator implements Aggregator {
  end: number

  constructor(end: number) {
    this.end = end
  }

  clone(): EndAggregator {
    return new EndAggregator(this.end)
  }

  matchTerminal(node: Node): boolean {
    this.end = node.endIndex
    return true
  }

  matchMetaVar(_metaVar: MetaVariable, node: Node): boolean {
    this.end = node.endIndex
    return true
  }

  matchEllipsis(_name: string | null, nodes: Node[], _skipped: number): boolean {
    const last = nodes[nodes.length - 1]
    if (!last) return false
    this.end = last.endIndex
    return true
  }
}

/** Port of `match_leaf_meta_var` in match_tree/mod.rs. */
function matchLeafMetaVar(mv: MetaVariable, candidate: Node, env: MetaVarEnv, source: string): boolean {
  switch (mv.type) {
    case 'capture':
      if (mv.named && !candidate.isNamed) return false
      return env.insert(mv.name, candidate)
    case 'dropped':
      if (mv.named && !candidate.isNamed) return false
      return true
    // Ellipsis is matched at the parent level
    case 'multiple':
      return true
    case 'multi-capture':
      return env.insertMulti(mv.name, [candidate])
  }
}

/**
 * Port of `does_node_match_exactly`: structural equality used for
 * repeated-metavariable equality checks. Collapsed from Rust `Node<D>` onto
 * web-tree-sitter nodes sharing one source string.
 */
export function doesNodeMatchExactly(
  goal: Node,
  candidate: Node,
  source: string
): boolean {
  // return true if goal and candidate are the same node
  if (goal.id === candidate.id) return true
  // gh issue #1087: matching is a little bit permissive — compare node text if
  // at least one node is a named leaf.
  if (isNamedLeaf(goal) || isNamedLeaf(candidate)) {
    return nodeText(goal, source) === nodeText(candidate, source)
  }
  if (goal.type !== candidate.type) return false
  const goalChildren = goal.children
  const candChildren = candidate.children
  if (goalChildren.length !== candChildren.length) return false
  return goalChildren.every((g, i) => doesNodeMatchExactly(g, candChildren[i], source))
}

/** `is_named_leaf`: named node without named children (node.rs, see ast-grep#276). */
export function isNamedLeaf(node: Node): boolean {
  return node.isNamed && node.namedChildCount === 0
}

export type EnvAggregatorHandle = { env: MetaVarEnv; agg: Aggregator }

export function createEnv(source: string): EnvAggregatorHandle {
  const matchesExactly = (a: Node, b: Node) => doesNodeMatchExactly(a, b, source)
  const env = new MetaVarEnv(source, matchesExactly)
  return { env, agg: new EnvAggregator(env, source) }
}

/**
 * Port of `match_root_node_impl`.
 *
 * Smart matching ignores comments inside structured patterns, but a root
 * metavariable represents the candidate itself and must still bind extras.
 */
export function matchRootNodeImpl(
  goal: PatternNode,
  candidate: Node,
  agg: Aggregator,
  strictness: MatchStrictness,
  source: string
): MatchOneNode {
  if (goal.kind === 'metavar' && strictness === 'smart') {
    return agg.matchMetaVar(goal.metaVar, candidate) ? 'matched-both' : 'no-match'
  }
  return matchNodeImpl(goal, candidate, agg, strictness, source)
}

/** Port of `match_node_impl`. */
export function matchNodeImpl(
  goal: PatternNode,
  candidate: Node,
  agg: Aggregator,
  strictness: MatchStrictness,
  source: string
): MatchOneNode {
  if (goal.kind === 'terminal') {
    const result = matchTerminal(strictness, goal, candidate, source)
    if (result === 'matched-both') {
      return agg.matchTerminal(candidate) ? 'matched-both' : 'no-match'
    }
    return result
  }
  if (goal.kind === 'metavar') {
    if (shouldSkipCandForMetavar(strictness, candidate)) return 'skip-candidate'
    return agg.matchMetaVar(goal.metaVar, candidate) ? 'matched-both' : 'no-match'
  }
  const kindMatched =
    shouldSkipKind(strictness) || areKindsMatching(goal.nodeType, goal.isErrorKind, candidate.type)
  if (!kindMatched) return 'no-match'
  const matched = matchNodesImplRecursive(goal.children, candidate.children, agg, strictness, source)
  return matched ? 'matched-both' : 'no-match'
}

/** Port of `match_nodes_impl_recursive`. */
function matchNodesImplRecursive(
  goals: PatternNode[],
  candidates: Node[],
  agg: Aggregator,
  strictness: MatchStrictness,
  source: string
): boolean {
  const goalChildren: Cursor<PatternNode> = { items: goals, i: 0 }
  const candChildren: Cursor<Node> = { items: candidates, i: 0 }
  // cand_children.peek()? — an internal node must have at least one candidate child
  if (!peek(candChildren)) return false
  for (;;) {
    const ellipsis = mayMatchEllipsisImpl(goalChildren, candChildren, agg, strictness, source)
    if (ellipsis === 'fail') return false
    if (ellipsis === 'return') return true
    if (ellipsis !== 'continue') {
      const single = matchSingleNodeWhileSkipTrivial(goalChildren, candChildren, agg, strictness, source)
      if (single === 'fail') return false
      if (single === 'return') return true
      if (single === 'continue') continue
      const consumedGoal = next(goalChildren)
      // if goal runs out, do not proceed cand nodes
      if (consumedGoal !== undefined) next(candChildren)
    }
    // all goal found?
    if (!peek(goalChildren)) {
      return drain(candChildren).every((n) => shouldSkipTrailing(strictness, n))
    }
    if (!peek(candChildren)) return false
  }
}

/**
 * Port of `may_match_ellipsis_impl`. Returns 'fail' when the Rust original
 * propagates None (no match).
 */
function mayMatchEllipsisImpl(
  goalChildren: Cursor<PatternNode>,
  candChildren: Cursor<Node>,
  agg: Aggregator,
  strictness: MatchStrictness,
  source: string
): ControlFlow {
  const curr = peek(goalChildren)
  if (!curr) {
    // in rare case, an internal node's children is empty
    // see https://github.com/ast-grep/ast-grep/issues/1688
    return 'return'
  }
  const optionalName = tryGetEllipsisMode(curr)
  if (optionalName === undefined) return 'fallthrough'
  const matched: Node[] = []
  next(goalChildren)
  // goal has all matched: the ellipsis swallows every remaining candidate
  if (!peek(goalChildren)) {
    return matchEllipsis(agg, optionalName, matched, drain(candChildren), 0)
      ? 'return'
      : 'fail'
  }
  // skip trivial nodes in goal after ellipsis
  let skippedAnonymous = 0
  while ((peek(goalChildren) as PatternNode).isTrivial) {
    next(goalChildren)
    skippedAnonymous += 1
    if (!peek(goalChildren)) {
      return matchEllipsis(agg, optionalName, matched, drain(candChildren), skippedAnonymous)
        ? 'return'
        : 'fail'
    }
  }
  // if next node is also an ellipsis, consume one candidate node as separator
  if (tryGetEllipsisMode(peek(goalChildren) as PatternNode) !== undefined) {
    const sep = next(candChildren)
    if (!sep) return 'fail'
    matched.push(sep)
    if (!peek(candChildren)) return 'fail'
    return matchEllipsis(agg, optionalName, matched, [], skippedAnonymous) ? 'continue' : 'fail'
  }
  for (;;) {
    // Probe the next goal against a cloned aggregator to find the ellipsis end.
    // This prevents failed metavar probes from leaking bindings into the real
    // env (which would make a later, genuine bind of the same metavar conflict
    // and fail). See https://github.com/ast-grep/ast-grep/pull/2670
    const probe = agg.clone()
    if (matchNodeImpl(peek(goalChildren) as PatternNode, peek(candChildren) as Node, probe, strictness, source) === 'matched-both') {
      return matchEllipsis(agg, optionalName, matched, [], skippedAnonymous) ? 'fallthrough' : 'fail'
    }
    const consumed = next(candChildren)
    if (!consumed) return 'fail'
    matched.push(consumed)
    if (!peek(candChildren)) return 'fail'
  }
}

/** Port of `match_single_node_while_skip_trivial`. */
function matchSingleNodeWhileSkipTrivial(
  goalChildren: Cursor<PatternNode>,
  candChildren: Cursor<Node>,
  agg: Aggregator,
  strictness: MatchStrictness,
  source: string
): ControlFlow {
  for (;;) {
    const cand = peek(candChildren)
    if (!cand) {
      // if cand runs out, check remaining goal: if all goals are skippable it
      // is a match, else a non match
      return shouldSkipGoal(strictness, goalChildren) ? 'fallthrough' : 'fail'
    }
    const result = matchNodeImpl(peek(goalChildren) as PatternNode, cand, agg, strictness, source)
    if (result === 'matched-both') return 'fallthrough'
    if (result === 'skip-goal') {
      next(goalChildren)
      if (!peek(goalChildren)) return 'fallthrough'
    } else if (result === 'skip-both') {
      next(candChildren)
      next(goalChildren)
      if (!peek(goalChildren)) return 'fallthrough'
    } else if (result === 'skip-candidate') {
      // skip trivial node
      next(candChildren)
    } else {
      // unmatched significant node
      return 'fail'
    }
  }
}

/**
 * Returns the ellipsis variable name (named $$$A), null (anonymous $$$), or
 * undefined when the node is not an ellipsis.
 * Port of `try_get_ellipsis_mode`.
 */
function tryGetEllipsisMode(node: PatternNode): string | null | undefined {
  if (node.kind !== 'metavar') return undefined
  if (node.metaVar.type === 'multiple') return null
  if (node.metaVar.type === 'multi-capture') return node.metaVar.name
  return undefined
}

function matchEllipsis(
  agg: Aggregator,
  optionalName: string | null,
  matched: Node[],
  rest: Node[],
  skippedAnonymous: number
): boolean {
  // The Rust caller returns Some(()) when this succeeds; the 'return' vs
  // 'fallthrough' distinction is applied by the caller, so this only reports
  // success/failure here.
  matched.push(...rest)
  return agg.matchEllipsis(optionalName, matched, skippedAnonymous)
}

export type { Aggregator }

/**
 * Port of `match_end_non_recursive`: the offset the match actually extends to
 * (ellipsis bindings can reach past the matched node's trailing punctuation).
 */
export function matchEndNonRecursive(
  goal: PatternNode,
  candidate: Node,
  strictness: MatchStrictness,
  source: string
): number | undefined {
  const agg = new EndAggregator(0)
  const result = matchRootNodeImpl(goal, candidate, agg, strictness, source)
  return result === 'matched-both' ? agg.end : undefined
}

/**
 * Port of `match_node_non_recursive`: match at this node only (no descent),
 * binding into the given env. Returns the candidate on success.
 */
export function matchNodeNonRecursive(
  goal: PatternNode,
  candidate: Node,
  envAgg: EnvAggregatorHandle,
  strictness: MatchStrictness,
  source: string
): Node | undefined {
  const result = matchRootNodeImpl(goal, candidate, envAgg.agg, strictness, source)
  return result === 'matched-both' ? candidate : undefined
}

