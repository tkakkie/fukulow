import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { connect, createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Session } from './revocation-burst-db.ts';
import { bindStatement, FALLBACK_MARKER, frame, Framer, gateQuery, RECHECK_MARKER, Relay, rewriteParse } from './revocation-burst-relay.ts';
import { startRssSampler } from './revocation-burst-rss.ts';
import { judge, peaks, percentile, poolWindow, verdictBySize, type Kind, type Run, type RunVerdict } from './revocation-burst-judgment.ts';

const z = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const parseBody = (name: string, query: string) => Buffer.concat([z(name), z(query), Buffer.from([0, 1, 0, 0, 0, 25])]);

test('Session enables psql error stopping and fails when psql exits without the success tag', async t => {
  const session = new Session({ name: 'fk592-test', port: 0, ownerPassword: '', appPassword: '' }, (file, args, options) => {
    assert.equal(file, 'docker');
    assert.deepEqual(args.slice(args.indexOf('-v'), args.indexOf('-v') + 2), ['-v', 'ON_ERROR_STOP=1']);
    assert.deepEqual(args.slice(-2), ['-f', '-']);
    return spawn(process.execPath, ['-e', `
      const input = require('node:readline').createInterface({ input: process.stdin });
      input.on('line', line => {
        if (line === 'SELECT invalid;') process.exit(3);
        const tag = /^SELECT '(fk592-[^']+)';$/.exec(line);
        if (tag) console.log(tag[1]);
      });
    `], options);
  });
  t.after(() => session.close());
  assert.equal(await session.run('SELECT 1;'), true);
  assert.equal(await session.run('SELECT invalid;'), false);
  assert.equal(await session.run('SELECT 1;'), false);
});

test('rewriteParse gates only the recheck statement and keeps parameter types', () => {
  const recheck = `SELECT x FROM unnest($2::uuid[]) ${RECHECK_MARKER} ORDER BY r.n`;
  const out = rewriteParse(parseBody('sqlx_s_7', recheck));
  assert.equal(out.recheck, true);
  assert.equal(out.name, 'sqlx_s_7');
  assert.deepEqual(out.body, parseBody('sqlx_s_7', gateQuery(recheck)));
  const other = parseBody('sqlx_s_8', 'SELECT 1');
  assert.deepEqual(rewriteParse(other), { body: other, name: 'sqlx_s_8', recheck: false, fallback: false });
  const pass = parseBody('sqlx_s_9', `SELECT 1 FROM unnest($1::uuid[]) ${FALLBACK_MARKER}`);
  assert.deepEqual(rewriteParse(pass), { body: pass, name: 'sqlx_s_9', recheck: false, fallback: true });
});

test('bindStatement reads the statement after the portal', () => {
  assert.equal(bindStatement(Buffer.concat([z(''), z('sqlx_s_7'), Buffer.from([0, 0])])), 'sqlx_s_7');
});

test('Framer splits a startup message then typed messages across chunks', () => {
  const startup = Buffer.alloc(8); startup.writeInt32BE(8, 0); startup.writeInt32BE(196608, 4);
  const stream = Buffer.concat([startup, frame(0x50, parseBody('a', 'SELECT 1')), frame(0x53, Buffer.alloc(0))]);
  const seen: (number | null)[] = [];
  const framer = new Framer(true);
  for (let i = 0; i < stream.length; i += 3) framer.push(stream.subarray(i, i + 3), type => seen.push(type));
  assert.deepEqual(seen, [null, 0x50, 0x53]);
});

