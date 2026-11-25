import { rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { platform } from 'node:os';
import { hrtime } from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { readCpuPolicy } from '../../harness-core/cpu-policy.ts';
import { hwmon } from '../../harness-core/host-record.ts';
import { controlFloors, frozenFloors, isQuote, permissionCheck } from './frequency-approval.ts';
import { cappedPolicy, cpus796, referenceRates, same, setNames, sets796, validatePolicy, type Calibration, type FrequencyEvidence,
  type ReferenceWindow } from './frequency-evidence.ts';
import { maxLimits, verifyLimits, withCap, writeLimits } from './frequency-policy.ts';
import { calibrate, timedCounters, waitUntil } from './frequency-collector.ts';
import { withSpotCheck, type SpotCheck } from './frequency-spot-check.ts';
import { assessReference, referenceMs, referenceRequired, settleMs } from './frequency-reference.ts';
import { diagnostic, housekeepingSampler } from './frequency-housekeeping.ts';
import { checkFrequencyEvidence, judgeFrequency, type FrequencyBlock } from './frequency-judge.ts';
import { controlSpotCheck } from './frequency-turbostat.ts';
import type { CpuSets } from '../../harness-core/cpusets.ts';
import { matches796, measurementSlice } from '../../harness-core/frequency-layout.ts';

export function frequencyRequest(stage: string, helper: string | undefined, review: string | undefined, permission: string | undefined,
  session: string | null, sets: CpuSets | undefined, marker: string | null) {
  const launch = JSON.parse(process.env.FUKULOW_LAUNCH_FREQUENCY ?? 'null');
  if (stage !== 'control' && stage !== 'rehearsal2' && stage !== 'formal') throw new Error('invalid frequency stage');
  if (platform() !== 'linux' || !session || !marker?.endsWith(`session ${session}`) || !launch ||
      launch.issue !== 796 || !isQuote(launch.go) || !isQuote(launch.airflow) || launch.sampleSeconds !== 5 ||
      launch.maxTctlC !== 50 || launch.maxWaitSeconds !== 1200 || launch.boost !== '0' ||
      launch.policyBoost !== '0' || launch.profile !== 'performance' || !launch.policy || !matches796(sets) || !helper || !isAbsolute(helper)) {
    throw new Error('STOP: #796 v3 needs its own approved Linux launcher job, cooldown, 5 s sampling, fixed CPU sets and absolute --perf-helper');
  }
  const approval = stage === 'formal' ? frozenFloors() : stage === 'rehearsal2' ? controlFloors(review) : null;
  const check = stage === 'control' ? permissionCheck(permission) : null;
  return { stage, helper, session, approval, check, go: launch.go, launchPolicy: launch.policy };
}

export async function runFrequencyBlock<P, T>(order: number, control: boolean, steps: {
  checkpoint(): bigint; settle(deadline: bigint): Promise<void>;
  reference(checkpointNs: bigint): Promise<ReferenceWindow>;
  clone(): P; coolBaseline(): Promise<void>;
  work(clone: P, reference?: ReferenceWindow): Promise<T>; cap(work: () => Promise<T>): Promise<T>;
}) {
  const run = async () => {
    let reference: ReferenceWindow | undefined;
    if (referenceRequired(order, control)) {
      const checkpointNs = steps.checkpoint();
      await steps.settle(checkpointNs + BigInt(settleMs) * 1_000_000n);
      reference = await steps.reference(checkpointNs);
    }
    const clone = steps.clone();
    if (control && order === 1) await steps.coolBaseline();
    return steps.work(clone, reference);
  };
  return control && order === 2 ? steps.cap(run) : run();
}

export function blockStopReasons(stage: ReturnType<typeof frequencyRequest>['stage'], order: number,
  completed: FrequencyBlock[], evidence: FrequencyEvidence, spot: SpotCheck | null) {
  const session = evidence.startSession;
  if (stage !== 'control') return checkFrequencyEvidence(completed, sets796, evidence, session, false).reasons;

  const judged = judgeFrequency(completed, sets796, evidence, session, null, true);
  const expected = order >= 2 ? setNames.map(set => `block 2: F5 throttled ${set}`) : [];
  const problems = judged.reasons.filter(reason => !expected.includes(reason));
  problems.push(...expected.filter(reason => !judged.reasons.includes(reason)).map(reason => `control failed to show ${reason}`));
  if (order === 2) problems.push(...controlSpotCheck(spot, judged).problems);
  return problems;
}

export function frequencyRun(request: ReturnType<typeof frequencyRequest>, out: string) {
  const before = readCpuPolicy(cpus796);
  if (!same(request.launchPolicy, before)) throw new Error('F1 policy changed between launcher and job setup');
  const signal = new AbortController();
  const stop = () => signal.abort(new Error('measurement interrupted'));
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of signals) process.on(sig, stop);
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const pending = join(out, 'frequency-restore-pending.json');
  const control = request.stage === 'control';
  let calibration: Calibration;
  let rates: ReturnType<typeof referenceRates>;
  let sampler: ReturnType<typeof housekeepingSampler> | undefined;
  let spot: SpotCheck | null = null;
  const completed: FrequencyBlock[] = [];
  const policyFor = (order: number) => control && order === 2 ? cappedPolicy(before) : before;

  async function reference(order: number, checkpointNs: bigint) {
    const expected = policyFor(order);
    if (!same(expected, readCpuPolicy(cpus796))) throw new Error('F1 unexpected policy before settled reference');
    const { counters } = await timedCounters(request.helper, request.session, order, false, signal.signal,
      () => waitUntil(hrtime.bigint() + BigInt(referenceMs) * 1_000_000n, signal.signal), sampler);
    const window = { ...counters, checkpointNs: String(checkpointNs) };
    let assessment: ReturnType<typeof assessReference> | undefined;
    try {
      assessment = assessReference(window, order, request.session, calibration.identity, expected, rates);
      if (assessment.reasons.length) throw new Error(`STOP: ${assessment.reasons.join('; ')}`);
    } finally { save(`frequency-reference-${order}.json`, { window, assessment }); }
    return window;
  }

  async function coolBaseline() {
    const wall = Date.now(), mono = hrtime.bigint();
    const readings: { elapsedMs: number; tctlC: number | null }[] = [];
    let ok = false, problem = '';
    try {
      for (;;) {
        signal.signal.throwIfAborted();
        const tctlC = hwmon(/^temp\d+_input$/, 1000)?.['k10temp/Tctl'] ?? null;
        const elapsedMs = Number(hrtime.bigint() - mono) / 1e6;
        readings.push({ elapsedMs, tctlC });
        if (Math.abs(Date.now() - wall - elapsedMs) > 1000) throw new Error('wall clock stepped during control cool-down');
        if (elapsedMs > 1_200_000 || tctlC === null) throw new Error('control baseline Tctl cool-down failed');
        if (tctlC <= 50) { ok = true; break; }
        await wait(Math.min(5000, 1_200_000 - elapsedMs), undefined, { signal: signal.signal });
      }
    } catch (error) { problem = String(error); throw error; }
    finally { save('frequency-baseline-cooldown.json', { ok, problem, readings }); }
  }

  return {
    signal: signal.signal,
    observeHousekeeping() {
      const ticks = diagnostic(() => Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 3000 })));
      sampler = housekeepingSampler(`/${measurementSlice}`, ticks && Number.isSafeInteger(ticks) && ticks > 0 ? ticks : null);
    },
    async start() {
      calibration = await calibrate(request.helper, signal.signal);
      rates = referenceRates(calibration);
      validatePolicy(before, calibration.identity);
      if (request.check && !same(request.check.identity, calibration.identity)) {
        throw new Error('STOP: permission check belongs to a different helper or host identity');
      }
      if (!same(before, readCpuPolicy(cpus796))) throw new Error('F1 policy changed during calibration');
      save('frequency-start.json', { before, calibration, permissionCheck: request.check, startSession: request.session });
    },
    async runBlock<P>(order: number, checkpoint: () => void, clone: () => P,
      work: (prepared: P, reference?: ReferenceWindow) => Promise<FrequencyBlock>) {
      signal.signal.throwIfAborted();
      return runFrequencyBlock(order, control, {
        checkpoint: () => { checkpoint(); return hrtime.bigint(); },
        settle: deadline => waitUntil(deadline, signal.signal),
        reference: checkpointNs => reference(order, checkpointNs),
        clone, coolBaseline,
        work: async (prepared, window) => {
          const measured = await work(prepared, window);
          completed.push(measured);
          const problems = blockStopReasons(request.stage, order, completed, { calibration, before, after: before,
            startSession: request.session, endSession: request.session }, spot);
          if (problems.length) throw new Error(`STOP: ${problems.join('; ')}`);
          return measured;
        },
        cap: block => withCap(maxLimits(before), block, {
          write: writeLimits, verify: verifyLimits,
          pending: saved => save('frequency-restore-pending.json', saved),
          restored: () => rmSync(pending),
        }),
      });
    },
    async measure<T, P>(order: number, reference: ReferenceWindow | undefined, prepare: () => Promise<P>, work: () => Promise<T>) {
      signal.signal.throwIfAborted();
      const expected = policyFor(order);
      const block = async () => {
        if (!same(expected, readCpuPolicy(cpus796))) throw new Error('F1 unexpected policy before block');
        const measured = await timedCounters(request.helper, request.session, order, control, signal.signal, work, sampler);
        const counters = { ...measured.counters, reference };
        save(`frequency-block-${order}.json`, counters);
        if (!same(expected, counters.policyBefore) || !same(expected, counters.policyAfter)) {
          throw new Error('F1 policy changed around block');
        }
        return { ...measured, counters };
      };
      const preparation = await prepare();
      const measured = control && order === 2 ? await withSpotCheck(block, signal.signal, raw => {
        spot = raw;
        save('frequency-turbostat.json', raw);
      }) : await block();
      return { ...measured, preparation };
    },
    finish() {
      try {
        const after = readCpuPolicy(cpus796);
        save('frequency-end.json', { after, endSession: request.session });
        if (!same(before, after)) throw new Error('F1 policy changed between launch and completion');
        signal.signal.throwIfAborted();
      } finally { for (const sig of signals) process.off(sig, stop); }
    },
  };
}

