import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { measuredSetsArg, sets796 } from '../../harness-core/frequency-layout.ts';
import { formatHostBusy } from '../../launcher/host-busy.ts';
import { rawIo, type Io } from './io.ts';
import { qualifiedCpuSets } from './qualification.ts';
import { stage1, type Measurement } from './judge.ts';
import { sequence, type MeasuredStep } from './plan.ts';
import { approvalFor, finishRecords, limitedExitCode, main, options, parseCount, prerequisites, readCounterWaitMs, readsDelta, signalStop, stopExitCode, workerGate } from './run.ts';

const hash = 'h'.repeat(64);
const sets = qualifiedCpuSets;
const swapped = 'client=2,4,6,10,12,14;server=1,3,5,9,11,13;housekeeping=0,7,8,15';
const launchSession = 'session-870';
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

function host() {
  const dir = mkdtempSync(join(tmpdir(), 'diag870-'));
  const busy = join(dir, 'HOST-BUSY');
  writeFileSync(busy, formatHostBusy('q870', ['smoke-870', 'stage1-870', 'stage2-870'],
    new Date('2026-11-24T00:00:00.000Z'), launchSession));
  const qualification = join(dir, 'qualification.json');
  const reportPath = join(dir, 'formal-report.json');
  const verdict = {result: 'PASS', reasons: [], runs: [1, 2, 3].map(i => ({name: `formal-${i}`, valid: true}))};
  json(reportPath, verdict);
  const formalReport = {path: reportPath, sha256: createHash('sha256').update(readFileSync(reportPath)).digest('hex')};
  const record = {issue: 796, result: 'PASS', cpuSets: sets, formalReport};
  json(qualification, record);
  return {dir, busy, qualification, record, verdict, env: {
    FUKULOW_HOST_BUSY: busy, FUKULOW_LAUNCH_JOB: 'stage1-870', FUKULOW_LAUNCH_SESSION: launchSession}};
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
  json(join(out, 'metadata.json'), {cpuSets: sets796});
  json(join(out, 'measurements.json'), {measurements, stopped: null});
  json(join(out, 'approval.json'), {issue: 870, stage, job: 'x', quote: 'go', at: '2026-11-25T09:00:00Z'});
  json(join(out, 'finish.json'), {normal, kind: normal ? 'normal' : limited ? 'limited' : 'blocked', reasons});
  if (limited || stopped) {
    json(join(out, limited ? 'limited.json' : 'stopped.json'), limited ? {stage, shortfall: reasons, at} : {stage, reasons, at});
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
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  assert.doesNotThrow(() => prerequisites(args, hash, env, 16));
  assert.doesNotThrow(() => prerequisites(args, hash, {...env, FUKULOW_LAUNCH_SESSION: undefined}, 16));
  assert.throws(() => prerequisites(args, hash, {}, 16), /HOST-BUSY is not held/);
  assert.throws(() => prerequisites(args, hash, {...env, FUKULOW_LAUNCH_JOB: 'smoke'}, 16), /HOST-BUSY is not held/);
  assert.throws(() => prerequisites(args, hash, {...env, FUKULOW_HOST_BUSY: join(h.dir, 'missing')}, 16), /HOST-BUSY is not held/);
  assert.throws(() => prerequisites(args, hash, {...env, FUKULOW_LAUNCH_SESSION: 'other'}, 16), /HOST-BUSY is not held/);
});

