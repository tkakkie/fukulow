import assert from 'node:assert/strict';
import test from 'node:test';
import { attribution, cacheConstraint, evidence, fillPlans, g95, minimums, noise, noiseSpreads, ownReasons, reproduction, smoke, spearman, stage1, stage2, type Measurement, type Plan } from './judge.ts';
import { sequence, type MeasuredStep } from './plan.ts';
import { rational, ratio } from './exact.ts';

const why = (x: object) => (x as {reason?: string; inconclusiveReason?: string});
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// Three accepted (index) queries and one short query; every accepted query gets the same p95, so G95 = g.
const queries = ['q1', 'q2', 'q3'];
const steps = new Map([...sequence('1'), ...sequence('2')].filter((s): s is MeasuredStep => s.kind !== 'idle' && s.kind !== 'scan').map(s => [s.id, s]));

const plans = (over: (q: string) => Partial<Plan> = () => ({})): Plan[] =>
  queries.map(query => ({query, shapeHash: 'same', buffers: 100, sharedHit: 100, sharedRead: 0, ...over(query)}) as Plan);

function m(id: string, g: number, over: Partial<Measurement> = {}): Measurement {
  const s = steps.get(id)!;
  const order = over.order ?? s.order;
  const names = order === 'F' ? [...queries, 'scalar'] : ['scalar', ...[...queries].reverse()];
  return {id, kind: s.kind, arm: s.arm, order, settle: s.kind === 'copy' && s.settle,
    latencies: names.map(query => ({query, p95: query === 'scalar' ? 1 : g})),
    plans: plans(), sharedReads: 0,
    env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []},
    invalid: [], missingEvidence: [], samplerChecked: true, ...over};
}

