import type {
  FrozenSemanticObject,
  Language,
  LanguageAwareSignal,
  LanguageAwareSignalDiffInput,
  LanguageAwareSignalKind,
  LanguageAwareSignalQuality,
  LanguageAwareSignalSource,
  Node,
  SourceRange,
} from '../types';

const TS_JS_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);
const CALLABLE_KINDS = new Set<Node['kind']>(['function', 'method', 'component']);
const CALLER_VISIBLE_BODY_SIGNAL_KINDS = new Set<LanguageAwareSignalKind>([
  'return_value_changed',
  'this_field_write',
  'parameter_mutation',
  'global_or_module_state_write',
]);
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'add', 'delete', 'clear']);

type FullSourceRange = Required<SourceRange>;
type SignalDraft = {
  kind: LanguageAwareSignalKind;
  line: number;
  reason: string;
  quality?: LanguageAwareSignalQuality;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

function isTsJsLanguage(language: Language): boolean {
  return TS_JS_LANGUAGES.has(language);
}

function isCallable(node: Node | FrozenSemanticObject): boolean {
  return CALLABLE_KINDS.has('payload' in node ? node.payload.kind : node.kind);
}

function range(startLine: number, endLine = startLine, startColumn = 0, endColumn = Number.MAX_SAFE_INTEGER): FullSourceRange {
  return { startLine, endLine, startColumn, endColumn };
}

function normalizeRange(input: SourceRange): FullSourceRange {
  return range(input.startLine, input.endLine ?? input.startLine, input.startColumn ?? 0, input.endColumn ?? Number.MAX_SAFE_INTEGER);
}

function rangeIntersects(left: SourceRange | undefined, right: SourceRange | undefined): boolean {
  if (!left || !right) return false;
  const a = normalizeRange(left);
  const b = normalizeRange(right);
  return a.startLine <= b.endLine && a.endLine >= b.startLine && a.startColumn <= b.endColumn && a.endColumn >= b.startColumn;
}

function sourceLines(source: string): string[] {
  return source.split(/\r?\n/);
}

function nodeLines(node: Node, source: string): Array<{ line: number; text: string }> {
  const lines = sourceLines(source);
  return lines.slice(Math.max(0, node.startLine - 1), node.endLine).map((text, index) => ({
    line: node.startLine + index,
    text,
  }));
}

function nodeText(node: Node, source: string): string {
  return nodeLines(node, source).map((line) => line.text).join('\n');
}

function isDeclarationOf(line: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(name)}\\b`).test(line);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitParameters(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '<' || char === '(' || char === '[' || char === '{') depth++;
    if (char === '>' || char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parameterNames(signature: string | undefined): string[] {
  if (!signature) return [];
  const params = signature.match(/\(([^)]*)\)/)?.[1];
  if (!params) return [];
  return splitParameters(params).flatMap((param) => {
    const cleaned = param
      .replace(/=.*/, '')
      .replace(/\b(?:public|private|protected|readonly|override)\b/g, '')
      .trim();
    const name = cleaned.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)\??\s*(?::|$)/)?.[1];
    return name ? [name] : [];
  });
}

function moduleVariables(source: string, node: Node): string[] {
  return [...new Set(sourceLines(source).flatMap((line, index) => {
    const lineNumber = index + 1;
    if (lineNumber >= node.startLine && lineNumber <= node.endLine) return [];
    const declaration = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    return declaration?.[1] ? [declaration[1]] : [];
  }))];
}

function localVariables(lines: Array<{ line: number; text: string }>): string[] {
  return [...new Set(lines.flatMap((line) => {
    const declaration = line.text.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    return declaration?.[1] ? [declaration[1]] : [];
  }))];
}

function signal(input: {
  kind: LanguageAwareSignalKind;
  language: Language;
  source?: LanguageAwareSignalSource;
  quality?: LanguageAwareSignalQuality;
  confidence?: number;
  line?: number;
  range?: SourceRange;
  reason: string;
  metadata?: Record<string, unknown>;
}): LanguageAwareSignal {
  const source = input.source ?? 'codegraph:language_analyzer';
  const quality = input.quality ?? 'heuristic';
  return {
    schemaVersion: 1,
    kind: input.kind,
    language: input.language,
    source,
    quality,
    confidence: input.confidence ?? (quality === 'exact' ? 0.95 : quality === 'unknown' ? 0.5 : 0.75),
    range: input.range ?? (input.line ? range(input.line) : undefined),
    reason: input.reason,
    metadata: input.metadata,
    signals: [
      `language:${input.language}`,
      `source:${source}`,
      `quality:${quality}`,
      `codegraph_language_signal:${input.kind}`,
    ],
  };
}

function dedupe(signals: LanguageAwareSignal[]): LanguageAwareSignal[] {
  return [...new Map(signals.map((item) => [`${item.kind}:${item.range?.startLine ?? 'node'}:${item.range?.endLine ?? 'node'}:${item.reason}`, item])).values()];
}

function draftSignal(input: SignalDraft, language: Language): LanguageAwareSignal {
  return signal({
    kind: input.kind,
    language,
    line: input.line,
    reason: input.reason,
    quality: input.quality,
    confidence: input.confidence,
    metadata: input.metadata,
  });
}

function analyzeTsJsBodySignals(node: Node, source: string): LanguageAwareSignal[] {
  const lines = nodeLines(node, source);
  const params = parameterNames(node.signature);
  const locals = new Set(localVariables(lines));
  const globals = moduleVariables(source, node);
  const drafts: SignalDraft[] = [];

  for (const line of lines) {
    const text = line.text;
    if (/\breturn\b\s+[^;\s}]/.test(text) || /=>\s*(?!\{)\S/.test(text)) {
      drafts.push({
        kind: 'return_value_changed',
        line: line.line,
        reason: 'TS/JS callable has a return value site intersectable by changed hunks',
      });
    }
    if (/\bthis\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])?\s*(?:=|\+=|-=|\*=|\/=|%=|\+\+|--)/.test(text) || /(?:\+\+|--)\s*this\.[A-Za-z_$][\w$]*/.test(text)) {
      drafts.push({
        kind: 'this_field_write',
        line: line.line,
        reason: 'TS/JS callable writes through this.<field>',
      });
    }
    if (/\bthis\.[A-Za-z_$][\w$]*/.test(text)) {
      drafts.push({
        kind: 'field_access',
        line: line.line,
        reason: 'TS/JS callable accesses this.<field>',
        confidence: 0.65,
      });
    }
    for (const param of params) {
      const escaped = escapeRegex(param);
      const propertyWrite = new RegExp(`\\b${escaped}(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])\\s*(?:=|\\+=|-=|\\*=|\\/=|%=|\\+\\+|--)`).test(text);
      const prefixWrite = new RegExp(`(?:\\+\\+|--)\\s*${escaped}(?:\\b|\\.|\\[)`).test(text);
      const mutatingCall = new RegExp(`\\b${escaped}\\.(?<method>[A-Za-z_$][\\w$]*)\\s*\\(`).exec(text)?.groups?.method;
      if (propertyWrite || prefixWrite || (mutatingCall && MUTATING_METHODS.has(mutatingCall))) {
        drafts.push({
          kind: 'parameter_mutation',
          line: line.line,
          reason: `TS/JS callable mutates parameter ${param}`,
          metadata: { parameter: param },
        });
      }
    }
    for (const global of globals) {
      if (locals.has(global) || isDeclarationOf(text, global)) continue;
      const escaped = escapeRegex(global);
      if (new RegExp(`\\b${escaped}(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\])?\\s*(?:=|\\+=|-=|\\*=|\\/=|%=|\\+\\+|--)`).test(text) || new RegExp(`(?:\\+\\+|--)\\s*${escaped}\\b`).test(text)) {
        drafts.push({
          kind: 'global_or_module_state_write',
          line: line.line,
          reason: `TS/JS callable writes module-scope binding ${global}`,
          metadata: { binding: global },
        });
      }
    }
  }

  return dedupe(drafts.map((item) => draftSignal(item, node.language)));
}

export function projectLanguageAwareSignals(node: Node, source: string | undefined, options: { hasOverrideRelation?: boolean } = {}): LanguageAwareSignal[] {
  const signals: LanguageAwareSignal[] = [];
  const nodeRange = range(node.startLine, node.endLine, node.startColumn, node.endColumn);
  if (!isTsJsLanguage(node.language)) {
    return isCallable(node)
      ? [signal({
          kind: 'unknown_body_effect',
          language: node.language,
          source: 'codegraph:fallback',
          quality: 'unknown',
          confidence: 0.45,
          range: nodeRange,
          reason: 'language-aware body effects are not implemented for this language',
        })]
      : [];
  }

  if (node.kind === 'route') {
    signals.push(signal({
      kind: 'route_handler_like',
      language: node.language,
      quality: 'exact',
      confidence: 0.95,
      range: nodeRange,
      reason: 'CodeGraph framework resolver projected this node as a route handler',
    }));
  }

  if (!source) {
    return isCallable(node)
      ? [signal({
          kind: 'unknown_body_effect',
          language: node.language,
          source: 'codegraph:fallback',
          quality: 'unknown',
          confidence: 0.45,
          range: nodeRange,
          reason: 'source text was unavailable for TS/JS body-effect analysis',
        }), ...signals]
      : signals;
  }

  const text = nodeText(node, source);
  if (node.kind === 'method' && (node.name === 'constructor' || /^\s*(?:public|private|protected)?\s*constructor\s*\(/m.test(text))) {
    signals.push(signal({
      kind: 'constructor_like',
      language: node.language,
      quality: 'exact',
      confidence: 0.95,
      range: nodeRange,
      reason: 'TS/JS method uses constructor syntax',
    }));
  }
  if (options.hasOverrideRelation || /\boverride\b/.test(text.split('{')[0] ?? text)) {
    signals.push(signal({
      kind: 'override_like',
      language: node.language,
      quality: options.hasOverrideRelation ? 'exact' : 'heuristic',
      confidence: options.hasOverrideRelation ? 0.95 : 0.8,
      range: nodeRange,
      reason: options.hasOverrideRelation ? 'CodeGraph override relation points from this method' : 'TS/JS method uses an override modifier',
    }));
  }
  if (isCallable(node)) signals.push(...analyzeTsJsBodySignals(node, source));
  if (isCallable(node) && signals.length === 0) {
    signals.push(signal({
      kind: 'unknown_body_effect',
      language: node.language,
      source: 'codegraph:fallback',
      quality: 'unknown',
      confidence: 0.45,
      range: nodeRange,
      reason: 'TS/JS callable body had no recognized body-effect sites',
    }));
  }
  return dedupe(signals);
}

function nodeLanguage(input: LanguageAwareSignalDiffInput): Language {
  return input.after?.payload.language ?? input.before?.payload.language ?? 'unknown';
}

function nodeBodyRange(input: LanguageAwareSignalDiffInput): SourceRange | undefined {
  return input.after?.payload.range ?? input.before?.payload.range;
}

function bodyChangeRange(input: LanguageAwareSignalDiffInput): SourceRange | undefined {
  return input.hunk?.newRange ?? input.hunk?.oldRange ?? nodeBodyRange(input);
}

function signalsIntersectingHunk(input: LanguageAwareSignalDiffInput): LanguageAwareSignal[] {
  const beforeMatches = (input.before?.payload.languageSignals ?? [])
    .filter((item) => CALLER_VISIBLE_BODY_SIGNAL_KINDS.has(item.kind))
    .filter((item) => rangeIntersects(item.range, input.hunk?.oldRange));
  const afterMatches = (input.after?.payload.languageSignals ?? [])
    .filter((item) => CALLER_VISIBLE_BODY_SIGNAL_KINDS.has(item.kind))
    .filter((item) => rangeIntersects(item.range, input.hunk?.newRange));
  return dedupe([...beforeMatches, ...afterMatches]);
}

function hasUnknownBodyEffect(input: LanguageAwareSignalDiffInput): boolean {
  return [...(input.before?.payload.languageSignals ?? []), ...(input.after?.payload.languageSignals ?? [])].some((item) => item.kind === 'unknown_body_effect');
}

export function diffNodeLanguageSignals(input: LanguageAwareSignalDiffInput): LanguageAwareSignal[] {
  const language = nodeLanguage(input);
  const bodyRange = bodyChangeRange(input);
  if (!isCallable(input.after ?? input.before ?? { payload: { kind: 'file' } } as FrozenSemanticObject)) return [];
  if (!isTsJsLanguage(language) || hasUnknownBodyEffect(input)) {
    return [signal({
      kind: 'unknown_body_effect',
      language,
      source: 'codegraph:language_diff',
      quality: 'unknown',
      confidence: 0.45,
      range: bodyRange,
      reason: isTsJsLanguage(language)
        ? 'TS/JS body-effect analysis could not prove the changed hunk effect'
        : 'language-aware body diff is not implemented for this language',
    })];
  }

  const callerVisible = signalsIntersectingHunk(input).map((item) => signal({
    kind: item.kind,
    language,
    source: 'codegraph:language_diff',
    quality: item.quality,
    confidence: Math.max(item.confidence, 0.8),
    range: item.range,
    reason: `changed hunk intersects CodeGraph ${item.kind} signal`,
    metadata: item.metadata,
  }));
  if (callerVisible.length > 0) return dedupe(callerVisible);

  return [signal({
    kind: 'local_only_change',
    language,
    source: 'codegraph:language_diff',
    quality: 'heuristic',
    confidence: 0.7,
    range: bodyRange,
    reason: 'changed hunk did not intersect TS/JS caller-visible body-effect signals',
  })];
}
