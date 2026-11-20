import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appFailures, classifyPair, diagnosticAppEvidence, diagnosticValidity, hasAppFailure, poolStatsCapability, validityResult } from './pool-before-after-diagnostic-results.ts';
import { generatorConfig } from './pool-before-after-config.ts';
import { parseActivity } from './pool-before-after-db.ts';
import { activityWindow, generatorStats, generatorWindow } from './pool-before-after-sampling.ts';

const lane = (name: string, attempted = 15000) => ({
  name, attempted, accepted: attempted, rejected429: 0, rejected503: 0, otherErrors: 0, clientTimeouts: 0,
  transportErrors: 0, droppedIterations: 0, p95: 15, p99: 25,
});

const databaseFailures = { pool_timeout: 0, pool_closed: 0, deadline: 0, io: 0, database: 0, other: 0 };
function validEvidence(vus = 200, vus_max = 3200): Parameters<typeof diagnosticValidity>[0] {
  const lanes = [lane('send'), lane('reads', 30000), lane('signin', 1200), lane('reader', 142)];
  const { scenarios } = generatorConfig(false, true, 'old', [250]);
  const vusLimit = Object.values(scenarios).reduce((sum, scenario) => sum + scenario.maxVUs, 0);
  const samples = Array.from({length: 71}, (_, i) => ({
    at: i * 1000, cpuTicks: i * 700, rssKiB: 1024, cpuPercent: 700, vus, vus_max,
  }));
  const generator = generatorWindow({ samples, errors: [] }, 0, 71000, vusLimit);
  return {
    hostLoad: 2.99, approvedSchedule: true, scheduledSendAttempts: 15000, send: lanes[0],
    lanes, expectedLanes: lanes.map(l => l.name),
    resources: { complete: true, samples: 71, maxSampleGapMs: 1000, maxInteriorGapMs: 1000, samplingErrors: 0 },
    generator, generatorRun: generator, cpuLimit: 8, vusLimit, vusPeak: 200, droppedIterations: 0, http5xx: 0, generatorExitCode: 0,
    app: { complete: true, reasons: [], http5xx: 0, panics: 0, databaseFailures, unknownEvents: [] }, statementsCaptured: true,
  };
}

test('diagnostic offered send tolerance accepts both 1% edges', () => {
  for (const attempted of [14850, 15000, 15150]) {
    const evidence = validEvidence();
    evidence.send = evidence.lanes[0] = lane('send', attempted);
    assert.deepEqual(diagnosticValidity(evidence), { valid: true, reasons: [] });
  }
});

test('every validity fault prevents an otherwise valid arm from qualifying', () => {
  type Evidence = ReturnType<typeof validEvidence>;
  const cases: [string, (e: Evidence) => void][] = [
    ['more than 1%', e => { e.send = e.lanes[0] = lane('send', 14849); }],
    ['more than 1%', e => { e.send = e.lanes[0] = lane('send', 15151); }],
    ['dropped iterations', e => { e.lanes[3].droppedIterations = e.droppedIterations = 1; }],
    ['incomplete dropped iterations evidence', e => { e.droppedIterations = 1; }],
    ['CPU saturated', e => { e.generatorRun = { ...e.generator, cpuPercent: { ...e.generator.cpuPercent, peak: 720 } }; }],
    ['reached maxVUs', e => { e.generatorRun = { ...e.generator, reachedMaxVUs: true }; }],
    ['reached maxVUs', e => { e.vusPeak = e.vusLimit; }],
    ['host load reached 3', e => { e.hostLoad = 3; }],
    ['missing pair-start host load', e => { e.hostLoad = undefined; }],
    ['missing app/DB resource evidence', e => { e.resources.samplingErrors = 1; }],
    ['missing generator CPU/VU evidence', e => { e.generator.vus.maxSampleGapMs = 3000; }],
    ['missing generator CPU/VU evidence', e => { e.generator.cpuPercent.maxInteriorGapMs = 2000; }],
    ['missing generator CPU/VU evidence', e => { e.generator.cpuPercent.peak = null; }],
    ['missing or duplicate generator lanes', e => { e.lanes.pop(); }],
    ['missing send p95', e => { delete (e.send as Partial<NonNullable<Evidence['send']>>).p95; }],
    ['missing HTTP 5xx count', e => { e.http5xx = undefined; }],
    ['app log: missing pool_stats', e => { e.app = { ...e.app, complete: false, reasons: ['missing pool_stats'] }; }],
    ['missing pg_stat_statements', e => { e.statementsCaptured = false; }],
    ['requires one mixed 250/s step', e => { e.approvedSchedule = false; }],
    ['generator exited unsuccessfully', e => { e.generatorExitCode = 1; }],
  ];
  for (const [reason, edit] of cases) {
    const evidence = validEvidence();
    edit(evidence);
    const result = diagnosticValidity(evidence);
    assert.equal(result.valid, false, reason);
    assert.ok(result.reasons.some(r => r.includes(reason)), JSON.stringify(result));
  }
});

