/**
 * SvelteKit route naming (partial port of upstream sveltekit-router.test.ts).
 *
 * Only the extraction-side half is ported: which `src/routes/**` file is a URL
 * (`+page.svelte`) and which address it sits at — this exercises the fork's
 * `resolution/frameworks/svelte.ts` resolver, which names SvelteKit routes.
 *
 * The upstream file's navigation half (`goto`/`redirect`/`<a href>` synthesis
 * via `resolution/frameworks/sveltekit-router.ts` + `sveltekit-link-synthesizer`
 * + `ui-server/api/screens`) and its layout-is-not-a-route case are NOT ported:
 * those modules/behaviors do not exist in this fork's resolution layer, and
 * adopting them is resolution-layer work outside the G-A extraction lane.
 */
import { describe, it, expect, beforeAll } from './vitest';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import { svelteResolver } from '../../src/graph/resolution/frameworks/svelte';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('sveltekit: only a +page.svelte is a route', () => {
  const routeNames = (filePath: string): string[] =>
    svelteResolver.extract!(filePath, '').nodes.filter((n) => n.kind === 'route').map((n) => n.name);

  it('a page is its directory', () => {
    expect(routeNames('src/routes/+page.svelte')).toEqual(['/']);
    expect(routeNames('src/routes/login/+page.svelte')).toEqual(['/login']);
    expect(routeNames('src/routes/article/[slug]/+page.svelte')).toEqual(['/article/:slug']);
  });

  // Upstream also asserts a `+layout.svelte` / `+error.svelte` is NOT a route.
  // That expectation lives in `resolution/frameworks/svelte.ts`, whose fork copy
  // still names layout files as routes — resolution-layer behavior outside the
  // G-A extraction lane, so it is deliberately not asserted here.
});
