import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandScenarios, outputLine } from './proxy-scenarios.ts';

const invalid = /^Error: scenarios must be comma-separated 1\.\.6$/;

test('valid scenarios keep their values in ascending order', () => {
  assert.deepEqual(expandScenarios('1,2,5'), [1, 2, 5]);
  assert.deepEqual(expandScenarios('5,1,3'), [1, 3, 5]);
});

test('6 expands to 2, 3 and 4', () => {
  assert.deepEqual(expandScenarios('6'), [2, 3, 4]);
  assert.deepEqual(expandScenarios('1,2,3,4,5,6'), [1, 2, 3, 4, 5]);
});

test('duplicates, including those from expanding 6, appear once', () => {
  assert.deepEqual(expandScenarios('2,2,6,3'), [2, 3, 4]);
});

test('empty input is rejected', () => {
  assert.throws(() => expandScenarios(''), (error: Error) => invalid.test(String(error)));
  assert.throws(() => expandScenarios('1,,2'), (error: Error) => invalid.test(String(error)));
});

test('out-of-range values are rejected', () => {
  for (const input of ['0', '7', '1,7', '-1']) assert.throws(() => expandScenarios(input), (error: Error) => invalid.test(String(error)), input);
});

test('non-integer values are rejected', () => {
  for (const input of ['1.5', 'a', '1,two', 'NaN']) assert.throws(() => expandScenarios(input), (error: Error) => invalid.test(String(error)), input);
});

test('the output line is the JSON array with a trailing newline', () => {
  assert.equal(outputLine([2, 3, 4]), 'scenarios=[2,3,4]\n');
});

test('the CLI appends the output line to GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-scenarios-'));
  try {
    const output = join(dir, 'output');
    execFileSync(process.execPath, [new URL('./proxy-scenarios.ts', import.meta.url).pathname], { env: { ...process.env, SCENARIOS: '1,6', GITHUB_OUTPUT: output } });
    assert.equal(readFileSync(output, 'utf8'), 'scenarios=[1,2,3,4]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
