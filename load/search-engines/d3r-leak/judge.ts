import { judgedIds, formal } from './design.ts';
import type { armStats, ratios } from './samples.ts';
import type { planFacts } from './plan.ts';

export const invalidChecks = [
  'sampleCount', 'pgbench', 'statementTimeout', 'fixture', 'rls', 'identity', 'hostBusy', 'idle', 'cleanup',
] as const;
type Check = typeof invalidChecks[number];

type ArmEvidence = Pick<ReturnType<typeof armStats>, 'n'> & Partial<ReturnType<typeof planFacts>>;
export type PairEvidence = {
  id: string;
  few?: ArmEvidence;
  many?: ArmEvidence;
  ratios?: Pick<ReturnType<typeof ratios>, 'p50' | 'p95'>;
};

export function flagged(p50: number, p95: number) {
  return (p50 >= 1.10 && p95 >= 1.10) || (p50 <= .91 && p95 <= .91);
}

export function judge({pairs = [], checks = {}}: {
  pairs?: PairEvidence[];
  checks?: Partial<Record<Check, boolean>>;
}) {
  const invalid: string[] = invalidChecks.filter(check => checks[check] === false);
  const flags = new Map<string, boolean>();
  for (const {id, few, many, ratios} of pairs) {
    if ([few, many].some(arm => arm?.n !== undefined && arm.n !== formal.blocksPerArm * formal.clients * formal.measuredPerClient)) {
      invalid.push(`sampleCount:${id}`);
    }
    if (ratios && [ratios.p50, ratios.p95].every(value => Number.isFinite(value) && value > 0)) {
      flags.set(id, flagged(ratios.p50, ratios.p95));
    }
  }
  if (flags.get('P') === false) invalid.push('positiveControl');
  if (flags.get('A/A') === true) invalid.push('negativeControl');
  if (invalid.length) return {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid} as const;

  const required = [...judgedIds, 'E', 'S', 'V', 'P', 'A/A'];
  if (invalidChecks.some(check => checks[check] !== true) ||
      required.some(id => {
        const matching = pairs.filter(pair => pair.id === id);
        const [pair] = matching;
        return matching.length !== 1 || !flags.has(id) ||
          [pair.few, pair.many].some(arm => arm?.n === undefined || !arm.shape);
      })) {
    return {validity: null, verdict: 'NOT EVALUATED'} as const;
  }
  const failures = pairs.filter(pair => judgedIds.includes(pair.id) &&
    (flags.get(pair.id) || pair.few?.shape !== pair.many?.shape)).map(pair => pair.id);
  return {validity: 'VALID', verdict: failures.length ? 'FAIL' : 'PASS', failures} as const;
}
