import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderFor, senderIndex, socketStop, peerWatched, regularPairs, percentile, outsideCheckout } from './dms-workload.ts';

test('2,000 consecutive sends use distinct senders and 1,000 reciprocal pairs', () => {
  const senders = Array.from({ length: 2000 }, (_, i) => senderFor(i));
  assert.equal(new Set(senders).size, 2000);
  assert.equal(new Set(senders.map(i => Math.floor(i / 2))).size, 1000);
  assert.equal(senderFor(2000), 0);
  assert.throws(() => senderFor(-1));
});
test('summary preserves tails and handles empty probes', () => {
  assert.equal(percentile([], .99), null);
  assert.equal(percentile([3, 1, 2, 100], .99), 100);
  assert.equal(percentile([3, 1, 2, 100], .5), 2);
});
test('sharded senders are distinct and their peers lie on their socket shard', () => {
  const ids = Array.from({ length: 4 }, (_, shard) => Array.from({ length: 500 }, (_, i) => senderIndex(i, shard, 10000))).flat();
  assert.equal(new Set(ids).size, 2000);
  assert.equal(new Set(ids.map(i => Math.floor(i/2))).size, 1000);
  for (const i of ids) assert.equal(Math.floor((i^1)/2500), Math.floor(i/2500));
});
test('sockets outlive offered sends and drain', () => {
  assert.equal(socketStop(0, 13000, 40, 95, 500), 145000);
  assert.equal(socketStop(0, 160000, 40, 95, 500), 160000);
  assert.equal(socketStop(0, 13000, 40, 95, 0), 108000);
});
test('formal fixture has 50,000 distinct pairs and exactly 100 DMs for every Member per Organization', () => {
  const pairs = regularPairs(1000,100), counts = Array<number>(1000).fill(0);
  assert.equal(pairs.length, 50000);
  assert.equal(new Set(pairs.map(p => p.join(':'))).size, 50000);
  for (const [a,b] of pairs) { assert.ok(a<b); counts[a]++; counts[b]++; }
  assert.ok(counts.every(n => n === 100));
  assert.throws(() => regularPairs(1000,1000));
});
test('raw artifacts cannot be written inside checkout', () => {
  assert.equal(outsideCheckout('/repo/out', '/repo'), false);
  assert.equal(outsideCheckout('/repo', '/repo'), false);
  assert.equal(outsideCheckout('/repo-other/out', '/repo'), true);
});

test('peer expectations include only watched sockets in this staged-load shard', () => {
  assert.equal(peerWatched(0, 0, 250), true);
  assert.equal(peerWatched(1, 0, 250), false);
  assert.equal(peerWatched(250, 0, 250), false);
  assert.equal(peerWatched(2500, 2500, 500), true);
  assert.equal(peerWatched(2498, 2500, 500), false);
  for (const sockets of [250,500,1250,2500]) {
    const expected = Array.from({length:500}, (_,i)=>peerWatched(i,0,sockets)).filter(Boolean).length;
    assert.equal(expected, Math.min(sockets,500)/2);
  }
});
