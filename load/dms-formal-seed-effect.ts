// The instrumentation's effect on the seed (#426): the matched comparison of a seed diagnostic run (instrumented arm,
// `--seed-diagnostic`) with a baseline run (`--seed-diagnostic-baseline`: the formal seed, the formal DB command and no
// samplers) under the same conditions. It reports the differences only; it sets no threshold and judges nothing.
// Usage: node load/dms-formal-seed-effect.ts [--rehearsal] <instrumented output> <baseline output>  (prints JSON)
// Pair evidence comes from two full-size arms only. --rehearsal compares two rehearsal arms (#920) to rehearse this step;
// its status is never `compared`. A rehearsal arm and a full arm are never compared.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

type Batches = { medianMs: number | null; batches: number; medianBatches: number };
type ArmSummary = { arm?: string; rehearsal?: boolean; infrastructureFailure?: boolean; seedStop?: unknown; collectionFailures?: string[];
  conditions?: Record<string, unknown>; overhead?: { seedSeconds?: number; batches?: Batches | null } };
// Conditions that must be identical. The image and harness digests are recorded in each summary but not required to
// match: a rebuild or a new archive of the same SHA can change them without changing the seed.
export const matchedConditions = ['sha', 'machine', 'load', 'limits', 'scenario', 'mode', 'postgres', 'shape'] as const;

const armFigures = (summary: ArmSummary) => ({ seedSeconds: summary.overhead?.seedSeconds ?? null, medianBatchMs: summary.overhead?.batches?.medianMs ?? null,
  batches: summary.overhead?.batches?.batches ?? null });
const ratio = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : Math.round((a / b) * 10_000) / 10_000;

// Compared only when both arms exist, completed every expected batch without a stop or a collection failure, and ran
// under the matched conditions; otherwise unevaluated, with every reason.
export function compareSeedArms(instrumented: ArmSummary | undefined, baseline: ArmSummary | undefined, { rehearsal = false } = {}) {
  const reasons: string[] = [];
  for (const [name, summary, arm] of [['instrumented', instrumented, 'instrumented'], ['baseline', baseline, 'baseline']] as const) {
    if (!summary) { reasons.push(`${name} arm summary missing`); continue; }
    if (summary.arm !== arm) reasons.push(`${name} summary is not the ${arm} arm`);
    if (!rehearsal && summary.rehearsal !== undefined) reasons.push(`${name} arm is a rehearsal, never pair evidence`);
    if (rehearsal && summary.rehearsal !== true) reasons.push(`${name} arm is not a rehearsal`);
    if (summary.infrastructureFailure !== false || summary.seedStop || (summary.collectionFailures ?? ['missing']).length)
      reasons.push(`${name} arm did not complete its seed and collection`);
    if (typeof summary.overhead?.seedSeconds !== 'number' || typeof summary.overhead?.batches?.medianMs !== 'number') reasons.push(`${name} arm has no seed timing`);
  }
  if (instrumented?.conditions && baseline?.conditions) {
    for (const key of matchedConditions) if (!isDeepStrictEqual(instrumented.conditions[key], baseline.conditions[key])) reasons.push(`conditions differ: ${key}`);
  } else if (instrumented && baseline) reasons.push('run conditions missing');
  if (instrumented && baseline && (instrumented.rehearsal === true) !== (baseline.rehearsal === true)) reasons.push('a rehearsal arm and a full-size arm are never compared');
  const figures = { instrumented: instrumented ? armFigures(instrumented) : null, baseline: baseline ? armFigures(baseline) : null };
  const marked = rehearsal ? { rehearsal: true as const, evidence: 'Rehearsal of the run path only; never pair evidence.' } : {};
  if (reasons.length) return { status: 'unevaluated' as const, ...marked, reasons, ...figures };
  const a = figures.instrumented!, b = figures.baseline!;
  return { status: rehearsal ? 'rehearsal-compared' as const : 'compared' as const, ...marked, reasons, ...figures,
    medianBatchDeltaMs: Math.round((a.medianBatchMs! - b.medianBatchMs!) * 1000) / 1000, medianBatchRatio: ratio(a.medianBatchMs, b.medianBatchMs),
    seedSecondsDelta: Math.round((a.seedSeconds! - b.seedSeconds!) * 1000) / 1000, seedSecondsRatio: ratio(a.seedSeconds, b.seedSeconds) };
}

export const readSummary = (directory: string): ArmSummary | undefined => {
  try { return JSON.parse(readFileSync(`${directory}/summary.json`, 'utf8')) as ArmSummary; } catch { return undefined; }
};

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2), rehearsal = args[0] === '--rehearsal', [instrumented, baseline] = rehearsal ? args.slice(1) : args;
  if (!instrumented || !baseline) {
    console.error('Usage: dms-formal-seed-effect.ts [--rehearsal] <instrumented output> <baseline output> (--rehearsal: two rehearsal arms, '
      + 'never pair evidence)');
    process.exitCode = 1;
  } else console.log(JSON.stringify(compareSeedArms(readSummary(instrumented), readSummary(baseline), { rehearsal }), null, 2));
}
