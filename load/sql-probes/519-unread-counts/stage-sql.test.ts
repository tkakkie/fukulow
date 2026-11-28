import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeTraversable, stageSql, stagedSql } from './stage-sql.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const mode = (path: string) => statSync(path).mode & 0o777;

function fixture(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'stage-sql-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source');
  const work = join(base, 'work');
  mkdirSync(source);
  mkdirSync(work);
  writeFileSync(join(source, 'a.sql'), 'SELECT 1;\n');
  writeFileSync(join(source, 'b.pgb'), 'SELECT 2;\n');
  writeFileSync(join(source, 'untracked.sql'), 'SELECT 3;\n');
  return { base, source, work };
}

test('stages only the listed files, 0755 directory and 0644 files under a 077 umask', t => {
  const { source, work } = fixture(t);
  const previous = process.umask(0o077);
  try { stageSql(source, work, ['a.sql', 'b.pgb']); } finally { process.umask(previous); }
  assert.deepEqual(readdirSync(join(work, 'sql')).sort(), ['a.sql', 'b.pgb']);
  assert.equal(mode(join(work, 'sql')), 0o755);
  assert.equal(mode(join(work, 'sql/a.sql')), 0o644);
  assert.equal(mode(join(work, 'sql/b.pgb')), 0o644);
  assert.equal(readFileSync(join(work, 'sql/b.pgb'), 'utf8'), 'SELECT 2;\n');
});

test('a symlinked source file throws and leaves its target untouched', t => {
  const { base, source, work } = fixture(t);
  const outside = join(base, 'outside.sql');
  writeFileSync(outside, 'secret\n');
  chmodSync(outside, 0o600);
  symlinkSync(outside, join(source, 'link.sql'));
  assert.throws(() => stageSql(source, work, ['link.sql']));
  assert.equal(mode(outside), 0o600);
  assert.equal(readFileSync(outside, 'utf8'), 'secret\n');
  assert.equal(existsSync(join(work, 'sql/link.sql')), false);
});

test('a source that is not a regular file throws', t => {
  const { source, work } = fixture(t);
  mkdirSync(join(source, 'dir.sql'));
  assert.throws(() => stageSql(source, work, ['dir.sql']), /not a regular file/);
});

test('a symlinked source directory throws', t => {
  const { base, source, work } = fixture(t);
  symlinkSync(source, join(base, 'linked'));
  assert.throws(() => stageSql(join(base, 'linked'), work, ['a.sql']), /canonical path/);
  assert.equal(existsSync(join(work, 'sql')), false);
});

test('a symlinked ancestor of the source throws', t => {
  const { base, work } = fixture(t);
  symlinkSync(base, join(base, 'alias'));
  assert.throws(() => stageSql(join(base, 'alias', 'source'), work, ['a.sql']), /canonical path/);
  assert.equal(existsSync(join(work, 'sql')), false);
});

test('a symlinked work root or work ancestor throws and leaves the target directory alone', t => {
  const { base, source, work } = fixture(t);
  chmodSync(work, 0o700);
  symlinkSync(work, join(base, 'work-link'));
  symlinkSync(base, join(base, 'alias'));
  for (const linked of [join(base, 'work-link'), join(base, 'alias', 'work')]) {
    assert.throws(() => stageSql(source, linked, ['a.sql']), /canonical path/, linked);
    assert.equal(mode(work), 0o700);
    assert.equal(existsSync(join(work, 'sql')), false);
  }
});

test('a FIFO input is rejected without blocking', t => {
  const { source, work } = fixture(t);
  if (spawnSync('mkfifo', [join(source, 'pipe.sql')]).status !== 0) return t.skip('mkfifo unavailable');
  // A child process, so a blocking open fails the test by timeout instead of hanging the runner.
  const script = `import { stageSql } from ${JSON.stringify(pathToFileURL(join(here, 'stage-sql.ts')).href)};
try { stageSql(${JSON.stringify(source)}, ${JSON.stringify(work)}, ['pipe.sql']); } catch (e) { console.log(String(e)); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.signal, null, 'stageSql blocked on the FIFO');
  assert.match(child.stdout, /not a regular file/);
});

test('a missing file throws', t => {
  const { source, work } = fixture(t);
  assert.throws(() => stageSql(source, work, ['missing.sql']), { code: 'ENOENT' });
});

test('unsafe names throw', t => {
  for (const name of ['../x', 'a/b', '..', '.hidden', '']) {
    const { source, work } = fixture(t);
    assert.throws(() => stageSql(source, work, [name]), /unsafe SQL file name/, name);
  }
});

test('an existing work sql directory throws', t => {
  const { source, work } = fixture(t);
  mkdirSync(join(work, 'sql'));
  assert.throws(() => stageSql(source, work, ['a.sql']), { code: 'EEXIST' });
});

test('makeTraversable opens a 0700 work root to 0755 and refuses a symlink', t => {
  const { base, work } = fixture(t);
  chmodSync(work, 0o700);
  symlinkSync(work, join(base, 'work-link'));
  symlinkSync(base, join(base, 'alias'));
  assert.throws(() => makeTraversable(join(base, 'work-link')));
  assert.throws(() => makeTraversable(join(base, 'alias', 'work')), /canonical path/);
  assert.equal(mode(work), 0o700);
  makeTraversable(work);
  assert.equal(mode(work), 0o755);
});

test('stagedSql exists in the checkout and covers every sql path final.ts opens', t => {
  const { work } = fixture(t);
  stageSql(join(here, 'sql'), work);
  assert.deepEqual(readdirSync(join(work, 'sql')).sort(), [...stagedSql].sort());
  const final = readFileSync(join(here, 'final.ts'), 'utf8');
  const opened = new Set([...final.matchAll(/\/work\/sql\/([A-Za-z0-9_.-]+)|'sql\/([A-Za-z0-9_.-]+)'/g)].map(m => m[1] ?? m[2]));
  assert.ok(opened.size > 0);
  for (const name of opened) assert.ok((stagedSql as readonly string[]).includes(name), `final.ts opens sql/${name}, missing from stagedSql`);
});
