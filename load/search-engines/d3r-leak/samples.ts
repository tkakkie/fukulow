import assert from 'node:assert/strict';
import { percentile } from '../bench.ts';
import { random } from './design.ts';

export type Sample = {client: number; transaction: number; us: number; warmup: boolean};
export type Block = Sample[];
export class SampleCountError extends Error {}

export function parseBlock(logs: string[], clients: number, measuredPerClient: number): Block {
  const samples: Sample[] = [];
  const counts = Array<number>(clients).fill(0);
  for (const file of logs) for (const line of file.trim().split('\n')) {
    const [client, transaction, us, script, seconds, micros, ...extra] = line.trim().split(/\s+/);
    assert.ok(!extra.length && [client, transaction, us, script, seconds, micros].every(part => /^\d+$/.test(part)) && script === '0', 'pgbench transaction failed or log has unexpected fields');
    const c = Number(client), t = Number(transaction), latency = Number(us);
    assert.ok(c < clients && t === counts[c] + 1 && Number.isSafeInteger(latency), 'Unexpected pgbench client or transaction sequence');
    counts[c] = t;
    samples.push({client: c, transaction: t, us: latency, warmup: t === 1});
  }
  if (!counts.every(count => count === measuredPerClient + 1)) {
    throw new SampleCountError('Wrong sample count after warm-up');
  }
  return samples;
}

const values = (blocks: Block[]) => blocks.map(block => block.filter(sample => !sample.warmup).map(sample => sample.us));

export function armStats(blocks: Block[]) {
  const measured = values(blocks).flat();
  const warmup = blocks.flat().filter(sample => sample.warmup).map(sample => sample.us);
  return {n: measured.length, p50: percentile(measured, .5), p95: percentile(measured, .95),
    warmup: {n: warmup.length, p50: percentile(warmup, .5), max: Math.max(...warmup)}};
}

export function ratios(few: Block[], many: Block[]) {
  const a = armStats(few), b = armStats(many);
  return {p50: b.p50 / a.p50, p95: b.p95 / a.p95, medianDifferenceUs: b.p50 - a.p50};
}

export const bootstrap = {resamples: 10_000, seed: 689_202_611, lower: .025, upper: .975};

function resampling(blocks: Block[]) {
  const measured = values(blocks);
  const distinct = [...new Set(measured.flat())].sort((a, b) => a - b);
  const rank = new Map(distinct.map((value, index) => [value, index]));
  const strata = measured.map(block => block.map(value => rank.get(value)!));
  const n = measured.reduce((sum, block) => sum + block.length, 0);
  const medianRank = Math.ceil(n * .5), tailRank = Math.ceil(n * .95);
  const frequencies = new Uint32Array(distinct.length);
  return (next: () => number) => {
    frequencies.fill(0);
    for (const block of strata) {
      for (let sample = 0; sample < block.length; sample++) frequencies[block[Math.floor(next() * block.length)]]++;
    }
    let count = 0, median: number | undefined;
    for (const [rank, frequency] of frequencies.entries()) {
      count += frequency;
      if (median === undefined && count >= medianRank) median = distinct[rank];
      if (count >= tailRank) return [median!, distinct[rank]];
    }
    throw new Error('No samples for bootstrap');
  };
}

export function confidenceIntervals(few: Block[], many: Block[]) {
  const resampleFew = resampling(few), resampleMany = resampling(many);
  const next = random(bootstrap.seed);
  const p50: number[] = [], p95: number[] = [];
  for (let i = 0; i < bootstrap.resamples; i++) {
    const a = resampleFew(next), b = resampleMany(next);
    p50.push(b[0] / a[0]);
    p95.push(b[1] / a[1]);
  }
  const interval = (samples: number[]) => [percentile(samples, bootstrap.lower), percentile(samples, bootstrap.upper)];
  return {p50: interval(p50), p95: interval(p95)};
}