test('pair classifications apply in order at the pre-set boundaries', () => {
  const arm = (sendP95Ms: number | null, hasAppFailure = false) => ({ validity: validityResult([]), sendP95Ms, hasAppFailure });
  for (const [b, a, classification] of [
    [arm(50), arm(100), 'slow'],
    [arm(9), arm(20), 'healthy'],
    [arm(9), arm(20.001), 'ambiguous'],
    [arm(25), arm(50), 'healthy'],
    [arm(25, true), arm(50), 'healthy'],
    [arm(25), arm(null, true), 'slow'],
    [arm(25, true), arm(11, true), 'slow'],
    [arm(25, true), arm(100, true), 'slow'],
  ] as const) {
    assert.deepEqual(classifyPair(b, a), { validity: validityResult([]), classification, diagnosticClassification: classification });
  }
});

const dropReason = 'dropped iterations';
const mismatchReason = 'offered sends differ from schedule by more than 1%';
const validArm = { validity: validityResult([]), sendP95Ms: 10, hasAppFailure: false };
const droppedArm = (attempted: number, droppedIterations: number, sendP95Ms: number, http503 = 0) => {
  const evidence = validEvidence();
  const send = { ...lane('send', attempted), accepted: attempted - http503, rejected503: http503, droppedIterations, p95: sendP95Ms };
  evidence.send = evidence.lanes[0] = send;
  evidence.droppedIterations = droppedIterations;
  return { validity: diagnosticValidity(evidence), sendP95Ms,
    hasAppFailure: hasAppFailure(appFailures(evidence.lanes, evidence.http5xx, evidence.app)),
    sendSchedule: { attempted, droppedIterations, scheduledSendAttempts: evidence.scheduledSendAttempts } };
};

test('only valid B can qualify a drop-limited A', () => {
  const invalid = droppedArm(14999, 1, 100);
  assert.deepEqual(invalid.validity, validityResult([dropReason]));
  assert.deepEqual(classifyPair(invalid, validArm), {
    validity: validityResult([`B: ${dropReason}`]), classification: null, diagnosticClassification: null,
  });
  assert.deepEqual(classifyPair(invalid, invalid), {
    validity: validityResult([`B: ${dropReason}`, `A: ${dropReason}`]), classification: null, diagnosticClassification: null,
  });
});

test('invalid A with no validity reasons has no diagnostic classification', () => {
  const a = { validity: { valid: false, reasons: [] }, sendP95Ms: 100, hasAppFailure: false };
  assert.deepEqual(classifyPair(validArm, a), { validity: a.validity, classification: null, diagnosticClassification: null });
});

test('drop-limited A uses the existing latency and app failure signals', () => {
  for (const [a, diagnosticClassification] of [
    [droppedArm(14999, 1, 100), 'slow_with_drops'],
    [droppedArm(14999, 1, 99, 1), 'slow_with_drops'],
    [droppedArm(14999, 1, 99), 'ambiguous'],
    [droppedArm(14999, 1, 10), 'ambiguous'],
    [{ ...droppedArm(14999, 1, 10, 1), sendP95Ms: null }, 'slow_with_drops'],
    [{ ...droppedArm(14999, 1, 10), sendP95Ms: null }, 'ambiguous'],
  ] as const) {
    assert.deepEqual(a.validity, validityResult([dropReason]));
    assert.deepEqual(classifyPair(validArm, a), {
      validity: validityResult([`A: ${dropReason}`]), classification: null, diagnosticClassification,
    });
  }
});