test('the #870 smoke accepts the launcher HOST-BUSY line with a session', t => {
  const h = host();
  t.after(() => rmSync(h.dir, {recursive: true}));
  const session = '12345678-1234-4234-8234-123456789abc';
  writeFileSync(h.busy, 'q870: smoke-870 2026-11-26T00:00:00.000Z session 12345678-1234-4234-8234-123456789abc\n');
  const args = options(argv(h, 'smoke'), 'linux');
  assert.doesNotThrow(() => prerequisites(args, hash, {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870', FUKULOW_LAUNCH_SESSION: session}, 16));
});

test('swapped CPU sets or a qualification that is not PASS on the #796 sets are refused', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  assert.throws(() => prerequisites(options(argv(h, 'smoke', [], swapped), 'linux'), hash, env, 16), /must be the #796 sets/);
  json(h.qualification, {issue: 796, result: 'FAIL', cpuSets: sets});
  assert.throws(() => prerequisites(options(argv(h, 'smoke'), 'linux'), hash, env, 16), /not recorded as PASS/);
});

test('#870 accepts the canonical three-set qualification with the verified formal report', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  const check = (cpuSets = sets) => prerequisites(options(argv(h, 'smoke', [], cpuSets), 'linux'), hash, env, 16);
  assert.equal(sets, 'server=2,4,6,10,12,14;client=1,3,5,9,11,13;housekeeping=0,7,8,15');
  assert.deepEqual(check().sets, sets796);
  assert.deepEqual(check().qualification.formalReport.runs, ['formal-1', 'formal-2', 'formal-3']);
  assert.throws(() => check(measuredSetsArg), /must be the #796 sets/);
  assert.throws(() => check(`${measuredSetsArg};housekeeping=0,7,8`), /must be the #796 sets/);
  json(h.qualification, {...h.record, cpuSets: measuredSetsArg});
  assert.throws(() => check(), /not recorded as PASS/);
});

test('qualification refuses missing provenance, a mismatched report hash, or a non-PASS formal report', () => {
  const h = host();
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870'};
  const check = () => prerequisites(options(argv(h, 'smoke'), 'linux'), hash, env, 16);
  json(h.qualification, {...h.record, formalReport: undefined});
  assert.throws(check, /needs the formal report path and full SHA-256/);
  json(h.qualification, h.record);
  json(h.record.formalReport.path, {...h.verdict, result: 'FAIL'});
  assert.throws(check, /formal report hash differs/);
  h.record.formalReport.sha256 = createHash('sha256').update(readFileSync(h.record.formalReport.path)).digest('hex');
  json(h.qualification, h.record);
  assert.throws(check, /formal report must be PASS/);
  rmSync(h.record.formalReport.path);
  assert.throws(check, /ENOENT/);
});

test('Stage 1 needs a smoke the supervisor finalized as valid, not only the worker completion', () => {
  const h = host();
  const run = (out: string) => prerequisites(options(argv(h, '1', ['--smoke-out', out]), 'linux'), hash, h.env, 16);
  assert.doesNotThrow(() => run(prior(h.dir, 'smoke', {outcome: 'smoke passed'})));
  const wrongLayout = prior(mkdtempSync(join(h.dir, 'layout')), 'smoke', {outcome: 'smoke passed'});
  json(join(wrongLayout, 'metadata.json'), {cpuSets: {...sets796, housekeeping: undefined}});
  assert.throws(() => run(wrongLayout), /ran on other CPU sets/);
  const unfinalized = prior(mkdtempSync(join(h.dir, 'u')), 'smoke', {outcome: 'smoke passed'}, {finalized: false});
  assert.throws(() => run(unfinalized), /not a finalized, valid smoke run/);
  const invalid = prior(mkdtempSync(join(h.dir, 'i')), 'smoke', {outcome: 'smoke passed'}, {valid: false});
  assert.throws(() => run(invalid), /not a finalized, valid smoke run/);
  // A missing cleanup record must still be refused even if a completion file exists.
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
  const n = run({outcome: good.outcome, noise: good.noise, finish: good.finish}).stage1Noise!;
  // The recorded finish must be what the measurements give, not only the outcome and N.
  assert.throws(() => run({outcome: good.outcome, noise: good.noise}), /recorded finish \(kind or shortfall\) is not what/);
  assert.throws(() => run({outcome: good.outcome, noise: good.noise, finish: {...good.finish, kind: 'limited'}}), /recorded finish \(kind or shortfall\) is not what/);
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

test('approvalFor rejects pending placeholders in quote, job and at', t => {
  const dir = mkdtempSync(join(tmpdir(), 'diag870-go-'));
  t.after(() => rmSync(dir, {recursive: true}));
  for (const field of ['quote', 'job', 'at']) {
    for (const value of ['PENDING', 'pending', '  PeNdInG \t']) {
      const file = approval(dir, 'smoke', {[field]: value});
      assert.throws(() => approvalFor(file, 'smoke', field === 'job' ? value : 'smoke-870', null),
        /go is still a pending placeholder/, `${field}=${JSON.stringify(value)}`);
    }
  }
  assert.equal(approvalFor(approval(dir, 'smoke'), 'smoke', 'smoke-870', null).quote, 'go');
});

function preflightFixture(t: TestContext) {
  const h = host();
  t.after(() => rmSync(h.dir, {recursive: true}));
  const args = argv(h, 'smoke');
  const env = {...h.env, FUKULOW_LAUNCH_JOB: 'smoke-870',
    FUKULOW_LAUNCH_GATE_LOG: join(h.dir, 'smoke-870-gate.log')};
  const calls: string[] = [];
  const io = Object.fromEntries(Object.keys(rawIo).map(name => [name, () => {
    calls.push(name);
    assert.fail(`Unexpected ${name} call`);
  }])) as unknown as Io;
  const out = join(realpathSync(h.dir), 'out');
  return {args, env, out, calls, deps: {io, os: 'linux' as const, logicalCpus: 16}};
}

test('a driver host preflight failure stops before supervision and Docker', async t => {
  const f = preflightFixture(t);
  const problems = ['CPU policy unreadable'];
  let gates = 0;
  await assert.rejects(main(f.args, f.env, {...f.deps, hostGate: (session, path, source) => {
    gates++;
    assert.equal(session, f.env.FUKULOW_LAUNCH_SESSION);
    assert.equal(path, f.out);
    assert.deepEqual(source, {launcherGateLog: f.env.FUKULOW_LAUNCH_GATE_LOG});
    return {problems};
  }, supervise: async () => assert.fail('supervisor started')}), /STOP: host preflight.*CPU policy unreadable/);
  assert.equal(gates, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(readFileSync(join(f.out, 'host-preflight.json'), 'utf8')), {problems});
});

test('the worker rechecks the host after driver preflight and stops before Docker on drift', async t => {
  const f = preflightFixture(t);
  const problems = ['host service inactive'];
  let gates = 0;
  const deps = {...f.deps, hostGate: (session: string, path: string) => {
    assert.equal(session, f.env.FUKULOW_LAUNCH_SESSION);
    assert.equal(path, f.out);
    return {problems: ++gates === 1 ? [] : problems};
  }};
  await assert.rejects(main(f.args, f.env, {...deps, supervise: ({env}) => main([], {...env, SEARCH_WORKER: '1'}, deps)}),
    /STOP: host preflight.*host service inactive/);
  assert.equal(gates, 2);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(JSON.parse(readFileSync(join(f.out, 'host-preflight.json'), 'utf8')), {problems: []});
  assert.deepEqual(JSON.parse(readFileSync(join(f.out, 'host-preflight-worker.json'), 'utf8')), {problems});
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
  const gate = (e: Record<string, string>) => workerGate(e, hash, 16, 'linux', () => ({problems: []}));
  const {qualification} = prerequisites(parsed, hash, smokeEnv, 16);
  json(join(out, 'qualification.json'), qualification);
  // Inherited worker settings without a launch: refused.
  assert.throws(() => gate({SEARCH_WORKER: '1', ...h.env}), /Not a supervised #870 worker launch/);
  // A launch whose prerequisites no longer hold (HOST-BUSY gone): refused.
  assert.throws(() => gate({...env, FUKULOW_HOST_BUSY: join(h.dir, 'gone')}), /HOST-BUSY is not held/);
  json(h.qualification, {...h.record, result: 'FAIL'});
  assert.throws(() => gate(env), /not recorded as PASS/);
  json(h.qualification, h.record);
  assert.ok(existsSync(join(out, 'worker-token')));
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
  // A stale limited.json or finish.json naming another shortfall is refused, even when the judgement, the
  // measurements and the go agree (sol final review).
  const stale = (file: string, field: string) => {
    const out = prior(mkdtempSync(join(h.dir, 's')), '1', record, {measurements: fallback, normal: false, limited: true});
    const rec = JSON.parse(readFileSync(join(out, file), 'utf8'));
    writeFileSync(join(out, file), JSON.stringify({...rec, [field]: ['INVALID: A1.2']}));
    return () => prerequisites(options(argv(h, '2', ['--stage1-out', out], sets, approval(h.dir, '2', ack)), 'linux'), hash, env, 16);
  };
  assert.throws(stale('limited.json', 'shortfall'), /limited\.json shortfall is not what/);
  assert.throws(stale('finish.json', 'reasons'), /finish\.json reasons are not what/);
  // Without the acknowledgement, or one naming another outcome or shortfall: refused.
  assert.throws(() => run(record, fallback, {}), /must name it/);
  assert.throws(() => run(record, fallback, {acceptsLimitedStage1: {outcome: f.outcome, shortfall: ['minimum not met: H2']}}), /must name it/);
  // The go is matched against the recomputed shortfall (sol review of the re-approval fix): a record whose finish
  // names another shortfall than its own measurements give is refused, with a go naming either one.
  const forged = {...record, finish: {...f.finish, shortfall: ['minimum not met: H2']}};
  assert.throws(() => run(forged, fallback, {acceptsLimitedStage1: {outcome: f.outcome, shortfall: ['minimum not met: H2']}}), /recorded finish \(kind or shortfall\) is not what/);
  assert.throws(() => run(forged, fallback, ack), /recorded finish \(kind or shortfall\) is not what/);
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

test('shared reads are the read counter delta after the approved 1 s wait, never the cumulative value', () => {
  assert.equal(readCounterWaitMs, 1_000);
  assert.equal(readsDelta(900, 900), 0);
  assert.equal(readsDelta(900, 950), 50);
  assert.equal(readsDelta(null, 950), null);
  assert.equal(readsDelta(900, null), null);
  // A counter that went backwards (a reset) is not a delta.
  assert.equal(readsDelta(950, 900), null);
});
