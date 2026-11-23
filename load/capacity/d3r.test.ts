import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GiB, hostStore, judge, margin, needs, rehearsalFigures, type Figures } from './d3r.ts';

const f: Figures = {archiveBytes: 60 * GiB, vmRoundPeak: 70 * GiB, vmRoundGrowth: 1 * GiB, roundOutputBytes: 4 * 1024 ** 2, formalRounds: 3};
const disk = (free: number, used = 0) => ({free, used});

test('the margin is 20% of the need and at least 20 GiB', () => {
  assert.equal(margin(10 * GiB), 20 * GiB);
  assert.equal(margin(200 * GiB), 40 * GiB);
});

test('paths on one device share one store: one free value, needs summed once', () => {
  const {ids, stores} = hostStore(['/out', '/docker.raw', '/backfill'], p => (p === '/backfill' ? '2' : '1'),
    p => (p === '/backfill' ? 5 : 9) * GiB);
  assert.deepEqual(ids, ['host:1', 'host:1', 'host:2']);
  assert.deepEqual(stores.map(s => [s.id, s.paths, s.free]), [['host:1', ['/out', '/docker.raw'], 9 * GiB], ['host:2', ['/backfill'], 5 * GiB]]);
});

test('formal on Docker Desktop: the VM need lands on the VM disk and on the host disk image, the staged archive on the output store', () => {
  const list = needs('formal', f, {output: 'host:1', dockerHost: 'host:1', vm: 'docker-vm'}, GiB);
  const cluster = (60 + 70 + 3) * GiB;
  const image = (60 + 3 * 71) * GiB; // the host image pays the round peak every round
  assert.deepEqual(list.map(n => [n.store, n.bytes]), [['host:1', 60 * GiB], ['host:1', 12 * 1024 ** 2], ['docker-vm', cluster], ['host:1', image]]);
  // One shared host store: its free value is compared once with the sum of everything written to it.
  const shared = judge([{id: 'host:1', kind: 'host', paths: [], free: 350 * GiB}, {id: 'docker-vm', kind: 'docker-vm', paths: [], free: 900 * GiB}], list);
  const row = shared.stores[0];
  assert.equal(row.need, 60 * GiB + 12 * 1024 ** 2 + image);
  assert.equal(row.ok, 350 * GiB >= row.need + margin(row.need));
  assert.equal(shared.ok, false);
  const roomy = judge([{id: 'host:1', kind: 'host', paths: [], free: 500 * GiB}, {id: 'docker-vm', kind: 'docker-vm', paths: [], free: 900 * GiB}], list);
  assert.equal(roomy.ok, true);
});

test('native Docker: the cluster is counted once, on the Docker root store', () => {
  const list = needs('formal', f, {output: 'host:1', dockerHost: 'host:2'}, GiB);
  assert.deepEqual(list.map(n => n.store), ['host:1', 'host:1', 'host:2']);
  const backfill = needs('backfill-only', f, {output: 'host:1', dockerHost: 'host:1'}, GiB);
  assert.deepEqual(backfill.map(n => [n.store, n.bytes]), [['host:1', 60 * GiB], ['host:1', 121 * GiB]]);
});

test('STOP when any store is short, and when a need has no measured store', () => {
  const list = needs('backfill-only', f, {output: 'host:1', dockerHost: 'host:2', vm: 'docker-vm'}, GiB);
  const stores = (vmFree: number) => [{id: 'host:1', kind: 'host' as const, paths: [], free: 100 * GiB},
    {id: 'host:2', kind: 'host' as const, paths: [], free: 500 * GiB}, {id: 'docker-vm', kind: 'docker-vm' as const, paths: [], free: vmFree}];
  assert.equal(judge(stores(500 * GiB), list).ok, true);
  assert.equal(judge(stores(130 * GiB), list).ok, false);
  assert.throws(() => judge(stores(500 * GiB).slice(0, 2), list));
});

test('rehearsal figures come only from a valid one-round record with Docker samples', () => {
  const samples = [{at: 'start', docker: disk(700 * GiB), output: disk(1)}, {at: 'mid', docker: disk(630 * GiB), output: disk(1)},
    {at: 'end', docker: disk(699 * GiB), output: disk(1)}];
  const headroom = {ok: true, problems: [], rehearsalRounds: 1, formalRounds: 3, samples, projection: {docker: {roundGrowth: GiB}}};
  assert.deepEqual(rehearsalFigures({snapshot: {bytes: 60 * GiB}}, headroom, 5),
    {archiveBytes: 60 * GiB, vmRoundPeak: 70 * GiB, vmRoundGrowth: GiB, roundOutputBytes: 5, formalRounds: 3});
  assert.throws(() => rehearsalFigures({snapshot: {bytes: 60 * GiB}}, {...headroom, ok: false}, 5));
  assert.throws(() => rehearsalFigures({snapshot: {bytes: 60 * GiB}}, {...headroom, samples: samples.slice(0, 1)}, 5));
  assert.throws(() => rehearsalFigures({snapshot: {bytes: 60 * GiB}}, {...headroom, samples: [{at: 'x'}, {at: 'y'}]}, 5));
  assert.throws(() => rehearsalFigures({snapshot: {}}, headroom, 5));
});
