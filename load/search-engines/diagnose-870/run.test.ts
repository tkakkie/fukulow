import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualifiedCpuSets } from './cluster.ts';
import { stage1, type Measurement } from './judge.ts';
import { sequence, type MeasuredStep } from './plan.ts';
import { finishRecords, limitedExitCode, options, parseCount, prerequisites, signalStop, stopExitCode, sweepLeftovers, workerGate } from './run.ts';

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
  json(file, {issue: 870, stage, job: {smoke: 'smoke-870', '1': 'stage1-870', '2': 'stage2-870'}[stage], quote: 'go', at: '2026-11-26T09:00:00+09:00', ...over});
  return file;
}
// Stage 1 measurements with both cache replicates (N from C hot1/hot2) and a flat A1 (not reproduced).
function stage1Measurements(): Measurement[] {
  return sequence('1').filter((s): s is MeasuredStep => s.kind !== 'idle' && s.kind !== 'scan').map(s => ({id: s.id, kind: s.kind,
    arm: s.arm, order: s.order, settle: s.kind === 'copy' && s.settle, latencies: [{query: 'fullwidth', p95: 40}],
    plans: [{query: 'fullwidth', shapeHash: 'x', buffers: 1, sharedHit: 1, sharedRead: 0}], sharedReads: 0, invalid: [], missingEvidence: [], samplerChecked: true,
    env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []}}));
}
// A prior stage's records as the worker and the supervisor leave them.
// `limited` leaves the records of a limited Stage 1 (exit 3, limited.json); `stopped` those of a STOP (exit 2).
function prior(dir: string, stage: string, judgement: Record<string, unknown>,
  {finalized = true, valid = true, swept = true, normal = true, measurements = [] as Measurement[], limited = false, stopped = false} = {}) {
  const out = join(dir, `out-${stage}`);
  mkdirSync(out);
  const at = '2026-11-25T10:00:00.000Z';
  const reasons = normal ? [] : (judgement.abnormal as string[] | undefined) ?? ['minimum not met: H2'];
  json(join(out, 'judgement.json'), {stage, stopped: null, abnormal: reasons, evidence: {complete: true, missing: []}, ...judgement});
  json(join(out, 'metadata.json'), {cpuSets: parsed});
  json(join(out, 'measurements.json'), {measurements, stopped: null});
  json(join(out, 'approval.json'), {issue: 870, stage, job: 'x', quote: 'go', at: '2026-11-25T09:00:00Z'});
  json(join(out, 'finish.json'), {normal, kind: normal ? 'normal' : limited ? 'limited' : 'blocked', reasons});
  if (limited || stopped) {
    json(join(out, limited ? 'limited.json' : 'stopped.json'), {stage, reasons, at});
    json(join(out, 'run-status.json'), {manifestHash: hash, valid: false, cleanupVerified: true, exitCode: limited ? 3 : 2});
    if (swept) json(join(out, 'leftover-cleanup.json'), {verified: true, found: [], failures: []});
    return out;
  }
  json(join(out, 'completed.json'), {manifestHash: hash, stage, at});
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
  const n = run({outcome: good.outcome, noise: good.noise}).stage1Noise!;
  assert.deepEqual([n.value, n.source], [1.05, 'C hot1/hot2']);
  // The exact spreads are recomputed from Stage 1's stored p95s for Stage 2 (review round 7).
  assert.equal(n.spreads.length, 2);
  assert.throws(() => run({outcome: 'smoke passed', noise: good.noise}), /no recognized outcome: smoke passed/);
  assert.throws(() => run({outcome: 'cause established', noise: good.noise}), /not what its measurements give/);
  assert.throws(() => run({outcome: good.outcome, noise: {value: 1.08, source: 'C hot1/hot2'}}), /recorded N is not what its measurements give/);
  assert.throws(() => run({outcome: good.outcome, noise: {value: 1.05, source: 'typed by hand'}}), /recorded N is not what/);
  // A fallback N (C replicate incomplete) is not accepted from a record marked normal.
  const fallback = ms.map(m => m.id === 'C1.hot2' ? {...m, invalid: ['fake']} : m);
  const f = stage1(fallback);
  assert.equal(f.noise.source, 'A1 spread (fallback)');
  assert.throws(() => run({outcome: f.outcome, noise: f.noise}, fallback), /recorded shortfall is not what its measurements give/);
  // Its real records are a limited finish, which needs the limited path and its own acknowledging go.
  assert.throws(() => run({outcome: f.outcome, noise: f.noise, abnormal: f.abnormal}, fallback), /not a normal finish of the Stage 1/);
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
  assert.throws(() => run(approval(h.dir, 'smoke', {at: '26 Nov'})), /no valid time/);
  assert.throws(() => run(approval(h.dir, 'smoke', {at: '2026-11-26'})), /no valid time/);
  assert.throws(() => run(approval(h.dir, 'smoke', {at: '2026-11-26T09:00:00'})), /no valid time/);
  // Stage 1's go must not precede the smoke's finish (2026-11-25T10:00Z), to the instant, not the day.
  const smokeOut = prior(mkdtempSync(join(h.dir, 'p')), 'smoke', {outcome: 'smoke passed'});
  assert.doesNotThrow(() => run(approval(h.dir, '1', {at: '2026-11-25T10:00:00Z'}), '1', h.env, ['--smoke-out', smokeOut]));
  assert.doesNotThrow(() => run(approval(h.dir, '1', {at: '2026-11-25T19:00:00+09:00'}), '1', h.env, ['--smoke-out', smokeOut]));
  assert.throws(() => run(approval(h.dir, '1', {at: '2026-11-25T09:59:59Z'}), '1', h.env, ['--smoke-out', smokeOut]), /predates the finish/);
  // Same day, morning go before an afternoon finish (JST): refused.
  assert.throws(() => run(approval(h.dir, '1', {at: '2026-11-25T18:59:00+09:00'}), '1', h.env, ['--smoke-out', smokeOut]), /predates the finish/);
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

test('anything but a normal or limited finish writes stopped.json, no completed.json, and exits 2; a normal finish exits 0', () => {
  assert.equal(stopExitCode, 2);
  const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const normal = mkdtempSync(join(tmpdir(), 'diag870-'));
  assert.equal(finishRecords(normal, '1', hash, null, []), 0);
  assert.deepEqual(read(normal, 'finish.json'), {normal: true, kind: 'normal', reasons: []});
  assert.equal(read(normal, 'completed.json').manifestHash, hash);
  assert.equal(existsSync(join(normal, 'stopped.json')), false);
  for (const reasons of [['STOP: A1.3: docker free 39.9 GB < 40 GB'], ['minimum not met: H2'], ['evidence incomplete']]) {
    const dir = mkdtempSync(join(tmpdir(), 'diag870-'));
    assert.equal(finishRecords(dir, '1', hash, null, reasons), stopExitCode, reasons[0]);
    // Without a limited Stage 1 record (smoke, Stage 2, a STOP, incomplete evidence) it is blocked.
    assert.deepEqual(read(dir, 'finish.json'), {normal: false, kind: 'blocked', reasons});
    assert.deepEqual(read(dir, 'stopped.json').reasons, reasons);
    assert.equal(existsSync(join(dir, 'completed.json')), false);
  }
});

test('the worker checks the prerequisites itself and claims a one-time token; SEARCH_WORKER alone reaches nothing', () => {
  const h = host();
  const smokeEnv = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  const go = approval(h.dir, 'smoke');
  const args = argv(h, 'smoke', [], sets, go);
  const out = mkdtempSync(join(h.dir, 'run-'));
  const parsed = options(args, 'linux');
  json(join(out, 'approval.json'), JSON.parse(readFileSync(go, 'utf8')));
  writeFileSync(join(out, 'worker-token'), 'tok');
  const env = {...smokeEnv, SEARCH_WORKER: '1', DIAG870_ARGV: JSON.stringify(args), DIAG870_TOKEN: 'tok', DIAG870_OUT: out,
    DIAG870_STAGE: 'smoke', DIAG870_FROM: parsed.from, DIAG870_CPU_SETS: sets};
  const gate = (e: Record<string, string>) => workerGate(e, hash, 16, 'linux');
  // Inherited worker settings without a launch: refused.
  assert.throws(() => gate({SEARCH_WORKER: '1', ...h.env}), /Not a supervised #870 worker launch/);
  // A launch whose prerequisites no longer hold (HOST-BUSY gone): refused.
  assert.throws(() => gate({...env, FUKULOW_HOST_BUSY: join(h.dir, 'gone')}), /HOST-BUSY is not held/);
  assert.throws(() => gate({...env, DIAG870_STAGE: '1'}), /do not match the launch arguments/);
  assert.throws(() => gate({...env, DIAG870_TOKEN: 'other'}), /token does not match/);
  // The failed attempt above already claimed the token; a fresh one is claimed once only.
  writeFileSync(join(out, 'worker-token'), 'tok');
  assert.equal(gate(env).approval.stage, 'smoke');
  assert.throws(() => gate(env), /missing or already claimed/);
});

test('a signal aborts at once, then exits only after the sampler stop and the abnormal finish record', async () => {
  const order: string[] = [];
  let release!: () => void;
  const stop = () => new Promise<{verified: boolean; how: string}>(r => { release = () => { order.push('stopped'); r({verified: true, how: 'SIGTERM'}); }; });
  signalStop('SIGTERM', 143, {abort: () => order.push('abort'), stop, record: () => order.push('record'), exit: code => order.push(`exit ${code}`)})();
  // The abort is synchronous: nothing new can start while the sampler stops.
  assert.deepEqual(order, ['abort']);
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(order, ['abort']);
  release();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(order, ['abort', 'stopped', 'record', 'exit 143']);
});

test('a signal records an abnormal finish: stopped.json, no completed.json, finish.json not normal', () => {
  const out = mkdtempSync(join(tmpdir(), 'diag870-sig-'));
  // Even after a normal finish was recorded, a later signal leaves no completed.json behind.
  assert.equal(finishRecords(out, '1', hash, null, []), 0);
  assert.equal(finishRecords(out, '1', hash, 'signal SIGTERM', ['STOP: signal SIGTERM']), stopExitCode);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'finish.json'), 'utf8')), {normal: false, kind: 'blocked', reasons: ['STOP: signal SIGTERM']});
  assert.equal(existsSync(join(out, 'completed.json')), false);
  assert.equal(JSON.parse(readFileSync(join(out, 'stopped.json'), 'utf8')).stopped, 'signal SIGTERM');
});