test('Relay counts recheck and fallback Bind batches but skips Parse/Describe batches', { timeout: 5000 }, async t => {
  const upstream = createServer(socket => {
    const framer = new Framer(true);
    socket.on('data', (chunk: Buffer) => framer.push(chunk, type => {
      if (type === 0x53) socket.write(frame(0x5a, Buffer.from('I')));
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const relay = new Relay({ host: '127.0.0.1', port: (upstream.address() as AddressInfo).port });
  const client = connect(await relay.listen(), '127.0.0.1');
  t.after(async () => {
    client.destroy();
    await relay.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const startup = Buffer.alloc(8); startup.writeInt32BE(8, 0); startup.writeInt32BE(196608, 4);
  const sync = frame(0x53, Buffer.alloc(0));
  const checked = new Promise<void>(resolve => {
    const framer = new Framer(false);
    let ready = 0;
    client.on('data', (chunk: Buffer) => framer.push(chunk, () => { if (++ready === 4) resolve(); }));
  });
  client.write(Buffer.concat([startup, ...[
    ['recheck', RECHECK_MARKER], ['fallback', FALLBACK_MARKER],
  ].flatMap(([name, query]) => [
    frame(0x50, parseBody(name, query)), frame(0x44, Buffer.concat([Buffer.from('S'), z(name)])), sync,
    frame(0x42, Buffer.concat([z(''), z(name), Buffer.alloc(6)])), frame(0x45, Buffer.alloc(5)), sync,
  ])]));
  await checked;
  assert.deepEqual(relay.statements.map(({ recheck, fallback }) => [recheck, fallback]), [
    [false, false], [true, false], [false, false], [false, true],
  ]);
});

for (const trigger of ['cleanup', 'server exit'] as const) {
  test(`RSS sampling stops on ${trigger} and discards an in-flight reading`, async () => {
    const server = new EventEmitter();
    const samples: { at: number; kb: number }[] = [];
    let finishRead!: (kb: number) => void;
    const read = new Promise<number>(resolve => { finishRead = resolve; });
    let readSignal: AbortSignal | undefined;
    let attempts = 0;
    const sampler = startRssSampler(server, signal => { readSignal = signal; attempts++; return read; }, samples);
    assert.equal(attempts, 1);
    if (trigger === 'cleanup') sampler.stop();
    else server.emit('exit');
    assert.equal(readSignal?.aborted, true);
    finishRead(100);
    await sampler.done;
    assert.equal(attempts, 1);
    assert.deepEqual(samples, []);
    assert.equal(server.listenerCount('exit'), 0);
  });
}

test('peaks counts 100 ms buckets and a sliding second', () => {
  assert.deepEqual(peaks([0, 10, 20, 150, 900, 1100]), { bucketPerSecond: 30, slidingSecond: 5 });
  assert.equal(percentile([5, 1, 3, 2, 4], 99), 5);
});

test('poolWindow takes bucket edges from bracketing cumulative samples', () => {
  const sample = (at: number, le100: number, le500: number, total: number, timeout = 0) => ({ at, fields: {
    wait_le_100_us: le100, wait_le_500_us: le500, ...Object.fromEntries([1000, 5000, 10000, 25000, 50000, 100000, 500000, 1000000, 5000000].map(e => [`wait_le_${e}_us`, total])), wait_count: total, acquire_timeout: timeout } });
  const w = poolWindow([sample(0, 10, 10, 10), sample(1000, 100, 108, 110, 2)], 0, 1000);
  assert.ok(w);
  assert.equal(w.p95Ms, 0.5); assert.equal(w.p99Ms, 1); assert.equal(w.timeouts, 2); assert.equal(w.acquisitions, 100);
});

const fixture = (): Run => {
  const statements = [];
  for (let t = 0; t < 40_000; t += 50) statements.push({ at: t, ms: 1, recheck: t % 100 === 0, fallback: false, error: false });
  const probes = (ms: number) => Array.from({ length: 800 }, (_, i) => ({ at: i * 50, ms, ok: true, status: 200 }));
  const counters = { revocation_held: 2, revocation_delivered_after_hold: 1, revocation_retired_fenced: 1, revocation_retired_registration_cap: 0, revocation_retired_global_cap: 0, revocation_retired_timeout: 0, revocation_retired_retries: 0 };
  return {
    kind: 'recheck', size: 2, repeat: 1, times: { pass: 12_300, burst: 11_300, fault: 12_000, mutationsDone: 13_000, recovery: 16_500, end: 40_000 },
    removals: [12_100, 12_200], mutationFailures: 0, statements, connections: [], refused: [],
    dbProbe: probes(1), httpProbe: probes(5), pool: [{ at: 0, fields: { wait_count: 0, acquire_timeout: 0 } }, { at: 39_000, fields: { wait_count: 0, acquire_timeout: 0 } }],
    rss: Array.from({ length: 80 }, (_, i) => ({ at: i * 500, kb: 1000 })), metrics: counters,
    members: [{ channelId: 'one', removeStartedAt: 11_400, removedAt: 12_100, restoredAt: 12_500, resets: [] }, { channelId: 'two', removeStartedAt: 11_500, removedAt: 12_200, resets: [] }],
    revocations: [{ socketIndex: 1, channelId: 'two', at: 17_000 }],
    serverCloses: 0,
  };
};

test('judge passes a reconciled run', () => {
  const verdict = judge(fixture());
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(verdict.reasons, []);
});

const boundaryFixture = () => {
  const run = fixture();
  run.kind = 'outage';
  run.members[1].removedAt = run.times.fault - 153;
  run.removals[1] = run.members[1].removedAt;
  run.metrics!.revocation_delivered_after_hold = 0;
  run.statements.push(
    { at: run.times.fault - 4, ms: 3, recheck: true, fallback: false, error: false },
    { at: run.times.fault - 1, ms: 1, recheck: true, fallback: false, error: false },
    { at: run.times.fault - 0.5, ms: 0.25, recheck: true, fallback: false, error: true },
  );
  return run;
};

test('judge reports the approved 0 and 2 ms boundary arrivals separately from clean passes', () => {
  for (const offset of [0, 2]) {
    const run = boundaryFixture();
    run.revocations[0].at = run.times.fault + offset;
    const result = judge(run);
    assert.equal(result.verdict, 'PASS_WITH_BOUNDARY_EXCEPTION');
    assert.equal(result.pass, false);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.summary.boundaryExceptions, [{
      ...run.revocations[0], arrivalAfterFaultMs: offset, removalConfirmedBeforeFaultMs: 153,
      lastSuccessfulRecheckCompletedBeforeFaultMs: 1,
    }]);
  }
});

const sendTimeFixture = (sendRelativeToFaultMs?: number) => {
  const run = boundaryFixture();
  run.revocations[0].at = run.times.fault + 3;
  const serverAt = run.times.fault - 100 + (sendRelativeToFaultMs ?? 0);
  run.sendTiming = {
    offsetBoundsMs: [99.75, 100.25],
    uncertaintyMs: 0.5,
    records: sendRelativeToFaultMs === undefined ? [] : [
      { channelId: 'two', beforeMs: serverAt - 0.25, afterMs: serverAt + 0.25 },
    ],
  };
  return run;
};

test('a send before the fault passes even when it arrives beyond the old allowance', () => {
  const result = judge(sendTimeFixture(-0.75));
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.summary.boundaryExceptions, []);
  assert.equal(result.summary.sendTiming?.matchedSendRecords, 1);
});

test('a send during the fault fails even when it arrives within the old allowance', () => {
  const run = sendTimeFixture(0.5);
  run.revocations[0].at = run.times.fault + 1;
  const result = judge(run);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.reasons, ['a revocation was sent while the failure was active']);
});

test('a send whose uncertainty interval overlaps the fault fails as indeterminate', () => {
  for (const offset of [-0.5, 0, 0.25]) {
    const run = sendTimeFixture(offset);
    const result = judge(run);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.reasons, ['a revocation send time is indeterminate at fault start']);
    assert.deepEqual(result.summary.sendTiming?.indeterminate, [
      { ...run.revocations[0], sentAt: run.times.fault + offset },
    ]);
  }
});

test('a notice without an unambiguous matching send record fails', () => {
  const missing = sendTimeFixture();
  const ambiguous = sendTimeFixture(-1);
  ambiguous.sendTiming!.records.push(ambiguous.sendTiming!.records[0]);
  for (const run of [missing, ambiguous]) {
    const result = judge(run);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.reasons, ['a revocation has no matching server send record']);
    assert.deepEqual(result.summary.sendTiming?.missingSendRecords, run.revocations);
  }
});

test('a serialized old-format run keeps the original boundary verdict', () => {
  const run = boundaryFixture();
  run.revocations[0].at = run.times.fault + 2;
  const result = judge(JSON.parse(JSON.stringify(run)));
  assert.equal(result.verdict, 'PASS_WITH_BOUNDARY_EXCEPTION');
  assert.equal(result.summary.boundaryExceptions.length, 1);
  assert.equal(Object.hasOwn(result.summary, 'sendTiming'), false);
});

test('judge fails arrivals beyond the bound or without pre-fault removal confirmation', () => {
  for (const [arrivalOffset, removalOffset] of [[2.001, -153], [2, 0], [2, 1]]) {
    const run = boundaryFixture();
    run.revocations[0].at = run.times.fault + arrivalOffset;
    run.members[1].removedAt = run.times.fault + removalOffset;
    run.removals[1] = run.members[1].removedAt;
    const result = judge(run);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.reasons, ['a revocation was delivered while the failure was active']);
    assert.deepEqual(result.summary.boundaryExceptions, []);
  }
});

test('judge requires relay evidence within the removal window and a real fault', () => {
  const run = boundaryFixture();
  run.revocations[0].at = run.times.fault + 1;
  run.kind = 'control';
  const control = judge(run);
  assert.equal(control.verdict, 'FAIL');
  assert.deepEqual(control.reasons, ['a revocation was delivered while the failure was active']);
  assert.deepEqual(control.summary.boundaryExceptions, []);
  run.kind = 'outage';
  const removalStart = run.members[1].removeStartedAt!;
  run.statements = run.statements.filter(s => s.at + s.ms < removalStart ||
    s.error || s.at + s.ms >= run.times.fault);
  const result = judge(run);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.summary.boundaryExceptions, []);
});

