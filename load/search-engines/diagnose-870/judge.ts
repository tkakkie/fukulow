import { accepts, fullySampled, type Sample } from '../d3r/acceptance.ts';
import type { Arm, Order } from './plan.ts';
import { atLeast, below, compare, geometric, q, rational, ratio, rhoAtLeast, sumAtLeast, type Root } from './exact.ts';

// The pre-set #870 Stage 1 and Stage 2 judgement (design rev 2, §4 and §5). Diagnosis only: nothing here
// reads or changes the #689 verdict. Every function is pure, so each rule is tested with fixed records.

export type Block = {query: string; start: number; end: number};
export type Latency = {query: string; p95?: number; error?: string};
// One accepted query's EXPLAIN (ANALYZE, BUFFERS): shape hash and root shared hit and read blocks, or the error.
export type Plan = {query: string; shapeHash: string; buffers: number; sharedHit: number; sharedRead: number} | {query: string; error: string};
export type Environment = {
  dirtyWritebackAtStartBytes: number | null; meanTemperatureC: number | null; meanFrequencyKHz: number | null;
  // Queries whose block an autovacuum reading on `measured` overlapped (blocks the H5 rule-out), and those
  // whose block wholly contained such a reading (the only H5 support).
  autovacuumQueries: string[]; autovacuumInsideQueries: string[];
};
export type Measurement = {
  id: string; kind: 'copy' | 'hot' | 'restart-only'; arm: Arm; order: Order; settle: boolean;
  latencies: Latency[]; plans: Plan[] | null; sharedReads: number | null; env: Environment;
  invalid: string[];
  // Evidence this measurement should have saved but did not (statistics, read counters, EXPLAIN plans).
  missingEvidence: string[];
  // The sampler check of this window ran (gaps, workers, containers, environment). Unchecked is incomplete
  // evidence: its INVALID reasons and environment are unknown.
  samplerChecked: boolean;
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
// The G95 as an exact root of the stored p95s, for the §4.2 and §5.3 thresholds (exact.ts); null when
// a p95 is missing, which no threshold passes.
export function g95Root(m: Measurement): Root | null {
  const values = m.latencies.filter(l => accepts(l.query)).map(l => l.p95);
  return values.length > 0 && values.every(v => v !== undefined && v > 0) ? geometric(values as number[]) : null;
}
const byRoot = (a: Root, b: Root) => compare(ratio(a, b), q(1));
const within = (ratio: number, n: number) => ratio <= n && ratio >= 1 / n;
const isPlan = (p: Plan | undefined): p is Extract<Plan, {shapeHash: string}> => p !== undefined && 'shapeHash' in p;
// The accepted queries, from the frozen set as measured.
const acceptedOf = (m: Measurement) => m.latencies.map(l => l.query).filter(accepts);
// Every accepted query has a plan (no EXPLAIN error, none missing).
export const plansComplete = (m: Measurement) => m.plans !== null && acceptedOf(m).length > 0 &&
  acceptedOf(m).every(q => isPlan(m.plans!.find(p => p.query === q)));

// After an EXPLAIN sweep: every accepted query without a plan gets an error entry, so a sweep cut short
// (a failed session) never leaves a partial list that could read as complete.
export const fillPlans = (accepted: string[], list: Plan[], error: string): Plan[] =>
  [...list, ...accepted.filter(q => !list.some(p => p.query === q)).map(query => ({query, error}))];

function ranks<T>(xs: T[], order: (a: T, b: T) => number = (a, b) => (a as number) - (b as number)) {
  const sorted = xs.map((x, i) => [x, i] as const).sort((a, b) => order(a[0], b[0]));
  const r = new Array<number>(xs.length);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && order(sorted[j + 1]![0], sorted[i]![0]) === 0) j++;
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
// The spreads behind N as exact roots (N = max(1.05, spreads)), for the §4.2 noise condition; null when a
// G95 behind a spread is missing, which fails the condition.
export function noiseSpreads(ms: Measurement[]): Root[] | null {
  const spread = (gs: Root[]) => {
    const sorted = [...gs].sort(byRoot);
    return ratio(sorted.at(-1)!, sorted[0]);
  };
  const roots = (ids: string[]) => ids.map(id => g95Root(byId(ms, id)!));
  const sets = minimums(ms).H1 ? (['C1', 'C2'] as const).map(arm => roots([`${arm}.hot1`, `${arm}.hot2`]))
    : [validIds(ms, a1Ids).map(g95Root)].filter(gs => gs.length > 0);
  return sets.every(gs => gs.every(g => g !== null)) ? sets.map(gs => spread(gs as Root[])) : null;
}

// §4.2. first = first valid of A1.1-A1.2, last = last valid of A1.5-A1.6. The thresholds are decided
// exactly on the stored p95s (exact.ts); r and rho are reported as doubles. N is the rational `n`, and also
// at least every exact root in `spreads` (Stage 1 passes N's floor and its measured spreads).
export function reproduction(ms: Measurement[], n: number, spreads: Root[] | null = []) {
  if (!minimums(ms).A1) return {result: 'inconclusive' as const, reason: 'A1 minimum not met', r: null, rho: null};
  const first = validIds(ms, ['A1.1', 'A1.2'])[0];
  const last = validIds(ms, ['A1.5', 'A1.6']).at(-1)!;
  const r = G(last) / G(first);
  const rounds = a1Ids.map((id, i) => [i + 1, byId(ms, id)] as const).filter(([, m]) => valid(m));
  const [gl, gf, gs] = [g95Root(last), g95Root(first), rounds.map(([, m]) => g95Root(m!))];
  if (gl === null || gf === null || gs.some(g => g === null)) return {result: 'inconclusive' as const, reason: 'a G95 is missing', r, rho: null};
  // The reported rho comes from the same exact G95 ranks as the decision (ranks of ranks are the ranks).
  const [ri, rg] = [ranks(rounds.map(([i]) => i)), ranks(gs as Root[], byRoot)];
  const rho = spearman(ri, rg);
  const R = ratio(gl, gf);
  const rhoMet = rounds.length >= 3 && rhoAtLeast(ri, rg, q(4, 5));
  // r - 1 >= 3 (N - 1): r >= 3n - 2 for the rational n, and r + 2 >= 3 x spread for each root.
  // 1.05 is the approved decimal floor, taken as exactly 21/20 rather than its double.
  const nq = n === minNoise ? q(21, 20) : rational(n);
  const noiseMet = atLeast(R, {n: 3n * nq.n - 2n * nq.d, d: nq.d}) && spreads !== null && spreads.every(s => sumAtLeast(R, q(2), q(3), s) === true);
  if (atLeast(R, q(13, 10)) && rhoMet && noiseMet) return {result: 'reproduced' as const, r, rho};
  if (below(R, q(23, 20))) return {result: 'not reproduced' as const, r, rho};
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
    // Plans are complete here (the H3 minimum). Each buffer count (the root's shared hit and shared read
    // blocks) is compared on its own: a change of more than 10% in either is a change.
    const queries = acceptedOf(a1[0]);
    const beyond10 = (xs: number[]) => Math.max(...xs) > 1.10 * Math.min(...xs);
    const changed = (query: string) => {
      const plans = a1.map(m => m.plans!.find(p => p.query === query)).filter(isPlan);
      return new Set(plans.map(p => p.shapeHash)).size > 1 || beyond10(plans.map(p => p.sharedHit)) || beyond10(plans.map(p => p.sharedRead));
    };
    const rose = (query: string) => (p95Of(last, query) ?? 0) >= 1.25 * (p95Of(first, query) ?? Infinity);
    out.H3 = verdict(queries.some(q => rose(q) && changed(q)), queries.every(q => !changed(q)));
  }

  // H4: settle vs current in both pairs, with dirty memory at the start of the current rounds.
  // H5: an autovacuum worker on `measured` seen wholly inside a block that rose 1.25x against A1's first
  // valid round; a reading that only overlaps a block keeps H5 from being ruled out but never supports it.
  if (!min.H45) { out.H4 = 'withheld'; out.H5 = 'withheld'; }
  else {
    const pairs = [1, 2].map(i => [byId(ms, `D.settle${i}`)!, byId(ms, `D.current${i}`)!] as const);
    const ratios = pairs.map(([s, c]) => G(s) / G(c));
    const dirty = pairs.every(([, c]) => (c.env.dirtyWritebackAtStartBytes ?? 0) > 64 * 1024 ** 2);
    out.H4 = verdict(ratios.every(x => x <= 0.80) && dirty, ratios.every(x => within(x, n)));
    const measured = ms.filter(valid);
    const overlaps = measured.flatMap(m => m.env.autovacuumQueries);
    const inside = measured.flatMap(m => m.env.autovacuumInsideQueries.map(q => [m, q] as const));
    out.H5 = verdict(inside.some(([m, q]) => (p95Of(m, q) ?? 0) >= 1.25 * (p95Of(first, q) ?? Infinity)), overlaps.length === 0 && inside.length === 0);
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
    // The rise follows the position in both orders, in either direction (later or earlier positions rise
    // more), with the same sign in F and R (decision 5, |rho| >= 0.8).
    const follows = pf !== null && pr !== null && ((pf >= 0.8 && pr >= 0.8) || (pf <= -0.8 && pr <= -0.8));
    out.H6 = verdict(follows, rf.every((x, i) => within(x / rr[i], n)));
  }
  return out;
}

