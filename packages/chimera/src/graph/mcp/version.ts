/**
 * Resolved package version, computed once at module load.
 *
 * The version string is the rendezvous datum between cooperating daemon and
 * proxy processes: the daemon advertises its version in the hello line, and
 * the proxy refuses to share IPC across a mismatch (falls back to direct
 * mode). Keeping the resolution in one place avoids drift between the CLI
 * `--version` output (which reads `package.json` directly) and the daemon
 * handshake.
 *
 * Resolution strategy: prefer the `package.json` next to the installed
 * binary (platform package), then the main package three levels up from this
 * internal graph module (source checkout). If reading fails (e.g. the
 * package was unpacked oddly), fall back to "0.0.0-unknown" — a sentinel
 * that will never match a real version, so the proxy harmlessly falls back
 * to direct mode.
 */

import * as fs from 'fs';
import * as path from 'path';

function readPackageVersion(): string {
  const pkgPath = [
    path.join(path.dirname(process.execPath), '..', 'package.json'),
    path.join(import.meta.dirname, '..', '..', '..', 'package.json'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!pkgPath) return '0.0.0-unknown';
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to sentinel.
  }
  return '0.0.0-unknown';
}

export const CodeGraphPackageVersion = readPackageVersion();