// A rising A1, no recovery after the cool-down, flat D, steady hot measurements, restart-only 3.25x warm
// (beyond 3 x N at N = 1.05, §4.3 as written).
function scenario(values: Partial<Record<string, number>> = {}, over: Record<string, Partial<Measurement>> = {}) {
  const g: Record<string, number> = {'A1.1': 40, 'A1.2': 44, 'A1.3': 48, 'A1.4': 50, 'A1.5': 53, 'A1.6': 56, 'A2.1': 56, 'A2.2': 56,
    'C1.warm': 40, 'C1.hot1': 40, 'C1.hot2': 40, 'C1.restart': 130, 'D.current1': 50, 'D.settle1': 50, 'D.current2': 50, 'D.settle2': 50,
    'C2.warm': 40, 'C2.hot1': 40, 'C2.hot2': 40, 'C2.restart': 130};
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
  assert.equal(r.outcome, 'repetition-linked, cause not established');
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

test('H1 support needs restart-only / warm >= 1.25 and >= 3 x N (§4.3 as written), not only beyond the noise', () => {
  assert.equal(attribution(scenario({'C1.restart': 125, 'C2.restart': 125}), 1.05).H1, 'withheld');
  assert.equal(attribution(scenario({'C1.restart': 127, 'C2.restart': 127}), 1.05).H1, 'supported');
  assert.equal(attribution(scenario({'C1.restart': 80, 'C2.restart': 80}), 1.05).H1, 'withheld');
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
  const changed = {'A1.6': {plans: plans(q => ({shapeHash: q === 'q1' ? 'other' : 'same'}))}};
  assert.equal(attribution(scenario({}, changed), 1.05).H3, 'supported');
  const buffers = {'A1.3': {plans: plans(q => ({sharedHit: q === 'q2' ? 111 : 100}))}};
  assert.equal(attribution(scenario({}, buffers), 1.05).H3, 'supported');
  // 10% exactly is not a change.
  assert.equal(attribution(scenario({}, {'A1.3': {plans: plans(q => ({sharedHit: q === 'q2' ? 110 : 100}))}}), 1.05).H3, 'ruled out');
  // Hits and reads are compared on their own: 100/0 -> 80/20 keeps the sum but is a change.
  const split = {'A1.6': {plans: plans(q => q === 'q1' ? {sharedHit: 80, sharedRead: 20} : {})}};
  assert.equal(attribution(scenario({}, split), 1.05).H3, 'supported');
  const flat = m('A1.6', 56);
  flat.latencies = flat.latencies.map(l => l.query === 'q1' ? {...l, p95: 40} : l);
  const ms = scenario({}, changed).map(x => x.id === 'A1.6' ? {...flat, plans: changed['A1.6'].plans} : x);
  assert.equal(attribution(ms, 1.05).H3, 'withheld');
});

test('H3 is withheld when an A1 plan is missing or its EXPLAIN failed, never read as a change', () => {
  const missing = {'A1.4': {plans: plans().filter(p => p.query !== 'q2')}};
  assert.equal(minimums(scenario({}, missing)).H3, false);
  assert.equal(attribution(scenario({}, missing), 1.05).H3, 'withheld');
  const failed = {'A1.4': {plans: plans().map(p => p.query === 'q2' ? {query: 'q2', error: 'timeout'} : p)}};
  assert.equal(attribution(scenario({}, failed), 1.05).H3, 'withheld');
});

test('H4 needs settle/current <= 0.80 in both pairs and dirty memory at the start of the current rounds', () => {
  const g = {'D.settle1': 39, 'D.settle2': 39};
  const dirty = {'D.current1': {env: {dirtyWritebackAtStartBytes: 100 * 1024 ** 2, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []}},
    'D.current2': {env: {dirtyWritebackAtStartBytes: 100 * 1024 ** 2, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []}}};
  assert.equal(attribution(scenario(g, dirty), 1.05).H4, 'supported');
  assert.equal(attribution(scenario(g), 1.05).H4, 'withheld');
  assert.equal(attribution(scenario({'D.settle1': 39}, dirty), 1.05).H4, 'withheld');
});

test('H2 also needs the A1 minimum; the cache minimum needs every one of warm, hot 1, hot 2 and restart-only', () => {
  const noA1 = {'A1.1': invalid, 'A1.2': invalid};
  assert.equal(minimums(scenario({}, noA1)).A1, false);
  assert.equal(minimums(scenario({}, noA1)).H2, false);
  assert.equal(minimums(scenario()).H2, true);
  for (const id of ['C1.warm', 'C1.hot1', 'C2.warm', 'C2.hot1', 'C2.hot2', 'C2.restart']) {
    assert.equal(minimums(scenario({}, {[id]: invalid})).H1, false, id);
  }
  assert.equal(minimums(scenario()).H1, true);
});

test('the H4/H5 minimum needs both current rounds and both settle rounds; H2 needs both A2 rounds', () => {
  assert.equal(minimums(scenario({}, {'D.current2': invalid})).H45, false);
  assert.equal(attribution(scenario({}, {'D.current1': invalid}), 1.05).H4, 'withheld');
  assert.equal(minimums(scenario({}, {'A2.2': invalid})).H2, false);
  assert.equal(attribution(scenario({}, {'A2.2': invalid}), 1.05).H2, 'withheld');
});

test('H5: an autovacuum worker over a slow block supports it; any overlap stops it being ruled out', () => {
  const env = (q: string[], inside = q) => ({env: {dirtyWritebackAtStartBytes: 0, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: q, autovacuumInsideQueries: inside}});
  assert.equal(attribution(scenario({}, {'A1.6': env(['q2'])}), 1.05).H5, 'supported');
  assert.equal(attribution(scenario({}, {'A1.1': env(['q2'])}), 1.05).H5, 'withheld');
  assert.equal(attribution(scenario(), 1.05).H5, 'ruled out');
  // Review round 6: a reading that only partly overlaps the slow block is not support; it is withheld.
  assert.equal(attribution(scenario({}, {'A1.6': env(['q2'], [])}), 1.05).H5, 'withheld');
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

test('H6 is ruled out when the same query rises in F and R rounds wherever it sits', () => {
  // q1 rises 1.5x in both orders (first in F rounds, last in R rounds); the others do not.
  const query = (id: string, base: number) => {
    const x = m(id, base);
    x.latencies = x.latencies.map(l => l.query === 'q1' ? {...l, p95: base * 1.5} : l);
    return x;
  };
  const ms = scenario({'A1.2': 40}).map(x => ['A1.5', 'A1.6'].includes(x.id) ? query(x.id, 40) : x);
  assert.equal(attribution(ms, 1.05).H6, 'ruled out');
});

test('Stage 1 outcomes: not reproduced, several supported, none supported with one withheld, H6 alone', () => {
  const flat = Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`A1.${i}`, 40 + i * 0.5]));
  const nr = stage1(scenario(flat));
  assert.equal(nr.outcome, 'not reproduced');
  assert.equal(nr.stage2, 'propose');
  // H1 and H3 both supported.
  const two = stage1(scenario({}, {'A1.6': {plans: plans(q => ({shapeHash: q === 'q1' ? 'other' : 'same'}))}}));
  assert.equal(two.attribution!.H1, 'supported');
  assert.equal(two.attribution!.H3, 'supported');
  assert.equal(two.outcome, 'cause not established');
  // None supported, H2 withheld (A2.1 INVALID): not established, not repetition-linked.
  const none = stage1(scenario({'C1.restart': 40, 'C2.restart': 40}, {'A2.1': invalid}));
  assert.equal(Object.values(none.attribution!).includes('supported'), false);
  assert.equal(none.outcome, 'cause not established');
  assert.equal(none.repetitionLinked, false);
  const position = (id: string, base: number) => {
    const x = m(id, base);
    x.latencies = x.latencies.map((l, i) => l.query === 'scalar' ? l : {...l, p95: base * (1 + 0.2 * i)});
    return x;
  };
  const h6 = stage1(scenario({'C1.restart': 40, 'C2.restart': 40}).map(x => x.id === 'A1.5' ? position('A1.5', 53) : x.id === 'A1.6' ? position('A1.6', 56) : x));
  // H6 supported alone with H1-H5 ruled out: "repetition-linked, cause not established" (maintainer decision
  // on PR #871, re-approval question 3), never "cause established"; nothing by elimination.
  assert.deepEqual(Object.values(h6.attribution!).filter(v => v === 'supported').length, 1);
  assert.equal(h6.attribution!.H6, 'supported');
  assert.equal(h6.repetitionLinked, true);
  assert.equal(h6.outcome, 'repetition-linked, cause not established');
  assert.equal(h6.stage2, 'propose');
});

