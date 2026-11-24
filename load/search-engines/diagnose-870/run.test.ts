import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualifiedCpuSets } from './cluster.ts';
import { stage1, type Measurement } from './judge.ts';
import { sequence, type MeasuredStep } from './plan.ts';
import { finishRecords, options, prerequisites, stopExitCode, sweepLeftovers } from './run.ts';

const hash = 'h'.repeat(64);
const sets = qualifiedCpuSets;
const swapped = 'server=1,3,5,7,9,11,13,15;client=0,2,4,6,8,10,12,14';
const parsed = {server: [0, 2, 4, 6, 8, 10, 12, 14], client: [1, 3, 5, 7, 9, 11, 13, 15]};
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

function host() {
  const dir = mkdtempSync(join(tmpdir(), 'diag870-'));
  const busy = join(dir, 'HOST-BUSY');
  writeFileSync(busy, 'q870: smoke-870, stage1-870, stage2-870 2026-11-24T00:00:00.000Z\n');
  const qualification = join(dir, 'qualification.json');
  json(qualification, {issue: 796, result: 'PASS', cpuSets: sets});
  return {dir, busy, qualification, env: {FUKULOW_HOST_BUSY: busy, FUKULOW_LAUNCH_JOB: 'stage1-870'}};
}
// The maintainer's go for one stage, as the operator records it before queueing the job.
function approval(dir: string, stage: string, over: Record<string, unknown> = {}) {
  const file = join(mkdtempSync(join(dir, 'go-')), 'approval.json');
  json(file, {issue: 870, stage, job: {smoke: 'smoke-870', '1': 'stage1-870', '2': 'stage2-870'}[stage], quote: 'go', date: '2026-11-26', ...over});
  return file;
}
// Stage 1 measurements with both cache replicates (N from C hot1/hot2) and a flat A1 (not reproduced).
function stage1Measurements(): Measurement[] {
  return sequence('1').filter((s): s is MeasuredStep => s.kind !== 'idle' && s.kind !== 'scan').map(s => ({id: s.id, kind: s.kind,
    arm: s.arm, order: s.order, settle: s.kind === 'copy' && s.settle, latencies: [{query: 'fullwidth', p95: 40}],
    plans: [{query: 'fullwidth', shapeHash: 'x', buffers: 1, sharedHit: 1, sharedRead: 0}], sharedReads: 0, invalid: [], missingEvidence: [],
    env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []}}));
}
// A prior stage's records as the worker and the supervisor leave them.
function prior(dir: string, stage: string, judgement: Record<string, unknown>,
  {finalized = true, valid = true, swept = true, normal = true, measurements = [] as Measurement[]} = {}) {
  const out = join(dir, `out-${stage}`);
  mkdirSync(out);
  const at = '2026-11-25T10:00:00.000Z';
  json(join(out, 'completed.json'), {manifestHash: hash, stage, at});
  json(join(out, 'judgement.json'), {stage, stopped: null, abnormal: normal ? [] : ['minimum not met: H2'], ...judgement});
  json(join(out, 'metadata.json'), {cpuSets: parsed});
  json(join(out, 'measurements.json'), {measurements, stopped: null});
  json(join(out, 'approval.json'), {issue: 870, stage, job: 'x', quote: 'go', date: '2026-11-25'});
  json(join(out, 'finish.json'), {normal, reasons: normal ? [] : ['minimum not met: H2']});
  if (finalized) {
    json(join(out, 'finished.json'), {manifestHash: hash, stage, at});
    json(join(out, 'run-status.json'), {manifestHash: hash, valid, cleanupVerified: valid, exitCode: valid ? 0 : 1});
  }
  if (swept) json(join(out, 'leftover-cleanup.json'), {verified: true, found: [], failures: []});
  return out;
}
const argv = (h: ReturnType<typeof host>, stage: string, extra: string[] = [], cpuSets = sets, go = approval(h.dir, stage)) =>
  ['--stage', stage, '--from-backfill', h.dir, '--out', join(h.dir, 'out'), '--cpu-sets', cpuSets, '--qualification', h.qualification,
    '--approval', go, ...extra];

