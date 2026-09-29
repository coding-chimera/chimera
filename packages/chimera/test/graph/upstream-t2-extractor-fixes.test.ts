/**
 * Regression coverage for three upstream extractor fixes ported in the v1.6.1
 * T2 batch:
 *
 *  - #1642/#1998: a Java/Kotlin/Scala package segment named `build` under a
 *    conventional source root survives the default build-output exclusion;
 *    a top-level `build/` output dir stays excluded.
 *  - #1222: MyBatis close tags with trailing whitespace (`</select >`) no
 *    longer swallow the following statement, and a fully-qualified
 *    `<include refid="com.example.M.base">` splits on the LAST dot only.
 *  - #1350/#2010: DFM component nodes carry their full block range — the
 *    matching `end` updates endLine/endColumn instead of just popping an id.
 */

import { describe, it, expect, afterEach } from './vitest';
const { scanDirectory, extractFromSource } = await import('../../src/graph/extraction');
const { DfmExtractor } = await import('../../src/graph/extraction/dfm-extractor');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let testDir: string | null = null;

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  testDir = null;
});

describe('Java packages named build (upstream #1642/#1998)', () => {
  it('indexes src/*/java/**/build but keeps module build output excluded', () => {
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-build-')));
    const pkgDir = path.join(testDir, 'src', 'main', 'java', 'com', 'example', 'build');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'BuildTool.java'), 'package com.example.build;\npublic class BuildTool {}\n');
    const testPkgDir = path.join(testDir, 'src', 'test', 'java', 'com', 'example', 'build');
    fs.mkdirSync(testPkgDir, { recursive: true });
    fs.writeFileSync(path.join(testPkgDir, 'BuildToolTest.java'), 'package com.example.build;\npublic class BuildToolTest {}\n');
    // Module build output must STAY excluded.
    fs.mkdirSync(path.join(testDir, 'build', 'classes'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'build', 'classes', 'Generated.java'), 'public class Generated {}\n');

    const files = scanDirectory(testDir);
    expect(files).toContain('src/main/java/com/example/build/BuildTool.java');
    expect(files).toContain('src/test/java/com/example/build/BuildToolTest.java');
    expect(files.some((f) => f.startsWith('build/'))).toBe(false);
  });
});

describe('MyBatis whitespace close tags + qualified refid (upstream #1222)', () => {
  it('does not overshoot past a close tag with trailing whitespace', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="first">SELECT 1</select >' +
      '<select id="second">SELECT 2</select>' +
      '</mapper>';
    const names = extractFromSource('FooMapper.xml', xml)
      .nodes.filter((n) => n.kind === 'method')
      .map((n) => n.qualifiedName);
    // Before the fix the non-greedy body of `first` overshot to `</select>`
    // of `second`, silently swallowing it.
    expect(names).toContain('com.example.FooMapper::first');
    expect(names).toContain('com.example.FooMapper::second');
  });

  it('splits a qualified include refid on the last dot only', () => {
    const xml =
      '<mapper namespace="com.example.FooMapper">' +
      '<select id="getById">SELECT <include refid="com.example.M.base"/> FROM t</select>' +
      '</mapper>';
    const refs = extractFromSource('FooMapper.xml', xml).unresolvedReferences.map(
      (r) => r.referenceName,
    );
    // Before the fix every dot became `::` (com::example::M::base), which
    // never matched the fragment's qualifiedName (com.example.M::base).
    expect(refs).toContain('com.example.M::base');
    expect(refs).not.toContain('com::example::M::base');
  });
});

describe('DFM component ranges (upstream #1350/#2010)', () => {
  it('extends a component node to its matching end block', () => {
    const dfm = [
      'object Form1: TForm1',        // line 1
      '  Left = 0',                  // 2
      '  object Button1: TButton',   // 3
      '    OnClick = Button1Click',  // 4
      '  end',                       // 5
      'end',                         // 6
    ].join('\n');
    const result = new DfmExtractor('MainForm.dfm', dfm).extract();
    const form = result.nodes.find((n) => n.name === 'Form1')!;
    const button = result.nodes.find((n) => n.name === 'Button1')!;
    expect(form).toBeDefined();
    expect(button).toBeDefined();
    // Before the fix both stayed pinned to their declaration lines.
    expect(form.startLine).toBe(1);
    expect(form.endLine).toBe(6);
    expect(button.startLine).toBe(3);
    expect(button.endLine).toBe(5);
    // Event handler still references the INNER component.
    const handler = result.unresolvedReferences.find((r) => r.referenceName === 'Button1Click');
    expect(handler?.fromNodeId).toBe(button.id);
    // Containment edge survives the node-stack change.
    expect(result.edges.some((e) => e.source === form.id && e.target === button.id && e.kind === 'contains')).toBe(true);
  });
});
