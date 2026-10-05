/**
 * Identifier-segment utilities for the name_segment_vocab table (upstream
 * v1.6.1 src/search/identifier-segments.ts port, splitter arm): symbol names
 * split into the words a human would use for them in prose.
 *
 * "OrderStateMachine" → order / state / machine. The FTS index can't serve
 * this shape on its own — the fork's `search_text` split
 * (splitIdentifierWords) is ASCII-only, so Unicode-bearing names lose their
 * accented words — which is why segments are materialized at index time
 * (see db/schema.sql, name_segment_vocab).
 *
 * Upstream also keeps prose-candidate extraction and the prompt-hook gate's
 * stopword list here; the fork lands those pieces only where it has consumers.
 */

/** Bounds keep degenerate identifiers (minified names, hashes) from bloating
 *  the vocab: segments outside them carry no prose signal anyway. */
const MIN_SEGMENT_CHARS = 2;
const MAX_SEGMENT_CHARS = 32;
const MAX_SEGMENTS_PER_NAME = 12;

/**
 * Split a symbol or file name into lowercase word segments.
 *
 * Handles camelCase / PascalCase (inner lower→Upper), acronym runs
 * ("HTMLParser" → html/parser), snake_case / kebab-case / dotted file names
 * (non-alphanumerics separate), and keeps digits glued to their word
 * ("base64Encode" → base64/encode). Digit-only fragments are dropped.
 */
export function splitIdentifierSegments(name: string): string[] {
  if (!name) return [];
  const out = new Set<string>();
  for (const run of name.match(/[\p{L}\p{N}]+/gu) ?? []) {
    // Split before an Upper that follows lower/digit (camelCase hump), and
    // before the last Upper of an acronym run when a lowercase follows
    // ("HTMLParser" → HTML | Parser).
    const parts = run.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
    for (const part of parts) {
      if (out.size >= MAX_SEGMENTS_PER_NAME) return [...out];
      const seg = part.toLowerCase();
      if (seg.length < MIN_SEGMENT_CHARS || seg.length > MAX_SEGMENT_CHARS) continue;
      if (/^\p{N}+$/u.test(seg)) continue;
      out.add(seg);
    }
  }
  return [...out];
}
