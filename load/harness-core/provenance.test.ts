import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { harnessHashes } from './provenance.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'harness-provenance-'));
  mkdirSync(join(root, 'load'));
  writeFileSync(join(root, 'load/a.ts'), 'a');
  writeFileSync(join(root, 'compose.yml'), 'b');
  return root;
}

test('harness hashes are SHA-256 of each listed file, keyed by the path as given, in list order', () => {
  const root = tree();
  const hashes = harnessHashes(['load/a.ts', 'compose.yml'], root);
  assert.deepEqual(hashes, { 'load/a.ts': sha('a'), 'compose.yml': sha('b') });
  assert.deepEqual(Object.keys(hashes), ['load/a.ts', 'compose.yml']);
});

test('harness hashes equal the inline readFileSync form harnesses use today, relative to the working directory', () => {
  const root = tree(), before = process.cwd();
  const list = ['load/a.ts', 'compose.yml'];
  try {
    process.chdir(root);
    const inline = Object.fromEntries(list.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
    assert.deepEqual(harnessHashes(list), inline);
  } finally { process.chdir(before); }
});

test('a missing or non-file provenance entry fails instead of being skipped', () => {
  const root = tree();
  assert.throws(() => harnessHashes(['load/a.ts', 'load/gone.ts'], root), /Provenance file missing: load\/gone\.ts/);
  assert.throws(() => harnessHashes(['load'], root), /Provenance file missing: load$/);
});

test('an empty, duplicate, absolute or escaping provenance list fails', () => {
  const root = tree();
  assert.throws(() => harnessHashes([], root), /Provenance list is empty/);
  assert.throws(() => harnessHashes(['load/a.ts', 'load/a.ts'], root), /listed twice: load\/a\.ts/);
  assert.throws(() => harnessHashes([join(root, 'load/a.ts')], root), /must be repository-relative/);
  assert.throws(() => harnessHashes(['../x.ts'], join(root, 'load')), /must be repository-relative/);
  assert.throws(() => harnessHashes(['load/../../x.ts'], root), /must be repository-relative/);
});

