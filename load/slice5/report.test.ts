import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { scope } from './config.ts';
import { parseTimeline, type RunD, type RunC, type RunB, type Counts } from './judge.ts';
import { channelLogSQL, prefillSQL, watchedRelationsSQL } from './fixture.ts';
import { mergeProblems, render, verdicts } from './report.ts';

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
  metadata: { night: n, parts: n === '1' ? ['A'] : ['B','C','D'], node: 'v26.13.1', scope, smoke: false, commits: { B: 'b', A: 'a' }, images: { B: 'i', A: 'j' }, settingsHash: 's', k6Id: 'k', machine: {}, docker: {},
    harnessCommit: 'h', harnessHashes: { 'load/slice5/judge.ts': 'x' }, dirty: '', started: 't', ...edit },
  summary: { failed: false, interrupted: '', faults: [], cleanupErrors: [], finished: 't' }, results: [] as (RunD | RunC | RunB)[] });
test('nights that differ, fail, are smoke or dirty are run-level problems', () => {
  assert.deepEqual(mergeProblems(night('1'), night('2')), []);
  for (const edit of [{ parts: ['B','C'] }, { node: 'v1' }, { scope: 'wrong' }, { images: { B: 'x', A: 'j' } }, { settingsHash: 'other' }, { smoke: true }, { dirty: ' M run.ts' }, { k6Id: 'other' }, { harnessCommit: 'h2' }, { harnessHashes: { 'load/slice5/judge.ts': 'y' } }])
    assert.ok(mergeProblems(night('1'), night('2', edit)).length, JSON.stringify(edit));
  const failed = night('2'); failed.summary.interrupted = 'hard timeout';
  assert.ok(mergeProblems(night('1'), failed).length);
});
test('empty nights never pass', () => {
  const v = verdicts(night('1'), night('2'));
  assert.notEqual(v.overall, 'PASS');
  assert.ok(v.verdicts.every(x => x.status !== 'PASS'));
});

const timelineRuns = (): RunD[] => [1,2,3].flatMap(round => (['B','A'] as const).map(arm => ({ part: 'D', round, arm,
  commit: arm === 'A' ? 'f7fe08a' : 'b975ffa', complete: true, smoke: false, topics: 10000,
  rows: parseTimeline('TOPIC_PAGE boundary=None n=400 p50_ms=1 p95_ms=10 max_ms=20\n' +
    'TOPIC_PAGE boundary=Some(190000) n=400 p50_ms=1 p95_ms=10 max_ms=20\n' +
    'TOPIC_SEND boundary=None n=20 p50_ms=1 p95_ms=10 max_ms=20\n' +
    'TOPIC_SEND boundary=Some(190000) n=20 p50_ms=1 p95_ms=10 max_ms=20\n') })));
test('summary.failed downgrades actual PASS cells and preserves FAIL', () => {
  const n1 = night('1'), n2 = night('2'); n2.results = timelineRuns();
  assert.ok(verdicts(n1,n2).verdicts.some(v => v.part === 'D' && v.status === 'PASS'));
  n2.summary.failed = true;
  assert.deepEqual(mergeProblems(n1,n2), ['night 2: runner failed']);
  assert.ok(verdicts(n1,n2).verdicts.filter(v => v.part === 'D' && v.cell.startsWith('PAGE')).every(v => v.status === 'INVALID'));
  for (const r of n2.results as RunD[]) if (r.arm === 'A') r.rows[0].p95 = 101;
  assert.ok(verdicts(n1,n2).verdicts.some(v => v.status === 'FAIL'));
});
test('R2 invalid and error counts appear in the report, including missing evidence', () => {
  const n2 = night('2');
  n2.results = [{ part: 'C', cell: '1M-deep', arm: 'A', round: 1, r2: { status: 'REPORT ONLY', invalid: 2, errors: 3, p95: 10 } } as RunC];
  const report = render(night('1'),n2);
  assert.match(report,/invalid 2, errors 3, p95 10/);
  assert.doesNotMatch(report,/green in CI at A/);
  delete (n2.results[0] as RunC).r2;
  assert.match(render(night('1'),n2),/1M-deep A1: NOT EVALUATED; invalid n.a/);
});
test('watched WAL relations include table and TOAST indexes', () => {
  assert.match(watchedRelationsSQL,/SELECT reltoastrelid FROM tables/);
  assert.match(watchedRelationsSQL,/SELECT indexrelid FROM pg_index WHERE indrelid IN \(SELECT oid FROM heaps\)/);
});
test('runner uses drain resource evidence and isolated replay stacks', () => {
  // The runner has CLI side effects; inspect these orchestration boundaries without running it.
  const run = readFileSync(new URL('./run.ts',import.meta.url),'utf8');
  assert.match(run,/samples.window\(r.start, r.start \+ \(plan.seconds \+ partA.drainSeconds\) \* 1000\)/);
  assert.match(run,/for \(const cellName of partC.cells\) \{[\s\S]*?const cell = await withStack/);
  assert.match(run,/reader: counts\(r.result.reader\?\.all\)/);
  assert.match(run,/timelineEnv\(process.env, smoke \? tiny.topics : undefined\)/);
  assert.match(run,/const nonSuccess = closedLoopNonSuccess\(r.result\)/);
  const send = readFileSync(new URL('./send-k6.ts',import.meta.url),'utf8');
  assert.match(send,/export function reader\(\) \{\s+initialize\('reader'\)/);
  assert.match(send,/for \(const window of windows\) for \(const n of names\) counters\[n\].add\(0/);
  assert.match(run,/requireMergedHarness\(smoke, smoke \|\| command\('git'/);
  const replay = readFileSync(new URL('./replay-k6.ts',import.meta.url),'utf8');
  assert.match(replay,/replayPosition\(data.size, recentWindow, limit, depth, Number\(execution.scenario.name.slice\(7\)\), k\)/);
});

test('run-level problems preserve INVESTIGATE for candidate-only saturation', () => {
  const n2 = night('2', { dirty: 'modified' });
  const c: Counts = { attempted: 60000, accepted: 60000, rejected429: 0, rejected503: 0, otherErrors: 0, clientTimeouts: 0, transportErrors: 0, droppedIterations: 0, p95: 5 };
  n2.results = [1,2,3].flatMap(round => (['A','B'] as const).map(arm => ({ part: 'B' as const, cell: 'many-17', round, arm,
    commit: arm === 'A' ? 'f7fe08a' : 'b975ffa', image: arm, settingsHash: 's', fixtureChecksum: 'f', complete: true, smoke: false,
    acceptedPerSecond: 1000, measured: c, nonSuccess: 0, hostCpuMeanPercent: arm === 'A' ? 91 : 50,
    evidence: { samples: 60, maxSampleGapMs: 1000, samplingErrors: 0 } })));
  assert.equal(verdicts(night('1'),n2).verdicts.find(v => v.part === 'B' && v.cell === 'many-17')!.status,'INVESTIGATE');
});
