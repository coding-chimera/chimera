/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping } from './types';
import { LRUCache } from './lru-cache';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';
import { JS_BUILT_INS, TS_PRIMITIVE_TYPES } from './js-builtins';

// Names defined more than this many times are never guessed by fuzzy scoring:
// K definitions x K references is O(K²) work and stalls indexing on vendored/
// duplicated code. Precise strategies (qualified name, imports, class names)
// still resolve before this ceiling is consulted.
const DEFAULT_AMBIGUOUS_NAME_CEILING = 500;

function resolveAmbiguousNameCeiling(): number {
  const raw = process.env.CODEGRAPH_AMBIGUOUS_NAME_CEILING;
  const value = raw === undefined ? DEFAULT_AMBIGUOUS_NAME_CEILING : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AMBIGUOUS_NAME_CEILING;
}

const AMBIGUOUS_NAME_CEILING = resolveAmbiguousNameCeiling();

// ===========================================================================
// K-v2 P5-1 / D8: cross-file pseudo-edge defenses ported from upstream N.
// Layering (INVENTORY D8 adjudication): these N rules run as CANDIDATE
// PRE-FILTERS inside the name strategies and as a POST-RANK winner rejection
// (isCrossFileReachable in matchByExactName/matchFuzzy, isVisibleAcrossFiles
// in ReferenceResolver.resolveOne). The fork's import-aware veto below and the
// three-layer same-name disambiguation keep their existing skeleton slots.
// An N rejection is FINAL: the reference stays unresolved — a rejected winner
// never promotes a runner-up (the anti-promotion discipline N's own pipeline
// documents: "Reachability may reject a unique guess; it must never
// manufacture one").
// ===========================================================================

/** Languages whose module boundary is `import`/`export` (or CommonJS). */
const ESM_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/**
 * A line-initial `import` statement — the marker that a JS/TS file is a MODULE
 * rather than a classic script. Line-anchored and followed by a name, brace,
 * star or quote, so a dynamic `import(` and the word inside a comment or string
 * do not match.
 */