export type Outcome = 'not reproduced' | 'cause established' | 'cause not established' | 'repetition-linked, cause not established' | 'inconclusive';

// Evidence completeness over a stage: every measurement's own evidence, plus the stage records (the
// PostgreSQL log, the sampler stop). Incomplete evidence never establishes a cause (review item 4).
export function evidence(ms: Measurement[], stageMissing: string[] = []) {
  const missing = [...ms.flatMap(m => [...m.missingEvidence, ...(m.samplerChecked ? [] : ['sampler window not checked'])].map(x => `${m.id}: ${x}`)),
    ...stageMissing];
  return {complete: missing.length === 0, missing};
}

// Why a stage is not a normal finish (review item 2): a STOP, a §4.1 / §5.3 minimum not met, or incomplete
// evidence. A non-empty list exits non-zero, so the launcher ends the queue.
// Any INVALID measurement is listed too: the judgement excludes it as §4.1 says, but the maintainer's review
// (item 2) does not accept a stage with an INVALID measurement as a normal finish.
const abnormalOf = (stopped: string | null, unmet: string[], ev: ReturnType<typeof evidence>, ms: Measurement[]) => {
  const invalid = ms.filter(m => m.invalid.length > 0).map(m => m.id);
  return [...(stopped ? [`STOP: ${stopped}`] : []), ...unmet.map(x => `minimum not met: ${x}`),
    ...(invalid.length ? [`INVALID: ${invalid.join(', ')}`] : []), ...(ev.complete ? [] : ['evidence incomplete'])];
};

