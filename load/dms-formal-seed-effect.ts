// The instrumentation's effect on the seed (#426): the matched comparison of a seed diagnostic run (instrumented arm,
// `--seed-diagnostic`) with a baseline run (`--seed-diagnostic-baseline`: the formal seed, the formal DB command and no
// samplers) under the same conditions. It reports the differences only; it sets no threshold and judges nothing.
// Usage: node load/dms-formal-seed-effect.ts <instrumented output> <baseline output>  (prints the comparison as JSON)
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

type Batches = { medianMs: number | null; batches: number; medianBatches: number };
type ArmSummary = { arm?: string; infrastructureFailure?: boolean; seedStop?: unknown; collectionFailures?: string[];
  conditions?: Record<string, unknown>; overhead?: { seedSeconds?: number; batches?: Batches | null } };
// Conditions that must be identical. The image and harness digests are recorded in each summary but not required to
// match: a rebuild or a new archive of the same SHA can change them without changing the seed.
export const matchedConditions = ['sha', 'machine', 'load', 'limits', 'scenario', 'mode', 'postgres', 'shape'] as const;

const armFigures = (summary: ArmSummary) => ({ seedSeconds: summary.overhead?.seedSeconds ?? null, medianBatchMs: summary.overhead?.batches?.medianMs ?? null,
  batches: summary.overhead?.batches?.batches ?? null });
const ratio = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : Math.round((a / b) * 10_000) / 10_000;

// Compared only when both arms exist, completed every expected batch without a stop or a collection failure, and ran
// under the matched conditions; otherwise unevaluated, with every reason.
export function compareSeedArms(instrumented: ArmSummary | undefined, baseline: ArmSummary | undefined) {
  const reasons: string[] = [];
  for (const [name, summary, arm] of [['instrumented', instrumented, 'instrumented'], ['baseline', baseline, 'baseline']] as const) {
    if (!summary) { reasons.push(`${name} arm summary missing`); continue; }
    if (summary.arm !== arm) reasons.push(`${name} summary is not the ${arm} arm`);
    if (summary.infrastructureFailure !== false || summary.seedStop || (summary.collectionFailures ?? ['missing']).length)
      reasons.push(`${name} arm did not complete its seed and collection`);
    if (typeof summary.overhead?.seedSeconds !== 'number' || typeof summary.overhead?.batches?.medianMs !== 'number') reasons.push(`${name} arm has no seed timing`);
  }
  if (instrumented?.conditions && baseline?.conditions) {
    for (const key of matchedConditions) if (!isDeepStrictEqual(instrumented.conditions[key], baseline.conditions[key])) reasons.push(`conditions differ: ${key}`);
  } else if (instrumented && baseline) reasons.push('run conditions missing');
  const figures = { instrumented: instrumented ? armFigures(instrumented) : null, baseline: baseline ? armFigures(baseline) : null };
  if (reasons.length) return { status: 'unevaluated' as const, reasons, ...figures };
  const a = figures.instrumented!, b = figures.baseline!;
  return { status: 'compared' as const, reasons, ...figures,
    medianBatchDeltaMs: Math.round((a.medianBatchMs! - b.medianBatchMs!) * 1000) / 1000, medianBatchRatio: ratio(a.medianBatchMs, b.medianBatchMs),
    seedSecondsDelta: Math.round((a.seedSeconds! - b.seedSeconds!) * 1000) / 1000, seedSecondsRatio: ratio(a.seedSeconds, b.seedSeconds) };
}

const readSummary = (directory: string): ArmSummary | undefined => {
  try { return JSON.parse(readFileSync(`${directory}/summary.json`, 'utf8')) as ArmSummary; } catch { return undefined; }
};

if (process.argv[1] === import.meta.filename) {
  const [instrumented, baseline] = process.argv.slice(2);
  if (!instrumented || !baseline) { console.error('Usage: dms-formal-seed-effect.ts <instrumented output> <baseline output>'); process.exitCode = 1; }
  else console.log(JSON.stringify(compareSeedArms(readSummary(instrumented), readSummary(baseline)), null, 2));
}
