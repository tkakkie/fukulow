import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRecord } from '../../harness-core/host-record.ts';
import type { ThermalSample } from '../../harness-core/thermal.ts';
import { judge, judgeRun, type RunInput } from './stability-judge.ts';

const t0 = Date.parse('2026-11-25T00:00:00Z');
const host = { platform: 'linux', logicalCpus: 4, boost: '0', policyBoost: { 0: [0, 1, 2, 3] }, platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } } as unknown as HostRecord;
const arms = ['current', 'final', 'final', 'current', 'current', 'final'];

// Six 120 s blocks, 200 s apart, sampled every 5 s; freq(block) gives the server and client kHz.
function run(name: string, over: Partial<RunInput> = {}, opts: { tps?: number; freq?: (block: number) => [number, number] } = {}): RunInput {
  const freq = opts.freq ?? (() => [2_000_000, 2_000_000]);
  const sends = arms.map((arm, i) => ({ order: i + 1, arm, ended: new Date(t0 + (i + 1) * 200_000).toISOString(), tps: (opts.tps ?? 10_000) + i, walBytesPerSend: 1787, crossed: false, errors: [] }));
  const samples: ThermalSample[] = [];
  for (let s = 0; s <= 1300; s += 5) {
    const block = Math.min(6, Math.max(1, Math.ceil(s / 200)));
    const [server, client] = freq(block);
    samples.push({ at: new Date(t0 + s * 1000).toISOString(), avgFreqKHz: [server, client, server, client], temperaturesC: { 'k10temp/Tctl': 70 }, fansRpm: {} });
  }
  return { name, complete: true, sends, metadata: { cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } },
    hostBefore: host, cooldown: { ok: true, maxTctlC: 50, maxWaitSeconds: 1200 }, samples, thermalSampleSeconds: 5, ...over };
}

test('three valid runs inside both spreads PASS', () => {
  const v = judge([run('s1'), run('s2', {}, { tps: 10_200 }), run('s3', {}, { tps: 10_400 })]);
  assert.deepEqual([v.result, v.reasons], ['PASS', []]);
  assert.equal(v.runs[0].blocks[0].thermal.samples, 25);
});

test('a tps spread over 5 % FAILs, as in the first check', () => {
  const v = judge([run('s1'), run('s2'), run('s3', {}, { tps: 7_500 })]);
  assert.equal(v.result, 'FAIL');
  assert.match(v.reasons.join(), /current tps spread .* > 5 %/);
});

test('a block more than 5 % below block 1 on either set is throttled: the run is INVALID and the check FAILs', () => {
  const r = judgeRun(run('s1', {}, { freq: b => [b === 5 ? 1_890_000 : 2_000_000, 2_000_000] }));
  assert.equal(r.valid, false);
  assert.match(r.invalid.join(), /block 5: throttled, server median 1890000 kHz < 95 % of block 1/);
  assert.equal(judgeRun(run('s1', {}, { freq: b => [2_000_000, b === 6 ? 1_899_999 : 2_000_000] })).invalid.length, 1);
  assert.equal(judgeRun(run('s1', {}, { freq: b => [b === 3 ? 1_900_000 : 2_000_000, 2_000_000] })).valid, true); // exactly 5 % is not throttled
  assert.equal(judge([run('s1', {}, { freq: b => [b > 3 ? 1_000_000 : 2_000_000, 2_000_000] }), run('s2'), run('s3')]).result, 'FAIL');
});

test('a missing lever, cool-down or thermal record makes the run INVALID', () => {
  const cases: [Partial<RunInput>, RegExp][] = [
    [{ hostBefore: { ...host, boost: '1' } as HostRecord }, /lever: boost is 1/],
    [{ hostBefore: { ...host, fanControl: { 'hp/pwm1_enable': 2 } } as HostRecord }, /lever: fan control/],
    [{ hostBefore: { ...host, platformProfile: 'balanced' } as HostRecord }, /lever: platform profile/],
    [{ hostBefore: null }, /no host record/],
    [{ cooldown: null }, /no passed cool-down/],
    [{ cooldown: { ok: true, maxTctlC: 60, maxWaitSeconds: 1200 } }, /no passed cool-down/],
    [{ thermalSampleSeconds: undefined }, /thermal samples every \(none\) s/],
    [{ samples: [] }, /block 1: 0 thermal samples < 22/],
    [{ metadata: { cpuSets: null, sends: { measuredSeconds: 120 } } }, /no CPU sets/],
    [{ complete: false }, /did not complete/],
  ];
  for (const [over, pattern] of cases) {
    const r = judgeRun(run('s1', over));
    assert.equal(r.valid, false, String(pattern));
    assert.match(r.invalid.join('\n'), pattern);
  }
  const gappy = run('s1');
  gappy.samples = gappy.samples.filter((s, i) => !(Date.parse(s.at) > t0 + 100_000 && Date.parse(s.at) < t0 + 200_000 && i % 2 === 0));
  assert.match(judgeRun(gappy).invalid.join(), /block 1: \d+ thermal samples < 22/);
  const unreadable = run('s1');
  unreadable.samples[30] = { ...unreadable.samples[30], avgFreqKHz: [null, 1, 1, 1] };
  assert.match(judgeRun(unreadable).invalid.join(), /unreadable CPU frequency/);
});

test('block problems and a wrong run count FAIL the check', () => {
  const bad = run('s1');
  bad.sends[2] = { ...bad.sends[2], crossed: true, errors: ['latency log'] };
  const r = judgeRun(bad);
  assert.match(r.invalid.join(), /block 3: latency log.*block 3: crossed/);
  assert.match(judge([run('s1'), run('s2')]).reasons.join(), /2 runs, not 3/);
  const five = run('s1');
  five.sends.pop();
  assert.match(judgeRun(five).invalid.join(), /5 blocks, not 6/);
});
