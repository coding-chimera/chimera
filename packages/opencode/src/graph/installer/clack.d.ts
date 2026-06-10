/**
 * Type declarations for @clack/prompts
 *
 * The package ships ESM-only (.d.mts) which TypeScript can't resolve
 * with moduleResolution "node". We declare the subset we use here.
 */

declare module '@clack/prompts' {
  type OutputOptions = {
    output?: unknown;
  };

  type PromptOption<Value> = {
    value: Value;
    label: string;
    hint?: string;
  };

  export function intro(title?: string, opts?: OutputOptions): void;
  export function outro(message?: string, opts?: OutputOptions): void;
  export function cancel(message?: string): void;
  export function isCancel(value: unknown): value is symbol;

  export function confirm(opts: {
    message: string;
    active?: string;
    inactive?: string;
    initialValue?: boolean;
  }): Promise<boolean | symbol>;

  export function select<Value>(opts: {
    message: string;
    options: PromptOption<Value>[];
    initialValue?: Value;
    maxItems?: number;
    output?: unknown;
  }): Promise<Value | symbol>;

  export function multiselect<Value>(opts: {
    message: string;
    options: PromptOption<Value>[];
    initialValues?: Value[];
    required?: boolean;
    output?: unknown;
  }): Promise<Value[] | symbol>;

  export function autocomplete<Value>(opts: {
    message: string;
    options: PromptOption<Value>[];
    initialValue?: Value;
    maxItems?: number;
    output?: unknown;
  }): Promise<Value | symbol>;

  export function text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
    output?: NodeJS.WriteStream;
  }): Promise<string | symbol>;

  export function password(opts: {
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
    output?: unknown;
  }): Promise<string | symbol>;

  export function spinner(): {
    start(message?: string): void;
    stop(message?: string, code?: number): void;
    message(message?: string): void;
  };

  export function note(message: string, title?: string): void;

  export const log: {
    message(message: string): void;
    info(message: string, opts?: OutputOptions): void;
    success(message: string, opts?: OutputOptions): void;
    step(message: string, opts?: OutputOptions): void;
    warn(message: string, opts?: OutputOptions): void;
    error(message: string, opts?: OutputOptions): void;
  };
}
