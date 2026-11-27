import test from 'node:test';
import assert from 'node:assert/strict';
import { report } from './signin-owner-burst-report.ts';
import { run, setMs } from './signin-owner-burst-fixture.ts';

test('per-burst report carries the sampler peaks and the owner operation offset', () => {
  const r = report(run());
  assert.deepEqual(r.bursts.map(b => [b.sampler.peakWaiters, b.sampler.peakConnections, b.sampler.waitingShareAtPeak, b.ownerOp?.afterAdmittedSendMs]),
    [[2, 7, 2 / 7, 13], [2, 7, 2 / 7, 13], [2, 7, 2 / 7, 13]]);
});

test('report: per-burst pool timeouts and waits over 1 s', () => {
  const r = run();
  r.server.burstPoolTimeouts = [0, 2, null];
  r.waits[3] = { ...r.waits[3], waitedMs: 1_200 };
  setMs(r.attack.find(a => a.burst === 3 && a.status === 401)!, 1_500);
  const bursts = report(r).bursts;
  assert.deepEqual(bursts.map(b => [b.poolTimeouts, b.lockLog.over1s, b.operationsOver1s]), [[0, 0, 0], [2, 1, 0], [null, 0, 1]]);
});
