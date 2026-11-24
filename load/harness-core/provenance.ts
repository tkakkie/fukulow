import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

// SHA-256 of each listed harness file, keyed by its repository-relative path as given. A missing,
// non-file, absolute, escaping or duplicate entry throws: a provenance record never omits a file
// silently, and keys stay machine-independent.
export function harnessHashes(paths: readonly string[], root = process.cwd()): Record<string, string> {
  if (paths.length === 0) throw new Error('Provenance list is empty');
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    if (isAbsolute(path) || normalize(path).split(/[\\/]/)[0] === '..') throw new Error(`Provenance path must be repository-relative: ${path}`);
    if (Object.hasOwn(hashes, path)) throw new Error(`Provenance path listed twice: ${path}`);
    const full = resolve(root, path);
    let file: boolean;
    try { file = statSync(full).isFile(); } catch { file = false; }
    if (!file) throw new Error(`Provenance file missing: ${path}`);
    hashes[path] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return hashes;
}
