import assert from 'node:assert/strict';
import test from 'node:test';
import { cpus796 } from './frequency-evidence.ts';
import { block, evidence, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';
import { controlSpotCheck } from './frequency-turbostat.ts';

test('capped spot check requires a spanning turbostat pair on each CPU and compares raw ratios', () => {
  const baseline = block(1, { control: true });
  const capped = block(2, { control: true, ratios: () => [17n, 20n] });
  const restored = block(3, { control: true });
  const v = judgeFrequency([baseline, capped, restored], sets796, evidence, session, null, true);
  assert.deepEqual(v.reasons, ['block 2: F5 throttled server', 'block 2: F5 throttled client']);
  const startNs = capped.counters.open.reads[0].monoNs;
  const stopNs = capped.counters.close.reads.at(-1)!.monoNs;
  const rows = (alter?: number) => cpus796.map(cpu => `${cpu} 2000 ${cpu >= 8 ? 0 : cpu === alter ? 1600 : 1700} ${cpu < 8 ? 2000 : 0}`);
  const raw = (lines: string[]) => ({ startNs, stopNs, stdout: '', stderr: ['CPU TSC_MHz APERF MPERF', ...lines].join('\n') });
  const got = controlSpotCheck(raw(rows()), v);
  assert.deepEqual(got.problems, []);
  assert.equal(got.cpus[0].ratio, 0.85);
  assert.match(controlSpotCheck(raw(rows(7)), v).problems.join(), /discrepancy.*CPU 7/);
  assert.match(controlSpotCheck(raw(rows().slice(0, -1)), v).problems.join(), /all 16 CPUs/);
  assert.match(controlSpotCheck({ ...raw(rows()), startNs: String(BigInt(startNs) + 1n) }, v).problems.join(), /did not span/);
});
