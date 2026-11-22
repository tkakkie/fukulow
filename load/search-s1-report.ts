import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './search-m1-bodies.ts';
import {
  appShortfall, classify, completeRun, generatorInvalid, limiter, orders, pairedLatency, scenarios, sustained, workload,
  type Batch, type Identity, type Run, type Scenario, type StackIdentity, type Step,
} from './search-m1-report.ts';
import { bodyCount, bodySeed, poolSha256 } from './search-s1-bodies.ts';
import { overlaySource, validTermCheck, type S1Functions, type TermCheck } from './search-s1-evidence.ts';

export type S1Mode = 'smoke' | 'rehearsal' | 'formal';
export const productCommit = '3d61902e482ee9935ee0859b2c359590324a86d3';
export const s1Node = 'v26.13.1';
export const s1DbSettings = { shared_preload_libraries: 'pg_stat_statements', 'pg_stat_statements.track': 'all' };
export const expectedS1DbSettings = { ...s1DbSettings, fsync: 'on', wal_level: 'replica', synchronous_commit: 'on' };
const s1Rates = [50, 100, 250];
export const s1Workload = (scenario: Scenario, mode: S1Mode) => ({
  ...workload(scenario, mode !== 'formal'), rates: mode === 'formal' ? s1Rates : [50],
});
export const s1Orders = (mode: S1Mode) => mode === 'formal' ? orders : [orders[0]];
export const s1Scenarios = (mode: S1Mode) => mode === 'formal' ? scenarios : ['many'] as const;

export type S1Overlay = { arm: Run['arm']; originalSha256: string; definitionSha256: string; overlaySha256: string; searchEngine: string };
export type S1Stack = StackIdentity<S1Overlay>;
export type S1Run = Run<S1Overlay> & { termCheck?: TermCheck; normalizedBodies?: number };
export type S1Metadata = S1Functions & {
  mode: S1Mode; node: string; k6Version: string; bodySize: number;
  expected: Omit<Identity<S1Overlay>, 'workload' | 'overlay'>;
};
type Judgement = 'PASS' | 'FAIL' | 'NOT EVALUATED';

const recordedMetrics = (step: Step) => ({
  ...step, successRate: step.offered ? step.accepted / step.offered : null,
});

