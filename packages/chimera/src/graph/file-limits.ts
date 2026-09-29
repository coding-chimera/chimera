/**
 * Source file size limits and bounded readers (port of upstream codegraph
 * src/file-limits.ts, #1910/#2082).
 *
 * A file over the limit is NEVER decoded: reading one only to hash and
 * discard cost multi-GB RSS spikes on committed video/blob fixtures and
 * could fail outright with `Invalid string length` past ~512 MB. The index
 * stores a size stamp in place of its content, and change detection hashes
 * the same stamp — a same-size rewrite of a file nothing is indexed from is
 * not a change, while crossing the limit in either direction is.
 *
 * The MPEG transport-stream sniff lives here (upstream keeps it in
 * extraction/grammars.ts) so the language-detection helpers stay contained
 * in the file-limits surface and grammars.ts is untouched.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Largest source file CodeGraph will parse or read during resolution. Generated
 * bundles, minified sources, and dependency archives above this limit provide no
 * useful symbols; 1 MB covers essentially all hand-written source.
 */
export const MAX_SOURCE_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * What stands in for the content of a file over MAX_SOURCE_FILE_SIZE_BYTES.
 * Such a file is never parsed, so its bytes are never needed (#1910).
 */
export function oversizeStamp(size: number): string {
  return `codegraph:oversize:${size}`;
}

/**
 * The text whose hash the index stores for a file of `size` bytes: its content
 * within the limit, the size stamp over it. Anything that checks a file on disk
 * against its stored `contentHash` has to hash this, or every unchanged file
 * over the limit reads as drifted. `content` is only read within the limit.
 */
export function indexedHashInput(size: number, content: () => string): string {
  return size > MAX_SOURCE_FILE_SIZE_BYTES ? oversizeStamp(size) : content();
}

/** A source file's stats, and its bytes when they are within the limit (null = oversize). */
export interface BoundedSource {
  stats: fs.Stats;
  bytes: Buffer | null;
}

const READ_CHUNK_BYTES = 64 * 1024;

function assertRegularFile(stats: fs.Stats): void {
  if (!stats.isFile()) throw new Error('Source path is not a regular file');
}

/**
 * Read a source file without ever holding more than the limit plus one byte.
 * A stat before the read is not enough: the file can grow between the stat
 * and the read (a log, a download, a build output being written), so the
 * descriptor is re-checked after opening and the read itself stops one byte
 * past the limit. Returns `bytes: null` for an oversize file.
 */
export async function readBoundedSource(file: string): Promise<BoundedSource> {
  const initial = await fsp.stat(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const handle = await fsp.open(file, 'r');
  try {
    let stats = await handle.stat();
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = await handle.stat();
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

/** Synchronous {@link readBoundedSource}. */
export function readBoundedSourceSync(file: string): BoundedSource {
  const initial = fs.statSync(file);
  assertRegularFile(initial);
  if (initial.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats: initial, bytes: null };
  const fd = fs.openSync(file, 'r');
  try {
    let stats = fs.fstatSync(fd);
    assertRegularFile(stats);
    if (stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return { stats, bytes: null };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_SOURCE_FILE_SIZE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SOURCE_FILE_SIZE_BYTES + 1 - size));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    stats = fs.fstatSync(fd);
    if (size > MAX_SOURCE_FILE_SIZE_BYTES || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      stats.size = Math.max(size, stats.size);
      return { stats, bytes: null };
    }
    return { stats, bytes: Buffer.concat(chunks, size) };
  } finally {
    fs.closeSync(fd);
  }
}

/** MPEG transport stream: fixed 188-byte packets, each opening with 0x47. */
const MPEG_TS_PACKET_SIZE = 188;
const MPEG_TS_SYNC_BYTE = 0x47;
/**
 * Consecutive packets whose sync byte must line up before a file counts as
 * video — 3 KB of head. A stream shorter than that is cheap to parse anyway;
 * the cost #1910 is about comes from clips hundreds of KB long.
 */
const MPEG_TS_MIN_PACKETS = 16;
/**
 * Share of the head that must be control bytes (below 0x20, other than the
 * whitespace ones) for it to count as binary. Compressed audio and video put
 * about one byte in eight there; source text puts none.
 */
const MPEG_TS_MIN_CONTROL_SHARE = 1 / 64;
/**
 * How many bytes of a file's head `isMpegTransportStream` needs — enough to
 * see `MPEG_TS_MIN_PACKETS` sync bytes plus the packets between them.
 */
export const MPEG_TS_SNIFF_BYTES = MPEG_TS_PACKET_SIZE * MPEG_TS_MIN_PACKETS;

/**
 * Whether these leading bytes are an MPEG transport stream — the OTHER thing
 * a `.ts` file can be. Golden video fixtures (`testdata/*.ts`, e2e clips)
 * share TypeScript's extension, and tree-sitter takes ~28 s to chew through a
 * 900 KB clip for zero symbols (#1910), so the decision has to be made from
 * the head of the file, before any parse.
 *
 * Two conditions, both required:
 *   1. the sync byte 0x47 sits at every 188-byte packet boundary of the first
 *      `MPEG_TS_MIN_PACKETS` packets — every packet of a transport stream
 *      opens with it, and nothing else pads to 188;
 *   2. the head is binary: at least `MPEG_TS_MIN_CONTROL_SHARE` of it is
 *      control bytes, as any compressed payload is.
 * 0x47 is the letter `G`, so (1) alone could match source whose lines happen
 * to put a `G` at every 188-byte stride. Checking for a single NUL was not
 * enough to close that: one NUL in a comment is still TypeScript. (2) asks
 * for dozens of control bytes, which no source file carries.
 *
 * `head` is the first `MPEG_TS_SNIFF_BYTES` (or fewer) bytes of the file.
 */
export function isMpegTransportStream(head: Uint8Array): boolean {
  const lastSync = MPEG_TS_PACKET_SIZE * (MPEG_TS_MIN_PACKETS - 1);
  if (head.length <= lastSync) return false;
  for (let off = 0; off <= lastSync; off += MPEG_TS_PACKET_SIZE) {
    if (head[off] !== MPEG_TS_SYNC_BYTE) return false;
  }
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i]!;
    // Tab, newline, vertical tab, form feed and carriage return are text.
    if (b < 0x20 && (b < 0x09 || b > 0x0d)) control++;
  }
  return control >= head.length * MPEG_TS_MIN_CONTROL_SHARE;
}

/** Whether `filePath` carries the one extension MPEG-TS shares with a language. */
export function hasMpegTsExtension(filePath: string): boolean {
  return filePath.length > 3 && filePath.slice(-3).toLowerCase() === '.ts';
}