test('the diagnosis runs only on Linux, with the #796 CPU sets and qualification', () => {
  const h = host();
  assert.throws(() => options(argv(h, 'smoke'), 'darwin'), /only on the #796-qualified Linux host/);
  assert.throws(() => options(['--stage', 'smoke', '--from-backfill', h.dir, '--out', h.dir, '--approval', 'a'], 'linux'), /CPU sets and --qualification are required/);
  assert.throws(() => options(['--stage', 'smoke', '--from-backfill', h.dir, '--out', h.dir], 'linux'), /--approval is required/);
  assert.doesNotThrow(() => options(argv(h, 'smoke'), 'linux'));
});

test('a run must be started by the launcher: HOST-BUSY held and naming this job', () => {
  const h = host();
  const args = options(argv(h, 'smoke'), 'linux');
  assert.doesNotThrow(() => prerequisites(args, hash, {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'}, 16));
  assert.throws(() => prerequisites(args, hash, {}, 16), /HOST-BUSY is not held/);
  assert.throws(() => prerequisites(args, hash, {...h.env, FUKULOW_LAUNCH_JOB: 'other'}, 16), /HOST-BUSY is not held/);
  assert.throws(() => prerequisites(args, hash, {...h.env, FUKULOW_HOST_BUSY: join(h.dir, 'missing')}, 16), /HOST-BUSY is not held/);
});

test('swapped CPU sets or a qualification that is not PASS on the #796 sets are refused', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  assert.throws(() => prerequisites(options(argv(h, 'smoke', [], swapped), 'linux'), hash, env, 16), /must be the #796 sets/);
  json(h.qualification, {issue: 796, result: 'FAIL', cpuSets: sets});
  assert.throws(() => prerequisites(options(argv(h, 'smoke'), 'linux'), hash, env, 16), /not recorded as PASS/);
});

test('Stage 1 needs a smoke the supervisor finalized as valid, not only the worker completion', () => {
  const h = host();
  const run = (out: string) => prerequisites(options(argv(h, '1', ['--smoke-out', out]), 'linux'), hash, h.env, 16);
  assert.doesNotThrow(() => run(prior(h.dir, 'smoke', {outcome: 'smoke passed'})));
  const unfinalized = prior(mkdtempSync(join(h.dir, 'u')), 'smoke', {outcome: 'smoke passed'}, {finalized: false});
  assert.throws(() => run(unfinalized), /not a finalized, valid smoke run/);
  const invalid = prior(mkdtempSync(join(h.dir, 'i')), 'smoke', {outcome: 'smoke passed'}, {valid: false});
  assert.throws(() => run(invalid), /not a finalized, valid smoke run/);
  // The supervisor publishes before the sweep: a sweep killed midway leaves no verified record.
  const unswept = prior(mkdtempSync(join(h.dir, 'w')), 'smoke', {outcome: 'smoke passed'}, {swept: false});
  assert.throws(() => run(unswept), /leftover sweep did not verify/);
  const failedSweep = prior(mkdtempSync(join(h.dir, 'x')), 'smoke', {outcome: 'smoke passed'}, {swept: false});
  json(join(failedSweep, 'leftover-cleanup.json'), {verified: false, found: [], failures: ['listing failed']});
  assert.throws(() => run(failedSweep), /leftover sweep did not verify/);
  assert.throws(() => run(prior(mkdtempSync(join(h.dir, 'f')), 'smoke', {outcome: 'smoke failed'})), /did not pass/);
});

test('Stage 2 needs a finalized Stage 1 whose recorded outcome and N are what its measurements give, N from the C replicates', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'stage2-870'};
  const ms = stage1Measurements();
  const good = stage1(ms);
  assert.deepEqual([good.outcome, good.noise], ['not reproduced', {value: 1.05, source: 'C hot1/hot2'}]);
  const run = (judgement: Record<string, unknown>, measurements = ms, normal = true) => {
    const out = prior(mkdtempSync(join(h.dir, 's')), '1', judgement, {measurements, normal});
    return prerequisites(options(argv(h, '2', ['--stage1-out', out]), 'linux'), hash, env, 16);
  };
  assert.deepEqual(run({outcome: good.outcome, noise: good.noise}).stage1Noise, {value: 1.05, source: 'C hot1/hot2'});
  assert.throws(() => run({outcome: 'smoke passed', noise: good.noise}), /no recognized outcome: smoke passed/);
  assert.throws(() => run({outcome: 'cause established', noise: good.noise}), /not what its measurements give/);
  assert.throws(() => run({outcome: good.outcome, noise: {value: 1.08, source: 'C hot1/hot2'}}), /recorded N is not what its measurements give/);
  assert.throws(() => run({outcome: good.outcome, noise: {value: 1.05, source: 'typed by hand'}}), /recorded N is not what/);
  // A fallback N (C replicate incomplete) is not accepted, even if its record were marked normal.
  const fallback = ms.map(m => m.id === 'C1.hot2' ? {...m, invalid: ['fake']} : m);
  const f = stage1(fallback);
  assert.equal(f.noise.source, 'A1 spread (fallback)');
  assert.throws(() => run({outcome: f.outcome, noise: f.noise}, fallback), /needs N from both Stage 1 cache replicates/);
  // A Stage 1 that was not a normal finish (a minimum not met) never feeds Stage 2.
  assert.throws(() => run({outcome: good.outcome, noise: good.noise}, ms, false), /not a normal finish of the Stage 1/);
});

test('every stage needs its own approval record, for this stage and this job, not before the stage it builds on', () => {
  const h = host();
  const smokeEnv = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  const run = (go: string, stage = 'smoke', env: Record<string, string> = smokeEnv, extra: string[] = []) =>
    prerequisites(options(argv(h, stage, extra, sets, go), 'linux'), hash, env, 16);
  assert.equal(run(approval(h.dir, 'smoke')).approval.stage, 'smoke');
  assert.throws(() => run(join(h.dir, 'missing.json')), /not an #870 approval record/);
  assert.throws(() => run(approval(h.dir, 'smoke', {issue: 689})), /not an #870 approval record/);
  assert.throws(() => run(approval(h.dir, '1', {job: 'smoke-870'})), /approval is for stage 1, not smoke/);
  assert.throws(() => run(approval(h.dir, 'smoke', {job: 'stage1-870'})), /approval is for job stage1-870, not smoke-870/);
  assert.throws(() => run(approval(h.dir, 'smoke', {quote: '  '})), /no quoted go/);
  assert.throws(() => run(approval(h.dir, 'smoke', {date: '26 Nov'})), /no valid date/);
  // Stage 1's go must not predate the smoke it builds on (finished 2026-11-25).
  const smokeOut = prior(mkdtempSync(join(h.dir, 'p')), 'smoke', {outcome: 'smoke passed'});
  assert.doesNotThrow(() => run(approval(h.dir, '1', {date: '2026-11-25'}), '1', h.env, ['--smoke-out', smokeOut]));
  assert.throws(() => run(approval(h.dir, '1', {date: '2026-11-24'}), '1', h.env, ['--smoke-out', smokeOut]), /predates the earlier stage/);
  // A smoke run without a recorded go is not a finished smoke.
  rmSync(join(smokeOut, 'approval.json'));
  assert.throws(() => run(approval(h.dir, '1'), '1', h.env, ['--smoke-out', smokeOut]), /no recorded go for the smoke/);
});

test('the sweep always records whether it verified a clean host; a failed removal revokes validity, cleanup and the zero exit', () => {
  const fake = (present: string[], failRm = false) => (...a: string[]) => {
    if (a[1] === 'ls') return a[0] === 'container' ? present.map(n => `${n}|153`).join('\n') : '';
    if (a[0] === 'rm') { if (failRm) throw new Error('busy'); present.splice(present.indexOf(a[2]), 1); }
    return '';
  };
  const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const clean = mkdtempSync(join(tmpdir(), 'diag870-'));
  assert.equal(sweepLeftovers(clean, fake([])), true);
  assert.deepEqual(read(clean, 'leftover-cleanup.json'), {verified: true, found: [], failures: []});

  const removed = mkdtempSync(join(tmpdir(), 'diag870-'));
  json(join(removed, 'run-status.json'), {valid: true});
  writeFileSync(join(removed, 'finished.json'), '{}');
  assert.equal(sweepLeftovers(removed, fake(['probe'])), true);
  assert.deepEqual(read(removed, 'leftover-cleanup.json'), {verified: true, found: [{kind: 'container', name: 'probe'}], failures: []});
  assert.equal(JSON.parse(readFileSync(join(removed, 'run-status.json'), 'utf8')).valid, true);

  const stuck = mkdtempSync(join(tmpdir(), 'diag870-'));
  json(join(stuck, 'run-status.json'), {valid: true, cleanupVerified: true, exitCode: 0});
  writeFileSync(join(stuck, 'finished.json'), '{}');
  const code = process.exitCode;
  try {
    assert.equal(sweepLeftovers(stuck, fake(['probe'], true)), false);
    const status = read(stuck, 'run-status.json');
    assert.deepEqual([status.valid, status.cleanupVerified, status.exitCode], [false, false, 1]);
    assert.equal(read(stuck, 'leftover-cleanup.json').verified, false);
    assert.equal(existsSync(join(stuck, 'finished.json')), false);
  } finally { process.exitCode = code; }
});

test('anything but a normal finish writes stopped.json, no completed.json, and exits 2; a normal finish exits 0', () => {
  assert.equal(stopExitCode, 2);
  const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const normal = mkdtempSync(join(tmpdir(), 'diag870-'));
  assert.equal(finishRecords(normal, '1', hash, null, []), 0);
  assert.deepEqual(read(normal, 'finish.json'), {normal: true, reasons: []});
  assert.equal(read(normal, 'completed.json').manifestHash, hash);
  assert.equal(existsSync(join(normal, 'stopped.json')), false);
  for (const reasons of [['STOP: A1.3: docker free 39.9 GB < 40 GB'], ['minimum not met: H2'], ['evidence incomplete']]) {
    const dir = mkdtempSync(join(tmpdir(), 'diag870-'));
    assert.equal(finishRecords(dir, '1', hash, null, reasons), stopExitCode, reasons[0]);
    assert.deepEqual(read(dir, 'finish.json'), {normal: false, reasons});
    assert.deepEqual(read(dir, 'stopped.json').reasons, reasons);
    assert.equal(existsSync(join(dir, 'completed.json')), false);
  }
});
