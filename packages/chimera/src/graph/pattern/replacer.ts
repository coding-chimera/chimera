// Ported from ast-grep (MIT):
// - crates/core/src/replacer/template.rs
// - crates/core/src/replacer/structural.rs
// - `split_first_meta_var`/`MetaVarExtract` from crates/core/src/replacer.rs
// @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Chimera adaptation: replacers consume the materialized `PatternMatch`
// captures (see pattern.ts) instead of a live `NodeMatch` over a Doc, and all
// byte arrays collapse to JS strings. `MetaVarExtract::Transformed` (rule
// `transform:` rewrites) is not ported for v1. `applyReplacements` corresponds
// to ast-grep's source `Edit` splicing (`crates/core/src/source.rs` Edit +
// cli fixer ordering), reimplemented over UTF-16 string ranges with overlap
// detection.

import type { Node } from '../web-tree-sitter-types'
import { getParser } from '../extraction/grammars'
import type { Language } from '../types'
import { expandoChar, extractMetaVar, preprocessPattern } from './meta-var'
import { isNamedLeaf } from './match-tree'
import type { PatternCapture, PatternMatch } from './pattern'
import type { DeindentedExtract } from './indent'
import { getIndentAtOffset, indentLines } from './indent'

/** A single splice into the source string. Ranges are UTF-16 code-unit indices. */
export interface PatternEdit {
  start: number
  end: number
  replacement: string
}

/** Build the edit for a match (uses the ellipsis-extended replacedRange). */
export function editForMatch(match: PatternMatch, replacement: string): PatternEdit {
  return { start: match.replacedRange.start, end: match.replacedRange.end, replacement }
}

/**
 * Apply edits to `source` in reverse order. Edits must not overlap; throws an
 * Error identifying both offending edits.
 */
export function applyReplacements(source: string, edits: PatternEdit[]): string {
  const sorted = edits.map((edit, index) => ({ edit, index })).sort((a, b) => a.edit.start - b.edit.start)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].edit
    const curr = sorted[i].edit
    if (curr.start < prev.end) {
      throw new Error(
        `Overlapping replacements: edit #${sorted[i - 1].index} [${prev.start}, ${prev.end}) intersects edit #${sorted[i].index} [${curr.start}, ${curr.end})`
      )
    }
  }
  let out = source
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { start, end, replacement } = sorted[i].edit
    out = out.slice(0, start) + replacement + out.slice(end)
  }
  return out
}

// ---------------------------------------------------------------------------
// Template replacement ("text with $VAR holes", indent-aware)
// ---------------------------------------------------------------------------

type MetaVarExtract =
  | { type: 'single'; name: string }
  // $$$A for captured ellipsis
  | { type: 'multiple'; name: string }

interface Template {
  fragments: string[]
  vars: Array<{ extract: MetaVarExtract; indent: number }>
}

type TemplateFix = { textual: true; text: string } | { textual: false; template: Template }

/**
 * Port of `split_first_meta_var`: recognize `$NAME` / `$$$NAME` at the start of
 * `src` (which must begin with `metaChar`). Returns the variable and the number
 * of code units consumed, or undefined when the run is not a valid metavariable.
 */
export function splitFirstMetaVar(src: string, metaChar: string): { extract: MetaVarExtract; skipped: number } | undefined {
  let i = 0
  let skipped = 0
  let isMulti = false
  for (;;) {
    i += 1
    skipped += metaChar.length
    if (i === 3) {
      isMulti = true
      break
    }
    if (!src.startsWith(metaChar, skipped)) break
  }
  // no anonymous meta var allowed in templates ($$/$$$ bare) so `_` names still
  // parse like ast-grep: the name continues while is_valid_meta_var_char holds.
  let nameLen = 0
  while (nameLen < src.length - skipped && isValidNameChar(src[skipped + nameLen])) nameLen++
  // no name found
  if (nameLen === 0) return undefined
  const name = src.slice(skipped, skipped + nameLen)
  const extract: MetaVarExtract = isMulti ? { type: 'multiple', name } : { type: 'single', name }
  return { extract, skipped: skipped + nameLen }
}

// mirrors meta_var.rs is_valid_meta_var_char (uppercase, digit, underscore)
const isValidNameChar = (c: string) => (c >= 'A' && c <= 'Z') || c === '_' || (c >= '0' && c <= '9')

/** Port of `create_template`. */
function createTemplate(tmpl: string): TemplateFix {
  const mvChar = '$' // templates always use the meta-var char, not the expando
  const fragments: string[] = []
  const vars: Template['vars'] = []
  let len = 0
  let offset = 0
  for (;;) {
    const search = tmpl.indexOf(mvChar, len + offset)
    if (search < 0) break
    const split = splitFirstMetaVar(tmpl.slice(search), mvChar)
    if (split) {
      fragments.push(tmpl.slice(len, search))
      // NB we have to count indent of the full string
      const indent = getIndentAtOffset(tmpl.slice(0, search))
      vars.push({ extract: split.extract, indent })
      len = search + split.skipped
      offset = 0
      continue
    }
    // not a metavariable: skip this single '$' occurrence
    offset = search - len + 1
  }
  if (fragments.length === 0) {
    return { textual: true, text: tmpl.slice(len) }
  }
  fragments.push(tmpl.slice(len))
  return { textual: false, template: { fragments, vars } }
}