test('a boundary arrival does not excuse another correctness violation', () => {
  const run = boundaryFixture();
  run.revocations[0].at = run.times.fault + 1;
  run.revocations.push({ ...run.revocations[0], at: run.times.recovery });
  const result = judge(run);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.reasons, ['duplicate revocation']);
});

test('a boundary arrival on a wrong Channel or a restored registration still fails', () => {
  const wrong = boundaryFixture();
  wrong.revocations[0] = { ...wrong.revocations[0], channelId: 'one', at: wrong.times.fault + 1 };
  const wrongResult = judge(wrong);
  assert.equal(wrongResult.verdict, 'FAIL');
  assert.ok(wrongResult.reasons.includes('a revocation reached a socket or Channel outside the successful removal set'));
  assert.deepEqual(wrongResult.summary.boundaryExceptions, []);
  const restored = boundaryFixture();
  restored.members[1].restoredAt = restored.times.fault - 50;
  restored.revocations[0].at = restored.times.fault + 1;
  const restoredResult = judge(restored);
  assert.equal(restoredResult.verdict, 'FAIL');
  assert.deepEqual(restoredResult.reasons, ['a restored registration received a revocation']);
});

test('judge keeps fault and recovery recheck peaks separate', () => {
  const run = fixture();
  run.statements = [run.times.fault - 1, run.times.fault, run.times.recovery, run.times.recovery + 1]
    .map(at => ({ at, ms: 1, recheck: true, fallback: false, error: false }));
  const { peaks } = judge(run).summary;
  assert.deepEqual(peaks.recheck, { bucketPerSecond: 10, slidingSecond: 1 });
  assert.deepEqual(peaks.recheckRecovery, { bucketPerSecond: 20, slidingSecond: 2 });
  assert.equal(peaks.all.slidingSecond, 2);
});

