import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abba, distribution, judge, type Observation } from './proxy-judgment.ts';
const tls = ['http/1.1', 'h2'].map(alpn => ({ protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', alpn }));
const rows = (c: number[], n: number[]): Observation[] => [...c.map(value => ({ proxy: 'caddy' as const, value })),
  ...n.map(value => ({ proxy: 'nginx' as const, value }))].map(row => ({ ...row, tls, generatorCpu: 20 }));
const five = (n: number) => Array<number>(5).fill(n);
test('ABBA alternates blocks and keeps exactly five runs each', () => {
  assert.deepEqual(abba(5), ['caddy','nginx','nginx','caddy','nginx','caddy','caddy','nginx','caddy','nginx']);
  assert.deepEqual(abba(1), ['caddy', 'nginx']);
});
test('distribution computes spread and even median; zero has finite spread', () => {
  assert.deepEqual(distribution([3,1,2,4]), { min: 1, max: 4, median: 2.5, spread: 1.2 });
  assert.equal(distribution(five(0)).spread, 0);
});
test('latency passes only when every nginx run is within +5% of every Caddy run', () => {
  for (const [n, verdict] of [[105,'pass'],[106,'fail'],[90,'pass']] as const)
    assert.equal(judge(rows(five(100), five(n)), 'latency').verdict, verdict);
});
test('overlap is "no difference detected", never an automatic pass', () => {
  // Medians 100 vs 106 (+6%) with touching ranges: previously an overlap pass.
  const worse = judge(rows([100,100,100,100,104], [104,106,106,106,106]), 'latency');
  assert.equal('difference' in worse && worse.difference, 'no difference detected');
  assert.equal(worse.verdict, 'inconclusive');
  assert.equal(judge(rows([100,101,102,103,104], [104,105,106,107,108]), 'latency').verdict, 'inconclusive');
  assert.equal(judge(rows([100,101,102,103,104], [101,102,103,104,105]), 'latency').verdict, 'pass');
  assert.equal(judge(rows([90,100,100,100,110], five(100)), 'latency').verdict, 'inconclusive');
  assert.equal(judge(rows(five(100), [100,100,100,100,106]), 'latency').verdict, 'inconclusive');
  // Disjoint but within the margin on every run: a detected difference that still passes.
  const slower = judge(rows(five(100), five(104)), 'latency');
  assert.equal('difference' in slower && slower.difference, 'difference');
  assert.equal(slower.verdict, 'pass');
});
test('step metrics pass only when every nginx run reaches every Caddy run', () => {
  for (const [n, verdict] of [[2,'pass'],[1,'fail'],[3,'pass']] as const)
    assert.equal(judge(rows(five(2), five(n)), 'step').verdict, verdict);
  assert.equal(judge(rows([1,2,2,2,2], five(3)), 'step').verdict, 'pass');
  assert.equal(judge(rows([3,3,3,3,4], five(2)), 'step').verdict, 'fail');
  assert.equal(judge(rows(five(2), [2,3,3,3,3]), 'step').verdict, 'pass');
  assert.equal(judge(rows([2,2,2,2,3], five(2)), 'step').verdict, 'inconclusive');
  assert.equal(judge(rows(five(2), [1,2,2,2,2]), 'step').verdict, 'inconclusive');
  // Discrete steps: the 5% spread limit does not apply (spread here is 100% and 50%).
  assert.equal(judge(rows([1,1,1,2,2], [2,2,3,3,3]), 'step').verdict, 'pass');
});
test('invalid runs are excluded: CPU boundary, missing CPU, TLS, missing values, failed runs', () => {
  for (const change of [ { generatorCpu: 90 }, { generatorCpu: null }, { value: NaN }, { error: 'failed' },
    { tls: [] }, { tls: tls.map(t => ({ ...t, protocol: 'TLSv1.2' })) },
    { tls: tls.map(t => ({ ...t, cipher: 'different' })) } ]) {
    const input = rows(five(100), five(100)); Object.assign(input[0], change);
    const result = judge(input, 'latency', true);
    assert.equal(result.verdict, 'inconclusive'); assert.ok(result.invalid.length > 0);
  }
  const input = rows(five(100), five(100)); input[0].generatorCpu = 100;
  assert.equal(judge(input, 'latency').verdict, 'pass');
  input[0].generatorCpu = 89.99;
  assert.equal(judge(input, 'step', true).verdict, 'pass');
});
test('ALPN differences are reported but do not invalidate shipped HTTP version difference', () => {
  const input = rows(five(100), five(100)); input[5].tls = tls.map(t => ({ ...t, alpn: 'http/1.1' }));
  assert.equal(judge(input, 'latency').verdict, 'pass');
  assert.equal(judge(input, 'descriptive').verdict, 'descriptive');
  assert.equal(judge(input.slice(1), 'latency').verdict, 'inconclusive');
});

test('TLS mismatch excludes only the mismatched pair; unchanged pairs retain evidence', () => {
  const input = rows(five(100), five(100));
  input[5].tls = tls.map(t => ({ ...t, cipher: 'different' }));
  const result = judge(input, 'latency');
  assert.deepEqual(result.invalid.map(row => row.index), [0, 5]);
  assert.ok('counts' in result);
  assert.deepEqual(result.counts, { caddy: 4, nginx: 4 });
});