test('only send-lane drops within the schedule tolerance reconcile an offered-send mismatch', () => {
  const evidence = validEvidence();
  evidence.send = evidence.lanes[0] = lane('send', 14700);
  evidence.lanes[1].droppedIterations = evidence.droppedIterations = 300;
  const readsDropped = { ...droppedArm(14700, 0, 100), validity: diagnosticValidity(evidence) };
  for (const [a, diagnosticClassification] of [
    [droppedArm(14700, 150, 100), 'slow_with_drops'], // 1% below the schedule
    [droppedArm(14700, 450, 100), 'slow_with_drops'], // 1% above the schedule
    [droppedArm(14700, 149, 100), null],
    [droppedArm(14700, 451, 100), null], // over 1% above the schedule
    [droppedArm(15151, 1, 100), null],
    [readsDropped, null],
    [{ ...droppedArm(14700, 300, 100), sendSchedule: undefined }, null],
  ] as const) {
    assert.deepEqual(a.validity, validityResult([mismatchReason, dropReason]));
    assert.deepEqual(classifyPair(validArm, a), {
      validity: validityResult([`A: ${mismatchReason}`, `A: ${dropReason}`]), classification: null, diagnosticClassification,
    });
  }
});

test('invalid send schedule counts cannot explain an offered-send mismatch', () => {
  const a = droppedArm(14700, 300, 100);
  for (const [attempted, droppedIterations, scheduledSendAttempts] of [
    [0, 0, 0],
    [-1, 15001, 15000],
    [14700.5, 300, 15000],
    [NaN, 300, 15000],
    [15001, -1, 15000],
    [14700, 300.5, 15000],
    [14700, NaN, 15000],
  ]) {
    const sendSchedule = { attempted, droppedIterations, scheduledSendAttempts };
    assert.deepEqual(classifyPair(validArm, { ...a, sendSchedule }), {
      validity: validityResult([`A: ${mismatchReason}`, `A: ${dropReason}`]), classification: null, diagnosticClassification: null,
    }, `attempted=${attempted}, droppedIterations=${droppedIterations}, scheduledSendAttempts=${scheduledSendAttempts}`);
  }
});

test('any other invalidity reason disqualifies the drop-limited outcome', () => {
  for (const reason of [
    'generator CPU saturated', 'generator reached maxVUs', 'pair-start host load reached 3', 'missing pg_stat_statements',
    'app log: unknown database_failure kind', 'generator exited unsuccessfully', 'incomplete dropped iterations evidence',
    `${mismatchReason} (unverified)`,
  ]) {
    const a = { ...droppedArm(14700, 300, 100), validity: validityResult([dropReason, reason]) };
    assert.deepEqual(classifyPair(validArm, a), {
      validity: validityResult([`A: ${dropReason}`, `A: ${reason}`]), classification: null, diagnosticClassification: null,
    });
  }
});

test('detects pool_stats in the server source of each arm commit', () => {
  // A throwaway repository, so the test does not depend on CI's shallow clone holding old commits.
  const dir = mkdtempSync(join(tmpdir(), 'pool-stats-'));
  try {
    const git = (...args: string[]) => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    };
    git('init', '-q');
    mkdirSync(join(dir, 'server/src'), { recursive: true });
    writeFileSync(join(dir, 'server/src/main.rs'), 'fn main() {}\n');
    git('add', '.'); git('commit', '-q', '-m', 'old');
    const old = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'server/src/pool.rs'), 'const EVENT: &str = "pool_stats";\n');
    git('add', '.'); git('commit', '-q', '-m', 'new');
    const emitting = git('rev-parse', 'HEAD');
    assert.deepEqual(poolStatsCapability(old, dir), { emitsPoolStats: false, poolStats: 'not emitted by this commit' });
    assert.deepEqual(poolStatsCapability(emitting, dir), { emitsPoolStats: true });
    assert.throws(() => poolStatsCapability('no-such-arm-commit', dir), /Unable to determine pool_stats capability/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-#427 arm accepts a quiet log covering the window without pool_stats', () => {
  const log = '1970-01-01T00:00:00.999000000Z listening on 0.0.0.0:8080';
  const read = { startedAt: 71001, uninterrupted: true };
  const evidence = validEvidence();
  evidence.app = diagnosticAppEvidence(log, 1000, 71000, undefined, read);
  assert.deepEqual(diagnosticValidity(evidence), { valid: true, reasons: [] });

  for (const app of [
    diagnosticAppEvidence(log, 1000, 71000, 'app log read failed', read),
    diagnosticAppEvidence(log, 1000, 71000, undefined, { ...read, startedAt: 70999 }),
    diagnosticAppEvidence(log, 1000, 71000, undefined, { ...read, uninterrupted: false }),
    diagnosticAppEvidence(log.replace('00.999', '01.001'), 1000, 71000, undefined, read),
    diagnosticAppEvidence('', 1000, 71000, undefined, read),
  ]) {
    assert.equal(diagnosticValidity({ ...evidence, app }).valid, false);
  }
});

