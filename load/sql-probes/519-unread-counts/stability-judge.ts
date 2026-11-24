import { requirementViolations, type HostRecord } from '../../harness-core/host-record.ts';
import { blockThermal, median, type BlockThermal, type ThermalSample } from '../../harness-core/thermal.ts';

// Second #796 stability check (pre-registered on #796 and approved 2026-11-24, before any run):
// 3 consecutive runs of the #519 send diagnosis with cooling levers L1 (fan full speed), L2 (boost
// off), L3 (airflow, confirmed by the maintainer, not machine-checked) and L5 (cool-down gate).
// Pass criteria are the first check's. The lever and throttle rules can only fail a run.

export const levers = { boost: '0', policyBoost: '0', platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } };
export const cooldown = { maxTctlC: 50, maxWaitSeconds: 1200 };
export const sampleSeconds = 5;
export const runsRequired = 3;
export const blocksPerRun = 6;
export const limits = { tpsSpread: 0.05, walSpread: 0.02, throttle: 0.05 };
// A block needs nearly every 5 s sample of its measured window; fewer is missing data, so INVALID.
export const minSamples = (measuredSeconds: number) => Math.floor(measuredSeconds / sampleSeconds) - 2;

type Send = {
  order: number; arm: string; ended: string; tps: number; walBytesPerSend: number; crossed: boolean; errors?: string[];
  host?: { busy?: unknown; otherContainers?: unknown[] }; hostAfter?: { busy?: unknown; otherContainers?: unknown[] } | null;
};
export type RunInput = {
  name: string; complete: boolean; sends: Send[];
  metadata: { cpuSets: { server: number[]; client: number[] } | null; sends: { measuredSeconds: number } };
  hostBefore: HostRecord | null; cooldown: { ok?: boolean; maxTctlC?: number; maxWaitSeconds?: number } | null;
  samples: ThermalSample[]; thermalSampleSeconds: number | undefined;
};

export function judgeRun(r: RunInput) {
  const invalid: string[] = [];
  if (!r.complete) invalid.push('run did not complete');
  if (r.sends.length !== blocksPerRun) invalid.push(`${r.sends.length} blocks, not ${blocksPerRun}`);
  for (const s of r.sends) {
    for (const e of s.errors ?? []) invalid.push(`block ${s.order}: ${e}`);
    if (s.crossed) invalid.push(`block ${s.order}: crossed a checkpoint`);
    if (s.host?.busy || s.hostAfter?.busy) invalid.push(`block ${s.order}: host busy`);
    if ((s.host?.otherContainers ?? []).length || (s.hostAfter?.otherContainers ?? []).length) invalid.push(`block ${s.order}: other containers`);
  }
  if (r.hostBefore === null) invalid.push('no host record before the run');
  else invalid.push(...requirementViolations(r.hostBefore, levers).map(v => `lever: ${v}`));
  if (r.cooldown?.ok !== true || r.cooldown.maxTctlC !== cooldown.maxTctlC || r.cooldown.maxWaitSeconds !== cooldown.maxWaitSeconds) {
    invalid.push(`lever: no passed cool-down gate (Tctl <= ${cooldown.maxTctlC} °C within ${cooldown.maxWaitSeconds} s)`);
  }
  if (r.thermalSampleSeconds !== sampleSeconds) invalid.push(`thermal samples every ${r.thermalSampleSeconds ?? '(none)'} s, not ${sampleSeconds} s`);
  const sets = r.metadata.cpuSets;
  if (sets === null) invalid.push('no CPU sets in the run metadata');
  const measured = r.metadata.sends.measuredSeconds;
  const blocks = [...r.sends].sort((a, b) => a.order - b.order).map(s => {
    const end = Date.parse(s.ended);
    const t: BlockThermal = sets ? blockThermal(r.samples, end - measured * 1000, end, sets) : { samples: 0, server: null, client: null, maxTctlC: null };
    return { order: s.order, arm: s.arm, tps: s.tps, walBytesPerSend: s.walBytesPerSend, thermal: t };
  });
  for (const b of blocks) {
    if (b.thermal.samples < minSamples(measured)) invalid.push(`block ${b.order}: ${b.thermal.samples} thermal samples < ${minSamples(measured)}`);
    if (b.thermal.server === null || b.thermal.client === null) invalid.push(`block ${b.order}: unreadable CPU frequency`);
  }
  const first = blocks[0]?.thermal;
  for (const b of blocks.slice(1)) {
    for (const set of ['server', 'client'] as const) {
      const base = first?.[set]?.medianKHz;
      const got = b.thermal[set]?.medianKHz;
      if (base !== undefined && got !== undefined && got < base * (1 - limits.throttle)) {
        invalid.push(`block ${b.order}: throttled, ${set} median ${Math.round(got)} kHz < ${100 - limits.throttle * 100} % of block 1 (${Math.round(base)} kHz)`);
      }
    }
  }
  const arm = (a: string) => ({ tps: median(blocks.filter(b => b.arm === a).map(b => b.tps)), wal: median(blocks.filter(b => b.arm === a).map(b => b.walBytesPerSend)) });
  return { name: r.name, valid: invalid.length === 0, invalid, current: arm('current'), final: arm('final'), blocks };
}

const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);

export function judge(runs: RunInput[]) {
  const judged = runs.map(judgeRun);
  const reasons: string[] = [];
  if (runs.length !== runsRequired) reasons.push(`${runs.length} runs, not ${runsRequired}`);
  for (const r of judged) if (!r.valid) reasons.push(`${r.name} INVALID`);
  const arms = Object.fromEntries((['current', 'final'] as const).map(a => {
    const tps = spread(judged.map(r => r[a].tps));
    const wal = spread(judged.map(r => r[a].wal));
    if (!(tps <= limits.tpsSpread)) reasons.push(`${a} tps spread ${(tps * 100).toFixed(2)} % > ${limits.tpsSpread * 100} %`);
    if (!(wal <= limits.walSpread)) reasons.push(`${a} WAL/send spread ${(wal * 100).toFixed(2)} % > ${limits.walSpread * 100} %`);
    return [a, { tpsSpread: tps, walSpread: wal }];
  }));
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, arms, runs: judged,
    notes: ['L3 (airflow) is confirmed by the maintainer in the go, not machine-checked', 'an INVALID run fails the check; there is no rerun'] };
}
