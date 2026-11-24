import assert from 'node:assert/strict';
import test from 'node:test';
import { attribution, g95, minimums, noise, ownReasons, reproduction, spearman, stage1, stage2, type Measurement } from './judge.ts';
import { sequence, type MeasuredStep } from './plan.ts';

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// Three accepted (index) queries and one short query; every accepted query gets the same p95, so G95 = g.
const queries = ['q1', 'q2', 'q3'];
const steps = new Map([...sequence('1'), ...sequence('2')].filter((s): s is MeasuredStep => s.kind !== 'idle' && s.kind !== 'scan').map(s => [s.id, s]));

function m(id: string, g: number, over: Partial<Measurement> = {}): Measurement {
  const s = steps.get(id)!;
  const order = over.order ?? s.order;
  const names = order === 'F' ? [...queries, 'scalar'] : ['scalar', ...[...queries].reverse()];
  return {id, kind: s.kind, arm: s.arm, order, settle: s.kind === 'copy' && s.settle,
    latencies: names.map(query => ({query, p95: query === 'scalar' ? 1 : g})),
    plans: queries.map(query => ({query, shapeHash: 'same', buffers: 100})), sharedReads: 0,
    env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []},
    invalid: [], ...over};
}

// A rising A1, no recovery after the cool-down, flat D, steady hot measurements, restart-only slower.
function scenario(values: Partial<Record<string, number>> = {}, over: Record<string, Partial<Measurement>> = {}) {
  const g: Record<string, number> = {'A1.1': 40, 'A1.2': 44, 'A1.3': 48, 'A1.4': 50, 'A1.5': 53, 'A1.6': 56, 'A2.1': 56, 'A2.2': 56,
    'C1.warm': 40, 'C1.hot1': 40, 'C1.hot2': 40, 'C1.restart': 60, 'D.current1': 50, 'D.settle1': 50, 'D.current2': 50, 'D.settle2': 50,
    'C2.warm': 40, 'C2.hot1': 40, 'C2.hot2': 40, 'C2.restart': 60};
  Object.assign(g, values);
  return Object.entries(g).map(([id, v]) => m(id, v, over[id]));
}
const invalid = {invalid: ['fake']};

test('G95 is the geometric mean over accepted queries only; a missing p95 gives null', () => {
  const x = m('A1.1', 1);
  x.latencies = [{query: 'q1', p95: 10}, {query: 'q2', p95: 40}, {query: 'scalar', p95: 1000}];
  near(g95(x), 20);
  x.latencies.push({query: 'q3', error: 'x'});
  assert.equal(g95(x), null);
});

test('Spearman uses average ranks and is null for a constant series', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 2, 3], [5, 5, 5]), null);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 2, 2, 3])! - 0.9487) < 1e-3);
});

test('own INVALID reasons: a failed query, a short sample and load15 above 3', () => {
  const full = {query: 'q1', n: 100, p50: 1, p95: 1, p99: 1, tps: 1, wallMs: 1};
  assert.deepEqual(ownReasons([{query: 'q1', sample: full}], 3), []);
  assert.deepEqual(ownReasons([{query: 'q1', sample: {...full, n: 99}}], 1), ['q1 not fully sampled']);
  assert.deepEqual(ownReasons([{query: 'q1', error: 'pgbench failed'}], 1), ['q1 failed: pgbench failed']);
  assert.deepEqual(ownReasons([{query: 'q1', sample: full}], 3.01), ['load15 3.01 > 3 at start']);
  assert.deepEqual(ownReasons([{query: 'scalar', sample: {...full, query: 'scalar', outcomes: ['x']}}], 1), ['scalar not fully sampled']);
});

test('N is the largest hot1/hot2 spread (at least 1.05), else the A1 spread reported as a fallback', () => {
  assert.deepEqual(noise(scenario()), {value: 1.05, source: 'C hot1/hot2'});
  near(noise(scenario({'C2.hot2': 44})).value, 1.1);
  const fallback = noise(scenario({}, {'C2.restart': invalid}));
  assert.equal(fallback.source, 'A1 spread (fallback)');
  near(fallback.value, 56 / 40);
});