test('H6 is not supported when earlier positions rise more (rho <= -0.8 in F and R; decision 5 is rho >= 0.8)', () => {
  // Earlier positions rise more in both orders: q1 most in F rounds, q3 most in R rounds.
  const early = (id: string, base: number) => {
    const x = m(id, base);
    const accepted = x.latencies.filter(l => l.query !== 'scalar').length;
    x.latencies = x.latencies.map((l, i) => l.query === 'scalar' ? l : {...l, p95: base * (1 + 0.2 * (accepted - i))});
    return x;
  };
  const ms = scenario().map(x => x.id === 'A1.5' ? early('A1.5', 53) : x.id === 'A1.6' ? early('A1.6', 56) : x);
  assert.notEqual(attribution(ms, 1.05).H6, 'supported');
});

test('a normal Stage 1 has no abnormal reasons; each unmet minimum and a STOP are listed', () => {
  assert.deepEqual(stage1(scenario()).abnormal, []);
  assert.deepEqual(stage1(scenario({}, {'A2.1': invalid})).abnormal, ['minimum not met: H2', 'INVALID: A2.1']);
  assert.deepEqual(stage1(scenario({}, {'C1.hot2': invalid})).abnormal, ['minimum not met: H1', 'INVALID: C1.hot2']);
  assert.deepEqual(stage1(scenario({}, {'D.settle2': invalid})).abnormal, ['minimum not met: H45', 'INVALID: D.settle2']);
  assert.deepEqual(stage1(scenario({}, {'A1.4': {plans: null}})).abnormal, ['minimum not met: H3']);
  assert.deepEqual(stage1(scenario({}, {'A1.1': invalid, 'A1.2': invalid})).abnormal,
    ['minimum not met: A1', 'minimum not met: H2', 'INVALID: A1.1, A1.2']);
});

test('one INVALID measurement with every minimum still met is not a normal finish (review item 2)', () => {
  const r = stage1(scenario({}, {'A1.3': invalid}));
  assert.equal(minimums(scenario({}, {'A1.3': invalid})).A1, true);
  // The judgement excludes it as §4.1 says; the stage still does not count as a normal finish.
  assert.equal(r.outcome, 'cause established');
  assert.deepEqual(r.abnormal, ['INVALID: A1.3']);
  assert.deepEqual(stage2(b({}, {'B.post3': invalid}), C(1.05)).abnormal, ['INVALID: B.post3']);
  assert.deepEqual(smoke([{...m('A1.1', 40, invalid), id: 'smoke.1'}], null).abnormal, ['minimum not met: one valid smoke round', 'INVALID: smoke.1']);
});

test('a window the sampler never checked (sampler death in the final validation) is incomplete evidence', () => {
  const r = stage1(scenario({}, {'C2.restart': {samplerChecked: false}}), 'sampler validation: Error: the sampler process exited');
  assert.equal(r.evidence.complete, false);
  assert.deepEqual(r.evidence.missing, ['C2.restart: sampler window not checked']);
  assert.equal(r.outcome, 'inconclusive');
  assert.equal(r.attribution, null);
  // A blocked finish refuses Stage 2, and the top-level direction agrees (sol review of the re-approval fix).
  assert.deepEqual([r.finish.kind, r.finish.stage2, r.stage2], ['blocked', 'refused', 'refused']);
});

