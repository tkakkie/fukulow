import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The checkout SQL the final probe opens under /work/sql. Only these are staged, so an untracked
// file next to them never reaches the bind-mounted, world-readable work directory.
export const stagedSql = ['bench.pgb', 'current-fresh.sql', 'seed.sql', 'send-current.sql', 'setcut.sql'] as const;

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Symlink-free (any component) so every later path below it resolves inside it. Paths are opened by
// name after this check: the checkout is ours, and the work root is a 0700 mkdtemp directory owned by
// this uid inside the realpath'd tmpdir, which another user cannot rename in a sticky or per-user
// temp directory, so the remaining check-to-use window is not reachable by anyone else.
function canonicalDirectory(path: string, what: string) {
  if (realpathSync(path) !== path) throw new Error(`${what} must be a canonical path without symlinks: ${path}`);
}

// Opens `path` as a directory owned by this uid, refusing a symlink, and sets any mode on the descriptor.
function ownedDirectory(path: string, mode?: number) {
  const fd = openSync(path, directoryFlags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error(`not a directory owned by this user: ${path}`);
    if (mode !== undefined) fchmodSync(fd, mode);
  } finally { closeSync(fd); }
}

// Lets the container postgres user traverse the work root (mkdtemp gives 0700).
export function makeTraversable(work: string) {
  canonicalDirectory(work, 'work root');
  ownedDirectory(work, 0o755);
}

// Copies `names` from `source` into a new `<work>/sql` readable by the container postgres user
// (directory 0755, files 0644) whatever the umask. A source that is a symlink or not a regular file
// throws, and every mode change acts on a descriptor this function just created or verified, so
// nothing outside the work directory changes.
export function stageSql(source: string, work: string, names: readonly string[] = stagedSql) {
  canonicalDirectory(source, 'SQL source');
  canonicalDirectory(work, 'work root');
  ownedDirectory(work);
  const target = join(work, 'sql');
  mkdirSync(target, { mode: 0o700 });
  ownedDirectory(target, 0o755);
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error(`unsafe SQL file name: ${name}`);
    // O_NONBLOCK: a FIFO is rejected by the fstat check instead of blocking the open.
    const from = openSync(join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let body: Buffer;
    try {
      if (!fstatSync(from).isFile()) throw new Error(`SQL input is not a regular file: ${name}`);
      body = readFileSync(from);
    } finally { closeSync(from); }
    const to = openSync(join(target, name), 'wx', 0o600);
    try { writeFileSync(to, body); fchmodSync(to, 0o644); } finally { closeSync(to); }
  }
}
