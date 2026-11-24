import { accepts, fullySampled, type Sample } from '../d3r/acceptance.ts';
import type { Arm, Order } from './plan.ts';

// The pre-set #870 Stage 1 and Stage 2 judgement (design rev 2, §4 and §5). Diagnosis only: nothing here
// reads or changes the #689 verdict. Every function is pure, so each rule is tested with fixed records.

export type Block = {query: string; start: number; end: number};
export type Latency = {query: string; p95?: number; error?: string};
// One accepted query's EXPLAIN (ANALYZE, BUFFERS): shape hash and root shared hit and read blocks, or the error.
export type Plan = {query: string; shapeHash: string; buffers: number; sharedHit: number; sharedRead: number} | {query: string; error: string};
export type Environment = {
  dirtyWritebackAtStartBytes: number | null; meanTemperatureC: number | null; meanFrequencyKHz: number | null;
  // Queries whose block overlapped an autovacuum worker on `measured`.
  autovacuumQueries: string[];
};
export type Measurement = {
  id: string; kind: 'copy' | 'hot' | 'restart-only'; arm: Arm; order: Order; settle: boolean;
  latencies: Latency[]; plans: Plan[] | null; sharedReads: number | null; env: Environment;
  invalid: string[];
};
export type Verdict = 'supported' | 'ruled out' | 'withheld';
export type Hypothesis = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6';

export const minNoise = 1.05;
export const maxLoad15 = 3;

// A measurement's own INVALID reasons (§4.1): a query not fully sampled or failed, or load15 above 3 at
// its start. The sampler reasons (gaps, workers, containers) and a capped settle wait are added later.
export function ownReasons(results: ({query: string} & ({sample: Sample} | {error: string}))[], load15: number) {
  const reasons = results.flatMap(r => 'error' in r ? [`${r.query} failed: ${r.error}`]
    : fullySampled(r.sample) ? [] : [`${r.query} not fully sampled`]);
  return load15 > maxLoad15 ? [`load15 ${load15.toFixed(2)} > ${maxLoad15} at start`, ...reasons] : reasons;
}
const valid = (m: Measurement | undefined): m is Measurement => m !== undefined && m.invalid.length === 0;
const byId = (ms: Measurement[], id: string) => ms.find(m => m.id === id);
const validIds = (ms: Measurement[], ids: string[]) => ids.map(id => byId(ms, id)).filter(valid);
const a1Ids = [1, 2, 3, 4, 5, 6].map(i => `A1.${i}`);
const p95Of = (m: Measurement, query: string) => m.latencies.find(l => l.query === query)?.p95;

// Geometric mean p95 over the accepted (index) queries; null when any of them has no p95.
export function g95(m: Measurement) {
  const values = m.latencies.filter(l => accepts(l.query)).map(l => l.p95);
  if (values.length === 0 || values.some(v => v === undefined || !(v > 0))) return null;
  return Math.exp(values.reduce<number>((s, v) => s + Math.log(v as number), 0) / values.length);
}
const G = (m: Measurement) => g95(m) as number;
const within = (ratio: number, n: number) => ratio <= n && ratio >= 1 / n;
const isPlan = (p: Plan | undefined): p is Extract<Plan, {shapeHash: string}> => p !== undefined && 'shapeHash' in p;
// The accepted queries, from the frozen set as measured.
const acceptedOf = (m: Measurement) => m.latencies.map(l => l.query).filter(accepts);
// Every accepted query has a plan (no EXPLAIN error, none missing).
export const plansComplete = (m: Measurement) => m.plans !== null && acceptedOf(m).length > 0 &&
  acceptedOf(m).every(q => isPlan(m.plans!.find(p => p.query === q)));

