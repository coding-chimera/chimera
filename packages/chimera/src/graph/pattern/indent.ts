// Ported from ast-grep (MIT) crates/core/src/replacer/indent.rs @ 6f59168e67d4a5df69532fc51e81304a8cfddfe6
// ast-grep is Copyright (c) 2022-2026 Harrison Hanjie Zhou, MIT license.
//
// Indentation-sensitive replacement: extract a captured node's text relative to
// its own indentation, re-indent it to the position it lands in inside the
// replacement, then re-indent the whole replacement to the matched node's
// source indentation. See the Rust module doc comment for the worked example.
//
// Chimera adaptation: the generic `Content` (bytes/UTF-16) machinery collapses
// onto plain JS strings; NEW_LINE/TAB/SPACE are single UTF-16 code units, so
// the same assumptions hold.

export const MAX_LOOK_AHEAD = 512

/** Represents how we de-indent a matched meta var. */
export type DeindentedExtract =
  // If meta-var is only one line, no need to de-indent/re-indent
  | { single: true; text: string }
  // meta-var has multiple lines, may need re-indent
  | { single: false; text: string; indent: number }

/**
 * Port of `extract_with_deindent`: slice `content[start..end]` and record the
 * indentation of the line the slice starts on (for later re-indent).
 */
export function extractWithDeindent(content: string, start: number, end: number): DeindentedExtract {
  const extractSlice = content.slice(start, end)
  // no need to compute indentation for a single line
  if (!extractSlice.includes('\n')) return { single: true, text: extractSlice }
  const indent = getIndentAtOffset(content.slice(0, start))
  return { single: false, text: extractSlice, indent }
}

/**
 * Port of `formatted_slice`: de-indent a slice to column 0, using the source
 * indentation at `start`. (Used by `MetaVarEnv::insert_transformation` upstream;
 * exported for parity with the ported tests.)
 */
export function formattedSlice(slice: string, content: string, start: number): string {
  const extract = slice.includes('\n')
    ? ({ single: false, text: slice, indent: getIndentAtOffset(content.slice(0, start)) } as const)
    : ({ single: true, text: slice } as const)
  return indentLines(0, extract)
}

/**
 * Port of `indent_lines`: re-indent `extract` so its first line sits at column
 * `indent`, preserving the relative layout of the remaining lines.
 */
export function indentLines(indent: number, extract: DeindentedExtract): string {
  if (extract.single) return extract.text
  const { text: lines, indent: originalIndent } = extract
  if (originalIndent === indent) {
    // if old and new indent match, just return old lines
    return lines
  }
  if (originalIndent > indent) {
    // need to strip old indent
    return removeIndent(originalIndent - indent, lines)
  }
  // need to add missing indent
  return addIndent(indent - originalIndent, lines)
}

/** Port of `indent_lines_impl`: the first line never gets an indent. */
function addIndent(indent: number, text: string): string {
  const lines = text.split('\n')
  const leading = ' '.repeat(indent)
  return [lines[0] ?? '', ...lines.slice(1).map((line) => leading + line)].join('\n')
}

/**
 * Port of `remove_indent`.
 * NOTE: we assume input is well indented — following lines should have fewer
 * indentation than the initial line.
 */
function removeIndent(indent: number, text: string): string {
  const indentation = ' '.repeat(indent)
  return text
    .split('\n')
    .map((line) => (line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join('\n')
}

/**
 * Port of `get_indent_at_offset`: returns the number of spaces directly before
 * `src`'s end, 0 if no indent is found before the offset — either truly no
 * indent exists, or the offset is inside a long line beyond MAX_LOOK_AHEAD.
 * TODO (inherited from ast-grep): support TAB. Only whitespace is counted.
 */
export function getIndentAtOffset(src: string): number {
  const lookahead = Math.max(src.length, MAX_LOOK_AHEAD) - MAX_LOOK_AHEAD
  let indent = 0
  for (let i = src.length - 1; i >= lookahead; i--) {
    const c = src[i]
    if (c === '\n') return indent
    if (c === ' ') indent += 1
    else indent = 0
  }
  // lookahead == 0 means we have indentation at the first line
  return lookahead === 0 && indent !== 0 ? indent : 0
}
