import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileSha256, frozenManifest, sha256 } from './search-m1-bodies.ts';

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
    assert.notEqual(sha256(readFileSync(path, 'utf8') + '\n-- changed during the build\n'), hash);
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