test('a read counter must be a single integer; empty or other output is unreadable (Neon r5)', () => {
  assert.equal(parseCount('\n1234\n'), 1234);
  assert.equal(parseCount('0'), 0);
  assert.throws(() => parseCount(''), /not a count/);
  assert.throws(() => parseCount('x\n'), /not a count/);
  assert.throws(() => parseCount('12.5'), /not a count/);
});

// Maintainer decision on PR #871, re-approval question 2: a limited Stage 1 is distinct from a safety STOP.
test('a limited Stage 1 allows Stage 2 only with usable evidence, a computable N and a go naming it; a STOP never does', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'stage2-870'};
  const fallback = stage1Measurements().map(m => m.id === 'C1.hot2' ? {...m, invalid: ['fake']} : m);
  const f = stage1(fallback);
  assert.equal(f.finish.kind, 'limited');
  assert.deepEqual(f.finish.shortfall, ['minimum not met: H1', 'INVALID: C1.hot2']);
  assert.equal(f.finish.nSource, 'A1 spread (fallback)');
  assert.match(f.finish.stage2Constraints.join(' '), /cannot establish a cause.*A1 spread \(fallback/s);
  const record = {outcome: f.outcome, noise: f.noise, abnormal: f.abnormal, finish: f.finish};
  const ack = {acceptsLimitedStage1: {outcome: f.outcome, shortfall: f.finish.shortfall}};
  const run = (judgement: Record<string, unknown>, ms: Measurement[], go: Record<string, unknown>, kind: {limited?: boolean; stopped?: boolean} = {limited: true}) => {
    const out = prior(mkdtempSync(join(h.dir, 'l')), '1', judgement, {measurements: ms, normal: false, ...kind});
    return prerequisites(options(argv(h, '2', ['--stage1-out', out], sets, approval(h.dir, '2', go)), 'linux'), hash, env, 16);
  };
  const n = run(record, fallback, ack).stage1Noise!;
  assert.deepEqual([n.source, n.stage1.kind, n.stage1.shortfall, n.spreads.length], ['A1 spread (fallback)', 'limited', f.finish.shortfall, 1]);
  assert.deepEqual(n.stage1.constraints, f.finish.stage2Constraints);
  // Without the acknowledgement, or one naming another outcome or shortfall: refused.
  assert.throws(() => run(record, fallback, {}), /must name it/);
  assert.throws(() => run(record, fallback, {acceptsLimitedStage1: {outcome: f.outcome, shortfall: ['minimum not met: H2']}}), /must name it/);
  // Unusable evidence: a measurement with missing evidence.
  // Unusable evidence (a measurement with missing evidence) is a blocked finish; records claiming limited are refused.
  const partial = fallback.map(m => m.id === 'A1.3' ? {...m, missingEvidence: ['stats-after: Error: psql']} : m);
  const p = stage1(partial);
  assert.equal(p.finish.kind, 'blocked');
  assert.throws(() => run({outcome: p.outcome, noise: p.noise, abnormal: p.abnormal, finish: {...p.finish, kind: 'limited'}, evidence: {complete: true}}, partial,
    {acceptsLimitedStage1: {outcome: p.outcome, shortfall: p.finish.shortfall}}), /evidence is incomplete/);
  // N cannot be computed: no valid C replicate and no valid A1 round.
  const none = fallback.map(m => m.id.startsWith('A1.') ? {...m, invalid: ['fake']} : m);
  const g = stage1(none);
  assert.equal(g.finish.nComputable, false);
  assert.equal(g.finish.stage2, 'refused');
  assert.throws(() => run({outcome: g.outcome, noise: g.noise, abnormal: g.abnormal, finish: g.finish}, none,
    {acceptsLimitedStage1: {outcome: g.outcome, shortfall: g.finish.shortfall}}), /N cannot be computed/);
  // A safety STOP: stopped.json, exit 2. Refused even with an acknowledging go and usable measurements.
  assert.throws(() => run(record, fallback, ack, {stopped: true}), /not a finalized, valid Stage 1 run/);
  // A STOP recorded on top of limited records is still refused.
  const both = prior(mkdtempSync(join(h.dir, 'b')), '1', record, {measurements: fallback, normal: false, limited: true});
  writeFileSync(join(both, 'stopped.json'), '{}');
  assert.throws(() => prerequisites(options(argv(h, '2', ['--stage1-out', both], sets, approval(h.dir, '2', ack)), 'linux'), hash, env, 16), /stopped/);
});