test('judge fails each correctness violation', () => {
  const during = fixture(); during.revocations[0].at = 14_000;
  assert.ok(judge(during).reasons.includes('a revocation was delivered while the failure was active'));
  const early = fixture(); early.revocations[0].at = 11_450;
  assert.ok(judge(early).reasons.includes('a revocation reached a Member without a successful removal or before it'));
  const restored = fixture(); restored.revocations.push({ socketIndex: 0, channelId: 'one', at: 17_100 });
  assert.ok(judge(restored).reasons.includes('a restored registration received a revocation'));
  const duplicate = fixture(); duplicate.revocations.push({ ...duplicate.revocations[0], at: 17_100 });
  assert.ok(judge(duplicate).reasons.includes('duplicate revocation'));
  const unseen = fixture(); unseen.revocations = [];
  assert.ok(judge(unseen).reasons.some(r => r.startsWith('delivered_after_hold 1 > client revocations after recovery 0')));
  const overcounted = fixture(); overcounted.metrics!.revocation_retired_fenced = 2;
  assert.ok(judge(overcounted).reasons.some(r => r.startsWith('held 2 < delivered 1 + ended 2')));
  const missing = fixture(); missing.metrics = undefined;
  assert.ok(judge(missing).reasons.includes('no metrics event after the holds resolved'));
  const lost = fixture(); lost.revocations = []; lost.metrics!.revocation_delivered_after_hold = 0;
  assert.deepEqual(judge(lost).reasons, [], 'a lost notice is recovered by REST reconciliation, not a failure');
  assert.equal(judge(lost).summary.notices.lostWithoutNotice, 1);
});

