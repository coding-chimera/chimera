/**
 * file-limits tests (upstream #1910/#2082): oversize files are never decoded,
 * a `.ts` MPEG transport stream is never parsed, and the size stamp keeps
 * change detection stable without reading.
 */

import { describe, it, expect, afterEach } from './vitest';
const { default: CodeGraph } = await import('../../src/graph/index');
const {
  MAX_SOURCE_FILE_SIZE_BYTES,
  oversizeStamp,
  indexedHashInput,
  readBoundedSource,
  readBoundedSourceSync,
  isMpegTransportStream,
  hasMpegTsExtension,
  MPEG_TS_SNIFF_BYTES,
} = await import('../../src/graph/file-limits');

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

function makeDir(): string {
  testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-limits-')));
  return testDir;
}

/** A synthetic transport stream: 188-byte packets, each opening with 0x47, binary payload. */
function fakeMpegTs(packets = 20): Buffer {
  const buf = Buffer.alloc(packets * 188);
  for (let p = 0; p < packets; p++) {
    buf[p * 188] = 0x47;
    for (let i = 1; i < 188; i++) {
      // ~1/8 control bytes, like compressed payload; never valid UTF-8 text.
      buf[p * 188 + i] = i % 8 === 0 ? 0x00 : 0x80 + (i % 0x60);
    }
  }
  return buf;
}

describe('file-limits (upstream #1910/#2082)', () => {
  it('never decodes a file over the size limit (sync + async readers)', () => {
    const dir = makeDir();
    const big = path.join(dir, 'big.ts');
    // 2 MB of valid-looking TypeScript: would parse (slowly) if it were read.
    const line = 'export const filler = 1;\n';
    const chunks: string[] = [];
    while (chunks.join('').length < MAX_SOURCE_FILE_SIZE_BYTES + line.length * 64) chunks.push(line);
    fs.writeFileSync(big, chunks.join(''));
    expect(fs.statSync(big).size).toBeGreaterThan(MAX_SOURCE_FILE_SIZE_BYTES);

    const syncRead = readBoundedSourceSync(big);
    expect(syncRead.bytes).toBeNull();
    expect(syncRead.stats.size).toBeGreaterThan(MAX_SOURCE_FILE_SIZE_BYTES);

    return readBoundedSource(big).then((asyncRead) => {
      expect(asyncRead.bytes).toBeNull();
      expect(asyncRead.stats.size).toBe(syncRead.stats.size);
    });
  });

  it('reads a file within the limit normally', () => {
    const dir = makeDir();
    const small = path.join(dir, 'small.ts');
    fs.writeFileSync(small, 'export const x = 1;');
    const read = readBoundedSourceSync(small);
    expect(read.bytes?.toString('utf8')).toBe('export const x = 1;');
  });

  it('stamps an oversize file so change detection never reads it', () => {
    expect(oversizeStamp(2097152)).toBe('codegraph:oversize:2097152');
    // Under the limit: the content itself is hashed.
    expect(indexedHashInput(10, () => 'abcdefghij')).toBe('abcdefghij');
    // Over the limit: the stamp, and the content callback must not run.
    let called = false;
    expect(indexedHashInput(MAX_SOURCE_FILE_SIZE_BYTES + 1, () => { called = true; return 'x'; }))
      .toBe(oversizeStamp(MAX_SOURCE_FILE_SIZE_BYTES + 1));
    expect(called).toBe(false);
  });

  it('recognises an MPEG transport stream and refuses source-text false positives', () => {
    expect(isMpegTransportStream(fakeMpegTs())).toBe(true);
    expect(hasMpegTsExtension('fixtures/video.ts')).toBe(true);
    expect(hasMpegTsExtension('fixtures/video.TS')).toBe(true);
    expect(hasMpegTsExtension('src/index.tsx')).toBe(false);

    // A short clip (fewer than 16 packets of head) is cheap to parse — not video.
    expect(isMpegTransportStream(fakeMpegTs(8))).toBe(false);

    // TypeScript with a `G` (0x47) at every 188-byte stride and a NUL in a
    // comment is still source: the binary control-byte share gate rejects it.
    const src = Buffer.alloc(MPEG_TS_SNIFF_BYTES + 188, 0x61); // 'a' padding
    for (let off = 0; off <= MPEG_TS_SNIFF_BYTES; off += 188) src[off] = 0x47;
    src[10] = 0x00;
    expect(isMpegTransportStream(src)).toBe(false);
  });

  it('indexAll skips a 2MB .ts and an MPEG-TS clip but indexes real source', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'real.ts'), 'export function realSymbol() { return 1; }');
    // 2 MB TypeScript-looking filler — must be skipped by the size gate.
    const line = 'export const bigFillerMarker = 1;\n';
    fs.writeFileSync(path.join(dir, 'src', 'huge.ts'), line.repeat(Math.ceil((MAX_SOURCE_FILE_SIZE_BYTES * 2) / line.length)));
    // MPEG transport stream named .ts — must be skipped by the sniff.
    fs.writeFileSync(path.join(dir, 'src', 'video.ts'), fakeMpegTs(64));

    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.searchNodes('realSymbol').length).toBeGreaterThan(0);
      expect(cg.searchNodes('bigFillerMarker').length).toBe(0);
      // The oversize file must not be tracked at all (skipped, never stored).
      const snapshot = cg.getSnapshot();
      expect(snapshot.fileCount).toBe(1);
    } finally {
      await cg.close();
    }
  }, 60_000);
});
