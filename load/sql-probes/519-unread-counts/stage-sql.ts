import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

// The checkout SQL the final probe opens under /work/sql. Only these are staged, so an untracked
// file next to them never reaches the bind-mounted, world-readable work directory.
export const stagedSql = ['bench.pgb', 'current-fresh.sql', 'seed.sql', 'send-current.sql', 'setcut.sql'] as const;

// Copies `names` from `source` into a new `<work>/sql` readable by the container postgres user
// (directory 0755, files 0644) whatever the umask. A source that is a symlink or not a regular file
// throws, and every mode change acts on a descriptor or directory this function just created, so
// nothing outside the work directory changes.
export function stageSql(source: string, work: string, names: readonly string[] = stagedSql) {
  if (!lstatSync(source).isDirectory()) throw new Error(`SQL source is not a directory: ${source}`);
  const target = join(work, 'sql');
  mkdirSync(target);
  chmodSync(target, 0o755);
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error(`unsafe SQL file name: ${name}`);
    const from = openSync(join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      if (!fstatSync(from).isFile()) throw new Error(`SQL input is not a regular file: ${name}`);
      body = readFileSync(from);
    } finally { closeSync(from); }
    const to = openSync(join(target, name), 'wx', 0o600);
    try { writeFileSync(to, body); fchmodSync(to, 0o644); } finally { closeSync(to); }
  }
}
