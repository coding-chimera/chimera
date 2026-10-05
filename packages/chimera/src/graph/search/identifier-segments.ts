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

/**
 * English query/prose words that are never evidence a symbol was NAMED,
 * however rare their name happens to be in a given repo: function words,
 * filler, hyper-common dev verbs, and words ABOUT code rather than OF it
 * ("rename this file", "there's an issue"). Measured FPs that motivated this
 * upstream: "fix THIS typo" matched `resolveDeferredThisMemberRefs`, "WRITE a
 * haiku" matched `writeConfig`.
 *
 * English-only ON PURPOSE: identifiers are written in English, so only
 * English prose words can accidentally collide with symbol names. Other
 * languages' function words ("avec", "pendant", "dieser") don't match
 * anything and need no list. Domain nouns ("state", "checkout", "order")
 * stay OUT — they are exactly the signal.
 *
 * Fork consumer: handleExplore's named-symbol seeder guards its bare-token
 * path with this list (upstream guards that path with its fileNameSets/
 * corroboration system, which the fork does not carry).
 */
const ENGLISH_PROSE_STOPWORDS = new Set([
  'about', 'above', 'actually', 'after', 'again', 'against', 'almost', 'along', 'also', 'always',
  'another', 'anything', 'around', 'away', 'back', 'because', 'been', 'before', 'behind', 'being',
  'below', 'best', 'better', 'between', 'both', 'cannot', 'come', 'could', 'does', 'doing', 'done',
  'down', 'each', 'either', 'else', 'even', 'ever', 'every', 'everything', 'fine', 'first', 'from',
  'getting', 'give', 'goes', 'going', 'gone', 'good', 'great', 'have', 'having', 'help', 'here',
  'inside', 'instead', 'into', 'just', 'keep', 'know', 'last', 'least', 'less', 'like', 'likely',
  'little', 'look', 'looking', 'made', 'make', 'making', 'many', 'maybe', 'mind', 'more', 'most',
  'much', 'must', 'need', 'needs', 'never', 'next', 'nice', 'none', 'nothing', 'okay', 'only',
  'onto', 'other', 'otherwise', 'over', 'please', 'pretty', 'probably', 'quite', 'rather', 'really',
  'right', 'same', 'seem', 'seems', 'should', 'show', 'since', 'some', 'someone', 'something',
  'somewhere', 'soon', 'still', 'such', 'sure', 'take', 'than', 'thank', 'thanks', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'though',
  'tried', 'tries', 'trying', 'under', 'until', 'upon', 'very', 'want', 'wants', 'well', 'went',
  'were', 'what', 'when', 'which', 'while', 'will', 'wish', 'with', 'within', 'without', 'would',
  'wrong', 'your', 'yours',
  // words ABOUT code, not OF it — present in a huge share of queries while
  // almost never naming the symbol the user means
  'again', 'change', 'changes', 'check', 'class', 'classes', 'code', 'detail', 'details',
  'directory', 'error', 'errors', 'example', 'examples', 'file', 'files', 'folder', 'function',
  'functions', 'issue', 'issues', 'line', 'lines', 'method', 'methods', 'name', 'names', 'problem',
  'problems', 'project', 'question', 'questions', 'rename', 'test', 'tests', 'type', 'types',
  'update', 'value', 'values', 'warning', 'warnings', 'work', 'working', 'write', 'writing',
]);

/** True when the (already-lowercased) word is an English prose stopword that
 *  must never seed a symbol search. */
export function isEnglishProseStopword(word: string): boolean {
  return ENGLISH_PROSE_STOPWORDS.has(word);
}