// How a stage ended (maintainer decision on PR #871, re-approval question 2). "blocked": a safety STOP (any
// STOP) or incomplete evidence; nothing may follow it. "limited": no STOP and complete evidence, but INVALID
// measurements or a minimum not met; still not a normal finish (the queue ends), and Stage 2 may follow only
// with its own go that names this limited Stage 1, and only when N can be computed. "normal": neither.
export type FinishKind = 'normal' | 'limited' | 'blocked';
export const finishKindOf = (stopped: string | null, ev: {complete: boolean}, abnormal: string[]): FinishKind =>
  stopped !== null || !ev.complete ? 'blocked' : abnormal.length ? 'limited' : 'normal';

// What a Stage 2 after this Stage 1 can and cannot conclude, recorded in both stages' results.
export function stage2Constraints(kind: FinishKind, source: Noise['source'], shortfall: string[]) {
  return [
    ...(kind === 'limited' ? [`Stage 1 was a limited finish (${shortfall.join('; ')}): its attribution (H1-H6) and outcome stay as recorded, and Stage 2 neither completes nor changes them.`,
      'Stage 2 decides only the §5.3 scan contrast (B.post1 / B.pre: reproduced, not reproduced or inconclusive); it cannot establish a cause.'] : []),
    ...(source === 'A1 spread (fallback)' ? ['N is the A1 spread (fallback, §4.1), not the C hot1/hot2 spread. It contains any A1 rise, so it can exceed the noise: "reproduced" (>= 3 x (N - 1)) is harder to reach, and "not reproduced" (< 1.15) does not use N.'] : []),
  ];
}