test('§4.2 and §5.3 thresholds are exact on the stored p95s, with no tolerance: 23 queries at 100 -> 130 ms is 1.30', () => {
  const many = (id: string, values: number[]) => {
    const x = m(id, values[0]);
    x.latencies = values.map((p95, i) => ({query: `fullwidth-${i}`, p95}));
    return x;
  };
  const with2 = (pre: number[], post: number[]) =>
    b({}).map(x => x.id === 'B.pre' ? many('B.pre', pre) : x.id === 'B.post1' ? many('B.post1', post) : x);
  const flat = (v: number) => Array.from({length: 23}, () => v);
  // The double ratio computes below 1.30 here; the exact comparison still reproduces a true 1.30.
  assert.equal(stage2(with2(flat(100), flat(130)), C(1.05)).result, 'reproduced');
  assert.equal(stage2(with2(flat(100), flat(129.99)), C(1.05)).result, 'inconclusive');
  // Review round 6: 129.999 and 130.001 give a true ratio of 1.2999999999966554, below 1.30. The removed
  // 1e-9 tolerance reproduced it; the exact comparison does not.
  const sub = [129.999, 130.001, ...flat(130).slice(2)];
  assert.ok(g95(many('B.post1', sub))! / 100 < 1.3);
  assert.equal(stage2(with2(flat(100), sub), C(1.05)).result, 'inconclusive');
  // The same at the 1.15 bound: a true 1.15 is not "not reproduced", a hair below it is.
  assert.equal(stage2(with2(flat(100), flat(115)), C(1.05)).result, 'inconclusive');
  assert.equal(stage2(with2(flat(100), [114.999, 115.001, ...flat(115).slice(2)]), C(1.05)).result, 'not reproduced');
  // §4.2 on A1: a true 1.30 reproduces and a ratio just under it does not.
  const rising: Record<string, number> = {'A1.1': 100, 'A1.2': 104, 'A1.3': 108, 'A1.4': 112, 'A1.5': 120};
  const a1 = (last: number[]) => scenario({'C1.restart': 400, 'C2.restart': 400})
    .map(x => x.id.startsWith('A1.') ? many(x.id, x.id === 'A1.6' ? last : flat(rising[x.id])) : x);
  assert.equal(stage1(a1(flat(130))).reproduction.result, 'reproduced');
  assert.equal(stage1(a1(sub)).reproduction.result, 'inconclusive');
  assert.deepEqual(stage1(scenario(), 'more than 4 INVALID measurements').abnormal, ['STOP: more than 4 INVALID measurements']);
});

test('§4.2 noise condition with a measured spread is exact: r + 2 >= 3 x spread, an undecidable case never passes', () => {
  // hot2 / hot1 = 48 / 40 = 1.2 in both replicates, so N = 1.2 and r must be at least 1.6.
  const at = (last: number) => stage1(scenario({'C1.hot2': 48, 'C2.hot2': 48, 'A1.6': last})).reproduction.result;
  assert.equal(at(64), 'reproduced');
  assert.equal(at(63.999), 'inconclusive');
  assert.equal(at(70), 'reproduced');
});

test('a limited Stage 1 keeps its recorded outcome; the constraint says Stage 2 cannot change it', () => {
  const one = stage1(scenario({}, {'A1.2': {invalid: ['fake']}}));
  assert.equal(one.finish.kind, 'limited');
  const text = one.finish.stage2Constraints.join(' ');
  assert.match(text, /attribution \(H1-H6\) and outcome stay as recorded/);
  assert.doesNotMatch(text, /withheld or partial/);
});

test('incomplete evidence never establishes a cause: the outcome is inconclusive (evidence incomplete)', () => {
  assert.equal(stage1(scenario()).outcome, 'cause established');
  const partial = stage1(scenario({}, {'D.current1': {missingEvidence: ['stats-after: Error: psql']}}));
  assert.deepEqual([partial.outcome, why(partial).inconclusiveReason, partial.attribution, partial.stage2], ['inconclusive', 'evidence incomplete', null, 'refused']);
  assert.deepEqual(partial.evidence, {complete: false, missing: ['D.current1: stats-after: Error: psql']});
  assert.deepEqual(partial.abnormal, ['evidence incomplete']);
  const noLog = stage1(scenario(), null, ['postgres log: docker logs exited 1']);
  assert.equal(noLog.outcome, 'inconclusive');
  assert.deepEqual(evidence(scenario(), []), {complete: true, missing: []});
});

