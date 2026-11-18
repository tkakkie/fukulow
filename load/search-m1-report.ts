import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileSha256 } from './search-m1-bodies.ts';

export const scenarios = ['many', 'hot'] as const;
export const rates = [50, 100, 250, 500, 1000, 2000, 4000];
export const orders = [['B', 'A'], ['A', 'B'], ['B', 'A']] as const;
export const limiterNote = 'send limiter raised for this Mac-relative comparison';
export const limiter = { LOAD_SEND_BURST: '1000000', LOAD_SEND_REFILL_PER_SECOND: '1000000' };

export type Scenario = typeof scenarios[number];
export type Arm = typeof orders[number][number];
export type Counts = {
  offered: number; droppedIterations: number; accepted: number; rejected429: number; rejected503: number;
  otherHttpErrors: number; clientTimeouts: number; transportErrors: number;
};
export type Latency = { p50: number | null; p95: number | null; p99: number | null };
export type Resources = {
  acceptedPerSecond: number; walBytesPerSend: number | null; appCpuPeakPercent: number;
  dbCpuPeakPercent: number; dbSizeGrowthBytes: number;
};
export type Step = Counts & { rate: number; seconds: number; sendMs: Latency; resources?: Resources };
export type StackIdentity = {
  commit: string; appImage: string; migrateImage: string; dbImage: string;
  limiter: typeof limiter; dbSettings: Record<string, string>; overlay: { storedBody: boolean; pgroongaIndex: boolean };
};
export type Identity = StackIdentity & { bodySha256: string; bodySeed: number; k6Image: string; workload: ReturnType<typeof workload> };
export type Run = {
  scenario: Scenario; pair: number; arm: Arm; identity?: Identity; finalStack?: StackIdentity;
  cleanupVerified: boolean; errors: string[]; steps: Step[];
  totals?: Counts & { sendMs: Latency; resources?: Resources };
};
export type Metadata = {
  smoke: boolean; expected: Omit<Identity, 'workload'>;
};
export type Batch = { runs: Run[]; imageCleanupVerified: boolean; errors: string[] };

export function workload(scenario: Scenario, smoke: boolean) {
  return { mode: scenario, channels: scenario === 'many' ? 200 : 1, members: 4, subscribers: 0,
    preAllocatedVUs: 20, maxVUs: 100, requestTimeoutSeconds: 3,
    rates: smoke ? [50] : rates, seconds: smoke ? 10 : 60 };
}

const outcomeKeys = ['accepted', 'rejected429', 'rejected503', 'otherHttpErrors', 'clientTimeouts', 'transportErrors'] as const;
export const countKeys = ['offered', 'droppedIterations', ...outcomeKeys] as const;
const sustained = 'sustained';
const appShortfall = 'app-side shortfall';
const generatorInvalid = 'generator-side shortfall INVALID';
const runInvalid = 'INVALID run';

function completeCounts(counts: Counts & { sendMs: Latency }) {
  if (!countKeys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      counts.offered !== outcomeKeys.reduce((sum, key) => sum + counts[key], 0)) return false;
  const { p50, p95, p99 } = counts.sendMs ?? {};
  if (counts.offered === 0) return p50 === null && p95 === null && p99 === null;
  return typeof p50 === 'number' && typeof p95 === 'number' && typeof p99 === 'number' &&
    p50 >= 0 && p50 <= p95 && p95 <= p99 && Number.isFinite(p99);
}

export function classify(step: Step, validRun: boolean) {
  if (!validRun || !completeCounts(step)) return runInvalid;
  if (outcomeKeys.slice(1).some(key => step[key] > 0)) return appShortfall;
  if (step.offered * 100 < 99 * step.rate * step.seconds || step.droppedIterations > 0) return generatorInvalid;
  return sustained;
}

function completeResources(resources: Resources | undefined, counts: Counts) {
  return !!resources && Number.isFinite(resources.acceptedPerSecond) && resources.acceptedPerSecond >= 0 &&
    (counts.accepted === 0 ? resources.walBytesPerSend === null :
      Number.isFinite(resources.walBytesPerSend) && resources.walBytesPerSend! >= 0) &&
    Number.isFinite(resources.appCpuPeakPercent) && resources.appCpuPeakPercent >= 0 &&
    Number.isFinite(resources.dbCpuPeakPercent) && resources.dbCpuPeakPercent >= 0 &&
    Number.isSafeInteger(resources.dbSizeGrowthBytes);
}

export function runProblems(run: Run, metadata: Metadata, bodyHash: string | null, imageCleanupVerified: boolean) {
  const problems = [...run.errors];
  const expectedWorkload = workload(run.scenario, metadata.smoke);
  const expected = { ...metadata.expected, overlay: { storedBody: true, pgroongaIndex: run.arm === 'A' } };
  const { bodySha256, bodySeed, k6Image, ...expectedStack } = expected;
  if (!bodyHash || bodyHash !== bodySha256 || !isDeepStrictEqual(expected.limiter, limiter) ||
      !isDeepStrictEqual(run.identity, { ...expected, workload: expectedWorkload }) || !isDeepStrictEqual(run.finalStack, expectedStack)) {
    problems.push('Run identity mismatch');
  }
  if (!run.cleanupVerified || !imageCleanupVerified) problems.push('Cleanup unverified');
  const totals = run.totals;
  if (!totals || !completeCounts(totals) || !completeResources(totals.resources, totals) ||
      !countKeys.every(key => totals[key] === run.steps.reduce((sum, step) => sum + step[key], 0)) ||
      run.steps.length !== expectedWorkload.rates.length ||
      run.steps.some((step, index) => step.rate !== expectedWorkload.rates[index] ||
        step.seconds !== expectedWorkload.seconds || !completeCounts(step) || !completeResources(step.resources, step))) {
    problems.push('Incomplete step or arm-run evidence');
  }
  return problems;
}

