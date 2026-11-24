import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualifiedCpuSets } from './cluster.ts';
import { ends, options, prerequisites, stopExitCode, sweepLeftovers } from './run.ts';

const hash = 'h'.repeat(64);
const sets = qualifiedCpuSets;
const swapped = 'server=1,3,5,7,9,11,13,15;client=0,2,4,6,8,10,12,14';
const parsed = {server: [0, 2, 4, 6, 8, 10, 12, 14], client: [1, 3, 5, 7, 9, 11, 13, 15]};
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

function host() {
  const dir = mkdtempSync(join(tmpdir(), 'diag870-'));
  const busy = join(dir, 'HOST-BUSY');
  writeFileSync(busy, 'q870: smoke-870, stage1-870 2026-11-24T00:00:00.000Z\n');
  const qualification = join(dir, 'qualification.json');
  json(qualification, {issue: 796, result: 'PASS', cpuSets: sets});
  return {dir, busy, qualification, env: {FUKULOW_HOST_BUSY: busy, FUKULOW_LAUNCH_JOB: 'stage1-870'}};
}
// A prior stage's records as the worker and the supervisor leave them.
function prior(dir: string, stage: string, judgement: Record<string, unknown>, {finalized = true, valid = true, swept = true} = {}) {
  const out = join(dir, `out-${stage}`);
  mkdirSync(out);
  json(join(out, 'completed.json'), {manifestHash: hash, stage});
  json(join(out, 'judgement.json'), {stage, stopped: null, ...judgement});
  json(join(out, 'metadata.json'), {cpuSets: parsed});
  if (finalized) {
    json(join(out, 'finished.json'), {manifestHash: hash, stage});
    json(join(out, 'run-status.json'), {manifestHash: hash, valid, cleanupVerified: valid, exitCode: valid ? 0 : 1});
  }
  if (swept) json(join(out, 'leftover-cleanup.json'), {verified: true, found: [], failures: []});
  return out;
}
const argv = (h: ReturnType<typeof host>, stage: string, extra: string[] = [], cpuSets = sets) =>
  ['--stage', stage, '--from-backfill', h.dir, '--out', join(h.dir, 'out'), '--cpu-sets', cpuSets, '--qualification', h.qualification, ...extra];

test('the diagnosis runs only on Linux, with the #796 CPU sets and qualification', () => {
  const h = host();
  assert.throws(() => options(argv(h, 'smoke'), 'darwin'), /only on the #796-qualified Linux host/);
  assert.throws(() => options(['--stage', 'smoke', '--from-backfill', h.dir, '--out', h.dir], 'linux'), /CPU sets and --qualification are required/);
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

test('Stage 2 needs a finalized Stage 1 with a recognized outcome and N from a recognized source', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  const run = (judgement: Record<string, unknown>) => {
    const out = prior(mkdtempSync(join(h.dir, 's')), '1', judgement);
    return prerequisites(options(argv(h, '2', ['--stage1-out', out]), 'linux'), hash, env, 16);
  };
  const good = {outcome: 'cause not established', noise: {value: 1.08, source: 'C hot1/hot2'}};
  assert.deepEqual(run(good), {stage1Noise: 1.08});
  assert.throws(() => run({...good, outcome: 'smoke passed'}), /no recognized outcome/);
  assert.throws(() => run({...good, noise: {value: 1.08, source: 'typed by hand'}}), /no usable N/);
  assert.throws(() => run({...good, noise: {value: 1.04, source: 'C hot1/hot2'}}), /no usable N/);
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

test('a STOP or a failed smoke ends the run with a non-zero exit; a finished stage does not', () => {
  assert.equal(stopExitCode, 2);
  assert.equal(ends('A1.3: docker free 39.9 GB < 40 GB', {outcome: 'inconclusive'}), true);
  assert.equal(ends(null, {outcome: 'smoke failed'}), true);
  assert.equal(ends(null, {outcome: 'smoke passed'}), false);
  assert.equal(ends(null, {outcome: 'cause not established'}), false);
  assert.equal(ends(null, {result: 'inconclusive'}), false);
});