test('post-#427 arm still requires pool_stats', () => {
  const app = diagnosticAppEvidence('listening on 0.0.0.0:8080', 1000, 71000);
  assert.deepEqual(diagnosticValidity({ ...validEvidence(), app }), {
    valid: false, reasons: ['app log: missing pool_stats'],
  });
});

test('structured database failures include the drain and exclude out-of-window events', () => {
  const event = (timestamp: number, kind: string) => JSON.stringify({
    timestamp: new Date(timestamp).toISOString(), target: 'fukulow', level: 'ERROR',
    fields: { event: 'database_failure', kind },
  });
  const log = [event(999, 'io'), event(1000, 'pool_timeout'), event(61001, 'pool_timeout'), event(67000, 'deadline'),
    event(71001, 'database')].join('\n');
  const app = diagnosticAppEvidence(log, 1000, 71000);
  assert.deepEqual(app.databaseFailures, { ...databaseFailures, deadline: 1, pool_timeout: 2 });
  assert.equal(app.complete, false);
  assert.ok(app.reasons.includes('missing pool_stats'));
  const unknown = diagnosticAppEvidence(event(2000, 'unknown'), 1000, 71000);
  assert.ok(unknown.reasons.includes('unknown database_failure kind'));
  assert.deepEqual(unknown.unknownEvents.map(entry => entry.fields), [{ event: 'database_failure', kind: 'unknown' }]);
  const dockerLine = (line: string) => `${JSON.parse(line).timestamp} ${line}`;
  const dockerLog = log.split('\n').map(dockerLine).join('\n');
  const read = { startedAt: 71002, uninterrupted: true };
  const legacyApp = diagnosticAppEvidence(dockerLog, 1000, 71000, undefined, read);
  assert.equal(legacyApp.complete, true);
  assert.deepEqual(legacyApp.databaseFailures, app.databaseFailures);
  const legacyUnknown = diagnosticAppEvidence(`${dockerLog}\n${dockerLine(event(2000, 'unknown'))}`, 1000, 71000, undefined, read);
  assert.deepEqual(legacyUnknown.reasons, ['unknown database_failure kind']);
  assert.deepEqual(legacyUnknown.unknownEvents, unknown.unknownEvents);
  assert.deepEqual(appFailures([{ ...lane('reader', 4), accepted: 0, rejected429: 1, rejected503: 1, clientTimeouts: 1, otherErrors: 1 }], 1, legacyApp), {
    http429: 1, http503: 1, clientTimeouts: 1, clientHttp5xx: 1, serverHttp5xx: 0, databaseFailures: app.databaseFailures,
    transportErrors: 0, otherErrors: 1, panics: 0,
  });
});

