// kernel-parity corpus (fork port of the upstream torture.tsx #1987 block,
// b65e05b): calls through ES private fields — the extractor keeps the
// `this.#field.method` receiver on both arms, and `#items.add` on a builtin
// Set type resolves to nothing.
export class DelegatorBase {
  toString(): string { return 'base'; }
}

export class FieldDelegator extends DelegatorBase {
  constructor(private hooks: { send: (m: string) => string }, private list: string[]) { super(); }
  send(msg: string): string { return this.hooks.send(msg); }
  direct(): void { this.send('x'); super.toString(); }
}

// --- call through an ES private field (#1987) --------------------------------
export class PrivateDelegator {
  #mailer = new FieldDelegator({ send: (m: string) => m }, []);
  #items = new Set<string>();
  send(msg: string): string { return this.#mailer.send(msg); }
  add(x: string): void { this.#items.add(x); }
}

// --- const-bound functions inside a body (#1669) -----------------------------
export function NestedHandlers({ items, onPick }: { items: string[]; onPick: (a: unknown, b: unknown) => void }) {
  const handleClear = () => { onPick(null, null); };
  return handleClear;
}