test('reproduction needs r >= 1.30, rho >= 0.8 and r - 1 >= 3(N - 1); r < 1.15 is not reproduced', () => {
  assert.equal(reproduction(scenario(), 1.05).result, 'reproduced');
  assert.equal(reproduction(scenario(), 1.2).result, 'inconclusive');
  assert.equal(reproduction(scenario({'A1.6': 50}), 1.05).result, 'inconclusive');
  assert.equal(reproduction(scenario({'A1.2': 60, 'A1.3': 41, 'A1.4': 59, 'A1.5': 42}), 1.05).result, 'inconclusive');
  const flat = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`A1.${i}`, 40 + i * 0.5]));
  assert.equal(reproduction(scenario(flat), 1.05).result, 'not reproduced');
});

test('first and last use the first valid of A1.1-A1.2 and the last valid of A1.5-A1.6', () => {
  near(reproduction(scenario({}, {'A1.1': invalid}), 1.05).r, 56 / 44);
  near(reproduction(scenario({}, {'A1.6': invalid}), 1.05).r, 53 / 40);
});

test('the A1 minimum: 5 of 6 valid, one of A1.1-A1.2 and one of A1.5-A1.6; otherwise inconclusive', () => {
  assert.equal(minimums(scenario({}, {'A1.3': invalid})).A1, true);
  assert.equal(minimums(scenario({}, {'A1.3': invalid, 'A1.4': invalid})).A1, false);
  assert.equal(minimums(scenario({}, {'A1.1': invalid, 'A1.2': invalid})).A1, false);
  const r = stage1(scenario({}, {'A1.5': invalid, 'A1.6': invalid}));
  assert.equal(r.outcome, 'inconclusive');
  assert.equal(r.attribution, null);
  assert.equal(r.stage2, 'propose');
});

test('cause established: exactly one supported, all others ruled out; Stage 2 may be skipped', () => {
  const r = stage1(scenario());
  assert.deepEqual(r.attribution, {H1: 'supported', H2: 'ruled out', H3: 'ruled out', H4: 'ruled out', H5: 'ruled out', H6: 'ruled out'});
  assert.equal(r.outcome, 'cause established');
  assert.equal(r.stage2, 'may be skipped');
});

test('all of H1-H5 ruled out is "repetition-linked, cause not established"', () => {
  const r = stage1(scenario({'C1.restart': 40, 'C2.restart': 40}));
  assert.equal(r.attribution!.H1, 'ruled out');
  assert.equal(r.outcome, 'cause not established');
  assert.equal(r.repetitionLinked, true);
  assert.equal(r.stage2, 'propose');
});

test('a hypothesis whose minimum is not met is withheld, and the cause is then not established', () => {
  const h2 = stage1(scenario({}, {'A2.1': invalid}));
  assert.equal(h2.attribution!.H2, 'withheld');
  assert.equal(h2.outcome, 'cause not established');
  const h45 = attribution(scenario({}, {'D.settle1': invalid}), 1.05);
  assert.equal(h45.H4, 'withheld');
  assert.equal(h45.H5, 'withheld');
  assert.equal(attribution(scenario({}, {'A1.4': {plans: null}}), 1.05).H3, 'withheld');
  // Without both cache replicates, H1 is withheld and N falls back to the A1 spread.
  const h1 = stage1(scenario({}, {'C1.hot2': invalid}));
  assert.equal(h1.noise.source, 'A1 spread (fallback)');
  assert.equal(h1.outcome, 'inconclusive');
  assert.equal(attribution(scenario({}, {'C1.hot2': invalid}), 1.05).H1, 'withheld');
});

test('both replicates must agree: one slow restart-only alone withholds H1', () => {
  assert.equal(attribution(scenario({'C2.restart': 40}), 1.05).H1, 'withheld');
});

test('H1 is supported by shared reads in every A1 round above the median', () => {
  const reads = Object.fromEntries(['A1.4', 'A1.5', 'A1.6'].map(id => [id, {sharedReads: 10}]));
  assert.equal(attribution(scenario({'C1.restart': 40, 'C2.restart': 40}, reads), 1.05).H1, 'supported');
  assert.equal(attribution(scenario({'C1.restart': 40, 'C2.restart': 40}, {'A1.6': {sharedReads: 10}}), 1.05).H1, 'withheld');
});

test('H2 is supported by recovery after the cool-down that tracks temperature', () => {
  const temps: Record<string, Partial<Measurement>> = {};
  const g = {'A2.1': 41, 'A2.2': 42};
  for (const x of scenario(g)) if (x.kind === 'copy') temps[x.id] = {env: {...x.env, meanTemperatureC: g95(x)!, meanFrequencyKHz: null}};
  assert.equal(attribution(scenario(g, temps), 1.05).H2, 'supported');
  assert.equal(attribution(scenario(g), 1.05).H2, 'withheld');
});

