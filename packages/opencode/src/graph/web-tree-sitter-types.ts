export interface Point {
  row: number
  column: number
}

export interface Range {
  startPosition: Point
  endPosition: Point
  startIndex: number
  endIndex: number
}

export interface Edit {
  startPosition: Point
  oldEndPosition: Point
  newEndPosition: Point
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
}

export type ParseCallback = (index: number, position: Point) => string | undefined

export interface ParseOptions {
  includedRanges?: Range[]
  progressCallback?: (state: { currentOffset: number; hasError: boolean }) => void
}

export interface Parser {
  language: Language | null
  delete(): void
  setLanguage(language: Language | null): this
  parse(callback: string | ParseCallback, oldTree?: Tree | null, options?: ParseOptions): Tree | null
  reset(): void
  getIncludedRanges(): Range[]
  getTimeoutMicros(): number
  setTimeoutMicros(timeout: number): void
  setLogger(callback: ((message: string, isLex: boolean) => void) | boolean | null): this
  getLogger(): ((message: string, isLex: boolean) => void) | null
}

export interface Language {
  types: string[]
  fields: (string | null)[]
  readonly name: string | null
  readonly version: number
  readonly abiVersion: number
  readonly fieldCount: number
  readonly stateCount: number
  fieldIdForName(fieldName: string): number | null
  fieldNameForId(fieldId: number): string | null
  idForNodeType(type: string, named: boolean): number | null
  readonly nodeTypeCount: number
  nodeTypeForId(typeId: number): string | null
  nodeTypeIsNamed(typeId: number): boolean
  nodeTypeIsVisible(typeId: number): boolean
  readonly supertypes: number[]
  subtypes(supertype: number): number[]
  nextState(stateId: number, typeId: number): number
  lookaheadIterator(stateId: number): unknown
  query(source: string): unknown
}

export interface Tree {
  language: Language
  copy(): Tree
  delete(): void
  readonly rootNode: Node
  rootNodeWithOffset(offsetBytes: number, offsetExtent: Point): Node
  edit(edit: Edit): void
  walk(): TreeCursor
  getChangedRanges(other: Tree): Range[]
  getIncludedRanges(): Range[]
}

export interface Node {
  readonly id: number
  readonly startIndex: number
  readonly startPosition: Point
  readonly tree: Tree
  readonly typeId: number
  readonly grammarId: number
  readonly type: string
  readonly grammarType: string
  readonly isNamed: boolean
  readonly isExtra: boolean
  readonly isError: boolean
  readonly isMissing: boolean
  readonly hasChanges: boolean
  readonly hasError: boolean
  readonly endIndex: number
  readonly endPosition: Point
  readonly text: string
  readonly parseState: number
  readonly nextParseState: number
  equals(other: Node): boolean
  child(index: number): Node | null
  namedChild(index: number): Node | null
  childForFieldId(fieldId: number): Node | null
  childForFieldName(fieldName: string): Node | null
  fieldNameForChild(index: number): string | null
  fieldNameForNamedChild(index: number): string | null
  childrenForFieldName(fieldName: string): Node[]
  childrenForFieldId(fieldId: number): Node[]
  firstChildForIndex(index: number): Node | null
  firstNamedChildForIndex(index: number): Node | null
  readonly childCount: number
  readonly namedChildCount: number
  readonly firstChild: Node | null
  readonly firstNamedChild: Node | null
  readonly lastChild: Node | null
  readonly lastNamedChild: Node | null
  readonly children: Node[]
  readonly namedChildren: Node[]
  descendantsOfType(types: string | string[], startPosition?: Point, endPosition?: Point): Node[]
  readonly nextSibling: Node | null
  readonly previousSibling: Node | null
  readonly nextNamedSibling: Node | null
  readonly previousNamedSibling: Node | null
  readonly descendantCount: number
  readonly parent: Node | null
  childWithDescendant(descendant: Node): Node | null
  descendantForIndex(start: number, end?: number): Node | null
  namedDescendantForIndex(start: number, end?: number): Node | null
  descendantForPosition(start: Point, end?: Point): Node | null
  namedDescendantForPosition(start: Point, end?: Point): Node | null
  walk(): TreeCursor
  edit(edit: Edit): void
  toString(): string
}

export interface TreeCursor {
  copy(): TreeCursor
  delete(): void
  readonly currentNode: Node
  readonly currentFieldId: number
  readonly currentFieldName: string | null
  readonly currentDepth: number
  readonly currentDescendantIndex: number
  readonly nodeType: string
  readonly nodeTypeId: number
  readonly nodeStateId: number
  readonly nodeId: number
  readonly nodeIsNamed: boolean
  readonly nodeIsMissing: boolean
  readonly nodeText: string
  readonly startPosition: Point
  readonly endPosition: Point
  readonly startIndex: number
  readonly endIndex: number
  gotoFirstChild(): boolean
  gotoLastChild(): boolean
  gotoParent(): boolean
  gotoNextSibling(): boolean
  gotoPreviousSibling(): boolean
  gotoDescendant(goalDescendantIndex: number): void
  gotoFirstChildForIndex(goalIndex: number): boolean
  gotoFirstChildForPosition(goalPosition: Point): boolean
  reset(node: Node): void
  resetTo(cursor: TreeCursor): void
}
