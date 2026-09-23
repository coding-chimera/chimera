/**
 * SvelteKit routes and navigation (port of upstream sveltekit-router.test.ts,
 * G-C — completes the G-A partial port).
 *
 * Extraction half: which `src/routes/**` file is a URL (`+page.svelte`) and
 * which address it sits at — a `+layout.svelte` / `+error.svelte` sits at a
 * page's address WITHOUT being one (upstream N terminal state; the fork's
 * `resolution/frameworks/svelte.ts` now agrees).
 *
 * Navigation half: `goto`/`redirect` binding via
 * `resolution/frameworks/sveltekit-router.ts` and `<a href>` synthesis via
 * `resolution/sveltekit-synthesizer.ts`.
 *
 * FORK NOTE: upstream's "lands on the Screens tab" case is NOT ported — this
 * fork has no `ui-server/api/screens` surface.
 */
import { describe, it, expect, beforeAll, afterAll } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import { svelteResolver } from '../../src/graph/resolution/frameworks/svelte';
import { svelteKitHrefArgument } from '../../src/graph/resolution/frameworks/sveltekit-router';
import type { Node } from '../../src/graph/types';

// =============================================================================
// Which file is a URL, and which argument is the destination
// =============================================================================

describe('sveltekit: only a +page.svelte is a route', () => {
  const routeNames = (filePath: string): string[] =>
    svelteResolver.extract!(filePath, '').nodes.filter((n) => n.kind === 'route').map((n) => n.name);

  it('a page is its directory', () => {
    expect(routeNames('src/routes/+page.svelte')).toEqual(['/']);
    expect(routeNames('src/routes/login/+page.svelte')).toEqual(['/login']);
    expect(routeNames('src/routes/article/[slug]/+page.svelte')).toEqual(['/article/:slug']);
  });

  it.each(['src/routes/+layout.svelte', 'src/routes/+error.svelte', 'src/routes/profile/+layout.svelte'])(
    '%s sits at a page’s address without being one',
    (file) => {
      expect(routeNames(file)).toEqual([]);
    }
  );
});

describe('sveltekit: which argument carries the path', () => {
  it('goto takes it first; redirect takes the status first', () => {
    expect(svelteKitHrefArgument('goto')).toBe(0);
    expect(svelteKitHrefArgument('redirect')).toBe(1);
    expect(svelteKitHrefArgument('push')).toBeNull();
  });
});

// =============================================================================
// The whole picture, indexed
// =============================================================================