function ranks(xs: number[]) {
  const sorted = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]![0] === sorted[i]![0]) j++;
    for (let k = i; k <= j; k++) r[sorted[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
// Spearman's rho with average ranks for ties; null with fewer than 3 points or a constant series.
export function spearman(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const [rx, ry] = [ranks(xs), ranks(ys)];
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const [mx, my] = [mean(rx), mean(ry)];
  let [sxy, sxx, syy] = [0, 0, 0];
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

const cacheComplete = (ms: Measurement[], arm: 'C1' | 'C2') =>
  ['warm', 'hot1', 'hot2', 'restart'].every(s => valid(byId(ms, `${arm}.${s}`)));

// §4.1 minimum valid samples per comparison.
export function minimums(ms: Measurement[]) {
  const a1 = a1Ids.map(id => valid(byId(ms, id)));
  const A1 = a1.filter(Boolean).length >= 5 && (a1[0] || a1[1]) && (a1[4] || a1[5]);
  return {
    A1,
    H2: A1 && ['A2.1', 'A2.2'].every(id => valid(byId(ms, id))),
    H1: cacheComplete(ms, 'C1') && cacheComplete(ms, 'C2'),
    H45: validIds(ms, ['D.current1', 'D.current2']).length === 2 && validIds(ms, ['D.settle1', 'D.settle2']).length === 2,
    H3: validIds(ms, a1Ids).every(plansComplete),
  };
}

// N: the largest hot1/hot2 spread over both cache replicates (at least 1.05). Without both replicates it
// falls back to the spread of the valid A1 rounds, which is reported as such.
export function noise(ms: Measurement[]) {
  if (minimums(ms).H1) {
    const spreads = (['C1', 'C2'] as const).map(arm => {
      const [a, b] = [G(byId(ms, `${arm}.hot1`)!), G(byId(ms, `${arm}.hot2`)!)];
      return Math.max(a, b) / Math.min(a, b);
    });
    return {value: Math.max(minNoise, ...spreads), source: 'C hot1/hot2' as const};
  }
  const a1 = validIds(ms, a1Ids).map(G);
  return {value: a1.length ? Math.max(minNoise, Math.max(...a1) / Math.min(...a1)) : minNoise, source: 'A1 spread (fallback)' as const};
}

// §4.2. first = first valid of A1.1-A1.2, last = last valid of A1.5-A1.6.
export function reproduction(ms: Measurement[], n: number) {
  if (!minimums(ms).A1) return {result: 'inconclusive' as const, reason: 'A1 minimum not met', r: null, rho: null};
  const first = validIds(ms, ['A1.1', 'A1.2'])[0];
  const last = validIds(ms, ['A1.5', 'A1.6']).at(-1)!;
  const r = G(last) / G(first);
  const rounds = a1Ids.map((id, i) => [i + 1, byId(ms, id)] as const).filter(([, m]) => valid(m));
  const rho = spearman(rounds.map(([i]) => i), rounds.map(([, m]) => G(m!)));
  if (r >= 1.30 && rho !== null && rho >= 0.8 && r - 1 >= 3 * (n - 1)) return {result: 'reproduced' as const, r, rho};
  if (r < 1.15) return {result: 'not reproduced' as const, r, rho};
  return {result: 'inconclusive' as const, reason: 'between the reproduction thresholds', r, rho};
}

const verdict = (supported: boolean, ruledOut: boolean): Verdict =>
  supported === ruledOut ? 'withheld' : supported ? 'supported' : 'ruled out';

// §4.3, only when reproduced. A hypothesis whose minimum is not met is withheld.
export function attribution(ms: Measurement[], n: number): Record<Hypothesis, Verdict> {
  const min = minimums(ms);
  const a1 = validIds(ms, a1Ids);
  const first = validIds(ms, ['A1.1', 'A1.2'])[0];
  const last = validIds(ms, ['A1.5', 'A1.6']).at(-1)!;
  const out = {} as Record<Hypothesis, Verdict>;

  // H1 (§4.3 as written): restart-only / warm >= 1.25 and >= 3 x N in both replicates, or shared reads in
  // every valid A1 round above the median G95.
  if (!min.H1) out.H1 = 'withheld';
  else {
    const ratios = (['C1', 'C2'] as const).map(arm => G(byId(ms, `${arm}.restart`)!) / G(byId(ms, `${arm}.warm`)!));
    const sorted = a1.map(G).sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const slow = a1.filter(m => G(m) > median);
    const readsKnown = a1.every(m => m.sharedReads !== null);
    const readsInSlow = readsKnown && slow.length > 0 && slow.every(m => (m.sharedReads as number) > 0);
    out.H1 = !readsKnown ? 'withheld' : verdict(ratios.every(x => x >= 1.25 && x >= 3 * n) || readsInSlow,
      ratios.every(x => within(x, n)) && a1.every(m => m.sharedReads === 0));
  }

  // H2: recovery after the cool-down, tracked by temperature or frequency over all valid copy rounds.
  if (!min.H2) out.H2 = 'withheld';
  else {
    const a2 = validIds(ms, ['A2.1', 'A2.2']).map(m => G(m) / G(first));
    const copies = ms.filter(m => valid(m) && m.kind === 'copy');
    const series = (pick: (m: Measurement) => number | null) => {
      const points = copies.filter(m => pick(m) !== null);
      return points.length === copies.length ? spearman(points.map(m => pick(m) as number), points.map(G)) : null;
    };
    const rhoT = series(m => m.env.meanTemperatureC);
    const rhoF = series(m => m.env.meanFrequencyKHz);
    const tracks = (rhoT !== null && rhoT >= 0.8) || (rhoF !== null && rhoF <= -0.8);
    const temps = a1.map(m => m.env.meanTemperatureC);
    const freqs = a1.map(m => m.env.meanFrequencyKHz);
    const flat = temps.every(t => t !== null) && freqs.every(f => f !== null) &&
      Math.max(...temps as number[]) - Math.min(...temps as number[]) < 5 &&
      Math.max(...freqs as number[]) / Math.min(...freqs as number[]) <= 1.03;
    out.H2 = verdict(a2.every(x => x <= 1.10) && tracks, flat || a2.every(x => x > 1.10));
  }

  // H3: plan shape or buffer change for a query whose p95 rose at least 1.25x across A1.
  if (!min.H3) out.H3 = 'withheld';
  else {
    // Plans are complete here (the H3 minimum). Buffers are the root's shared hit + read; the hit/read split
    // is kept in the records for H1.
    const queries = acceptedOf(a1[0]);
    const changed = (query: string) => {
      const plans = a1.map(m => m.plans!.find(p => p.query === query)).filter(isPlan);
      const buffers = plans.map(p => p.buffers);
      return new Set(plans.map(p => p.shapeHash)).size > 1 || Math.max(...buffers) > 1.10 * Math.min(...buffers);
    };
    const rose = (query: string) => (p95Of(last, query) ?? 0) >= 1.25 * (p95Of(first, query) ?? Infinity);
    out.H3 = verdict(queries.some(q => rose(q) && changed(q)), queries.every(q => !changed(q)));
  }

  // H4: settle vs current in both pairs, with dirty memory at the start of the current rounds.
  // H5: an autovacuum worker on `measured` over a block that rose 1.25x against A1's first valid round.
  if (!min.H45) { out.H4 = 'withheld'; out.H5 = 'withheld'; }
  else {
    const pairs = [1, 2].map(i => [byId(ms, `D.settle${i}`)!, byId(ms, `D.current${i}`)!] as const);
    const ratios = pairs.map(([s, c]) => G(s) / G(c));
    const dirty = pairs.every(([, c]) => (c.env.dirtyWritebackAtStartBytes ?? 0) > 64 * 1024 ** 2);
    out.H4 = verdict(ratios.every(x => x <= 0.80) && dirty, ratios.every(x => within(x, n)));
    const measured = ms.filter(valid);
    const overlaps = measured.flatMap(m => m.env.autovacuumQueries.map(q => [m, q] as const));
    out.H5 = verdict(overlaps.some(([m, q]) => (p95Of(m, q) ?? 0) >= 1.25 * (p95Of(first, q) ?? Infinity)), overlaps.length === 0);
  }

  // H6 (position): the per-query rise in F rounds vs R rounds of A1.
  const rise = (order: Order) => {
    const rounds = a1.filter(m => m.order === order);
    if (rounds.length < 2) return null;
    const [a, b] = [rounds[0], rounds.at(-1)!];
    return a.latencies.filter(l => accepts(l.query)).map(l => [l.query, (p95Of(b, l.query) ?? NaN) / (l.p95 ?? NaN)] as const);
  };
  const [f, r] = [rise('F'), rise('R')];
  if (!min.A1 || f === null || r === null) out.H6 = 'withheld';
  else {
    const queries = f.map(([q]) => q);
    const position = (order: Order) => queries.map(q => {
      const set = a1.find(m => m.order === order)!.latencies.map(l => l.query);
      return set.indexOf(q);
    });
    const rf = f.map(([, x]) => x), rr = queries.map(q => r.find(([x]) => x === q)?.[1] ?? NaN);
    const [pf, pr] = [spearman(position('F'), rf), spearman(position('R'), rr)];
    out.H6 = verdict(pf !== null && pr !== null && pf >= 0.8 && pr >= 0.8, rf.every((x, i) => within(x / rr[i], n)));
  }
  return out;
}

export type Outcome = 'not reproduced' | 'cause established' | 'cause not established' | 'inconclusive';

// §5.2. `stopped` is a STOP reason when the stage ended early.
export function stage1(ms: Measurement[], stopped: string | null = null) {
  const N = noise(ms);
  const repro = reproduction(ms, N.value);
  const base = {noise: N, reproduction: repro, minimums: minimums(ms), stopped};
  // A STOP before the A1 minimum leaves reproduction inconclusive; after it, the A1 result stands.
  if (repro.result !== 'reproduced') {
    const outcome: Outcome = repro.result === 'not reproduced' ? 'not reproduced' : 'inconclusive';
    return {...base, outcome, attribution: null, repetitionLinked: false, stage2: 'propose'};
  }
  const att = attribution(ms, N.value);
  const verdicts = Object.values(att);
  // "Repetition-linked" (§4.3): the rise grows with round count, H1-H5 are ruled out and position (H6) does
  // not explain it. It is always "cause not established" (§5.2); nothing is attributed by elimination.
  const repetitionLinked = (['H1', 'H2', 'H3', 'H4', 'H5'] as const).every(h => att[h] === 'ruled out') && att.H6 !== 'supported';
  const established = !repetitionLinked && verdicts.filter(v => v === 'supported').length === 1 && verdicts.every(v => v !== 'withheld');
  const outcome: Outcome = established ? 'cause established' : 'cause not established';
  return {...base, outcome, attribution: att, repetitionLinked, stage2: established ? 'may be skipped' : 'propose'};
}

// §6, stated in every judgement so a standalone record cannot be read as ruling out the OS page cache.
export const cacheConstraint = {
  statement: 'No privileged container and no drop_caches. Restart-only empties PostgreSQL shared buffers only; the OS page cache may still hold the relation files, so it is not a cold-cache measurement. The OS cache state is recorded, not controlled.',
  h1Scope: 'H1 covers shared-buffer state and whether reads reach the OS. A cause in the OS page cache alone is withheld, never ruled out.',
};

// §5.3 Stage 2: first valid post-scan round against the pre-scan round, with Stage 1's N.
// The contrast is B.post1 (the first round after the scan) against B.pre; an INVALID B.post1 leaves it
// inconclusive. The noise condition is §5.3 as written: ratio >= 3 x (N - 1).
export function stage2(ms: Measurement[], n: number) {
  const pre = byId(ms, 'B.pre');
  const post = validIds(ms, ['B.post1', 'B.post2', 'B.post3']);
  const cool = validIds(ms, ['B.cool1', 'B.cool2']);
  if (!valid(pre) || post.length < 2 || cool.length < 2) return {result: 'inconclusive' as const, reason: 'Stage 2 minimum not met', ratio: null};
  const first = byId(ms, 'B.post1');
  if (!valid(first)) return {result: 'inconclusive' as const, reason: 'B.post1 INVALID', ratio: null};
  const ratio = G(first) / G(pre);
  if (ratio >= 1.30 && ratio >= 3 * (n - 1)) return {result: 'reproduced' as const, ratio};
  if (ratio < 1.15) return {result: 'not reproduced' as const, ratio};
  return {result: 'inconclusive' as const, reason: 'between the thresholds', ratio};
}