/** Port of `maybe_get_var` (Transformed branch omitted in v1). */
function maybeGetVar(
  extract: MetaVarExtract,
  indent: number,
  captures: Map<string, PatternCapture>
): string | undefined {
  const capture = captures.get(extract.name)
  if (!capture || capture.nodes.length === 0) return undefined
  // ast-grep parity: `$A` fills only single captures, `$$$A` only multi captures
  if ((extract.type === 'single') === capture.multi) return undefined
  // port of `extract_with_deindent(source, range)`, using the sourceIndent
  // recorded on the capture at match time
  const deindented: DeindentedExtract = capture.text.includes('\n')
    ? { single: false, text: capture.text, indent: capture.sourceIndent }
    : { single: true, text: capture.text }
  return indentLines(indent, deindented)
}

/** Port of `replace_fixer`. */
function replaceFixer(fixer: TemplateFix, captures: Map<string, PatternCapture>): string {
  if (fixer.textual) return fixer.text
  const { fragments, vars } = fixer.template
  let ret = fragments[0] ?? ''
  for (let i = 0; i < vars.length; i++) {
    const value = maybeGetVar(vars[i].extract, vars[i].indent, captures)
    if (value !== undefined) ret += value
    ret += fragments[i + 1] ?? ''
  }
  return ret
}

/**
 * Render a replacement template against a match, with indentation preserved:
 * captures are de-indented from their source position, placed at the template
 * hole's column, and the whole render is re-indented to the matched node's
 * source indentation. Port of `impl Replacer for TemplateFix` +
 * `template::gen_replacement`.
 *
 * `lang`'s meta_var_char is '$' for all v1 languages; templates always use
 * `$`-sigil metavariables (not the expando char).
 */
export function renderTemplateReplacement(
  template: string,
  match: PatternMatch,
  source: string
): string {
  const fixer = createTemplate(template)
  const leading = source.slice(0, match.range.start)
  const indent = getIndentAtOffset(leading)
  const replaced = replaceFixer(fixer, match.captures)
  // the rendered template gets the matched node's source indentation
  const extract = replaced.includes('\n')
    ? ({ single: false, text: replaced, indent: 0 } as const)
    : ({ single: true, text: replaced } as const)
  return indentLines(indent, extract)
}

/**
 * Variables referenced by a template (port of `TemplateFix::used_vars`).
 */
export function templateUsedVars(template: string): Set<string> {
  const fixer = createTemplate(template)
  const names = new Set<string>()
  if (fixer.textual) return names
  fixer.template.vars.forEach(({ extract }) => names.add(extract.name))
  return names
}

// ---------------------------------------------------------------------------
// Structural replacement (replacement written as a pattern tree)
// ---------------------------------------------------------------------------

/**
 * Port of `structural::gen_replacement` (`Root` as Replacer): parse
 * `template` as code in `lang` (after expando pre-processing), replace every
 * named-leaf metavariable token with the capture's source text, and keep all
 * other template text — punctuation, keywords — verbatim.
 *
 * Unlike the template replacer there is no de/re-indent pass, matching the
 * original (structural replacement is used for same-shape rewrites).
 */
export function renderStructuralReplacement(
  template: string,
  match: PatternMatch,
  lang: Language
): string {
  const expando = expandoChar(lang)
  const processed = preprocessPattern(template, expando)
  const parser = getParser(lang)
  if (!parser) throw new Error(`Grammar for language \`${lang}\` is not loaded; await ensureGrammarLoaded first.`)
  const tree = parser.parse(processed)
  if (!tree) throw new Error(`Structural replacement template failed to parse: ${template}`)
  try {
    const edits: Array<{ start: number; end: number; text: string }> = []
    const collectEdits = (node: Node) => {
      const replaced = getMetaVarReplacement(node, processed, expando, match.captures)
      if (replaced !== undefined) {
        edits.push({ start: node.startIndex, end: node.endIndex, text: replaced })
        return
      }
      for (const child of node.children) {
        if (!child.isMissing) collectEdits(child)
      }
    }
    collectEdits(tree.rootNode)
    // merge_edits_to_vec: copy template source between edits, splicing in capture text
    let ret = ''
    let start = 0
    for (const edit of edits) {
      ret += processed.slice(start, edit.start)
      ret += edit.text
      start = edit.end
    }
    ret += processed.slice(start, tree.rootNode.endIndex)
    return ret
  } finally {
    tree.delete()
  }
}

/** Port of `get_meta_var_replacement`. */
function getMetaVarReplacement(
  node: Node,
  templateSrc: string,
  expando: string,
  captures: Map<string, PatternCapture>
): string | undefined {
  if (!isNamedLeaf(node)) return undefined
  const metaVar = extractMetaVar(templateSrc.substring(node.startIndex, node.endIndex), expando)
  if (!metaVar) return undefined
  // ast-grep parity in get_var_bytes_impl: Capture reads single matches,
  // MultiCapture reads multi matches.
  if (metaVar.type === 'capture') {
    const capture = captures.get(metaVar.name)
    return capture && !capture.multi ? capture.text : undefined
  }
  if (metaVar.type === 'multi-capture') {
    const capture = captures.get(metaVar.name)
    return capture && capture.multi ? capture.text : undefined
  }
  return undefined
}
