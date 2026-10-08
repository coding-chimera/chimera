// Ported from ast-grep (MIT) crates/core/src/matcher/text.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Chimera adaptation: ast-grep's RegexMatcher is a `Matcher` over Doc/Node;
// collapsed here to a predicate over a node's text (web-tree-sitter `Node` +
// source string). Regex dialect note: ast-grep uses the Rust `regex` crate;
// JS RegExp is close enough for the text-matcher surface and is what the
// future ast_edit tool will pass through.

import type { Node } from '../web-tree-sitter-types'
import { nodeText } from './meta-var'

export interface RegexMatcherError {
  readonly kind: 'invalid-regex'
  readonly message: string
}

export class RegexMatcher {
  private readonly regex: RegExp

  private constructor(regex: RegExp) {
    this.regex = regex
  }

  static tryNew(pattern: string): { ok: true; matcher: RegexMatcher } | { ok: false; error: RegexMatcherError } {
    // RegExp has no side-effect-free constructor probe in JS; a failed
    // construction is the only way to detect an invalid pattern.
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (cause) {
      return {
        ok: false,
        error: { kind: 'invalid-regex', message: `Parsing text matcher fails: \`${pattern}\` (${String(cause)})` },
      }
    }
    return { ok: true, matcher: new RegexMatcher(regex) }
  }

  /** Port of `Matcher::match_node_with_env` (env is never touched). */
  matchNode(node: Node, source: string): Node | undefined {
    return this.regex.test(nodeText(node, source)) ? node : undefined
  }

  matchText(text: string): boolean {
    return this.regex.test(text)
  }
}
