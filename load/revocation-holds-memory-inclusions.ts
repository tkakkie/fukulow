// V5 evaluates evidence-only exclusions jointly in run order and retains every observed FAIL.
import { lessFavourable, memoryForGroup, stableMemoryVerdict, type MemoryEntry, type MemoryResult, type RssCorrectionKb } from './revocation-holds-memory.ts';
import { CELL_NAMES } from './revocation-holds-plan.ts';

export type AttemptMemory = MemoryEntry & { id: string; evidenceOnly: boolean };
type Failure = { included: string[]; firstObservedAt?: string; memory: MemoryResult };
export type MemoryHistory = Record<string, { memory: MemoryResult; failures: Failure[] }>;

function subsets(ids: string[]) {
  return ids.reduce<string[][]>((all, id) => [...all, ...all.map(included => [...included, id])], [[]]);
}

export function memoryWithInclusions(entries: AttemptMemory[], previous: MemoryHistory = {}): MemoryHistory {
  const groups: MemoryHistory = {};
  for (const cell of CELL_NAMES) for (const duration of ['short', 'long'] as const) {
    const key = `${cell}/${duration}`;
    const group = entries.filter(e => e.cell === cell && (e.kind === 'control' || e.duration === duration));
    const exclusions = group.filter(e => e.verdict === 'INVALID' && e.evidenceOnly);
    const failures = new Map(previous[key]?.failures.map(f => [JSON.stringify(f.included), f]));
    let memory = previous[key]?.memory.result === 'FAIL' ? previous[key].memory : undefined;
    for (const included of subsets(exclusions.map(e => e.id))) {
      const selected = new Set(included);
      const result = memoryForGroup(group.map(e => selected.has(e.id)
        ? { ...e, verdict: e.kind === 'fault' ? 'PASS' : 'CONTROL' } : e), duration);
      memory = memory ? lessFavourable(memory, result) : result;
      const subset = JSON.stringify(included);
      if (result.result === 'FAIL' && !failures.has(subset)) failures.set(subset, {
        included, firstObservedAt: entries.at(-1)?.id, memory: result,
      });
    }
    groups[key] = { memory: memory ?? { result: 'NOT EVALUATED' }, failures: [...failures.values()] };
  }
  return groups;
}

export function formalMemoryVerdicts(history: MemoryHistory, correctionKb?: RssCorrectionKb) {
  return Object.fromEntries(Object.entries(history).map(([key, { memory }]) => {
    const { result, dKb, nKb, bKb } = memory;
    const stable = correctionKb && dKb !== undefined && nKb !== undefined && bKb !== undefined &&
      stableMemoryVerdict(result, [dKb - correctionKb[1], dKb - correctionKb[0]], nKb, bKb);
    return [key, { ...memory, overheadInconclusive: !stable }];
  }));
}