const HAS_IMPORT_STATEMENT = /^[ \t]*import[\s{*'"]/m;

/**
 * Anything the file could offer another file, in every form the extractor's own
 * `isExported` flag misses. `^export` covers the declaration and later forms
 * (`export const`, `export { x }`, `export default x`, `export *`); the
 * CommonJS shapes cover files that never use ESM syntax at all, in both the dot
 * and the bracket form; and `declare global` contributes names to every file
 * whether or not the module exports anything of its own. Kept as a source test
 * rather than a node scan precisely because `isExported` is set only from an
 * `export_statement` ancestor, so `const x = …; export { x }` and
 * `module.exports = { x }` both read as unexported on the node.
 */
const HAS_ESM_EXPORT = /^[ \t]*export[\s{*]|^[ \t]*declare\s+global\b/m;
const HAS_CJS_EXPORT = /\bmodule\.exports\b|\bexports\s*[.[]/;

/**
 * Per-context memo of "this file is a module that exports nothing", asked once
 * per candidate FILE rather than once per reference. Derived from file source,
 * so it drops with the context's file caches — clearNameMatcherMemos deletes it.
 */
const SEALED_MODULES = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether `filePath` is a JS/TS module that exports NOTHING — an import
 * statement present, no export of any form. No reference from another file can
 * reach any binding in such a file, so every one of its symbols is a false
 * candidate for a cross-file name match (upstream #1719: on vitejs/vite, 157
 * cross-file `import { defineConfig } from 'vite'` refs resolved onto a
 * zero-export playground file's module-scope `const vite = await createServer(…)`).
 *
 * Deliberately narrow on three axes:
 * - A classic script is exempt (no `import` statement → top-level bindings are
 *   genuinely reachable).
 * - CommonJS is exempt (`module.exports` / `exports.x` count as exports).
 * - Other languages are exempt (no equivalent module boundary).
 */
function isSealedModule(filePath: string, context: ResolutionContext): boolean {
  let memo = SEALED_MODULES.get(context);
  if (!memo) {
    memo = new Map();
    SEALED_MODULES.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit !== undefined) return hit;
  const source = context.readFile?.(filePath) ?? null;
  const code = source === null ? '' : blankStringContents(stripCommentsForRegex(source, 'typescript'));
  // CommonJS assignments can execute inside template interpolations, which the
  // masker blanks. Keep the conservative raw-source exemption for those forms.
  const sealed =
    source !== null && HAS_IMPORT_STATEMENT.test(code) &&
    !context.getNodesInFile(filePath).some((n) => n.isExported) &&
    !HAS_ESM_EXPORT.test(code) && !HAS_CJS_EXPORT.test(source);
  memo.set(filePath, sealed);
  return sealed;
}

/**
 * Whether `candidate` can be named by a reference in `ref`'s file at all
 * (ESM-family module-boundary guards + markdown/JSON call-target guards,
 * upstream #1719). Both name-based strategies validate their chosen candidate
 * with this: removing an unreachable candidate before ranking can promote an
 * unrelated runner-up; rejecting the chosen target must leave the reference
 * unresolved instead.
 */
function isCrossFileReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  if ((ref.language as string) !== 'markdown' && (candidate.language as string) === 'markdown') return false;
  if (ref.referenceKind === 'calls' && ESM_FAMILY.has(candidate.language) &&
    (candidate.kind === 'constant' || candidate.kind === 'variable') &&
    /^=\s*require\s*\(\s*(['"])[^'"]+\.json\1\s*\)\s*;?\s*$/.test(candidate.signature ?? '')) return false;
  return (
    candidate.filePath === ref.filePath ||
    !ESM_FAMILY.has(candidate.language) ||
    !isSealedModule(candidate.filePath, context)
  );
}

/**
 * Languages in which `visibility: 'private'` on a definition means no other
 * FILE can name it: a Kotlin `private fun` is file- or class-local, and the
 * same holds for Java, C#, Swift, Scala, Dart and PHP members.
 */
const PRIVATE_IS_FILE_LOCAL = new Set<string>(['kotlin', 'java', 'csharp', 'swift', 'scala', 'dart', 'php']);

/** Per-context memo: node id → "this C/C++ function is declared `static`". */
const C_STATIC_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * A C/C++ file that IS a translation unit. A `static` defined here is local
 * to it. A `static` (typically `static inline`) in a header is a different
 * thing: the header is textually included, so the function exists in every
 * unit that includes it and is callable from each (upstream #1730: MAVLink's
 * generated `mavlink_msg_*.h`; 145 false cross-file calls on one betaflight
 * tree before this rule).
 */
const C_SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;

/**
 * Whether a C/C++ function definition carries the `static` storage class —
 * read from its first source line(s), since the extractor records no storage
 * class. `static` on the line above the name (`static void\nfoo(void)`) is
 * the common alternative layout.
 */
function isStaticCFunction(candidate: Node, context: ResolutionContext): boolean {
  let memo = C_STATIC_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    C_STATIC_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile?.(candidate.filePath)?.split('\n') ?? [];
  const head = [lines[candidate.startLine - 2] ?? '', lines[candidate.startLine - 1] ?? ''].join('\n');
  const isStatic = /(^|[\s;}])static\s/.test(head);
  memo.set(candidate.id, isStatic);
  return isStatic;
}

/** Per-context memo: node id → "this Rust method implements a trait". */
const RUST_TRAIT_IMPL_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a Rust method sits in an `impl Trait for Type` block. Such a method
 * carries no `pub` — the trait decides its visibility — so the extractor
 * records it as private; it is reachable wherever the trait is. Read from the
 * nearest enclosing `impl` header above the method, memoised per node.
 */
function isRustTraitImplMethod(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.kind !== 'method') return false;
  let memo = RUST_TRAIT_IMPL_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    RUST_TRAIT_IMPL_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile?.(candidate.filePath)?.split('\n') ?? [];
  let isTrait = false;
  for (let i = candidate.startLine - 2; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/^\s*(pub(\([^)]*\))?\s+)?(unsafe\s+)?impl\b/.test(line)) {
      isTrait = /\sfor\s/.test(line.replace(/\/\/.*$/, ''));
      break;
    }
    // A top-level item above the method means it was not inside an impl.
    if (/^(pub(\([^)]*\))?\s+)?(fn|struct|enum|mod|trait|const|static|type)\b/.test(line)) break;
  }
  memo.set(candidate.id, isTrait);
  return isTrait;
}

/**
 * The directory a Rust file's private items are visible from: the file's own
 * module subtree. `src/net.rs` and `src/net/mod.rs` own `src/net/`; a crate
 * root (`lib.rs` / `main.rs`) owns its directory. A child module reaches its
 * ancestors' private items (`super::`), a sibling or another crate never does.
 */
function rustModuleDir(filePath: string): string {
  const base = path.posix.basename(filePath);
  const dir = path.posix.dirname(filePath);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.posix.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * Whether `candidate` can be NAMED from a reference in `ref`'s file at all,
 * given what its language says about the definition's visibility (upstream
 * #1745/#1730/#1719 family). A definition the language makes file-local is
 * not a candidate for a cross-file name match, however well the names agree:
 *
 * - C / C++: a `static` function defined in a SOURCE file is local to that
 *   translation unit; one in a header stays visible (#1730).
 * - Kotlin, Java, C#, Swift, Scala, Dart, PHP: `private` is class- or
 *   file-local.
 * - Go: an unexported (lowercase) identifier is package-local, and a package
 *   is a directory. Judged by the name's case: the extractor's `isExported`
 *   is unset for every Go method.
 * - Rust: a non-`pub` item is visible to its module and that module's
 *   descendants, never to a sibling module or another crate. A method in an
 *   `impl Trait for Type` block has the trait's visibility, not `private`.
 * - JS / TS / ArkTS: a binding in a module that exports nothing is sealed
 *   (#1719). Classic scripts, CommonJS, later `export { … }`, and ambient
 *   globals stay visible.
 *
 * Same-file candidates are always visible. Applied by ReferenceResolver to
 * the target the whole name-matching pipeline settled on, so a rejection
 * ends the reference unresolved (never a promoted runner-up); the name
 * strategies additionally check their own survivors.
 */
export function isVisibleAcrossFiles(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (candidate.filePath === ref.filePath) return true;
  const lang = candidate.language as string;
  if (lang === 'c' || lang === 'cpp') {
    return (
      candidate.kind !== 'function' ||
      !C_SOURCE_EXT.test(candidate.filePath) ||
      !isStaticCFunction(candidate, context)
    );
  }
  if (lang === 'go') {
    // By the name's first letter, not the extractor's flag: the flag is unset
    // for every Go method, exported or not.
    return /^[A-Z]/.test(candidate.name) || path.posix.dirname(candidate.filePath) === path.posix.dirname(ref.filePath);
  }
  if (lang === 'rust') {
    if (candidate.visibility !== 'private') return true;
    if (isRustTraitImplMethod(candidate, context)) return true;
    const owner = rustModuleDir(candidate.filePath);
    return ref.filePath.startsWith(owner + '/');
  }
  if (PRIVATE_IS_FILE_LOCAL.has(lang)) return candidate.visibility !== 'private';
  // JS/TS/ArkTS sealed modules + markdown/JSON call-target guards (#1719).
  return isCrossFileReachable(candidate, ref, context);
}

const JS_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * Whether a JS/TS `calls` ref is a RECEIVER-LESS call — `serialize(x)`, not
 * `this.serialize(x)` / `obj.serialize(x)`. The extractor emits `this.m()`
 * and `super.m()` under the bare method name, so the receiver is read back
 * from the call site's own line: the text at the ref's column is the call
 * expression, and it starts with the name itself only when nothing precedes
 * it. In JS/TS a bare call can never bind to a class method (methods need a
 * receiver), so a `method` node is not a candidate for it (upstream #1714) —
 * the enclosing method itself least of all, which the same-file proximity
 * term used to pick over the module-scope function the call actually means.
 */
function isBareJsCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls' || !JS_FAMILY.has(ref.language)) return false;
  if (ref.referenceName.includes('.')) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile?.(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  const at = line.slice(ref.column);
  const nameEsc = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp('^' + nameEsc + '\\s*[(<]').test(at)) return false;
  // Nothing but whitespace, an operator or an opener may precede a bare call.
  return !/[.\w$\]\)]\s*$/.test(line.slice(0, ref.column)) || /\b(?:return|await|yield|typeof|void|new|else|case|throw|in|of|instanceof)\s*$/.test(line.slice(0, ref.column));
}

/** Per-context memo: `file\0name` → "the file binds this name locally". */
const LOCAL_BINDING_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a JS/TS file binds `name` itself — as a `const`/`let`/`var`/
 * `function`/`class` declaration (destructuring included) or as a parameter
 * of a function or arrow. Such a binding shadows every same-named symbol in
 * other files, so a bare call to it has no cross-file candidate: the
 * `resolve` of `new Promise((resolve, reject) => …)`, a spec's
 * `const transform = await makeTransform()`, a factory's `const now =
 * options.now || (() => new Date())`. None of these is a node the graph
 * holds (a parameter, a const bound to a call result), so without this the
 * matcher hands the call to whichever other file defines the name — and
 * once methods stop being candidates for a bare call (#1714), the function
 * that was out-ranked steps in. Read from source, memoised per file+name.
 */
function isLocallyBoundJsName(name: string, filePath: string, context: ResolutionContext): boolean {
  let memo = LOCAL_BINDING_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    LOCAL_BINDING_MEMO.set(context, memo);
  }
  const key = filePath + '\0' + name;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const source = context.readFile?.(filePath) ?? '';
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `const { name } = require('./m')` / `= await import('./m')` binds an IMPORT,
  // not a shadow: the symbol lives in the other file and the call means it.
  const declRe = new RegExp(
    '\\b(?:const|let|var)\\s+(?:' + n + '\\b|[{\\[][^;=]*?\\b' + n + '\\b[^;=]*?[}\\]])\\s*(?:=\\s*([^;\\n]*))?',
    'g'
  );
  let bound = false;
  for (const m of source.matchAll(declRe)) {
    if (!/^\s*(?:await\s+)?(?:require|import)\s*\(/.test(m[1] ?? '')) { bound = true; break; }
  }
  if (!bound) {
    bound =
      new RegExp('\\b(?:function|class)\\s+' + n + '\\b').test(source) ||
      // a parameter: every token before the name in the list is itself a
      // parameter (identifier, optional type, optional default) — so a string
      // argument containing the word cannot match.
      new RegExp(
        '\\(\\s*(?:(?:\\.\\.\\.)?[\\w$]+(?:\\s*\\??\\s*:\\s*[^,()]+)?(?:\\s*=\\s*[^,()]+)?\\s*,\\s*)*' +
          n + '\\b(?:\\s*\\??\\s*:[^,()]*)?(?:\\s*=[^,()]*)?(?:\\s*,\\s*[^()]*)?\\)\\s*(?::[^=;{]*)?(?:=>|\\{)'
      ).test(source) ||
      new RegExp('(?:^|[^\\w$.])' + n + '\\s*=>').test(source);
  }
  memo.set(key, bound);
  return bound;
}

/**
 * Drop every per-context memo this module owns. Called by
 * ReferenceResolver.clearCaches so source-derived answers (sealed-module
 * state, static-function reads, local-binding scans, import supplements,
 * receiver declarations, typed-function lists) die with the file caches they
 * were derived from — a sync must never let a stale memo survive.
 */
export function clearNameMatcherMemos(context: ResolutionContext): void {
  SEALED_MODULES.delete(context);
  C_STATIC_MEMO.delete(context);
  RUST_TRAIT_IMPL_MEMO.delete(context);
  LOCAL_BINDING_MEMO.delete(context);
  IMPORT_SUPPLEMENT_CACHES.delete(context);
  RECEIVER_DECL_CACHES.delete(context);
  TYPED_FN_CACHES.delete(context);
  GET_STATE_FILES.delete(context);
  SELECTOR_NAMES.delete(context);
}

/**
 * Import-aware veto for cross-file name binding (exact and fuzzy), applied
 * per candidate.
 *
 * In import-disciplined languages a bare reference name that the calling
 * file does NOT import is almost certainly a local binding the extractor
 * deliberately does not index (e.g. a function-scoped `const openSession =
 * ...` closure), and it must not bind to an unrelated file's same-named
 * symbol just because that symbol is the graph's only candidate. Bench
 * evidence: five fake layout.tsx -> wire-session `calls` edges polluted
 * every downstream tool (scope checks, drift signals, impact, audit).
 *
 * A cross-file candidate is still allowed when:
 * - the file has no import mappings at all (C, scripts, languages whose
 *   includes are not extracted as imports — recall must not drop where
 *   imports are not a usable signal; also covers partial mock contexts),
 * - the reference name itself is imported (localName, or a dotted member
 *   of an imported namespace/object), or
 * - the candidate's file is reachable from the file's imports (resolvedPath
 *   match, the import source's last segment equals the candidate file's
 *   name, or a relative specifier directory-resolves onto a candidate
 *   `index.<ext>` barrel file) — this keeps zustand-style destructuring
 *   working (`import { useStore } from './store'` then a bare `fetchUser()`
 *   call on an action defined in store.ts).
 */
function fileTailNoExt(filePath: string): string {
  const tail = filePath.split('/').pop() ?? filePath;
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? tail.slice(0, dot) : tail;
}

// Node/bundler directory-module convention: `import x from './db'` may name
// `db/index.<ext>` instead of `db.<ext>`. A bare tail comparison misses those
// (candidate tail `index` never equals the specifier tail `db`), which is the
// dominant layout of graph/db/index.ts-style barrel modules. `index.d.ts`
// (two dots) is included so declaration barrels bind like source barrels.
const BARREL_INDEX_FILE = /^index\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)?$/;

/**
 * Collapse POSIX path segments (`''`/`.` dropped, `..` pops) at string level.
 * Returns null when the walk escapes the project root — such a specifier has
 * no candidate inside the indexed tree, so it must not allow anything.
 */
function normalizeRelativeSegments(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * Whether a relative import specifier (`./x`, `../x`) directory-resolves onto
 * a candidate `index.<ext>` barrel: caller-dir + specifier, normalized, must
 * equal the candidate's parent dir exactly. Both paths are project-relative,
 * so the comparison is string-level with no filesystem probe — an `index.*`
 * file under an unrelated same-named directory stays vetoed. Bare/aliased
 * specifiers have no directory semantics and return false.
 */
function barrelImportReachesFile(ref: UnresolvedRef, candidateFilePath: string, source: string): boolean {
  if (!source.startsWith('./') && !source.startsWith('../')) return false;
  const candidateSegments = candidateFilePath.split('/');
  const candidateTail = candidateSegments[candidateSegments.length - 1] ?? '';
  if (!BARREL_INDEX_FILE.test(candidateTail)) return false;
  const resolved = normalizeRelativeSegments([
    ...ref.filePath.split('/').slice(0, -1),
    ...source.split('/'),
  ]);
  if (!resolved) return false;
  const candidateDir = candidateSegments.slice(0, -1);
  if (candidateDir.length !== resolved.length) return false;
  return resolved.every((segment, i) => segment === candidateDir[i]);
}

function refImportMappings(ref: UnresolvedRef, context: ResolutionContext): ImportMapping[] {
  const base =
    typeof context.getImportMappings === 'function'
      ? (context.getImportMappings(ref.filePath, ref.language) ?? [])
      : [];
  // Empty base keeps the permissive default intact — supplements are only
  // ever added to a file that already shows import discipline.
  if (base.length === 0) return base;
  const extras = importSupplementsForFile(ref.filePath, context);
  if (extras.length === 0) return base;
  const seen = new Set(base.map((m) => `${m.localName}\u0000${m.source}`));
  return [...base, ...extras.filter((m) => !seen.has(`${m.localName}\u0000${m.source}`))];
}

function crossFileCandidateAllowed(ref: UnresolvedRef, candidate: Node, imports: ImportMapping[]): boolean {
  if (candidate.filePath === ref.filePath) return true;
  if (imports.length === 0) return true;
  const candidateTail = fileTailNoExt(candidate.filePath);
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) return true;
    if (
      imp.resolvedPath &&
      (imp.resolvedPath === candidate.filePath ||
        imp.resolvedPath.endsWith('/' + candidate.filePath) ||
        candidate.filePath.endsWith('/' + imp.resolvedPath))
    ) {
      return true;
    }
    if (imp.source && fileTailNoExt(imp.source) === candidateTail) return true;
    if (imp.source && barrelImportReachesFile(ref, candidate.filePath, imp.source)) return true;
  }
  return false;
}

// Type-only default imports (`import type CodeGraph from '../index'`) and
// dynamic specifiers (`await import('../index')`) are real reachability
// evidence the import resolver's static regex misses (its `import\s+(\w+)`
// arm swallows `type` as a bogus default name). They join the veto inputs
// as ALLOW-only supplements — merged only when the resolver already found
// at least one mapping, so the "file has no imports -> permissive" default
// can never be closed by them; a dynamic specifier carries an empty local
// name, matching no reference, only source/path tails.
const TYPE_ONLY_DEFAULT_IMPORT =
  /\bimport\s+type\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_SPECIFIER = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const IMPORT_SUPPLEMENT_CACHES = new WeakMap<ResolutionContext, LRUCache<string, ImportMapping[]>>();
const IMPORT_SUPPLEMENT_FILE_LIMIT = 256;

function importSupplementsForFile(filePath: string, context: ResolutionContext): ImportMapping[] {
  if (typeof context.readFile !== 'function') return [];
  let cache = IMPORT_SUPPLEMENT_CACHES.get(context);
  if (!cache) {
    cache = new LRUCache<string, ImportMapping[]>(IMPORT_SUPPLEMENT_FILE_LIMIT);
    IMPORT_SUPPLEMENT_CACHES.set(context, cache);
  }
  const cached = cache.get(filePath);
  if (cached) return cached;
  const source = context.readFile(filePath);
  const supplements: ImportMapping[] = [];
  if (source) {
    for (const match of source.matchAll(TYPE_ONLY_DEFAULT_IMPORT)) {
      supplements.push({
        localName: match[1]!,
        exportedName: 'default',
        source: match[2]!,
        isDefault: true,
        isNamespace: false,
      });
    }
    const seenSpecifiers = new Set<string>();
    for (const match of source.matchAll(DYNAMIC_IMPORT_SPECIFIER)) {
      if (seenSpecifiers.has(match[1]!)) continue;
      seenSpecifiers.add(match[1]!);
      supplements.push({
        localName: '',
        exportedName: '',
        source: match[1]!,
        isDefault: false,
        isNamespace: false,
      });
    }
  }
  cache.set(filePath, supplements);
  return supplements;
}

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null;

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches "src/snippets/foo.liquid")
  const suffixMatch = fileNodes.find(n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName));
  if (suffixMatch) {
    return {
      original: ref,
      targetNodeId: suffixMatch.id,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // K-v2 P5-1 / D8 candidate pre-filters (upstream N semantics):
  // - `import`-kind nodes are import STATEMENTS, not definitions — a reference
  //   resolving to a sibling file's `import` is a meaningless edge (the real
  //   import→definition resolution is resolveViaImport's job). Excluding them
  //   also removes a quadratic blow-up: a ubiquitous package (`react`,
  //   Python `logging`/`typing`) is re-declared as an `import` node in every
  //   file that imports it (upstream #915). This is also the fs/os double-edge
  //   hygiene fix: `import fs from 'fs'` emits a moduleName ref and a binding
  //   ref both named `fs`, which used to exact-match the file's own import
  //   statement node twice.
  // - For `imports` refs, sealed-module candidates drop BEFORE ranking
  //   ("preserve import ranking; calls reject the winner without promoting
  //   another" — the calls rejection happens post-rank below).
  // - A receiver-less JS/TS call cannot reach a method (#1714), and never
  //   reaches a cross-file name the calling file binds locally.
  const bareJs = isBareJsCall(ref, context);
  if (bareJs) {
    const storeAction = matchJsStoreBindingCall(ref, context);
    if (storeAction) return storeAction;
  }
  const candidates = context.getNodesByName(ref.referenceName)
    .filter((n) => n.kind !== 'import')
    .filter((n) => ref.referenceKind !== 'imports' || n.filePath === ref.filePath ||
      !ESM_FAMILY.has(n.language) || !isSealedModule(n.filePath, context))
    .filter((n) => !(bareJs && n.kind === 'method'))
    .filter((n) => !(bareJs && n.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context)));

  if (candidates.length === 0) {
    return null;
  }

  // Import-aware veto (fork recall-campaign asset, unchanged slot): in
  // import-disciplined files, a name that is neither imported nor reachable
  // through an imported file is a local binding (closure/function-scoped const
  // the extractor does not index), not a cross-file call.
  const imports = refImportMappings(ref, context);
  const reachable = candidates.filter((node) => crossFileCandidateAllowed(ref, node, imports));

  if (reachable.length === 0) {
    return null;
  }

  // If only one reachable candidate, use it — validated post-rank by N's
  // module-boundary reachability (#1719 sealed modules, markdown/JSON guards).
  // A rejection leaves the reference unresolved; it never promotes another.
  if (reachable.length === 1) {
    if (!isCrossFileReachable(reachable[0]!, ref, context)) return null;
    return {
      original: ref,
      targetNodeId: reachable[0]!.id,
      resolvedBy: 'exact-match',
    };
  }

  // Too many same-named definitions: refuse to guess instead of scoring every
  // candidate (O(K²) stall protection, mirrors upstream CODEGRAPH_AMBIGUOUS_NAME_CEILING).
  if (reachable.length > AMBIGUOUS_NAME_CEILING) return null;

  // Multiple matches - try to narrow down. The ranked winner gets the same
  // post-rank reachability validation as the unique candidate.
  const bestMatch = findBestMatch(ref, reachable, context);
  if (bestMatch && isCrossFileReachable(bestMatch, ref, context)) {
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
): ResolvedRef | null {
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  const methodCandidates = context.getNodesByName(methodName);
  const want = `${typeName}::${methodName}`;
  const matches: Node[] = [];
  for (const m of methodCandidates) {
    if (m.kind !== 'method') continue;
    if (m.language !== ref.language) continue;
    const qn = m.qualifiedName;
    if (qn === want || qn.endsWith(`::${want}`)) {
      matches.push(m);
    }
  }
  if (matches.length === 0) return null;

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        resolvedBy,
      };
    }
  }

  return {
    original: ref,
    targetNodeId: matches[0]!.id,
    resolvedBy,
  };
}

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// Declarator regex: matches `Type receiver`, `Type* receiver`, `Type *receiver`,
// `Type*receiver`, `Type<X> receiver`, etc., REQUIRING a declarator terminator
// (`;`, `=`, `,`, `)`, `[`, `{`, `(`, or end-of-line) after the receiver. The
// terminator rules out uses like `return receiver->m()` where the preceding
// token is a keyword, not a type.
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  // Per-file lines cache when available — this runs per `receiver->method()`
  // ref and re-splitting the file each time is quadratic on large corpora.
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` — the declared type is deduced; recover it
        // from the initializer (call return type / construction) (upstream #645).
        const initType = inferCppAutoInitializerType(line, receiverName, ref, context, depth);
        if (initType) return initType;
        // No usable initializer on this line — keep scanning earlier ones.
      } else if (normalized) {
        return normalized;
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerLines = context.getFileLines
      ? context.getFileLines(headerPath)
      : (context.readFile(headerPath)?.split(/\r?\n/) ?? null);
    if (!headerLines) continue;

    for (const line of headerLines) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
    }
  }

  return null;
}

// ===========================================================================
// K-v2 P5-1 / D9: consumer side for the callee forms the N emitter layer
// (adopted in P2/P3) now produces. Each branch mirrors upstream N semantics
// adapted to the fork skeleton (fork resolveMethodOnType validation, no
// numeric confidence — the fork arbitrates by RESOLVER_RANK evidence class).
// Scope-narrowed against N (recorded in the P5-1 report): the generic #1108
// inferLocalReceiverType family is NOT ported — the fork's own d2 receiver
// evidence (Strategy 0.5/0.5b) stays the receiver-typing mechanism for simple
// `receiver.method` shapes, and language branches N feeds through #1108
// (Go 2-hop field chains #1276, PHP `this->prop.method`) decline exclusively
// in the fork (unresolved, never a guessed edge — same outcome as N when its
// inference fails).
// ===========================================================================

/**
 * Last `::`-separated segment of a (possibly namespace-qualified) C++ name.
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * Return type captured at extraction for `Class::method` (or a free function),
 * read off the indexed node's `returnType` — used by the C++ (#645) and PHP
 * (#608) chained-call resolvers. Language-filtered. Null when not indexed or
 * no return type was recorded (a `void`/primitive return).
 */
function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.language === ref.language &&
      !!n.returnType,
  );
  if (cls) {
    const want = `${cls}::${method}`;
    // The call site may name the class with MORE namespace qualification than
    // the stored node, or LESS. Accept an exact match or either being a
    // namespace-suffix of the other; the shared `::<class>::<method>` tail
    // keeps it specific.
    const m = candidates.find(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    return m?.returnType ?? null;
  }
  return candidates.find((n) => n.kind === 'function')?.returnType ?? null;
}

/** Does the graph contain an aggregate type named `name`'s last segment? */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'union') && n.language === ref.language);
}