test('finish records: a STOP is blocked (exit 2, stopped.json), a limited Stage 1 exits 3 with limited.json; both end the queue', () => {
  const out = mkdtempSync(join(tmpdir(), 'diag870-kind-'));
  const limited = {nSource: 'A1 spread (fallback)', constraints: ['c']};
  assert.equal(finishRecords(out, '1', hash, null, ['INVALID: A1.2'], limited), limitedExitCode);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'finish.json'), 'utf8')), {normal: false, kind: 'limited', reasons: ['INVALID: A1.2']});
  assert.equal(JSON.parse(readFileSync(join(out, 'limited.json'), 'utf8')).nSource, 'A1 spread (fallback)');
  assert.equal(existsSync(join(out, 'stopped.json')), false);
  // A STOP is never limited, whatever else is recorded: blocked, and limited.json goes.
  assert.equal(finishRecords(out, '1', hash, 'A1.3: disk', ['STOP: A1.3: disk', 'INVALID: A1.2'], limited), stopExitCode);
  assert.equal(JSON.parse(readFileSync(join(out, 'finish.json'), 'utf8')).kind, 'blocked');
  assert.equal(existsSync(join(out, 'limited.json')), false);
  assert.equal(existsSync(join(out, 'stopped.json')), true);
  assert.notEqual(limitedExitCode, 0);
});
