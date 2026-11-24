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

// How symlinks count. 'resolve' (default) compares after resolving them on both sides, as
// `proxy-target.ts` does. 'lexical' compares the strings as given, as `dms-workload.ts` and
// `log-compare/options.ts` do: a symlink inside the checkout pointing out is inside, and one outside
// pointing in is outside. README.md lists which guard needs which mode and what its wrapper keeps.
export type Symlinks = 'resolve' | 'lexical';

// Whether an absolute `path` lies outside `checkout`. A relative path is never outside: its location
// would depend on the working directory, so a harness that accepts one resolves it before calling.
// The checkout itself and anything under it are inside; its parent is outside. Each harness keeps its
// own error text.
export function outsideCheckout(path: string, checkout: string, symlinks: Symlinks = 'resolve'): boolean {
  if (!isAbsolute(path)) return false;
  if (symlinks === 'lexical') return path !== checkout && !path.startsWith(checkout + '/');
  const rel = relative(canonical(checkout), canonical(path));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}
