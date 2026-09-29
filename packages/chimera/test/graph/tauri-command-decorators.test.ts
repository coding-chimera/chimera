/**
 * Tauri command attributes are preserved as decorators (#1543).
 *
 * Fork port of upstream `__tests__/tauri-command-dead-code.test.ts` +
 * the kernel-rustlang-parity hunk (87e79c6), adapted: the fork has no
 * `src/graph/dead-code.ts` report module (upstream's ui-server surface),
 * so the dead-code-exclusion assertions are dropped here — the ported
 * behavior is the extraction half: Rust outer `#[tauri::command]`
 * attributes (whitespace-tolerant, through comments, stacked with other
 * attributes) are retained as `decorators: ['tauri::command']` on both
 * extraction arms, while commented-out, string-literal, and unrelated
 * attributes are not registrations. Dual-arm: wasm side in
 * tree-sitter.ts extractDecoratorsFor, native side in rustlang.rs.
 */

import { describe, it, expect, beforeAll, afterEach } from './vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../src/graph';
import { extractFromSource } from '../../src/graph/extraction';
import { initGrammars, loadAllGrammars } from '../../src/graph/extraction/grammars';
import { hasPrebuild } from './kernel-testutil';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const SRC = `
pub fn reached() {}
#[tauri::command]
fn get_mcp_port() -> u16 { 4000 }
#[tauri :: command(rename_all = "snake_case")]
// A comment between attributes and the function is allowed.
#[allow(non_snake_case)]
pub async fn readSettings() {}
fn unused_helper() {}
// #[tauri::command]
fn comment_only() {}
#[other::command]
fn unrelated_attribute() {}
const TEXT: &str = r#"#[tauri::command]"#;
fn string_only() {}
#[tauri::command]
fn outer_command() { fn nested_helper() {} }
fn next_function() {}
`;

const DECORATED = ['get_mcp_port', 'readSettings', 'outer_command'];
const PLAIN = ['reached', 'unused_helper', 'comment_only', 'unrelated_attribute', 'string_only', 'nested_helper', 'next_function'];

function checkDecorators(nodes: Array<{ name: string; decorators?: string[] | null }>): void {
  for (const name of DECORATED) {
    expect(nodes.find((n) => n.name === name)?.decorators, name).toEqual(['tauri::command']);
  }
  for (const name of PLAIN) {
    const decorators = nodes.find((n) => n.name === name)?.decorators;
    expect(!decorators || decorators.length === 0, name).toBe(true);
  }
}

describe('Tauri command decorators (#1543)', () => {
  let root: string | undefined;
  let cg: CodeGraph | undefined;
  let savedKernel: string | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = savedKernel;
  });

  it('wasm arm: preserves tauri::command and ignores lookalikes', () => {
    savedKernel = process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL = '0';
    checkDecorators(extractFromSource('commands.rs', SRC).nodes);
  });

  it('wasm arm: CRLF source behaves identically', () => {
    savedKernel = process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL = '0';
    checkDecorators(extractFromSource('commands.rs', SRC.replace(/\n/g, '\r\n')).nodes);
  });

  it.skipIf(!hasPrebuild())('native arm: persisted graph carries the same decorators', async () => {
    savedKernel = process.env.CODEGRAPH_KERNEL;
    delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tauri-deco-'));
    fs.writeFileSync(path.join(root, 'commands.rs'), SRC);
    fs.writeFileSync(path.join(root, 'main.rs'), 'mod commands;\nfn main() { commands::reached(); }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    checkDecorators(cg.getNodesInFile('commands.rs'));
  });
});
