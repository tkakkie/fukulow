import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// The path with symlinks resolved through its nearest existing ancestor, so a path that does not
// exist yet is compared where it would be created.
function canonical(path: string) {
  const full = resolve(path);
  let parent = full;
  while (!existsSync(parent)) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, full));
}

// Whether an absolute `path` lies outside `checkout` after resolving symlinks on both sides. A relative
// path is never outside: its location would depend on the working directory. The checkout itself and
// anything under it are inside; its parent is outside. Each harness keeps its own error text.
export function outsideCheckout(path: string, checkout: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(canonical(checkout), canonical(path));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}