/**
 * Infer the class produced by a C++ call/construction expression, using return
 * types captured at extraction (#645). Handles, in order:
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - single-level member call `recv.method()`       → recv's type, then method's return
 *   - `Class::method()` / free `func()`              → the callee's recorded return type
 *   - direct construction `Type()` / `ns::Type()`    → Type
 * Returns null when undeterminable. Callers MUST still validate the outer
 * method exists on the result before creating an edge, so a wrong guess stays
 * silent.
 */
function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // guard against pathological mutual recursion
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/);
  if (make) return make[1] ?? null;

  // Single-level member call `recv.method` (the `manager.view().render()` shape).
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // Direct construction — the callee itself names a class/struct.
  if (cppClassExists(expr, ref, context)) return cppLastSegment(expr);

  return null;
}

/**
 * Recover the type of an `auto`-declared local from its initializer on the
 * declaration line — `auto x = Foo::instance();`, `auto w = make_unique<W>();`,
 * `auto p = new W();`, `auto w = Widget();` (#645).
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return cppLastSegment(neu[1]);

  // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

/**
 * Resolve a C++ chained call whose receiver is itself a call — encoded by the
 * extractor as `<innerCallee>().<method>` (#645). The receiver's type is what
 * the inner call returns; the outer method is then resolved and VALIDATED on
 * it (resolveMethodOnType requires `cls::method` to exist), so a wrong
 * inference produces no edge rather than a wrong one.
 */
export function matchCppCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = resolveCppCallResultType(m[1], ref, context);
  if (!cls) return null;
  return resolveMethodOnType(cls, m[2], ref, context, 'instance-method');
}

/**
 * Resolve a `::`-scoped factory chain whose receiver is a scoped/static call —
 * PHP `Cls::for($x)->method()` (#608) or Rust `Foo::new().bar()`, both encoded
 * by the extractor as `Cls::factory().method`. The receiver's type is what
 * `Cls::factory` returns: a `self` marker (PHP `: self`/`: static`, Rust
 * `-> Self`) resolves to the factory's own type, a concrete return type to
 * that type. The outer method is then resolved and VALIDATED on it, so a
 * wrong inference yields no edge rather than a wrong one.
 */
export function matchScopedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!inner.includes('::')) return null; // only static-factory (`Cls::method`) chains
  const factoryClass = inner.slice(0, inner.lastIndexOf('::'));
  const ret = lookupCalleeReturnType(inner, ref, context);
  if (!ret) return null;
  // `self` (the extractor's marker for self/static/$this) → the factory's class.
  const resolvedClass = ret === 'self' ? factoryClass : ret;
  return resolveMethodOnType(resolvedClass, method, ref, context, 'instance-method');
}

/**
 * Languages where an unprefixed capitalized call `Foo(args)` constructs the
 * class (so a `Foo(args).method()` receiver's type is `Foo`). Java/C# need
 * `new`, so a bare `Foo()` there is a method call, not construction —
 * excluded. Scala's `Foo(args)` is a case-class / companion `apply`, which
 * conventionally returns `Foo` — and resolveMethodOnType validates, so a
 * non-conventional `apply` that returns another type simply yields no edge
 * rather than a wrong one. Pascal/Delphi: a `TFoo(x)` is a TYPECAST whose
 * result is a `TFoo`, so `TFoo(x).method()` resolves the method on `TFoo`.
 */
const CONSTRUCTS_VIA_BARE_CALL = new Set(['kotlin', 'swift', 'scala', 'dart', 'pascal']);

/**
 * Resolve a dotted chained call whose receiver is a static factory / fluent
 * call — `Foo.getInstance().bar()`, encoded by the extractor as
 * `Foo.getInstance().bar` (#645/#608 mechanism). The receiver's type is what
 * `Foo.getInstance` returns (its declared return type); the outer method is
 * then resolved and VALIDATED on it, so a wrong inference yields no edge
 * rather than a wrong one. Shared by the dot-notation languages (Java,
 * Kotlin, C#, Swift, Go, Scala, Dart, ObjC, Pascal).
 */
export function matchDottedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1]; // `Foo.getInstance`
  const method = m[2]; // `bar`
  const lastDot = inner.lastIndexOf('.');

  if (lastDot <= 0) {
    // Go: bare package-level factory FUNCTION `New().method()` — the receiver's
    // type is what `New` returns; resolve the method on that.
    if (ref.language === 'go') {
      const ret = lookupCalleeReturnType(inner, ref, context);
      if (ret) {
        return resolveMethodOnType(ret, method, ref, context, 'instance-method', importedFqnOf(ret, ref, context));
      }
      // `inner` isn't a function with a captured return type — typically a
      // package-level VARIABLE holding a function value (e.g. gin's `engine()`),
      // whose type we can't recover. Fall back to bare-name resolution of the
      // method so we don't DROP an edge the un-re-encoded bare path would have
      // found. (When `inner` IS a real factory function but the method doesn't
      // exist on its return type, `ret` is truthy and we returned no edge above
      // — the absent-method safety guarantee is preserved.)
      //
      // CRITICAL: resolve the TARGET via a synthetic bare-name ref, but return
      // the match tied to the ORIGINAL `ref` (referenceName `inner().method`).
      // The batched resolver deletes resolved rows by (fromNode, referenceName,
      // referenceKind) tuple when no row id is available; propagating the
      // synthetic ref's bare `method` as `.original` would never match the
      // stored `inner().method` row, the batch would never drain, and the loop
      // would re-resolve + re-insert forever (upstream #1269: a runaway that
      // grew gin's graph to 5M edges / 1.4 GB before the fix).
      const bareRef = { ...ref, referenceName: method };
      const bareMatch = matchByExactName(bareRef, context) ?? matchFuzzy(bareRef, context);
      return bareMatch ? { ...bareMatch, original: ref } : null;
    }
    // Constructor receiver `Foo(args).method()` (encoded `Foo().method`): a
    // bare, capitalized inner is a class construction, so the receiver's type
    // is the class itself — resolve the method on it. Only in languages where
    // an unprefixed capitalized call constructs the class; in Java/C# a bare
    // `Foo()` is a method call (constructors need `new`). A lowercase bare
    // inner is a top-level `factory().method()` whose type we can't recover —
    // bail.
    if (!CONSTRUCTS_VIA_BARE_CALL.has(ref.language) || !/^[A-Z]/.test(inner)) return null;
    return resolveMethodOnType(inner, method, ref, context, 'instance-method', importedFqnOf(inner, ref, context));
  }

  // Factory/fluent receiver `Receiver.factory(args).method()`: the receiver's
  // type is what `Receiver.factory` returns (its declared return type).
  const factoryClass = inner.slice(0, lastDot).split('.').pop(); // simple class name
  const factoryMethod = inner.slice(lastDot + 1);
  if (!factoryClass || !factoryMethod) return null;
  const ret = lookupCalleeReturnType(`${factoryClass}::${factoryMethod}`, ref, context);
  if (!ret) {
    // Objective-C: a class-message factory — `[X alloc]`, `[X new]`,
    // `[X sharedFoo]` — returns an instance of the RECEIVER class `X` by
    // convention (`instancetype`). resolveMethodOnType validates against X,
    // so a class whose method actually lives elsewhere yields NO edge, not a
    // wrong one — and this does NOT fire when a concrete return type WAS
    // captured but simply lacks the method (absent-method safety above).
    if (ref.language === 'objc' && /^[A-Z]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    // Pascal/Delphi: the extractor only re-encodes a `TFoo`/`IFoo`-prefixed
    // chain (the type-naming convention), so `factoryClass` is always a real
    // class here. A factory whose return type wasn't captured is a
    // CONSTRUCTOR (`constructor Create` has no `: TBar` annotation but
    // returns its own class) or an unannotated function — the receiver's type
    // is the class itself. Validated by resolveMethodOnType as above.
    if (ref.language === 'pascal' && /^[TI]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    return null;
  }
  return resolveMethodOnType(ret, method, ref, context, 'instance-method', importedFqnOf(ret, ref, context));
}

/**
 * When several classes share a simple type name, the caller file's import of
 * that type is the only signal that names WHICH one (#314). Returns the
 * imported FQN for `typeName` in the ref's file, or undefined.
 */
function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Language families that share a type system / runtime, so a same-language-
 * only reference may still resolve across them (a Kotlin `Foo.BAR` can name a
 * Java `Foo`). Anything not listed forms its own singleton family.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'apple', objc: 'apple',
  // ArkTS is a TS superset — every HarmonyOS project mixes `.ets` UI with
  // `.ts` logic modules, so refs must cross freely between them.
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web', arkts: 'web',
  c: 'c', cpp: 'c',
  // Razor/Blazor markup names C# types — same family so `@model Foo` /
  // `<MyComponent/>` resolve to their `.cs` class.
  csharp: 'dotnet', razor: 'dotnet',
};
export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}

/** Languages with no nested named functions: nesting in the graph is never a scope. */
const NO_NESTED_FUNCTIONS = new Set<string>(['c', 'cpp']);

/**
 * A function nested inside another FUNCTION is only callable from within its
 * container — Python, JS/TS, and every closure language scope it lexically.
 * Resolving a bare name from elsewhere to a nested local fabricates an edge
 * scope already rules out (upstream #1230). A candidate whose qualifiedName
 * parent is a same-file function/method is kept only when the ref originates
 * inside that parent's line range. Class members are unaffected, as are
 * top-level symbols and C++ namespace-prefixed names. Used by the store-
 * accessor holder filter (#1683 port); NOT wired into the general exact/fuzzy
 * candidate filters in this fork batch (tracked as a pending-parent item).
 */
function isLexicallyReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  if (candidate.kind !== 'function') return true;
  // C and C++ have no nested named functions, so a function the graph shows
  // inside another is an extraction artifact, not a scope (macro-call error
  // recovery runs the enclosing function_definition to end of file).
  if (NO_NESTED_FUNCTIONS.has(candidate.language)) return true;
  const qn = candidate.qualifiedName;
  if (!qn || !qn.includes('::')) return true;
  const parentQn = qn.slice(0, qn.lastIndexOf('::'));
  const containers = context
    .getNodesByQualifiedName(parentQn)
    .filter(
      (p) =>
        p.filePath === candidate.filePath &&
        (p.kind === 'function' || p.kind === 'method') &&
        p.startLine <= candidate.startLine &&
        p.endLine >= candidate.endLine
    );
  if (containers.length === 0) return true;
  return (
    ref.filePath === candidate.filePath &&
    containers.some((p) => ref.line >= p.startLine && ref.line <= p.endLine)
  );
}

