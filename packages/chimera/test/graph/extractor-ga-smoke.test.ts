/**
 * G-A smoke: one sample source per language through `extractFromSource` for the
 * four extractors adopted at upstream terminal state (liquid / svelte / vue /
 * mybatis), each pinning the upstream delta the adoption brought:
 *   - liquid: Shopify OS 2.0 JSON template `sections` → `sections/<type>.liquid`
 *     references (#383), and the `{% schema %}` docstring no longer dumping raw
 *     schema JSON (security part of #383).
 *   - svelte: script-block symbols keep their true source line (the embedded
 *     newline after `<script>` is no longer double-counted).
 *   - vue: `<template>` component usages become references (#629), kebab-case
 *     converts to PascalCase, Vue built-ins and native elements are skipped.
 *   - mybatis: basic mapper statement extraction (robustness details live in
 *     mybatis-extractor-robustness.test.ts).
 */
import { describe, it, expect, beforeAll } from './vitest';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('liquid extractor smoke', () => {
  it('links render/section references from a .liquid file', () => {
    const source =
      "{% render 'product-card' %}\n" +
      "{% section 'header' %}\n" +
      '{% schema %}\n{"name": "Featured", "settings": [{"id": "api_key", "default": "SECRET"}]}\n{% endschema %}\n';
    const result = extractFromSource('sections/featured.liquid', source);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('snippets/product-card.liquid');
    expect(refs).toContain('sections/header.liquid');
    // #383 security: the schema node exists but its raw JSON (with the setting
    // default that may hold a key) is NOT dumped into the docstring — the
    // adopted extractor drops the docstring entirely.
    const schema = result.nodes.find((n) => n.kind === 'constant');
    expect(schema?.name).toBe('Featured');
    expect(schema?.docstring).toBeUndefined();
  });

  it('links each section type from an OS 2.0 JSON template (#383)', () => {
    const source = JSON.stringify({
      sections: {
        hero: { type: 'hero', settings: { title: 'Hi' } },
        header: { type: 'header' },
        'hero-dup': { type: 'hero' },
      },
      order: ['hero', 'header'],
    });
    const result = extractFromSource('templates/index.json', source);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('sections/hero.liquid');
    expect(refs).toContain('sections/header.liquid');
    // A repeated type is linked once; no symbol nodes are emitted for the JSON.
    expect(refs.filter((n) => n === 'sections/hero.liquid')).toHaveLength(1);
    expect(result.nodes.filter((n) => n.kind !== 'file')).toHaveLength(0);
  });
});

describe('svelte extractor smoke', () => {
  it('keeps script-block symbols on their true source line', () => {
    const source =
      '<script>\n' +
      '  export function greet(name) {\n' +
      "    return 'hi ' + name;\n" +
      '  }\n' +
      '</script>\n' +
      '\n' +
      '<h1>Hello</h1>\n';
    const result = extractFromSource('src/Greeter.svelte', source);
    const greet = result.nodes.find((n) => n.name === 'greet');
    expect(greet).toBeDefined();
    // Physical line 2. Before the offset fix the embedded newline after
    // `<script>` was double-counted and this landed on line 3.
    expect(greet!.startLine).toBe(2);
  });
});

describe('vue extractor smoke', () => {
  it('turns template component usages into references (#629)', () => {
    const source =
      '<script>\n' +
      "import Modal from './Modal.vue';\n" +
      'export default { components: { Modal } };\n' +
      '</script>\n' +
      '<template>\n' +
      '  <div>\n' +
      '    <Modal />\n' +
      '    <my-button>Click</my-button>\n' +
      '    <Transition><p>x</p></Transition>\n' +
      '    <keep-alive><section /></keep-alive>\n' +
      '  </div>\n' +
      '</template>\n';
    const result = extractFromSource('src/Parent.vue', source);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('Modal');
    // kebab-case converts to PascalCase
    expect(refs).toContain('MyButton');
    // built-ins (either case) and native HTML elements are skipped
    expect(refs).not.toContain('Transition');
    expect(refs).not.toContain('KeepAlive');
    expect(refs).not.toContain('div');
    expect(refs).not.toContain('section');
    // the script block still yields its own symbols
    expect(result.nodes.some((n) => n.name === 'Modal' || n.qualifiedName.includes('Modal'))).toBe(true);
  });
});

describe('mybatis extractor smoke', () => {
  it('extracts mapper statements and include references', () => {
    const source =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n' +
      '<mapper namespace="com.example.UserMapper">\n' +
      '  <sql id="cols">id, name</sql>\n' +
      '  <select id="getById" resultType="User">SELECT <include refid="cols"/> FROM users WHERE id = #{id}</select>\n' +
      '</mapper>\n';
    const result = extractFromSource('UserMapper.xml', source);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.map((n) => n.qualifiedName).sort()).toEqual([
      'com.example.UserMapper::cols',
      'com.example.UserMapper::getById',
    ]);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('com.example.UserMapper::cols');
  });
});