// §5.2. `stopped` is a STOP reason when the stage ended early.
export function stage1(ms: Measurement[], stopped: string | null = null, stageMissing: string[] = []) {
  const N = noise(ms);
  const repro = reproduction(ms, minNoise, noiseSpreads(ms));
  const min = minimums(ms);
  const ev = evidence(ms, stageMissing);
  const abnormal = abnormalOf(stopped, Object.entries(min).filter(([, met]) => !met).map(([k]) => k), ev, ms);
  const kind = finishKindOf(stopped, ev, abnormal);
  const spreads = noiseSpreads(ms);
  const nComputable = spreads !== null && spreads.length > 0;
  const finish = {kind, shortfall: kind === 'normal' ? [] : abnormal, nSource: N.source, nComputable,
    stage2: kind === 'normal' ? 'with its own go' : kind === 'limited' && nComputable ? 'only with its own go naming this limited Stage 1' : 'refused',
    stage2Constraints: kind === 'blocked' ? [] : stage2Constraints(kind, N.source, abnormal)};
  const base = {noise: N, reproduction: repro, minimums: min, stopped, evidence: ev, abnormal, finish};
  // One direction for Stage 2 (sol review of the re-approval fix): a finish that refuses Stage 2 is never
  // also a proposal for it.
  const next = (proposal: 'propose' | 'may be skipped') => finish.stage2 === 'refused' ? 'refused' as const : proposal;
  // A STOP before the A1 minimum leaves reproduction inconclusive; after it, the A1 result stands.
  // Incomplete evidence is inconclusive whatever the numbers say: no cause from partial evidence.
  if (!ev.complete) return {...base, outcome: 'inconclusive' as Outcome, inconclusiveReason: 'evidence incomplete', attribution: null, repetitionLinked: false, stage2: next('propose')};
  if (repro.result !== 'reproduced') {
    const outcome: Outcome = repro.result === 'not reproduced' ? 'not reproduced' : 'inconclusive';
    return {...base, outcome, attribution: null, repetitionLinked: false, stage2: next('propose')};
  }
  const att = attribution(ms, N.value);
  const verdicts = Object.values(att);
  // "Repetition-linked" (§4.3): the rise grows with round count (reproduced) and H1-H5 are ruled out. Its
  // outcome is "repetition-linked, cause not established" whatever the H6 position verdict, H6 supported
  // alone included (maintainer decision on PR #871, re-approval question 3): Stage 1 tests only the position
  // part of H6, and nothing is attributed by elimination alone.
  const repetitionLinked = (['H1', 'H2', 'H3', 'H4', 'H5'] as const).every(h => att[h] === 'ruled out');
  const established = !repetitionLinked && verdicts.filter(v => v === 'supported').length === 1 && verdicts.every(v => v !== 'withheld');
  const outcome: Outcome = established ? 'cause established' : repetitionLinked ? 'repetition-linked, cause not established' : 'cause not established';
  return {...base, outcome, attribution: att, repetitionLinked, stage2: next(established ? 'may be skipped' : 'propose')};
}

// The smoke passes only when its single round ran, is valid and saved all of its evidence; its numbers are not used.
export function smoke(ms: Measurement[], stopped: string | null, stageMissing: string[] = []) {
  const ev = evidence(ms, stageMissing);
  const unmet = ms.length === 1 && ms[0].invalid.length === 0 ? [] : ['one valid smoke round'];
  const abnormal = abnormalOf(stopped, unmet, ev, ms);
  return {note: 'SMOKE: numbers are not used', evidence: ev, abnormal, outcome: abnormal.length ? 'smoke failed' : 'smoke passed'};
}