/**
 * When a symbol name is ambiguous across files, prefer the candidate(s)
 * declared in the call site's own file, keeping the rest in their original
 * order (upstream #1079). A same-file definition is the strongest language-
 * agnostic signal for which of several same-named symbols a call means.
 * No-op when there are <2 candidates or none share the call site's file.
 */
export function preferCallSiteFile(nodes: Node[], callSiteFile: string): Node[] {
  if (nodes.length < 2) return nodes;
  const same: Node[] = [];
  const other: Node[] = [];
  for (const n of nodes) {
    if (n.filePath === callSiteFile) same.push(n);
    else other.push(n);
  }
  return same.length ? [...same, ...other] : nodes;
}

/**
 * Languages whose object literals declare callable members — `export const
 * api = { call() {…}, get: () => {…} }` used as a namespace (upstream #1573).
 */
const OBJECT_LITERAL_LANGUAGES = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/** True when `inner`'s source range lies within `outer`'s (lines, then columns on a shared line). */
function rangeWithin(inner: Node, outer: Node): boolean {
  const innerEnd = inner.endLine ?? inner.startLine;
  const outerEnd = outer.endLine ?? outer.startLine;
  if (inner.startLine < outer.startLine || innerEnd > outerEnd) return false;
  if (inner.startLine === outer.startLine && inner.startColumn < outer.startColumn) return false;
  if (innerEnd === outerEnd && inner.endColumn > outer.endColumn) return false;
  return true;
}

function sameRange(a: Node, b: Node): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    (a.endLine ?? a.startLine) === (b.endLine ?? b.startLine) &&
    a.endColumn === b.endColumn
  );
}

/**
 * Resolve `container.member` where `container` is a VALUE holding an object
 * literal — `export const api = { call() {…}, get: () => {…} }` used as the
 * module's namespace (upstream #1573). The members are extracted as plain
 * functions with BARE qualified names inside the constant's source extent
 * (there is no `api::call`), so none of the class-shaped strategies can see
 * them. This looks the member up by CONTAINMENT: a node named `member` whose
 * range lies inside the container's, in the container's own file. A helper
 * declared inside a member's body is not a member and is skipped. Calls take
 * callable kinds only; other references accept value members too.
 */
export function resolveObjectLiteralMember(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolvedBy: ResolvedRef['resolvedBy'],
): ResolvedRef | null {
  if (container.kind !== 'constant' && container.kind !== 'variable') return null;
  if (!OBJECT_LITERAL_LANGUAGES.has(container.language)) return null;
  if (!sameLanguageFamily(container.language, ref.language)) return null;

  const inFile = context.getNodesInFile(container.filePath);
  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method';
  const valueMember = (n: Node) =>
    callable(n) || n.kind === 'property' || n.kind === 'variable' || n.kind === 'constant';
  const accepts = ref.referenceKind === 'calls' ? callable : valueMember;

  const inside = inFile.filter((n) => n.id !== container.id && rangeWithin(n, container));
  let candidates = inside.filter((n) => n.name === member && accepts(n));
  if (candidates.length === 0) return null;

  // Drop a candidate nested inside ANOTHER callable's body within the literal
  // (`{ run() { const call = () => {}; } }` — `call` is `run`'s local, not a
  // member). Strict containment: an identically-ranged sibling node for the
  // same member (a property node over an arrow function) is not a body.
  const bodies = inside.filter(callable);
  candidates = candidates.filter(
    (c) => !bodies.some((b) => b.id !== c.id && !sameRange(b, c) && rangeWithin(c, b))
  );
  if (candidates.length === 0) return null;

  // Several survivors (a property AND a function for one arrow member, say):
  // a callable first, then the earliest in source order.
  candidates.sort((a, b) => {
    const ca = callable(a) ? 0 : 1;
    const cb = callable(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.startLine - b.startLine || a.startColumn - b.startColumn;
  });
  return {
    original: ref,
    targetNodeId: candidates[0]!.id,
    resolvedBy,
  };
}

// Rust primitives and the prelude's own types: a field of one of these never
// names a project type, so a `self.<field>.<method>()` on it stays unresolved.
const RUST_NON_PROJECT_FIELD_TYPES = new Set([
  'bool', 'char', 'str', 'String',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64',
  'Self', 'self',
]);

/**
 * Reduce a Rust field's declared type text to the simple name of the type a
 * method call on that field auto-derefs to, or null when there is none we can
 * name. Only the layers Rust's method-call auto-deref looks through are
 * unwrapped: references (`&`, `&'a mut`) and the owning smart pointers (`Box`,
 * `Rc`, `Arc`). Containers that do NOT auto-deref to their parameter
 * (`Option<Inner>`, `Vec<Inner>`, `Mutex<Inner>`) keep their own name and,
 * having no project node, resolve to nothing — `self.items.push()` must never
 * become `Inner::push`. A trait object (`Box<dyn Source>`) yields the trait.
 * A generic parameter, primitive, tuple/array/raw-pointer/fn type, or a
 * non-identifier yields null.
 */
export function rustFieldTypeName(raw: string): string | null {
  let t = raw.trim();
  for (;;) {
    const before = t;
    t = t.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '');
    t = t.replace(/^(?:Box|Rc|Arc)\s*<\s*/, '');
    t = t.replace(/^(?:dyn|impl)\s+/, '');
    if (t === before) break;
  }
  // Drop generic args, the closing `>`s of unwrapped pointers, and trait-object
  // bounds (`dyn Source + Send`); keep the last path segment.
  t = t.replace(/[<>+].*$/, '').trim();
  const seg = t.split('::').filter(Boolean).pop();
  if (!seg || !/^[A-Za-z_]\w*$/.test(seg)) return null;
  if (RUST_NON_PROJECT_FIELD_TYPES.has(seg)) return null;
  if (/^[A-Z]$/.test(seg)) return null; // bare single-letter generic parameter
  return seg;
}

/**
 * Resolve a Rust call through a field of the enclosing type —
 * `self.inner.run()`, emitted by the extractor as `self.inner.run` (#1585).
 * The owner type is the calling method's qualified-name prefix
 * (`Outer::run` → `Outer`), the field's declared type comes from the owner
 * struct's OWN declaration lines, and the method is resolved AND VALIDATED on
 * that type by resolveMethodOnType. EXCLUSIVE for `self.<field>` receivers: a
 * field whose type is external, generic, or not declared where we can see it
 * yields null and the ref stays unresolved — letting the bare name through is
 * how `self.inner.run()` used to resolve to a same-named method on an
 * unrelated type, or to the calling method itself. Rust struct fields are not
 * graph nodes, so the declaration text is the only place the type lives.
 */
function matchRustSelfFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  // The extractor only ever emits a single field hop; anything else is not ours.
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) =>
      (n.kind === 'struct' || n.kind === 'union' || n.kind === 'class') &&
      n.language === 'rust'
  );
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `pub inner: Inner,` / `inner: Box<dyn Source>,` / `pub(crate) inner: T }` —
  // the type text runs to the field separator. A comma inside generic args
  // (`HashMap<K, V>`) truncates the capture, which rustFieldTypeName then
  // reduces to the container's own name — exactly the non-deref case it
  // refuses anyway.
  const fieldRe = new RegExp(`\\b${fieldEsc}\\s*:\\s*([^,{}]+)`);
  for (const s of owners) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines, comment-stripped line by line —
    // prose or a same-named identifier elsewhere in the file can never donate
    // a type.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldRe);
      if (!m || !m[1]) continue;
      const fieldType = rustFieldTypeName(m[1]);
      // The field is declared here; whether or not its type names a project
      // symbol, this owner is the answer — no other same-named struct applies.
      if (!fieldType) return null;
      return resolveMethodOnType(fieldType, methodName, ref, context, 'instance-method');
    }
  }
  return null;
}

/**
 * `self.method()` in Rust — the method on the type the call sits inside
 * (#1861). The owner is the calling method's qualified-name prefix
 * (`Target::run` → `Target`), which is where the `impl` block's type ends up.
 * A free function has no `self`, so a caller whose qualified name carries no
 * owner declines. Exactly one candidate must belong to that owner: a project
 * with two `impl` blocks for the same type is normal, two same-named methods
 * on it is not, and guessing between them is the failure this replaces.
 */
function matchRustSelfCall(
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller?.qualifiedName) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep);

  let owned = context
    .getNodesByQualifiedName(`${owner}::${methodName}`)
    .filter(
      (n) =>
        n.kind === 'method' &&
        n.language === 'rust' &&
        n.qualifiedName === `${owner}::${methodName}`,
    );
  // Rust's extracted qualified names omit module paths. Two modules can each
  // declare `Target`; matching just `Target::reset` does not establish
  // ownership. In that case require a single owner declaration in the
  // caller's file and a method in that file. Otherwise leave it unresolved.
  // A unique owner still permits ordinary impl blocks split across files.
  const owners = context.getNodesByQualifiedName(owner).filter((n) =>
    n.language === 'rust' && ['struct', 'enum', 'union', 'trait', 'class'].includes(n.kind));
  if (owners.length > 1) {
    if (owners.filter((n) => n.filePath === caller.filePath).length !== 1) return null;
    owned = owned.filter((n) => n.filePath === caller.filePath);
  }
  if (owned.length !== 1) return null;

  return {
    original: ref,
    targetNodeId: owned[0]!.id,
    resolvedBy: 'qualified-name',
  };
}

/**
 * Resolve a TS/JS `this.<field>.<method>()` call (#1496) through the field's
 * declared type, read off the ENCLOSING class's own declaration lines: a
 * field or constructor-parameter property (`private mailer: Mailer`,
 * `mailer?: Mailer`, `readonly mailer: Mailer`) or an initializer
 * (`mailer = new Mailer()`, `this.mailer = new Mailer()`). The method is then
 * VALIDATED on that type by resolveMethodOnType. Null — never a bare-name
 * fallback — when the field is not declared there or its type is external, a
 * builtin (`this.items.push()`) or not spelled out. EXCLUSIVE: letting the
 * bare name through is how `this.mailer.send()` inside `Notifier.send()`
 * resolved to the calling method itself — a self-edge the source does not
 * contain — whenever the two shared a name.
 */
function matchTsThisFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // not inside a class
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) => (n.kind === 'class' || n.kind === 'component') && sameLanguageFamily(n.language, ref.language)
  );
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: Array<{ re: RegExp; valueType: boolean }> = [
    // `storage: typeof DraftHubStorage` — the type OF a value: an object
    // literal used as a namespace. Its members are bare-named functions inside
    // the constant's extent (#1573), so they are found by containment, not by
    // `Type::method`. Tried first: the declared-type pattern below would
    // otherwise capture the word `typeof`.
    {
      re: new RegExp(`\\b${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?typeof\\s+([A-Za-z_$][\\w.$]*)`),
      valueType: true,
    },
    // `private readonly mailer?: Mailer` — a class field or a constructor
    // parameter property; the capture stops at `<`, `[` or `|`, so a generic
    // or union type yields its head and resolveMethodOnType decides.
    {
      re: new RegExp(`\\b${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?([A-Za-z_$][\\w.$]*)`),
      valueType: false,
    },
    // `mailer = new Mailer()` / `this.mailer = new Mailer()`
    { re: new RegExp(`\\b${fieldEsc}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), valueType: false },
  ];
  for (const cls of owners) {
    const source = context.readFile(cls.filePath);
    if (!source) continue;
    const declLines = source.split('\n').slice(Math.max(0, cls.startLine - 1), cls.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      for (const { re, valueType } of patterns) {
        const m = line.match(re);
        if (!m || !m[1]) continue;
        if (valueType) {
          // The value's declaration may live in another file (it is imported);
          // the call site's file is preferred when several share the name.
          const holderName = m[1].split('.').pop()!;
          const holders = preferCallSiteFile(context.getNodesByName(holderName), ref.filePath).filter(
            (n) => (n.kind === 'constant' || n.kind === 'variable') && sameLanguageFamily(n.language, ref.language)
          );
          for (const holder of holders) {
            const hit = resolveObjectLiteralMember(holder, methodName, ref, context, 'instance-method');
            if (hit) return hit;
          }
          return null;
        }
        // `ns.Mailer` → `Mailer`; a primitive or builtin names no project type.
        const typeName = m[1].split('.').pop()!;
        if (!/^[A-Z]/.test(typeName)) return null;
        // Two apps in one repo may each declare a `UserService`. The bare-name
        // path this replaces broke that tie by directory proximity, so keep
        // the same signal: among the type's declarations of the method,
        // prefer the one closest to the call site's directory, never index
        // order. resolveMethodOnType still answers the single-declaration case.
        const declared = context
          .getNodesByName(methodName)
          .filter(
            (n) =>
              n.kind === 'method' &&
              sameLanguageFamily(n.language, ref.language) &&
              (n.qualifiedName === `${typeName}::${methodName}` || n.qualifiedName.endsWith(`::${typeName}::${methodName}`))
          );
        if (declared.length > 1) {
          const callDirs = ref.filePath.split('/').slice(0, -1);
          const shared = (fp: string) => {
            const dirs = fp.split('/').slice(0, -1);
            let i = 0;
            while (i < dirs.length && i < callDirs.length && dirs[i] === callDirs[i]) i++;
            return i;
          };
          const nearest = [...declared].sort((a, b) => shared(b.filePath) - shared(a.filePath) || a.filePath.localeCompare(b.filePath))[0]!;
          return { original: ref, targetNodeId: nearest.id, resolvedBy: 'instance-method' };
        }
        return resolveMethodOnType(typeName, methodName, ref, context, 'instance-method');
      }
    }
  }
  return null;
}

/** 1-based start line of the tightest function/method enclosing the call. */
function enclosingScopeStartLine(ref: UnresolvedRef, context: ResolutionContext): number {
  let start = 1;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line && n.startLine >= start) {
      start = n.startLine;
    }
  }
  return start;
}

/** Balanced parameter lists also cover function-typed parameters, whose own
 * parentheses must not make the outer shadow invisible. Conservative when a
 * parameter's type mentions the same name: leave that call unresolved. */
function hasParameterBinding(code: string, escapedName: string): boolean {
  const name = new RegExp(`\\b${escapedName}\\b`);
  if (new RegExp(`\\b${escapedName}\\s*=>`).test(code)) return true;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '(' || /\b(?:if|while|for|switch|with)\s*$/.test(code.slice(0, i))) continue;
    let depth = 1, j = i + 1;
    for (; j < code.length && depth; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
    }
    if (depth === 0 && name.test(code.slice(i + 1, j - 1)) &&
        /^\s*(?::[^=;{]*)?(?:=>|\{)/.test(code.slice(j))) return true;
  }
  return false;
}

/** Import resolution names the module binding; a nearer parameter or block
 * declaration can shadow that binding at this particular call site. */
function importShadowedAt(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const fn of context.getNodesInFile(ref.filePath)) {
    if ((fn.kind === 'function' || fn.kind === 'method') && fn.startLine <= ref.line && fn.endLine >= ref.line &&
        fn.signature && hasParameterBinding(`${fn.signature} {`, escaped)) return true;
  }
  const lines = (context.readFile(ref.filePath) ?? '').split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]?.slice(0, ref.column) ?? '').join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const scope = stackAt(code.length);
  const declarations = new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b)`, 'g');
  return [...code.matchAll(declarations)].some(m => stackAt(m.index!).every((p, i) => scope[i] === p));
}

/**
 * The one fallback a TS/JS/Python call-receiver chain keeps (#1683): a STORE
 * ACCESSOR. Zustand's `get()` inside the store factory and
 * `useStore.getState()` outside it hand back the store whose actions are
 * indexed as functions (#1573). JS/TS resolves the member within that store;
 * the existing Python fallback still requires a unique callable. Nothing else
 * qualifies: a chain rooted in a project value still says nothing about what
 * the inner call RETURNS — `db.prepare(sql).all()` would bind to any project
 * function named `all` — so it resolves to nothing, exactly like a chain
 * rooted in a parameter (`d.setdefault(k, []).append(v)`).
 */
function matchStoreAccessorChain(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = ref.referenceName.match(/^([\w$.]+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!(inner === 'get' || inner === 'getState' || inner.endsWith('.getState'))) return null;
  if (JS_FAMILY.has(ref.language)) {
    return resolveStoreAction(inner, method, ref, context);
  }
  const callables = context
    .getNodesByName(method)
    .filter((n) => (n.kind === 'function' || n.kind === 'method') && sameLanguageFamily(n.language, ref.language) && n.id !== ref.fromNodeId);
  if (callables.length !== 1) return null;
  return { original: ref, targetNodeId: callables[0]!.id, resolvedBy: 'exact-match' };
}

/** Resolve the implementation inside the identified store, not a namesake or
 * an interface signature elsewhere in the project. Import resolution already
 * follows aliases/barrels; containment already excludes nested action locals. */
function resolveStoreAction(inner: string, member: string, ref: UnresolvedRef, context: ResolutionContext, selector = false): ResolvedRef | null {
  let holders: Node[];
  if (inner === 'get' || inner === 'getState') {
    const caller = context.getNodeById?.(ref.fromNodeId);
    if (!caller) return null;
    holders = context.getNodesInFile(ref.filePath).filter((n) => {
      if ((n.kind !== 'constant' && n.kind !== 'variable') || !rangeWithin(caller, n)) return false;
      const source = context.readFile(n.filePath)?.split('\n').slice(n.startLine - 1, caller.startLine).join('\n') ?? '';
      // The accessor must actually be a parameter of the enclosing factory.
      return new RegExp(`\\(\\s*[\\w$]+\\s*,\\s*${inner}\\s*(?:,\\s*[\\w$]+\\s*)?\\)\\s*=>`).test(source);
    });
  } else {
    const name = inner.slice(0, -'.getState'.length);
    if (!/^[\w$]+$/.test(name)) return null;
    const imported = context.resolveImport?.({ ...ref, referenceName: name, referenceKind: 'references' });
    const node = imported && context.getNodeById?.(imported.targetNodeId);
    if (node && importShadowedAt(name, ref, context)) return null;
    holders = node ? [node] : context.getNodesByName(name).filter((n) =>
      n.filePath === ref.filePath && isLexicallyReachable(n, ref, context));
  }
  if (holders.length !== 1) return null;
  const holder = holders[0]!;
  if (selector) {
    // Only a Zustand hook promises to return the selector's result. An
    // arbitrary function accepting that callback is not a store binding.
    const text = context.readFile(holder.filePath)?.split('\n').slice(holder.startLine - 1, holder.endLine).join('\n') ?? '';
    const escaped = holder.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const factory = new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*([\\w$]+)\\s*[<(]`).exec(text)?.[1];
    if (!factory || !context.getImportMappings(holder.filePath, holder.language).some(m =>
      m.localName === factory && m.source === 'zustand' && (m.exportedName === 'create' || m.isDefault))) return null;
  }
  return resolveObjectLiteralMember(holder, member, ref, context, 'instance-method');
}

// Store-binding eligibility is a file property, not a call-site property.
// Cache both answers within the same stable-source window as the resolver's
// file cache; sync drops it via clearNameMatcherMemos.
const GET_STATE_FILES = new WeakMap<ResolutionContext, Map<string, boolean>>();
const GET_STATE_FILES_CAP = 8192;

/** A const destructuring is a bound reference, so it is eligible even though
 * arbitrary locally-bound bare calls must never guess a cross-file target. */
function matchDestructuredStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let files = GET_STATE_FILES.get(context);
  if (!files) { files = new Map(); GET_STATE_FILES.set(context, files); }
  let eligible = files.get(ref.filePath);
  let source: string | null | undefined;
  if (eligible === undefined) {
    source = context.readFile(ref.filePath);
    eligible = source?.includes('.getState') ?? false;
    if (files.size >= GET_STATE_FILES_CAP) {
      const oldest = files.keys().next().value;
      if (oldest !== undefined) files.delete(oldest);
    }
    files.set(ref.filePath, eligible);
  }
  if (!eligible) return null;
  source ??= context.readFile(ref.filePath);
  if (!source) return null;
  const lines = source.split('\n');
  const start = enclosingScopeStartLine(ref, context) - 1;
  const before = lines.slice(start, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binding = /\bconst\s*\{([^{}]*)\}\s*=\s*([\w$]+)\.getState\s*\(\s*\)/g;
  // Compare block identities, not just nesting depth: a binding in a sibling
  // or already-closed block is not in scope at this call.
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    // Plain named bindings only; defaults, rest and computed keys need their
    // own value tracing rather than a same-name guess.
    if (!m[1]!.split(',').some(part => part.trim() === ref.referenceName)) continue;
    const scope = stackAt(m.index!);
    if (!scope.every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    // Keep the guard when another declaration shadows the captured const.
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest)) return null;
    return resolveStoreAction(`${m[2]}.getState`, ref.referenceName, ref, context);
  }
  return null;
}

const SELECTOR_NAMES = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** A selector returns the named action from one identified store. Keep the
 * lexical block identity so closures may capture it but sibling scopes and
 * shadowing parameters/declarations cannot donate a binding. */
function matchSelectedStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(ref.filePath);
  if (!source?.includes('=>')) return null;
  let files = SELECTOR_NAMES.get(context);
  if (!files) { files = new Map(); SELECTOR_NAMES.set(context, files); }
  let names = files.get(ref.filePath);
  if (!names) {
    names = new Set([...source.matchAll(/\bconst\s+([\w$]+)\s*=\s*[\w$]+\s*\(\s*(?:\(\s*[\w$]+\s*\)|[\w$]+)\s*=>/g)].map(m => m[1]!));
    files.set(ref.filePath, names);
  }
  if (!names.has(ref.referenceName)) return null;
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = source.split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const binding = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([\\w$]+)\\s*\\(\\s*(?:\\(\\s*([\\w$]+)\\s*\\)|([\\w$]+))\\s*=>\\s*([\\w$]+)\\.([\\w$]+)\\s*\\)`, 'g');
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    if ((m[2] ?? m[3]) !== m[4]) continue;
    if (!stackAt(m.index!).every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest) ||
        hasParameterBinding(rest, name)) return null;
    return resolveStoreAction(`${m[1]}.getState`, m[5]!, ref, context, true);
  }
  return null;
}

/** Bound action names need not have a same-named definition (selectors may
 * rename them). The resolver's symbol-existence prefilter must allow them. */
export function matchJsStoreBindingCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isBareJsCall(ref, context)) return null;
  return matchDestructuredStoreCall(ref, context) ?? matchSelectedStoreCall(ref, context);
}

/** A qualified untyped chain is useful source evidence, not permission to
 * infer a property type. Framework resolution runs before this guard. */
export function isUnresolvedJsMemberCall(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) &&
    !/^(?:this|window)\./.test(ref.referenceName) &&
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(ref.referenceName);
}

/**
 * Resolve a function-as-value reference (upstream #756) — a function name
 * used as a callback/function-pointer value (`register(handler)`,
 * `o->cb = handler`, `{ .cb = handler }`, `signal(SIGINT, handler)`). The
 * ONLY strategy allowed for `function_ref` refs: exact name, function/method
 * targets only, same language family, same-file first, and cross-file only
 * when the match is UNIQUE. No fuzzy fallback, no qualified-name walking — a
 * wrong callback edge is worse than none.
 */
export function matchFunctionRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `this.<member>` refs are resolved ONLY by the class-scoped resolver in
  // resolveOne (resolveThisMemberFnRef) — never by name matching here.
  if (ref.referenceName.startsWith('this.')) return null;

  // In JS/TS/Python a bare identifier can never be a method value (methods
  // are only reachable through a receiver), so bare fn-refs match FUNCTIONS
  // only. Python additionally accepts CLASS targets for bare identifiers
  // (#1478): class-as-value is a core Python idiom. C++ likewise: a bare
  // identifier can only be a FREE function (member values need `&Cls::m`).
  // PHP string callables name global FUNCTIONS. Other languages keep method
  // targets: C# method groups, Swift/Dart implicit-self, Java/Kotlin method
  // references.
  const bareFnOnly =
    ref.language === 'typescript' || ref.language === 'tsx' ||
    ref.language === 'javascript' || ref.language === 'jsx' ||
    ref.language === 'arkts' ||
    ref.language === 'cpp' || ref.language === 'python' ||
    ref.language === 'php';
  const bareClassOk = ref.language === 'python';

  // Qualified member-pointer (`&Widget::on_click` → "Widget::on_click"):
  // resolve the member ON THAT SCOPE — exempt from bareFnOnly. Unique-or-drop.
  if (ref.referenceName.includes('::')) {
    const memberName = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const scoped = context
      .getNodesByName(memberName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          sameLanguageFamily(n.language, ref.language) &&
          n.id !== ref.fromNodeId &&
          (n.qualifiedName === ref.referenceName ||
            n.qualifiedName.endsWith(`::${ref.referenceName}`))
      );
    if (scoped.length === 0) return null;
    const sameFileScoped = scoped.filter((n) => n.filePath === ref.filePath);
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped;
    if (sameFileScoped.length === 0 && scoped.length > 1) return null;
    const target = pool.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      resolvedBy: 'function-ref',
    };
  }

  let candidates = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' ||
          (!bareFnOnly && n.kind === 'method') ||
          (bareClassOk && n.kind === 'class')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  if (candidates.length === 0) return null;

  // Swift implicit-self: a bare identifier can name a METHOD only of the
  // ENCLOSING type (`Button(action: handleTap)` written inside that type) —
  // a same-named method on any OTHER class is a parameter collision.
  if (ref.language === 'swift' && candidates.some((n) => n.kind === 'method')) {
    const fromNode = context.getNodeById?.(ref.fromNodeId);
    const sep = fromNode ? fromNode.qualifiedName.lastIndexOf('::') : -1;
    const classPrefix = fromNode && sep > 0 ? fromNode.qualifiedName.slice(0, sep) : null;
    candidates = candidates.filter((n) => {
      if (n.kind !== 'method') return true;
      if (!classPrefix) return false;
      const mSep = n.qualifiedName.lastIndexOf('::');
      if (mSep <= 0) return false;
      const methodPrefix = n.qualifiedName.slice(0, mSep);
      // Accept exact-scope matches plus suffix relationships either way, so
      // extension-declared members still match a nested from-scope and vice
      // versa.
      return (
        methodPrefix === classPrefix ||
        methodPrefix.endsWith(`::${classPrefix}`) ||
        classPrefix.endsWith(`::${methodPrefix}`)
      );
    });
    if (candidates.length === 0) return null;
  }

  // Same-file definition wins — the extraction gate guarantees most survivors
  // have one, and it's the dominant C pattern (static callback registered in
  // a same-file ops struct).
  const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) {
    // Swift: several same-named METHODS in one file is an API overload family,
    // and a bare identifier hitting it is almost always a same-named
    // parameter, not a method value — refuse rather than guess. A single
    // method (SwiftUI's `action: handleTap`) still resolves.
    if (
      ref.language === 'swift' &&
      sameFile.length > 1 &&
      sameFile.every((n) => n.kind === 'method')
    ) {
      return null;
    }
    // Same-name overloads in one file are the same conceptual symbol; pick
    // the first by position for determinism.
    const target = sameFile.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      resolvedBy: 'function-ref',
    };
  }

  // Cross-file (imported names the import resolver didn't already claim):
  // only an unambiguous match resolves.
  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      resolvedBy: 'function-ref',
    };
  }
  return null;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}

