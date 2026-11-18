import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileSha256, frozenManifest, repoPath, sha256 } from './search-m1-bodies.ts';

const runner = readFileSync(new URL('./search-m1.ts', import.meta.url), 'utf8');

test('Astra 3: the generator label and cleanup filter use the same Compose project key and value', () => {
  assert.match(runner, /const ownership = `com\.docker\.compose\.project=\$\{project\}`/);
  assert.match(runner, /'--label', ownership/);
  assert.match(runner, /const ownershipFilter = `label=\$\{ownership\}`/);
  assert.equal([...runner.matchAll(/'--filter', ownershipFilter/g)].length, 2);
});

test('Astra 7: arm checks use manifest hashes even when an overlay changes during image build', async () => {
  assert.match(runner, /\.\.\.overlayHashes/);
  assert.match(runner, /overlayHashes\(frozen\.sourceHashes\)/);
  assert.match(runner, /verifyHarness\(\);\s+await dc\('up'/);
  assert.match(runner, /finally \{\s+try \{ verifyHarness\(\); }/);
  assert.match(runner, /assert\.equal\(sha256\(bytes\), harnessHashes\[path\]/);
  const { overlayHashes } = await import('./search-m1-bodies.ts');
  const { frozen } = frozenManifest();
  for (const [path, hash] of Object.entries(overlayHashes(frozen.sourceHashes))) {
    assert.equal(fileSha256(path), hash);
    assert.notEqual(sha256(readFileSync(repoPath(path), 'utf8') + '\n-- changed during the build\n'), hash);
  }
});

test('Astra 7: stack inspection compares the actual index definition', () => {
  assert.match(runner, /pg_get_indexdef\(indexrelid\)/);
  assert.match(runner, /assert\.equal\(actual\.indexDefinition, arm === 'A' \? pgroongaIndexDefinition : null/);
  const frozenSql = readFileSync(new URL('./search-engines/pgroonga.sql', import.meta.url), 'utf8');
  const [createIndex, options] = frozenSql.trim().replace(/;$/, '').split('\n');
  assert.ok(runner.includes(createIndex.replace('ON messages', 'ON public.messages')));
  assert.ok(runner.includes(options));
});

test('DB image inputs are verified from the copied files before build and stay pinned in arm checks', async t => {
  assert.ok(/const dbHashes = dbImageHashes\(frozen\.sourceHashes\)/.test(runner), 'runner must pin DB image inputs to manifest v2');
  assert.match(runner, /for \(const path of Object\.keys\(dbHashes\)\) copyFileSync\(repoPath\(path\), join\(recipe, basename\(path\)\)\)/);
  assert.match(runner, /verifyDbImageInputs\(recipe, dbHashes\);\s+await build\(dbTag, \[recipe\]\)/);
  assert.match(runner, /const verifyHarness = \(\) => \{\s+verifyDbImageInputs\(recipe, dbHashes\);/);
  assert.match(runner, /\.\.\.dbHashes/);
  assert.match(runner, /Object\.entries\(harnessHashes\).*fileSha256\(path\)/);

  const { dbImageHashes, verifyDbImageInputs } = await import('./search-m1-bodies.ts');
  const { frozen } = frozenManifest();
  const hashes = dbImageHashes(frozen.sourceHashes);
  const paths = ['load/search-engines/Dockerfile', 'load/search-engines/seed.ts'];
  assert.deepEqual(Object.keys(hashes).sort(), paths);
  const dir = mkdtempSync(join(tmpdir(), 'search-m1-db-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of paths) copyFileSync(repoPath(path), join(dir, basename(path)));
  verifyDbImageInputs(dir, hashes);
  for (const path of paths) {
    assert.throws(() => dbImageHashes(frozen.sourceHashes.filter(entry => entry.path !== path)), /Missing manifest v2/);
    const copy = join(dir, basename(path));
    writeFileSync(copy, readFileSync(copy, 'utf8') + '\n# changed during the app build\n');
    assert.throws(() => verifyDbImageInputs(dir, hashes), { message: new RegExp(`DB image input changed: ${path}`) });
    copyFileSync(repoPath(path), copy);
  }
});
