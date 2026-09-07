/**
 * Guard-exemption unit tests for the Node version hard block in
 * cli/chimera.ts. prepareRuntime() hard-exits on Node 25+ (or below the
 * supported floor) before any WASM work. Read-only/recovery commands that
 * never compile tree-sitter grammars (unlock, status, help/version output)
 * stay reachable with a short warning instead of the block, so users can
 * inspect and repair an index on unsupported Node versions. These tests pin
 * the exemption set, the version classification, and the warning copy (which
 * must keep the CHIMERA_ALLOW_UNSAFE_NODE=1 escape hatch visible).
 */

import { describe, it, expect } from './vitest';
import { MIN_NODE_MAJOR } from '../../src/graph/cli/node-version-check';
import {
  parseNodeMajor,
  classifyNodeGuardLevel,
  isGuardExemptSubcommand,
  buildGuardExemptWarning,
} from '../../src/graph/cli/chimera';

describe('parseNodeMajor', () => {
  it('parses the major from process.versions.node-style strings', () => {
    expect(parseNodeMajor('26.3.0')).toBe(26);
    expect(parseNodeMajor('25.0.0')).toBe(25);
    expect(parseNodeMajor('24.0.0')).toBe(24);
    expect(parseNodeMajor('19.9.9')).toBe(19);
  });
});

describe('classifyNodeGuardLevel', () => {
  it('flags 25+ as unsupported-major', () => {
    expect(classifyNodeGuardLevel('26.0.0')).toBe('unsupported-major');
    expect(classifyNodeGuardLevel('25.0.0')).toBe('unsupported-major');
  });

  it('accepts the supported range', () => {
    expect(classifyNodeGuardLevel('24.0.0')).toBe('ok');
    expect(classifyNodeGuardLevel(`${MIN_NODE_MAJOR}.0.0`)).toBe('ok');
  });

  it('flags versions below the floor as too-old', () => {
    expect(classifyNodeGuardLevel(`${MIN_NODE_MAJOR - 1}.0.0`)).toBe('too-old');
    expect(classifyNodeGuardLevel('16.0.0')).toBe('too-old');
  });
});

describe('isGuardExemptSubcommand', () => {
  it('exempts unlock and status with or without trailing args', () => {
    expect(isGuardExemptSubcommand(['unlock'])).toBe(true);
    expect(isGuardExemptSubcommand(['unlock', '/repo'])).toBe(true);
    expect(isGuardExemptSubcommand(['status'])).toBe(true);
    expect(isGuardExemptSubcommand(['status', '-j'])).toBe(true);
    expect(isGuardExemptSubcommand(['status', '/repo'])).toBe(true);
  });

  it('exempts help/version flag and word invocations', () => {
    expect(isGuardExemptSubcommand(['--help'])).toBe(true);
    expect(isGuardExemptSubcommand(['-h'])).toBe(true);
    expect(isGuardExemptSubcommand(['--version'])).toBe(true);
    expect(isGuardExemptSubcommand(['-V'])).toBe(true);
    expect(isGuardExemptSubcommand(['help'])).toBe(true);
    expect(isGuardExemptSubcommand(['version'])).toBe(true);
  });

  it('does not exempt parsing/other commands or empty argv', () => {
    expect(isGuardExemptSubcommand([])).toBe(false);
    expect(isGuardExemptSubcommand(['index'])).toBe(false);
    expect(isGuardExemptSubcommand(['sync'])).toBe(false);
    expect(isGuardExemptSubcommand(['init'])).toBe(false);
    expect(isGuardExemptSubcommand(['uninit'])).toBe(false);
    expect(isGuardExemptSubcommand(['migrate-data'])).toBe(false);
    expect(isGuardExemptSubcommand(['query', 'foo'])).toBe(false);
    expect(isGuardExemptSubcommand(['serve'])).toBe(false);
    expect(isGuardExemptSubcommand(['install'])).toBe(false);
  });
});

describe('buildGuardExemptWarning', () => {
  it('names the command, the reported version, and the 25+ escape hatch', () => {
    const warning = buildGuardExemptWarning('26.1.0', 26, 'unlock');
    expect(warning).toContain('Unsupported Node.js version 26.1.0');
    expect(warning).toContain('"unlock"');
    expect(warning).toContain('read-only/recovery');
    expect(warning).toContain('CHIMERA_ALLOW_UNSAFE_NODE=1');
  });

  it('reports the supported floor for too-old exemptions', () => {
    const warning = buildGuardExemptWarning('18.0.0', 18, 'status');
    expect(warning).toContain(`below the supported floor (${MIN_NODE_MAJOR}+)`);
    expect(warning).toContain('"status"');
    expect(warning).toContain('CHIMERA_ALLOW_UNSAFE_NODE=1');
  });
});