// Strategy 0.5 gate: receiver types are only inferable from `= new`
// declaration evidence in the languages whose function bodies are indexed
// as statement nodes. Mirrors CODEPLAN_STATEMENT_LANGUAGES in
// extraction/tree-sitter.ts, which is module-local and cannot be imported.
const DECLARATION_EVIDENCE_LANGUAGES: ReadonlySet<Language> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
]);

// Receiver-declaration evidence, strongest first: a direct `= new Class`
// names the class outright; a type annotation names it without constructing;
// a factory call only implies it through the callee's return type.
type ReceiverEvidenceKind = 'new' | 'annotation' | 'factory';

// Captures `receiver = new ClassName` inside statement signatures. Covers
// the three shapes the extractor records: `const receiver = new X(` ,
// `let receiver = new X(`, and bare `receiver = new X(` (reassignment) —
// in all three the word right before `=` is the receiver, so one global
// regex indexes every declaration pair in a file per scan.
const RECEIVER_NEW_DECLARATION = /\b(\w+)\s*=\s*new\s+([A-Za-z_$][\w$]*)/g;
// `receiver = fnName(` / `receiver = await fnName(` — a factory call. The
// callee's return-type annotation names the receiver's class one inference
// hop away (weakest). The optional `await` is the high-yield shape
// (`const cg = await open()` + `open(): Promise<Graph>`); the await flag is
// decided from the match's own span (FACTORY_AWAITED_INIT), so
// multi-declaration statements cannot cross-contaminate. Dotted callees
// (`= await Foo.bar()`) stay out of scope: the bare last segment would not
// say which class owns `bar`.
const RECEIVER_FACTORY_DECLARATION = /\b(\w+)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
// The only `=` inside a factory match is the initializer, and `await` can
// sit only between it and the callee, so testing the matched span is exact.
const FACTORY_AWAITED_INIT = /=\s*await\s/;

// `receiver = [await] Prefix.callee(` — a dotted factory call. The prefix
// pins WHICH member runs (a class's static/instance method, or `this`'s own
// method), and that member's return-type annotation names the receiver's
// class — the same one-hop inference the bare factory makes, for callees the
// bare regex cannot see. Chains deeper than two segments are recorded here
// but never bound (dottedFactoryTypeName falls through on them).
const RECEIVER_DOTTED_FACTORY_DECLARATION =
  /\b(\w+)\s*=\s*(?:await\s+)?((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)\s*\(/g;
// `receiver: TypeName =` / `receiver: TypeName;` — an explicit type
// annotation. Only a simple type name binds here; structured annotations
// go to the keyword-gated variant below (this shape still covers
// keyword-less declarations like class properties).
const RECEIVER_ANNOTATION_DECLARATION = /\b(\w+)\s*:\s*([A-Za-z_$][\w$.]*)\s*[=;]/g;
// Keyword-declaration annotation with full type capture: `const receiver:
// Type` up to a `= ; , )` or newline terminator, so `Promise<Queue>` and
// `readonly Foo` survive capture and unwrapReceiverType decides binding.
// Requiring const/let/var right before the name keeps object literals
// (`{ key: value }`) — and parameter lists, which belong to Strategy 0.5b
// via node.params — out of this evidence stream.
const RECEIVER_ANNOTATION_FULL_DECLARATION =
  /\b(?:const|let|var)\s+(\w+)\s*:\s*([^=;,\n)]+?)(?=\s*[=;,\n)])/g;
// An `= await` sitting right after the annotation's terminator means the
// receiver holds the resolved value (Promise-peelable).
const ANNOTATION_AWAITED_INIT = /^\s*=\s*await\s/;

// Simple-identifier type layer: no generics (`<`), unions (`|`),
// intersections (`&`), function arrows (`=>`), or whitespace. Anything
// else is not structured enough to bind on, so it falls back.
const SIMPLE_TYPE_NAME = /^[\w$.]+$/;

// The only two wrapper shapes this pass understands: a single `Promise<…>`
// layer (peeled only for await-initialized receivers) and a leading
// `readonly` qualifier over a simple name.
const PROMISE_WRAPPING_TYPE = /^Promise\s*<([^<>]+)>$/;
const READONLY_QUALIFIED_TYPE = /^readonly\s+([\w$.]+)$/;

/**
 * Peel a captured receiver type down to the simple project-class name a
 * method call can bind to, or undefined (= not bindable evidence: fall
 * through to the heuristic strategies, never veto).
 *
 * A `Promise<Inner>` type is peeled ONLY when the declaration was
 * await-initialized (`const cg = await open()`). The non-await rule is the
 * whole safety story here: `const q = makePromise()` leaves `q` holding the
 * Promise itself, so `q.push()` is either a builtin Promise call (`q.then`)
 * or statically-broken code — binding it to `Inner.push` would fabricate a
 * `calls` edge no receiver ever dispatches through. Fall-through (undefined)
 * keeps the weaker strategies' chance without claiming a known type.
 *
 * `readonly Inner` is a pure type-space modifier — it peels unconditionally,
 * and so does a nullability union (`X | null` / `X | undefined`): null and
 * undefined declare no methods, so a member call can only dispatch through
 * the sole value-typed member. Everything else is not guessed: `X[]`,
 * `Array<X>`/`ReadonlyArray<X>`, `Partial`/`Pick`/`Omit`/`Record` and other
 * generics, nested `Promise<Promise<X>>` (only one peel layer), multi-member
 * unions, and function types all stay opaque.
 */
function unwrapReceiverType(
  typeText: string,
  opts: { awaitInitialized: boolean },
): string | undefined {
  const trimmed = typeText.trim();
  // Nullable-union peel (pool evidence: `let initializedDb: DatabaseConnection
  // | undefined` then `initializedDb?.close()` — 12 failed refs in-repo).
  // Splitting first makes every `|` inside generic args (`Foo<A | B>`,
  // `Array<A> | null`'s structured survivors) fail the single-simple-member
  // test too, so this arm only ever converts today's opaque fall-through
  // (undefined) into a bindable name or keeps it — it never vetoes.
  if (trimmed.includes('|')) {
    const survivors = trimmed
      .split('|')
      .map((member) => member.trim())
      .filter((member) => member !== 'null' && member !== 'undefined');
    if (survivors.length !== 1) return undefined;
    // Survivors re-enter every rule above unchanged; a member of a split
    // union can no longer contain `|`, so the recursion is one hop deep.
    return unwrapReceiverType(survivors[0]!, opts);
  }
  const promise = PROMISE_WRAPPING_TYPE.exec(trimmed);
  if (promise) {
    if (!opts.awaitInitialized) return undefined;
    const inner = promise[1]!.trim();
    return SIMPLE_TYPE_NAME.test(inner) ? inner : undefined;
  }
  const readonly = READONLY_QUALIFIED_TYPE.exec(trimmed);
  if (readonly) return readonly[1]!;
  return SIMPLE_TYPE_NAME.test(trimmed) ? trimmed : undefined;
}

interface ReceiverDeclaration {
  kind: ReceiverEvidenceKind;
  /** 'new' → class name, 'annotation' → type name, 'factory' → callee name
   *  (possibly dotted: `Prefix.callee` or `this.callee`). */
  name: string;
  line: number;
  /** True when the initializer is awaited — `= await f()` for a factory,
   *  or `= await` right after a `: T` annotation. Only Promise-wrapped
   *  types consult it (unwrapReceiverType); 'new' evidence never sets it. */
  awaitInitialized: boolean;
}

// Priority rank per evidence kind — higher wins when one receiver has
// several declarations. Nearest line breaks ties within a kind.
const RECEIVER_EVIDENCE_PRIORITY: Record<ReceiverEvidenceKind, number> = {
  new: 2,
  annotation: 1,
  factory: 0,
};

interface ReceiverDeclarationEntry {
  /** Identity token: the exact node array the map was built from. When the
   *  resolver clears its per-file cache (sync / post-extract), getNodesInFile
   *  hands back a new array and the entry is rebuilt on the next touch — no
   *  stale declaration evidence survives inside a resolver's lifetime. */
  nodes: Node[];
  decls: Map<string, ReceiverDeclaration[]>;
}

// Per-context memo (WeakMap keyed by the ResolutionContext object): the
// failing-reference batch is ~78k refs, and rescanning a file per ref is
// unacceptable. Keying on the context object (each resolver builds exactly
// one) also means per-file paths from different projects can never alias,
// and the whole cache dies with the resolver.
const RECEIVER_DECL_CACHES = new WeakMap<ResolutionContext, LRUCache<string, ReceiverDeclarationEntry>>();
const RECEIVER_DECL_FILE_LIMIT = 256;

function receiverDeclarationsForFile(
  filePath: string,
  context: ResolutionContext,
): Map<string, ReceiverDeclaration[]> {
  let cache = RECEIVER_DECL_CACHES.get(context);
  if (!cache) {
    cache = new LRUCache<string, ReceiverDeclarationEntry>(RECEIVER_DECL_FILE_LIMIT);
    RECEIVER_DECL_CACHES.set(context, cache);
  }
  const nodes = context.getNodesInFile(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.nodes === nodes) return cached.decls;

  const decls = new Map<string, ReceiverDeclaration[]>();
  const add = (receiver: string, decl: ReceiverDeclaration): void => {
    const existing = decls.get(receiver);
    if (existing) existing.push(decl);
    else decls.set(receiver, [decl]);
  };

  for (const node of nodes) {
    if (node.kind !== 'statement' && node.kind !== 'variable' && node.kind !== 'constant') continue;
    if (!node.signature) continue;
    // variable/constant signatures are initializer-only (`= new X(...)`), so
    // prefix the node name to feed both shapes through the same regex.
    const text = node.kind === 'statement' ? node.signature : `${node.name} ${node.signature}`;
    for (const match of text.matchAll(RECEIVER_NEW_DECLARATION)) {
      add(match[1]!, { kind: 'new', name: match[2]!, line: node.startLine, awaitInitialized: false });
    }
    for (const match of text.matchAll(RECEIVER_FACTORY_DECLARATION)) {
      if (match[2] === 'new') continue; // direct construction handled above
      add(match[1]!, {
        kind: 'factory',
        name: match[2]!,
        line: node.startLine,
        awaitInitialized: FACTORY_AWAITED_INIT.test(match[0]),
      });
    }
    for (const match of text.matchAll(RECEIVER_DOTTED_FACTORY_DECLARATION)) {
      add(match[1]!, {
        kind: 'factory',
        name: match[2]!,
        line: node.startLine,
        awaitInitialized: FACTORY_AWAITED_INIT.test(match[0]),
      });
    }
    for (const match of text.matchAll(RECEIVER_ANNOTATION_DECLARATION)) {
      add(match[1]!, { kind: 'annotation', name: match[2]!, line: node.startLine, awaitInitialized: false });
    }
    for (const match of text.matchAll(RECEIVER_ANNOTATION_FULL_DECLARATION)) {
      add(match[1]!, {
        kind: 'annotation',
        name: match[2]!,
        line: node.startLine,
        awaitInitialized: ANNOTATION_AWAITED_INIT.test(
          match.input.slice((match.index ?? 0) + match[0].length),
        ),
      });
    }
  }

  // Top-level `const q: Queue = ...` is a variable node whose signature holds
  // only the initializer, so annotation evidence for it must come from source.
  const source = context.readFile(filePath);
  if (source) {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const match of line.matchAll(RECEIVER_ANNOTATION_DECLARATION)) {
        add(match[1]!, { kind: 'annotation', name: match[2]!, line: i + 1, awaitInitialized: false });
      }
      for (const match of line.matchAll(RECEIVER_ANNOTATION_FULL_DECLARATION)) {
        add(match[1]!, {
          kind: 'annotation',
          name: match[2]!,
          line: i + 1,
          awaitInitialized: ANNOTATION_AWAITED_INIT.test(
            match.input.slice((match.index ?? 0) + match[0].length),
          ),
        });
      }
      // Source-row backstop for the kernel route, which emits no statement
      // nodes: `= new` / `= factory()` / `= Prefix.factory()` evidence is
      // re-derived from raw source so in-function declarations keep feeding
      // Strategy 0.5 when the stmt-signature loop above has nothing to read.
      // Single-line statements produce byte-identical duplicates of the stmt
      // path's evidence (same kind/name/line/await tuple) — same no-flip
      // property the two coexisting annotation regexes already rely on.
      // Unlike a statement signature this is a raw source row, so a
      // declaration-shaped comment would match verbatim: skip full comment
      // lines (leading `//`, `*` continuation, or `/*` opener). String
      // literals on live code rows stay an accepted risk, same tier as the
      // annotation source scan above.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      for (const match of line.matchAll(RECEIVER_NEW_DECLARATION)) {
        add(match[1]!, { kind: 'new', name: match[2]!, line: i + 1, awaitInitialized: false });
      }
      for (const match of line.matchAll(RECEIVER_FACTORY_DECLARATION)) {
        if (match[2] === 'new') continue; // direct construction handled above
        add(match[1]!, {
          kind: 'factory',
          name: match[2]!,
          line: i + 1,
          awaitInitialized: FACTORY_AWAITED_INIT.test(match[0]),
        });
      }
      for (const match of line.matchAll(RECEIVER_DOTTED_FACTORY_DECLARATION)) {
        add(match[1]!, {
          kind: 'factory',
          name: match[2]!,
          line: i + 1,
          awaitInitialized: FACTORY_AWAITED_INIT.test(match[0]),
        });
      }
    }
  }

  cache.set(filePath, { nodes, decls });
  return decls;
}

