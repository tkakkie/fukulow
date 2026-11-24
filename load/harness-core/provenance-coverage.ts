import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// Test-side check that a harness's provenance list hashes every local module it imports. It uses
// the TypeScript preprocessor (already a load/ devDependency) so commented-out imports do not count,
// and it stays out of provenance.ts so a harness at run time never loads the compiler.

const local = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');
const toRepo = (root: string, full: string) => relative(root, full).split(sep).join(posix.sep);

// Every local module `entry` reaches through static, type-only, re-export, literal dynamic or require imports,
// transitively, as sorted repository-relative paths. `entry` itself is not included. An import that
// does not resolve to a file throws.
export function localImports(entry: string, root = process.cwd()): string[] {
  const seen = new Set<string>();
  const pending = [resolve(root, entry)];
  const start = pending[0]!;
  while (pending.length) {
    const file = pending.pop()!;
    const source = readFileSync(file, 'utf8');
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!local(fileName)) continue;
      const target = resolve(dirname(file), fileName);
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`${toRepo(root, file)} imports a missing module: ${fileName}`);
      if (target === start || seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }
  return [...seen].map(full => toRepo(root, full)).sort();
}

// The entry and the local modules it imports that `list` does not contain, sorted.
export function missingFromProvenance(entry: string, list: readonly string[], root = process.cwd()): string[] {
  const listed = new Set(list);
  return [entry, ...localImports(entry, root)].filter(path => !listed.has(path)).sort();
}