describe('sveltekit: a routed app end to end', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function write(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sveltekit-'));
    write('package.json', JSON.stringify({ name: 'conduit', devDependencies: { '@sveltejs/kit': '2', svelte: '5' } }));
    write(
      'src/routes/+layout.svelte',
      '<script>\n  export let data\n</script>\n' +
        '<nav>\n' +
        '  <a href="/">Home</a>\n' +
        '  <a href="/login">Sign in</a>\n' +
        '  <a href="/settings">Settings</a>\n' +
        '  <a href="https://example.com">Elsewhere</a>\n' +
        '</nav>\n' +
        '<slot />\n'
    );
    write(
      'src/routes/+page.svelte',
      '<script>\n  export let data\n</script>\n<h1>Conduit</h1>\n<a href="/register">Sign up</a>\n'
    );
    write('src/routes/login/+page.svelte', '<script>\n  export let form\n</script>\n<a href="/register">Need an account?</a>\n');
    write(
      'src/routes/login/+page.server.js',
      "import { redirect } from '@sveltejs/kit'\n" +
        'export function load({ locals }) {\n' +
        "  if (locals.user) redirect(307, '/')\n" +
        '}\n' +
        'export const actions = {\n' +
        '  default: async ({ request, locals }) => {\n' +
        '    const user = await signIn(request)\n' +
        "    if (!user) return { errors: ['bad login'] }\n" +
        "    redirect(307, '/')\n" +
        '  }\n' +
        '}\n'
    );
    write('src/routes/register/+page.svelte', '<script>\n  export let form\n</script>\n<a href="/login">Have an account?</a>\n');
    write('src/routes/settings/+page.svelte', '<script>\n  export let data\n</script>\n<h1>Settings</h1>\n');
    write(
      'src/routes/settings/+page.server.js',
      "import { redirect } from '@sveltejs/kit'\n" +
        'export function load({ locals }) {\n' +
        "  if (!locals.user) redirect(302, '/login')\n" +
        '}\n'
    );
    write(
      'src/routes/editor/+page.svelte',
      '<script>\n' +
        "  import { goto } from '$app/navigation'\n" +
        '  async function publish() {\n' +
        '    const article = await save()\n' +
        '    goto(`/article/${article.slug}`)\n' +
        '  }\n' +
        '</script>\n' +
        '<button on:click={publish}>Publish</button>\n'
    );
    write(
      'src/routes/article/[slug]/+page.svelte',
      '<script>\n  export let data\n</script>\n<a href="/editor">Edit</a>\n<a href="/profile/@{data.author}">Author</a>\n'
    );
    write('src/routes/profile/@[user]/+page.svelte', '<script>\n  export let data\n</script>\n<h1>Profile</h1>\n');
    write('src/routes/profile/@[user]/+layout.svelte', '<script>\n  export let data\n</script>\n<slot />\n');
    // The precision floor: a destination nothing serves, and a computed one.
    write(
      'src/routes/nowhere/+page.server.js',
      "import { redirect } from '@sveltejs/kit'\n" +
        'export function load({ url }) {\n' +
        "  redirect(307, '/no-such-page')\n" +
        '  redirect(307, url.searchParams.get("next"))\n' +
        '}\n'
    );
    cg = await CodeGraph.init(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (name: string): Node => {
    const r = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
    return r;
  };
  const sym = (name: string, file?: string): Node => {
    const n = cg
      .getNodesByName(name)
      .find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import' && (!file || n.filePath.includes(file)));
    if (!n) throw new Error(`no symbol ${name}${file ? ` in ${file}` : ''}`);
    return n;
  };
  const navs = (from: Node) => cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates');
  const hrefs = (from: Node) =>
    navs(from)
      .map((e) => (e.metadata as Record<string, unknown>).href as string)
      .sort();

  it('names one route per page, and a layout is not a second screen at the same address', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual([
      '/',
      '/article/:slug',
      '/editor',
      '/login',
      '/profile/@:user',
      '/register',
      '/settings',
    ]);
  });

  it('redirect takes its path from the SECOND argument, after the status', () => {
    const guard = navs(sym('load', 'settings'));
    expect(guard).toHaveLength(1);
    expect(guard[0]!.target).toBe(route('/login').id);
    expect(guard[0]!.metadata).toMatchObject({ href: '/login', navMethod: 'redirect' });
    expect(navs(sym('load', 'login'))[0]!.target).toBe(route('/').id);
  });

  it('goto with a template hole reaches the [slug] page', () => {
    const publish = navs(sym('publish'));
    expect(publish).toHaveLength(1);
    expect(publish[0]!.target).toBe(route('/article/:slug').id);
    expect(publish[0]!.metadata).toMatchObject({ href: '/article/${…}', navMethod: 'goto' });
  });

  it('an internal <a href> navigates from the component that renders it; an external one does not', () => {
    const article = sym('+page', 'article/[slug]');
    // `/profile/@{data.author}` is an interpolation, and reaches `/profile/@:user`.
    expect(hrefs(article)).toEqual(['/editor', '/profile/@${…}']);
    const link = navs(article).find((e) => (e.metadata as Record<string, unknown>).href === '/editor')!;
    expect(link.provenance).toBe('heuristic');
    expect(link.metadata).toMatchObject({ synthesizedBy: 'sveltekit-link', navMethod: 'a' });
    expect(navs(article).find((e) => e.target === route('/profile/@:user').id)).toBeDefined();
    // The layout's nav bar links out, and never to the external site.
    expect(hrefs(sym('+layout', 'routes/+layout'))).toEqual(['/', '/login', '/settings']);
  });

  it('a path no page serves and a computed one are left unresolved', () => {
    expect(navs(sym('load', 'nowhere'))).toEqual([]);
  });

  // Upstream's final case ("lands on the Screens tab as transitions between
  // screens") exercises `ui-server/api/screens`, which this fork does not
  // ship — deliberately not ported (G-C).
});