/**
 * Highest-priority declaration at or before the call line; ties within a
 * kind go to the nearest line (reassignment retypes the receiver).
 */
function selectReceiverDeclaration(
  declarations: ReceiverDeclaration[] | undefined,
  callLine: number,
): ReceiverDeclaration | null {
  let best: ReceiverDeclaration | null = null;
  for (const candidate of declarations ?? []) {
    if (candidate.line > callLine) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const candidateRank = RECEIVER_EVIDENCE_PRIORITY[candidate.kind];
    const bestRank = RECEIVER_EVIDENCE_PRIORITY[best.kind];
    if (candidateRank > bestRank || (candidateRank === bestRank && candidate.line >= best.line)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Resolve a declaration to the simple type name whose method the receiver
 * call must target, or undefined when the evidence carries no class-bearing
 * name (opaque shapes included — see unwrapReceiverType). Factory evidence
 * needs a same-language function/method whose `returnType` unwraps to a
 * simple identifier; a `Promise<Inner>` return only counts when the
 * declaration awaited the call. Same-file factories win over
 * import-reachable cross-file ones.
 */
function declaredReceiverTypeName(
  declared: ReceiverDeclaration,
  ref: UnresolvedRef,
  context: ResolutionContext,
  imports: ImportMapping[],
): string | undefined {
  if (declared.kind !== 'factory') {
    return unwrapReceiverType(declared.name, { awaitInitialized: declared.awaitInitialized });
  }
  if (declared.name.includes('.')) {
    return dottedFactoryTypeName(declared, ref, context, imports);
  }

  const factories = context
    .getNodesByName(declared.name)
    .filter((n) => (n.kind === 'function' || n.kind === 'method') && n.language === ref.language);
  const reachable = factories.filter(
    (n) => n.filePath === ref.filePath || crossFileCandidateAllowed(ref, n, imports),
  );
  const ordered = [
    ...reachable.filter((n) => n.filePath === ref.filePath),
    ...reachable.filter((n) => n.filePath !== ref.filePath),
  ];
  for (const candidate of ordered) {
    if (!candidate.returnType) continue;
    const typeName = unwrapReceiverType(candidate.returnType, {
      awaitInitialized: declared.awaitInitialized,
    });
    if (typeName) return typeName;
  }
  return undefined;
}

/**
 * Dotted factory evidence (`const cg = await CodeGraph.open(...)`,
 * `cg = this.getCodeGraph(...)`): resolve the callee to a method whose
 * qualified name ends `<prefix>::<callee>` (or, for `this.`, a method in the
 * caller's own file), then read its return type under the same await/Promise
 * rule as every other factory. An unresolvable prefix — any object that is
 * not a graph-known member — yields undefined (fall-through), never a veto.
 */
function dottedFactoryTypeName(
  declared: ReceiverDeclaration,
  ref: UnresolvedRef,
  context: ResolutionContext,
  imports: ImportMapping[],
): string | undefined {
  const segments = declared.name.split('.');
  const callee = segments.pop()!;
  const prefix = segments.pop()!;
  if (segments.length > 0) return undefined; // `a.b.c()` — too deep to trust

  const viaThis = prefix === 'this';
  const methods = context
    .getNodesByName(callee)
    .filter((n) => n.kind === 'method' && n.language === ref.language)
    .filter((n) => {
      if (viaThis) return n.filePath === ref.filePath;
      const parts = n.qualifiedName.split(/::|\./);
      return parts.length >= 2 && parts[parts.length - 2] === prefix && parts[parts.length - 1] === callee;
    });
  const reachable = methods.filter(
    (n) => n.filePath === ref.filePath || crossFileCandidateAllowed(ref, n, imports),
  );
  const ordered = [
    ...reachable.filter((n) => n.filePath === ref.filePath),
    ...reachable.filter((n) => n.filePath !== ref.filePath),
  ];
  for (const candidate of ordered) {
    if (!candidate.returnType) continue;
    const typeName = unwrapReceiverType(candidate.returnType, {
      awaitInitialized: declared.awaitInitialized,
    });
    if (typeName) return typeName;
  }
  return undefined;
}

// A receiver's declared type may also name a TypeScript type alias whose
// object shape carries first-class members: extractTsTypeAliasMembers emits
// `X::m` method nodes for `type X = { m(): T }`, so those aliases bind
// receiver calls exactly like a class/struct/interface would.
function isReceiverContainerCandidate(node: Node, language: Language): boolean {
  return (
    (node.kind === 'class' ||
      node.kind === 'struct' ||
      node.kind === 'union' ||
      node.kind === 'interface' ||
      node.kind === 'type_alias') &&
    node.language === language
  );
}

/**
 * Relative specifier that names THIS candidate file exactly: caller dir +
 * specifier (normalized) must equal the candidate's directory and file-name
 * tail — strict path identity, unlike the loose same-name-tail arm the plain
 * allow-check uses (that would pin every same-named file and make the
 * disambiguation layer meaningless).
 */
function relativeSourceNamesFile(candidateFilePath: string, ref: UnresolvedRef, source: string): boolean {
  if (!source.startsWith('./') && !source.startsWith('../')) return false;
  const resolved = normalizeRelativeSegments([
    ...ref.filePath.split('/').slice(0, -1),
    ...source.split('/'),
  ]);
  if (!resolved) return false;
  const candidateSegments = candidateFilePath.split('/');
  const fileTail = fileTailNoExt(candidateSegments[candidateSegments.length - 1] ?? '');
  if (resolved[resolved.length - 1] !== fileTail) return false;
  const candidateDir = candidateSegments.slice(0, -1);
  if (candidateDir.length !== resolved.length - 1) return false;
  return candidateDir.every((segment, i) => segment === resolved[i]);
}

/**
 * Import evidence that pins WHICH file a candidate came from: exact resolved
 * path, a relative specifier naming the candidate file, or a directory-barrel
 * specifier — the file-path sibling of the qualified-name suffix check in
 * `matchByQualifiedName`. Used only to DISAMBIGUATE (a unique pin selects);
 * it never vetoes, so a candidate the plain import veto allowed stays allowed.
 */
function importPinsFile(candidateFilePath: string, ref: UnresolvedRef, imports: ImportMapping[]): boolean {
  for (const imp of imports) {
    if (
      imp.resolvedPath &&
      (imp.resolvedPath === candidateFilePath ||
        imp.resolvedPath.endsWith('/' + candidateFilePath) ||
        candidateFilePath.endsWith('/' + imp.resolvedPath))
    ) {
      return true;
    }
    if (imp.source && relativeSourceNamesFile(candidateFilePath, ref, imp.source)) return true;
    if (imp.source && barrelImportReachesFile(ref, candidateFilePath, imp.source)) return true;
  }
  return false;
}

/**
 * Same-name container disambiguation for receiver-type binding. Plain
 * `find()` takes whichever candidate the name index happens to return
 * first — a coin flip when several files declare `Prompt` (or a test-local
 * `Database`). Conservative layering: a layer only decides when its result
 * is UNIQUE, any ambiguity falls to the next layer, and the last layer is
 * the old first-allowed behavior (no regression):
 *  1. exactly one allowed candidate lives in the caller's own file;
 *  2. exactly one allowed candidate is pinned by an import statement;
 *  3. the first allowed candidate (status quo).
 */
function pickContainerCandidate(
  candidates: Node[],
  ref: UnresolvedRef,
  imports: ImportMapping[],
): Node | undefined {
  const allowed = candidates.filter((n) => crossFileCandidateAllowed(ref, n, imports));
  const sameFile = allowed.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length === 1) return sameFile[0];
  const pinned = allowed.filter((n) => importPinsFile(n.filePath, ref, imports));
  if (pinned.length === 1) return pinned[0];
  return allowed[0];
}

/**
 * Whether an inferred receiver type names a JS/TS builtin global or a TS
 * primitive (D7 tables): such a receiver's member calls are library calls,
 * never project methods (#1566/#1840). Only consulted when the type has no
 * project class node — a project type shadowing a builtin keeps its binding.
 */
function builtinReceiverVeto(typeName: string, ref: UnresolvedRef): boolean {
  return ESM_FAMILY.has(ref.language) && (JS_BUILT_INS.has(typeName) || TS_PRIMITIVE_TYPES.has(typeName));
}
/**
 * Strategy 0.5: resolve `receiver.method()` from declaration evidence — an
 * earlier `receiver = new ClassName()` / `receiver: TypeName` /
 * `receiver = factory()` declaration in the same file names the receiver's
 * class exactly (a `Promise<Inner>` factory/annotation type only counts
 * when awaited), which is a tier above the word-overlap guessing in
 * Strategies 1-3.
 *
 * Tri-state: `undefined` = no usable declaration evidence (fall through to
 * the heuristic strategies, zero behavior change); `null` = evidence found
 * and the declared class has no such method (veto the heuristics — the
 * receiver type is known, another class's same-named method cannot be it);
 * otherwise the bound method node.
 */
function matchMethodCallByDeclaration(
  receiverName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null | undefined {
  const declared = selectReceiverDeclaration(
    receiverDeclarationsForFile(ref.filePath, context).get(receiverName),
    ref.line,
  );
  if (!declared) return undefined;

  const imports = refImportMappings(ref, context);
  const typeName = declaredReceiverTypeName(declared, ref, context, imports);
  // Evidence whose type carries no graph class (builtins like Map/Set/Date),
  // is not a simple identifier, or is vetoed by the caller file's imports is
  // not evidence we can bind on — fall through instead of vetoing.
  if (!typeName) return undefined;

  const classCandidates = context
    .getNodesByName(typeName)
    .filter((n) => isReceiverContainerCandidate(n, ref.language));
  const declClass = pickContainerCandidate(classCandidates, ref, imports);
  // A known JS/TS builtin or primitive receiver type with no project class is
  // EXTERNAL (#1566/#1840): `m.get()` on a `Map`, `listed.split()` on a
  // `string` are built-in methods, and the heuristic strategies must not hand
  // the call whichever project class declares a lone same-named method. A
  // project type SHADOWING a builtin keeps its binding (the class lookup above
  // found it). Other untyped shapes fall through instead of vetoing.
  if (!declClass) return builtinReceiverVeto(typeName, ref) ? null : undefined;

  const declClassName = declClass.name;
  const methodNode = context.getNodesInFile(declClass.filePath).find(
    (n) => n.kind === 'method' && n.name === methodName && n.qualifiedName.includes(declClassName),
  );
  // Declaration evidence is authoritative: the receiver's class is known, so
  // a method it does not declare must not bind to another class's guess.
  if (!methodNode) return null;
  if (!crossFileCandidateAllowed(ref, methodNode, imports)) return null;
  return {
    original: ref,
    targetNodeId: methodNode.id,
    resolvedBy: 'instance-method',
  };
}

interface TypedFunctionEntry {
  /** Identity token, see ReceiverDeclarationEntry. */
  nodes: Node[];
  /** Function/method nodes that carry typed parameter pairs. */
  functions: Node[];
}

// Same per-context memo pattern as RECEIVER_DECL_CACHES: the enclosing-
// function lookup scans a file's node list, and the failing-ref batch makes
// a per-ref rescan unacceptable.
const TYPED_FN_CACHES = new WeakMap<ResolutionContext, LRUCache<string, TypedFunctionEntry>>();
const TYPED_FN_FILE_LIMIT = 256;

function typedFunctionsForFile(filePath: string, context: ResolutionContext): Node[] {
  let cache = TYPED_FN_CACHES.get(context);
  if (!cache) {
    cache = new LRUCache<string, TypedFunctionEntry>(TYPED_FN_FILE_LIMIT);
    TYPED_FN_CACHES.set(context, cache);
  }
  const nodes = context.getNodesInFile(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.nodes === nodes) return cached.functions;

  const functions = nodes.filter(
    (n) => (n.kind === 'function' || n.kind === 'method') && n.params?.length,
  );
  cache.set(filePath, { nodes, functions });
  return functions;
}

/**
 * Strategy 0.5b: resolve `receiver.method()` from a type annotation on the
 * enclosing function's parameter — `function f(q: Queue) { q.push() }`
 * binds `q.push` to `Queue.push`. Parameters are the largest remaining
 * receiver-type source (`= new` never names them). Tri-state, class lookup,
 * and veto semantics mirror matchMethodCallByDeclaration exactly; this runs
 * only when no `= new` declaration exists for the receiver (above), so a
 * conflicting declaration always wins.
 */
function matchMethodCallByParamType(
  receiverName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null | undefined {
  // Every typed function/method containing the call line, innermost first.
  // A receiver typed on an ENCLOSING function's parameter is still visible
  // in nested bodies (closure parameters), and the innermost declaration of
  // the same name shadows outer ones — so the walk stops at the first hit.
  const covering = typedFunctionsForFile(ref.filePath, context)
    .filter((fn) => fn.startLine <= ref.line && (fn.endLine ?? fn.startLine) >= ref.line)
    .sort((a, b) => b.startLine - a.startLine);
  let param: NonNullable<Node['params']>[number] | undefined;
  for (const fn of covering) {
    param = fn.params?.find((p) => p.name === receiverName);
    if (param) break;
  }
  if (!param) return undefined;
  // Parameters hold exactly what callers pass — a `Promise<X>` parameter
  // is the Promise itself (never await-initialized), so only a simple
  // annotated type (or `readonly X`) binds; everything else falls through.
  const declaredType = unwrapReceiverType(param.type, { awaitInitialized: false });
  if (!declaredType) return undefined;

  // `db.Queue` names the class `Queue` — match on the trailing segment.
  const typeName = declaredType.split('.').pop() ?? declaredType;
  const imports = refImportMappings(ref, context);
  const classCandidates = context
    .getNodesByName(typeName)
    .filter((n) => isReceiverContainerCandidate(n, ref.language));
  // An annotated type with no graph class (builtins like Promise/Map) or one
  // vetoed by the caller file's imports is not evidence we can bind on —
  // fall through instead of vetoing, except for the builtin/primitive veto
  // (#1566/#1840) which declines the heuristics outright.
  const paramClass = pickContainerCandidate(classCandidates, ref, imports);
  if (!paramClass) return builtinReceiverVeto(typeName, ref) ? null : undefined;

  const methodNode = context.getNodesInFile(paramClass.filePath).find(
    (n) => n.kind === 'method' && n.name === methodName && n.qualifiedName.includes(paramClass.name),
  );
  // The annotation is authoritative: the receiver's class is known, so a
  // method it does not declare must not bind to another class's guess.
  if (!methodNode) return null;
  if (!crossFileCandidateAllowed(ref, methodNode, imports)) return null;
  return {
    original: ref,
    targetNodeId: methodNode.id,
    resolvedBy: 'instance-method',
  };
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method". The
  // receiver allows dots (`this.field.method` #1496, `self.inner.run` #1585,
  // `target.conn.Exec` #1276, `builder.Services.AddCoreServices`) so a CHAINED
  // call reaches its dedicated exclusive branch below or resolves by its last
  // segment. The method part allows trailing `:` keywords so Objective-C
  // selectors resolve (`SDImageCache.storeImage:`); colons never appear in
  // other languages' method refs, so this is a no-op for them. C++ explicit
  // operator call `a.operator+(b)` reaches the resolver as `a.operator+`
  // (#1247) — the operator's symbol chars fail the \w method part of the plain
  // pattern, so admit them explicitly; every downstream strategy compares the
  // method part by exact string equality, so a stray match can't invent an edge.
  const dotMatch =
    ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/) ??
    (ref.language === 'cpp'
      ? ref.referenceName.match(/^([\w.]+)\.(operator[^\w\s.]+)$/)
      : null);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);

  const match = dotMatch || colonMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;

  if (ref.language === 'cpp' && dotMatch) {
    const inferredType = inferCppReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        'instance-method',
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Go 2-hop field chain `base.field.Method` (#1276). EXCLUSIVE for chained Go
  // receivers. Scope-narrowed port: upstream infers `base`'s type through its
  // generic #1108 local-declaration inference, which this fork skeleton does
  // not carry (the fork's d2 declaration evidence covers simple receivers in
  // its own languages); without a validated base type the ref must stay
  // UNRESOLVED rather than fall through to the bare-name strategies below —
  // which is exactly how `target.conn.Exec(...)` fabricated a dependency on an
  // unrelated local interface's same-named method. (Pending-parent: a full
  // #1108 port would recover the inference recall here.)
  if (ref.language === 'go' && dotMatch && objectOrClass!.includes('.')) {
    return null;
  }

  // Rust call through a field of the enclosing type — `self.inner.run()`,
  // emitted as `self.inner.run` (#1585). EXCLUSIVE: validated field-type
  // inference or nothing.
  if (ref.language === 'rust' && dotMatch && objectOrClass!.startsWith('self.')) {
    return matchRustSelfFieldCall(objectOrClass!.slice('self.'.length), methodName!, ref, context);
  }

  // Rust call on the enclosing type itself — `self.reset()`, emitted as
  // `self.reset` (#1861). EXCLUSIVE for the same reason: the owner is written
  // on the `impl` line and carried in the calling method's qualified name, so
  // it is not a guess. Letting this shape reach the bare-name strategies below
  // is how `self.reset()` resolved to a same-named method on an unrelated type
  // whenever that type's method happened to sit nearer the call site.
  if (ref.language === 'rust' && dotMatch && objectOrClass === 'self') {
    return matchRustSelfCall(methodName!, ref, context);
  }

  // TS/JS call through a field of the enclosing class — `this.mailer.send()`,
  // emitted as `this.mailer.send` (#1496). EXCLUSIVE: the field's declared type
  // off the class's own declaration, validated by resolveMethodOnType, or
  // nothing. Letting the bare name through is how `this.mailer.send()` inside
  // `Notifier.send()` resolved to the calling method itself — a self-edge the
  // source does not contain — whenever the two shared a name.
  if (JS_FAMILY.has(ref.language) && dotMatch && objectOrClass!.startsWith('this.')) {
    return matchTsThisFieldCall(objectOrClass!.slice('this.'.length), methodName!, ref, context);
  }


  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        'instance-method',
        importedFqn,
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Strategy 0.5: declaration-evidence receiver type (`const q = new Queue()`
  // then `q.push()`). Only dot receivers, only languages whose statements the
  // extractor indexes (see DECLARATION_EVIDENCE_LANGUAGES).
  if (dotMatch && DECLARATION_EVIDENCE_LANGUAGES.has(ref.language)) {
    const declarationMatch = matchMethodCallByDeclaration(objectOrClass!, methodName!, ref, context);
    if (declarationMatch !== undefined) {
      return declarationMatch;
    }
    // No `= new` evidence for this receiver — a typed parameter on the
    // enclosing function is the next-strongest declaration of its type.
    const paramTypeMatch = matchMethodCallByParamType(objectOrClass!, methodName!, ref, context);
    if (paramTypeMatch !== undefined) {
      return paramTypeMatch;
    }
  }

  // Object-literal namespace receiver (#1573): `api.call()` where `api` is a
  // same-file `const api = { call() {…}, get: () => {…} }`. Its members are
  // plain functions with bare names inside the constant's extent — no
  // `Container::member` qualified name — so none of the class-shaped strategies
  // below can see them (Strategy 3 only considers `method` kinds). Same file
  // only: a cross-file use reaches the same helper through the import path.
  if (dotMatch && !objectOrClass!.includes('.') && OBJECT_LITERAL_LANGUAGES.has(ref.language)) {
    const holders = preferCallSiteFile(context.getNodesByName(objectOrClass!), ref.filePath).filter(
      (n) => (n.kind === 'constant' || n.kind === 'variable') && n.filePath === ref.filePath
    );
    for (const holder of holders) {
      const hit = resolveObjectLiteralMember(holder, methodName!, ref, context, 'instance-method');
      if (hit) return hit;
    }
  }

  // Strategy 1: Direct class name match (existing logic)
  const classCandidates = context.getNodesByName(objectOrClass!);

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'union' || classNode.kind === 'interface') {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver);
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'union' || classNode.kind === 'interface') {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            resolvedBy: 'instance-method',
          };
        }
      }
    }
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!);

    // Same-name ceiling: refuse to guess when a name repeats beyond any real
    // codebase; precise strategies already tried above stay unaffected.
    if (methodCandidates.length > AMBIGUOUS_NAME_CEILING) return null;
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // Filter to same-language candidates first
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

    // If only one same-language method with this name exists, use it. Veto
    // only this branch: a single candidate offers no receiver-word evidence
    // to fall back on, so a cross-file bind must be import-reachable like the
    // exact/fuzzy name matches.
    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      const imports = refImportMappings(ref, context);
      if (!crossFileCandidateAllowed(ref, targetMethods[0]!, imports)) {
        return null;
      }
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!);
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      for (const method of targetMethods) {
        const classWords = splitCamelCase(method.qualifiedName);
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          resolvedBy: 'instance-method',
        };
      }
    }
  }

  return null;
}