type ClassifiedStep = Partial<Step> & Pick<Step, 'rate' | 'seconds'> & { classification: ReturnType<typeof classify> };
type ClassifiedRun = Omit<Run, 'steps'> & { problems: string[]; steps: ClassifiedStep[] };

const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];

function judgeScenario(scenario: Scenario, runs: ClassifiedRun[], smoke: boolean) {
  const arms = (arm: Arm, rate: number) => orders.map((_, index) => {
    const matches = runs.filter(run => run.pair === index + 1 && run.arm === arm);
    return matches.length === 1 ? matches[0].steps.find(step => step.rate === rate) : undefined;
  });
  const allSustained = (arm: Arm) => rates.filter(rate => arms(arm, rate).every(step => step?.classification === sustained));
  const comparisonRates = allSustained('B');
  const bHighest = comparisonRates.at(-1) ?? null;
  const aHighest = allSustained('A').at(-1) ?? null;
  const invalid = (step: ReturnType<typeof arms>[number]) =>
    !step || step.classification === generatorInvalid || step.classification === runInvalid;
  const base = { scenario, comparisonRates, bHighest, aHighest, runs };
  const notEvaluated = (reason: string) => ({ ...base, judgement: 'NOT EVALUATED', reasons: [reason] });
  if (smoke) return notEvaluated('SMOKE / NON-EVALUATION');
  if (bHighest === null) return notEvaluated('B sustained no rate in all three pairs');
  if (comparisonRates.some(rate => arms('A', rate).some(invalid))) {
    return notEvaluated('A has an INVALID step at a comparison rate');
  }
  if (rates.some(rate => rate <= bHighest && arms('B', rate).some(invalid))) {
    return notEvaluated('B has an INVALID step at or below its highest sustained rate');
  }

  const reasons = comparisonRates.filter(rate => arms('A', rate).some(step => step?.classification === appShortfall))
    .map(rate => `A app-side shortfall at ${rate}/s`);
  const latency = comparisonRates.filter(rate => rate <= 1000).map(rate => {
    const pairs = arms('A', rate).map((a, index) => {
      const aMs = a!.sendMs!.p95!;
      const bMs = arms('B', rate)[index]!.sendMs!.p95!;
      return { aMs, bMs, ratio: bMs === 0 && aMs === 0 ? 1 : aMs / bMs, absoluteDifferenceMs: Math.abs(aMs - bMs) };
    });
    const medianRatio = median(pairs.map(pair => pair.ratio));
    const medianAbsoluteDifferenceMs = median(pairs.map(pair => pair.absoluteDifferenceMs));
    if (medianRatio > 1.25 && medianAbsoluteDifferenceMs > 5) reasons.push(`A send p95 exceeds both limits at ${rate}/s`);
    return { rate, pairs, medianRatio, medianAbsoluteDifferenceMs };
  });
  if (aHighest === null || aHighest < bHighest) reasons.push('A highest sustained rate is below B');
  return { ...base, latency, judgement: reasons.length ? 'Material impact' : 'No material impact', reasons };
}

export function report(metadata: Metadata, batch: Batch, bodyHash: string | null) {
  const runs = batch.runs.map((run): ClassifiedRun => {
    const problems = runProblems(run, metadata, bodyHash, batch.imageCleanupVerified);
    const { rates, seconds } = workload(run.scenario, metadata.smoke);
    return { ...run, problems, steps: rates.map(rate => {
      const step = run.steps.find(step => step.rate === rate);
      return step ? { ...step, classification: classify(step, !problems.length) } : { rate, seconds, classification: runInvalid };
    }) };
  });
  return { smoke: metadata.smoke, limiterNote, limiter, errors: batch.errors,
    scenarios: (metadata.smoke ? ['many'] as const : scenarios).map(scenario =>
      judgeScenario(scenario, runs.filter(run => run.scenario === scenario), metadata.smoke)) };
}

export function writeReport(dir: string) {
  const metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8')) as Metadata;
  const batch = JSON.parse(readFileSync(`${dir}/runs.json`, 'utf8')) as Batch;
  let bodyHash: string | null = null;
  try { bodyHash = fileSha256(`${dir}/bodies.json`); } catch { /* missing body evidence invalidates the run */ }
  const result = report(metadata, batch, bodyHash);
  writeFileSync(`${dir}/report.json`, JSON.stringify(result, (_, value) => value === Infinity ? 'Infinity' : value, 2) + '\n');
  return result;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: node load/search-m1-report.ts <dir>');
  const result = writeReport(process.argv[2]);
  console.log(limiterNote);
  for (const scenario of result.scenarios) console.log(`${scenario.scenario} ${scenario.judgement}`);
}
