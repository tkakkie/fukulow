import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestRank, nearestRankIndex, type OutOfRange } from './nearest-rank.ts';
import { percentile as dmsWorkload } from '../dms-workload.ts';
import { percentile as hotLatency } from '../hot-latency.ts';
import { distributions as moveDistributions } from '../move/diagnostic-evidence.ts';
import { stats as replyCountsStats } from '../reply-counts-model.ts';
import { percentile as revocationBurst } from '../revocation-burst-judgment.ts';
import { distribution as signinDistribution } from '../signin-summary.ts';
import { quantile as probe519 } from '../sql-probes/519-unread-counts/probe.ts';
import { quantiles as replay515 } from '../sql-probes/515-replay/measure.ts';
import { percentile as unreadInit } from '../unread-init/model.ts';

test('nearest rank is the smallest sample with at least the fraction at or below it', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual([0.01, 0.1, 0.11, 0.5, 0.95, 0.99, 1].map(f => nearestRank(ten, f)), [1, 1, 2, 5, 10, 10, 10]);
  assert.equal(nearestRank([7], 0.5), 7);
  assert.equal(nearestRank([1, 2], 0.5), 1);
  assert.equal(nearestRank([1, 2, 2, 9], 0.75), 2);
});

test('nearest rank over 100 samples picks the p-th sample on both scales', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  for (const p of [1, 29, 50, 95, 99, 100]) assert.equal(nearestRank(hundred, p / 100), p);
  // With 101 samples p99 is the 100th; with 99 samples it is the slowest.
  assert.equal(nearestRank(Array.from({ length: 101 }, (_, i) => i), 0.99), 99);
  assert.equal(nearestRank(Array.from({ length: 99 }, (_, i) => i), 0.99), 98);
});

test('nearest rank equals the inline formula harnesses use today on the same input', () => {
  for (let n = 1; n <= 257; n++) {
    const sorted = Array.from({ length: n }, (_, i) => i * 7 + (i % 3));
    for (const fraction of [0.001, 0.05, 0.25, 0.29, 0.5, 0.57, 0.9, 0.95, 0.99, 0.999, 1]) {
      const clamped = sorted[Math.min(n - 1, Math.max(0, Math.ceil(fraction * n) - 1))];
      assert.equal(nearestRank(sorted, fraction), clamped, `n=${n} fraction=${fraction}`);
    }
    for (const p of [5, 29, 50, 95, 99]) {
      const percentScale = sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
      assert.equal(nearestRank(sorted, p / 100), percentScale, `n=${n} p=${p}`);
    }
  }
});

test('empty input is undefined so each harness wrapper chooses its own empty result', () => {
  assert.equal(nearestRank([], 0.5), undefined);
  assert.equal(nearestRank([], 1), undefined);
});

test('a fraction outside (0, 1] or unsorted input throws', () => {
  for (const bad of [0, -0.1, 1.01, 99, Number.NaN]) assert.throws(() => nearestRank([1, 2], bad), RangeError);
  assert.throws(() => nearestRank([], 0), RangeError);
  assert.throws(() => nearestRank([2, 1], 0.5), /not sorted ascending/);
  assert.throws(() => nearestRank([1, 3, 2, 4], 1), /not sorted ascending/);
});

// Same-input equality against every existing copy, through the thin wrapper each harness would keep:
// its out-of-range mode, its scale and its empty-input result. Copies that are exported are imported;
// private ones are reproduced verbatim with their location.
const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);
const inputs: number[][] = [[], [7], [2, 1], [3, 1, 2], [5, 5, 1, 9], ...Array.from({ length: 37 }, (_, n) => Array.from({ length: n + 4 }, (_, i) => (i * 37) % (n + 5) + (i % 3) / 4))];
const fractions = [Number.NEGATIVE_INFINITY, -0.5, 0, Number.MIN_VALUE, 0.001, 0.25, 0.29, 0.5, 0.95, 0.99, 1, 1 + Number.EPSILON, 1.1, 2, Number.POSITIVE_INFINITY, Number.NaN];
const percents = [-5, 0, 0.1, 25, 29, 50, 95, 99, 100, 100.5, 110, Number.NaN];
const outcome = (run: () => unknown) => { try { return { value: run() }; } catch (error) { return { threw: (error as Error).message }; } };
const same = (name: string, old: () => unknown, kit: () => unknown) => assert.deepEqual(outcome(kit), outcome(old), name);

