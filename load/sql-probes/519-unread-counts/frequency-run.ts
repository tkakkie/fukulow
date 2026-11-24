import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { platform } from 'node:os';
import { hrtime } from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { readCpuPolicy } from '../../harness-core/cpu-policy.ts';
import { hwmon } from '../../harness-core/host-record.ts';
import { controlFloors, frozenFloors, isQuote, permissionCheck } from './frequency-approval.ts';
import { cpus796, referenceRates, same, sets796, validatePolicy, type Calibration } from './frequency-evidence.ts';
import { maxLimits, verifyLimits, withCap, writeLimits } from './frequency-policy.ts';
import { calibrate, timedCounters } from './frequency-collector.ts';
import { withSpotCheck } from './frequency-spot-check.ts';
import type { CpuSets } from '../../harness-core/cpusets.ts';

export function frequencyRequest(stage: string, helper: string | undefined, review: string | undefined, permission: string | undefined,
  session: string | null, sets: CpuSets | undefined, marker: string | null) {
  const launch = JSON.parse(process.env.FUKULOW_LAUNCH_FREQUENCY ?? 'null');
  if (stage !== 'control' && stage !== 'rehearsal2' && stage !== 'formal') throw new Error('invalid frequency stage');
  if (platform() !== 'linux' || !session || !marker?.endsWith(`session ${session}`) || !launch ||
      launch.issue !== 796 || !isQuote(launch.go) || !isQuote(launch.airflow) || launch.sampleSeconds !== 5 ||
      launch.maxTctlC !== 50 || launch.maxWaitSeconds !== 1200 || launch.boost !== '0' ||
      launch.policyBoost !== '0' || launch.profile !== 'performance' || !launch.policy || !same(sets, sets796) || !helper || !isAbsolute(helper)) {
    throw new Error('STOP: #796 v3 needs its own approved Linux launcher job, cooldown, 5 s sampling, fixed CPU sets and absolute --perf-helper');
  }
  const approval = stage === 'formal' ? frozenFloors() : stage === 'rehearsal2' ? controlFloors(review) : null;
  const check = stage === 'control' ? permissionCheck(permission) : null;
  return { stage, helper, session, approval, check, go: launch.go, launchPolicy: launch.policy };
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

  return {
    signal: signal.signal,
    async start() {
      calibration = await calibrate(request.helper, signal.signal);
      referenceRates(calibration);
      validatePolicy(before, calibration.identity);
      if (request.check && !same(request.check.identity, calibration.identity)) {
        throw new Error('STOP: permission check belongs to a different helper or host identity');
      }
      if (!same(before, readCpuPolicy(cpus796))) throw new Error('F1 policy changed during calibration');
      save('frequency-start.json', { before, calibration, permissionCheck: request.check, startSession: request.session });
    },
    async coolBaseline() {
      if (!control) return;
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
    },
    async measure<T, P>(order: number, prepare: () => Promise<P>, work: () => Promise<T>) {
      signal.signal.throwIfAborted();
      const expected = control && order === 2
        ? { ...before, policies: before.policies.map(p => ({ ...p, max: '1700000' })) } : before;
      const block = async () => {
        if (!same(expected, readCpuPolicy(cpus796))) throw new Error('F1 unexpected policy before block');
        const measured = await timedCounters(request.helper, request.session, order, control, signal.signal, work);
        save(`frequency-block-${order}.json`, measured.counters);
        if (!same(expected, measured.counters.policyBefore) || !same(expected, measured.counters.policyAfter)) {
          throw new Error('F1 policy changed around block');
        }
        return measured;
      };
      const capped = control && order === 2;
      const preparedBlock = async () => {
        signal.signal.throwIfAborted();
        const preparation = await prepare();
        const measured = capped ? await withSpotCheck(block, signal.signal, raw => save('frequency-turbostat.json', raw)) : await block();
        return { ...measured, preparation };
      };
      if (!capped) return preparedBlock();
      return withCap(maxLimits(before), preparedBlock, {
        write: writeLimits, verify: verifyLimits,
        pending: saved => save('frequency-restore-pending.json', saved),
        restored: () => rmSync(pending),
      });
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