test('judge fails revocations to untracked sockets and wrong Channels', () => {
  for (const [socketIndex, channelId] of [[2, 'two'], [1, 'one'], [1, null]] as const) {
    const run = fixture();
    run.size = 3;
    run.revocations.push({ socketIndex, channelId, at: 17_100 });
    const verdict = judge(run);
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.reasons, ['a revocation reached a socket or Channel outside the successful removal set']);
    assert.equal(verdict.summary.notices.receivedAfterRecovery, 1);
  }
});

test('judge fails a matching revocation when the removal did not succeed', () => {
  const run = fixture();
  delete run.members[1].removedAt;
  const verdict = judge(run);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.reasons, ['a revocation reached a Member without a successful removal or before it']);
});

test('judge fails each recovery violation', () => {
  const late = fixture(); late.revocations[0].at = 27_000;
  assert.ok(judge(late).reasons.includes('a revocation arrived after the drain limit'));
  const slowDb = fixture(); slowDb.dbProbe = slowDb.dbProbe.map(p => p.at >= 16_500 ? { ...p, ms: 40 } : p);
  assert.ok(judge(slowDb).reasons.some(r => r.startsWith('database probe p99')));
  const http = fixture(); http.httpProbe = http.httpProbe.map(p => p.at >= 18_000 && p.at < 18_200 ? { ...p, ok: false, status: 503 } : p);
  assert.ok(judge(http).reasons.some(r => r.includes('HTTP probe failures')));
  const noRecovery = fixture(); noRecovery.httpProbe = noRecovery.httpProbe.map(p => p.at >= 16_500 && p.at < 22_000 ? { ...p, ok: false, status: 503 } : p);
  assert.ok(judge(noRecovery).reasons.includes('no successful HTTP probe within the first-success limit'));
  const pool = fixture(); pool.pool = [{ at: 16_000, fields: { acquire_timeout: 0 } }, { at: 27_000, fields: { acquire_timeout: 3 } }];
  assert.ok(judge(pool).reasons.includes('3 pool acquire timeouts after recovery'));
});

test('judge fails when the recovery pool timeout measurement is unavailable', () => {
  const first = { at: 16_000, fields: { acquire_timeout: 0 } };
  const last = { at: 27_000, fields: { acquire_timeout: 0 } };
  for (const samples of [[], [first], [first, { ...last, at: first.at }], [first, { ...last, fields: {} }]]) {
    const run = fixture();
    run.pool = samples;
    const verdict = judge(run);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.summary.pool.recovery, null);
    assert.deepEqual(verdict.reasons, ['pool acquire timeouts unavailable in the recovery window']);
  }
});

test('verdictBySize needs every repeat of both kinds', () => {
  const pass = (kind: Kind, size: number) => ({ kind, size, verdict: 'PASS' as RunVerdict });
  const all = [256, 1024, 4096].flatMap(size => [1, 2, 3].flatMap(() => [pass('recheck', size), pass('outage', size)]));
  assert.deepEqual(verdictBySize(all), { 256: 'PASS', 1024: 'PASS', 4096: 'PASS' });
  assert.deepEqual(verdictBySize(all.slice(1)), { 256: 'NOT EVALUATED', 1024: 'PASS', 4096: 'PASS' });
  all[0].verdict = 'PASS_WITH_BOUNDARY_EXCEPTION';
  assert.equal(verdictBySize(all)[256], 'PASS_WITH_BOUNDARY_EXCEPTION');
  assert.equal(verdictBySize(all.slice(0, 1))[256], 'NOT EVALUATED');
  assert.equal(verdictBySize([...all, { kind: 'outage', size: 256, verdict: 'FAIL' }])[256], 'FAIL');
});
