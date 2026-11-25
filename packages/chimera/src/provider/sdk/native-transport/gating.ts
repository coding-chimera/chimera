// Native-transport gate. Strangler-fig discipline: the flag defaults off and
// the off path never constructs anything from the addon. Once the flag is
// explicitly on, EVERY provider is eligible (user decision): the per-request
// delegation whitelist in fetch.ts is the safety net — Request inputs,
// unsupported schemes, Bun init extensions and unknown keys all fall back
// before startRequest, and a provider custom fetch is handled at the provider
// seam, not here.

export type EligibilityInput = {
  readonly enabled: boolean | undefined
}

/**
 * Pure decision function: only an explicitly-on flag may switch to the native
 * transport. Everything else stays on the existing fetch path.
 */
export function eligible(input: EligibilityInput): boolean {
  return input.enabled === true
}

export * as NativeTransportGating from "./gating"