export function s1Report(metadata: S1Metadata, batch: Batch<S1Run>, bodyHash: string | null) {
  const { mode, node, k6Version, expected, originalTermsSha256, overlaidTermsSha256 } = metadata;
  const { k6Image, bodySeed: expectedSeed, bodySha256, ...expectedStack } = expected;
  const active = s1Scenarios(mode);
  const planned = active.flatMap(scenario =>
    s1Orders(mode).flatMap((arms, index) => arms.map(arm => ({ pair: index + 1, arm, scenario }))));
  const problems = [...batch.errors];
  const hash = (value: string | undefined) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (expected.commit !== productCommit || expected.appImage !== expected.migrateImage ||
      ![expected.appImage, expected.dbImage, k6Image].every(value => /^sha256:[0-9a-f]{64}$/.test(value)) ||
      !isDeepStrictEqual(expected.limiter, limiter) || !isDeepStrictEqual(expected.dbSettings, expectedS1DbSettings) ||
      bodyHash !== poolSha256 || bodySha256 !== poolSha256 || expectedSeed !== bodySeed || metadata.bodySize !== bodyCount ||
      !isDeepStrictEqual(metadata.overlay, overlaySource()) || node !== s1Node || typeof k6Version !== 'string' || !k6Version.trim() ||
      !hash(originalTermsSha256) || !hash(overlaidTermsSha256) || originalTermsSha256 === overlaidTermsSha256) {
    problems.push('Run identity mismatch');
  }
  if (batch.imageCleanupVerified !== true) problems.push('Image cleanup unverified');
  const seen = [...batch.runs].sort((a, b) => a.sequence - b.sequence);
  if (seen.length !== planned.length || seen.some((run, index) => run.sequence !== index + 1 ||
      !isDeepStrictEqual({ pair: run.pair, arm: run.arm, scenario: run.scenario }, planned[index]))) {
    problems.push('Arm-run sequence does not match the approved pair order');
  }
  const runs = seen.map(run => {
    const errors = [...run.errors];
    const conditions = s1Workload(run.scenario, mode);
    const overlay = { arm: run.arm, searchEngine: 'disabled', overlaySha256: metadata.overlay?.sha256,
      originalSha256: originalTermsSha256, definitionSha256: run.arm === 'A' ? originalTermsSha256 : overlaidTermsSha256 };
    const stack = { ...expectedStack, overlay };
    if (!isDeepStrictEqual(run.identity, { ...stack, k6Image, bodySeed, bodySha256, workload: conditions }) ||
        !isDeepStrictEqual(run.finalStack, stack) || run.normalizedBodies !== bodyCount) errors.push('Arm-run identity mismatch');
    if (run.cleanupVerified !== true) errors.push('Arm-run cleanup unverified');
    if (!completeRun(run, conditions)) {
      errors.push('Incomplete arm-run evidence');
    }
    if (!validTermCheck(run.termCheck, run.totals?.accepted ?? -1, run.arm)) errors.push('Message term count mismatch');
    const steps = run.steps.map(step => {
      const classification = classify(step, !errors.length && !problems.length);
      return { ...recordedMetrics(step), classification: classification === generatorInvalid ? 'generator-side shortfall' : classification };
    });
    return { ...run, problems: errors, totals: run.totals && {
      ...run.totals, successRate: run.totals.offered ? run.totals.accepted / run.totals.offered : null,
    }, steps };
  });

  const results = active.map(scenario => {
    const armRuns = runs.filter(run => run.scenario === scenario);
    const byRate = (arm: Run['arm'], rate: number) => armRuns.filter(run => run.arm === arm)
      .map(run => run.steps.find(step => step.rate === rate)!);
    const valid = !problems.length && armRuns.every(run => !run.problems.length);
    const comparisonRates = mode === 'formal' && valid ?
      s1Rates.filter(rate => byRate('B', rate).every(step => step.classification === sustained)) : [];
    const comparisons = comparisonRates.map(rate => {
      const a = byRate('A', rate);
      const b = byRate('B', rate);
      if (a.some(step => step.classification === appShortfall)) {
        return { rate, judgement: 'FAIL', reason: 'A had a failed send' } as const;
      }
      if (a.some(step => step.classification !== sustained)) {
        return { rate, judgement: 'NOT EVALUATED', reason: 'A had a generator-side shortfall' } as const;
      }
      const latency = pairedLatency(a.map(step => step.sendMs.p95!), b.map(step => step.sendMs.p95!));
      const judgement: Judgement = latency.medianRatio <= 1.25 && latency.medianDifferenceMs <= 5 ? 'PASS' : 'FAIL';
      return { rate, ...latency, judgement };
    });
    const reason = !valid ? 'INVALID run' : mode !== 'formal' ? `${mode} is never evidence` :
      !comparisons.length ? 'B sustained no step in all three pairs' :
        comparisons.some(result => result.judgement === 'NOT EVALUATED') ? 'A had a generator-side shortfall at a comparison step' : undefined;
    const judgement: Judgement = reason ? 'NOT EVALUATED' : overall(comparisons);
    return { scenario, judgement, reason, comparisonRates, comparisons, runs: armRuns };
  });
  return { mode, evidence: mode === 'formal' && !problems.length && runs.every(run => !run.problems.length),
    judgement: overall(results), problems, scenarios: results };
}

function overall(results: { judgement: Judgement }[]): Judgement {
  if (results.some(result => result.judgement === 'FAIL')) return 'FAIL';
  return results.every(result => result.judgement === 'PASS') ? 'PASS' : 'NOT EVALUATED';
}

export function writeS1Report(dir: string) {
  const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as S1Metadata;
  const batch = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')) as Batch<S1Run>;
  let bodyHash: string | null = null;
  try { bodyHash = sha256(readFileSync(join(dir, 'bodies.json'))); } catch { /* Missing body evidence invalidates the run. */ }
  const report = s1Report(metadata, batch, bodyHash);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, (_, value) => value === Infinity ? 'Infinity' : value, 2) + '\n');
  return report;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: node load/search-s1-report.ts <dir>');
  console.log(writeS1Report(process.argv[2]).judgement);
}