test('H2 is ruled out by a flat temperature and frequency while A1 rose', () => {
  const flat: Record<string, Partial<Measurement>> = {};
  for (const x of scenario({'A2.1': 41, 'A2.2': 42})) flat[x.id] = {env: {...x.env, meanTemperatureC: 60 + (x.id === 'A1.6' ? 4 : 0), meanFrequencyKHz: 5_000_000}};
  assert.equal(attribution(scenario({'A2.1': 41, 'A2.2': 42}, flat), 1.05).H2, 'ruled out');
});

test('H3 is supported by a plan change for a query that rose; a change in a flat query only withholds it', () => {
  const changed = {'A1.6': {plans: queries.map(query => ({query, shapeHash: query === 'q1' ? 'other' : 'same', buffers: 100}))}};
  assert.equal(attribution(scenario({}, changed), 1.05).H3, 'supported');
  const buffers = {'A1.3': {plans: queries.map(query => ({query, shapeHash: 'same', buffers: query === 'q2' ? 111 : 100}))}};
  assert.equal(attribution(scenario({}, buffers), 1.05).H3, 'supported');
  const flat = m('A1.6', 56);
  flat.latencies = flat.latencies.map(l => l.query === 'q1' ? {...l, p95: 40} : l);
  const ms = scenario({}, changed).map(x => x.id === 'A1.6' ? {...flat, plans: changed['A1.6'].plans} : x);
  assert.equal(attribution(ms, 1.05).H3, 'withheld');
});

test('H4 needs settle/current <= 0.80 in both pairs and dirty memory at the start of the current rounds', () => {
  const g = {'D.settle1': 39, 'D.settle2': 39};
  const dirty = {'D.current1': {env: {dirtyWritebackAtStartBytes: 100 * 1024 ** 2, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []}},
    'D.current2': {env: {dirtyWritebackAtStartBytes: 100 * 1024 ** 2, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []}}};
  assert.equal(attribution(scenario(g, dirty), 1.05).H4, 'supported');
  assert.equal(attribution(scenario(g), 1.05).H4, 'withheld');
  assert.equal(attribution(scenario({'D.settle1': 39}, dirty), 1.05).H4, 'withheld');
});

test('H5: an autovacuum worker over a slow block supports it; any overlap stops it being ruled out', () => {
  const env = (q: string[]) => ({env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: q}});
  assert.equal(attribution(scenario({}, {'A1.6': env(['q2'])}), 1.05).H5, 'supported');
  assert.equal(attribution(scenario({}, {'A1.1': env(['q2'])}), 1.05).H5, 'withheld');
});

test('H6: a rise that follows the position in the round, in F and in R rounds, supports it', () => {
  // Later positions rise more in both orders: q3 most in F rounds, q1 most in R rounds.
  const position = (id: string, base: number, factor: number) => {
    const x = m(id, base);
    x.latencies = x.latencies.map((l, i) => l.query === 'scalar' ? l : {...l, p95: base * (1 + factor * i)});
    return x;
  };
  const ms = scenario().map(x => x.id === 'A1.5' ? position('A1.5', 53, 0.2) : x.id === 'A1.6' ? position('A1.6', 56, 0.2) : x);
  assert.equal(attribution(ms, 1.05).H6, 'supported');
});

test('Stage 2: reproduced, not reproduced, and its minimum', () => {
  const b = (g: Record<string, number>, over: Record<string, Partial<Measurement>> = {}) => Object.entries({'B.pre': 40, 'B.post1': 56,
    'B.post2': 56, 'B.post3': 56, 'B.cool1': 50, 'B.cool2': 50, ...g}).map(([id, v]) => m(id, v, over[id]));
  assert.equal(stage2(b({}), 1.05).result, 'reproduced');
  assert.equal(stage2(b({}), 1.2).result, 'inconclusive');
  assert.equal(stage2(b({'B.post1': 44}), 1.05).result, 'not reproduced');
  near(stage2(b({}, {'B.post1': invalid}), 1.05).ratio, 56 / 40);
  assert.equal(stage2(b({}, {'B.post1': invalid, 'B.post2': invalid}), 1.05).result, 'inconclusive');
  assert.equal(stage2(b({}, {'B.cool2': invalid}), 1.05).result, 'inconclusive');
  assert.equal(stage2(b({}, {'B.pre': invalid}), 1.05).result, 'inconclusive');
});
