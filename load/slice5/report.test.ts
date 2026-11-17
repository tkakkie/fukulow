import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelLogSQL, prefillSQL } from './fixture.ts';
import { mergeProblems, verdicts } from './report.ts';

const org = '11111111-1111-4111-8111-111111111111', ch = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
test('prefill SQL rejects non-UUID input and mismatched plans', () => {
  assert.throws(() => prefillSQL("x'; DROP TABLE messages; --", ch, [1, 1]));
  assert.throws(() => prefillSQL(org, ["2'--", ch[1]], [1, 1]));
  assert.throws(() => prefillSQL(org, ch, [1]));
  assert.throws(() => prefillSQL(org, ch, [1, -1]));
  assert.match(prefillSQL(org, ch, [5, 0]), /ARRAY\[5,0\]::int\[\]/);
});
test('channel_log rows only on A, guarded by the table presence', () => {
  assert.doesNotMatch(channelLogSQL('B', org, ch), /INSERT INTO channel_log/);
  assert.match(channelLogSQL('B', org, ch), /<> false/);
  assert.match(channelLogSQL('A', org, ch), /INSERT INTO channel_log/);
  assert.match(channelLogSQL('A', org, ch), /<> true/);
});

const night = (n: string, edit: Record<string, unknown> = {}) => ({
  metadata: { night: n, smoke: false, commits: { B: 'b', A: 'a' }, images: { B: 'i', A: 'j' }, settingsHash: 's', k6Id: 'k', machine: {}, docker: {},
    harnessCommit: 'h', harnessHashes: { 'load/slice5/judge.ts': 'x' }, dirty: '', started: 't', ...edit },
  summary: { failed: false, interrupted: '', faults: [], cleanupErrors: [], finished: 't' }, results: [] });
test('nights that differ, fail, are smoke or dirty are run-level problems', () => {
  assert.deepEqual(mergeProblems(night('1'), night('2')), []);
  for (const edit of [{ images: { B: 'x', A: 'j' } }, { settingsHash: 'other' }, { smoke: true }, { dirty: ' M run.ts' }, { k6Id: 'other' }, { harnessCommit: 'h2' }, { harnessHashes: { 'load/slice5/judge.ts': 'y' } }])
    assert.ok(mergeProblems(night('1'), night('2', edit)).length, JSON.stringify(edit));
  const failed = night('2'); failed.summary.interrupted = 'hard timeout';
  assert.ok(mergeProblems(night('1'), failed).length);
});
test('empty nights never pass', () => {
  const v = verdicts(night('1'), night('2'));
  assert.notEqual(v.overall, 'PASS');
  assert.ok(v.verdicts.every(x => x.status !== 'PASS'));
});