test('the smoke passes only with one valid round, no STOP and complete evidence', () => {
  const one = (over: Partial<Measurement> = {}) => [{...m('A1.1', 40, over), id: 'smoke.1'}];
  assert.equal(smoke(one(), null).outcome, 'smoke passed');
  assert.deepEqual(smoke(one(), null).abnormal, []);
  assert.equal(smoke(one(invalid), null).outcome, 'smoke failed');
  assert.equal(smoke([], 'smoke.1: Error: boom').outcome, 'smoke failed');
  assert.equal(smoke(one({missingEvidence: ['EXPLAIN session: x']}), null).outcome, 'smoke failed');
  assert.equal(smoke(one(), null, ['sampler: did not exit after SIGKILL']).outcome, 'smoke failed');
});

// A recorded N whose one exact spread is the double itself.
const normalStage1 = {kind: 'normal' as const, shortfall: [], constraints: []};
const C = (value: number) => ({value, source: 'C hot1/hot2' as const, spreads: [{q: rational(value), k: 1n}], stage1: normalStage1});
const b = (g: Record<string, number>, over: Record<string, Partial<Measurement>> = {}) => Object.entries({'B.pre': 40, 'B.post1': 56,
  'B.post2': 56, 'B.post3': 56, 'B.cool1': 50, 'B.cool2': 50, ...g}).map(([id, v]) => m(id, v, over[id]));

test('Stage 2: reproduced, not reproduced, and its minimum', () => {
  assert.equal(stage2(b({}), C(1.05)).result, 'reproduced');
  // §5.3 as written: ratio >= 1.30 and ratio >= 3 x (N - 1). At N = 1.20 a 1.40 ratio reproduces.
  assert.equal(stage2(b({}), C(1.2)).result, 'reproduced');
  assert.equal(stage2(b({}), C(1.5)).result, 'inconclusive');
  assert.equal(stage2(b({'B.post1': 44}), C(1.05)).result, 'not reproduced');
  // The contrast is B.post1; an INVALID B.post1 is not replaced by B.post2.
  const p1 = stage2(b({}, {'B.post1': invalid}), C(1.05));
  assert.deepEqual([p1.result, why(p1).reason, p1.ratio], ['inconclusive', 'B.post1 INVALID', null]);
  assert.equal(stage2(b({}, {'B.post1': invalid, 'B.post2': invalid}), C(1.05)).result, 'inconclusive');
  assert.equal(stage2(b({}, {'B.cool2': invalid}), C(1.05)).result, 'inconclusive');
  assert.equal(stage2(b({}, {'B.pre': invalid}), C(1.05)).result, 'inconclusive');
});

test('Stage 2 boundaries are §5.3 literally: 1.30 reproduces, 1.15 is inconclusive, under 1.15 is not reproduced', () => {
  assert.equal(stage2(b({'B.post1': 52}), C(1.05)).result, 'reproduced');
  near(stage2(b({'B.post1': 52}), C(1.05)).ratio, 1.3);
  assert.equal(stage2(b({'B.post1': 51.99}), C(1.05)).result, 'inconclusive');
  assert.equal(stage2(b({'B.post1': 46}), C(1.05)).result, 'inconclusive');
  assert.equal(stage2(b({'B.post1': 45.99}), C(1.05)).result, 'not reproduced');
  // The noise condition is on the ratio itself: 1.50 >= 3 x (1.5 - 1) = 1.50 reproduces, the next double N does not.
  assert.equal(stage2(b({'B.post1': 60}), C(1.5)).result, 'reproduced');
  assert.equal(stage2(b({'B.post1': 60}), C(1.5 + 2 ** -52)).result, 'inconclusive');
});

test('Stage 2 is not a normal finish when its minimum, B.post1 or any evidence is missing; it records N and its source', () => {
  assert.deepEqual(stage2(b({}), C(1.05)).abnormal, []);
  assert.deepEqual(stage2(b({}), C(1.05)).noise, {value: 1.05, source: 'C hot1/hot2'});
  assert.deepEqual(stage2(b({}, {'B.post1': invalid}), C(1.05)).abnormal, ['minimum not met: B.post1 (the §5.3 contrast)', 'INVALID: B.post1']);
  assert.deepEqual(stage2(b({}, {'B.cool1': invalid}), C(1.05)).abnormal, ['minimum not met: both cool-down rounds', 'INVALID: B.cool1']);
  const partial = stage2(b({}, {'B.post2': {missingEvidence: ['EXPLAIN q1: timeout']}}), C(1.05));
  assert.deepEqual([partial.result, why(partial).reason, partial.abnormal], ['inconclusive', 'evidence incomplete', ['evidence incomplete']]);
  assert.deepEqual(stage2(b({}), C(1.05), 'B.post2: boom').abnormal.slice(0, 1), ['STOP: B.post2: boom']);
});