/**
 * Split a camelCase or PascalCase string into words.
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += computePathProximity(ref.filePath, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'union' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort.
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind));

  // Same import-aware veto as exact matching
  const fuzzyImports = refImportMappings(ref, context);
  const reachableCandidates = callableCandidates.filter((n) => crossFileCandidateAllowed(ref, n, fuzzyImports));

  // Prefer same-language matches
  const sameLanguageCandidates = reachableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : reachableCandidates;

  // Post-rank survivor validation (upstream N guards; K-v2 P5-1 / D8). The
  // sealed-module / visibility tests reject the survivor and never filter the
  // set that produced it: removing a sealed candidate from a crowd would leave
  // a lone one and manufacture a guess out of an ambiguity fuzzy declines.
  // Also decline a bare JS/TS call whose only survivor is a method (#1714) or
  // a cross-file name the file already binds locally. Reachability may reject
  // a unique guess; it must never manufacture one.
  if (finalCandidates.length === 1) {
    const survivor = finalCandidates[0]!;
    if (
      isVisibleAcrossFiles(survivor, ref, context) &&
      isCrossFileReachable(survivor, ref, context) &&
      !(isBareJsCall(ref, context) &&
        (survivor.kind === 'method' ||
          (survivor.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context))))
    ) {
      return {
        original: ref,
        targetNodeId: survivor.id,
        resolvedBy: 'fuzzy',
      };
    }
  }

  return null;
}

/**
 * Match all strategies in a fixed try order (first hit wins) — the order is
 * evidence strength, not a calibrated probability.
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Function-as-value refs (#756) resolve ONLY through the dedicated matcher —
  // never the fuzzy/qualified fallthrough below (a wrong callback edge is
  // worse than none).
  if (ref.referenceKind === 'function_ref') {
    return matchFunctionRef(ref, context);
  }

  // A retained untyped qualified chain (`a.b.c`, 3+ segments — the emitter
  // keeps it as source evidence, never as permission to infer a property
  // type): nothing below may guess for it. The method-call pattern rejects
  // the shape, exact name never matches, but fuzzy would hand `a.b.c` to any
  // same-named symbol. Framework resolvers with receiver evidence ran BEFORE
  // this point (resolveOne) and keep their claim.
  if (isUnresolvedJsMemberCall(ref)) return null;

  // Try strategies in fixed order (first hit wins)
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. Qualified name match
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 1b. C++ chained call whose receiver is another call — `Foo::instance().bar()`
  // encoded as `Foo::instance().bar` by the extractor (#645). Resolve the
  // receiver's type from what the inner call returns, then the method on it.
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = matchCppCallChain(ref, context);
    if (result) return result;
  }

  // 1c. `::`-scoped factory chain — PHP `Cls::for($x)->method()` (#608) or Rust
  // `Foo::new().bar()`, both encoded as `Cls::factory().method`. The receiver's
  // type is the factory's `self` (PHP `: self`/`: static`, Rust `-> Self`) or
  // concrete return type.
  if (ref.language === 'php' || ref.language === 'rust') {
    result = matchScopedCallChain(ref, context);
    if (result) return result;
  }

  // 1d. Dotted chained static-factory / fluent call (Java / Kotlin / C# / Swift /
  // Go / Scala / Dart / Objective-C / Pascal) — `Foo.getInstance().bar()`
  // encoded as `Foo.getInstance().bar` (#645/#608 mechanism). Resolve the
  // method's class from the inner call's declared return type, then validate it.
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart' ||
    ref.language === 'objc' ||
    ref.language === 'pascal'
  ) {
    result = matchDottedCallChain(ref, context);
    if (result) return result;
  }

  // A call-receiver chain the extractor encoded as `<inner>().<method>` for a
  // language with no chain resolver above (TS/JS, Python — #1683) is a
  // receiver whose type is unknown. Nothing below may guess for it: the
  // method-call pattern rejects the parens, exact name never matches, but the
  // fuzzy strategy would hand `make().run` to any `run` — the fabricated edge
  // the encoding exists to prevent. The store-accessor fallback is the ONE
  // kept resolution; its answer (including null) is final.
  if (
    ref.referenceName.includes('().') &&
    (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'python')
  ) {
    return matchStoreAccessorChain(ref, context);
  }

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}