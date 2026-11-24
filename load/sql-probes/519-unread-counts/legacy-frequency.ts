import { exactFraction, type BlockThermal } from '../../harness-core/thermal.ts';
import { below, keepFrequency, medianRatio, type Ratio } from './frequency-ratios.ts';

const activity = { minTickShare: 0.5, minCpuShare: 0.5 };
type CpuSet = 'server' | 'client';

// The qualifying CPUs of a set in a block (F3), by CPU number with twice their block value (the sum
// of the two middle active readings), so ratios stay exact integers.
// n / total >= share, in integers (no rounding at the boundary).
const atLeast = (n: number, total: number, share: number) => { const [a, b] = exactFraction(share); return BigInt(n) * b >= a * BigInt(total); };
function qualifying(t: BlockThermal, set: CpuSet): Map<number, bigint> {
  return new Map(t[set].cpus.flatMap(c => (c.mid !== null && atLeast(c.activeTicks, t.ticks, activity.minTickShare) ? [[c.cpu, BigInt(c.mid[0]) + BigInt(c.mid[1])] as const] : [])));
}

// A ratio rounded down to 4 decimals, so a printed "x < limit" is always true.
const floor4 = (r: Ratio) => (Number((r[0] * 10_000n) / r[1]) / 10_000).toFixed(4);

// F4 and F5 for one set over the run's blocks. The baseline is block 1 itself: without it nothing is
// compared and the run is INVALID. An empty or malformed set is INVALID, never judged as passing.
export function legacyFrequencyProblems(blocks: { order: number; thermal: BlockThermal }[], set: CpuSet, cpus: number[]): string[] {
  const size = cpus.length;
  if (size === 0 || new Set(cpus).size !== size || !cpus.every(c => Number.isSafeInteger(c) && c >= 0)) return [`${set} set is empty or not distinct CPU numbers: [${cpus.join(',')}]`];
  const p: string[] = [];
  const enough = (n: number) => atLeast(n, size, activity.minCpuShare);
  const judgeable = blocks.map(b => {
    const a = b.thermal[set];
    if (a.problem !== null) { p.push(`block ${b.order}: ${set} set: ${a.problem}`); return null; }
    const q = qualifying(b.thermal, set);
    if (!enough(q.size)) { p.push(`block ${b.order}: too few active CPUs to judge frequency, ${set} set ${q.size} of ${size} qualify`); return null; }
    return q;
  });
  const i1 = blocks.findIndex(b => b.order === 1);
  if (i1 < 0) return [...p, `${set} set: no block 1 to compare frequency with`];
  const base = judgeable[i1];
  if (!base) return p; // block 1 is already INVALID; nothing to compare with
  for (const [i, b] of blocks.entries()) {
    const got = judgeable[i];
    if (i === i1 || !got) continue;
    const ratios = [...got].flatMap(([cpu, v]): Ratio[] => (base.has(cpu) ? [[v, base.get(cpu)!]] : []));
    if (!enough(ratios.length)) { p.push(`block ${b.order}: ${set} set: ${ratios.length} of ${size} CPUs qualify in both block 1 and this block, too few to compare`); continue; }
    const m = medianRatio(ratios);
    if (below(m, keepFrequency)) p.push(`block ${b.order}: throttled, ${set} median per-CPU ratio ${floor4(m)} < 0.95 of block 1 (${ratios.length} CPUs)`);
  }
  return p;
}