test('a cut-short EXPLAIN sweep is never a partial plan list: missing queries get errors and H3 is withheld', () => {
  const got = plans().filter(p => p.query === 'q1');
  const filled = fillPlans(queries, got, 'EXPLAIN session failed before this query');
  assert.deepEqual(filled.map(p => [p.query, 'error' in p]), [['q1', false], ['q2', true], ['q3', true]]);
  assert.equal(attribution(scenario({}, {'A1.4': {plans: filled}}), 1.05).H3, 'withheld');
});

test('Stage 2 uses the exact spreads behind N, never the rounded double (review round 7)', () => {
  // A 23-query hot replicate whose exact spread is just above 1.5 while its G95 double ratio is below 1.5.
  const many = (id: string, values: number[]) => {
    const x = m(id, values[0]);
    x.latencies = values.map((p95, i) => ({query: `fullwidth-${i}`, p95}));
    return x;
  };
  // hot2 = 1.5 x hot1 per query (exact), with its first p95 two ulps higher: the exact N is above 1.5.
  const hot1 = [53, 45, 51, 35, 39, 35, 34, 55, 35, 34, 30, 41, 58, 60, 39, 41, 37, 47, 50, 48, 31, 67, 35];
  const hot2 = [79.50000000000003, ...hot1.slice(1).map(x => x * 1.5)];
  const ms = scenario().map(x => x.id === 'C1.hot1' ? many('C1.hot1', hot1) : x.id === 'C1.hot2' ? many('C1.hot2', hot2) : x);
  const N = noise(ms);
  const spreads = noiseSpreads(ms)!;
  assert.equal(N.value, 1.4999999999999991);
  assert.ok(ratio(spreads[0], {q: rational(1.5), k: 1n}).q.n > ratio(spreads[0], {q: rational(1.5), k: 1n}).q.d);
  // B.post1 / B.pre = 60 / 40 = 1.5 exactly: below 3 x (N - 1) for the exact N, so not reproduced as written.
  assert.equal(stage2(b({'B.post1': 60}), {...N, spreads, stage1: normalStage1}).result, 'inconclusive');
  // With the rounded double as the spread it would have reproduced.
  assert.equal(stage2(b({'B.post1': 60}), C(N.value)).result, 'reproduced');
  assert.deepEqual(stage2(b({'B.post1': 60}), {...N, spreads, stage1: normalStage1}).noise, N);
});

test('the reported rho is computed from the exact G95 ranks used for the decision', () => {
  const r = reproduction(scenario(), 1.05);
  assert.equal(r.rho, 1);
  // A1.3 (F) and A1.4 (R) hold the same p95s in opposite query orders: the same exact G95, though the
  // doubles differ in the last bits. They tie in rank, in the decision and in the reported rho.
  const p95 = {q1: 59.54, q2: 55.29, q3: 59.57} as Record<string, number>;
  const same = (x: Measurement) => ({...x, latencies: x.latencies.map(l => l.query === 'scalar' ? l : {...l, p95: p95[l.query]})});
  const ms = scenario({'A1.5': 60, 'A1.6': 62}).map(x => x.id === 'A1.3' || x.id === 'A1.4' ? same(x) : x);
  const [a3, a4] = ['A1.3', 'A1.4'].map(id => ms.find(x => x.id === id)!);
  assert.notEqual(a3.order, a4.order);
  assert.notEqual(g95(a3), g95(a4));
  assert.equal(reproduction(ms, 1.05).rho, spearman([1, 2, 3, 4, 5, 6], [1, 2, 3.5, 3.5, 5, 6]));
});

test('every judgement states that H1 shared reads are database-wide supporting evidence, never a per-query cause', () => {
  assert.match(cacheConstraint.h1Reads, /blks_read delta/);
  assert.match(cacheConstraint.h1Reads, /autovacuum and analyze/);
  assert.match(cacheConstraint.h1Reads, /never attribute the rise to a particular query/);
});
