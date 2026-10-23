import type { Node as SyntaxNode } from '../../web-tree-sitter-types';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
/**
 * Blank standalone `NS_ASSUME_NONNULL_BEGIN` / `NS_ASSUME_NONNULL_END`
 * lines before parsing. The vendored tree-sitter-objc grammar accepts only
 * `#`-prefixed preprocessor directives at the top level, so the bare Foundation
 * macros (they are real macros, normally spelled without `#`) surface as a
 * parse-tree ERROR. The kernel treats any ERROR as `defer:`, so the whole file
 * falls back to wasm — and wasm's recovery drops the surrounding
 * interface/implementation declarations too.
 *
 * The macros are pure nullability pragmas: they annotate every declaration in
 * the enclosed region but contribute no syntax of their own, so blanking them
 * leaves the interface/implementation parse tree unchanged. Only a line whose
 * entire content is whitespace + the macro name is blanked (an inline or
 * argument-bearing use keeps its bytes and is left to the grammar).
 *
 * Replacement preserves byte offsets (macro text → spaces, newlines and CRs
 * kept) so every symbol's line/column stays exact on both parser arms.
 */
export function blankAssumeNonNullMacros(source: string): string {
  if (!source.includes('NS_ASSUME_NONNULL_')) return source;
  const re = /^[ \t]*NS_ASSUME_NONNULL_(?:BEGIN|END)[ \t]*\r?$/gm;
  return source.replace(re, (m) => m.replace(/[^\r]/g, ' '));
}
function findCompoundStatement(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'compound_statement') {
      return child;
    }
  }
  return null;
}

/** Build ObjC selector: `greet`, `doThing:`, or `doThing:with:`. */
function extractObjcMethodName(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
    return undefined;
  }

  const identifiers = node.namedChildren.filter((c) => c.type === 'identifier');
  if (identifiers.length === 0) return undefined;

  const hasParameters = node.namedChildren.some((c) => c.type === 'method_parameter');
  const firstIdentifier = identifiers[0];
  if (!firstIdentifier) return undefined;
  if (!hasParameters) {
    return getNodeText(firstIdentifier, source);
  }

  return identifiers.map((id) => `${getNodeText(id, source)}:`).join('');
}

/** Nullability / ARC qualifiers that sit where a return type's first type
 *  identifier does (`(nonnull instancetype)`, `(nullable Bar *)`) — never the type. */
const OBJC_TYPE_QUALIFIERS = new Set([
  'nonnull', 'nullable', 'null_unspecified', 'null_resettable',
  '_Nonnull', '_Nullable', '_Null_unspecified', '__nonnull', '__nullable',
  'const', 'volatile', 'strong', 'weak', 'copy', 'assign', 'retain', 'oneway',
  '__strong', '__weak', '__unsafe_unretained', '__autoreleasing', '__kindof',
]);

/** Collect the type identifiers under a `method_type`, in document order. */
function collectTypeIdentifiers(node: SyntaxNode, source: string, out: string[]): void {
  if (node.type === 'type_identifier') out.push(getNodeText(node, source).trim());
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) collectTypeIdentifiers(child, source, out);
  }
}

/**
 * Capture an ObjC method's declared return type as a bare class name, for the
 * chained static-factory call mechanism (#750). `+ (Bar *)create` yields `Bar`;
 * a nullability/ARC qualifier (`(nonnull instancetype)`, `(nullable Bar *)`) is
 * skipped to reach the real type. `void` / `id` / `instancetype` / primitives
 * yield undefined — for a class-message factory that means the receiver's type
 * is the class itself (handled in resolution), so `[[X alloc] init]` and
 * singleton chains still resolve.
 */
function extractObjcReturnType(node: SyntaxNode, source: string): string | undefined {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') return undefined;
  const methodType = node.namedChildren.find((c) => c.type === 'method_type');
  if (!methodType) return undefined;
  const ids: string[] = [];
  collectTypeIdentifiers(methodType, source, ids);
  const name = ids.find((n) => !OBJC_TYPE_QUALIFIERS.has(n));
  if (!name || !/^[A-Za-z_]\w*$/.test(name) || name === 'void' || name === 'id' || name === 'instancetype') {
    return undefined;
  }
  return name;
}

function extractObjcPropertyName(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'property_declaration') return null;

  const structDecl = node.namedChildren.find((c) => c.type === 'struct_declaration');
  if (!structDecl) return null;

  const structDeclarator = structDecl.namedChildren.find((c) => c.type === 'struct_declarator');
  if (!structDeclarator) return null;

  let current: SyntaxNode | null = structDeclarator;
  while (current) {
    const inner: SyntaxNode | undefined =
      getChildByField(current, 'declarator') ||
      current.namedChildren.find((c) => c.type === 'identifier' || c.type === 'pointer_declarator');
    if (!inner) break;
    if (inner.type === 'identifier') {
      return getNodeText(inner, source);
    }
    current = inner;
  }

  return null;
}

export const objcExtractor: LanguageExtractor = {
  preParse: blankAssumeNonNullMacros,
  functionTypes: ['function_definition'],
  // Only @interface emits a class node; @implementation reuses it via visitNode.
  classTypes: ['class_interface'],
  methodTypes: ['method_definition'],
  interfaceTypes: ['protocol_declaration'],
  interfaceKind: 'protocol',
  structTypes: ['struct_specifier'],
  // Objective-C is a C superset: union declarations preserve their own kind.
  unionTypes: ['union_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include'],
  callTypes: ['call_expression', 'message_expression'],
  variableTypes: ['declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  getReturnType: extractObjcReturnType,
  resolveName: extractObjcMethodName,
  extractPropertyName: extractObjcPropertyName,
  resolveBody: (node, bodyField) => {
    const fromField = getChildByField(node, bodyField);
    if (fromField) {
      return fromField;
    }
    return findCompoundStatement(node);
  },
  resolveTypeAliasKind: (node, _source) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body'))
        return 'struct';
      if (child.type === 'union_specifier' && getChildByField(child, 'body')) return 'union';
    }
    return undefined;
  },
  isStatic: (node) => /^\s*\+/.test(node.text),
  visitNode: (node, ctx: ExtractorContext) => {
    if (node.type !== 'class_implementation') return false;

    const classNameNode = node.namedChildren.find((c) => c.type === 'identifier');
    if (!classNameNode) return true;

    const className = getNodeText(classNameNode, ctx.source);
    const classNode =
      ctx.nodes.find(
        (n) => n.name === className && n.filePath === ctx.filePath && n.kind === 'class'
      ) ?? ctx.createNode('class', className, node, {});
    if (!classNode) return true;

    ctx.pushScope(classNode.id);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'implementation_definition') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const implChild = child.namedChild(j);
          if (implChild) ctx.visitNode(implChild);
        }
      }
    }
    ctx.popScope();
    return true;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
