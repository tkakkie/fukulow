import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRecipe } from './generator.ts';

const fixture = (recipe: string) => {
  const directory = mkdtempSync(`${tmpdir()}/fukulow-generator-`);
  writeFileSync(`${directory}/Makefile`, `load:\n${recipe}\n`);
  return directory;
};

test('the expanded load recipe returns the generator exit code that make converts to 2', t => {
  const directory = fixture("\tsh -c 'exit $(CODE)' \\\n\t\t&& true");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, CODE: '99' };
  // Control: this is the defect. make itself exits 2, so a capacity failure (k6 99) looked like a harness error.
  assert.equal(spawnSync('make', ['-s', 'load'], { cwd: directory, env }).status, 2);
  const { file, args } = loadRecipe(env, directory);
  assert.equal(spawnSync(file, args, { cwd: directory, env }).status, 99);
  const success = loadRecipe({ ...env, CODE: '0' }, directory);
  assert.equal(spawnSync(success.file, success.args, { cwd: directory, env }).status, 0);
});

test('a recipe with more than one command is rejected', t => {
  const directory = fixture("\tsh -c 'exit 99'\n\ttrue");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadRecipe(process.env, directory), /exactly one shell command/);
});

test('the repository load recipe expands to one docker run command', () => {
  const { file, args } = loadRecipe({ ...process.env, LOAD_CONTAINER_NAME: 'fukulow-load-x-generator', LOAD_DOCKER_NETWORK: 'bridge',
    LOAD_NOFILE: '65536', BASE_URL: 'http://app:8080', LOAD_SCRIPT: 'load/scenario.ts' }, resolve(import.meta.dirname, '..'));
  assert.equal(file, '/bin/sh');
  assert.match(args[1], /^docker run --rm --name 'fukulow-load-x-generator'/);
  assert.match(args[1], / run 'load\/scenario\.ts'$/);
});