test('kit wrappers equal the clamping copies on every input, including out-of-range fractions and empty input', () => {
  for (const values of inputs) {
    const sorted = ascending(values), at = `[${values}]`;
    for (const f of fractions) {
      // sql-probes/519-unread-counts/probe.ts quantile: clamp both sides, empty throws.
      same(`519 ${at} ${f}`, () => probe519(values, f), () => { if (!values.length) throw new Error('no samples'); return nearestRank(ascending(values), f, 'clamp'); });
      // dms-workload.ts percentile: clamp above only, empty null.
      same(`dms ${at} ${f}`, () => dmsWorkload(values, f), () => values.length ? nearestRank(ascending(values), f, 'clamp-high') : null);
      // unread-init/model.ts percentile: clamp below only, empty throws.
      same(`unread ${at} ${f}`, () => unreadInit(values, f), () => { if (!values.length) throw new Error('empty distribution'); return nearestRank(ascending(values), f, 'clamp-low'); });
      // log-compare/measure.ts percentile (private): clamp below only, out of range or empty 0.
      same(`log-compare ${at} ${f}`, () => sorted[Math.max(0, Math.ceil(sorted.length * f) - 1)] ?? 0, () => nearestRank(sorted, f, 'clamp-low') ?? 0);
      // web/scripts/aggregate-wasm-core.ts (private): either scale, clamp both sides, empty 0.
      const aggregate = (q: number) => { if (values.length === 0) return 0; const ratio = q > 1 ? q / 100 : q; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))]; };
      same(`aggregate ${at} ${f}`, () => aggregate(f), () => values.length === 0 ? 0 : nearestRank(sorted, f > 1 ? f / 100 : f, 'clamp'));
    }
    for (const p of percents) {
      // hot-latency.ts percentile: percent scale, clamp both sides, empty throws.
      same(`hot-latency ${at} ${p}`, () => hotLatency(sorted, p), () => { if (!sorted.length) throw new Error('no samples'); return nearestRank(sorted, p / 100, 'clamp'); });
      // revocation-burst-judgment.ts percentile: percent scale, clamp above only, empty NaN.
      same(`revocation ${at} ${p}`, () => revocationBurst(values, p), () => values.length ? nearestRank(ascending(values), p / 100, 'clamp-high') : Number.NaN);
      // web/scripts/first-paint.ts nearestRank (private): percent scale, clamp both sides, 2 decimals, empty throws.
      const firstPaint = () => Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!.toFixed(2));
      same(`first-paint ${at} ${p}`, firstPaint, () => { const v = nearestRank(sorted, p / 100, 'clamp'); if (v === undefined) throw new TypeError("Cannot read properties of undefined (reading 'toFixed')"); return Number(v.toFixed(2)); });
    }
  }
});

test('kit wrappers equal the fixed-fraction copies, including each empty-input outcome', () => {
  for (const values of inputs) {
    const sorted = ascending(values), at = `[${values}]`;
    // sql-probes/515-replay/measure.ts quantiles: no clamping, empty or invalid samples throw.
    same(`515-replay ${at}`, () => replay515(values), () => { if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) throw new Error('Invalid latency samples'); return { n: sorted.length, p50: nearestRank(sorted, 0.5, 'none'), p95: nearestRank(sorted, 0.95, 'none') }; });
    // signin-summary.ts distribution: no clamping, empty null.
    same(`signin ${at}`, () => signinDistribution(values), () => ({ count: sorted.length, ...Object.fromEntries((['p50', 'p95', 'p99'] as const).map((k, i) => [k, sorted.length ? nearestRank(sorted, [0.5, 0.95, 0.99][i]!, 'none') : null])) }));
    // move/diagnostic-evidence.ts distributions: no clamping, empty null.
    same(`move ${at}`, () => moveDistributions(values), () => ({ count: sorted.length, p50: nearestRank(sorted, 0.5, 'none') ?? null, p95: nearestRank(sorted, 0.95, 'none') ?? null, p99: nearestRank(sorted, 0.99, 'none') ?? null, max: sorted.at(-1) ?? null }));
    // reply-counts-model.ts stats: no clamping, empty throws.
    same(`reply-counts ${at}`, () => replyCountsStats(values), () => { if (!values.length) throw new Error('invalid latency samples'); return { n: values.length, p50: nearestRank(sorted, 0.5, 'none'), p95: nearestRank(sorted, 0.95, 'none'), p99: nearestRank(sorted, 0.99, 'none'), max: sorted.at(-1)! }; });
  }
});

test('the sql-probes/515-replay wrapper keeps its empty and invalid-sample checks', () => {
  for (const bad of [[], [1, Number.NaN], [1, -1], [Number.POSITIVE_INFINITY]]) {
    assert.throws(() => replay515(bad), /Invalid latency samples/, `[${bad}]`);
  }
});

test('the sql-probes/515-app whole-sample rank with an ID tie-break goes through nearestRankIndex', () => {
  type Row = { id: number; httpMs: number };
  // sql-probes/515-app/results.ts atHttpRank (private), verbatim.
  const old = (samples: Row[], rank: number) => { const rows = [...samples].sort((a, b) => a.httpMs - b.httpMs || a.id - b.id); return rows[Math.ceil(rows.length * rank) - 1]; };
  const kit = (samples: Row[], rank: number) => { const rows = [...samples].sort((a, b) => a.httpMs - b.httpMs || a.id - b.id); const i = nearestRankIndex(rows.length, rank, 'none'); return i === undefined ? undefined : rows[i]; };
  for (const values of inputs) {
    const rows = values.map((httpMs, i) => ({ id: (i * 7) % (values.length + 1), httpMs: Math.round(httpMs) }));
    for (const rank of [...fractions, 0.5, 0.95]) assert.equal(kit(rows, rank), old(rows, rank), `[${values}] ${rank}`);
  }
});

test('each out-of-range mode on [1, 2]: fraction 0, above 1 and NaN', () => {
  const modes: OutOfRange[] = ['clamp', 'clamp-low', 'clamp-high', 'none'];
  assert.deepEqual(modes.map(m => [0, 1.1, Number.NaN].map(f => nearestRank([1, 2], f, m))),
    [[1, 2, undefined], [1, undefined, undefined], [undefined, 2, undefined], [undefined, undefined, undefined]]);
  for (const m of modes) assert.equal(nearestRank([], 0.5, m), undefined, m);
  assert.equal(nearestRankIndex(0, 0, 'clamp'), undefined);
  assert.equal(nearestRankIndex(3, 2 / 3), 1);
  assert.deepEqual(['none', 'clamp-low'].map(m => nearestRankIndex(2, 1.1, m as OutOfRange)), [undefined, undefined]);
});
