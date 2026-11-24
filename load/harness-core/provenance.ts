import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

// SHA-256 of each listed harness file, keyed by its repository-relative path as given, in list order.
// A missing, non-file, absolute, escaping or duplicate entry throws, and so does an entry whose
// symlinks resolve outside `root`: a provenance record never omits a file silently, keys stay
// machine-independent, and every hashed file is part of the checkout. Any key, `__proto__` included,
// is an own property of the result.
export function harnessHashes(paths: readonly string[], root = process.cwd()): Record<string, string> {
  if (paths.length === 0) throw new Error('Provenance list is empty');
  const realRoot = realpathSync(root);
  const listed = new Set<string>();
  const entries: [string, string][] = [];
  for (const path of paths) {
    if (isAbsolute(path) || normalize(path).split(/[\\/]/)[0] === '..') throw new Error(`Provenance path must be repository-relative: ${path}`);
    if (listed.has(path)) throw new Error(`Provenance path listed twice: ${path}`);
    listed.add(path);
    const full = resolve(root, path);
    let file: boolean;
    try { file = statSync(full).isFile(); } catch { file = false; }
    if (!file) throw new Error(`Provenance file missing: ${path}`);
    const rel = relative(realRoot, realpathSync(full));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Provenance path resolves outside the checkout: ${path}`);
    entries.push([path, createHash('sha256').update(readFileSync(full)).digest('hex')]);
  }
  return Object.fromEntries(entries);
}