test('every app-side failure makes a valid, low-latency A slow and 429 alone stays healthy', () => {
  const legacyRead = { startedAt: 71001, uninterrupted: true };
  const startup = '1970-01-01T00:00:00.999Z listening on 0.0.0.0:8080';
  const event = (fields: object, span?: object) =>
    '1970-01-01T00:01:07.000Z ' + JSON.stringify({ timestamp: '1970-01-01T00:01:07.000Z', target: 'fukulow', fields, span });
  const cases = [
    { outcome: 'rejected429', classification: 'healthy' },
    { outcome: 'rejected503' },
    { outcome: 'clientTimeouts' },
    { outcome: 'transportErrors' },
    { outcome: 'otherErrors' },
    { clientHttp5xx: 1 },
    { log: event({ event: 'http_completed' }, { status: 500 }) },
    { log: event({ event: 'database_failure', kind: 'io' }) },
    { log: '1970-01-01T00:01:07.000Z {"level":"ERROR","target":"fukulow","fields":{"event":"panic"}}' },
    { log: "1970-01-01T00:01:07.000Z thread 'tokio-runtime-worker' (42) panicked at server.rs:1:2:" },
  ] as const;
  const b = { validity: validityResult([]), sendP95Ms: 10, hasAppFailure: false };
  for (const entry of cases) {
    const evidence = validEvidence();
    if ('outcome' in entry) {
      evidence.lanes[3][entry.outcome]++;
      evidence.lanes[3].accepted--;
    }
    evidence.http5xx = 'clientHttp5xx' in entry ? entry.clientHttp5xx : 0;
    evidence.app = diagnosticAppEvidence('log' in entry ? `${startup}\n${entry.log}` : startup, 1000, 71000, undefined, legacyRead);
    const failures = appFailures(evidence.lanes, evidence.http5xx, evidence.app);
    const a = { validity: diagnosticValidity(evidence), sendP95Ms: 15, hasAppFailure: hasAppFailure(failures) };
    assert.deepEqual(a.validity, validityResult([]));
    assert.equal(classifyPair(b, a).classification, 'classification' in entry ? entry.classification : 'slow', JSON.stringify(entry));
  }
  const modern = diagnosticAppEvidence('{"level":"ERROR","target":"fukulow","fields":{"event":"panic"}}', 1000, 71000);
  assert.equal(modern.panics, 1);
});

test('DB wait samples preserve null wait events and count blocked backends separately', () => {
  const activity = {
    connections: 3, active: 2, blocked: 1, states: { active: 2, idle: 1 }, holds: {},
    waits: [
      { state: 'active', waitEventType: 'Lock', waitEvent: 'transactionid', count: 1 },
      { state: 'active', waitEventType: null, waitEvent: null, count: 1 },
      { state: 'idle', waitEventType: 'Client', waitEvent: 'ClientRead', count: 1 },
    ],
  };
  assert.deepEqual(parseActivity(JSON.stringify(activity)), activity);
  const later = { ...activity, blocked: 0 };
  assert.deepEqual(activityWindow([activity, later]).blockedBackends, { mean: 0.5, peak: 1 });
  assert.throws(() => parseActivity(JSON.stringify({ ...activity, waits: [] })), /Incomplete DB wait sample/);
  assert.throws(() => parseActivity(JSON.stringify({ ...activity, blocked: undefined })), /Incomplete DB wait sample/);
});

test('k6 process and gauge probes preserve missing metrics as gaps', () => {
  const stat = '1 (k6 (probe)) S 0 0 0 0 0 0 0 0 0 0 100 50\nVmRSS: 1024 kB';
  const gauge = (value: number) => JSON.stringify({ data: { attributes: { sample: { value } } } });
  const both = generatorStats([stat, gauge(200), gauge(200)].join('\n---\n'));
  assert.deepEqual(both, { cpuTicks: 150, rssKiB: 1024, vus: 200, vus_max: 200 });
  const missing = generatorStats([stat, gauge(199), ''].join('\n---\n'));
  assert.equal(missing.vus_max, null);
  const samples = [{ ...both, at: 1000, cpuPercent: 100 }, { ...missing, at: 2000, cpuPercent: 80 }];
  const oneMissing = generatorWindow({ samples, errors: [] }, 0, 3000, 3200);
  assert.equal(oneMissing.vus_max.samples, 1);
  assert.equal(oneMissing.vus_max.maxSampleGapMs, 2000);
});

test('matching allocation during old-generator VU growth stays valid below the configured cap', () => {
  const belowCap = validEvidence(200, 200);
  assert.equal(belowCap.vusLimit, 3200);
  assert.equal(belowCap.generatorRun.reachedMaxVUs, false);
  assert.deepEqual(diagnosticValidity(belowCap), validityResult([]));
  const atCap = validEvidence(3200, 3200);
  assert.equal(atCap.generatorRun.reachedMaxVUs, true);
  assert.deepEqual(diagnosticValidity(atCap), validityResult(['generator reached maxVUs']));
});