// §6, stated in every judgement so a standalone record cannot be read as ruling out the OS page cache.
export const cacheConstraint = {
  statement: 'No privileged container and no drop_caches. Restart-only empties PostgreSQL shared buffers only; the OS page cache may still hold the relation files, so it is not a cold-cache measurement. The OS cache state is recorded, not controlled.',
  h1Scope: 'H1 covers shared-buffer state and whether reads reach the OS. A cause in the OS page cache alone is withheld, never ruled out.',
};

// §5.3 Stage 2, as written: G95(first round after the scan) / G95(the first round), so B.post1 against
// B.pre, never a later post-scan round in its place (an INVALID B.post1 is inconclusive). Reproduced when the
// ratio is >= 1.30 and >= 3 x (N - 1), not reproduced when it is < 1.15, with Stage 1's recorded N.
export type Noise = {value: number; source: 'C hot1/hot2' | 'A1 spread (fallback)'};
// Stage 1's N for Stage 2: the recorded value and source, and the exact spreads behind it, recomputed from
// Stage 1's stored p95s (review round 7), so the threshold never uses the rounded double.
// `stage1` is how Stage 1 ended, what it fell short of, and the constraints that carries into Stage 2.
export type Stage1N = Noise & {spreads: Root[]; stage1: {kind: 'normal' | 'limited'; shortfall: string[]; constraints: string[]}};
export function stage2(ms: Measurement[], stage1N: Stage1N, stopped: string | null = null, stageMissing: string[] = []) {
  const noise: Noise = {value: stage1N.value, source: stage1N.source};
  const pre = byId(ms, 'B.pre');
  const first = byId(ms, 'B.post1');
  const post = validIds(ms, ['B.post1', 'B.post2', 'B.post3']);
  const cool = validIds(ms, ['B.cool1', 'B.cool2']);
  const ev = evidence(ms, stageMissing);
  const unmet = [...(!valid(pre) ? ['B.pre'] : []), ...(post.length < 2 ? ['2 of 3 post-scan rounds'] : []),
    ...(cool.length < 2 ? ['both cool-down rounds'] : []), ...(!valid(first) ? ['B.post1 (the §5.3 contrast)'] : [])];
  const base = {noise, stage1: stage1N.stage1, stopped, evidence: ev, abnormal: abnormalOf(stopped, unmet, ev, ms)};
  if (!ev.complete) return {...base, result: 'inconclusive' as const, reason: 'evidence incomplete', ratio: null};
  if (!valid(pre) || post.length < 2 || cool.length < 2) return {...base, result: 'inconclusive' as const, reason: 'Stage 2 minimum not met', ratio: null};
  if (!valid(first)) return {...base, result: 'inconclusive' as const, reason: 'B.post1 INVALID', ratio: null};
  const value = G(first) / G(pre);
  const [gp, gq] = [g95Root(first), g95Root(pre)];
  if (gp === null || gq === null) return {...base, result: 'inconclusive' as const, reason: 'a G95 is missing', ratio: value};
  // Decided exactly on the stored p95s (exact.ts); the double is reported. With N = max(1.05, spreads),
  // ratio >= 3 (N - 1) is ratio >= 3 x 0.05 and ratio + 3 >= 3 x spread for each exact spread.
  const R = ratio(gp, gq);
  const noiseMet = atLeast(R, q(3, 20)) && stage1N.spreads.every(s => sumAtLeast(R, q(3), q(3), s) === true);
  if (atLeast(R, q(13, 10)) && noiseMet) return {...base, result: 'reproduced' as const, ratio: value};
  if (below(R, q(23, 20))) return {...base, result: 'not reproduced' as const, ratio: value};
  return {...base, result: 'inconclusive' as const, reason: 'between the thresholds', ratio: value};
}
